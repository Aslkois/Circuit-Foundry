import { describe, expect, it } from 'vitest';
import {
  CircuitRunner,
  ExtractError,
  extractComponent,
  findCircuit,
  parseProject,
  projectContext,
  serializeProject,
  type Project,
} from '../../src/model/index.ts';
import { rippleAdderProject, srLatchProject } from '../../src/samples/index.ts';
import { halfAdderProject } from './helpers.ts';

function table(p: Project, root: string, inputs: string[], outputs: string[]) {
  return new CircuitRunner(p, root).truthTable(inputs, outputs);
}

function problems(p: Project, root: string) {
  return new CircuitRunner(p, root).design.diagnostics.filter((d) => d.severity !== 'info');
}

describe('create component from selection', () => {
  it('turns selected gates into a component whose ports are named after the nets', () => {
    const p = halfAdderProject();
    const reference = table(p, 'ha', ['A', 'B'], ['S', 'C']);
    const r = extractComponent(p, 'ha', new Set(['c3', 'c4']), new Set(), 'Adder core');
    expect(r.ports.map((x) => `${x.dir}:${x.label}`).sort()).toEqual(['in:A', 'in:B', 'out:C', 'out:S']);
    expect(table(r.project, 'ha', ['A', 'B'], ['S', 'C'])).toEqual(reference);
    expect(problems(r.project, 'ha')).toEqual([]);
    expect(problems(r.project, r.circuitId)).toEqual([]);

    const parent = findCircuit(r.project, 'ha')!;
    expect(parent.components.filter((c) => c.type === 'xor' || c.type === 'and')).toEqual([]);
    expect(parent.components.find((c) => c.id === r.instanceId)).toMatchObject({ type: 'subcircuit', props: { circuit: r.circuitId } });
    const inner = findCircuit(r.project, r.circuitId)!;
    expect(inner.name).toBe('Adder core');
    expect(inner.components.filter((c) => c.type === 'xor' || c.type === 'and').map((c) => c.id).sort()).toEqual(['c3', 'c4']);
    // The new component works on its own too.
    expect(table(r.project, r.circuitId, ['A', 'B'], ['S', 'C'])).toEqual(reference);
    // And survives a save/load cycle.
    const loaded = parseProject(serializeProject(r.project)).project;
    expect(table(loaded, 'ha', ['A', 'B'], ['S', 'C'])).toEqual(reference);
  });

  it('keeps selected Input and Output pins as the ports and puts them back outside', () => {
    const p = halfAdderProject();
    const all = findCircuit(p, 'ha')!;
    const reference = table(p, 'ha', ['A', 'B'], ['S', 'C']);
    const r = extractComponent(p, 'ha', new Set(all.components.map((c) => c.id)), new Set(all.wires.map((w) => w.id)), 'Half adder');
    expect(r.tunnels).toBe(0);
    expect(r.ports.map((x) => x.label).sort()).toEqual(['A', 'B', 'C', 'S']);
    const parent = findCircuit(r.project, 'ha')!;
    expect(parent.components.map((c) => c.type).sort()).toEqual(['input', 'input', 'output', 'output', 'subcircuit']);
    expect(parent.wires).toEqual([]);
    // Same component ids for the pins outside, so watches and inputs keep working.
    expect(parent.components.filter((c) => c.type !== 'subcircuit').map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c5', 'c6']);
    expect(table(r.project, 'ha', ['A', 'B'], ['S', 'C'])).toEqual(reference);
    expect(problems(r.project, 'ha')).toEqual([]);
  });

  it('preserves feedback through the boundary (SR latch)', () => {
    const p = srLatchProject();
    const latch = findCircuit(p, 'sr-latch')!;
    const gates = latch.components.filter((c) => c.type === 'nor').map((c) => c.id);
    const r = extractComponent(p, 'sr-latch', new Set(gates), new Set(), 'Core');
    expect(problems(r.project, 'sr-latch')).toEqual([]);
    const run = new CircuitRunner(r.project, 'sr-latch');
    run.set('S', 1);
    run.set('S', 0);
    expect([run.bits('Q'), run.bits('Q̅')]).toEqual(['1', '0']);
    run.set('R', 1);
    run.set('R', 0);
    expect([run.bits('Q'), run.bits('Q̅')]).toEqual(['0', '1']);
  });

  it('nests: extracting subcircuit instances creates a deeper hierarchy', () => {
    const p = rippleAdderProject();
    const adder = findCircuit(p, 'adder4')!;
    const fas = adder.components.filter((c) => c.type === 'subcircuit').map((c) => c.id);
    const r = extractComponent(p, 'adder4', new Set(fas.slice(0, 2)), new Set(), 'Two bits');
    const sums = (q: Project) => {
      const run = new CircuitRunner(q, 'adder4');
      const out: (number | null)[] = [];
      for (const [a, b, c] of [
        [3, 5, 0],
        [15, 1, 1],
        [9, 6, 1],
        [7, 7, 0],
      ]) {
        run.setMany({ A: a, B: b, Cin: c });
        out.push(run.num('S'), run.num('Cout'));
      }
      return out;
    };
    expect(sums(r.project)).toEqual(sums(p));
    expect(problems(r.project, 'adder4')).toEqual([]);
    const design = new CircuitRunner(r.project, 'adder4').design;
    // adder4 → Two bits → full adder → half adder
    expect(design.root!.children.get(r.instanceId)!.children.size).toBe(2);
    expect(design.instanceCount).toBe(1 + 1 + 4 + 8);
  });

  it('refuses an empty selection', () => {
    expect(() => extractComponent(halfAdderProject(), 'ha', new Set(), new Set(['w1']), 'X')).toThrow(ExtractError);
  });

  it('places the instance so that its pins do not touch the remaining wiring', () => {
    const p = halfAdderProject();
    const r = extractComponent(p, 'ha', new Set(['c3', 'c4']), new Set(), 'Core');
    const ctx = projectContext(r.project);
    const parent = findCircuit(r.project, 'ha')!;
    const inst = parent.components.find((c) => c.id === r.instanceId)!;
    expect(ctx.getInterface(r.circuitId)!.inputs.map((x) => x.label)).toEqual(['A', 'B']);
    expect(inst.rotation).toBe(0);
  });
});

describe('naming ports when creating a component', () => {
  it('uses the names given for new and existing ports, and rejects duplicates', () => {
    const p = halfAdderProject();
    const r = extractComponent(p, 'ha', new Set(['c3', 'c4']), new Set(), 'Core', { portLabels: { A: 'X', S: 'SUM', C: '  ' } });
    expect(r.ports.map((x) => x.label).sort()).toEqual(['B', 'C', 'SUM', 'X']);
    expect(table(r.project, 'ha', ['A', 'B'], ['S', 'C'])).toEqual(table(p, 'ha', ['A', 'B'], ['S', 'C']));
    // The top-level pins keep their names; only the component's ports are renamed.
    expect(findCircuit(r.project, 'ha')!.components.filter((c) => c.type === 'input').map((c) => c.props.label)).toEqual(['A', 'B']);

    const all = findCircuit(p, 'ha')!;
    const whole = extractComponent(p, 'ha', new Set(all.components.map((c) => c.id)), new Set(all.wires.map((w) => w.id)), 'HA', { portLabels: { A: 'IN_A' } });
    expect(whole.ports.map((x) => x.label).sort()).toEqual(['B', 'C', 'IN_A', 'S']);
    expect(table(whole.project, 'ha', ['A', 'B'], ['S', 'C'])).toEqual(table(p, 'ha', ['A', 'B'], ['S', 'C']));

    expect(() => extractComponent(p, 'ha', new Set(['c3', 'c4']), new Set(), 'Core', { portLabels: { A: 'B' } })).toThrow(/both be called "B"/);
  });
});
