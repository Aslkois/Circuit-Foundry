import { useState, type ReactElement } from 'react';
import {
  DefinitionError,
  PORT_SIDES,
  addParam,
  circuitInterface,
  findCircuit,
  movePort,
  removeParam,
  replaceCircuit,
  resetSymbol,
  setPortClock,
  setPortSide,
  setSymbolBody,
  updateParam,
  type Circuit,
  type ParamDef,
  type PortSide,
  type Project,
} from '../../model/index.ts';
import { useServices } from '../context.ts';
import { Icon } from './icons.tsx';
import { SymbolPreview } from './SymbolPreview.tsx';

/*
 * The "as a component" part of the circuit inspector: how the circuit looks
 * and behaves when placed in other circuits (symbol and parameters).
 */

const SIDE_LABELS: Record<PortSide, string> = { left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' };

/** Commit a definition edit, turning DefinitionErrors into a message. */
function useDefinitionEdit(): { error: string | null; run: (fn: () => Project | null) => void } {
  const { store } = useServices();
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    run: (fn) => {
      try {
        const next = fn();
        setError(null);
        if (next) store.commit(next);
      } catch (e) {
        if (e instanceof DefinitionError) setError(e.message);
        else throw e;
      }
    },
  };
}

function TextCommit({ id, value, onCommit, placeholder, mono }: { id: string; value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean }): ReactElement {
  const [text, setText] = useState(value);
  return (
    <input
      id={id}
      type="text"
      className={mono ? 'mono' : undefined}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(value);
      }}
    />
  );
}

export function SymbolEditor({ circuit }: { circuit: Circuit }): ReactElement {
  const { store } = useServices();
  const { error, run } = useDefinitionEdit();
  const project = store.getState().project;
  const iface = circuitInterface(circuit);
  const ports = [...iface.inputs, ...iface.outputs].sort((a, b) => PORT_SIDES.indexOf(a.side) - PORT_SIDES.indexOf(b.side) || a.slot - b.slot);
  const edit = (fn: (c: Circuit) => Circuit) => run(() => replaceCircuit(project, fn(circuit)));
  const count = (side: PortSide) => ports.filter((p) => p.side === side).length;

  return (
    <div className="definition-section" aria-label="Symbol">
      <h3>Symbol</h3>
      <div className="symbol-preview">
        <SymbolPreview type="subcircuit" props={{ circuit: circuit.id }} ctx={store.ctx} version={iface} width={260} height={Math.min(220, 70 + 16 * Math.max(count('left'), count('right')))} maxUnit={16} />
      </div>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="symbol-label">Body text</label>
          <TextCommit key={`l:${iface.symbolLabel}`} id="symbol-label" value={iface.symbolLabel} placeholder="none" onCommit={(label) => edit((c) => setSymbolBody(c, { label: label.trim() }))} />
        </div>
        <div className="field">
          <label htmlFor="symbol-width">Body width</label>
          <TextCommit
            key={`w:${circuit.symbol?.width ?? ''}`}
            id="symbol-width"
            value={circuit.symbol?.width === undefined ? '' : String(circuit.symbol.width)}
            placeholder={`auto (${iface.symbolWidth})`}
            onCommit={(t) => edit((c) => setSymbolBody(c, { width: t.trim() === '' ? null : Number(t) }))}
          />
        </div>
      </div>
      {ports.length === 0 ? (
        <p className="muted small">No ports yet. Input and Output pins in this circuit become the ports of its symbol.</p>
      ) : (
        <table className="port-editor">
          <thead>
            <tr>
              <th scope="col">Port</th>
              <th scope="col">Side</th>
              <th scope="col">Order</th>
              <th scope="col" title="Draw a clock marker">Clk</th>
            </tr>
          </thead>
          <tbody>
            {ports.map((p) => {
              const sameSide = ports.filter((q) => q.side === p.side);
              const i = sameSide.indexOf(p);
              return (
                <tr key={p.id} data-port={p.label}>
                  <td>
                    <span className={`dir-tag ${p.dir}`}>{p.dir}</span> {p.label}
                    {p.width > 1 && <span className="muted mono"> [{p.width}]</span>}
                  </td>
                  <td>
                    <select aria-label={`Side of ${p.label}`} value={p.side} onChange={(e) => edit((c) => setPortSide(c, p.id, e.target.value as PortSide))}>
                      {PORT_SIDES.map((s) => (
                        <option key={s} value={s}>
                          {SIDE_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="order">
                    <button className="icon-button small" aria-label={`Move ${p.label} up`} title="Earlier on this side" disabled={i === 0} onClick={() => edit((c) => movePort(c, p.id, -1))}>
                      <Icon name="up" size={12} />
                    </button>
                    <button
                      className="icon-button small"
                      aria-label={`Move ${p.label} down`}
                      title="Later on this side"
                      disabled={i === sameSide.length - 1}
                      onClick={() => edit((c) => movePort(c, p.id, 1))}
                    >
                      <Icon name="down" size={12} />
                    </button>
                  </td>
                  <td>
                    <input type="checkbox" aria-label={`Clock marker on ${p.label}`} checked={p.clock} onChange={(e) => edit((c) => setPortClock(c, p.id, e.target.checked))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {error && <p className="error-text">{error}</p>}
      {circuit.symbol && (
        <div className="button-row">
          <button onClick={() => edit(resetSymbol)}>Reset to default layout</button>
        </div>
      )}
      <p className="muted small">Instances everywhere update immediately; wires attached to ports that move are re-routed.</p>
    </div>
  );
}

function ParamRow({ circuitId, param }: { circuitId: string; param: ParamDef }): ReactElement {
  const { store } = useServices();
  const { error, run } = useDefinitionEdit();
  const update = (patch: Partial<ParamDef>) => run(() => updateParam(store.getState().project, circuitId, param.name, patch));
  const num = (field: 'default' | 'min' | 'max') => (
    <TextCommit
      key={`${field}:${param[field]}`}
      id={`param-${param.name}-${field}`}
      mono
      value={String(param[field])}
      onCommit={(t) => {
        const n = Number(t.trim());
        if (t.trim() === '' || !Number.isInteger(n)) run(() => {
          throw new DefinitionError(`${field === 'default' ? 'Default' : field === 'min' ? 'Minimum' : 'Maximum'} must be a whole number.`);
        });
        else update({ [field]: n });
      }}
    />
  );
  return (
    <>
      <tr data-param={param.name}>
        <td>
          <TextCommit key={`n:${param.name}`} id={`param-${param.name}-name`} mono value={param.name} onCommit={(name) => update({ name: name.trim() })} />
        </td>
        <td>{num('default')}</td>
        <td>{num('min')}</td>
        <td>{num('max')}</td>
        <td>
          <button
            className="icon-button small"
            aria-label={`Remove parameter ${param.name}`}
            title="Remove parameter"
            onClick={() => run(() => removeParam(store.getState().project, circuitId, param.name))}
          >
            <Icon name="trash" size={12} />
          </button>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={5} className="error-text">
            {error}
          </td>
        </tr>
      )}
    </>
  );
}

export function ParamEditor({ circuit }: { circuit: Circuit }): ReactElement {
  const { store } = useServices();
  const { error, run } = useDefinitionEdit();
  const params = circuit.params ?? [];
  return (
    <div className="definition-section" aria-label="Parameters">
      <h3>Parameters</h3>
      {params.length === 0 ? (
        <p className="muted small">
          Parameters make one definition serve many sizes: bind a property (such as a bit width) to an expression like <code>N</code> or <code>N*2</code>, and set N per instance.
        </p>
      ) : (
        <table className="param-editor">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Default</th>
              <th scope="col">Min</th>
              <th scope="col">Max</th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {params.map((p) => (
              <ParamRow key={p.name} circuitId={circuit.id} param={p} />
            ))}
          </tbody>
        </table>
      )}
      {error && <p className="error-text">{error}</p>}
      <div className="button-row">
        <button onClick={() => run(() => replaceCircuit(store.getState().project, addParam(findCircuit(store.getState().project, circuit.id)!)))}>
          <Icon name="plus" size={14} /> Add parameter
        </button>
      </div>
    </div>
  );
}
