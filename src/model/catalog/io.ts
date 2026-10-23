import type { Props } from '../types.ts';
import { AUTO_WIDTH, LABEL_PROP, WIDTH_PROP, intOf, type ComponentTypeDef, type PropDef } from './types.ts';

/** Size of a bit-cell box (input/output pins): 1 bit → 2×2, wider values → up to 8 cells per row. */
export function bitBoxSize(width: number): { w: number; h: number; cols: number; rows: number } {
  if (width === 1) return { w: 2, h: 2, cols: 1, rows: 1 };
  const cols = Math.min(width, 8);
  const rows = Math.ceil(width / 8);
  return { w: cols + 1, h: rows + 1, cols, rows };
}

export const RADIX_PROP: PropDef = {
  name: 'radix',
  label: 'Display',
  kind: 'enum',
  default: 'hex',
  options: [
    { value: 'hex', label: 'Hexadecimal' },
    { value: 'bin', label: 'Binary' },
    { value: 'dec', label: 'Unsigned decimal' },
    { value: 'sdec', label: 'Signed decimal' },
  ],
};

export const LED_COLORS = ['green', 'red', 'yellow', 'blue', 'white'] as const;

export function constantBoxWidth(width: number): number {
  return Math.max(2, Math.ceil(Math.ceil(width / 4) * 0.75) + 1);
}

export const IO_DEFS: ComponentTypeDef[] = [
  {
    type: 'input',
    name: 'Input pin',
    category: 'Inputs & Outputs',
    description:
      'A toggle input. Click its bits to change them while simulating. Inside a circuit used as a component, it becomes one of that component\'s input ports, named by its label.',
    props: [WIDTH_PROP, LABEL_PROP],
    role: { kind: 'inputPort' },
    layout: (props: Props) => {
      const width = intOf(props, 'width');
      const box = bitBoxSize(width);
      return {
        pins: [{ name: 'out', dir: 'out', width, x: 0, y: 0 }],
        bounds: { x: -box.w, y: -box.h / 2, w: box.w, h: box.h },
      };
    },
  },
  {
    type: 'output',
    name: 'Output pin',
    category: 'Inputs & Outputs',
    description:
      'Shows the value it receives. Inside a circuit used as a component, it becomes one of that component\'s output ports, named by its label.',
    props: [WIDTH_PROP, LABEL_PROP],
    role: { kind: 'outputPort' },
    layout: (props: Props) => {
      const width = intOf(props, 'width');
      const box = bitBoxSize(width);
      return {
        pins: [{ name: 'in', dir: 'in', width, x: 0, y: 0 }],
        bounds: { x: 0, y: -box.h / 2, w: box.w, h: box.h },
      };
    },
  },
  {
    type: 'button',
    name: 'Push button',
    category: 'Inputs & Outputs',
    description: 'Outputs 1 only while held down with the mouse.',
    props: [LABEL_PROP],
    role: { kind: 'primitive', primitive: 'input', mapProps: () => ({ width: 1 }) },
    layout: () => ({
      pins: [{ name: 'out', dir: 'out', width: 1, x: 0, y: 0 }],
      bounds: { x: -2, y: -1, w: 2, h: 2 },
    }),
  },
  {
    type: 'constant',
    name: 'Constant',
    category: 'Inputs & Outputs',
    description: 'Drives a fixed value.',
    props: [
      WIDTH_PROP,
      {
        name: 'value',
        label: 'Value',
        kind: 'uint',
        default: 1,
        min: 0,
        max: 0xffffffff,
        check: (v, p) => (typeof v === 'number' && v >= 2 ** intOf(p, 'width') ? `does not fit in ${intOf(p, 'width')} bit(s)` : null),
      },
      LABEL_PROP,
    ],
    role: {
      kind: 'primitive',
      primitive: 'constant',
      mapProps: (p) => ({ width: intOf(p, 'width'), value: intOf(p, 'value') }),
    },
    layout: (props: Props) => {
      const width = intOf(props, 'width');
      const w = constantBoxWidth(width);
      return {
        pins: [{ name: 'out', dir: 'out', width, x: 0, y: 0 }],
        bounds: { x: -w, y: -1, w, h: 2 },
      };
    },
  },
  {
    type: 'clock',
    name: 'Clock',
    category: 'Inputs & Outputs',
    description:
      'Square wave that advances one tick per simulation tick: low for "low ticks", then high for "high ticks". Run the simulation or press Tick to advance it.',
    props: [
      { name: 'highTicks', label: 'High duration (ticks)', kind: 'int', default: 1, min: 1, max: 1000 },
      { name: 'lowTicks', label: 'Low duration (ticks)', kind: 'int', default: 1, min: 1, max: 1000 },
      { name: 'phase', label: 'Phase offset (ticks)', kind: 'int', default: 0, min: 0, max: 1000 },
      LABEL_PROP,
    ],
    role: {
      kind: 'primitive',
      primitive: 'clock',
      mapProps: (p) => ({ highTicks: intOf(p, 'highTicks'), lowTicks: intOf(p, 'lowTicks'), phase: intOf(p, 'phase') }),
    },
    layout: () => ({
      pins: [{ name: 'out', dir: 'out', width: 1, x: 0, y: 0 }],
      bounds: { x: -2, y: -1, w: 2, h: 2 },
    }),
  },
  {
    type: 'led',
    name: 'LED',
    category: 'Inputs & Outputs',
    description: 'Lights when its input is 1.',
    props: [
      {
        name: 'color',
        label: 'Colour',
        kind: 'enum',
        default: 'green',
        options: LED_COLORS.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })),
      },
      LABEL_PROP,
    ],
    role: { kind: 'passive' },
    layout: () => ({
      pins: [{ name: 'in', dir: 'in', width: 1, x: 0, y: 0 }],
      bounds: { x: 0, y: -1, w: 2, h: 2 },
    }),
  },
  {
    type: 'probe',
    name: 'Probe',
    category: 'Inputs & Outputs',
    description: 'Displays the value of whatever it touches, at any bit width.',
    props: [RADIX_PROP, LABEL_PROP],
    role: { kind: 'passive' },
    layout: () => ({
      pins: [{ name: 'in', dir: 'in', width: AUTO_WIDTH, x: 0, y: 0 }],
      bounds: { x: 0, y: -1, w: 5, h: 2 },
    }),
  },
];
