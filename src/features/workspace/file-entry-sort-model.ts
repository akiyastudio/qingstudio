import type { ProjectFileEntry, ProjectFileSortField } from '../../types';

const naturalFileNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const lexicalFileNameCollator = new Intl.Collator('zh-CN', { numeric: false, sensitivity: 'base' });
const contentHashPrefixPattern = /^[0-9a-f]{16,}(?=[_.-]|$)/i;

export const defaultProjectFileSortDirection = (field: ProjectFileSortField): 'asc' | 'desc' => field === 'name' ? 'asc' : 'desc';

export const isFolderLikeEntry = (entry: ProjectFileEntry) => entry.kind === 'folder';

export const compareProjectFileNames = (left: string, right: string) => {
  const leftHash = contentHashPrefixPattern.test(left);
  const rightHash = contentHashPrefixPattern.test(right);
  if (leftHash !== rightHash) return leftHash ? 1 : -1;
  const result = (leftHash ? lexicalFileNameCollator : naturalFileNameCollator).compare(left, right);
  return result || left.localeCompare(right);
};

export const sortProjectFileEntries = (
  entries: readonly ProjectFileEntry[],
  field: ProjectFileSortField,
  direction: 'asc' | 'desc',
) => {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...entries].sort((left, right) => {
    if (isFolderLikeEntry(left) && !isFolderLikeEntry(right)) return -1;
    if (!isFolderLikeEntry(left) && isFolderLikeEntry(right)) return 1;

    const nameComparison = compareProjectFileNames(left.name, right.name);
    if (field === 'name') return nameComparison * multiplier;

    const fieldComparison = field === 'date'
      ? left.updatedAt - right.updatedAt
      : left.size - right.size;
    return fieldComparison === 0 ? nameComparison : fieldComparison * multiplier;
  });
};
