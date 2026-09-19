import type { ProjectFileEntry } from '../../types';

export type PendingFileOperationKind = 'rename' | 'create' | 'delete' | 'move' | 'paste' | 'import' | 'copy' | 'cut' | 'project';

export type PendingProjectFileEntry = ProjectFileEntry & {
  pendingOperationId?: string;
  pendingSourceRelativePath?: string;
};

export type PendingFileOperation = {
  id: string;
  kind: PendingFileOperationKind;
  label: string;
  projectPath?: string;
  lockedPaths: string[];
  affectedDirectories: string[];
  tombstonePaths?: string[];
  optimisticEntries?: PendingProjectFileEntry[];
};

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('zh-CN');
const parentPath = (value: string) => normalizePath(value).split('/').slice(0, -1).join('/');

export const pendingPathConflicts = (operations: PendingFileOperation[], paths: string[]) => {
  const requested = new Set(paths.map(normalizePath).filter(Boolean));
  if (!requested.size) return false;
  return operations.some(operation => operation.lockedPaths.some(path => {
    const locked = normalizePath(path);
    return requested.has(locked) || [...requested].some(candidate => candidate.startsWith(`${locked}/`) || locked.startsWith(`${candidate}/`));
  }));
};

export const addPendingFileOperation = (operations: PendingFileOperation[], operation: PendingFileOperation) => (
  pendingPathConflicts(operations, operation.lockedPaths) ? operations : [...operations, operation]
);

export const removePendingFileOperation = (operations: PendingFileOperation[], operationId: string) => (
  operations.filter(operation => operation.id !== operationId)
);

// The selection retained by a rename must not turn a click on another file
// into multi-selection instead of opening it in single-click mode.
export const selectionOutsidePendingRenames = (paths: string[], operations: PendingFileOperation[]) => {
  const renames = operations.filter(operation => operation.kind === 'rename');
  return paths.filter(path => !pendingPathConflicts(renames, [path]));
};

export const predictUniqueDirectoryName = (requestedName: string, existingNames: string[]) => {
  const occupied = new Set(existingNames.map(name => name.toLocaleLowerCase('zh-CN')));
  if (!occupied.has(requestedName.toLocaleLowerCase('zh-CN'))) return requestedName;
  let index = 2;
  while (occupied.has(`${requestedName} (${index})`.toLocaleLowerCase('zh-CN'))) index += 1;
  return `${requestedName} (${index})`;
};

export const applyPendingFileOperations = (
  entries: ProjectFileEntry[],
  directoryPath: string | undefined,
  operations: PendingFileOperation[],
): PendingProjectFileEntry[] => {
  const normalizedDirectory = directoryPath === undefined ? undefined : normalizePath(directoryPath);
  const hidden = new Set(operations.flatMap(operation => operation.tombstonePaths || []).map(normalizePath));
  const pendingByPath = new Map<string, PendingFileOperation>();
  for (const operation of operations) {
    for (const path of operation.lockedPaths) pendingByPath.set(normalizePath(path), operation);
  }
  const visible: PendingProjectFileEntry[] = entries
    .filter(entry => {
      const entryPath = normalizePath(entry.relativePath);
      return ![...hidden].some(hiddenPath => entryPath === hiddenPath || entryPath.startsWith(`${hiddenPath}/`));
    })
    .map(entry => {
      const operation = pendingByPath.get(normalizePath(entry.relativePath));
      return operation ? { ...entry, pendingOperationId: operation.id } : entry;
    });
  const visiblePaths = new Set(visible.map(entry => normalizePath(entry.relativePath)));
  for (const operation of operations) {
    if (operation.kind !== 'rename') continue;
    const operationTombstones = new Set((operation.tombstonePaths || []).map(normalizePath));
    for (const optimisticEntry of operation.optimisticEntries || []) {
      const sourceKey = normalizePath(optimisticEntry.pendingSourceRelativePath || '');
      if (!sourceKey || !operationTombstones.has(sourceKey)) continue;
      if (normalizedDirectory !== undefined && parentPath(optimisticEntry.relativePath) !== normalizedDirectory) continue;
      const key = normalizePath(optimisticEntry.relativePath);
      if (visiblePaths.has(key)) continue;
      visiblePaths.add(key);
      visible.push({
        ...optimisticEntry,
        pendingOperationId: operation.id,
      });
    }
  }
  return visible;
};

export const operationRefreshDirectories = (
  operation: Pick<PendingFileOperation, 'affectedDirectories'>,
  result?: { affectedDirectories?: string[] },
) => Array.from(new Set([...(operation.affectedDirectories || []), ...(result?.affectedDirectories || [])].map(normalizePath)));

export const claimClipboardGeneration = (currentGeneration: number, pendingAcquired: boolean) => pendingAcquired
  ? currentGeneration + 1
  : currentGeneration;

export const pendingOperationForEntry = (entry: ProjectFileEntry): Pick<PendingProjectFileEntry, 'pendingOperationId'> => {
  const pending = entry as PendingProjectFileEntry;
  return {
    pendingOperationId: pending.pendingOperationId,
  };
};
