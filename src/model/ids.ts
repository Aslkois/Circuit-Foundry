import type { Circuit, Project } from './types.ts';

/**
 * Returns a generator of ids `${prefix}${n}` that do not collide with any id
 * in `existing`. Ids are short, readable and deterministic, which keeps
 * project files stable and diffable.
 */
export function idGenerator(prefix: string, existing: Iterable<string>): () => string {
  const taken = new Set(existing);
  let n = 1;
  for (const id of taken) {
    if (id.startsWith(prefix)) {
      const rest = id.slice(prefix.length);
      if (/^\d+$/.test(rest)) n = Math.max(n, Number(rest) + 1);
    }
  }
  return () => {
    let id = `${prefix}${n++}`;
    while (taken.has(id)) id = `${prefix}${n++}`;
    taken.add(id);
    return id;
  };
}

export function componentIdGenerator(circuit: Circuit): () => string {
  return idGenerator('c', circuit.components.map((c) => c.id));
}

export function wireIdGenerator(circuit: Circuit): () => string {
  return idGenerator('w', circuit.wires.map((w) => w.id));
}

export function circuitIdGenerator(project: Project): () => string {
  return idGenerator('circuit', project.circuits.map((c) => c.id));
}
