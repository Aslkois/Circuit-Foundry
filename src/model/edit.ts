import { getDef, defaultProps, type LayoutContext } from './catalog/index.ts';
import { nextRotation } from './geometry.ts';
import { componentIdGenerator, idGenerator, wireIdGenerator } from './ids.ts';
import { resolveComponent } from './layout.ts';
import { pointKey, type Circuit, type ComponentInstance, type Point, type Project, type PropValue, type Props, type Rotation, type Wire } from './types.ts';
import { normalizeWires } from './wires.ts';

/*
 * Pure edit operations. Each returns a new Circuit (or Project) and leaves the
 * input untouched; unchanged components and wires keep their identity.
 * Wires are re-canonicalized after every edit (see wires.ts).
 */

export interface Segment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

function pinPoints(components: readonly ComponentInstance[], ctx: LayoutContext): Point[] {
  const out: Point[] = [];
  for (const c of components) for (const p of resolveComponent(c, ctx).pins) out.push(p);
  return out;
}

/** Re-canonicalize wires against the current pins. */
export function withNormalizedWires(circuit: Circuit, ctx: LayoutContext, wires: readonly Wire[] = circuit.wires): Circuit {
  const next = normalizeWires(wires, pinPoints(circuit.components, ctx), wireIdGenerator({ ...circuit, wires }));
  if (next === circuit.wires) return circuit;
  return { ...circuit, wires: next };
}

export function createComponent(
  circuit: Circuit,
  type: string,
  x: number,
  y: number,
  rotation: Rotation = 0,
  props: Props = {},
): ComponentInstance {
  const def = getDef(type);
  const base = def ? defaultProps(def) : {};
  return { id: componentIdGenerator(circuit)(), type, x, y, rotation, props: { ...base, ...props } };
}

export function addComponents(circuit: Circuit, comps: readonly ComponentInstance[], ctx: LayoutContext): Circuit {
  return withNormalizedWires({ ...circuit, components: [...circuit.components, ...comps] }, ctx);
}

export function addWires(circuit: Circuit, segments: readonly Segment[], ctx: LayoutContext): Circuit {
  const gen = wireIdGenerator(circuit);
  const added: Wire[] = segments
    .filter((s) => (s.x1 === s.x2) !== (s.y1 === s.y2))
    .map((s) => ({ id: gen(), x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }));
  if (added.length === 0) return circuit;
  return withNormalizedWires(circuit, ctx, [...circuit.wires, ...added]);
}

export function deleteItems(circuit: Circuit, componentIds: ReadonlySet<string>, wireIds: ReadonlySet<string>, ctx: LayoutContext): Circuit {
  if (componentIds.size === 0 && wireIds.size === 0) return circuit;
  const next: Circuit = {
    ...circuit,
    components: circuit.components.filter((c) => !componentIds.has(c.id)),
    wires: circuit.wires.filter((w) => !wireIds.has(w.id)),
  };
  return withNormalizedWires(next, ctx);
}

/**
 * Translate components and wires. With `rubberBand`, unselected wires whose
 * ends touch moving pins or moving wire ends follow them: fully attached
 * wires translate; wires attached at one end are re-routed orthogonally.
 */
export function moveItems(
  circuit: Circuit,
  componentIds: ReadonlySet<string>,
  wireIds: ReadonlySet<string>,
  dx: number,
  dy: number,
  ctx: LayoutContext,
  rubberBand = true,
): Circuit {
  if (dx === 0 && dy === 0) return circuit;
  const moving = new Set<number>();
  for (const c of circuit.components) {
    if (!componentIds.has(c.id)) continue;
    for (const p of resolveComponent(c, ctx).pins) moving.add(pointKey(p.x, p.y));
  }
  for (const w of circuit.wires) {
    if (!wireIds.has(w.id)) continue;
    moving.add(pointKey(w.x1, w.y1));
    moving.add(pointKey(w.x2, w.y2));
  }

  const components = circuit.components.map((c) => (componentIds.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c));
  const wires: Wire[] = [];
  const gen = wireIdGenerator(circuit);
  for (const w of circuit.wires) {
    const translated = { ...w, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy };
    if (wireIds.has(w.id)) {
      wires.push(translated);
      continue;
    }
    const aMoves = rubberBand && moving.has(pointKey(w.x1, w.y1));
    const bMoves = rubberBand && moving.has(pointKey(w.x2, w.y2));
    if (aMoves && bMoves) wires.push(translated);
    else if (aMoves) wires.push(...reroute(w, { x: w.x2, y: w.y2 }, { x: w.x1 + dx, y: w.y1 + dy }, gen));
    else if (bMoves) wires.push(...reroute(w, { x: w.x1, y: w.y1 }, { x: w.x2 + dx, y: w.y2 + dy }, gen));
    else wires.push(w);
  }
  return withNormalizedWires({ ...circuit, components }, ctx, wires);
}

/** Orthogonal path from a fixed end to a moved end, keeping the wire's original direction at both ends. */
function reroute(w: Wire, fixed: Point, moved: Point, gen: () => string): Wire[] {
  const horizontal = w.y1 === w.y2;
  const pts: Point[] = [fixed];
  if (horizontal && fixed.y !== moved.y) {
    const mx = Math.round((fixed.x + moved.x) / 2);
    pts.push({ x: mx, y: fixed.y }, { x: mx, y: moved.y });
  } else if (!horizontal && fixed.x !== moved.x) {
    const my = Math.round((fixed.y + moved.y) / 2);
    pts.push({ x: fixed.x, y: my }, { x: moved.x, y: my });
  }
  pts.push(moved);
  const out: Wire[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.x === b.x && a.y === b.y) continue;
    out.push({ id: out.length === 0 ? w.id : gen(), x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}

export function rotateComponents(circuit: Circuit, ids: ReadonlySet<string>, clockwise: boolean, ctx: LayoutContext): Circuit {
  if (ids.size === 0) return circuit;
  const components = circuit.components.map((c) => (ids.has(c.id) ? { ...c, rotation: nextRotation(c.rotation, clockwise) } : c));
  return withNormalizedWires({ ...circuit, components }, ctx);
}

export function setRotation(circuit: Circuit, ids: ReadonlySet<string>, rotation: Rotation, ctx: LayoutContext): Circuit {
  if (ids.size === 0) return circuit;
  const components = circuit.components.map((c) => (ids.has(c.id) && c.rotation !== rotation ? { ...c, rotation } : c));
  return withNormalizedWires({ ...circuit, components }, ctx);
}

export function setComponentProps(circuit: Circuit, id: string, changes: Readonly<Record<string, PropValue>>, ctx: LayoutContext): Circuit {
  const components = circuit.components.map((c) => (c.id === id ? { ...c, props: { ...c.props, ...changes } } : c));
  return withNormalizedWires({ ...circuit, components }, ctx);
}

/**
 * Copy components and wires into `circuit` with fresh ids, offset by (dx, dy).
 * Returns the new circuit and the ids of the copies.
 */
export function pasteItems(
  circuit: Circuit,
  comps: readonly ComponentInstance[],
  wires: readonly Wire[],
  dx: number,
  dy: number,
  ctx: LayoutContext,
): { circuit: Circuit; componentIds: string[]; wireIds: string[] } {
  const cgen = componentIdGenerator(circuit);
  const wgen = wireIdGenerator(circuit);
  const newComps = comps.map((c) => ({ ...c, id: cgen(), x: c.x + dx, y: c.y + dy }));
  const newWires = wires.map((w) => ({ id: wgen(), x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy }));
  const next = withNormalizedWires({ ...circuit, components: [...circuit.components, ...newComps] }, ctx, [...circuit.wires, ...newWires]);
  const wireIds = new Set(next.wires.map((w) => w.id));
  return { circuit: next, componentIds: newComps.map((c) => c.id), wireIds: newWires.map((w) => w.id).filter((id) => wireIds.has(id)) };
}

/* ------------------------------------------------------------------------ */
/* Project-level operations                                                  */
/* ------------------------------------------------------------------------ */

export function replaceCircuit(project: Project, circuit: Circuit): Project {
  return { ...project, circuits: project.circuits.map((c) => (c.id === circuit.id ? circuit : c)) };
}

export function addCircuit(project: Project, name: string): { project: Project; circuit: Circuit } {
  const id = idGenerator('circuit', project.circuits.map((c) => c.id))();
  const circuit: Circuit = { id, name, components: [], wires: [] };
  return { project: { ...project, circuits: [...project.circuits, circuit] }, circuit };
}

export function renameCircuit(project: Project, id: string, name: string): Project {
  return { ...project, circuits: project.circuits.map((c) => (c.id === id ? { ...c, name } : c)) };
}

/** Removes a circuit. Callers must first check it is unused (see hierarchy.usersOf). */
export function deleteCircuit(project: Project, id: string): Project {
  const circuits = project.circuits.filter((c) => c.id !== id);
  if (circuits.length === 0) return project;
  const mainCircuitId = project.mainCircuitId === id ? circuits[0].id : project.mainCircuitId;
  return { ...project, circuits, mainCircuitId };
}

export function uniqueCircuitName(project: Project, base: string): string {
  const names = new Set(project.circuits.map((c) => c.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
