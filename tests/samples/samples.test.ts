import { describe, expect, it } from 'vitest';
import { CircuitRunner, compileProject, parseProject, serializeProject, type Project } from '../../src/model/index.ts';
import {
  SAMPLES,
  addersProject,
  basicGatesProject,
  dFlipFlopProject,
  halfAdderProject,
  ramProject,
  registerProject,
  rippleAdderProject,
  srLatchProject,
} from '../../src/samples/index.ts';

describe('every sample', () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}: compiles cleanly at every level and survives save/load`, () => {
      const project = sample.build();
      for (const c of project.circuits) {
        const design = compileProject(project, c.id);
        const problems = design.diagnostics.filter((d) => d.severity !== 'info');
        expect(problems, `${c.name}: ${problems.map((p) => p.message).join('; ')}`).toEqual([]);
      }
      const loaded = parseProject(serializeProject(project)).project;
      expect(loaded).toEqual(project);
    });
  }
});

describe('1. basic logic gates', () => {
  it('matches every gate truth table', () => {
    const r = new CircuitRunner(basicGatesProject());
    const outs = ['A AND B', 'A OR B', 'A NAND B', 'A NOR B', 'A XOR B', 'A XNOR B', 'NOT A'];
    expect(r.truthTable(['A', 'B'], outs)).toEqual([
      { in: [0, 0], out: [0, 0, 1, 1, 0, 1, 1] },
      { in: [0, 1], out: [0, 1, 1, 0, 1, 0, 1] },
      { in: [1, 0], out: [0, 1, 1, 0, 1, 0, 0] },
      { in: [1, 1], out: [1, 1, 0, 0, 0, 1, 0] },
    ]);
  });
});

describe('2. half adder and full adder', () => {
  it('half adder adds two bits', () => {
    const r = new CircuitRunner(halfAdderProject());
    for (const row of r.truthTable(['A', 'B'], ['S', 'C'])) {
      const sum = row.in[0] + row.in[1];
      expect(row.out).toEqual([sum & 1, sum >> 1]);
    }
  });

  it('full adder adds three bits through half-adder subcircuits', () => {
    const p = addersProject();
    const r = new CircuitRunner(p, 'full-adder');
    const rows = r.truthTable(['A', 'B', 'Cin'], ['Sum', 'Cout']);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      const sum = row.in[0] + row.in[1] + row.in[2];
      expect(row.out, row.in.join('')).toEqual([sum & 1, sum >> 1]);
    }
    expect(r.design.instanceCount).toBe(3);
  });
});

describe('3. four-bit ripple-carry adder', () => {
  it('adds all 512 combinations of A, B and carry-in', () => {
    const r = new CircuitRunner(rippleAdderProject());
    for (let cin = 0; cin < 2; cin++) {
      r.set('Cin', cin);
      for (let a = 0; a < 16; a++) {
        r.set('A', a);
        for (let b = 0; b < 16; b++) {
          r.set('B', b);
          const sum = a + b + cin;
          expect([r.num('S'), r.num('Cout')], `${a}+${b}+${cin}`).toEqual([sum & 15, sum >> 4]);
        }
      }
    }
  });

  it('ripples the carry through every stage (worst-case propagation is measurable)', () => {
    const r = new CircuitRunner(rippleAdderProject());
    r.set('A', 0b1111);
    r.set('B', 0);
    const t0 = r.sim.time;
    r.set('B', 1); // 15 + 1: the carry ripples through all four full adders
    expect([r.num('S'), r.num('Cout')]).toEqual([0, 1]);
    const delay = r.sim.time - t0;
    expect(delay).toBeGreaterThan(8);
    expect(delay).toBeLessThan(40);
  });
});

describe('4. SR latch', () => {
  it('sets, resets and holds', () => {
    const r = new CircuitRunner(srLatchProject());
    expect([r.bits('Q'), r.bits('Q̅')]).toEqual(['x', 'x']);
    r.set('S', 1);
    expect([r.bits('Q'), r.bits('Q̅')]).toEqual(['1', '0']);
    r.set('S', 0);
    expect([r.bits('Q'), r.bits('Q̅')]).toEqual(['1', '0']);
    r.set('R', 1);
    expect([r.bits('Q'), r.bits('Q̅')]).toEqual(['0', '1']);
    r.set('R', 0);
    expect([r.bits('Q'), r.bits('Q̅')]).toEqual(['0', '1']);
  });

  it('reports oscillation when S and R fall together from the forbidden state', () => {
    const r = new CircuitRunner(srLatchProject(), 'sr-latch', { maxSettleSteps: 500 });
    r.set('S', 1);
    r.set('R', 1);
    const res = r.setMany({ S: 0, R: 0 });
    expect(res.stable).toBe(false);
    expect(res.oscillation?.componentKeys).toEqual(['c3', 'c4']);
  });
});

describe('5. D latch and D flip-flop', () => {
  it('D latch is transparent while enabled and holds otherwise', () => {
    const r = new CircuitRunner(dFlipFlopProject(), 'd-latch');
    r.set('EN', 1);
    r.set('D', 1);
    expect(r.bits('Q')).toBe('1');
    r.set('D', 0);
    expect([r.bits('Q'), r.bits('Q̅')]).toEqual(['0', '1']);
    r.set('D', 1);
    r.set('EN', 0);
    r.set('D', 0);
    expect(r.bits('Q')).toBe('1');
  });

  it('D flip-flop changes only on the rising clock edge', () => {
    const r = new CircuitRunner(dFlipFlopProject(), 'd-flip-flop');
    r.set('D', 1);
    expect(r.bits('Q')).toBe('x');
    r.set('CLK', 1);
    expect([r.bits('Q'), r.bits('Q̅')]).toEqual(['1', '0']);
    r.set('D', 0);
    expect(r.bits('Q')).toBe('1');
    r.set('CLK', 0);
    expect(r.bits('Q')).toBe('1');
    r.set('CLK', 1);
    expect(r.bits('Q')).toBe('0');
  });

  it('clocked demo follows D on rising edges of the clock generator', () => {
    const p = dFlipFlopProject();
    const r = new CircuitRunner(p, 'dff-demo');
    r.set('D', 1);
    r.tick(1); // clock 0 → 1
    expect(r.valueAtPin('c4', 'in').a).toBe(1); // LED "Q"
    r.set('D', 0);
    expect(r.valueAtPin('c4', 'in').a).toBe(1);
    r.tick(2);
    expect(r.valueAtPin('c4', 'in').a).toBe(0);
  });
});

describe('6. four-bit register', () => {
  const pulse = (r: CircuitRunner) => {
    r.set('CLK', 1);
    r.set('CLK', 0);
  };

  it('register bit loads when enabled and holds when not', () => {
    const r = new CircuitRunner(registerProject(), 'register-bit');
    r.set('EN', 1);
    r.set('D', 1);
    pulse(r);
    expect(r.bits('Q')).toBe('1');
    r.set('EN', 0);
    r.set('D', 0);
    pulse(r);
    pulse(r);
    expect(r.bits('Q')).toBe('1');
    r.set('EN', 1);
    pulse(r);
    expect(r.bits('Q')).toBe('0');
  });

  it('stores every 4-bit value and keeps it while disabled', () => {
    const r = new CircuitRunner(registerProject());
    for (let v = 0; v < 16; v++) {
      r.set('EN', 1);
      r.set('D', v);
      pulse(r);
      expect(r.num('Q')).toBe(v);
      r.set('EN', 0);
      r.set('D', 15 - v);
      pulse(r);
      expect(r.num('Q')).toBe(v);
    }
  });
});

describe('7. RAM built from gates', () => {
  const pulse = (r: CircuitRunner) => {
    r.set('CLK', 1);
    r.set('CLK', 0);
  };
  const write = (r: CircuitRunner, addr: number, value: number) => {
    r.set('A', addr);
    r.set('Din', value);
    r.set('WE', 1);
    pulse(r);
    r.set('WE', 0);
  };
  const read = (r: CircuitRunner, addr: number) => {
    r.set('A', addr);
    return r.num('Dout');
  };

  it('2-to-4 decoder selects exactly one line', () => {
    const r = new CircuitRunner(ramProject(), 'decoder2');
    expect(r.truthTable(['A1', 'A0'], ['Y0', 'Y1', 'Y2', 'Y3'])).toEqual([
      { in: [0, 0], out: [1, 0, 0, 0] },
      { in: [0, 1], out: [0, 1, 0, 0] },
      { in: [1, 0], out: [0, 0, 1, 0] },
      { in: [1, 1], out: [0, 0, 0, 1] },
    ]);
  });

  it('writes and reads back every address independently', () => {
    const r = new CircuitRunner(ramProject());
    expect(r.design.instanceCount).toBeGreaterThan(40);
    const values = [0b1010, 0b0101, 0b1111, 0b0011];
    values.forEach((v, a) => write(r, a, v));
    values.forEach((v, a) => expect(read(r, a), `address ${a}`).toBe(v));
    write(r, 2, 0b0110);
    expect([0, 1, 2, 3].map((a) => read(r, a))).toEqual([0b1010, 0b0101, 0b0110, 0b0011]);
  });

  it('does not write while WE = 0', () => {
    const r = new CircuitRunner(ramProject());
    write(r, 1, 9);
    r.set('A', 1);
    r.set('Din', 4);
    pulse(r); // WE is 0
    expect(read(r, 1)).toBe(9);
  });

  it('shows unwritten words as unknown, honestly', () => {
    const r = new CircuitRunner(ramProject());
    write(r, 0, 7);
    expect(read(r, 0)).toBe(7);
    expect(r.bits('Dout')).toBe('0111');
    r.set('A', 3);
    expect(r.bits('Dout')).toBe('xxxx');
  });
});

describe('sample projects are independent copies', () => {
  it('builds a fresh project each time', () => {
    const a: Project = SAMPLES[0].build();
    const b: Project = SAMPLES[0].build();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
