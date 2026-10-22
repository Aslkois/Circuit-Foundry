import type { Props } from '../types.ts';
import { LABEL_PROP, strOf, type CircuitInterface, type ComponentLayout, type ComponentTypeDef, type PinLayout } from './types.ts';

export const SUBCIRCUIT_HALF_WIDTH = 3;

/** Pin offsets along one side, centred: n pins two units apart. */
function sideOffsets(n: number): number[] {
  return Array.from({ length: n }, (_, i) => -n + 1 + 2 * i);
}

export function subcircuitLayout(iface: CircuitInterface | undefined): ComponentLayout {
  const inputs = iface?.inputs ?? [];
  const outputs = iface?.outputs ?? [];
  const rows = Math.max(1, inputs.length, outputs.length);
  const hw = SUBCIRCUIT_HALF_WIDTH;
  const pins: PinLayout[] = [];
  sideOffsets(inputs.length).forEach((y, i) => {
    const p = inputs[i];
    pins.push({ name: p.id, dir: 'in', width: p.width, x: -hw - 1, y, label: p.label });
  });
  sideOffsets(outputs.length).forEach((y, i) => {
    const p = outputs[i];
    pins.push({ name: p.id, dir: 'out', width: p.width, x: hw + 1, y, label: p.label });
  });
  return { pins, bounds: { x: -hw, y: -rows, w: 2 * hw, h: 2 * rows } };
}

export const SUBCIRCUIT_DEF: ComponentTypeDef = {
  type: 'subcircuit',
  name: 'Subcircuit',
  category: 'Circuits',
  description: 'An instance of another circuit in this project. Its Input and Output pins become the ports.',
  props: [{ name: 'circuit', label: 'Circuit', kind: 'string', default: '', hidden: true }, LABEL_PROP],
  role: { kind: 'subcircuit' },
  hiddenInPalette: true,
  layout: (props: Props, ctx) => subcircuitLayout(ctx.getInterface(strOf(props, 'circuit'))),
};
