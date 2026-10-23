import {
  ID_PATTERN,
  PARAM_NAME_PATTERN,
  PORT_SIDES,
  ROTATIONS,
  type Circuit,
  type CircuitSymbol,
  type ComponentInstance,
  type ParamDef,
  type PortPlacement,
  type PortSide,
  type Project,
  type PropValue,
  type Rotation,
  type Wire,
} from './types.ts';

/*
 * Project file format (see docs/project-format.md).
 *
 *   {
 *     "format": "circuit-foundry-project",
 *     "formatVersion": 2,
 *     "generator": "Circuit Foundry 0.1.0",
 *     "project": { id, name, mainCircuitId, createdAt, modifiedAt, circuits: [...] }
 *   }
 *
 * Compatibility rules:
 *  - Any change that adds or changes stored data bumps FORMAT_VERSION and
 *    adds a migration from the previous version.
 *  - Older files are migrated step by step on load; the original text is
 *    never modified in place.
 *  - Files from a newer version are refused rather than silently dropping
 *    data this build does not understand.
 *  - Unknown component types and unknown props are preserved verbatim.
 *
 * History:
 *  1  Initial format.
 *  2  Circuits gain an optional "symbol" (port sides and slots, body width,
 *     label) and "params" (parameter declarations); components gain an
 *     optional "bind" (property → expression). Version 1 files are valid
 *     version 2 files, so the migration only changes the number.
 */

export const FORMAT_ID = 'circuit-foundry-project';
export const FORMAT_VERSION = 2;
export const GENERATOR = 'Circuit Foundry 0.1.0';

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

/** Upgrades a raw document from version N to N+1. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Registered migrations, keyed by the version they upgrade *from*. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: (doc) => doc,
};

export interface LoadResult {
  readonly project: Project;
  /** Version found in the file before migration. */
  readonly fileVersion: number;
  readonly migrated: boolean;
}

/**
 * Serialize to the canonical text form: indented structure with one
 * component or wire per line, so files stay compact and diff well.
 */
export function serializeProject(project: Project): string {
  const j = JSON.stringify;
  const lines: string[] = [];
  lines.push('{');
  lines.push(`  "format": ${j(FORMAT_ID)},`);
  lines.push(`  "formatVersion": ${FORMAT_VERSION},`);
  lines.push(`  "generator": ${j(GENERATOR)},`);
  lines.push('  "project": {');
  lines.push(`    "id": ${j(project.id)},`);
  lines.push(`    "name": ${j(project.name)},`);
  lines.push(`    "mainCircuitId": ${j(project.mainCircuitId)},`);
  lines.push(`    "createdAt": ${j(project.createdAt)},`);
  lines.push(`    "modifiedAt": ${j(project.modifiedAt)},`);
  lines.push('    "circuits": [');
  project.circuits.forEach((c, ci) => {
    lines.push('      {');
    lines.push(`        "id": ${j(c.id)},`);
    lines.push(`        "name": ${j(c.name)},`);
    if (c.description) lines.push(`        "description": ${j(c.description)},`);
    if (c.params?.length) {
      lines.push('        "params": [');
      c.params.forEach((p, i) => lines.push(`          ${j(p)}${i < c.params!.length - 1 ? ',' : ''}`));
      lines.push('        ],');
    }
    if (c.symbol) lines.push(`        "symbol": ${j(c.symbol)},`);
    lines.push('        "components": [');
    c.components.forEach((k, i) => {
      const item = j({ id: k.id, type: k.type, x: k.x, y: k.y, rotation: k.rotation, props: sortedProps(k.props), ...(k.bind ? { bind: sortedProps(k.bind) } : {}) });
      lines.push(`          ${item}${i < c.components.length - 1 ? ',' : ''}`);
    });
    lines.push('        ],');
    lines.push('        "wires": [');
    c.wires.forEach((w, i) => {
      const item = j({ id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 });
      lines.push(`          ${item}${i < c.wires.length - 1 ? ',' : ''}`);
    });
    lines.push('        ]');
    lines.push(`      }${ci < project.circuits.length - 1 ? ',' : ''}`);
  });
  lines.push('    ]');
  lines.push('  }');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function sortedProps<T extends PropValue>(props: Readonly<Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(props).sort()) out[k] = props[k];
  return out;
}

/** Parse, migrate and validate project text. Throws ProjectFormatError with a readable message. */
export function parseProject(text: string, migrations: Readonly<Record<number, Migration>> = MIGRATIONS, currentVersion = FORMAT_VERSION): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ProjectFormatError(`The file is not valid JSON (${(e as Error).message}).`);
  }
  if (!isObject(raw) || raw.format !== FORMAT_ID) {
    throw new ProjectFormatError('This is not a Circuit Foundry project file.');
  }
  const fileVersion = raw.formatVersion;
  if (typeof fileVersion !== 'number' || !Number.isInteger(fileVersion) || fileVersion < 1) {
    throw new ProjectFormatError('The project file has no valid format version.');
  }
  if (fileVersion > currentVersion) {
    throw new ProjectFormatError(
      `This project was saved by a newer version of Circuit Foundry (format version ${fileVersion}); this build reads up to version ${currentVersion}. Opening it here could lose data, so it was not loaded.`,
    );
  }
  let doc: Record<string, unknown> = raw;
  for (let v = fileVersion; v < currentVersion; v++) {
    const m = migrations[v];
    if (!m) throw new ProjectFormatError(`No migration from format version ${v}.`);
    doc = m(doc);
    doc = { ...doc, formatVersion: v + 1 };
  }
  return { project: validateProject(doc.project), fileVersion, migrated: fileVersion !== currentVersion };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Checker {
  readonly path: string[] = [];

  fail(msg: string): never {
    throw new ProjectFormatError(`Invalid project file at ${this.path.join('.').replaceAll('.[', '[') || 'top level'}: ${msg}`);
  }

  at<T>(segment: string, fn: () => T): T {
    this.path.push(segment);
    try {
      return fn();
    } finally {
      this.path.pop();
    }
  }

  object(v: unknown): Record<string, unknown> {
    if (!isObject(v)) this.fail('expected an object');
    return v;
  }

  string(o: Record<string, unknown>, key: string, optional = false): string {
    const v = o[key];
    if (v === undefined && optional) return '';
    if (typeof v !== 'string') this.at(key, () => this.fail('expected text'));
    return v as string;
  }

  id(o: Record<string, unknown>, key: string): string {
    const v = this.string(o, key);
    if (!ID_PATTERN.test(v)) this.at(key, () => this.fail(`"${v}" is not a valid id (letters, digits, - and _)`));
    return v;
  }

  int(o: Record<string, unknown>, key: string): number {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) this.at(key, () => this.fail('expected a whole number'));
    return v as number;
  }

  array(o: Record<string, unknown>, key: string): unknown[] {
    const v = o[key];
    if (!Array.isArray(v)) this.at(key, () => this.fail('expected a list'));
    return v as unknown[];
  }
}

export function validateProject(value: unknown): Project {
  const ck = new Checker();
  return ck.at('project', () => {
    const p = ck.object(value);
    const circuitsRaw = ck.array(p, 'circuits');
    if (circuitsRaw.length === 0) ck.fail('a project needs at least one circuit');
    const seen = new Set<string>();
    const circuits = circuitsRaw.map((c, i) =>
      ck.at(`circuits[${i}]`, () => {
        const circuit = validateCircuit(ck, c);
        if (seen.has(circuit.id)) ck.fail(`duplicate circuit id "${circuit.id}"`);
        seen.add(circuit.id);
        return circuit;
      }),
    );
    const mainCircuitId = ck.string(p, 'mainCircuitId');
    if (!seen.has(mainCircuitId)) ck.at('mainCircuitId', () => ck.fail(`no circuit with id "${mainCircuitId}"`));
    return {
      id: ck.id(p, 'id'),
      name: ck.string(p, 'name'),
      mainCircuitId,
      createdAt: ck.string(p, 'createdAt', true),
      modifiedAt: ck.string(p, 'modifiedAt', true),
      circuits,
    };
  });
}

function validateCircuit(ck: Checker, value: unknown): Circuit {
  const c = ck.object(value);
  const ids = new Set<string>();
  const components = ck.array(c, 'components').map((v, i) =>
    ck.at(`components[${i}]`, () => {
      const comp = validateComponent(ck, v);
      if (ids.has(comp.id)) ck.fail(`duplicate component id "${comp.id}"`);
      ids.add(comp.id);
      return comp;
    }),
  );
  const wireIds = new Set<string>();
  const wires = ck.array(c, 'wires').map((v, i) =>
    ck.at(`wires[${i}]`, () => {
      const w = validateWire(ck, v);
      if (wireIds.has(w.id)) ck.fail(`duplicate wire id "${w.id}"`);
      wireIds.add(w.id);
      return w;
    }),
  );
  const description = ck.string(c, 'description', true);
  const params = c.params === undefined ? undefined : ck.at('params', () => validateParams(ck, c.params));
  const symbol = c.symbol === undefined ? undefined : ck.at('symbol', () => validateSymbol(ck, c.symbol));
  return {
    id: ck.id(c, 'id'),
    name: ck.string(c, 'name'),
    ...(description ? { description } : {}),
    components,
    wires,
    ...(symbol ? { symbol } : {}),
    ...(params?.length ? { params } : {}),
  };
}

function validateParams(ck: Checker, value: unknown): ParamDef[] {
  if (!Array.isArray(value)) ck.fail('expected a list');
  const names = new Set<string>();
  return value.map((v, i) =>
    ck.at(`[${i}]`, () => {
      const o = ck.object(v);
      const name = ck.string(o, 'name');
      if (!PARAM_NAME_PATTERN.test(name)) ck.at('name', () => ck.fail(`"${name}" is not a valid parameter name (a letter or _, then letters, digits or _)`));
      if (names.has(name)) ck.fail(`duplicate parameter "${name}"`);
      names.add(name);
      const def = ck.int(o, 'default');
      const min = ck.int(o, 'min');
      const max = ck.int(o, 'max');
      if (!(min <= def && def <= max)) ck.fail('needs min ≤ default ≤ max');
      const description = ck.string(o, 'description', true);
      return { name, default: def, min, max, ...(description ? { description } : {}) };
    }),
  );
}

function validateSymbol(ck: Checker, value: unknown): CircuitSymbol {
  const o = ck.object(value);
  const out: { width?: number; label?: string; ports?: Record<string, PortPlacement> } = {};
  if (o.width !== undefined) {
    const w = ck.int(o, 'width');
    if (w < 2 || w > 80) ck.at('width', () => ck.fail('must be between 2 and 80'));
    out.width = w;
  }
  if (o.label !== undefined) out.label = ck.string(o, 'label');
  if (o.ports !== undefined) {
    const ports = ck.at('ports', () => ck.object(o.ports));
    out.ports = {};
    for (const [id, raw] of Object.entries(ports)) {
      out.ports[id] = ck.at(`ports.${id}`, () => {
        const p = ck.object(raw);
        const side = ck.string(p, 'side');
        if (!PORT_SIDES.includes(side as PortSide)) ck.at('side', () => ck.fail('must be left, right, top or bottom'));
        const slot = ck.int(p, 'slot');
        if (slot < 0 || slot > 255) ck.at('slot', () => ck.fail('must be between 0 and 255'));
        if (p.clock !== undefined && typeof p.clock !== 'boolean') ck.at('clock', () => ck.fail('must be true or false'));
        return { side: side as PortSide, slot, ...(typeof p.clock === 'boolean' ? { clock: p.clock } : {}) };
      });
    }
  }
  return out;
}

function validateComponent(ck: Checker, value: unknown): ComponentInstance {
  const o = ck.object(value);
  const rotation = o.rotation ?? 0;
  if (!ROTATIONS.includes(rotation as Rotation)) ck.at('rotation', () => ck.fail('must be 0, 90, 180 or 270'));
  const propsRaw = o.props ?? {};
  const props = ck.at('props', () => {
    const obj = ck.object(propsRaw);
    const out: Record<string, PropValue> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') ck.at(k, () => ck.fail('must be a number, text or true/false'));
      if (typeof v === 'number' && !Number.isFinite(v)) ck.at(k, () => ck.fail('must be a finite number'));
      out[k] = v as PropValue;
    }
    return out;
  });
  const bind =
    o.bind === undefined
      ? undefined
      : ck.at('bind', () => {
          const obj = ck.object(o.bind);
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v !== 'string') ck.at(k, () => ck.fail('must be an expression (text)'));
            out[k] = v as string;
          }
          return out;
        });
  return {
    id: ck.id(o, 'id'),
    type: ck.string(o, 'type'),
    x: ck.int(o, 'x'),
    y: ck.int(o, 'y'),
    rotation: rotation as Rotation,
    props,
    ...(bind && Object.keys(bind).length ? { bind } : {}),
  };
}

function validateWire(ck: Checker, value: unknown): Wire {
  const o = ck.object(value);
  const w: Wire = { id: ck.id(o, 'id'), x1: ck.int(o, 'x1'), y1: ck.int(o, 'y1'), x2: ck.int(o, 'x2'), y2: ck.int(o, 'y2') };
  const horizontal = w.y1 === w.y2 && w.x1 !== w.x2;
  const vertical = w.x1 === w.x2 && w.y1 !== w.y2;
  if (!horizontal && !vertical) ck.fail('a wire must be a non-empty horizontal or vertical segment');
  return w;
}
