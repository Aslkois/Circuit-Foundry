import { MAX_WIDTH, widthMask } from '../logic.ts';
import type { PrimitiveProps } from '../netlist.ts';
import {
  checkInt,
  firstError,
  intProp,
  type Behavior,
  type EvalContext,
  type PinSpec,
  type PrimitiveSpec,
} from './types.ts';

/*
 * Gate semantics on four-state vectors (bitwise across `width`):
 *  - Floating (Z) inputs are treated as unknown (X).
 *  - AND: any 0 → 0; all 1 → 1; otherwise X.   OR: any 1 → 1; all 0 → 0; otherwise X.
 *  - XOR / XNOR with more than two inputs compute odd / even parity; any X → X.
 *  - Gate outputs are never Z.
 *
 * Words are normalized so that X and Z both have a=1, b=1; then "known 0" is
 * exactly a=0, which keeps the combine steps branch-free.
 */

export const MAX_GATE_INPUTS = 16;

type GateOp = 'and' | 'or' | 'xor';

/* One class per operation keeps each evaluate() small and monomorphic. */

class AndGate implements Behavior {
  private readonly n: number;
  private readonly negate: boolean;
  private readonly mask: number;

  constructor(n: number, negate: boolean, width: number) {
    this.n = n;
    this.negate = negate;
    this.mask = widthMask(width);
  }

  evaluate(ctx: EvalContext): void {
    let a = -1;
    let b = 0;
    for (let i = 0; i < this.n; i++) {
      const ib = ctx.b(i);
      a &= ctx.a(i) | ib;
      b = a & (b | ib);
    }
    if (this.negate) a = ~a | b;
    ctx.out(this.n, a & this.mask, b & this.mask);
  }
}

class OrGate implements Behavior {
  private readonly n: number;
  private readonly negate: boolean;
  private readonly mask: number;

  constructor(n: number, negate: boolean, width: number) {
    this.n = n;
    this.negate = negate;
    this.mask = widthMask(width);
  }

  evaluate(ctx: EvalContext): void {
    let a = 0;
    let b = 0;
    for (let i = 0; i < this.n; i++) {
      const ib = ctx.b(i);
      const ia = ctx.a(i) | ib;
      const one = (a & ~b) | (ia & ~ib);
      a |= ia;
      b = a & ~one;
    }
    if (this.negate) a = ~a | b;
    ctx.out(this.n, a & this.mask, b & this.mask);
  }
}

class XorGate implements Behavior {
  private readonly n: number;
  private readonly negate: boolean;
  private readonly mask: number;

  constructor(n: number, negate: boolean, width: number) {
    this.n = n;
    this.negate = negate;
    this.mask = widthMask(width);
  }

  evaluate(ctx: EvalContext): void {
    let a = 0;
    let b = 0;
    for (let i = 0; i < this.n; i++) {
      const ib = ctx.b(i);
      b |= ib;
      a = (a ^ (ctx.a(i) | ib)) | b;
    }
    if (this.negate) a = ~a | b;
    ctx.out(this.n, a & this.mask, b & this.mask);
  }
}

const GATE_CLASSES = { and: AndGate, or: OrGate, xor: XorGate };

function gatePins(props: PrimitiveProps): PinSpec[] {
  const n = intProp(props, 'inputs', 2);
  const width = intProp(props, 'width', 1);
  const pins: PinSpec[] = [];
  for (let i = 0; i < n; i++) pins.push({ name: `in${i}`, dir: 'in', width });
  pins.push({ name: 'out', dir: 'out', width });
  return pins;
}

function gateSpec(type: string, op: GateOp, negate: boolean): PrimitiveSpec {
  return {
    type,
    kind: 'logic',
    kernel: { op, negate },
    sequential: false,
    delay: 1,
    validate: (props) =>
      firstError(checkInt(props, 'inputs', 2, MAX_GATE_INPUTS), checkInt(props, 'width', 1, MAX_WIDTH)),
    pins: gatePins,
    create: (props) => new GATE_CLASSES[op](intProp(props, 'inputs', 2), negate, intProp(props, 'width', 1)),
  };
}

export const AND = gateSpec('and', 'and', false);
export const NAND = gateSpec('nand', 'and', true);
export const OR = gateSpec('or', 'or', false);
export const NOR = gateSpec('nor', 'or', true);
export const XOR = gateSpec('xor', 'xor', false);
export const XNOR = gateSpec('xnor', 'xor', true);

class UnaryBehavior implements Behavior {
  private readonly invert: boolean;
  private readonly mask: number;

  constructor(invert: boolean, width: number) {
    this.invert = invert;
    this.mask = widthMask(width);
  }

  evaluate(ctx: EvalContext): void {
    const b = ctx.b(0);
    let a = ctx.a(0) | b;
    if (this.invert) a = ~a | b;
    ctx.out(1, a & this.mask, b & this.mask);
  }
}

function unarySpec(type: string, invert: boolean): PrimitiveSpec {
  return {
    type,
    kind: 'logic',
    kernel: { op: 'buffer', negate: invert },
    sequential: false,
    delay: 1,
    validate: (props) => checkInt(props, 'width', 1, MAX_WIDTH),
    pins: (props) => {
      const width = intProp(props, 'width', 1);
      return [
        { name: 'in', dir: 'in', width },
        { name: 'out', dir: 'out', width },
      ];
    },
    create: (props) => new UnaryBehavior(invert, intProp(props, 'width', 1)),
  };
}

export const NOT = unarySpec('not', true);
export const BUFFER = unarySpec('buffer', false);

/**
 * Tri-state buffer: drives `in` onto `out` when `en` is 1, releases the
 * output (Z) when `en` is 0, and drives X when `en` is unknown or floating.
 * Floating data bits are driven as X.
 */
class TriStateBehavior implements Behavior {
  private readonly mask: number;

  constructor(width: number) {
    this.mask = widthMask(width);
  }

  evaluate(ctx: EvalContext): void {
    const m = this.mask;
    const enA = ctx.a(1) & 1;
    const enB = ctx.b(1) & 1;
    if (enB !== 0) {
      ctx.out(2, m, m);
    } else if (enA === 0) {
      ctx.out(2, 0, m);
    } else {
      const b = ctx.b(0);
      ctx.out(2, (ctx.a(0) | b) & m, b & m);
    }
  }
}

export const TRISTATE: PrimitiveSpec = {
  type: 'tristate',
  kind: 'logic',
  sequential: false,
  delay: 1,
  validate: (props) => checkInt(props, 'width', 1, MAX_WIDTH),
  pins: (props) => {
    const width = intProp(props, 'width', 1);
    return [
      { name: 'in', dir: 'in', width },
      { name: 'en', dir: 'in', width: 1 },
      { name: 'out', dir: 'out', width },
    ];
  },
  create: (props) => new TriStateBehavior(intProp(props, 'width', 1)),
};
