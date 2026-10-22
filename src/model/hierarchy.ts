import { strOf } from './catalog/index.ts';
import type { Circuit, Project } from './types.ts';

/** Circuit ids directly instantiated by `circuit`. */
export function directDependencies(circuit: Circuit): Set<string> {
  const out = new Set<string>();
  for (const c of circuit.components) {
    if (c.type === 'subcircuit') out.add(strOf(c.props, 'circuit'));
  }
  return out;
}

/** Every circuit id reachable from `circuitId` through subcircuit instances (excluding itself unless cyclic). */
export function transitiveDependencies(project: Project, circuitId: string): Set<string> {
  const byId = new Map(project.circuits.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const stack = [circuitId];
  while (stack.length > 0) {
    const c = byId.get(stack.pop()!);
    if (!c) continue;
    for (const d of directDependencies(c)) {
      if (!seen.has(d)) {
        seen.add(d);
        stack.push(d);
      }
    }
  }
  return seen;
}

/** Placing an instance of `childId` inside `parentId` would make a circuit contain itself. */
export function wouldCreateCycle(project: Project, parentId: string, childId: string): boolean {
  return parentId === childId || transitiveDependencies(project, childId).has(parentId);
}

/** Circuits that (transitively) contain an instance of themselves. */
export function cyclicCircuits(project: Project): string[] {
  return project.circuits.filter((c) => transitiveDependencies(project, c.id).has(c.id)).map((c) => c.id);
}

/** Circuits that instantiate `circuitId` directly. */
export function usersOf(project: Project, circuitId: string): Circuit[] {
  return project.circuits.filter((c) => directDependencies(c).has(circuitId));
}
