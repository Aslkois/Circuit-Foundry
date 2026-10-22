import type { PinDirection } from '../../engine/primitives/types.ts';
import type { PrimitiveProps } from '../../engine/netlist.ts';
import type { Rect } from '../geometry.ts';
import type { ComponentInstance, ParamDef, PortSide, PropValue, Props } from '../types.ts';

export type Category = 'Gates' | 'Inputs & Outputs' | 'Wiring' | 'Memory' | 'Circuits' | 'Annotation';

export const CATEGORY_ORDER: readonly Category[] = ['Gates', 'Inputs & Outputs', 'Wiring', 'Memory', 'Circuits', 'Annotation'];

export type PropKind = 'int' | 'uint' | 'enum' | 'string' | 'bool';

export interface PropOption {
  readonly value: string;
  readonly label: string;
}

export interface PropDef {
  readonly name: string;
  readonly label: string;
  readonly kind: PropKind;
  readonly default: PropValue;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly PropOption[];
  readonly help?: string;
  /** Not shown in the property editor (managed by the editor itself). */
  readonly hidden?: boolean;
  /** Custom validation beyond kind/min/max/options; returns an error message or null. */
  readonly check?: (value: PropValue, props: Props) => string | null;
}

/** Width 0 marks an auto-width pin (adopts the width of the net it touches). */
export const AUTO_WIDTH = 0;

export interface PinLayout {
  readonly name: string;
  readonly dir: PinDirection;
  readonly width: number;
  /** Local, unrotated offset from the component anchor. */
  readonly x: number;
  readonly y: number;
  /** Optional text drawn next to the pin. */
  readonly label?: string;
  /** Drawn with a clock marker. */
  readonly clock?: boolean;
}

export interface ComponentLayout {
  readonly pins: readonly PinLayout[];
  /** Body bounds in local, unrotated coordinates. */
  readonly bounds: Rect;
  /** Text drawn in the middle of the body (custom symbol label). */
  readonly bodyText?: string;
}

export interface PortDef {
  /** Id of the Input/Output pin component inside the defining circuit. */
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly dir: 'in' | 'out';
  readonly side: PortSide;
  /** Slot along the side (0 = top or leftmost). */
  readonly slot: number;
  readonly clock: boolean;
}

/** The externally visible pins of a circuit used as a subcircuit, and how its symbol looks. */
export interface CircuitInterface {
  readonly circuitId: string;
  readonly name: string;
  /** Input ports in symbol order. */
  readonly inputs: readonly PortDef[];
  /** Output ports in symbol order. */
  readonly outputs: readonly PortDef[];
  /** Body width of the symbol (even). */
  readonly symbolWidth: number;
  /** Text drawn inside the body. */
  readonly symbolLabel: string;
  readonly params: readonly ParamDef[];
}

export interface LayoutContext {
  /**
   * Interface of a circuit in the project. `instanceProps` are the props of
   * the instance asking, whose "@name" entries select parameter values.
   */
  getInterface(circuitId: string, instanceProps?: Props): CircuitInterface | undefined;
}

/** How a document component participates in simulation. */
export type SimRole =
  /** Backed by an engine primitive; layout pin names match engine pin names. */
  | { readonly kind: 'primitive'; readonly primitive: string; readonly mapProps: (props: Props) => PrimitiveProps }
  /** Input pin: a user-controlled source at top level, a port inside a subcircuit. */
  | { readonly kind: 'inputPort' }
  /** Output pin: an indicator at top level, a port inside a subcircuit. */
  | { readonly kind: 'outputPort' }
  /** Reads signals for display only (LED, probe) or has no pins (text). */
  | { readonly kind: 'passive' }
  /** Pure connectivity between a bus and its parts. */
  | { readonly kind: 'splitter' }
  /** Instance of another circuit in the project. */
  | { readonly kind: 'subcircuit' };

export interface ComponentTypeDef {
  readonly type: string;
  readonly name: string;
  readonly category: Category;
  readonly description: string;
  readonly props: readonly PropDef[];
  readonly role: SimRole;
  /** Present for optimized behavioural models, which must not be mistaken for gate-level circuits. */
  readonly primitiveNote?: string;
  /** Hidden from the palette (e.g. subcircuit, which is placed from the circuit list). */
  readonly hiddenInPalette?: boolean;
  /** Layout for normalized props (`instance` gives access to the raw props, e.g. subcircuit parameters). */
  layout(props: Props, ctx: LayoutContext, instance?: ComponentInstance): ComponentLayout;
}

export function intOf(props: Props, name: string): number {
  const v = props[name];
  return typeof v === 'number' ? v : 0;
}

export function strOf(props: Props, name: string): string {
  const v = props[name];
  return typeof v === 'string' ? v : '';
}

export const LABEL_PROP: PropDef = { name: 'label', label: 'Label', kind: 'string', default: '' };

export const WIDTH_PROP: PropDef = {
  name: 'width',
  label: 'Bit width',
  kind: 'int',
  default: 1,
  min: 1,
  max: 32,
};
