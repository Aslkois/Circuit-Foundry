/**
 * Headless simulation from the command line (plain Node, no browser):
 *
 *   node scripts/sim.ts <project.cfproj | --sample ID> [options]
 *
 * Options:
 *   --circuit NAME     circuit to simulate (name or id; default: the main circuit)
 *   --set LABEL=VALUE  set an input pin (repeatable; VALUE: 5, 0x1f, 0b101, x, z)
 *   --ticks N          advance clocks N ticks after applying inputs
 *   --table [A,B,...]  print the exhaustive truth table over these inputs (default: all inputs)
 *   --list             list samples, or the circuits of a project
 */
import { readFileSync } from 'node:fs';
import { formatBinary, formatHex, parseValue } from '../src/engine/index.ts';
import { CircuitRunner, compileProject, parseProject, type Project } from '../src/model/index.ts';
import { SAMPLES } from '../src/samples/index.ts';

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let file: string | null = null;
let sample: string | null = null;
let circuitName: string | null = null;
let ticks = 0;
let table: string[] | null = null;
let list = false;
const sets: [string, string][] = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => args[++i] ?? fail(`${a} needs a value`);
  if (a === '--sample') sample = next();
  else if (a === '--circuit') circuitName = next();
  else if (a === '--ticks') ticks = Number(next());
  else if (a === '--set') {
    const [k, v] = next().split('=');
    if (!k || v === undefined) fail('--set expects LABEL=VALUE');
    sets.push([k, v]);
  } else if (a === '--table') table = args[i + 1] && !args[i + 1].startsWith('--') ? next().split(',') : [];
  else if (a === '--list') list = true;
  else if (a === '--help' || a === '-h') {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
    process.exit(0);
  } else if (!a.startsWith('--')) file = a;
  else fail(`unknown option ${a}`);
}

if (list && !file && !sample) {
  for (const s of SAMPLES) console.log(`${s.id.padEnd(14)} ${s.name} — ${s.description}`);
  process.exit(0);
}

let project: Project;
if (sample) {
  const s = SAMPLES.find((x) => x.id === sample) ?? fail(`no sample "${sample}" (try --list)`);
  project = s.build();
} else if (file) {
  try {
    project = parseProject(readFileSync(file, 'utf8')).project;
  } catch (e) {
    fail((e as Error).message);
  }
} else {
  fail('give a project file or --sample ID (see --help)');
}

if (list) {
  for (const c of project.circuits) console.log(`${c.id.padEnd(16)} ${c.name}${c.id === project.mainCircuitId ? '  (main)' : ''}`);
  process.exit(0);
}

const circuit = circuitName ? project.circuits.find((c) => c.id === circuitName || c.name === circuitName) : project.circuits.find((c) => c.id === project.mainCircuitId);
if (!circuit) fail(`no circuit "${circuitName}"`);

const t0 = performance.now();
const design = compileProject(project, circuit.id);
for (const d of design.diagnostics) console.error(`${d.severity}: ${d.message}`);
const r = new CircuitRunner(project, circuit.id);
const compileMs = performance.now() - t0;

const show = (v: ReturnType<CircuitRunner['get']>) => (v.width === 1 ? formatBinary(v) : `0b${formatBinary(v)} (0x${formatHex(v)})`);

console.log(`${project.name} › ${circuit.name}: ${r.sim.componentCount} primitives, ${r.sim.netCount} nets, ${design.instanceCount} instance(s), compiled in ${compileMs.toFixed(1)} ms`);

if (table) {
  const ins = table.length > 0 ? table : r.inputs.map((p) => p.label);
  const outs = r.outputs.map((p) => p.label);
  console.log([...ins, '|', ...outs].join('\t'));
  for (const row of r.truthTable(ins, outs)) {
    console.log([...row.in.map(String), '|', ...row.out.map((v) => (v === null ? 'x' : String(v)))].join('\t'));
  }
  process.exit(0);
}

for (const [label, text] of sets) {
  const port = r.inputs.find((p) => p.label === label) ?? fail(`no input "${label}" (inputs: ${r.inputs.map((p) => p.label).join(', ')})`);
  const v = parseValue(text, port.width) ?? fail(`"${text}" is not a ${port.width}-bit value`);
  const res = r.set(label, v);
  if (!res.stable) console.error(`warning: did not settle after setting ${label}: oscillation in ${res.oscillation?.componentKeys.join(', ')}`);
}
if (ticks > 0) {
  const res = r.tick(ticks);
  if (!res.stable) console.error('warning: oscillation while ticking');
}
for (const p of r.inputs) console.log(`  in  ${p.label.padEnd(10)} ${show(r.sim.getInput(design.root!.keys.get(p.id)!)!)}`);
for (const p of r.outputs) console.log(`  out ${p.label.padEnd(10)} ${show(r.get(p.label))}`);
console.log(`  t = ${r.sim.time}, ticks = ${r.sim.tickCount}, events = ${r.sim.stats.events}`);
