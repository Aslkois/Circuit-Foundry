import { MAX_ADDR_WIDTH, parseRomContents } from '../../engine/primitives/memory.ts';
import { TRIGGERS } from '../../engine/primitives/sequential.ts';
import type { Props } from '../types.ts';
import { LABEL_PROP, WIDTH_PROP, intOf, strOf, type ComponentTypeDef, type PropDef } from './types.ts';

const TRIGGER_PROP: PropDef = {
  name: 'trigger',
  label: 'Trigger',
  kind: 'enum',
  default: 'rising',
  options: TRIGGERS.map((t) => ({ value: t, label: t === 'rising' ? 'Rising edge' : 'Falling edge' })),
};

const MEMORY_NOTE =
  'Optimized behavioural model, not built from gates. Use it for large memories; the RAM example shows how memory is built from gates.';

const ADDR_PROP: PropDef = { name: 'addrWidth', label: 'Address bits', kind: 'int', default: 4, min: 1, max: MAX_ADDR_WIDTH, help: 'The memory holds 2^bits words.' };
const DATA_PROP: PropDef = { name: 'width', label: 'Data bits', kind: 'int', default: 8, min: 1, max: 32 };

const PRIMITIVE_NOTE =
  'Optimized behavioural model, not built from gates. It powers up holding 0. Use the gate-level examples to see how storage is built from logic.';

export const MEMORY_DEFS: ComponentTypeDef[] = [
  {
    type: 'ram',
    name: 'RAM',
    category: 'Memory',
    description:
      'Random-access memory. Q always shows the word at address A; on a rising CLK edge with WE = 1 the word at A is replaced by D. Powers up holding 0. Select it to view and edit its contents.',
    primitiveNote: MEMORY_NOTE,
    props: [ADDR_PROP, DATA_PROP, LABEL_PROP],
    role: {
      kind: 'primitive',
      primitive: 'ram',
      mapProps: (p: Props) => ({ addrWidth: intOf(p, 'addrWidth'), width: intOf(p, 'width') }),
    },
    layout: (props: Props) => {
      const aw = intOf(props, 'addrWidth');
      const w = intOf(props, 'width');
      return {
        pins: [
          { name: 'A', dir: 'in', width: aw, x: -4, y: -3, label: 'A' },
          { name: 'D', dir: 'in', width: w, x: -4, y: -1, label: 'D' },
          { name: 'WE', dir: 'in', width: 1, x: -4, y: 1, label: 'WE' },
          { name: 'CLK', dir: 'in', width: 1, x: -4, y: 3, label: '>' },
          { name: 'Q', dir: 'out', width: w, x: 4, y: -3, label: 'Q' },
        ],
        bounds: { x: -3, y: -4, w: 6, h: 8 },
      };
    },
  },
  {
    type: 'rom',
    name: 'ROM',
    category: 'Memory',
    description: 'Read-only memory: Q shows the word at address A. Its contents are saved with the project; select it to edit them.',
    primitiveNote: MEMORY_NOTE,
    props: [
      ADDR_PROP,
      DATA_PROP,
      {
        name: 'contents',
        label: 'Contents',
        kind: 'string',
        default: '',
        hidden: true,
        check: (v, p) => {
          if (typeof v !== 'string') return null;
          const r = parseRomContents(v, 2 ** intOf(p, 'addrWidth'), intOf(p, 'width'));
          return typeof r === 'string' ? r : null;
        },
      },
      LABEL_PROP,
    ],
    role: {
      kind: 'primitive',
      primitive: 'rom',
      mapProps: (p: Props) => ({ addrWidth: intOf(p, 'addrWidth'), width: intOf(p, 'width'), contents: strOf(p, 'contents') }),
    },
    layout: (props: Props) => ({
      pins: [
        { name: 'A', dir: 'in', width: intOf(props, 'addrWidth'), x: -4, y: 0, label: 'A' },
        { name: 'Q', dir: 'out', width: intOf(props, 'width'), x: 4, y: 0, label: 'Q' },
      ],
      bounds: { x: -3, y: -2, w: 6, h: 4 },
    }),
  },
  {
    type: 'dff',
    name: 'D flip-flop',
    category: 'Memory',
    description: 'Edge-triggered D flip-flop: Q takes the value of D at each active clock edge.',
    primitiveNote: PRIMITIVE_NOTE,
    props: [WIDTH_PROP, TRIGGER_PROP, LABEL_PROP],
    role: {
      kind: 'primitive',
      primitive: 'dff',
      mapProps: (p: Props) => ({ width: intOf(p, 'width'), trigger: strOf(p, 'trigger') }),
    },
    layout: (props: Props) => {
      const width = intOf(props, 'width');
      return {
        pins: [
          { name: 'D', dir: 'in', width, x: -3, y: -1, label: 'D' },
          { name: 'CLK', dir: 'in', width: 1, x: -3, y: 1, label: '>' },
          { name: 'Q', dir: 'out', width, x: 3, y: -1, label: 'Q' },
          { name: 'NQ', dir: 'out', width, x: 3, y: 1, label: 'Q̅' },
        ],
        bounds: { x: -2, y: -2, w: 4, h: 4 },
      };
    },
  },
  {
    type: 'register',
    name: 'Register',
    category: 'Memory',
    description:
      'Multi-bit register. On each active clock edge it loads D if EN is 1 (or unconnected). CLR = 1 clears it immediately.',
    primitiveNote: PRIMITIVE_NOTE,
    props: [{ ...WIDTH_PROP, default: 8 }, TRIGGER_PROP, LABEL_PROP],
    role: {
      kind: 'primitive',
      primitive: 'register',
      mapProps: (p: Props) => ({ width: intOf(p, 'width'), trigger: strOf(p, 'trigger') }),
    },
    layout: (props: Props) => {
      const width = intOf(props, 'width');
      return {
        pins: [
          { name: 'D', dir: 'in', width, x: -3, y: -2, label: 'D' },
          { name: 'EN', dir: 'in', width: 1, x: -3, y: 0, label: 'EN' },
          { name: 'CLK', dir: 'in', width: 1, x: -3, y: 2, label: '>' },
          { name: 'CLR', dir: 'in', width: 1, x: 0, y: 4, label: 'CLR' },
          { name: 'Q', dir: 'out', width, x: 3, y: -2, label: 'Q' },
        ],
        bounds: { x: -2, y: -3, w: 4, h: 6 },
      };
    },
  },
];
