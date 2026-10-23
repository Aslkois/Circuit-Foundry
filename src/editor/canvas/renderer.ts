import type { LogicValue } from '../../engine/logic.ts';
import {
  pinKey,
  pointKey,
  rectsIntersect,
  strOf,
  type Circuit,
  type Connectivity,
  type LayoutContext,
  type Point,
  type Rect,
  type ResolvedComponent,
} from '../../model/index.ts';
import type { Selection } from '../state/store.ts';
import type { Hit } from './hitTest.ts';
import { Painter } from './painter.ts';
import { drawComponent, drawSubcircuitTitle, type SignalSource } from './symbols.ts';
import { COLORS, signalColor } from './theme.ts';
import type { Viewport } from './viewport.ts';

/** Live values for the circuit on screen, addressed by local net id. */
export interface ValueSource {
  net(localNet: number): LogicValue | null;
  contended(localNet: number): boolean;
  source(componentId: string): LogicValue | null;
  state(componentId: string): unknown;
}

export interface Scene {
  readonly circuit: Circuit;
  readonly conn: Connectivity;
  readonly layout: LayoutContext;
  readonly selection: Selection;
  readonly values: ValueSource | null;
  readonly hover: Hit;
  readonly ghost: ResolvedComponent | null;
  readonly wirePreview: readonly { x1: number; y1: number; x2: number; y2: number }[] | null;
  readonly marquee: Rect | null;
  readonly problems: ReadonlyMap<string, 'error' | 'warning'>;
  readonly problemWires: ReadonlySet<string>;
  /** Components highlighted because they keep oscillating. */
  readonly oscillating: ReadonlySet<string>;
}

const BIT_WIRE_PX = 2;
const BUS_WIRE_PX = 3.5;
/** Below this many pixels per grid unit, components are drawn as plain outlines. */
const LOD_UNIT_PX = 6;

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly vp: Viewport;

  constructor(canvas: HTMLCanvasElement, vp: Viewport) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.vp = vp;
  }

  /** Match the backing store to the element size. Returns true if it changed. */
  resize(width: number, height: number, dpr: number): boolean {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    this.vp.width = width;
    this.vp.height = height;
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  render(scene: Scene, dpr: number): void {
    const ctx = this.ctx;
    const p = new Painter(ctx, this.vp, dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const visible = this.vp.visible();
    const margin = 3;
    const view: Rect = { x: visible.x - margin, y: visible.y - margin, w: visible.w + 2 * margin, h: visible.h + 2 * margin };

    this.drawGrid(p, visible, dpr);
    p.world();

    const { conn, values } = scene;
    const netColor = (net: number | undefined): string => {
      if (net === undefined) return COLORS.noNet;
      const info = conn.nets[net];
      if (info.widthConflict) return COLORS.widthError;
      if (!values) return info.pins.length === 0 ? COLORS.noNet : COLORS.bodyStrokeDim;
      if (info.pins.length === 0) return COLORS.noNet;
      return signalColor(values.net(net), values.contended(net));
    };
    const netIsBus = (net: number | undefined): boolean => {
      if (net === undefined) return false;
      const info = conn.nets[net];
      if (info.width !== null) return info.width > 1;
      const v = values?.net(net);
      return !!v && v.width > 1;
    };

    // Hover and selection underlays for wires.
    const hoverNet = this.hoverNet(scene);
    const underlay = (color: string, px: number, filter: (wireId: string, net: number | undefined) => boolean) => {
      ctx.beginPath();
      let any = false;
      for (const w of scene.circuit.wires) {
        const net = conn.wireNet.get(w.id);
        if (!filter(w.id, net)) continue;
        ctx.moveTo(w.x1, w.y1);
        ctx.lineTo(w.x2, w.y2);
        any = true;
      }
      if (!any) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = px * p.px;
      ctx.lineCap = 'round';
      ctx.stroke();
    };
    if (hoverNet !== null) underlay(COLORS.hover, 8, (_, net) => net === hoverNet);
    if (scene.selection.wires.size > 0) underlay(COLORS.selection, 7, (id) => scene.selection.wires.has(id));
    if (scene.problemWires.size > 0) underlay('rgba(248, 81, 73, 0.45)', 8, (id) => scene.problemWires.has(id));

    // Wires, batched by colour and thickness.
    const batches = new Map<string, { x1: number; y1: number; x2: number; y2: number }[]>();
    for (const w of scene.circuit.wires) {
      const seg = { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 };
      if (!rectsIntersect({ x: Math.min(w.x1, w.x2), y: Math.min(w.y1, w.y2), w: Math.abs(w.x2 - w.x1), h: Math.abs(w.y2 - w.y1) }, view)) continue;
      const net = conn.wireNet.get(w.id);
      const key = `${netColor(net)}|${netIsBus(net) ? BUS_WIRE_PX : BIT_WIRE_PX}`;
      let list = batches.get(key);
      if (!list) batches.set(key, (list = []));
      list.push(seg);
    }
    ctx.lineCap = 'round';
    for (const [key, segs] of batches) {
      const [color, px] = key.split('|');
      ctx.beginPath();
      for (const s of segs) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, Number(px)) * p.px;
      ctx.stroke();
    }

    // Junction dots.
    const pointNet = new Map<number, number>();
    for (const w of scene.circuit.wires) {
      const net = conn.wireNet.get(w.id);
      if (net === undefined) continue;
      pointNet.set(pointKey(w.x1, w.y1), net);
      pointNet.set(pointKey(w.x2, w.y2), net);
    }
    for (const j of conn.junctions) {
      if (j.x < view.x || j.y < view.y || j.x > view.x + view.w || j.y > view.y + view.h) continue;
      const net = pointNet.get(pointKey(j.x, j.y)) ?? this.netAtPin(conn, j);
      ctx.beginPath();
      ctx.arc(j.x, j.y, Math.max(0.2, 3 * p.px) * (netIsBus(net) ? 1.25 : 1), 0, Math.PI * 2);
      ctx.fillStyle = netColor(net);
      ctx.fill();
    }

    // Components. Far out, symbols are only a few pixels across: draw batched outlines instead.
    if (this.vp.unit < LOD_UNIT_PX) {
      this.drawComponentsSimplified(p, scene, view);
    } else for (const c of scene.circuit.components) {
      const rc = conn.components.get(c.id);
      if (!rc || !rectsIntersect(rc.bounds, view)) continue;
      const selected = scene.selection.components.has(c.id);
      const problem = scene.oscillating.has(c.id) ? 'error' : (scene.problems.get(c.id) ?? null);
      const signals = values ? this.signalsFor(conn, values, c.id) : null;
      drawComponent(p, rc, { signals, selected, ghost: false, problem });
      if (c.type === 'subcircuit') {
        const name = scene.layout.getInterface(strOf(c.props, 'circuit'))?.name ?? 'missing circuit';
        drawSubcircuitTitle(p, rc, name, { signals, selected, ghost: false });
      }
    }

    // Open (unconnected) pins.
    ctx.lineWidth = 1.2 * p.px;
    if (this.vp.unit >= LOD_UNIT_PX) for (const net of conn.nets) {
      if (net.pins.length !== 1 || net.wireIds.length > 0) continue;
      const pin = net.pins[0];
      if (pin.x < view.x || pin.y < view.y || pin.x > view.x + view.w || pin.y > view.y + view.h) continue;
      ctx.beginPath();
      ctx.arc(pin.x, pin.y, Math.max(0.12, 2.5 * p.px), 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.bodyStrokeDim;
      ctx.stroke();
    }

    // Selection frames.
    ctx.setLineDash([4 * p.px, 3 * p.px]);
    ctx.lineWidth = 1 * p.px;
    ctx.strokeStyle = COLORS.selection;
    for (const id of scene.selection.components) {
      const rc = conn.components.get(id);
      if (!rc) continue;
      const b = rc.bounds;
      ctx.strokeRect(b.x - 0.35, b.y - 0.35, b.w + 0.7, b.h + 0.7);
    }
    ctx.setLineDash([]);

    // Hover feedback.
    this.drawHover(p, scene);

    // Placement ghost.
    if (scene.ghost) drawComponent(p, scene.ghost, { signals: null, selected: false, ghost: true });

    // Wire being drawn.
    if (scene.wirePreview && scene.wirePreview.length > 0) {
      ctx.beginPath();
      for (const s of scene.wirePreview) {
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
      }
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2.5 * p.px;
      ctx.lineCap = 'round';
      ctx.stroke();
      const last = scene.wirePreview[scene.wirePreview.length - 1];
      ctx.beginPath();
      ctx.arc(last.x2, last.y2, Math.max(0.15, 3 * p.px), 0, Math.PI * 2);
      ctx.fillStyle = COLORS.selection;
      ctx.fill();
    }

    // Marquee.
    if (scene.marquee) {
      const m = scene.marquee;
      ctx.fillStyle = COLORS.selectionFill;
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 1 * p.px;
      ctx.strokeRect(m.x, m.y, m.w, m.h);
    }
  }

  private drawComponentsSimplified(p: Painter, scene: Scene, view: Rect): void {
    const ctx = p.ctx;
    const groups = new Map<string, Rect[]>();
    const add = (color: string, r: Rect) => {
      let list = groups.get(color);
      if (!list) groups.set(color, (list = []));
      list.push(r);
    };
    for (const c of scene.circuit.components) {
      const rc = scene.conn.components.get(c.id);
      if (!rc || !rectsIntersect(rc.bounds, view)) continue;
      let color: string = COLORS.bodyStroke;
      if (scene.selection.components.has(c.id)) color = COLORS.selection;
      else if (scene.oscillating.has(c.id) || scene.problems.get(c.id) === 'error') color = COLORS.error;
      else if (scene.problems.get(c.id) === 'warning') color = COLORS.warning;
      else if ((c.type === 'input' || c.type === 'output' || c.type === 'led') && scene.values) {
        const pin = rc.pins[0];
        const net = pin ? scene.conn.pinNet.get(pinKey(c.id, pin.name)) : undefined;
        if (net !== undefined) color = signalColor(scene.values.net(net), scene.values.contended(net));
      }
      add(color, rc.bounds);
    }
    ctx.lineWidth = 1 * p.px;
    for (const [color, rects] of groups) {
      ctx.beginPath();
      for (const r of rects) ctx.rect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = COLORS.body;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  private drawGrid(p: Painter, visible: Rect, dpr: number): void {
    const unit = this.vp.unit;
    if (unit < 4) return;
    const ctx = p.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const step = unit < 8 ? 5 : 1;
    const x0 = Math.floor(visible.x / step) * step;
    const y0 = Math.floor(visible.y / step) * step;
    const size = unit >= 12 ? 1.5 : 1;
    for (let gx = x0; gx <= visible.x + visible.w; gx += step) {
      const sx = Math.round(this.vp.toScreenX(gx));
      for (let gy = y0; gy <= visible.y + visible.h; gy += step) {
        const major = gx % 10 === 0 && gy % 10 === 0;
        ctx.fillStyle = major ? COLORS.gridDotMajor : COLORS.gridDot;
        const sy = Math.round(this.vp.toScreenY(gy));
        const s = major ? size + 1 : size;
        ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      }
    }
  }

  private hoverNet(scene: Scene): number | null {
    const h = scene.hover;
    if (h.kind === 'wire') return scene.conn.wireNet.get(h.wireId) ?? null;
    if (h.kind === 'pin') return scene.conn.pinNet.get(pinKey(h.componentId, h.pin)) ?? null;
    return null;
  }

  private drawHover(p: Painter, scene: Scene): void {
    const ctx = p.ctx;
    const h = scene.hover;
    if (h.kind === 'pin' || (h.kind === 'wire' && h.endpoint)) {
      const pt = h.kind === 'pin' ? h.point : h.endpoint!;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(0.35, 6 * p.px), 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 1.5 * p.px;
      ctx.stroke();
    } else if (h.kind === 'component' && !scene.selection.components.has(h.componentId)) {
      const rc = scene.conn.components.get(h.componentId);
      if (!rc) return;
      const b = rc.bounds;
      ctx.strokeStyle = 'rgba(127, 182, 255, 0.35)';
      ctx.lineWidth = 1 * p.px;
      ctx.strokeRect(b.x - 0.3, b.y - 0.3, b.w + 0.6, b.h + 0.6);
    }
  }

  private netAtPin(conn: Connectivity, pt: Point): number | undefined {
    for (const net of conn.nets) for (const pin of net.pins) if (pin.x === pt.x && pin.y === pt.y) return net.id;
    return undefined;
  }

  private signalsFor(conn: Connectivity, values: ValueSource, componentId: string): SignalSource {
    return {
      pin: (name) => {
        const n = conn.pinNet.get(pinKey(componentId, name));
        return n === undefined ? null : values.net(n);
      },
      contended: (name) => {
        const n = conn.pinNet.get(pinKey(componentId, name));
        return n !== undefined && values.contended(n);
      },
      source: () => values.source(componentId),
      state: () => values.state(componentId),
    };
  }
}
