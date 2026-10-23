import { MAX_WIDTH, widthMask } from '../logic.ts';
import {
  checkInt,
  firstError,
  intProp,
  type Behavior,
  type EvalContext,
  type PrimitiveSpec,
} from './types.ts';

/**
 * Externally controlled source (toggle switch, push button, top-level input
 * pin). Its value is part of simulator state and set with Simulator.setInput.
 * It may drive any four-state value, including Z.
 */
export class InputBehavior implements Behavior {
  a = 0;
  b = 0;
  private readonly mask: number;

  constructor(width: number) {
    this.mask = widthMask(width);
  }

  evaluate(ctx: EvalContext): void {
    ctx.out(0, this.a, this.b);
  }

  set(a: number, b: number): void {
    this.a = a & this.mask;
    this.b = b & this.mask;
  }

  getState(): unknown {
    return { a: this.a, b: this.b };
  }

  setState(state: unknown): void {
    if (state && typeof state === 'object') {
      const s = state as { a?: unknown; b?: unknown };
      if (typeof s.a === 'number' && typeof s.b === 'number') this.set(s.a, s.b);
    }
  }
}

export const INPUT: PrimitiveSpec = {
  type: 'input',
  kind: 'input',
  sequential: true,
  delay: 1,
  validate: (props) => checkInt(props, 'width', 1, MAX_WIDTH),
  pins: (props) => [{ name: 'out', dir: 'out', width: intProp(props, 'width', 1) }],
  create: (props) => new InputBehavior(intProp(props, 'width', 1)),
};

export const CONSTANT: PrimitiveSpec = {
  type: 'constant',
  kind: 'logic',
  sequential: true,
  delay: 1,
  validate: (props) => {
    const err = checkInt(props, 'width', 1, MAX_WIDTH);
    if (err) return err;
    const v = props.value;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffffff) {
      return 'property "value" must be an unsigned 32-bit integer';
    }
    return null;
  },
  pins: (props) => [{ name: 'out', dir: 'out', width: intProp(props, 'width', 1) }],
  create: (props) => {
    const a = intProp(props, 'value', 0) & widthMask(intProp(props, 'width', 1));
    return { evaluate: (ctx: EvalContext) => ctx.out(0, a, 0) };
  },
};

/**
 * Clock source. Clocks advance only on Simulator.tick(); one tick is the
 * smallest unit of clock time. The waveform repeats every highTicks+lowTicks
 * ticks: low for `lowTicks` ticks, then high for `highTicks` ticks, shifted by
 * `phase` ticks. At reset (tick 0, phase 0) the clock is low.
 */
export function clockLevel(tick: number, high: number, low: number, phase: number): number {
  const period = high + low;
  const t = (((tick + phase) % period) + period) % period;
  return t >= low ? 1 : 0;
}

export const CLOCK: PrimitiveSpec = {
  type: 'clock',
  kind: 'clock',
  sequential: true,
  delay: 1,
  validate: (props) =>
    firstError(
      checkInt(props, 'highTicks', 1, 1_000_000),
      checkInt(props, 'lowTicks', 1, 1_000_000),
      checkInt(props, 'phase', 0, 1_000_000, false),
    ),
  pins: () => [{ name: 'out', dir: 'out', width: 1 }],
  create: (props) => {
    const high = intProp(props, 'highTicks', 1);
    const low = intProp(props, 'lowTicks', 1);
    const phase = intProp(props, 'phase', 0);
    return { evaluate: (ctx: EvalContext) => ctx.out(0, clockLevel(ctx.tick, high, low, phase), 0) };
  },
};
