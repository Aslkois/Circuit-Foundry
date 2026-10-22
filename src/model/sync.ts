import { strOf } from './catalog/index.ts';
import { wireIdGenerator } from './ids.ts';
import { projectContext, resolveComponent } from './layout.ts';
import { withNormalizedWires } from './edit.ts';
import { findRoute, isEnd, onSegment } from './route.ts';
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
    const r = rerouteMoves(circuit, moves, ctxAfter);
    rerouted += r.rerouted;
    disconnected.push(...r.failed.map((m) => ({ circuitId: circuit.id, componentId: m.componentId, port: m.port, reason: 'no-route' as const })));
    if (r.circuit !== circuit) {
      circuits ??= [...after.circuits];
      circuits[index] = r.circuit;
    }
  });

  return { project: circuits ? { ...after, circuits } : after, rerouted, disconnected };
}

function touchesWire(wires: readonly Wire[], p: Point): boolean {
  return wires.some((w) => onSegment(w, p.x, p.y));
}

function rerouteMoves(circuit: Circuit, moves: readonly PinMove[], ctx: ReturnType<typeof projectContext>): { circuit: Circuit; rerouted: number; failed: PinMove[] } {
  // Pins of the circuit after the edit; a route may only touch its own target pin.
  const pinKeys = new Set<number>();
  for (const c of circuit.components) for (const p of resolveComponent(c, ctx).pins) pinKeys.add(pointKey(p.x, p.y));
  const movedFrom = new Set(moves.map((m) => pointKey(m.from.x, m.from.y)));

  let wires: Wire[] = [...circuit.wires];
  // A wire ending on a moved pin, with nothing else meeting it there, is detached and re-routed from its far end.
  const plans: { move: PinMove; start: Point; lead: Wire | null; blocked?: boolean }[] = [];
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
  if (plans.length === 0) return { circuit, rerouted: 0, failed: [] };

  const gen = wireIdGenerator(circuit);
  const failed: PinMove[] = [];
  let rerouted = 0;
  for (const plan of plans) {
    const path = plan.blocked ? null : findRoute(plan.start, plan.move.to, plan.move.out, wires, pinKeys);
    if (!path) {
      if (plan.lead) wires.push(plan.lead);
      failed.push(plan.move);
      continue;
    }
    rerouted++;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const id = i === 0 && plan.lead ? plan.lead.id : gen();
      wires.push({ id, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  return { circuit: withNormalizedWires(circuit, ctx, wires), rerouted, failed };
}
