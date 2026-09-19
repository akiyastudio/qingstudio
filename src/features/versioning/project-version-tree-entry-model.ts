import type { ProgressFolder, ProjectFileEntry } from '../../types';

export type ResolvedVersionTreeEntryItem = { folder: ProgressFolder; entry: ProjectFileEntry };
type RenameAwareProjectFileEntry = ProjectFileEntry & { pendingSourceRelativePath?: string };

export const versionTreeReactKey = (item: {
  key: string;
  nodeKey: string;
  folder?: Pick<ProgressFolder, 'folderId'>;
}) => item.folder
  // A rename keeps both the graph node and physical folder identity stable,
  // so its mounted cover can survive the path transition.
  ? `${item.nodeKey}:folder:${item.folder.folderId || 'unknown'}`
  : item.key;

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('zh-CN');
const parentPath = (value: string) => normalizePath(value).split('/').slice(0, -1).join('/');
export const resolveVersionTreeEntryMapping = ({
  folders,
  entries,
  structureEntries,
  scopePath,
  projectRelativePath,
}: {
  folders: ProgressFolder[];
  entries: ProjectFileEntry[];
  structureEntries: ProjectFileEntry[];
  scopePath: string;
  projectRelativePath: (absolutePath: string) => string;
}) => {
  const normalizedScopePath = normalizePath(scopePath);
  const liveEntries = entries as RenameAwareProjectFileEntry[];
  const liveEntryByPath = new Map(liveEntries.map(entry => [normalizePath(entry.relativePath), entry]));
  const liveEntryBySourceAlias = new Map(liveEntries
    .filter(entry => Boolean(entry.pendingSourceRelativePath))
    .map(entry => [normalizePath(entry.pendingSourceRelativePath!), entry]));
  const structureEntryByPath = new Map(structureEntries.map(entry => [normalizePath(entry.relativePath), entry]));
  const versionItems: ResolvedVersionTreeEntryItem[] = folders.flatMap(folder => {
    const stableRelativePath = normalizePath(projectRelativePath(folder.folderPath));
    const livePathEntry = liveEntryByPath.get(stableRelativePath);
    const sourceAliasEntry = liveEntryBySourceAlias.get(stableRelativePath);
    const structurePathEntry = structureEntryByPath.get(stableRelativePath);
    const foundEntry = sourceAliasEntry || livePathEntry || structurePathEntry;
    const entry: ProjectFileEntry | undefined = foundEntry || folder.folderMissing ? foundEntry || {
      kind: 'folder', name: folder.displayName, path: folder.folderPath, relativePath: stableRelativePath, extension: '', size: 0, createdAt: folder.createdAt, updatedAt: folder.updatedAt,
    } : undefined;
    return entry && parentPath(stableRelativePath) === normalizedScopePath ? [{ folder, entry }] : [];
  });
  const trackedEntryPaths = new Set(versionItems.map(item => normalizePath(item.entry.relativePath)));
  const ordinaryEntries = entries.filter(entry => !trackedEntryPaths.has(normalizePath(entry.relativePath)));
  return { versionItems, trackedEntryPaths, ordinaryEntries };
};
