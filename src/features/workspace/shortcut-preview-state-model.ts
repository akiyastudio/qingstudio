import type { ProjectFileEntry } from '../../types';

export type ShortcutPreviewState = Pick<ProjectFileEntry, 'shortcutTargetKind' | 'shortcutBroken'>;

export const applyShortcutPreviewState = (
  entries: ProjectFileEntry[],
  shortcutPath: string,
  shortcutUpdatedAt: number,
  state: ShortcutPreviewState,
) => {
  const normalizedPath = shortcutPath.toLocaleLowerCase();
  let changed = false;
  const next = entries.map(entry => {
    const samePath = entry.path.toLocaleLowerCase() === normalizedPath;
    const sameRevision = !entry.updatedAt || !shortcutUpdatedAt || entry.updatedAt === shortcutUpdatedAt;
    if (!samePath || !sameRevision) return entry;
    if (entry.shortcutTargetKind === state.shortcutTargetKind && entry.shortcutBroken === state.shortcutBroken) return entry;
    changed = true;
    return { ...entry, ...state };
  });
  return changed ? next : entries;
};
