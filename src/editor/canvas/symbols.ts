import { formatHex, formatValue, logic, type LogicValue, type Radix } from '../../engine/logic.ts';
import {
  bitBoxSize,
  gateHalfHeight,
  gateInputOffsets,
  intOf,
  rotatePoint,
  splitterArmBits,
  strOf,
  textScale,
  type ResolvedComponent,
} from '../../model/index.ts';
import type { Painter } from './painter.ts';
import { COLORS, LED_ON, signalColor } from './theme.ts';

/** Live values a symbol may display. Absent for ghosts and palette icons. */
export interface SignalSource {
  /** Value of the net touching a pin. */
  pin(name: string): LogicValue | null;
  contended(name: string): boolean;
  /** Value driven by an input pin or button (its stored state). */
  source(): LogicValue | null;
  /** Internal state of a primitive (register contents). */
  state(): unknown;
}

export interface SymbolOptions {
  readonly signals: SignalSource | null;
  readonly selected: boolean;
  /** Draw translucent (placement preview). */
  readonly ghost: boolean;
  /** Outline colour override for components with problems. */
  readonly problem?: 'error' | 'warning' | null;
}

type Draw = (p: Painter, rc: ResolvedComponent, o: SymbolOptions) => void;

const BUS_PX = 3.5;
const BIT_PX = 2;

function stroke(o: SymbolOptions): string {
  if (o.selected) return COLORS.selection;
  if (o.problem === 'error') return COLORS.error;
  if (o.problem === 'warning') return COLORS.warning;
  return o.ghost ? COLORS.ghost : COLORS.bodyStroke;
}

function pinColor(o: SymbolOptions, name: string): string {
  if (!o.signals) return o.ghost ? COLORS.ghost : COLORS.bodyStrokeDim;
  return signalColor(o.signals.pin(name), o.signals.contended(name));
}

function pinWidthPx(rc: ResolvedComponent, o: SymbolOptions, name: string): number {
  const v = o.signals?.pin(name);
  const w = v?.width ?? rc.pins.find((x) => x.name === name)?.width ?? 1;
  return w > 1 ? BUS_PX : BIT_PX;
}

/** Pin stub in local coordinates, coloured by the pin's signal. */
function stub(p: Painter, rc: ResolvedComponent, o: SymbolOptions, name: string, x1: number, y1: number, x2: number, y2: number): void {
  const ctx = p.ctx;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = pinColor(o, name);
  ctx.lineWidth = pinWidthPx(rc, o, name) * p.px;
  ctx.lineCap = 'butt';
  ctx.stroke();
}

function body(p: Painter, o: SymbolOptions, path: () => void, fill: string = COLORS.body): void {
  const ctx = p.ctx;
  ctx.beginPath();
  path();
  ctx.fillStyle = o.ghost ? 'rgba(28, 32, 40, 0.6)' : fill;
  ctx.fill();
  ctx.strokeStyle = stroke(o);
  ctx.lineWidth = (o.selected ? 2.2 : 1.5) * p.px;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function roundRect(p: Painter, x: number, y: number, w: number, h: number, r: number): void {
  p.ctx.roundRect(x, y, w, h, r);
}

/* ------------------------------------------------------------------------ */
/* Gates                                                                     */
/* ------------------------------------------------------------------------ */

/** x of the concave back curve of OR-family gates at height y. */
function orBackX(y: number): number {
  if (Math.abs(y) >= 2) return -2.2;
  const t = (2 - y) / 4;
  return -2.2 * ((1 - t) ** 2 + t ** 2) - 2.4 * t * (1 - t);
}

function gate(kind: 'and' | 'or' | 'xor', negate: boolean): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    const n = intOf(rc.props, 'inputs');
    const h = gateHalfHeight(n);
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    gateInputOffsets(n).forEach((y, i) => {
      const end = kind === 'and' ? -2 : orBackX(y) - (kind === 'xor' ? 0.5 : 0) + (Math.abs(y) >= 2 ? 0 : 0.05);
      stub(p, rc, o, `in${i}`, -3, y, Math.abs(y) > 2 ? (kind === 'and' ? -2 : -2.2) : end, y);
    });
    stub(p, rc, o, 'out', negate ? 2.6 : 2, 0, 3, 0);
    if (h > 2) {
      // Wings: extend the back edge to reach outer inputs.
      ctx.beginPath();
      const bx = kind === 'and' ? -2 : -2.2;
      ctx.moveTo(bx, -h);
      ctx.lineTo(bx, -2);
      ctx.moveTo(bx, 2);
      ctx.lineTo(bx, h);
      ctx.strokeStyle = stroke(o);
      ctx.lineWidth = 1.5 * p.px;
      ctx.stroke();
    }
    if (kind === 'and') {
      body(p, o, () => {
        ctx.moveTo(-2, -2);
        ctx.lineTo(0, -2);
        ctx.arc(0, 0, 2, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(-2, 2);
        ctx.closePath();
      });
    } else {
      body(p, o, () => {
        ctx.moveTo(-2.2, -2);
        ctx.quadraticCurveTo(0.6, -2, 2, 0);
        ctx.quadraticCurveTo(0.6, 2, -2.2, 2);
        ctx.quadraticCurveTo(-1.2, 0, -2.2, -2);
        ctx.closePath();
      });
      if (kind === 'xor') {
        ctx.beginPath();
        ctx.moveTo(-2.7, 2);
        ctx.quadraticCurveTo(-1.7, 0, -2.7, -2);
        ctx.strokeStyle = stroke(o);
        ctx.lineWidth = 1.5 * p.px;
        ctx.stroke();
      }
    }
    if (negate) bubble(p, o, 2.3, 0, 0.3);
    ctx.restore();
  };
}

function bubble(p: Painter, o: SymbolOptions, x: number, y: number, r: number): void {
  body(p, o, () => p.ctx.arc(x, y, r, 0, Math.PI * 2));
}

function unary(invert: boolean, tristate = false): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    stub(p, rc, o, 'in', -2, 0, -1, 0);
    stub(p, rc, o, 'out', invert ? 1.1 : 1, 0, 2, 0);
    if (tristate) stub(p, rc, o, 'en', 0, 0.5, 0, 1);
    body(p, o, () => {
      ctx.moveTo(-1, -1);
      ctx.lineTo(invert ? 0.6 : 1, 0);
      ctx.lineTo(-1, 1);
      ctx.closePath();
    });
    if (invert) bubble(p, o, 0.85, 0, 0.25);
    ctx.restore();
  };
}

/* ------------------------------------------------------------------------ */
/* Inputs and outputs                                                        */
/* ------------------------------------------------------------------------ */

function bitStateColors(v: LogicValue | null, bit: number): { fill: string; text: string; label: string } {
  if (!v) return { fill: COLORS.cellOff, text: COLORS.textDim, label: '·' };
  const a = (v.a >>> bit) & 1;
  const b = (v.b >>> bit) & 1;
  if (b === 0) return a ? { fill: COLORS.cellOn, text: '#ffffff', label: '1' } : { fill: COLORS.cellOff, text: COLORS.text, label: '0' };
  return a ? { fill: '#22406e', text: '#cfe2ff', label: 'x' } : { fill: '#2b3038', text: COLORS.textDim, label: 'z' };
}

/** Local centre of the cell showing bit `bit` of a multi-bit pin box (MSB first, eight per row). */
export function bitCellCenter(width: number, boxX: number, boxY: number, bit: number): { x: number; y: number } {
  const idx = width - 1 - bit;
  const row = Math.floor(idx / 8);
  const col = idx % 8;
  return { x: boxX + 1 + col, y: boxY + 1 + row };
}

function bitBox(output: boolean): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    const width = intOf(rc.props, 'width');
    const box = bitBoxSize(width);
    const bx = rc.localBounds.x;
    const by = rc.localBounds.y;
    const v = o.signals ? (output ? o.signals.pin('in') : (o.signals.source() ?? o.signals.pin('out'))) : null;
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    body(p, o, () => roundRect(p, bx, by, box.w, box.h, output ? 0.9 : 0.25));
    const cells: { x: number; y: number; c: ReturnType<typeof bitStateColors> }[] = [];
    const size = width === 1 ? 1.4 : 0.84;
    for (let bit = 0; bit < width; bit++) {
      const c = bitStateColors(v, bit);
      const { x: cx, y: cy } = width === 1 ? { x: bx + box.w / 2, y: by + box.h / 2 } : bitCellCenter(width, bx, by, bit);
      ctx.beginPath();
      if (output && width === 1) ctx.arc(cx, cy, 0.7, 0, Math.PI * 2);
      else roundRect(p, cx - size / 2, cy - size / 2, size, size, width === 1 ? 0.2 : 0.12);
      ctx.fillStyle = o.ghost ? 'rgba(40,45,55,0.5)' : c.fill;
      ctx.fill();
      cells.push({ x: cx, y: cy, c });
    }
    ctx.restore();
    if (!o.ghost) {
      for (const cell of cells) {
        const w = rotatePoint(cell.x, cell.y, rc.comp.rotation);
        p.text(cell.c.label, rc.comp.x + w.x, rc.comp.y + w.y, { size: width === 1 ? 0.95 : 0.62, color: cell.c.text, mono: true, bold: true });
      }
    }
  };
}

function button(): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    const pressed = o.signals?.source()?.a === 1;
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    body(p, o, () => roundRect(p, -2, -1, 2, 2, 0.25));
    ctx.beginPath();
    roundRect(p, -1.65, -0.65, 1.3, 1.3, 0.35);
    ctx.fillStyle = pressed ? COLORS.cellOn : '#3a404b';
    ctx.fill();
    if (!pressed) {
      ctx.strokeStyle = '#59606c';
      ctx.lineWidth = 1 * p.px;
      ctx.stroke();
    }
    ctx.restore();
  };
}

function constant(): Draw {
  return (p, rc, o) => {
    const width = intOf(rc.props, 'width');
    const b = rc.localBounds;
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    body(p, o, () => roundRect(p, b.x, b.y, b.w, b.h, 0.2), '#20252e');
    p.ctx.restore();
    const v = logic(width, intOf(rc.props, 'value'), 0);
    const label = width === 1 ? String(v.a & 1) : `0x${formatHex(v)}`;
    const c = rotatePoint(b.x + b.w / 2, 0, rc.comp.rotation);
    p.text(label, rc.comp.x + c.x, rc.comp.y + c.y, { size: 0.75, mono: true, color: o.ghost ? COLORS.ghost : COLORS.text });
  };
}

function clock(): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    const v = o.signals?.pin('out') ?? null;
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    body(p, o, () => roundRect(p, -2, -1, 2, 2, 0.25));
    ctx.beginPath();
    ctx.moveTo(-1.7, 0.45);
    ctx.lineTo(-1.35, 0.45);
    ctx.lineTo(-1.35, -0.45);
    ctx.lineTo(-0.85, -0.45);
    ctx.lineTo(-0.85, 0.45);
    ctx.lineTo(-0.35, 0.45);
    ctx.lineTo(-0.35, -0.45);
    ctx.strokeStyle = o.signals ? signalColor(v) : stroke(o);
    ctx.lineWidth = 1.8 * p.px;
    ctx.stroke();
    ctx.restore();
  };
}

function led(): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    const v = o.signals?.pin('in') ?? null;
    const on = v !== null && v.b === 0 && (v.a & 1) === 1;
    const color = LED_ON[strOf(rc.props, 'color')] ?? LED_ON.green;
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    stub(p, rc, o, 'in', 0, 0, 0.2, 0);
    let fill: string = COLORS.ledOff;
    if (o.ghost) fill = 'rgba(40,45,55,0.5)';
    else if (on) fill = color;
    else if (v && (v.b & 1) === 1) fill = (v.a & 1) === 1 ? '#22406e' : '#2b3038';
    if (on && !o.ghost) {
      ctx.beginPath();
      ctx.arc(1, 0, 1.25, 0, Math.PI * 2);
      ctx.fillStyle = `${color}33`;
      ctx.fill();
    }
    body(p, o, () => ctx.arc(1, 0, 0.8, 0, Math.PI * 2), fill);
    ctx.restore();
  };
}

function probe(): Draw {
  return (p, rc, o) => {
    const v = o.signals?.pin('in') ?? null;
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    body(p, o, () => roundRect(p, 0, -1, 5, 2, 0.5), '#191d24');
    p.ctx.restore();
    let label = '—';
    if (v) {
      const radix = strOf(rc.props, 'radix') as Radix;
      label = formatValue(v, v.width === 1 ? 'bin' : radix);
      if (radix === 'hex' && v.width > 1) label = `0x${label}`;
    }
    const c = rotatePoint(2.5, 0, rc.comp.rotation);
    const maxW = 4.4;
    let size = 0.8;
    const w = p.measure(label, size, true);
    if (w > maxW) size = Math.max(0.35, (size * maxW) / w);
    p.text(label, rc.comp.x + c.x, rc.comp.y + c.y, { size, mono: true, color: o.signals ? valueTextColor(v) : COLORS.ghost });
  };
}

function valueTextColor(v: LogicValue | null): string {
  if (!v) return COLORS.textDim;
  if (v.b === 0) return COLORS.text;
  return signalColor(v);
}

/* ------------------------------------------------------------------------ */
/* Wiring, memory, subcircuits, annotation                                   */
/* ------------------------------------------------------------------------ */

function splitter(): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    const arms = splitterArmBits(rc.props);
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    // Arms
    arms.forEach((bits, i) => {
      if (bits.length === 0) return;
      stub(p, rc, o, `f${i}`, 1, i + 1, 2, i + 1);
    });
    // Spine
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(1, 1);
    ctx.lineTo(1, Math.max(1, arms.length));
    ctx.strokeStyle = o.selected ? COLORS.selection : o.signals ? pinColor(o, 'bus') : stroke(o);
    ctx.lineWidth = (o.selected ? 5 : 4) * p.px;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
    arms.forEach((bits, i) => {
      if (bits.length === 0) return;
      const label = bits.length === 1 ? String(bits[0]) : bits.every((b, k) => k === 0 || b === bits[k - 1] + 1) ? `${bits[0]}-${bits[bits.length - 1]}` : bits.join(',');
      const at = rotatePoint(1.55, i + 1 - 0.38, rc.comp.rotation);
      p.text(label, rc.comp.x + at.x, rc.comp.y + at.y, { size: 0.48, color: COLORS.textDim, mono: true });
    });
  };
}

function boxWithPins(title: string, pinLabels: Record<string, string>, clockPins: string[]): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    const b = rc.localBounds;
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    const local = rc.pins.map((pin) => ({ pin, l: unrotateLocal(rc, pin.x, pin.y) }));
    for (const { pin, l } of local) {
      const ex = Math.min(Math.max(l.x, b.x), b.x + b.w);
      const ey = Math.min(Math.max(l.y, b.y), b.y + b.h);
      stub(p, rc, o, pin.name, l.x, l.y, ex, ey);
    }
    body(p, o, () => roundRect(p, b.x, b.y, b.w, b.h, 0.25));
    for (const name of clockPins) {
      const pl = local.find((x) => x.pin.name === name);
      if (!pl) continue;
      ctx.beginPath();
      ctx.moveTo(b.x, pl.l.y - 0.4);
      ctx.lineTo(b.x + 0.5, pl.l.y);
      ctx.lineTo(b.x, pl.l.y + 0.4);
      ctx.strokeStyle = stroke(o);
      ctx.lineWidth = 1.3 * p.px;
      ctx.stroke();
    }
    ctx.restore();
    for (const { pin, l } of local) {
      const label = pinLabels[pin.name];
      if (!label) continue;
      const inside = { x: l.x < b.x ? b.x + 0.35 : l.x > b.x + b.w ? b.x + b.w - 0.35 : l.x, y: l.y > b.y + b.h ? b.y + b.h - 0.45 : l.y };
      const align: CanvasTextAlign = l.x < b.x ? 'left' : l.x > b.x + b.w ? 'right' : 'center';
      if (clockPins.includes(pin.name)) inside.x += 0.4;
      p.localText(label, rc.comp.x, rc.comp.y, rc.comp.rotation, inside.x, inside.y, { size: 0.55, color: COLORS.textDim, align });
    }
    if (title) {
      const c = rotatePoint(b.x + b.w / 2, b.y + b.h / 2, rc.comp.rotation);
      p.text(title, rc.comp.x + c.x, rc.comp.y + c.y + (rc.def?.type === 'register' ? 0.9 : 0), { size: 0.55, color: COLORS.textDim, bold: true });
    }
  };
}

function unrotateLocal(rc: ResolvedComponent, wx: number, wy: number): { x: number; y: number } {
  const dx = wx - rc.comp.x;
  const dy = wy - rc.comp.y;
  switch (rc.comp.rotation) {
    case 0:
      return { x: dx, y: dy };
    case 90:
      return { x: dy, y: -dx };
    case 180:
      return { x: -dx, y: -dy };
    case 270:
      return { x: -dy, y: dx };
  }
}

const dff = boxWithPins('DFF', { D: 'D', Q: 'Q', NQ: 'Q̅' }, ['CLK']);

const registerBox = (() => {
  const base = boxWithPins('REG', { D: 'D', EN: 'EN', CLR: 'CLR', Q: 'Q' }, ['CLK']);
  return ((p, rc, o) => {
    base(p, rc, o);
    const st = o.signals?.state();
    if (Array.isArray(st) && typeof st[0] === 'number') {
      const v = logic(intOf(rc.props, 'width'), st[0], st[1] as number);
      const c = rotatePoint(0, -0.2, rc.comp.rotation);
      p.text(`0x${formatHex(v)}`, rc.comp.x + c.x, rc.comp.y + c.y, { size: 0.62, mono: true, color: COLORS.text });
    }
  }) as Draw;
})();

function memoryBox(kind: 'RAM' | 'ROM'): Draw {
  const base = boxWithPins('', { A: 'A', D: 'D', WE: 'WE', Q: 'Q' }, ['CLK']);
  return (p, rc, o) => {
    base(p, rc, o);
    const words = 2 ** intOf(rc.props, 'addrWidth');
    const size = words >= 1024 ? `${words / 1024}K` : String(words);
    const c = rotatePoint(0, kind === 'RAM' ? 0.2 : 0, rc.comp.rotation);
    p.text(kind, rc.comp.x + c.x, rc.comp.y + c.y - 0.5, { size: 0.7, color: o.ghost ? COLORS.ghost : COLORS.text, bold: true });
    p.text(`${size} × ${intOf(rc.props, 'width')}`, rc.comp.x + c.x, rc.comp.y + c.y + 0.5, { size: 0.55, color: COLORS.textDim, mono: true });
  };
}

function subcircuit(): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    const b = rc.localBounds;
    const pins = rc.pins.map((pin) => {
      const l = unrotateLocal(rc, pin.x, pin.y);
      const side = l.x < b.x ? 'left' : l.x > b.x + b.w ? 'right' : l.y < b.y ? 'top' : 'bottom';
      return { pin, l, side };
    });
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    for (const { pin, l, side } of pins) {
      const ex = side === 'left' ? b.x : side === 'right' ? b.x + b.w : l.x;
      const ey = side === 'top' ? b.y : side === 'bottom' ? b.y + b.h : l.y;
      stub(p, rc, o, pin.name, l.x, l.y, ex, ey);
    }
    body(p, o, () => roundRect(p, b.x, b.y, b.w, b.h, 0.35), '#1e2430');
    ctx.beginPath();
    roundRect(p, b.x + 0.18, b.y + 0.18, b.w - 0.36, b.h - 0.36, 0.25);
    ctx.strokeStyle = o.ghost ? COLORS.ghost : '#3a4352';
    ctx.lineWidth = 1 * p.px;
    ctx.stroke();
    // Clock markers: a small triangle pointing into the body.
    ctx.strokeStyle = stroke(o);
    ctx.lineWidth = 1.3 * p.px;
    for (const { pin, l, side } of pins) {
      if (!pin.clock) continue;
      ctx.beginPath();
      if (side === 'left' || side === 'right') {
        const x = side === 'left' ? b.x : b.x + b.w;
        const d = side === 'left' ? 0.5 : -0.5;
        ctx.moveTo(x, l.y - 0.4);
        ctx.lineTo(x + d, l.y);
        ctx.lineTo(x, l.y + 0.4);
      } else {
        const y = side === 'top' ? b.y : b.y + b.h;
        const d = side === 'top' ? 0.5 : -0.5;
        ctx.moveTo(l.x - 0.4, y);
        ctx.lineTo(l.x, y + d);
        ctx.lineTo(l.x + 0.4, y);
      }
      ctx.stroke();
    }
    ctx.restore();
    for (const { pin, l, side } of pins) {
      const text = pin.label ?? pin.name;
      const inset = pin.clock ? 0.75 : 0.4;
      if (side === 'left' || side === 'right') {
        const left = side === 'left';
        p.localText(text, rc.comp.x, rc.comp.y, rc.comp.rotation, left ? b.x + inset : b.x + b.w - inset, l.y, {
          size: 0.62,
          color: COLORS.textDim,
          align: left ? 'left' : 'right',
        });
      } else {
        const top = side === 'top';
        p.localText(text, rc.comp.x, rc.comp.y, rc.comp.rotation, l.x, top ? b.y + inset + 0.15 : b.y + b.h - inset - 0.15, { size: 0.55, color: COLORS.textDim });
      }
    }
    if (rc.bodyText) {
      const c = rotatePoint(b.x + b.w / 2, b.y + b.h / 2, rc.comp.rotation);
      p.text(rc.bodyText, rc.comp.x + c.x, rc.comp.y + c.y, { size: 0.75, color: o.ghost ? COLORS.ghost : COLORS.text, bold: true });
    }
  };
}

function tunnel(): Draw {
  return (p, rc, o) => {
    const ctx = p.ctx;
    const b = rc.localBounds;
    p.local(rc.comp.x, rc.comp.y, rc.comp.rotation);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-0.7, b.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(b.x, b.y + b.h);
    ctx.lineTo(-0.7, b.y + b.h);
    ctx.closePath();
    ctx.fillStyle = o.ghost ? 'rgba(28, 32, 40, 0.6)' : COLORS.body;
    ctx.fill();
    ctx.strokeStyle = o.selected || o.problem || !o.signals ? stroke(o) : pinColor(o, 'io');
    ctx.lineWidth = (o.selected ? 2.2 : pinWidthPx(rc, o, 'io') > BIT_PX ? 2 : 1.5) * p.px;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
    p.localText(strOf(rc.props, 'label'), rc.comp.x, rc.comp.y, rc.comp.rotation, (b.x - 0.6) / 2, 0, {
      size: 0.6,
      mono: true,
      color: o.ghost ? COLORS.ghost : COLORS.text,
    });
  };
}

function textNote(): Draw {
  return (p, rc, o) => {
    const scale = textScale(strOf(rc.props, 'size'));
    const lines = strOf(rc.props, 'text').split('\n');
    const lh = 1.3 * scale;
    const top = rc.comp.y - ((lines.length - 1) * lh) / 2;
    lines.forEach((line, i) => {
      p.text(line, rc.comp.x, top + i * lh, { size: 0.8 * scale, color: o.selected ? COLORS.selection : o.ghost ? COLORS.ghost : COLORS.label });
    });
  };
}

function unknown(): Draw {
  return (p, rc) => {
    const ctx = p.ctx;
    const b = rc.bounds;
    ctx.save();
    ctx.setLineDash([0.3, 0.2]);
    ctx.strokeStyle = COLORS.error;
    ctx.lineWidth = 1.5 * p.px;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
    p.text('?', b.x + b.w / 2, b.y + b.h / 2 - 0.4, { size: 1.2, color: COLORS.error, bold: true });
    p.text(rc.comp.type, b.x + b.w / 2, b.y + b.h / 2 + 0.9, { size: 0.5, color: COLORS.error });
  };
}

const DRAW: Record<string, Draw> = {
  and: gate('and', false),
  nand: gate('and', true),
  or: gate('or', false),
  nor: gate('or', true),
  xor: gate('xor', false),
  xnor: gate('xor', true),
  not: unary(true),
  buffer: unary(false),
  tristate: unary(false, true),
  input: bitBox(false),
  output: bitBox(true),
  button: button(),
  constant: constant(),
  clock: clock(),
  led: led(),
  probe: probe(),
  splitter: splitter(),
  tunnel: tunnel(),
  dff,
  register: registerBox,
  ram: memoryBox('RAM'),
  rom: memoryBox('ROM'),
  subcircuit: subcircuit(),
  text: textNote(),
};

/** Draw a component (Painter must be in world mode). */
export function drawComponent(p: Painter, rc: ResolvedComponent, o: SymbolOptions): void {
  const draw = rc.def ? DRAW[rc.comp.type] : undefined;
  (draw ?? unknown())(p, rc, o);
  drawLabel(p, rc, o);
}

/** The user label next to a component. */
function drawLabel(p: Painter, rc: ResolvedComponent, o: SymbolOptions): void {
  const type = rc.comp.type;
  const label = strOf(rc.props, 'label');
  if (!label || type === 'text' || type === 'subcircuit' || type === 'tunnel') return;
  const b = rc.bounds;
  const color = o.ghost ? COLORS.ghost : COLORS.label;
  if (type === 'input' || type === 'constant' || type === 'clock' || type === 'button') {
    if (rc.comp.rotation === 0) p.text(label, b.x - 0.4, b.y + b.h / 2, { size: 0.7, color, align: 'right' });
    else if (rc.comp.rotation === 180) p.text(label, b.x + b.w + 0.4, b.y + b.h / 2, { size: 0.7, color, align: 'left' });
    else p.text(label, b.x + b.w / 2, b.y - 0.6, { size: 0.7, color });
  } else if (type === 'output' || type === 'led' || type === 'probe') {
    if (rc.comp.rotation === 0) p.text(label, b.x + b.w + 0.4, b.y + b.h / 2, { size: 0.7, color, align: 'left' });
    else if (rc.comp.rotation === 180) p.text(label, b.x - 0.4, b.y + b.h / 2, { size: 0.7, color, align: 'right' });
    else p.text(label, b.x + b.w / 2, b.y - 0.6, { size: 0.7, color });
  } else {
    p.text(label, b.x + b.w / 2, b.y - 0.6, { size: 0.65, color });
  }
}

/** Title shown above subcircuit instances. */
export function drawSubcircuitTitle(p: Painter, rc: ResolvedComponent, circuitName: string, o: SymbolOptions): void {
  const b = rc.bounds;
  const label = strOf(rc.props, 'label');
  const title = label ? `${label}: ${circuitName}` : circuitName;
  p.text(title, b.x + b.w / 2, b.y - 0.6, { size: 0.65, color: o.ghost ? COLORS.ghost : COLORS.text, bold: true });
}
