import type { ProjectFileEntry } from '../../types';

export const projectFileQueryRequestIdentity = (parts: readonly unknown[]) => parts.map(value => String(value ?? '')).join('\0');

export const mergeProjectFileQueryEntries = (
  current: readonly ProjectFileEntry[],
  incoming: readonly ProjectFileEntry[],
  sessionRecreated: boolean,
) => {
  if (sessionRecreated) return [...incoming];
  const existing = new Set(current.map(entry => entry.path.toLocaleLowerCase()));
  return [...current, ...incoming.filter(entry => !existing.has(entry.path.toLocaleLowerCase()))];
};
