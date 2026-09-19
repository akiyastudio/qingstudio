import { useEffect, useState, type RefObject } from 'react';
import { usePageState } from '../../platform/page-transfer-state';
import { normalizePanelOrder, PANEL_LAYOUT_CHANGED_EVENT } from './workspace-panel-model';
import { WORKSPACE_PANEL_IDS, type WorkspacePanelId } from '../../contracts/workspace-panels';

const readLayout = (key: string): { order?: unknown; filesOpen?: boolean; filesPinned?: boolean } => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
};
export const readWorkspacePanelWidths = (kind: string): Partial<Record<WorkspacePanelId, number>> => {
  try { const value = JSON.parse(localStorage.getItem(`photoflow:${kind}:panel-widths`) || '{}'); return Object.fromEntries(Object.entries(value).filter(([key, size]) => /^component:[a-z0-9._-]+:[a-z0-9._-]+$/i.test(key) && typeof size === 'number' && Number.isFinite(size) && size >= 0).map(([key, size]) => [key, Number(size)])); } catch { return {}; }
};
export const usePersistWorkspacePanelWidths = (kind: string, widths: Partial<Record<WorkspacePanelId, number>>) => {
  useEffect(() => { try { localStorage.setItem(`photoflow:${kind}:panel-widths`, JSON.stringify(widths)); } catch { /* Storage is optional. */ } }, [kind, widths]);
};

export const useWorkspacePanelLayout = (pageId: string, kind: string, available: readonly WorkspacePanelId[] = WORKSPACE_PANEL_IDS) => {
  const key = `photoflow:${kind}:panel-layout-v1`;
  const [panelOrder, setPanelOrder] = usePageState<WorkspacePanelId[]>(pageId, 'panelOrder', () => {
    const saved = readLayout(key).order;
    const savedPluginIds: WorkspacePanelId[] = Array.isArray(saved) ? saved.filter(id => typeof id === 'string' && /^component:[a-z0-9._-]+:[a-z0-9._-]+$/i.test(id)).slice(0, 64) : [];
    return normalizePanelOrder(saved, [...new Set([...available, ...savedPluginIds])]);
  });
  const [filesPaneOpen, setFilesPaneOpen] = usePageState(pageId, 'filesPaneOpen', () => readLayout(key).filesOpen !== false);
  const [filesPanePinned, setFilesPanePinned] = usePageState(pageId, 'filesPanePinned', () => readLayout(key).filesPinned !== false);
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify({ order: panelOrder, filesOpen: filesPaneOpen, filesPinned: filesPanePinned })); } catch { /* Local storage may be unavailable. */ }
  }, [key, panelOrder, filesPaneOpen, filesPanePinned]);
  return { panelOrder: normalizePanelOrder(panelOrder, available), setPanelOrder, filesPaneOpen, setFilesPaneOpen, filesPanePinned, setFilesPanePinned };
};

export const useFilePanelStatusRight = (filesRef: RefObject<HTMLDivElement>) => {
  const [right, setRight] = useState(12);
  useEffect(() => {
    const files = filesRef.current;
    if (!files) return;
    const measure = () => setRight(Math.max(12, window.innerWidth - files.getBoundingClientRect().right + 12));
    const observer = new ResizeObserver(measure);
    observer.observe(files);
    window.addEventListener('resize', measure);
    window.addEventListener(PANEL_LAYOUT_CHANGED_EVENT, measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener(PANEL_LAYOUT_CHANGED_EVENT, measure);
    };
  }, [filesRef]);
  return right;
};
