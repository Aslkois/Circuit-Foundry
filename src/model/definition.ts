import { strOf } from './catalog/index.ts';
import { evalExpr, ExprError, isReservedName, renameInExpr } from './expr.ts';
import { circuitInterface } from './layout.ts';
import { PARAM_PREFIX, paramDefaults, specialize } from './params.ts';
import { PARAM_NAME_PATTERN, PORT_SIDES, type Circuit, type ComponentInstance, type ParamDef, type PortPlacement, type PortSide, type Project, type PropValue } from './types.ts';

/*
 * Editing a circuit's definition as a component: its symbol (port sides,
 * order, clock markers, body) and its parameters and bindings. All functions
 * are pure. Callers commit through the editor store, which re-routes wiring
 * around existing instances when pins move (see sync.ts).
 */

export class DefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefinitionError';
  }
}

/* ------------------------------------------------------------------------ */
/* Symbol                                                                    */
/* ------------------------------------------------------------------------ */

/** Every port's current placement, explicit or defaulted. */
export function portPlacements(circuit: Circuit): Record<string, PortPlacement> {
  const iface = circuitInterface(circuit);
  const out: Record<string, PortPlacement> = {};
  for (const p of [...iface.inputs, ...iface.outputs]) {
    const explicit = circuit.symbol?.ports?.[p.id]?.clock;
    out[p.id] = { side: p.side, slot: p.slot, ...(explicit !== undefined ? { clock: explicit } : {}) };
  }
  return out;
}

function withPlacements(circuit: Circuit, ports: Record<string, PortPlacement>): Circuit {
  return { ...circuit, symbol: { ...circuit.symbol, ports } };
}

/** Renumber the slots on one side 0..n-1 in their current order. */
function compact(ports: Record<string, PortPlacement>, side: PortSide): void {
  const ids = Object.keys(ports)
    .filter((id) => ports[id].side === side)
    .sort((a, b) => ports[a].slot - ports[b].slot);
  ids.forEach((id, i) => (ports[id] = { ...ports[id], slot: i }));
}

/** Move a port to another side of the symbol (appended after the ports already there). */
export function setPortSide(circuit: Circuit, portId: string, side: PortSide): Circuit {
  if (!PORT_SIDES.includes(side)) throw new DefinitionError(`Unknown side "${side}".`);
  const ports = portPlacements(circuit);
  const p = ports[portId];
  if (!p || p.side === side) return circuit;
  const slot = Math.max(-1, ...Object.values(ports).filter((q) => q.side === side).map((q) => q.slot)) + 1;
  ports[portId] = { ...p, side, slot };
  compact(ports, p.side);
  return withPlacements(circuit, ports);
}

/** Swap a port with its neighbour on the same side (delta -1: towards the top or left). */
export function movePort(circuit: Circuit, portId: string, delta: -1 | 1): Circuit {
  const ports = portPlacements(circuit);
  const p = ports[portId];
  if (!p) return circuit;
  const same = Object.keys(ports)
    .filter((id) => ports[id].side === p.side)
    .sort((a, b) => ports[a].slot - ports[b].slot);
  const i = same.indexOf(portId);
  const j = i + delta;
  if (j < 0 || j >= same.length) return circuit;
  const other = same[j];
  ports[portId] = { ...p, slot: ports[other].slot };
  ports[other] = { ...ports[other], slot: p.slot };
  return withPlacements(circuit, ports);
}

/** Show or hide the clock marker of a port. */
export function setPortClock(circuit: Circuit, portId: string, clock: boolean): Circuit {
  const ports = portPlacements(circuit);
  if (!ports[portId]) return circuit;
  ports[portId] = { ...ports[portId], clock };
  return withPlacements(circuit, ports);
}

/** Body label and width (null width = automatic). */
export function setSymbolBody(circuit: Circuit, patch: { label?: string; width?: number | null }): Circuit {
  const symbol = { ...circuit.symbol };
  if (patch.label !== undefined) {
    if (patch.label === '') delete symbol.label;
    else symbol.label = patch.label;
  }
  if (patch.width !== undefined) {
    if (patch.width === null) delete symbol.width;
    else {
      if (!Number.isInteger(patch.width) || patch.width < 4 || patch.width > 40) throw new DefinitionError('Body width must be a whole number from 4 to 40.');
      symbol.width = patch.width;
    }
  }
  const { ports, ...rest } = symbol;
  if (!ports && Object.keys(rest).length === 0) {
    const { symbol: _omit, ...plain } = circuit;
    return plain;
  }
  return { ...circuit, symbol };
}

/** Back to the default symbol: inputs left, outputs right, in schematic order. */
export function resetSymbol(circuit: Circuit): Circuit {
  if (!circuit.symbol) return circuit;
  const { symbol: _omit, ...plain } = circuit;
  return plain;
}

/* ------------------------------------------------------------------------ */
/* Parameters                                                                */
/* ------------------------------------------------------------------------ */

function checkParam(p: ParamDef, others: readonly ParamDef[]): void {
  if (!PARAM_NAME_PATTERN.test(p.name)) throw new DefinitionError(`"${p.name}" is not a valid parameter name: start with a letter or _, then letters, digits or _.`);
  if (isReservedName(p.name)) throw new DefinitionError(`"${p.name}" is the name of a function; choose another name.`);
  if (others.some((q) => q.name === p.name)) throw new DefinitionError(`There is already a parameter called "${p.name}".`);
  for (const [k, v] of [
    ['Default', p.default],
    ['Minimum', p.min],
    ['Maximum', p.max],
  ] as const) {
    if (!Number.isSafeInteger(v)) throw new DefinitionError(`${k} must be a whole number.`);
  }
  if (p.min > p.max) throw new DefinitionError('The minimum must not be larger than the maximum.');
  if (p.default < p.min || p.default > p.max) throw new DefinitionError(`The default must be between ${p.min} and ${p.max}.`);
}

/** Re-evaluate bindings so stored props show the default instance. */
function respecialize(circuit: Circuit): Circuit {
  return specialize(circuit, paramDefaults(circuit));
}

function mapCircuit(project: Project, id: string, fn: (c: Circuit) => Circuit): Project {
  return { ...project, circuits: project.circuits.map((c) => (c.id === id ? fn(c) : c)) };
}

/** Add a parameter with a fresh name. */
export function addParam(circuit: Circuit, def: Partial<ParamDef> = {}): Circuit {
  const params = circuit.params ?? [];
  let name = def.name ?? 'N';
  if (def.name === undefined) for (let i = 2; params.some((p) => p.name === name); i++) name = `N${i}`;
  const p: ParamDef = { name, default: def.default ?? 8, min: def.min ?? 1, max: def.max ?? 32, ...(def.description ? { description: def.description } : {}) };
  checkParam(p, params);
  return { ...circuit, params: [...params, p] };
}

/**
 * Change a parameter. Renaming updates every binding in the circuit and the
 * "@name" values of its instances throughout the project.
 */
export function updateParam(project: Project, circuitId: string, name: string, patch: Partial<ParamDef>): Project {
  const circuit = project.circuits.find((c) => c.id === circuitId);
  const params = circuit?.params ?? [];
  const old = params.find((p) => p.name === name);
  if (!circuit || !old) throw new DefinitionError(`No parameter "${name}".`);
  const next: ParamDef = { ...old, ...patch };
  if (next.description === '') delete (next as { description?: string }).description;
  checkParam(
    next,
    params.filter((p) => p !== old),
  );
  const renamed = next.name !== old.name;
  let result = mapCircuit(project, circuitId, (c) => {
    const components = !renamed
      ? c.components
      : c.components.map((k) => {
          if (!k.bind) return k;
          const bind: Record<string, string> = {};
          for (const [prop, expr] of Object.entries(k.bind)) bind[prop] = renameInExpr(expr, old.name, next.name);
          return { ...k, bind };
        });
    return respecialize({ ...c, components, params: params.map((p) => (p === old ? next : p)) });
  });
  if (renamed) {
    const from = PARAM_PREFIX + old.name;
    const to = PARAM_PREFIX + next.name;
    result = {
      ...result,
      circuits: result.circuits.map((c) => {
        let changed = false;
        const components = c.components.map((k) => {
          if (k.type !== 'subcircuit' || strOf(k.props, 'circuit') !== circuitId) return k;
          if (!(from in k.props) && !(k.bind && from in k.bind)) return k;
          changed = true;
          return renameKey(k, from, to);
        });
        return changed ? { ...c, components } : c;
      }),
    };
  }
  return result;
}

function renameKey(k: ComponentInstance, from: string, to: string): ComponentInstance {
  const props: Record<string, PropValue> = {};
  for (const [key, v] of Object.entries(k.props)) props[key === from ? to : key] = v;
  let bind = k.bind;
  if (bind && from in bind) {
    const b: Record<string, string> = {};
    for (const [key, v] of Object.entries(bind)) b[key === from ? to : key] = v;
    bind = b;
  }
  return { ...k, props, ...(bind ? { bind } : {}) };
}

/**
 * Remove a parameter. Instances drop their value for it; bindings that still
 * use it are reported as diagnostics until they are changed.
 */
export function removeParam(project: Project, circuitId: string, name: string): Project {
  const key = PARAM_PREFIX + name;
  return {
    ...project,
    circuits: project.circuits.map((c) => {
      let next = c;
      if (c.id === circuitId) {
        const params = (c.params ?? []).filter((p) => p.name !== name);
        const { params: _omit, ...plain } = c;
        next = params.length ? { ...c, params } : plain;
      }
      let changed = false;
      const components = next.components.map((k) => {
        if (k.type !== 'subcircuit' || strOf(k.props, 'circuit') !== circuitId) return k;
        if (!(key in k.props) && !(k.bind && key in k.bind)) return k;
        changed = true;
        const { [key]: _p, ...props } = k.props;
        let bind = k.bind;
        if (bind && key in bind) {
          const { [key]: _b, ...rest } = bind;
          bind = Object.keys(rest).length ? rest : undefined;
        }
        const { bind: _old, ...base } = k;
        return { ...base, props, ...(bind ? { bind } : {}) };
      });
      return changed ? { ...next, components } : next;
    }),
  };
}

/**
 * Bind a component property to an expression over the circuit's parameters,
 * or remove the binding (expr null). The expression must evaluate for the
 * default values; the stored value becomes that result.
 */
export function setBinding(circuit: Circuit, componentId: string, prop: string, expr: string | null): Circuit {
  const comp = circuit.components.find((c) => c.id === componentId);
  if (!comp) return circuit;
  const bind: Record<string, string> = { ...comp.bind };
  if (expr === null) {
    if (!(prop in bind)) return circuit;
    delete bind[prop];
  } else {
    const text = expr.trim();
    try {
      evalExpr(text, paramDefaults(circuit));
    } catch (e) {
      throw new DefinitionError(e instanceof ExprError ? e.message : String(e));
    }
    bind[prop] = text;
  }
  const { bind: _old, ...base } = comp;
  const next: ComponentInstance = Object.keys(bind).length ? { ...base, bind } : base;
  return respecialize({ ...circuit, components: circuit.components.map((c) => (c === comp ? next : c)) });
}
