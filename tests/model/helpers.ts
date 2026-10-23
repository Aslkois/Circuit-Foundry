import { ProjectBuilder, type Project } from '../../src/model/index.ts';

/**
 * Half adder from individual gates:
 *   A ─┬──────── XOR ── S
 *   B ─┼─┬────── AND ── C
 */
export function halfAdderProject(): Project {
  const pb = new ProjectBuilder('test', 'Test');
  pb.circuit('ha', 'Half adder', (b) => {
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
  });
  return pb.build('ha');
}
