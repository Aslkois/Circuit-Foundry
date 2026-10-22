import { describe, expect, it } from 'vitest';
import { CircuitRunner, addComponents, createComponent, deleteItems, type Project } from '../../src/model/index.ts';
import { addersProject, rippleAdderProject } from '../../src/samples/index.ts';
import { EditorStore, resolvePath } from '../../src/editor/state/store.ts';

function blank(): Project {
  return { id: 'p', name: 'P', mainCircuitId: 'm', circuits: [{ id: 'm', name: 'M', components: [], wires: [] }], createdAt: '', modifiedAt: '' };
}

describe('EditorStore', () => {
  it('records edits for undo and redo, and clears redo on a new edit', () => {
    const store = new EditorStore(blank());
    const add = (type: string, x: number) => store.editViewed((c, ctx) => addComponents(c, [createComponent(c, type, x, 0)], ctx));
    add('and', 0);
    add('or', 10);
    expect(store.viewedCircuit.components.map((c) => c.type)).toEqual(['and', 'or']);
    expect(store.getState().canUndo).toBe(true);
    store.undo();
    expect(store.viewedCircuit.components.map((c) => c.type)).toEqual(['and']);
    expect(store.getState().canRedo).toBe(true);
    store.redo();
    expect(store.viewedCircuit.components.map((c) => c.type)).toEqual(['and', 'or']);
    store.undo();
    add('xor', 20);
    expect(store.getState().canRedo).toBe(false);
    expect(store.viewedCircuit.components.map((c) => c.type)).toEqual(['and', 'xor']);
  });

  it('keeps instances wired when a definition gains a port, in one undo step', () => {
    const project = rippleAdderProject();
    const store = new EditorStore(project);
    const sums = (p: Project) => {
      const r = new CircuitRunner(p, 'adder4');
      return [
        [3, 5, 0],
        [15, 1, 1],
        [9, 9, 0],
      ].map(([a, b, c]) => {
        r.setMany({ A: a, B: b, Cin: c });
        return [r.num('S'), r.num('Cout')];
      });
    };
    const reference = sums(project);
    store.openCircuit('half-adder');
    // A new input above the others shifts both existing ports of every half-adder symbol.
    store.editViewed((c, ctx) => addComponents(c, [createComponent(c, 'input', -6, -10, 0, { label: 'EXTRA' })], ctx));
    const edited = store.getState().project;
    expect(store.getState().notice).toBeNull();
    expect(sums(edited)).toEqual(reference);
    expect(new CircuitRunner(edited, 'full-adder').design.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    store.undo();
    expect(store.getState().project).toBe(project);
  });

  it('ignores edits that change nothing', () => {
    const store = new EditorStore(blank());
    const rev = store.getState().revision;
    store.editViewed((c) => c);
    expect(store.getState().revision).toBe(rev);
    expect(store.getState().canUndo).toBe(false);
  });

  it('prunes the selection when selected items disappear', () => {
    const store = new EditorStore(blank());
    store.editViewed((c, ctx) => addComponents(c, [createComponent(c, 'and', 0, 0)], ctx));
    const id = store.viewedCircuit.components[0].id;
    store.setSelection({ components: new Set([id]), wires: new Set() });
    store.editViewed((c, ctx) => deleteItems(c, new Set([id]), new Set(), ctx));
    expect(store.getState().selection.components.size).toBe(0);
    store.undo();
    expect(store.getState().selection.components.has(id)).toBe(true);
  });

  it('marks the project as needing a save after edits but not after navigation', () => {
    const store = new EditorStore(addersProject());
    expect(store.getState().saveStatus).toBe('saved');
    store.openCircuit('half-adder');
    expect(store.getState().saveStatus).toBe('saved');
    store.editViewed((c, ctx) => addComponents(c, [createComponent(c, 'led', 30, 30)], ctx));
    expect(store.getState().saveStatus).toBe('pending');
  });

  it('navigates into subcircuit instances and back out', () => {
    const store = new EditorStore(addersProject());
    const ha = store.viewedCircuit.components.find((c) => c.type === 'subcircuit')!;
    store.enterInstance(ha.id);
    expect(store.getState().path).toEqual([ha.id]);
    expect(store.viewedCircuit.id).toBe('half-adder');
    // Edits apply to the definition being viewed.
    store.editViewed((c, ctx) => addComponents(c, [createComponent(c, 'led', 40, 40)], ctx));
    expect(store.getState().project.circuits.find((c) => c.id === 'half-adder')!.components.some((c) => c.type === 'led')).toBe(true);
    store.exitTo(0);
    expect(store.getState().path).toEqual([]);
    expect(store.getState().selection.components.has(ha.id)).toBe(true);
    // Entering something that is not a subcircuit is refused.
    store.enterInstance(store.viewedCircuit.components.find((c) => c.type === 'or')!.id);
    expect(store.getState().path).toEqual([]);
  });

  it('keeps a valid view when undo removes the circuit being viewed', () => {
    const store = new EditorStore(blank());
    const project = store.getState().project;
    store.commit({ ...project, circuits: [...project.circuits, { id: 'x', name: 'X', components: [], wires: [] }] });
    store.openCircuit('x');
    store.undo();
    expect(store.getState().rootCircuitId).toBe('m');
    expect(store.viewedCircuit.id).toBe('m');
  });

  it('resolvePath stops at the first invalid step', () => {
    const project = addersProject();
    const ha = project.circuits.find((c) => c.id === 'full-adder')!.components.find((c) => c.type === 'subcircuit')!;
    expect(resolvePath(project, 'full-adder', [ha.id]).circuit.id).toBe('half-adder');
    const bad = resolvePath(project, 'full-adder', [ha.id, 'nope']);
    expect(bad.path).toEqual([ha.id]);
    expect(bad.circuit.id).toBe('half-adder');
  });

  it('notifies subscribers and supports unsubscribing', () => {
    const store = new EditorStore(blank());
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.setTool({ kind: 'wire' });
    off();
    store.setTool({ kind: 'select' });
    expect(calls).toBe(1);
  });
});
