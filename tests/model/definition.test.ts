import { describe, expect, it } from 'vitest';
import {
  CircuitRunner,
  DefinitionError,
  ProjectBuilder,
  addParam,
  circuitInterface,
  findCircuit,
  movePort,
  removeParam,
  renameInExpr,
  replaceCircuit,
  resetSymbol,
  setBinding,
  setPortClock,
  setPortSide,
  setSymbolBody,
  updateParam,
  type Project,
} from '../../src/model/index.ts';
import { halfAdderProject } from './helpers.ts';

function ports(c: Parameters<typeof circuitInterface>[0]) {
  const i = circuitInterface(c);
  return [...i.inputs, ...i.outputs].map((p) => `${p.label}:${p.side}${p.slot}${p.clock ? '^' : ''}`);
}

/** invN (parameter N) used in top with N = 8. */
function parametric(): Project {
  const pb = new ProjectBuilder('p', 'P');
  pb.circuit('invN', 'Inverter', (b) => {
    b.param('N', 4, 1, 32);
    const a = b.add('input', 0, 0, { label: 'A' });
    const n = b.add('not', 4, 0);
    const y = b.add('output', 8, 0, { label: 'Y' });
    b.bind(a, 'width', 'N').bind(n, 'width', 'N').bind(y, 'width', 'max(N, 1)');
    b.wire(a.pin('out'), n.pin('in'));
    b.wire(n.pin('out'), y.pin('in'));
  });
  pb.circuit('top', 'Top', (b) => {
    const a = b.add('input', 0, 0, { label: 'A', width: 8 });
    const u = b.sub('invN', 8, 0, '', 0, { N: 8 });
    const y = b.add('output', 16, 0, { label: 'Y', width: 8 });
    b.wire(a.pin('out'), u.port('A'));
    b.wire(u.port('Y'), y.pin('in'));
  });
  return pb.build('top');
}

describe('symbol editing', () => {
  it('moves ports between sides, reorders them and marks clocks', () => {
    const c = findCircuit(halfAdderProject(), 'ha')!;
    expect(ports(c)).toEqual(['A:left0', 'B:left1', 'S:right0', 'C:right1']);
    const top = setPortSide(c, 'c1', 'top');
    expect(ports(top)).toEqual(['B:left0', 'A:top0', 'S:right0', 'C:right1']);
    const swapped = movePort(top, 'c6', -1);
    expect(ports(swapped)).toEqual(['B:left0', 'A:top0', 'C:right0', 'S:right1']);
    expect(movePort(swapped, 'c6', -1)).toBe(swapped);
    const clocked = setPortClock(swapped, 'c2', true);
    expect(ports(clocked)).toEqual(['B:left0^', 'A:top0', 'C:right0', 'S:right1']);
    const body = setSymbolBody(clocked, { label: 'HA', width: 10 });
    expect(circuitInterface(body)).toMatchObject({ symbolLabel: 'HA', symbolWidth: 10 });
    expect(() => setSymbolBody(body, { width: 3 })).toThrow(DefinitionError);
    expect(resetSymbol(body).symbol).toBeUndefined();
    expect(setSymbolBody(c, { label: '' })).toEqual(c);
  });
});

describe('parameter editing', () => {
  it('renames a parameter in bindings and in instance values across the project', () => {
    const p = parametric();
    const q = updateParam(p, 'invN', 'N', { name: 'WIDTH' });
    const inv = findCircuit(q, 'invN')!;
    expect(inv.params).toEqual([{ name: 'WIDTH', default: 4, min: 1, max: 32 }]);
    expect(inv.components.map((c) => c.bind)).toEqual([{ width: 'WIDTH' }, { width: 'WIDTH' }, { width: 'max(WIDTH, 1)' }]);
    expect(findCircuit(q, 'top')!.components.find((c) => c.type === 'subcircuit')!.props).toMatchObject({ '@WIDTH': 8 });
    const r = new CircuitRunner(q);
    expect(r.design.diagnostics).toEqual([]);
    r.set('A', 0x0f);
    expect(r.num('Y')).toBe(0xf0);
  });

  it('re-evaluates stored values when a default changes and validates ranges', () => {
    const p = parametric();
    const q = updateParam(p, 'invN', 'N', { default: 6 });
    expect(findCircuit(q, 'invN')!.components.map((c) => c.props.width)).toEqual([6, 6, 6]);
    expect(() => updateParam(p, 'invN', 'N', { default: 40 })).toThrow(/between 1 and 32/);
    expect(() => updateParam(p, 'invN', 'N', { name: 'max' })).toThrow(/function/);
    expect(() => updateParam(p, 'invN', 'N', { name: '9x' })).toThrow(/not a valid parameter name/);
  });

  it('adds and removes parameters', () => {
    const p = parametric();
    const inv = addParam(findCircuit(p, 'invN')!);
    expect(inv.params!.map((x) => x.name)).toEqual(['N', 'N2']);
    const q = removeParam(replaceCircuit(p, inv), 'invN', 'N');
    expect(findCircuit(q, 'invN')!.params!.map((x) => x.name)).toEqual(['N2']);
    expect(findCircuit(q, 'top')!.components.find((c) => c.type === 'subcircuit')!.props).not.toHaveProperty('@N');
    // Bindings that still use N are reported.
    expect(new CircuitRunner(q).design.diagnostics.some((d) => d.code === 'binding')).toBe(true);
  });

  it('binds and unbinds properties, rejecting expressions that do not evaluate', () => {
    const inv = findCircuit(parametric(), 'invN')!;
    const bound = setBinding(inv, 'c2', 'width', 'N * 2');
    expect(bound.components[1]).toMatchObject({ bind: { width: 'N * 2' }, props: { width: 8 } });
    const unbound = setBinding(bound, 'c2', 'width', null);
    expect(unbound.components[1].bind).toBeUndefined();
    expect(unbound.components[1].props.width).toBe(8);
    expect(() => setBinding(inv, 'c2', 'width', 'M + 1')).toThrow(/unknown parameter "M"/);
    expect(() => setBinding(inv, 'c2', 'width', 'N +')).toThrow(DefinitionError);
  });

  it('renames identifiers in expressions without touching functions or hex literals', () => {
    expect(renameInExpr('max(N, 0xN) + N*2', 'N', 'W')).toBe('max(W, 0xN) + W*2');
    expect(renameInExpr('max(max, 1)', 'max', 'M')).toBe('max(M, 1)');
  });
});
