import { widthMask, type LogicValue } from '../../engine/logic.ts';

/** Canvas palette. Signal colours carry meaning; everything else stays quiet. */
export const COLORS = {
  background: '#15171c',
  gridDot: '#2b3039',
  gridDotMajor: '#3f4652',
  body: '#1c2028',
  bodyStroke: '#b4bcc8',
  bodyStrokeDim: '#6e7681',
  text: '#d0d7de',
  textDim: '#8b949e',
  label: '#9aa4b1',
  selection: '#4c9dff',
  selectionFill: 'rgba(76, 157, 255, 0.10)',
  hover: 'rgba(127, 182, 255, 0.55)',
  ghost: 'rgba(180, 188, 200, 0.55)',
  error: '#f85149',
  warning: '#f0883e',

  // Signal states
  low: '#2f7d4f',
  high: '#4ade80',
  floating: '#6e7681',
  unknown: '#5b9cf5',
  contention: '#f85149',
  widthError: '#f0883e',
  bus: '#d8b04a',
  noNet: '#8b949e',

  cellOff: '#232833',
  cellOn: '#2f9e5b',
  ledOff: '#20262f',
} as const;

export const LED_ON: Record<string, string> = {
  green: '#4ade80',
  red: '#ff5d5d',
  yellow: '#facc15',
  blue: '#60a5fa',
  white: '#f5f7fa',
};

/** Colour for a wire carrying `v`. Multi-bit buses use one colour unless something is wrong. */
export function signalColor(v: LogicValue | null, contended = false): string {
  if (!v) return COLORS.noNet;
  if (contended) return COLORS.contention;
  const m = widthMask(v.width);
  if (v.width === 1) {
    if (v.b === 0) return v.a ? COLORS.high : COLORS.low;
    return v.a ? COLORS.unknown : COLORS.floating;
  }
  if (v.b === 0) return COLORS.bus;
  if (v.a === 0 && v.b === m) return COLORS.floating;
  return COLORS.unknown;
}

/** Base size of one grid unit in CSS pixels at 100% zoom. */
export const UNIT_PX = 16;

export const FONT_UI = '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif';
export const FONT_MONO = '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace';
