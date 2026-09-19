export const MIN_SUBTITLE_FONT_SIZE = 16;
export const MAX_SUBTITLE_FONT_SIZE = 120;
export const DEFAULT_SUBTITLE_FONT_SIZE = 55;
export const LEGACY_LARGE_SUBTITLE_FONT_SIZE = 74;

export const normalizeSubtitleFontSize = (value: unknown) => {
  if (value === null || value === '' || typeof value === 'boolean') return DEFAULT_SUBTITLE_FONT_SIZE;
  const migrated = value === 'large'
    ? LEGACY_LARGE_SUBTITLE_FONT_SIZE
    : value === 'default'
      ? DEFAULT_SUBTITLE_FONT_SIZE
      : Number(value);
  if (!Number.isFinite(migrated)) return DEFAULT_SUBTITLE_FONT_SIZE;
  return Math.max(MIN_SUBTITLE_FONT_SIZE, Math.min(MAX_SUBTITLE_FONT_SIZE, Math.round(migrated)));
};
