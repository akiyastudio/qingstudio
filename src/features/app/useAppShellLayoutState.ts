import { useEffect, useState } from 'react';
import type { WorkspaceWindowContext } from '../../contracts/workspace-windows';
import { BACKGROUND_TASK_DRAWER_STORAGE_KEY } from './app-shell-layout-model';

export const useSidebarToggleShortcut = (toggleSidebar: () => void) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing
        || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable
        || target.closest('input, textarea, select, [role="textbox"]'))) return;
      if (document.querySelector('[aria-modal="true"], dialog[open]')) return;
      event.preventDefault();
      if (!event.repeat) toggleSidebar();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);
};

export const useSidebarWidthPersistence = (sidebarWidth: number) => {
  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-width', String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);
};

export const useBackgroundTaskDrawerWidthPersistence = (backgroundTaskDrawerWidth: number) => {
  useEffect(() => {
    window.localStorage.setItem(BACKGROUND_TASK_DRAWER_STORAGE_KEY, String(Math.round(backgroundTaskDrawerWidth)));
  }, [backgroundTaskDrawerWidth]);
};

export const useSidebarCollapsedPersistence = (sidebarCollapsed: boolean) => {
  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);
};

export const useWindowSidebarState = (context: WorkspaceWindowContext | null) => {
  const [mainCollapsed, setMainCollapsed] = useState(() => window.localStorage.getItem('photoflow:sidebar-collapsed') === 'true');
  const [detachedSidebar, setDetachedSidebar] = useState<{ windowId: number; collapsed: boolean } | null>(null);
  // The pinned home tab identifies the primary window, including when one of
  // its content tabs is active. Detached layout must not change its preference.
  const detached = Boolean(context && (context.sharedTabs ? !context.root : !context.tabs.some(tab => tab.pinned)));
  useSidebarCollapsedPersistence(mainCollapsed);
  useEffect(() => setDetachedSidebar(null), [context?.windowId]);
  const detachedCollapsed = detachedSidebar && detachedSidebar.windowId === context?.windowId ? detachedSidebar.collapsed : true;
  const sidebarCollapsed = detached ? detachedCollapsed : mainCollapsed;
  const toggleSidebar = () => {
    if (detached && context) {
      const windowId = context.windowId;
      setDetachedSidebar(previous => ({ windowId, collapsed: !(previous?.windowId === windowId ? previous.collapsed : true) }));
    } else setMainCollapsed(value => !value);
  };
  return { sidebarCollapsed, toggleSidebar };
};

export const useViewportWidth = () => {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const measureViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', measureViewport);
    return () => window.removeEventListener('resize', measureViewport);
  }, []);
  return viewportWidth;
};
