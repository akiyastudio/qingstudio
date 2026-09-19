import type { ProjectFileEntry } from '../../types';
import type { PendingProjectFileEntry } from './file-operation-state-model';

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/g, '');
const pathIdentity = (value: string) => normalizePath(value).toLocaleLowerCase('zh-CN');

const childSuffixWithin = (candidate: string, directory: string) => {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedDirectory = normalizePath(directory);
  const candidateKey = pathIdentity(normalizedCandidate);
  const directoryKey = pathIdentity(normalizedDirectory);
  if (!directoryKey || candidateKey === directoryKey || !candidateKey.startsWith(`${directoryKey}/`)) return null;
  return normalizedCandidate.slice(normalizedDirectory.length + 1);
};

const suffixWithinOrEqual = (candidate: string, directory: string) => pathIdentity(candidate) === pathIdentity(directory)
  ? ''
  : childSuffixWithin(candidate, directory);

const joinPath = (root: string, suffix: string) => [normalizePath(root), normalizePath(suffix).replace(/^\/+/, '')].filter(Boolean).join('/');

export const directoryPreviewCacheKey = (
  entry: Pick<ProjectFileEntry, 'kind' | 'relativePath' | 'updatedAt'>,
  relativePath = entry.relativePath,
) => {
  const normalizedRelativePath = normalizePath(relativePath).replace(/^\/+/, '');
  return entry.kind === 'shortcut'
    ? `shortcut:${normalizedRelativePath}:${entry.updatedAt}`
    : normalizedRelativePath;
};

export const pendingDirectoryPreviewSourceCacheKey = (entry: PendingProjectFileEntry) => entry.pendingSourceRelativePath
  ? directoryPreviewCacheKey(entry, entry.pendingSourceRelativePath)
  : undefined;

const pendingRenamePhysicalRoots = (entry: PendingProjectFileEntry) => {
  if (!entry.pendingSourceRelativePath) return undefined;
  const target = normalizePath(entry.path);
  const separatorIndex = target.lastIndexOf('/');
  const sourceName = normalizePath(entry.pendingSourceRelativePath).split('/').pop() || '';
  return { source: `${separatorIndex >= 0 ? target.slice(0, separatorIndex + 1) : ''}${sourceName}`, target };
};

/** Remap cached children to an optimistic directory rename without losing thumbnail grants or media metadata. */
export const remapPendingDirectoryPreviewEntries = (
  entry: PendingProjectFileEntry,
  cachedEntries: readonly ProjectFileEntry[],
): ProjectFileEntry[] | undefined => {
  if (!entry.pendingSourceRelativePath) return undefined;
  const physicalRoots = pendingRenamePhysicalRoots(entry);
  if (!physicalRoots) return undefined;
  return cachedEntries.map(cachedEntry => {
    const relativeSuffix = childSuffixWithin(cachedEntry.relativePath, entry.pendingSourceRelativePath!);
    const physicalSuffix = childSuffixWithin(cachedEntry.path, physicalRoots.source);
    if (relativeSuffix === null || physicalSuffix === null) return cachedEntry;
    const parentSuffix = cachedEntry.parentRelativePath
      ? suffixWithinOrEqual(cachedEntry.parentRelativePath, entry.pendingSourceRelativePath!)
      : null;
    return {
      ...cachedEntry,
      path: joinPath(physicalRoots.target, physicalSuffix),
      relativePath: joinPath(entry.relativePath, relativeSuffix),
      ...(parentSuffix === null ? {} : { parentRelativePath: joinPath(entry.relativePath, parentSuffix) }),
    };
  });
};

export const shouldCacheDirectoryPreviewResult = (
  pendingRename: boolean,
  result: { success: boolean; entries: readonly ProjectFileEntry[] },
) => result.success && (!pendingRename || result.entries.length > 0);

const parseShortcutCacheKey = (value: string) => {
  const normalized = normalizePath(value);
  if (!normalized.startsWith('shortcut:')) return undefined;
  const timestampSeparator = normalized.lastIndexOf(':');
  if (timestampSeparator <= 'shortcut:'.length) return undefined;
  return {
    relativePath: normalized.slice('shortcut:'.length, timestampSeparator),
    timestampSuffix: normalized.slice(timestampSeparator),
  };
};

const plainDirectoryPreviewCacheKeyWithin = (candidate: string, root: string) => {
  const candidateIdentity = pathIdentity(candidate);
  const rootIdentity = pathIdentity(root);
  return candidateIdentity === rootIdentity || candidateIdentity.startsWith(`${rootIdentity}/`);
};

/** Path-segment-aware cache scope matching; similar sibling prefixes do not match. */
export const directoryPreviewCacheKeyWithin = (candidate: string, root: string) => {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  if (normalizedRoot.startsWith('shortcut:')) return pathIdentity(normalizedCandidate) === pathIdentity(normalizedRoot);
  const shortcut = parseShortcutCacheKey(normalizedCandidate);
  return plainDirectoryPreviewCacheKeyWithin(shortcut?.relativePath || normalizedCandidate, normalizedRoot);
};

export const remapDirectoryPreviewCacheKey = (candidate: string, source: string, target: string) => {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedSource = normalizePath(source);
  if (!directoryPreviewCacheKeyWithin(normalizedCandidate, normalizedSource)) return undefined;
  if (normalizedSource.startsWith('shortcut:')) return normalizePath(target);
  const shortcut = parseShortcutCacheKey(normalizedCandidate);
  const candidatePath = shortcut?.relativePath || normalizedCandidate;
  const remappedPath = `${normalizePath(target)}${candidatePath.slice(normalizedSource.length)}`;
  return shortcut ? `shortcut:${remappedPath}${shortcut.timestampSuffix}` : remappedPath;
};

/**
 * Atomically finish one or more optimistic directory renames.
 *
 * The immutable source snapshot is essential for supported swaps/cycles such
 * as A->B and B->A. Reading and writing the authoritative map one entry at a
 * time would let the first target overwrite the next source cover.
 */
export const settlePendingDirectoryPreviewRenameCaches = (
  cache: Map<string, ProjectFileEntry[]>,
  optimisticCache: Map<string, ProjectFileEntry[]>,
  entries: readonly PendingProjectFileEntry[],
  committed: boolean,
) => {
  const renames = entries.flatMap(entry => {
    if ((entry.kind !== 'folder' && entry.kind !== 'shortcut') || !entry.pendingSourceRelativePath) return [];
    return [{ entry, sourceKey: pendingDirectoryPreviewSourceCacheKey(entry)!, targetKey: directoryPreviewCacheKey(entry) }];
  });
  if (!renames.length) return undefined;

  const sourceSnapshot = new Map(cache);
  const targetUpdates = new Map<string, ProjectFileEntry[]>();
  if (committed) {
    for (const rename of renames) {
      for (const [sourceCacheKey, sourceEntries] of sourceSnapshot) {
        const targetCacheKey = remapDirectoryPreviewCacheKey(sourceCacheKey, rename.sourceKey, rename.targetKey);
        if (!targetCacheKey) continue;
        const remapped = remapPendingDirectoryPreviewEntries(rename.entry, sourceEntries);
        if (remapped) targetUpdates.set(targetCacheKey, remapped);
      }
      for (const [targetCacheKey, targetEntries] of optimisticCache) {
        if (directoryPreviewCacheKeyWithin(targetCacheKey, rename.targetKey)) targetUpdates.set(targetCacheKey, targetEntries);
      }
    }
    for (const key of [...cache.keys()]) {
      if (renames.some(rename => directoryPreviewCacheKeyWithin(key, rename.sourceKey) || directoryPreviewCacheKeyWithin(key, rename.targetKey))) cache.delete(key);
    }
    for (const [key, value] of targetUpdates) cache.set(key, value);
  }
  for (const key of [...optimisticCache.keys()]) {
    if (renames.some(rename => directoryPreviewCacheKeyWithin(key, rename.targetKey))) optimisticCache.delete(key);
  }
  return {
    renames: renames.map(({ sourceKey, targetKey }) => ({ sourceKey, targetKey })),
    invalidatedRequestRoots: committed
      ? [...new Set(renames.flatMap(rename => [rename.sourceKey, rename.targetKey]))]
      : [...new Set(renames.map(rename => rename.targetKey))],
  };
};

export const folderCoverEntryAfterLoad = (
  previous: ProjectFileEntry | undefined,
  entries: readonly ProjectFileEntry[],
  retainPrevious: boolean,
) => {
  const next = entries.find(item => item.kind === 'image' || item.kind === 'raw' || item.kind === 'video')
    || entries.find(item => item.kind !== 'folder');
  return retainPrevious && !next ? previous : next;
};
