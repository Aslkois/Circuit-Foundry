import { describe, expect, it } from 'vitest';
import {
  CircuitRunner,
  ProjectBuilder,
  addComponents,
  analyzeConnectivity,
  createComponent,
  deleteItems,
  findCircuit,
  pinKey,
  projectContext,
  replaceCircuit,
  syncInstances,
  type Circuit,
  type Project,
} from '../../src/model/index.ts';

/** "cell" = OR(A, B) → Y, used twice in "top" with every port wired. */
function project(): Project {
  const pb = new ProjectBuilder('p', 'Sync');
  pb.circuit('cell', 'Cell', (b) => {
    const a = b.add('input', 0, 0, { label: 'A' });
    const bb = b.add('input', 0, 2, { label: 'B' });
    const g = b.add('or', 6, 1);
    const y = b.add('output', 12, 1, { label: 'Y' });
    b.connect(a.pin('out'), g.pin('in0'));
    b.connect(bb.pin('out'), g.pin('in1'));
    b.wire(g.pin('out'), y.pin('in'));
  });
  pb.circuit('top', 'Top', (b) => {
    const u1 = b.sub('cell', 20, 10);
    const u2 = b.sub('cell', 20, 30);
    const x1 = b.add('input', 8, 9, { label: 'X1' });
    const x2 = b.add('input', 8, 11, { label: 'X2' });
    const x3 = b.add('input', 8, 29, { label: 'X3' });
    const x4 = b.add('input', 8, 31, { label: 'X4' });
    const z1 = b.add('output', 32, 10, { label: 'Z1' });
    const z2 = b.add('output', 32, 30, { label: 'Z2' });
    b.wire(x1.pin('out'), u1.port('A'));
    b.wire(x2.pin('out'), u1.port('B'));
    b.wire(x3.pin('out'), u2.port('A'));
    b.wire(x4.pin('out'), u2.port('B'));
    b.wire(u1.port('Y'), z1.pin('in'));
    b.wire(u2.port('Y'), z2.pin('in'));
  });
  return pb.build('top');
}

function editCell(p: Project, fn: (c: Circuit) => Circuit): Project {
  return replaceCircuit(p, fn(findCircuit(p, 'cell')!));
}

/** Which top-level component pins share a net with each instance port. */
function portNets(p: Project): Record<string, string[]> {
  const top = findCircuit(p, 'top')!;
  const conn = analyzeConnectivity(top, projectContext(p));
  const out: Record<string, string[]> = {};
  for (const id of ['c1', 'c2']) {
    for (const port of conn.components.get(id)!.pins) {
      const net = conn.pinNet.get(pinKey(id, port.name));
      out[`${id}.${port.label}`] = net === undefined ? [] : conn.nets[net].pins.filter((x) => x.componentId !== id).map((x) => x.componentId);
    }
  }
  return out;
}

function behaviour(p: Project): (number | null)[] {
  const r = new CircuitRunner(p);
  return r.truthTable(['X1', 'X2', 'X3', 'X4'], ['Z1', 'Z2']).map((row) => (row.out[0] ?? 9) * 10 + (row.out[1] ?? 9));
}

describe('instance synchronization', () => {
  it('keeps connections when a port is added and the others shift', () => {
    const before = project();
    const expected = portNets(before);
    const reference = behaviour(before);
    const ctx = projectContext(before);
    const after = editCell(before, (c) => addComponents(c, [createComponent(c, 'input', 0, -4, 0, { label: 'C' })], ctx));
    // Without synchronization the shifted ports lose their wires.
    expect(portNets(after)['c1.A']).toEqual([]);

    const r = syncInstances(before, after);
    expect(r.disconnected).toEqual([]);
    expect(r.rerouted).toBe(4);
    const nets = portNets(r.project);
    expect(nets).toEqual({ ...expected, 'c1.C': [], 'c2.C': [] });
    expect(behaviour(r.project)).toEqual(reference);
    expect(new CircuitRunner(r.project).design.diagnostics).toEqual([]);
  });

  it('keeps connections when the symbol is widened or ports change sides', () => {
    const before = project();
    const expected = portNets(before);
    const after = editCell(before, (c) => ({ ...c, symbol: { width: 10, ports: { c3: { side: 'right', slot: 1 } } } }));
    const r = syncInstances(before, after);
    expect(r.disconnected).toEqual([]);
    expect(portNets(r.project)).toEqual(expected);
    expect(behaviour(r.project)).toEqual(behaviour(before));
  });

  it('reports wires to removed ports and leaves them in place', () => {
    const before = project();
    const ctx = projectContext(before);
    const after = editCell(before, (c) => deleteItems(c, new Set(['c2']), new Set(), ctx));
    const r = syncInstances(before, after);
    expect(r.disconnected).toEqual([
      { circuitId: 'top', componentId: 'c1', port: 'B', reason: 'removed' },
      { circuitId: 'top', componentId: 'c2', port: 'B', reason: 'removed' },
    ]);
    const nets = portNets(r.project);
    expect(nets['c1.A']).toEqual(['c3']);
    expect(nets['c2.A']).toEqual(['c5']);
  });

  it('does nothing for edits that leave interfaces unchanged', () => {
    const before = project();
    const ctx = projectContext(before);
    const after = editCell(before, (c) => addComponents(c, [createComponent(c, 'not', 4, 8)], ctx));
    const r = syncInstances(before, after);
    expect(r.project).toBe(after);
    expect(r.rerouted).toBe(0);
  });

  it('never routes through other pins or wires', () => {
    const before = project();
    const ctx = projectContext(before);
    // Crowd the space left of the first instance with a vertical wire right next to its ports.
    const crowded = replaceCircuit(before, {
      ...findCircuit(before, 'top')!,
      wires: [...findCircuit(before, 'top')!.wires, { id: 'wx', x1: 14, y1: 0, x2: 14, y2: 20 }],
    });
    const after = editCell(crowded, (c) => addComponents(c, [createComponent(c, 'input', 0, -4, 0, { label: 'C' })], ctx));
    const r = syncInstances(crowded, after);
    const nets = portNets(r.project);
    // The vertical wire crosses the horizontal leads; it must not join any of them.
    for (const port of ['c1.A', 'c1.B']) expect(nets[port].length).toBeLessThanOrEqual(1);
    expect(r.disconnected.length + r.rerouted).toBe(4);
    expect(behaviour(r.project)).toEqual(behaviour(before));
  });

  it('leaves a wire unconnected rather than touching another pin', () => {
    const before = project();
    const ctx = projectContext(before);
    const top = findCircuit(before, 'top')!;
    // A probe exactly where every route to the new position of u1.A would pass.
    const blocked = replaceCircuit(before, addComponents(top, [{ ...createComponent(top, 'probe', 15, 10), id: 'pr' }], ctx));
    const after = editCell(blocked, (c) => addComponents(c, [createComponent(c, 'input', 0, -4, 0, { label: 'C' })], ctx));
    const r = syncInstances(blocked, after);
    expect(r.disconnected).toEqual([{ circuitId: 'top', componentId: 'c1', port: 'A', reason: 'no-route' }]);
    const conn = analyzeConnectivity(findCircuit(r.project, 'top')!, projectContext(r.project));
    const probeNet = conn.pinNet.get(pinKey('pr', 'in'));
    expect(probeNet === undefined || conn.nets[probeNet].pins.length === 1).toBe(true);
    expect(portNets(r.project)['c1.B']).toEqual(['c4']);
  });
});
