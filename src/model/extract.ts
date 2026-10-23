import { strOf, type LayoutContext } from './catalog/index.ts';
import { analyzeConnectivity, type Connectivity, type LocalNet } from './connectivity.ts';
import { createComponent, uniqueCircuitName, withNormalizedWires } from './edit.ts';
import { circuitIdGenerator, idGenerator, wireIdGenerator } from './ids.ts';
import { circuitInterface, projectContext, resolveComponent } from './layout.ts';
import { findComb, findRoute, onSegment, trimStubs } from './route.ts';
import { pointKey, type Circuit, type ComponentInstance, type Point, type Project, type Rotation, type Wire } from './types.ts';
import { unionRect, type Rect } from './geometry.ts';

/*
 * Create a component from a selection.
 *
 * The selected components (and the wires of nets that lie entirely inside
 * the selection) move into a new circuit, which an instance replaces in the
 * original. Every net that crosses the selection boundary becomes a port:
 * selected Input and Output pins stay ports with their labels; other
 * boundary nets get new pins, named after a pin or tunnel on the net where
 * possible. Both sides are reconnected with clean routes (see route.ts), or
 * with a pair of tunnels where no clean route exists, so the circuit behaves
 * exactly as before.
 */

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

export interface ExtractResult {
  readonly project: Project;
  /** The new circuit. */
  readonly circuitId: string;
  /** The instance that replaced the selection in the original circuit. */
  readonly instanceId: string;
  readonly ports: readonly { readonly label: string; readonly dir: 'in' | 'out'; readonly width: number }[];
  /** Connections made with tunnels because no clean wire route existed. */
  readonly tunnels: number;
}

interface Boundary {
  readonly net: LocalNet;
  /** Points where the inside and outside parts of the net touch. */
  readonly contacts: Point[];
  /** Selected Input/Output pin on the net, which becomes the port. */
  existingPort: ComponentInstance | null;
  dir: 'in' | 'out';
  width: number;
  label: string;
  /** Port component id in the new circuit. */
  portId: string;
}

const DIRS: Record<Rotation, Point> = { 0: { x: -1, y: 0 }, 90: { x: 0, y: -1 }, 180: { x: 1, y: 0 }, 270: { x: 0, y: 1 } };

/** Rotation that makes a tunnel's body extend in direction `d` from its pin. */
function tunnelRotation(d: Point): Rotation {
  for (const r of [0, 90, 180, 270] as const) if (DIRS[r].x === d.x && DIRS[r].y === d.y) return r;
  return 0;
}

function dominant(dx: number, dy: number): Point {
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx < 0 ? -1 : 1, y: 0 };
  return { x: 0, y: dy < 0 ? -1 : 1 };
}

export interface ExtractOptions {
  /** New names for ports, keyed by the name the port would get automatically. */
  readonly portLabels?: Readonly<Record<string, string>>;
}

export function extractComponent(
  project: Project,
  parentId: string,
  componentIds: ReadonlySet<string>,
  wireIds: ReadonlySet<string>,
  name: string,
  options: ExtractOptions = {},
): ExtractResult {
  const parent = project.circuits.find((c) => c.id === parentId);
  if (!parent) throw new ExtractError(`Circuit "${parentId}" does not exist.`);
  const ctx = projectContext(project);
  const conn = analyzeConnectivity(parent, ctx);
  const selected = parent.components.filter((c) => componentIds.has(c.id));
  if (selected.length === 0) throw new ExtractError('Select the components to turn into a new component.');
  const wireById = new Map(parent.wires.map((w) => [w.id, w]));

  /* ---- Classify nets ---------------------------------------------------- */

  const moved = new Set<string>();
  const boundaries: Boundary[] = [];
  for (const net of conn.nets) {
    const insidePins = net.pins.filter((p) => componentIds.has(p.componentId));
    if (insidePins.length === 0) continue; // selected wires on an outside net stay where they are
    const outsidePins = net.pins.filter((p) => !componentIds.has(p.componentId));
    if (outsidePins.length === 0) {
      for (const id of net.wireIds) moved.add(id);
      continue;
    }
    const insideWires = net.wireIds.filter((id) => wireIds.has(id)).map((id) => wireById.get(id)!);
    const outsideWires = net.wireIds.filter((id) => !wireIds.has(id)).map((id) => wireById.get(id)!);
    for (const w of insideWires) moved.add(w.id);
    const insidePoints = [...insidePins.map((p) => ({ x: p.x, y: p.y })), ...insideWires.flatMap(ends)];
    const outsidePoints = [...outsidePins.map((p) => ({ x: p.x, y: p.y })), ...outsideWires.flatMap(ends)];
    const outsideKeys = new Set(outsidePoints.map((p) => pointKey(p.x, p.y)));
    const contacts = new Map<number, Point>();
    for (const p of insidePoints) {
      if (outsideKeys.has(pointKey(p.x, p.y)) || outsideWires.some((w) => onSegment(w, p.x, p.y))) contacts.set(pointKey(p.x, p.y), p);
    }
    for (const p of outsidePoints) if (insideWires.some((w) => onSegment(w, p.x, p.y))) contacts.set(pointKey(p.x, p.y), p);
    const existing = insidePins.map((p) => conn.components.get(p.componentId)!.comp).find((c) => c.type === 'input' || c.type === 'output') ?? null;
    const drivesOut = insidePins.some((p) => p.dir === 'out');
    const width = net.width ?? insidePins.find((p) => p.width > 0)?.width ?? 1;
    boundaries.push({ net, contacts: [...contacts.values()], existingPort: existing, dir: drivesOut ? 'out' : 'in', width, label: '', portId: '' });
  }

  /* ---- Port names --------------------------------------------------------- */

  const usedLabels = new Set<string>();
  for (const c of selected) if (c.type === 'input' || c.type === 'output') usedLabels.add(strOf(c.props, 'label') || c.id);
  const unique = (base: string) => {
    let label = base;
    for (let i = 2; usedLabels.has(label); i++) label = `${base}${i}`;
    usedLabels.add(label);
    return label;
  };
  let nIn = 0;
  let nOut = 0;
  for (const b of boundaries) {
    if (b.existingPort) {
      b.label = strOf(b.existingPort.props, 'label') || b.existingPort.id;
      b.dir = b.existingPort.type === 'input' ? 'in' : 'out';
      b.portId = b.existingPort.id;
      continue;
    }
    const named = b.net.pins
      .map((p) => conn.components.get(p.componentId)!.comp)
      .find((c) => (c.type === 'input' || c.type === 'output' || c.type === 'tunnel') && strOf(c.props, 'label'));
    // Else a labelled port of a labelled part inside, e.g. "FA0.Cout".
    const part = b.net.pins
      .filter((p) => componentIds.has(p.componentId))
      .map((p) => ({ rc: conn.components.get(p.componentId)!, pin: p.pin }))
      .map(({ rc, pin }) => ({ owner: strOf(rc.props, 'label'), port: rc.pins.find((x) => x.name === pin)?.label }))
      .find((x) => x.owner && x.port && x.port !== '>');
    b.label = unique(named ? strOf(named.props, 'label') : part ? `${part.owner}.${part.port}` : b.dir === 'in' ? `in${nIn++}` : `out${nOut++}`);
  }

  // Names chosen by the user replace the automatic ones (on new pins and on selected Input/Output pins).
  const rename = (auto: string): string => {
    const v = options.portLabels?.[auto]?.trim();
    return v ? v : auto;
  };
  const finalLabels = new Map<string, string>();
  for (const c of selected) if (c.type === 'input' || c.type === 'output') finalLabels.set(c.id, rename(strOf(c.props, 'label') || c.id));
  for (const b of boundaries) if (!b.existingPort) b.label = rename(b.label);
  const seenLabels = new Set<string>();
  for (const label of [...finalLabels.values(), ...boundaries.filter((b) => !b.existingPort).map((b) => b.label)]) {
    if (seenLabels.has(label)) throw new ExtractError(`Two ports would both be called "${label}". Give each port its own name.`);
    seenLabels.add(label);
  }
  for (const b of boundaries) if (b.existingPort) b.label = finalLabels.get(b.existingPort.id)!;

  /* ---- The new circuit ---------------------------------------------------- */

  let box: Rect | null = null;
  for (const c of selected) box = unionRect(box, resolveComponent(c, ctx).bounds);
  for (const id of moved) {
    const w = wireById.get(id)!;
    box = unionRect(box, { x: Math.min(w.x1, w.x2), y: Math.min(w.y1, w.y2), w: Math.abs(w.x2 - w.x1), h: Math.abs(w.y2 - w.y1) });
  }
  const bounds = box!;
  const newId = circuitIdGenerator(project)();
  let inner: Circuit = {
    id: newId,
    name: uniqueCircuitName(project, name),
    components: selected.map((c) =>
      (c.type === 'input' || c.type === 'output') && finalLabels.get(c.id) !== (strOf(c.props, 'label') || c.id) ? { ...c, props: { ...c.props, label: finalLabels.get(c.id)! } } : c,
    ),
    wires: parent.wires.filter((w) => moved.has(w.id)),
  };
  const anchorY = (b: Boundary) => Math.min(...b.contacts.map((p) => p.y));
  const newPorts: ComponentInstance[] = [];
  for (const dir of ['in', 'out'] as const) {
    const x = dir === 'in' ? Math.floor(bounds.x) - 4 : Math.ceil(bounds.x + bounds.w) + 4;
    let lastY = -Infinity;
    for (const b of boundaries.filter((q) => !q.existingPort && q.dir === dir).sort((p, q) => anchorY(p) - anchorY(q))) {
      const y = Math.max(anchorY(b), lastY + 3);
      lastY = y;
      const comp = createComponent({ ...inner, components: [...inner.components, ...newPorts] }, dir === 'in' ? 'input' : 'output', x, y, 0, { label: b.label, width: b.width });
      b.portId = comp.id;
      newPorts.push(comp);
    }
  }
  inner = { ...inner, components: [...inner.components, ...newPorts] };
  const newProject: Project = { ...project, circuits: [...project.circuits, inner] };
  const innerCtx = projectContext(newProject);
  let tunnels = 0;

  inner = connectPieces(inner, innerCtx, boundaries, (b) => {
    const port = inner.components.find((c) => c.id === b.portId)!;
    const pin = resolveComponent(port, innerCtx).pins[0];
    // Wires leave an Input pin to the east and enter an Output pin from the west (before rotation).
    const facing = port.type === 'input' ? rotateDir({ x: 1, y: 0 }, port.rotation) : rotateDir({ x: -1, y: 0 }, port.rotation);
    return { at: { x: pin.x, y: pin.y }, out: facing, label: b.label };
  }, () => tunnels++);

  /* ---- The original circuit ------------------------------------------------ */

  const finalProject0: Project = { ...project, circuits: [...project.circuits, inner] };
  const outerCtx = projectContext(finalProject0);
  const remainingComps = parent.components.filter((c) => !componentIds.has(c.id));
  const remainingWires = parent.wires.filter((w) => !moved.has(w.id));
  const instanceId = idGenerator('c', parent.components.map((c) => c.id))();
  const centre = { x: Math.round(bounds.x + bounds.w / 2), y: Math.round(bounds.y + bounds.h / 2) };
  const instance = placeInstance(instanceId, newId, centre, remainingComps, remainingWires, outerCtx);
  const instPins = resolveComponent(instance, outerCtx);
  const portPin = new Map(instPins.pins.map((p) => [p.name, p]));
  // Moved Input/Output pins keep their role in the original circuit: put them back on their ports.
  const replacements: ComponentInstance[] = [];
  for (const c of selected) {
    if (c.type !== 'input' && c.type !== 'output') continue;
    const p = portPin.get(c.id);
    if (p) replacements.push({ ...c, x: p.x, y: p.y, rotation: 0 });
  }
  let outer: Circuit = { ...parent, components: [...remainingComps, instance, ...replacements], wires: remainingWires };
  const ib = instPins.bounds;
  outer = connectPieces(outer, outerCtx, boundaries, (b) => {
    const p = portPin.get(b.portId)!;
    const out = p.x < ib.x ? { x: -1, y: 0 } : p.x > ib.x + ib.w ? { x: 1, y: 0 } : p.y < ib.y ? { x: 0, y: -1 } : { x: 0, y: 1 };
    return { at: { x: p.x, y: p.y }, out, label: `${inner.name}.${b.label}` };
  }, () => tunnels++);

  const finalProject: Project = { ...project, circuits: [...project.circuits.map((c) => (c.id === parentId ? outer : c)), inner] };
  const iface = circuitInterface(inner);
  return {
    project: finalProject,
    circuitId: newId,
    instanceId,
    ports: [...iface.inputs, ...iface.outputs].map((x) => ({ label: x.label, dir: x.dir, width: x.width })),
    tunnels,
  };
}

function ends(w: Wire): Point[] {
  return [
    { x: w.x1, y: w.y1 },
    { x: w.x2, y: w.y2 },
  ];
}

function rotateDir(d: Point, r: Rotation): Point {
  switch (r) {
    case 0:
      return d;
    case 90:
      return { x: -d.y, y: d.x };
    case 180:
      return { x: -d.x, y: -d.y };
    case 270:
      return { x: d.y, y: -d.x };
  }
}

/** Instance near `centre` whose pins touch no remaining pin or wire. */
function placeInstance(id: string, circuitId: string, centre: Point, comps: readonly ComponentInstance[], wires: readonly Wire[], ctx: LayoutContext): ComponentInstance {
  const pinKeys = new Set<number>();
  for (const c of comps) for (const p of resolveComponent(c, ctx).pins) pinKeys.add(pointKey(p.x, p.y));
  const base: ComponentInstance = { id, type: 'subcircuit', x: centre.x, y: centre.y, rotation: 0, props: { circuit: circuitId, label: '' } };
  for (let r = 0; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cand = { ...base, x: centre.x + dx, y: centre.y + dy };
        const pins = resolveComponent(cand, ctx).pins;
        if (pins.every((p) => !pinKeys.has(pointKey(p.x, p.y)) && !wires.some((w) => onSegment(w, p.x, p.y)))) return cand;
      }
    }
  }
  return base;
}

/**
 * Join every piece of each boundary net in `circuit` to its port. Dead-end
 * stubs left where the selection was are trimmed first; then all pieces of a
 * net are joined with one comb (a spine with a leg per piece), or with
 * separate clean routes, or, where neither exists, with a tunnel at the
 * piece and one at the port.
 */
function connectPieces(
  circuit: Circuit,
  ctx: LayoutContext,
  boundaries: readonly Boundary[],
  portOf: (b: Boundary) => { at: Point; out: Point; label: string },
  onTunnel: () => void,
): Circuit {
  const pinKeys = new Set<number>();
  for (const c of circuit.components) for (const p of resolveComponent(c, ctx).pins) pinKeys.add(pointKey(p.x, p.y));
  const trimmed = trimStubs(circuit.wires, pinKeys, boundaries.flatMap((b) => b.contacts));
  const wires: Wire[] = trimmed.wires;
  const base: Circuit = { ...circuit, wires: [...wires] };
  const conn = analyzeConnectivity(base, ctx);
  const comps: ComponentInstance[] = [...circuit.components];
  const genWire = wireIdGenerator(circuit);
  const genComp = idGenerator('c', circuit.components.map((c) => c.id));
  const tunnelLabels = new Set(circuit.components.filter((c) => c.type === 'tunnel').map((c) => strOf(c.props, 'label')));
  const addSeg = (a: Point, b: Point) => wires.push({ id: genWire(), x1: a.x, y1: a.y, x2: b.x, y2: b.y });

  let next = 0;
  for (const b of boundaries) {
    const ends = b.contacts.map(() => trimmed.ends[next++]);
    const port = portOf(b);
    const portNet = netAt(conn, base, port.at);
    // One start per piece of the net: the end nearest the port.
    const pieces = new Map<number, Point>();
    const dist = (p: Point) => Math.abs(p.x - port.at.x) + Math.abs(p.y - port.at.y);
    for (const p of ends) {
      if (!p) continue;
      const n = netAt(conn, base, p);
      if (n === null || n === portNet) continue;
      const best = pieces.get(n);
      if (!best || dist(p) < dist(best)) pieces.set(n, p);
    }
    const starts = [...pieces.values()];
    if (starts.length === 0) continue;
    const comb = findComb(port.at, port.out, starts, wires, pinKeys);
    if (comb) {
      for (const sgm of comb) addSeg({ x: sgm.x1, y: sgm.y1 }, { x: sgm.x2, y: sgm.y2 });
      continue;
    }
    let tunnelLabel: string | null = null;
    for (const start of starts) {
      const path = findRoute(start, port.at, port.out, wires, pinKeys);
      if (path) {
        for (let i = 0; i + 1 < path.length; i++) addSeg(path[i], path[i + 1]);
        continue;
      }
      if (tunnelLabel === null) {
        let label = port.label;
        for (let i = 2; tunnelLabels.has(label); i++) label = `${port.label}_${i}`;
        tunnelLabels.add(label);
        tunnelLabel = label;
        comps.push({ id: genComp(), type: 'tunnel', x: port.at.x, y: port.at.y, rotation: tunnelRotation(port.out), props: { label } });
      }
      comps.push({ id: genComp(), type: 'tunnel', x: start.x, y: start.y, rotation: tunnelRotation(awayFrom(conn, base, start)), props: { label: tunnelLabel } });
      onTunnel();
    }
  }
  return withNormalizedWires({ ...circuit, components: comps }, ctx, wires);
}

/** Net of whatever pin or wire is at a point, or null. */
function netAt(conn: Connectivity, circuit: Circuit, p: Point): number | null {
  for (const net of conn.nets) if (net.pins.some((q) => q.x === p.x && q.y === p.y)) return net.id;
  for (const w of circuit.wires) if (onSegment(w, p.x, p.y)) return conn.wireNet.get(w.id) ?? null;
  return null;
}

/** Direction pointing away from what is attached at `p` (for placing a tunnel body). */
function awayFrom(conn: Connectivity, circuit: Circuit, p: Point): Point {
  const w = circuit.wires.find((x) => (x.x1 === p.x && x.y1 === p.y) || (x.x2 === p.x && x.y2 === p.y));
  if (w) {
    const other = w.x1 === p.x && w.y1 === p.y ? { x: w.x2, y: w.y2 } : { x: w.x1, y: w.y1 };
    return dominant(p.x - other.x, p.y - other.y);
  }
  for (const rc of conn.components.values()) {
    if (rc.pins.some((q) => q.x === p.x && q.y === p.y)) {
      const b = rc.bounds;
      return dominant(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2));
    }
  }
  return { x: -1, y: 0 };
}
