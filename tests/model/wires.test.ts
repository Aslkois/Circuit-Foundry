import { describe, expect, it } from 'vitest';
import {
  analyzeConnectivity,
  idGenerator,
  normalizeWires,
  projectContext,
  type Circuit,
  type Point,
  type Project,
  type Wire,
} from '../../src/model/index.ts';
import { prng } from '../engine/helpers.ts';

const w = (id: string, x1: number, y1: number, x2: number, y2: number): Wire => ({ id, x1, y1, x2, y2 });
const norm = (wires: Wire[], pins: Point[] = []) => normalizeWires(wires, pins, idGenerator('w', wires.map((x) => x.id)));
const shape = (wires: readonly Wire[]) => wires.map((x) => `${x.x1},${x.y1}-${x.x2},${x.y2}`).sort();

describe('wire canonicalization', () => {
  it('merges touching and overlapping collinear segments', () => {
    expect(shape(norm([w('w1', 0, 0, 3, 0), w('w2', 3, 0, 7, 0)]))).toEqual(['0,0-7,0']);
    expect(shape(norm([w('w1', 0, 0, 5, 0), w('w2', 3, 0, 9, 0), w('w3', 1, 0, 2, 0)]))).toEqual(['0,0-9,0']);
  });

  it('splits at pins and at the ends of perpendicular wires', () => {
    expect(shape(norm([w('w1', 0, 0, 10, 0)], [{ x: 4, y: 0 }]))).toEqual(['0,0-4,0', '4,0-10,0']);
    expect(shape(norm([w('w1', 0, 0, 10, 0), w('w2', 6, 0, 6, 5)]))).toEqual(['0,0-6,0', '6,0-10,0', '6,0-6,5']);
  });

  it('keeps an explicit four-way junction but not a plain crossing', () => {
    const fourWay = norm([w('a', 0, 0, 5, 0), w('b', 5, 0, 10, 0), w('v', 5, -5, 5, 5)]);
    expect(shape(fourWay)).toEqual(['0,0-5,0', '5,-5-5,0', '5,0-10,0', '5,0-5,5']);
    const crossing = norm([w('a', 0, 0, 10, 0), w('v', 5, -5, 5, 5)]);
    expect(shape(crossing)).toEqual(['0,0-10,0', '5,-5-5,5']);
  });

  it('drops zero-length wires and orders endpoints', () => {
    expect(shape(norm([w('w1', 3, 3, 3, 3), w('w2', 9, 1, 2, 1)]))).toEqual(['2,1-9,1']);
  });

  it('returns the same array when already canonical and keeps ids of unchanged segments', () => {
    const wires = [w('w1', 0, 0, 5, 0), w('w2', 5, 0, 5, 5)];
    expect(norm(wires)).toBe(wires);
    const out = norm([w('w1', 0, 0, 5, 0), w('w2', 5, 0, 5, 5), w('w3', 0, 9, 4, 9)], [{ x: 2, y: 9 }]);
    expect(out.find((x) => x.x1 === 0 && x.y1 === 0)?.id).toBe('w1');
    expect(out.find((x) => x.y1 === 5 || x.y2 === 5)?.id).toBe('w2');
    expect(new Set(out.map((x) => x.id)).size).toBe(out.length);
  });

  it('never changes which points are connected (randomized)', () => {
    const rnd = prng(2024);
    const ri = (n: number) => Math.floor(rnd() * n);
    for (let trial = 0; trial < 300; trial++) {
      const wires: Wire[] = [];
      for (let i = 0; i < 2 + ri(8); i++) {
        const x = ri(8);
        const y = ri(8);
        const len = 1 + ri(6);
        wires.push(rnd() < 0.5 ? w(`w${i + 1}`, x, y, x + len, y) : w(`w${i + 1}`, x, y, x, y + len));
      }
      // Probes are 1-pin components we can use as connection witnesses.
      const probes = Array.from({ length: 1 + ri(4) }, (_, i) => ({ id: `p${i}`, x: ri(10), y: ri(10) }));
      const components = probes.map((p) => ({ id: p.id, type: 'led', x: p.x, y: p.y, rotation: 0 as const, props: {} }));
      const witnesses = wires.flatMap((x) => [
        { x: x.x1, y: x.y1 },
        { x: x.x2, y: x.y2 },
      ]);
      const before = connectionClasses(components, wires, witnesses);
      const after = connectionClasses(components, [...norm(wires, probes)], witnesses);
      expect(after, JSON.stringify(wires)).toEqual(before);
    }
  });
});

/**
 * Partition of witness points (the original wire endpoints) and probes into
 * connected groups. Every wire covering a witness must be on the same net.
 */
function connectionClasses(components: Circuit['components'], wires: Wire[], witnesses: Point[]): string[][] {
  const circuit: Circuit = { id: 'm', name: 'm', components, wires };
  const project: Project = { id: 'p', name: 'p', mainCircuitId: 'm', circuits: [circuit], createdAt: '', modifiedAt: '' };
  const conn = analyzeConnectivity(circuit, projectContext(project));
  const groups = new Map<number, Set<string>>();
  const add = (net: number, label: string) => {
    let g = groups.get(net);
    if (!g) groups.set(net, (g = new Set()));
    g.add(label);
  };
  for (const c of components) add(conn.pinNet.get(`${c.id}:in`)!, c.id);
  for (const p of witnesses) {
    const nets = new Set<number>();
    for (const wire of wires) {
      const onH = wire.y1 === wire.y2 && p.y === wire.y1 && p.x >= Math.min(wire.x1, wire.x2) && p.x <= Math.max(wire.x1, wire.x2);
      const onV = wire.x1 === wire.x2 && p.x === wire.x1 && p.y >= Math.min(wire.y1, wire.y2) && p.y <= Math.max(wire.y1, wire.y2);
      if (onH || onV) nets.add(conn.wireNet.get(wire.id)!);
    }
    if (nets.size !== 1) return [[`inconsistent at ${p.x},${p.y}: ${nets.size} nets`]];
    add([...nets][0], `${p.x},${p.y}`);
  }
  return [...groups.values()].map((g) => [...g].sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
