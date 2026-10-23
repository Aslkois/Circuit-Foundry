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

/** A point a route may end at, entered while moving in one of `dirs`. */
export interface RouteTarget {
  readonly at: Point;
  readonly dirs: readonly Point[];
}

const DIRS4: readonly Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

/**
 * Shortest clean orthogonal path from `s` to any target, found by a
 * Dijkstra search over the grid (cost: length plus a penalty per bend). The
 * path may cross existing wires at right angles but never runs along one,
 * never bends on one, and never passes a pin or wire end other than its own
 * start and target. The search is limited to the box around the start and
 * targets, widened by `margin`.
 */
export function routeMaze(s: Point, targets: readonly RouteTarget[], wires: readonly Wire[], pinKeys: ReadonlySet<number>, margin = 8, bendCost = 3): Point[] | null {
  if (targets.length === 0) return null;
  let minX = s.x;
  let maxX = s.x;
  let minY = s.y;
  let maxY = s.y;
  for (const t of targets) {
    minX = Math.min(minX, t.at.x);
    maxX = Math.max(maxX, t.at.x);
    minY = Math.min(minY, t.at.y);
    maxY = Math.max(maxY, t.at.y);
  }
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;
  const W = maxX - minX + 1;
  const H = maxY - minY + 1;
  if (W * H > 400_000) return null;
  const idx = (x: number, y: number) => (y - minY) * W + (x - minX);
  const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;

  // Occupancy of the region.
  const blocked = new Uint8Array(W * H); // pins and wire ends
  const onWire = new Uint8Array(W * H);
  const hEdge = new Uint8Array(W * H); // edge (x,y)-(x+1,y) is covered by a horizontal wire
  const vEdge = new Uint8Array(W * H); // edge (x,y)-(x,y+1) is covered by a vertical wire
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (pinKeys.has(pointKey(x, y))) blocked[idx(x, y)] = 1;
  for (const w of wires) {
    for (const [ex, ey] of [
      [w.x1, w.y1],
      [w.x2, w.y2],
    ]) {
      if (inside(ex, ey)) blocked[idx(ex, ey)] = 1;
    }
    if (w.y1 === w.y2) {
      if (w.y1 < minY || w.y1 > maxY) continue;
      const lo = Math.min(w.x1, w.x2);
      const hi = Math.max(w.x1, w.x2);
      for (let x = Math.max(lo, minX); x <= Math.min(hi, maxX); x++) {
        onWire[idx(x, w.y1)] = 1;
        if (x < hi) hEdge[idx(x, w.y1)] = 1;
      }
    } else {
      if (w.x1 < minX || w.x1 > maxX) continue;
      const lo = Math.min(w.y1, w.y2);
      const hi = Math.max(w.y1, w.y2);
      for (let y = Math.max(lo, minY); y <= Math.min(hi, maxY); y++) {
        onWire[idx(w.x1, y)] = 1;
        if (y < hi) vEdge[idx(w.x1, y)] = 1;
      }
    }
  }
  const edgeCovered = (x: number, y: number, d: Point): boolean => {
    if (d.y === 0) {
      const ex = d.x > 0 ? x : x - 1;
      return inside(ex, y) && hEdge[idx(ex, y)] === 1;
    }
    const ey = d.y > 0 ? y : y - 1;
    return inside(x, ey) && vEdge[idx(x, ey)] === 1;
  };

  const targetDirs = new Map<number, number>();
  for (const t of targets) {
    if (!inside(t.at.x, t.at.y)) continue;
    let mask = targetDirs.get(idx(t.at.x, t.at.y)) ?? 0;
    for (const d of t.dirs) mask |= 1 << DIRS4.findIndex((q) => q.x === d.x && q.y === d.y);
    targetDirs.set(idx(t.at.x, t.at.y), mask);
  }

  // Dijkstra over (cell, incoming direction); direction 4 = the start.
  const N = W * H * 5;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap: number[] = [];
  const hk: number[] = [];
  const push = (state: number, cost: number) => {
    heap.push(state);
    hk.push(cost);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= hk[i]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      [hk[p], hk[i]] = [hk[i], hk[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const lastS = heap.pop()!;
    const lastK = hk.pop()!;
    if (heap.length > 0) {
      heap[0] = lastS;
      hk[0] = lastK;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && hk[l] < hk[m]) m = l;
        if (r < heap.length && hk[r] < hk[m]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        [hk[m], hk[i]] = [hk[i], hk[m]];
        i = m;
      }
    }
    return top;
  };
  const sCell = idx(s.x, s.y);
  const start = sCell * 5 + 4;
  dist[start] = 0;
  push(start, 0);
  let found = -1;
  while (heap.length > 0) {
    const state = pop();
    const cell = (state / 5) | 0;
    const din = state % 5;
    const cost = dist[state];
    const x = (cell % W) + minX;
    const y = ((cell / W) | 0) + minY;
    if (din !== 4) {
      const mask = targetDirs.get(cell);
      if (mask !== undefined && mask & (1 << din)) {
        found = state;
        break;
      }
    }
    for (let d = 0; d < 4; d++) {
      if (din !== 4 && (d + 2) % 4 === din) continue;
      const bend = din !== 4 && d !== din;
      if (bend && (onWire[cell] || blocked[cell])) continue;
      const dv = DIRS4[d];
      const nx = x + dv.x;
      const ny = y + dv.y;
      if (!inside(nx, ny) || edgeCovered(x, y, dv)) continue;
      const ncell = idx(nx, ny);
      if (ncell === sCell) continue;
      const isTarget = ((targetDirs.get(ncell) ?? 0) & (1 << d)) !== 0;
      if (blocked[ncell] && !isTarget) continue;
      const nstate = ncell * 5 + d;
      const ncost = cost + 1 + (bend ? bendCost : 0);
      if (ncost < dist[nstate]) {
        dist[nstate] = ncost;
        prev[nstate] = state;
        push(nstate, ncost);
      }
    }
  }
  if (found < 0) return null;
  const pts: Point[] = [];
  for (let st = found; st >= 0; st = prev[st]) {
    const cell = (st / 5) | 0;
    pts.push({ x: (cell % W) + minX, y: ((cell / W) | 0) + minY });
  }
  pts.reverse();
  return compact(pts);
}

/**
 * Clean orthogonal path from `s` to pin `t`, arriving from outside the
 * symbol (moving against `out`).
 */
export function findRoute(s: Point, t: Point, out: Point, wires: readonly Wire[], pinKeys: ReadonlySet<number>): Point[] | null {
  if (s.x === t.x && s.y === t.y) return [s];
  return routeMaze(s, [{ at: t, dirs: [{ x: -out.x, y: -out.y }] }], wires, pinKeys);
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

interface Seg {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * New segments touch existing pins and wires only at `allowed` points: no
 * pin or wire end on them elsewhere, none of their ends on an existing wire
 * elsewhere, and no collinear overlap with an existing wire.
 */
export function segmentsClean(segs: readonly Seg[], wires: readonly Wire[], pinKeys: ReadonlySet<number>, allowed: ReadonlySet<number>): boolean {
  for (const seg of segs) {
    const h = seg.y1 === seg.y2;
    const n = h ? Math.abs(seg.x2 - seg.x1) : Math.abs(seg.y2 - seg.y1);
    for (let k = 0; k <= n; k++) {
      const x = h ? Math.min(seg.x1, seg.x2) + k : seg.x1;
      const y = h ? seg.y1 : Math.min(seg.y1, seg.y2) + k;
      const key = pointKey(x, y);
      if (pinKeys.has(key) && !allowed.has(key)) return false;
    }
    for (const w of wires) {
      for (const e of [
        { x: w.x1, y: w.y1 },
        { x: w.x2, y: w.y2 },
      ]) {
        if (onSegment(seg, e.x, e.y) && !allowed.has(pointKey(e.x, e.y))) return false;
      }
      if (onSegment(w, seg.x1, seg.y1) && !allowed.has(pointKey(seg.x1, seg.y1))) return false;
      if (onSegment(w, seg.x2, seg.y2) && !allowed.has(pointKey(seg.x2, seg.y2))) return false;
      const wh = w.y1 === w.y2;
      if (wh === h) {
        if (h && w.y1 === seg.y1 && overlap(w.x1, w.x2, seg.x1, seg.x2)) return false;
        if (!h && w.x1 === seg.x1 && overlap(w.y1, w.y2, seg.y1, seg.y2)) return false;
      }
    }
  }
  return true;
}

/**
 * Connect several start points to one pin with a comb: a stub out of the pin
 * to a spine perpendicular to it, and a straight leg from the spine to each
 * start. Every start must lie beyond the spine (seen from the pin). Returns
 * the segments, or null when no clean comb exists.
 */
export function findComb(t: Point, out: Point, starts: readonly Point[], wires: readonly Wire[], pinKeys: ReadonlySet<number>): Seg[] | null {
  if (starts.length === 0) return [];
  const horizontal = out.y === 0;
  const along = (p: Point) => (horizontal ? (p.x - t.x) * out.x : (p.y - t.y) * out.y);
  const across = (p: Point) => (horizontal ? p.y : p.x);
  const nearest = Math.min(...starts.map(along));
  if (nearest < 1) return null;
  const allowed = new Set([pointKey(t.x, t.y), ...starts.map((p) => pointKey(p.x, p.y))]);
  for (let k = 1; k <= nearest; k++) {
    const at = (c: number): Point => (horizontal ? { x: t.x + out.x * k, y: c } : { x: c, y: t.y + out.y * k });
    const segs: Seg[] = [];
    const root = at(across(t));
    segs.push({ x1: t.x, y1: t.y, x2: root.x, y2: root.y });
    const cs = [across(t), ...starts.map(across)];
    const lo = Math.min(...cs);
    const hi = Math.max(...cs);
    if (hi > lo) {
      const a = at(lo);
      const b = at(hi);
      segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    for (const p of starts) {
      const j = at(across(p));
      if (j.x !== p.x || j.y !== p.y) segs.push({ x1: j.x, y1: j.y, x2: p.x, y2: p.y });
    }
    if (segmentsClean(segs, wires, pinKeys, allowed)) return segs;
  }
  return null;
}

/**
 * Remove dead-end wire chains starting at the given points: while a point
 * has no pin and exactly one wire ending there (and no wire passing through),
 * drop that wire and continue from its other end. Returns the remaining wires
 * and, per input point, where its chain stopped (null when nothing is left
 * there to connect to).
 */
export function trimStubs(wires: readonly Wire[], pinKeys: ReadonlySet<number>, points: readonly Point[]): { wires: Wire[]; ends: (Point | null)[] } {
  let rest = [...wires];
  const walk = (start: Point): Point | null => {
    let p = start;
    for (;;) {
      if (pinKeys.has(pointKey(p.x, p.y))) return p;
      const at = rest.filter((w) => onSegment(w, p.x, p.y));
      if (at.length === 0) return null;
      if (at.length > 1 || !isEnd(at[0], p)) return p;
      const w = at[0];
      rest = rest.filter((x) => x !== w);
      p = w.x1 === p.x && w.y1 === p.y ? { x: w.x2, y: w.y2 } : { x: w.x1, y: w.y1 };
    }
  };
  let ends = points.map(walk);
  // A chain can stop at a junction that a later chain then turns into a dead end: repeat until stable.
  for (let changed = true; changed; ) {
    changed = false;
    ends = ends.map((p) => {
      if (!p) return p;
      const q = walk(p);
      if (q?.x !== p.x || q?.y !== p.y) changed = true;
      return q;
    });
  }
  return { wires: rest, ends };
}

function overlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)) > 0;
}

/**
 * Connect `points` into one tree with clean routes: each point after the
 * first is routed to the nearest part of the tree built so far (the first
 * point, or any point of an earlier route, joined as a T). Returns the new
 * segments, or null if some point cannot be reached.
 */
export function connectTree(points: readonly Point[], wires: readonly Wire[], pinKeys: ReadonlySet<number>): Seg[] | null {
  if (points.length < 2) return [];
  const all: Wire[] = [...wires];
  const segs: Seg[] = [];
  const tree: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (tree.some((q) => q.x === p.x && q.y === p.y)) continue;
    const path = routeMaze(
      p,
      tree.map((at) => ({ at, dirs: DIRS4 })),
      all,
      pinKeys,
    );
    if (!path) return null;
    for (let k = 0; k + 1 < path.length; k++) {
      const a = path[k];
      const b = path[k + 1];
      const seg = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      segs.push(seg);
      all.push({ id: '', ...seg });
      const n = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      for (let j = 0; j <= n; j++) tree.push({ x: a.x + Math.sign(b.x - a.x) * j, y: a.y + Math.sign(b.y - a.y) * j });
    }
  }
  return segs;
}
