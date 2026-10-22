import { FORMAT_VERSION, parseProject, serializeProject, type Project } from '../../model/index.ts';

/*
 * Local project storage. Projects are stored as the same serialized text that
 * "Export" writes to a file, so storage and files share one format, one
 * validator and one migration path.
 */

export interface StoredProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly modifiedAt: string;
  readonly circuitCount: number;
}

export interface ProjectRepository {
  /** False when projects only live in memory (storage unavailable). */
  readonly persistent: boolean;
  list(): Promise<StoredProjectSummary[]>;
  load(id: string): Promise<Project>;
  save(project: Project): Promise<void>;
  remove(id: string): Promise<void>;
  getLastOpened(): Promise<string | null>;
  setLastOpened(id: string): Promise<void>;
}

interface ProjectRecord {
  id: string;
  name: string;
  modifiedAt: string;
  circuitCount: number;
  formatVersion: number;
  text: string;
}

function toRecord(project: Project): ProjectRecord {
  return {
    id: project.id,
    name: project.name,
    modifiedAt: project.modifiedAt,
    circuitCount: project.circuits.length,
    formatVersion: FORMAT_VERSION,
    text: serializeProject(project),
  };
}

function summary(r: ProjectRecord): StoredProjectSummary {
  return { id: r.id, name: r.name, modifiedAt: r.modifiedAt, circuitCount: r.circuitCount };
}

const DB_NAME = 'circuit-foundry';
const DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

class IndexedDbRepository implements ProjectRepository {
  readonly persistent = true;
  private readonly db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(): Promise<IndexedDbRepository> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB'));
      req.onblocked = () => reject(new Error('Storage is blocked by another tab'));
    });
    return new IndexedDbRepository(db);
  }

  private store(name: 'projects' | 'meta', mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async list(): Promise<StoredProjectSummary[]> {
    const all = await request(this.store('projects', 'readonly').getAll() as IDBRequest<ProjectRecord[]>);
    return all.map(summary).sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  }

  async load(id: string): Promise<Project> {
    const rec = await request(this.store('projects', 'readonly').get(id) as IDBRequest<ProjectRecord | undefined>);
    if (!rec) throw new Error('This project is no longer in local storage.');
    return parseProject(rec.text).project;
  }

  async save(project: Project): Promise<void> {
    const existing = await request(this.store('projects', 'readonly').get(project.id) as IDBRequest<ProjectRecord | undefined>);
    if (existing && existing.formatVersion > FORMAT_VERSION) {
      throw new Error('A newer version of Circuit Foundry saved this project; refusing to overwrite it.');
    }
    await request(this.store('projects', 'readwrite').put(toRecord(project)));
  }

  async remove(id: string): Promise<void> {
    await request(this.store('projects', 'readwrite').delete(id));
  }

  async getLastOpened(): Promise<string | null> {
    const rec = await request(this.store('meta', 'readonly').get('lastOpened') as IDBRequest<{ key: string; value: string } | undefined>);
    return rec?.value ?? null;
  }

  async setLastOpened(id: string): Promise<void> {
    await request(this.store('meta', 'readwrite').put({ key: 'lastOpened', value: id }));
  }
}

/** Fallback when IndexedDB is unavailable (some private browsing modes). */
class MemoryRepository implements ProjectRepository {
  readonly persistent = false;
  private readonly records = new Map<string, ProjectRecord>();
  private last: string | null = null;

  async list(): Promise<StoredProjectSummary[]> {
    return [...this.records.values()].map(summary);
  }

  async load(id: string): Promise<Project> {
    const r = this.records.get(id);
    if (!r) throw new Error('Project not found');
    return parseProject(r.text).project;
  }

  async save(project: Project): Promise<void> {
    this.records.set(project.id, toRecord(project));
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }

  async getLastOpened(): Promise<string | null> {
    return this.last;
  }

  async setLastOpened(id: string): Promise<void> {
    this.last = id;
  }
}

export async function openRepository(): Promise<ProjectRepository> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
    return await IndexedDbRepository.open();
  } catch {
    return new MemoryRepository();
  }
}

/* ------------------------------------------------------------------------ */
/* Files                                                                    */
/* ------------------------------------------------------------------------ */

export const FILE_EXTENSION = '.cfproj';

export function fileNameFor(project: Project): string {
  const slug = project.name.trim().replace(/[^A-Za-z0-9._ -]+/g, '').replace(/\s+/g, '-').slice(0, 60) || 'project';
  return `${slug}${FILE_EXTENSION}`;
}

export function downloadProject(project: Project): void {
  const text = serializeProject(project);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFor(project);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickProjectFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${FILE_EXTENSION},.json,application/json`;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, text: await file.text() });
    };
    input.click();
  });
}

export function newProjectId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 18);
  return `p${rnd}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function blankProject(name = 'Untitled project'): Project {
  const now = nowIso();
  return {
    id: newProjectId(),
    name,
    mainCircuitId: 'main',
    circuits: [{ id: 'main', name: 'Main', components: [], wires: [] }],
    createdAt: now,
    modifiedAt: now,
  };
}
