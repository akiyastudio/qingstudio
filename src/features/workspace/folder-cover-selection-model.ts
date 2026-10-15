import type { ProjectFileEntry } from '../../types';

export type DirectoryPreviewLoadResult = { entries: ProjectFileEntry[]; authoritative: boolean };
export type FolderCoverSelection = DirectoryPreviewLoadResult & { collage: boolean };

const isPhoto = (entry: ProjectFileEntry) => entry.kind === 'image' || entry.kind === 'raw';
const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase('zh-CN');

/** Read only as far as needed, taking one photo from each child branch per round. */
export const loadFolderCoverSelection = async (
  entry: ProjectFileEntry,
  loadEntries: (entry: ProjectFileEntry) => Promise<DirectoryPreviewLoadResult>,
  isActive: () => boolean = () => true,
  pendingRename = false,
): Promise<FolderCoverSelection> => {
  let authoritative = true;
  const read = async (directory: ProjectFileEntry) => {
    try {
      const result = await loadEntries(directory);
      authoritative &&= result.authoritative;
      return result.entries;
    } catch {
      authoritative = false;
      return [];
    }
  };
  const children = await read(entry);
  const directPhoto = children.find(isPhoto);
  if (directPhoto) return { entries: [directPhoto], collage: false, authoritative };
  // Optimistic paths cannot be browsed until the filesystem rename commits.
  if (!isActive() || pendingRename || !authoritative) return { entries: [], collage: false, authoritative: false };

  const visitedDirectories = new Set([pathKey(entry.path)]);
  const selectedPaths = new Set<string>();
  async function* photosInBranch(directory: ProjectFileEntry) {
    const queue = [directory];
    for (let index = 0; index < queue.length && isActive(); index += 1) {
      const current = queue[index];
      const key = pathKey(current.path);
      if (visitedDirectories.has(key)) continue;
      visitedDirectories.add(key);
      const entries = await read(current);
      for (const photo of entries) {
        if (!isActive()) return;
        if (!isPhoto(photo) || selectedPaths.has(pathKey(photo.path))) continue;
        selectedPaths.add(pathKey(photo.path));
        yield photo;
      }
      // Ordinary folders only: following shortcuts here could escape the branch or loop.
      for (const child of entries) if (child.kind === 'folder') queue.push(child);
    }
  }

  let branches = children.filter(child => child.kind === 'folder').map(photosInBranch);
  const photos: ProjectFileEntry[] = [];
  while (branches.length && photos.length < 4 && isActive()) {
    const remaining: typeof branches = [];
    for (const branch of branches) {
      if (!isActive()) break;
      const next = await branch.next();
      if (next.done) continue;
      photos.push(next.value);
      remaining.push(branch);
      if (photos.length === 4) break;
    }
    branches = remaining;
  }
  if (photos.length) return { entries: photos, collage: true, authoritative };
  // Retain the existing video/ordinary-file cover when no descendant photos exist.
  const fallback = children.find(child => child.kind === 'video') || children.find(child => child.kind !== 'folder');
  return { entries: fallback ? [fallback] : [], collage: false, authoritative };
};
