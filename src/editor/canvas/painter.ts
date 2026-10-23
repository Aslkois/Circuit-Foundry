import { rotatePoint, type Rotation } from '../../model/index.ts';
import { FONT_MONO, FONT_UI } from './theme.ts';
import type { Viewport } from './viewport.ts';

export interface TextOptions {
  size?: number;
  color?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  mono?: boolean;
  bold?: boolean;
}

/**
 * Drawing helper. Shapes are drawn in world units (one unit = one grid cell)
 * through the canvas transform; text is drawn in screen space so it stays
 * crisp and upright at any zoom and rotation.
 */
export class Painter {
  readonly ctx: CanvasRenderingContext2D;
  readonly vp: Viewport;
  readonly dpr: number;

  constructor(ctx: CanvasRenderingContext2D, vp: Viewport, dpr: number) {
    this.ctx = ctx;
    this.vp = vp;
    this.dpr = dpr;
  }

  /** One CSS pixel in world units. */
  get px(): number {
    return 1 / this.vp.unit;
  }

  /** Set the transform so drawing coordinates are world units. */
  world(): void {
    const u = this.vp.unit * this.dpr;
    this.ctx.setTransform(u, 0, 0, u, (this.vp.width / 2 - this.vp.cx * this.vp.unit) * this.dpr, (this.vp.height / 2 - this.vp.cy * this.vp.unit) * this.dpr);
  }

  /** Enter a component's local frame (call world() first; restore with ctx.restore()). */
  local(x: number, y: number, rotation: Rotation): void {
    this.ctx.save();
    this.ctx.translate(x, y);
    if (rotation) this.ctx.rotate((rotation * Math.PI) / 180);
  }

  /** Draw text at a world position. Returns false when too small to be legible. */
  text(str: string, wx: number, wy: number, o: TextOptions = {}): boolean {
    const sizePx = (o.size ?? 0.8) * this.vp.unit;
    if (sizePx < 5 || str === '') return false;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `${o.bold ? '600 ' : ''}${sizePx.toFixed(1)}px ${o.mono ? FONT_MONO : FONT_UI}`;
    ctx.fillStyle = o.color ?? '#d0d7de';
    ctx.textAlign = o.align ?? 'center';
    ctx.textBaseline = o.baseline ?? 'middle';
    ctx.fillText(str, this.vp.toScreenX(wx), this.vp.toScreenY(wy));
    ctx.restore();
    return true;
  }

  /** Text at a component-local position, kept upright. */
  localText(str: string, cx: number, cy: number, rotation: Rotation, lx: number, ly: number, o: TextOptions = {}): void {
    const p = rotatePoint(lx, ly, rotation);
    let align = o.align ?? 'center';
    // Keep side labels on the correct side of their pin after rotation.
    if (align !== 'center' && (rotation === 180 || rotation === 90)) align = align === 'left' ? 'right' : 'left';
    if (rotation === 90 || rotation === 270) align = 'center';
    this.text(str, cx + p.x, cy + p.y, { ...o, align });
  }

  measure(str: string, size: number, mono = false): number {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${size * this.vp.unit}px ${mono ? FONT_MONO : FONT_UI}`;
    const w = ctx.measureText(str).width / this.vp.unit;
    ctx.restore();
    return w;
  }
}
