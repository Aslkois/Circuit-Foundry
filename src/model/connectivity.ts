import type { PinDirection } from '../engine/primitives/types.ts';
import { strOf, type CircuitInterface, type LayoutContext } from './catalog/index.ts';
import { resolveComponent, type ResolvedComponent } from './layout.ts';
import { pointKey, type Circuit, type Point } from './types.ts';

/*
 * Geometric connectivity of one circuit.
 *
 * Connection rules (all on the integer grid):
 *  - a wire connects its two endpoints;
 *  - wire endpoints and component pins at the same point are connected;
 *  - a wire endpoint or pin lying on the interior of another wire connects to
 *    that wire (a T junction);
 *  - two wires crossing at interior points are NOT connected.
 */

export interface NetPin {
  readonly componentId: string;
  readonly pin: string;
  readonly dir: PinDirection;
  /** 0 = auto width. */
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface LocalNet {
  readonly id: number;
  /** Width agreed by all fixed-width pins; null when no fixed-width pin is attached or widths conflict. */
  readonly width: number | null;
  /** Fixed-width pins on this net disagree about the width. */
  readonly widthConflict: boolean;
  readonly pins: readonly NetPin[];
  readonly wireIds: readonly string[];
}

export interface Connectivity {
  readonly circuit: Circuit;
  readonly nets: readonly LocalNet[];
  readonly components: ReadonlyMap<string, ResolvedComponent>;
  /** Net id per wire id. */
  readonly wireNet: ReadonlyMap<string, number>;
  /** Net id per pin, keyed by pinKey(componentId, pin). */
  readonly pinNet: ReadonlyMap<string, number>;
  /** Points where three or more connections meet (drawn as junction dots). */
  readonly junctions: readonly Point[];
}

export function pinKey(componentId: string, pin: string): string {
  return `${componentId}:${pin}`;
}

interface CacheEntry {
  deps: Map<string, CircuitInterface | undefined>;
  result: Connectivity;
}

const cache = new WeakMap<Circuit, CacheEntry>();

/** Connectivity of a circuit; cached per circuit object and the interfaces of the subcircuits it uses. */
export function analyzeConnectivity(circuit: Circuit, ctx: LayoutContext): Connectivity {
  const hit = cache.get(circuit);
  if (hit && [...hit.deps].every(([id, iface]) => ctx.getInterface(id) === iface)) return hit.result;

  const deps = new Map<string, CircuitInterface | undefined>();
  for (const c of circuit.components) {
    if (c.type === 'subcircuit') {
      const id = strOf(c.props, 'circuit');
      deps.set(id, ctx.getInterface(id));
    }
  }
  const result = compute(circuit, ctx);
  cache.set(circuit, { deps, result });
  return result;
}

function compute(circuit: Circuit, ctx: LayoutContext): Connectivity {
  const nodeOf = new Map<number, number>();
  const nodePoints: Point[] = [];
  const parent: number[] = [];
  const node = (x: number, y: number): number => {
    const k = pointKey(x, y);
    let n = nodeOf.get(k);
    if (n === undefined) {
      n = nodePoints.length;
      nodeOf.set(k, n);
      nodePoints.push({ x, y });
      parent.push(n);
    }
    return n;
  };
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const x = find(a);
    const y = find(b);
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };

  // Count connection "ends" per point for junction dots.
  const degree = new Map<number, number>();
  const bump = (x: number, y: number, by = 1) => {
    const k = pointKey(x, y);
    degree.set(k, (degree.get(k) ?? 0) + by);
  };

  const horizontal = new Map<number, { x1: number; x2: number; node: number }[]>();
  const vertical = new Map<number, { y1: number; y2: number; node: number }[]>();
  const wireNode: number[] = [];
  for (const w of circuit.wires) {
    const a = node(w.x1, w.y1);
    const b = node(w.x2, w.y2);
    union(a, b);
    wireNode.push(a);
    bump(w.x1, w.y1);
    bump(w.x2, w.y2);
    if (w.y1 === w.y2 && w.x1 !== w.x2) {
      let row = horizontal.get(w.y1);
      if (!row) horizontal.set(w.y1, (row = []));
      row.push({ x1: Math.min(w.x1, w.x2), x2: Math.max(w.x1, w.x2), node: a });
    } else if (w.x1 === w.x2 && w.y1 !== w.y2) {
      let col = vertical.get(w.x1);
      if (!col) vertical.set(w.x1, (col = []));
      col.push({ y1: Math.min(w.y1, w.y2), y2: Math.max(w.y1, w.y2), node: a });
    }
  }

  const components = new Map<string, ResolvedComponent>();
  const pinNodes: { componentId: string; pin: ResolvedComponent['pins'][number]; node: number }[] = [];
  for (const comp of circuit.components) {
    const rc = resolveComponent(comp, ctx);
    components.set(comp.id, rc);
    for (const pin of rc.pins) {
      pinNodes.push({ componentId: comp.id, pin, node: node(pin.x, pin.y) });
      bump(pin.x, pin.y);
    }
  }

  // T junctions: any point of interest on the interior of a wire joins that wire.
  for (let n = 0; n < nodePoints.length; n++) {
    const { x, y } = nodePoints[n];
    const row = horizontal.get(y);
    if (row) {
      for (const seg of row) {
        if (x > seg.x1 && x < seg.x2) {
          union(n, seg.node);
          bump(x, y, 2);
        }
      }
    }
    const col = vertical.get(x);
    if (col) {
      for (const seg of col) {
        if (y > seg.y1 && y < seg.y2) {
          union(n, seg.node);
          bump(x, y, 2);
        }
      }
    }
  }

  // Assign net ids in a deterministic order: wires first, then pins.
  const netOfRoot = new Map<number, number>();
  const netPins: NetPin[][] = [];
  const netWires: string[][] = [];
  const netFor = (n: number): number => {
    const r = find(n);
    let id = netOfRoot.get(r);
    if (id === undefined) {
      id = netPins.length;
      netOfRoot.set(r, id);
      netPins.push([]);
      netWires.push([]);
    }
    return id;
  };

  const wireNet = new Map<string, number>();
  circuit.wires.forEach((w, i) => {
    const id = netFor(wireNode[i]);
    wireNet.set(w.id, id);
    netWires[id].push(w.id);
  });
  const pinNet = new Map<string, number>();
  for (const p of pinNodes) {
    const id = netFor(p.node);
    pinNet.set(pinKey(p.componentId, p.pin.name), id);
    netPins[id].push({ componentId: p.componentId, pin: p.pin.name, dir: p.pin.dir, width: p.pin.width, x: p.pin.x, y: p.pin.y });
  }

  const nets: LocalNet[] = netPins.map((pins, id) => {
    let width: number | null = null;
    let widthConflict = false;
    for (const p of pins) {
      if (p.width <= 0) continue;
      if (width === null) width = p.width;
      else if (width !== p.width) widthConflict = true;
    }
    return { id, width: widthConflict ? null : width, widthConflict, pins, wireIds: netWires[id] };
  });

  const junctions: Point[] = [];
  for (const [k, d] of degree) {
    if (d < 3) continue;
    const n = nodeOf.get(k);
    if (n !== undefined) junctions.push(nodePoints[n]);
  }

  return { circuit, nets, components, wireNet, pinNet, junctions };
}
