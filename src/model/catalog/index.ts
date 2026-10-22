import type { PropValue, Props } from '../types.ts';
import { GATE_DEFS } from './gates.ts';
import { IO_DEFS } from './io.ts';
import { MEMORY_DEFS } from './memory.ts';
import { SUBCIRCUIT_DEF } from './subcircuit.ts';
import type { ComponentTypeDef, PropDef } from './types.ts';
import { WIRING_DEFS } from './wiring.ts';

export * from './types.ts';
export { gateHalfHeight, gateInputOffsets } from './gates.ts';
export { bitBoxSize, constantBoxWidth, LED_COLORS } from './io.ts';
export { describeBits, splitterArmBits, splitterMapping, defaultSplitterMapping, parseSplitterMapping, textScale, tunnelLength } from './wiring.ts';
export { subcircuitLayout, symbolSize, DEFAULT_SYMBOL_WIDTH } from './subcircuit.ts';

const ALL_DEFS: ComponentTypeDef[] = [...GATE_DEFS, ...IO_DEFS, ...WIRING_DEFS, ...MEMORY_DEFS, SUBCIRCUIT_DEF];

export const CATALOG: ReadonlyMap<string, ComponentTypeDef> = new Map(ALL_DEFS.map((d) => [d.type, d]));

export function getDef(type: string): ComponentTypeDef | undefined {
  return CATALOG.get(type);
}

export function defaultProps(def: ComponentTypeDef): Props {
  const out: Record<string, PropValue> = {};
  for (const p of def.props) out[p.name] = p.default;
  return out;
}

export interface PropError {
  readonly name: string;
  readonly message: string;
}

export interface NormalizedProps {
  /** Every declared prop, with invalid or missing values replaced by defaults. */
  readonly props: Props;
  readonly errors: readonly PropError[];
}

function checkBasic(def: PropDef, v: PropValue): string | null {
  switch (def.kind) {
    case 'int':
    case 'uint':
      if (typeof v !== 'number' || !Number.isInteger(v)) return 'must be a whole number';
      if (def.min !== undefined && v < def.min) return `must be at least ${def.min}`;
      if (def.max !== undefined && v > def.max) return `must be at most ${def.max}`;
      return null;
    case 'enum':
      return typeof v === 'string' && def.options?.some((o) => o.value === v) ? null : 'is not a valid choice';
    case 'string':
      return typeof v === 'string' ? null : 'must be text';
    case 'bool':
      return typeof v === 'boolean' ? null : 'must be true or false';
  }
}

const normalizeCache = new WeakMap<Props, Map<ComponentTypeDef, NormalizedProps>>();

/** Fill defaults and replace invalid values. Results are cached per props object. */
export function normalizeProps(def: ComponentTypeDef, raw: Props): NormalizedProps {
  let perDef = normalizeCache.get(raw);
  const cached = perDef?.get(def);
  if (cached) return cached;

  const out: Record<string, PropValue> = {};
  const errors: PropError[] = [];
  for (const p of def.props) {
    const v = raw[p.name];
    if (v === undefined) {
      out[p.name] = p.default;
      continue;
    }
    const err = checkBasic(p, v);
    if (err) {
      errors.push({ name: p.name, message: `${p.label} ${err}` });
      out[p.name] = p.default;
    } else {
      out[p.name] = v;
    }
  }
  // Cross-field checks run in declaration order against the props fixed so far.
  for (const p of def.props) {
    if (!p.check) continue;
    const err = p.check(out[p.name], out);
    if (err) {
      if (raw[p.name] !== undefined) errors.push({ name: p.name, message: `${p.label} ${err}` });
      out[p.name] = p.default;
      const again = p.check(out[p.name], out);
      if (again) errors.push({ name: p.name, message: `${p.label} default ${again}` });
    }
  }
  const result: NormalizedProps = { props: out, errors };
  if (!perDef) {
    perDef = new Map();
    normalizeCache.set(raw, perDef);
  }
  perDef.set(def, result);
  return result;
}

/** Validate a single prop edit against the other current props. */
export function validatePropEdit(def: ComponentTypeDef, current: Props, name: string, value: PropValue): string | null {
  const p = def.props.find((x) => x.name === name);
  if (!p) return 'unknown property';
  const err = checkBasic(p, value);
  if (err) return `${p.label} ${err}`;
  const next = { ...normalizeProps(def, current).props, [name]: value };
  for (const q of def.props) {
    if (!q.check) continue;
    const e = q.check(next[q.name], next);
    if (e) return `${q.label} ${e}`;
  }
  return null;
}
