import { useEffect, type RefObject } from 'react';

interface RecentFilesScrollContainer {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  addEventListener: (type: 'scroll', listener: () => void, options?: AddEventListenerOptions) => void;
  removeEventListener: (type: 'scroll', listener: () => void) => void;
}

export const useRecentFilesAutoLoad = (
  active: boolean,
  enabled: boolean,
  containerRef: RefObject<RecentFilesScrollContainer | null>,
  loadMore: () => void | Promise<void>,
  refreshKey: unknown,
  loadAheadPx: number,
) => {
  useEffect(() => {
    if (!active || !enabled) return;
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const loadNearBottom = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (container.scrollHeight - container.scrollTop - container.clientHeight <= loadAheadPx) void loadMore();
      });
    };
    loadNearBottom();
    container.addEventListener('scroll', loadNearBottom, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      container.removeEventListener('scroll', loadNearBottom);
    };
  }, [active, containerRef, enabled, loadAheadPx, loadMore, refreshKey]);
};
