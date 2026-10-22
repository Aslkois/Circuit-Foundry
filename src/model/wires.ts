import { pointKey, type Point, type Wire } from './types.ts';

/*
 * Wire canonicalization.
 *
 * Editing produces overlapping, touching and redundant segments. After every
 * edit the wire set is rewritten into a canonical form that is electrically
 * identical (see connectivity.ts for the rules):
 *
 *  - zero-length segments are dropped;
 *  - collinear segments that overlap or touch are merged into one interval;
 *  - intervals are split at every junction inside them: a pin, the end of a
 *    perpendicular wire, or the end of a collinear wire where a perpendicular
 *    wire passes (an explicit four-way junction).
 *
 * Unchanged segments keep their ids, so selections and diffs stay stable.
 */

interface Seg {
  /** Fixed coordinate (y for horizontal, x for vertical). */
  line: number;
  start: number;
  end: number;
  horizontal: boolean;
  id?: string;
  order: number;
}

function toSeg(w: Wire, order: number): Seg | null {
  if (w.y1 === w.y2 && w.x1 !== w.x2) {
    return { line: w.y1, start: Math.min(w.x1, w.x2), end: Math.max(w.x1, w.x2), horizontal: true, id: w.id, order };
  }
  if (w.x1 === w.x2 && w.y1 !== w.y2) {
    return { line: w.x1, start: Math.min(w.y1, w.y2), end: Math.max(w.y1, w.y2), horizontal: false, id: w.id, order };
  }
  return null;
}

function mergeIntervals(segs: Seg[]): { line: number; start: number; end: number; members: Seg[] }[] {
  const byLine = new Map<number, Seg[]>();
  for (const s of segs) {
    let list = byLine.get(s.line);
    if (!list) byLine.set(s.line, (list = []));
    list.push(s);
  }
  const out: { line: number; start: number; end: number; members: Seg[] }[] = [];
  for (const [line, list] of byLine) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let cur: { line: number; start: number; end: number; members: Seg[] } | null = null;
    for (const s of list) {
      if (cur && s.start <= cur.end) {
        cur.end = Math.max(cur.end, s.end);
        cur.members.push(s);
      } else {
        cur = { line, start: s.start, end: s.end, members: [s] };
        out.push(cur);
      }
    }
  }
  return out;
}

export function normalizeWires(wires: readonly Wire[], pins: Iterable<Point>, newId: () => string): readonly Wire[] {
  const segs: Seg[] = [];
  wires.forEach((w, i) => {
    const s = toSeg(w, i);
    if (s) segs.push(s);
  });

  const pinPoints = [...pins];
  const pinSet = new Set<number>();
  for (const p of pinPoints) pinSet.add(pointKey(p.x, p.y));
  const hEnds = new Set<number>();
  const vEnds = new Set<number>();
  for (const s of segs) {
    const set = s.horizontal ? hEnds : vEnds;
    set.add(s.horizontal ? pointKey(s.start, s.line) : pointKey(s.line, s.start));
    set.add(s.horizontal ? pointKey(s.end, s.line) : pointKey(s.line, s.end));
  }

  const hIntervals = mergeIntervals(segs.filter((s) => s.horizontal));
  const vIntervals = mergeIntervals(segs.filter((s) => !s.horizontal));

  const covers = (intervals: typeof hIntervals, line: number, pos: number) =>
    intervals.some((iv) => iv.line === line && pos > iv.start && pos < iv.end);
  // Index perpendicular intervals by line for the four-way junction test.
  const vByX = new Map<number, typeof vIntervals>();
  for (const iv of vIntervals) vByX.set(iv.line, [...(vByX.get(iv.line) ?? []), iv]);
  const hByY = new Map<number, typeof hIntervals>();
  for (const iv of hIntervals) hByY.set(iv.line, [...(hByY.get(iv.line) ?? []), iv]);

  // Candidate split points per line: every pin and wire end lying on it.
  const byY = new Map<number, Set<number>>();
  const byX = new Map<number, Set<number>>();
  const addPoint = (x: number, y: number) => {
    let row = byY.get(y);
    if (!row) byY.set(y, (row = new Set()));
    row.add(x);
    let col = byX.get(x);
    if (!col) byX.set(x, (col = new Set()));
    col.add(y);
  };
  for (const p of pinPoints) addPoint(p.x, p.y);
  for (const s of segs) {
    if (s.horizontal) {
      addPoint(s.start, s.line);
      addPoint(s.end, s.line);
    } else {
      addPoint(s.line, s.start);
      addPoint(s.line, s.end);
    }
  }
  const candidates = (horizontal: boolean, line: number): number[] => [...((horizontal ? byY : byX).get(line) ?? [])];

  const result: Seg[] = [];
  const emit = (horizontal: boolean, intervals: typeof hIntervals) => {
    for (const iv of intervals) {
      const cands = candidates(horizontal, iv.line);
      const splits: number[] = [];
      for (const pos of cands) {
        if (pos <= iv.start || pos >= iv.end) continue;
        const key = horizontal ? pointKey(pos, iv.line) : pointKey(iv.line, pos);
        const ownEnds = horizontal ? hEnds : vEnds;
        const otherEnds = horizontal ? vEnds : hEnds;
        const perpendicular = horizontal ? vByX.get(pos) : hByY.get(pos);
        const crossed = perpendicular ? covers(perpendicular, pos, iv.line) : false;
        if (pinSet.has(key) || otherEnds.has(key) || (ownEnds.has(key) && crossed)) splits.push(pos);
      }
      splits.sort((a, b) => a - b);
      const points = [iv.start, ...splits, iv.end];
      for (let i = 0; i + 1 < points.length; i++) {
        result.push({ line: iv.line, start: points[i], end: points[i + 1], horizontal, order: Infinity });
      }
    }
  };
  emit(true, hIntervals);
  emit(false, vIntervals);

  // Reuse ids: exact matches first, then any overlapping original on the same line.
  const exact = new Map<string, Seg>();
  for (const s of segs) {
    const k = `${s.horizontal ? 'h' : 'v'}${s.line}:${s.start}:${s.end}`;
    if (!exact.has(k)) exact.set(k, s);
  }
  const used = new Set<string>();
  for (const r of result) {
    const e = exact.get(`${r.horizontal ? 'h' : 'v'}${r.line}:${r.start}:${r.end}`);
    if (e?.id && !used.has(e.id)) {
      r.id = e.id;
      r.order = e.order;
      used.add(e.id);
    }
  }
  for (const r of result) {
    if (r.id) continue;
    const donor = segs.find((s) => s.horizontal === r.horizontal && s.line === r.line && s.start < r.end && s.end > r.start && s.id && !used.has(s.id));
    if (donor?.id) {
      r.id = donor.id;
      r.order = donor.order;
      used.add(donor.id);
    }
  }
  result.sort((a, b) => a.order - b.order);

  const out: Wire[] = result.map((r) => {
    const id = r.id ?? newId();
    return r.horizontal
      ? { id, x1: r.start, y1: r.line, x2: r.end, y2: r.line }
      : { id, x1: r.line, y1: r.start, x2: r.line, y2: r.end };
  });

  // Preserve identity when nothing changed.
  if (out.length === wires.length) {
    const same = out.every((w, i) => {
      const o = wires[i];
      return o.id === w.id && o.x1 === w.x1 && o.y1 === w.y1 && o.x2 === w.x2 && o.y2 === w.y2;
    });
    if (same) return wires;
  }
  return out;
}
