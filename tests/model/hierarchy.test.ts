import { describe, expect, it } from 'vitest';
import {
  CircuitRunner,
  ProjectBuilder,
  compileProject,
  projectContext,
  resolveComponent,
  type Project,
} from '../../src/model/index.ts';

/** N-bit inverter with parameter N (default 4), and a top circuit using it at several widths. */
function parametricProject(): Project {
  const pb = new ProjectBuilder('p', 'Parametric');
  pb.circuit('invN', 'Inverter', (b) => {
    b.param('N', 4, 1, 32, 'Bit width');
    const a = b.add('input', 0, 0, { label: 'A' });
    const n = b.add('not', 4, 0);
    const y = b.add('output', 8, 0, { label: 'Y' });
    b.bind(a, 'width', 'N').bind(n, 'width', 'N').bind(y, 'width', 'N');
    b.wire(a.pin('out'), n.pin('in'));
    b.wire(n.pin('out'), y.pin('in'));
  });
  pb.circuit('top', 'Top', (b) => {
    const a8 = b.add('input', 0, 0, { label: 'A8', width: 8 });
    const b8 = b.add('input', 0, 10, { label: 'B8', width: 8 });
    const a3 = b.add('input', 0, 20, { label: 'A3', width: 3 });
    const u1 = b.sub('invN', 10, 0, '', 0, { N: 8 });
    const u2 = b.sub('invN', 10, 10, '', 0, { N: 8 });
    const u3 = b.sub('invN', 10, 20, '', 0, { N: 3 });
    const y1 = b.add('output', 20, 0, { label: 'Y1', width: 8 });
    const y2 = b.add('output', 20, 10, { label: 'Y2', width: 8 });
    const y3 = b.add('output', 20, 20, { label: 'Y3', width: 3 });
    b.wire(a8.pin('out'), u1.port('A'));
    b.wire(b8.pin('out'), u2.port('A'));
    b.wire(a3.pin('out'), u3.port('A'));
    b.wire(u1.port('Y'), y1.pin('in'));
    b.wire(u2.port('Y'), y2.pin('in'));
    b.wire(u3.port('Y'), y3.pin('in'));
  });
  return pb.build('top');
}

describe('parametric components', () => {
  it('stores the default specialization and evaluates bindings per instance', () => {
    const project = parametricProject();
    const inv = project.circuits.find((c) => c.id === 'invN')!;
    expect(inv.components.map((c) => c.props.width)).toEqual([4, 4, 4]);

    const r = new CircuitRunner(project);
    expect(r.design.diagnostics).toEqual([]);
    r.setMany({ A8: 0b1010_0101, B8: 0x0f, A3: 0b101 });
    expect(r.num('Y1')).toBe(0b0101_1010);
    expect(r.num('Y2')).toBe(0xf0);
    expect(r.num('Y3')).toBe(0b010);
  });

  it('shares one template per definition and parameter set', () => {
    const design = compileProject(parametricProject(), 'top');
    expect(design.instanceCount).toBe(4);
    // top, invN with N=8 (used twice), invN with N=3
    expect(design.templateCount).toBe(3);
    const u1 = design.root!.children.get('c4')!;
    const u3 = design.root!.children.get('c6')!;
    expect(u1.params).toEqual({ N: 8 });
    expect(u3.params).toEqual({ N: 3 });
    expect(u1.circuit.components.every((c) => c.props.width === 8)).toBe(true);
    expect(u1.keys.get('c2')).toBe('c4/c2');
    // Ports of a subcircuit are merged with the outer nets, not simulated.
    expect(u1.keys.get('c1')).toBeUndefined();
  });

  it('gives instances pins of the selected width', () => {
    const project = parametricProject();
    const ctx = projectContext(project);
    const top = project.circuits.find((c) => c.id === 'top')!;
    const widths = top.components.filter((c) => c.type === 'subcircuit').map((c) => resolveComponent(c, ctx).pins.map((p) => p.width));
    expect(widths).toEqual([
      [8, 8],
      [8, 8],
      [3, 3],
    ]);
  });

  it('passes parameters down through bindings of instance parameters', () => {
    const pb = new ProjectBuilder('p', 'Nested params');
    pb.circuit('invN', 'Inverter', (b) => {
      b.param('N', 4, 1, 32);
      const a = b.add('input', 0, 0, { label: 'A' });
      const n = b.add('not', 4, 0);
      const y = b.add('output', 8, 0, { label: 'Y' });
      b.bind(a, 'width', 'N').bind(n, 'width', 'N').bind(y, 'width', 'N');
      b.wire(a.pin('out'), n.pin('in'));
      b.wire(n.pin('out'), y.pin('in'));
    });
    pb.circuit('wide', 'Wide', (b) => {
      b.param('M', 2, 1, 16);
      const a = b.add('input', 0, 0, { label: 'A' });
      const u = b.sub('invN', 8, 0);
      const y = b.add('output', 16, 0, { label: 'Y' });
      b.bind(a, 'width', 'M*2').bind(u, '@N', 'M*2').bind(y, 'width', 'M*2');
      b.wire(a.pin('out'), u.port('A'));
      b.wire(u.port('Y'), y.pin('in'));
    });
    pb.circuit('top', 'Top', (b) => {
      const a = b.add('input', 0, 0, { label: 'A', width: 12 });
      const u = b.sub('wide', 8, 0, '', 0, { M: 6 });
      const y = b.add('output', 16, 0, { label: 'Y', width: 12 });
      b.wire(a.pin('out'), u.port('A'));
      b.wire(u.port('Y'), y.pin('in'));
    });
    const r = new CircuitRunner(pb.build('top'));
    expect(r.design.diagnostics).toEqual([]);
    r.set('A', 0x0f0);
    expect(r.num('Y')).toBe(0xf0f);
    expect(r.design.root!.children.get('c2')!.children.get('c2')!.params).toEqual({ N: 12 });
  });

  it('reports failed bindings and out-of-range instance parameters', () => {
    const pb = new ProjectBuilder('p', 'Problems');
    pb.circuit('invN', 'Inverter', (b) => {
      b.param('N', 4, 1, 8);
      const a = b.add('input', 0, 0, { label: 'A' });
      const n = b.add('not', 4, 0);
      const y = b.add('output', 8, 0, { label: 'Y' });
      b.bind(a, 'width', 'N').bind(n, 'width', 'N').bind(y, 'width', 'N');
      b.wire(a.pin('out'), n.pin('in'));
      b.wire(n.pin('out'), y.pin('in'));
    });
    pb.circuit('top', 'Top', (b) => {
      b.sub('invN', 10, 0, '', 0, { N: 20 });
    });
    const project = pb.build('top');
    const design = compileProject(project, 'top');
    expect(design.diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid-props', severity: 'warning', circuitId: 'top', message: 'Subcircuit parameter N = 20 is outside 1..8; using 8.' }),
    ]);
    expect(design.root!.children.get('c1')!.params).toEqual({ N: 8 });

    const broken: Project = {
      ...project,
      circuits: project.circuits.map((c) =>
        c.id === 'invN' ? { ...c, components: c.components.map((x) => (x.id === 'c2' ? { ...x, bind: { width: 'N / (N - N)' } } : x)) } : c,
      ),
    };
    const d2 = compileProject(broken, 'top');
    expect(d2.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'binding', circuitId: 'invN', componentIds: ['c2'], message: expect.stringContaining('division by zero') }),
    );
  });
});

describe('tunnels', () => {
  it('connects tunnels with the same label, including buses', () => {
    const pb = new ProjectBuilder('p', 'Tunnels');
    pb.circuit('t', 'Tunnels', (b) => {
      const a = b.add('input', 0, 0, { label: 'A', width: 4 });
      const t1 = b.add('tunnel', 6, 0, { label: 'data' }, 180);
      const t2 = b.add('tunnel', 10, 10, { label: 'data' });
      const t3 = b.add('tunnel', 10, 20, { label: 'other' });
      const y = b.add('output', 16, 10, { label: 'Y', width: 4 });
      const z = b.add('output', 16, 20, { label: 'Z', width: 4 });
      b.wire(a.pin('out'), t1.pin('io'));
      b.wire(t2.pin('io'), y.pin('in'));
      b.wire(t3.pin('io'), z.pin('in'));
    });
    const r = new CircuitRunner(pb.build('t'));
    expect(r.design.diagnostics).toEqual([]);
    r.set('A', 9);
    expect(r.num('Y')).toBe(9);
    expect(r.bits('Z')).toBe('zzzz');
  });
});

describe('custom symbols', () => {
  it('places ports on the requested sides and keeps them working', () => {
    const pb = new ProjectBuilder('p', 'Symbols');
    pb.circuit('cell', 'Cell', (b) => {
      const a = b.add('input', 0, 0, { label: 'A' });
      const clk = b.add('input', 0, 2, { label: 'CLK' });
      const en = b.add('input', 0, 4, { label: 'EN' });
      const g = b.add('and', 6, 2, { inputs: 3 });
      const y = b.add('output', 12, 2, { label: 'Y' });
      b.wire(a.pin('out'), g.pin('in0'));
      b.wire(clk.pin('out'), g.pin('in1'));
      b.wire(en.pin('out'), g.pin('in2'));
      b.wire(g.pin('out'), y.pin('in'));
      b.symbol({ width: 8, label: 'CELL', ports: { c2: { side: 'bottom', slot: 0 }, c3: { side: 'top', slot: 0 } } });
    });
    pb.circuit('top', 'Top', (b) => {
      const u = b.sub('cell', 20, 20);
      const pins = Object.fromEntries(resolveComponent(u.comp, pb.ctx).pins.map((p) => [p.label, { x: p.x - 20, y: p.y - 20 }]));
      expect(pins).toEqual({ A: { x: -5, y: 0 }, EN: { x: 0, y: -2 }, CLK: { x: 0, y: 2 }, Y: { x: 5, y: 0 } });
      const a = b.add('input', 10, 20, { label: 'A' });
      const c = b.add('input', 20, 26, { label: 'C' }, 270);
      const e = b.add('input', 20, 14, { label: 'E' }, 90);
      const y = b.add('output', 30, 20, { label: 'Y' });
      b.wire(a.pin('out'), u.port('A'));
      b.wire(c.pin('out'), u.port('CLK'));
      b.wire(e.pin('out'), u.port('EN'));
      b.wire(u.port('Y'), y.pin('in'));
    });
    const project = pb.build('top');
    const ctx = projectContext(project);
    expect(ctx.getInterface('cell')).toMatchObject({
      symbolWidth: 8,
      symbolLabel: 'CELL',
      inputs: [
        { label: 'A', side: 'left', slot: 0, clock: false },
        { label: 'EN', side: 'top', slot: 0 },
        { label: 'CLK', side: 'bottom', slot: 0, clock: true },
      ],
    });
    const r = new CircuitRunner(project);
    expect(r.design.diagnostics).toEqual([]);
    expect(r.truthTable(['A', 'C', 'E'], ['Y']).map((row) => row.out[0])).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });
});
