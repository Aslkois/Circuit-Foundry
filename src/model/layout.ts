import type { PinDirection } from '../engine/primitives/types.ts';
import {
  getDef,
  normalizeProps,
  strOf,
  type CircuitInterface,
  type ComponentTypeDef,
  type LayoutContext,
  type PortDef,
} from './catalog/index.ts';
import { rotatePoint, rotateRect, translateRect, type Rect } from './geometry.ts';
import type { Circuit, ComponentInstance, Project, Props } from './types.ts';

/* ------------------------------------------------------------------------ */
/* Circuit interfaces                                                        */
/* ------------------------------------------------------------------------ */

const interfaceCache = new WeakMap<Circuit, CircuitInterface>();
/** Interning keeps the same object for structurally equal interfaces, so layout caches survive unrelated edits. */
const interned = new Map<string, CircuitInterface>();

function portsOf(circuit: Circuit, type: 'input' | 'output'): PortDef[] {
  const def = getDef(type)!;
  return circuit.components
    .filter((c) => c.type === type)
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => {
      const props = normalizeProps(def, c.props).props;
      return { id: c.id, label: strOf(props, 'label') || c.id, width: props.width as number };
    });
}

/**
 * The ports a circuit exposes when used as a component: its Input pins and
 * Output pins, each side ordered top-to-bottom (then left-to-right) by their
 * position in the circuit.
 */
export function circuitInterface(circuit: Circuit): CircuitInterface {
  const cached = interfaceCache.get(circuit);
  if (cached) return cached;
  const iface: CircuitInterface = {
    circuitId: circuit.id,
    name: circuit.name,
    inputs: portsOf(circuit, 'input'),
    outputs: portsOf(circuit, 'output'),
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

const contextCache = new WeakMap<Project, LayoutContext>();

/** Layout context resolving subcircuit interfaces within a project. */
export function projectContext(project: Project): LayoutContext {
  let ctx = contextCache.get(project);
  if (!ctx) {
    const byId = new Map(project.circuits.map((c) => [c.id, c]));
    ctx = {
      getInterface: (id: string) => {
        const c = byId.get(id);
        return c ? circuitInterface(c) : undefined;
      },
    };
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
  const iface = def?.role.kind === 'subcircuit' ? ctx.getInterface(strOf(comp.props, 'circuit')) : undefined;
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
    const layout = def.layout(props, ctx);
    const pins = layout.pins.map((p) => {
      const r = rotatePoint(p.x, p.y, comp.rotation);
      return { name: p.name, dir: p.dir, width: p.width, x: comp.x + r.x, y: comp.y + r.y, label: p.label };
    });
    result = {
      comp,
      def,
      props,
      pins,
      bounds: translateRect(rotateRect(layout.bounds, comp.rotation), comp.x, comp.y),
      localBounds: layout.bounds,
    };
  }
  layoutCache.set(comp, { iface, result });
  return result;
}
