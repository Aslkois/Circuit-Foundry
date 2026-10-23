import { formatBinary, fromUnsigned, toUnsigned, type LogicValue } from '../engine/logic.ts';
import { Simulator, type SettleResult, type SimulatorOptions } from '../engine/simulator.ts';
import { intOf, strOf } from './catalog/index.ts';
import { compileProject, type CompiledDesign } from './compile.ts';
import { pinKey } from './connectivity.ts';
import type { Project } from './types.ts';

export interface PortInfo {
  readonly id: string;
  readonly label: string;
  readonly width: number;
}

/**
 * Headless simulation of one circuit of a project: compile, simulate, and
 * address top-level Input and Output pins by label. Used by tests, scripts
 * and the command-line runner; the editor uses the same compile + engine path.
 */
export class CircuitRunner {
  readonly design: CompiledDesign;
  readonly sim: Simulator;
  readonly inputs: readonly PortInfo[];
  readonly outputs: readonly PortInfo[];
  lastSettle: SettleResult;

  constructor(project: Project, rootCircuitId = project.mainCircuitId, options?: SimulatorOptions) {
    this.design = compileProject(project, rootCircuitId);
    const errors = this.design.diagnostics.filter((d) => d.severity === 'error');
    if (!this.design.root) throw new Error(errors[0]?.message ?? 'missing root circuit');
    this.sim = new Simulator(this.design.netlist, options);
    const circuit = this.design.root.circuit;
    const ports = (type: string): PortInfo[] =>
      circuit.components
        .filter((c) => c.type === type)
        .map((c) => ({ id: c.id, label: strOf(c.props, 'label') || c.id, width: intOf(c.props, 'width') || 1 }));
    this.inputs = ports('input');
    this.outputs = ports('output');
    this.lastSettle = this.sim.settle();
  }

  private port(list: readonly PortInfo[], label: string, kind: string): PortInfo {
    const p = list.find((x) => x.label === label) ?? list.find((x) => x.id === label);
    if (!p) throw new Error(`no ${kind} labelled "${label}" (have: ${list.map((x) => x.label).join(', ')})`);
    return p;
  }

  /** Set an Input pin and settle. */
  set(label: string, value: number | LogicValue): SettleResult {
    const p = this.port(this.inputs, label, 'input');
    const v = typeof value === 'number' ? fromUnsigned(p.width, value) : value;
    this.sim.setInput(this.design.root!.keys.get(p.id)!, v);
    this.lastSettle = this.sim.settle();
    return this.lastSettle;
  }

  /** Set several inputs at the same instant, then settle once. */
  setMany(values: Readonly<Record<string, number>>): SettleResult {
    for (const [label, value] of Object.entries(values)) {
      const p = this.port(this.inputs, label, 'input');
      this.sim.setInput(this.design.root!.keys.get(p.id)!, fromUnsigned(p.width, value));
    }
    this.lastSettle = this.sim.settle();
    return this.lastSettle;
  }

  /** Value at an Output pin. */
  get(label: string): LogicValue {
    const p = this.port(this.outputs, label, 'output');
    return this.valueAtPin(p.id, 'in');
  }

  /** Unsigned value at an Output pin, or null if any bit is unknown/floating. */
  num(label: string): number | null {
    return toUnsigned(this.get(label));
  }

  bits(label: string): string {
    return formatBinary(this.get(label));
  }

  /** Value of the net touching a pin of a top-level component. */
  valueAtPin(componentId: string, pin: string): LogicValue {
    const root = this.design.root!;
    const local = root.connectivity.pinNet.get(pinKey(componentId, pin));
    if (local === undefined) throw new Error(`no pin ${componentId}.${pin}`);
    return this.sim.getNet(root.netMap[local]);
  }

  /** Advance clocks `n` ticks, settling after each. */
  tick(n = 1): SettleResult {
    this.lastSettle = this.sim.runTicks(n);
    return this.lastSettle;
  }

  /** Exhaustive truth table over the given inputs (each value in input order, MSB first). */
  truthTable(inputs: readonly string[], outputs: readonly string[]): { in: number[]; out: (number | null)[] }[] {
    const widths = inputs.map((l) => this.port(this.inputs, l, 'input').width);
    const total = widths.reduce((a, w) => a + w, 0);
    const rows: { in: number[]; out: (number | null)[] }[] = [];
    for (let combo = 0; combo < 2 ** total; combo++) {
      let shift = total;
      const values = widths.map((w) => {
        shift -= w;
        return Math.floor(combo / 2 ** shift) % 2 ** w;
      });
      inputs.forEach((l, i) => this.set(l, values[i]));
      rows.push({ in: values, out: outputs.map((o) => this.num(o)) });
    }
    return rows;
  }
}
