import { createContext, useContext, useSyncExternalStore } from 'react';
import type { CanvasController, HoverInfo } from './canvas/controller.ts';
import type { Point } from '../model/index.ts';
import type { Observable } from './state/observable.ts';
import type { SimulationHost, SimStatus } from './sim/SimulationHost.ts';
import type { ProjectRepository } from './state/persistence.ts';
import type { EditorState, EditorStore } from './state/store.ts';

export interface AppServices {
  readonly store: EditorStore;
  readonly host: SimulationHost;
  readonly repo: ProjectRepository;
  /** Set once the canvas is mounted. */
  readonly controller: () => CanvasController | null;
  readonly actions: AppActions;
  readonly view: ViewObservables;
}

export interface ViewObservables {
  readonly zoom: Observable<number>;
  readonly pointer: Observable<Point | null>;
  readonly hover: Observable<HoverInfo | null>;
  readonly dialog: Observable<'projects' | 'help' | null>;
}

export interface AppActions {
  openProjects(): void;
  openHelp(): void;
  exportProject(): void;
  importProject(): void;
  newProject(): void;
  openSample(id: string): void;
  openStored(id: string): void;
  saveNow(): void;
}

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext missing');
  return s;
}

/** Subscribe to a slice of editor state. Selectors must return stable values (primitives or existing objects). */
export function useEditor<T>(selector: (s: EditorState) => T): T {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function useSimStatus(): SimStatus {
  const { host } = useServices();
  return useSyncExternalStore(host.subscribe, host.getStatus);
}
