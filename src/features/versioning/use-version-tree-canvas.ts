import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';
import { alignVersionTreeHistoryPositions, mappedVersionTreeServerNodeKeys, markVersionTreeCanvasPositionsPersisted, reconcileVersionTreeCanvasPositions, translateVersionTreeCanvasSelection, updateVersionTreeServerPositionMirror, type VersionTreeCanvasPosition } from './version-tree-canvas-model';
import { loadVersionTreeLayout, peekVersionTreeLayout, rememberVersionTreeLayout } from './version-tree-layout-cache';

export type VersionTreeCanvasItem = { id: string; nodeKey: string; fallbackNodeKeys?: readonly string[]; x: number; y: number };
export type VersionTreeDragState =
  | { type: 'node'; nodeKey: string; pointerId: number }
  | { type: 'relation'; childProgressId: string; pointerId: number }
  | { type: 'create-version'; sourceProgressId: string; pointerId: number }
  | { type: 'pan'; pointerId: number }
  | null;

type UseVersionTreeCanvasInput = {
  active: boolean;
  nodes: readonly VersionTreeCanvasItem[];
  workspacePath: string;
  projectName: string;
  scopeKey: string;
  nodeWidth: number;
  nodeHeight: number;
  collisionHorizontalGap?: number;
  coordinateScale?: number;
  onNotice: (message: string, duration?: number) => void;
  selectedNodeIds?: ReadonlySet<string>;
  dragStateRef: MutableRefObject<VersionTreeDragState>;
  onDragStateChange: (state: VersionTreeDragState) => void;
};

type NodeDrag = {
  element: Element;
  pointerId: number;
  anchorId: string;
  ids: string[];
  startClientX: number;
  startClientY: number;
  startPositions: Map<string, VersionTreeCanvasPosition>;
  beforeMutationMarkers: Map<string, number | undefined>;
  before: Map<string, VersionTreeCanvasPosition>;
  dragged: boolean;
};

type CanvasPan = { element: Element; pointerId: number; clientX: number; clientY: number; scrollLeft: number; scrollTop: number; requiresSpace: boolean };
type LayoutHistoryEntry = { id: number; valid: boolean; before: Map<string, VersionTreeCanvasPosition>; after: Map<string, VersionTreeCanvasPosition> };
const DRAG_THRESHOLD = 5;
const SNAP_SIZE = 20;

const sameCanvasPositions = (
  left: ReadonlyMap<string, VersionTreeCanvasPosition>,
  right: ReadonlyMap<string, VersionTreeCanvasPosition>,
) => left.size === right.size && [...left].every(([id, position]) => {
  const candidate = right.get(id);
  return candidate?.x === position.x
    && candidate.y === position.y
    && Boolean(candidate.manual) === Boolean(position.manual);
});

export const useVersionTreeCanvas = ({ active, nodes, workspacePath, projectName, scopeKey, nodeWidth, nodeHeight, collisionHorizontalGap, coordinateScale = 1, onNotice, selectedNodeIds = new Set(), dragStateRef, onDragStateChange }: UseVersionTreeCanvasInput) => {
  const nodesRef = useRef(nodes);
  const onNoticeRef = useRef(onNotice);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const dimensionsRef = useRef({ nodeWidth, nodeHeight, collisionHorizontalGap });
  const serverPositionsRef = useRef(new Map<string, VersionTreeCanvasPosition>());
  const appliedServerNodeKeysRef = useRef(new Set<string>());
  nodesRef.current = nodes;
  onNoticeRef.current = onNotice;
  selectedNodeIdsRef.current = selectedNodeIds;
  dimensionsRef.current = { nodeWidth, nodeHeight, collisionHorizontalGap };
  const nodeLayoutKey = JSON.stringify(nodes.map(node => [node.id, node.nodeKey, node.fallbackNodeKeys || [], node.x, node.y]));
  const defaultPositions = useCallback(() => new Map(nodesRef.current.map(node => [node.id, { x: node.x, y: node.y }])), []);
  const [positions, setPositions] = useState<Map<string, VersionTreeCanvasPosition>>(defaultPositions);
  const positionsRef = useRef(positions);
  const revisionRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const saveQueueRef = useRef(Promise.resolve());
  const saveEpochRef = useRef(0);
  const historyEpochRef = useRef(0);
  const historyEntrySequenceRef = useRef(0);
  const commandSequenceRef = useRef(0);
  const generationRef = useRef(0);
  const layoutReadyRef = useRef(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const loadPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const localMutationSequenceRef = useRef(0);
  const localMutationByNodeRef = useRef(new Map<string, number>());
  const persistedMutationByNodeRef = useRef(new Map<string, number>());
  const disposedRef = useRef(false);
  const nodeDragRef = useRef<NodeDrag | null>(null);
  const canvasPanRef = useRef<CanvasPan | null>(null);
  const suppressClickRef = useRef('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportOwnsInteractionRef = useRef(false);
  const spacePressedRef = useRef(false);
  const undoStackRef = useRef<LayoutHistoryEntry[]>([]);
  const redoStackRef = useRef<LayoutHistoryEntry[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  positionsRef.current = positions;

  const applyPositions = useCallback((next: Map<string, VersionTreeCanvasPosition>) => {
    if (disposedRef.current) return;
    if (sameCanvasPositions(positionsRef.current, next)) return;
    positionsRef.current = next;
    setPositions(next);
  }, []);

  const alignHistoryPositions = useCallback((snapshot: ReadonlyMap<string, VersionTreeCanvasPosition>) => {
    const dimensions = dimensionsRef.current;
    return alignVersionTreeHistoryPositions({
      nodes: nodesRef.current,
      current: positionsRef.current,
      snapshot,
      nodeWidth: dimensions.nodeWidth,
      nodeHeight: dimensions.nodeHeight,
      horizontalGap: dimensions.collisionHorizontalGap,
    });
  }, []);

  const invalidateHistoryEntry = useCallback((entry: LayoutHistoryEntry | undefined) => {
    if (!entry || !entry.valid) return;
    entry.valid = false;
    undoStackRef.current = undoStackRef.current.filter(candidate => candidate !== entry);
    redoStackRef.current = redoStackRef.current.filter(candidate => candidate !== entry);
    setHistoryRevision(value => value + 1);
  }, []);

  const cancelCanvasInteraction = useCallback((restoreNode = true) => {
    const drag = nodeDragRef.current;
    if (drag?.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
    if (drag && restoreNode) {
      drag.beforeMutationMarkers.forEach((mutation, id) => {
        if (mutation === undefined) localMutationByNodeRef.current.delete(id);
        else localMutationByNodeRef.current.set(id, mutation);
      });
      if (drag.dragged) applyPositions(drag.before);
    }
    const pan = canvasPanRef.current;
    if (pan?.element.hasPointerCapture(pan.pointerId)) pan.element.releasePointerCapture(pan.pointerId);
    nodeDragRef.current = null;
    canvasPanRef.current = null;
    suppressClickRef.current = '';
    spacePressedRef.current = false;
    if (dragStateRef.current?.type === 'node' || dragStateRef.current?.type === 'pan') onDragStateChange(null);
  }, [applyPositions, dragStateRef, onDragStateChange]);

  const positionsFromLayoutSnapshot = useCallback((result: { revision: number; positions: Array<{ nodeKey: string; x: number; y: number }> }) => {
    revisionRef.current = result.revision;
    serverPositionsRef.current = new Map(result.positions.map(position => [position.nodeKey, { x: position.x, y: position.y, manual: true }]));
    appliedServerNodeKeysRef.current = new Set();
    const currentNodes = nodesRef.current;
    const idByNodeKey = new Map(currentNodes.flatMap(node => [node.nodeKey, ...(node.fallbackNodeKeys || [])].map(nodeKey => [nodeKey, node.id] as const)));
    const saved = new Map<string, VersionTreeCanvasPosition>();
    result.positions.forEach(position => {
      const id = idByNodeKey.get(position.nodeKey);
      if (id) {
        saved.set(id, { x: position.x, y: position.y, manual: true });
        appliedServerNodeKeysRef.current.add(position.nodeKey);
      }
    });
    const dimensions = dimensionsRef.current;
    return reconcileVersionTreeCanvasPositions({ nodes: currentNodes, previous: saved, nodeWidth: dimensions.nodeWidth, nodeHeight: dimensions.nodeHeight, horizontalGap: dimensions.collisionHorizontalGap });
  }, []);

  const loadServerLayout = useCallback(async (generation = generationRef.current, forceFresh = false) => {
    if (disposedRef.current || generation !== generationRef.current) return;
    const sequence = ++loadSequenceRef.current;
    const localMutationAtStart = localMutationSequenceRef.current;
    const result = await loadVersionTreeLayout(workspacePath, projectName, scopeKey, forceFresh).catch(error => ({
      success: false,
      revision: 0,
      positions: [],
      error: error instanceof Error ? error.message : String(error),
    }));
    if (disposedRef.current || generation !== generationRef.current || sequence !== loadSequenceRef.current) return;
    if (!result.success) {
      layoutReadyRef.current = true;
      setLayoutReady(true);
      onNoticeRef.current(`读取版本树布局失败：${result.error || '未知错误'}`, 5000);
      return;
    }
    const reconciled = positionsFromLayoutSnapshot(result);
    const drag = nodeDragRef.current;
    const draggedIds = new Set(drag?.ids || []);
    // A pointer move can happen while the initial IPC read is in flight. Such
    // local coordinates belong to this identity and must win over the late
    // server snapshot, while untouched nodes still receive persisted values.
    localMutationByNodeRef.current.forEach((mutation, id) => {
      if (mutation <= localMutationAtStart) return;
      if (drag && draggedIds.has(id)) {
        const beforeMutation = drag.beforeMutationMarkers.get(id);
        const beforePosition = drag.before.get(id);
        if (beforeMutation !== undefined && beforeMutation > localMutationAtStart && beforePosition) reconciled.set(id, beforePosition);
        return;
      }
      const current = positionsRef.current.get(id);
      if (current) reconciled.set(id, current);
    });
    const displayed = new Map(reconciled);
    if (drag) {
      drag.ids.forEach(id => {
        const current = positionsRef.current.get(id);
        if (current) displayed.set(id, current);
      });
      drag.before = new Map(reconciled);
    }
    layoutReadyRef.current = true;
    setLayoutReady(true);
    applyPositions(displayed);
    // Loading persisted positions is asynchronous. The user may already have
    // panned or scrolled while the request was in flight, so keep the current
    // viewport instead of snapping it back to the canvas origin.
  }, [applyPositions, positionsFromLayoutSnapshot, projectName, scopeKey, workspacePath]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      generationRef.current += 1;
      loadSequenceRef.current += 1;
      cancelCanvasInteraction(false);
      dragStateRef.current = null;
      saveEpochRef.current += 1;
      commandSequenceRef.current += 1;
      saveQueueRef.current = Promise.resolve();
      layoutReadyRef.current = false;
    };
  }, [cancelCanvasInteraction, dragStateRef]);

  useEffect(() => {
    if (!active) cancelCanvasInteraction();
  }, [active, cancelCanvasInteraction]);

  useLayoutEffect(() => {
    // React StrictMode recreates layout effects before passive effects. Reset
    // the disposal marker here as well so the second development-only setup
    // cannot mistake the still-mounted canvas for an unmounted one.
    disposedRef.current = false;
    cancelCanvasInteraction();
    const generation = ++generationRef.current;
    revisionRef.current = 0;
    loadSequenceRef.current += 1;
    saveEpochRef.current += 1;
    commandSequenceRef.current += 1;
    saveQueueRef.current = Promise.resolve();
    layoutReadyRef.current = false;
    setLayoutReady(false);
    localMutationSequenceRef.current = 0;
    localMutationByNodeRef.current = new Map();
    persistedMutationByNodeRef.current = new Map();
    serverPositionsRef.current = new Map();
    appliedServerNodeKeysRef.current = new Set();
    undoStackRef.current = [];
    redoStackRef.current = [];
    historyEpochRef.current += 1;
    setHistoryRevision(value => value + 1);
    applyPositions(defaultPositions());
    const cachedLayout = peekVersionTreeLayout(workspacePath, projectName, scopeKey);
    if (cachedLayout) {
      applyPositions(positionsFromLayoutSnapshot(cachedLayout));
      layoutReadyRef.current = true;
      setLayoutReady(true);
    }
    // A genuinely different project/scope starts at its origin. Do this before
    // the asynchronous read begins so a late response cannot override any
    // scrolling the user performs afterward.
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
      viewportRef.current.scrollTop = 0;
    }
    loadPromiseRef.current = loadServerLayout(generation);
    return () => {
      loadSequenceRef.current += 1;
      generationRef.current += 1;
      saveEpochRef.current += 1;
      saveQueueRef.current = Promise.resolve();
      layoutReadyRef.current = false;
      revisionRef.current = 0;
      undoStackRef.current = [];
      redoStackRef.current = [];
      historyEpochRef.current += 1;
    };
  }, [applyPositions, cancelCanvasInteraction, defaultPositions, loadServerLayout, positionsFromLayoutSnapshot, projectName, scopeKey, workspacePath]);

  useEffect(() => {
    // Automatic positions must follow a changed graph layout (for example,
    // immediately after a new parent relation is saved). Only coordinates the
    // user actually dragged, or coordinates loaded from storage, are fixed.
    const currentNodes = nodesRef.current;
    const previous = new Map([...positionsRef.current].filter(([, position]) => position.manual));
    currentNodes.forEach(node => {
      const savedKey = [node.nodeKey, ...(node.fallbackNodeKeys || [])].find(nodeKey => serverPositionsRef.current.has(nodeKey) && !appliedServerNodeKeysRef.current.has(nodeKey));
      const saved = savedKey ? serverPositionsRef.current.get(savedKey) : undefined;
      if (saved && savedKey) {
        previous.set(node.id, saved);
        appliedServerNodeKeysRef.current.add(savedKey);
      }
    });
    applyPositions(reconcileVersionTreeCanvasPositions({ nodes: currentNodes, previous, nodeWidth, nodeHeight, horizontalGap: collisionHorizontalGap }));
  }, [applyPositions, collisionHorizontalGap, nodeHeight, nodeLayoutKey, nodeWidth]);

  useEffect(() => {
    const finishCanvasPan = (spaceOnly: boolean) => {
      const pan = canvasPanRef.current;
      if (!pan || spaceOnly && !pan.requiresSpace) return;
      if (pan.element.hasPointerCapture(pan.pointerId)) pan.element.releasePointerCapture(pan.pointerId);
      canvasPanRef.current = null;
      if (dragStateRef.current?.type === 'pan' && dragStateRef.current.pointerId === pan.pointerId) onDragStateChange(null);
    };
    const belongsToViewport = (target: EventTarget | null) => {
      const viewport = viewportRef.current;
      const contains = (candidate: EventTarget | null) => {
        let current = candidate as Node | null;
        while (current) {
          if (current === viewport) return true;
          current = current.parentNode;
        }
        return false;
      };
      return Boolean(viewport && (contains(target) || contains(document.activeElement)));
    };
    const updateOwnership = (event: Event) => { viewportOwnsInteractionRef.current = belongsToViewport(event.target); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.code === 'Space' && (viewportOwnsInteractionRef.current || belongsToViewport(event.target))
        && !(event.target as Element | null)?.closest?.('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) {
        spacePressedRef.current = true;
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      const wasPressed = spacePressedRef.current;
      spacePressedRef.current = false;
      finishCanvasPan(true);
      if (event.defaultPrevented) return;
      if (wasPressed) event.preventDefault();
    };
    const onBlur = () => {
      spacePressedRef.current = false;
      finishCanvasPan(false);
    };
    if (!active) {
      viewportOwnsInteractionRef.current = false;
      spacePressedRef.current = false;
      finishCanvasPan(false);
      return;
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerdown', updateOwnership, true);
    window.addEventListener('focusin', updateOwnership, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerdown', updateOwnership, true);
      window.removeEventListener('focusin', updateOwnership, true);
    };
  }, [active, dragStateRef, onDragStateChange]);

  const enqueueSave = useCallback((mode: 'patch' | 'replace', savedPositions: Map<string, VersionTreeCanvasPosition>, before: Map<string, VersionTreeCanvasPosition>, requiredHistoryEpoch?: number, historyEntry?: LayoutHistoryEntry) => {
    if (disposedRef.current) return Promise.resolve(false);
    const generation = generationRef.current;
    const saveEpoch = saveEpochRef.current;
    const commandSequence = ++commandSequenceRef.current;
    const localMutationAtEnqueue = ++localMutationSequenceRef.current;
    savedPositions.forEach((_position, id) => localMutationByNodeRef.current.set(id, localMutationAtEnqueue));
    const operation = saveQueueRef.current.then(async () => {
      await loadPromiseRef.current;
      if (disposedRef.current || generation !== generationRef.current || saveEpoch !== saveEpochRef.current || requiredHistoryEpoch !== undefined && requiredHistoryEpoch !== historyEpochRef.current) return false;
      if (!layoutReadyRef.current) return false;
      const buildPayload = () => {
        const nodeById = new Map(nodesRef.current.map(node => [node.id, node]));
        return [...savedPositions].flatMap(([id, position]) => {
          const node = nodeById.get(id);
          return node ? [{ nodeKey: node.nodeKey, x: position.x, y: position.y }] : [];
        });
      };
      let payload = buildPayload();
      const persistedMutationBeforeCommand = new Map([...savedPositions.keys()].map(id => [id, persistedMutationByNodeRef.current.get(id)] as const));
      const failureBaseline = new Map(before);
      const currentNodesAtExecution = nodesRef.current;
      currentNodesAtExecution.forEach(node => {
        if (!savedPositions.has(node.id)) return;
        const persisted = [node.nodeKey, ...(node.fallbackNodeKeys || [])].map(nodeKey => serverPositionsRef.current.get(nodeKey)).find(Boolean);
        if (persisted) failureBaseline.set(node.id, persisted);
      });
      let result = await window.electronAPI.saveVersionTreeLayout(workspacePath, projectName, {
        scopeKey,
        expectedRevision: revisionRef.current,
        mode,
        positions: payload,
      }).catch(error => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
      const staleLayout = !result.success && String(result.error || '').startsWith('stale_layout:');
      if (staleLayout && mode === 'patch') {
        const latest = await window.electronAPI.getVersionTreeLayout(workspacePath, projectName, scopeKey).catch(error => ({
          success: false,
          revision: revisionRef.current,
          positions: [],
          error: error instanceof Error ? error.message : String(error),
        }));
        if (disposedRef.current || generation !== generationRef.current || saveEpoch !== saveEpochRef.current) return false;
        if (latest.success) {
          rememberVersionTreeLayout(workspacePath, projectName, scopeKey, latest);
          revisionRef.current = latest.revision;
          const currentNodes = nodesRef.current;
          const idByNodeKey = new Map(currentNodes.flatMap(node => [node.nodeKey, ...(node.fallbackNodeKeys || [])].map(nodeKey => [nodeKey, node.id] as const)));
          const latestServerPositions = new Map(latest.positions.map(position => [position.nodeKey, { x: position.x, y: position.y, manual: true }]));
          const latestPositionsById = new Map<string, VersionTreeCanvasPosition>();
          latest.positions.forEach(position => {
            const id = idByNodeKey.get(position.nodeKey);
            if (id) latestPositionsById.set(id, { x: position.x, y: position.y, manual: true });
          });
          const dimensions = dimensionsRef.current;
          const currentNodeIds = new Set(currentNodes.map(node => node.id));
          const merged = reconcileVersionTreeCanvasPositions({
            nodes: currentNodes,
            previous: latestPositionsById,
            nodeWidth: dimensions.nodeWidth,
            nodeHeight: dimensions.nodeHeight,
            horizontalGap: dimensions.collisionHorizontalGap,
          });
          // If the retry itself fails, the fetched winning revision—not the
          // obsolete pre-command UI snapshot—is the rollback authority.
          failureBaseline.clear();
          merged.forEach((position, id) => failureBaseline.set(id, position));
          savedPositions.forEach((_position, id) => persistedMutationBeforeCommand.set(id, undefined));
          savedPositions.forEach((position, id) => { if (currentNodeIds.has(id)) merged.set(id, position); });
          localMutationByNodeRef.current.forEach((mutation, id) => {
            const current = positionsRef.current.get(id);
            if (currentNodeIds.has(id) && mutation > localMutationAtEnqueue && current) merged.set(id, current);
          });
          serverPositionsRef.current = latestServerPositions;
          appliedServerNodeKeysRef.current = mappedVersionTreeServerNodeKeys(latest.positions.map(position => position.nodeKey), new Set(idByNodeKey.keys()));
          // History entries are node-local patches. They remain valid across a
          // stale-layout merge and cannot overwrite untouched remote nodes.
          // Overlaying mutations enqueued after this command makes this safe
          // even when a later undo/redo/refresh is already visible locally.
          applyPositions(merged);
          payload = buildPayload();
          if (!payload.length && savedPositions.size) return true;
          result = await window.electronAPI.saveVersionTreeLayout(workspacePath, projectName, {
            scopeKey,
            expectedRevision: revisionRef.current,
            mode,
            positions: payload,
          }).catch(error => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
        }
      }
      if (disposedRef.current || generation !== generationRef.current || saveEpoch !== saveEpochRef.current) return false;
      if (result.success) {
        revisionRef.current = 'revision' in result && result.revision !== undefined ? result.revision : revisionRef.current + 1;
        serverPositionsRef.current = updateVersionTreeServerPositionMirror(
          serverPositionsRef.current,
          new Map(payload.map(position => [position.nodeKey, { x: position.x, y: position.y }])),
          mode,
        );
        rememberVersionTreeLayout(workspacePath, projectName, scopeKey, {
          success: true,
          scopeKey,
          revision: revisionRef.current,
          updatedAt: Date.now(),
          positions: [...serverPositionsRef.current].map(([nodeKey, position]) => ({ nodeKey, x: position.x, y: position.y })),
        });
        const mountedNodeKeys = new Set(nodesRef.current.flatMap(node => [node.nodeKey, ...(node.fallbackNodeKeys || [])]));
        const savedMountedNodeKeys = mappedVersionTreeServerNodeKeys(payload.map(position => position.nodeKey), mountedNodeKeys);
        if (mode === 'replace') appliedServerNodeKeysRef.current = savedMountedNodeKeys;
        else savedMountedNodeKeys.forEach(nodeKey => appliedServerNodeKeysRef.current.add(nodeKey));
        const persistedIds = new Set([...savedPositions.keys()].filter(id => localMutationByNodeRef.current.get(id) === localMutationAtEnqueue));
        if (persistedIds.size) applyPositions(markVersionTreeCanvasPositionsPersisted(positionsRef.current, persistedIds));
        const activeDrag = nodeDragRef.current;
        savedPositions.forEach((position, id) => {
          persistedMutationByNodeRef.current.set(id, localMutationAtEnqueue);
          if (!activeDrag?.ids.includes(id) || activeDrag.beforeMutationMarkers.get(id) !== localMutationAtEnqueue) return;
          // A save can finish after pointerdown. Advance only the gesture's
          // cancellation baseline; its currently displayed drag position must
          // remain untouched until the pointer gesture finishes.
          activeDrag.before.set(id, { ...position, manual: true });
          activeDrag.beforeMutationMarkers.set(id, localMutationAtEnqueue);
        });
        return true;
      }
      invalidateHistoryEntry(historyEntry);
      const rollback = new Map(positionsRef.current);
      savedPositions.forEach((_position, id) => {
        if (localMutationByNodeRef.current.get(id) !== localMutationAtEnqueue) return;
        const previous = failureBaseline.get(id);
        if (previous) rollback.set(id, previous);
        const persistedMutation = persistedMutationBeforeCommand.get(id);
        if (persistedMutation === undefined) localMutationByNodeRef.current.delete(id);
        else localMutationByNodeRef.current.set(id, persistedMutation);
      });
      const activeDrag = nodeDragRef.current;
      savedPositions.forEach((_position, id) => {
        if (!activeDrag?.ids.includes(id) || activeDrag.beforeMutationMarkers.get(id) !== localMutationAtEnqueue) return;
        const previous = failureBaseline.get(id);
        if (previous) activeDrag.before.set(id, previous);
        activeDrag.beforeMutationMarkers.set(id, persistedMutationBeforeCommand.get(id));
      });
      applyPositions(alignVersionTreeHistoryPositions({
        nodes: nodesRef.current,
        current: rollback,
        snapshot: new Map(),
        nodeWidth: dimensionsRef.current.nodeWidth,
        nodeHeight: dimensionsRef.current.nodeHeight,
        horizontalGap: dimensionsRef.current.collisionHorizontalGap,
      }));
      onNoticeRef.current(`保存版本树布局失败：${result.error || '未知错误'}`, 5000);
      if ((mode === 'patch' || staleLayout) && commandSequence === commandSequenceRef.current) await loadServerLayout(generation, true);
      return false;
    });
    saveQueueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [applyPositions, invalidateHistoryEntry, loadServerLayout, projectName, scopeKey, workspacePath]);

  const nodePointerHandlers = useCallback((id: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      viewportOwnsInteractionRef.current = active;
      if (!active || disposedRef.current || dragStateRef.current || event.button !== 0 || (event.target as Element).closest('button,input,select,textarea,[data-version-tree-port]')) return;
      const startPosition = positionsRef.current.get(id);
      if (!startPosition) return;
      const currentSelectedNodeIds = selectedNodeIdsRef.current;
      const ids = currentSelectedNodeIds.has(id) && currentSelectedNodeIds.size > 1
        ? [...currentSelectedNodeIds].filter(candidate => positionsRef.current.has(candidate))
        : [id];
      const startPositions = new Map(ids.flatMap(candidate => {
        const position = positionsRef.current.get(candidate);
        return position ? [[candidate, position] as const] : [];
      }));
      const beforeMutationMarkers = new Map(ids.map(nodeId => [nodeId, localMutationByNodeRef.current.get(nodeId)] as const));
      onDragStateChange({ type: 'node', nodeKey: id, pointerId: event.pointerId });
      nodeDragRef.current = { element: event.currentTarget, pointerId: event.pointerId, anchorId: id, ids, startClientX: event.clientX, startClientY: event.clientY, startPositions, beforeMutationMarkers, before: new Map(positionsRef.current), dragged: false };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = nodeDragRef.current;
      if (!drag || drag.anchorId !== id || drag.pointerId !== event.pointerId) return;
      const scale = Number.isFinite(coordinateScale) && coordinateScale > 0 ? coordinateScale : 1;
      const rawDeltaX = (event.clientX - drag.startClientX) / scale;
      const rawDeltaY = (event.clientY - drag.startClientY) / scale;
      const deltaX = event.ctrlKey ? rawDeltaX : Math.round(rawDeltaX / SNAP_SIZE) * SNAP_SIZE;
      const deltaY = event.ctrlKey ? rawDeltaY : Math.round(rawDeltaY / SNAP_SIZE) * SNAP_SIZE;
      if (!drag.dragged && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
      if (!drag.dragged) {
        drag.dragged = true;
        drag.element.setPointerCapture(drag.pointerId);
      }
      event.preventDefault();
      const moved = translateVersionTreeCanvasSelection(drag.startPositions, deltaX, deltaY);
      const next = new Map(positionsRef.current);
      const mutation = ++localMutationSequenceRef.current;
      moved.forEach((position, nodeId) => {
        next.set(nodeId, position);
        localMutationByNodeRef.current.set(nodeId, mutation);
      });
      applyPositions(next);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = nodeDragRef.current;
      if (!drag || drag.anchorId !== id || drag.pointerId !== event.pointerId) return;
      if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
      nodeDragRef.current = null;
      onDragStateChange(null);
      if (!drag.dragged) {
        applyPositions(drag.before);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = id;
      const moved = new Map(drag.ids.flatMap(nodeId => {
        const position = positionsRef.current.get(nodeId);
        return position ? [[nodeId, position] as const] : [];
      }));
      if (moved.size) {
        const beforeMoved = new Map(drag.ids.flatMap(nodeId => {
          const position = drag.before.get(nodeId);
          return position ? [[nodeId, position] as const] : [];
        }));
        const historyEntry: LayoutHistoryEntry = { id: ++historyEntrySequenceRef.current, valid: true, before: beforeMoved, after: moved };
        undoStackRef.current.push(historyEntry);
        if (undoStackRef.current.length > 80) undoStackRef.current.shift();
        redoStackRef.current = [];
        setHistoryRevision(value => value + 1);
        void enqueueSave('patch', moved, drag.before, undefined, historyEntry);
      }
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = nodeDragRef.current;
      if (!drag || drag.anchorId !== id || drag.pointerId !== event.pointerId) return;
      if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
      nodeDragRef.current = null;
      onDragStateChange(null);
      drag.beforeMutationMarkers.forEach((mutation, nodeId) => {
        if (mutation === undefined) localMutationByNodeRef.current.delete(nodeId);
        else localMutationByNodeRef.current.set(nodeId, mutation);
      });
      applyPositions(drag.before);
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = nodeDragRef.current;
      if (!drag || drag.dragged || drag.anchorId !== id || drag.pointerId !== event.pointerId) return;
      nodeDragRef.current = null;
      onDragStateChange(null);
      applyPositions(drag.before);
    },
    onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current !== id) return;
      suppressClickRef.current = '';
      event.preventDefault();
      event.stopPropagation();
    },
  }), [active, applyPositions, coordinateScale, dragStateRef, enqueueSave, onDragStateChange]);

  const canvasPointerHandlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      viewportOwnsInteractionRef.current = active;
      const shouldPan = event.button === 1 || event.button === 0 && spacePressedRef.current;
      if (!active || disposedRef.current || dragStateRef.current || !shouldPan || (event.target as Element).closest('[data-version-tree-node]')) return;
      const viewport = viewportRef.current;
      if (!viewport) return;
      event.preventDefault();
      // The version tree lives inside the file surface, whose blank-area
      // pointer handler starts marquee selection and edge auto-scroll. Once
      // canvas panning claims this pointer, keep that unrelated interaction
      // from starting on the same gesture.
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      onDragStateChange({ type: 'pan', pointerId: event.pointerId });
      canvasPanRef.current = { element: event.currentTarget, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, requiresSpace: event.button === 0 };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const pan = canvasPanRef.current;
      const viewport = viewportRef.current;
      if (!pan || !viewport || pan.pointerId !== event.pointerId || pan.requiresSpace && !spacePressedRef.current) return;
      viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
      viewport.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const pan = canvasPanRef.current;
      if (!pan || pan.pointerId !== event.pointerId) return;
      if (pan.element.hasPointerCapture(pan.pointerId)) pan.element.releasePointerCapture(pan.pointerId);
      canvasPanRef.current = null;
      onDragStateChange(null);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => {
      const pan = canvasPanRef.current;
      if (!pan || pan.pointerId !== event.pointerId) return;
      if (pan.element.hasPointerCapture(pan.pointerId)) pan.element.releasePointerCapture(pan.pointerId);
      canvasPanRef.current = null;
      onDragStateChange(null);
    },
  };

  const refreshLayout = useCallback(async () => {
    const before = new Map(positionsRef.current);
    const next = defaultPositions();
    applyPositions(next);
    const historyEntry: LayoutHistoryEntry = { id: ++historyEntrySequenceRef.current, valid: true, before, after: next };
    undoStackRef.current.push(historyEntry);
    redoStackRef.current = [];
    setHistoryRevision(value => value + 1);
    const success = await enqueueSave('replace', next, before, undefined, historyEntry);
    if (success) {
      if (viewportRef.current) {
        viewportRef.current.scrollLeft = 0;
        viewportRef.current.scrollTop = 0;
      }
    } else {
      invalidateHistoryEntry(historyEntry);
    }
    return success;
  }, [applyPositions, defaultPositions, enqueueSave, invalidateHistoryEntry]);

  const undoLayout = useCallback(async () => {
    const entry = undoStackRef.current.pop();
    if (!entry) return false;
    const historyEpoch = historyEpochRef.current;
    const current = new Map(positionsRef.current);
    const target = alignHistoryPositions(entry.before);
    const patch = new Map([...entry.before].filter(([id]) => target.has(id)));
    applyPositions(target);
    const success = await enqueueSave('patch', patch, current, historyEpoch);
    if (success && entry.valid) redoStackRef.current.push(entry);
    else if (!success && entry.valid && historyEpoch === historyEpochRef.current) undoStackRef.current.push(entry);
    setHistoryRevision(value => value + 1);
    return success;
  }, [alignHistoryPositions, applyPositions, enqueueSave]);

  const redoLayout = useCallback(async () => {
    const entry = redoStackRef.current.pop();
    if (!entry) return false;
    const historyEpoch = historyEpochRef.current;
    const current = new Map(positionsRef.current);
    const target = alignHistoryPositions(entry.after);
    const patch = new Map([...entry.after].filter(([id]) => target.has(id)));
    applyPositions(target);
    const success = await enqueueSave('patch', patch, current, historyEpoch);
    if (success && entry.valid) undoStackRef.current.push(entry);
    else if (!success && entry.valid && historyEpoch === historyEpochRef.current) redoStackRef.current.push(entry);
    setHistoryRevision(value => value + 1);
    return success;
  }, [alignHistoryPositions, applyPositions, enqueueSave]);

  const resetViewport = useCallback(() => {
    if (!viewportRef.current) return;
    viewportRef.current.scrollLeft = 0;
    viewportRef.current.scrollTop = 0;
  }, []);

  const hasManualLayout = nodes.some(node => {
    const position = positions.get(node.id);
    return Boolean(position && (position.x !== node.x || position.y !== node.y));
  });

  void historyRevision;
  return { positions, viewportRef, nodePointerHandlers, canvasPointerHandlers, refreshLayout, resetViewport, undoLayout, redoLayout, canUndo: undoStackRef.current.length > 0, canRedo: redoStackRef.current.length > 0, hasManualLayout, layoutReady };
};
