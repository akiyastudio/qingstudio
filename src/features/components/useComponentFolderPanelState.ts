import { useEffect } from 'react';
import { usePageState } from '../../platform/page-transfer-state';
import { componentWorkspacePanelId, type ComponentWorkspacePanelId } from '../../contracts/workspace-panels';
import type { ComponentContribution } from '../../types';
import type { PanelControl } from '../workspace/useWorkspacePanelControls';
import { componentPanelTaskKind } from '../background-tasks/panel-task-session-model';

export const useComponentFolderPanelState = (pageId: string, kind: string, contributions: ComponentContribution[], active = true) => {
  const key = `photoflow:${kind}:component-panel-preferences`;
  const [preferences, setPreferences] = usePageState<Record<string, { open: boolean; pinned: boolean }>>(pageId, 'componentPanelPreferences', () => {
    try { const stored = JSON.parse(localStorage.getItem(key) || '{}'); return Object.fromEntries(Object.entries(stored).filter(([id]) => /^component:[a-z0-9._-]+:[a-z0-9._-]+$/i.test(id)).map(([id, value]) => [id, { open: (value as { open?: boolean })?.open !== false, pinned: (value as { pinned?: boolean })?.pinned === true }])); } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(preferences)); } catch { /* Storage is optional. */ } }, [key, preferences]);
  const panels = contributions.filter(item => item.type === 'component.sidePanel' && item.placement === 'workspace.folderPanel');
  const panelKey = panels.map(item => `${item.componentId}:${item.contributionId}`).join('|');
  useEffect(() => {
    if (!active) return;
    const requestOpen = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const item = event.type === 'photoflow:restore-panel-task'
        ? detail?.ownerPageId === pageId && panels.find(panel => componentPanelTaskKind(panel.componentId, panel.contributionId) === detail.panelKind)
        : detail?.scope?.sourcePageId === pageId && panels.find(panel => panel.componentId === detail.contribution?.componentId && panel.contributionId === detail.contribution?.contributionId);
      if (!item) return;
      const id = componentWorkspacePanelId(item.componentId, item.contributionId);
      setPreferences(current => ({ ...current, [id]: { ...(current[id] || { pinned: false }), open: true } }));
    };
    window.addEventListener('photoflow:open-component-contribution', requestOpen); window.addEventListener('photoflow:restore-panel-task', requestOpen);
    return () => { window.removeEventListener('photoflow:open-component-contribution', requestOpen); window.removeEventListener('photoflow:restore-panel-task', requestOpen); };
  }, [active, pageId, panelKey]);
  const controls: Partial<Record<ComponentWorkspacePanelId, PanelControl>> = {};
  for (const item of panels) {
    const id = componentWorkspacePanelId(item.componentId, item.contributionId); const value = preferences[id] || { open: true, pinned: false };
    controls[id] = { ...value, label: item.label,
      setOpen: open => setPreferences(current => ({ ...current, [id]: { ...(current[id] || { pinned: false }), open, ...(!open ? { pinned: false } : {}) } })),
      setPinned: pinned => setPreferences(current => ({ ...current, [id]: { ...(current[id] || { open: true }), pinned, ...(pinned ? { open: true } : {}) } })),
    };
  }
  return { panels, controls, ids: panels.map(item => componentWorkspacePanelId(item.componentId, item.contributionId)) };
};
