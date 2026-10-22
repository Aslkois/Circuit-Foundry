import { formatRomContents } from '../engine/primitives/memory.ts';
import { ProjectBuilder, type Project } from '../model/index.ts';
import { defineFullAdder, defineHalfAdder, note } from './common.ts';
import { FIBONACCI, assemble } from './mycpu-isa.ts';

/*
 * The 8-bit computer example: MyCPU, an accumulator CPU built entirely from
 * reusable components, placed in a computer with a program ROM, data RAM, a
 * clock, switches and an output register.
 *
 *   half adder → full adder → 8-bit adder ─┐
 *   3→8 decoder ───────────────────────────┼→ ALU ─┐
 *   2:1 multiplexer (parameter N) ─────────┼───────┼→ MyCPU → Computer
 *   control unit (gates) ──────────────────┘       │
 *   registers (A, Z, C, PC) ───────────────────────┘
 *
 * Inside the components most nets are joined by tunnels (named net labels),
 * which keeps the schematics readable. See mycpu-isa.ts for the instruction
 * set.
 */

/** 2:1 multiplexer of width N: Y = S ? B : A, from two tri-state buffers. */
export function defineMux2(pb: ProjectBuilder): void {
  pb.circuit(
    'mux2',
    'Mux 2:1',
    (b) => {
      b.param('N', 8, 1, 32, 'Bit width');
      const a = b.add('input', 0, 0, { label: 'A', width: 8 });
      const bi = b.add('input', 0, 6, { label: 'B', width: 8 });
      const s = b.add('input', 0, 10, { label: 'S' });
      const t1 = b.add('tristate', 6, 0, { width: 8 });
      const t2 = b.add('tristate', 6, 6, { width: 8 });
      const inv = b.add('not', 4, 3);
      const y = b.add('output', 14, 3, { label: 'Y', width: 8 });
      for (const h of [a, bi, t1, t2, y]) b.bind(h, 'width', 'N');
      b.wire(a.pin('out'), t1.pin('in'));
      b.wire(bi.pin('out'), t2.pin('in'));
      b.wire(s.pin('out'), { x: 6, y: 10 }, t2.pin('en'));
      b.wire({ x: 2, y: 10 }, inv.pin('in'));
      b.wire(inv.pin('out'), t1.pin('en'));
      b.wire(t1.pin('out'), { x: 10, y: 0 }, { x: 10, y: 6 }, t2.pin('out'));
      b.wire({ x: 10, y: 3 }, y.pin('in'));
      b.symbol({ label: 'MUX', ports: { [s.id]: { side: 'bottom', slot: 0 } } });
      note(b, 7, -4, 'Y = S ? B : A. The width N is a parameter: each instance chooses its own.');
    },
    'Selects A (S = 0) or B (S = 1). Parameter N sets the bus width.',
  );
}

/** Ripple-carry 8-bit adder from eight full adders. */
function defineAdder8(pb: ProjectBuilder): void {
  pb.circuit(
    'adder8',
    'Adder (8-bit)',
    (b) => {
      const a = b.add('input', 0, 0, { label: 'A', width: 8 });
      const bb = b.add('input', 0, 14, { label: 'B', width: 8 });
      const cin = b.add('input', 0, 28, { label: 'Cin' });
      const sa = b.add('splitter', 4, 0, { busWidth: 8, fanout: 8 });
      const sb = b.add('splitter', 4, 14, { busWidth: 8, fanout: 8 });
      b.wire(a.pin('out'), sa.pin('bus'));
      b.wire(bb.pin('out'), sb.pin('bus'));
      b.tag(cin, 'out', 'c0');
      for (let i = 0; i < 8; i++) {
        b.tag(sa, `f${i}`, `a${i}`, i % 2 ? 7 : 2);
        b.tag(sb, `f${i}`, `b${i}`, i % 2 ? 7 : 2);
        const fa = b.sub('full-adder', 34, 4 + 8 * i, `FA${i}`);
        b.tagPort(fa, 'A', `a${i}`).tagPort(fa, 'B', `b${i}`).tagPort(fa, 'Cin', `c${i}`);
        b.tagPort(fa, 'Sum', `s${i}`).tagPort(fa, 'Cout', `c${i + 1}`);
      }
      const ss = b.add('splitter', 56, 2, { busWidth: 8, fanout: 8 });
      for (let i = 0; i < 8; i++) b.tag(ss, `f${i}`, `s${i}`, i % 2 ? 7 : 2);
      const s = b.add('output', 64, -2, { label: 'S', width: 8 });
      b.wire(ss.pin('bus'), { x: 56, y: -2 }, s.pin('in'));
      const cout = b.add('output', 64, 66, { label: 'Cout' });
      b.tag(cout, 'in', 'c8');
      note(b, 34, -6, 'Eight full adders; carry ci ripples from bit i - 1 to bit i. Tunnels with the same name are connected.');
    },
    'S = A + B + Cin, from eight full adders chained by their carries.',
  );
}

/** 3-to-8 decoder from NOT and AND gates. */
function defineDecoder(pb: ProjectBuilder): void {
  pb.circuit(
    'dec3',
    'Decoder 3→8',
    (b) => {
      const i = b.add('input', 0, 0, { label: 'I', width: 3 });
      const sp = b.add('splitter', 4, 0, { busWidth: 3, fanout: 3 });
      b.wire(i.pin('out'), sp.pin('bus'));
      for (let k = 0; k < 3; k++) {
        b.tag(sp, `f${k}`, `i${k}`, k === 1 ? 7 : 2);
        const n = b.add('not', 18, 2 + 4 * k);
        b.tag(n, 'in', `i${k}`).tag(n, 'out', `n${k}`);
      }
      for (let j = 0; j < 8; j++) {
        const g = b.add('and', 34, 3 + 8 * j, { inputs: 3 });
        for (let k = 0; k < 3; k++) b.tag(g, `in${k}`, (j >> k) & 1 ? `i${k}` : `n${k}`);
        const o = b.add('output', 42, 3 + 8 * j, { label: `O${j}` });
        b.wire(g.pin('out'), o.pin('in'));
      }
      note(b, 22, -4, 'Exactly one output is 1: the one numbered by I.');
    },
    'One-hot decoder: output O(I) is 1, all others 0.',
  );
}

/** 8-bit ALU: 000 B, 001 A+B, 010 A-B, 011 A&B, 100 A|B, 101 A^B, 110 ~A, 111 A>>1. */
function defineAlu(pb: ProjectBuilder): void {
  pb.circuit(
    'alu8',
    'ALU (8-bit)',
    (b) => {
      const ia = b.add('input', 0, 0, { label: 'A', width: 8 });
      const ib = b.add('input', 0, 4, { label: 'B', width: 8 });
      const iop = b.add('input', 0, 8, { label: 'OP', width: 3 });
      b.tag(ia, 'out', 'a').tag(ib, 'out', 'b').tag(iop, 'out', 'op');

      // Operation decoder: e0..e7 enable one result.
      const dec = b.sub('dec3', 14, 30, 'DEC');
      b.tagPort(dec, 'I', 'op');
      for (let j = 0; j < 8; j++) b.tagPort(dec, `O${j}`, `e${j}`);

      // Subtraction: A + ~B + 1. The mask is 0xFF when subtracting (e2), else 0.
      const k00 = b.add('constant', 22, 44, { width: 8, value: 0 });
      const kff = b.add('constant', 22, 48, { width: 8, value: 255 });
      b.tag(k00, 'out', 'k00').tag(kff, 'out', 'kff');
      const mask = b.sub('mux2', 40, 3, 'MASK', 0, { N: 8 });
      b.tagPort(mask, 'A', 'k00').tagPort(mask, 'B', 'kff').tagPort(mask, 'S', 'e2').tagPort(mask, 'Y', 'mask');
      const bx = b.add('xor', 54, 10, { width: 8 });
      b.tag(bx, 'in0', 'b').tag(bx, 'in1', 'mask').tag(bx, 'out', 'bx');
      const add = b.sub('adder8', 70, 12, 'ADDER');
      b.tagPort(add, 'A', 'a').tagPort(add, 'B', 'bx').tagPort(add, 'Cin', 'e2');
      b.tagPort(add, 'S', 'sum').tagPort(add, 'Cout', 'cout');

      // Logic operations.
      const ops: [string, string][] = [
        ['and', 'and'],
        ['or', 'or'],
        ['xor', 'xor'],
      ];
      ops.forEach(([type, net], k) => {
        const g = b.add(type, 54, 22 + 8 * k, { width: 8 });
        b.tag(g, 'in0', 'a').tag(g, 'in1', 'b').tag(g, 'out', net);
      });
      const inv = b.add('not', 54, 46, { width: 8 });
      b.tag(inv, 'in', 'a').tag(inv, 'out', 'nota');

      // Shift right: bits 1..7 of A become bits 0..6; bit 7 is 0.
      const sh1 = b.add('splitter', 50, 52, { busWidth: 8, fanout: 2, mapping: '1,0,0,0,0,0,0,0' });
      b.tag(sh1, 'bus', 'a').tag(sh1, 'f0', 'shr7', 2);
      const sh2 = b.add('splitter', 64, 52, { busWidth: 8, fanout: 2, mapping: '0,0,0,0,0,0,0,1' });
      b.tag(sh2, 'bus', 'shr').tag(sh2, 'f0', 'shr7', 7);
      const zero = b.add('constant', 68, 54, { width: 1, value: 0 }, 180);
      b.wire(sh2.pin('f1'), zero.pin('out'));

      // Result bus: one tri-state buffer per operation, enabled by the decoder.
      const sources = ['b', 'sum', 'sum', 'and', 'or', 'xor', 'nota', 'shr'];
      sources.forEach((src, j) => {
        const t = b.add('tristate', 96, 4 + 8 * j, { width: 8 });
        b.tag(t, 'in', src).tag(t, 'en', `e${j}`).tag(t, 'out', 'y');
      });
      const y = b.add('output', 120, 0, { label: 'Y', width: 8 });
      b.tag(y, 'in', 'y');

      // Z: no result bit is set.
      const zs = b.add('splitter', 104, 70, { busWidth: 8, fanout: 8 });
      b.tag(zs, 'bus', 'y');
      for (let i = 0; i < 8; i++) b.tag(zs, `f${i}`, `y${i}`, i % 2 ? 7 : 2);
      const nor = b.add('nor', 128, 20, { inputs: 8 });
      for (let i = 0; i < 8; i++) b.tag(nor, `in${i}`, `y${i}`, i % 2 ? 7 : 2);
      const z = b.add('output', 134, 20, { label: 'Z' });
      b.wire(nor.pin('out'), z.pin('in'));

      // C: the adder's carry, for ADD and SUB only.
      const isArith = b.add('or', 116, 34);
      b.tag(isArith, 'in0', 'e1').tag(isArith, 'in1', 'e2').tag(isArith, 'out', 'arith');
      const carry = b.add('and', 128, 36);
      b.tag(carry, 'in0', 'cout').tag(carry, 'in1', 'arith');
      const c = b.add('output', 134, 36, { label: 'C' });
      b.wire(carry.pin('out'), c.pin('in'));
      note(b, 60, -6, 'OP: 000 B · 001 A+B · 010 A−B · 011 A AND B · 100 A OR B · 101 A XOR B · 110 NOT A · 111 A >> 1');
    },
    'Eight operations on 8-bit values, with zero and carry flags.',
  );
}

/** Instruction decoding and branch conditions, from gates. */
function defineControl(pb: ProjectBuilder): void {
  pb.circuit(
    'control',
    'Control unit',
    (b) => {
      const op = b.add('input', 0, 0, { label: 'OP', width: 4 });
      const c1 = b.add('input', 0, 6, { label: 'C1' });
      const c0 = b.add('input', 0, 10, { label: 'C0' });
      const zf = b.add('input', 0, 14, { label: 'ZF' });
      const cf = b.add('input', 0, 18, { label: 'CF' });
      const sp = b.add('splitter', 4, 0, { busWidth: 4, fanout: 4 });
      b.wire(op.pin('out'), sp.pin('bus'));
      for (let k = 0; k < 4; k++) b.tag(sp, `f${k}`, `o${k}`, k % 2 ? 7 : 2);
      b.tag(c1, 'out', 'c1').tag(c0, 'out', 'c0').tag(zf, 'out', 'z').tag(cf, 'out', 'cf');
      const inverted: [string, string][] = [
        ['o0', 'n0'],
        ['o1', 'n1'],
        ['o2', 'n2'],
        ['o3', 'n3'],
        ['c1', 'nc1'],
        ['c0', 'nc0'],
        ['z', 'nz'],
      ];
      inverted.forEach(([from, to], k) => {
        const n = b.add('not', 22, 2 + 4 * k);
        b.tag(n, 'in', from).tag(n, 'out', to);
      });
      const and = (y: number, inputs: string[], out: string | null) => {
        const g = b.add('and', 44, y, { inputs: inputs.length });
        inputs.forEach((net, k) => b.tag(g, `in${k}`, net, inputs.length > 3 && k % 2 ? 7 : 2));
        if (out) b.tag(g, 'out', out);
        return g;
      };
      const st = and(2, ['n3', 'n2', 'o1', 'n0'], null); // 0010 ST
      and(10, ['n3', 'n2', 'o1', 'o0'], 'j'); // 0011 jump
      const hlt = and(18, ['n3', 'n2', 'n1', 'o0'], null); // 0001 HLT
      and(26, ['nc1', 'nc0'], 't00'); // always
      and(33, ['nc1', 'c0', 'z'], 't01'); // zero
      and(41, ['c1', 'nc0', 'cf'], 't10'); // carry
      and(49, ['c1', 'c0', 'nz'], 't11'); // not zero
      const take = b.add('or', 62, 30, { inputs: 4 });
      ['t00', 't01', 't10', 't11'].forEach((net, k) => b.tag(take, `in${k}`, net, k % 2 ? 7 : 2));
      b.tag(take, 'out', 'take');
      const jmp = b.add('and', 62, 42);
      b.tag(jmp, 'in0', 'j').tag(jmp, 'in1', 'take');

      const aluw = b.add('output', 76, -4, { label: 'ALUW' });
      b.tag(aluw, 'in', 'o3');
      const ost = b.add('output', 76, 2, { label: 'ST' });
      b.wire(st.pin('out'), ost.pin('in'));
      const ohlt = b.add('output', 76, 18, { label: 'HLT' });
      b.wire(hlt.pin('out'), ohlt.pin('in'));
      const ojmp = b.add('output', 76, 42, { label: 'JMP' });
      b.wire(jmp.pin('out'), ojmp.pin('in'));
      note(b, 40, -8, 'ALUW: opcode 1xxx · ST: 0010 · HLT: 0001 · JMP: 0011 and the condition C1 C0 (always, Z, C, not Z) holds');
    },
    'Decodes the opcode into control signals and evaluates jump conditions.',
  );
}

/** MyCPU: the 8-bit accumulator CPU. */
function defineCpu(pb: ProjectBuilder): void {
  pb.circuit(
    'mycpu',
    'MyCPU',
    (b) => {
      const clk = b.add('input', 0, 0, { label: 'CLK' });
      const rst = b.add('input', 0, 4, { label: 'RST' });
      const instr = b.add('input', 0, 8, { label: 'INSTR', width: 16 });
      const din = b.add('input', 0, 12, { label: 'DIN', width: 8 });
      b.tag(clk, 'out', 'clk').tag(rst, 'out', 'rst').tag(instr, 'out', 'instr').tag(din, 'out', 'din');

      // Instruction fields: operand 7..0, condition / immediate 11..10, opcode 15..12.
      const fields = b.add('splitter', 10, 20, { busWidth: 16, fanout: 5, mapping: '0,0,0,0,0,0,0,0,1,1,2,3,4,4,4,4' });
      b.tag(fields, 'bus', 'instr');
      b.tag(fields, 'f0', 'opd').tag(fields, 'f2', 'c0', 7).tag(fields, 'f3', 'c1', 2).tag(fields, 'f4', 'op', 7);
      const opBits = b.add('splitter', 10, 34, { busWidth: 4, fanout: 2, mapping: '0,0,0,1' });
      b.tag(opBits, 'bus', 'op').tag(opBits, 'f0', 'aluop');

      const ctl = b.sub('control', 40, 10, 'CONTROL');
      b.tagPort(ctl, 'OP', 'op').tagPort(ctl, 'C1', 'c1').tagPort(ctl, 'C0', 'c0').tagPort(ctl, 'ZF', 'zf').tagPort(ctl, 'CF', 'cf');
      b.tagPort(ctl, 'ALUW', 'aluw').tagPort(ctl, 'ST', 'we').tagPort(ctl, 'HLT', 'hlt').tagPort(ctl, 'JMP', 'jmp');

      // Second operand: memory (DIN) or the immediate operand, chosen by the I bit (c1).
      const bsel = b.sub('mux2', 40, 32, 'BSEL', 0, { N: 8 });
      b.tagPort(bsel, 'A', 'din').tagPort(bsel, 'B', 'opd').tagPort(bsel, 'S', 'c1').tagPort(bsel, 'Y', 'bop');
      const alu = b.sub('alu8', 64, 32, 'ALU');
      b.tagPort(alu, 'A', 'acc').tagPort(alu, 'B', 'bop').tagPort(alu, 'OP', 'aluop');
      b.tagPort(alu, 'Y', 'res').tagPort(alu, 'Z', 'zn').tagPort(alu, 'C', 'cn');

      // Registers: accumulator, flags and program counter.
      const reg = (y: number, width: number, label: string, d: string, en: string, q: string) => {
        const r = b.add('register', 92, y, { width, label });
        b.tag(r, 'D', d).tag(r, 'EN', en).tag(r, 'CLK', 'clk').tag(r, 'CLR', 'rst').tag(r, 'Q', q);
      };
      reg(8, 8, 'A', 'res', 'aluw', 'acc');
      reg(24, 1, 'Z', 'zn', 'aluw', 'zf');
      reg(40, 1, 'C', 'cn', 'aluw', 'cf');
      reg(58, 8, 'PC', 'pcn', 'run', 'pc');
      const run = b.add('not', 78, 70);
      b.tag(run, 'in', 'hlt').tag(run, 'out', 'run');

      // Next PC: PC + 1, or the operand when a jump is taken.
      const inc = b.sub('adder8', 40, 58, 'INC');
      const zero = b.add('constant', 16, 52, { width: 8, value: 0 });
      const one = b.add('constant', 16, 58, { width: 1, value: 1 });
      b.tag(zero, 'out', 'zero8').tag(one, 'out', 'one');
      b.tagPort(inc, 'A', 'pc').tagPort(inc, 'B', 'zero8').tagPort(inc, 'Cin', 'one').tagPort(inc, 'S', 'pc1');
      const psel = b.sub('mux2', 64, 58, 'PCSEL', 0, { N: 8 });
      b.tagPort(psel, 'A', 'pc1').tagPort(psel, 'B', 'opd').tagPort(psel, 'S', 'jmp').tagPort(psel, 'Y', 'pcn');

      const outputs: [string, number, string][] = [
        ['PC', 8, 'pc'],
        ['ADDR', 8, 'opd'],
        ['DOUT', 8, 'acc'],
        ['WE', 1, 'we'],
        ['A', 8, 'acc'],
        ['HALT', 1, 'hlt'],
      ];
      outputs.forEach(([label, width, net], k) => {
        const o = b.add('output', 116, 6 * k, { label, width });
        b.tag(o, 'in', net);
      });
      b.symbol({ label: 'MyCPU', width: 10 });
      note(b, 56, -6, 'One instruction per clock cycle. Double-click a block to look inside; every gate is simulated.');
    },
    'An 8-bit accumulator CPU: control unit, ALU, accumulator, flags and program counter.',
  );
}

export const COMPUTER_ROM = assemble(FIBONACCI).words;

/** The computer: MyCPU with program ROM, RAM, clock, switches and an output register. */
function defineComputer(pb: ProjectBuilder, program: readonly number[]): void {
  pb.circuit(
    'computer',
    '8-bit computer',
    (b) => {
      const clk = b.add('clock', 0, 0, { label: 'CLK' });
      const rst = b.add('input', 0, 6, { label: 'RST' });
      const sw = b.add('input', 0, 40, { label: 'IN', width: 8 });
      b.tag(clk, 'out', 'clk').tag(rst, 'out', 'rst').tag(sw, 'out', 'sw');

      const cpu = b.sub('mycpu', 40, 20, 'CPU');
      b.tagPort(cpu, 'CLK', 'clk').tagPort(cpu, 'RST', 'rst').tagPort(cpu, 'INSTR', 'instr').tagPort(cpu, 'DIN', 'din');
      b.tagPort(cpu, 'PC', 'pc').tagPort(cpu, 'ADDR', 'addr').tagPort(cpu, 'DOUT', 'dout').tagPort(cpu, 'WE', 'we');
      b.tagPort(cpu, 'A', 'acc').tagPort(cpu, 'HALT', 'halt');

      const rom = b.add('rom', 20, 56, { addrWidth: 8, width: 16, contents: formatRomContents(program, 16), label: 'PROGRAM' });
      b.tag(rom, 'A', 'pc').tag(rom, 'Q', 'instr');

      // Address map: 0x00-0x7F RAM, 0x80-0xFF I/O.
      const amap = b.add('splitter', 66, 50, { busWidth: 8, fanout: 2, mapping: '0,0,0,0,0,0,0,1' });
      b.tag(amap, 'bus', 'addr').tag(amap, 'f0', 'ra').tag(amap, 'f1', 'io', 7);
      const nio = b.add('not', 70, 62);
      b.tag(nio, 'in', 'io').tag(nio, 'out', 'mem');
      const ramWe = b.add('and', 70, 70);
      b.tag(ramWe, 'in0', 'we').tag(ramWe, 'in1', 'mem').tag(ramWe, 'out', 'ramwe');
      const outWe = b.add('and', 70, 78);
      b.tag(outWe, 'in0', 'we').tag(outWe, 'in1', 'io').tag(outWe, 'out', 'outwe');

      const ram = b.add('ram', 98, 54, { addrWidth: 7, width: 8, label: 'RAM' });
      b.tag(ram, 'A', 'ra').tag(ram, 'D', 'dout').tag(ram, 'WE', 'ramwe').tag(ram, 'CLK', 'clk').tag(ram, 'Q', 'ramq');

      const dsel = b.sub('mux2', 98, 30, 'DSEL', 0, { N: 8 });
      b.tagPort(dsel, 'A', 'ramq').tagPort(dsel, 'B', 'sw').tagPort(dsel, 'S', 'io').tagPort(dsel, 'Y', 'din');

      const outReg = b.add('register', 98, 78, { width: 8, label: 'OUT' });
      b.tag(outReg, 'D', 'dout').tag(outReg, 'EN', 'outwe').tag(outReg, 'CLK', 'clk').tag(outReg, 'CLR', 'rst').tag(outReg, 'Q', 'outq');

      const show: [string, number, string, number][] = [
        ['OUT', 8, 'outq', 0],
        ['ACC', 8, 'acc', 8],
        ['PC', 8, 'pc', 16],
        ['HALT', 1, 'halt', 24],
      ];
      for (const [label, width, net, y] of show) {
        const o = b.add('output', 126, y, { label, width });
        b.tag(o, 'in', net);
      }
      note(b, 56, -8, 'MyCPU runs the program in ROM one instruction per clock cycle. Press Run (or T to tick).');
      note(b, 56, -5, 'Reads from address 0x80 and up return the IN switches; writes there set the OUT register. RST restarts.');
      note(b, 56, 92, 'The program prints Fibonacci numbers on OUT, then halts. Edit the ROM in the inspector to load another program.');
    },
    'MyCPU with program ROM, data RAM, clock, switches and an output register.',
  );
}

export function computerProject(program: readonly number[] = COMPUTER_ROM): Project {
  const pb = new ProjectBuilder('sample-computer', '8-bit computer');
  defineHalfAdder(pb);
  defineFullAdder(pb);
  defineMux2(pb);
  defineAdder8(pb);
  defineDecoder(pb);
  defineAlu(pb);
  defineControl(pb);
  defineCpu(pb);
  defineComputer(pb, program);
  return pb.build('computer');
}
