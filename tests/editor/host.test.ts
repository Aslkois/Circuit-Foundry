import { describe, expect, it } from 'vitest';
import { addComponents, createComponent, replaceCircuit, type Project } from '../../src/model/index.ts';
import { addersProject, srLatchProject } from '../../src/samples/index.ts';
import { SimulationHost } from '../../src/editor/sim/SimulationHost.ts';
import { formatBinary } from '../../src/engine/index.ts';

const bits = (host: SimulationHost, componentId: string, pin: string, path: string[] = []) => {
  const v = host.valueAt(path, componentId, pin);
  return v ? formatBinary(v) : 'none';
};

function edit(project: Project, circuitId: string, type: string, x: number, y: number): Project {
  const c = project.circuits.find((k) => k.id === circuitId)!;
  const ctx = { getInterface: () => undefined };
  return replaceCircuit(project, addComponents(c, [createComponent(c, type, x, y)], ctx));
}

describe('SimulationHost', () => {
  it('keeps switch positions and latch contents across edits', () => {
    let project = srLatchProject();
    const host = new SimulationHost(project, 'sr-latch');
    // c1 = R, c2 = S, c5 = Q output.
    host.toggleBit([], 'c2', 0); // S = 1
    host.toggleBit([], 'c2', 0); // S = 0: latch holds 1
    expect(bits(host, 'c5', 'in')).toBe('1');
    project = edit(project, 'sr-latch', 'led', 40, 40);
    host.sync(project, 'sr-latch');
    expect(bits(host, 'c5', 'in')).toBe('1');
    expect(host.getSource([], 'c2')?.a).toBe(0);
  });

  it('remembers the state of each simulated circuit when switching between them', () => {
    const project = addersProject();
    const host = new SimulationHost(project, 'full-adder');
    host.toggleBit([], 'c1', 0); // A = 1
    expect(bits(host, 'c7', 'in')).toBe('1'); // Sum
    host.sync(project, 'half-adder');
    expect(bits(host, 'c1', 'out')).toBe('0'); // the half adder starts fresh
    host.toggleBit([], 'c2', 0);
    host.sync(project, 'full-adder');
    expect(bits(host, 'c1', 'out')).toBe('1');
    expect(bits(host, 'c7', 'in')).toBe('1');
    host.sync(project, 'half-adder');
    expect(bits(host, 'c2', 'out')).toBe('1');
  });

  it('only lets top-level inputs and buttons be driven by the user', () => {
    const project = addersProject();
    const host = new SimulationHost(project, 'full-adder');
    expect(host.sourceKey([], 'c1')).toBe('c1');
    const ha = project.circuits.find((c) => c.id === 'full-adder')!.components.find((c) => c.type === 'subcircuit')!;
    // Inside an instance, Input pins are ports driven by the parent.
    expect(host.sourceKey([ha.id], 'c1')).toBeNull();
    expect(host.toggleBit([ha.id], 'c1', 0)).toBe(false);
    // But values inside the instance are visible.
    host.toggleBit([], 'c1', 0);
    expect(bits(host, 'c1', 'out', [ha.id])).toBe('1');
  });

  it('reports oscillation as a diagnostic and recovers after reset', () => {
    const project = srLatchProject();
    const host = new SimulationHost(project, 'sr-latch');
    host.toggleBit([], 'c1', 0); // R = 1
    host.toggleBit([], 'c2', 0); // S = 1 (both outputs 0)
    // Releasing both at once is impossible from the UI one click at a time; use the engine directly.
    host.sim.setInput('c1', 0);
    host.sim.setInput('c2', 0);
    host.settle();
    expect(host.getStatus().state).toBe('oscillating');
    expect(host.diagnostics.some((d) => d.code === 'oscillation' && d.componentIds?.length === 2)).toBe(true);
    host.reset();
    expect(host.getStatus().state).toBe('stable');
    expect(host.diagnostics.some((d) => d.code === 'oscillation')).toBe(false);
  });

  it('notes feedback loops once per circuit definition', () => {
    const host = new SimulationHost(srLatchProject(), 'sr-latch');
    const loops = host.diagnostics.filter((d) => d.code === 'feedback-loop');
    expect(loops).toHaveLength(1);
    expect(loops[0].severity).toBe('info');
  });

  it('steps one gate delay at a time when auto-propagate is off', () => {
    const host = new SimulationHost(addersProject(), 'half-adder');
    host.setAutoPropagate(false);
    host.toggleBit([], 'c1', 0);
    expect(host.getStatus().state).toBe('pending');
    let steps = 0;
    while (host.getStatus().state === 'pending' && steps < 50) {
      host.step();
      steps++;
    }
    expect(host.getStatus().state).toBe('stable');
    expect(steps).toBe(2); // input source, then the XOR gate
    expect(bits(host, 'c5', 'in')).toBe('1');
  });
});
