import type { BitLink, Netlist, NetlistComponent, PrimitiveProps } from '../engine/netlist.ts';
import { defaultLibrary } from '../engine/primitives/index.ts';
import type { PrimitiveLibrary } from '../engine/primitives/types.ts';
import { getDef, intOf, normalizeProps, splitterArmBits, strOf, type LayoutContext } from './catalog/index.ts';
import { analyzeConnectivity, pinKey, type Connectivity } from './connectivity.ts';
import { sortDiagnostics, type Diagnostic } from './diagnostics.ts';
import { projectContext } from './layout.ts';
import { bindingProblems, instanceParamValues, paramDefaults, paramSignature, specialize, type ParamValues } from './params.ts';
import type { Circuit, Project } from './types.ts';

/*
 * Compilation: hierarchical, geometric circuits → one flat engine netlist.
 *
 * Definitions are shared. Each circuit (for each distinct set of parameter
 * values) is analyzed once into a *template*: its primitives, nets, ports and
 * child instances in local slot numbers. A template is cached on the
 * circuit's connectivity, so a definition placed hundreds of times is
 * analyzed once; instantiating it only offsets slot numbers.
 *
 * Inside an instance, Input and Output pin components are not simulated:
 * their nets are merged with the nets attached to the instance's ports, so a
 * port adds no delay and signals can flow either way (tri-state buses work
 * across boundaries). Every instance gets its own engine primitives, so state
 * (latches, registers, memories) is per instance.
 *
 * Engine component keys are instance paths: "c4" at the top level, "c9/c4"
 * for component c4 inside subcircuit instance c9, and so on.
 */

/** Looks up the engine key of a component of an instance. */
export interface KeyLookup {
  get(componentId: string): string | undefined;
}

export interface InstanceNode {
  /** The circuit as instantiated (with this instance's parameter values applied). */
  readonly circuit: Circuit;
  /** Parameter values of this instance. */
  readonly params: ParamValues;
  /** Engine key prefix: "" for the root, "c9/" for instance c9, "c9/c2/" deeper. */
  readonly prefix: string;
  /** Component ids from the root to this instance. */
  readonly path: readonly string[];
  readonly connectivity: Connectivity;
  /** Flat net index for each local net id. */
  readonly netMap: Int32Array;
  /** Engine key of each simulated component. */
  readonly keys: KeyLookup;
  /** Expanded subcircuit instances, by component id. */
  readonly children: ReadonlyMap<string, InstanceNode>;
}

export interface CompiledDesign {
  readonly project: Project;
  readonly rootCircuitId: string;
  readonly netlist: Netlist;
  /** Null when the root circuit does not exist. */
  readonly root: InstanceNode | null;
  readonly diagnostics: readonly Diagnostic[];
  /** Total number of circuit instances expanded (including the root). */
  readonly instanceCount: number;
  /** Number of distinct (definition, parameters) templates used. */
  readonly templateCount: number;
}

export interface CompileOptions {
  library?: PrimitiveLibrary;
  /**
   * Safety limit on nesting depth (default 1000). Containment cycles are
   * rejected, so real designs are bounded by their number of circuits.
   */
  maxDepth?: number;
}

/* ------------------------------------------------------------------------ */
/* Templates                                                                 */
/* ------------------------------------------------------------------------ */

interface TemplatePrimitive {
  readonly id: string;
  readonly type: string;
  readonly props: PrimitiveProps;
  /** Local slot per engine pin; -1 = unconnected. */
  readonly pins: Int32Array;
}

interface TemplateChild {
  readonly id: string;
  readonly circuitId: string;
  readonly values: ParamValues;
  readonly problems: readonly string[];
  /** Local slot attached to each port (by port id). */
  readonly portSlots: ReadonlyMap<string, number>;
}

interface Template {
  readonly conn: Connectivity;
  /** Width of every local slot: one per net, then isolated slots for pins on nets with conflicting widths. */
  readonly slotWidth: readonly number[];
  readonly prims: readonly TemplatePrimitive[];
  /** Input pins: user-controlled sources at the root, ports elsewhere. */
  readonly inputs: readonly { id: string; width: number; slot: number }[];
  /** Slot of every port (Input/Output pin) by id. */
  readonly ports: ReadonlyMap<string, number>;
  /** Bit links as [slotA, bitA, slotB, bitB, ...]. */
  readonly links: readonly number[];
  readonly children: readonly TemplateChild[];
  /** Ids of components that become engine primitives (Input pins only at the root). */
  readonly primitiveIds: ReadonlySet<string>;
  readonly inputIds: ReadonlySet<string>;
}

const templateCache = new WeakMap<Connectivity, Template>();

function buildTemplate(conn: Connectivity, ctx: LayoutContext, library: PrimitiveLibrary): Template {
  const slotWidth: number[] = conn.nets.map((n) => n.width ?? 1);
  const newSlot = (width: number) => slotWidth.push(Math.max(1, width)) - 1;
  const pinSlot = (componentId: string, pin: string, width: number): number => {
    const netId = conn.pinNet.get(pinKey(componentId, pin));
    if (netId === undefined) return newSlot(width);
    // Pins on a net with conflicting widths are isolated so the rest of the design still simulates.
    return conn.nets[netId].widthConflict ? newSlot(width) : netId;
  };

  const prims: TemplatePrimitive[] = [];
  const inputs: { id: string; width: number; slot: number }[] = [];
  const ports = new Map<string, number>();
  const links: number[] = [];
  const children: TemplateChild[] = [];

  for (const comp of conn.circuit.components) {
    const rc = conn.components.get(comp.id)!;
    const def = rc.def;
    if (!def) continue;
    switch (def.role.kind) {
      case 'primitive': {
        const spec = library.get(def.role.primitive);
        if (!spec) break;
        const props = def.role.mapProps(rc.props);
        if (spec.validate(props)) break; // reported as invalid-props
        const pins = Int32Array.from(spec.pins(props), (ep) => {
          const lp = rc.pins.find((p) => p.name === ep.name);
          return lp ? pinSlot(comp.id, lp.name, ep.width) : -1;
        });
        prims.push({ id: comp.id, type: def.role.primitive, props, pins });
        break;
      }
      case 'inputPort': {
        const width = intOf(rc.props, 'width');
        const slot = pinSlot(comp.id, 'out', width);
        inputs.push({ id: comp.id, width, slot });
        ports.set(comp.id, slot);
        break;
      }
      case 'outputPort':
        ports.set(comp.id, pinSlot(comp.id, 'in', intOf(rc.props, 'width')));
        break;
      case 'splitter': {
        const bus = pinSlot(comp.id, 'bus', intOf(rc.props, 'busWidth'));
        splitterArmBits(rc.props).forEach((bits, arm) => {
          if (bits.length === 0) return;
          const s = pinSlot(comp.id, `f${arm}`, bits.length);
          bits.forEach((bit, j) => links.push(bus, bit, s, j));
        });
        break;
      }
      case 'subcircuit': {
        const circuitId = strOf(rc.props, 'circuit');
        const iface = ctx.getInterface(circuitId, comp.props);
        if (!iface) break; // reported as missing-circuit
        const { values, problems } = instanceParamValues({ id: circuitId, name: '', components: [], wires: [], params: iface.params }, comp.props);
        const portSlots = new Map<string, number>();
        for (const p of [...iface.inputs, ...iface.outputs]) portSlots.set(p.id, pinSlot(comp.id, p.id, p.width));
        children.push({ id: comp.id, circuitId, values, problems, portSlots });
        break;
      }
      case 'passive':
        break;
    }
  }
  return {
    conn,
    slotWidth,
    prims,
    inputs,
    ports,
    links,
    children,
    primitiveIds: new Set(prims.map((p) => p.id)),
    inputIds: new Set(inputs.map((i) => i.id)),
  };
}

function templateFor(conn: Connectivity, ctx: LayoutContext, library: PrimitiveLibrary): Template {
  if (library !== defaultLibrary) return buildTemplate(conn, ctx, library);
  let t = templateCache.get(conn);
  if (!t) {
    t = buildTemplate(conn, ctx, library);
    templateCache.set(conn, t);
  }
  return t;
}

/* ------------------------------------------------------------------------ */
/* Instantiation                                                             */
/* ------------------------------------------------------------------------ */

class Node implements InstanceNode {
  readonly circuit: Circuit;
  readonly params: ParamValues;
  readonly prefix: string;
  readonly path: readonly string[];
  readonly children = new Map<string, Node>();
  readonly keys: KeyLookup;
  readonly template: Template;
  /** First global slot of this instance. */
  readonly base: number;
  private readonly slotNet: { map: Int32Array | null };
  private cachedNetMap: Int32Array | null = null;

  constructor(template: Template, circuit: Circuit, params: ParamValues, prefix: string, path: readonly string[], base: number, isRoot: boolean, slotNet: { map: Int32Array | null }) {
    this.template = template;
    this.circuit = circuit;
    this.params = params;
    this.prefix = prefix;
    this.path = path;
    this.base = base;
    this.slotNet = slotNet;
    this.keys = {
      get: (id: string) => (template.primitiveIds.has(id) || (isRoot && template.inputIds.has(id)) ? prefix + id : undefined),
    };
  }

  get connectivity(): Connectivity {
    return this.template.conn;
  }

  get netMap(): Int32Array {
    if (!this.cachedNetMap) {
      const map = this.slotNet.map!;
      const n = this.template.conn.nets.length;
      this.cachedNetMap = Int32Array.from({ length: n }, (_, i) => map[this.base + i]);
    }
    return this.cachedNetMap;
  }
}

export function compileProject(project: Project, rootCircuitId: string, options: CompileOptions = {}): CompiledDesign {
  const library = options.library ?? defaultLibrary;
  const maxDepth = options.maxDepth ?? 1000;
  const ctx = projectContext(project);
  const byId = new Map(project.circuits.map((c) => [c.id, c]));
  const diagnostics: Diagnostic[] = [];
  const diagnosed = new Set<string>();
  const usedTemplates = new Set<Template>();

  const root = byId.get(rootCircuitId);
  if (!root) {
    return {
      project,
      rootCircuitId,
      netlist: { nets: [], components: [], links: [] },
      root: null,
      diagnostics: [{ severity: 'error', code: 'missing-root', message: `Circuit "${rootCircuitId}" does not exist.`, circuitId: rootCircuitId }],
      instanceCount: 0,
      templateCount: 0,
    };
  }

  // Union-find over global slots.
  const slotWidth: number[] = [];
  const parent: number[] = [];
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const x = find(a);
    const y = find(b);
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };

  const comps: { key: string; type: string; props: PrimitiveProps; pins: ArrayLike<number>; base: number }[] = [];
  const links: number[] = [];
  const slotNet: { map: Int32Array | null } = { map: null };
  let instanceCount = 0;

  const cyclicCache = new Map<string, boolean>();
  const cyclic = (parentId: string, childId: string): boolean => {
    const k = `${parentId}>${childId}`;
    let v = cyclicCache.get(k);
    if (v === undefined) {
      v = parentId === childId || reaches(byId, childId, parentId);
      cyclicCache.set(k, v);
    }
    return v;
  };

  const instantiate = (raw: Circuit, values: ParamValues, path: string[], ports: Map<string, number> | null, stack: string[]): Node => {
    instanceCount++;
    const circuit = specialize(raw, values);
    const conn = analyzeConnectivity(circuit, ctx);
    const template = templateFor(conn, ctx, library);
    usedTemplates.add(template);
    const diagKey = `${raw.id}|${paramSignature(values)}`;
    if (!diagnosed.has(diagKey)) {
      diagnosed.add(diagKey);
      diagnoseCircuit(circuit, conn, project, ctx, diagnostics);
      for (const p of bindingProblems(raw, values)) {
        diagnostics.push({
          severity: 'error',
          code: 'binding',
          message: `Binding ${p.prop} = "${p.expr}" failed: ${p.message}. The stored value is used.`,
          circuitId: raw.id,
          componentIds: [p.componentId],
        });
      }
    }

    const prefix = path.length === 0 ? '' : `${path.join('/')}/`;
    const base = slotWidth.length;
    for (const w of template.slotWidth) {
      slotWidth.push(w);
      parent.push(parent.length);
    }
    const node = new Node(template, circuit, values, prefix, path, base, ports === null, slotNet);

    for (const p of template.prims) comps.push({ key: prefix + p.id, type: p.type, props: p.props, pins: p.pins, base });
    if (ports === null) {
      for (const i of template.inputs) comps.push({ key: prefix + i.id, type: 'input', props: { width: i.width }, pins: [i.slot], base });
    } else {
      for (const [id, slot] of template.ports) {
        const outer = ports.get(id);
        if (outer !== undefined) union(base + slot, outer);
      }
    }
    for (let i = 0; i < template.links.length; i += 4) {
      links.push(base + template.links[i], template.links[i + 1], base + template.links[i + 2], template.links[i + 3]);
    }

    for (const child of template.children) {
      const target = byId.get(child.circuitId);
      // Missing targets and instances that are part of a cycle are reported by diagnoseCircuit.
      if (!target || stack.includes(child.circuitId) || cyclic(raw.id, child.circuitId)) continue;
      if (path.length >= maxDepth) {
        diagnostics.push({
          severity: 'error',
          code: 'recursive-subcircuit',
          message: `Subcircuits are nested more than ${maxDepth} levels deep here; deeper levels are not simulated.`,
          circuitId: raw.id,
          componentIds: [child.id],
        });
        continue;
      }
      for (const problem of child.problems) {
        diagnostics.push({ severity: 'warning', code: 'invalid-props', message: `Subcircuit ${problem}.`, circuitId: raw.id, componentIds: [child.id] });
      }
      const childPorts = new Map<string, number>();
      for (const [id, slot] of child.portSlots) childPorts.set(id, base + slot);
      node.children.set(child.id, instantiate(target, child.values, [...path, child.id], childPorts, [...stack, child.circuitId]));
    }
    return node;
  };

  const rootNode = instantiate(root, paramDefaults(root), [], null, [root.id]);

  // Collapse slots into nets.
  const map = new Int32Array(slotWidth.length);
  const nets: { width: number }[] = [];
  const netOfRoot = new Map<number, number>();
  for (let s = 0; s < slotWidth.length; s++) {
    const r = find(s);
    let n = netOfRoot.get(r);
    if (n === undefined) {
      n = nets.length;
      netOfRoot.set(r, n);
      nets.push({ width: slotWidth[r] });
    }
    map[s] = n;
  }
  slotNet.map = map;

  const components: NetlistComponent[] = comps.map((c) => ({
    key: c.key,
    type: c.type,
    props: c.props,
    pins: Array.from(c.pins, (s) => (s < 0 ? -1 : map[c.base + s])),
  }));
  const bitLinks: BitLink[] = [];
  for (let i = 0; i < links.length; i += 4) bitLinks.push({ netA: map[links[i]], bitA: links[i + 1], netB: map[links[i + 2]], bitB: links[i + 3] });

  return {
    project,
    rootCircuitId,
    netlist: { nets, components, links: bitLinks },
    root: rootNode,
    diagnostics: sortDiagnostics(dedupe(diagnostics)),
    instanceCount,
    templateCount: usedTemplates.size,
  };
}

function dedupe(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const k = `${d.circuitId}|${d.code}|${d.message}|${(d.componentIds ?? []).join(',')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Find the instance node for a path of subcircuit component ids. */
export function instanceAt(design: CompiledDesign, path: readonly string[]): InstanceNode | null {
  let node = design.root;
  for (const id of path) {
    if (!node) return null;
    node = node.children.get(id) ?? null;
  }
  return node;
}

/** Resolve an engine key ("c9/c2/c4") to the instance containing the component and its id. */
export function locateKey(design: CompiledDesign, key: string): { node: InstanceNode; componentId: string } | null {
  const parts = key.split('/');
  const componentId = parts.pop()!;
  const node = instanceAt(design, parts);
  return node ? { node, componentId } : null;
}

/* ------------------------------------------------------------------------ */
/* Static diagnostics for one circuit definition                             */
/* ------------------------------------------------------------------------ */

function diagnoseCircuit(circuit: Circuit, conn: Connectivity, project: Project, ctx: LayoutContext, out: Diagnostic[]): void {
  const circuitId = circuit.id;
  const byId = new Map(project.circuits.map((c) => [c.id, c]));

  for (const comp of circuit.components) {
    const def = getDef(comp.type);
    if (!def) {
      out.push({
        severity: 'error',
        code: 'unknown-type',
        message: `Unknown component type "${comp.type}". It is kept in the file but not simulated.`,
        circuitId,
        componentIds: [comp.id],
      });
      continue;
    }
    for (const e of normalizeProps(def, comp.props).errors) {
      out.push({ severity: 'warning', code: 'invalid-props', message: `${def.name}: ${e.message}; using the default.`, circuitId, componentIds: [comp.id] });
    }
    if (def.role.kind === 'subcircuit') {
      const targetId = strOf(comp.props, 'circuit');
      const target = byId.get(targetId);
      if (!target) {
        out.push({
          severity: 'error',
          code: 'missing-circuit',
          message: `This subcircuit refers to a circuit that is not in the project ("${targetId}").`,
          circuitId,
          componentIds: [comp.id],
        });
      } else if (targetId === circuitId || reaches(byId, targetId, circuitId)) {
        out.push({
          severity: 'error',
          code: 'recursive-subcircuit',
          message: `"${target.name}" contains "${circuit.name}", so placing it here would make the circuit contain itself. It is not simulated.`,
          circuitId,
          componentIds: [comp.id],
        });
      }
    }
  }

  for (const net of conn.nets) {
    if (net.widthConflict) {
      const widths = [...new Set(net.pins.filter((p) => p.width > 0).map((p) => p.width))].sort((a, b) => a - b);
      out.push({
        severity: 'error',
        code: 'width-conflict',
        message: `Connected pins have different bit widths (${widths.join(', ')}). These pins are left unconnected until the widths match.`,
        circuitId,
        componentIds: [...new Set(net.pins.map((p) => p.componentId))],
        wireIds: net.wireIds,
      });
    }
    const drivers = net.pins.filter((p) => {
      if (p.dir !== 'out') return false;
      const type = conn.components.get(p.componentId)?.comp.type;
      return type !== undefined && type !== 'tristate' && type !== 'subcircuit';
    });
    if (drivers.length > 1) {
      out.push({
        severity: 'warning',
        code: 'multiple-drivers',
        message: `${drivers.length} outputs drive the same wire. When they disagree its value becomes unknown (X). Use tri-state buffers to share a wire.`,
        circuitId,
        componentIds: drivers.map((p) => p.componentId),
        wireIds: net.wireIds,
      });
    }
  }

  const iface = ctx.getInterface(circuitId);
  if (iface) {
    for (const side of [iface.inputs, iface.outputs]) {
      const seen = new Map<string, string[]>();
      for (const p of side) seen.set(p.label, [...(seen.get(p.label) ?? []), p.id]);
      for (const [label, ids] of seen) {
        if (ids.length > 1) {
          out.push({
            severity: 'warning',
            code: 'duplicate-port',
            message: `${ids.length} pins are labelled "${label}". Give each pin a unique label so the ports of this circuit can be told apart.`,
            circuitId,
            componentIds: ids,
          });
        }
      }
    }
  }
}

function reaches(byId: Map<string, Circuit>, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const c = byId.get(id);
    if (!c) continue;
    for (const comp of c.components) if (comp.type === 'subcircuit') stack.push(strOf(comp.props, 'circuit'));
  }
  return false;
}
