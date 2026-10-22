import { describe, expect, it } from 'vitest';
import {
  NetlistBuilder,
  NetlistError,
  Simulator,
  findFeedbackLoops,
  formatBinary,
  type Netlist,
} from '../../src/engine/index.ts';
import { Bench, fromBits, prng } from './helpers.ts';

describe('propagation and timing', () => {
  it('propagates through a chain with one time unit per gate', () => {
    const t = new Bench();
    let n = t.input('A');
    for (let i = 0; i < 10; i++) n = t.unary('not', n);
    t.name('Y', n);
    const sim = t.start();
    t.set('A', 0);
    const t0 = sim.time;
    sim.setInput('A', 1);
    const r = sim.settle();
    expect(r.stable).toBe(true);
    // 1 unit for the input source, then 10 gate delays.
    expect(sim.time - t0).toBe(11);
    expect(t.bits('Y')).toBe('1');
  });

  it('honours per-component delays', () => {
    const t = new Bench();
    const a = t.input('A');
    t.name('Y', t.gate('and', [a, a], { delay: 5 }));
    const sim = t.start();
    t.set('A', 0);
    const t0 = sim.time;
    sim.setInput('A', 1);
    sim.settle();
    expect(sim.time - t0).toBe(6);
  });

  it('exposes static hazards (glitches) when stepping propagation', () => {
    // Y = A AND NOT A: logically 0, but the inverter delay produces a pulse.
    const t = new Bench();
    const a = t.input('A');
    const na = t.unary('not', a);
    t.name('Y', t.gate('and', [a, na]));
    const sim = t.start();
    t.set('A', 0);
    sim.setInput('A', 1);
    const seen: string[] = [];
    while (sim.step()) seen.push(t.bits('Y'));
    expect(seen).toContain('1');
    expect(t.bits('Y')).toBe('0');
  });

  it('settles to the same result regardless of component order', () => {
    // Build a random combinational/sequential mix twice with shuffled component order.
    const build = (shuffleSeed: number | null): Netlist => {
      const rnd = prng(7);
      const nb = new NetlistBuilder();
      const nets: number[] = [];
      const comps: { key: string; type: string; props: Record<string, number>; pins: number[] }[] = [];
      for (let i = 0; i < 6; i++) {
        const n = nb.net(1);
        nets.push(n);
        comps.push({ key: `in${i}`, type: 'input', props: { width: 1 }, pins: [n] });
      }
      const types = ['and', 'or', 'xor', 'nand', 'nor', 'xnor'];
      for (let i = 0; i < 60; i++) {
        const type = types[Math.floor(rnd() * types.length)];
        const x = nets[Math.floor(rnd() * nets.length)];
        const y = nets[Math.floor(rnd() * nets.length)];
        const out = nb.net(1);
        comps.push({ key: `g${i}`, type, props: { inputs: 2, width: 1 }, pins: [x, y, out] });
        nets.push(out);
      }
      if (shuffleSeed !== null) {
        const r2 = prng(shuffleSeed);
        for (let i = comps.length - 1; i > 0; i--) {
          const j = Math.floor(r2() * (i + 1));
          [comps[i], comps[j]] = [comps[j], comps[i]];
        }
      }
      for (const c of comps) nb.add(c.type, c.props, c.pins, c.key);
      return nb.build();
    };
    const sims = [build(null), build(1), build(2)].map((nl) => new Simulator(nl));
    const trace = sims.map(() => [] as string[]);
    const stim = prng(99);
    for (let step = 0; step < 40; step++) {
      const key = `in${Math.floor(stim() * 6)}`;
      const v = stim() < 0.5 ? 0 : 1;
      sims.forEach((s, i) => {
        s.setInput(key, v);
        const r = s.settle();
        const values = Array.from({ length: s.netCount }, (_, n) => formatBinary(s.getNet(n))).join('');
        trace[i].push(`${r.stable}:${s.time}:${values}`);
      });
    }
    expect(trace[1]).toEqual(trace[0]);
    expect(trace[2]).toEqual(trace[0]);
  });
});

describe('multiple drivers and floating nets', () => {
  it('leaves undriven nets floating and drives gates with floating inputs to X', () => {
    const t = new Bench();
    const floating = t.net(1);
    t.name('F', floating);
    t.name('Y', t.unary('not', floating));
    t.start();
    expect(t.bits('F')).toBe('z');
    expect(t.bits('Y')).toBe('x');
  });

  it('reports contention when known drivers disagree', () => {
    const nb = new NetlistBuilder();
    const n = nb.net(2);
    nb.add('input', { width: 2 }, [n], 'P');
    nb.add('input', { width: 2 }, [n], 'Q');
    const sim = new Simulator(nb.build());
    sim.setInput('P', 0b01);
    sim.setInput('Q', 0b11);
    sim.settle();
    expect(formatBinary(sim.getNet(n))).toBe('x1');
    expect(sim.netContention[n]).toBe(0b10);
    sim.setInput('Q', 0b01);
    sim.settle();
    expect(formatBinary(sim.getNet(n))).toBe('01');
    expect(sim.netContention[n]).toBe(0);
  });

  it('shares a bus between tri-state drivers', () => {
    const t = new Bench();
    const bus = t.name('BUS', t.net(4));
    const d1 = t.input('D1', 4);
    const d2 = t.input('D2', 4);
    const e1 = t.input('E1');
    const e2 = t.input('E2');
    t.add('tristate', { width: 4 }, [d1, e1, bus]);
    t.add('tristate', { width: 4 }, [d2, e2, bus]);
    const sim = t.start();
    t.set('D1', 0b0011);
    t.set('D2', 0b0101);
    expect(t.bits('BUS')).toBe('zzzz');
    t.set('E1', 1);
    expect(t.bits('BUS')).toBe('0011');
    t.set('E1', 0);
    t.set('E2', 1);
    expect(t.bits('BUS')).toBe('0101');
    t.set('E1', 1);
    expect(t.bits('BUS')).toBe('0xx1');
    expect(sim.netContention[bus]).toBe(0b0110);
  });
});

describe('oscillation and feedback', () => {
  it('keeps an uninitialized self-inverting loop at X', () => {
    const nb = new NetlistBuilder();
    const n = nb.net(1);
    nb.add('not', { width: 1 }, [n, n], 'ring');
    const sim = new Simulator(nb.build(), { maxSettleSteps: 1000 });
    const r = sim.settle();
    // X propagates through NOT as X, so an unknown ring is stable...
    expect(r.stable).toBe(true);
    expect(formatBinary(sim.getNet(n))).toBe('x');
  });

  it('detects oscillation of a ring oscillator once it holds a known value', () => {
    // Ring of 3 inverters, broken by a NAND acting as an enable.
    const t = new Bench();
    const en = t.input('EN');
    const loop = t.net(1);
    const a = t.gate('nand', [en, loop], { key: 'nand' });
    const b = t.unary('not', a, { key: 'inv1' });
    t.unary('not', b, { key: 'inv2', out: loop });
    const sim = t.start({ maxSettleSteps: 500 });
    t.set('EN', 0); // forces a known state: nand=1, inv1=0, loop=1
    expect(formatBinary(sim.getNet(loop))).toBe('1');
    sim.setInput('EN', 1);
    const r = sim.settle();
    expect(r.stable).toBe(false);
    expect(r.oscillation?.componentKeys).toEqual(['inv1', 'inv2', 'nand']);
    // The engine stays usable: disabling the oscillator settles it again.
    sim.setInput('EN', 0);
    expect(sim.settle().stable).toBe(true);
  });

  it('reports feedback loops statically without rejecting them', () => {
    const t = new Bench();
    const s = t.input('S');
    const r = t.input('R');
    const q = t.net(1);
    const qn = t.net(1);
    t.gate('nor', [r, qn], { key: 'norQ', out: q });
    t.gate('nor', [s, q], { key: 'norQn', out: qn });
    t.gate('and', [s, r], { key: 'unrelated' });
    const sim = t.start();
    const loops = findFeedbackLoops(sim).map((l) => l.map((i) => sim.component(i).key));
    expect(loops).toEqual([['norQ', 'norQn']]);
  });

  it('does not treat loops through flip-flops as combinational', () => {
    const t = new Bench();
    const clk = t.clock('clk');
    const q = t.net(1);
    const nq = t.unary('not', q);
    t.add('dff', { width: 1 }, [nq, clk, q, t.net(1)], 'ff');
    const sim = t.start();
    expect(findFeedbackLoops(sim)).toEqual([]);
  });
});

describe('gate-level storage', () => {
  function srLatch() {
    const t = new Bench();
    const s = t.input('S');
    const r = t.input('R');
    const q = t.name('Q', t.net(1));
    const qn = t.name('Qn', t.net(1));
    t.gate('nor', [r, qn], { out: q });
    t.gate('nor', [s, q], { out: qn });
    return t;
  }

  it('SR latch from NOR gates sets, resets and holds', () => {
    const t = srLatch();
    t.start();
    t.set('S', 0);
    t.set('R', 0);
    expect([t.bits('Q'), t.bits('Qn')]).toEqual(['x', 'x']); // never initialized
    t.set('S', 1);
    expect([t.bits('Q'), t.bits('Qn')]).toEqual(['1', '0']);
    t.set('S', 0);
    expect([t.bits('Q'), t.bits('Qn')]).toEqual(['1', '0']); // holds
    t.set('R', 1);
    expect([t.bits('Q'), t.bits('Qn')]).toEqual(['0', '1']);
    t.set('R', 0);
    expect([t.bits('Q'), t.bits('Qn')]).toEqual(['0', '1']); // holds
  });

  it('SR latch oscillates when S and R are released simultaneously (unit-delay metastability)', () => {
    const t = srLatch();
    const sim = t.start({ maxSettleSteps: 200 });
    t.set('S', 1);
    t.set('R', 1);
    expect([t.bits('Q'), t.bits('Qn')]).toEqual(['0', '0']);
    sim.setInput('S', 0);
    sim.setInput('R', 0);
    const r = sim.settle();
    expect(r.stable).toBe(false);
    expect(r.oscillation?.componentKeys.length).toBe(2);
  });

  function dLatch(t: Bench, d: number, en: number, prefix: string) {
    const nd = t.unary('not', d);
    const s = t.gate('nand', [d, en]);
    const r = t.gate('nand', [nd, en]);
    const q = t.net(1);
    const qn = t.net(1);
    t.gate('nand', [s, qn], { out: q, key: `${prefix}q` });
    t.gate('nand', [r, q], { out: qn, key: `${prefix}qn` });
    return q;
  }

  it('gated D latch from NAND gates is transparent while enabled and holds otherwise', () => {
    const t = new Bench();
    const d = t.input('D');
    const en = t.input('EN');
    t.name('Q', dLatch(t, d, en, 'l'));
    t.start();
    t.set('EN', 1);
    t.set('D', 1);
    expect(t.bits('Q')).toBe('1');
    t.set('D', 0);
    expect(t.bits('Q')).toBe('0');
    t.set('D', 1);
    t.set('EN', 0);
    t.set('D', 0);
    expect(t.bits('Q')).toBe('1');
  });

  it('master-slave D flip-flop from gates captures on the rising clock edge only', () => {
    const t = new Bench();
    const d = t.input('D');
    const clk = t.clock('clk');
    const nclk = t.unary('not', clk);
    const m = dLatch(t, d, nclk, 'm');
    t.name('Q', dLatch(t, m, clk, 's'));
    const sim = t.start();
    expect(t.bits('Q')).toBe('x');
    t.set('D', 1);
    expect(t.bits('Q')).toBe('x'); // clock low: master follows D, slave holds
    expect(sim.runTicks(1).stable).toBe(true); // rising edge
    expect(t.bits('Q')).toBe('1');
    t.set('D', 0);
    expect(t.bits('Q')).toBe('1'); // clock high: master closed
    sim.runTicks(1); // falling edge
    expect(t.bits('Q')).toBe('1');
    sim.runTicks(1); // rising edge
    expect(t.bits('Q')).toBe('0');
  });
});

describe('bit links (splitters)', () => {
  function splitBus() {
    const t = new Bench();
    const bus = t.name('BUS', t.net(4));
    const bits = [0, 1, 2, 3].map((i) => t.name(`b${i}`, t.net(1)));
    bits.forEach((n, i) => t.nb.link(bus, i, n, 0));
    return { t, bus, bits };
  }

  it('combines individual bits into a bus', () => {
    const { t, bits } = splitBus();
    const ins = bits.map((n, i) => {
      t.add('input', { width: 1 }, [n], `I${i}`);
      return n;
    });
    expect(ins.length).toBe(4);
    t.start();
    t.set('I0', 1);
    t.set('I3', 1);
    t.set('I2', fromBits(['z']));
    expect(t.bits('BUS')).toBe('1z01');
    t.set('I1', 0);
    t.set('I2', 1);
    expect(t.bits('BUS')).toBe('1101');
  });

  it('splits a bus into bits, and is bidirectional', () => {
    const { t, bus, bits } = splitBus();
    t.add('input', { width: 4 }, [bus], 'BUSIN');
    t.add('input', { width: 1 }, [bits[2]], 'B2');
    const sim = t.start();
    t.set('BUSIN', 0b1010);
    t.set('B2', fromBits(['z']));
    expect([t.bits('b0'), t.bits('b1'), t.bits('b2'), t.bits('b3')]).toEqual(['0', '1', '0', '1']);
    t.set('B2', 1); // agrees with nothing on the bus side for bit 2 (bus drives 0)
    expect(t.bits('BUS')).toBe('1x10');
    expect(sim.netContention[bus]).toBe(0b0100);
  });

  it('can reorder and merge bits across several nets', () => {
    // Swap nibbles of an 8-bit bus through two 4-bit intermediate nets.
    const t = new Bench();
    const a = t.input('A', 8);
    const lo = t.net(4);
    const hi = t.net(4);
    const y = t.name('Y', t.net(8));
    for (let i = 0; i < 4; i++) {
      t.nb.link(a, i, lo, i);
      t.nb.link(a, i + 4, hi, i);
      t.nb.link(y, i, hi, i);
      t.nb.link(y, i + 4, lo, i);
    }
    t.start();
    t.set('A', 0x3c);
    expect(t.bits('Y')).toBe('11000011');
  });
});

describe('state snapshots', () => {
  it('restores gate-level latch state into a fresh simulator', () => {
    const build = () => {
      const t = new Bench();
      const s = t.input('S');
      const r = t.input('R');
      const q = t.name('Q', t.net(1));
      const qn = t.net(1);
      t.gate('nor', [r, qn], { out: q, key: 'q' });
      t.gate('nor', [s, q], { out: qn, key: 'qn' });
      return t;
    };
    const t1 = build();
    t1.start();
    t1.set('R', 0);
    t1.set('S', 1);
    t1.set('S', 0);
    expect(t1.bits('Q')).toBe('1');
    const snap = JSON.parse(JSON.stringify(t1.s.exportState()));

    const t2 = build();
    const sim2 = t2.start();
    expect(t2.bits('Q')).toBe('x');
    sim2.importState(snap);
    expect(sim2.settle().stable).toBe(true);
    expect(t2.bits('Q')).toBe('1');
    expect(sim2.getInput('S')?.a).toBe(0);
  });

  it('drives outputs of components that are not in the snapshot (added since it was taken)', () => {
    // Snapshot from an empty design, imported into one with an input and a gate.
    const empty = new Simulator({ nets: [], components: [] });
    const snap = empty.exportState();
    const t = new Bench();
    const a = t.input('A');
    t.name('A', a);
    t.name('Y', t.unary('not', a));
    const sim = new Simulator(t.nb.build());
    sim.importState(snap);
    expect(sim.settle().stable).toBe(true);
    expect(formatBinary(sim.getNet(0))).toBe('0');
    expect(formatBinary(sim.getNet(1))).toBe('1');
  });

  it('ignores snapshot entries that no longer match the netlist', () => {
    const t = new Bench();
    const a = t.input('A', 4);
    t.name('Y', t.unary('not', a, { width: 4, key: 'inv' }));
    const sim = t.start();
    sim.importState({
      time: 5,
      tick: 0,
      components: { A: { state: { a: 0b0011, b: 0 }, out: { out: [4, 0b0011, 0] } }, inv: { out: { out: [8, 1, 0] } }, gone: {} },
    });
    expect(sim.settle().stable).toBe(true);
    expect(t.bits('Y')).toBe('1100');
  });
});

describe('netlist validation', () => {
  const expectError = (nl: Netlist, pattern: RegExp) => {
    expect(() => new Simulator(nl)).toThrow(NetlistError);
    expect(() => new Simulator(nl)).toThrow(pattern);
  };

  it('rejects width mismatches, unknown types, bad props and bad pin lists', () => {
    expectError({ nets: [{ width: 1 }, { width: 2 }], components: [{ key: 'g', type: 'not', props: { width: 1 }, pins: [0, 1] }] }, /pin out is 1 bit\(s\) but net 1 is 2/);
    expectError({ nets: [], components: [{ key: 'g', type: 'warp-drive', props: {}, pins: [] }] }, /unknown primitive/);
    expectError({ nets: [{ width: 1 }], components: [{ key: 'g', type: 'and', props: { inputs: 1, width: 1 }, pins: [0, 0] }] }, /inputs/);
    expectError({ nets: [{ width: 1 }], components: [{ key: 'g', type: 'not', props: { width: 1 }, pins: [0] }] }, /expected 2 pin/);
    expectError({ nets: [{ width: 1 }], components: [{ key: 'g', type: 'not', props: { width: 1 }, pins: [0, 7] }] }, /missing net 7/);
    expectError({ nets: [{ width: 40 }], components: [] }, /invalid width/);
    expectError(
      {
        nets: [{ width: 1 }],
        components: [
          { key: 'g', type: 'input', props: { width: 1 }, pins: [0] },
          { key: 'g', type: 'input', props: { width: 1 }, pins: [0] },
        ],
      },
      /duplicate component key/,
    );
    expectError({ nets: [{ width: 2 }, { width: 1 }], components: [], links: [{ netA: 0, bitA: 2, netB: 1, bitB: 0 }] }, /bit 2 out of range/);
  });

  it('accepts unconnected pins (-1) as floating', () => {
    const sim = new Simulator({ nets: [{ width: 1 }], components: [{ key: 'g', type: 'and', props: { inputs: 2, width: 1 }, pins: [-1, -1, 0] }] });
    sim.settle();
    expect(formatBinary(sim.getNet(0))).toBe('x');
  });
});
