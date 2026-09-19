export interface MarqueeAutoScrollContainer {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  getBoundingClientRect: () => Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>;
}

export interface MarqueeAutoScrollResult {
  edgeActive: boolean;
  scrolled: boolean;
}

const MARQUEE_AUTO_SCROLL_EDGE = 64;
const MARQUEE_AUTO_SCROLL_MAX_STEP = 24;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export const marqueeAutoScrollDelta = (pointer: number, viewportStart: number, viewportEnd: number) => {
  if (pointer < viewportStart + MARQUEE_AUTO_SCROLL_EDGE) {
    const strength = clamp((viewportStart + MARQUEE_AUTO_SCROLL_EDGE - pointer) / MARQUEE_AUTO_SCROLL_EDGE, 0, 1);
    return -Math.max(1, Math.ceil(strength * MARQUEE_AUTO_SCROLL_MAX_STEP));
  }
  if (pointer > viewportEnd - MARQUEE_AUTO_SCROLL_EDGE) {
    const strength = clamp((pointer - viewportEnd + MARQUEE_AUTO_SCROLL_EDGE) / MARQUEE_AUTO_SCROLL_EDGE, 0, 1);
    return Math.max(1, Math.ceil(strength * MARQUEE_AUTO_SCROLL_MAX_STEP));
  }
  return 0;
};

/**
 * Attempts one DOM scroll frame. `edgeActive` deliberately remains true when
 * the current DOM dimensions cannot scroll yet: React may commit a larger
 * logical canvas before the next animation frame.
 */
export const advanceMarqueeAutoScroll = (
  container: MarqueeAutoScrollContainer,
  pointer: { clientX: number; clientY: number },
): MarqueeAutoScrollResult => {
  const rect = container.getBoundingClientRect();
  const deltaY = marqueeAutoScrollDelta(pointer.clientY, rect.top, rect.bottom);
  const deltaX = marqueeAutoScrollDelta(pointer.clientX, rect.left, rect.right);
  if (!deltaY && !deltaX) return { edgeActive: false, scrolled: false };

  const previousScrollTop = container.scrollTop;
  const previousScrollLeft = container.scrollLeft;
  const maximumScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const maximumScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  container.scrollTop = clamp(previousScrollTop + deltaY, 0, maximumScrollTop);
  container.scrollLeft = clamp(previousScrollLeft + deltaX, 0, maximumScrollLeft);
  return {
    edgeActive: true,
    scrolled: container.scrollTop !== previousScrollTop || container.scrollLeft !== previousScrollLeft,
  };
};
