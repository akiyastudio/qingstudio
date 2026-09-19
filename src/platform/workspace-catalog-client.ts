import type { WorkspaceStatusGroup } from '../types';

export type WorkspaceCatalogResponse = {
  success: boolean;
  root?: string;
  statuses: WorkspaceStatusGroup[];
  error?: string;
};

type StoredSnapshot = {
  requestedPath: string;
  capturedAt: number;
  response: WorkspaceCatalogResponse;
};

const STORAGE_KEY = 'photoflow:workspace-catalog-snapshots:v1';
const MAX_STORED_SNAPSHOTS = 8;
const memorySnapshots = new Map<string, StoredSnapshot>();
const inFlight = new Map<string, Promise<WorkspaceCatalogResponse>>();
let storedSnapshotsLoaded = false;

const keyFor = (workspacePath: string) => workspacePath.trim().replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();

const validResponse = (value: unknown): value is WorkspaceCatalogResponse => {
  const response = value as WorkspaceCatalogResponse | null;
  return Boolean(response && typeof response.success === 'boolean'
    && (response.root === undefined || typeof response.root === 'string')
    && (response.error === undefined || typeof response.error === 'string')
    && Array.isArray(response.statuses)
    && response.statuses.every(group => group && typeof group.status === 'string'
      && Array.isArray(group.projects)
      && group.projects.every(project => project && typeof project.name === 'string' && typeof project.path === 'string')));
};

const loadStoredSnapshots = () => {
  if (storedSnapshotsLoaded) return;
  storedSnapshotsLoaded = true;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]') as StoredSnapshot[];
    for (const snapshot of Array.isArray(parsed) ? parsed : []) {
      if (!snapshot?.requestedPath || !validResponse(snapshot.response) || !snapshot.response.success) continue;
      memorySnapshots.set(keyFor(snapshot.requestedPath), snapshot);
    }
  } catch {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* unavailable storage */ }
  }
};

const persistSnapshots = () => {
  try {
    const snapshots = [...memorySnapshots.values()]
      .filter(snapshot => snapshot.response.success)
      .sort((left, right) => right.capturedAt - left.capturedAt)
      .slice(0, MAX_STORED_SNAPSHOTS);
    const retained = new Set(snapshots);
    for (const [key, snapshot] of memorySnapshots) if (!retained.has(snapshot)) memorySnapshots.delete(key);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
  } catch {
    // A catalog snapshot is only a startup optimization.
  }
};

const sameResponse = (left?: WorkspaceCatalogResponse, right?: WorkspaceCatalogResponse) => JSON.stringify(left) === JSON.stringify(right);

export const readWorkspaceCatalogSnapshot = (workspacePath: string) => {
  loadStoredSnapshots();
  return memorySnapshots.get(keyFor(workspacePath))?.response || null;
};

const requestFreshCatalog = (workspacePath: string) => {
  loadStoredSnapshots();
  const key = keyFor(workspacePath);
  const running = inFlight.get(key);
  if (running) return running;
  const previous = memorySnapshots.get(key)?.response;
  const request = window.electronAPI.getWorkspaceProjects(workspacePath).then(response => {
    if (response.success) {
      const snapshot = { requestedPath: workspacePath, capturedAt: Date.now(), response };
      memorySnapshots.set(key, snapshot);
      if (response.root) memorySnapshots.set(keyFor(response.root), { ...snapshot, requestedPath: response.root });
      persistSnapshots();
      if (!sameResponse(previous, response)) {
        window.dispatchEvent(new CustomEvent('workspace-catalog-snapshot-changed', { detail: { workspacePath, response } }));
      }
    }
    return response;
  }).finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
};

export const getWorkspaceCatalog = async (workspacePath: string, options: { fresh?: boolean } = {}) => {
  loadStoredSnapshots();
  const key = keyFor(workspacePath);
  const snapshot = memorySnapshots.get(key);
  if (!options.fresh && snapshot?.response.success) {
    void requestFreshCatalog(workspacePath).catch(() => undefined);
    return snapshot.response;
  }
  return requestFreshCatalog(workspacePath);
};

export const workspaceCatalogEventMatches = (event: Event, workspacePath: string) => {
  const detail = (event as CustomEvent<{ workspacePath?: string }>).detail;
  return Boolean(detail?.workspacePath && keyFor(detail.workspacePath) === keyFor(workspacePath));
};
