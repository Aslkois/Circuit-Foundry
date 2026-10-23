import { describe, expect, it } from 'vitest';
import {
  CircuitRunner,
  FORMAT_VERSION,
  ProjectFormatError,
  parseProject,
  serializeProject,
  type Project,
} from '../../src/model/index.ts';
import { halfAdderProject } from './helpers.ts';

function mutate(project: Project, fn: (doc: { project: Record<string, unknown> } & Record<string, unknown>) => void): string {
  const doc = JSON.parse(serializeProject(project));
  fn(doc);
  return JSON.stringify(doc);
}

describe('project file format', () => {
  it('round-trips a project exactly', () => {
    const p = halfAdderProject();
    const text = serializeProject(p);
    const loaded = parseProject(text);
    expect(loaded.project).toEqual(p);
    expect(loaded.fileVersion).toBe(FORMAT_VERSION);
    expect(serializeProject(loaded.project)).toBe(text);
  });

  it('writes one component or wire per line', () => {
    const text = serializeProject(halfAdderProject());
    expect(text).toMatch(/^ {10}\{"id":"c1","type":"input","x":0,"y":0,"rotation":0,"props":\{"label":"A","width":1\}\},$/m);
    expect(JSON.parse(text).format).toBe('circuit-foundry-project');
  });

  it('preserves behaviour after save and load', () => {
    const loaded = parseProject(serializeProject(halfAdderProject())).project;
    const r = new CircuitRunner(loaded);
    r.set('A', 1);
    r.set('B', 1);
    expect([r.bits('S'), r.bits('C')]).toEqual(['0', '1']);
  });

  it('preserves unknown component types and props verbatim', () => {
    const text = mutate(halfAdderProject(), (doc) => {
      const circuits = doc.project.circuits as { components: unknown[] }[];
      circuits[0].components.push({ id: 'future', type: 'quantum-gate', x: 1, y: 2, rotation: 90, props: { qubits: 3 } });
      (circuits[0].components[0] as { props: Record<string, unknown> }).props.futureFlag = true;
    });
    const p = parseProject(text).project;
    expect(p.circuits[0].components.find((c) => c.id === 'future')).toEqual({ id: 'future', type: 'quantum-gate', x: 1, y: 2, rotation: 90, props: { qubits: 3 } });
    expect(p.circuits[0].components[0].props.futureFlag).toBe(true);
    expect(parseProject(serializeProject(p)).project).toEqual(p);
  });

  it('refuses files from a newer format version instead of losing data', () => {
    const text = mutate(halfAdderProject(), (doc) => {
      doc.formatVersion = FORMAT_VERSION + 1;
    });
    expect(() => parseProject(text)).toThrow(ProjectFormatError);
    expect(() => parseProject(text)).toThrow(/newer version/);
  });

  it('applies migrations step by step', () => {
    // Simulate a future format 3 where circuits gained a "notes" field and v1 → v2 renamed "name" to "title".
    const v1 = serializeProject(halfAdderProject()).replace(`"formatVersion": ${FORMAT_VERSION}`, '"formatVersion": 1');
    const migrations = {
      1: (doc: Record<string, unknown>) => {
        const p = doc.project as Record<string, unknown>;
        return { ...doc, project: { ...p, title: p.name } };
      },
      2: (doc: Record<string, unknown>) => {
        const p = doc.project as Record<string, unknown>;
        return { ...doc, project: { ...p, name: `${String(p.title)} (migrated)` } };
      },
    };
    const r = parseProject(v1, migrations, 3);
    expect(r.migrated).toBe(true);
    expect(r.fileVersion).toBe(1);
    expect(r.project.name).toBe('Test (migrated)');
    expect(() => parseProject(v1, { 1: migrations[1] }, 3)).toThrow(/No migration from format version 2/);
  });

  it('round-trips symbols, parameters and bindings', () => {
    const base = halfAdderProject();
    const c = base.circuits[0];
    const p: Project = {
      ...base,
      circuits: [
        {
          ...c,
          params: [{ name: 'N', default: 1, min: 1, max: 8, description: 'Width' }],
          symbol: { width: 8, label: 'HA', ports: { c1: { side: 'top', slot: 0 }, c5: { side: 'right', slot: 1, clock: false } } },
          components: c.components.map((k) => (k.id === 'c1' ? { ...k, bind: { width: 'N', '@x': 'N*2' } } : k)),
        },
      ],
    };
    const text = serializeProject(p);
    expect(text).toContain('"bind":{"@x":"N*2","width":"N"}');
    expect(text).toMatch(/^ {8}"symbol": \{"width":8,"label":"HA","ports":/m);
    const loaded = parseProject(text);
    expect(loaded.project).toEqual(p);
    expect(serializeProject(loaded.project)).toBe(text);
  });

  it('loads version 1 files unchanged', () => {
    const v1 = serializeProject(halfAdderProject()).replace(`"formatVersion": ${FORMAT_VERSION}`, '"formatVersion": 1');
    const r = parseProject(v1);
    expect(r).toMatchObject({ fileVersion: 1, migrated: true });
    expect(r.project).toEqual(halfAdderProject());
  });

  it('gives readable errors for malformed files', () => {
    const p = halfAdderProject();
    const cases: [string, RegExp][] = [
      ['not json', /not valid JSON/],
      ['{"format":"something-else"}', /not a Circuit Foundry project/],
      [mutate(p, (d) => delete d.formatVersion), /no valid format version/],
      [mutate(p, (d) => (d.project.mainCircuitId = 'missing')), /mainCircuitId: no circuit with id "missing"/],
      [
        mutate(p, (d) => {
          const w = (d.project.circuits as { wires: Record<string, number>[] }[])[0].wires[0];
          w.x2 = w.x1 + 1;
          w.y2 = w.y1 + 1;
        }),
        /wires\[0\]: a wire must be a non-empty horizontal or vertical segment/,
      ],
      [
        mutate(p, (d) => {
          const comps = (d.project.circuits as { components: Record<string, unknown>[] }[])[0].components;
          comps[1].id = comps[0].id;
        }),
        /duplicate component id "c1"/,
      ],
      [mutate(p, (d) => ((d.project.circuits as Record<string, unknown>[])[0].components = 'x')), /components: expected a list/],
      [mutate(p, (d) => ((d.project.circuits as { components: Record<string, unknown>[] }[])[0].components[0].rotation = 45)), /rotation: must be 0, 90, 180 or 270/],
      [mutate(p, (d) => ((d.project.circuits as { components: Record<string, unknown>[] }[])[0].components[0].id = 'a/b')), /not a valid id/],
      [mutate(p, (d) => (d.project.circuits = [])), /at least one circuit/],
      [mutate(p, (d) => ((d.project.circuits as Record<string, unknown>[])[0].params = [{ name: '2x', default: 1, min: 0, max: 3 }])), /params\[0\]\.name: "2x" is not a valid parameter name/],
      [mutate(p, (d) => ((d.project.circuits as Record<string, unknown>[])[0].params = [{ name: 'N', default: 9, min: 0, max: 3 }])), /params\[0\]: needs min ≤ default ≤ max/],
      [mutate(p, (d) => ((d.project.circuits as Record<string, unknown>[])[0].symbol = { ports: { c1: { side: 'middle', slot: 0 } } })), /symbol\.ports\.c1\.side: must be left, right, top or bottom/],
      [mutate(p, (d) => ((d.project.circuits as { components: Record<string, unknown>[] }[])[0].components[0].bind = { width: 4 })), /bind\.width: must be an expression/],
    ];
    for (const [text, pattern] of cases) {
      expect(() => parseProject(text)).toThrow(ProjectFormatError);
      expect(() => parseProject(text), text.slice(0, 60)).toThrow(pattern);
    }
  });
});
