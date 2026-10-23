/**
 * Simulation performance benchmarks (plain Node):  node scripts/bench.ts
 *
 * Each case reports wall time and engine throughput (applied driver events
 * per second). Results are checked for correctness as they run, so a fast
 * but wrong engine fails loudly instead of looking good.
 */
import { NetlistBuilder, Simulator, fromUnsigned, toUnsigned } from '../src/engine/index.ts';
import { CircuitRunner, ProjectBuilder, compileProject } from '../src/model/index.ts';
import { addersProject, ramProject } from '../src/samples/index.ts';
import { computerProject } from '../src/samples/computer.ts';
import { FIBONACCI, assemble, emulate } from '../src/samples/mycpu-isa.ts';

interface Row {
  name: string;
  size: string;
  ms: number;
  events: number;
  evals: number;
  note: string;
}

const rows: Row[] = [];

function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`benchmark result wrong: ${msg}`);
}

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
}

/* 1. 32-bit ripple-carry adder from individual gates ----------------------- */
{
  const W = 32;
  const nb = new NetlistBuilder();
  const aBus = nb.net(W);
  const bBus = nb.net(W);
  const sBus = nb.net(W);
  nb.add('input', { width: W }, [aBus], 'A');
  nb.add('input', { width: W }, [bBus], 'B');
  let carry = nb.net(1);
  nb.add('constant', { width: 1, value: 0 }, [carry], 'cin');
  for (let i = 0; i < W; i++) {
    const a = nb.net(1);
    const b = nb.net(1);
    const s = nb.net(1);
    nb.link(aBus, i, a, 0);
    nb.link(bBus, i, b, 0);
    nb.link(sBus, i, s, 0);
    const x1 = nb.net(1);
    const a1 = nb.net(1);
    const a2 = nb.net(1);
    const cout = nb.net(1);
    nb.add('xor', { inputs: 2, width: 1 }, [a, b, x1]);
    nb.add('xor', { inputs: 2, width: 1 }, [x1, carry, s]);
    nb.add('and', { inputs: 2, width: 1 }, [a, b, a1]);
    nb.add('and', { inputs: 2, width: 1 }, [x1, carry, a2]);
    nb.add('or', { inputs: 2, width: 1 }, [a1, a2, cout]);
    carry = cout;
  }
  const sim = new Simulator(nb.build());
  sim.settle();
  const rnd = prng(1);
  const N = 20_000;
  const e0 = sim.stats.events;
  const v0 = sim.stats.evaluations;
  const [, ms] = time(() => {
    for (let i = 0; i < N; i++) {
      const x = Math.floor(rnd() * 2 ** 32);
      const y = Math.floor(rnd() * 2 ** 32);
      sim.setInput('A', fromUnsigned(32, x));
      sim.setInput('B', fromUnsigned(32, y));
      sim.settle();
      check(toUnsigned(sim.getNet(sBus)) === (x + y) % 2 ** 32, `${x}+${y}`);
    }
  });
  rows.push({ name: '32-bit ripple-carry adder (gates)', size: `${sim.componentCount} primitives`, ms, events: sim.stats.events - e0, evals: sim.stats.evaluations - v0, note: `${((N / ms) * 1000).toFixed(0)} additions/s` });
}

/* 2. Long shift register of flip-flop primitives ---------------------------- */
{
  const N = 10_000;
  const nb = new NetlistBuilder();
  const clk = nb.net(1);
  nb.add('clock', { highTicks: 1, lowTicks: 1 }, [clk], 'clk');
  const d = nb.net(1);
  nb.add('input', { width: 1 }, [d], 'D');
  let prev = d;
  const outs: number[] = [];
  for (let i = 0; i < N; i++) {
    const q = nb.net(1);
    nb.add('dff', { width: 1 }, [prev, clk, q, -1]);
    outs.push(q);
    prev = q;
  }
  const sim = new Simulator(nb.build());
  sim.settle();
  sim.setInput('D', 1);
  sim.settle();
  const TICKS = 400;
  const e0 = sim.stats.events;
  const v0 = sim.stats.evaluations;
  const [, ms] = time(() => sim.runTicks(TICKS));
  // After TICKS/2 rising edges the 1 has shifted into the first TICKS/2 stages.
  check(sim.getNet(outs[TICKS / 2 - 1]).a === 1 && sim.getNet(outs[TICKS / 2]).a === 0, 'shift position');
  rows.push({ name: 'Shift register (DFF primitives)', size: `${N} flip-flops`, ms, events: sim.stats.events - e0, evals: sim.stats.evaluations - v0, note: `${((TICKS / ms) * 1000).toFixed(0)} ticks/s` });
}

/* 3. Wide random combinational logic --------------------------------------- */
// Gates draw inputs from recent nets, giving a deep network (~90 levels) with
// heavy reconvergent fan-out: a worst case for glitch propagation.
{
  const G = 100_000;
  const nb = new NetlistBuilder();
  const rnd = prng(7);
  const nets: number[] = [];
  for (let i = 0; i < 64; i++) {
    const n = nb.net(1);
    nb.add('input', { width: 1 }, [n], `in${i}`);
    nets.push(n);
  }
  const types = ['and', 'or', 'xor', 'nand', 'nor', 'xnor'];
  for (let i = 0; i < G; i++) {
    const out = nb.net(1);
    const pick = () => nets[Math.max(0, nets.length - 1 - Math.floor(rnd() * Math.min(nets.length, 4000)))];
    nb.add(types[i % types.length], { inputs: 2, width: 1 }, [pick(), pick(), out]);
    nets.push(out);
  }
  const [sim, buildMs] = time(() => new Simulator(nb.build()));
  sim.settle();
  const N = 20;
  const e0 = sim.stats.events;
  const v0 = sim.stats.evaluations;
  const [, ms] = time(() => {
    for (let i = 0; i < N; i++) {
      sim.setInput(`in${Math.floor(rnd() * 64)}`, rnd() < 0.5 ? 0 : 1);
      check(sim.settle().stable, 'acyclic logic must settle');
    }
  });
  rows.push({ name: 'Random deep logic (glitchy)', size: `${G} gates`, ms, events: sim.stats.events - e0, evals: sim.stats.evaluations - v0, note: `${N} input changes; engine build ${buildMs.toFixed(0)} ms` });
}

/* 4. Gate-level RAM sample: write and read back ----------------------------- */
{
  const r = new CircuitRunner(ramProject());
  const N = 300;
  const rnd = prng(3);
  const mem = [0, 0, 0, 0];
  const e0 = r.sim.stats.events;
  const v0 = r.sim.stats.evaluations;
  const [, ms] = time(() => {
    for (let i = 0; i < N; i++) {
      const addr = Math.floor(rnd() * 4);
      const v = Math.floor(rnd() * 16);
      r.set('A', addr);
      r.set('Din', v);
      r.set('WE', 1);
      r.set('CLK', 1);
      r.set('CLK', 0);
      r.set('WE', 0);
      mem[addr] = v;
      const probe = Math.floor(rnd() * 4);
      r.set('A', probe);
      if (i >= 8) check(r.num('Dout') === mem[probe] || mem[probe] === 0, 'ram readback');
    }
  });
  rows.push({ name: 'Gate-level 4×4 RAM sample', size: `${r.sim.componentCount} primitives`, ms, events: r.sim.stats.events - e0, evals: r.sim.stats.evaluations - v0, note: `${((N / ms) * 1000).toFixed(0)} write+read cycles/s` });
}

/* 5. Compile a deep hierarchy ---------------------------------------------- */
{
  const base = addersProject();
  const pb = new ProjectBuilder('bench', 'Bench');
  // Reuse the sample's half and full adder definitions.
  const circuits = [...base.circuits];
  const N = 512;
  const top = pb.circuit('chain', 'Chain', (b) => {
    for (let i = 0; i < N; i++) b.sub('full-adder', 10, i * 8);
  });
  const project = { ...base, circuits: [...circuits, top], mainCircuitId: 'chain' };
  const [design, ms] = time(() => compileProject(project, 'chain'));
  rows.push({ name: 'Compile hierarchical design', size: `${design.instanceCount} instances`, ms, events: 0, evals: 0, note: `${design.netlist.components.length} primitives` });
}

/* 6. The gate-level 8-bit computer running a program ----------------------- */
{
  const words = assemble(FIBONACCI).words;
  const ref = emulate(words, 0, 10_000);
  const r = new CircuitRunner(computerProject(words), 'computer');
  const e0 = r.sim.stats.events;
  const v0 = r.sim.stats.evaluations;
  let instructions = 0;
  const RUNS = 20;
  const [, ms] = time(() => {
    for (let run = 0; run < RUNS; run++) {
      r.set('RST', 1);
      r.set('RST', 0);
      while (r.num('HALT') !== 1) {
        r.tick(2);
        instructions++;
      }
      check(r.num('OUT') === ref.out[ref.out.length - 1], 'computer output');
    }
  });
  rows.push({ name: '8-bit computer (MyCPU)', size: `${r.sim.componentCount} primitives`, ms, events: r.sim.stats.events - e0, evals: r.sim.stats.evaluations - v0, note: `${((instructions / ms) * 1000).toFixed(0)} instructions/s` });
}

/* 7. Compile many instances of a large component --------------------------- */
{
  const base = computerProject();
  const pb = new ProjectBuilder('bench', 'Bench');
  const N = 64;
  const farm = pb.circuit('farm', 'Farm', (b) => {
    for (let i = 0; i < N; i++) b.add('subcircuit', (i % 8) * 40, Math.floor(i / 8) * 40, { circuit: 'mycpu', label: '' });
  });
  const project = { ...base, circuits: [...base.circuits, farm], mainCircuitId: 'farm' };
  compileProject(project, 'farm'); // warm the per-definition caches once, as the editor does
  const [design, ms] = time(() => compileProject(project, 'farm'));
  check(design.diagnostics.length === 0 && design.templateCount === 9, 'cpu farm compiles');
  rows.push({ name: `Compile ${N} MyCPU instances`, size: `${design.instanceCount} instances`, ms, events: 0, evals: 0, note: `${design.netlist.components.length} primitives, ${design.templateCount} shared templates` });
}

const pad = (s: string, n: number) => s.padEnd(n);
const rate = (n: number, ms: number) => (n > 0 ? `${((n / ms) * 1000 / 1e6).toFixed(2)}M` : '—');
console.log(`Node ${process.version}`);
console.log(`${pad('Benchmark', 34)}${pad('Size', 20)}${pad('Time', 11)}${pad('Events/s', 11)}${pad('Evals/s', 11)}Notes`);
for (const r of rows) {
  console.log(`${pad(r.name, 34)}${pad(r.size, 20)}${pad(`${r.ms.toFixed(0)} ms`, 11)}${pad(rate(r.events, r.ms), 11)}${pad(rate(r.evals, r.ms), 11)}${r.note}`);
}
