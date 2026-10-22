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
}

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
