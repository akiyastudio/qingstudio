import { WORKSPACE_PANEL_IDS, type WorkspacePanelId } from '../../contracts/workspace-panels';
export { WORKSPACE_PANEL_IDS, PANEL_LAYOUT_CHANGED_EVENT, type WorkspacePanelId } from '../../contracts/workspace-panels';
export type WorkspacePanelWidths = Record<WorkspacePanelId, number>;
export const WORKSPACE_PANEL_LABELS: Record<WorkspacePanelId, string> = { files: '文件夹', preview: '预览', metadata: '详细信息' };
export const DEFAULT_PANEL_WIDTHS: WorkspacePanelWidths = { files: 560, preview: 340, metadata: 320 };

export const normalizePanelOrder = (value: unknown, available: readonly WorkspacePanelId[] = WORKSPACE_PANEL_IDS): WorkspacePanelId[] => {
  const known = Array.isArray(value) ? value.filter((id): id is WorkspacePanelId => available.includes(id)) : [];
  return [...new Set([...known, ...available])];
};

export const movePanelBefore = (order: readonly WorkspacePanelId[], source: WorkspacePanelId, before: WorkspacePanelId | null) => {
  const normalized = normalizePanelOrder(order, [...new Set([...WORKSPACE_PANEL_IDS, ...order])]);
  if (source === before) return normalized;
  const next = normalized.filter(id => id !== source);
  const index = before === null ? next.length : next.indexOf(before);
  next.splice(index < 0 ? next.length : index, 0, source);
  return next;
};

export const fitPanelWidths = (preferred: WorkspacePanelWidths, containerWidth: number, visible: readonly WorkspacePanelId[]): WorkspacePanelWidths => {
  const result = { ...DEFAULT_PANEL_WIDTHS };
  for (const id of new Set<WorkspacePanelId>([...WORKSPACE_PANEL_IDS, ...visible, ...Object.keys(preferred) as WorkspacePanelId[]])) result[id] = Number.isFinite(preferred[id]) && preferred[id] >= 0 ? preferred[id] : DEFAULT_PANEL_WIDTHS[id] ?? 340;
  const available = Math.max(0, (Number.isFinite(containerWidth) ? containerWidth : 0) - Math.max(0, visible.length - 1));
  const total = visible.reduce((sum, id) => sum + result[id], 0);
  if (!visible.length) return result;
  if (!total) {
    for (const id of visible) result[id] = available / visible.length;
  } else if (available < total) {
    for (const id of visible) result[id] *= available / total;
  } else {
    const expanding = visible.includes('files') ? 'files' : visible[0];
    result[expanding] += available - total;
  }
  return result;
};

export const resizePanelBoundary = (widths: WorkspacePanelWidths, left: WorkspacePanelId, right: WorkspacePanelId, delta: number): WorkspacePanelWidths => {
  if (left === right || !Number.isFinite(delta)) return widths;
  const total = widths[left] + widths[right];
  const minimum: Record<WorkspacePanelId, number> = { files: 0, preview: 180, metadata: 160, [left]: left === 'files' ? 0 : left === 'metadata' ? 160 : 180, [right]: right === 'files' ? 0 : right === 'metadata' ? 160 : 180 };
  const scale = Math.min(1, total / Math.max(1, minimum[left] + minimum[right]));
  const leftWidth = Math.max(minimum[left] * scale, Math.min(widths[left] + delta, total - minimum[right] * scale));
  return { ...widths, [left]: leftWidth, [right]: total - leftWidth };
};

export type PanelDropRect = { id: WorkspacePanelId; left: number; right: number };
export const panelDropBefore = (rects: readonly PanelDropRect[], source: WorkspacePanelId, x: number) =>
  rects.find(rect => rect.id !== source && x < (rect.left + rect.right) / 2)?.id ?? null;
