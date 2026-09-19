import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { WorkspacePanelId } from '../contracts/workspace-panels';

export type WorkspacePanelEntry = { id: WorkspacePanelId; label: string; visible: boolean; pinned: boolean };
type WorkspacePanelController = {
  pageId: string;
  panels: WorkspacePanelEntry[];
  setVisible: (id: WorkspacePanelId, visible: boolean) => void;
  setPinned: (id: WorkspacePanelId, pinned: boolean) => void;
  reset: () => void;
};
// Renderer-local registrations keep the titlebar connected to its active page,
// including the shared file browser used by the inspiration library.
const controllers = new Map<string, WorkspacePanelController>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const usePublishWorkspacePanels = (enabled: boolean, controller: WorkspacePanelController) => {
  const latest = useRef(controller);
  latest.current = controller;
  const stateKey = JSON.stringify(controller.panels);
  const snapshot = useMemo<WorkspacePanelController>(() => ({
    pageId: controller.pageId, panels: controller.panels,
    setVisible: (id, visible) => latest.current.setVisible(id, visible),
    setPinned: (id, pinned) => latest.current.setPinned(id, pinned),
    reset: () => latest.current.reset(),
  }), [controller.pageId, stateKey]);
  useEffect(() => {
    if (!enabled) return;
    controllers.set(snapshot.pageId, snapshot); notify();
    return () => {
      if (controllers.get(snapshot.pageId) === snapshot) { controllers.delete(snapshot.pageId); notify(); }
    };
  }, [enabled, snapshot]);
};

export const useWorkspacePanels = (pageId: string | null) => useSyncExternalStore(subscribe, () => pageId ? controllers.get(pageId) ?? null : null);
