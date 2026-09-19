type ProjectColumnWidths = { files: number; preview: number; metadata: number };

export type FileListColumnWidths = { name: number; modified: number; type: number; size: number };
export const FILE_LIST_COLUMN_STORAGE_KEYS: Record<keyof FileListColumnWidths, string> = {
  name: 'photoflow:file-list-name-column-width',
  modified: 'photoflow:file-list-modified-column-width',
  type: 'photoflow:file-list-type-column-width',
  size: 'photoflow:file-list-size-column-width',
};
export const FILE_LIST_COLUMNS_CUSTOMIZED_STORAGE_KEY = 'photoflow:file-list-columns-customized-v2';
export type FileListColumnBoundary = 0 | 1 | 2 | 3;

export const FILE_LIST_COLUMN_KEYS = ['name', 'modified', 'type', 'size'] as const;
export const DEFAULT_FILE_LIST_COLUMN_WIDTHS: FileListColumnWidths = { name: 420, modified: 220, type: 170, size: 110 };
export const MIN_FILE_LIST_COLUMN_WIDTHS: FileListColumnWidths = { name: 24, modified: 24, type: 24, size: 24 };
// Three 16px gaps plus 10px inline padding on both sides of each grid row.
export const FILE_LIST_GRID_CHROME_WIDTH = 68;

export const scheduleAfterProjectPaint = (delayMs: number, callback: () => void) => {
  let timer = 0;
  const frame = window.requestAnimationFrame(() => {
    timer = window.setTimeout(callback, delayMs);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
};

export const clampNumber = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export const fitProjectColumnWidths = (preferred: ProjectColumnWidths, containerWidth: number, previewOpen: boolean, metadataOpen: boolean) => {
  const handleCount = Number(previewOpen) + Number(metadataOpen);
  const available = Math.max(0, containerWidth - handleCount);
  const preferredTotal = preferred.files + (previewOpen ? preferred.preview : 0) + (metadataOpen ? preferred.metadata : 0);
  if (!previewOpen && !metadataOpen) return { ...preferred, files: available };
  if (preferredTotal <= 0) return preferred;
  if (available >= preferredTotal) return { ...preferred, files: preferred.files + available - preferredTotal };
  const scale = available / preferredTotal;
  return {
    files: preferred.files * scale,
    preview: previewOpen ? preferred.preview * scale : preferred.preview,
    metadata: metadataOpen ? preferred.metadata * scale : preferred.metadata,
  };
};

export const shouldRetainGroupedResultsDuringRefresh = (previousIdentity: string, nextIdentity: string, resultCount: number) =>
  Boolean(previousIdentity) && previousIdentity === nextIdentity && resultCount > 0;

export const groupedResultsAreInitiallyLoading = (loading: boolean, visibleGroupCount: number) =>
  loading && visibleGroupCount === 0;

export const createDelayedCloseController = (
  close: () => void,
  delayMs = 100,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancelScheduled: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout,
) => {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const cancelClose = () => {
    if (handle === null) return;
    cancelScheduled(handle);
    handle = null;
  };
  const scheduleClose = () => {
    cancelClose();
    handle = schedule(() => { handle = null; close(); }, delayMs);
  };
  return { scheduleClose, cancelClose, dispose: cancelClose };
};

export const positionViewportSubmenu = (
  trigger: { left: number; right: number; top: number },
  submenu: { width: number; height: number },
  viewport: { width: number; height: number; margin?: number },
) => {
  const margin = viewport.margin ?? 8;
  const openLeft = trigger.right + submenu.width + 4 > viewport.width - margin;
  return {
    openLeft,
    left: Math.max(margin, openLeft ? trigger.left - submenu.width - 4 : trigger.right + 4),
    top: Math.max(margin, Math.min(trigger.top, viewport.height - submenu.height - margin)),
  };
};

const LEGACY_SUBMENU_STATE_CLASSES = new Set(['invisible', 'absolute', 'left-full', 'right-full', 'top-0', 'opacity-0', 'opacity-100', 'group-hover/submenu:visible', 'group-hover/submenu:opacity-100']);
export const cleanViewportSubmenuClassName = (className = '') => className.split(/\s+/).filter(token => token && !LEGACY_SUBMENU_STATE_CLASSES.has(token)).join(' ');

export const fitFileListColumnWidths = (preferred: FileListColumnWidths, availableWidth: number): FileListColumnWidths => {
  const normalized = Object.fromEntries(FILE_LIST_COLUMN_KEYS.map(key => {
    const value = Number(preferred[key]);
    return [key, Number.isFinite(value) && value > 0 ? value : DEFAULT_FILE_LIST_COLUMN_WIDTHS[key]];
  })) as FileListColumnWidths;
  const minimumTotal = FILE_LIST_COLUMN_KEYS.reduce((total, key) => total + MIN_FILE_LIST_COLUMN_WIDTHS[key], 0);
  const targetWidth = Math.max(minimumTotal, Number.isFinite(availableWidth) ? availableWidth : minimumTotal);
  const result = {} as FileListColumnWidths;
  let remainingWidth = targetWidth;
  let activeKeys = [...FILE_LIST_COLUMN_KEYS];

  while (activeKeys.length) {
    const activeWeight = activeKeys.reduce((total, key) => total + normalized[key], 0);
    const constrained = activeKeys.filter(key => activeWeight <= 0 || remainingWidth * normalized[key] / activeWeight < MIN_FILE_LIST_COLUMN_WIDTHS[key]);
    if (!constrained.length) {
      for (const key of activeKeys) result[key] = remainingWidth * normalized[key] / activeWeight;
      break;
    }
    for (const key of constrained) {
      result[key] = MIN_FILE_LIST_COLUMN_WIDTHS[key];
      remainingWidth -= result[key];
    }
    activeKeys = activeKeys.filter(key => !constrained.includes(key));
  }
  return result;
};

export const resizeFileListColumnBoundary = (widths: FileListColumnWidths, boundary: FileListColumnBoundary, deltaX: number): FileListColumnWidths => {
  const key = FILE_LIST_COLUMN_KEYS[boundary];
  const safeDelta = Math.max(MIN_FILE_LIST_COLUMN_WIDTHS[key] - widths[key], Number.isFinite(deltaX) ? deltaX : 0);
  return {
    ...widths,
    [key]: widths[key] + safeDelta,
  };
};

export const readStoredNumber = (key: string, fallback: number) => {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

export const readStoredBoolean = (key: string, fallback: boolean) => {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
};
