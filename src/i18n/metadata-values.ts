import { getLocale, t } from './runtime';
import type { MultiSelectionSummary } from '../features/workspace/multi-selection-metadata-model';
const TYPE_KEYS = [['folder', 'metadata.kind.folder'], ['image', 'metadata.kind.image'], ['raw', 'metadata.kind.raw'], ['video', 'metadata.kind.video'], ['file', 'metadata.kind.file'], ['shortcut', 'metadata.kind.shortcut']] as const;
export const selectionTypeLabel = (summary: MultiSelectionSummary) => {
  const parts = TYPE_KEYS.flatMap(([kind, key]) => { const count = summary.selectedKindCounts[kind] ?? 0; return count ? [t(key, { count })] : []; });
  return parts.length ? new Intl.ListFormat(getLocale(), { style: 'short', type: 'unit' }).format(parts) : '—';
};
export const selectionFormatLabel = (summary: MultiSelectionSummary) => {
  if (!summary.selectedFormats.length) return '—';
  const formats = new Intl.ListFormat(getLocale(), { style: 'short', type: 'unit' }).format(summary.selectedFormats.slice(0, 4));
  return summary.selectedFormats.length > 4 ? t('metadata.formatsMore', { formats, count: summary.selectedFormats.length }) : formats;
};
export const shutterSpeedLabel = (value: string | undefined) => {
  const match = value && /^((?:1\/)?\d+(?:\.\d+)?) 秒$/.exec(value);
  return match ? t('metadata.shutterSeconds', { value: match[1] }) : value;
};
