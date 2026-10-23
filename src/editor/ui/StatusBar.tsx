import { useState, type ReactElement } from 'react';
import { findCircuit, type Diagnostic } from '../../model/index.ts';
import { useEditor, useServices, useSimStatus } from '../context.ts';
import { useObservable } from '../state/observable.ts';
import { Icon } from './icons.tsx';

function fmtRate(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}

export function StatusBar({ onToggleProblems, problemsOpen }: { onToggleProblems: () => void; problemsOpen: boolean }): ReactElement {
  const { view, host } = useServices();
  const pointer = useObservable(view.pointer);
  const sim = useSimStatus();
  useEditor((s) => s.revision);
  const diags = host.diagnostics;
  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.filter((d) => d.severity === 'warning').length;
  const infos = diags.length - errors - warnings;

  const stateLabel = {
    stable: 'Stable',
    pending: `Propagating · ${sim.pendingEvents} pending event(s)`,
    oscillating: 'Oscillating — paused',
    error: 'Error',
  }[sim.state];

  return (
    <footer className="status-bar">
      <span className={`sim-state ${sim.state}`} data-testid="sim-state">
        <span className="dot" aria-hidden="true" />
        {stateLabel}
        {sim.running && ' · running'}
      </span>
      <span title="Simulation time in gate delays">t = {sim.time}</span>
      <span title="Clock ticks since reset">tick {sim.tick}</span>
      {sim.running && (
        <span title="Measured simulation speed">
          {fmtRate(sim.ticksPerSecond)} ticks/s · {fmtRate(sim.eventsPerSecond)} events/s
        </span>
      )}
      <span className="muted" title="Size of the flattened design and compile time">
        {sim.primitives} primitives · {sim.nets} nets · {sim.instances} instance(s) · compiled in {sim.compileMs.toFixed(1)} ms
      </span>
      <span className="spacer" />
      <button className={`problems-toggle${problemsOpen ? ' open' : ''}`} onClick={onToggleProblems} title="Show problems and notes" data-testid="problems-toggle">
        <Icon name="error" size={13} /> {errors}
        <Icon name="warning" size={13} /> {warnings}
        <Icon name="info" size={13} /> {infos}
      </button>
      <span className="coords">{pointer ? `x ${Math.round(pointer.x)}  y ${Math.round(pointer.y)}` : ''}</span>
    </footer>
  );
}

export function ProblemsPanel({ onClose }: { onClose: () => void }): ReactElement {
  const { host, store, controller } = useServices();
  useSimStatus();
  const project = useEditor((s) => s.project);
  const [showInfo, setShowInfo] = useState(true);
  const list = host.diagnostics.filter((d) => showInfo || d.severity !== 'info');

  const go = (d: Diagnostic) => {
    const state = store.getState();
    if (store.viewedCircuit.id !== d.circuitId) {
      if (findCircuit(state.project, d.circuitId)) store.openCircuit(d.circuitId);
    }
    store.setSelection({ components: new Set(d.componentIds ?? []), wires: new Set(d.wireIds ?? []) });
    requestAnimationFrame(() => controller()?.reveal(d.componentIds ?? [], d.wireIds ?? []));
  };

  return (
    <section className="problems" aria-label="Problems">
      <header>
        <h2>Problems and notes</h2>
        <label className="toggle small">
          <input type="checkbox" checked={showInfo} onChange={(e) => setShowInfo(e.target.checked)} /> Show notes
        </label>
        <button className="icon-button" onClick={onClose} aria-label="Close problems">
          <Icon name="close" size={14} />
        </button>
      </header>
      {list.length === 0 ? (
        <p className="muted small empty">No problems found.</p>
      ) : (
        <ul>
          {list.map((d, i) => (
            <li key={i} className={d.severity}>
              <button onClick={() => go(d)}>
                <Icon name={d.severity === 'info' ? 'info' : d.severity} size={14} />
                <span className="where">{findCircuit(project, d.circuitId)?.name ?? d.circuitId}</span>
                <span className="msg">{d.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
