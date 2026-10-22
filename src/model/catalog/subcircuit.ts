import type { ComponentInstance, Props } from '../types.ts';
import { LABEL_PROP, strOf, type CircuitInterface, type ComponentLayout, type ComponentTypeDef, type PinLayout, type PortDef } from './types.ts';

/** Default body width; also the width of every symbol before custom symbols existed. */
export const DEFAULT_SYMBOL_WIDTH = 6;

/** Number of slots in use on a side (highest slot + 1). */
function slotsOn(ports: readonly PortDef[], side: PortDef['side']): number {
  let n = 0;
  for (const p of ports) if (p.side === side) n = Math.max(n, p.slot + 1);
  return n;
}

/** Body size of a symbol: half-height in rows, width in units (even). */
export function symbolSize(iface: CircuitInterface | undefined): { rows: number; width: number } {
  const ports = iface ? [...iface.inputs, ...iface.outputs] : [];
  const rows = Math.max(1, slotsOn(ports, 'left'), slotsOn(ports, 'right'));
  const cols = Math.max(slotsOn(ports, 'top'), slotsOn(ports, 'bottom'));
  const width = Math.max(iface?.symbolWidth ?? DEFAULT_SYMBOL_WIDTH, 2 * cols + 2);
  return { rows, width: width % 2 === 0 ? width : width + 1 };
}

/**
 * Symbol layout. The anchor is the centre of the body. Ports on each side are
 * two units apart and centred on that side: with the default placement
 * (inputs left, outputs right, width 6) this is exactly the original fixed
 * layout, so older projects keep their wiring.
 */
export function subcircuitLayout(iface: CircuitInterface | undefined): ComponentLayout {
  const ports = iface ? [...iface.inputs, ...iface.outputs] : [];
  const { rows, width } = symbolSize(iface);
  const hw = width / 2;
  const count = { left: slotsOn(ports, 'left'), right: slotsOn(ports, 'right'), top: slotsOn(ports, 'top'), bottom: slotsOn(ports, 'bottom') };
  const pins: PinLayout[] = ports.map((p) => {
    const along = -count[p.side] + 1 + 2 * p.slot;
    const pos =
      p.side === 'left'
        ? { x: -hw - 1, y: along }
        : p.side === 'right'
          ? { x: hw + 1, y: along }
          : p.side === 'top'
            ? { x: along, y: -rows - 1 }
            : { x: along, y: rows + 1 };
    return { name: p.id, dir: p.dir, width: p.width, ...pos, label: p.label, ...(p.clock ? { clock: true } : {}) };
  });
  return { pins, bounds: { x: -hw, y: -rows, w: width, h: 2 * rows }, ...(iface?.symbolLabel ? { bodyText: iface.symbolLabel } : {}) };
}

export const SUBCIRCUIT_DEF: ComponentTypeDef = {
  type: 'subcircuit',
  name: 'Subcircuit',
  category: 'Circuits',
  description: 'An instance of another circuit in this project. Its Input and Output pins become the ports.',
  props: [{ name: 'circuit', label: 'Circuit', kind: 'string', default: '', hidden: true }, LABEL_PROP],
  role: { kind: 'subcircuit' },
  hiddenInPalette: true,
  layout: (props: Props, ctx, instance?: ComponentInstance) => subcircuitLayout(ctx.getInterface(strOf(props, 'circuit'), instance?.props)),
};
