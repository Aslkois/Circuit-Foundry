import {
  bitBoxSize,
  distanceToSegment,
  intOf,
  rectContains,
  rectsIntersect,
  type Circuit,
  type Connectivity,
  type Point,
  type Rect,
  type ResolvedComponent,
} from '../../model/index.ts';

export type Hit =
  | { readonly kind: 'none' }
  | { readonly kind: 'pin'; readonly componentId: string; readonly pin: string; readonly point: Point }
  | { readonly kind: 'input-cell'; readonly componentId: string; readonly bit: number }
  | { readonly kind: 'button'; readonly componentId: string }
  | { readonly kind: 'component'; readonly componentId: string }
  | { readonly kind: 'wire'; readonly wireId: string; readonly endpoint: Point | null; readonly point: Point };

export const NO_HIT: Hit = { kind: 'none' };

/** Component-local coordinates of a world point. */
export function toLocal(rc: ResolvedComponent, wx: number, wy: number): Point {
  const dx = wx - rc.comp.x;
  const dy = wy - rc.comp.y;
  switch (rc.comp.rotation) {
    case 0:
      return { x: dx, y: dy };
    case 90:
      return { x: dy, y: -dx };
    case 180:
      return { x: -dx, y: -dy };
    case 270:
      return { x: -dy, y: dx };
  }
}

/** Which bit cell of an input pin is under a world point, or -1. */
export function inputCellAt(rc: ResolvedComponent, wx: number, wy: number): number {
  const width = intOf(rc.props, 'width');
  const l = toLocal(rc, wx, wy);
  const b = rc.localBounds;
  if (!rectContains(b, l.x, l.y)) return -1;
  if (width === 1) return 0;
  const box = bitBoxSize(width);
  const col = Math.floor(l.x - (b.x + 0.5));
  const row = Math.floor(l.y - (b.y + 0.5));
  if (col < 0 || col >= box.cols || row < 0 || row >= box.rows) return -1;
  const idx = row * 8 + col;
  return idx < width ? width - 1 - idx : -1;
}

export interface HitOptions {
  /** Tolerance in world units. */
  readonly tolerance: number;
  /** Allow interacting with input cells and buttons (top-level sources). */
  readonly interactive: (componentId: string) => boolean;
}

export function hitTest(circuit: Circuit, conn: Connectivity, wx: number, wy: number, o: HitOptions): Hit {
  const tol = o.tolerance;
  const comps = circuit.components;

  // 1. Interactive controls take precedence over everything under them.
  for (let i = comps.length - 1; i >= 0; i--) {
    const c = comps[i];
    if (c.type !== 'input' && c.type !== 'button') continue;
    const rc = conn.components.get(c.id);
    if (!rc || !rectContains(rc.bounds, wx, wy)) continue;
    // Leave a margin around the pin itself so wires can still be started from it.
    const pin = rc.pins[0];
    if (pin && Math.hypot(pin.x - wx, pin.y - wy) < tol) break;
    if (!o.interactive(c.id)) break;
    if (c.type === 'button') return { kind: 'button', componentId: c.id };
    const bit = inputCellAt(rc, wx, wy);
    if (bit >= 0) return { kind: 'input-cell', componentId: c.id, bit };
  }

  // 2. Pins.
  let best: Hit = NO_HIT;
  let bestD = tol;
  for (const c of comps) {
    const rc = conn.components.get(c.id);
    if (!rc) continue;
    for (const pin of rc.pins) {
      const d = Math.hypot(pin.x - wx, pin.y - wy);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'pin', componentId: c.id, pin: pin.name, point: { x: pin.x, y: pin.y } };
      }
    }
  }
  if (best.kind !== 'none') return best;

  // 3. Wire endpoints.
  for (const w of circuit.wires) {
    for (const [x, y] of [
      [w.x1, w.y1],
      [w.x2, w.y2],
    ]) {
      const d = Math.hypot(x - wx, y - wy);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'wire', wireId: w.id, endpoint: { x, y }, point: { x, y } };
      }
    }
  }
  if (best.kind !== 'none') return best;

  // 4. Component bodies (topmost first).
  for (let i = comps.length - 1; i >= 0; i--) {
    const rc = conn.components.get(comps[i].id);
    if (rc && rectContains(rc.bounds, wx, wy, 0.15)) return { kind: 'component', componentId: comps[i].id };
  }

  // 5. Wire segments.
  bestD = tol * 0.8;
  for (const w of circuit.wires) {
    const d = distanceToSegment(wx, wy, w.x1, w.y1, w.x2, w.y2);
    if (d < bestD) {
      bestD = d;
      const point = w.y1 === w.y2 ? { x: Math.round(wx), y: w.y1 } : { x: w.x1, y: Math.round(wy) };
      best = { kind: 'wire', wireId: w.id, endpoint: null, point };
    }
  }
  return best;
}

/** Components and wires touching a rectangle. */
export function itemsInRect(circuit: Circuit, conn: Connectivity, rect: Rect): { components: Set<string>; wires: Set<string> } {
  const components = new Set<string>();
  const wires = new Set<string>();
  for (const c of circuit.components) {
    const rc = conn.components.get(c.id);
    if (rc && rectsIntersect(rc.bounds, rect)) components.add(c.id);
  }
  for (const w of circuit.wires) {
    const seg: Rect = { x: Math.min(w.x1, w.x2), y: Math.min(w.y1, w.y2), w: Math.abs(w.x2 - w.x1), h: Math.abs(w.y2 - w.y1) };
    if (rectsIntersect(seg, rect)) wires.add(w.id);
  }
  return { components, wires };
}
