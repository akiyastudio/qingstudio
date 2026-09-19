import { versionTreeEdgePath } from './version-tree-edge-model.ts';

export type VersionTreeLayoutRelationKind = 'main' | 'auxiliary' | 'media_companion' | 'derived_preview' | 'derived_transcode' | 'workflow_input';

export type VersionTreeLayoutNode = {
  id: string;
  mediaKind?: 'image' | 'video';
  nodeRole: 'original' | 'progress' | 'selection' | 'artifact' | 'workflow' | 'broll';
  artifactKind?: string;
  sourceMetadata?: { parentCapability?: 'structural' | 'workflow-input' | 'none' };
  relationKind?: 'main' | 'auxiliary';
  createdAt: number;
};

export type VersionTreeLayoutEdge = {
  id?: string;
  parentId: string;
  childId: string;
  relationKind: VersionTreeLayoutRelationKind;
};

export type VersionTreeLayoutInput = {
  nodes: readonly VersionTreeLayoutNode[];
  edges: readonly VersionTreeLayoutEdge[];
  nodeWidth: number;
  nodeHeight: number;
  columnGap: number;
  rowGap: number;
  auxiliaryGap?: number;
  rootGap: number;
};

export type PositionedVersionNode = VersionTreeLayoutNode & {
  x: number;
  y: number;
  depth: number;
  subtreeHeight: number;
};

export type PositionedVersionEdge = VersionTreeLayoutEdge & {
  id: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  path: string;
};

export type VersionTreeLayoutResult = {
  nodes: PositionedVersionNode[];
  edges: PositionedVersionEdge[];
  width: number;
  height: number;
};

const roleOrder = { original: 0, workflow: 1, artifact: 2, progress: 3, selection: 4, broll: 5 } as const;
const relationOrder: Record<VersionTreeLayoutRelationKind, number> = { main: 0, auxiliary: 1, workflow_input: 2, media_companion: 3, derived_preview: 4, derived_transcode: 5 };
const compareNodes = (left: VersionTreeLayoutNode, right: VersionTreeLayoutNode) =>
  roleOrder[left.nodeRole] - roleOrder[right.nodeRole]
  || relationOrder[left.relationKind || 'main'] - relationOrder[right.relationKind || 'main']
  || left.createdAt - right.createdAt
  || left.id.localeCompare(right.id);
const compareEdges = (left: VersionTreeLayoutEdge, right: VersionTreeLayoutEdge) =>
  relationOrder[left.relationKind] - relationOrder[right.relationKind]
  || left.parentId.localeCompare(right.parentId)
  || left.childId.localeCompare(right.childId)
  || String(left.id || '').localeCompare(String(right.id || ''));
const appendIndex = <T,>(index: Map<string, T[]>, key: string, value: T) => {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
};

const layoutVersionTreeDag = (input: VersionTreeLayoutInput): VersionTreeLayoutResult => {
  const nodeWidth = Math.max(1, input.nodeWidth);
  const nodeHeight = Math.max(1, input.nodeHeight);
  const columnGap = Math.max(0, input.columnGap);
  const rowGap = Math.max(0, input.rowGap);
  const auxiliaryGap = Math.max(rowGap, input.auxiliaryGap ?? rowGap);
  const rootGap = Math.max(rowGap, input.rootGap);
  const stableNodes = [...new Map([...input.nodes].sort(compareNodes).filter(node => node.id).map(node => [node.id, node])).values()];
  const nodeById = new Map(stableNodes.map(node => [node.id, node]));
  const nodeRank = new Map(stableNodes.map((node, index) => [node.id, index]));
  const adjacency = new Map<string, string[]>();
  const acceptedEdges: VersionTreeLayoutEdge[] = [];
  const edgeKeys = new Set<string>();
  const reaches = (start: string, target: string) => {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of adjacency.get(current) || []) pending.push(next);
    }
    return false;
  };
  for (const edge of [...input.edges].sort(compareEdges)) {
    if (edge.parentId === edge.childId || !nodeById.has(edge.parentId) || !nodeById.has(edge.childId)) continue;
    const key = `${edge.parentId}\0${edge.childId}\0${edge.relationKind}`;
    if (edgeKeys.has(key) || reaches(edge.childId, edge.parentId)) continue;
    edgeKeys.add(key);
    acceptedEdges.push(edge);
    appendIndex(adjacency, edge.parentId, edge.childId);
  }

  const incoming = new Map<string, VersionTreeLayoutEdge[]>();
  const outgoing = new Map<string, VersionTreeLayoutEdge[]>();
  const indegree = new Map(stableNodes.map(node => [node.id, 0]));
  for (const edge of acceptedEdges) {
    appendIndex(incoming, edge.childId, edge);
    appendIndex(outgoing, edge.parentId, edge);
    indegree.set(edge.childId, (indegree.get(edge.childId) || 0) + 1);
  }
  for (const edges of incoming.values()) edges.sort(compareEdges);
  for (const edges of outgoing.values()) edges.sort(compareEdges);
  const compareIds = (left: string, right: string) => (nodeRank.get(left) ?? 0) - (nodeRank.get(right) ?? 0) || left.localeCompare(right);
  const ready = stableNodes.filter(node => indegree.get(node.id) === 0).map(node => node.id).sort(compareIds);
  const orderedIds: string[] = [];
  const depths = new Map<string, number>();
  while (ready.length) {
    const id = ready.shift()!;
    orderedIds.push(id);
    for (const edge of outgoing.get(id) || []) {
      const target = nodeById.get(edge.childId);
      const targetHasStructuralMain = (incoming.get(edge.childId) || []).some(candidate => candidate.relationKind === 'main');
      const depthStep = edge.relationKind === 'media_companion' || edge.relationKind === 'derived_preview' || edge.relationKind === 'derived_transcode'
        || edge.relationKind === 'workflow_input' && target?.nodeRole === 'progress' && targetHasStructuralMain
        ? 0
        : 1;
      depths.set(edge.childId, Math.max(depths.get(edge.childId) || 0, (depths.get(id) || 0) + depthStep));
      const next = (indegree.get(edge.childId) || 0) - 1;
      indegree.set(edge.childId, next);
      if (next === 0) { ready.push(edge.childId); ready.sort(compareIds); }
    }
  }
  const orderedSet = new Set(orderedIds);
  for (const node of stableNodes) if (!orderedSet.has(node.id)) orderedIds.push(node.id);

  // Pack disconnected trees horizontally. Previously every independent root
  // started in depth 0 and was pushed downward by auxiliary nodes belonging to
  // another tree. A missing parent relation could therefore create a very
  // large, seemingly random vertical gap. Keeping components in distinct depth
  // ranges preserves the fact that they are disconnected without inventing an
  // edge between them.
  const undirected = new Map<string, string[]>();
  for (const edge of acceptedEdges) {
    appendIndex(undirected, edge.parentId, edge.childId);
    appendIndex(undirected, edge.childId, edge.parentId);
  }
  const componentById = new Map<string, number>();
  const componentIds: string[][] = [];
  for (const id of orderedIds) {
    if (componentById.has(id)) continue;
    const componentIndex = componentIds.length;
    const members: string[] = [];
    const pending = [id];
    while (pending.length) {
      const current = pending.pop()!;
      if (componentById.has(current)) continue;
      componentById.set(current, componentIndex);
      members.push(current);
      for (const neighbor of undirected.get(current) || []) if (!componentById.has(neighbor)) pending.push(neighbor);
    }
    componentIds.push(members);
  }
  const componentDepthOffset = new Map<number, number>();
  let nextComponentDepth = 0;
  componentIds.forEach((members, componentIndex) => {
    componentDepthOffset.set(componentIndex, nextComponentDepth);
    const maxLocalDepth = members.reduce((maximum, id) => Math.max(maximum, depths.get(id) || 0), 0);
    nextComponentDepth += maxLocalDepth + 1;
  });

  const positioned = new Map<string, PositionedVersionNode>();
  const occupiedByDepth = new Map<number, number[]>();
  const nextRootYByComponent = new Map<number, number>();
  const anchorById = new Map<string, VersionTreeLayoutEdge | undefined>();
  for (const id of orderedIds) {
    const parents = incoming.get(id) || [];
    const supplementalAnchor = [...parents].sort((left, right) =>
      (depths.get(right.parentId) || 0) - (depths.get(left.parentId) || 0)
      || compareIds(left.parentId, right.parentId)
      || compareEdges(left, right)
    )[0];
    anchorById.set(id, parents.find(edge => edge.relationKind === 'main')
      || parents.find(edge => edge.relationKind === 'auxiliary')
      || supplementalAnchor);
  }
  // Placement has a different priority from dependency traversal. A workflow
  // input can make a main-version node topologically ready only after its
  // selection node, but the main-version branch should still claim the upper
  // lanes first. Otherwise the selection occupies the second lane and pushes
  // a sibling version several rows down.
  const placementIds: string[] = [];
  const pendingPlacement = new Set(orderedIds);
  const placementRelationOrder: Record<VersionTreeLayoutRelationKind, number> = {
    main: 0,
    workflow_input: 1,
    media_companion: 2,
    derived_preview: 2,
    derived_transcode: 2,
    auxiliary: 3,
  };
  while (pendingPlacement.size) {
    const readyForPlacement = [...pendingPlacement].filter(id => {
      const anchor = anchorById.get(id);
      return !anchor || !pendingPlacement.has(anchor.parentId);
    }).sort((left, right) => {
      const componentDifference = (componentById.get(left) || 0) - (componentById.get(right) || 0);
      if (componentDifference) return componentDifference;
      const leftAnchor = anchorById.get(left);
      const rightAnchor = anchorById.get(right);
      return (leftAnchor ? placementRelationOrder[leftAnchor.relationKind] : -1)
        - (rightAnchor ? placementRelationOrder[rightAnchor.relationKind] : -1)
        || compareIds(left, right);
    });
    const nextId = readyForPlacement[0] || [...pendingPlacement].sort(compareIds)[0];
    pendingPlacement.delete(nextId);
    placementIds.push(nextId);
  }
  for (const id of placementIds) {
    const node = nodeById.get(id)!;
    const componentIndex = componentById.get(id) || 0;
    const depth = (depths.get(id) || 0) + (componentDepthOffset.get(componentIndex) || 0);
    const parents = incoming.get(id) || [];
    const anchor = anchorById.get(id);
    const parent = anchor ? positioned.get(anchor.parentId) : undefined;
    const followsParentLane = anchor?.relationKind === 'main'
      || anchor?.relationKind === 'workflow_input' && node.nodeRole === 'progress';
    let y = parent
      ? parent.y + (followsParentLane ? 0 : nodeHeight + auxiliaryGap)
      : nextRootYByComponent.get(componentIndex) || 0;
    if (parent && !followsParentLane) {
      const mainBranchFloor = (outgoing.get(parent.id) || [])
        .filter(edge => edge.relationKind === 'main')
        .map(edge => positioned.get(edge.childId))
        .filter((child): child is PositionedVersionNode => Boolean(child))
        .reduce((floor, child) => Math.max(floor, child.y + nodeHeight + auxiliaryGap), y);
      y = Math.max(y, mainBranchFloor);
    }
    const occupied = occupiedByDepth.get(depth) || [];
    while (occupied.some(candidate => Math.abs(candidate - y) < nodeHeight + rowGap)) y += nodeHeight + rowGap;
    occupied.push(y);
    occupiedByDepth.set(depth, occupied);
    positioned.set(id, { ...node, x: depth * (nodeWidth + columnGap), y, depth, subtreeHeight: nodeHeight });
    if (!parents.length) nextRootYByComponent.set(componentIndex, Math.max(nextRootYByComponent.get(componentIndex) || 0, y + nodeHeight + rootGap));
  }
  const nodes = stableNodes.map(node => positioned.get(node.id)!).filter(Boolean);
  const edges = acceptedEdges.map(edge => {
    const parent = positioned.get(edge.parentId)!;
    const child = positioned.get(edge.childId)!;
    const startX = parent.x + nodeWidth;
    const startY = parent.y + nodeHeight / 2;
    const endX = child.x;
    const endY = child.y + nodeHeight / 2;
    return { ...edge, id: edge.id || `${edge.parentId}:${edge.childId}:${edge.relationKind}`, startX, startY, endX, endY, path: versionTreeEdgePath(startX, startY, endX, endY) };
  });
  return {
    nodes,
    edges,
    width: nodes.length ? Math.max(...nodes.map(node => node.x + nodeWidth)) : 0,
    height: nodes.length ? Math.max(...nodes.map(node => node.y + nodeHeight)) : 0,
  };
};

export const layoutVersionTree = (input: VersionTreeLayoutInput): VersionTreeLayoutResult => {
  const groups = [
    input.nodes.filter(node => node.mediaKind === 'image'),
    input.nodes.filter(node => node.mediaKind === 'video'),
    input.nodes.filter(node => !node.mediaKind),
  ].filter(group => group.length > 0);
  if (groups.length <= 1) return layoutVersionTreeDag(input);

  const nodeGroup = new Map<string, number>();
  groups.forEach((group, groupIndex) => group.forEach(node => nodeGroup.set(node.id, groupIndex)));
  // Swimlanes are separated by a stable visual gap. Their internal branch
  // height still prevents overlap, but a tall image branch no longer adds an
  // additional proportional gap before the video workflow.
  const bandGap = 112;
  let offsetY = 0;
  let width = 0;
  const nodes: PositionedVersionNode[] = [];
  const edges: PositionedVersionEdge[] = [];
  groups.forEach((group, groupIndex) => {
    const result = layoutVersionTreeDag({
      ...input,
      nodes: group,
      edges: input.edges.filter(edge => nodeGroup.get(edge.parentId) === groupIndex && nodeGroup.get(edge.childId) === groupIndex),
    });
    nodes.push(...result.nodes.map(node => ({ ...node, y: node.y + offsetY })));
    edges.push(...result.edges.map(edge => {
      const startY = edge.startY + offsetY;
      const endY = edge.endY + offsetY;
      return { ...edge, startY, endY, path: versionTreeEdgePath(edge.startX, startY, edge.endX, endY) };
    }));
    width = Math.max(width, result.width);
    offsetY += result.height + bandGap;
  });
  return { nodes, edges, width, height: Math.max(0, offsetY - bandGap) };
};
