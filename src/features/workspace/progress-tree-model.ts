export type ProgressRelationNode = {
  id: string;
  parentProgressId?: string;
};

export type ProgressRelationInspection = {
  visitedIds: Set<string>;
  cycleNodeIds: string[];
  /** Parent IDs referenced by nodes but absent from the inspected collection. */
  danglingParentIds?: string[];
  /** Requested traversal roots absent from the inspected collection. */
  invalidRootIds?: string[];
  /** Integrity diagnostics that do not imply a cycle repair. */
  hasIntegrityIssues?: boolean;
  needsRepair: boolean;
};

const inspectFrom = (nodes: readonly ProgressRelationNode[], roots: readonly string[]): ProgressRelationInspection => {
  const nodeIds = new Set(nodes.map(node => node.id));
  const childrenByParent = new Map<string, string[]>();
  const danglingParentIds = new Set<string>();
  for (const node of nodes) {
    if (!node.parentProgressId) continue;
    if (!nodeIds.has(node.parentProgressId)) danglingParentIds.add(node.parentProgressId);
    const children = childrenByParent.get(node.parentProgressId) || [];
    children.push(node.id);
    childrenByParent.set(node.parentProgressId, children);
  }

  const visitedIds = new Set<string>();
  const activeIds = new Set<string>();
  const traversalParent = new Map<string, string>();
  const cycleNodeIds = new Set<string>();
  const invalidRootIds = new Set<string>();

  for (const rootId of roots) {
    if (!rootId || visitedIds.has(rootId)) continue;
    if (!nodeIds.has(rootId)) {
      invalidRootIds.add(rootId);
      continue;
    }
    visitedIds.add(rootId);
    activeIds.add(rootId);
    const stack: Array<{ id: string; childIndex: number }> = [{ id: rootId, childIndex: 0 }];

    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = childrenByParent.get(frame.id) || [];
      if (frame.childIndex >= children.length) {
        activeIds.delete(frame.id);
        stack.pop();
        continue;
      }

      const childId = children[frame.childIndex];
      frame.childIndex += 1;
      if (activeIds.has(childId)) {
        cycleNodeIds.add(childId);
        let currentId: string | undefined = frame.id;
        while (currentId && currentId !== childId) {
          cycleNodeIds.add(currentId);
          currentId = traversalParent.get(currentId);
        }
        continue;
      }
      if (visitedIds.has(childId)) continue;
      visitedIds.add(childId);
      activeIds.add(childId);
      traversalParent.set(childId, frame.id);
      stack.push({ id: childId, childIndex: 0 });
    }
  }

  const hasIntegrityIssues = danglingParentIds.size > 0 || invalidRootIds.size > 0;
  return {
    visitedIds,
    cycleNodeIds: [...cycleNodeIds],
    ...(danglingParentIds.size ? { danglingParentIds: [...danglingParentIds] } : {}),
    ...(invalidRootIds.size ? { invalidRootIds: [...invalidRootIds] } : {}),
    ...(hasIntegrityIssues ? { hasIntegrityIssues: true } : {}),
    needsRepair: cycleNodeIds.size > 0,
  };
};

export const inspectProgressRelations = (nodes: readonly ProgressRelationNode[]) => inspectFrom(nodes, nodes.map(node => node.id));

export const collectProgressSubtree = (nodes: readonly ProgressRelationNode[], progressId?: string): ProgressRelationInspection => {
  if (!progressId) return { visitedIds: new Set<string>(), cycleNodeIds: [], needsRepair: false };
  return inspectFrom(nodes, [progressId]);
};
