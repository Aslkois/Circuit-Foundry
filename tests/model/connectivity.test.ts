import { describe, expect, it } from 'vitest';
import {
  analyzeConnectivity,
  pinKey,
  projectContext,
  type Circuit,
  type ComponentInstance,
  type Project,
  type Wire,
} from '../../src/model/index.ts';

let wireN = 0;
const w = (x1: number, y1: number, x2: number, y2: number): Wire => ({ id: `w${++wireN}`, x1, y1, x2, y2 });
const comp = (id: string, type: string, x: number, y: number, props: Record<string, number | string> = {}): ComponentInstance => ({
  id,
  type,
  x,
  y,
  rotation: 0,
  props,
});

function analyze(components: ComponentInstance[], wires: Wire[]) {
  const circuit: Circuit = { id: 'main', name: 'Main', components, wires };
  const project: Project = { id: 'p', name: 'P', mainCircuitId: 'main', circuits: [circuit], createdAt: '', modifiedAt: '' };
  return analyzeConnectivity(circuit, projectContext(project));
}

describe('connectivity', () => {
  it('connects wire endpoints that meet and pins at wire ends', () => {
    const wires = [w(0, 0, 4, 0), w(4, 0, 4, 4)];
    const conn = analyze([comp('i', 'input', 0, 0), comp('o', 'output', 4, 4)], wires);
    const net = conn.pinNet.get(pinKey('i', 'out'));
    expect(conn.pinNet.get(pinKey('o', 'in'))).toBe(net);
    expect(conn.wireNet.get(wires[0].id)).toBe(net);
    expect(conn.wireNet.get(wires[1].id)).toBe(net);
    expect(conn.nets[net!].width).toBe(1);
  });

  it('connects a wire ending on the interior of another (T junction) and draws a dot', () => {
    const wires = [w(0, 0, 10, 0), w(5, 0, 5, 5)];
    const conn = analyze([], wires);
    expect(conn.wireNet.get(wires[0].id)).toBe(conn.wireNet.get(wires[1].id));
    expect(conn.junctions).toEqual([{ x: 5, y: 0 }]);
  });

  it('does not connect wires that merely cross', () => {
    const wires = [w(0, 0, 10, 0), w(5, -5, 5, 5)];
    const conn = analyze([], wires);
    expect(conn.wireNet.get(wires[0].id)).not.toBe(conn.wireNet.get(wires[1].id));
    expect(conn.junctions).toEqual([]);
  });

  it('connects pins that touch directly and pins lying on a wire interior', () => {
    // Output pin of input "a" at (0,0) touches LED pin at (0,0); LED "b" pin sits on a wire's interior.
    const wires = [w(-5, 3, 5, 3)];
    const conn = analyze([comp('a', 'input', 0, 0), comp('l1', 'led', 0, 0), comp('l2', 'led', 0, 3)], wires);
    expect(conn.pinNet.get(pinKey('a', 'out'))).toBe(conn.pinNet.get(pinKey('l1', 'in')));
    expect(conn.pinNet.get(pinKey('l2', 'in'))).toBe(conn.wireNet.get(wires[0].id));
  });

  it('infers net width from pins, flags conflicts, and lets probes adapt', () => {
    const wires = [w(0, 0, 6, 0), w(0, 4, 6, 4)];
    const conn = analyze(
      [
        comp('a', 'input', 0, 0, { width: 8 }),
        comp('p', 'probe', 6, 0),
        comp('b', 'input', 0, 4, { width: 4 }),
        comp('c', 'output', 6, 4, { width: 2 }),
      ],
      wires,
    );
    const n1 = conn.nets[conn.wireNet.get(wires[0].id)!];
    expect(n1.width).toBe(8);
    expect(n1.widthConflict).toBe(false);
    const n2 = conn.nets[conn.wireNet.get(wires[1].id)!];
    expect(n2.widthConflict).toBe(true);
    expect(n2.width).toBeNull();
  });

  it('honours rotation when placing pins', () => {
    // NOT gate rotated 90° faces south: input above, output below the anchor.
    const circuit: Circuit = { id: 'm', name: 'M', components: [{ id: 'n', type: 'not', x: 10, y: 10, rotation: 90, props: {} }], wires: [] };
    const project: Project = { id: 'p', name: 'P', mainCircuitId: 'm', circuits: [circuit], createdAt: '', modifiedAt: '' };
    const conn = analyzeConnectivity(circuit, projectContext(project));
    const pins = conn.components.get('n')!.pins;
    expect(pins.map((p) => [p.name, p.x, p.y])).toEqual([
      ['in', 10, 8],
      ['out', 10, 12],
    ]);
  });
});
