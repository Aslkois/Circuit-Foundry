import { useState, type ReactElement, type ReactNode } from 'react';
import { formatBinary, formatDecimal, formatHex, parseValue, type LogicValue } from '../../engine/logic.ts';
import {
  DefinitionError,
  PARAM_PREFIX,
  analyzeConnectivity,
  findCircuit,
  getDef,
  intOf,
  normalizeProps,
  pinKey,
  setComponentProps,
  setBinding,
  setRotation,
  strOf,
  usersOf,
  validatePropEdit,
  type Circuit,
  type ComponentInstance,
  type ParamDef,
  type PropDef,
  type PropValue,
  type Rotation,
} from '../../model/index.ts';
import { useEditor, useServices, useSimStatus } from '../context.ts';
import { useObservable } from '../state/observable.ts';
import { Icon } from './icons.tsx';
import { MemoryView } from './MemoryView.tsx';
import { ParamEditor, SymbolEditor } from './DefinitionPanel.tsx';
import { pinLocationLabel } from './WatchPanel.tsx';

export function formatLogic(v: LogicValue | null): string {
  if (!v) return '—';
  if (v.width === 1) return formatBinary(v);
  const parts = [`0b${formatBinary(v)}`, `0x${formatHex(v)}`];
  const dec = formatDecimal(v);
  if (dec !== 'x' && dec !== 'z') parts.push(dec);
  return parts.join('  ·  ');
}

const FACINGS: { value: Rotation; label: string }[] = [
  { value: 0, label: 'East (0°)' },
  { value: 90, label: 'South (90°)' },
  { value: 180, label: 'West (180°)' },
  { value: 270, label: 'North (270°)' },
];

function PropField({ def, comp, onError, labelExtra }: { def: PropDef; comp: ComponentInstance; onError: (msg: string | null) => void; labelExtra?: ReactNode }): ReactElement {
  const { store } = useServices();
  const typeDef = getDef(comp.type)!;
  const current = normalizeProps(typeDef, comp.props).props[def.name];
  // The parent keys this component by the current value, so local text resets when the value changes.
  const [text, setText] = useState(String(current));

  const commit = (value: PropValue) => {
    if (value === current) return;
    const err = validatePropEdit(typeDef, comp.props, def.name, value);
    if (err) {
      onError(err);
      setText(String(current));
      return;
    }
    onError(null);
    store.editViewed((c, ctx) => setComponentProps(c, comp.id, { [def.name]: value }, ctx));
  };

  const id = `prop-${comp.id}-${def.name}`;
  let input: ReactElement;
  switch (def.kind) {
    case 'enum':
      input = (
        <select id={id} value={String(current)} onChange={(e) => commit(e.target.value)}>
          {def.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'bool':
      input = <input id={id} type="checkbox" checked={current === true} onChange={(e) => commit(e.target.checked)} />;
      break;
    case 'int':
    case 'uint':
      input = (
        <input
          id={id}
          type="text"
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const t = text.trim().toLowerCase();
            const n = t.startsWith('0x') ? parseInt(t.slice(2), 16) : Number(t);
            if (!Number.isFinite(n)) {
              onError(`${def.label} must be a number`);
              setText(String(current));
              return;
            }
            commit(n);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setText(String(current));
          }}
        />
      );
      break;
    case 'string':
      input =
        def.name === 'text' ? (
          <textarea id={id} rows={3} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => commit(text)} />
        ) : (
          <input
            id={id}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => commit(text)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setText(String(current));
            }}
          />
        );
      break;
  }
  return (
    <div className="field">
      <div className="label-row">
        <label htmlFor={id}>{def.label}</label>
        {labelExtra}
      </div>
      {input}
      {def.help && <small className="help">{def.help}</small>}
    </div>
  );
}

function BindToggle({ bound, label, onClick }: { bound: boolean; label: string; onClick: () => void }): ReactElement {
  return (
    <button
      className={`bind-toggle${bound ? ' on' : ''}`}
      aria-pressed={bound}
      aria-label={bound ? `Unbind ${label}` : `Bind ${label} to a parameter expression`}
      title={bound ? 'Remove the binding (keep the current value)' : 'Bind to an expression over this circuit\'s parameters'}
      onClick={onClick}
    >
      ƒ
    </button>
  );
}

/** A property bound to an expression over the parameters of the circuit on screen. */
function BindingField({ label, prop, comp, displayed }: { label: string; prop: string; comp: ComponentInstance; displayed: ComponentInstance | undefined }): ReactElement {
  const { store } = useServices();
  const expr = comp.bind?.[prop] ?? '';
  const [text, setText] = useState(expr);
  const [error, setError] = useState<string | null>(null);
  const apply = (value: string | null) => {
    try {
      store.editViewed((c) => setBinding(c, comp.id, prop, value));
      setError(null);
    } catch (e) {
      if (!(e instanceof DefinitionError)) throw e;
      setError(e.message);
    }
  };
  const id = `bind-${comp.id}-${prop}`;
  const value = displayed?.props[prop];
  return (
    <div className="field">
      <div className="label-row">
        <label htmlFor={id}>{label}</label>
        <BindToggle bound label={label} onClick={() => apply(null)} />
      </div>
      <input
        id={id}
        type="text"
        className="mono bound"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() !== expr && apply(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(expr);
        }}
      />
      <small className="help">{value !== undefined ? `= ${String(value)} here` : ''}</small>
      {error && <small className="error-text">{error}</small>}
    </div>
  );
}

/** Parameter values of a subcircuit instance ("@name" props). */
function InstanceParams({ comp, target, parentHasParams, displayed }: { comp: ComponentInstance; target: Circuit; parentHasParams: boolean; displayed: ComponentInstance | undefined }): ReactElement | null {
  const { store } = useServices();
  const [error, setError] = useState<string | null>(null);
  const params = target.params ?? [];
  if (params.length === 0) return null;
  const set = (p: ParamDef, text: string) => {
    const t = text.trim();
    const key = PARAM_PREFIX + p.name;
    if (t === '') {
      if (comp.props[key] === undefined) return;
      const { [key]: _drop, ...rest } = comp.props;
      store.editViewed((c, ctx) => setComponentProps({ ...c, components: c.components.map((k) => (k.id === comp.id ? { ...k, props: rest } : k)) }, comp.id, {}, ctx));
      setError(null);
      return;
    }
    const n = Number(t);
    if (!Number.isInteger(n) || n < p.min || n > p.max) {
      setError(`${p.name} must be a whole number from ${p.min} to ${p.max}.`);
      return;
    }
    setError(null);
    if (comp.props[key] !== n) store.editViewed((c, ctx) => setComponentProps(c, comp.id, { [key]: n }, ctx));
  };
  return (
    <div className="definition-section">
      <h3>Parameters</h3>
      {params.map((p) => {
        const key = PARAM_PREFIX + p.name;
        if (comp.bind?.[key] !== undefined) return <BindingField key={`${key}:${comp.bind[key]}`} label={p.name} prop={key} comp={comp} displayed={displayed} />;
        const v = comp.props[key];
        const id = `iparam-${comp.id}-${p.name}`;
        return (
          <div className="field" key={`${key}:${String(v)}`}>
            <div className="label-row">
              <label htmlFor={id}>
                {p.name}
                {p.description ? ` — ${p.description}` : ''}
              </label>
              {parentHasParams && (
                <BindToggle
                  bound={false}
                  label={p.name}
                  onClick={() => store.editViewed((c) => setBinding(c, comp.id, key, String(typeof v === 'number' ? v : p.default)))}
                />
              )}
            </div>
            <input
              id={id}
              type="text"
              inputMode="numeric"
              className="mono"
              defaultValue={typeof v === 'number' ? String(v) : ''}
              placeholder={`${p.default} (default)`}
              onBlur={(e) => set(p, e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <small className="help">
              {p.min}–{p.max}
            </small>
          </div>
        );
      })}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function InputValueEditor({ comp, path }: { comp: ComponentInstance; path: readonly string[] }): ReactElement | null {
  const { host } = useServices();
  useSimStatus();
  const v = host.getSource(path, comp.id);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!v) return null;
  const apply = () => {
    const parsed = parseValue(text, v.width);
    if (!parsed) {
      setErr(`Enter a ${v.width}-bit value: decimal, 0x hex, 0b binary (x/z allowed), x or z.`);
      return;
    }
    setErr(null);
    host.setSource(path, comp.id, parsed);
    setText('');
  };
  return (
    <div className="field">
      <label htmlFor={`set-${comp.id}`}>Set value</label>
      <div className="inline">
        <input
          id={`set-${comp.id}`}
          placeholder={formatHex(v).length > 1 ? `0x${formatHex(v)}` : formatBinary(v)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && apply()}
        />
        <button onClick={apply}>Set</button>
      </div>
      {err && <small className="error-text">{err}</small>}
    </div>
  );
}

function WatchToggle({ componentId, pin }: { componentId: string; pin: string }): ReactElement {
  const { watches, store } = useServices();
  useObservable(watches.items);
  const { rootCircuitId, path, project } = store.getState();
  const on = watches.has(rootCircuitId, path, componentId, pin);
  const label = pinLocationLabel(project, rootCircuitId, path, componentId, pin);
  return (
    <button
      className={`icon-button small watch-toggle${on ? ' on' : ''}`}
      aria-label={on ? `Stop watching ${label}` : `Watch ${label}`}
      aria-pressed={on}
      title={on ? 'Remove from the Watch panel' : 'Add to the Watch panel'}
      onClick={() => (on ? watches.removeWhere(rootCircuitId, path, componentId, pin) : watches.add({ rootCircuitId, path, componentId, pin, label }))}
    >
      <Icon name="eye" size={13} />
    </button>
  );
}

function LiveValues({ comp }: { comp: ComponentInstance }): ReactElement | null {
  const { store, host } = useServices();
  const path = useEditor((s) => s.path);
  useSimStatus();
  const circuit = store.displayedCircuit;
  const node = host.nodeAt(path);
  if (!node || node.circuit !== circuit) return null;
  const conn = node.connectivity;
  const rc = conn.components.get(comp.id);
  if (!rc || rc.pins.length === 0) return null;
  const state = host.componentState(node, comp.id);
  let stored: LogicValue | null = null;
  if ((comp.type === 'register' || comp.type === 'dff') && Array.isArray(state)) {
    stored = { width: intOf(rc.props, 'width'), a: state[0] as number, b: state[1] as number };
  }
  return (
    <div className="live-values">
      <h3>Signals</h3>
      <table>
        <tbody>
          {rc.pins.map((pin) => {
            const net = conn.pinNet.get(pinKey(comp.id, pin.name));
            const v = net === undefined ? null : host.netValue(node, net);
            return (
              <tr key={pin.name}>
                <th scope="row" title={pin.dir}>
                  {pin.label ?? pin.name}
                </th>
                <td className="mono">{formatLogic(v)}</td>
                <td className="watch-cell">
                  <WatchToggle componentId={comp.id} pin={pin.name} />
                </td>
              </tr>
            );
          })}
          {stored && (
            <tr>
              <th scope="row">stored</th>
              <td className="mono">{formatLogic(stored)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ComponentInspector({ comp }: { comp: ComponentInstance }): ReactElement {
  const { store, host } = useServices();
  const project = useEditor((s) => s.project);
  const path = useEditor((s) => s.path);
  const [error, setError] = useState<string | null>(null);
  const def = getDef(comp.type);

  if (!def) {
    return (
      <div className="inspector-body">
        <h2>Unknown component</h2>
        <p className="muted">Type "{comp.type}" is not known to this version. It is preserved in the file but not simulated.</p>
      </div>
    );
  }
  const sub = comp.type === 'subcircuit' ? findCircuit(project, strOf(comp.props, 'circuit')) : undefined;
  const isSource = host.sourceKey(path, comp.id) !== null && comp.type === 'input';
  const hasParams = (store.viewedCircuit.params?.length ?? 0) > 0;
  const displayed = store.displayedCircuit.components.find((c) => c.id === comp.id);
  return (
    <div className="inspector-body">
      <h2>{sub ? sub.name : def.name}</h2>
      <p className="muted small">
        {comp.type === 'subcircuit' ? 'Subcircuit instance' : def.category} · id {comp.id}
      </p>
      <p className="description">{sub ? (sub.description ?? def.description) : def.description}</p>
      {def.primitiveNote && <p className="note">{def.primitiveNote}</p>}
      {comp.type === 'input' && path.length > 0 && <p className="note">Inside a subcircuit this pin is a port: its value comes from the enclosing circuit.</p>}
      {sub && (
        <div className="button-row">
          <button onClick={() => store.enterInstance(comp.id)}>
            <Icon name="enter" size={14} /> Look inside
          </button>
          <button onClick={() => store.openCircuit(sub.id)}>
            <Icon name="edit" size={14} /> Open definition
          </button>
        </div>
      )}
      <div className="fields">
        {def.props
          .filter((p) => !p.hidden)
          .map((p) =>
            comp.bind?.[p.name] !== undefined ? (
              <BindingField key={`${p.name}:${comp.bind[p.name]}`} label={p.label} prop={p.name} comp={comp} displayed={displayed} />
            ) : (
              <PropField
                key={`${p.name}=${String(normalizeProps(def, comp.props).props[p.name])}`}
                def={p}
                comp={comp}
                onError={setError}
                labelExtra={
                  hasParams && (p.kind === 'int' || p.kind === 'uint') ? (
                    <BindToggle bound={false} label={p.label} onClick={() => store.editViewed((c) => setBinding(c, comp.id, p.name, String(normalizeProps(def, comp.props).props[p.name])))} />
                  ) : undefined
                }
              />
            ),
          )}
        {comp.type !== 'text' && (
          <div className="field">
            <label htmlFor={`facing-${comp.id}`}>Facing</label>
            <select
              id={`facing-${comp.id}`}
              value={comp.rotation}
              onChange={(e) => store.editViewed((c, ctx) => setRotation(c, new Set([comp.id]), Number(e.target.value) as Rotation, ctx))}
            >
              {FACINGS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
      {sub && <InstanceParams comp={comp} target={sub} parentHasParams={hasParams} displayed={displayed} />}
      {isSource && <InputValueEditor comp={comp} path={path} />}
      {(comp.type === 'ram' || comp.type === 'rom') && <MemoryView comp={comp} />}
      <LiveValues comp={comp} />
    </div>
  );
}

function WireInspector({ wireIds }: { wireIds: string[] }): ReactElement {
  const { store, host } = useServices();
  const path = useEditor((s) => s.path);
  useSimStatus();
  const circuit = store.displayedCircuit;
  const conn = analyzeConnectivity(circuit, store.ctx);
  const nets = [...new Set(wireIds.map((id) => conn.wireNet.get(id)).filter((n): n is number => n !== undefined))];
  const node = host.nodeAt(path);
  return (
    <div className="inspector-body">
      <h2>{wireIds.length === 1 ? 'Wire' : `${wireIds.length} wires`}</h2>
      {nets.map((n) => {
        const net = conn.nets[n];
        const v = node && node.circuit === circuit ? host.netValue(node, n) : null;
        const pins = net.pins.map((p) => {
          const c = circuit.components.find((x) => x.id === p.componentId);
          const name = c ? strOf(c.props, 'label') || getDef(c.type)?.name || c.type : p.componentId;
          return `${name}.${p.pin}`;
        });
        return (
          <div key={n} className="net-info">
            <p>
              <strong>{net.widthConflict ? 'Width conflict' : net.width === null ? 'Unknown width' : `${net.width}-bit`}</strong>
              {' · '}
              {net.pins.length} pin(s), {net.wireIds.length} wire segment(s)
            </p>
            <p className="mono">{formatLogic(v)}</p>
            {pins.length > 0 && <p className="muted small">Connects: {pins.slice(0, 12).join(', ')}{pins.length > 12 ? '…' : ''}</p>}
            {net.pins.length > 0 && (
              <div className="inline-watch">
                <WatchToggle componentId={net.pins[0].componentId} pin={net.pins[0].pin} /> <span className="muted small">Watch this signal</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DescriptionField({ value, onCommit }: { value: string; onCommit: (v: string) => void }): ReactElement {
  const [desc, setDesc] = useState(value);
  return (
    <div className="field">
      <label htmlFor="circuit-desc">Description</label>
      <textarea id="circuit-desc" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== value && onCommit(desc)} />
    </div>
  );
}

function CircuitInspector(): ReactElement {
  const { store } = useServices();
  const project = useEditor((s) => s.project);
  useEditor((s) => s.path);
  const circuit = store.viewedCircuit;
  const users = usersOf(project, circuit.id);
  const update = (patch: { name?: string; description?: string }) => {
    store.commit({ ...project, circuits: project.circuits.map((c) => (c.id === circuit.id ? { ...c, ...patch } : c)) });
  };
  return (
    <div className="inspector-body">
      <h2>{circuit.name}</h2>
      <p className="muted small">
        Circuit · {circuit.components.length} components · {circuit.wires.length} wire segments
      </p>
      <DescriptionField key={`${circuit.id}:${circuit.description ?? ''}`} value={circuit.description ?? ''} onCommit={(description) => update({ description })} />
      <SymbolEditor key={`sym:${circuit.id}`} circuit={circuit} />
      <ParamEditor key={`par:${circuit.id}`} circuit={circuit} />
      <h3>Usage</h3>
      <p className="muted small">{users.length === 0 ? 'Not used by other circuits.' : `Used in: ${users.map((u) => u.name).join(', ')}.`}</p>
      {project.mainCircuitId !== circuit.id ? (
        <button onClick={() => store.commit({ ...project, mainCircuitId: circuit.id })}>Make this the main circuit</button>
      ) : (
        <p className="muted small">This is the project's main circuit.</p>
      )}
    </div>
  );
}

export function Inspector(): ReactElement {
  const { store, actions } = useServices();
  const selection = useEditor((s) => s.selection);
  useEditor((s) => s.project);
  const circuit = store.viewedCircuit;
  let content: ReactElement;
  if (selection.components.size === 1 && selection.wires.size === 0) {
    const comp = circuit.components.find((c) => selection.components.has(c.id));
    content = comp ? <ComponentInspector key={comp.id} comp={comp} /> : <CircuitInspector />;
  } else if (selection.components.size === 0 && selection.wires.size > 0) {
    content = <WireInspector wireIds={[...selection.wires]} />;
  } else if (selection.components.size + selection.wires.size > 1) {
    content = (
      <div className="inspector-body">
        <h2>Selection</h2>
        <p className="muted">
          {selection.components.size} component(s), {selection.wires.size} wire segment(s).
        </p>
        <p className="muted small">Drag to move · R to rotate · Ctrl+D to duplicate · Delete to remove.</p>
        <div className="button-row">
          <button onClick={() => actions.createComponent()} disabled={selection.components.size === 0}>
            <Icon name="pack" size={14} /> Create component…
          </button>
        </div>
        <p className="muted small">Turns the selection into a reusable component (Ctrl+G). Connections across the selection edge become its ports.</p>
      </div>
    );
  } else {
    content = <CircuitInspector />;
  }
  return (
    <section className="panel inspector" aria-label="Inspector">
      <header className="panel-header">
        <h2>Inspector</h2>
      </header>
      {content}
    </section>
  );
}
