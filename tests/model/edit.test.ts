import { describe, expect, it } from 'vitest';
import {
  CircuitRunner,
  addCircuit,
  addComponents,
  addWires,
  analyzeConnectivity,
  createComponent,
  deleteItems,
  moveItems,
  pasteItems,
  pinKey,
  projectContext,
  replaceCircuit,
  rotateComponents,
  setComponentProps,
  wouldCreateCycle,
  type Circuit,
  type Project,
} from '../../src/model/index.ts';
import { halfAdderProject } from './helpers.ts';

function edit(project: Project, fn: (c: Circuit, ctx: ReturnType<typeof projectContext>) => Circuit): Project {
  const ctx = projectContext(project);
  return replaceCircuit(project, fn(project.circuits[0], ctx));
}

function connected(project: Project, a: [string, string], b: [string, string]): boolean {
  const c = project.circuits[0];
  const conn = analyzeConnectivity(c, projectContext(project));
  return conn.pinNet.get(pinKey(...a)) === conn.pinNet.get(pinKey(...b));
}

describe('editing', () => {
  it('builds a working circuit from scratch with add operations', () => {
    let p: Project = { id: 'p', name: 'P', mainCircuitId: 'm', circuits: [{ id: 'm', name: 'M', components: [], wires: [] }], createdAt: '', modifiedAt: '' };
    p = edit(p, (c, ctx) => addComponents(c, [createComponent(c, 'input', 0, 0, 0, { label: 'A' })], ctx));
    p = edit(p, (c, ctx) => addComponents(c, [createComponent(c, 'not', 6, 0)], ctx));
    p = edit(p, (c, ctx) => addComponents(c, [createComponent(c, 'output', 12, 0, 0, { label: 'Y' })], ctx));
    // One straight wire through the NOT gate's pins would short them; draw two separate wires.
    p = edit(p, (c, ctx) => addWires(c, [{ x1: 0, y1: 0, x2: 4, y2: 0 }], ctx));
    p = edit(p, (c, ctx) => addWires(c, [{ x1: 8, y1: 0, x2: 12, y2: 0 }], ctx));
    const r = new CircuitRunner(p);
    r.set('A', 0);
    expect(r.bits('Y')).toBe('1');
    r.set('A', 1);
    expect(r.bits('Y')).toBe('0');
  });

  it('splits a wire drawn straight across a pin so the pin connects', () => {
    let p: Project = { id: 'p', name: 'P', mainCircuitId: 'm', circuits: [{ id: 'm', name: 'M', components: [], wires: [] }], createdAt: '', modifiedAt: '' };
    p = edit(p, (c, ctx) => addComponents(c, [createComponent(c, 'led', 5, 0)], ctx));
    p = edit(p, (c, ctx) => addWires(c, [{ x1: 0, y1: 0, x2: 10, y2: 0 }], ctx));
    expect(p.circuits[0].wires.map((w) => [w.x1, w.x2])).toEqual([
      [0, 5],
      [5, 10],
    ]);
  });

  it('moves components with rubber-band wires that stay connected', () => {
    const p0 = halfAdderProject();
    // Move the AND gate (c4) and its output pin (c6) down and right.
    const p1 = edit(p0, (c, ctx) => moveItems(c, new Set(['c4']), new Set(), 2, 3, ctx));
    expect(connected(p1, ['c4', 'in0'], ['c1', 'out'])).toBe(true);
    expect(connected(p1, ['c4', 'in1'], ['c2', 'out'])).toBe(true);
    expect(connected(p1, ['c4', 'out'], ['c6', 'in'])).toBe(true);
    for (const w of p1.circuits[0].wires) expect(w.x1 === w.x2 || w.y1 === w.y2).toBe(true);
    const r = new CircuitRunner(p1);
    r.set('A', 1);
    r.set('B', 1);
    expect([r.bits('S'), r.bits('C')]).toEqual(['0', '1']);
  });

  it('moves without rubber band can disconnect', () => {
    const p1 = edit(halfAdderProject(), (c, ctx) => moveItems(c, new Set(['c4']), new Set(), 0, 5, ctx, false));
    expect(connected(p1, ['c4', 'out'], ['c6', 'in'])).toBe(false);
  });

  it('deletes components and wires, re-merging wires split at removed pins', () => {
    let p: Project = { id: 'p', name: 'P', mainCircuitId: 'm', circuits: [{ id: 'm', name: 'M', components: [], wires: [] }], createdAt: '', modifiedAt: '' };
    p = edit(p, (c, ctx) => addComponents(c, [createComponent(c, 'led', 5, 0)], ctx));
    p = edit(p, (c, ctx) => addWires(c, [{ x1: 0, y1: 0, x2: 10, y2: 0 }], ctx));
    p = edit(p, (c, ctx) => deleteItems(c, new Set(['c1']), new Set(), ctx));
    expect(p.circuits[0].components).toEqual([]);
    expect(p.circuits[0].wires.map((w) => [w.x1, w.x2])).toEqual([[0, 10]]);
  });

  it('rotates components about their anchor', () => {
    const p = edit(halfAdderProject(), (c, ctx) => rotateComponents(c, new Set(['c3']), true, ctx));
    expect(p.circuits[0].components.find((c) => c.id === 'c3')?.rotation).toBe(90);
    const back = edit(p, (c, ctx) => rotateComponents(c, new Set(['c3']), false, ctx));
    expect(back.circuits[0].components.find((c) => c.id === 'c3')?.rotation).toBe(0);
  });

  it('changes props, which can change pins', () => {
    const p = edit(halfAdderProject(), (c, ctx) => setComponentProps(c, 'c3', { inputs: 3 }, ctx));
    const conn = analyzeConnectivity(p.circuits[0], projectContext(p));
    expect(conn.components.get('c3')?.pins.map((x) => x.name)).toEqual(['in0', 'in1', 'in2', 'out']);
  });

  it('pastes copies with fresh ids', () => {
    const p0 = halfAdderProject();
    const c0 = p0.circuits[0];
    const res = pasteItems(c0, c0.components, c0.wires, 0, 20, projectContext(p0));
    expect(res.circuit.components).toHaveLength(12);
    expect(new Set(res.circuit.components.map((c) => c.id)).size).toBe(12);
    expect(res.componentIds).toEqual(['c7', 'c8', 'c9', 'c10', 'c11', 'c12']);
  });

  it('detects instances that would make a circuit contain itself', () => {
    let p = halfAdderProject();
    const added = addCircuit(p, 'Wrapper');
    p = added.project;
    const wrapper = added.circuit;
    const ctx = projectContext(p);
    p = replaceCircuit(p, addComponents(wrapper, [createComponent(wrapper, 'subcircuit', 0, 0, 0, { circuit: 'ha' })], ctx));
    expect(wouldCreateCycle(p, wrapper.id, 'ha')).toBe(false);
    expect(wouldCreateCycle(p, 'ha', wrapper.id)).toBe(true);
    expect(wouldCreateCycle(p, 'ha', 'ha')).toBe(true);
  });
});
