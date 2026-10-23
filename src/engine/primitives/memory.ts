import { MAX_WIDTH, widthMask } from '../logic.ts';
import type { PrimitiveProps } from '../netlist.ts';
import { EdgeDetector } from './sequential.ts';
import { checkInt, firstError, intProp, strProp, type Behavior, type EvalContext, type PrimitiveSpec } from './types.ts';

/*
 * Behavioural memories. These are optimized models, not gate-level circuits:
 * a 64K-word RAM costs one component instead of millions of gates.
 *
 *  - RAM: synchronous write on the rising clock edge when WE = 1, asynchronous
 *    read (Q always shows the word at A). Powers up holding 0. A write whose
 *    address is unknown is ignored; an unknown WE makes the addressed word
 *    pessimistically unknown where old and new data differ.
 *  - ROM: asynchronous read of contents given as a property.
 *
 * An unknown or floating address reads as X.
 */

export const MAX_ADDR_WIDTH = 16;

/** Direct access to a memory's contents, for viewers and editors. */
export interface MemoryPort {
  readonly words: number;
  readonly width: number;
  read(addr: number): { a: number; b: number };
  write(addr: number, a: number, b: number): void;
  /** Address of the last read through the pins, or -1. */
  readonly lastRead: number;
  /** Address of the last write through the pins, or -1. */
  readonly lastWrite: number;
}

export interface MemoryBehavior extends Behavior {
  readonly memory: MemoryPort;
}

export function isMemoryBehavior(b: Behavior): b is MemoryBehavior {
  return 'memory' in b;
}

/** Parse ROM contents: hexadecimal words separated by spaces, commas or newlines. */
export function parseRomContents(text: string, words: number, width: number): Int32Array | string {
  const out = new Int32Array(words);
  const tokens = text.split(/[\s,]+/).filter((t) => t !== '');
  if (tokens.length > words) return `has ${tokens.length} words but the ROM holds ${words}`;
  const max = 2 ** width;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,8}$/i.test(t)) return `word ${i} ("${tokens[i]}") is not hexadecimal`;
    const v = parseInt(t, 16);
    if (v >= max) return `word ${i} (${tokens[i]}) does not fit in ${width} bit(s)`;
    out[i] = v | 0;
  }
  return out;
}

/** Format memory words as ROM contents text: hex, sixteen words per line, trailing zeros dropped. */
export function formatRomContents(words: ArrayLike<number>, width: number): string {
  let last = words.length - 1;
  while (last >= 0 && words[last] === 0) last--;
  const digits = Math.ceil(width / 4);
  const lines: string[] = [];
  for (let i = 0; i <= last; i += 16) {
    const row: string[] = [];
    for (let j = i; j < Math.min(i + 16, last + 1); j++) row.push((words[j] >>> 0).toString(16).padStart(digits, '0'));
    lines.push(row.join(' '));
  }
  return lines.join('\n');
}

/** Pins: A, D, WE, CLK, Q */
class RamBehavior implements MemoryBehavior, MemoryPort {
  readonly words: number;
  readonly width: number;
  private readonly dataA: Int32Array;
  private readonly dataB: Int32Array;
  private readonly mask: number;
  private readonly addrMask: number;
  private readonly edge = new EdgeDetector(true);
  lastRead = -1;
  lastWrite = -1;

  constructor(addrWidth: number, width: number) {
    this.words = 2 ** addrWidth;
    this.width = width;
    this.dataA = new Int32Array(this.words);
    this.dataB = new Int32Array(this.words);
    this.mask = widthMask(width);
    this.addrMask = widthMask(addrWidth);
  }

  get memory(): MemoryPort {
    return this;
  }

  read(addr: number): { a: number; b: number } {
    return { a: this.dataA[addr], b: this.dataB[addr] };
  }

  write(addr: number, a: number, b: number): void {
    this.dataA[addr] = a & this.mask;
    this.dataB[addr] = b & this.mask;
  }

  evaluate(ctx: EvalContext): void {
    const m = this.mask;
    const addrKnown = ctx.b(0) === 0;
    const addr = ctx.a(0) & this.addrMask;
    const e = this.edge.update(ctx.a(3), ctx.b(3));
    if (e !== 0 && addrKnown) {
      const weA = ctx.a(2) & 1;
      const weB = ctx.b(2) & 1;
      const weFloating = weB === 1 && weA === 0;
      if (!weFloating && (weA === 1 || weB === 1)) {
        const db = ctx.b(1);
        const da = ctx.a(1) | db;
        if (e === 1 && weB === 0) {
          this.dataA[addr] = da & m;
          this.dataB[addr] = db & m;
        } else {
          // Possible write: keep agreeing bits, others become unknown.
          const qa = this.dataA[addr];
          const qb = this.dataB[addr];
          const agree = ~(qa ^ da) & ~qb & ~db;
          this.dataA[addr] = ((qa & agree) | ~agree) & m;
          this.dataB[addr] = ~agree & m;
        }
        this.lastWrite = addr;
      }
    }
    if (addrKnown) {
      this.lastRead = addr;
      ctx.out(4, this.dataA[addr], this.dataB[addr]);
    } else {
      ctx.out(4, m, m);
    }
  }

  getState(): unknown {
    const cells: number[] = [];
    for (let i = 0; i < this.dataA.length; i++) {
      if (this.dataA[i] !== 0 || this.dataB[i] !== 0) cells.push(i, this.dataA[i], this.dataB[i]);
    }
    return { clk: this.edge.last, cells, lastRead: this.lastRead, lastWrite: this.lastWrite };
  }

  setState(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as { clk?: unknown; cells?: unknown; lastRead?: unknown; lastWrite?: unknown };
    if (typeof s.clk === 'number') this.edge.last = s.clk;
    if (typeof s.lastRead === 'number') this.lastRead = s.lastRead;
    if (typeof s.lastWrite === 'number') this.lastWrite = s.lastWrite;
    if (!Array.isArray(s.cells)) return;
    this.dataA.fill(0);
    this.dataB.fill(0);
    for (let i = 0; i + 2 < s.cells.length; i += 3) {
      const [addr, a, b] = [s.cells[i], s.cells[i + 1], s.cells[i + 2]];
      if (typeof addr === 'number' && addr >= 0 && addr < this.dataA.length && typeof a === 'number' && typeof b === 'number') {
        this.dataA[addr] = a & this.mask;
        this.dataB[addr] = b & this.mask;
      }
    }
  }
}

/** Pins: A, Q */
class RomBehavior implements MemoryBehavior, MemoryPort {
  readonly words: number;
  readonly width: number;
  private readonly data: Int32Array;
  private readonly mask: number;
  private readonly addrMask: number;
  lastRead = -1;
  readonly lastWrite = -1;

  constructor(addrWidth: number, width: number, contents: string) {
    this.words = 2 ** addrWidth;
    this.width = width;
    const parsed = parseRomContents(contents, this.words, width);
    this.data = typeof parsed === 'string' ? new Int32Array(this.words) : parsed;
    this.mask = widthMask(width);
    this.addrMask = widthMask(addrWidth);
  }

  get memory(): MemoryPort {
    return this;
  }

  read(addr: number): { a: number; b: number } {
    return { a: this.data[addr], b: 0 };
  }

  /** ROM contents belong to the document; a direct write only lasts until the design is recompiled. */
  write(addr: number, a: number): void {
    this.data[addr] = a & this.mask;
  }

  evaluate(ctx: EvalContext): void {
    if (ctx.b(0) !== 0) {
      ctx.out(1, this.mask, this.mask);
      return;
    }
    const addr = ctx.a(0) & this.addrMask;
    this.lastRead = addr;
    ctx.out(1, this.data[addr], 0);
  }
}

function memoryValidate(props: PrimitiveProps): string | null {
  return firstError(checkInt(props, 'addrWidth', 1, MAX_ADDR_WIDTH), checkInt(props, 'width', 1, MAX_WIDTH));
}

export const RAM: PrimitiveSpec = {
  type: 'ram',
  kind: 'logic',
  sequential: true,
  delay: 1,
  validate: memoryValidate,
  pins: (props) => {
    const aw = intProp(props, 'addrWidth', 4);
    const w = intProp(props, 'width', 8);
    return [
      { name: 'A', dir: 'in', width: aw },
      { name: 'D', dir: 'in', width: w },
      { name: 'WE', dir: 'in', width: 1 },
      { name: 'CLK', dir: 'in', width: 1 },
      { name: 'Q', dir: 'out', width: w },
    ];
  },
  create: (props) => new RamBehavior(intProp(props, 'addrWidth', 4), intProp(props, 'width', 8)),
};

export const ROM: PrimitiveSpec = {
  type: 'rom',
  kind: 'logic',
  // Combinational read: Q follows A within one delay.
  sequential: false,
  delay: 1,
  validate: (props) => {
    const err = memoryValidate(props);
    if (err) return err;
    const parsed = parseRomContents(strProp(props, 'contents', ''), 2 ** intProp(props, 'addrWidth', 4), intProp(props, 'width', 8));
    return typeof parsed === 'string' ? `contents ${parsed}` : null;
  },
  pins: (props) => [
    { name: 'A', dir: 'in', width: intProp(props, 'addrWidth', 4) },
    { name: 'Q', dir: 'out', width: intProp(props, 'width', 8) },
  ],
  create: (props) => new RomBehavior(intProp(props, 'addrWidth', 4), intProp(props, 'width', 8), strProp(props, 'contents', '')),
};
