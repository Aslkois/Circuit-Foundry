import { strOf } from './catalog/index.ts';
import { uniqueCircuitName } from './edit.ts';
import { transitiveDependencies } from './hierarchy.ts';
import { idGenerator } from './ids.ts';
import type { Circuit, Project } from './types.ts';

/*
 * Reusing components across projects: copy circuits (and every circuit they
 * contain) from one project into another. Ids and names that already exist
 * in the target are replaced by fresh ones; a circuit identical to one the
 * target already has (for example from an earlier import) is reused rather
 * than duplicated.
 */

export interface ImportResult {
  readonly project: Project;
  /** Circuits added to the target, in dependency order. */
  readonly added: readonly Circuit[];
  /** Source circuit id → id in the target (added or reused). */
  readonly idMap: ReadonlyMap<string, string>;
}

/** Source circuit ids needed to import `ids`, children before parents. */
export function importOrder(source: Project, ids: readonly string[]): string[] {
  const byId = new Map(source.circuits.map((c) => [c.id, c]));
  const needed = new Set<string>();
  for (const id of ids) {
    if (!byId.has(id)) continue;
    needed.add(id);
    for (const d of transitiveDependencies(source, id)) if (byId.has(d)) needed.add(d);
  }
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string) => {
    if (state.get(id) === 'done' || state.get(id) === 'visiting') return;
    state.set(id, 'visiting');
    for (const k of byId.get(id)!.components) {
      if (k.type !== 'subcircuit') continue;
      const child = strOf(k.props, 'circuit');
      if (needed.has(child)) visit(child);
    }
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of source.circuits.map((c) => c.id)) if (needed.has(id)) visit(id);
  return order;
}

function content(c: Circuit): string {
  const { id: _id, ...rest } = c;
  return JSON.stringify(rest);
}

export function importCircuits(target: Project, source: Project, ids: readonly string[]): ImportResult {
  const byId = new Map(source.circuits.map((c) => [c.id, c]));
  const idMap = new Map<string, string>();
  const added: Circuit[] = [];
  let project = target;
  const newId = idGenerator('circuit', [...target.circuits.map((c) => c.id), ...source.circuits.map((c) => c.id)]);
  for (const id of importOrder(source, ids)) {
    const original = byId.get(id)!;
    const components = original.components.map((k) => {
      if (k.type !== 'subcircuit') return k;
      const mapped = idMap.get(strOf(k.props, 'circuit'));
      return mapped ? { ...k, props: { ...k.props, circuit: mapped } } : k;
    });
    const remapped: Circuit = { ...original, components };
    const same = project.circuits.find((c) => c.name === remapped.name && content(c) === content(remapped));
    if (same) {
      idMap.set(id, same.id);
      continue;
    }
    const taken = project.circuits.some((c) => c.id === id);
    const circuit: Circuit = { ...remapped, id: taken ? newId() : id, name: uniqueCircuitName(project, remapped.name) };
    idMap.set(id, circuit.id);
    added.push(circuit);
    project = { ...project, circuits: [...project.circuits, circuit] };
  }
  return { project, added, idMap };
}
