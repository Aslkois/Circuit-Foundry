import { evalExpr, ExprError } from './expr.ts';
import type { Circuit, ComponentInstance, Props, PropValue } from './types.ts';

/*
 * Parametric circuits.
 *
 * A circuit declares integer parameters; any component property can be bound
 * to an expression over them (`bind: { width: "N" }`). Each subcircuit
 * instance supplies values with "@name" props (missing ones take the
 * default). Specializing a circuit for a set of values evaluates every
 * binding, giving an ordinary circuit that the rest of the model handles
 * unchanged. Specializations are cached, so a definition used a hundred times
 * with the same parameters is specialized and analyzed once.
 */

export type ParamValues = Readonly<Record<string, number>>;

export const PARAM_PREFIX = '@';

export function paramDefaults(circuit: Circuit): ParamValues {
  const out: Record<string, number> = {};
  for (const p of circuit.params ?? []) out[p.name] = p.default;
  return out;
}

export interface ParamProblem {
  readonly message: string;
}

/** Parameter values for an instance of `target` from its "@name" props, clamped to each parameter's range. */
export function instanceParamValues(target: Circuit, props: Props): { values: ParamValues; problems: string[] } {
  const values: Record<string, number> = {};
  const problems: string[] = [];
  for (const p of target.params ?? []) {
    const raw = props[PARAM_PREFIX + p.name];
    if (raw === undefined) {
      values[p.name] = p.default;
    } else if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      problems.push(`parameter ${p.name} must be a whole number; using ${p.default}`);
      values[p.name] = p.default;
    } else if (raw < p.min || raw > p.max) {
      const v = Math.min(p.max, Math.max(p.min, raw));
      problems.push(`parameter ${p.name} = ${raw} is outside ${p.min}..${p.max}; using ${v}`);
      values[p.name] = v;
    } else {
      values[p.name] = raw;
    }
  }
  return { values, problems };
}

export function paramSignature(values: ParamValues): string {
  return Object.keys(values)
    .sort()
    .map((k) => `${k}=${values[k]}`)
    .join(',');
}

export interface BindingProblem {
  readonly componentId: string;
  readonly prop: string;
  readonly expr: string;
  readonly message: string;
}

interface Specialization {
  circuit: Circuit;
  problems: BindingProblem[];
}

const cache = new WeakMap<Circuit, Map<string, Specialization>>();

function compute(circuit: Circuit, values: ParamValues): Specialization {
  const problems: BindingProblem[] = [];
  let changed = false;
  const components = circuit.components.map((c): ComponentInstance => {
    if (!c.bind) return c;
    let props: Record<string, PropValue> | null = null;
    for (const [prop, expr] of Object.entries(c.bind)) {
      try {
        const v = evalExpr(expr, values);
        if (c.props[prop] !== v) {
          props ??= { ...c.props };
          props[prop] = v;
        }
      } catch (e) {
        problems.push({ componentId: c.id, prop, expr, message: e instanceof ExprError ? e.message : String(e) });
      }
    }
    if (!props) return c;
    changed = true;
    return { ...c, props };
  });
  return { circuit: changed ? { ...circuit, components } : circuit, problems };
}

function lookup(circuit: Circuit, values: ParamValues): Specialization {
  let perCircuit = cache.get(circuit);
  if (!perCircuit) cache.set(circuit, (perCircuit = new Map()));
  const sig = paramSignature(values);
  let s = perCircuit.get(sig);
  if (!s) {
    s = compute(circuit, values);
    if (perCircuit.size > 256) perCircuit.clear();
    perCircuit.set(sig, s);
  }
  return s;
}

/**
 * The circuit with every property binding evaluated for `values`. Returns
 * the circuit itself when nothing changes, so caches keyed on it still hit.
 */
export function specialize(circuit: Circuit, values: ParamValues = paramDefaults(circuit)): Circuit {
  if (!circuit.components.some((c) => c.bind)) return circuit;
  return lookup(circuit, values).circuit;
}

/** Bindings that failed to evaluate for `values` (the stored prop value is used instead). */
export function bindingProblems(circuit: Circuit, values: ParamValues = paramDefaults(circuit)): readonly BindingProblem[] {
  if (!circuit.components.some((c) => c.bind)) return [];
  return lookup(circuit, values).problems;
}
