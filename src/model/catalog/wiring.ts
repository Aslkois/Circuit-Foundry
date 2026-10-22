import type { PropValue, Props } from '../types.ts';
import { intOf, strOf, type ComponentTypeDef, type PinLayout } from './types.ts';

/**
 * Splitter bit assignment. `mapping` lists, for each bus bit starting at bit 0,
 * the arm it belongs to ("0,0,1,1"), or "-" to leave the bit unconnected.
 * An empty mapping distributes bits evenly: arm 0 gets the lowest bits.
 */
export function defaultSplitterMapping(busWidth: number, fanout: number): number[] {
  const out: number[] = [];
  const base = Math.floor(busWidth / fanout);
  const extra = busWidth % fanout;
  for (let arm = 0; arm < fanout; arm++) {
    const n = base + (arm < extra ? 1 : 0);
    for (let i = 0; i < n; i++) out.push(arm);
  }
  return out;
}

/** Parse a mapping string; returns null when malformed for the given sizes. */
export function parseSplitterMapping(text: string, busWidth: number, fanout: number): number[] | null {
  const parts = text.split(',').map((s) => s.trim());
  if (parts.length !== busWidth) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (p === '-') {
      out.push(-1);
      continue;
    }
    if (!/^\d+$/.test(p)) return null;
    const arm = Number(p);
    if (arm >= fanout) return null;
    out.push(arm);
  }
  return out;
}

export function splitterMapping(props: Props): number[] {
  const busWidth = intOf(props, 'busWidth');
  const fanout = intOf(props, 'fanout');
  const text = strOf(props, 'mapping');
  return (text && parseSplitterMapping(text, busWidth, fanout)) || defaultSplitterMapping(busWidth, fanout);
}

/** Bus bit indexes carried by each arm, in ascending order (arm bit 0 = lowest bus bit). */
export function splitterArmBits(props: Props): number[][] {
  const fanout = intOf(props, 'fanout');
  const arms: number[][] = Array.from({ length: fanout }, () => []);
  splitterMapping(props).forEach((arm, bit) => {
    if (arm >= 0) arms[arm].push(bit);
  });
  return arms;
}

/** "3", "0-3", or "0,2,5" style description of a bit list. */
export function describeBits(bits: number[]): string {
  if (bits.length === 0) return '';
  const contiguous = bits.every((b, i) => i === 0 || b === bits[i - 1] + 1);
  if (bits.length === 1) return String(bits[0]);
  if (contiguous) return `${bits[0]}-${bits[bits.length - 1]}`;
  return bits.join(',');
}

export const WIRING_DEFS: ComponentTypeDef[] = [
  {
    type: 'splitter',
    name: 'Splitter',
    category: 'Wiring',
    description:
      'Joins a multi-bit bus (the single end) with narrower wires (the arms). Works in both directions: it splits a bus into parts or combines parts into a bus.',
    props: [
      { name: 'busWidth', label: 'Bus width', kind: 'int', default: 4, min: 1, max: 32 },
      {
        name: 'fanout',
        label: 'Arms',
        kind: 'int',
        default: 4,
        min: 1,
        max: 32,
        check: (v: PropValue, p: Props) => (typeof v === 'number' && v > intOf(p, 'busWidth') ? 'cannot exceed bus width' : null),
      },
      {
        name: 'mapping',
        label: 'Bit → arm map',
        kind: 'string',
        default: '',
        help: 'Arm index for each bus bit from bit 0, comma separated; "-" leaves a bit unconnected. Empty = split evenly.',
        check: (v: PropValue, p: Props) =>
          typeof v === 'string' && v.trim() !== '' && !parseSplitterMapping(v, intOf(p, 'busWidth'), intOf(p, 'fanout'))
            ? `needs ${intOf(p, 'busWidth')} comma-separated arm numbers below ${intOf(p, 'fanout')}`
            : null,
      },
    ],
    role: { kind: 'splitter' },
    layout: (props: Props) => {
      const busWidth = intOf(props, 'busWidth');
      const arms = splitterArmBits(props);
      const pins: PinLayout[] = [{ name: 'bus', dir: 'inout', width: busWidth, x: 0, y: 0 }];
      arms.forEach((bits, i) => {
        if (bits.length > 0) {
          pins.push({ name: `f${i}`, dir: 'inout', width: bits.length, x: 2, y: i + 1, label: describeBits(bits) });
        }
      });
      return { pins, bounds: { x: 0, y: 0, w: 2, h: arms.length + 0.5 } };
    },
  },
  {
    type: 'text',
    name: 'Text',
    category: 'Annotation',
    description: 'A free text note. It has no electrical function.',
    props: [
      { name: 'text', label: 'Text', kind: 'string', default: 'Note' },
      {
        name: 'size',
        label: 'Size',
        kind: 'enum',
        default: 'medium',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'medium', label: 'Medium' },
          { value: 'large', label: 'Large' },
        ],
      },
    ],
    role: { kind: 'passive' },
    layout: (props: Props) => {
      const scale = textScale(strOf(props, 'size'));
      const lines = strOf(props, 'text').split('\n');
      const w = Math.max(1, Math.max(...lines.map((l) => l.length)) * 0.6 * scale);
      const h = Math.max(1, lines.length * 1.3 * scale);
      return { pins: [], bounds: { x: -w / 2, y: -h / 2, w, h } };
    },
  },
];

export function textScale(size: string): number {
  return size === 'small' ? 0.8 : size === 'large' ? 1.6 : 1.1;
}

