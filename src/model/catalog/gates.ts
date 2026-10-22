import { MAX_GATE_INPUTS } from '../../engine/primitives/gates.ts';
import type { Props } from '../types.ts';
import { LABEL_PROP, WIDTH_PROP, intOf, type ComponentLayout, type ComponentTypeDef, type PinLayout } from './types.ts';

/**
 * Input pin offsets for an n-input gate (facing east, anchor at body centre).
 * Up to three inputs use a two-unit pitch; more inputs use a one-unit pitch,
 * skipping the centre line for even counts so the output stays centred.
 */
export function gateInputOffsets(n: number): number[] {
  if (n <= 3) return Array.from({ length: n }, (_, i) => -(n - 1) + 2 * i);
  const ys: number[] = [];
  const half = Math.floor(n / 2);
  for (let y = -half; y <= half; y++) {
    if (y === 0 && n % 2 === 0) continue;
    ys.push(y);
  }
  return ys;
}

/** Half-height of a gate body for n inputs. */
export function gateHalfHeight(n: number): number {
  const ys = gateInputOffsets(n);
  return Math.max(2, Math.max(...ys.map(Math.abs)) + 1);
}

function gateLayout(props: Props): ComponentLayout {
  const n = intOf(props, 'inputs');
  const width = intOf(props, 'width');
  const pins: PinLayout[] = gateInputOffsets(n).map((y, i) => ({ name: `in${i}`, dir: 'in', width, x: -3, y }));
  pins.push({ name: 'out', dir: 'out', width, x: 3, y: 0 });
  const h = gateHalfHeight(n);
  return { pins, bounds: { x: -2, y: -h, w: 4, h: 2 * h } };
}

function gate(type: string, name: string, description: string): ComponentTypeDef {
  return {
    type,
    name,
    category: 'Gates',
    description,
    props: [
      { name: 'inputs', label: 'Inputs', kind: 'int', default: 2, min: 2, max: MAX_GATE_INPUTS },
      WIDTH_PROP,
      LABEL_PROP,
    ],
    role: {
      kind: 'primitive',
      primitive: type,
      mapProps: (p) => ({ inputs: intOf(p, 'inputs'), width: intOf(p, 'width') }),
    },
    layout: gateLayout,
  };
}

function unaryLayout(props: Props): ComponentLayout {
  const width = intOf(props, 'width');
  return {
    pins: [
      { name: 'in', dir: 'in', width, x: -2, y: 0 },
      { name: 'out', dir: 'out', width, x: 2, y: 0 },
    ],
    bounds: { x: -1, y: -1, w: 2, h: 2 },
  };
}

export const GATE_DEFS: ComponentTypeDef[] = [
  gate('and', 'AND', 'Outputs 1 when all inputs are 1.'),
  gate('or', 'OR', 'Outputs 1 when any input is 1.'),
  gate('nand', 'NAND', 'Outputs 0 when all inputs are 1.'),
  gate('nor', 'NOR', 'Outputs 0 when any input is 1.'),
  gate('xor', 'XOR', 'Outputs 1 when an odd number of inputs are 1.'),
  gate('xnor', 'XNOR', 'Outputs 1 when an even number of inputs are 1.'),
  {
    type: 'not',
    name: 'NOT',
    category: 'Gates',
    description: 'Inverts its input.',
    props: [WIDTH_PROP, LABEL_PROP],
    role: { kind: 'primitive', primitive: 'not', mapProps: (p) => ({ width: intOf(p, 'width') }) },
    layout: unaryLayout,
  },
  {
    type: 'buffer',
    name: 'Buffer',
    category: 'Gates',
    description: 'Copies its input after one gate delay.',
    props: [WIDTH_PROP, LABEL_PROP],
    role: { kind: 'primitive', primitive: 'buffer', mapProps: (p) => ({ width: intOf(p, 'width') }) },
    layout: unaryLayout,
  },
  {
    type: 'tristate',
    name: 'Tri-state buffer',
    category: 'Gates',
    description: 'Drives its input onto the output while enable is 1; otherwise releases the output (Z). Use it to share a bus between several drivers.',
    props: [WIDTH_PROP, LABEL_PROP],
    role: { kind: 'primitive', primitive: 'tristate', mapProps: (p) => ({ width: intOf(p, 'width') }) },
    layout: (props) => {
      const width = intOf(props, 'width');
      return {
        pins: [
          { name: 'in', dir: 'in', width, x: -2, y: 0 },
          { name: 'en', dir: 'in', width: 1, x: 0, y: 1 },
          { name: 'out', dir: 'out', width, x: 2, y: 0 },
        ],
        bounds: { x: -1, y: -1, w: 2, h: 2 },
      };
    },
  },
];
