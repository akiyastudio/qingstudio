export type VersionTreeCanvasPosition = { x: number; y: number; manual?: boolean };
export type VersionTreeCanvasNode = { id: string; x: number; y: number };

export const translateVersionTreeCanvasSelection = (
  startPositions: ReadonlyMap<string, VersionTreeCanvasPosition>,
  deltaX: number,
  deltaY: number,
) => {
  const finiteDeltaX = Number.isFinite(deltaX) ? deltaX : 0;
  const finiteDeltaY = Number.isFinite(deltaY) ? deltaY : 0;
  const positions = [...startPositions.values()];
  const clampedDeltaX = Math.max(finiteDeltaX, -(positions.length ? Math.min(...positions.map(position => position.x)) : 0));
  const clampedDeltaY = Math.max(finiteDeltaY, -(positions.length ? Math.min(...positions.map(position => position.y)) : 0));
  return new Map([...startPositions].map(([id, position]) => [id, {
    x: position.x + clampedDeltaX,
    y: position.y + clampedDeltaY,
    manual: true,
  }]));
};

export const DEFAULT_VERSION_TREE_SPACING = Object.freeze({
  horizontalGap: 64,
  rowGap: 24,
  auxiliaryGap: 44,
  rootGap: 40,
  padding: 32,
});

export const versionTreeAreaSize = (
  natural: { width: number; height: number },
  custom: { width: number; height: number } | undefined,
  minimum: { width: number; height: number },
) => custom
  ? {
    width: Math.max(minimum.width, custom.width),
    height: Math.max(minimum.height, custom.height),
  }
  : natural;

type ReconcileVersionTreeCanvasInput = {
  nodes: readonly VersionTreeCanvasNode[];
  previous?: ReadonlyMap<string, VersionTreeCanvasPosition>;
  nodeWidth: number;
  nodeHeight: number;
  horizontalGap?: number;
  rowGap?: number;
  refreshAll?: boolean;
};

type AlignVersionTreeHistoryInput = Omit<ReconcileVersionTreeCanvasInput, 'previous' | 'refreshAll'> & {
  current: ReadonlyMap<string, VersionTreeCanvasPosition>;
  snapshot: ReadonlyMap<string, VersionTreeCanvasPosition>;
};

const finitePosition = (position: VersionTreeCanvasPosition | undefined): position is VersionTreeCanvasPosition => Boolean(
  position && Number.isFinite(position.x) && Number.isFinite(position.y),
);

const conflicts = (
  left: VersionTreeCanvasPosition,
  right: VersionTreeCanvasPosition,
  nodeWidth: number,
  nodeHeight: number,
  horizontalGap: number,
  rowGap: number,
) => left.x < right.x + nodeWidth + horizontalGap
  && right.x < left.x + nodeWidth + horizontalGap
  && left.y < right.y + nodeHeight + rowGap
  && right.y < left.y + nodeHeight + rowGap;

export const reconcileVersionTreeCanvasPositions = ({
  nodes,
  previous = new Map(),
  nodeWidth,
  nodeHeight,
  horizontalGap = DEFAULT_VERSION_TREE_SPACING.horizontalGap,
  rowGap = DEFAULT_VERSION_TREE_SPACING.rowGap,
  refreshAll = false,
}: ReconcileVersionTreeCanvasInput) => {
  const width = Math.max(1, nodeWidth);
  const height = Math.max(1, nodeHeight);
  const horizontal = Math.max(0, horizontalGap);
  const vertical = Math.max(0, rowGap);
  const nodeIds = new Set(nodes.map(node => node.id));
  const result = new Map<string, VersionTreeCanvasPosition>();
  if (!refreshAll) {
    for (const [id, position] of previous) if (nodeIds.has(id) && finitePosition(position)) {
      result.set(id, position.x >= 0 && position.y >= 0
        ? position
        : { ...position, x: Math.max(0, position.x), y: Math.max(0, position.y) });
    }
  }

  const occupied = [...result.values()];
  const orderedNodes = [...nodes].sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id));
  for (const node of orderedNodes) {
    if (result.has(node.id)) continue;
    const position: VersionTreeCanvasPosition = { x: node.x, y: node.y };
    while (occupied.some(candidate => conflicts(position, candidate, width, height, horizontal, vertical))) {
      position.y += height + vertical;
    }
    result.set(node.id, position);
    occupied.push(position);
  }
  return result;
};

/**
 * Applies an older history snapshot to the graph that exists now. History is
 * intentionally not authoritative for graph membership: nodes created later
 * retain their current coordinates and removed nodes cannot be resurrected.
 */
export const alignVersionTreeHistoryPositions = ({
  nodes,
  current,
  snapshot,
  nodeWidth,
  nodeHeight,
  horizontalGap,
  rowGap,
}: AlignVersionTreeHistoryInput) => {
  const nodeIds = new Set(nodes.map(node => node.id));
  const aligned = new Map<string, VersionTreeCanvasPosition>();
  current.forEach((position, id) => { if (nodeIds.has(id)) aligned.set(id, position); });
  snapshot.forEach((position, id) => { if (nodeIds.has(id)) aligned.set(id, position); });
  return reconcileVersionTreeCanvasPositions({ nodes, previous: aligned, nodeWidth, nodeHeight, horizontalGap, rowGap });
};

export const markVersionTreeCanvasPositionsPersisted = (
  current: ReadonlyMap<string, VersionTreeCanvasPosition>,
  persistedIds: ReadonlySet<string>,
) => new Map([...current].map(([id, position]) => [id, persistedIds.has(id) ? { ...position, manual: true } : position]));

export const updateVersionTreeServerPositionMirror = (
  previous: ReadonlyMap<string, VersionTreeCanvasPosition>,
  saved: ReadonlyMap<string, VersionTreeCanvasPosition>,
  mode: 'patch' | 'replace',
) => {
  const next = mode === 'replace' ? new Map<string, VersionTreeCanvasPosition>() : new Map(previous);
  saved.forEach((position, nodeKey) => next.set(nodeKey, { ...position, manual: true }));
  return next;
};

export const mappedVersionTreeServerNodeKeys = (
  serverNodeKeys: Iterable<string>,
  mountedNodeKeys: ReadonlySet<string>,
) => new Set([...serverNodeKeys].filter(nodeKey => mountedNodeKeys.has(nodeKey)));

export const versionTreeCanvasBounds = (
  positions: ReadonlyMap<string, VersionTreeCanvasPosition>,
  nodeWidth: number,
  nodeHeight: number,
  padding = DEFAULT_VERSION_TREE_SPACING.padding,
) => {
  const values = [...positions.values()];
  const safePadding = Math.max(0, padding);
  return {
    width: values.length ? Math.max(...values.map(position => position.x + nodeWidth)) + safePadding * 2 : nodeWidth + safePadding * 2,
    height: values.length ? Math.max(...values.map(position => position.y + nodeHeight)) + safePadding * 2 : nodeHeight + safePadding * 2,
  };
};
