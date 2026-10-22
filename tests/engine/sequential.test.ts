import { describe, expect, it } from 'vitest';
import { clockLevel } from '../../src/engine/index.ts';
import { Bench, fromBits } from './helpers.ts';

describe('clock', () => {
  it('follows low-then-high waveform with configurable durations and phase', () => {
    const levels = (high: number, low: number, phase: number) =>
      Array.from({ length: 10 }, (_, t) => clockLevel(t, high, low, phase)).join('');
    expect(levels(1, 1, 0)).toBe('0101010101');
    expect(levels(2, 3, 0)).toBe('0001100011');
    expect(levels(2, 3, 3)).toBe('1100011000');
  });

  it('drives its net on each tick', () => {
    const t = new Bench();
    t.name('C', t.clock('clk', { highTicks: 2, lowTicks: 1 }));
    const sim = t.start();
    const seen = [t.bits('C')];
    for (let i = 0; i < 6; i++) {
      sim.runTicks(1);
      seen.push(t.bits('C'));
    }
    expect(seen.join('')).toBe('0110110');
  });
});

describe('D flip-flop primitive', () => {
  function dff(props: Record<string, number | string> = { width: 1 }) {
    const t = new Bench();
    const width = (props.width as number) ?? 1;
    const d = t.input('D', width);
    const clk = t.input('CLK');
    const q = t.name('Q', t.net(width));
    const nq = t.name('NQ', t.net(width));
    t.add('dff', props, [d, clk, q, nq], 'ff');
    t.start();
    return t;
  }

  it('powers up as 0 and captures D on the rising edge only', () => {
    const t = dff();
    expect([t.bits('Q'), t.bits('NQ')]).toEqual(['0', '1']);
    t.set('D', 1);
    expect(t.bits('Q')).toBe('0');
    t.set('CLK', 1);
    expect([t.bits('Q'), t.bits('NQ')]).toEqual(['1', '0']);
    t.set('D', 0);
    expect(t.bits('Q')).toBe('1');
    t.set('CLK', 0);
    expect(t.bits('Q')).toBe('1');
    t.set('CLK', 1);
    expect(t.bits('Q')).toBe('0');
  });

  it('supports falling-edge triggering and multi-bit data', () => {
    const t = dff({ width: 4, trigger: 'falling' });
    t.set('D', 0b1001);
    t.set('CLK', 1);
    expect(t.bits('Q')).toBe('0000');
    t.set('CLK', 0);
    expect(t.bits('Q')).toBe('1001');
  });

  it('is pessimistic about unknown clock transitions', () => {
    const t = dff({ width: 2 });
    t.set('D', 0b01);
    t.set('CLK', fromBits(['x']));
    // Q was 00, D is 01: bit 0 may have changed, bit 1 agrees.
    expect(t.bits('Q')).toBe('0x');
  });

  it('shift register of flip-flops on a shared clock shifts exactly one stage per edge', () => {
    const t = new Bench();
    const d = t.input('D');
    const clk = t.clock('clk');
    let prev = d;
    for (let i = 0; i < 4; i++) {
      const q = t.name(`Q${i}`, t.net(1));
      t.add('dff', { width: 1 }, [prev, clk, q, t.net(1)], `ff${i}`);
      prev = q;
    }
    const sim = t.start();
    const state = () => [0, 1, 2, 3].map((i) => t.bits(`Q${i}`)).join('');
    t.set('D', 1);
    sim.runTicks(2);
    expect(state()).toBe('1000');
    t.set('D', 0);
    sim.runTicks(2);
    expect(state()).toBe('0100');
    sim.runTicks(2);
    expect(state()).toBe('0010');
  });
});

describe('register primitive', () => {
  function reg() {
    const t = new Bench();
    const d = t.input('D', 8);
    const clk = t.input('CLK');
    const en = t.input('EN');
    const clr = t.input('CLR');
    const q = t.name('Q', t.net(8));
    t.add('register', { width: 8 }, [d, clk, en, clr, q], 'r');
    t.start();
    return t;
  }

  const pulse = (t: Bench) => {
    t.set('CLK', 1);
    t.set('CLK', 0);
  };

  it('loads on a rising edge when enabled, holds otherwise', () => {
    const t = reg();
    t.set('EN', 1);
    t.set('D', 0xa5);
    expect(t.bits('Q')).toBe('00000000');
    pulse(t);
    expect(t.bits('Q')).toBe('10100101');
    t.set('EN', 0);
    t.set('D', 0x0f);
    pulse(t);
    expect(t.bits('Q')).toBe('10100101');
  });

  it('clears asynchronously', () => {
    const t = reg();
    t.set('EN', 1);
    t.set('D', 0xff);
    pulse(t);
    t.set('CLR', 1);
    expect(t.bits('Q')).toBe('00000000');
    pulse(t); // clear dominates the clock
    expect(t.bits('Q')).toBe('00000000');
  });

  it('treats unconnected enable as enabled and unconnected clear as inactive', () => {
    const t = new Bench();
    const d = t.input('D', 4);
    const clk = t.input('CLK');
    const q = t.name('Q', t.net(4));
    t.add('register', { width: 4 }, [d, clk, -1, -1, q], 'r');
    t.start();
    t.set('D', 0b0110);
    t.set('CLK', 1);
    expect(t.bits('Q')).toBe('0110');
  });

  it('keeps state across snapshot export and import', () => {
    const t = reg();
    t.set('EN', 1);
    t.set('D', 0x3c);
    pulse(t);
    const snap = t.s.exportState();
    const t2 = reg();
    t2.s.importState(snap);
    t2.s.settle();
    expect(t2.bits('Q')).toBe('00111100');
  });
});
