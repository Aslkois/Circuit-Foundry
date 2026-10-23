import {
  NetlistBuilder,
  Simulator,
  bitAt,
  formatBinary,
  logic,
  type BitState,
  type LogicValue,
  type PrimitiveProps,
  type SimulatorOptions,
} from '../../src/engine/index.ts';

/** Thin convenience layer over NetlistBuilder for readable engine tests. */
export class Bench {
  readonly nb = new NetlistBuilder();
  private sim: Simulator | null = null;
  private outputs = new Map<string, number>();

  net(width = 1): number {
    return this.nb.net(width);
  }

  input(key: string, width = 1): number {
    const n = this.nb.net(width);
    this.nb.add('input', { width }, [n], key);
    return n;
  }

  clock(key: string, props: PrimitiveProps = { highTicks: 1, lowTicks: 1 }): number {
    const n = this.nb.net(1);
    this.nb.add('clock', props, [n], key);
    return n;
  }

  gate(type: string, ins: number[], opts: { width?: number; key?: string; out?: number; delay?: number } = {}): number {
    const width = opts.width ?? 1;
    const out = opts.out ?? this.nb.net(width);
    const props: Record<string, number> = { inputs: ins.length, width };
    if (opts.delay !== undefined) props.delay = opts.delay;
    this.nb.add(type, props, [...ins, out], opts.key);
    return out;
  }

  unary(type: 'not' | 'buffer', input: number, opts: { width?: number; key?: string; out?: number } = {}): number {
    const out = opts.out ?? this.nb.net(opts.width ?? 1);
    this.nb.add(type, { width: opts.width ?? 1 }, [input, out], opts.key);
    return out;
  }

  add(type: string, props: PrimitiveProps, pins: number[], key?: string): string {
    return this.nb.add(type, props, pins, key);
  }

  /** Name a net for reading with get(). */
  name(name: string, net: number): number {
    this.outputs.set(name, net);
    return net;
  }

  start(options?: SimulatorOptions): Simulator {
    this.sim = new Simulator(this.nb.build(), options);
    const r = this.sim.settle();
    if (!r.stable) throw new Error('circuit did not settle after reset');
    return this.sim;
  }

  get s(): Simulator {
    if (!this.sim) throw new Error('call start() first');
    return this.sim;
  }

  set(key: string, value: number | LogicValue): void {
    this.s.setInput(key, value);
    const r = this.s.settle();
    if (!r.stable) throw new Error(`circuit did not settle after setting ${key}`);
  }

  get(name: string): LogicValue {
    const n = this.outputs.get(name);
    if (n === undefined) throw new Error(`unknown output ${name}`);
    return this.s.getNet(n);
  }

  /** Binary string of a named net, e.g. "1", "x", "0101". */
  bits(name: string): string {
    return formatBinary(this.get(name));
  }
}

/* Scalar four-state reference model used to check the word-level gate code. */

export const STATES: BitState[] = ['0', '1', 'x', 'z'];

const n = (v: BitState): BitState => (v === 'z' ? 'x' : v);

export function refAnd(xs: BitState[]): BitState {
  const v = xs.map(n);
  if (v.includes('0')) return '0';
  if (v.every((x) => x === '1')) return '1';
  return 'x';
}

export function refOr(xs: BitState[]): BitState {
  const v = xs.map(n);
  if (v.includes('1')) return '1';
  if (v.every((x) => x === '0')) return '0';
  return 'x';
}

export function refXor(xs: BitState[]): BitState {
  const v = xs.map(n);
  if (v.includes('x')) return 'x';
  return v.filter((x) => x === '1').length % 2 === 1 ? '1' : '0';
}

export function refNot(x: BitState): BitState {
  const v = n(x);
  return v === 'x' ? 'x' : v === '1' ? '0' : '1';
}

export function refResolve(x: BitState, y: BitState): BitState {
  if (x === 'z') return y;
  if (y === 'z') return x;
  if (x === y && x !== 'x') return x;
  return 'x';
}

/** Build a LogicValue from per-bit states, index 0 = LSB. */
export function fromBits(bits: BitState[]): LogicValue {
  let a = 0;
  let b = 0;
  bits.forEach((s, i) => {
    if (s === '1' || s === 'x') a |= 1 << i;
    if (s === 'x' || s === 'z') b |= 1 << i;
  });
  return logic(bits.length, a, b);
}

export function toBits(v: LogicValue): BitState[] {
  return Array.from({ length: v.width }, (_, i) => bitAt(v, i));
}

/** Deterministic PRNG (mulberry32) for randomized-but-reproducible tests. */
export function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
