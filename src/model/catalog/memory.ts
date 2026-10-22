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

const PRIMITIVE_NOTE =
  'Optimized behavioural model, not built from gates. It powers up holding 0. Use the gate-level examples to see how storage is built from logic.';

export const MEMORY_DEFS: ComponentTypeDef[] = [
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
