import type { PrimitiveProps } from '../netlist.ts';

export type PinDirection = 'in' | 'out' | 'inout';

export interface PinSpec {
  readonly name: string;
  readonly dir: PinDirection;
  readonly width: number;
}

/**
 * What a behaviour sees while it is evaluated. Reads return the resolved net
 * value at the current simulation time; writes are scheduled `delay` time
 * units in the future, so evaluation order within a time step never matters.
 */
export interface EvalContext {
  /** Simulation time (in gate-delay units) of the current evaluation. */
  readonly time: number;
  /** Number of clock ticks since reset. */
  readonly tick: number;
  /** `a` word (value bits) of the net on `pin`. */
  a(pin: number): number;
  /** `b` word (unknown/floating bits) of the net on `pin`. */
  b(pin: number): number;
  /** Drive `pin`. Values are masked to the pin width. */
  out(pin: number, a: number, b: number): void;
}

export interface Behavior {
  /** Called at reset, whenever an input/inout net changes, and for external stimulus. */
  evaluate(ctx: EvalContext): void;
  /** JSON-serializable internal state, for snapshots. Stateless primitives omit it. */
  getState?(): unknown;
  /** Restore state produced by getState. Must ignore malformed input. */
  setState?(state: unknown): void;
}

export type PrimitiveKind =
  /** Ordinary component evaluated when its inputs change. */
  | 'logic'
  /** Externally controlled source (switch, button); see Simulator.setInput. */
  | 'input'
  /** Clock source advanced by Simulator.tick. */
  | 'clock';

/**
 * Optional declarative description of a stateless gate. When present the
 * simulator evaluates the component inline from flat arrays instead of
 * calling its Behavior (same results; much better memory locality for large
 * designs). The Behavior must implement exactly the same function.
 */
export interface GateKernel {
  readonly op: 'and' | 'or' | 'xor' | 'buffer';
  readonly negate: boolean;
}

export interface PrimitiveSpec {
  readonly type: string;
  readonly kind: PrimitiveKind;
  readonly kernel?: GateKernel;
  /**
   * True when outputs depend only on stored state, i.e. there is no
   * combinational path from inputs to outputs. Used by feedback analysis.
   */
  readonly sequential: boolean;
  /** Default propagation delay (>= 1). A numeric `delay` prop overrides it. */
  readonly delay: number;
  /** Returns an error message for invalid props, or null. */
  validate(props: PrimitiveProps): string | null;
  /** Pin list for the given props; the order defines netlist pin indexes. */
  pins(props: PrimitiveProps): PinSpec[];
  create(props: PrimitiveProps): Behavior;
}

export type PrimitiveLibrary = ReadonlyMap<string, PrimitiveSpec>;

/* Prop helpers shared by primitive implementations. */

export function intProp(props: PrimitiveProps, name: string, fallback: number): number {
  const v = props[name];
  return typeof v === 'number' && Number.isInteger(v) ? v : fallback;
}

export function strProp(props: PrimitiveProps, name: string, fallback: string): string {
  const v = props[name];
  return typeof v === 'string' ? v : fallback;
}

export function checkInt(props: PrimitiveProps, name: string, min: number, max: number, required = true): string | null {
  const v = props[name];
  if (v === undefined && !required) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return `property "${name}" must be an integer in ${min}..${max}`;
  }
  return null;
}

export function checkEnum(props: PrimitiveProps, name: string, options: readonly string[], required = true): string | null {
  const v = props[name];
  if (v === undefined && !required) return null;
  if (typeof v !== 'string' || !options.includes(v)) {
    return `property "${name}" must be one of ${options.join(', ')}`;
  }
  return null;
}

export function firstError(...errors: (string | null)[]): string | null {
  for (const e of errors) if (e) return e;
  return null;
}
