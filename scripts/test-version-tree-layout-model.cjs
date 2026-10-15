const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const modelRoot = path.resolve(__dirname, '..', 'src', 'features', 'versioning');
  const { layoutVersionTree } = await import(pathToFileURL(path.join(modelRoot, 'version-tree-layout-model.ts')).href);
  const canvas = await import(pathToFileURL(path.join(modelRoot, 'version-tree-canvas-model.ts')).href);
  const edgeModel = await import(pathToFileURL(path.join(modelRoot, 'version-tree-edge-model.ts')).href);
  const base = { nodeWidth: 120, nodeHeight: 80, columnGap: 64, rowGap: 28, auxiliaryGap: 36, rootGap: 44 };
  const node = (id, nodeRole = 'progress', createdAt = 1, relationKind) => ({ id, nodeRole, createdAt, ...(relationKind ? { relationKind } : {}) });
  const edge = (parentId, childId, relationKind = 'main') => ({ id: `${parentId}-${childId}`, parentId, childId, relationKind });

  const roots = layoutVersionTree({ ...base, nodes: ['RAW', 'JPG', 'MOV', 'OTHER'].map((id, index) => node(id, 'original', index)), edges: [] });
  assert.strictEqual(roots.edges.length, 0, 'independent roots must not create inferred edges');
  const rootBoxes = roots.nodes.map(item => [item.x, item.x + base.nodeWidth]);
  for (let index = 1; index < rootBoxes.length; index += 1) assert(rootBoxes[index][0] >= rootBoxes[index - 1][1] + base.columnGap, 'disconnected trees must pack horizontally instead of creating large vertical gaps');

  const branch = layoutVersionTree({
    ...base,
    nodes: [node('RAW', 'original', 0), node('main', 'progress', 1, 'main'), node('RAW_selection', 'selection', 2, 'auxiliary')],
    edges: [edge('RAW', 'main'), edge('RAW', 'RAW_selection', 'auxiliary')],
  });
  const byId = new Map(branch.nodes.map(item => [item.id, item]));
  assert(branch.edges.some(item => item.parentId === 'RAW' && item.childId === 'RAW_selection' && item.relationKind === 'auxiliary'));
  assert.strictEqual(byId.get('main').y, byId.get('RAW').y, 'the primary main branch must remain horizontal');
  assert.strictEqual(byId.get('main').x - (byId.get('RAW').x + base.nodeWidth), base.columnGap, 'horizontal spacing must be measured between node boundaries');
  assert.strictEqual(byId.get('RAW_selection').x, byId.get('main').x, 'selection must occupy the source next-column branch');
  assert.strictEqual(byId.get('RAW_selection').y - (byId.get('main').y + base.nodeHeight), base.auxiliaryGap, 'auxiliary spacing must be measured once between node boundaries');

  const chainNodes = Array.from({ length: 8 }, (_, index) => node(`chain-${index}`, index ? 'progress' : 'original', index));
  const chainEdges = chainNodes.slice(1).map((item, index) => edge(chainNodes[index].id, item.id));
  const chain = layoutVersionTree({ ...base, nodes: chainNodes, edges: chainEdges });
  assert(chain.edges.every(item => item.startY === item.endY), 'a main chain must not produce long vertical connectors');

  const shuffled = layoutVersionTree({ ...base, nodes: [...branch.nodes].reverse().map(({ x, y, depth, subtreeHeight, ...item }) => item), edges: [...branch.edges].reverse().map(({ startX, startY, endX, endY, path: ignoredPath, ...item }) => item) });
  assert.deepStrictEqual(
    shuffled.nodes.map(item => [item.id, item.x, item.y]),
    branch.nodes.map(item => [item.id, item.x, item.y]),
    'input order must not affect layout',
  );
  const narrowViewport = layoutVersionTree({ ...base, nodes: chainNodes, edges: chainEdges });
  assert.deepStrictEqual(narrowViewport.nodes.map(item => [item.x, item.y]), chain.nodes.map(item => [item.x, item.y]), 'viewport width must not reflow the graph');

  const cyclic = layoutVersionTree({ ...base, nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')] });
  assert.strictEqual(cyclic.nodes.length, 3);
  assert.strictEqual(cyclic.edges.length, 2, 'one deterministic cycle edge must be removed for safe display');

  const largeNodes = Array.from({ length: 1000 }, (_, index) => node(`large-${String(index).padStart(4, '0')}`, index ? 'progress' : 'original', index));
  const largeEdges = largeNodes.slice(1).map((item, index) => edge(largeNodes[index].id, item.id));
  const large = layoutVersionTree({ ...base, nodes: largeNodes, edges: largeEdges });
  assert.strictEqual(large.nodes.length, 1000, 'iterative layout must handle 1000 nodes without stack overflow');
  assert.strictEqual(large.edges.length, 999);

  const defaultPositions = new Map(branch.nodes.map(item => [item.id, { x: item.x, y: item.y }]));
  const manual = new Map(defaultPositions);
  manual.set('RAW', { x: 500, y: 300, manual: true });
  const preserved = canvas.reconcileVersionTreeCanvasPositions({ nodes: branch.nodes, previous: manual, nodeWidth: base.nodeWidth, nodeHeight: base.nodeHeight });
  assert.strictEqual(preserved.get('RAW'), manual.get('RAW'), 'existing manual coordinates must preserve their exact object and values');
  const withNewNode = canvas.reconcileVersionTreeCanvasPositions({ nodes: [...branch.nodes, { id: 'new', x: 0, y: 0 }], previous: preserved, nodeWidth: base.nodeWidth, nodeHeight: base.nodeHeight });
  for (const id of preserved.keys()) assert.strictEqual(withNewNode.get(id), preserved.get(id), 'adding a node must not rearrange existing nodes');
  assert(withNewNode.has('new'));
  const alignedHistory = canvas.alignVersionTreeHistoryPositions({
    nodes: [...branch.nodes.filter(item => item.id !== 'RAW_selection'), { id: 'new', x: 900, y: 700 }],
    current: new Map([...preserved, ['new', { x: 940, y: 740, manual: true }]]),
    snapshot: new Map([...defaultPositions, ['deleted', { x: 10, y: 20, manual: true }]]),
    nodeWidth: base.nodeWidth,
    nodeHeight: base.nodeHeight,
  });
  assert.deepStrictEqual(alignedHistory.get('new'), { x: 940, y: 740, manual: true }, 'applying old history must preserve a node added after the snapshot');
  assert(!alignedHistory.has('deleted'), 'applying old history must not revive a node removed from the current graph');
  assert(!alignedHistory.has('RAW_selection'), 'history alignment must remove nodes that no longer exist');
  assert.deepStrictEqual(alignedHistory.get('RAW'), defaultPositions.get('RAW'), 'history alignment must still restore snapshot coordinates for surviving nodes');
  const persistedAutomatic = canvas.markVersionTreeCanvasPositionsPersisted(defaultPositions, new Set(['RAW']));
  assert.strictEqual(persistedAutomatic.get('RAW').manual, true, 'a successfully persisted automatic coordinate must use the same manual semantics as a reload');
  const graphChangedAfterPersistence = branch.nodes.map(item => item.id === 'RAW' ? { ...item, x: item.x + 700, y: item.y + 500 } : item);
  const currentSessionAfterGraphChange = canvas.reconcileVersionTreeCanvasPositions({ nodes: graphChangedAfterPersistence, previous: persistedAutomatic, nodeWidth: base.nodeWidth, nodeHeight: base.nodeHeight });
  const reloadedAfterGraphChange = canvas.reconcileVersionTreeCanvasPositions({ nodes: graphChangedAfterPersistence, previous: new Map([...persistedAutomatic].map(([id, position]) => [id, { x: position.x, y: position.y, manual: true }])), nodeWidth: base.nodeWidth, nodeHeight: base.nodeHeight });
  assert.deepStrictEqual(currentSessionAfterGraphChange.get('RAW'), reloadedAfterGraphChange.get('RAW'), 'graph changes must treat a just-persisted coordinate exactly like the same coordinate after reload');
  const patchedMirror = canvas.updateVersionTreeServerPositionMirror(new Map([['old', { x: 1, y: 2, manual: true }]]), new Map([['new', { x: 3, y: 4 }]]), 'patch');
  assert.deepStrictEqual([...patchedMirror.keys()].sort(), ['new', 'old'], 'patch mirror updates must retain untouched server keys');
  const replacedMirror = canvas.updateVersionTreeServerPositionMirror(patchedMirror, new Map([['new', { x: 5, y: 6 }]]), 'replace');
  assert.deepStrictEqual([...replacedMirror.keys()], ['new'], 'replace mirror updates must delete keys omitted by the repository replacement');
  assert.deepStrictEqual([...canvas.mappedVersionTreeServerNodeKeys(['mounted', 'not-mounted'], new Set(['mounted']))], ['mounted'], 'only server keys mapped to currently mounted nodes may be marked as applied');
  const clampedLegacy = canvas.reconcileVersionTreeCanvasPositions({ nodes: branch.nodes, previous: new Map([['RAW', { x: -220, y: -80, manual: true }]]), nodeWidth: base.nodeWidth, nodeHeight: base.nodeHeight });
  assert.deepStrictEqual(clampedLegacy.get('RAW'), { x: 0, y: 0, manual: true }, 'legacy negative saved coordinates must not clip nodes above or left of the viewport');
  const refreshed = canvas.reconcileVersionTreeCanvasPositions({ nodes: branch.nodes, previous: manual, nodeWidth: base.nodeWidth, nodeHeight: base.nodeHeight, refreshAll: true });
  assert.deepStrictEqual(refreshed.get('RAW'), defaultPositions.get('RAW'), 'explicit refresh must restore the complete default layout');
  const shuffledCanvas = canvas.reconcileVersionTreeCanvasPositions({ nodes: [...branch.nodes].reverse(), nodeWidth: base.nodeWidth, nodeHeight: base.nodeHeight });
  assert.deepStrictEqual([...shuffledCanvas.entries()].sort(), [...defaultPositions.entries()].sort(), 'canvas reconciliation must ignore input order');
  const groupStart = new Map([['a', { x: 20, y: 30 }], ['b', { x: 90, y: 110 }]]);
  const groupMoved = canvas.translateVersionTreeCanvasSelection(groupStart, 35, 45);
  assert.deepStrictEqual(groupMoved.get('a'), { x: 55, y: 75, manual: true });
  assert.deepStrictEqual(groupMoved.get('b'), { x: 125, y: 155, manual: true });
  const groupClamped = canvas.translateVersionTreeCanvasSelection(groupStart, -100, -100);
  assert.deepStrictEqual(groupClamped.get('a'), { x: 0, y: 0, manual: true }, 'group drag must clamp once without changing the spacing between selected nodes');
  assert.deepStrictEqual([groupClamped.get('b').x - groupClamped.get('a').x, groupClamped.get('b').y - groupClamped.get('a').y], [70, 80]);

  const mediaBands = layoutVersionTree({
    ...base,
    nodes: [
      { ...node('raw', 'original', 0), mediaKind: 'image' },
      { ...node('jpg', 'original', 1), mediaKind: 'image', artifactKind: 'companion' },
      { ...node('image-v1', 'progress', 2), mediaKind: 'image' },
      { ...node('mov', 'original', 0), mediaKind: 'video' },
      { ...node('mov-transcode', 'artifact', 1), mediaKind: 'video', artifactKind: 'transcode' },
      { ...node('video-selection', 'selection', 2, 'auxiliary'), mediaKind: 'video' },
    ],
    edges: [
      edge('raw', 'jpg', 'media_companion'), edge('raw', 'image-v1', 'main'),
      edge('mov', 'mov-transcode', 'derived_transcode'), edge('mov', 'video-selection', 'auxiliary'),
    ],
  });
  const mediaById = new Map(mediaBands.nodes.map(item => [item.id, item]));
  assert.strictEqual(mediaById.get('raw').x, mediaById.get('jpg').x, 'RAW and its companion JPG must share a source column');
  assert.strictEqual(mediaById.get('mov').x, mediaById.get('mov-transcode').x, 'MOV and its transcode must share a source column');
  assert(mediaById.get('image-v1').x > mediaById.get('raw').x, 'main progress must advance from left to right');
  const imageBandBottom = Math.max(...mediaBands.nodes.filter(item => item.mediaKind === 'image').map(item => item.y + base.nodeHeight));
  const videoBandTop = Math.min(...mediaBands.nodes.filter(item => item.mediaKind === 'video').map(item => item.y));
  assert.strictEqual(videoBandTop - imageBandBottom, 112, 'image and video workflows must use the stable compact swimlane gap');
  assert.deepStrictEqual(
    canvas.versionTreeAreaSize({ width: 900, height: 600 }, { width: 420, height: 260 }, { width: 120, height: 80 }),
    { width: 420, height: 260 },
    'an explicitly resized area must be allowed to shrink below its initial natural size',
  );
  assert.deepStrictEqual(
    canvas.versionTreeAreaSize({ width: 900, height: 600 }, { width: 40, height: 30 }, { width: 120, height: 80 }),
    { width: 120, height: 80 },
    'an area must not shrink below one node',
  );
  const canonicalVideo = layoutVersionTree({
    ...base,
    nodes: [
      { ...node('mov-source', 'original', 0), mediaKind: 'video' },
      { ...node('mov-transcode-canonical', 'artifact', 1), mediaKind: 'video', artifactKind: 'transcode' },
      { ...node('video-v1', 'progress', 2, 'main'), mediaKind: 'video' },
      { ...node('video-pick', 'selection', 3, 'auxiliary'), mediaKind: 'video' },
    ],
    edges: [
      edge('mov-source', 'mov-transcode-canonical', 'derived_transcode'),
      edge('mov-source', 'video-v1', 'main'),
      edge('mov-source', 'video-pick', 'auxiliary'),
      edge('video-pick', 'video-v1', 'workflow_input'),
    ],
  });
  const canonicalVideoById = new Map(canonicalVideo.nodes.map(item => [item.id, item]));
  assert.strictEqual(canonicalVideoById.get('video-v1').y, canonicalVideoById.get('mov-source').y, 'MOV and video progress 1 must form the horizontal solid mainline');
  assert.strictEqual(canonicalVideoById.get('video-v1').x, canonicalVideoById.get('video-pick').x, 'video selection must branch below the first progress column');
  assert(canonicalVideoById.get('video-pick').y > canonicalVideoById.get('video-v1').y, 'video selection must not displace the mainline into a lower row');
  assert.strictEqual(canonicalVideoById.get('mov-transcode-canonical').x, canonicalVideoById.get('mov-source').x, 'MOV transcode must stay below MOV in the source column');
  const workflowBranch = layoutVersionTree({
    ...base,
    nodes: [
      { ...node('source-root', 'original', 0), mediaKind: 'image' },
      { ...node('source-edit', 'progress', 1), mediaKind: 'image' },
      { ...node('team', 'workflow', 2), mediaKind: 'image', artifactKind: 'component_workspace' },
    ],
    edges: [edge('source-root', 'source-edit', 'main'), edge('source-root', 'team', 'workflow_input'), edge('source-edit', 'team', 'workflow_input')],
  });
  const workflowById = new Map(workflowBranch.nodes.map(item => [item.id, item]));
  assert(workflowById.get('team').x > workflowById.get('source-edit').x, 'team workflow must advance from the deepest explicit input');
  assert(workflowById.get('team').y > workflowById.get('source-edit').y, 'team workflow must render as a branch below its source lane');

  assert.strictEqual(edgeModel.versionTreeEdgePresentation('main').strokeDasharray, undefined, 'main relations must use solid lines');
  for (const kind of ['main', 'auxiliary', 'media_companion', 'derived_preview', 'derived_transcode', 'workflow_input']) {
    assert.strictEqual(edgeModel.versionTreeEdgePresentation(kind).strokeDasharray, undefined, `${kind} relations must use solid lines`);
  }
  assert.deepStrictEqual(['main', 'auxiliary', 'media_companion', 'derived_preview', 'derived_transcode', 'workflow_input'].map(edgeModel.versionTreeRelationLabel), ['版本关系', '选片关联', '配套素材', '预览产物', '转码产物', '工作流输入']);
  const relationNode = (id, nodeRole, artifactKind) => ({ id, projectId: 'p', mediaKind: 'image', nodeRole, artifactKind, folderMissing: false, ...(nodeRole === 'progress' ? { parentProgressId: 'raw', relationKind: 'main' } : {}) });
  assert.deepStrictEqual(edgeModel.allowedVersionTreeRelationKinds(relationNode('raw', 'original'), relationNode('jpg', 'artifact', 'companion')), ['media_companion']);
  assert.deepStrictEqual(edgeModel.allowedVersionTreeRelationKinds(relationNode('jpg', 'original', 'companion'), relationNode('selection', 'selection')), ['auxiliary'], 'camera JPG can own selection results');
  assert.deepStrictEqual(edgeModel.allowedVersionTreeRelationKinds(relationNode('jpg', 'original', 'companion'), relationNode('v1', 'progress')), [], 'camera JPG cannot parent the main version chain');
  assert.deepStrictEqual(edgeModel.allowedVersionTreeRelationKinds(relationNode('raw', 'original'), relationNode('preview', 'artifact', 'preview')), ['derived_preview']);
  assert.deepStrictEqual(edgeModel.allowedVersionTreeRelationKinds(relationNode('mov', 'original'), relationNode('transcode', 'artifact', 'transcode')), ['derived_transcode']);
  assert.deepStrictEqual(edgeModel.allowedVersionTreeRelationKinds(relationNode('selection', 'selection'), relationNode('v1', 'progress')), ['workflow_input']);
  assert.deepStrictEqual(edgeModel.allowedVersionTreeRelationKinds(relationNode('selection', 'selection'), { ...relationNode('orphan', 'progress'), parentProgressId: undefined, relationKind: undefined }), [], 'legacy orphan progress must be repaired before accepting workflow inputs');
  assert.deepStrictEqual(edgeModel.allowedVersionTreeRelationKinds(relationNode('artifact', 'artifact', 'preview'), relationNode('v1', 'progress')), [], 'illegal role pairs must not expose a relation type');
  assert.deepStrictEqual(edgeModel.allowedVersionTreeRelationKinds(relationNode('raw', 'original'), relationNode('ambiguous', 'artifact')), ['media_companion', 'derived_preview', 'derived_transcode'], 'ambiguous artifacts must require an explicit finite type choice');
  assert.match(edgeModel.versionTreeEdgePath(0, 0, 100, 100), /^M /);
  const parentRect = { x: 100, y: 100, width: 120, height: 80 };
  const directionCases = [
    [{ x: 320, y: 100, width: 120, height: 80 }, 'right', 'left'],
    [{ x: -120, y: 100, width: 120, height: 80 }, 'left', 'right'],
    [{ x: 100, y: -100, width: 120, height: 80 }, 'top', 'bottom'],
    [{ x: 100, y: 300, width: 120, height: 80 }, 'bottom', 'top'],
  ];
  for (const [childRect, startPort, endPort] of directionCases) {
    const geometry = edgeModel.versionTreeEdgeGeometry(parentRect, childRect);
    assert.strictEqual(geometry.startPort, startPort);
    assert.strictEqual(geometry.endPort, endPort);
    assert.match(geometry.path, /^M .+ C .+$/);
    assert(!/NaN|Infinity/.test(geometry.path), `the ${startPort} path must remain finite`);
  }
  const dirtyGeometry = edgeModel.versionTreeEdgeGeometry(
    { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: Number.NaN, height: 0 },
    { x: Number.NEGATIVE_INFINITY, y: Number.NaN, width: 0, height: Number.POSITIVE_INFINITY },
  );
  assert(!/NaN|Infinity/.test(dirtyGeometry.path), 'invalid drag coordinates must be sanitized before path generation');

  console.log('version tree layout model behavior tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
