import type { BitLink, Netlist, NetlistComponent, PrimitiveProps } from '../engine/netlist.ts';
import { defaultLibrary } from '../engine/primitives/index.ts';
import type { PrimitiveLibrary } from '../engine/primitives/types.ts';
import { getDef, intOf, normalizeProps, splitterArmBits, strOf, type LayoutContext } from './catalog/index.ts';
import { analyzeConnectivity, pinKey, type Connectivity } from './connectivity.ts';
import { sortDiagnostics, type Diagnostic } from './diagnostics.ts';
import { circuitInterface, projectContext } from './layout.ts';
import type { Circuit, Project } from './types.ts';

/*
 * Compilation: hierarchical, geometric circuits → one flat engine netlist.
 *
 * Every subcircuit instance is expanded in place. Inside an instance, Input
 * and Output pin components are not simulated; their nets are merged with the
 * nets attached to the instance's ports, so a port adds no delay and signals
 * can flow in either direction (tri-state buses work across boundaries).
 * Each instance gets its own copy of every component, so state (latches,
 * registers) is per instance.
 *
 * Engine component keys are instance paths: "c4" at the top level,
 * "c9/c4" for component c4 inside subcircuit instance c9, and so on.
 */

export interface InstanceNode {
  readonly circuit: Circuit;
  /** Engine key prefix: "" for the root, "c9/" for instance c9, "c9/c2/" deeper. */
  readonly prefix: string;
  /** Component ids from the root to this instance. */
  readonly path: readonly string[];
  readonly connectivity: Connectivity;
  /** Flat net index for each local net id. */
  readonly netMap: Int32Array;
  /** Engine key of each simulated component, by component id. */
  readonly keys: ReadonlyMap<string, string>;
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
}

export interface CompileOptions {
  library?: PrimitiveLibrary;
  /** Maximum nesting depth (default 64). */
  maxDepth?: number;
}

export function compileProject(project: Project, rootCircuitId: string, options: CompileOptions = {}): CompiledDesign {
  const library = options.library ?? defaultLibrary;
  const maxDepth = options.maxDepth ?? 64;
  const ctx = projectContext(project);
  const byId = new Map(project.circuits.map((c) => [c.id, c]));
  const diagnostics: Diagnostic[] = [];
  const diagnosed = new Set<string>();

  const root = byId.get(rootCircuitId);
  if (!root) {
    return {
      project,
      rootCircuitId,
      netlist: { nets: [], components: [], links: [] },
      root: null,
      diagnostics: [{ severity: 'error', code: 'missing-root', message: `Circuit "${rootCircuitId}" does not exist.`, circuitId: rootCircuitId }],
      instanceCount: 0,
    };
  }

  // Union-find over net slots.
  const slotWidth: number[] = [];
  const parent: number[] = [];
  const newSlot = (width: number): number => {
    slotWidth.push(width);
    parent.push(parent.length);
    return parent.length - 1;
  };
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

  interface PendingComponent {
    key: string;
    type: string;
    props: PrimitiveProps;
    pins: number[];
  }
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
  const comps: PendingComponent[] = [];
  const links: [number, number, number, number][] = [];
  let instanceCount = 0;

  interface MutableNode {
    circuit: Circuit;
    prefix: string;
    path: string[];
    connectivity: Connectivity;
    slots: number[];
    keys: Map<string, string>;
    children: Map<string, MutableNode>;
  }

  const expand = (circuit: Circuit, path: string[], ports: Map<string, number> | null, stack: string[]): MutableNode => {
    instanceCount++;
    const conn = analyzeConnectivity(circuit, ctx);
    if (!diagnosed.has(circuit.id)) {
      diagnosed.add(circuit.id);
      diagnoseCircuit(circuit, conn, project, ctx, diagnostics);
    }
    const prefix = path.length === 0 ? '' : `${path.join('/')}/`;
    const slots = conn.nets.map((n) => newSlot(n.width ?? 1));
    const node: MutableNode = { circuit, prefix, path, connectivity: conn, slots, keys: new Map(), children: new Map() };

    const pinSlot = (componentId: string, pin: string, width: number): number => {
      const netId = conn.pinNet.get(pinKey(componentId, pin));
      if (netId === undefined) return newSlot(Math.max(1, width));
      const net = conn.nets[netId];
      // Pins on a net with conflicting widths are isolated so the rest of the design still simulates.
      if (net.widthConflict) return newSlot(Math.max(1, width));
      return slots[netId];
    };

    for (const comp of circuit.components) {
      const rc = conn.components.get(comp.id)!;
      const def = rc.def;
      if (!def) continue;
      const key = prefix + comp.id;
      switch (def.role.kind) {
        case 'primitive': {
          const spec = library.get(def.role.primitive);
          if (!spec) continue;
          const pprops = def.role.mapProps(rc.props);
          if (spec.validate(pprops)) continue; // reported as invalid-props
          const pins = spec.pins(pprops).map((ep) => {
            const lp = rc.pins.find((p) => p.name === ep.name);
            return lp ? pinSlot(comp.id, lp.name, ep.width) : -1;
          });
          comps.push({ key, type: def.role.primitive, props: pprops, pins });
          node.keys.set(comp.id, key);
          break;
        }
        case 'inputPort': {
          const width = intOf(rc.props, 'width');
          const s = pinSlot(comp.id, 'out', width);
          if (ports === null) {
            comps.push({ key, type: 'input', props: { width }, pins: [s] });
            node.keys.set(comp.id, key);
          } else {
            const outer = ports.get(comp.id);
            if (outer !== undefined) union(s, outer);
          }
          break;
        }
        case 'outputPort': {
          if (ports !== null) {
            const outer = ports.get(comp.id);
            if (outer !== undefined) union(pinSlot(comp.id, 'in', intOf(rc.props, 'width')), outer);
          }
          break;
        }
        case 'splitter': {
          const bus = pinSlot(comp.id, 'bus', intOf(rc.props, 'busWidth'));
          splitterArmBits(rc.props).forEach((bits, arm) => {
            if (bits.length === 0) return;
            const s = pinSlot(comp.id, `f${arm}`, bits.length);
            bits.forEach((bit, j) => links.push([bus, bit, s, j]));
          });
          break;
        }
        case 'subcircuit': {
          const targetId = strOf(rc.props, 'circuit');
          const target = byId.get(targetId);
          // Missing targets and instances that are part of a cycle are reported by diagnoseCircuit.
          if (!target || stack.includes(targetId) || cyclic(circuit.id, targetId)) continue;
          if (path.length >= maxDepth) {
            diagnostics.push({
              severity: 'error',
              code: 'recursive-subcircuit',
              message: `Subcircuits are nested more than ${maxDepth} levels deep here; deeper levels are not simulated.`,
              circuitId: circuit.id,
              componentIds: [comp.id],
            });
            continue;
          }
          const iface = circuitInterface(target);
          const childPorts = new Map<string, number>();
          for (const p of [...iface.inputs, ...iface.outputs]) childPorts.set(p.id, pinSlot(comp.id, p.id, p.width));
          const child = expand(target, [...path, comp.id], childPorts, [...stack, targetId]);
          node.children.set(comp.id, child);
          break;
        }
        case 'passive':
          break;
      }
    }
    return node;
  };

  const rootNode = expand(root, [], null, [root.id]);

  // Collapse slots into nets.
  const netOfRoot = new Map<number, number>();
  const nets: { width: number }[] = [];
  const netOf = (slot: number): number => {
    const r = find(slot);
    let n = netOfRoot.get(r);
    if (n === undefined) {
      n = nets.length;
      netOfRoot.set(r, n);
      nets.push({ width: slotWidth[r] });
    }
    return n;
  };

  const components: NetlistComponent[] = comps.map((c) => ({
    key: c.key,
    type: c.type,
    props: c.props,
    pins: c.pins.map((s) => (s < 0 ? -1 : netOf(s))),
  }));
  const bitLinks: BitLink[] = links.map(([a, bitA, b, bitB]) => ({ netA: netOf(a), bitA, netB: netOf(b), bitB }));

  const freeze = (n: MutableNode): InstanceNode => ({
    circuit: n.circuit,
    prefix: n.prefix,
    path: n.path,
    connectivity: n.connectivity,
    netMap: Int32Array.from(n.slots, netOf),
    keys: n.keys,
    children: new Map([...n.children].map(([id, child]) => [id, freeze(child)])),
  });
  const frozenRoot = freeze(rootNode);

  return {
    project,
    rootCircuitId,
    netlist: { nets, components, links: bitLinks },
    root: frozenRoot,
    diagnostics: sortDiagnostics(diagnostics),
    instanceCount,
  };
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
