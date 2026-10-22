import { ProjectBuilder, type CircuitBuilder, type Project } from '../model/index.ts';

/*
 * Built-in example projects. Every example is an ordinary, editable project
 * built only from catalog components; tests/samples verifies each one against
 * its truth table or reference behaviour.
 *
 * Coordinates are hand-placed on the grid. Wires that cross without a
 * junction are not connected; every intended junction is a wire end.
 */

export interface SampleInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  build(): Project;
}

function note(b: CircuitBuilder, x: number, y: number, text: string, size = 'small'): void {
  b.add('text', x, y, { text, size });
}

/* ------------------------------------------------------------------------ */
/* 1. Basic logic gates                                                      */
/* ------------------------------------------------------------------------ */

export function basicGatesProject(): Project {
  const pb = new ProjectBuilder('sample-gates', 'Basic logic gates');
  pb.circuit(
    'gates',
    'Logic gates',
    (b) => {
      const a = b.add('input', 0, 0, { label: 'A' });
      const bb = b.add('input', 0, 3, { label: 'B' });
      // Input rails: A on x=4, B on x=6.
      b.wire(a.pin('out'), { x: 4, y: 0 }, { x: 4, y: 42 });
      b.wire(bb.pin('out'), { x: 6, y: 3 }, { x: 6, y: 37 });
      const gates: [string, string][] = [
        ['and', 'A AND B'],
        ['or', 'A OR B'],
        ['nand', 'A NAND B'],
        ['nor', 'A NOR B'],
        ['xor', 'A XOR B'],
        ['xnor', 'A XNOR B'],
      ];
      gates.forEach(([type, label], i) => {
        const y = 6 + 6 * i;
        const g = b.add(type, 14, y);
        const o = b.add('output', 22, y, { label });
        b.wire({ x: 4, y: y - 1 }, g.pin('in0'));
        b.wire({ x: 6, y: y + 1 }, g.pin('in1'));
        b.wire(g.pin('out'), o.pin('in'));
      });
      const n = b.add('not', 14, 42);
      const no = b.add('output', 22, 42, { label: 'NOT A' });
      b.wire({ x: 4, y: 42 }, n.pin('in'));
      b.wire(n.pin('out'), no.pin('in'));
      note(b, 14, -4, 'Click the A and B input bits to change them; each output shows its gate\'s result.');
    },
    'Every basic gate driven by the same two inputs.',
  );
  return pb.build('gates');
}

/* ------------------------------------------------------------------------ */
/* 2. Half adder and full adder                                              */
/* ------------------------------------------------------------------------ */

function defineHalfAdder(pb: ProjectBuilder): void {
  pb.circuit(
    'half-adder',
    'Half adder',
    (b) => {
      const a = b.add('input', 0, 0, { label: 'A' });
      const bb = b.add('input', 0, 6, { label: 'B' });
      const xor = b.add('xor', 10, 2);
      const and = b.add('and', 10, 10);
      const s = b.add('output', 18, 2, { label: 'S' });
      const c = b.add('output', 18, 10, { label: 'C' });
      b.wire(a.pin('out'), { x: 3, y: 0 }, { x: 3, y: 9 }, and.pin('in0'));
      b.wire({ x: 3, y: 1 }, xor.pin('in0'));
      b.wire(bb.pin('out'), { x: 5, y: 6 });
      b.wire(xor.pin('in1'), { x: 5, y: 3 }, { x: 5, y: 11 }, and.pin('in1'));
      b.wire(xor.pin('out'), s.pin('in'));
      b.wire(and.pin('out'), c.pin('in'));
      note(b, 10, -4, 'S = A XOR B (sum)    C = A AND B (carry)');
    },
    'Adds two bits: S is the sum bit, C the carry.',
  );
}

function defineFullAdder(pb: ProjectBuilder): void {
  pb.circuit(
    'full-adder',
    'Full adder',
    (b) => {
      const a = b.add('input', 0, 0, { label: 'A' });
      const bb = b.add('input', 0, 4, { label: 'B' });
      const cin = b.add('input', 0, 8, { label: 'Cin' });
      const ha1 = b.sub('half-adder', 12, 2, 'HA1');
      const ha2 = b.sub('half-adder', 26, 6, 'HA2');
      const or = b.add('or', 38, 10);
      const sum = b.add('output', 44, 5, { label: 'Sum' });
      const cout = b.add('output', 44, 10, { label: 'Cout' });
      b.wire(a.pin('out'), { x: 4, y: 0 }, { x: 4, y: 1 }, ha1.port('A'));
      b.wire(bb.pin('out'), { x: 6, y: 4 }, { x: 6, y: 3 }, ha1.port('B'));
      b.wire(ha1.port('S'), { x: 19, y: 1 }, { x: 19, y: 5 }, ha2.port('A'));
      b.wire(cin.pin('out'), { x: 20, y: 8 }, { x: 20, y: 7 }, ha2.port('B'));
      b.wire(ha1.port('C'), { x: 32, y: 3 }, { x: 32, y: 9 }, or.pin('in0'));
      b.wire(ha2.port('S'), sum.pin('in'));
      b.wire(ha2.port('C'), { x: 31, y: 7 }, { x: 31, y: 11 }, or.pin('in1'));
      b.wire(or.pin('out'), cout.pin('in'));
      note(b, 22, -3, 'Two half adders and an OR gate. Double-click a half adder to look inside.');
    },
    'Adds three bits (A + B + carry in) using two half-adder subcircuits.',
  );
}

export function halfAdderProject(): Project {
  const pb = new ProjectBuilder('sample-half-adder', 'Half adder');
  defineHalfAdder(pb);
  return pb.build('half-adder');
}

export function addersProject(): Project {
  const pb = new ProjectBuilder('sample-adders', 'Half and full adder');
  defineHalfAdder(pb);
  defineFullAdder(pb);
  return pb.build('full-adder');
}

/* ------------------------------------------------------------------------ */
/* 3. Four-bit ripple-carry adder                                            */
/* ------------------------------------------------------------------------ */

export function rippleAdderProject(): Project {
  const pb = new ProjectBuilder('sample-ripple-adder', 'Four-bit ripple-carry adder');
  defineHalfAdder(pb);
  defineFullAdder(pb);
  pb.circuit(
    'adder4',
    '4-bit adder',
    (b) => {
      const a = b.add('input', 0, 7, { label: 'A', width: 4 });
      const bIn = b.add('input', 0, 49, { label: 'B', width: 4 });
      const cin = b.add('input', 0, 2, { label: 'Cin' });
      const sOut = b.add('output', 66, 13, { label: 'S', width: 4 });
      const cout = b.add('output', 66, 47, { label: 'Cout' });
      const sa = b.add('splitter', 4, 7, { busWidth: 4, fanout: 4 });
      const sb = b.add('splitter', 4, 49, { busWidth: 4, fanout: 4 });
      // Sum combiner: rotated to face west; bit 0 on the top arm.
      const ss = b.add('splitter', 60, 13, { busWidth: 4, fanout: 4, mapping: '3,2,1,0' }, 180);
      b.wire(a.pin('out'), sa.pin('bus'));
      b.wire(bIn.pin('out'), sb.pin('bus'));
      b.wire(ss.pin('bus'), sOut.pin('in'));

      const fa = [0, 1, 2, 3].map((i) => b.sub('full-adder', 40, 10 + 12 * i, `FA${i}`));
      const aLeg = [0, 14, 12, 10];
      const bLeg = [20, 22, 24, 26];
      const sLeg = [0, 50, 52, 54];
      fa.forEach((f, i) => {
        const y = 10 + 12 * i;
        // A bit i: downward fan-out from the A splitter.
        if (i === 0) b.wire(sa.pin('f0'), f.port('A'));
        else b.wire(sa.pin(`f${i}`), { x: aLeg[i], y: 8 + i }, { x: aLeg[i], y: y - 2 }, f.port('A'));
        // B bit i: upward fan-out from the B splitter.
        b.wire(sb.pin(`f${i}`), { x: bLeg[i], y: 50 + i }, { x: bLeg[i], y }, f.port('B'));
        // Sum bit i: upward fan-in to the combiner (arm 3 - i carries bit i).
        if (i === 0) b.wire(f.port('Sum'), ss.pin('f3'));
        else b.wire(f.port('Sum'), { x: sLeg[i], y: y - 1 }, { x: sLeg[i], y: 9 + i }, ss.pin(`f${3 - i}`));
        // Carry ripples to the next stage.
        if (i < 3) {
          b.wire(f.port('Cout'), { x: 46, y: y + 1 }, { x: 46, y: y + 5 }, { x: 34, y: y + 5 }, { x: 34, y: y + 14 }, fa[i + 1].port('Cin'));
        } else {
          b.wire(f.port('Cout'), cout.pin('in'));
        }
      });
      b.wire(cin.pin('out'), { x: 30, y: 2 }, { x: 30, y: 12 }, fa[0].port('Cin'));
      note(b, 30, -3, 'S = A + B + Cin. Splitters break the 4-bit buses into single bits and join the sum bits back up.');
    },
    'Four full adders chained by their carries.',
  );
  return pb.build('adder4');
}

/* ------------------------------------------------------------------------ */
/* 4. SR latch                                                               */
/* ------------------------------------------------------------------------ */

export function srLatchProject(): Project {
  const pb = new ProjectBuilder('sample-sr-latch', 'SR latch');
  pb.circuit(
    'sr-latch',
    'SR latch',
    (b) => {
      const r = b.add('input', 0, 0, { label: 'R' });
      const s = b.add('input', 0, 8, { label: 'S' });
      const g1 = b.add('nor', 10, 1);
      const g2 = b.add('nor', 10, 7);
      const q = b.add('output', 20, 1, { label: 'Q' });
      const qn = b.add('output', 20, 7, { label: 'Q̅' });
      b.wire(r.pin('out'), g1.pin('in0'));
      b.wire(s.pin('out'), g2.pin('in1'));
      b.wire(g1.pin('out'), q.pin('in'));
      b.wire(g2.pin('out'), qn.pin('in'));
      // Cross-coupling: each gate's output feeds the other gate.
      b.wire({ x: 15, y: 1 }, { x: 15, y: 4 }, { x: 5, y: 4 }, { x: 5, y: 6 }, g2.pin('in0'));
      b.wire({ x: 16, y: 7 }, { x: 16, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 2 }, g1.pin('in1'));
      note(b, 10, -4, 'S = 1 sets Q, R = 1 resets it; with both at 0 the latch remembers.');
      note(b, 10, 12, 'Q starts unknown (blue) until set or reset. S = R = 1 is not allowed.');
    },
    'Two cross-coupled NOR gates storing one bit.',
  );
  return pb.build('sr-latch');
}

/* ------------------------------------------------------------------------ */
/* 5. D flip-flop (master-slave, from NAND D latches)                        */
/* ------------------------------------------------------------------------ */

function defineDLatch(pb: ProjectBuilder): void {
  pb.circuit(
    'd-latch',
    'D latch',
    (b) => {
      const d = b.add('input', 0, 0, { label: 'D' });
      const en = b.add('input', 0, 8, { label: 'EN' });
      const inv = b.add('not', 6, 6);
      const n1 = b.add('nand', 14, 1);
      const n2 = b.add('nand', 14, 7);
      const n3 = b.add('nand', 24, 2);
      const n4 = b.add('nand', 24, 6);
      const q = b.add('output', 32, 2, { label: 'Q' });
      const qn = b.add('output', 32, 6, { label: 'Q̅' });
      b.wire(d.pin('out'), n1.pin('in0'));
      b.wire({ x: 2, y: 0 }, { x: 2, y: 6 }, inv.pin('in'));
      b.wire(inv.pin('out'), n2.pin('in0'));
      b.wire(en.pin('out'), n2.pin('in1'));
      b.wire({ x: 9, y: 8 }, { x: 9, y: 2 }, n1.pin('in1'));
      b.wire(n1.pin('out'), n3.pin('in0'));
      b.wire(n2.pin('out'), n4.pin('in1'));
      b.wire(n3.pin('out'), q.pin('in'));
      b.wire(n4.pin('out'), qn.pin('in'));
      b.wire({ x: 29, y: 2 }, { x: 29, y: 4 }, { x: 19, y: 4 }, { x: 19, y: 5 }, n4.pin('in0'));
      b.wire({ x: 30, y: 6 }, { x: 30, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 3 }, n3.pin('in1'));
      note(b, 16, -3, 'While EN = 1, Q follows D. When EN = 0, Q holds.');
    },
    'Gated D latch from four NAND gates and an inverter.',
  );
}

function defineDFlipFlop(pb: ProjectBuilder): void {
  pb.circuit(
    'd-flip-flop',
    'D flip-flop',
    (b) => {
      const d = b.add('input', 0, 0, { label: 'D' });
      const clk = b.add('input', 0, 8, { label: 'CLK' });
      const inv = b.add('not', 8, 8);
      const master = b.sub('d-latch', 18, 1, 'master');
      const slave = b.sub('d-latch', 32, 1, 'slave');
      const q = b.add('output', 42, 0, { label: 'Q' });
      const qn = b.add('output', 42, 2, { label: 'Q̅' });
      b.wire(d.pin('out'), master.port('D'));
      b.wire(clk.pin('out'), inv.pin('in'));
      b.wire(inv.pin('out'), { x: 12, y: 8 }, { x: 12, y: 2 }, master.port('EN'));
      b.wire({ x: 3, y: 8 }, { x: 3, y: 10 }, { x: 26, y: 10 }, { x: 26, y: 2 }, slave.port('EN'));
      b.wire(master.port('Q'), slave.port('D'));
      b.wire(slave.port('Q'), q.pin('in'));
      b.wire(slave.port('Q̅'), qn.pin('in'));
      note(b, 22, -4, 'Master latch is open while CLK = 0, slave while CLK = 1: Q changes only on the rising edge.');
    },
    'Edge-triggered D flip-flop built from two D latches.',
  );
}

export function dFlipFlopProject(): Project {
  const pb = new ProjectBuilder('sample-d-flip-flop', 'D flip-flop');
  defineDLatch(pb);
  defineDFlipFlop(pb);
  pb.circuit(
    'dff-demo',
    'Clocked demo',
    (b) => {
      const d = b.add('input', 0, 0, { label: 'D' });
      const clk = b.add('clock', 0, 4, { label: 'CLK' });
      const ff = b.sub('d-flip-flop', 10, 1, 'DFF');
      const led = b.add('led', 20, 0, { label: 'Q' });
      const clkLed = b.add('led', 6, -3, { color: 'yellow', label: 'clock' });
      b.wire(d.pin('out'), ff.port('D'));
      b.wire(clk.pin('out'), { x: 3, y: 4 }, { x: 3, y: 2 }, ff.port('CLK'));
      b.wire({ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 4, y: -3 }, clkLed.pin('in'));
      b.wire(ff.port('Q'), led.pin('in'));
      note(b, 10, -7, 'Press Run (or Tick) to clock the flip-flop. Q copies D on each rising edge.');
    },
    'The gate-level flip-flop driven by a clock.',
  );
  return pb.build('d-flip-flop');
}

/* ------------------------------------------------------------------------ */
/* 6. Four-bit register                                                      */
/* ------------------------------------------------------------------------ */

function defineRegisterBit(pb: ProjectBuilder): void {
  pb.circuit(
    'register-bit',
    'Register bit',
    (b) => {
      const d = b.add('input', 0, 0, { label: 'D' });
      const en = b.add('input', 0, 6, { label: 'EN' });
      const clk = b.add('input', 0, 16, { label: 'CLK' });
      const inv = b.add('not', 7, 6);
      const and1 = b.add('and', 14, 1);
      const and2 = b.add('and', 14, 7);
      const or = b.add('or', 22, 4);
      const ff = b.sub('d-flip-flop', 32, 5, 'DFF');
      const q = b.add('output', 42, 4, { label: 'Q' });
      b.wire(d.pin('out'), and1.pin('in0'));
      b.wire(en.pin('out'), inv.pin('in'));
      b.wire({ x: 3, y: 6 }, { x: 3, y: 2 }, and1.pin('in1'));
      b.wire(inv.pin('out'), and2.pin('in0'));
      b.wire(and1.pin('out'), { x: 18, y: 1 }, { x: 18, y: 3 }, or.pin('in0'));
      b.wire(and2.pin('out'), { x: 18, y: 7 }, { x: 18, y: 5 }, or.pin('in1'));
      b.wire(or.pin('out'), ff.port('D'));
      b.wire(clk.pin('out'), { x: 26, y: 16 }, { x: 26, y: 6 }, ff.port('CLK'));
      b.wire(ff.port('Q'), q.pin('in'));
      // Feedback: when EN = 0 the flip-flop reloads its own value.
      b.wire({ x: 38, y: 4 }, { x: 38, y: 12 }, { x: 9, y: 12 }, { x: 9, y: 8 }, and2.pin('in1'));
      note(b, 20, -4, 'EN selects new data (D) or the stored value (Q) as the flip-flop input.');
    },
    'One stored bit with load enable: a 2-to-1 multiplexer feeding a D flip-flop.',
  );
}

function defineRegister4(pb: ProjectBuilder): void {
  pb.circuit(
    'register4',
    '4-bit register',
    (b) => {
      const d = b.add('input', 0, 3, { label: 'D', width: 4 });
      const en = b.add('input', 0, 50, { label: 'EN' });
      const clk = b.add('input', 0, 54, { label: 'CLK' });
      const q = b.add('output', 52, 10, { label: 'Q', width: 4 });
      const sd = b.add('splitter', 3, 3, { busWidth: 4, fanout: 4 });
      const sq = b.add('splitter', 48, 10, { busWidth: 4, fanout: 4, mapping: '3,2,1,0' }, 180);
      b.wire(d.pin('out'), sd.pin('bus'));
      b.wire(sq.pin('bus'), q.pin('in'));
      b.wire(en.pin('out'), { x: 20, y: 50 }, { x: 20, y: 6 });
      b.wire(clk.pin('out'), { x: 22, y: 54 }, { x: 22, y: 8 });
      const dLeg = [0, 14, 12, 10];
      const qLeg = [0, 38, 40, 42];
      for (let i = 0; i < 4; i++) {
        const y = 6 + 10 * i;
        const bit = b.sub('register-bit', 30, y, `bit ${i}`);
        if (i === 0) b.wire(sd.pin('f0'), bit.port('D'));
        else b.wire(sd.pin(`f${i}`), { x: dLeg[i], y: 4 + i }, { x: dLeg[i], y: y - 2 }, bit.port('D'));
        b.wire({ x: 20, y }, bit.port('EN'));
        b.wire({ x: 22, y: y + 2 }, bit.port('CLK'));
        if (i === 0) b.wire(bit.port('Q'), sq.pin('f3'));
        else b.wire(bit.port('Q'), { x: qLeg[i], y }, { x: qLeg[i], y: 6 + i }, sq.pin(`f${3 - i}`));
      }
      note(b, 30, -3, 'Loads D on the rising edge of CLK when EN = 1.');
    },
    'Four register bits sharing enable and clock.',
  );
}

export function registerProject(): Project {
  const pb = new ProjectBuilder('sample-register', 'Four-bit register');
  defineDLatch(pb);
  defineDFlipFlop(pb);
  defineRegisterBit(pb);
  defineRegister4(pb);
  return pb.build('register4');
}

/* ------------------------------------------------------------------------ */
/* 7. 4 × 4-bit RAM from gates                                               */
/* ------------------------------------------------------------------------ */

function defineDecoder(pb: ProjectBuilder): void {
  pb.circuit(
    'decoder2',
    '2-to-4 decoder',
    (b) => {
      const a0 = b.add('input', 0, 0, { label: 'A0' });
      const a1 = b.add('input', 0, 6, { label: 'A1' });
      const n0 = b.add('not', 7, 2);
      const n1 = b.add('not', 17, 8);
      // Rails: A0 x=4, /A0 x=10, A1 x=14, /A1 x=20. Each rail ends at its last tap.
      b.wire(a0.pin('out'), { x: 4, y: 0 }, { x: 4, y: 33 });
      b.wire({ x: 4, y: 2 }, n0.pin('in'));
      b.wire(n0.pin('out'), { x: 10, y: 2 }, { x: 10, y: 27 });
      b.wire(a1.pin('out'), { x: 14, y: 6 }, { x: 14, y: 31 });
      b.wire({ x: 14, y: 8 }, n1.pin('in'));
      b.wire(n1.pin('out'), { x: 20, y: 8 }, { x: 20, y: 19 });
      // Y_k = (A1 or /A1) AND (A0 or /A0)
      const rails: [number, number][] = [
        [20, 10],
        [20, 4],
        [14, 10],
        [14, 4],
      ];
      rails.forEach(([hi, lo], k) => {
        const y = 14 + 6 * k;
        const g = b.add('and', 28, y);
        const o = b.add('output', 36, y, { label: `Y${k}` });
        b.wire({ x: hi, y: y - 1 }, g.pin('in0'));
        b.wire({ x: lo, y: y + 1 }, g.pin('in1'));
        b.wire(g.pin('out'), o.pin('in'));
      });
      note(b, 20, -3, 'Exactly one output is 1: the one numbered by the address A1 A0.');
    },
    'Selects one of four lines from a 2-bit address.',
  );
}

export function ramProject(): Project {
  const pb = new ProjectBuilder('sample-ram', '4 × 4-bit RAM from gates');
  defineDLatch(pb);
  defineDFlipFlop(pb);
  defineRegisterBit(pb);
  defineRegister4(pb);
  defineDecoder(pb);
  pb.circuit(
    'ram',
    'RAM 4×4',
    (b) => {
      const addr = b.add('input', 0, 4, { label: 'A', width: 2 });
      const we = b.add('input', 0, 70, { label: 'WE' });
      const clk = b.add('input', 0, 74, { label: 'CLK' });
      const din = b.add('input', 0, 78, { label: 'Din', width: 4 });
      const dout = b.add('output', 80, 38, { label: 'Dout', width: 4 });
      const sa = b.add('splitter', 3, 4, { busWidth: 2, fanout: 2 });
      const dec = b.sub('decoder2', 14, 8, 'decoder');
      b.wire(addr.pin('out'), sa.pin('bus'));
      b.wire(sa.pin('f0'), { x: 8, y: 5 }, { x: 8, y: 7 }, dec.port('A0'));
      b.wire(sa.pin('f1'), { x: 7, y: 6 }, { x: 7, y: 9 }, dec.port('A1'));
      // Shared control and data columns: WE x=31, Din x=42, CLK x=44, read bus x=75.
      b.wire(we.pin('out'), { x: 31, y: 70 }, { x: 31, y: 19 });
      b.wire(din.pin('out'), { x: 42, y: 78 }, { x: 42, y: 18 });
      b.wire(clk.pin('out'), { x: 44, y: 74 }, { x: 44, y: 22 });
      b.wire({ x: 75, y: 20 }, { x: 75, y: 56 });
      b.wire({ x: 75, y: 38 }, dout.pin('in'));
      const yLeg = [30, 28, 26, 24];
      for (let i = 0; i < 4; i++) {
        const y = 20 + 12 * i;
        const reg = b.sub('register4', 50, y, `word ${i}`);
        const and = b.add('and', 36, y);
        const buf = b.add('tristate', 70, y, { width: 4 });
        const probe = b.add('probe', 58, y - 3, { radix: 'bin', label: `word ${i}` });
        // Decoder line i: select for writing (AND with WE) and reading (tri-state enable).
        b.wire(dec.port(`Y${i}`), { x: yLeg[i], y: 5 + 2 * i }, { x: yLeg[i], y: y + 5 }, { x: 70, y: y + 5 }, buf.pin('en'));
        b.wire({ x: yLeg[i], y: y + 1 }, and.pin('in1'));
        b.wire({ x: 31, y: y - 1 }, and.pin('in0'));
        b.wire(and.pin('out'), reg.port('EN'));
        b.wire({ x: 42, y: y - 2 }, reg.port('D'));
        b.wire({ x: 44, y: y + 2 }, reg.port('CLK'));
        b.wire(reg.port('Q'), buf.pin('in'));
        b.wire(probe.pin('in'), { x: 58, y });
        b.wire(buf.pin('out'), { x: 75, y });
      }
      note(b, 46, -3, 'Write: choose A and Din, set WE = 1, then pulse CLK. Read: choose A and look at Dout.');
      note(b, 46, -1, 'Each word is a gate-level 4-bit register; tri-state buffers share the read bus.');
    },
    'Four words of four bits: decoder, write-enable gating, gate-level registers and a tri-state read bus.',
  );
  return pb.build('ram');
}

export const SAMPLES: readonly SampleInfo[] = [
  { id: 'gates', name: 'Basic logic gates', description: 'AND, OR, NAND, NOR, XOR, XNOR and NOT side by side.', build: basicGatesProject },
  { id: 'half-adder', name: 'Half adder', description: 'Adds two bits with an XOR and an AND gate.', build: halfAdderProject },
  { id: 'adders', name: 'Half and full adder', description: 'A full adder built from two half-adder subcircuits.', build: addersProject },
  { id: 'ripple-adder', name: 'Four-bit ripple-carry adder', description: 'Four full adders chained by their carries, with 4-bit buses.', build: rippleAdderProject },
  { id: 'sr-latch', name: 'SR latch', description: 'One bit of memory from two cross-coupled NOR gates.', build: srLatchProject },
  { id: 'd-flip-flop', name: 'D flip-flop', description: 'Master-slave flip-flop from NAND-gate D latches, with a clocked demo.', build: dFlipFlopProject },
  { id: 'register', name: 'Four-bit register', description: 'Gate-level register with load enable, built from the flip-flop.', build: registerProject },
  { id: 'ram', name: 'Small RAM from gates', description: 'Addressable 4 × 4-bit memory: decoder, registers and a tri-state bus.', build: ramProject },
];
