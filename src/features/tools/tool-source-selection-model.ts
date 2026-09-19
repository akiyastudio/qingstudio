import type { ProjectToolSource } from '../../types';

const sourcePathIdentity = (value: string) => {
  const trimmed = value.trim();
  const cleaned = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') : trimmed;
  return /^[a-z]:([\\/]|$)/i.test(cleaned) || /^[/\\]{2}[^/\\]+[/\\]+[^/\\]+/.test(cleaned)
    ? cleaned.replace(/\//g, '\\').toLocaleLowerCase()
    : cleaned.replace(/\/{2,}/g, '/');
};

const normalizedPath = (value: string) => sourcePathIdentity(value).replace(/\\/g, '/');

const pathIsInside = (candidate: string, folder: string) => {
  const normalizedCandidate = normalizedPath(candidate);
  const normalizedFolder = normalizedPath(folder);
  if (normalizedFolder === '/') return normalizedCandidate.startsWith('/');
  return normalizedCandidate === normalizedFolder || normalizedCandidate.startsWith(`${normalizedFolder}/`);
};

export const resolveInspectedToolSources = (
  sources: readonly ProjectToolSource[] | undefined,
  folderPaths: readonly string[] = [],
  discoveredFilePaths: readonly string[] = [],
): ProjectToolSource[] => {
  if (sources?.length) return sources.map(source => ({ ...source }));
  const folderIdentities = new Set<string>();
  const folders = folderPaths.filter(Boolean).filter(path => {
    const identity = sourcePathIdentity(path);
    if (folderIdentities.has(identity)) return false;
    folderIdentities.add(identity);
    return true;
  });
  const directFiles = discoveredFilePaths.filter(candidate => !folders.some(folder => pathIsInside(candidate, folder)));
  return [
    ...folders.map(path => ({ path, kind: 'folder' as const })),
    ...directFiles.filter((path, index) => directFiles.findIndex(candidate => sourcePathIdentity(candidate) === sourcePathIdentity(path)) === index).map(path => ({ path, kind: 'file' as const })),
  ];
};
