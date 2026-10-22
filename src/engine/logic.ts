/**
 * Four-state logic vectors.
 *
 * A vector of `width` bits (1..MAX_WIDTH) is stored as two 32-bit words using
 * the Verilog aval/bval encoding, bit by bit:
 *
 *   a=0 b=0 → 0      a=1 b=0 → 1      a=0 b=1 → Z (floating)      a=1 b=1 → X (unknown)
 *
 * Words are kept in the signed int32 domain (the natural result of JS bitwise
 * operators) and are always masked to the vector width. Use `toUnsigned` /
 * formatting helpers for presentation.
 */

export const MAX_WIDTH = 32;

/** Bit mask for a vector of the given width. */
export function widthMask(width: number): number {
  return (-1 >>> (32 - width)) | 0;
}

export function isValidWidth(width: unknown): width is number {
  return typeof width === 'number' && Number.isInteger(width) && width >= 1 && width <= MAX_WIDTH;
}

export interface LogicValue {
  readonly width: number;
  readonly a: number;
  readonly b: number;
}

export type BitState = '0' | '1' | 'x' | 'z';

export function logic(width: number, a: number, b: number): LogicValue {
  const m = widthMask(width);
  return { width, a: a & m, b: b & m };
}

/** A fully known value from a non-negative integer (truncated to width). */
export function fromUnsigned(width: number, n: number): LogicValue {
  return logic(width, n | 0, 0);
}

export function allZ(width: number): LogicValue {
  return logic(width, 0, -1);
}

export function allX(width: number): LogicValue {
  return logic(width, -1, -1);
}

export function bitAt(v: LogicValue, i: number): BitState {
  const a = (v.a >>> i) & 1;
  const b = (v.b >>> i) & 1;
  if (b === 0) return a === 1 ? '1' : '0';
  return a === 1 ? 'x' : 'z';
}

export function withBit(v: LogicValue, i: number, bit: BitState): LogicValue {
  const m = 1 << i;
  let a = v.a & ~m;
  let b = v.b & ~m;
  if (bit === '1' || bit === 'x') a |= m;
  if (bit === 'x' || bit === 'z') b |= m;
  return logic(v.width, a, b);
}

export function isFullyKnown(v: LogicValue): boolean {
  return v.b === 0;
}

export function hasX(v: LogicValue): boolean {
  return (v.a & v.b) !== 0;
}

export function isAllZ(v: LogicValue): boolean {
  return v.a === 0 && v.b === widthMask(v.width);
}

export function sameValue(x: LogicValue, y: LogicValue): boolean {
  return x.width === y.width && x.a === y.a && x.b === y.b;
}

/** Unsigned integer value, or null when any bit is X or Z. */
export function toUnsigned(v: LogicValue): number | null {
  if (v.b !== 0) return null;
  return v.a >>> 0;
}

/** Two's complement signed value, or null when any bit is X or Z. */
export function toSigned(v: LogicValue): number | null {
  if (v.b !== 0) return null;
  if (v.width >= 32) return v.a | 0;
  const sign = 1 << (v.width - 1);
  return (v.a & sign) !== 0 ? (v.a | 0) - (1 << v.width) : v.a;
}

/** MSB-first binary string, using x and z for unknown and floating bits. */
export function formatBinary(v: LogicValue): string {
  let s = '';
  for (let i = v.width - 1; i >= 0; i--) s += bitAt(v, i);
  return s;
}

/** Hex string; a digit is 'z' if all its bits float, 'x' if any bit is unknown/floating. */
export function formatHex(v: LogicValue): string {
  const digits = Math.ceil(v.width / 4);
  let s = '';
  for (let d = digits - 1; d >= 0; d--) {
    const bits = Math.min(4, v.width - d * 4);
    const m = (1 << bits) - 1;
    const a = (v.a >>> (d * 4)) & m;
    const b = (v.b >>> (d * 4)) & m;
    if (b === 0) s += a.toString(16);
    else if (b === m && a === 0) s += 'z';
    else s += 'x';
  }
  return s;
}

export function formatDecimal(v: LogicValue, signed = false): string {
  const n = signed ? toSigned(v) : toUnsigned(v);
  if (n !== null) return String(n);
  if (isAllZ(v)) return 'z';
  return 'x';
}

export type Radix = 'bin' | 'hex' | 'dec' | 'sdec';

export function formatValue(v: LogicValue, radix: Radix): string {
  switch (radix) {
    case 'bin':
      return formatBinary(v);
    case 'hex':
      return formatHex(v);
    case 'dec':
      return formatDecimal(v, false);
    case 'sdec':
      return formatDecimal(v, true);
  }
}

/**
 * Parse a user-entered value. Accepts:
 *  - decimal integers ("13", "-3" as two's complement)
 *  - hexadecimal with 0x prefix ("0x1f")
 *  - binary with 0b prefix, allowing x/z digits ("0b10x1")
 *  - a single "x" or "z" to fill the whole vector
 * Returns null when the text is not a valid value for the width.
 */
export function parseValue(text: string, width: number): LogicValue | null {
  const t = text.trim().toLowerCase().replace(/_/g, '');
  if (t === '') return null;
  if (t === 'x') return allX(width);
  if (t === 'z') return allZ(width);
  if (t.startsWith('0b')) {
    const digits = t.slice(2);
    if (digits.length === 0 || digits.length > width || !/^[01xz]+$/.test(digits)) return null;
    let v = fromUnsigned(width, 0);
    for (let i = 0; i < digits.length; i++) {
      v = withBit(v, digits.length - 1 - i, digits[i] as BitState);
    }
    return v;
  }
  let n: number;
  if (t.startsWith('0x')) {
    if (!/^[0-9a-f]+$/.test(t.slice(2))) return null;
    n = parseInt(t.slice(2), 16);
  } else {
    if (!/^-?[0-9]+$/.test(t)) return null;
    n = parseInt(t, 10);
  }
  if (!Number.isSafeInteger(n)) return null;
  const max = 2 ** width;
  if (n >= max || n < -(max / 2)) return null;
  if (n < 0) n += max;
  return fromUnsigned(width, n >>> 0);
}

/* ------------------------------------------------------------------------ */
/* Word-level operations used on the simulator hot path. They operate on raw */
/* (a, b) words; callers mask results to the vector width.                   */
/* ------------------------------------------------------------------------ */

/**
 * Wired resolution of two drivers on the same bits.
 * Z yields to the other driver; equal known values agree; anything else is X.
 * Returns the `a` word; use `resolveB` for the `b` word.
 */
export function resolveA(a1: number, b1: number, a2: number, b2: number): number {
  const z1 = ~a1 & b1;
  const z2 = ~a2 & b2;
  const nz = ~z1 & ~z2;
  const agree = ~(a1 ^ a2) & ~b1 & ~b2 & nz;
  const conflict = nz & ~agree;
  return (z1 & a2) | (z2 & ~z1 & a1) | (agree & a1) | conflict;
}

export function resolveB(a1: number, b1: number, a2: number, b2: number): number {
  const z1 = ~a1 & b1;
  const z2 = ~a2 & b2;
  const nz = ~z1 & ~z2;
  const agree = ~(a1 ^ a2) & ~b1 & ~b2 & nz;
  const conflict = nz & ~agree;
  return (z1 & b2) | (z2 & ~z1 & b1) | conflict;
}

/** Bits where two drivers actively disagree (one drives 0, the other 1). */
export function contentionBits(a1: number, b1: number, a2: number, b2: number): number {
  return ~b1 & ~b2 & (a1 ^ a2);
}

/** Resolve two LogicValues of equal width (convenience, allocates). */
export function resolve(x: LogicValue, y: LogicValue): LogicValue {
  return logic(x.width, resolveA(x.a, x.b, y.a, y.b), resolveB(x.a, x.b, y.a, y.b));
}
