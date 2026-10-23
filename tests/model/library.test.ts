import { describe, expect, it } from 'vitest';
import { CircuitRunner, compileProject, importCircuits, importOrder, type Project } from '../../src/model/index.ts';
import { computerProject } from '../../src/samples/computer.ts';
import { halfAdderProject } from './helpers.ts';

function blank(): Project {
  return { id: 'p', name: 'P', mainCircuitId: 'main', circuits: [{ id: 'main', name: 'Main', components: [], wires: [] }], createdAt: '', modifiedAt: '' };
}

describe('importing components from another project', () => {
  it('brings a component with everything it contains, children first', () => {
    const source = computerProject();
    expect(importOrder(source, ['alu8'])).toEqual(['half-adder', 'full-adder', 'mux2', 'adder8', 'dec3', 'alu8']);
    const r = importCircuits(blank(), source, ['mycpu']);
    expect(r.added.map((c) => c.name)).toEqual(['Half adder', 'Full adder', 'Mux 2:1', 'Adder (8-bit)', 'Decoder 3→8', 'ALU (8-bit)', 'Control unit', 'MyCPU']);
    const d = compileProject(r.project, r.idMap.get('mycpu')!);
    expect(d.diagnostics).toEqual([]);
    expect(d.instanceCount).toBe(57);
  });

  it('reuses identical circuits and renames on conflicts', () => {
    const source = computerProject();
    const once = importCircuits(blank(), source, ['adder8']);
    const twice = importCircuits(once.project, source, ['alu8']);
    // half adder, full adder and adder8 are already there and identical.
    expect(twice.added.map((c) => c.name)).toEqual(['Mux 2:1', 'Decoder 3→8', 'ALU (8-bit)']);
    expect(twice.idMap.get('adder8')).toBe(once.idMap.get('adder8'));

    // A different circuit that happens to use the same id and name gets a fresh id and name.
    const target = halfAdderProject(); // its circuit "ha" is called "Half adder" too
    const clash: Project = { ...target, circuits: [{ ...target.circuits[0], id: 'half-adder' }], mainCircuitId: 'half-adder' };
    const r = importCircuits(clash, source, ['full-adder']);
    const imported = r.project.circuits.find((c) => c.id === r.idMap.get('half-adder'))!;
    expect(imported.id).not.toBe('half-adder');
    expect(imported.name).toBe('Half adder 2');
    const run = new CircuitRunner(r.project, r.idMap.get('full-adder')!);
    expect(run.truthTable(['A', 'B', 'Cin'], ['Sum', 'Cout']).map((row) => row.out)).toEqual([
      [0, 0],
      [1, 0],
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
      [0, 1],
      [1, 1],
    ]);
  });
});
