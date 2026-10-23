import { describe, expect, it } from 'vitest';
import { NetlistError, Simulator, formatRomContents, fromUnsigned, parseRomContents } from '../../src/engine/index.ts';
import { Bench, fromBits } from './helpers.ts';

function ram(addrWidth = 4, width = 8) {
  const t = new Bench();
  const a = t.input('A', addrWidth);
  const d = t.input('D', width);
  const we = t.input('WE');
  const clk = t.input('CLK');
  const q = t.name('Q', t.net(width));
  t.add('ram', { addrWidth, width }, [a, d, we, clk, q], 'mem');
  t.start();
  return t;
}

const pulse = (t: Bench) => {
  t.set('CLK', 1);
  t.set('CLK', 0);
};

const write = (t: Bench, addr: number, v: number) => {
  t.set('A', addr);
  t.set('D', v);
  t.set('WE', 1);
  pulse(t);
  t.set('WE', 0);
};

describe('RAM primitive', () => {
  it('writes on the rising edge when enabled and reads asynchronously', () => {
    const t = ram();
    expect(t.bits('Q')).toBe('00000000');
    write(t, 3, 0xa5);
    write(t, 9, 0x3c);
    t.set('A', 3);
    expect(t.bits('Q')).toBe('10100101');
    t.set('A', 9);
    expect(t.bits('Q')).toBe('00111100');
    t.set('A', 4);
    expect(t.bits('Q')).toBe('00000000');
  });

  it('does not write while WE is 0, and shows new data right after a write', () => {
    const t = ram();
    t.set('A', 5);
    t.set('D', 0x11);
    pulse(t);
    expect(t.bits('Q')).toBe('00000000');
    t.set('WE', 1);
    t.set('CLK', 1);
    expect(t.bits('Q')).toBe('00010001');
  });

  it('reads X for an unknown address and ignores writes to one', () => {
    const t = ram(2, 4);
    write(t, 1, 0xf);
    t.set('A', fromBits(['x', '0']));
    expect(t.bits('Q')).toBe('xxxx');
    t.set('D', 0x5);
    t.set('WE', 1);
    pulse(t);
    t.set('WE', 0);
    t.set('A', 1);
    expect(t.bits('Q')).toBe('1111');
  });

  it('is pessimistic about an unknown write enable', () => {
    const t = ram(2, 4);
    write(t, 2, 0b1100);
    t.set('A', 2);
    t.set('D', 0b1010);
    t.set('WE', fromBits(['x']));
    pulse(t);
    expect(t.bits('Q')).toBe('1xx0');
  });

  it('exposes contents for viewers and supports direct writes', () => {
    const t = ram();
    write(t, 7, 42);
    const mem = t.s.memory('mem')!;
    expect(mem.words).toBe(16);
    expect(mem.read(7).a).toBe(42);
    expect(mem.lastWrite).toBe(7);
    t.set('A', 2);
    t.s.writeMemory('mem', 2, fromUnsigned(8, 99));
    t.s.settle();
    expect(t.get('Q').a).toBe(99);
    expect(t.s.memory('A')).toBeNull();
  });

  it('keeps its contents across snapshot export and import', () => {
    const t = ram();
    write(t, 1, 0x12);
    write(t, 15, 0xff);
    const snap = JSON.parse(JSON.stringify(t.s.exportState()));
    const t2 = ram();
    t2.s.importState(snap);
    t2.s.settle();
    t2.set('A', 15);
    expect(t2.get('Q').a).toBe(0xff);
    t2.set('A', 1);
    expect(t2.get('Q').a).toBe(0x12);
  });
});

describe('ROM primitive', () => {
  function rom(contents: string, addrWidth = 3, width = 8) {
    const t = new Bench();
    const a = t.input('A', addrWidth);
    const q = t.name('Q', t.net(width));
    t.add('rom', { addrWidth, width, contents }, [a, q], 'rom');
    t.start();
    return t;
  }

  it('reads its contents', () => {
    const t = rom('de ad be ef\n01 0x02');
    const read = (addr: number) => {
      t.set('A', addr);
      return t.get('Q').a;
    };
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(read)).toEqual([0xde, 0xad, 0xbe, 0xef, 1, 2, 0, 0]);
  });

  it('rejects malformed contents with a clear message', () => {
    const nl = (contents: string) => ({ nets: [{ width: 2 }, { width: 4 }], components: [{ key: 'r', type: 'rom', props: { addrWidth: 2, width: 4, contents }, pins: [0, 1] }] });
    expect(() => new Simulator(nl('1 2 3 4 5'))).toThrow(/has 5 words but the ROM holds 4/);
    expect(() => new Simulator(nl('1 g'))).toThrow(NetlistError);
    expect(() => new Simulator(nl('10'))).toThrow(/does not fit in 4 bit/);
  });

  it('formats and parses contents symmetrically', () => {
    const words = Int32Array.from([1, 0xff, 0, 0x10, 0, 0, 0, 0]);
    const text = formatRomContents(words, 8);
    expect(text).toBe('01 ff 00 10');
    expect(parseRomContents(text, 8, 8)).toEqual(words);
    expect(formatRomContents(new Int32Array(4), 8)).toBe('');
  });
});
