import { NetlistError, Simulator, findFeedbackLoops, fromUnsigned, logic, type LogicValue, type OscillationReport, type SimSnapshot } from '../../engine/index.ts';
import {
  compileProject,
  findCircuit,
  getDef,
  instanceAt,
  locateKey,
  type CompiledDesign,
  type Diagnostic,
  type InstanceNode,
  type Project,
} from '../../model/index.ts';

export type SimState = 'stable' | 'pending' | 'oscillating' | 'error';

export interface SimStatus {
  readonly state: SimState;
  readonly running: boolean;
  readonly autoPropagate: boolean;
  /** Clock ticks per second while running. */
  readonly tickRate: number;
  readonly time: number;
  readonly tick: number;
  readonly pendingEvents: number;
  /** Measured while running. */
  readonly ticksPerSecond: number;
  readonly eventsPerSecond: number;
  readonly compileMs: number;
  readonly nets: number;
  readonly primitives: number;
  readonly instances: number;
  readonly hasClocks: boolean;
  readonly oscillation: OscillationReport | null;
  readonly error: string | null;
}

export const TICK_RATES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 1024, 4096, 16384] as const;

const STATUS_INTERVAL_MS = 120;
const FRAME_BUDGET_MS = 10;
/** Events processed per settle call before yielding to the browser. */
const SETTLE_CHUNK_EVENTS = 1_000_000;

/**
 * Owns the compiled design and the engine instance for the editor.
 *
 * The design is recompiled synchronously whenever the project or the
 * simulation root changes. Simulator state (switch positions, latch and
 * register contents) is carried across recompiles by component key, so
 * editing a circuit does not reset it. Clock ticks run on animation frames
 * with a fixed time budget, independent of React rendering.
 */
export class SimulationHost {
  design: CompiledDesign;
  sim: Simulator;
  private project: Project;
  private rootId: string;
  private status: SimStatus;
  private readonly listeners = new Set<() => void>();
  private feedbackDiagnostics: Diagnostic[] = [];
  private runtimeDiagnostics: Diagnostic[] = [];
  private compileCount = 0;
  /** Simulator state of circuits that were simulated before, by root circuit id. */
  private readonly rootSnapshots = new Map<string, SimSnapshot>();

  private rafId = 0;
  private continuation: ReturnType<typeof setTimeout> | null = null;
  private lastFrame = 0;
  private tickAccumulator = 0;
  private lastStatusEmit = 0;
  private rateWindowStart = 0;
  private rateWindowTicks = 0;
  private rateWindowEvents = 0;

  constructor(project: Project, rootId: string) {
    this.project = project;
    this.rootId = rootId;
    this.status = {
      state: 'stable',
      running: false,
      autoPropagate: true,
      tickRate: 4,
      time: 0,
      tick: 0,
      pendingEvents: 0,
      ticksPerSecond: 0,
      eventsPerSecond: 0,
      compileMs: 0,
      nets: 0,
      primitives: 0,
      instances: 0,
      hasClocks: false,
      oscillation: null,
      error: null,
    };
    this.design = compileProject(project, rootId);
    this.sim = new Simulator({ nets: [], components: [] });
    this.recompile(null);
  }

  getStatus = (): SimStatus => this.status;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Changes whenever displayed values may have changed. */
  get valueVersion(): number {
    return this.sim.valueVersion * 1024 + this.compileCount;
  }

  /** Static diagnostics from compilation plus feedback-loop notes and runtime problems. */
  get diagnostics(): Diagnostic[] {
    return [...this.runtimeDiagnostics, ...this.design.diagnostics, ...this.feedbackDiagnostics];
  }

  /**
   * Recompile if the project or root changed. Switching the simulated circuit
   * keeps the state of the one being left, and restores it when it comes back.
   */
  sync(project: Project, rootId: string): void {
    if (project === this.project && rootId === this.rootId) return;
    const nextRoot = findCircuit(project, rootId) ? rootId : project.mainCircuitId;
    if (project.id !== this.project.id) this.rootSnapshots.clear();
    let restore: SimSnapshot | null = null;
    if (nextRoot !== this.rootId) {
      this.rootSnapshots.set(this.rootId, this.sim.exportState());
      restore = this.rootSnapshots.get(nextRoot) ?? null;
    } else if (project.id === this.project.id) {
      restore = this.sim.exportState();
    }
    this.project = project;
    this.rootId = nextRoot;
    this.recompile(restore);
  }

  private recompile(previous: SimSnapshot | null): void {
    const t0 = performance.now();
    this.design = compileProject(this.project, this.rootId);
    let error: string | null = null;
    try {
      this.sim = new Simulator(this.design.netlist);
    } catch (e) {
      // The compiler only emits valid netlists; this is a safety net, not a user-facing path.
      error = e instanceof NetlistError ? e.message : String(e);
      this.sim = new Simulator({ nets: [], components: [] });
    }
    if (previous) this.sim.importState(previous);
    this.compileCount++;
    this.feedbackDiagnostics = this.describeFeedback();
    const compileMs = performance.now() - t0;
    this.patch({
      compileMs,
      nets: this.sim.netCount,
      primitives: this.sim.componentCount,
      instances: this.design.instanceCount,
      hasClocks: this.sim.hasClocks,
      error,
      oscillation: null,
    });
    if (this.status.autoPropagate) this.settle();
    else this.refreshState(true);
    if (this.status.running && !this.sim.hasClocks) this.setRunning(false);
  }

  /* -------------------------------------------------------------------- */
  /* Controls                                                             */
  /* -------------------------------------------------------------------- */

  /**
   * Settle, yielding to the browser between chunks of work so a very large or
   * glitch-heavy design keeps the editor responsive ("Propagating…").
   */
  settle(): void {
    const r = this.sim.settle({ maxEvents: SETTLE_CHUNK_EVENTS });
    if (r.incomplete) {
      this.refreshState(true);
      if (!this.continuation) {
        this.continuation = setTimeout(() => {
          this.continuation = null;
          if (this.status.autoPropagate && !this.sim.isSettled) this.settle();
        }, 0);
      }
      return;
    }
    this.afterSettle(r.stable, r.oscillation ?? null);
  }

  private afterSettle(stable: boolean, oscillation: OscillationReport | null): void {
    if (!stable && oscillation) {
      this.runtimeDiagnostics = [this.describeOscillation(oscillation)];
      if (this.status.running) this.stopLoop();
      this.patch({ state: 'oscillating', oscillation, running: false }, true);
    } else {
      this.runtimeDiagnostics = [];
      this.refreshState(true);
    }
  }

  private refreshState(force: boolean): void {
    const state: SimState = this.status.error ? 'error' : this.sim.isSettled ? 'stable' : this.status.state === 'oscillating' ? 'oscillating' : 'pending';
    this.patch(
      {
        state,
        oscillation: state === 'oscillating' ? this.status.oscillation : null,
        time: this.sim.time,
        tick: this.sim.tickCount,
        pendingEvents: this.sim.pendingEvents,
      },
      force,
    );
  }

  /** One clock tick (half a period of a 1:1 clock). */
  tickOnce(): void {
    this.sim.tick();
    if (this.status.autoPropagate) this.settle();
    else this.refreshState(true);
  }

  /** Process the next pending time step (manual propagation). */
  step(): void {
    if (this.sim.isSettled) return;
    this.sim.step();
    this.patch({ state: this.sim.isSettled ? 'stable' : 'pending' });
    this.refreshState(true);
  }

  /** Power-on reset: clears all state including switch positions. */
  reset(): void {
    this.sim.reset();
    this.runtimeDiagnostics = [];
    this.patch({ oscillation: null, state: 'stable' });
    if (this.status.autoPropagate) this.settle();
    else this.refreshState(true);
  }

  setAutoPropagate(on: boolean): void {
    if (on === this.status.autoPropagate) return;
    if (!on && this.status.running) this.setRunning(false);
    this.patch({ autoPropagate: on }, true);
    if (on) this.settle();
  }

  setTickRate(rate: number): void {
    this.patch({ tickRate: rate }, true);
  }

  setRunning(running: boolean): void {
    if (running === this.status.running) return;
    if (running) {
      if (!this.status.autoPropagate || !this.sim.hasClocks) return;
      if (this.status.state === 'oscillating') return;
      this.patch({ running: true }, true);
      this.lastFrame = performance.now();
      this.tickAccumulator = 1; // first tick immediately
      this.rateWindowStart = this.lastFrame;
      this.rateWindowTicks = 0;
      this.rateWindowEvents = this.sim.stats.events;
      this.rafId = requestAnimationFrame(this.frame);
    } else {
      this.stopLoop();
      this.patch({ running: false, ticksPerSecond: 0, eventsPerSecond: 0 }, true);
    }
  }

  private stopLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private frame = (now: number): void => {
    if (!this.status.running) return;
    const dt = Math.min(now - this.lastFrame, 250) / 1000;
    this.lastFrame = now;
    this.tickAccumulator += dt * this.status.tickRate;
    const due = Math.floor(this.tickAccumulator);
    this.tickAccumulator -= due;
    const deadline = performance.now() + FRAME_BUDGET_MS;
    if (!this.sim.isSettled) {
      // Still propagating the previous tick: no new edges until it settles.
      this.settle();
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }
    for (let i = 0; i < due; i++) {
      this.sim.tick();
      const r = this.sim.settle({ maxEvents: SETTLE_CHUNK_EVENTS });
      if (r.incomplete) break;
      this.rateWindowTicks++;
      if (!r.stable) {
        this.afterSettle(false, r.oscillation ?? null);
        return;
      }
      if (performance.now() > deadline) {
        this.tickAccumulator = 0; // cannot keep up: run as fast as the budget allows
        break;
      }
    }
    if (now - this.rateWindowStart >= 1000) {
      const secs = (now - this.rateWindowStart) / 1000;
      this.patch({
        ticksPerSecond: this.rateWindowTicks / secs,
        eventsPerSecond: (this.sim.stats.events - this.rateWindowEvents) / secs,
      });
      this.rateWindowStart = now;
      this.rateWindowTicks = 0;
      this.rateWindowEvents = this.sim.stats.events;
    }
    this.refreshState(false);
    this.rafId = requestAnimationFrame(this.frame);
  };

  /* -------------------------------------------------------------------- */
  /* Stimulus                                                             */
  /* -------------------------------------------------------------------- */

  /** Engine key of a user-controllable source (top-level input pin, or any push button). */
  sourceKey(path: readonly string[], componentId: string): string | null {
    const node = instanceAt(this.design, path);
    const key = node?.keys.get(componentId);
    if (!key) return null;
    const ci = this.sim.componentIndex(key);
    if (ci < 0 || this.sim.component(ci).kind !== 'input') return null;
    return key;
  }

  getSource(path: readonly string[], componentId: string): LogicValue | null {
    const key = this.sourceKey(path, componentId);
    return key ? this.sim.getInput(key) : null;
  }

  setSource(path: readonly string[], componentId: string, value: LogicValue): boolean {
    const key = this.sourceKey(path, componentId);
    if (!key) return false;
    this.sim.setInput(key, value);
    if (this.status.autoPropagate) this.settle();
    else this.refreshState(true);
    return true;
  }

  /** Toggle one bit of an input pin. Floating or unknown bits become 1. */
  toggleBit(path: readonly string[], componentId: string, bit: number): boolean {
    const v = this.getSource(path, componentId);
    if (!v) return false;
    const m = 1 << bit;
    const known = (v.b & m) === 0;
    const a = known ? v.a ^ m : v.a | m;
    return this.setSource(path, componentId, logic(v.width, a, v.b & ~m));
  }

  setButton(path: readonly string[], componentId: string, pressed: boolean): boolean {
    return this.setSource(path, componentId, fromUnsigned(1, pressed ? 1 : 0));
  }

  /* -------------------------------------------------------------------- */
  /* Values for display                                                   */
  /* -------------------------------------------------------------------- */

  nodeAt(path: readonly string[]): InstanceNode | null {
    return instanceAt(this.design, path);
  }

  netValue(node: InstanceNode, localNet: number): LogicValue {
    return this.sim.getNet(node.netMap[localNet]);
  }

  netContended(node: InstanceNode, localNet: number): boolean {
    return this.sim.netContention[node.netMap[localNet]] !== 0;
  }

  /** Value at a component pin in the instance at `path` (automation and tests). */
  valueAt(path: readonly string[], componentId: string, pin: string): LogicValue | null {
    const node = this.nodeAt(path);
    const net = node?.connectivity.pinNet.get(`${componentId}:${pin}`);
    return node && net !== undefined ? this.netValue(node, net) : null;
  }

  /** Internal state of a primitive-backed component (register contents etc.). */
  componentState(node: InstanceNode, componentId: string): unknown {
    const key = node.keys.get(componentId);
    return key ? this.sim.componentState(key) : undefined;
  }

  /* -------------------------------------------------------------------- */

  private patch(p: Partial<SimStatus>, force = true): void {
    this.status = { ...this.status, ...p };
    const now = performance.now();
    if (!force && now - this.lastStatusEmit < STATUS_INTERVAL_MS) return;
    this.lastStatusEmit = now;
    for (const fn of this.listeners) fn();
  }

  private describeOscillation(o: OscillationReport): Diagnostic {
    // Group by circuit definition; report the shallowest instance.
    let best: { circuitId: string; ids: string[]; depth: number } | null = null;
    const groups = new Map<string, { circuitId: string; ids: Set<string>; depth: number }>();
    for (const key of o.componentKeys) {
      const loc = locateKey(this.design, key);
      if (!loc) continue;
      const k = loc.node.prefix;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { circuitId: loc.node.circuit.id, ids: new Set(), depth: loc.node.path.length }));
      g.ids.add(loc.componentId);
    }
    for (const g of groups.values()) {
      if (!best || g.depth < best.depth) best = { circuitId: g.circuitId, ids: [...g.ids], depth: g.depth };
    }
    const circuitId = best?.circuitId ?? this.rootId;
    const circuit = findCircuit(this.project, circuitId);
    return {
      severity: 'error',
      code: 'oscillation',
      message: `The circuit does not settle: ${o.componentKeys.length} component(s) keep changing${circuit ? ` (in "${circuit.name}")` : ''}. It is paused at time ${o.time}. Fix the feedback loop or press Reset.`,
      circuitId,
      componentIds: best?.ids ?? [],
    };
  }

  private describeFeedback(): Diagnostic[] {
    if (this.sim.componentCount > 200_000) return [];
    const seen = new Set<string>();
    const out: Diagnostic[] = [];
    for (const loop of findFeedbackLoops(this.sim)) {
      const byCircuit = new Map<string, Set<string>>();
      for (const ci of loop) {
        const loc = locateKey(this.design, this.sim.component(ci).key);
        if (!loc) continue;
        const cid = loc.node.circuit.id;
        let s = byCircuit.get(cid);
        if (!s) byCircuit.set(cid, (s = new Set()));
        s.add(loc.componentId);
      }
      for (const [circuitId, ids] of byCircuit) {
        const sig = `${circuitId}:${[...ids].sort().join(',')}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        const names = [...ids].map((id) => {
          const c = findCircuit(this.project, circuitId)?.components.find((x) => x.id === id);
          return c ? (getDef(c.type)?.name ?? c.type) : id;
        });
        out.push({
          severity: 'info',
          code: 'feedback-loop',
          message: `Feedback loop through ${ids.size} gate(s) (${names.join(', ')}). Loops like this can store a bit (a latch) or oscillate.`,
          circuitId,
          componentIds: [...ids],
        });
      }
    }
    return out;
  }

  dispose(): void {
    this.stopLoop();
    if (this.continuation) clearTimeout(this.continuation);
    this.listeners.clear();
  }
}
