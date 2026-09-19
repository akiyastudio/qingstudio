import type { ProjectFileEntry } from '../../types';

export type SelectionEntryDetails = {
  size: number;
  createdAt: number;
  updatedAt: number;
  fileCount: number;
  folderCount: number;
};

export type MultiSelectionSummary = {
  selectedCount: number;
  selectedFileCount: number;
  selectedFolderCount: number;
  containedFileCount: number;
  containedFolderCount: number;
  totalSize: number;
  sizeComplete: boolean;
  typeSummary: string;
  formatSummary: string;
  commonParentPath: string;
  earliestCreatedAt?: number;
  latestCreatedAt?: number;
  earliestUpdatedAt?: number;
  latestUpdatedAt?: number;
};

const isFolderLike = (entry: ProjectFileEntry) => entry.kind === 'folder';

const TYPE_LABELS: ReadonlyArray<[ProjectFileEntry['kind'], string]> = [
  ['image', '图片'],
  ['raw', 'RAW 图片'],
  ['video', '视频'],
  ['file', '文件'],
  ['shortcut', '快捷方式'],
];

const normalizedParentSegments = (relativePath: string) => relativePath
  .replace(/\\/g, '/')
  .replace(/^\/+|\/+$/g, '')
  .split('/')
  .filter(Boolean)
  .slice(0, -1);

const commonParentPath = (entries: readonly ProjectFileEntry[]) => {
  if (!entries.length) return '';
  const parents = entries.map(entry => normalizedParentSegments(entry.relativePath));
  const shared = [...parents[0]];
  while (shared.length && parents.some(parts => parts.slice(0, shared.length).join('/') !== shared.join('/'))) shared.pop();
  return shared.join('/');
};

const finitePositiveRange = (values: number[]) => {
  const valid = values.filter(value => Number.isFinite(value) && value > 0);
  return valid.length ? { earliest: Math.min(...valid), latest: Math.max(...valid) } : {};
};

const summarizeTypes = (entries: readonly ProjectFileEntry[]) => {
  const folders = entries.filter(isFolderLike).length;
  const counts = new Map<ProjectFileEntry['kind'], number>();
  for (const entry of entries) {
    if (isFolderLike(entry)) continue;
    counts.set(entry.kind, (counts.get(entry.kind) || 0) + 1);
  }
  const parts = [
    ...(folders ? [`${folders} 个文件夹`] : []),
    ...TYPE_LABELS.flatMap(([kind, label]) => counts.get(kind) ? [`${counts.get(kind)} 个${label}`] : []),
  ];
  return parts.join('，');
};

const summarizeFormats = (entries: readonly ProjectFileEntry[]) => {
  const formats = [...new Set(entries
    .filter(entry => !isFolderLike(entry))
    .map(entry => entry.extension.replace(/^\./, '').toLocaleUpperCase())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  if (!formats.length) return '—';
  if (formats.length <= 4) return formats.join('、');
  return `${formats.slice(0, 4).join('、')} 等 ${formats.length} 种`;
};

export const summarizeMultiSelection = (
  entries: readonly ProjectFileEntry[],
  detailsByPath: Readonly<Record<string, SelectionEntryDetails | undefined>> = {},
): MultiSelectionSummary => {
  let totalSize = 0;
  let sizeComplete = true;
  let containedFileCount = 0;
  let containedFolderCount = 0;
  let selectedFolderCount = 0;

  for (const entry of entries) {
    const details = detailsByPath[entry.path];
    if (isFolderLike(entry)) {
      selectedFolderCount += 1;
      if (!details) sizeComplete = false;
      else {
        totalSize += Math.max(0, details.size);
        containedFileCount += Math.max(0, details.fileCount);
        containedFolderCount += Math.max(0, details.folderCount);
      }
      continue;
    }
    if (details) totalSize += Math.max(0, details.size);
    else if (entry.size >= 0) totalSize += entry.size;
    else sizeComplete = false;
    containedFileCount += 1;
  }

  const createdRange = finitePositiveRange(entries.map(entry => detailsByPath[entry.path]?.createdAt || entry.createdAt));
  const updatedRange = finitePositiveRange(entries.map(entry => detailsByPath[entry.path]?.updatedAt || entry.updatedAt));
  return {
    selectedCount: entries.length,
    selectedFileCount: entries.length - selectedFolderCount,
    selectedFolderCount,
    containedFileCount,
    containedFolderCount,
    totalSize,
    sizeComplete,
    typeSummary: summarizeTypes(entries),
    formatSummary: summarizeFormats(entries),
    commonParentPath: commonParentPath(entries),
    earliestCreatedAt: createdRange.earliest,
    latestCreatedAt: createdRange.latest,
    earliestUpdatedAt: updatedRange.earliest,
    latestUpdatedAt: updatedRange.latest,
  };
};
