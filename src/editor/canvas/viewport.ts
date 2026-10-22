import type { Rect } from '../../model/index.ts';
import { UNIT_PX } from './theme.ts';

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 6;

export interface ViewState {
  /** World coordinate (grid units) shown at the canvas centre. */
  readonly cx: number;
  readonly cy: number;
  readonly zoom: number;
}

/** Maps between world (grid units) and screen (CSS pixels relative to the canvas). */
export class Viewport {
  cx = 0;
  cy = 0;
  zoom = 1;
  width = 1;
  height = 1;

  get unit(): number {
    return UNIT_PX * this.zoom;
  }

  get state(): ViewState {
    return { cx: this.cx, cy: this.cy, zoom: this.zoom };
  }

  set state(s: ViewState) {
    this.cx = s.cx;
    this.cy = s.cy;
    this.zoom = s.zoom;
  }

  toScreenX(wx: number): number {
    return (wx - this.cx) * this.unit + this.width / 2;
  }

  toScreenY(wy: number): number {
    return (wy - this.cy) * this.unit + this.height / 2;
  }

  toWorldX(sx: number): number {
    return (sx - this.width / 2) / this.unit + this.cx;
  }

  toWorldY(sy: number): number {
    return (sy - this.height / 2) / this.unit + this.cy;
  }

  /** Visible world rectangle. */
  visible(): Rect {
    const x = this.toWorldX(0);
    const y = this.toWorldY(0);
    return { x, y, w: this.width / this.unit, h: this.height / this.unit };
  }

  panBy(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.unit;
    this.cy -= dyPx / this.unit;
  }

  /** Zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const wx = this.toWorldX(sx);
    const wy = this.toWorldY(sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.cx = wx - (sx - this.width / 2) / this.unit;
    this.cy = wy - (sy - this.height / 2) / this.unit;
  }

  /** Fit a world rectangle with a margin (in grid units). */
  fit(rect: Rect, margin = 4, maxZoom = 2.5): void {
    const w = rect.w + 2 * margin;
    const h = rect.h + 2 * margin;
    const zoom = Math.min(this.width / (w * UNIT_PX), this.height / (h * UNIT_PX));
    this.zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, zoom));
    this.cx = rect.x + rect.w / 2;
    this.cy = rect.y + rect.h / 2;
  }
}
