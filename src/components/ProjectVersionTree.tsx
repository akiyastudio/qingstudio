import { getLocale } from '../i18n/runtime';
import { LocalizedText } from "../i18n/LocalizedText";
import { versionTreeRelationLabel, trackingStateLabel } from "../i18n/built-in-labels";
import { useLocale } from "../i18n/react";
import { t } from "../i18n/runtime";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { ProgressFolder, ProjectFileEntry, VersionGraphEdge } from '../types';
import { layoutVersionTree, DEFAULT_VERSION_TREE_SPACING, versionTreeAreaSize, versionTreeCanvasBounds, allowedVersionTreeRelationKinds, isSupplementalVersionTreeEdgeKind, versionTreeEdgeGeometry, versionTreeEdgePath, versionTreeEdgePresentation, type VersionTreeEdgeKind, type VersionTreeSupplementalEdgeKind, useVersionTreeCanvas, type VersionTreeDragState, progressRelationChangeError, projectVisibleVersionGraph, resolveVersionTreeEntryMapping, versionTreeReactKey } from '../features/versioning/public';
import { FILE_GRID_GAP } from '../features/workspace/marquee-selection-model';
import { useHostSurfaceSuspension } from './LayerProvider';

type ProjectVersionTreeProps = {
  active: boolean;
  progressFolders: ProgressFolder[];
  graphEdges?: VersionGraphEdge[];
  entries: ProjectFileEntry[];
  structureEntries?: ProjectFileEntry[];
  selectedRelativePaths?: string[];
  filterActive?: boolean;
  activeRelativePath: string;
  gridIconSize: number;
  workspacePath: string;
  projectName: string;
  projectRelativePath: (absolutePath: string) => string;
  renderEntry: (entry: ProjectFileEntry, progressFolder?: ProgressFolder, sourceKind?: 'image' | 'video') => ReactNode;
  pendingChildId?: string;
  hoverParentId?: string;
  mutatingChildIds?: string[];
  onBeginRelationEdit?: (childId: string) => void;
  onHoverRelationParent?: (parentId?: string) => void;
  onRequestRelationChange?: (childProgressId: string, parentProgressId: string | null) => void;
  onRequestSupplementalEdgeDelete?: (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => void;
  onRequestSupplementalEdgeReconnect?: (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>, newSourceProgressId: string) => void;
  onRequestSupplementalEdgeCreate?: (sourceProgressId: string, targetProgressId: string, edgeKind: VersionTreeSupplementalEdgeKind) => void;
  onRequestCreateVersion?: (source: ProgressFolder, target: ProjectFileEntry) => void;
  onRequestCreateEmptyVersion?: (source: ProgressFolder, branch: boolean) => void;
  onRequestEntryContextMenu?: (event: ReactMouseEvent<HTMLDivElement>, entry: ProjectFileEntry) => void;
  onStartFileDrag?: (event: ReactDragEvent<HTMLDivElement>, entry: ProjectFileEntry) => void;
  canUndoRelation?: boolean;
  canRedoRelation?: boolean;
  onUndoRelation?: () => void;
  onRedoRelation?: () => void;
  onCancelRelationEdit?: () => void;
  onNotice: (message: string, duration?: number) => void;
  onCanvasControllerChange?: (controller: VersionTreeCanvasController | null) => void;
  onViewportScrollChange?: (scrolled: boolean) => void;
};

export type VersionTreeCanvasController = {
  hasManualLayout: boolean;
  refreshLayout: () => Promise<boolean>;
  fitView: () => void;
  resetZoom: () => void;
  undoLayout: () => Promise<boolean>;
  redoLayout: () => Promise<boolean>;
};

type VersionTreeAreaKind = 'image' | 'video' | 'other';
type VersionTreeAreaBand = { areaKind: VersionTreeAreaKind; label: string; left: number; right: number; top: number; bottom: number };
type VersionTreeAreaSize = { width: number; height: number };
type PositionedItem = { key: string; nodeKey: string; areaKind: VersionTreeAreaKind; folder?: ProgressFolder; sourceKind?: 'image' | 'video'; entry: ProjectFileEntry; x: number; y: number };
type LayoutRelation = { id: string; kind: VersionTreeEdgeKind; parentId: string; childId: string; selectable: boolean };
type DrawnEdge = { id: string; kind: VersionTreeEdgeKind; path: string; parentId?: string; childId?: string; startX: number; startY: number; endX: number; endY: number; menuX: number; menuY: number };
const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('zh-CN');
const versionTreeCanvasItemId = (item: Pick<PositionedItem, 'key' | 'nodeKey' | 'folder'>) => item.folder ? item.nodeKey : item.key;
const isVersionFolderEntry = (entry: ProjectFileEntry) => entry.kind === 'folder';
const isEditableShortcutTarget = (target: EventTarget | null) => Boolean(
  (target as Element | null)?.closest?.('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'),
);
const EMPTY_VERSION_TREE_IDS: string[] = [];
const EMPTY_VERSION_TREE_EDGES: VersionGraphEdge[] = [];
const afterVersionTreePaint = (callback: () => void) => typeof window.requestAnimationFrame === 'function'
  ? window.requestAnimationFrame(callback)
  : globalThis.setTimeout(callback, 0);

export const ProjectVersionTree = ({ active, progressFolders, graphEdges = EMPTY_VERSION_TREE_EDGES, entries, structureEntries = entries, selectedRelativePaths = EMPTY_VERSION_TREE_IDS, filterActive = false, activeRelativePath, gridIconSize, workspacePath, projectName, projectRelativePath, renderEntry, pendingChildId, hoverParentId, mutatingChildIds = EMPTY_VERSION_TREE_IDS, onBeginRelationEdit, onHoverRelationParent, onRequestRelationChange, onRequestSupplementalEdgeDelete, onRequestSupplementalEdgeReconnect, onRequestSupplementalEdgeCreate, onRequestCreateVersion, onRequestCreateEmptyVersion, onRequestEntryContextMenu, onStartFileDrag, canUndoRelation = false, canRedoRelation = false, onUndoRelation, onRedoRelation, onCancelRelationEdit, onNotice, onCanvasControllerChange, onViewportScrollChange }: ProjectVersionTreeProps) => {
  useLocale();
  const [pointerPoint, setPointerPoint] = useState<{ x: number; y: number } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [dragState, setDragState] = useState<VersionTreeDragState>(null);
  const [relationChoice, setRelationChoice] = useState<{ sourceId: string; targetId: string; kinds: VersionTreeEdgeKind[] } | null>(null);
  const [createVersionTargetKey, setCreateVersionTargetKey] = useState('');
  const [zoom, setZoom] = useState(1);
  const [selectedNodeKey, setSelectedNodeKey] = useState('');
  const [blankOutputSourceId, setBlankOutputSourceId] = useState('');
  const [nativeDragArmed, setNativeDragArmed] = useState(false);
  const nativeDragScopeRef = useRef<HTMLDivElement>(null);
  const scopeOwnsInteractionRef = useRef(false);
  const onStartFileDragRef = useRef(onStartFileDrag);
  onStartFileDragRef.current = onStartFileDrag;
  useHostSurfaceSuspension(active && Boolean(relationChoice || blankOutputSourceId));
  const [viewportBounds, setViewportBounds] = useState({ left: 0, top: 0, width: 1600, height: 1000 });
  const [areaBandSizes, setAreaBandSizes] = useState<Partial<Record<VersionTreeAreaKind, VersionTreeAreaSize>>>({});
  const areaResizeRef = useRef<{ element: Element; pointerId: number; areaKind: VersionTreeAreaKind; axis: 'x' | 'y' | 'both'; startX: number; startY: number; width: number; height: number } | null>(null);
  const nativeFileDragRef = useRef<{ nodeKey: string; pointerId: number } | null>(null);
  const dragStateRef = useRef<VersionTreeDragState>(null);
  const changeDragState = useCallback((next: VersionTreeDragState) => {
    dragStateRef.current = next;
    setDragState(next);
  }, []);
  const arrowMarkerId = `version-tree-arrow-${useId().replace(/:/g, '')}`;
  const activePortRef = useRef<{ element: Element; pointerId: number; childId: string } | null>(null);
  const createVersionPortRef = useRef<{ element: Element; pointerId: number; sourceId: string } | null>(null);
  const reconnectEdgeRef = useRef<Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'> | null>(null);
  const relationEditActiveRef = useRef(false);
  const onCancelRelationEditRef = useRef(onCancelRelationEdit);
  const onHoverRelationParentRef = useRef(onHoverRelationParent);
  onCancelRelationEditRef.current = onCancelRelationEdit;
  onHoverRelationParentRef.current = onHoverRelationParent;
  const setNativeDragArm = useCallback((armed: boolean) => {
    // Update the DOM in the keyboard event itself. Waiting for React to commit
    // can let Chromium classify the next pointer while draggable is stale.
    nativeDragScopeRef.current?.querySelectorAll<HTMLElement>('[data-version-tree-node="true"]').forEach(node => {
      node.draggable = armed && Boolean(onStartFileDragRef.current);
      if (armed) node.dataset.nativeDragArmed = 'true';
      else delete node.dataset.nativeDragArmed;
    });
    setNativeDragArmed(armed);
  }, []);
  const cancelComponentInteractions = useCallback(() => {
    const activePort = activePortRef.current;
    if (activePort?.element.hasPointerCapture(activePort.pointerId)) activePort.element.releasePointerCapture(activePort.pointerId);
    const createVersionPort = createVersionPortRef.current;
    if (createVersionPort?.element.hasPointerCapture(createVersionPort.pointerId)) createVersionPort.element.releasePointerCapture(createVersionPort.pointerId);
    const areaResize = areaResizeRef.current;
    if (areaResize?.element.hasPointerCapture(areaResize.pointerId)) areaResize.element.releasePointerCapture(areaResize.pointerId);
    activePortRef.current = null;
    createVersionPortRef.current = null;
    reconnectEdgeRef.current = null;
    areaResizeRef.current = null;
    nativeFileDragRef.current = null;
    setPointerPoint(null);
    setCreateVersionTargetKey('');
    setRelationChoice(null);
    setBlankOutputSourceId('');
    setSelectedEdgeId('');
    setSelectedNodeKey('');
    setNativeDragArm(false);
    const cancelRelationEdit = relationEditActiveRef.current || dragStateRef.current?.type === 'relation';
    relationEditActiveRef.current = false;
    if (dragStateRef.current?.type === 'relation' || dragStateRef.current?.type === 'create-version') {
      changeDragState(null);
    }
    if (cancelRelationEdit) {
      onHoverRelationParentRef.current?.(undefined);
      onCancelRelationEditRef.current?.();
    }
  }, [changeDragState, setNativeDragArm]);
  useLayoutEffect(() => {
    cancelComponentInteractions();
    setAreaBandSizes({});
    scopeOwnsInteractionRef.current = false;
  }, [activeRelativePath, cancelComponentInteractions, projectName, workspacePath]);
  useLayoutEffect(() => {
    if (!active) {
      cancelComponentInteractions();
      scopeOwnsInteractionRef.current = false;
    }
  }, [active, cancelComponentInteractions]);
  useEffect(() => {
    const updateNativeDragArm = (event: KeyboardEvent) => {
      if (event.key !== 'Control' && event.key !== 'Meta') return;
      if (event.type === 'keyup') { setNativeDragArm(false); return; }
      if (event.defaultPrevented || isEditableShortcutTarget(event.target) || !active || !scopeOwnsInteractionRef.current) return;
      setNativeDragArm(true);
    };
    const disarmNativeDrag = () => setNativeDragArm(false);
    const updateOwnership = (event: Event) => {
      const root = nativeDragScopeRef.current;
      let current = event.target as Node | null;
      scopeOwnsInteractionRef.current = false;
      while (root && current) {
        if (current === root) { scopeOwnsInteractionRef.current = true; break; }
        current = current.parentNode;
      }
      if (!scopeOwnsInteractionRef.current) disarmNativeDrag();
    };
    if (!active) disarmNativeDrag();
    window.addEventListener('keydown', updateNativeDragArm, true);
    window.addEventListener('keyup', updateNativeDragArm, true);
    window.addEventListener('blur', disarmNativeDrag);
    window.addEventListener('pointerdown', updateOwnership, true);
    window.addEventListener('focusin', updateOwnership, true);
    return () => {
      window.removeEventListener('keydown', updateNativeDragArm, true);
      window.removeEventListener('keyup', updateNativeDragArm, true);
      window.removeEventListener('blur', disarmNativeDrag);
      window.removeEventListener('pointerdown', updateOwnership, true);
      window.removeEventListener('focusin', updateOwnership, true);
      disarmNativeDrag();
    };
  }, [active, setNativeDragArm]);
  useEffect(() => {
    if (pendingChildId || !activePortRef.current) return;
    const activePort = activePortRef.current;
    if (activePort.element.hasPointerCapture(activePort.pointerId)) activePort.element.releasePointerCapture(activePort.pointerId);
    activePortRef.current = null;
    reconnectEdgeRef.current = null;
    relationEditActiveRef.current = false;
    setPointerPoint(null);
    if (dragStateRef.current?.type === 'relation') changeDragState(null);
  }, [changeDragState, pendingChildId]);
  useEffect(() => () => {
    const cancelRelationEdit = relationEditActiveRef.current || dragStateRef.current?.type === 'relation';
    const activePort = activePortRef.current;
    if (activePort?.element.hasPointerCapture(activePort.pointerId)) activePort.element.releasePointerCapture(activePort.pointerId);
    activePortRef.current = null;
    const createVersionPort = createVersionPortRef.current;
    if (createVersionPort?.element.hasPointerCapture(createVersionPort.pointerId)) createVersionPort.element.releasePointerCapture(createVersionPort.pointerId);
    createVersionPortRef.current = null;
    reconnectEdgeRef.current = null;
    const areaResize = areaResizeRef.current;
    if (areaResize?.element.hasPointerCapture(areaResize.pointerId)) areaResize.element.releasePointerCapture(areaResize.pointerId);
    areaResizeRef.current = null;
    nativeFileDragRef.current = null;
    relationEditActiveRef.current = false;
    dragStateRef.current = null;
    if (cancelRelationEdit) {
      onHoverRelationParentRef.current?.(undefined);
      onCancelRelationEditRef.current?.();
    }
  }, []);
  const scopePath = normalizePath(activeRelativePath);
  const graph = useMemo(() => projectVisibleVersionGraph(progressFolders, graphEdges), [graphEdges, progressFolders]);
  const resolvedEntryMapping = useMemo(() => resolveVersionTreeEntryMapping({
    folders: graph.folders, entries, structureEntries, scopePath, projectRelativePath,
  }), [entries, graph.folders, projectRelativePath, scopePath, structureEntries]);
  const versionItems = resolvedEntryMapping.versionItems;
  const visibleIds = useMemo(() => new Set(versionItems.map(item => item.folder.id)), [versionItems]);
  const visibleEdges = useMemo(() => graph.edges.filter(edge => visibleIds.has(edge.parentId) && visibleIds.has(edge.childId)), [graph.edges, visibleIds]);
  const selectedPathSet = useMemo(() => new Set(selectedRelativePaths.map(normalizePath)), [selectedRelativePaths]);
  // Keep every untracked entry visible. Folders can still accept version
  // outputs, while ordinary files remain passive nodes in the Other area.
  const ordinaryEntries = resolvedEntryMapping.ordinaryEntries;
  const selectedNodeIds = useMemo(() => new Set([
    ...versionItems.filter(item => selectedPathSet.has(normalizePath(item.entry.relativePath))).map(item => `progress:${item.folder.id}`),
    ...ordinaryEntries.filter(entry => selectedPathSet.has(normalizePath(entry.relativePath))).map(entry => `entry:${normalizePath(entry.relativePath)}`),
  ]), [ordinaryEntries, selectedPathSet, versionItems]);

  const nodeWidth = Math.max(80, Math.round(gridIconSize));
  const nodeHeight = nodeWidth + 52;
  const { horizontalGap: defaultColumnGap, rowGap, auxiliaryGap, rootGap, padding: canvasPadding } = DEFAULT_VERSION_TREE_SPACING;
  const columnGap = Math.max(76, defaultColumnGap);
  const otherColumnGap = FILE_GRID_GAP;
  const defaultLayout = useMemo(() => {
    const itemById = new Map(versionItems.map(item => [item.folder.id, item]));
    const graphVersionItems = versionItems.filter(item => item.folder.nodeRole !== 'broll');
    const positioned: PositionedItem[] = [];
    const relations: LayoutRelation[] = [];
    let areaTop = 0;
    for (const mediaKind of ['image', 'video'] as const) {
      const mediaIds = new Set(graphVersionItems.filter(item => item.folder.mediaKind === mediaKind).map(item => item.folder.id));
      const forest = layoutVersionTree({
        nodes: graphVersionItems.filter(item => mediaIds.has(item.folder.id)).map(({ folder }) => ({ id: folder.id, mediaKind, nodeRole: folder.nodeRole, artifactKind: folder.artifactKind, sourceMetadata: folder.sourceMetadata, relationKind: folder.relationKind, createdAt: folder.createdAt })),
        edges: visibleEdges.filter(edge => mediaIds.has(edge.parentId) && mediaIds.has(edge.childId)).map(edge => ({ ...edge, id: edge.id || `${edge.parentId}:${edge.childId}:${edge.relationKind}` })),
        nodeWidth, nodeHeight, columnGap, rowGap, auxiliaryGap, rootGap,
      });
      const mediaNodes = forest.nodes.flatMap(node => {
        const item = itemById.get(node.id);
        return item ? [{ key: `entry:${normalizePath(item.entry.relativePath)}`, nodeKey: `progress:${node.id}`, areaKind: mediaKind, ...item, x: node.x, y: node.y + areaTop }] : [];
      });
      positioned.push(...mediaNodes);
      relations.push(...forest.edges.map(edge => ({ id: edge.id, kind: edge.relationKind, parentId: edge.parentId, childId: edge.childId, selectable: true })));
      const areaNodes = [...mediaNodes];
      if (areaNodes.length) areaTop = Math.max(...areaNodes.map(item => item.y + nodeHeight)) + rootGap + 12;
    }
    const graphBottom = positioned.length ? Math.max(...positioned.map(item => item.y + nodeHeight)) : 0;
    const otherTop = graphBottom ? graphBottom + rootGap + 12 : 0;
    // Keep loose folders in a compact horizontal shelf. They do not need the
    // wider column spacing reserved for relation arrows in the version graph.
    const brollItems = versionItems.filter(item => item.folder.nodeRole === 'broll');
    const otherEntries = ordinaryEntries;
    const otherItems = [
      ...brollItems.map(item => ({
        key: `entry:${normalizePath(item.entry.relativePath)}`,
        nodeKey: `progress:${item.folder.id}`,
        areaKind: 'other' as const,
        ...item,
      })),
      ...otherEntries.map(entry => ({
        key: `entry:${normalizePath(entry.relativePath)}`,
        nodeKey: `entry:${normalizePath(entry.relativePath)}`,
        areaKind: 'other' as const,
        entry,
      })),
    ];
    const otherColumns = Math.max(1, otherItems.length);
    positioned.push(...otherItems.map((item, index) => ({
      ...item,
      x: index % otherColumns * (nodeWidth + otherColumnGap),
      y: otherTop + Math.floor(index / otherColumns) * (nodeHeight + rowGap),
    })));
    return { positioned, relations };
  }, [auxiliaryGap, columnGap, nodeHeight, nodeWidth, ordinaryEntries, otherColumnGap, rootGap, rowGap, versionItems, visibleEdges]);
  const canvasNodes = useMemo(() => defaultLayout.positioned.map(item => ({ id: versionTreeCanvasItemId(item), nodeKey: item.nodeKey, fallbackNodeKeys: item.folder ? [item.key] : undefined, x: item.x, y: item.y })), [defaultLayout]);
  const canvas = useVersionTreeCanvas({
    active, nodes: canvasNodes,
    workspacePath, projectName, scopeKey: activeRelativePath, nodeWidth, nodeHeight, collisionHorizontalGap: otherColumnGap, coordinateScale: zoom, onNotice,
    selectedNodeIds, dragStateRef, onDragStateChange: changeDragState,
  });
  const layout = useMemo(() => {
    const positioned = defaultLayout.positioned.flatMap(item => {
      const position = canvas.positions.get(versionTreeCanvasItemId(item));
      return position ? [{ ...item, x: canvasPadding + position.x, y: canvasPadding + position.y }] : [];
    });
    const byId = new Map<string, PositionedItem>();
    positioned.forEach(item => { byId.set(item.key, item); if (item.folder) byId.set(item.folder.id, item); });
    const edges: DrawnEdge[] = defaultLayout.relations.flatMap(edge => {
      const parent = byId.get(edge.parentId);
      const child = byId.get(edge.childId);
      if (!parent || !child) return [];
      const geometry = versionTreeEdgeGeometry(
        { x: parent.x, y: parent.y, width: nodeWidth, height: nodeHeight },
        { x: child.x, y: child.y, width: nodeWidth, height: nodeHeight },
      );
      const directAssociation = edge.kind === 'media_companion' || edge.kind === 'derived_preview' || edge.kind === 'derived_transcode';
      const path = directAssociation
        ? `M ${geometry.start.x} ${geometry.start.y} L ${geometry.end.x} ${geometry.end.y}`
        : geometry.path;
      return [{ id: edge.id, kind: edge.kind, path, parentId: edge.selectable ? edge.parentId : undefined, childId: edge.selectable ? edge.childId : undefined, startX: geometry.start.x, startY: geometry.start.y, endX: geometry.end.x, endY: geometry.end.y, menuX: geometry.midpoint.x, menuY: geometry.midpoint.y }];
    });
    const bounds = versionTreeCanvasBounds(canvas.positions, nodeWidth, nodeHeight, canvasPadding);
    return { positioned, edges, width: bounds.width, height: bounds.height };
  }, [canvas.positions, canvasPadding, defaultLayout, nodeHeight, nodeWidth]);
  const incomingEdgesByChild = useMemo(() => {
    const incoming = new Map<string, DrawnEdge[]>();
    layout.edges.forEach(edge => {
      if (!edge.childId || !edge.parentId) return;
      const edges = incoming.get(edge.childId) || [];
      edges.push(edge);
      incoming.set(edge.childId, edges);
    });
    return incoming;
  }, [layout.edges]);
  const naturalAreaBands = useMemo(() => ([['image', t("ui.image.d24c10")], ['video', t("ui.video.c20f76")], ['other', t("legacy.d2909f1647e7")]] as const).flatMap(([areaKind, label]) => {
      const items = defaultLayout.positioned.filter(item => item.areaKind === areaKind);
      if (!items.length) return [];
      return [{
        areaKind, label,
        left: canvasPadding + Math.min(...items.map(item => item.x)),
        right: canvasPadding + Math.max(...items.map(item => item.x + nodeWidth)),
        top: canvasPadding + Math.min(...items.map(item => item.y)),
        bottom: canvasPadding + Math.max(...items.map(item => item.y + nodeHeight)),
      }];
    }), [getLocale(), canvasPadding, defaultLayout.positioned, nodeHeight, nodeWidth]);
  const areaBands = useMemo(() => naturalAreaBands.map(area => {
    const natural = { width: area.right - area.left, height: area.bottom - area.top };
    const requested = areaBandSizes[area.areaKind];
    // Keep the public area-size helper's explicit shrink contract. The tree
    // itself clamps its semantic frame to the current node bounds so a custom
    // size from an earlier graph cannot leave nodes outside their region.
    const custom = requested ? {
      width: Math.max(natural.width, requested.width),
      height: Math.max(natural.height, requested.height),
    } : undefined;
    const size = versionTreeAreaSize(
      natural,
      custom,
      { width: nodeWidth, height: nodeHeight },
    );
    return {
      ...area,
      right: area.left + size.width,
      bottom: area.top + size.height,
    };
  }), [areaBandSizes, naturalAreaBands, nodeHeight, nodeWidth]);
  const beginAreaResize = (event: ReactPointerEvent<HTMLSpanElement>, area: VersionTreeAreaBand, axis: 'x' | 'y' | 'both') => {
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    areaResizeRef.current = { element: event.currentTarget, pointerId: event.pointerId, areaKind: area.areaKind, axis, startX: event.clientX, startY: event.clientY, width: area.right - area.left, height: area.bottom - area.top };
  };
  const updateAreaResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = areaResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const scale = zoom > 0 ? zoom : 1;
    const deltaX = (event.clientX - resize.startX) / scale;
    const deltaY = (event.clientY - resize.startY) / scale;
    setAreaBandSizes(current => ({
      ...current,
      [resize.areaKind]: {
        width: Math.max(nodeWidth, resize.width + (resize.axis === 'y' ? 0 : deltaX)),
        height: Math.max(nodeHeight, resize.height + (resize.axis === 'x' ? 0 : deltaY)),
      },
    }));
  };
  const endAreaResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = areaResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (resize.element.hasPointerCapture(resize.pointerId)) resize.element.releasePointerCapture(resize.pointerId);
    areaResizeRef.current = null;
  };
  const framedLayoutWidth = Math.max(layout.width, ...areaBands.map(area => area.right + canvasPadding));
  const framedLayoutHeight = Math.max(layout.height, ...areaBands.map(area => area.bottom + canvasPadding));
  const fitView = useCallback(() => {
    const viewport = canvas.viewportRef.current;
    if (!viewport) return;
    const measuredWidth = Number(viewport.clientWidth);
    const measuredHeight = Number(viewport.clientHeight);
    const availableWidth = Number.isFinite(measuredWidth) && measuredWidth > 24 ? measuredWidth - 24 : Math.max(1, layout.width);
    const availableHeight = Number.isFinite(measuredHeight) && measuredHeight > 24 ? measuredHeight - 24 : Math.max(1, layout.height);
    const nextZoom = Math.max(.45, Math.min(1,
      availableWidth / Math.max(1, framedLayoutWidth),
      availableHeight / Math.max(1, framedLayoutHeight),
    ));
    setZoom(nextZoom);
    afterVersionTreePaint(canvas.resetViewport);
  }, [canvas.resetViewport, canvas.viewportRef, framedLayoutHeight, framedLayoutWidth, layout.height, layout.width]);
  const resetZoom = useCallback(() => {
    setZoom(1);
    afterVersionTreePaint(canvas.resetViewport);
  }, [canvas.resetViewport]);
  useLayoutEffect(() => {
    setZoom(1);
  }, [activeRelativePath, projectName, workspacePath]);
  const focusNode = useCallback((nodeKey: string) => {
    const viewport = canvas.viewportRef.current;
    const item = layout.positioned.find(candidate => candidate.key === nodeKey);
    if (!viewport || !item) return;
    viewport.scrollTo({
      left: Math.max(0, (item.x + nodeWidth / 2) * zoom - viewport.clientWidth / 2),
      top: Math.max(0, (item.y + nodeHeight / 2) * zoom - viewport.clientHeight / 2),
      behavior: 'smooth',
    });
    setSelectedNodeKey(nodeKey);
  }, [canvas.viewportRef, layout.positioned, nodeHeight, nodeWidth, zoom]);
  useEffect(() => {
    const viewport = canvas.viewportRef.current;
    if (!viewport) return;
    let previousScrollTop = viewport.scrollTop;
    const updateBounds = () => {
      const nextScrollTop = viewport.scrollTop;
      if (nextScrollTop > 1) onViewportScrollChange?.(true);
      else if (nextScrollTop < previousScrollTop) onViewportScrollChange?.(false);
      previousScrollTop = nextScrollTop;
      setViewportBounds(current => {
        const next = {
          left: viewport.scrollLeft / zoom,
          top: viewport.scrollTop / zoom,
          width: (viewport.clientWidth || 1600) / zoom,
          height: (viewport.clientHeight || 1000) / zoom,
        };
        return current.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height
          ? current
          : next;
      });
    };
    const updateHeaderForWheel = (event: WheelEvent) => {
      if (event.deltaY > 0) onViewportScrollChange?.(true);
      else if (event.deltaY < 0 && viewport.scrollTop <= 1) onViewportScrollChange?.(false);
    };
    updateBounds();
    viewport.addEventListener('scroll', updateBounds, { passive: true });
    viewport.addEventListener('wheel', updateHeaderForWheel, { passive: true });
    window.addEventListener('resize', updateBounds);
    return () => { viewport.removeEventListener('scroll', updateBounds); viewport.removeEventListener('wheel', updateHeaderForWheel); window.removeEventListener('resize', updateBounds); };
  }, [canvas.layoutReady, canvas.viewportRef, onViewportScrollChange, zoom]);
  const refreshStandardLayout = useCallback(async () => {
    const refreshed = await canvas.refreshLayout();
    if (refreshed) {
      setAreaBandSizes({});
      resetZoom();
    }
    return refreshed;
  }, [canvas.refreshLayout, resetZoom]);
  useEffect(() => {
    if (!onCanvasControllerChange) return;
    if (!active) {
      onCanvasControllerChange(null);
      return;
    }
    onCanvasControllerChange({ hasManualLayout: canvas.hasManualLayout, refreshLayout: refreshStandardLayout, fitView, resetZoom, undoLayout: canvas.undoLayout, redoLayout: canvas.redoLayout });
    return () => onCanvasControllerChange(null);
  }, [active, canvas.hasManualLayout, canvas.redoLayout, canvas.undoLayout, fitView, onCanvasControllerChange, refreshStandardLayout, resetZoom]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!active || !scopeOwnsInteractionRef.current || event.defaultPrevented || isEditableShortcutTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey && canRedoRelation) onRedoRelation?.();
        else if (!event.shiftKey && canUndoRelation) onUndoRelation?.();
        else void (event.shiftKey ? canvas.redoLayout() : canvas.undoLayout());
      } else if (event.key === 'Home') {
        event.preventDefault();
        fitView();
      } else if ((event.key.toLocaleLowerCase() === 'f' || event.key === 'Decimal') && selectedNodeKey) {
        event.preventDefault();
        focusNode(selectedNodeKey);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, canRedoRelation, canUndoRelation, canvas.redoLayout, canvas.undoLayout, fitView, focusNode, onRedoRelation, onUndoRelation, selectedNodeKey]);

  const visibleFolderById = useMemo(() => new Map(versionItems.map(item => [item.folder.id, item.folder])), [versionItems]);
  const mutatingIds = useMemo(() => new Set(mutatingChildIds), [mutatingChildIds]);
  const graphEdgeById = useMemo(() => new Map(graphEdges.map(edge => [edge.id, edge])), [graphEdges]);
  const graphAdjacency = useMemo(() => {
    const adjacency = new Map<string, Array<{ childId: string; edgeId?: string }>>();
    graph.edges.forEach(edge => {
      const children = adjacency.get(edge.parentId) || [];
      children.push({ childId: edge.childId, edgeId: edge.id });
      adjacency.set(edge.parentId, children);
    });
    return adjacency;
  }, [graph.edges]);
  const relationWouldCycle = (sourceId: string, targetId: string, ignoredEdgeId?: string) => {
    const stack = [targetId];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === sourceId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const candidate of graphAdjacency.get(current) || []) {
        if (ignoredEdgeId && candidate.edgeId === ignoredEdgeId) continue;
        stack.push(candidate.childId);
      }
    }
    return false;
  };
  const validRelationKinds = (sourceId: string, targetId: string, ignoredEdgeId?: string) => {
    const source = visibleFolderById.get(sourceId);
    const target = visibleFolderById.get(targetId);
    if (!source || !target) return [];
    return allowedVersionTreeRelationKinds(source, target).filter(kind => {
      if ((kind === 'main' || kind === 'auxiliary') && progressRelationChangeError(graph.folders, target.id, source.id)) return false;
      if (relationWouldCycle(source.id, target.id, ignoredEdgeId)) return false;
      return !graph.edges.some(edge => edge.id !== ignoredEdgeId && edge.parentId === source.id && edge.childId === target.id && edge.relationKind === kind);
    });
  };
  const supplementalRelationError = (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>, sourceId: string) => {
    const source = visibleFolderById.get(sourceId);
    const target = visibleFolderById.get(edge.targetProgressId);
    if (!source || !target) return '候选节点不在当前版本树中';
    if (source.id === target.id) return '节点不能连接到自己';
    if (source.projectId !== target.projectId) return '节点不属于同一个项目';
    if (source.mediaKind !== target.mediaKind) return '图片和视频节点不能互相连接';
    if (!allowedVersionTreeRelationKinds(source, target).includes(edge.edgeKind)) return '节点角色不符合这类补充关系';
    if (relationWouldCycle(source.id, target.id, edge.id)) return '该连接会形成循环';
    return graph.edges.some(candidate => candidate.id !== edge.id && candidate.parentId === source.id && candidate.childId === target.id && candidate.relationKind === edge.edgeKind)
      ? '相同关系已经存在'
      : '';
  };
  const relationError = (childId: string, parentId: string | null) => {
    const reconnectEdge = reconnectEdgeRef.current;
    if (reconnectEdge && parentId) return supplementalRelationError(reconnectEdge, parentId);
    if (!parentId) return progressRelationChangeError(graph.folders, childId, null);
    const source = visibleFolderById.get(parentId);
    const target = visibleFolderById.get(childId);
    if (!source || !target) return '候选节点不在当前版本树中';
    if (source.id === target.id) return '节点不能连接到自己';
    if (source.projectId !== target.projectId) return '节点不属于同一个项目';
    if (source.mediaKind !== target.mediaKind) return '图片和视频节点不能互相连接';
    return validRelationKinds(parentId, childId).length ? '' : '节点角色不允许建立关系';
  };
  const updatePointerCandidate = (clientX: number, clientY: number, currentTarget: Element) => {
    const canvas = currentTarget.closest<HTMLElement>('[data-version-tree-canvas]');
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    setPointerPoint({ x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom });
    const candidate = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-relation-parent-id]')?.dataset.relationParentId;
    onHoverRelationParent?.(candidate || undefined);
    return candidate;
  };
  const beginRelationDrag = (event: ReactPointerEvent<Element>, childProgressId: string, point: { x: number; y: number }, reconnectEdge?: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => {
    if (!active || dragStateRef.current || mutatingIds.has(childProgressId)) return false;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePortRef.current = { element: event.currentTarget, pointerId: event.pointerId, childId: childProgressId };
    reconnectEdgeRef.current = reconnectEdge || null;
    relationEditActiveRef.current = true;
    changeDragState({ type: 'relation', childProgressId, pointerId: event.pointerId });
    onBeginRelationEdit?.(childProgressId);
    setPointerPoint(point);
    return true;
  };
  const endRelationDrag = (event: ReactPointerEvent<Element>, childProgressId: string) => {
    if (activePortRef.current?.pointerId !== event.pointerId || dragStateRef.current?.type !== 'relation') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const reconnectEdge = reconnectEdgeRef.current;
    activePortRef.current = null;
    reconnectEdgeRef.current = null;
    changeDragState(null);
    finishPointerRelation(event.clientX, event.clientY, childProgressId, reconnectEdge);
  };
  const cancelRelationDrag = (event: ReactPointerEvent<Element>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    activePortRef.current = null;
    reconnectEdgeRef.current = null;
    changeDragState(null);
    setPointerPoint(null);
    cancelRelationSelection();
  };
  const updateCreateVersionTarget = (clientX: number, clientY: number, currentTarget: Element) => {
    const canvasElement = currentTarget.closest<HTMLElement>('[data-version-tree-canvas]');
    if (!canvasElement) return '';
    const rect = canvasElement.getBoundingClientRect();
    setPointerPoint({ x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom });
    const targetKey = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-version-output-target-key]')?.dataset.versionOutputTargetKey || '';
    setCreateVersionTargetKey(targetKey);
    return targetKey;
  };
  const beginCreateVersionDrag = (event: ReactPointerEvent<Element>, sourceProgressId: string, point: { x: number; y: number }) => {
    if (!active || dragStateRef.current || mutatingIds.has(sourceProgressId)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    createVersionPortRef.current = { element: event.currentTarget, pointerId: event.pointerId, sourceId: sourceProgressId };
    changeDragState({ type: 'create-version', sourceProgressId, pointerId: event.pointerId });
    setCreateVersionTargetKey('');
    setPointerPoint(point);
  };
  const endCreateVersionDrag = (event: ReactPointerEvent<Element>, sourceProgressId: string) => {
    if (createVersionPortRef.current?.pointerId !== event.pointerId || dragStateRef.current?.type !== 'create-version') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const targetKey = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-version-output-target-key]')?.dataset.versionOutputTargetKey || '';
    createVersionPortRef.current = null;
    changeDragState(null);
    setPointerPoint(null);
    setCreateVersionTargetKey('');
    const source = visibleFolderById.get(sourceProgressId);
    const targetItem = layout.positioned.find(item => item.key === targetKey);
    if (!source) return;
    if (!targetItem || targetItem.key === sourceProgressId) {
      if (source.nodeRole === 'progress') setBlankOutputSourceId(source.id);
      return;
    }
    if (!targetItem.folder) {
      if ((source.nodeRole === 'original' || source.nodeRole === 'progress') && isVersionFolderEntry(targetItem.entry)) onRequestCreateVersion?.(source, targetItem.entry);
      else onNotice('只有原始素材或版本进度可以向普通文件夹创建下一版本', 4000);
      return;
    }
    const kinds = validRelationKinds(source.id, targetItem.folder.id);
    if (kinds.length === 1) submitNewRelation(source.id, targetItem.folder.id, kinds[0]);
    else if (kinds.length > 1) {
      relationEditActiveRef.current = true;
      setRelationChoice({ sourceId: source.id, targetId: targetItem.folder.id, kinds });
    }
    else onNotice('这两个节点的类型不允许建立关系', 4000);
  };
  const cancelCreateVersionDrag = (event: ReactPointerEvent<Element>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    createVersionPortRef.current = null;
    changeDragState(null);
    setPointerPoint(null);
    setCreateVersionTargetKey('');
  };
  const submitNewRelation = (sourceId: string, targetId: string, kind: VersionTreeEdgeKind) => {
    relationEditActiveRef.current = false;
    setRelationChoice(null);
    if (kind === 'main' || kind === 'auxiliary') {
      onRequestRelationChange?.(targetId, sourceId);
      return;
    }
    if (isSupplementalVersionTreeEdgeKind(kind)) {
      if (onRequestSupplementalEdgeCreate) onRequestSupplementalEdgeCreate(sourceId, targetId, kind);
      else {
        onNotice(`当前页面无法创建${versionTreeRelationLabel(kind)}关系`, 5000);
        onCancelRelationEdit?.();
      }
    }
  };
  function finishPointerRelation(clientX: number, clientY: number, childId: string, reconnectEdge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'> | null) {
    const candidate = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-relation-parent-id]')?.dataset.relationParentId;
    setPointerPoint(null);
    onHoverRelationParent?.(undefined);
    const error = candidate && reconnectEdge ? supplementalRelationError(reconnectEdge, candidate) : relationError(childId, candidate || null);
    if (candidate && !error && reconnectEdge) {
      relationEditActiveRef.current = false;
      if (onRequestSupplementalEdgeReconnect) onRequestSupplementalEdgeReconnect(reconnectEdge, candidate);
      else {
        onNotice(`当前页面无法重连${versionTreeRelationLabel(reconnectEdge.edgeKind)}关系`, 5000);
        onCancelRelationEdit?.();
      }
    }
    else if (candidate && !error) {
      const kinds = validRelationKinds(candidate, childId);
      if (kinds.length === 1) submitNewRelation(candidate, childId, kinds[0]);
      else if (kinds.length > 1) {
        relationEditActiveRef.current = true;
        setRelationChoice({ sourceId: candidate, targetId: childId, kinds });
      } else {
        relationEditActiveRef.current = false;
        onCancelRelationEdit?.();
      }
    } else {
      relationEditActiveRef.current = false;
      onCancelRelationEdit?.();
    }
  }
  const activeRelationChildId = pendingChildId || (dragState?.type === 'relation' ? dragState.childProgressId : undefined);
  const pendingPosition = activeRelationChildId ? layout.positioned.find(item => item.folder?.id === activeRelationChildId) : undefined;
  const createVersionSourceId = dragState?.type === 'create-version' ? dragState.sourceProgressId : undefined;
  const createVersionSourcePosition = createVersionSourceId ? layout.positioned.find(item => item.folder?.id === createVersionSourceId) : undefined;
  const selectedEdge = layout.edges.find(edge => edge.id === selectedEdgeId && edge.childId && edge.parentId);
  const selectedChild = selectedEdge?.childId ? visibleFolderById.get(selectedEdge.childId) : undefined;
  const selectedParent = selectedEdge?.parentId ? visibleFolderById.get(selectedEdge.parentId) : undefined;
  const selectedBusy = Boolean(selectedChild && mutatingIds.has(selectedChild.id));
  const selectedEdgeIsSupplemental = Boolean(selectedEdge && isSupplementalVersionTreeEdgeKind(selectedEdge.kind));
  const selectedSupplementalEdge = selectedEdgeIsSupplemental && selectedEdge
    ? graphEdgeById.get(selectedEdge.id)
    : undefined;
  const beginSelectedEdgeReconnect = (event: ReactPointerEvent<Element>, edge: DrawnEdge) => {
    if (isSupplementalVersionTreeEdgeKind(edge.kind) && !selectedSupplementalEdge) {
      event.preventDefault();
      event.stopPropagation();
      onNotice('没有找到要重连的补充关系，请刷新后重试', 5000);
      return;
    }
    beginRelationDrag(event, edge.childId!, { x: edge.endX, y: edge.endY }, selectedSupplementalEdge);
  };
  const selectedDeletionError = selectedChild && !selectedEdgeIsSupplemental ? relationError(selectedChild.id, null) : '';
  const requestEdgeDeletion = useCallback((edge: DrawnEdge) => {
    if (!edge.childId) return;
    const child = visibleFolderById.get(edge.childId);
    if (!child || mutatingIds.has(child.id)) return;
    if (isSupplementalVersionTreeEdgeKind(edge.kind)) {
      const supplemental = graphEdgeById.get(edge.id);
      if (supplemental) onRequestSupplementalEdgeDelete?.(supplemental);
      else onNotice('没有找到要删除的补充关系，请刷新后重试', 5000);
      return;
    }
    const error = progressRelationChangeError(graph.folders, child.id, null);
    if (error) { onNotice(error, 5000); return; }
    onRequestRelationChange?.(child.id, null);
  }, [graph.folders, graphEdgeById, mutatingIds, onNotice, onRequestRelationChange, onRequestSupplementalEdgeDelete, visibleFolderById]);
  const requestSelectedEdgeDeletion = () => {
    if (!selectedEdge || !selectedChild || selectedBusy) return;
    requestEdgeDeletion(selectedEdge);
  };
  useEffect(() => {
    if (selectedEdgeId && !layout.edges.some(edge => edge.id === selectedEdgeId)) setSelectedEdgeId('');
  }, [layout.edges, selectedEdgeId]);
  useEffect(() => {
    if (!selectedEdge) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!active || !scopeOwnsInteractionRef.current || event.defaultPrevented || isEditableShortcutTarget(event.target)) return;
      if (event.key === 'Escape') {
        setSelectedEdgeId('');
        onCancelRelationEdit?.();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedChild && !selectedBusy) {
        event.preventDefault();
        requestEdgeDeletion(selectedEdge);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, onCancelRelationEdit, requestEdgeDeletion, selectedBusy, selectedChild, selectedEdge]);
  const selectEdge = (edge: DrawnEdge) => {
    if (!edge.childId || !edge.parentId) return;
    setSelectedEdgeId(edge.id);
  };
  function cancelRelationSelection() {
    relationEditActiveRef.current = false;
    setSelectedEdgeId('');
    onCancelRelationEdit?.();
  }
  const removeNodeInput = (folder: ProgressFolder) => {
    const incoming = incomingEdgesByChild.get(folder.id) || [];
    const edge = incoming.find(candidate => candidate.kind === 'main' || candidate.kind === 'auxiliary') || incoming[0];
    if (!edge) {
      onNotice('该节点当前没有可断开的输入连接');
      return;
    }
    if (isSupplementalVersionTreeEdgeKind(edge.kind)) {
      const supplemental = graphEdgeById.get(edge.id);
      if (supplemental) onRequestSupplementalEdgeDelete?.(supplemental);
      else onNotice('没有找到要断开的补充关系，请刷新后重试');
      return;
    }
    const error = progressRelationChangeError(graph.folders, folder.id, null);
    if (error) {
      onNotice(error, 5000);
      return;
    }
    onRequestRelationChange?.(folder.id, null);
  };
  const hasGraphItems = layout.positioned.length > 0;
  const renderedItems = layout.positioned.filter(item => item.folder || item.x + nodeWidth >= viewportBounds.left - 500 && item.x <= viewportBounds.left + viewportBounds.width + 500 && item.y + nodeHeight >= viewportBounds.top - 500 && item.y <= viewportBounds.top + viewportBounds.height + 500);
  return <div ref={nativeDragScopeRef} onPointerDownCapture={() => { scopeOwnsInteractionRef.current = active; }} onFocusCapture={() => { scopeOwnsInteractionRef.current = active; }} className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
    {!canvas.layoutReady && <div role="status" aria-live="polite" className="flex h-full min-h-[360px] flex-col items-center justify-center gap-3 border-y border-slate-200 text-sm text-slate-500"><span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600"/><span>{t("ui.restoring.version.tree.layout.c198b8")}</span></div>}
    {canvas.layoutReady && <>
    {graph.cycleNodeIds.length > 0 && <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{t("message.83b4003c77ee", { value0: graph.cycleNodeIds.join('、') })}</div>}
    {relationChoice && <div role="dialog" aria-modal="true" aria-label={t("ui.choose.relationship.type.384ef6")} className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4"><section className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"><h3 className="font-bold text-slate-800">{t("ui.choose.relationship.type.384ef6")}</h3><p className="mt-1 text-xs text-slate-500">{t("ui.these.nodes.support.multiple.relationship.types.444d4d")}</p><div className="mt-4 grid gap-2">{relationChoice.kinds.map(kind => <button key={kind} type="button" onClick={() => submitNewRelation(relationChoice.sourceId, relationChoice.targetId, kind)} className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-blue-400 hover:bg-blue-50">{versionTreeRelationLabel(kind)}</button>)}</div><button type="button" onClick={() => { relationEditActiveRef.current = false; setRelationChoice(null); onCancelRelationEdit?.(); }} className="mt-3 w-full rounded px-3 py-2 text-sm text-slate-500 hover:bg-slate-100">{t("common.cancel")}</button></section></div>}
    {blankOutputSourceId && <div role="dialog" aria-modal="true" aria-label={t("ui.create.a.node.from.this.output.10b831")} className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/40 p-4"><section className="w-full max-w-xs rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"><h3 className="font-bold text-slate-800">{t("message.cfd4f52b6e59", { value0: visibleFolderById.get(blankOutputSourceId)?.versionKey })}</h3><p className="mt-1 text-xs text-slate-500">{t("ui.drop.an.output.connection.on.an.90a282")}</p><div className="mt-4 grid gap-2"><button type="button" onClick={() => { const source = visibleFolderById.get(blankOutputSourceId); setBlankOutputSourceId(''); if (source) onRequestCreateEmptyVersion?.(source, false); }} className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-left text-sm font-semibold text-blue-700">{t("ui.create.next.version.69b80f")}</button><button type="button" onClick={() => { const source = visibleFolderById.get(blankOutputSourceId); setBlankOutputSourceId(''); if (source) onRequestCreateEmptyVersion?.(source, true); }} className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-700">{t("ui.create.tracked.version.branch.44f1b8")}</button></div><button type="button" onClick={() => setBlankOutputSourceId('')} className="mt-3 w-full rounded px-3 py-2 text-sm text-slate-500 hover:bg-slate-100">{t("common.cancel")}</button></section></div>}
      {hasGraphItems && <div className="relative min-h-0 flex-1"><div ref={canvas.viewportRef} data-version-tree-viewport="true" className="h-full min-h-[360px] overflow-auto"><div className="relative min-h-full min-w-full" style={{ width: framedLayoutWidth * zoom, height: Math.max(360, framedLayoutHeight * zoom, viewportBounds.height * zoom) }}><div data-version-tree-canvas="true" data-drag-state={dragState?.type} onPointerDown={event => { canvas.canvasPointerHandlers.onPointerDown(event); if (!(event.target as Element).closest('[data-version-tree-node],[data-edge-id],button')) { cancelRelationSelection(); setSelectedNodeKey(''); } }} onPointerMove={canvas.canvasPointerHandlers.onPointerMove} onPointerUp={canvas.canvasPointerHandlers.onPointerUp} onPointerCancel={canvas.canvasPointerHandlers.onPointerCancel} className={`absolute left-0 top-0 ${dragState?.type === 'pan' ? 'cursor-grabbing' : 'cursor-default'}`} style={{ width: framedLayoutWidth, height: framedLayoutHeight, minWidth: `${100 / zoom}%`, minHeight: Math.max(360 / zoom, viewportBounds.height), touchAction: 'none', transform: `scale(${zoom})`, transformOrigin: 'left top', backgroundImage: 'radial-gradient(circle, rgb(148 163 184 / 0.025) 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
      {areaBands.map(area => <div key={area.areaKind} aria-label={t("ui.value0.area.51b5fe", { value0: area.label })} className={`pointer-events-none absolute rounded-2xl border ${area.areaKind === 'image' ? 'border-sky-300/30 bg-sky-500/[0.035]' : area.areaKind === 'video' ? 'border-violet-300/30 bg-violet-500/[0.035]' : 'border-slate-300/40 bg-slate-500/[0.035]'}`} style={{ left: area.left - 16, top: area.top - 28, width: area.right - area.left + 32, height: area.bottom - area.top + 44 }}><span className={`absolute left-3 top-2 px-1 text-[10px] font-semibold tracking-[0.16em] ${area.areaKind === 'image' ? 'text-sky-600/70' : area.areaKind === 'video' ? 'text-violet-600/70' : 'text-slate-600/65'}`}>{area.label} · {defaultLayout.positioned.filter(item => item.areaKind === area.areaKind).length}</span><span role="separator" aria-orientation="vertical" aria-label={t("ui.resize.value0.area.width.1f3d37", { value0: area.label })} title={t("ui.drag.to.resize.width.b51545")} onPointerDown={event => beginAreaResize(event, area, 'x')} onPointerMove={updateAreaResize} onPointerUp={endAreaResize} onPointerCancel={endAreaResize} className="pointer-events-auto absolute -right-1 top-8 bottom-3 z-30 w-2 cursor-ew-resize bg-transparent"/><span role="separator" aria-orientation="horizontal" aria-label={t("ui.resize.value0.area.height.176870", { value0: area.label })} title={t("ui.drag.to.resize.height.7fc4ca")} onPointerDown={event => beginAreaResize(event, area, 'y')} onPointerMove={updateAreaResize} onPointerUp={endAreaResize} onPointerCancel={endAreaResize} className="pointer-events-auto absolute -bottom-1 left-3 right-3 z-30 h-2 cursor-ns-resize bg-transparent"/><span role="separator" aria-label={t("ui.resize.value0.area.91a3ea", { value0: area.label })} title={t("ui.drag.to.resize.6cf289")} onPointerDown={event => beginAreaResize(event, area, 'both')} onPointerMove={updateAreaResize} onPointerUp={endAreaResize} onPointerCancel={endAreaResize} className="pointer-events-auto absolute -bottom-2 -right-2 z-30 h-5 w-5 cursor-nwse-resize bg-transparent"/></div>)}
      <svg aria-label={t("ui.version.relationship.cc3afc")} className="absolute inset-0 z-10 h-full w-full overflow-visible"><defs><marker id={arrowMarkerId} markerWidth="8" markerHeight="8" refX="0" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke"/></marker></defs>{layout.edges.map(edge => { const presentation = versionTreeEdgePresentation(edge.kind, selectedEdgeId === edge.id); const directAssociation = edge.kind === 'media_companion' || edge.kind === 'derived_preview' || edge.kind === 'derived_transcode'; return <g key={edge.id}>
        <path data-edge-id={edge.id} data-relation-kind={edge.kind} role={edge.childId ? 'button' : undefined} tabIndex={edge.childId ? 0 : undefined} aria-label={edge.childId ? t("ui.select.value0.relationship.4e0a05", { value0: versionTreeRelationLabel(edge.kind) }) : undefined} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); selectEdge(edge); }} onClick={event => { event.stopPropagation(); selectEdge(edge); }} onKeyDown={event => { if (!event.defaultPrevented && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectEdge(edge); } }} d={edge.path} fill="none" stroke="transparent" strokeWidth="14" pointerEvents="stroke" className={edge.childId ? 'cursor-pointer' : undefined}/>
        <path aria-hidden data-relation-kind={edge.kind} d={edge.path} fill="none" stroke={presentation.stroke} strokeWidth={presentation.strokeWidth} opacity={presentation.opacity} markerEnd={directAssociation ? undefined : `url(#${arrowMarkerId})`} pointerEvents="none"/>
        {selectedEdgeId === edge.id && edge.childId && !mutatingIds.has(edge.childId) && <circle data-edge-child-handle={edge.childId} role="button" tabIndex={0} aria-label={t("ui.drag.the.value0.endpoint.to.reconnect.7041cd", { value0: versionTreeRelationLabel(edge.kind) })} cx={edge.endX} cy={edge.endY} r="7" fill="white" stroke="#2563eb" strokeWidth="2" className="cursor-grab" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={event => beginSelectedEdgeReconnect(event, edge)} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePointerCandidate(event.clientX, event.clientY, event.currentTarget); }} onPointerUp={event => endRelationDrag(event, edge.childId!)} onPointerCancel={cancelRelationDrag}/>} {null}
      </g>; })}{pendingPosition && pointerPoint && <path d={versionTreeEdgePath(pendingPosition.x, pendingPosition.y + nodeHeight / 2, pointerPoint.x, pointerPoint.y)} fill="none" stroke={hoverParentId && activeRelationChildId && relationError(activeRelationChildId, hoverParentId) ? '#ef4444' : '#2563eb'} strokeWidth="2" pointerEvents="none"/>}{createVersionSourcePosition && pointerPoint && <path d={versionTreeEdgePath(createVersionSourcePosition.x + nodeWidth, createVersionSourcePosition.y + nodeHeight / 2, pointerPoint.x, pointerPoint.y)} fill="none" stroke={createVersionTargetKey ? '#10b981' : '#2563eb'} strokeWidth="2" pointerEvents="none"/>}</svg>
      {selectedEdge && selectedChild && selectedParent && <div role="status" style={{ left: selectedEdge.menuX, top: selectedEdge.menuY }} className="absolute z-30 flex -translate-x-1/2 -translate-y-1/2 flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-600 shadow-lg">
        <span>{t("message.f6cc76dfe92b", { value0: selectedParent.displayName })}</span><span>{t("message.9b1bcb318b9c", { value0: selectedChild.displayName })}</span><span>{t("message.6bfbadb294bc", { value0: versionTreeRelationLabel(selectedEdge.kind) })}</span>
        <button type="button" onClick={requestSelectedEdgeDeletion} disabled={selectedBusy || Boolean(selectedDeletionError)} title={selectedDeletionError || (selectedEdgeIsSupplemental ? t("ui.remove.the.value0.relationship.without.changing.31cfae", { value0: versionTreeRelationLabel(selectedEdge.kind) }) : t("ui.remove.structural.relationship.and.make.an.5f63d6"))} className="rounded bg-red-50 px-2.5 py-1 text-red-700 disabled:cursor-not-allowed disabled:opacity-40">{t("ui.remove.relationship.738c6d")}</button>
        <button type="button" onClick={cancelRelationSelection} className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100">{t("common.close")}</button>
        {selectedChild.nodeRole === 'selection' && <span className="text-violet-600">{t("ui.selection.relationships.can.only.change.their.bb34e5")}</span>}
      </div>}
      {renderedItems.map(item => {
        const nodeHandlers = canvas.nodePointerHandlers(versionTreeCanvasItemId(item));
        const canBeParent = Boolean(item.folder && !item.folder.folderMissing
          && (item.folder.nodeRole === 'original' && !item.folder.artifactKind
            || ['selection', 'workflow'].includes(item.folder.nodeRole)
            || item.folder.nodeRole === 'progress' && item.folder.parentProgressId && item.folder.relationKind === 'main'));
        const hasInputRelation = Boolean(item.folder && incomingEdgesByChild.has(item.folder.id));
        const canAcceptInput = Boolean(item.folder && (['progress', 'selection', 'artifact', 'workflow'].includes(item.folder.nodeRole)
          || item.folder.nodeRole === 'original' && item.folder.artifactKind));
        const createVersionTarget = !item.folder && isVersionFolderEntry(item.entry) && (!item.entry.viaShortcut);
        const candidateError = item.folder && activeRelationChildId ? relationError(activeRelationChildId, item.folder.id) : '';
        const candidateHovered = Boolean(item.folder && activeRelationChildId && hoverParentId === item.folder.id);
        const candidateColor = !activeRelationChildId
          ? 'bg-violet-600'
          : candidateHovered && candidateError
            ? 'bg-red-600'
            : candidateError
              ? 'bg-slate-300'
              : candidateHovered
                ? 'bg-emerald-500'
                : 'bg-blue-600';
        return <div key={versionTreeReactKey(item)} {...nodeHandlers} draggable={active && nativeDragArmed && Boolean(onStartFileDrag)} data-version-tree-node="true" data-native-drag-armed={active && nativeDragArmed ? 'true' : undefined} data-version-progress-id={item.folder?.id} data-version-output-target-key={createVersionTarget || item.folder && item.folder.nodeRole !== 'broll' ? item.key : undefined} onPointerDownCapture={event => {
          if (!active) return;
          setSelectedNodeKey(item.key);
          if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || !onStartFileDrag || (event.target as Element).closest('button,input,select,textarea,[data-version-tree-port]')) return;
          nativeFileDragRef.current = { nodeKey: item.key, pointerId: event.pointerId };
          // Ctrl-drag belongs to the OS file-drag path. Do not let the canvas
          // node handler claim this pointer and persist a new layout position.
          event.stopPropagation();
        }} onPointerUpCapture={event => {
          const nativeDrag = nativeFileDragRef.current;
          if (!nativeDrag || nativeDrag.nodeKey !== item.key || nativeDrag.pointerId !== event.pointerId) return;
          nativeFileDragRef.current = null;
        }} onPointerCancelCapture={event => {
          const nativeDrag = nativeFileDragRef.current;
          if (!nativeDrag || nativeDrag.nodeKey !== item.key || nativeDrag.pointerId !== event.pointerId) return;
          nativeFileDragRef.current = null;
        }} onDragStart={event => {
          const nativeDrag = nativeFileDragRef.current;
          if (!nativeDrag || nativeDrag.nodeKey !== item.key || !onStartFileDrag) { event.preventDefault(); return; }
          event.stopPropagation();
          try { onStartFileDrag(event, item.entry); }
          finally {
            // Electron owns the drag after startProjectFileDrag is sent and a
            // cancelled HTML drag is not guaranteed to emit dragend.
            nativeFileDragRef.current = null;
          }
        }} onDragEnd={() => {
          nativeFileDragRef.current = null;
        }} onFocusCapture={() => setSelectedNodeKey(item.key)} onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
          onRequestEntryContextMenu?.(event, item.entry);
        }} className={`group/version-node absolute z-20 cursor-grab rounded-xl active:cursor-grabbing ${createVersionTargetKey === item.key ? 'ring-2 ring-emerald-400 ring-offset-2' : ''}`} data-node-role={item.folder?.nodeRole} data-tracking-label={item.folder ? trackingStateLabel(item.folder) : undefined} style={{ left: item.x, top: item.y, width: nodeWidth, minHeight: nodeHeight, touchAction: 'none' }}>
        {renderEntry(item.entry, item.folder, item.sourceKind)}
        {item.folder && <>
          {canAcceptInput && <button type="button" data-version-tree-port="true" disabled={mutatingIds.has(item.folder.id)} aria-label={hasInputRelation ? t("ui.disconnect.the.input.of.value0.901866", { value0: item.folder.displayName }) : t("ui.value0.is.waiting.for.an.input.3724de", { value0: item.folder.displayName })} title={mutatingIds.has(item.folder.id) ? t("ui.updating.relationship.df8f36") : hasInputRelation ? t("ui.click.to.disconnect.only.the.left.81e4b4") : t("ui.empty.input.drag.from.the.source.004b6e")} onPointerDown={event => { if (!active || event.button !== 0) return; event.preventDefault(); event.stopPropagation(); if (hasInputRelation) removeNodeInput(item.folder!); else onNotice('左侧触点只用于断开已有连接；请从来源节点右侧拖出新线。'); }} onClick={event => { event.preventDefault(); event.stopPropagation(); }} className="absolute -left-2.5 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity group-hover/version-node:opacity-100 group-focus-within/version-node:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"><span aria-hidden className={`h-2.5 w-2.5 rounded-full border-2 shadow ${hasInputRelation ? 'border-white bg-red-500' : 'border-slate-400 bg-white'}`}/></button>}
          {canBeParent && <button type="button" data-version-tree-port="true" data-relation-parent-id={item.folder.id} aria-label={t("ui.drag.a.connection.from.value0.ea867f", { value0: item.folder.displayName })} title={activeRelationChildId ? candidateError || t("ui.can.connect.6043b9") : item.folder.nodeRole === 'progress' ? t("ui.drop.onto.an.ordinary.folder.to.68c4ea") : t("ui.drag.from.the.right.output.to.beb6dd")} onPointerDown={event => beginCreateVersionDrag(event, item.folder!.id, { x: item.x + nodeWidth, y: item.y + nodeHeight / 2 })} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateCreateVersionTarget(event.clientX, event.clientY, event.currentTarget); }} onPointerUp={event => endCreateVersionDrag(event, item.folder!.id)} onPointerCancel={cancelCreateVersionDrag} className="absolute -right-2.5 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity group-hover/version-node:opacity-100 group-focus-within/version-node:opacity-100 focus:opacity-100"><span aria-hidden className={`h-2.5 w-2.5 rounded-full border-2 border-white shadow ${candidateColor}`}/>{candidateHovered && candidateError && <span role="tooltip" className="pointer-events-none absolute left-5 top-1/2 z-40 -translate-y-1/2 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-[10px] font-medium text-white shadow-lg"><LocalizedText value={candidateError}/></span>}</button>}
        </>}
      </div>; })}
    </div></div></div>
      <button type="button" onClick={fitView} title={t("ui.minimap.click.to.show.all.5149c2")} className="fixed bottom-4 right-4 z-[120] h-20 w-36 overflow-hidden rounded-lg border border-slate-300 bg-slate-950/75 shadow-lg"><svg viewBox={`0 0 ${Math.max(1, framedLayoutWidth)} ${Math.max(1, framedLayoutHeight)}`} className="h-full w-full">{layout.positioned.map(item => <rect key={item.key} x={item.x} y={item.y} width={nodeWidth} height={nodeHeight} rx="8" fill={item.areaKind === 'image' ? '#38bdf8' : item.areaKind === 'video' ? '#8b5cf6' : '#94a3b8'} opacity={selectedNodeKey === item.key ? 1 : .65}/>)}</svg></button>
    </div>}
    {filterActive && !hasGraphItems && <p className="py-6 text-center text-xs text-slate-400">{t("ui.no.files.match.the.current.search.94d082")}</p>}
    {!hasGraphItems && !ordinaryEntries.length && <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">{t("ui.this.folder.is.empty.eaa3bd")}</p>}
    </>}
  </div>;
};
