export type ProjectFileFilter = 'all' | 'media' | 'image' | 'video';
export type ProjectRatingFilter = 'all' | 'rated' | '1' | '2' | '3' | '4' | '5';
export const PROJECT_FILE_FILTER_OPTIONS: ReadonlyArray<{ value: ProjectFileFilter; label: string }> = [
  { value: 'all', label: '全部文件' },
  { value: 'media', label: '媒体文件' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
];
export const PROJECT_BINARY_RATING_FILTER_OPTIONS: ReadonlyArray<{ value: ProjectRatingFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'rated', label: '仅看喜爱' },
];
export const PROJECT_STAR_RATING_FILTER_OPTIONS: ReadonlyArray<{ value: ProjectRatingFilter; label: string }> = [
  { value: 'all', label: '全部评分' },
  { value: 'rated', label: '有星媒体' },
  { value: '1', label: '1 星' },
  { value: '2', label: '2 星' },
  { value: '3', label: '3 星' },
  { value: '4', label: '4 星' },
  { value: '5', label: '5 星' },
];
