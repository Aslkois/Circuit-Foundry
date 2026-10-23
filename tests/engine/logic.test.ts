import { describe, expect, it } from 'vitest';
import {
  allX,
  allZ,
  contentionBits,
  formatBinary,
  formatDecimal,
  formatHex,
  fromUnsigned,
  parseValue,
  resolve,
  toSigned,
  toUnsigned,
  widthMask,
} from '../../src/engine/index.ts';
import { STATES, fromBits, refResolve, toBits } from './helpers.ts';

describe('logic values', () => {
  it('computes width masks up to 32 bits', () => {
    expect(widthMask(1)).toBe(1);
    expect(widthMask(4)).toBe(0xf);
    expect(widthMask(31)).toBe(0x7fffffff);
    expect(widthMask(32)).toBe(-1);
  });

  it('formats binary, hex and decimal with unknown and floating bits', () => {
    expect(formatBinary(fromUnsigned(4, 0b1010))).toBe('1010');
    expect(formatBinary(fromBits(['1', 'x', 'z', '0']))).toBe('0zx1');
    expect(formatHex(fromUnsigned(12, 0xabc))).toBe('abc');
    expect(formatHex(fromUnsigned(32, 0xffffffff))).toBe('ffffffff');
    expect(formatHex(allZ(8))).toBe('zz');
    expect(formatHex(fromBits(['1', 'x', '0', '0', '1', '0', '0', '0']))).toBe('1x');
    expect(formatDecimal(fromUnsigned(8, 200))).toBe('200');
    expect(formatDecimal(fromUnsigned(8, 200), true)).toBe('-56');
    expect(formatDecimal(allX(3))).toBe('x');
    expect(formatDecimal(allZ(3))).toBe('z');
  });

  it('converts to unsigned and signed integers', () => {
    expect(toUnsigned(fromUnsigned(32, 0xffffffff))).toBe(0xffffffff);
    expect(toSigned(fromUnsigned(32, 0xffffffff))).toBe(-1);
    expect(toSigned(fromUnsigned(4, 0b1000))).toBe(-8);
    expect(toSigned(fromUnsigned(4, 0b0111))).toBe(7);
    expect(toUnsigned(allX(4))).toBeNull();
  });

  it('parses user-entered values', () => {
    expect(parseValue('13', 4)).toEqual(fromUnsigned(4, 13));
    expect(parseValue('0x1F', 8)).toEqual(fromUnsigned(8, 31));
    expect(parseValue('0b10_01', 4)).toEqual(fromUnsigned(4, 9));
    expect(parseValue('-1', 4)).toEqual(fromUnsigned(4, 15));
    expect(parseValue('0b1x', 2)).toEqual(fromBits(['x', '1']));
    expect(parseValue('x', 3)).toEqual(allX(3));
    expect(parseValue('16', 4)).toBeNull();
    expect(parseValue('-9', 4)).toBeNull();
    expect(parseValue('0b111', 2)).toBeNull();
    expect(parseValue('abc', 8)).toBeNull();
    expect(parseValue('4294967295', 32)).toEqual(fromUnsigned(32, 0xffffffff));
  });

  it('resolves multiple drivers per bit like a wired net', () => {
    for (const x of STATES) {
      for (const y of STATES) {
        const r = resolve(fromBits([x]), fromBits([y]));
        expect(toBits(r)[0], `${x} + ${y}`).toBe(refResolve(x, y));
      }
    }
  });

  it('resolves all bit combinations in parallel across a 16-bit word', () => {
    const xs: ('0' | '1' | 'x' | 'z')[] = [];
    const ys: ('0' | '1' | 'x' | 'z')[] = [];
    for (const x of STATES) for (const y of STATES) {
      xs.push(x);
      ys.push(y);
    }
    const r = toBits(resolve(fromBits(xs), fromBits(ys)));
    r.forEach((bit, i) => expect(bit).toBe(refResolve(xs[i], ys[i])));
  });

  it('flags contention only where known drivers disagree', () => {
    const x = fromBits(['0', '1', '1', 'z', 'x']);
    const y = fromBits(['1', '1', 'z', '0', '0']);
    expect(contentionBits(x.a, x.b, y.a, y.b) & widthMask(5)).toBe(0b00001);
  });
});
