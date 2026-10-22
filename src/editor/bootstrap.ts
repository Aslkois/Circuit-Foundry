import { ProjectFormatError, parseProject, type Project } from '../model/index.ts';
import { SAMPLES } from '../samples/index.ts';
import type { CanvasController } from './canvas/controller.ts';
import type { AppActions, AppServices, ViewObservables } from './context.ts';
import { SimulationHost } from './sim/SimulationHost.ts';
import { Observable } from './state/observable.ts';
import {
  blankProject,
  downloadProject,
  newProjectId,
  nowIso,
  openRepository,
  pickProjectFile,
  type ProjectRepository,
} from './state/persistence.ts';
import { EditorStore } from './state/store.ts';
import { WatchList } from './state/watches.ts';

const AUTOSAVE_DELAY_MS = 600;

export interface Boot {
  readonly services: AppServices;
  readonly setController: (c: CanvasController | null) => void;
}

/**
 * Create the store, simulation host and storage, open the last project, and
 * wire up autosave. Everything here lives outside React so its lifetime is
 * the page's lifetime.
 */
export async function bootstrap(): Promise<Boot> {
  const repo = await openRepository();
  let project: Project | null = null;
  let loadError: string | null = null;
  try {
    const last = await repo.getLastOpened();
    if (last) project = await repo.load(last);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  if (!project) {
    project = blankProject();
    await repo.save(project).catch(() => undefined);
    await repo.setLastOpened(project.id).catch(() => undefined);
  }

  const store = new EditorStore(project);
  const host = new SimulationHost(project, project.mainCircuitId);
  const watches = new WatchList();
  let projectId = project.id;
  store.subscribe(() => {
    const s = store.getState();
    host.sync(s.project, s.rootCircuitId);
    if (s.project.id !== projectId) {
      projectId = s.project.id;
      watches.clear();
    }
  });

  let controller: CanvasController | null = null;
  const view: ViewObservables = {
    zoom: new Observable(1),
    pointer: new Observable(null),
    hover: new Observable(null),
    dialog: new Observable(null),
  };

  const autosave = createAutosave(store, repo);

  const switchTo = async (next: Project) => {
    await autosave.flush();
    store.loadProject(next);
    try {
      await repo.save(next);
      await repo.setLastOpened(next.id);
      store.setSaveStatus('saved');
    } catch (e) {
      store.setSaveStatus('error', e instanceof Error ? e.message : String(e));
    }
    view.dialog.set(null);
  };

  const actions: AppActions = {
    openProjects: () => view.dialog.set('projects'),
    openHelp: () => view.dialog.set('help'),
    exportProject: () => {
      downloadProject({ ...store.getState().project, modifiedAt: nowIso() });
      store.notify('Project file exported.');
    },
    importProject: async () => {
      const file = await pickProjectFile();
      if (!file) return;
      try {
        const { project: imported, migrated, fileVersion } = parseProject(file.text);
        let next = imported;
        const existing = (await repo.list()).find((p) => p.id === imported.id);
        if (existing) {
          const replace = window.confirm(
            `A project with the same identity ("${existing.name}") is already stored in this browser.\n\nOK: replace it with the file.\nCancel: import the file as a separate copy.`,
          );
          if (!replace) next = { ...imported, id: newProjectId(), name: `${imported.name} (imported)` };
        }
        await switchTo(next);
        store.notify(migrated ? `Imported "${next.name}" (upgraded from format version ${fileVersion}).` : `Imported "${next.name}".`);
      } catch (e) {
        const msg = e instanceof ProjectFormatError ? e.message : `Could not import ${file.name}: ${e instanceof Error ? e.message : String(e)}`;
        store.notify(msg, 'error');
      }
    },
    newProject: () => void switchTo(blankProject()),
    openSample: (id: string) => {
      const sample = SAMPLES.find((s) => s.id === id);
      if (!sample) return;
      const now = nowIso();
      void switchTo({ ...sample.build(), id: newProjectId(), createdAt: now, modifiedAt: now });
    },
    openStored: async (id: string) => {
      if (id === store.getState().project.id) {
        view.dialog.set(null);
        return;
      }
      try {
        await switchTo(await repo.load(id));
      } catch (e) {
        store.notify(e instanceof Error ? e.message : String(e), 'error');
      }
    },
    flushSave: () => autosave.flush(),
    saveNow: () => {
      void autosave.flush().then(() => {
        if (store.getState().saveStatus === 'saved') store.notify(repo.persistent ? 'Saved in this browser.' : 'Local storage is unavailable here: export the project to keep it.');
      });
    },
  };

  const services: AppServices = { store, host, repo, controller: () => controller, actions, view, watches };

  window.addEventListener('beforeunload', (e) => {
    if (store.getState().saveStatus !== 'saved') {
      void autosave.flush();
      e.preventDefault();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void autosave.flush();
  });

  if (loadError) setTimeout(() => store.notify(`Could not open the last project: ${loadError}`, 'error'), 0);

  // Debugging and automation hook (used by the end-to-end tests).
  (window as unknown as { circuitFoundry: unknown }).circuitFoundry = { store, host, repo, services };

  return {
    services,
    setController: (c) => {
      controller = c;
    },
  };
}

function createAutosave(store: EditorStore, repo: ProjectRepository): { flush(): Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;

  const save = async (): Promise<void> => {
    const state = store.getState();
    if (state.saveStatus === 'saved') return;
    const project = state.project;
    store.setSaveStatus('saving');
    try {
      await repo.save({ ...project, modifiedAt: nowIso() });
      await repo.setLastOpened(project.id);
      // Only mark saved if nothing changed while writing.
      if (store.getState().project === project && store.getState().saveStatus === 'saving') store.setSaveStatus('saved');
    } catch (e) {
      store.setSaveStatus('error', e instanceof Error ? e.message : String(e));
    }
  };

  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    while (running) await running;
    if (store.getState().saveStatus === 'saved') return;
    running = save().finally(() => {
      running = null;
    });
    await running;
  };

  store.subscribe(() => {
    if (store.getState().saveStatus !== 'pending') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  });

  return { flush };
}
