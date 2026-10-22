import {
  findCircuit,
  projectContext,
  replaceCircuit,
  strOf,
  type Circuit,
  type ComponentInstance,
  type LayoutContext,
  type Project,
  type Props,
  type Rotation,
  type Wire,
} from '../../model/index.ts';

export type Tool =
  | { readonly kind: 'select' }
  | { readonly kind: 'wire' }
  | { readonly kind: 'place'; readonly type: string; readonly props: Props; readonly rotation: Rotation };

export interface Selection {
  readonly components: ReadonlySet<string>;
  readonly wires: ReadonlySet<string>;
}

export const EMPTY_SELECTION: Selection = { components: new Set(), wires: new Set() };

export function selectionSize(s: Selection): number {
  return s.components.size + s.wires.size;
}

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error';

export interface Notice {
  readonly id: number;
  readonly kind: 'info' | 'error';
  readonly text: string;
}

export interface EditorState {
  readonly project: Project;
  /** Circuit being simulated (top of the instance path). */
  readonly rootCircuitId: string;
  /** Subcircuit component ids leading from the root to the circuit on screen. */
  readonly path: readonly string[];
  readonly selection: Selection;
  readonly tool: Tool;
  /** Incremented on every project change (including undo/redo and loads). */
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly saveStatus: SaveStatus;
  readonly saveError: string | null;
  readonly notice: Notice | null;
}

interface HistoryEntry {
  readonly project: Project;
  readonly rootCircuitId: string;
  readonly path: readonly string[];
  readonly selection: Selection;
}

const MAX_HISTORY = 200;

export interface Clipboard {
  readonly components: readonly ComponentInstance[];
  readonly wires: readonly Wire[];
}

/**
 * Editor state container. The project is immutable; every edit replaces it
 * and records the previous version for undo. Listeners are notified
 * synchronously; React subscribes through useSyncExternalStore and the
 * canvas redraws on the next animation frame.
 */
export class EditorStore {
  private state: EditorState;
  private readonly listeners = new Set<() => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private noticeId = 0;
  clipboard: Clipboard | null = null;
  /** Consecutive pastes of the same clipboard are offset further each time. */
  pasteCount = 0;

  constructor(project: Project) {
    this.state = {
      project,
      rootCircuitId: project.mainCircuitId,
      path: [],
      selection: EMPTY_SELECTION,
      tool: { kind: 'select' },
      revision: 0,
      canUndo: false,
      canRedo: false,
      saveStatus: 'saved',
      saveError: null,
      notice: null,
    };
  }

  getState = (): EditorState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  get ctx(): LayoutContext {
    return projectContext(this.state.project);
  }

  /** The circuit definition currently on screen, after following the instance path. */
  get viewedCircuit(): Circuit {
    return resolvePath(this.state.project, this.state.rootCircuitId, this.state.path).circuit;
  }

  /** True when looking inside a subcircuit instance rather than at the simulation root. */
  get insideInstance(): boolean {
    return this.state.path.length > 0;
  }

  /* -------------------------------------------------------------------- */
  /* Project changes                                                      */
  /* -------------------------------------------------------------------- */

  /** Replace the project, recording an undo step. */
  commit(project: Project, selection: Selection = this.state.selection): void {
    if (project === this.state.project) {
      if (selection !== this.state.selection) this.set({ selection });
      return;
    }
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.applyProject(project, { selection });
  }

  /** Apply an edit to the circuit on screen. */
  editViewed(fn: (circuit: Circuit, ctx: LayoutContext) => Circuit, selection?: (next: Circuit) => Selection): void {
    const current = this.viewedCircuit;
    const next = fn(current, this.ctx);
    if (next === current) return;
    this.commit(replaceCircuit(this.state.project, next), selection ? selection(next) : pruneSelection(this.state.selection, next));
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
  }

  /** Load a different project; clears history. */
  loadProject(project: Project): void {
    this.undoStack = [];
    this.redoStack = [];
    this.state = {
      ...this.state,
      project,
      rootCircuitId: project.mainCircuitId,
      path: [],
      selection: EMPTY_SELECTION,
      tool: { kind: 'select' },
      revision: this.state.revision + 1,
      canUndo: false,
      canRedo: false,
      saveStatus: 'saved',
      saveError: null,
    };
    for (const fn of this.listeners) fn();
  }

  private snapshot(): HistoryEntry {
    const { project, rootCircuitId, path, selection } = this.state;
    return { project, rootCircuitId, path, selection };
  }

  private restore(entry: HistoryEntry): void {
    const root = findCircuit(entry.project, this.state.rootCircuitId) ? this.state.rootCircuitId : entry.rootCircuitId;
    const resolved = resolvePath(entry.project, root, root === this.state.rootCircuitId ? this.state.path : entry.path);
    this.applyProject(entry.project, { selection: entry.selection, rootCircuitId: root, path: resolved.path });
  }

  private applyProject(project: Project, opts: { selection: Selection; rootCircuitId?: string; path?: readonly string[] }): void {
    let rootCircuitId = opts.rootCircuitId ?? this.state.rootCircuitId;
    if (!findCircuit(project, rootCircuitId)) rootCircuitId = project.mainCircuitId;
    const resolved = resolvePath(project, rootCircuitId, opts.path ?? this.state.path);
    this.set({
      project,
      rootCircuitId,
      path: resolved.path,
      selection: pruneSelection(opts.selection, resolved.circuit),
      revision: this.state.revision + 1,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      saveStatus: 'pending',
    });
  }

  /* -------------------------------------------------------------------- */
  /* Navigation, selection, tools                                          */
  /* -------------------------------------------------------------------- */

  /** Show a circuit as the simulation root. */
  openCircuit(id: string): void {
    if (!findCircuit(this.state.project, id)) return;
    this.set({ rootCircuitId: id, path: [], selection: EMPTY_SELECTION, tool: { kind: 'select' } });
  }

  /** Look inside a subcircuit instance on screen. */
  enterInstance(componentId: string): void {
    const path = [...this.state.path, componentId];
    const resolved = resolvePath(this.state.project, this.state.rootCircuitId, path);
    if (resolved.path.length !== path.length) return;
    this.set({ path, selection: EMPTY_SELECTION, tool: { kind: 'select' } });
  }

  /** Go back up to the given depth (0 = root). */
  exitTo(depth: number): void {
    if (depth >= this.state.path.length) return;
    const leaving = this.state.path[depth];
    this.set({ path: this.state.path.slice(0, depth), selection: { components: new Set([leaving]), wires: new Set() } });
  }

  setSelection(selection: Selection): void {
    this.set({ selection });
  }

  setTool(tool: Tool): void {
    this.set({ tool });
  }

  setSaveStatus(saveStatus: SaveStatus, saveError: string | null = null): void {
    if (saveStatus === this.state.saveStatus && saveError === this.state.saveError) return;
    this.set({ saveStatus, saveError });
  }

  notify(text: string, kind: Notice['kind'] = 'info'): void {
    this.set({ notice: { id: ++this.noticeId, kind, text } });
  }

  dismissNotice(id: number): void {
    if (this.state.notice?.id === id) this.set({ notice: null });
  }
}

/** Follow an instance path; stops at the first id that is not a valid subcircuit instance. */
export function resolvePath(project: Project, rootId: string, path: readonly string[]): { circuit: Circuit; path: readonly string[] } {
  let circuit = findCircuit(project, rootId) ?? findCircuit(project, project.mainCircuitId) ?? project.circuits[0];
  const valid: string[] = [];
  for (const id of path) {
    const comp = circuit.components.find((c) => c.id === id);
    if (!comp || comp.type !== 'subcircuit') break;
    const next = findCircuit(project, strOf(comp.props, 'circuit'));
    if (!next) break;
    circuit = next;
    valid.push(id);
  }
  return { circuit, path: valid.length === path.length ? path : valid };
}

function pruneSelection(selection: Selection, circuit: Circuit): Selection {
  if (selection.components.size === 0 && selection.wires.size === 0) return selection;
  const compIds = new Set(circuit.components.map((c) => c.id));
  const wireIds = new Set(circuit.wires.map((w) => w.id));
  const components = new Set([...selection.components].filter((id) => compIds.has(id)));
  const wires = new Set([...selection.wires].filter((id) => wireIds.has(id)));
  if (components.size === selection.components.size && wires.size === selection.wires.size) return selection;
  return { components, wires };
}
