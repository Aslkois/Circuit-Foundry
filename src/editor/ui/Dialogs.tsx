import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { ExtractError, ProjectFormatError, extractComponent, importCircuits, importOrder, parseProject, uniqueCircuitName, type ExtractResult, type Project } from '../../model/index.ts';
import { SAMPLES } from '../../samples/index.ts';
import { useServices } from '../context.ts';
import { pickProjectFile, type StoredProjectSummary } from '../state/persistence.ts';
import type { EditorState } from '../state/store.ts';
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
  ['Ctrl+G', 'Create a component from the selection'],
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
            <li>
              To make a reusable component, select part of a circuit and press Ctrl+G (Create component), or build a circuit with labelled Input and Output pins. Place it from the palette's "This project" group or the Circuits list. Every
              instance shares the definition: edit it once and all instances update, each with its own state. Double-click an instance to look inside with live values.
            </li>
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

function dryRunExtract(state: EditorState, circuitId: string, name: string, portLabels: Record<string, string>): ExtractResult | string {
  try {
    return extractComponent(state.project, circuitId, state.selection.components, state.selection.wires, name || 'Component', { portLabels });
  } catch (e) {
    if (e instanceof ExtractError) return e.message;
    throw e;
  }
}

export function CreateComponentDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { store } = useServices();
  const [state] = useState(() => store.getState());
  const circuit = useMemo(() => store.viewedCircuit, [store]);
  const [name, setName] = useState(() => uniqueCircuitName(state.project, 'Component'));
  const trimmed = name.trim();
  const [portNames, setPortNames] = useState<Record<string, string>>({});
  // A dry run with the automatic names lists the ports; a second one applies the names typed here.
  const base = useMemo(() => dryRunExtract(state, circuit.id, trimmed, {}), [state, circuit, trimmed]);
  const preview = useMemo(() => dryRunExtract(state, circuit.id, trimmed, portNames), [state, circuit, trimmed, portNames]);

  const create = () => {
    if (typeof preview === 'string' || !trimmed) return;
    store.commit(preview.project, { components: new Set([preview.instanceId]), wires: new Set() });
    const inner = preview.project.circuits.find((c) => c.id === preview.circuitId)!;
    store.notify(
      `Created "${inner.name}" with ${preview.ports.length} port${preview.ports.length === 1 ? '' : 's'}${preview.tunnels ? `; ${preview.tunnels} connection(s) use tunnels where no clean wire route existed` : ''}. Double-click it to look inside.`,
    );
    onClose();
  };

  return (
    <Modal title="Create component" onClose={onClose}>
      <form
        className="create-component"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="field">
          <label htmlFor="component-name">Name</label>
          <input id="component-name" type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        </div>
        {typeof base === 'string' ? (
          <p className="error-text">{base}</p>
        ) : (
          <>
            <p className="muted small">
              The {state.selection.components.size} selected component(s) move into a new circuit and one instance takes their place. Signals crossing the edge of the selection become ports; rename them here if you like:
            </p>
            {base.ports.length === 0 ? (
              <p className="muted small">No signal crosses the edge of the selection, so the component will have no ports.</p>
            ) : (
              <table className="ports port-names">
                <tbody>
                  {base.ports.map((p) => (
                    <tr key={`${p.dir}:${p.label}`}>
                      <th scope="row">{p.dir}</th>
                      <td>
                        <input
                          type="text"
                          aria-label={`Name of port ${p.label}`}
                          value={portNames[p.label] ?? p.label}
                          onChange={(e) => setPortNames({ ...portNames, [p.label]: e.target.value })}
                        />
                      </td>
                      <td className="mono">{p.width}-bit</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {typeof preview === 'string' && <p className="error-text">{preview}</p>}
          </>
        )}
        <div className="button-row end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={typeof preview === 'string' || !trimmed}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Copy components (with everything they contain) from another project, an example or a file. */
export function ImportComponentsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { repo, store, actions } = useServices();
  const currentId = store.getState().project.id;
  const [stored, setStored] = useState<StoredProjectSummary[] | null>(null);
  const [source, setSource] = useState<Project | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    actions
      .flushSave()
      .then(() => repo.list())
      .then((list) => live && setStored(list.filter((p) => p.id !== currentId)));
    return () => {
      live = false;
    };
  }, [repo, actions, currentId]);

  const choose = (p: Project) => {
    setSource(p);
    setPicked(new Set());
    setError(null);
  };
  const fromFile = async () => {
    const file = await pickProjectFile();
    if (!file) return;
    try {
      choose(parseProject(file.text).project);
    } catch (e) {
      setError(e instanceof ProjectFormatError ? e.message : `Could not read ${file.name}.`);
    }
  };
  const doImport = () => {
    if (!source || picked.size === 0) return;
    const r = importCircuits(store.getState().project, source, [...picked]);
    store.commit(r.project);
    const names = [...picked].map((id) => source.circuits.find((c) => c.id === id)!.name);
    const pickedAdded = [...picked].filter((id) => r.added.some((c) => c.id === r.idMap.get(id))).length;
    const extra = r.added.length - pickedAdded;
    store.notify(
      r.added.length === 0
        ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} already in this project.`
        : `Imported ${names.join(', ')}${extra > 0 ? ` and ${extra} component(s) ${names.length === 1 ? 'it uses' : 'they use'}` : ''}. Find ${names.length === 1 ? 'it' : 'them'} in the palette under "This project".`,
    );
    onClose();
  };

  const needs = source ? importOrder(source, [...picked]) : [];
  return (
    <Modal title="Import components" onClose={onClose} wide>
      <div className="projects-layout">
        <section>
          <h3>From</h3>
          <p className="muted small">Components are copied into this project together with every component they contain.</p>
          <div className="button-row">
            <button onClick={fromFile}>
              <Icon name="upload" size={14} /> Project file…
            </button>
          </div>
          <ul className="project-list">
            {SAMPLES.map((s) => (
              <li key={s.id}>
                <button className="project-open" onClick={() => choose(s.build())} data-testid={`import-sample-${s.id}`}>
                  <strong>{s.name}</strong>
                  <span className="muted small">Example</span>
                </button>
              </li>
            ))}
            {(stored ?? []).map((p) => (
              <li key={p.id}>
                <button className="project-open" onClick={() => repo.load(p.id).then(choose, (e: unknown) => setError(String(e)))}>
                  <strong>{p.name}</strong>
                  <span className="muted small">{p.circuitCount} circuit(s) · stored in this browser</span>
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="error-text">{error}</p>}
        </section>
        <section>
          <h3>{source ? `Components in "${source.name}"` : 'Components'}</h3>
          {!source ? (
            <p className="muted small">Choose a project, an example or a file.</p>
          ) : (
            <>
              <ul className="import-list">
                {source.circuits.map((c) => (
                  <li key={c.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={picked.has(c.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          setPicked(next);
                        }}
                      />
                      <span>{c.name}</span>
                    </label>
                    {c.description && <span className="muted small">{c.description}</span>}
                  </li>
                ))}
              </ul>
              {needs.length > picked.size && (
                <p className="muted small">
                  Also brings: {needs.filter((id) => !picked.has(id)).map((id) => source.circuits.find((c) => c.id === id)!.name).join(', ')}.
                </p>
              )}
              <div className="button-row end">
                <button type="button" onClick={onClose}>
                  Cancel
                </button>
                <button className="primary" disabled={picked.size === 0} onClick={doImport}>
                  Import
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
