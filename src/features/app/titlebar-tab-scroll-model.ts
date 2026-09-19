export type TitlebarTabScrollState = {
  overflow: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
};

type TitlebarTabScrollMetrics = {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
};

export const measureTitlebarTabScroll = ({ scrollWidth, clientWidth, scrollLeft }: TitlebarTabScrollMetrics): TitlebarTabScrollState => {
  const overflow = scrollWidth > clientWidth + 1;
  return {
    overflow,
    canScrollLeft: overflow && scrollLeft > 1,
    canScrollRight: overflow && scrollLeft + clientWidth < scrollWidth - 1,
  };
};

export const titlebarTabScrollOffset = (direction: -1 | 1, clientWidth: number) => (
  direction * Math.max(180, clientWidth * 0.65)
);

export const titlebarTabWheelOffset = (deltaX: number, deltaY: number) => (
  Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY
);
