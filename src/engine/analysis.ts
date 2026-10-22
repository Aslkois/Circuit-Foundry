import type { Simulator } from './simulator.ts';

/**
 * Static feedback analysis.
 *
 * Builds the combinational dependency graph (component → components reading
 * any net it drives; sequential primitives break edges because their outputs
 * depend only on stored state) and returns its non-trivial strongly connected
 * components. Each one is a feedback loop through combinational logic: either
 * an intentional storage element built from gates (an SR latch) or an
 * accidental loop that may oscillate. Loops are reported, never rejected.
 */
export function findFeedbackLoops(sim: Simulator): number[][] {
  const count = sim.componentCount;
  const adj: number[][] = Array.from({ length: count }, () => []);
  const linkedCache = new Map<number, number[]>();
  const linked = (n: number) => {
    let l = linkedCache.get(n);
    if (!l) {
      l = sim.linkedNets(n);
      linkedCache.set(n, l);
    }
    return l;
  };

  for (let c = 0; c < count; c++) {
    const info = sim.component(c);
    if (info.sequential) continue;
    const targets = new Set<number>();
    info.pins.forEach((pin, pi) => {
      if (pin.dir === 'in') return;
      for (const n of linked(info.pinNets[pi])) {
        for (const r of sim.netReaders(n)) {
          if (!sim.component(r).sequential) targets.add(r);
        }
      }
    });
    adj[c] = [...targets];
  }

  // Iterative Tarjan SCC.
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack: number[] = [];
  const loops: number[][] = [];
  let next = 0;

  for (let root = 0; root < count; root++) {
    if (index[root] >= 0) continue;
    const work: [number, number][] = [[root, 0]];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame[0];
      if (frame[1] < adj[v].length) {
        const w = adj[v][frame[1]++];
        if (index[w] < 0) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1][0];
          low[parent] = Math.min(low[parent], low[v]);
        }
        if (low[v] === index[v]) {
          const scc: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            scc.push(w);
          } while (w !== v);
          if (scc.length > 1 || adj[v].includes(v)) loops.push(scc.sort((x, y) => x - y));
        }
      }
    }
  }
  return loops.sort((x, y) => x[0] - y[0]);
}
