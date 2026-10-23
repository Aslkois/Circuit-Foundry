import type { PinDirection } from '../engine/primitives/types.ts';
import {
  DEFAULT_SYMBOL_WIDTH,
  getDef,
  normalizeProps,
  strOf,
  type CircuitInterface,
  type ComponentTypeDef,
  type LayoutContext,
  type PortDef,
} from './catalog/index.ts';
import { rotatePoint, rotateRect, translateRect, type Rect } from './geometry.ts';
import { instanceParamValues, specialize } from './params.ts';
import { PORT_SIDES, type Circuit, type ComponentInstance, type PortPlacement, type PortSide, type Project, type Props } from './types.ts';

/* ------------------------------------------------------------------------ */
/* Circuit interfaces                                                        */
/* ------------------------------------------------------------------------ */

const interfaceCache = new WeakMap<Circuit, CircuitInterface>();
/** Interning keeps the same object for structurally equal interfaces, so layout caches survive unrelated edits. */
const interned = new Map<string, CircuitInterface>();

function byPosition(a: ComponentInstance, b: ComponentInstance): number {
  return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function validPlacement(p: PortPlacement | undefined): p is PortPlacement {
  return !!p && PORT_SIDES.includes(p.side) && Number.isInteger(p.slot) && p.slot >= 0 && p.slot < 256;
}

/**
 * Ports of a circuit with their symbol placement. Ports with a valid explicit
 * placement keep it; the others go on their default side (inputs left,
 * outputs right) after the explicitly placed ones, in schematic order
 * (top to bottom, then left to right).
 */
function resolvePorts(circuit: Circuit): PortDef[] {
  const placements = circuit.symbol?.ports ?? {};
  const pins = circuit.components.filter((c) => c.type === 'input' || c.type === 'output').sort(byPosition);
  const taken: Record<PortSide, Set<number>> = { left: new Set(), right: new Set(), top: new Set(), bottom: new Set() };
  const placed = new Map<string, PortPlacement>();
  for (const c of pins) {
    const p = placements[c.id];
    if (validPlacement(p) && !taken[p.side].has(p.slot)) {
      taken[p.side].add(p.slot);
      placed.set(c.id, p);
    }
  }
  const next: Record<PortSide, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const side of PORT_SIDES) next[side] = taken[side].size === 0 ? 0 : Math.max(...taken[side]) + 1;
  const out: PortDef[] = [];
  for (const c of pins) {
    const def = getDef(c.type)!;
    const props = normalizeProps(def, c.props).props;
    const dir = c.type === 'input' ? 'in' : 'out';
    let p = placed.get(c.id);
    if (!p) {
      const requested = placements[c.id];
      const side: PortSide = requested && PORT_SIDES.includes(requested.side) ? requested.side : dir === 'in' ? 'left' : 'right';
      p = { side, slot: next[side]++, clock: requested?.clock };
    }
    const label = strOf(props, 'label') || c.id;
    out.push({ id: c.id, label, width: props.width as number, dir, side: p.side, slot: p.slot, clock: p.clock ?? /^(clk|clock)$/i.test(label) });
  }
  const sideOrder = (x: PortDef) => PORT_SIDES.indexOf(x.side);
  return out.sort((a, b) => sideOrder(a) - sideOrder(b) || a.slot - b.slot);
}

/**
 * The ports a circuit exposes when used as a component (its Input and Output
 * pins) and the shape of its symbol.
 */
export function circuitInterface(circuit: Circuit): CircuitInterface {
  const cached = interfaceCache.get(circuit);
  if (cached) return cached;
  const ports = resolvePorts(circuit);
  const w = circuit.symbol?.width;
  const iface: CircuitInterface = {
    circuitId: circuit.id,
    name: circuit.name,
    inputs: ports.filter((p) => p.dir === 'in'),
    outputs: ports.filter((p) => p.dir === 'out'),
    symbolWidth: typeof w === 'number' && Number.isInteger(w) ? Math.min(40, Math.max(4, w + (w % 2))) : DEFAULT_SYMBOL_WIDTH,
    symbolLabel: circuit.symbol?.label ?? '',
    params: circuit.params ?? [],
  };
  const sig = JSON.stringify(iface);
  let result = interned.get(sig);
  if (!result) {
    if (interned.size > 5000) interned.clear();
    interned.set(sig, iface);
    result = iface;
  }
  interfaceCache.set(circuit, result);
  return result;
}

/** Layout context over any circuit lookup; parametric circuits are specialized for the asking instance. */
export function lookupContext(getCircuit: (id: string) => Circuit | undefined): LayoutContext {
  return {
    getInterface: (id: string, instanceProps?: Props) => {
      const c = getCircuit(id);
      if (!c) return undefined;
      if (!c.params?.length) return circuitInterface(c);
      return circuitInterface(specialize(c, instanceParamValues(c, instanceProps ?? {}).values));
    },
  };
}

const contextCache = new WeakMap<Project, LayoutContext>();

/** Layout context resolving subcircuit interfaces (for the instance's parameter values) within a project. */
export function projectContext(project: Project): LayoutContext {
  let ctx = contextCache.get(project);
  if (!ctx) {
    const byId = new Map(project.circuits.map((c) => [c.id, c]));
    ctx = lookupContext((id) => byId.get(id));
    contextCache.set(project, ctx);
  }
  return ctx;
}

/* ------------------------------------------------------------------------ */
/* Component geometry in circuit coordinates                                 */
/* ------------------------------------------------------------------------ */

export interface ResolvedPin {
  readonly name: string;
  readonly dir: PinDirection;
  /** 0 = auto width (adopts the connected net's width). */
  readonly width: number;
  /** Circuit coordinates. */
  readonly x: number;
  readonly y: number;
  /** Optional text drawn next to the pin. */
  readonly label?: string;
  readonly clock?: boolean;
}

export interface ResolvedComponent {
  readonly comp: ComponentInstance;
  readonly def: ComponentTypeDef | undefined;
  /** Normalized props (defaults filled in). */
  readonly props: Props;
  readonly pins: readonly ResolvedPin[];
  /** Body bounds in circuit coordinates. */
  readonly bounds: Rect;
  /** Body bounds in local unrotated coordinates. */
  readonly localBounds: Rect;
  readonly bodyText?: string;
}

const UNKNOWN_BOUNDS: Rect = { x: -2, y: -2, w: 4, h: 4 };

interface LayoutCacheEntry {
  iface: CircuitInterface | undefined;
  result: ResolvedComponent;
}

const layoutCache = new WeakMap<ComponentInstance, LayoutCacheEntry>();

/** World-space pins and bounds of a component. Cached per component object. */
export function resolveComponent(comp: ComponentInstance, ctx: LayoutContext): ResolvedComponent {
  const def = getDef(comp.type);
  const iface = def?.role.kind === 'subcircuit' ? ctx.getInterface(strOf(comp.props, 'circuit'), comp.props) : undefined;
  const cached = layoutCache.get(comp);
  if (cached && cached.iface === iface) return cached.result;

  let result: ResolvedComponent;
  if (!def) {
    result = {
      comp,
      def,
      props: comp.props,
      pins: [],
      bounds: translateRect(UNKNOWN_BOUNDS, comp.x, comp.y),
      localBounds: UNKNOWN_BOUNDS,
    };
  } else {
    const props = normalizeProps(def, comp.props).props;
    const layout = def.layout(props, ctx, comp);
    const pins = layout.pins.map((p) => {
      const r = rotatePoint(p.x, p.y, comp.rotation);
      return { name: p.name, dir: p.dir, width: p.width, x: comp.x + r.x, y: comp.y + r.y, label: p.label, ...(p.clock ? { clock: true } : {}) };
    });
    result = {
      comp,
      def,
      props,
      pins,
      bounds: translateRect(rotateRect(layout.bounds, comp.rotation), comp.x, comp.y),
      localBounds: layout.bounds,
      ...(layout.bodyText ? { bodyText: layout.bodyText } : {}),
    };
  }
  layoutCache.set(comp, { iface, result });
  return result;
}
