import { contentionBits, isValidWidth, logic, resolveA, resolveB, widthMask, type LogicValue } from './logic.ts';
import { NetlistError, type Netlist, type NetlistComponent } from './netlist.ts';
import { defaultLibrary } from './primitives/index.ts';
import { InputBehavior } from './primitives/sources.ts';
import type { Behavior, EvalContext, PinSpec, PrimitiveLibrary, PrimitiveSpec } from './primitives/types.ts';
import { EventQueue, type Bucket } from './scheduler.ts';

/*
 * Event-driven, four-state, discrete-time logic simulator.
 *
 * Time advances in integer gate-delay units. Each step processes every event
 * scheduled for the earliest pending time in three phases:
 *
 *   1. apply   – update the driver values carried by the events;
 *   2. resolve – recompute each affected net from all of its drivers
 *                (wired resolution: Z yields, conflicting known values give X);
 *   3. evaluate – re-run every component reading a changed net. Behaviours
 *                read the now-fixed net values and schedule output changes at
 *                least one time unit ahead.
 *
 * Because every evaluation in a step sees the same net snapshot and can only
 * affect the future, results never depend on evaluation order, and each step
 * does bounded work (no recursion). `settle` repeats steps until no events
 * remain or a work limit is hit, which is reported as oscillation.
 *
 * Clocks are not tied to propagation time: `tick` advances all clocks by one
 * tick, after which the caller settles the circuit again.
 */

export interface SimulatorOptions {
  library?: PrimitiveLibrary;
  /** settle() reports oscillation after this many steps (default 100 000). */
  maxSettleSteps?: number;
  /** ...or after processing this many events (default: unlimited). */
  maxSettleEvents?: number;
  /**
   * Evaluate built-in gates inline from flat arrays (default true). Turning
   * this off routes every component through its Behavior object; results are
   * identical, which the test suite checks.
   */
  fastKernels?: boolean;
}

const OP_NONE = 0;
const OP_AND = 1;
const OP_OR = 2;
const OP_XOR = 3;
const OP_BUFFER = 4;
const KERNEL_OPS = { and: OP_AND, or: OP_OR, xor: OP_XOR, buffer: OP_BUFFER } as const;

export interface OscillationReport {
  /** Components that kept being re-evaluated, by key (sorted). */
  componentKeys: string[];
  /** Nets that kept changing (sorted). */
  nets: number[];
  /** Simulation time at which the report was taken. */
  time: number;
}

export interface SettleResult {
  /** No events remain. */
  stable: boolean;
  steps: number;
  events: number;
  /** The circuit kept changing past the step limit: it oscillates (or is pathologically deep). */
  oscillation?: OscillationReport;
  /** The per-call work budget ran out first; call settle() again to continue. */
  incomplete?: boolean;
}

export interface SettleBudget {
  /** Stop (with `incomplete`) after processing this many events in this call. */
  maxEvents?: number;
}

export interface SimStats {
  /** Time steps processed. */
  steps: number;
  /** Scheduled driver updates processed. */
  events: number;
  /** Component evaluations. */
  evaluations: number;
}

export interface SimSnapshot {
  readonly time: number;
  readonly tick: number;
  /** Per component key: behaviour state and driven output values ([width, a, b] per pin name). */
  readonly components: Readonly<
    Record<string, { readonly state?: unknown; readonly out?: Readonly<Record<string, readonly [number, number, number]>> }>
  >;
}

export interface ComponentInfo {
  readonly key: string;
  readonly type: string;
  readonly kind: PrimitiveSpec['kind'];
  readonly sequential: boolean;
  readonly pins: readonly PinSpec[];
  /** Net index per pin. */
  readonly pinNets: Int32Array;
}

/** Per-component evaluation context; reads and writes go straight to simulator arrays. */
class ComponentRuntime implements EvalContext, ComponentInfo {
  readonly key: string;
  readonly type: string;
  readonly kind: PrimitiveSpec['kind'];
  readonly sequential: boolean;
  readonly spec: PrimitiveSpec;
  readonly source: NetlistComponent;
  readonly pins: readonly PinSpec[];
  readonly pinNets: Int32Array;
  readonly pinSlots: Int32Array;
  readonly delay: number;
  behavior: Behavior;
  private readonly sim: Simulator;
  // Direct references to the simulator's value arrays (one hop fewer on every read).
  private readonly netA: Int32Array;
  private readonly netB: Int32Array;

  constructor(sim: Simulator, source: NetlistComponent, spec: PrimitiveSpec, pins: PinSpec[], pinNets: Int32Array, pinSlots: Int32Array) {
    this.sim = sim;
    this.netA = sim.netA;
    this.netB = sim.netB;
    this.source = source;
    this.key = source.key;
    this.type = source.type;
    this.kind = spec.kind;
    this.sequential = spec.sequential;
    this.spec = spec;
    this.pins = pins;
    this.pinNets = pinNets;
    this.pinSlots = pinSlots;
    const d = source.props.delay;
    this.delay = typeof d === 'number' && Number.isInteger(d) && d >= 1 ? d : Math.max(1, spec.delay);
    this.behavior = spec.create(source.props);
  }

  get time(): number {
    return this.sim.time;
  }

  get tick(): number {
    return this.sim.tickCount;
  }

  a(pin: number): number {
    return this.netA[this.pinNets[pin]];
  }

  b(pin: number): number {
    return this.netB[this.pinNets[pin]];
  }

  out(pin: number, a: number, b: number): void {
    const slot = this.pinSlots[pin];
    if (slot >= 0) this.sim.drive(slot, a, b, this.delay);
  }
}

const OSCILLATION_SAMPLE_STEPS = 64;

export class Simulator {
  readonly library: PrimitiveLibrary;
  readonly netCount: number;
  /** Number of nets supplied by the netlist (extra internal nets follow for unconnected pins). */
  readonly externalNetCount: number;
  readonly netWidth: Uint8Array;
  /** Resolved net values (value bits). Read-only for callers. */
  readonly netA: Int32Array;
  /** Resolved net values (unknown/floating bits). Read-only for callers. */
  readonly netB: Int32Array;
  /** Bits on which known drivers currently disagree, per net. */
  readonly netContention: Int32Array;

  /** Current simulation time in gate-delay units. */
  time = 0;
  /** Clock ticks since reset. */
  tickCount = 0;
  /** Incremented whenever any net value changes; cheap change detection for observers. */
  valueVersion = 0;
  readonly stats: SimStats = { steps: 0, events: 0, evaluations: 0 };

  private readonly maxSettleSteps: number;
  private readonly maxSettleEvents: number;
  private readonly netMask: Int32Array;
  private readonly comps: ComponentRuntime[] = [];
  private readonly byKey = new Map<string, number>();
  private readonly clockComps: number[] = [];

  // Driver slots (one per output/inout pin).
  private readonly slotNet: Int32Array;
  private readonly slotMask: Int32Array;
  private readonly slotComp: Int32Array;
  private readonly slotPin: Int32Array;
  private readonly drvA: Int32Array;
  private readonly drvB: Int32Array;
  private readonly projA: Int32Array;
  private readonly projB: Int32Array;

  // CSR adjacency: drivers and readers per net.
  private readonly netDrvStart: Int32Array;
  private readonly netDrvSlots: Int32Array;
  private readonly netRdrStart: Int32Array;
  private readonly netRdrComps: Int32Array;

  // Bit-level threads for nets joined by bit links (splitters). -1 = word-level net.
  private readonly netThreadBase: Int32Array;
  private readonly bitThread: Int32Array;
  private readonly threadDrvStart: Int32Array;
  private readonly threadDrvSlot: Int32Array;
  private readonly threadDrvBit: Int32Array;
  private readonly threadLocStart: Int32Array;
  private readonly threadLocNet: Int32Array;
  private readonly threadLocBit: Int32Array;

  // Per-step work lists.
  private readonly queue = new EventQueue();
  private readonly netPending: Uint8Array;
  private readonly pendingNets: Int32Array;
  private pendingNetCount = 0;
  private readonly threadPending: Uint8Array;
  private readonly pendingThreads: Int32Array;
  private pendingThreadCount = 0;
  private readonly netChanged: Uint8Array;
  private readonly changedNets: Int32Array;
  private changedNetCount = 0;
  private readonly compDirty: Uint8Array;
  private readonly dirtyComps: Int32Array;
  private dirtyCount = 0;

  // Inline gate kernels (see GateKernel): per-component op, inputs and output.
  private readonly kOp: Uint8Array;
  private readonly kNeg: Uint8Array;
  private readonly kIn: Uint8Array;
  private readonly kPinStart: Int32Array;
  private readonly kPins: Int32Array;
  private readonly kOut: Int32Array;
  private readonly kMask: Int32Array;
  private readonly kDelay: Int32Array;

  /** Consecutive steps since the queue was last empty or the last external stimulus (oscillation detection). */
  private unsettledSteps = 0;

  private traceNets: Set<number> | null = null;
  private traceComps: Set<number> | null = null;

  constructor(netlist: Netlist, options: SimulatorOptions = {}) {
    this.library = options.library ?? defaultLibrary;
    this.maxSettleSteps = options.maxSettleSteps ?? 100_000;
    this.maxSettleEvents = options.maxSettleEvents ?? Infinity;

    const errors: string[] = [];
    const fail = (msg: string) => {
      if (errors.length < 20) errors.push(msg);
    };

    // ---- nets ---------------------------------------------------------------
    const widths: number[] = [];
    netlist.nets.forEach((n, i) => {
      if (!isValidWidth(n.width)) fail(`net ${i}: invalid width ${String(n.width)}`);
      widths.push(isValidWidth(n.width) ? n.width : 1);
    });
    this.externalNetCount = widths.length;

    // ---- components -----------------------------------------------------------
    interface Pending {
      source: NetlistComponent;
      spec: PrimitiveSpec;
      pins: PinSpec[];
      pinNets: Int32Array;
    }
    const pending: Pending[] = [];
    for (const c of netlist.components) {
      const label = `component "${c.key}" (${c.type})`;
      if (this.byKey.has(c.key)) {
        fail(`duplicate component key "${c.key}"`);
        continue;
      }
      const spec = this.library.get(c.type);
      if (!spec) {
        fail(`${label}: unknown primitive type`);
        continue;
      }
      const propError = spec.validate(c.props);
      if (propError) {
        fail(`${label}: ${propError}`);
        continue;
      }
      const pins = spec.pins(c.props);
      if (pins.length !== c.pins.length) {
        fail(`${label}: expected ${pins.length} pin connections, got ${c.pins.length}`);
        continue;
      }
      const pinNets = new Int32Array(pins.length);
      for (let p = 0; p < pins.length; p++) {
        let n = c.pins[p];
        if (n === -1) {
          widths.push(pins[p].width);
          n = widths.length - 1;
        } else if (!Number.isInteger(n) || n < 0 || n >= this.externalNetCount) {
          fail(`${label}: pin ${pins[p].name} references missing net ${n}`);
          n = 0;
        } else if (widths[n] !== pins[p].width) {
          fail(`${label}: pin ${pins[p].name} is ${pins[p].width} bit(s) but net ${n} is ${widths[n]} bit(s)`);
        }
        pinNets[p] = n;
      }
      this.byKey.set(c.key, pending.length);
      pending.push({ source: c, spec, pins, pinNets });
    }

    const links = netlist.links ?? [];
    links.forEach((l, i) => {
      for (const [net, bit] of [
        [l.netA, l.bitA],
        [l.netB, l.bitB],
      ]) {
        if (!Number.isInteger(net) || net < 0 || net >= this.externalNetCount) fail(`link ${i}: missing net ${net}`);
        else if (!Number.isInteger(bit) || bit < 0 || bit >= widths[net]) fail(`link ${i}: bit ${bit} out of range for net ${net}`);
      }
    });

    if (errors.length > 0) throw new NetlistError(`Invalid netlist:\n  ${errors.join('\n  ')}`);

    // ---- net arrays --------------------------------------------------------------
    const netCount = widths.length;
    this.netCount = netCount;
    this.netWidth = Uint8Array.from(widths);
    this.netMask = Int32Array.from(widths, widthMask);
    this.netA = new Int32Array(netCount);
    this.netB = new Int32Array(netCount);
    this.netContention = new Int32Array(netCount);
    this.netPending = new Uint8Array(netCount);
    this.pendingNets = new Int32Array(netCount);
    this.netChanged = new Uint8Array(netCount);
    this.changedNets = new Int32Array(netCount);

    // ---- driver slots ----------------------------------------------------------
    let slotCount = 0;
    for (const p of pending) for (const pin of p.pins) if (pin.dir !== 'in') slotCount++;
    this.slotNet = new Int32Array(slotCount);
    this.slotMask = new Int32Array(slotCount);
    this.slotComp = new Int32Array(slotCount);
    this.slotPin = new Int32Array(slotCount);
    this.drvA = new Int32Array(slotCount);
    this.drvB = new Int32Array(slotCount);
    this.projA = new Int32Array(slotCount);
    this.projB = new Int32Array(slotCount);

    const drvCount = new Int32Array(netCount + 1);
    const rdrCount = new Int32Array(netCount + 1);
    const lastReader = new Int32Array(netCount).fill(-1);
    let slot = 0;
    pending.forEach((p, ci) => {
      const pinSlots = new Int32Array(p.pins.length).fill(-1);
      p.pins.forEach((pin, pi) => {
        const n = p.pinNets[pi];
        if (pin.dir !== 'in') {
          pinSlots[pi] = slot;
          this.slotNet[slot] = n;
          this.slotMask[slot] = this.netMask[n];
          this.slotComp[slot] = ci;
          this.slotPin[slot] = pi;
          drvCount[n]++;
          slot++;
        }
        if (pin.dir !== 'out' && lastReader[n] !== ci) {
          lastReader[n] = ci;
          rdrCount[n]++;
        }
      });
      const rt = new ComponentRuntime(this, p.source, p.spec, p.pins, p.pinNets, pinSlots);
      this.comps.push(rt);
      if (p.spec.kind === 'clock') this.clockComps.push(ci);
    });

    this.netDrvStart = prefixSum(drvCount);
    this.netRdrStart = prefixSum(rdrCount);
    this.netDrvSlots = new Int32Array(slotCount);
    this.netRdrComps = new Int32Array(this.netRdrStart[netCount]);
    {
      const fillD = this.netDrvStart.slice(0, netCount);
      for (let s = 0; s < slotCount; s++) this.netDrvSlots[fillD[this.slotNet[s]]++] = s;
      const fillR = this.netRdrStart.slice(0, netCount);
      lastReader.fill(-1);
      this.comps.forEach((c, ci) => {
        c.pins.forEach((pin, pi) => {
          const n = c.pinNets[pi];
          if (pin.dir !== 'out' && lastReader[n] !== ci) {
            lastReader[n] = ci;
            this.netRdrComps[fillR[n]++] = ci;
          }
        });
      });
    }

    // ---- bit threads for linked nets -----------------------------------------------
    this.netThreadBase = new Int32Array(netCount).fill(-1);
    let totalBits = 0;
    for (const l of links) {
      for (const n of [l.netA, l.netB]) {
        if (this.netThreadBase[n] < 0) {
          this.netThreadBase[n] = totalBits;
          totalBits += widths[n];
        }
      }
    }
    const parent = new Int32Array(totalBits);
    for (let i = 0; i < totalBits; i++) parent[i] = i;
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (const l of links) {
      const x = find(this.netThreadBase[l.netA] + l.bitA);
      const y = find(this.netThreadBase[l.netB] + l.bitB);
      if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
    }
    this.bitThread = new Int32Array(totalBits);
    const threadId = new Int32Array(totalBits).fill(-1);
    let threadCount = 0;
    for (let i = 0; i < totalBits; i++) {
      const r = find(i);
      if (threadId[r] < 0) threadId[r] = threadCount++;
      this.bitThread[i] = threadId[r];
    }
    const tDrv = new Int32Array(threadCount + 1);
    const tLoc = new Int32Array(threadCount + 1);
    for (let n = 0; n < netCount; n++) {
      const base = this.netThreadBase[n];
      if (base < 0) continue;
      const nd = this.netDrvStart[n + 1] - this.netDrvStart[n];
      for (let bit = 0; bit < widths[n]; bit++) {
        const t = this.bitThread[base + bit];
        tLoc[t]++;
        tDrv[t] += nd;
      }
    }
    this.threadDrvStart = prefixSum(tDrv);
    this.threadLocStart = prefixSum(tLoc);
    this.threadDrvSlot = new Int32Array(this.threadDrvStart[threadCount]);
    this.threadDrvBit = new Int32Array(this.threadDrvStart[threadCount]);
    this.threadLocNet = new Int32Array(this.threadLocStart[threadCount]);
    this.threadLocBit = new Int32Array(this.threadLocStart[threadCount]);
    {
      const fillD = this.threadDrvStart.slice(0, threadCount);
      const fillL = this.threadLocStart.slice(0, threadCount);
      for (let n = 0; n < netCount; n++) {
        const base = this.netThreadBase[n];
        if (base < 0) continue;
        for (let bit = 0; bit < widths[n]; bit++) {
          const t = this.bitThread[base + bit];
          this.threadLocNet[fillL[t]] = n;
          this.threadLocBit[fillL[t]++] = bit;
          for (let k = this.netDrvStart[n]; k < this.netDrvStart[n + 1]; k++) {
            this.threadDrvSlot[fillD[t]] = this.netDrvSlots[k];
            this.threadDrvBit[fillD[t]++] = bit;
          }
        }
      }
    }
    this.threadPending = new Uint8Array(threadCount);
    this.pendingThreads = new Int32Array(threadCount);

    this.compDirty = new Uint8Array(this.comps.length);
    this.dirtyComps = new Int32Array(this.comps.length);

    // ---- inline gate kernels ------------------------------------------------------
    const nc = this.comps.length;
    this.kOp = new Uint8Array(nc);
    this.kNeg = new Uint8Array(nc);
    this.kIn = new Uint8Array(nc);
    this.kPinStart = new Int32Array(nc);
    this.kOut = new Int32Array(nc);
    this.kMask = new Int32Array(nc);
    this.kDelay = new Int32Array(nc);
    const kernelPins: number[] = [];
    if (options.fastKernels ?? true) {
      this.comps.forEach((c, ci) => {
        const k = c.spec.kernel;
        const last = c.pins.length - 1;
        // Kernels need inputs first and a single output last.
        if (!k || last < 1 || c.pins[last].dir !== 'out' || c.pins.slice(0, last).some((p) => p.dir !== 'in')) return;
        this.kOp[ci] = KERNEL_OPS[k.op];
        this.kNeg[ci] = k.negate ? 1 : 0;
        this.kIn[ci] = last;
        this.kPinStart[ci] = kernelPins.length;
        for (let p = 0; p < last; p++) kernelPins.push(c.pinNets[p]);
        this.kOut[ci] = c.pinSlots[last];
        this.kMask[ci] = this.netMask[c.pinNets[last]];
        this.kDelay[ci] = c.delay;
      });
    }
    this.kPins = Int32Array.from(kernelPins);

    this.reset();
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                             */
  /* ---------------------------------------------------------------------- */

  get componentCount(): number {
    return this.comps.length;
  }

  /** Number of events waiting to be processed. Zero means the circuit is settled. */
  get pendingEvents(): number {
    return this.queue.size;
  }

  get isSettled(): boolean {
    return this.queue.isEmpty;
  }

  /** Time of the next pending event, or Infinity. */
  get nextEventTime(): number {
    return this.queue.peekTime();
  }

  component(index: number): ComponentInfo {
    return this.comps[index];
  }

  componentIndex(key: string): number {
    return this.byKey.get(key) ?? -1;
  }

  /**
   * Restore power-on state: every net floats, every driver is released,
   * components get fresh behaviour state, and every component is evaluated
   * once at time 0. Call settle() afterwards to propagate.
   */
  reset(): void {
    this.queue.clear();
    this.unsettledSteps = 0;
    this.time = 0;
    this.tickCount = 0;
    this.valueVersion++;
    for (let n = 0; n < this.netCount; n++) {
      this.netA[n] = 0;
      this.netB[n] = this.netMask[n];
      this.netContention[n] = 0;
    }
    for (let s = 0; s < this.slotNet.length; s++) {
      this.drvA[s] = this.projA[s] = 0;
      this.drvB[s] = this.projB[s] = this.slotMask[s];
    }
    for (const c of this.comps) c.behavior = c.spec.create(c.source.props);
    this.evaluateAll();
  }

  /** Process the earliest pending time step. Returns false when nothing was pending. */
  step(): boolean {
    const bucket = this.queue.pop();
    if (!bucket) return false;
    this.time = bucket.time;
    this.stats.events += bucket.length;
    // The phases are separate methods whose hot loops are followed only by a
    // return: V8 optimizes long loops on-stack, and code after such a loop
    // that has not run yet would otherwise force a deoptimization.
    this.pendingNetCount = this.applyEvents(bucket, this.pendingNetCount);
    this.queue.release(bucket);
    this.resolvePending(this.pendingNetCount);
    this.pendingNetCount = 0;
    if (this.pendingThreadCount > 0) this.resolvePendingThreads();
    const changed = this.changedNetCount;
    if (changed > 0) {
      this.valueVersion++;
      if (this.traceNets) for (let i = 0; i < changed; i++) this.traceNets.add(this.changedNets[i]);
      this.dirtyCount = this.markReaders(changed, this.dirtyCount);
      this.changedNetCount = 0;
    }
    const count = this.dirtyCount;
    this.dirtyCount = 0;
    if (this.traceComps) for (let i = 0; i < count; i++) this.traceComps.add(this.dirtyComps[i]);
    this.evaluateDirty(count);
    this.stats.evaluations += count;
    this.stats.steps++;
    this.unsettledSteps = this.queue.isEmpty ? 0 : this.unsettledSteps + 1;
    return true;
  }

  /** Phase 1: update driver values; returns the new count of nets waiting to be resolved. */
  private applyEvents(bucket: Bucket, pendingCount: number): number {
    const { drvA, drvB, slotNet, netThreadBase, netPending, pendingNets } = this;
    const slots = bucket.slots;
    const as = bucket.a;
    const bs = bucket.b;
    const length = bucket.length;
    for (let i = 0; i < length; i++) {
      const s = slots[i];
      const a = as[i];
      const b = bs[i];
      const oa = drvA[s];
      const ob = drvB[s];
      if (oa === a && ob === b) continue;
      drvA[s] = a;
      drvB[s] = b;
      const n = slotNet[s];
      const base = netThreadBase[n];
      if (base < 0) {
        if (netPending[n] === 0) {
          netPending[n] = 1;
          pendingNets[pendingCount++] = n;
        }
      } else {
        this.markThreads(base, (oa ^ a) | (ob ^ b));
      }
    }
    return pendingCount;
  }

  private markThreads(base: number, diff: number): void {
    while (diff !== 0) {
      const low = diff & -diff;
      diff ^= low;
      const t = this.bitThread[base + 31 - Math.clz32(low)];
      if (this.threadPending[t] === 0) {
        this.threadPending[t] = 1;
        this.pendingThreads[this.pendingThreadCount++] = t;
      }
    }
  }

  /** Phase 2: recompute every affected word-level net from all of its drivers. */
  private resolvePending(count: number): void {
    const pendingNets = this.pendingNets;
    const netPending = this.netPending;
    for (let i = 0; i < count; i++) {
      const n = pendingNets[i];
      netPending[n] = 0;
      this.resolveNet(n);
    }
  }

  private resolvePendingThreads(): void {
    for (let i = 0; i < this.pendingThreadCount; i++) {
      const t = this.pendingThreads[i];
      this.threadPending[t] = 0;
      this.resolveThread(t);
    }
    this.pendingThreadCount = 0;
  }

  /** Phase 3: mark components reading a changed net; returns the new dirty count. */
  private markReaders(count: number, dirty: number): number {
    const { changedNets, netChanged, netRdrStart, netRdrComps, compDirty, dirtyComps } = this;
    for (let i = 0; i < count; i++) {
      const n = changedNets[i];
      netChanged[n] = 0;
      const end = netRdrStart[n + 1];
      for (let k = netRdrStart[n]; k < end; k++) {
        const c = netRdrComps[k];
        if (compDirty[c] === 0) {
          compDirty[c] = 1;
          dirtyComps[dirty++] = c;
        }
      }
    }
    return dirty;
  }

  /** Phase 4: evaluate marked components against the now-fixed net values. */
  private evaluateDirty(count: number): void {
    const { dirtyComps, compDirty, comps, kOp, kNeg, kIn, kPinStart, kPins, kOut, kMask, kDelay, netA, netB } = this;
    for (let i = 0; i < count; i++) {
      const ci = dirtyComps[i];
      compDirty[ci] = 0;
      const op = kOp[ci];
      if (op === OP_NONE) {
        const c = comps[ci];
        c.behavior.evaluate(c);
        continue;
      }
      // Same semantics as the gate behaviours in primitives/gates.ts.
      const n = kIn[ci];
      const p = kPinStart[ci];
      let a: number;
      let b: number;
      if (op === OP_AND) {
        a = -1;
        b = 0;
        for (let j = 0; j < n; j++) {
          const net = kPins[p + j];
          const ib = netB[net];
          a &= netA[net] | ib;
          b = a & (b | ib);
        }
      } else if (op === OP_OR) {
        a = 0;
        b = 0;
        for (let j = 0; j < n; j++) {
          const net = kPins[p + j];
          const ib = netB[net];
          const ia = netA[net] | ib;
          const one = (a & ~b) | (ia & ~ib);
          a |= ia;
          b = a & ~one;
        }
      } else if (op === OP_XOR) {
        a = 0;
        b = 0;
        for (let j = 0; j < n; j++) {
          const net = kPins[p + j];
          const ib = netB[net];
          b |= ib;
          a = (a ^ (netA[net] | ib)) | b;
        }
      } else {
        const net = kPins[p];
        b = netB[net];
        a = netA[net] | b;
      }
      if (kNeg[ci] !== 0) a = ~a | b;
      const m = kMask[ci];
      this.drive(kOut[ci], a & m, b & m, kDelay[ci]);
    }
  }

  /**
   * Run steps until no events remain. Reports oscillation when the circuit has
   * been changing for more than `maxSettleSteps` consecutive time steps (counted
   * across calls), or when this call processed more than `maxSettleEvents`.
   * With a budget, stops early with `incomplete` so callers can stay responsive.
   */
  settle(budget?: SettleBudget): SettleResult {
    const startEvents = this.stats.events;
    let steps = 0;
    while (!this.queue.isEmpty) {
      const events = this.stats.events - startEvents;
      if (this.unsettledSteps >= this.maxSettleSteps || events >= this.maxSettleEvents) {
        const oscillation = this.sampleOscillation();
        return { stable: false, steps, events: this.stats.events - startEvents, oscillation };
      }
      if (budget?.maxEvents !== undefined && events >= budget.maxEvents) {
        return { stable: false, steps, events, incomplete: true };
      }
      this.step();
      steps++;
    }
    return { stable: true, steps, events: this.stats.events - startEvents };
  }

  /** Advance all clocks by one tick (half a period for a 1:1 clock). Does not settle. */
  tick(): void {
    this.tickCount++;
    this.unsettledSteps = 0;
    for (const ci of this.clockComps) {
      const c = this.comps[ci];
      c.behavior.evaluate(c);
    }
  }

  /** tick() + settle(), `count` times; stops early if the circuit fails to settle. */
  runTicks(count: number): SettleResult {
    let total: SettleResult = { stable: true, steps: 0, events: 0 };
    for (let i = 0; i < count; i++) {
      this.tick();
      const r = this.settle();
      total = { stable: r.stable, steps: total.steps + r.steps, events: total.events + r.events, oscillation: r.oscillation };
      if (!r.stable) break;
    }
    return total;
  }

  get hasClocks(): boolean {
    return this.clockComps.length > 0;
  }

  /** Set the value driven by an externally controlled source. Does not settle. */
  setInput(key: string, value: LogicValue | number): void {
    const ci = this.byKey.get(key);
    if (ci === undefined) throw new Error(`No component with key "${key}"`);
    const c = this.comps[ci];
    if (!(c.behavior instanceof InputBehavior)) throw new Error(`Component "${key}" (${c.type}) is not an input`);
    const width = c.pins[0].width;
    const v = typeof value === 'number' ? logic(width, value, 0) : value;
    if (v.width !== width) throw new Error(`Input "${key}" is ${width} bit(s); got a ${v.width}-bit value`);
    c.behavior.set(v.a, v.b);
    c.behavior.evaluate(c);
    this.unsettledSteps = 0;
  }

  getInput(key: string): LogicValue | null {
    const ci = this.byKey.get(key);
    if (ci === undefined) return null;
    const c = this.comps[ci];
    if (!(c.behavior instanceof InputBehavior)) return null;
    return logic(c.pins[0].width, c.behavior.a, c.behavior.b);
  }

  getNet(n: number): LogicValue {
    return logic(this.netWidth[n], this.netA[n], this.netB[n]);
  }

  /** Value on a component pin (the resolved value of the net it is attached to). */
  pinValue(key: string, pin: string): LogicValue {
    const ci = this.byKey.get(key);
    if (ci === undefined) throw new Error(`No component with key "${key}"`);
    const c = this.comps[ci];
    const p = c.pins.findIndex((x) => x.name === pin);
    if (p < 0) throw new Error(`Component "${key}" has no pin "${pin}"`);
    return this.getNet(c.pinNets[p]);
  }

  /** Internal state of a component (as produced by its behaviour), for inspection. */
  componentState(key: string): unknown {
    const ci = this.byKey.get(key);
    return ci === undefined ? undefined : this.comps[ci].behavior.getState?.();
  }

  /** Nets electrically joined to `n` through bit links (including `n`). */
  linkedNets(n: number): number[] {
    const base = this.netThreadBase[n];
    if (base < 0) return [n];
    const out = new Set<number>([n]);
    for (let bit = 0; bit < this.netWidth[n]; bit++) {
      const t = this.bitThread[base + bit];
      for (let k = this.threadLocStart[t]; k < this.threadLocStart[t + 1]; k++) out.add(this.threadLocNet[k]);
    }
    return [...out];
  }

  /** Components with an input or inout pin on net `n`. */
  netReaders(n: number): number[] {
    return Array.from(this.netRdrComps.subarray(this.netRdrStart[n], this.netRdrStart[n + 1]));
  }

  /** Components driving net `n`. */
  netDrivers(n: number): number[] {
    const out: number[] = [];
    for (let k = this.netDrvStart[n]; k < this.netDrvStart[n + 1]; k++) out.push(this.slotComp[this.netDrvSlots[k]]);
    return out;
  }

  /** Capture behaviour state and driver values of a settled circuit, keyed by component key. */
  exportState(): SimSnapshot {
    const components: Record<string, { state?: unknown; out?: Record<string, [number, number, number]> }> = {};
    for (const c of this.comps) {
      const entry: { state?: unknown; out?: Record<string, [number, number, number]> } = {};
      const state = c.behavior.getState?.();
      if (state !== undefined) entry.state = state;
      c.pins.forEach((pin, pi) => {
        const s = c.pinSlots[pi];
        if (s < 0) return;
        entry.out ??= {};
        entry.out[pin.name] = [pin.width, this.drvA[s], this.drvB[s]];
      });
      components[c.key] = entry;
    }
    return { time: this.time, tick: this.tickCount, components };
  }

  /**
   * Restore a snapshot, possibly taken from a different (edited) netlist.
   * Components are matched by key and type-compatible pins by name and width;
   * unmatched components keep power-on state. Every net is re-resolved and
   * every component re-evaluated; call settle() afterwards.
   */
  importState(snapshot: SimSnapshot): void {
    this.queue.clear();
    this.unsettledSteps = 0;
    // Pending events are discarded, so projected driver values fall back to the actual ones.
    this.projA.set(this.drvA);
    this.projB.set(this.drvB);
    this.time = Number.isFinite(snapshot.time) ? snapshot.time : 0;
    this.tickCount = Number.isFinite(snapshot.tick) ? snapshot.tick : 0;
    for (const c of this.comps) {
      const entry = snapshot.components[c.key];
      if (!entry) continue;
      if (entry.state !== undefined) c.behavior.setState?.(entry.state);
      if (!entry.out) continue;
      c.pins.forEach((pin, pi) => {
        const s = c.pinSlots[pi];
        const v = entry.out?.[pin.name];
        if (s < 0 || !v || v[0] !== pin.width) return;
        const m = this.slotMask[s];
        this.drvA[s] = this.projA[s] = v[1] & m;
        this.drvB[s] = this.projB[s] = v[2] & m;
      });
    }
    for (let n = 0; n < this.netCount; n++) {
      if (this.netThreadBase[n] < 0) this.resolveNet(n);
    }
    for (let t = 0; t < this.threadPending.length; t++) this.resolveThread(t);
    for (let i = 0; i < this.changedNetCount; i++) this.netChanged[this.changedNets[i]] = 0;
    this.changedNetCount = 0;
    this.valueVersion++;
    this.evaluateAll();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /** @internal Schedule a driver change `delay` units after the current time. */
  drive(slot: number, a: number, b: number, delay: number): void {
    const m = this.slotMask[slot];
    a &= m;
    b &= m;
    if (this.projA[slot] === a && this.projB[slot] === b) return;
    this.projA[slot] = a;
    this.projB[slot] = b;
    this.queue.schedule(this.time + delay, slot, a, b);
  }

  private evaluateAll(): void {
    for (const c of this.comps) c.behavior.evaluate(c);
    this.stats.evaluations += this.comps.length;
  }

  private markChanged(n: number): void {
    if (this.netChanged[n] === 0) {
      this.netChanged[n] = 1;
      this.changedNets[this.changedNetCount++] = n;
    }
  }

  private resolveNet(n: number): void {
    const start = this.netDrvStart[n];
    const end = this.netDrvStart[n + 1];
    const m = this.netMask[n];
    let a: number;
    let b: number;
    let cont = 0;
    if (start === end) {
      a = 0;
      b = m;
    } else {
      let s = this.netDrvSlots[start];
      a = this.drvA[s];
      b = this.drvB[s];
      for (let k = start + 1; k < end; k++) {
        s = this.netDrvSlots[k];
        const a2 = this.drvA[s];
        const b2 = this.drvB[s];
        cont |= contentionBits(a, b, a2, b2);
        const na = resolveA(a, b, a2, b2);
        b = resolveB(a, b, a2, b2);
        a = na;
      }
      a &= m;
      b &= m;
    }
    this.netContention[n] = cont & m;
    if (a !== this.netA[n] || b !== this.netB[n]) {
      this.netA[n] = a;
      this.netB[n] = b;
      this.markChanged(n);
    }
  }

  private resolveThread(t: number): void {
    let a = 0;
    let b = 1;
    let cont = 0;
    for (let k = this.threadDrvStart[t]; k < this.threadDrvStart[t + 1]; k++) {
      const s = this.threadDrvSlot[k];
      const bit = this.threadDrvBit[k];
      const a2 = (this.drvA[s] >>> bit) & 1;
      const b2 = (this.drvB[s] >>> bit) & 1;
      cont |= contentionBits(a, b, a2, b2);
      const na = resolveA(a, b, a2, b2) & 1;
      b = resolveB(a, b, a2, b2) & 1;
      a = na;
    }
    cont &= 1;
    for (let k = this.threadLocStart[t]; k < this.threadLocStart[t + 1]; k++) {
      const n = this.threadLocNet[k];
      const bit = this.threadLocBit[k];
      const mask = 1 << bit;
      const na = (this.netA[n] & ~mask) | (a << bit);
      const nb = (this.netB[n] & ~mask) | (b << bit);
      this.netContention[n] = (this.netContention[n] & ~mask) | (cont << bit);
      if (na !== this.netA[n] || nb !== this.netB[n]) {
        this.netA[n] = na;
        this.netB[n] = nb;
        this.markChanged(n);
      }
    }
  }

  /** Run a few more steps while recording what changes, to describe an oscillation. */
  private sampleOscillation(): OscillationReport {
    this.traceNets = new Set();
    this.traceComps = new Set();
    for (let i = 0; i < OSCILLATION_SAMPLE_STEPS && this.step(); i++) {
      /* sampling */
    }
    const nets = [...this.traceNets].sort((x, y) => x - y);
    const componentKeys = [...this.traceComps].map((ci) => this.comps[ci].key).sort();
    this.traceNets = null;
    this.traceComps = null;
    return { componentKeys, nets, time: this.time };
  }
}

function prefixSum(counts: Int32Array): Int32Array {
  const out = new Int32Array(counts.length);
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    out[i] = acc;
    acc += counts[i];
  }
  return out;
}
