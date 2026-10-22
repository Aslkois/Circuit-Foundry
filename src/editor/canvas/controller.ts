import type { LogicValue } from '../../engine/logic.ts';
import {
  addComponents,
  addWires,
  analyzeConnectivity,
  createComponent,
  deleteItems,
  getDef,
  moveItems,
  nextRotation,
  pasteItems,
  pinKey,
  rectFromPoints,
  resolveComponent,
  rotateComponents,
  strOf,
  unionRect,
  wouldCreateCycle,
  type Circuit,
  type ComponentInstance,
  type Connectivity,
  type Point,
  type Rect,
  type Segment,
} from '../../model/index.ts';
import type { SimulationHost } from '../sim/SimulationHost.ts';
import { EMPTY_SELECTION, selectionSize, type EditorStore, type Selection } from '../state/store.ts';
import { NO_HIT, hitTest, itemsInRect, type Hit } from './hitTest.ts';
import { Renderer, type Scene, type ValueSource } from './renderer.ts';
import { Viewport, type ViewState } from './viewport.ts';

type Gesture =
  | { kind: 'idle' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'press'; sx: number; sy: number; world: Point; hit: Hit; shift: boolean }
  | { kind: 'move'; origin: Point; dx: number; dy: number; components: Set<string>; wires: Set<string>; preview: Circuit | null }
  | { kind: 'marquee'; origin: Point; current: Point; additive: boolean; base: Selection }
  | { kind: 'wire'; start: Point; current: Point; horizontalFirst: boolean | null; clickMode: boolean }
  | { kind: 'button'; componentId: string };

const DRAG_THRESHOLD_PX = 4;

/** Orthogonal L-shaped route between two grid points. */
export function routeSegments(a: Point, b: Point, horizontalFirst: boolean): Segment[] {
  const corner = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  const out: Segment[] = [];
  if (corner.x !== a.x || corner.y !== a.y) out.push({ x1: a.x, y1: a.y, x2: corner.x, y2: corner.y });
  if (corner.x !== b.x || corner.y !== b.y) out.push({ x1: corner.x, y1: corner.y, x2: b.x, y2: b.y });
  return out;
}

/**
 * Connects the canvas element, the editor store and the simulation host:
 * pointer and keyboard gestures become store edits or simulation stimulus,
 * and the scene is redrawn on animation frames only when something changed.
 */
export class CanvasController {
  readonly vp = new Viewport();
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly store: EditorStore;
  private readonly host: SimulationHost;
  private gesture: Gesture = { kind: 'idle' };
  private hover: Hit = NO_HIT;
  private pointer: Point | null = null;
  private spaceHeld = false;
  private dirty = true;
  private raf = 0;
  private lastValueVersion = -1;
  private lastRevision = -1;
  private lastCircuit: Circuit | null = null;
  private readonly views = new Map<string, ViewState>();
  private viewKey = '';
  private unsubscribe: (() => void)[] = [];
  private resizeObserver: ResizeObserver;
  private dpr = 1;
  /** Called when the pointer moves (world coordinates) for the status bar. */
  onPointer: ((p: Point | null) => void) | null = null;
  /** Called when the zoom changes. */
  onZoom: ((zoom: number) => void) | null = null;
  /** Hover changes, for tooltips: the hovered net's value and the screen position. */
  onHoverInfo: ((info: HoverInfo | null) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, store: EditorStore, host: SimulationHost) {
    this.canvas = canvas;
    this.store = store;
    this.host = host;
    this.renderer = new Renderer(canvas, this.vp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.syncView();
    this.unsubscribe.push(
      store.subscribe(() => {
        this.syncView();
        this.invalidate();
      }),
    );
    this.unsubscribe.push(host.subscribe(() => this.invalidate()));
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    for (const u of this.unsubscribe) u();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerCancel);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('dblclick', this.onDoubleClick);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('contextmenu', this.onContextMenu);
  }

  invalidate = (): void => {
    this.dirty = true;
  };

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.renderer.resize(r.width, r.height, this.dpr);
    this.dirty = true;
  }

  /* -------------------------------------------------------------------- */
  /* Scene                                                                */
  /* -------------------------------------------------------------------- */

  private get circuit(): Circuit {
    return this.store.viewedCircuit;
  }

  private connOf(circuit: Circuit): Connectivity {
    return analyzeConnectivity(circuit, this.store.ctx);
  }

  /**
   * Each circuit view (project, root and instance path) keeps its own pan and
   * zoom. Runs synchronously on every store change so the viewport is never
   * stale relative to the circuit on screen.
   */
  private syncView(): void {
    const state = this.store.getState();
    const key = `${state.project.id}|${state.rootCircuitId}|${state.path.join('/')}`;
    if (key === this.viewKey) return;
    if (this.viewKey) this.views.set(this.viewKey, this.vp.state);
    this.viewKey = key;
    const saved = this.views.get(key);
    if (saved) this.vp.state = saved;
    else this.fitToContent(this.circuit);
    this.onZoom?.(this.vp.zoom);
    this.hover = NO_HIT;
    this.gesture = { kind: 'idle' };
    this.dirty = true;
  }

  private frame = (): void => {
    this.raf = requestAnimationFrame(this.frame);
    const state = this.store.getState();
    const circuit = this.circuit;
    const vv = this.host.valueVersion;
    if (vv !== this.lastValueVersion || state.revision !== this.lastRevision || circuit !== this.lastCircuit) {
      this.lastValueVersion = vv;
      this.lastRevision = state.revision;
      this.lastCircuit = circuit;
      this.dirty = true;
      this.emitHoverInfo();
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.buildScene(), this.dpr);
  };

  private valuesFor(circuit: Circuit, conn: Connectivity): ValueSource | null {
    const state = this.store.getState();
    const node = this.host.nodeAt(state.path);
    if (!node) return null;
    const host = this.host;
    if (node.circuit === circuit) {
      return {
        net: (n) => host.netValue(node, n),
        contended: (n) => host.netContended(node, n),
        source: (id) => host.getSource(state.path, id),
        state: (id) => host.componentState(node, id),
      };
    }
    // A preview (e.g. while dragging): map preview nets to compiled nets through shared pins and wires.
    const map = new Map<number, number>();
    for (const net of conn.nets) {
      for (const pin of net.pins) {
        const orig = node.connectivity.pinNet.get(pinKey(pin.componentId, pin.pin));
        if (orig !== undefined) {
          map.set(net.id, orig);
          break;
        }
      }
      if (!map.has(net.id)) {
        for (const w of net.wireIds) {
          const orig = node.connectivity.wireNet.get(w);
          if (orig !== undefined) {
            map.set(net.id, orig);
            break;
          }
        }
      }
    }
    return {
      net: (n) => {
        const o = map.get(n);
        return o === undefined ? null : host.netValue(node, o);
      },
      contended: (n) => {
        const o = map.get(n);
        return o !== undefined && host.netContended(node, o);
      },
      source: (id) => host.getSource(state.path, id),
      state: (id) => host.componentState(node, id),
    };
  }

  private buildScene(): Scene {
    const state = this.store.getState();
    const g = this.gesture;
    const circuit = g.kind === 'move' && g.preview ? g.preview : this.circuit;
    const conn = this.connOf(circuit);
    let selection = state.selection;
    if (g.kind === 'marquee') selection = this.marqueeSelection(g);

    let ghost = null;
    const tool = state.tool;
    if (tool.kind === 'place' && this.pointer && g.kind === 'idle') {
      const comp: ComponentInstance = {
        id: '__ghost',
        type: tool.type,
        x: Math.round(this.pointer.x),
        y: Math.round(this.pointer.y),
        rotation: tool.rotation,
        props: tool.props,
      };
      ghost = resolveComponent(comp, this.store.ctx);
    }

    let wirePreview: Segment[] | null = null;
    if (g.kind === 'wire') wirePreview = routeSegments(g.start, g.current, g.horizontalFirst ?? true);

    const problems = new Map<string, 'error' | 'warning'>();
    const problemWires = new Set<string>();
    const oscillating = new Set<string>();
    for (const d of this.host.diagnostics) {
      if (d.circuitId !== circuit.id || d.severity === 'info') continue;
      for (const id of d.componentIds ?? []) {
        if (d.code === 'oscillation') oscillating.add(id);
        else if (problems.get(id) !== 'error') problems.set(id, d.severity === 'error' ? 'error' : 'warning');
      }
      if (d.severity === 'error') for (const id of d.wireIds ?? []) problemWires.add(id);
    }

    return {
      circuit,
      conn,
      layout: this.store.ctx,
      selection,
      values: this.valuesFor(circuit, conn),
      hover: g.kind === 'idle' ? this.hover : NO_HIT,
      ghost,
      wirePreview,
      marquee: g.kind === 'marquee' ? rectFromPoints(g.origin.x, g.origin.y, g.current.x, g.current.y) : null,
      problems,
      problemWires,
      oscillating,
    };
  }

  /* -------------------------------------------------------------------- */
  /* View                                                                 */
  /* -------------------------------------------------------------------- */

  fitToContent(circuit: Circuit = this.circuit): void {
    const conn = this.connOf(circuit);
    let r: Rect | null = null;
    for (const rc of conn.components.values()) r = unionRect(r, rc.bounds);
    for (const w of circuit.wires) r = unionRect(r, rectFromPoints(w.x1, w.y1, w.x2, w.y2));
    if (r) this.vp.fit(r, 4, 2.2);
    else this.vp.state = { cx: 10, cy: 6, zoom: 1.25 };
    this.onZoom?.(this.vp.zoom);
    this.dirty = true;
  }

  zoomBy(factor: number): void {
    this.vp.zoomAt(this.vp.width / 2, this.vp.height / 2, factor);
    this.onZoom?.(this.vp.zoom);
    this.dirty = true;
  }

  setZoom(zoom: number): void {
    this.zoomBy(zoom / this.vp.zoom);
  }

  private screenPoint(e: PointerEvent | MouseEvent | WheelEvent): { sx: number; sy: number } {
    const r = this.canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  private worldPoint(sx: number, sy: number): Point {
    return { x: this.vp.toWorldX(sx), y: this.vp.toWorldY(sy) };
  }

  private snap(p: Point): Point {
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  private tolerance(): number {
    return Math.max(0.45, 7 / this.vp.unit);
  }

  private hitAt(world: Point): Hit {
    const circuit = this.circuit;
    const path = this.store.getState().path;
    return hitTest(circuit, this.connOf(circuit), world.x, world.y, {
      tolerance: this.tolerance(),
      interactive: (id) => this.host.sourceKey(path, id) !== null,
    });
  }

  /* -------------------------------------------------------------------- */
  /* Pointer                                                              */
  /* -------------------------------------------------------------------- */

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.focus({ preventScroll: true });
    const { sx, sy } = this.screenPoint(e);
    const world = this.worldPoint(sx, sy);
    const state = this.store.getState();

    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      e.preventDefault();
      this.gesture = { kind: 'pan', lastX: sx, lastY: sy };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button === 2) {
      // Right click ends an in-progress wire; otherwise it pans.
      if (this.gesture.kind === 'wire') {
        this.finishWire(false);
        return;
      }
      this.gesture = { kind: 'pan', lastX: sx, lastY: sy };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    const g = this.gesture;
    if (g.kind === 'wire' && g.clickMode) {
      // Click-to-route mode: each click fixes the route so far and continues from there.
      const end = this.snap(world);
      if (end.x === g.start.x && end.y === g.start.y) {
        this.finishWire(false);
        return;
      }
      this.commitWire(g.start, end, g.horizontalFirst ?? true);
      const hit = this.hitAt(end);
      if (hit.kind === 'pin' || (hit.kind === 'wire' && hit.endpoint === null) || e.detail >= 2) {
        this.gesture = { kind: 'idle' };
      } else {
        this.gesture = { kind: 'wire', start: end, current: end, horizontalFirst: null, clickMode: true };
      }
      this.dirty = true;
      return;
    }

    this.canvas.setPointerCapture(e.pointerId);
    if (state.tool.kind === 'place') {
      this.placeAt(this.snap(world), e.shiftKey);
      return;
    }
    if (state.tool.kind === 'wire') {
      const start = this.snapToConnection(world);
      this.gesture = { kind: 'wire', start, current: start, horizontalFirst: null, clickMode: false };
      this.dirty = true;
      return;
    }
    const hit = this.hitAt(world);
    if (hit.kind === 'button' && !e.shiftKey) {
      this.host.setButton(state.path, hit.componentId, true);
      this.gesture = { kind: 'button', componentId: hit.componentId };
      return;
    }
    this.gesture = { kind: 'press', sx, sy, world, hit, shift: e.shiftKey };
  };

  private onPointerMove = (e: PointerEvent): void => {
    const { sx, sy } = this.screenPoint(e);
    const world = this.worldPoint(sx, sy);
    this.pointer = world;
    this.onPointer?.(world);
    const g = this.gesture;
    switch (g.kind) {
      case 'pan':
        this.vp.panBy(sx - g.lastX, sy - g.lastY);
        g.lastX = sx;
        g.lastY = sy;
        this.dirty = true;
        return;
      case 'press':
        if (Math.hypot(sx - g.sx, sy - g.sy) >= DRAG_THRESHOLD_PX) this.beginDrag(g, world);
        return;
      case 'move': {
        const dx = Math.round(world.x - g.origin.x);
        const dy = Math.round(world.y - g.origin.y);
        if (dx !== g.dx || dy !== g.dy) {
          g.dx = dx;
          g.dy = dy;
          g.preview = dx === 0 && dy === 0 ? null : moveItems(this.circuit, g.components, g.wires, dx, dy, this.store.ctx);
          this.dirty = true;
        }
        return;
      }
      case 'marquee':
        g.current = world;
        this.dirty = true;
        return;
      case 'wire': {
        const p = this.snapToConnection(world);
        if (p.x !== g.current.x || p.y !== g.current.y) {
          if (g.horizontalFirst === null) {
            const dx = Math.abs(world.x - g.start.x);
            const dy = Math.abs(world.y - g.start.y);
            if (dx > 0.5 || dy > 0.5) g.horizontalFirst = dx >= dy;
          }
          g.current = p;
          this.dirty = true;
        }
        return;
      }
      case 'button':
        return;
      case 'idle': {
        const hit = this.hitAt(world);
        if (!sameHit(hit, this.hover)) {
          this.hover = hit;
          this.updateCursor();
          this.emitHoverInfo(sx, sy);
        }
        if (this.store.getState().tool.kind === 'place') this.dirty = true;
        return;
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const g = this.gesture;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const state = this.store.getState();
    switch (g.kind) {
      case 'pan':
        this.gesture = { kind: 'idle' };
        this.updateCursor();
        return;
      case 'button':
        this.host.setButton(state.path, g.componentId, false);
        this.gesture = { kind: 'idle' };
        return;
      case 'press':
        this.gesture = { kind: 'idle' };
        this.click(g.hit, g.shift);
        return;
      case 'move':
        this.gesture = { kind: 'idle' };
        if (g.dx !== 0 || g.dy !== 0) {
          const { components, wires, dx, dy } = g;
          this.store.editViewed(
            (c, ctx) => moveItems(c, components, wires, dx, dy, ctx),
            (next) => keepSelection(next, components, wires),
          );
        }
        this.dirty = true;
        return;
      case 'marquee':
        this.gesture = { kind: 'idle' };
        this.store.setSelection(this.marqueeSelection(g));
        this.dirty = true;
        return;
      case 'wire':
        if (g.clickMode) return;
        if (g.current.x === g.start.x && g.current.y === g.start.y) {
          // A click without dragging: continue in click-to-route mode.
          this.gesture = { ...g, clickMode: true };
          return;
        }
        this.commitWire(g.start, g.current, g.horizontalFirst ?? true);
        this.gesture = { kind: 'idle' };
        this.dirty = true;
        return;
      case 'idle':
        return;
    }
  };

  private onPointerCancel = (): void => {
    const g = this.gesture;
    if (g.kind === 'button') this.host.setButton(this.store.getState().path, g.componentId, false);
    this.gesture = { kind: 'idle' };
    this.dirty = true;
  };

  private onPointerLeave = (): void => {
    if (this.gesture.kind === 'idle') {
      this.pointer = null;
      this.hover = NO_HIT;
      this.onPointer?.(null);
      this.onHoverInfo?.(null);
      this.dirty = true;
    }
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const { sx, sy } = this.screenPoint(e);
    const hit = this.hitAt(this.worldPoint(sx, sy));
    if (hit.kind !== 'component') return;
    const comp = this.circuit.components.find((c) => c.id === hit.componentId);
    if (comp?.type === 'subcircuit') this.store.enterInstance(comp.id);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { sx, sy } = this.screenPoint(e);
    if (e.shiftKey && !e.ctrlKey) {
      this.vp.panBy(-(e.deltaY || e.deltaX), 0);
    } else {
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015));
      this.vp.zoomAt(sx, sy, factor);
      this.onZoom?.(this.vp.zoom);
    }
    this.dirty = true;
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private beginDrag(g: Extract<Gesture, { kind: 'press' }>, world: Point): void {
    const hit = g.hit;
    const state = this.store.getState();
    if (hit.kind === 'pin' || (hit.kind === 'wire' && hit.endpoint)) {
      const start = hit.kind === 'pin' ? hit.point : hit.endpoint!;
      this.gesture = { kind: 'wire', start, current: this.snap(world), horizontalFirst: null, clickMode: false };
      this.dirty = true;
      return;
    }
    if (hit.kind === 'component' || hit.kind === 'input-cell' || hit.kind === 'wire') {
      let selection = state.selection;
      const isComp = hit.kind !== 'wire';
      const id = hit.kind === 'wire' ? hit.wireId : hit.componentId;
      const selected = isComp ? selection.components.has(id) : selection.wires.has(id);
      if (!selected) {
        selection = g.shift ? addTo(selection, isComp, id) : isComp ? { components: new Set([id]), wires: new Set() } : { components: new Set(), wires: new Set([id]) };
        this.store.setSelection(selection);
      }
      this.gesture = {
        kind: 'move',
        origin: this.snap(g.world),
        dx: 0,
        dy: 0,
        components: new Set(selection.components),
        wires: new Set(selection.wires),
        preview: null,
      };
      return;
    }
    this.gesture = { kind: 'marquee', origin: g.world, current: world, additive: g.shift, base: state.selection };
    this.dirty = true;
  }

  private click(hit: Hit, shift: boolean): void {
    const state = this.store.getState();
    switch (hit.kind) {
      case 'input-cell':
        if (!shift) this.host.toggleBit(state.path, hit.componentId, hit.bit);
        this.store.setSelection(shift ? addTo(state.selection, true, hit.componentId, true) : { components: new Set([hit.componentId]), wires: new Set() });
        break;
      case 'component':
      case 'pin':
        this.store.setSelection(shift ? addTo(state.selection, true, hit.componentId, true) : { components: new Set([hit.componentId]), wires: new Set() });
        break;
      case 'wire':
        this.store.setSelection(shift ? addTo(state.selection, false, hit.wireId, true) : { components: new Set(), wires: new Set([hit.wireId]) });
        break;
      case 'button':
        break;
      case 'none':
        if (!shift && selectionSize(state.selection) > 0) this.store.setSelection(EMPTY_SELECTION);
        break;
    }
    this.dirty = true;
  }

  private marqueeSelection(g: Extract<Gesture, { kind: 'marquee' }>): Selection {
    const rect = rectFromPoints(g.origin.x, g.origin.y, g.current.x, g.current.y);
    const circuit = this.circuit;
    const found = itemsInRect(circuit, this.connOf(circuit), rect);
    if (!g.additive) return found;
    return {
      components: new Set([...g.base.components, ...found.components]),
      wires: new Set([...g.base.wires, ...found.wires]),
    };
  }

  /** Snap to the nearest pin or wire end if close, otherwise to the grid. */
  private snapToConnection(world: Point): Point {
    const hit = this.hitAt(world);
    if (hit.kind === 'pin') return hit.point;
    if (hit.kind === 'wire') return hit.endpoint ?? hit.point;
    return this.snap(world);
  }

  private commitWire(a: Point, b: Point, horizontalFirst: boolean): void {
    const segments = routeSegments(a, b, horizontalFirst);
    if (segments.length === 0) return;
    this.store.editViewed((c, ctx) => addWires(c, segments, ctx), () => EMPTY_SELECTION);
  }

  private finishWire(commit: boolean): void {
    const g = this.gesture;
    if (g.kind === 'wire' && commit) this.commitWire(g.start, g.current, g.horizontalFirst ?? true);
    this.gesture = { kind: 'idle' };
    this.dirty = true;
  }

  private updateCursor(): void {
    const h = this.hover;
    const tool = this.store.getState().tool.kind;
    let cursor = 'default';
    if (this.spaceHeld) cursor = 'grab';
    else if (tool === 'wire' || tool === 'place') cursor = 'crosshair';
    else if (h.kind === 'pin' || (h.kind === 'wire' && h.endpoint)) cursor = 'crosshair';
    else if (h.kind === 'input-cell' || h.kind === 'button') cursor = 'pointer';
    else if (h.kind === 'component' || h.kind === 'wire') cursor = 'move';
    this.canvas.style.cursor = cursor;
  }

  private emitHoverInfo(sx?: number, sy?: number): void {
    if (!this.onHoverInfo) return;
    const h = this.hover;
    const circuit = this.circuit;
    const conn = this.connOf(circuit);
    let net: number | undefined;
    let at: Point = { x: 0, y: 0 };
    if (h.kind === 'wire') {
      net = conn.wireNet.get(h.wireId);
      at = h.point;
    } else if (h.kind === 'pin') {
      net = conn.pinNet.get(pinKey(h.componentId, h.pin));
      at = h.point;
    }
    if (net === undefined) {
      this.onHoverInfo(null);
      return;
    }
    const values = this.valuesFor(circuit, conn);
    const info = conn.nets[net];
    this.onHoverInfo({
      value: values?.net(net) ?? null,
      width: info.width,
      widthConflict: info.widthConflict,
      contended: values?.contended(net) ?? false,
      pins: info.pins.length,
      pinName: h.kind === 'pin' ? `${componentName(circuit, h.componentId)} · ${h.pin}` : null,
      sx: sx ?? this.vp.toScreenX(at.x),
      sy: sy ?? this.vp.toScreenY(at.y),
    });
  }

  /* -------------------------------------------------------------------- */
  /* Commands                                                             */
  /* -------------------------------------------------------------------- */

  /** Place the armed component (or `type`) at a grid point. */
  placeAt(at: Point, keepTool = false, type?: string, props?: Record<string, string | number | boolean>): void {
    const state = this.store.getState();
    const tool = state.tool;
    const placeType = type ?? (tool.kind === 'place' ? tool.type : null);
    if (!placeType) return;
    const placeProps = props ?? (tool.kind === 'place' ? tool.props : {});
    const rotation = tool.kind === 'place' && !type ? tool.rotation : 0;
    if (placeType === 'subcircuit') {
      const target = strOf(placeProps, 'circuit');
      if (wouldCreateCycle(state.project, this.circuit.id, target)) {
        this.store.notify('That circuit contains this one, so it cannot be placed here.', 'error');
        this.store.setTool({ kind: 'select' });
        return;
      }
    }
    let id = '';
    this.store.editViewed(
      (c, ctx) => {
        const comp = createComponent(c, placeType, at.x, at.y, rotation, placeProps);
        id = comp.id;
        return addComponents(c, [comp], ctx);
      },
      () => ({ components: new Set([id]), wires: new Set() }),
    );
    if (!keepTool) this.store.setTool({ kind: 'select' });
    this.gesture = { kind: 'idle' };
    this.dirty = true;
  }

  /** Drop from the palette at client coordinates. */
  dropAt(clientX: number, clientY: number, type: string, props: Record<string, string | number | boolean>): void {
    const r = this.canvas.getBoundingClientRect();
    const world = this.worldPoint(clientX - r.left, clientY - r.top);
    this.placeAt(this.snap(world), false, type, props);
  }

  rotate(clockwise: boolean): void {
    const state = this.store.getState();
    if (state.tool.kind === 'place') {
      this.store.setTool({ ...state.tool, rotation: nextRotation(state.tool.rotation, clockwise) });
      this.dirty = true;
      return;
    }
    const ids = state.selection.components;
    if (ids.size === 0) return;
    this.store.editViewed((c, ctx) => rotateComponents(c, ids, clockwise, ctx));
  }

  deleteSelection(): void {
    const sel = this.store.getState().selection;
    if (selectionSize(sel) === 0) return;
    this.store.editViewed((c, ctx) => deleteItems(c, sel.components, sel.wires, ctx), () => EMPTY_SELECTION);
  }

  nudge(dx: number, dy: number): void {
    const sel = this.store.getState().selection;
    if (selectionSize(sel) === 0) {
      this.vp.panBy(-dx * this.vp.unit * 2, -dy * this.vp.unit * 2);
      this.dirty = true;
      return;
    }
    this.store.editViewed(
      (c, ctx) => moveItems(c, sel.components, sel.wires, dx, dy, ctx),
      (next) => keepSelection(next, sel.components, sel.wires),
    );
  }

  selectAll(): void {
    const c = this.circuit;
    this.store.setSelection({ components: new Set(c.components.map((x) => x.id)), wires: new Set(c.wires.map((w) => w.id)) });
  }

  copy(): boolean {
    const sel = this.store.getState().selection;
    if (selectionSize(sel) === 0) return false;
    const c = this.circuit;
    this.store.clipboard = {
      components: c.components.filter((x) => sel.components.has(x.id)),
      wires: c.wires.filter((w) => sel.wires.has(w.id)),
    };
    this.store.pasteCount = 0;
    return true;
  }

  cut(): void {
    if (this.copy()) this.deleteSelection();
  }

  paste(): void {
    const clip = this.store.clipboard;
    if (!clip) return;
    const state = this.store.getState();
    const circuitId = this.circuit.id;
    for (const comp of clip.components) {
      if (comp.type === 'subcircuit' && wouldCreateCycle(state.project, circuitId, strOf(comp.props, 'circuit'))) {
        this.store.notify('The clipboard contains a circuit that contains this one; it cannot be pasted here.', 'error');
        return;
      }
    }
    this.store.pasteCount++;
    const offset = 2 * this.store.pasteCount;
    let ids: { componentIds: string[]; wireIds: string[] } = { componentIds: [], wireIds: [] };
    this.store.editViewed(
      (c, ctx) => {
        const r = pasteItems(c, clip.components, clip.wires, offset, offset, ctx);
        ids = r;
        return r.circuit;
      },
      () => ({ components: new Set(ids.componentIds), wires: new Set(ids.wireIds) }),
    );
  }

  duplicate(): void {
    if (this.copy()) this.paste();
  }

  /** Cancel the current gesture. Returns true if there was one. */
  cancel(): boolean {
    const g = this.gesture;
    if (g.kind === 'idle') return false;
    if (g.kind === 'button') this.host.setButton(this.store.getState().path, g.componentId, false);
    this.gesture = { kind: 'idle' };
    this.dirty = true;
    return true;
  }

  setSpaceHeld(held: boolean): void {
    if (this.spaceHeld === held) return;
    this.spaceHeld = held;
    this.updateCursor();
  }

  /** Client (page) coordinates of a world point; used by automation and tests. */
  clientPoint(wx: number, wy: number): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + this.vp.toScreenX(wx), y: r.top + this.vp.toScreenY(wy) };
  }

  /** Current pointer position in grid coordinates (if over the canvas). */
  get pointerGrid(): Point | null {
    return this.pointer ? this.snap(this.pointer) : null;
  }

  /** Centre the view on given components (diagnostics navigation). */
  reveal(componentIds: readonly string[], wireIds: readonly string[] = []): void {
    const circuit = this.circuit;
    const conn = this.connOf(circuit);
    let r: Rect | null = null;
    for (const id of componentIds) {
      const rc = conn.components.get(id);
      if (rc) r = unionRect(r, rc.bounds);
    }
    for (const w of circuit.wires) if (wireIds.includes(w.id)) r = unionRect(r, rectFromPoints(w.x1, w.y1, w.x2, w.y2));
    if (!r) return;
    this.vp.cx = r.x + r.w / 2;
    this.vp.cy = r.y + r.h / 2;
    this.dirty = true;
  }
}

export interface HoverInfo {
  readonly value: LogicValue | null;
  readonly width: number | null;
  readonly widthConflict: boolean;
  readonly contended: boolean;
  readonly pins: number;
  readonly pinName: string | null;
  readonly sx: number;
  readonly sy: number;
}

function componentName(circuit: Circuit, id: string): string {
  const c = circuit.components.find((x) => x.id === id);
  if (!c) return id;
  const label = strOf(c.props, 'label');
  return label || getDef(c.type)?.name || c.type;
}

function sameHit(a: Hit, b: Hit): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'none':
      return true;
    case 'pin':
      return b.kind === 'pin' && a.componentId === b.componentId && a.pin === b.pin;
    case 'input-cell':
      return b.kind === 'input-cell' && a.componentId === b.componentId && a.bit === b.bit;
    case 'button':
    case 'component':
      return (b.kind === 'button' || b.kind === 'component') && a.componentId === b.componentId;
    case 'wire':
      return b.kind === 'wire' && a.wireId === b.wireId && (a.endpoint === null) === (b.endpoint === null);
  }
}

function addTo(sel: Selection, isComponent: boolean, id: string, toggle = false): Selection {
  const components = new Set(sel.components);
  const wires = new Set(sel.wires);
  const set = isComponent ? components : wires;
  if (toggle && set.has(id)) set.delete(id);
  else set.add(id);
  return { components, wires };
}

/** After a move, keep the moved components selected and any wires that still exist. */
function keepSelection(next: Circuit, components: ReadonlySet<string>, wires: ReadonlySet<string>): Selection {
  const wireIds = new Set(next.wires.map((w) => w.id));
  return { components: new Set(components), wires: new Set([...wires].filter((id) => wireIds.has(id))) };
}
