import { strOf, type LayoutContext } from './catalog/index.ts';
import { analyzeConnectivity, pinKey } from './connectivity.ts';
import { wireIdGenerator } from './ids.ts';
import { projectContext, resolveComponent } from './layout.ts';
import { withNormalizedWires } from './edit.ts';
import { connectTree, findRoute, isEnd, onSegment, segmentsClean } from './route.ts';
import { pointKey, type Circuit, type Point, type Project, type Wire } from './types.ts';

/*
 * Live synchronization of instances with their definitions.
 *
 * Editing a circuit's interface (adding, removing or relabelling ports,
 * moving them on the symbol, changing the symbol width or a parameter that
 * changes geometry) moves the pins of every instance of it. Instances are not
 * copies, so they pick up the new interface automatically; what needs care is
 * the wiring around them in other circuits. After each edit the wires that
 * ended on a moved pin are re-routed to its new position, so connections to
 * ports that still exist are preserved. A route is only accepted when it
 * touches nothing else, so re-routing never creates a new connection; when no
 * clean route exists the wire is left where it was and reported.
 */

export interface DisconnectedPort {
  readonly circuitId: string;
  readonly componentId: string;
  /** Port label (or id). */
  readonly port: string;
  readonly reason: 'removed' | 'no-route';
}

export interface SyncResult {
  readonly project: Project;
  /** Pins whose wiring was re-routed to a new position. */
  readonly rerouted: number;
  readonly disconnected: readonly DisconnectedPort[];
}

interface PinMove {
  readonly componentId: string;
  readonly port: string;
  readonly from: Point;
  readonly to: Point;
  /** Outward direction of the pin at its new position. */
  readonly out: Point;
}

/**
 * Re-route wiring around instances whose pins moved between `before` and
 * `after`. Only instances that kept their position and rotation are
 * considered (an edit that moves an instance re-routes its own wires).
 */
export function syncInstances(before: Project, after: Project): SyncResult {
  if (before === after) return { project: after, rerouted: 0, disconnected: [] };
  const beforeById = new Map(before.circuits.map((c) => [c.id, c]));
  const changed = new Set(after.circuits.filter((c) => beforeById.get(c.id) !== c).map((c) => c.id));
  if (changed.size === 0) return { project: after, rerouted: 0, disconnected: [] };

  const ctxBefore = projectContext(before);
  const ctxAfter = projectContext(after);
  let rerouted = 0;
  const disconnected: DisconnectedPort[] = [];
  let circuits: Circuit[] | null = null;

  after.circuits.forEach((circuit, index) => {
    const old = beforeById.get(circuit.id);
    if (!old) return;
    const oldComps = new Map(old.components.map((c) => [c.id, c]));
    const moves: PinMove[] = [];
    for (const comp of circuit.components) {
      if (comp.type !== 'subcircuit') continue;
      const target = strOf(comp.props, 'circuit');
      if (!changed.has(target) && comp === oldComps.get(comp.id)) continue;
      const prev = oldComps.get(comp.id);
      if (!prev || prev.type !== 'subcircuit' || prev.x !== comp.x || prev.y !== comp.y || prev.rotation !== comp.rotation) continue;
      if (ctxBefore.getInterface(strOf(prev.props, 'circuit'), prev.props) === ctxAfter.getInterface(target, comp.props)) continue;
      const was = resolveComponent(prev, ctxBefore);
      const now = resolveComponent(comp, ctxAfter);
      const newPins = new Map(now.pins.map((p) => [p.name, p]));
      for (const p of was.pins) {
        const q = newPins.get(p.name);
        const port = p.label ?? p.name;
        if (!q) {
          if (touchesWire(circuit.wires, p)) disconnected.push({ circuitId: circuit.id, componentId: comp.id, port, reason: 'removed' });
          continue;
        }
        if (q.x === p.x && q.y === p.y) continue;
        const b = now.bounds;
        const out = q.x < b.x ? { x: -1, y: 0 } : q.x > b.x + b.w ? { x: 1, y: 0 } : q.y < b.y ? { x: 0, y: -1 } : { x: 0, y: 1 };
        moves.push({ componentId: comp.id, port, from: { x: p.x, y: p.y }, to: { x: q.x, y: q.y }, out });
      }
    }
    if (moves.length === 0) return;
    let r = rerouteMoves(circuit, moves, ctxAfter);
    // Safety net: re-routing must never join nets that were separate. If it somehow would, detach instead.
    if (!keepsNetsApart(old, ctxBefore, r.circuit, ctxAfter)) r = detachMoves(circuit, moves, ctxAfter);
    rerouted += r.rerouted;
    disconnected.push(...r.failed.map((m) => ({ circuitId: circuit.id, componentId: m.componentId, port: m.port, reason: 'no-route' as const })));
    if (r.circuit !== circuit) {
      circuits ??= [...after.circuits];
      circuits[index] = r.circuit;
    }
  });

  return { project: circuits ? { ...after, circuits } : after, rerouted, disconnected };
}

/** True when no net of `next` contains pins that were on different nets in `prev` (pins matched by component and name). */
function keepsNetsApart(prev: Circuit, ctxPrev: LayoutContext, next: Circuit, ctxNext: LayoutContext): boolean {
  const before = analyzeConnectivity(prev, ctxPrev);
  const after = analyzeConnectivity(next, ctxNext);
  for (const net of after.nets) {
    let seen: number | undefined;
    for (const p of net.pins) {
      const n = before.pinNet.get(pinKey(p.componentId, p.pin));
      if (n === undefined) continue;
      if (seen === undefined) seen = n;
      else if (seen !== n) return false;
    }
  }
  return true;
}

/** Fallback: remove every wire touching a moved pin's new position, leaving those ports unconnected. */
function detachMoves(circuit: Circuit, moves: readonly PinMove[], ctx: LayoutContext): { circuit: Circuit; rerouted: number; failed: PinMove[] } {
  const wires = circuit.wires.filter((w) => !moves.some((m) => onSegment(w, m.to.x, m.to.y)));
  return { circuit: withNormalizedWires(circuit, ctx, wires), rerouted: 0, failed: [...moves] };
}

/** Wires connected to a point through shared ends (wires are normalized, so junctions are ends). */
function reachable(wires: readonly Wire[], from: Point): Set<Wire> {
  const byEnd = new Map<number, Wire[]>();
  for (const w of wires) {
    for (const k of [pointKey(w.x1, w.y1), pointKey(w.x2, w.y2)]) {
      const list = byEnd.get(k);
      if (list) list.push(w);
      else byEnd.set(k, [w]);
    }
  }
  const seen = new Set<Wire>();
  const stack = [pointKey(from.x, from.y)];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const k = stack.pop()!;
    if (visited.has(k)) continue;
    visited.add(k);
    for (const w of byEnd.get(k) ?? []) {
      if (seen.has(w)) continue;
      seen.add(w);
      stack.push(pointKey(w.x1, w.y1), pointKey(w.x2, w.y2));
    }
  }
  return seen;
}

function touchesWire(wires: readonly Wire[], p: Point): boolean {
  return wires.some((w) => onSegment(w, p.x, p.y));
}

function rerouteMoves(circuit: Circuit, moves: readonly PinMove[], ctx: LayoutContext): { circuit: Circuit; rerouted: number; failed: PinMove[] } {
  // Pins of the circuit after the edit; a route may only touch its own target pin.
  const pinKeys = new Set<number>();
  for (const c of circuit.components) for (const p of resolveComponent(c, ctx).pins) pinKeys.add(pointKey(p.x, p.y));
  const movedFrom = new Set(moves.map((m) => pointKey(m.from.x, m.from.y)));

  let wires: Wire[] = [...circuit.wires];
  // A wire ending on a moved pin, with nothing else meeting it there, is detached and re-routed from its far end.
  const plans: { move: PinMove; start: Point; lead: Wire | null; blocked?: boolean }[] = [];
  // (start and blocked may be updated by the detours below)
  for (const m of moves) {
    const at = wires.filter((w) => onSegment(w, m.from.x, m.from.y));
    if (at.length === 0) continue;
    const fromKey = pointKey(m.from.x, m.from.y);
    const otherPinThere = pinKeys.has(fromKey) && !moves.some((n) => pointKey(n.to.x, n.to.y) === fromKey);
    if (at.length === 1 && isEnd(at[0], m.from) && !otherPinThere) {
      const lead = at[0];
      const start = lead.x1 === m.from.x && lead.y1 === m.from.y ? { x: lead.x2, y: lead.y2 } : { x: lead.x1, y: lead.y1 };
      // A lead whose far end is another moved pin is handled when that pin is routed.
      if (movedFrom.has(pointKey(start.x, start.y))) {
        plans.push({ move: m, start: m.from, lead: null });
        continue;
      }
      wires = wires.filter((w) => w !== lead);
      plans.push({ move: m, start, lead });
    } else if (otherPinThere || !moves.some((n) => pointKey(n.to.x, n.to.y) === fromKey)) {
      // Several wires (or another component's pin) meet at the old position: keep them and bridge from there to the new pin.
      plans.push({ move: m, start: m.from, lead: null });
    } else {
      // Another port now sits where the junction was; bridging would short them.
      plans.push({ move: m, start: m.from, lead: null, blocked: true });
    }
  }
  // A pin that moved onto a wire joins that wire's net. Wires of other nets there are detoured around the new
  // pin position so the nets stay apart; a plan starting at that point continues from the detoured net.
  const detourFailed: PinMove[] = [];
  const genDetour = wireIdGenerator(circuit);
  const ownOf = new Map<PinMove, Set<Wire>>();
  for (const plan of plans) ownOf.set(plan.move, reachable(wires, plan.start));
  for (const m of moves) {
    const own = ownOf.get(m) ?? new Set<Wire>();
    const foreign = wires.filter((w) => onSegment(w, m.to.x, m.to.y) && !own.has(w));
    if (foreign.length === 0) continue;
    const ends: Point[] = [];
    for (const w of foreign) {
      for (const e of [
        { x: w.x1, y: w.y1 },
        { x: w.x2, y: w.y2 },
      ]) {
        if ((e.x !== m.to.x || e.y !== m.to.y) && !ends.some((q) => q.x === e.x && q.y === e.y)) ends.push(e);
      }
    }
    const rest = wires.filter((w) => !foreign.includes(w));
    const tree = connectTree(ends, rest, pinKeys);
    if (!tree) {
      // Keeping the nets apart matters more than keeping this wire whole: the other net is split and reported.
      detourFailed.push(m);
      wires = rest;
    } else {
      wires = [...rest, ...tree.map((t) => ({ id: genDetour(), ...t }))];
    }
    for (const plan of plans) {
      if (plan.move === m || plan.start.x !== m.to.x || plan.start.y !== m.to.y) continue;
      if (ends.length > 0 && tree) plan.start = ends[0];
      else plan.blocked = true;
    }
  }
  // Pins now sitting on their own net's wiring need no route.
  const satisfied = new Set<PinMove>();
  for (const plan of plans) {
    if (plan.blocked) continue;
    const touching = wires.filter((w) => onSegment(w, plan.move.to.x, plan.move.to.y));
    if (touching.length === 0) continue;
    const own = reachable(wires, plan.start);
    if (touching.every((w) => own.has(w))) satisfied.add(plan.move);
  }
  if (plans.length === 0 && detourFailed.length === 0 && wires.length === circuit.wires.length && wires.every((w, i) => w === circuit.wires[i])) {
    return { circuit, rerouted: 0, failed: [] };
  }

  type Plan = (typeof plans)[number];
  const base = wires;
  const todo = plans.filter((p) => !satisfied.has(p.move));
  const attempt = (order: readonly Plan[]) => {
    const gen = wireIdGenerator({ ...circuit, wires: base });
    const out: Wire[] = [...base];
    const failed: PinMove[] = [];
    let rerouted = satisfied.size;
    for (const plan of order) {
      const path = plan.blocked ? null : findRoute(plan.start, plan.move.to, plan.move.out, out, pinKeys);
      if (!path) {
        // Put the old lead back only where it now touches nothing but its own far end.
        if (plan.lead && segmentsClean([plan.lead], out, pinKeys, new Set([pointKey(plan.start.x, plan.start.y)]))) out.push(plan.lead);
        failed.push(plan.move);
        continue;
      }
      rerouted++;
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i];
        const b = path[i + 1];
        const id = i === 0 && plan.lead ? plan.lead.id : gen();
        out.push({ id, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
    return { wires: out, rerouted, failed };
  };
  // Routes can block each other (two ports swapping places): retry with the failed ones first.
  let best = attempt(todo);
  for (let i = 0; i < 3 && best.failed.length > 0; i++) {
    const failedSet = new Set(best.failed);
    const next = attempt([...todo.filter((p) => failedSet.has(p.move)), ...todo.filter((p) => !failedSet.has(p.move))]);
    if (next.failed.length >= best.failed.length) break;
    best = next;
  }
  return { circuit: withNormalizedWires(circuit, ctx, best.wires), rerouted: best.rerouted, failed: [...detourFailed, ...best.failed] };
}
