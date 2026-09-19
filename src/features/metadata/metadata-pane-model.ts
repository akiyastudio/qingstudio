import type { MediaMetadataField } from '../../types';

export const EMPTY_MEDIA_METADATA_FIELDS: readonly MediaMetadataField[] = Object.freeze([]);

const groupsFromKey = (groupKey: string): string[] => {
  try {
    const value: unknown = JSON.parse(groupKey);
    return Array.isArray(value) ? value.filter((group): group is string => typeof group === 'string') : [];
  } catch {
    return [];
  }
};

const sameSetContents = (left: ReadonlySet<string>, right: ReadonlySet<string>) => left.size === right.size
  && [...left].every(value => right.has(value));

export const metadataGroupDependencyKey = (fields: readonly MediaMetadataField[]) => JSON.stringify(
  [...new Set(fields.map(field => field.group))].sort((left, right) => left.localeCompare(right)),
);

export const buildDefaultExpandedMetadataGroups = (entryPath: string | undefined, groupKey: string) => {
  return new Set<string>(entryPath ? ['Application', ...groupsFromKey(groupKey)] : []);
};

export const reconcileExpandedMetadataGroups = (
  current: Set<string>,
  entryPath: string | undefined,
  groupKey: string,
) => {
  const target = buildDefaultExpandedMetadataGroups(entryPath, groupKey);
  return sameSetContents(current, target) ? current : target;
};

export const previewMetadataFieldsForEntry = (
  fields: readonly MediaMetadataField[],
  resolvedPath: string,
  entryPath: string | undefined,
) => entryPath && resolvedPath === entryPath ? fields : EMPTY_MEDIA_METADATA_FIELDS;
