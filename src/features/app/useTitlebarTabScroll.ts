import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type WheelEventHandler } from 'react';
import { useTitlebarTabOrder } from './useTitlebarTabOrder';
import {
  measureTitlebarTabScroll,
  titlebarTabScrollOffset,
  titlebarTabWheelOffset,
  type TitlebarTabScrollState,
} from './titlebar-tab-scroll-model';

const INITIAL_TITLEBAR_TAB_SCROLL: TitlebarTabScrollState = {
  overflow: false,
  canScrollLeft: false,
  canScrollRight: false,
};

type UseTitlebarTabScrollOptions = {
  nativeRevision?: number;
  tabsRef: RefObject<HTMLDivElement>;
  componentPages: Array<{ identity: string; insertAfterTabId: string }>;
  configLoaded: boolean;
  activeTab: string;
  activePageId?: string | null;
  projectPages: Array<{
    id: string;
    kind?: string;
    initialRelativePath: string;
    currentRelativePath: string;
    project?: { path: string } | null;
  }>;
  pinInspirationLibrary?: boolean;
  searchAllTabOpen: boolean;
  settingsTabOpen: boolean;
  workspaceToolTabs: Array<{ ownerPageId: string; projectPath: string; kind: string }>;
};

export const useTitlebarTabScroll = ({
  nativeRevision,
  tabsRef,
  componentPages,
  configLoaded,
  activeTab,
  activePageId,
  projectPages,
  pinInspirationLibrary,
  searchAllTabOpen,
  settingsTabOpen,
  workspaceToolTabs,
}: UseTitlebarTabScrollOptions) => {
  const tabsRefHolder = useRef(tabsRef);
  const titlebarPages = useMemo(() => ({
    inspiration: projectPages.filter(page => page.kind === 'inspiration').map(page => ({ id: page.id, currentRelativePath: page.currentRelativePath })),
    pinnedInspirationPageId: pinInspirationLibrary ? projectPages.find(page => page.kind === 'inspiration' && page.initialRelativePath === '')?.id : undefined,
    projects: projectPages.filter(page => page.project).map(page => ({ id: page.id, projectPath: page.project!.path })),
  }), [pinInspirationLibrary, projectPages]);
  const tabDragProps = useTitlebarTabOrder({
    inspirationPages: titlebarPages.inspiration,
    pinnedInspirationPageId: titlebarPages.pinnedInspirationPageId,
    projectPages: titlebarPages.projects,
    toolTabs: workspaceToolTabs,
    componentPages,
    searchAllOpen: searchAllTabOpen,
    settingsOpen: settingsTabOpen,
  });
  const [tabScroll, setTabScroll] = useState(INITIAL_TITLEBAR_TAB_SCROLL);
  const updateTabScroll = useCallback(() => {
    const element = tabsRefHolder.current.current;
    if (!element) return;
    const next = measureTitlebarTabScroll(element);
    setTabScroll(current => current.overflow === next.overflow
      && current.canScrollLeft === next.canScrollLeft
      && current.canScrollRight === next.canScrollRight ? current : next);
  }, []);

  useEffect(() => {
    const element = tabsRefHolder.current.current;
    if (!element) return;
    const observer = new ResizeObserver(updateTabScroll);
    observer.observe(element);
    element.addEventListener('scroll', updateTabScroll, { passive: true });
    updateTabScroll();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', updateTabScroll);
    };
  }, [componentPages.length, configLoaded, projectPages.length, settingsTabOpen, updateTabScroll, workspaceToolTabs.length, nativeRevision]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = tabsRefHolder.current.current;
      element?.querySelector<HTMLElement>('[data-active-tab="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      updateTabScroll();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [componentPages.length, configLoaded, activeTab, activePageId, projectPages.length, settingsTabOpen, updateTabScroll, workspaceToolTabs.length, nativeRevision]);

  const scrollTabs = useCallback((direction: -1 | 1) => {
    const element = tabsRefHolder.current.current;
    if (!element) return;
    element.scrollBy({ left: titlebarTabScrollOffset(direction, element.clientWidth), behavior: 'smooth' });
  }, []);

  const handleWheel: WheelEventHandler<HTMLDivElement> = useCallback(event => {
    const element = event.currentTarget;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    const delta = titlebarTabWheelOffset(event.deltaX, event.deltaY);
    if (!delta) return;
    event.preventDefault();
    element.scrollBy({ left: delta, behavior: 'auto' });
  }, []);

  return {
    titlebarTabScroll: tabScroll,
    titlebarTabDragProps: tabDragProps,
    scrollTitlebarTabs: scrollTabs,
    handleTitlebarTabWheel: handleWheel,
  };
};
