import type { MainBranchMediaEntry, MediaVersion } from '../../types';

type MainBranchMediaLike = Omit<MainBranchMediaEntry, 'nodeRole' | 'relationKind'> & { nodeRole: string; relationKind?: string };

export const MAIN_BRANCH_PHOTO_PAGE_SIZE = 48;

export const mainBranchVersionsForPhoto = (entries: readonly MainBranchMediaLike[], photoId: string): MediaVersion[] => entries
  .filter(entry => entry.photoId === photoId
    && (entry.nodeRole === 'original' || entry.nodeRole === 'progress')
    && entry.relationKind !== 'auxiliary')
  .sort((left, right) => left.branchIndex - right.branchIndex
    || left.version.createdAt - right.version.createdAt
    || left.version.id.localeCompare(right.version.id))
  .map(entry => entry.version);

export type MainBranchPhotoSummary = {
  photoId: string;
  originalName: string;
  firstBranchIndex: number;
  versionCount: number;
  missing: boolean;
  previewVersion?: MediaVersion;
};

export const mainBranchPhotoSummaries = (entries: readonly MainBranchMediaLike[]): MainBranchPhotoSummary[] => {
  const grouped = new Map<string, MainBranchMediaLike[]>();
  entries.forEach(entry => {
    if ((entry.nodeRole !== 'original' && entry.nodeRole !== 'progress') || entry.relationKind === 'auxiliary') return;
    const current = grouped.get(entry.photoId) || [];
    current.push(entry);
    grouped.set(entry.photoId, current);
  });
  return [...grouped.entries()].map(([photoId, versions]) => {
    versions.sort((left, right) => left.branchIndex - right.branchIndex || left.version.createdAt - right.version.createdAt);
    const previewEntry = [...versions].reverse().find(entry => !entry.version.fileMissing) || versions.at(-1);
    return {
      photoId,
      originalName: versions[0]?.originalName || photoId,
      firstBranchIndex: Math.min(...versions.map(entry => entry.branchIndex)),
      versionCount: versions.length,
      missing: versions.every(entry => entry.version.fileMissing),
      previewVersion: previewEntry?.version,
    };
  }).sort((left, right) => Number(right.versionCount > 1) - Number(left.versionCount > 1)
    || left.firstBranchIndex - right.firstBranchIndex
    || left.originalName.localeCompare(right.originalName, 'zh-CN')
    || left.photoId.localeCompare(right.photoId));
};

export const paginateMainBranchPhotos = (photos: readonly MainBranchPhotoSummary[], page: number, pageSize = MAIN_BRANCH_PHOTO_PAGE_SIZE) => {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(photos.length / safePageSize));
  const currentPage = Math.max(0, Math.min(pageCount - 1, Math.floor(page)));
  return {
    items: photos.slice(currentPage * safePageSize, (currentPage + 1) * safePageSize),
    currentPage,
    pageCount,
    total: photos.length,
  };
};
