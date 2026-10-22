import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { SAMPLES } from '../../samples/index.ts';
import { useServices } from '../context.ts';
import type { StoredProjectSummary } from '../state/persistence.ts';
import { Icon } from './icons.tsx';

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ProjectsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { repo, actions, store } = useServices();
  const [projects, setProjects] = useState<StoredProjectSummary[] | null>(null);
  const currentId = store.getState().project.id;

  useEffect(() => {
    let live = true;
    // Save pending edits first so the list shows the current project as it is.
    actions
      .flushSave()
      .then(() => repo.list())
      .then((list) => live && setProjects(list));
    return () => {
      live = false;
    };
  }, [repo, actions]);

  const remove = async (p: StoredProjectSummary) => {
    if (p.id === currentId) return;
    if (!window.confirm(`Delete "${p.name}" from this browser? This cannot be undone. Export it first if you want a copy.`)) return;
    await repo.remove(p.id);
    setProjects(await repo.list());
  };

  return (
    <Modal title="Projects" onClose={onClose} wide>
      <div className="projects-layout">
        <section>
          <h3>Your projects</h3>
          <p className="muted small">{repo.persistent ? 'Stored in this browser.' : 'This browser does not allow local storage; projects last only until the tab closes.'}</p>
          <div className="button-row">
            <button className="primary" onClick={actions.newProject}>
              <Icon name="plus" size={14} /> New blank project
            </button>
            <button onClick={actions.importProject}>
              <Icon name="upload" size={14} /> Import file…
            </button>
          </div>
          {projects === null ? (
            <p className="muted">Loading…</p>
          ) : (
            <ul className="project-list">
              {projects.map((p) => (
                <li key={p.id} className={p.id === currentId ? 'current' : ''}>
                  <button className="project-open" onClick={() => actions.openStored(p.id)}>
                    <strong>{p.name}</strong>
                    <span className="muted small">
                      {p.circuitCount} circuit(s) · {p.modifiedAt ? new Date(p.modifiedAt).toLocaleString() : ''}
                      {p.id === currentId ? ' · open' : ''}
                    </span>
                  </button>
                  <button className="icon-button" disabled={p.id === currentId} title="Delete" aria-label={`Delete ${p.name}`} onClick={() => remove(p)}>
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3>Examples</h3>
          <p className="muted small">Each example opens as a new editable project built from real, working components.</p>
          <ul className="sample-list">
            {SAMPLES.map((s) => (
              <li key={s.id}>
                <button onClick={() => actions.openSample(s.id)} data-testid={`sample-${s.id}`}>
                  <strong>{s.name}</strong>
                  <span className="muted small">{s.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['V / Esc', 'Select tool; Esc also cancels and leaves a subcircuit'],
  ['W', 'Wire tool (drag, or click point to point)'],
  ['Drag from a pin', 'Draw a wire from that pin'],
  ['Click input bit', 'Toggle it (Shift+click to select without toggling)'],
  ['R / Shift+R', 'Rotate selection or the component being placed'],
  ['Delete / Backspace', 'Delete selection'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo (Ctrl+Y also redoes)'],
  ['Ctrl+C / X / V / D', 'Copy, cut, paste, duplicate'],
  ['Ctrl+A', 'Select all'],
  ['Arrow keys', 'Nudge selection (Shift: 5 units) or pan'],
  ['Wheel / pinch', 'Zoom at the cursor'],
  ['Middle drag, Space+drag, right drag', 'Pan'],
  ['F', 'Fit circuit in view'],
  ['+ / -', 'Zoom in / out'],
  ['Double-click subcircuit', 'Look inside the instance'],
  ['P', 'Run / pause clocks'],
  ['T', 'Advance clocks one tick'],
  ['.', 'Step one gate delay (when auto-propagate is off)'],
  ['Ctrl+S', 'Save now (projects also save automatically)'],
  ['Ctrl+O', 'Projects and examples'],
  ['Ctrl+Shift+E / I', 'Export / import a project file'],
  ['?', 'This help'],
];

export function HelpDialog({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <Modal title="Circuit Foundry — help" onClose={onClose} wide>
      <div className="help-layout">
        <section>
          <h3>Getting started</h3>
          <ol>
            <li>Pick a component in the palette, then click on the canvas (or drag it over).</li>
            <li>Drag from a pin to draw a wire. Wires snap to the grid and bend at right angles; a wire ending on another wire joins it (a dot marks the junction). Crossing wires are not connected.</li>
            <li>Click the bits of an Input pin to change them. Values propagate immediately: bright green is 1, dark green 0, blue unknown (X), grey floating (Z), red a conflict between drivers, amber a multi-bit bus.</li>
            <li>To make a reusable component, build a circuit with labelled Input and Output pins, then drag it from the Circuits list into another circuit.</li>
            <li>Clocks advance with Run or Tick. Each tick is half a period of a 1:1 clock.</li>
          </ol>
          <h3>Timing model</h3>
          <p className="small">
            Every gate has one unit of delay. All gates that see a change in the same time step are evaluated against the same values, so results never depend on evaluation order. If a circuit never settles (for example an
            inverter feeding itself), the simulation pauses and the components involved are outlined in red.
          </p>
        </section>
        <section>
          <h3>Keyboard and mouse</h3>
          <table className="shortcuts">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">
                    <kbd>{k}</kbd>
                  </th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </Modal>
  );
}
