import { AND, BUFFER, NAND, NOR, NOT, OR, TRISTATE, XNOR, XOR } from './gates.ts';
import { DFF, REGISTER } from './sequential.ts';
import { CLOCK, CONSTANT, INPUT } from './sources.ts';
import type { PrimitiveLibrary, PrimitiveSpec } from './types.ts';

export * from './types.ts';
export { MAX_GATE_INPUTS } from './gates.ts';
export { clockLevel } from './sources.ts';
export { TRIGGERS } from './sequential.ts';

const ALL: PrimitiveSpec[] = [AND, OR, NAND, NOR, XOR, XNOR, NOT, BUFFER, TRISTATE, INPUT, CONSTANT, CLOCK, DFF, REGISTER];

export function createLibrary(specs: readonly PrimitiveSpec[]): PrimitiveLibrary {
  const lib = new Map<string, PrimitiveSpec>();
  for (const s of specs) {
    if (lib.has(s.type)) throw new Error(`Duplicate primitive type "${s.type}"`);
    lib.set(s.type, s);
  }
  return lib;
}

/** The built-in primitive library. */
export const defaultLibrary: PrimitiveLibrary = createLibrary(ALL);
