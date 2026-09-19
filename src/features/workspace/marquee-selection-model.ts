export interface MarqueePoint {
  x: number;
  y: number;
}

export interface MarqueeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface MarqueeViewportTransform {
  viewportLeft: number;
  viewportTop: number;
  scrollLeft: number;
  scrollTop: number;
  contentLeft?: number;
  contentTop?: number;
}

export interface MarqueePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MarqueeGridLayout {
  kind: 'grid';
  columns: number;
  rowHeight: number;
  columnWidth: number;
  gap: number;
  padding: MarqueePadding;
}

export interface MarqueeListLayout {
  kind: 'list';
  rowHeight: number;
  columnWidth: number;
  gap: number;
  padding: MarqueePadding;
}

export type MarqueeLayout = MarqueeGridLayout | MarqueeListLayout;

export const FILE_SURFACE_HORIZONTAL_PADDING = 24;
export const FILE_GRID_GAP = 12;
export const FILE_GRID_ITEM_HEIGHT_EXTRA = 68;
export const FILE_LIST_ROW_HEIGHT = 48;
export const FILE_LIST_HEADER_HEIGHT = 48;
export const FILE_SURFACE_PADDING: MarqueePadding = {
  top: 0,
  right: FILE_SURFACE_HORIZONTAL_PADDING,
  bottom: 0,
  left: FILE_SURFACE_HORIZONTAL_PADDING,
};

const nonNegative = (value: number) => Math.max(0, Number.isFinite(value) ? value : 0);

export const fileSurfaceContentWidth = (surfaceWidth: number, padding: MarqueePadding = FILE_SURFACE_PADDING) => Math.max(
  1,
  nonNegative(surfaceWidth) - nonNegative(padding.left) - nonNegative(padding.right),
);

export const calculateFileGridGeometry = (
  surfaceWidth: number,
  minimumColumnWidth: number,
  measuredItemHeight?: number,
): MarqueeGridLayout & { contentWidth: number; rowPitch: number } => {
  const padding = { ...FILE_SURFACE_PADDING };
  const gap = FILE_GRID_GAP;
  const contentWidth = fileSurfaceContentWidth(surfaceWidth, padding);
  const safeMinimumColumnWidth = Math.max(1, nonNegative(minimumColumnWidth));
  const columns = Math.max(1, Math.floor((contentWidth + gap) / (safeMinimumColumnWidth + gap)));
  const columnWidth = Math.max(1, (contentWidth - Math.max(0, columns - 1) * gap) / columns);
  const rowHeight = measuredItemHeight && measuredItemHeight > 0 ? measuredItemHeight : columnWidth + FILE_GRID_ITEM_HEIGHT_EXTRA;
  return { kind: 'grid', columns, columnWidth, rowHeight, gap, padding, contentWidth, rowPitch: rowHeight + gap };
};

export const viewportPointToContentPoint = (point: MarqueePoint, transform: MarqueeViewportTransform): MarqueePoint => ({
  x: point.x - transform.viewportLeft + transform.scrollLeft - (transform.contentLeft || 0),
  y: point.y - transform.viewportTop + transform.scrollTop - (transform.contentTop || 0),
});

export const normalizeMarqueeRect = (start: MarqueePoint, end: MarqueePoint): MarqueeRect => {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

export const gridItemRect = (index: number, layout: MarqueeGridLayout): MarqueeRect => {
  const columns = Math.max(1, Math.floor(layout.columns));
  const safeIndex = Math.max(0, Math.floor(index));
  const column = safeIndex % columns;
  const row = Math.floor(safeIndex / columns);
  const left = layout.padding.left + column * (nonNegative(layout.columnWidth) + nonNegative(layout.gap));
  const top = layout.padding.top + row * (nonNegative(layout.rowHeight) + nonNegative(layout.gap));
  return normalizeMarqueeRect({ x: left, y: top }, { x: left + nonNegative(layout.columnWidth), y: top + nonNegative(layout.rowHeight) });
};

export const listItemRect = (index: number, layout: MarqueeListLayout): MarqueeRect => {
  const safeIndex = Math.max(0, Math.floor(index));
  const left = layout.padding.left;
  const top = layout.padding.top + safeIndex * (nonNegative(layout.rowHeight) + nonNegative(layout.gap));
  return normalizeMarqueeRect({ x: left, y: top }, { x: left + nonNegative(layout.columnWidth), y: top + nonNegative(layout.rowHeight) });
};

export const marqueeItemRect = (index: number, layout: MarqueeLayout): MarqueeRect => layout.kind === 'grid'
  ? gridItemRect(index, layout)
  : listItemRect(index, layout);

export const rectanglesIntersect = (left: MarqueeRect, right: MarqueeRect) => left.left <= right.right
  && left.right >= right.left
  && left.top <= right.bottom
  && left.bottom >= right.top;

export const logicalCanvasSize = (itemCount: number, layout: MarqueeLayout) => {
  const count = Math.max(0, Math.floor(itemCount));
  const columns = layout.kind === 'grid' ? Math.max(1, Math.floor(layout.columns)) : 1;
  const rows = count ? Math.ceil(count / columns) : 0;
  const usedColumns = layout.kind === 'grid' ? Math.min(columns, count) : count ? 1 : 0;
  return {
    width: layout.padding.left + layout.padding.right + usedColumns * nonNegative(layout.columnWidth) + Math.max(0, usedColumns - 1) * nonNegative(layout.gap),
    height: layout.padding.top + layout.padding.bottom + rows * nonNegative(layout.rowHeight) + Math.max(0, rows - 1) * nonNegative(layout.gap),
  };
};

export const finiteLogicalCanvasSize = (
  itemCount: number,
  layout: MarqueeLayout,
  viewport: { width: number; height: number },
  selection?: MarqueeRect,
) => {
  const content = logicalCanvasSize(itemCount, layout);
  return {
    width: Math.max(content.width, nonNegative(viewport.width), nonNegative(selection?.right || 0)),
    height: Math.max(content.height, nonNegative(viewport.height), nonNegative(selection?.bottom || 0)),
  };
};

export const hitMarqueeIndices = (selection: MarqueeRect, itemCount: number, layout: MarqueeLayout) => {
  const hits: number[] = [];
  for (let index = 0; index < Math.max(0, Math.floor(itemCount)); index += 1) {
    if (rectanglesIntersect(selection, marqueeItemRect(index, layout))) hits.push(index);
  }
  return hits;
};

export const mergeMarqueeSelection = (initialPaths: string[], hitPaths: string[], additive: boolean) => {
  if (!additive) return Array.from(new Set(hitPaths));
  const initialSet = new Set(initialPaths);
  const hitSet = new Set(hitPaths);
  return [
    ...initialPaths.filter(path => !hitSet.has(path)),
    ...hitPaths.filter(path => !initialSet.has(path)),
  ];
};
