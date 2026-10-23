import { defaultProps, getDef, type LayoutContext } from './catalog/index.ts';
import { withNormalizedWires } from './edit.ts';
import { lookupContext, resolveComponent } from './layout.ts';
import { evalExpr } from './expr.ts';
import { PARAM_PREFIX, specialize } from './params.ts';
import type { Circuit, CircuitSymbol, ComponentInstance, ParamDef, Point, Project, Props, Rotation, Wire } from './types.ts';

/*
 * Programmatic construction of projects (samples, tests, scripts).
 * Circuits must be added children-first so that subcircuit pin positions can
 * be resolved while wiring the parents.
 */

export class ComponentHandle {
  comp: ComponentInstance;
  private readonly ctx: LayoutContext;

  constructor(comp: ComponentInstance, ctx: LayoutContext) {
    this.comp = comp;
    this.ctx = ctx;
  }

  get id(): string {
    return this.comp.id;
  }

  /** World position of a pin. */
  pin(name: string): Point {
    const p = resolveComponent(this.comp, this.ctx).pins.find((x) => x.name === name);
    if (!p) throw new Error(`${this.comp.type} ${this.comp.id} has no pin "${name}"`);
    return { x: p.x, y: p.y };
  }

  /** Pin of a subcircuit instance by port label. */
  port(label: string): Point {
    const p = resolveComponent(this.comp, this.ctx).pins.find((x) => x.label === label);
    if (!p) throw new Error(`${this.comp.id} has no port "${label}"`);
    return { x: p.x, y: p.y };
  }

  /** Pin name of a subcircuit port by label. */
  portPin(label: string): string {
    const p = resolveComponent(this.comp, this.ctx).pins.find((x) => x.label === label);
    if (!p) throw new Error(`${this.comp.id} has no port "${label}"`);
    return p.name;
  }

  /** The side of the body a pin leaves from. */
  side(name: string): PinSide {
    const rc = resolveComponent(this.comp, this.ctx);
    const p = rc.pins.find((x) => x.name === name);
    if (!p) throw new Error(`${this.comp.type} ${this.comp.id} has no pin "${name}"`);
    const b = rc.bounds;
    if (p.x <= b.x) return 'left';
    if (p.x >= b.x + b.w) return 'right';
    if (p.y <= b.y) return 'up';
    return 'down';
  }
}

export type PinSide = 'left' | 'right' | 'up' | 'down';

const SIDE_STEP: Record<PinSide, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };
/** Tunnel rotation whose body extends in the given direction from its pin. */
const SIDE_TUNNEL: Record<PinSide, Rotation> = { left: 0, right: 180, up: 90, down: 270 };

export class CircuitBuilder {
  readonly id: string;
  readonly name: string;
  private readonly description: string | undefined;
  private readonly components: ComponentInstance[] = [];
  private readonly wires: Wire[] = [];
  private readonly ctx: LayoutContext;
  private symbolDef: CircuitSymbol | undefined;
  private paramDefs: ParamDef[] = [];
  private nextComp = 1;
  private nextWire = 1;

  constructor(id: string, name: string, ctx: LayoutContext, description?: string) {
    this.id = id;
    this.name = name;
    this.ctx = ctx;
    this.description = description;
  }

  add(type: string, x: number, y: number, props: Props = {}, rotation: Rotation = 0): ComponentHandle {
    const def = getDef(type);
    if (!def) throw new Error(`unknown component type ${type}`);
    const comp: ComponentInstance = { id: `c${this.nextComp++}`, type, x, y, rotation, props: { ...defaultProps(def), ...props } };
    this.components.push(comp);
    return new ComponentHandle(comp, this.ctx);
  }

  /** Instance of another circuit already added to the project, with optional parameter values. */
  sub(circuitId: string, x: number, y: number, label = '', rotation: Rotation = 0, params: Record<string, number> = {}): ComponentHandle {
    const props: Record<string, string | number> = { circuit: circuitId, label };
    for (const [k, v] of Object.entries(params)) props[PARAM_PREFIX + k] = v;
    return this.add('subcircuit', x, y, props, rotation);
  }

  /** Declare a parameter of this circuit. */
  param(name: string, def: number, min: number, max: number, description?: string): this {
    this.paramDefs.push({ name, default: def, min, max, ...(description ? { description } : {}) });
    return this;
  }

  /** Bind a property of a component to an expression over this circuit's parameters (declare them first). */
  bind(handle: ComponentHandle, prop: string, expr: string): this {
    const i = this.components.indexOf(handle.comp);
    if (i < 0) throw new Error(`component ${handle.id} is not in ${this.id}`);
    const scope = Object.fromEntries(this.paramDefs.map((p) => [p.name, p.default]));
    const comp: ComponentInstance = { ...handle.comp, props: { ...handle.comp.props, [prop]: evalExpr(expr, scope) }, bind: { ...handle.comp.bind, [prop]: expr } };
    this.components[i] = comp;
    handle.comp = comp;
    return this;
  }

  /** Set the symbol shape (port sides and slots, body width, label). */
  symbol(symbol: CircuitSymbol): this {
    this.symbolDef = symbol;
    return this;
  }

  /**
   * Attach a pin to the net named `label`: a stub of `len` units straight out
   * of the pin, ending in a tunnel. Tunnels with the same label connect.
   */
  tag(h: ComponentHandle, pin: string, label: string, len = 2): this {
    const p = h.pin(pin);
    const side = h.side(pin);
    const d = SIDE_STEP[side];
    const q = { x: p.x + d.x * len, y: p.y + d.y * len };
    if (len > 0) this.wire(p, q);
    this.add('tunnel', q.x, q.y, { label }, SIDE_TUNNEL[side]);
    return this;
  }

  /** `tag` for a subcircuit port given by its label. */
  tagPort(h: ComponentHandle, port: string, label: string, len = 2): this {
    return this.tag(h, h.portPin(port), label, len);
  }

  /** Orthogonal polyline through the given points. */
  wire(...points: Point[]): this {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a.x === b.x && a.y === b.y) continue;
      if (a.x !== b.x && a.y !== b.y) throw new Error(`diagonal wire (${a.x},${a.y})-(${b.x},${b.y}) in ${this.id}`);
      this.wires.push({ id: `w${this.nextWire++}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    return this;
  }

  /**
   * Connect two points with a horizontal-vertical-horizontal route whose
   * vertical leg runs at x = `viaX` (default: halfway).
   */
  connect(a: Point, b: Point, viaX?: number): this {
    if (a.y === b.y) return this.wire(a, b);
    const x = viaX ?? Math.round((a.x + b.x) / 2);
    return this.wire(a, { x, y: a.y }, { x, y: b.y }, b);
  }

  /** Connect with a vertical-horizontal-vertical route whose horizontal leg runs at y = `viaY`. */
  connectV(a: Point, b: Point, viaY?: number): this {
    if (a.x === b.x) return this.wire(a, b);
    const y = viaY ?? Math.round((a.y + b.y) / 2);
    return this.wire(a, { x: a.x, y }, { x: b.x, y }, b);
  }

  build(): Circuit {
    const circuit: Circuit = {
      id: this.id,
      name: this.name,
      ...(this.description ? { description: this.description } : {}),
      components: [...this.components],
      wires: [...this.wires],
      ...(this.symbolDef ? { symbol: this.symbolDef } : {}),
      ...(this.paramDefs.length ? { params: [...this.paramDefs] } : {}),
    };
    // Stored props hold the values for the default parameters, so the definition displays as its default instance.
    return withNormalizedWires(specialize(circuit), this.ctx);
  }
}

export class ProjectBuilder {
  private readonly circuits: Circuit[] = [];
  private readonly id: string;
  private readonly name: string;
  readonly ctx: LayoutContext = lookupContext((id) => this.circuits.find((x) => x.id === id));

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  /** Define a circuit; `fn` places components and wires. */
  circuit(id: string, name: string, fn: (b: CircuitBuilder) => void, description?: string): Circuit {
    const b = new CircuitBuilder(id, name, this.ctx, description);
    fn(b);
    const c = b.build();
    this.circuits.push(c);
    return c;
  }

  build(mainCircuitId: string, timestamp = '2026-01-01T00:00:00.000Z'): Project {
    return { id: this.id, name: this.name, mainCircuitId, circuits: [...this.circuits], createdAt: timestamp, modifiedAt: timestamp };
  }
}
