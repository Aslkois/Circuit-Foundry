import { describe, expect, it } from 'vitest';
import { CircuitRunner, compileProject, findCircuit, parseProject, serializeProject, setComponentProps, projectContext, replaceCircuit, type Project } from '../../src/model/index.ts';
import { formatRomContents } from '../../src/engine/primitives/memory.ts';
import { computerProject } from '../../src/samples/computer.ts';
import { AsmError, FIBONACCI, SUM_TO_N, assemble, emulate } from '../../src/samples/mycpu-isa.ts';

let seed = 99;
function rand(n: number): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
}

const project = computerProject();

describe('MyCPU building blocks', () => {
  it('adds 8-bit numbers with carry (adder8, gate level)', () => {
    const r = new CircuitRunner(project, 'adder8');
    expect(r.design.diagnostics).toEqual([]);
    for (let k = 0; k < 200; k++) {
      const a = rand(256);
      const b = rand(256);
      const c = rand(2);
      r.setMany({ A: a, B: b, Cin: c });
      expect([r.num('S'), r.num('Cout')], `${a}+${b}+${c}`).toEqual([(a + b + c) & 0xff, (a + b + c) >> 8]);
    }
  });

  it('decodes 3 bits to one-hot outputs', () => {
    const r = new CircuitRunner(project, 'dec3');
    for (let i = 0; i < 8; i++) {
      r.set('I', i);
      expect([0, 1, 2, 3, 4, 5, 6, 7].map((j) => r.num(`O${j}`))).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((j) => (j === i ? 1 : 0)));
    }
  });

  it('selects with the parametric multiplexer at several widths', () => {
    const r = new CircuitRunner(project, 'mux2');
    r.setMany({ A: 0x12, B: 0xab, S: 0 });
    expect(r.num('Y')).toBe(0x12);
    r.set('S', 1);
    expect(r.num('Y')).toBe(0xab);
  });

  it('computes all eight ALU operations and the flags', () => {
    const r = new CircuitRunner(project, 'alu8');
    expect(r.design.diagnostics).toEqual([]);
    const ref = (op: number, a: number, b: number): [number, number] => {
      switch (op) {
        case 0:
          return [b, 0];
        case 1:
          return [(a + b) & 0xff, a + b > 0xff ? 1 : 0];
        case 2:
          return [(a - b) & 0xff, a >= b ? 1 : 0];
        case 3:
          return [a & b, 0];
        case 4:
          return [a | b, 0];
        case 5:
          return [a ^ b, 0];
        case 6:
          return [~a & 0xff, 0];
        default:
          return [a >> 1, 0];
      }
    };
    const pairs = [
      [0, 0],
      [255, 1],
      [1, 255],
      [0x80, 0x80],
      [7, 7],
    ];
    for (let k = 0; k < 40; k++) pairs.push([rand(256), rand(256)]);
    for (let op = 0; op < 8; op++) {
      for (const [a, b] of pairs) {
        r.setMany({ A: a, B: b, OP: op });
        const [y, c] = ref(op, a, b);
        expect([r.num('Y'), r.num('Z'), r.num('C')], `op ${op} a ${a} b ${b}`).toEqual([y, y === 0 ? 1 : 0, c]);
      }
    }
  });

  it('decodes every opcode and jump condition in the control unit', () => {
    const r = new CircuitRunner(project, 'control');
    for (let op = 0; op < 16; op++) {
      for (let cond = 0; cond < 4; cond++) {
        for (let flags = 0; flags < 4; flags++) {
          const z = flags & 1;
          const c = flags >> 1;
          r.setMany({ OP: op, C1: cond >> 1, C0: cond & 1, ZF: z, CF: c });
          const take = cond === 0 || (cond === 1 && z === 1) || (cond === 2 && c === 1) || (cond === 3 && z === 0);
          expect([r.num('ALUW'), r.num('ST'), r.num('HLT'), r.num('JMP')], `op ${op} cond ${cond} z ${z} c ${c}`).toEqual([
            op >= 8 ? 1 : 0,
            op === 2 ? 1 : 0,
            op === 1 ? 1 : 0,
            op === 3 && take ? 1 : 0,
          ]);
        }
      }
    }
  });
});

/** Run the computer until HALT, recording each value written to the output port. */
function runComputer(p: Project, input: number, maxCycles = 2000) {
  const r = new CircuitRunner(p, 'computer');
  const cpuId = findCircuit(p, 'computer')!.components.find((c) => c.type === 'subcircuit' && c.props.circuit === 'mycpu')!.id;
  const port = (label: string) => {
    const pin = r.design.root!.connectivity.components.get(cpuId)!.pins.find((x) => x.label === label)!;
    return r.valueAtPin(cpuId, pin.name);
  };
  r.set('IN', input);
  r.set('RST', 1);
  r.set('RST', 0);
  const out: number[] = [];
  let cycles = 0;
  for (; cycles < maxCycles && r.num('HALT') !== 1; cycles++) {
    // Each instruction is one clock period (two ticks); writes happen on the rising edge.
    const we = port('WE');
    const addr = port('ADDR');
    const writesOut = we.a === 1 && we.b === 0 && (addr.a & 0x80) !== 0;
    r.tick(2);
    if (writesOut) out.push(r.num('OUT')!);
  }
  return { r, out, cycles, halted: r.num('HALT') === 1 };
}

describe('8-bit computer', () => {
  it('runs the Fibonacci program from ROM and halts', () => {
    const { r, out, halted, cycles } = runComputer(project, 0);
    const ref = emulate(assemble(FIBONACCI).words, 0, 2000);
    expect(halted).toBe(true);
    expect(out).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]);
    expect(out).toEqual(ref.out);
    expect(cycles).toBe(ref.cycles);
    expect(r.num('ACC')).toBe(ref.a);
    expect(r.lastSettle.stable).toBe(true);
  });

  it('runs another program with input from the switches', () => {
    const words = assemble(SUM_TO_N).words;
    const p = computerProject(words);
    for (const n of [0, 1, 10, 22]) {
      const { out, halted } = runComputer(p, n);
      expect(halted).toBe(true);
      expect(out).toEqual([(n * (n + 1)) / 2 & 0xff]);
      expect(out).toEqual(emulate(words, n, 5000).out);
    }
  });

  it('matches the reference model on every instruction, including flags and memory', () => {
    // Exercises all ALU operations in both addressing modes, every jump condition, and RAM.
    const src = `
      a = 0x10
      b = 0x11
            LDI  200
            ST   a
            LDI  100
            ST   b
            LD   a
            ADD  b        ; 300: carry
            JC   c1
            HLT
      c1:   ST   0x80     ; 44
            SUBI 44       ; 0: zero, no borrow
            JZ   z1
            HLT
      z1:   JNZ  bad
            ORI  0xF0
            XOR  a        ; 0xF0 ^ 200
            ST   0x80
            ANDI 0x3C
            ST   0x80
            NOT
            ST   0x80
            SHR
            ST   0x80
            SUB  b        ; borrow when A < 100
            ST   0x80
            JC   bad
            LDI  0
            JMP  done
      bad:  LDI  0xEE
            ST   0x80
      done: ST   0x80
            HLT`;
    const words = assemble(src).words;
    const ref = emulate(words, 0, 500);
    expect(ref.halted).toBe(true);
    const { out, halted } = runComputer(computerProject(words), 0);
    expect(halted).toBe(true);
    expect(out).toEqual(ref.out);
    expect(out[out.length - 1]).toBe(0);
  });

  it('keeps every component simulated, sharing definitions between instances', () => {
    const d = compileProject(project, 'computer');
    expect(d.diagnostics).toEqual([]);
    // computer → MyCPU → ALU/INC → adder8 → full adder → half adder → gates
    expect(d.instanceCount).toBe(59);
    expect(d.templateCount).toBe(9);
    const types = new Map<string, number>();
    for (const c of d.netlist.components) types.set(c.type, (types.get(c.type) ?? 0) + 1);
    // Two 8-bit adders of 8 full adders, each 2 half adders (XOR + AND) and an OR.
    expect(types.get('xor')).toBeGreaterThanOrEqual(32);
    expect(types.get('or')).toBeGreaterThanOrEqual(16);
    expect(types.get('rom')).toBe(1);
    expect(types.get('ram')).toBe(1);
    // Deep engine keys show the hierarchy.
    expect(d.netlist.components.some((c) => c.key.split('/').length === 6)).toBe(true);
  });

  it('survives save and load, and an edit of a nested definition reaches the CPU', () => {
    const loaded = parseProject(serializeProject(project)).project;
    expect(runComputer(loaded, 0).out.slice(-3)).toEqual([55, 89, 144]);
    // Break the half adder's carry (AND → OR): every adder in the CPU changes, so Fibonacci goes wrong.
    const ha = findCircuit(loaded, 'half-adder')!;
    const and = ha.components.find((c) => c.type === 'and')!;
    const broken = replaceCircuit(loaded, { ...ha, components: ha.components.map((c) => (c === and ? { ...c, type: 'or' } : c)) });
    expect(runComputer(broken, 0, 300).out).not.toEqual(runComputer(loaded, 0).out);
  });

  it('loads a new program by editing the ROM contents', () => {
    const words = assemble('LDI 42\nST 0x80\nHLT').words;
    const comp = findCircuit(project, 'computer')!;
    const rom = comp.components.find((c) => c.type === 'rom')!;
    const p = replaceCircuit(project, setComponentProps(comp, rom.id, { contents: formatRomContents(words, 16) }, projectContext(project)));
    expect(runComputer(p, 0).out).toEqual([42]);
  });

  it('reports assembler errors with line numbers', () => {
    expect(() => assemble('LDI 300')).toThrow(AsmError);
    expect(() => assemble('NOP\nFOO 1')).toThrow(/line 2: unknown instruction "FOO"/);
    expect(() => assemble('JMP nowhere')).toThrow(/not a number or a known name/);
  });
});
