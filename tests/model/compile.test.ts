import { describe, expect, it } from 'vitest';
import {
  CircuitRunner,
  ProjectBuilder,
  compileProject,
  locateKey,
  type Project,
} from '../../src/model/index.ts';
import { halfAdderProject } from './helpers.ts';

/** Inverter circuit plus wrappers nested three deep. */
function nestedProject(): Project {
  const pb = new ProjectBuilder('p', 'Nested');
  pb.circuit('inv', 'Inverter', (b) => {
    const i = b.add('input', 0, 0, { label: 'in' });
    const n = b.add('not', 4, 0);
    const o = b.add('output', 8, 0, { label: 'out' });
    b.wire(i.pin('out'), n.pin('in'));
    b.wire(n.pin('out'), o.pin('in'));
  });
  pb.circuit('double', 'Double', (b) => {
    const i = b.add('input', 0, 0, { label: 'in' });
    const s1 = b.sub('inv', 6, 0);
    const s2 = b.sub('inv', 16, 0);
    const o = b.add('output', 24, 0, { label: 'out' });
    b.wire(i.pin('out'), s1.port('in'));
    b.wire(s1.port('out'), s2.port('in'));
    b.wire(s2.port('out'), o.pin('in'));
  });
  pb.circuit('top', 'Top', (b) => {
    const i = b.add('input', 0, 0, { label: 'X' });
    const d = b.sub('double', 6, 0);
    const v = b.sub('inv', 16, 0);
    const o = b.add('output', 24, 0, { label: 'Y' });
    b.wire(i.pin('out'), d.port('in'));
    b.wire(d.port('out'), v.port('in'));
    b.wire(v.port('out'), o.pin('in'));
  });
  return pb.build('top');
}

describe('compiling designs', () => {
  it('simulates a half adder built from gates', () => {
    const r = new CircuitRunner(halfAdderProject());
    expect(r.design.diagnostics).toEqual([]);
    expect(r.truthTable(['A', 'B'], ['S', 'C'])).toEqual([
      { in: [0, 0], out: [0, 0] },
      { in: [0, 1], out: [1, 0] },
      { in: [1, 0], out: [1, 0] },
      { in: [1, 1], out: [0, 1] },
    ]);
  });

  it('flattens nested subcircuits with per-instance keys and no extra port delay', () => {
    const r = new CircuitRunner(nestedProject());
    expect(r.design.instanceCount).toBe(5);
    expect(r.design.netlist.components.map((c) => c.key).sort()).toEqual(['c1', 'c2/c2/c2', 'c2/c3/c2', 'c3/c2']);
    r.set('X', 0);
    expect(r.bits('Y')).toBe('1');
    const t0 = r.sim.time;
    r.set('X', 1);
    expect(r.bits('Y')).toBe('0');
    // input source delay + three inverters; subcircuit boundaries add nothing
    expect(r.sim.time - t0).toBe(4);
    expect(locateKey(r.design, 'c2/c3/c2')).toMatchObject({ componentId: 'c2', node: { path: ['c2', 'c3'] } });
  });

  it('keeps state separately for each instance of a stateful subcircuit', () => {
    const pb = new ProjectBuilder('p', 'Latches');
    pb.circuit('sr', 'SR latch', (b) => {
      // g1 = NOR(R, g2) is Q; g2 = NOR(g1, S) is not-Q.
      const r = b.add('input', 0, 0, { label: 'R' });
      const s = b.add('input', 0, 8, { label: 'S' });
      const g1 = b.add('nor', 10, 1);
      const g2 = b.add('nor', 10, 7);
      const q = b.add('output', 20, 1, { label: 'Q' });
      b.wire(r.pin('out'), { x: 7, y: 0 });
      b.wire(s.pin('out'), { x: 7, y: 8 });
      b.wire(g1.pin('out'), q.pin('in'));
      b.wire({ x: 15, y: 1 }, { x: 15, y: 4 }, { x: 5, y: 4 }, { x: 5, y: 6 }, g2.pin('in0'));
      b.wire(g2.pin('out'), { x: 16, y: 7 }, { x: 16, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 2 }, g1.pin('in1'));
    });
    pb.circuit('top', 'Top', (b) => {
      const s1 = b.add('input', 0, 5, { label: 'S1' });
      const s2 = b.add('input', 0, 17, { label: 'S2' });
      const r = b.add('input', 0, 22, { label: 'R' });
      const l1 = b.sub('sr', 12, 4);
      const l2 = b.sub('sr', 12, 16);
      const q1 = b.add('output', 22, 4, { label: 'Q1' });
      const q2 = b.add('output', 22, 16, { label: 'Q2' });
      b.wire(s1.pin('out'), l1.port('S'));
      b.wire(s2.pin('out'), l2.port('S'));
      b.wire(r.pin('out'), { x: 4, y: 22 }, { x: 4, y: 3 }, l1.port('R'));
      b.wire({ x: 4, y: 15 }, l2.port('R'));
      b.wire(l1.port('Q'), q1.pin('in'));
      b.wire(l2.port('Q'), q2.pin('in'));
    });
    const r = new CircuitRunner(pb.build('top'));
    expect(r.design.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect([r.bits('Q1'), r.bits('Q2')]).toEqual(['x', 'x']);
    r.set('S1', 1);
    r.set('S1', 0);
    expect([r.bits('Q1'), r.bits('Q2')]).toEqual(['1', 'x']);
    r.set('R', 1);
    r.set('R', 0);
    expect([r.bits('Q1'), r.bits('Q2')]).toEqual(['0', '0']);
    r.set('S2', 1);
    r.set('S2', 0);
    expect([r.bits('Q1'), r.bits('Q2')]).toEqual(['0', '1']);
  });

  it('carries tri-state signals across subcircuit boundaries', () => {
    const pb = new ProjectBuilder('p', 'Bus');
    pb.circuit('drv', 'Driver', (b) => {
      const d = b.add('input', 0, 0, { label: 'D', width: 4 });
      const e = b.add('input', 0, 6, { label: 'E' });
      const t = b.add('tristate', 6, 0, { width: 4 });
      const o = b.add('output', 12, 0, { label: 'Y', width: 4 });
      b.wire(d.pin('out'), t.pin('in'));
      b.wire(e.pin('out'), { x: 6, y: 6 }, t.pin('en'));
      b.wire(t.pin('out'), o.pin('in'));
    });
    pb.circuit('top', 'Top', (b) => {
      const d1 = b.add('constant', 0, 0, { width: 4, value: 3 });
      const e1 = b.add('input', 0, 2, { label: 'E1' });
      const d2 = b.add('constant', 0, 10, { width: 4, value: 12 });
      const e2 = b.add('input', 0, 12, { label: 'E2' });
      const u1 = b.sub('drv', 10, 1);
      const u2 = b.sub('drv', 10, 11);
      const bus = b.add('output', 24, 6, { label: 'BUS', width: 4 });
      b.connect(d1.pin('out'), u1.port('D'));
      b.connect(e1.pin('out'), u1.port('E'));
      b.connect(d2.pin('out'), u2.port('D'));
      b.connect(e2.pin('out'), u2.port('E'));
      b.wire(u1.port('Y'), { x: 18, y: 1 }, { x: 18, y: 11 }, u2.port('Y'));
      b.wire({ x: 18, y: 6 }, bus.pin('in'));
    });
    const r = new CircuitRunner(pb.build('top'));
    expect(r.bits('BUS')).toBe('zzzz');
    r.set('E1', 1);
    expect(r.num('BUS')).toBe(3);
    r.set('E1', 0);
    r.set('E2', 1);
    expect(r.num('BUS')).toBe(12);
    r.set('E1', 1);
    expect(r.bits('BUS')).toBe('xxxx');
  });

  it('splits buses with splitters', () => {
    const pb = new ProjectBuilder('p', 'Split');
    pb.circuit('m', 'Main', (b) => {
      const i = b.add('input', 0, 0, { label: 'V', width: 4 });
      const sp = b.add('splitter', 2, 0, { busWidth: 4, fanout: 4 });
      const o0 = b.add('output', 8, 1, { label: 'b0' });
      const o3 = b.add('output', 8, 4, { label: 'b3' });
      b.wire(i.pin('out'), sp.pin('bus'));
      b.wire(sp.pin('f0'), o0.pin('in'));
      b.wire(sp.pin('f3'), o3.pin('in'));
    });
    const r = new CircuitRunner(pb.build('m'));
    r.set('V', 0b1000);
    expect([r.bits('b0'), r.bits('b3')]).toEqual(['0', '1']);
    r.set('V', 0b0001);
    expect([r.bits('b0'), r.bits('b3')]).toEqual(['1', '0']);
  });

  it('reports recursive subcircuits instead of expanding them forever', () => {
    const base = nestedProject();
    // Make "inv" contain an instance of "top", which contains "inv": a cycle.
    const project: Project = {
      ...base,
      circuits: base.circuits.map((c) =>
        c.id === 'inv'
          ? { ...c, components: [...c.components, { id: 'loop', type: 'subcircuit', x: 40, y: 40, rotation: 0, props: { circuit: 'top', label: '' } }] }
          : c,
      ),
    };
    const design = compileProject(project, 'top');
    const recursive = design.diagnostics.filter((d) => d.code === 'recursive-subcircuit');
    expect(recursive.length).toBeGreaterThan(0);
    expect(recursive.every((d) => d.severity === 'error')).toBe(true);
    expect(design.instanceCount).toBeLessThan(10);
  });

  it('reports width conflicts and keeps simulating the rest', () => {
    const pb = new ProjectBuilder('p', 'Widths');
    pb.circuit('m', 'Main', (b) => {
      const a = b.add('input', 0, 0, { label: 'A', width: 4 });
      const y = b.add('output', 6, 0, { label: 'Y' });
      const c = b.add('input', 0, 6, { label: 'C' });
      const z = b.add('output', 6, 6, { label: 'Z' });
      b.wire(a.pin('out'), y.pin('in'));
      b.wire(c.pin('out'), z.pin('in'));
    });
    const r = new CircuitRunner(pb.build('m'));
    const errs = r.design.diagnostics.filter((d) => d.code === 'width-conflict');
    expect(errs).toHaveLength(1);
    expect(errs[0].componentIds).toEqual(['c1', 'c2']);
    r.set('C', 1);
    expect(r.bits('Z')).toBe('1');
    expect(r.bits('Y')).toBe('z');
  });

  it('warns about missing subcircuit definitions and multiple drivers', () => {
    const pb = new ProjectBuilder('p', 'Warn');
    pb.circuit('m', 'Main', (b) => {
      const a = b.add('input', 0, 0, { label: 'A' });
      const c = b.add('input', 0, 4, { label: 'B' });
      b.wire(a.pin('out'), { x: 2, y: 0 }, { x: 2, y: 4 }, c.pin('out'));
      b.add('subcircuit', 20, 20, { circuit: 'nope' });
    });
    const design = compileProject(pb.build('m'), 'm');
    expect(design.diagnostics.map((d) => d.code).sort()).toEqual(['missing-circuit', 'multiple-drivers']);
  });
});
