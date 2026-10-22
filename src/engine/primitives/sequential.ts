import { MAX_WIDTH, widthMask } from '../logic.ts';
import {
  checkEnum,
  checkInt,
  firstError,
  intProp,
  strProp,
  type Behavior,
  type EvalContext,
  type PrimitiveSpec,
} from './types.ts';

/*
 * Optimized edge-triggered storage primitives. These are behavioural models,
 * not gate-level circuits: they power up holding 0 and sample their data
 * inputs from the net values present at the instant the clock edge is seen.
 * Because outputs change one delay after the edge, chains of registers
 * clocked by the same clock never race (a shift register shifts by one).
 *
 * Unknown clocks are handled pessimistically: a transition that may or may
 * not have been an edge (0→X, X→1 for rising) keeps bits where the stored
 * value and the data agree and makes the others X.
 */

export const TRIGGERS = ['rising', 'falling'] as const;

const NO_EDGE = 0;
const EDGE = 1;
const MAYBE_EDGE = 2;

/** Tracks a clock input's level between evaluations. */
export class EdgeDetector {
  /** -1: no known level seen yet; 0/1: known level; 2: unknown. */
  last = -1;
  private readonly from: number;
  private readonly to: number;

  constructor(rising: boolean) {
    this.from = rising ? 0 : 1;
    this.to = rising ? 1 : 0;
  }

  update(a: number, b: number): number {
    const cur = (b & 1) !== 0 ? 2 : a & 1;
    const prev = this.last;
    if (prev === -1) {
      if (cur !== 2) this.last = cur;
      return NO_EDGE;
    }
    this.last = cur;
    if (prev === this.from && cur === this.to) return EDGE;
    if ((prev === this.from && cur === 2) || (prev === 2 && cur === this.to)) return MAYBE_EDGE;
    return NO_EDGE;
  }
}

/** Bits where both known values agree keep their value; all others become X. */
function mergeA(qa: number, qb: number, da: number, db: number): number {
  const agree = ~(qa ^ da) & ~qb & ~db;
  return (qa & agree) | ~agree;
}

function mergeB(qa: number, qb: number, da: number, db: number): number {
  return ~(~(qa ^ da) & ~qb & ~db);
}

function isStateArray(s: unknown): s is [number, number, number] {
  return Array.isArray(s) && s.length === 3 && s.every((x) => typeof x === 'number');
}

/** Pins: D, CLK, Q, NQ */
class DffBehavior implements Behavior {
  private qa = 0;
  private qb = 0;
  private readonly mask: number;
  private readonly edge: EdgeDetector;

  constructor(width: number, rising: boolean) {
    this.mask = widthMask(width);
    this.edge = new EdgeDetector(rising);
  }

  evaluate(ctx: EvalContext): void {
    const e = this.edge.update(ctx.a(1), ctx.b(1));
    if (e !== NO_EDGE) {
      const db = ctx.b(0);
      const da = ctx.a(0) | db;
      if (e === EDGE) {
        this.qa = da;
        this.qb = db;
      } else {
        const a = mergeA(this.qa, this.qb, da, db);
        this.qb = mergeB(this.qa, this.qb, da, db) & this.mask;
        this.qa = a & this.mask;
      }
    }
    ctx.out(2, this.qa, this.qb);
    ctx.out(3, ~this.qa | this.qb, this.qb);
  }

  getState(): unknown {
    return [this.qa, this.qb, this.edge.last];
  }

  setState(s: unknown): void {
    if (!isStateArray(s)) return;
    this.qa = s[0] & this.mask;
    this.qb = s[1] & this.mask;
    this.edge.last = s[2];
  }
}

export const DFF: PrimitiveSpec = {
  type: 'dff',
  kind: 'logic',
  sequential: true,
  delay: 1,
  validate: (props) =>
    firstError(checkInt(props, 'width', 1, MAX_WIDTH), checkEnum(props, 'trigger', TRIGGERS, false)),
  pins: (props) => {
    const width = intProp(props, 'width', 1);
    return [
      { name: 'D', dir: 'in', width },
      { name: 'CLK', dir: 'in', width: 1 },
      { name: 'Q', dir: 'out', width },
      { name: 'NQ', dir: 'out', width },
    ];
  },
  create: (props) => new DffBehavior(intProp(props, 'width', 1), strProp(props, 'trigger', 'rising') === 'rising'),
};

/**
 * Register with load enable and asynchronous clear.
 * Pins: D, CLK, EN, CLR, Q. A floating EN counts as enabled and a floating
 * CLR as inactive, so the control pins can be left unconnected.
 */
class RegisterBehavior implements Behavior {
  private qa = 0;
  private qb = 0;
  private readonly mask: number;
  private readonly edge: EdgeDetector;

  constructor(width: number, rising: boolean) {
    this.mask = widthMask(width);
    this.edge = new EdgeDetector(rising);
  }

  evaluate(ctx: EvalContext): void {
    const m = this.mask;
    const e = this.edge.update(ctx.a(1), ctx.b(1));
    if (e !== NO_EDGE) {
      const enA = ctx.a(2) & 1;
      const enB = ctx.b(2) & 1;
      const enFloating = enB === 1 && enA === 0;
      const en = enFloating ? 1 : enB === 1 ? 2 : enA;
      if (en !== 0) {
        const db = ctx.b(0);
        const da = ctx.a(0) | db;
        if (e === EDGE && en === 1) {
          this.qa = da & m;
          this.qb = db & m;
        } else {
          const a = mergeA(this.qa, this.qb, da, db);
          this.qb = mergeB(this.qa, this.qb, da, db) & m;
          this.qa = a & m;
        }
      }
    }
    const clrA = ctx.a(3) & 1;
    const clrB = ctx.b(3) & 1;
    if (clrB === 0 && clrA === 1) {
      this.qa = 0;
      this.qb = 0;
    } else if (clrB === 1 && clrA === 1) {
      const a = mergeA(this.qa, this.qb, 0, 0);
      this.qb = mergeB(this.qa, this.qb, 0, 0) & m;
      this.qa = a & m;
    }
    ctx.out(4, this.qa, this.qb);
  }

  getState(): unknown {
    return [this.qa, this.qb, this.edge.last];
  }

  setState(s: unknown): void {
    if (!isStateArray(s)) return;
    this.qa = s[0] & this.mask;
    this.qb = s[1] & this.mask;
    this.edge.last = s[2];
  }
}

export const REGISTER: PrimitiveSpec = {
  type: 'register',
  kind: 'logic',
  sequential: true,
  delay: 1,
  validate: (props) =>
    firstError(checkInt(props, 'width', 1, MAX_WIDTH), checkEnum(props, 'trigger', TRIGGERS, false)),
  pins: (props) => {
    const width = intProp(props, 'width', 1);
    return [
      { name: 'D', dir: 'in', width },
      { name: 'CLK', dir: 'in', width: 1 },
      { name: 'EN', dir: 'in', width: 1 },
      { name: 'CLR', dir: 'in', width: 1 },
      { name: 'Q', dir: 'out', width },
    ];
  },
  create: (props) =>
    new RegisterBehavior(intProp(props, 'width', 1), strProp(props, 'trigger', 'rising') === 'rising'),
};
