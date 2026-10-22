import { pointKey, type Point, type Wire } from './types.ts';

/*
 * Clean orthogonal routes for automatic wiring (instance synchronization,
 * component extraction). A route is clean when it touches no pin, wire end or
 * wire except at its own two ends, so adding it never creates a connection
 * other than the intended one.
 */

export function onSegment(w: { x1: number; y1: number; x2: number; y2: number }, x: number, y: number): boolean {
  if (w.y1 === w.y2) return y === w.y1 && x >= Math.min(w.x1, w.x2) && x <= Math.max(w.x1, w.x2);
  return x === w.x1 && y >= Math.min(w.y1, w.y2) && y <= Math.max(w.y1, w.y2);
}

export function isEnd(w: Wire, p: Point): boolean {
  return (w.x1 === p.x && w.y1 === p.y) || (w.x2 === p.x && w.y2 === p.y);
}

/**
 * Orthogonal path from `s` to pin `t` that arrives from outside the symbol
 * (along `out`) and touches no wire end, pin or wire other than at `s` and
 * `t`. Tries a straight line, then L and Z shapes with the jog as close to
 * the pin as possible.
 */
export function findRoute(s: Point, t: Point, out: Point, wires: readonly Wire[], pinKeys: ReadonlySet<number>): Point[] | null {
  if (s.x === t.x && s.y === t.y) return [s];
  const horizontal = out.y === 0;
  const candidates: Point[][] = [];
  const along = horizontal ? s.x - t.x : s.y - t.y;
  const aligned = horizontal ? s.y === t.y : s.x === t.x;
  if (aligned && along * (horizontal ? out.x : out.y) > 0) candidates.push([s, t]);
  const span = Math.abs(along);
  const reach = Math.max(span, 1) + 12;
  for (let k = 1; k <= reach; k++) {
    if (horizontal) {
      const x = t.x + out.x * k;
      candidates.push(compact([s, { x, y: s.y }, { x, y: t.y }, t]));
    } else {
      const y = t.y + out.y * k;
      candidates.push(compact([s, { x: s.x, y }, { x: t.x, y }, t]));
    }
  }
  // L shape leaving the start perpendicular to the pin's axis.
  candidates.push(compact(horizontal ? [s, { x: s.x, y: t.y }, t] : [s, { x: t.x, y: s.y }, t]));
  for (const path of candidates) if (path.length >= 2 && routeIsClean(path, wires, pinKeys, s, t)) return path;
  return null;
}

function compact(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    // Drop collinear middle points.
    if (out.length >= 2) {
      const a = out[out.length - 2];
      if ((a.x === last.x && last.x === p.x) || (a.y === last.y && last.y === p.y)) {
        // A path doubling back on itself is not a valid route.
        const back = (last.x - a.x) * (p.x - last.x) + (last.y - a.y) * (p.y - last.y) < 0;
        if (back) return [];
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

function routeIsClean(path: readonly Point[], wires: readonly Wire[], pinKeys: ReadonlySet<number>, s: Point, t: Point): boolean {
  const sKey = pointKey(s.x, s.y);
  const tKey = pointKey(t.x, t.y);
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const seg = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    const h = a.y === b.y;
    // No pin on the segment except the target (and the start, which is where the wire already was).
    for (let k = 0, n = h ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y); k <= n; k++) {
      const x = h ? Math.min(a.x, b.x) + k : a.x;
      const y = h ? a.y : Math.min(a.y, b.y) + k;
      const key = pointKey(x, y);
      if (key !== sKey && key !== tKey && pinKeys.has(key)) return false;
    }
    for (const w of wires) {
      const wh = w.y1 === w.y2;
      // Wire ends on the new segment would join it.
      for (const e of [
        { x: w.x1, y: w.y1 },
        { x: w.x2, y: w.y2 },
      ]) {
        const key = pointKey(e.x, e.y);
        if (key !== sKey && onSegment(seg, e.x, e.y)) return false;
      }
      // Bends and the target must not land on an existing wire.
      if (i > 0 && onSegment(w, a.x, a.y)) return false;
      if (i + 1 < path.length - 1 && onSegment(w, b.x, b.y)) return false;
      if (i + 1 === path.length - 1 && onSegment(w, b.x, b.y) && !isEnd(w, b)) return false;
      // Collinear overlap merges wires.
      if (wh === h) {
        if (h && w.y1 === a.y && overlap(w.x1, w.x2, a.x, b.x)) return false;
        if (!h && w.x1 === a.x && overlap(w.y1, w.y2, a.y, b.y)) return false;
      }
    }
  }
  return true;
}

function overlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)) > 0;
}
