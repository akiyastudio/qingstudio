export type FileEntryOpenMode = 'single' | 'double';

export type FileEntryClickIntent = 'ignore-repeat' | 'range-select' | 'toggle-select' | 'add-and-preview' | 'select' | 'open';

export interface FileEntryClickIntentInput {
  openMode: FileEntryOpenMode;
  selectionCount: number;
  entrySelected: boolean;
  range: boolean;
  additive: boolean;
  clickCount?: number;
}

export interface FileEntryPointerModifiers {
  path: string;
  additive: boolean;
  range: boolean;
  pointerType: 'mouse' | 'pen' | 'touch';
}

/** Pointer capture records click/drag context only; selection belongs to click or dragstart. */
export const fileEntryPointerModifiers = ({
  path,
  ctrlKey = false,
  metaKey = false,
  shiftKey = false,
  pointerType,
}: {
  path: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  pointerType: FileEntryPointerModifiers['pointerType'];
}): FileEntryPointerModifiers => ({
  path,
  additive: ctrlKey || metaKey,
  range: shiftKey,
  pointerType,
});

/** Native dragging never creates a persistent selection; selected drags retain their group. */
export const fileEntrySelectionAfterDragStart = (
  selectedPaths: readonly string[],
  _entryPath: string,
  _dragPaths: readonly string[],
) => [...selectedPaths];

/** Selected native drags retain order while excluding entries that cannot be exported. */
export const fileEntryDragPaths = (
  entryPath: string,
  selectedPaths: readonly string[],
  isUnsupportedPath: (path: string) => boolean,
) => {
  const requestedPaths = selectedPaths.includes(entryPath) ? [...selectedPaths] : [entryPath];
  return {
    requestedPaths,
    dragPaths: requestedPaths.filter(path => !isUnsupportedPath(path)),
  };
};

export const fileEntryClickIntent = ({
  openMode,
  selectionCount,
  entrySelected,
  range,
  additive,
  clickCount = 1,
}: FileEntryClickIntentInput): FileEntryClickIntent => {
  if (clickCount > 1) return 'ignore-repeat';
  if (range) return 'range-select';
  if (additive) return 'toggle-select';
  if (selectionCount > 0) return entrySelected ? 'toggle-select' : 'add-and-preview';
  return openMode === 'single' ? 'open' : 'select';
};

const normalizeDirectoryPath = (path: string) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

const normalizeComparablePath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/g, '');

const pathSuffixWithin = (candidate: string, directory: string) => {
  const normalizedCandidate = normalizeComparablePath(candidate);
  const normalizedDirectory = normalizeComparablePath(directory);
  const candidateIdentity = normalizedCandidate.toLocaleLowerCase('zh-CN');
  const directoryIdentity = normalizedDirectory.toLocaleLowerCase('zh-CN');
  if (candidateIdentity === directoryIdentity) return '';
  if (!directoryIdentity || !candidateIdentity.startsWith(`${directoryIdentity}/`)) return null;
  return normalizedCandidate.slice(normalizedDirectory.length + 1);
};

export interface ProgressFolderEntryLocation {
  folderPath: string;
  relativePath: string;
}

/** Keep an open media entry attached to the same progress node after its folder moves. */
export const remapEntryAfterProgressFolderMove = <T extends { path: string; relativePath: string; previewUrl?: string }>(
  entry: T,
  previous: ProgressFolderEntryLocation,
  next: ProgressFolderEntryLocation,
): T => {
  const relativeSuffix = pathSuffixWithin(entry.relativePath, previous.relativePath);
  const physicalSuffix = pathSuffixWithin(entry.path, previous.folderPath);
  if (relativeSuffix === null || physicalSuffix === null) return entry;
  const nextRelativeRoot = normalizeDirectoryPath(next.relativePath);
  const nextPhysicalRoot = normalizeComparablePath(next.folderPath);
  const relativePath = [nextRelativeRoot, relativeSuffix].filter(Boolean).join('/');
  const path = [nextPhysicalRoot, physicalSuffix].filter(Boolean).join('/');
  if (relativePath === entry.relativePath && path === entry.path) return entry;
  const { previewUrl: _stalePreviewUrl, ...retained } = entry;
  return { ...retained, path, relativePath } as T;
};

export const mutatedEntryCanBeRevealed = ({
  requestedProjectPath,
  currentProjectPath,
  mutationDirectoryPath,
  currentDirectoryPath,
  browseMode,
}: {
  requestedProjectPath: string;
  currentProjectPath: string;
  mutationDirectoryPath: string;
  currentDirectoryPath: string;
  browseMode: string;
}) => requestedProjectPath === currentProjectPath
  && normalizeDirectoryPath(mutationDirectoryPath) === normalizeDirectoryPath(currentDirectoryPath)
  && (browseMode === 'grid' || browseMode === 'list');

export const mutatedEntryFiltersNeedReset = ({
  searchQuery,
  fileFilter,
  ratingFilter,
  filterScope,
}: {
  searchQuery: string;
  fileFilter: string;
  ratingFilter: string;
  filterScope: string;
}) => Boolean(searchQuery.trim()) || fileFilter !== 'all' || ratingFilter !== 'all' || filterScope !== 'current-folder';

export const mergeRefreshedEntryMetadata = <T extends { relativePath: string; size: number; createdAt: number; updatedAt: number }>(
  refreshedEntries: readonly T[],
  retainedEntries: readonly T[],
) => {
  const retainedByPath = new Map(retainedEntries.map(entry => [entry.relativePath, entry]));
  return refreshedEntries.map(entry => {
    const retained = retainedByPath.get(entry.relativePath);
    return retained?.updatedAt ? { ...entry, size: retained.size, createdAt: retained.createdAt, updatedAt: retained.updatedAt } : entry;
  });
};

export const mergeRefreshedRecursiveDirectoryEntries = <T extends { relativePath: string; parentRelativePath?: string; size: number; createdAt: number; updatedAt: number }>(
  currentEntries: readonly T[],
  refreshedEntries: readonly T[],
  directoryPath: string,
) => {
  const directoryKey = normalizeDirectoryPath(directoryPath).toLocaleLowerCase('zh-CN');
  const belongsToDirectory = (entry: T) => normalizeDirectoryPath(
    entry.parentRelativePath ?? normalizeDirectoryPath(entry.relativePath).split('/').slice(0, -1).join('/'),
  ).toLocaleLowerCase('zh-CN') === directoryKey;
  const previousDirectoryEntries = currentEntries.filter(belongsToDirectory);
  return [
    ...currentEntries.filter(entry => !belongsToDirectory(entry)),
    ...mergeRefreshedEntryMetadata(refreshedEntries, previousDirectoryEntries),
  ];
};

export const retainStableGroupOrder = (previousOrder: readonly string[], availableOrder: readonly string[]) => {
  const known = new Set(previousOrder);
  return [...previousOrder, ...availableOrder.filter(key => !known.has(key))];
};

export const ratingMutationPreviewIsCurrent = (
  mutationSequence: number,
  currentSequence: number,
  targetIdentity: string,
  currentIdentity: string,
) => mutationSequence === currentSequence && targetIdentity === currentIdentity;

export const mediaRatingCacheKey = (filePath: string, updatedAt: number) => {
  const source = filePath.replace(/\\/g, '/');
  const slashed = source.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  const normalized = /^(?:[a-z]:\/|\/\/)/i.test(source) ? slashed.toLocaleLowerCase() : slashed;
  return `${normalized}|${updatedAt || 0}`;
};

export const renamedEntryDestinationPath = (
  sourceRelativePath: string,
  nextName: string,
  movedItems: ReadonlyArray<{ sourceRelativePath: string; destinationRelativePath: string }> = [],
) => {
  const source = normalizeDirectoryPath(sourceRelativePath);
  const moved = movedItems.find(item => normalizeDirectoryPath(item.sourceRelativePath).toLocaleLowerCase('zh-CN') === source.toLocaleLowerCase('zh-CN'));
  if (moved?.destinationRelativePath) return normalizeDirectoryPath(moved.destinationRelativePath);
  const parent = source.split('/').slice(0, -1).join('/');
  const name = normalizeDirectoryPath(nextName);
  return name ? [parent, name].filter(Boolean).join('/') : '';
};

export const directoryEntryToRevealOnReturn = (currentPath: string, targetPath: string) => {
  const current = normalizeDirectoryPath(currentPath);
  const target = normalizeDirectoryPath(targetPath);
  if (!current || current === target || target && !current.startsWith(`${target}/`)) return '';
  const nextSegment = current.slice(target ? target.length + 1 : 0).split('/')[0];
  return nextSegment ? [target, nextSegment].filter(Boolean).join('/') : '';
};
