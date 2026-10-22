import type { CircuitBuilder, ProjectBuilder } from '../model/index.ts';

/* Building blocks shared by several examples. */

export function note(b: CircuitBuilder, x: number, y: number, text: string, size = 'small'): void {
  b.add('text', x, y, { text, size });
}

export function defineHalfAdder(pb: ProjectBuilder): void {
  pb.circuit(
    'half-adder',
    'Half adder',
    (b) => {
      const a = b.add('input', 0, 0, { label: 'A' });
      const bb = b.add('input', 0, 6, { label: 'B' });
      const xor = b.add('xor', 10, 2);
      const and = b.add('and', 10, 10);
      const s = b.add('output', 18, 2, { label: 'S' });
      const c = b.add('output', 18, 10, { label: 'C' });
      b.wire(a.pin('out'), { x: 3, y: 0 }, { x: 3, y: 9 }, and.pin('in0'));
      b.wire({ x: 3, y: 1 }, xor.pin('in0'));
      b.wire(bb.pin('out'), { x: 5, y: 6 });
      b.wire(xor.pin('in1'), { x: 5, y: 3 }, { x: 5, y: 11 }, and.pin('in1'));
      b.wire(xor.pin('out'), s.pin('in'));
      b.wire(and.pin('out'), c.pin('in'));
      note(b, 10, -4, 'S = A XOR B (sum)    C = A AND B (carry)');
    },
    'Adds two bits: S is the sum bit, C the carry.',
  );
}

export function defineFullAdder(pb: ProjectBuilder): void {
  pb.circuit(
    'full-adder',
    'Full adder',
    (b) => {
      const a = b.add('input', 0, 0, { label: 'A' });
      const bb = b.add('input', 0, 4, { label: 'B' });
      const cin = b.add('input', 0, 8, { label: 'Cin' });
      const ha1 = b.sub('half-adder', 12, 2, 'HA1');
      const ha2 = b.sub('half-adder', 26, 6, 'HA2');
      const or = b.add('or', 38, 10);
      const sum = b.add('output', 44, 5, { label: 'Sum' });
      const cout = b.add('output', 44, 10, { label: 'Cout' });
      b.wire(a.pin('out'), { x: 4, y: 0 }, { x: 4, y: 1 }, ha1.port('A'));
      b.wire(bb.pin('out'), { x: 6, y: 4 }, { x: 6, y: 3 }, ha1.port('B'));
      b.wire(ha1.port('S'), { x: 19, y: 1 }, { x: 19, y: 5 }, ha2.port('A'));
      b.wire(cin.pin('out'), { x: 20, y: 8 }, { x: 20, y: 7 }, ha2.port('B'));
      b.wire(ha1.port('C'), { x: 32, y: 3 }, { x: 32, y: 9 }, or.pin('in0'));
      b.wire(ha2.port('S'), sum.pin('in'));
      b.wire(ha2.port('C'), { x: 31, y: 7 }, { x: 31, y: 11 }, or.pin('in1'));
      b.wire(or.pin('out'), cout.pin('in'));
      note(b, 22, -3, 'Two half adders and an OR gate. Double-click a half adder to look inside.');
    },
    'Adds three bits (A + B + carry in) using two half-adder subcircuits.',
  );
}
