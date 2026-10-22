import { describe, expect, it } from 'vitest';
import { fromUnsigned, logic, type BitState } from '../../src/engine/index.ts';
import { Bench, STATES, fromBits, prng, refAnd, refNot, refOr, refXor, toBits } from './helpers.ts';

const GATES: Record<string, (xs: BitState[]) => BitState> = {
  and: refAnd,
  or: refOr,
  xor: refXor,
  nand: (xs) => refNot(refAnd(xs)),
  nor: (xs) => refNot(refOr(xs)),
  xnor: (xs) => refNot(refXor(xs)),
};

function allCombos(n: number): BitState[][] {
  if (n === 0) return [[]];
  const rest = allCombos(n - 1);
  return STATES.flatMap((s) => rest.map((r) => [s, ...r]));
}

describe('logic gates', () => {
  it('matches the classic 0/1 truth tables for two-input gates', () => {
    const expected: Record<string, number[]> = {
      // inputs (A,B) = 00, 01, 10, 11
      and: [0, 0, 0, 1],
      or: [0, 1, 1, 1],
      nand: [1, 1, 1, 0],
      nor: [1, 0, 0, 0],
      xor: [0, 1, 1, 0],
      xnor: [1, 0, 0, 1],
    };
    for (const [type, table] of Object.entries(expected)) {
      const t = new Bench();
      const a = t.input('A');
      const b = t.input('B');
      t.name('Y', t.gate(type, [a, b]));
      t.start();
      for (let i = 0; i < 4; i++) {
        t.set('A', (i >> 1) & 1);
        t.set('B', i & 1);
        expect(t.bits('Y'), `${type}(${i >> 1},${i & 1})`).toBe(String(table[i]));
      }
    }
  });

  it('implements NOT and buffer', () => {
    const t = new Bench();
    const a = t.input('A');
    t.name('N', t.unary('not', a));
    t.name('B', t.unary('buffer', a));
    t.start();
    t.set('A', 0);
    expect([t.bits('N'), t.bits('B')]).toEqual(['1', '0']);
    t.set('A', 1);
    expect([t.bits('N'), t.bits('B')]).toEqual(['0', '1']);
    t.set('A', fromBits(['z']));
    expect([t.bits('N'), t.bits('B')]).toEqual(['x', 'x']);
  });

  for (const [type, ref] of Object.entries(GATES)) {
    it(`${type}: four-state behaviour for 2 and 3 inputs matches the reference model`, () => {
      for (const n of [2, 3]) {
        // Evaluate every combination in parallel, one combination per bit lane.
        const combos = allCombos(n);
        const width = combos.length; // 16 or 64 lanes; split into 32-bit chunks
        for (let start = 0; start < width; start += 32) {
          const chunk = combos.slice(start, start + 32);
          const t = new Bench();
          const ins = Array.from({ length: n }, (_, i) => t.input(`I${i}`, chunk.length));
          t.name('Y', t.gate(type, ins, { width: chunk.length }));
          t.start();
          for (let i = 0; i < n; i++) t.set(`I${i}`, fromBits(chunk.map((c) => c[i])));
          const out = toBits(t.get('Y'));
          chunk.forEach((c, lane) => expect(out[lane], `${type}(${c.join(',')})`).toBe(ref(c)));
        }
      }
    });
  }

  it('operates bitwise on 32-bit buses (randomized, reproducible)', () => {
    const rnd = prng(42);
    const t = new Bench();
    const a = t.input('A', 32);
    const b = t.input('B', 32);
    const c = t.input('C', 32);
    t.name('and', t.gate('and', [a, b, c], { width: 32 }));
    t.name('or', t.gate('or', [a, b, c], { width: 32 }));
    t.name('xor', t.gate('xor', [a, b, c], { width: 32 }));
    t.name('nand', t.gate('nand', [a, b, c], { width: 32 }));
    t.name('not', t.unary('not', a, { width: 32 }));
    t.start();
    for (let i = 0; i < 50; i++) {
      const [x, y, z] = [0, 0, 0].map(() => Math.floor(rnd() * 2 ** 32));
      t.set('A', fromUnsigned(32, x));
      t.set('B', fromUnsigned(32, y));
      t.set('C', fromUnsigned(32, z));
      expect(t.get('and')).toEqual(logic(32, x & y & z, 0));
      expect(t.get('or')).toEqual(logic(32, x | y | z, 0));
      expect(t.get('xor')).toEqual(logic(32, x ^ y ^ z, 0));
      expect(t.get('nand')).toEqual(logic(32, ~(x & y & z), 0));
      expect(t.get('not')).toEqual(logic(32, ~x, 0));
    }
  });

  it('supports up to 16 inputs', () => {
    const t = new Bench();
    const ins = Array.from({ length: 16 }, (_, i) => t.input(`I${i}`));
    t.name('Y', t.gate('and', ins));
    t.start();
    for (let i = 0; i < 16; i++) t.set(`I${i}`, 1);
    expect(t.bits('Y')).toBe('1');
    t.set('I9', 0);
    expect(t.bits('Y')).toBe('0');
  });

  it('tri-state buffer passes, releases, or drives unknown', () => {
    const t = new Bench();
    const d = t.input('D', 4);
    const en = t.input('EN');
    const out = t.net(4);
    t.add('tristate', { width: 4 }, [d, en, out]);
    t.name('Y', out);
    t.start();
    t.set('D', 0b1010);
    t.set('EN', 1);
    expect(t.bits('Y')).toBe('1010');
    t.set('EN', 0);
    expect(t.bits('Y')).toBe('zzzz');
    t.set('EN', fromBits(['x']));
    expect(t.bits('Y')).toBe('xxxx');
  });
});
