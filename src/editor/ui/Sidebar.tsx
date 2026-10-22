import { useMemo, useState, type DragEvent, type ReactElement } from 'react';
import {
  CATALOG,
  CATEGORY_ORDER,
  addCircuit,
  deleteCircuit,
  defaultProps,
  renameCircuit,
  uniqueCircuitName,
  usersOf,
  wouldCreateCycle,
  type ComponentTypeDef,
} from '../../model/index.ts';
import { useEditor, useServices } from '../context.ts';
import { Icon } from './icons.tsx';
import { SymbolPreview } from './SymbolPreview.tsx';

export const DRAG_MIME = 'application/x-circuit-foundry-component';

function startDrag(e: DragEvent, type: string, props: Record<string, string | number | boolean>): void {
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ type, props }));
  e.dataTransfer.effectAllowed = 'copy';
}

export function CircuitList(): ReactElement {
  const { store } = useServices();
  const project = useEditor((s) => s.project);
  const rootId = useEditor((s) => s.rootCircuitId);
  const path = useEditor((s) => s.path);
  const [renaming, setRenaming] = useState<string | null>(null);
  const viewedId = store.viewedCircuit.id;

  const add = () => {
    const name = uniqueCircuitName(project, 'Circuit');
    const r = addCircuit(project, name);
    store.commit(r.project);
    store.openCircuit(r.circuit.id);
    setRenaming(r.circuit.id);
  };

  const remove = (id: string) => {
    const users = usersOf(project, id);
    const circuit = project.circuits.find((c) => c.id === id);
    if (!circuit) return;
    if (project.circuits.length === 1) {
      store.notify('A project needs at least one circuit.', 'error');
      return;
    }
    if (users.length > 0) {
      store.notify(`"${circuit.name}" is used in ${users.map((u) => `"${u.name}"`).join(', ')}. Remove those instances first.`, 'error');
      return;
    }
    if (!window.confirm(`Delete circuit "${circuit.name}"? You can undo this.`)) return;
    store.commit(deleteCircuit(project, id));
  };

  return (
    <section className="panel circuits" aria-label="Circuits">
      <header className="panel-header">
        <h2>Circuits</h2>
        <button className="icon-button" title="New circuit" aria-label="New circuit" onClick={add}>
          <Icon name="plus" />
        </button>
      </header>
      <ul className="circuit-list">
        {project.circuits.map((c) => {
          const isRoot = c.id === rootId;
          const usable = !wouldCreateCycle(project, viewedId, c.id);
          return (
            <li
              key={c.id}
              className={`circuit-row${isRoot ? ' active' : ''}${isRoot && path.length > 0 ? ' inside' : ''}`}
              draggable={usable}
              onDragStart={(e) => startDrag(e, 'subcircuit', { circuit: c.id, label: '' })}
              title={usable ? 'Click to open. Drag onto the canvas to use it as a component.' : 'Open. (It cannot be placed here: it contains the circuit you are editing.)'}
            >
              {renaming === c.id ? (
                <input
                  className="rename"
                  autoFocus
                  defaultValue={c.name}
                  aria-label="Circuit name"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== c.name) store.commit(renameCircuit(project, c.id, v));
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button className="circuit-open" onClick={() => store.openCircuit(c.id)} onDoubleClick={() => setRenaming(c.id)}>
                  <Icon name="chip" size={14} />
                  <span className="circuit-name">{c.name}</span>
                  {c.id === project.mainCircuitId && <span className="badge">main</span>}
                </button>
              )}
              <span className="row-actions">
                <button
                  className="icon-button small"
                  title={usable ? `Place "${c.name}" as a component` : 'Cannot place: it contains this circuit'}
                  aria-label={`Place ${c.name}`}
                  disabled={!usable}
                  onClick={() => store.setTool({ kind: 'place', type: 'subcircuit', props: { circuit: c.id, label: '' }, rotation: 0 })}
                >
                  <Icon name="enter" size={13} />
                </button>
                <button className="icon-button small" title="Rename" aria-label={`Rename ${c.name}`} onClick={() => setRenaming(c.id)}>
                  <Icon name="edit" size={13} />
                </button>
                <button className="icon-button small" title="Delete circuit" aria-label={`Delete ${c.name}`} onClick={() => remove(c.id)}>
                  <Icon name="trash" size={13} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Palette(): ReactElement {
  const { store } = useServices();
  const tool = useEditor((s) => s.tool);
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const map = new Map<string, ComponentTypeDef[]>();
    for (const def of CATALOG.values()) {
      if (def.hiddenInPalette) continue;
      if (f && !def.name.toLowerCase().includes(f) && !def.type.includes(f)) continue;
      const list = map.get(def.category) ?? [];
      list.push(def);
      map.set(def.category, list);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => [c, map.get(c)!] as const);
  }, [filter]);

  return (
    <section className="panel palette" aria-label="Components">
      <header className="panel-header">
        <h2>Components</h2>
      </header>
      <input className="palette-filter" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter components" />
      <div className="palette-scroll">
        {groups.map(([category, defs]) => (
          <div key={category} className="palette-group">
            <h3>{category}</h3>
            <div className="palette-grid">
              {defs.map((def) => {
                const armed = tool.kind === 'place' && tool.type === def.type;
                return (
                  <button
                    key={def.type}
                    className={`palette-item${armed ? ' armed' : ''}`}
                    draggable
                    onDragStart={(e) => startDrag(e, def.type, {})}
                    onClick={() => store.setTool(armed ? { kind: 'select' } : { kind: 'place', type: def.type, props: defaultProps(def), rotation: 0 })}
                    title={`${def.name}: ${def.description}${def.primitiveNote ? ` (${def.primitiveNote})` : ''}\nClick, then click on the canvas, or drag it onto the canvas.`}
                    aria-label={def.name}
                    aria-pressed={armed}
                    data-type={def.type}
                  >
                    <SymbolPreview type={def.type} />
                    <span>{def.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
