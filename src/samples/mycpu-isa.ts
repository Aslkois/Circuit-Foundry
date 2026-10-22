/*
 * Instruction set of MyCPU, the 8-bit accumulator CPU in the "8-bit
 * computer" example, and a small assembler for it.
 *
 * Every instruction is one 16-bit ROM word and executes in one clock cycle:
 *
 *   15..12  opcode
 *   11      I: the operand is an immediate value (ALU instructions)
 *   11..10  condition (jumps): 00 always, 01 zero, 10 carry, 11 not zero
 *   7..0    operand: an immediate value or a data address
 *
 *   0x0 NOP          no operation
 *   0x1 HLT          stop (the program counter holds)
 *   0x2 ST  addr     MEM[addr] = A
 *   0x3 Jcc addr     jump if the condition holds (JMP, JZ, JC, JNZ)
 *   0x8 LD  x        A = x            x = MEM[addr], or an immediate with the I bit
 *   0x9 ADD x        A = A + x        (LDI, ADDI, SUBI, ... set the I bit)
 *   0xA SUB x        A = A - x
 *   0xB AND x        A = A & x
 *   0xC OR  x        A = A | x
 *   0xD XOR x        A = A ^ x
 *   0xE NOT          A = ~A
 *   0xF SHR          A = A >> 1
 *
 * ALU instructions (0x8-0xF) set Z when the result is 0; ADD and SUB set C
 * to the carry out (for SUB: 1 = no borrow), the others clear it.
 *
 * Data addresses 0x00-0x7F are RAM. Address 0x80 and up is I/O: reading
 * returns the switches, writing sets the output register.
 */

export const OPCODES = {
  NOP: 0x0,
  HLT: 0x1,
  ST: 0x2,
  J: 0x3,
  LD: 0x8,
  ADD: 0x9,
  SUB: 0xa,
  AND: 0xb,
  OR: 0xc,
  XOR: 0xd,
  NOT: 0xe,
  SHR: 0xf,
} as const;

export const IO_ADDRESS = 0x80;

const ALU_MEM: Record<string, number> = { LD: 0x8, ADD: 0x9, SUB: 0xa, AND: 0xb, OR: 0xc, XOR: 0xd };
const ALU_IMM: Record<string, number> = { LDI: 0x8, ADDI: 0x9, SUBI: 0xa, ANDI: 0xb, ORI: 0xc, XORI: 0xd };
const JUMPS: Record<string, number> = { JMP: 0, JZ: 1, JC: 2, JNZ: 3 };
const NO_OPERAND: Record<string, number> = { NOP: 0x0, HLT: 0x1, NOT: 0xe, SHR: 0xf };

export class AsmError extends Error {
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'AsmError';
  }
}

export interface Program {
  readonly words: number[];
  readonly labels: ReadonlyMap<string, number>;
}

/**
 * Assemble a program. Syntax, one statement per line:
 *
 *   label:            define a label (an instruction address)
 *   name = value      define a constant (e.g. a data address)
 *   MNEMONIC [x]      x: number (decimal, 0x hex, 0b binary), label or constant
 *   ; comment
 */
export function assemble(source: string): Program {
  const lines = source.split('\n');
  const symbols = new Map<string, number>();
  const labels = new Map<string, number>();
  const stmts: { line: number; op: string; arg: string | null }[] = [];
  lines.forEach((raw, i) => {
    let text = raw.replace(/;.*$/, '').trim();
    const line = i + 1;
    const label = /^([A-Za-z_]\w*):\s*(.*)$/.exec(text);
    if (label) {
      if (symbols.has(label[1])) throw new AsmError(line, `"${label[1]}" is already defined`);
      symbols.set(label[1], stmts.length);
      labels.set(label[1], stmts.length);
      text = label[2].trim();
    }
    if (text === '') return;
    const equ = /^([A-Za-z_]\w*)\s*=\s*(\S+)$/.exec(text);
    if (equ) {
      if (symbols.has(equ[1])) throw new AsmError(line, `"${equ[1]}" is already defined`);
      symbols.set(equ[1], parseNumber(equ[2], line));
      return;
    }
    const m = /^([A-Za-z]+)(?:\s+(\S+))?$/.exec(text);
    if (!m) throw new AsmError(line, `cannot read "${text}"`);
    stmts.push({ line, op: m[1].toUpperCase(), arg: m[2] ?? null });
  });

  const value = (arg: string | null, line: number): number => {
    if (arg === null) throw new AsmError(line, 'missing operand');
    const v = symbols.has(arg) ? symbols.get(arg)! : parseNumber(arg, line);
    if (v < 0 || v > 255) throw new AsmError(line, `operand ${arg} is outside 0..255`);
    return v;
  };

  const words = stmts.map(({ line, op, arg }) => {
    if (op in NO_OPERAND) {
      if (arg !== null) throw new AsmError(line, `${op} takes no operand`);
      return NO_OPERAND[op] << 12;
    }
    if (op === 'ST') return (OPCODES.ST << 12) | value(arg, line);
    if (op in JUMPS) return (OPCODES.J << 12) | (JUMPS[op] << 10) | value(arg, line);
    if (op in ALU_MEM) return (ALU_MEM[op] << 12) | value(arg, line);
    if (op in ALU_IMM) return (ALU_IMM[op] << 12) | (1 << 11) | value(arg, line);
    throw new AsmError(line, `unknown instruction "${op}"`);
  });
  if (words.length > 256) throw new AsmError(lines.length, 'the program does not fit in 256 words');
  return { words, labels };
}

function parseNumber(text: string, line: number): number {
  const t = text.toLowerCase();
  const v = t.startsWith('0x') ? parseInt(t.slice(2), 16) : t.startsWith('0b') ? parseInt(t.slice(2), 2) : /^\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isInteger(v)) throw new AsmError(line, `"${text}" is not a number or a known name`);
  return v;
}

/** Reference model: run a program the way MyCPU does, for checking the gate-level CPU. */
export function emulate(words: readonly number[], input: number, maxCycles: number): { out: number[]; a: number; ram: number[]; halted: boolean; cycles: number } {
  let pc = 0;
  let a = 0;
  let z = 0;
  let c = 0;
  const out: number[] = [];
  const ram = new Array<number>(128).fill(0);
  let cycles = 0;
  for (; cycles < maxCycles; cycles++) {
    const w = words[pc] ?? 0;
    const op = w >> 12;
    const opd = w & 0xff;
    if (op === OPCODES.HLT) return { out, a, ram, halted: true, cycles };
    let next = (pc + 1) & 0xff;
    if (op === OPCODES.ST) {
      if (opd & 0x80) out.push(a);
      else ram[opd] = a;
    } else if (op === OPCODES.J) {
      const cond = (w >> 10) & 3;
      const take = cond === 0 || (cond === 1 && z === 1) || (cond === 2 && c === 1) || (cond === 3 && z === 0);
      if (take) next = opd;
    } else if (op >= 0x8) {
      const x = w & (1 << 11) ? opd : opd & 0x80 ? input & 0xff : ram[opd];
      let r: number;
      let carry = 0;
      switch (op) {
        case 0x8:
          r = x;
          break;
        case 0x9:
          r = a + x;
          carry = r > 0xff ? 1 : 0;
          break;
        case 0xa:
          r = a + ((~x) & 0xff) + 1;
          carry = r > 0xff ? 1 : 0;
          break;
        case 0xb:
          r = a & x;
          break;
        case 0xc:
          r = a | x;
          break;
        case 0xd:
          r = a ^ x;
          break;
        case 0xe:
          r = ~a;
          break;
        default:
          r = a >> 1;
      }
      a = r & 0xff;
      z = a === 0 ? 1 : 0;
      c = carry;
    }
    pc = next;
  }
  return { out, a, ram, halted: false, cycles };
}

/** The example program: Fibonacci numbers on the output port until the next one would overflow. */
export const FIBONACCI = `; Fibonacci numbers on the output port (address 0x80).
x   = 0x00
y   = 0x01
t   = 0x02
OUT = 0x80

        LDI 0
        ST  x
        LDI 1
        ST  y
loop:   LD  x
        ST  OUT        ; show x
        ADD y          ; A = x + y, C = 1 on overflow
        JC  done
        ST  t
        LD  y
        ST  x          ; x = y
        LD  t
        ST  y          ; y = x + y
        JMP loop
done:   HLT
`;

/** Sum 1 + 2 + ... + N, where N comes from the switches; the result goes to the output port. */
export const SUM_TO_N = `; Output 1 + 2 + ... + N, N read from the switches (0x80).
n   = 0x00
sum = 0x01
IO  = 0x80

        LD   IO        ; A = N
        ST   n
        LDI  0
        ST   sum
loop:   LD   n
        JZ   done
        ADD  sum
        ST   sum       ; sum = sum + n
        LD   n
        SUBI 1
        ST   n         ; n = n - 1
        JMP  loop
done:   LD   sum
        ST   IO
        HLT
`;
