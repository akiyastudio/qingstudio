import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

const TITLEBAR_TAB_ORDER_KEY = 'photoflow:titlebar-tab-order';
const TAB_DRAG_THRESHOLD_PX = 8;
const TAB_EDGE_SCROLL_ZONE_PX = 36;

export const projectTabId = (pageId: string) => `project-page:${pageId}`;
export const inspirationTabId = (pageId: string) => `inspiration-page:${pageId}`;
export const workspaceToolTabId = (ownerPageId: string, kind: string) => `project-tool:${kind}:${ownerPageId}`;
export const componentTabId = (identity: string) => `component-page:${encodeURIComponent(identity)}`;

export const migrateLegacyWorkspaceToolTabId = (
  id: string,
  toolTabs: Array<{ ownerPageId: string; projectPath: string; kind: string }>,
) => {
  if (!id.startsWith('project-tool:')) return id;
  if (toolTabs.some(tab => workspaceToolTabId(tab.ownerPageId, tab.kind) === id)) return id;
  const legacyMatch = /^project-tool:([^:]+):(.*)$/.exec(id);
  if (!legacyMatch) return id;
  const [, kind, legacyProjectPath] = legacyMatch;
  const tab = toolTabs.find(candidate => candidate.kind === kind
    && candidate.projectPath.toLocaleLowerCase() === legacyProjectPath.toLocaleLowerCase());
  return tab ? workspaceToolTabId(tab.ownerPageId, tab.kind) : id;
};

const completeVisibleOrder = (savedOrder: string[], visibleIds: string[]) => {
  const visible = new Set(visibleIds);
  const ordered = savedOrder.filter((id, index) => visible.has(id) && savedOrder.indexOf(id) === index);
  return [...ordered, ...visibleIds.filter(id => !ordered.includes(id))];
};

export const insertNewTabsAfterAnchors = (
  savedOrder: string[],
  visibleIds: string[],
  insertions: Array<{ id: string; insertAfterTabId: string }>,
) => {
  const saved = new Set(savedOrder);
  const next = completeVisibleOrder(savedOrder, visibleIds);
  for (const insertion of insertions) {
    if (saved.has(insertion.id) || !next.includes(insertion.id)) continue;
    const currentIndex = next.indexOf(insertion.id);
    next.splice(currentIndex, 1);
    const anchorIndex = next.indexOf(insertion.insertAfterTabId);
    next.splice(anchorIndex < 0 ? next.length : anchorIndex + 1, 0, insertion.id);
  }
  return next;
};

const keepPinnedInspirationBesideHome = (orderedIds: string[], pinnedInspirationId?: string) => {
  if (!pinnedInspirationId || !orderedIds.includes('home') || !orderedIds.includes(pinnedInspirationId)) return orderedIds;
  const next = orderedIds.filter(id => id !== pinnedInspirationId);
  next.splice(next.indexOf('home') + 1, 0, pinnedInspirationId);
  return next;
};

export const useTitlebarTabOrder = ({
  inspirationPages,
  pinnedInspirationPageId,
  projectPages,
  toolTabs,
  componentPages,
  searchAllOpen = false,
  settingsOpen,
}: {
  inspirationPages: Array<{ id: string; currentRelativePath: string }>;
  pinnedInspirationPageId?: string;
  projectPages: Array<{ id: string; projectPath: string }>;
  toolTabs: Array<{ ownerPageId: string; projectPath: string; kind: string }>;
  componentPages?: Array<{ identity: string; insertAfterTabId: string }>;
  searchAllOpen?: boolean;
  settingsOpen: boolean;
}) => {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(TITLEBAR_TAB_ORDER_KEY) || '[]');
      return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  });
  const [draggedId, setDraggedId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' }>();
  const suppressClickRef = useRef<string>();
  const activeDragCleanupRef = useRef<() => void>();

  useEffect(() => {
    try {
      window.localStorage.setItem(TITLEBAR_TAB_ORDER_KEY, JSON.stringify(order));
    } catch {
      // Tab ordering is a convenience; storage being unavailable must not break navigation.
    }
  }, [order]);

  useEffect(() => () => activeDragCleanupRef.current?.(), []);

  const visibleIds = useMemo(() => [
    'home',
    ...(searchAllOpen ? ['search-all'] : []),
    ...inspirationPages.map(page => inspirationTabId(page.id)),
    ...projectPages.flatMap(page => [
      projectTabId(page.id),
      ...toolTabs.filter(tab => tab.ownerPageId === page.id).map(tab => workspaceToolTabId(tab.ownerPageId, tab.kind)),
    ]),
    ...(componentPages || []).map(page => componentTabId(page.identity)),
    ...(settingsOpen ? ['settings'] : []),
  ], [componentPages, inspirationPages, projectPages, searchAllOpen, settingsOpen, toolTabs]);

  const completeOrder = useCallback((current: string[]) => insertNewTabsAfterAnchors(
    current,
    visibleIds,
    (componentPages || []).map(page => ({ id: componentTabId(page.identity), insertAfterTabId: page.insertAfterTabId })),
  ), [componentPages, visibleIds]);

  useEffect(() => {
    setOrder(current => {
      const migrated = current.map(id => {
        if (id === 'inspiration') {
          const rootPage = inspirationPages.find(page => page.currentRelativePath === '') || inspirationPages[0];
          return rootPage ? inspirationTabId(rootPage.id) : id;
        }
        if (id.startsWith('project:')) {
          const legacyPath = id.slice('project:'.length).toLocaleLowerCase();
          const page = projectPages.find(candidate => candidate.projectPath.toLocaleLowerCase() === legacyPath);
          return page ? projectTabId(page.id) : id;
        }
        return migrateLegacyWorkspaceToolTabId(id, toolTabs);
      });
      return migrated.every((id, index) => id === current[index]) ? current : migrated;
    });
  }, [inspirationPages, projectPages, toolTabs]);

  const orderedVisibleIds = useMemo(() => {
    const completed = completeOrder(order);
    const newComponentBesideHome = (componentPages || []).some(page => page.insertAfterTabId === 'home' && !order.includes(componentTabId(page.identity)));
    return newComponentBesideHome ? completed : keepPinnedInspirationBesideHome(
      completed,
      pinnedInspirationPageId ? inspirationTabId(pinnedInspirationPageId) : undefined,
    );
  }, [completeOrder, componentPages, order, pinnedInspirationPageId]);

  const reorder = useCallback((sourceId: string, targetId: string, side: 'before' | 'after') => {
    if (sourceId === targetId) return;
    setOrder(current => {
      const next = completeVisibleOrder(current, visibleIds).filter(id => id !== sourceId);
      const targetIndex = next.indexOf(targetId);
      if (targetIndex < 0) return current;
      next.splice(targetIndex + (side === 'after' ? 1 : 0), 0, sourceId);
      return keepPinnedInspirationBesideHome(next, pinnedInspirationPageId ? inspirationTabId(pinnedInspirationPageId) : undefined);
    });
  }, [pinnedInspirationPageId, visibleIds]);

  return (id: string) => {
    const draggable = id !== (pinnedInspirationPageId ? inspirationTabId(pinnedInspirationPageId) : undefined);
    return {
      'data-titlebar-tab-id': id,
      'data-tab-draggable': draggable || undefined,
      'aria-grabbed': draggedId === id || undefined,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (!draggable || event.button !== 0 || (event.target as HTMLElement).closest('[data-tab-drag-ignore="true"]')) return;
        activeDragCleanupRef.current?.();
        const sourceElement = event.currentTarget;
        const container = sourceElement.parentElement;
        if (!container) return;
        const pointerId = event.pointerId;
        const startX = event.clientX;
        let started = false;
        const previousUserSelect = document.body.style.userSelect;
        const previousCursor = document.body.style.cursor;

        const finish = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finishPointer);
          window.removeEventListener('pointercancel', finishPointer);
          window.removeEventListener('blur', finish);
          if (started) {
            suppressClickRef.current = id;
            window.setTimeout(() => {
              if (suppressClickRef.current === id) suppressClickRef.current = undefined;
            }, 0);
          }
          document.body.style.userSelect = previousUserSelect;
          document.body.style.cursor = previousCursor;
          if (sourceElement.hasPointerCapture(pointerId)) sourceElement.releasePointerCapture(pointerId);
          setDraggedId(undefined);
          setDropTarget(undefined);
          activeDragCleanupRef.current = undefined;
        };
        const finishPointer = (pointerEvent: PointerEvent) => {
          if (pointerEvent.pointerId === pointerId) finish();
        };
        const move = (pointerEvent: PointerEvent) => {
          if (pointerEvent.pointerId !== pointerId) return;
          if (!started) {
            if (Math.abs(pointerEvent.clientX - startX) < TAB_DRAG_THRESHOLD_PX) return;
            started = true;
            sourceElement.setPointerCapture(pointerId);
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'grabbing';
            setDraggedId(id);
          }
          pointerEvent.preventDefault();
          const containerRect = container.getBoundingClientRect();
          if (pointerEvent.clientX < containerRect.left + TAB_EDGE_SCROLL_ZONE_PX) container.scrollLeft -= 18;
          else if (pointerEvent.clientX > containerRect.right - TAB_EDGE_SCROLL_ZONE_PX) container.scrollLeft += 18;

          const candidates = [...container.querySelectorAll<HTMLElement>('[data-titlebar-tab-id]')]
            .filter(candidate => candidate.dataset.titlebarTabId !== id);
          const target = candidates.reduce<HTMLElement | undefined>((nearest, candidate) => {
            const candidateCenter = candidate.getBoundingClientRect().left + candidate.getBoundingClientRect().width / 2;
            if (!nearest) return candidate;
            const nearestRect = nearest.getBoundingClientRect();
            const nearestCenter = nearestRect.left + nearestRect.width / 2;
            return Math.abs(candidateCenter - pointerEvent.clientX) < Math.abs(nearestCenter - pointerEvent.clientX) ? candidate : nearest;
          }, undefined);
          if (!target?.dataset.titlebarTabId) return;
          const targetRect = target.getBoundingClientRect();
          const side = pointerEvent.clientX < targetRect.left + targetRect.width / 2 ? 'before' : 'after';
          setDropTarget({ id: target.dataset.titlebarTabId, side });
          reorder(id, target.dataset.titlebarTabId, side);
        };

        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', finishPointer);
        window.addEventListener('pointercancel', finishPointer);
        window.addEventListener('blur', finish);
        activeDragCleanupRef.current = finish;
      },
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (suppressClickRef.current !== id) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = undefined;
      },
      style: { order: orderedVisibleIds.indexOf(id) },
      'data-dragging': draggedId === id || undefined,
      'data-drop-target': dropTarget?.id === id || undefined,
      'data-drop-side': dropTarget?.id === id ? dropTarget.side : undefined,
    };
  };
};
