import type { Point, Rotation } from './types.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Rotate a local offset clockwise (screen coordinates, y down). */
export function rotatePoint(x: number, y: number, r: Rotation): Point {
  switch (r) {
    case 0:
      return { x, y };
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
  }
}

/** Inverse of rotatePoint. */
export function unrotatePoint(x: number, y: number, r: Rotation): Point {
  return rotatePoint(x, y, ((360 - r) % 360) as Rotation);
}

export function rotateRect(rect: Rect, r: Rotation): Rect {
  const p1 = rotatePoint(rect.x, rect.y, r);
  const p2 = rotatePoint(rect.x + rect.w, rect.y + rect.h, r);
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  return { x, y, w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
}

export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h };
}

export function rectContains(rect: Rect, x: number, y: number, margin = 0): boolean {
  return x >= rect.x - margin && x <= rect.x + rect.w + margin && y >= rect.y - margin && y <= rect.y + rect.h + margin;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** Rect `inner` lies entirely within `outer`. */
export function rectInside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectFromPoints(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** Distance from point to an axis-aligned segment. */
export function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** True when (x, y) lies strictly inside the segment (not at an endpoint). Segments are axis-aligned. */
export function onSegmentInterior(x: number, y: number, x1: number, y1: number, x2: number, y2: number): boolean {
  if (y1 === y2) return y === y1 && x > Math.min(x1, x2) && x < Math.max(x1, x2);
  if (x1 === x2) return x === x1 && y > Math.min(y1, y2) && y < Math.max(y1, y2);
  return false;
}

export function nextRotation(r: Rotation, clockwise = true): Rotation {
  return (((r + (clockwise ? 90 : 270)) % 360) as Rotation);
}
