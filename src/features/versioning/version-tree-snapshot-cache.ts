import type { ProgressFolder, VersionGraphEdge } from '../../types';

export type CachedVersionTreeSnapshot = {
  progressFolders: ProgressFolder[];
  graphEdges: VersionGraphEdge[];
  cachedAt: number;
};

const MAX_CACHED_VERSION_TREES = 16;
const snapshots = new Map<string, CachedVersionTreeSnapshot>();

const normalizedPart = (value: string) => value
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
  .toLocaleLowerCase('zh-CN');

const snapshotKey = (
  workspacePath: string,
  projectName: string,
  projectPath: string,
  projectStatus: string,
) => [workspacePath, projectName, projectPath, projectStatus].map(normalizedPart).join('\0');

const trimCache = () => {
  while (snapshots.size > MAX_CACHED_VERSION_TREES) snapshots.delete(snapshots.keys().next().value!);
};

export const peekVersionTreeSnapshot = (
  workspacePath: string,
  projectName: string,
  projectPath: string,
  projectStatus: string,
): CachedVersionTreeSnapshot | undefined => {
  const key = snapshotKey(workspacePath, projectName, projectPath, projectStatus);
  const cached = snapshots.get(key);
  if (!cached) return undefined;
  snapshots.delete(key);
  snapshots.set(key, cached);
  return {
    ...cached,
    progressFolders: [...cached.progressFolders],
    graphEdges: [...cached.graphEdges],
  };
};

export const rememberVersionTreeSnapshot = (
  workspacePath: string,
  projectName: string,
  projectPath: string,
  projectStatus: string,
  progressFolders: ProgressFolder[],
  graphEdges: VersionGraphEdge[],
) => {
  const key = snapshotKey(workspacePath, projectName, projectPath, projectStatus);
  snapshots.delete(key);
  snapshots.set(key, {
    progressFolders: [...progressFolders],
    graphEdges: [...graphEdges],
    cachedAt: Date.now(),
  });
  trimCache();
};

export const clearVersionTreeSnapshotCacheForTests = () => snapshots.clear();
