
export type VersionTreeEdgeKind = 'main' | 'auxiliary' | 'media_companion' | 'derived_preview' | 'derived_transcode' | 'workflow_input';
export type VersionTreeEdgePort = 'left' | 'right' | 'top' | 'bottom';
export type VersionTreeEdgeRect = { x: number; y: number; width: number; height: number };
export type VersionTreeEdgePoint = { x: number; y: number };
export type VersionTreeSupplementalEdgeKind = 'media_companion' | 'derived_preview' | 'derived_transcode' | 'workflow_input';
export type VersionTreeRelationNode = {
  id: string;
  projectId: string;
  mediaKind: string;
  nodeRole: 'original' | 'progress' | 'selection' | 'artifact' | 'workflow' | 'broll';
  artifactKind?: string;
  sourceMetadata?: { parentCapability?: 'structural' | 'workflow-input' | 'none' };
  relationKind?: 'main' | 'auxiliary';
  parentProgressId?: string;
  folderMissing?: boolean;
};

const VERSION_TREE_RELATION_LABELS: Record<VersionTreeEdgeKind, string> = {
  main: '版本关系',
  auxiliary: '选片关联',
  media_companion: '配套素材',
  derived_preview: '预览产物',
  derived_transcode: '转码产物',
  workflow_input: '工作流输入',
};

export const versionTreeRelationLabel = (kind: VersionTreeEdgeKind) => VERSION_TREE_RELATION_LABELS[kind];

export const isSupplementalVersionTreeEdgeKind = (kind: VersionTreeEdgeKind): kind is VersionTreeSupplementalEdgeKind =>
  kind === 'media_companion' || kind === 'derived_preview' || kind === 'derived_transcode' || kind === 'workflow_input';

export const allowedVersionTreeRelationKinds = (source: VersionTreeRelationNode, target: VersionTreeRelationNode): VersionTreeEdgeKind[] => {
  if (source.folderMissing || target.folderMissing || source.id === target.id || source.projectId !== target.projectId || source.mediaKind !== target.mediaKind) return [];
  const result: VersionTreeEdgeKind[] = [];
  const sourceIsMain = source.nodeRole === 'original' && !source.artifactKind
    || source.nodeRole === 'progress' && source.relationKind === 'main' && Boolean(source.parentProgressId);
  const targetIsMainProgress = target.nodeRole === 'progress' && target.relationKind === 'main' && Boolean(target.parentProgressId);
  if (target.nodeRole === 'progress' && target.relationKind !== 'auxiliary' && sourceIsMain) result.push('main');
  if (target.nodeRole === 'selection' && sourceIsMain) result.push('auxiliary');
  if (source.nodeRole === 'original' && !source.artifactKind && (target.nodeRole === 'artifact' || target.nodeRole === 'original')
    && (!target.artifactKind || target.artifactKind === 'companion')) result.push('media_companion');
  if (sourceIsMain && target.nodeRole === 'artifact'
    && (!target.artifactKind || target.artifactKind === 'preview')) result.push('derived_preview');
  if (sourceIsMain && target.nodeRole === 'artifact'
    && (!target.artifactKind || target.artifactKind === 'transcode')) result.push('derived_transcode');
  const parentCapability = (node: VersionTreeRelationNode) => node.sourceMetadata?.parentCapability
    || (node.nodeRole === 'selection' || node.nodeRole === 'workflow' ? 'workflow-input' : undefined);
  const sourceCapability = parentCapability(source);
  const targetCapability = parentCapability(target);
  if (sourceCapability === 'workflow-input' && targetIsMainProgress
    || sourceIsMain && source.nodeRole === 'progress' && target.nodeRole === 'workflow' && targetCapability === 'workflow-input') result.push('workflow_input');
  return result;
};

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const safeRect = (rect: VersionTreeEdgeRect): VersionTreeEdgeRect => ({
  x: finite(rect.x),
  y: finite(rect.y),
  width: Math.max(1, finite(rect.width, 1)),
  height: Math.max(1, finite(rect.height, 1)),
});

const portPoint = (rect: VersionTreeEdgeRect, port: VersionTreeEdgePort): VersionTreeEdgePoint => {
  if (port === 'left') return { x: rect.x, y: rect.y + rect.height / 2 };
  if (port === 'right') return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  if (port === 'top') return { x: rect.x + rect.width / 2, y: rect.y };
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
};

const portsForRelativePosition = (parent: VersionTreeEdgeRect, child: VersionTreeEdgeRect): [VersionTreeEdgePort, VersionTreeEdgePort] => {
  const deltaX = child.x + child.width / 2 - (parent.x + parent.width / 2);
  const deltaY = child.y + child.height / 2 - (parent.y + parent.height / 2);
  if (Math.abs(deltaX) >= Math.abs(deltaY)) return deltaX >= 0 ? ['right', 'left'] : ['left', 'right'];
  return deltaY >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
};

export const versionTreeEdgePath = (startX: number, startY: number, endX: number, endY: number, preferredAxis?: 'horizontal' | 'vertical') => {
  const safeStartX = finite(startX);
  const safeStartY = finite(startY);
  const safeEndX = finite(endX, safeStartX);
  const safeEndY = finite(endY, safeStartY);
  const deltaX = safeEndX - safeStartX;
  const deltaY = safeEndY - safeStartY;
  if (preferredAxis === 'horizontal' || (preferredAxis !== 'vertical' && Math.abs(deltaX) >= Math.abs(deltaY))) {
    const direction = deltaX >= 0 ? 1 : -1;
    const bend = Math.max(24, Math.abs(deltaX) / 2);
    return `M ${safeStartX} ${safeStartY} C ${safeStartX + direction * bend} ${safeStartY}, ${safeEndX - direction * bend} ${safeEndY}, ${safeEndX} ${safeEndY}`;
  }
  const direction = deltaY >= 0 ? 1 : -1;
  const bend = Math.max(24, Math.abs(deltaY) / 2);
  return `M ${safeStartX} ${safeStartY} C ${safeStartX} ${safeStartY + direction * bend}, ${safeEndX} ${safeEndY - direction * bend}, ${safeEndX} ${safeEndY}`;
};

export const versionTreeEdgeGeometry = (parentRect: VersionTreeEdgeRect, childRect: VersionTreeEdgeRect) => {
  const parent = safeRect(parentRect);
  const child = safeRect(childRect);
  const [startPort, endPort] = portsForRelativePosition(parent, child);
  const start = portPoint(parent, startPort);
  const end = portPoint(child, endPort);
  return {
    startPort,
    endPort,
    start,
    end,
    midpoint: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    path: versionTreeEdgePath(start.x, start.y, end.x, end.y, startPort === 'left' || startPort === 'right' ? 'horizontal' : 'vertical'),
  };
};

export const versionTreeEdgePresentation = (kind: VersionTreeEdgeKind, selected = false) => ({
  stroke: selected ? '#2563eb'
    : kind === 'workflow_input' ? '#0ea5e9'
      : kind === 'auxiliary' ? '#8b5cf6'
        : kind === 'media_companion' ? '#14b8a6'
          : kind === 'derived_transcode' ? '#2563eb'
          : kind === 'derived_preview' ? '#f59e0b'
            : '#94a3b8',
  strokeWidth: selected ? 3 : kind === 'main' ? 2 : 1.7,
  opacity: selected ? 1 : kind === 'main' ? .82 : kind === 'auxiliary' ? .72 : .58,
  // Every persisted relation is solid. Colour and arrow presence communicate
  // semantics; a dashed line is reserved for no persisted state at all.
  strokeDasharray: undefined,
});
