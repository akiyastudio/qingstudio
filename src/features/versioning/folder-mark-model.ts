import type { ProgressFolder } from '../../types';
import type { VersionProgressDraft } from './VersionProgressPanel';
import { defaultMainParentId, nextVersionKeys, selectableVersionParents } from './versioning-v2-model';

export type FolderMarkPurpose = 'original' | 'progress' | 'broll';
export type FolderMarkMediaKind = 'image' | 'video';

export const defaultFolderMarkPurpose = (relativePath: string, hasRawFiles: boolean): FolderMarkPurpose => {
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return normalizedPath && !normalizedPath.includes('/') && hasRawFiles ? 'original' : 'progress';
};

export type FolderMarkCommon = {
  relativePath: string;
  folderName: string;
};

export type FolderMarkDraft =
  | (FolderMarkCommon & {
    purpose: 'original';
    mediaKind: FolderMarkMediaKind;
  })
  | (FolderMarkCommon & {
    purpose: 'progress';
    progress: VersionProgressDraft;
  })
  | (FolderMarkCommon & {
    purpose: 'broll';
  });

export const cleanFolderMarkCommon = (draft: FolderMarkCommon): FolderMarkCommon => ({
  relativePath: draft.relativePath,
  folderName: draft.folderName,
});

const currentMediaKind = (draft: FolderMarkDraft): FolderMarkMediaKind => draft.purpose === 'original'
  ? draft.mediaKind
  : draft.purpose === 'progress'
    ? draft.progress.mediaKind
    : 'image';

const createProgressDraft = (
  common: FolderMarkCommon,
  folders: ProgressFolder[],
  mediaKind: FolderMarkMediaKind,
): VersionProgressDraft => {
  const parents = selectableVersionParents(folders, { mediaKind, relationKind: 'main' });
  const semanticParentId = defaultMainParentId(folders, [], mediaKind);
  const parent = parents.find(folder => folder.id === semanticParentId);
  return {
    // This panel always marks an existing folder. `create-next` keeps the
    // existing-target move preflight without locking media type or parent.
    mode: 'create-next',
    sourceRelativePath: common.relativePath,
    displayName: common.folderName,
    mediaKind,
    relationKind: 'main',
    parentProgressId: parent?.id || '',
    versionKey: parent ? nextVersionKeys(folders, mediaKind, parent).main : '',
    versionKind: 'main',
    trackingEnabled: false,
    renameFromParent: false,
    copyMissingFromParent: false,
    workflowInputProgressIds: [],
    targetFolderLocked: true,
  };
};

export const createFolderMarkDraft = (
  common: FolderMarkCommon,
  purpose: FolderMarkPurpose = 'original',
  folders: ProgressFolder[] = [],
  mediaKind: FolderMarkMediaKind = 'image',
): FolderMarkDraft => {
  const normalizedCommon = cleanFolderMarkCommon(common);
  if (purpose === 'broll') return { ...normalizedCommon, purpose: 'broll' };
  if (purpose === 'progress') return {
    ...normalizedCommon,
    purpose: 'progress',
    progress: createProgressDraft(normalizedCommon, folders, mediaKind),
  };
  return { ...normalizedCommon, purpose: 'original', mediaKind };
};

export const switchFolderMarkPurpose = (
  draft: FolderMarkDraft,
  purpose: FolderMarkPurpose,
  folders: ProgressFolder[],
  preferredMediaKind: FolderMarkMediaKind = currentMediaKind(draft),
): FolderMarkDraft => createFolderMarkDraft(cleanFolderMarkCommon(draft), purpose, folders, preferredMediaKind);
