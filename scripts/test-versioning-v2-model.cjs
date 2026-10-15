const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const model = await import(pathToFileURL(path.resolve(__dirname, '..', 'src', 'features', 'versioning', 'versioning-v2-model.ts')).href);
  assert.deepStrictEqual(Object.keys(model.VERSION_PANEL_DEFINITIONS), ['create', 'create-next', 'import', 'modify', 'confirm']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS.create.states], ['ready', 'processing', 'result', 'failure']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS['create-next'].states], ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS.import.states], ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS.modify.states], ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure']);
  assert.deepStrictEqual([...model.VERSION_PANEL_DEFINITIONS.confirm.states], ['loading', 'waiting_confirmation', 'committing', 'result', 'failure']);
  assert.strictEqual(model.exportedImageFolderCandidate('工作目录/JPG/one.jpg'), '工作目录/JPG');
  assert.strictEqual(model.exportedImageFolderCandidate('工作目录/jpeg/one.jpg'), '工作目录/jpeg');
  assert.strictEqual(model.exportedImageFolderCandidate('工作目录/客户_导出/one.jpg'), '工作目录/客户_导出');
  assert.strictEqual(model.exportedImageFolderCandidate('工作目录/普通文件夹/one.jpg'), '', 'ordinary folders must not trigger export-version onboarding');
  assert.deepStrictEqual(model.exportedImageFolderCandidates([
    '工作目录/JPG', '工作目录/JPG/子文件夹', '工作目录/客户_导出', '普通文件夹',
  ]), ['工作目录/JPG', '工作目录/客户_导出'], 'activation reconciliation must deduplicate discovered export folders');
  const promptMemory = new Map();
  const promptStorage = {
    getItem: key => promptMemory.get(key) || null,
    setItem: (key, value) => promptMemory.set(key, value),
  };
  const exportFolderIdentity = 'c:/workspace/project|工作目录/jpg';
  assert.strictEqual(model.exportFolderPromptWasShown(promptStorage, exportFolderIdentity), false);
  model.rememberExportFolderPromptShown(promptStorage, exportFolderIdentity);
  assert.strictEqual(model.exportFolderPromptWasShown(promptStorage, exportFolderIdentity), true, 'an export folder prompt must remain deduplicated after the workspace remounts');
  assert.strictEqual(model.exportFolderPromptWasShown(promptStorage, `${exportFolderIdentity}-new`), false, 'a different export folder must still receive its own prompt');
  assert.doesNotThrow(() => model.rememberExportFolderPromptShown({ setItem: () => { throw new Error('unavailable'); } }, exportFolderIdentity));
  assert.strictEqual(model.exportFolderPromptWasShown({ getItem: () => { throw new Error('unavailable'); } }, exportFolderIdentity), false);
  const queuedTreeTask = {
    type: 'version-tree-update', state: 'queued', progress: 0,
    message: '等待“完善版本文件校验信息”完成',
    metadata: { projectName: 'Project', progressId: 'progress-1' },
  };
  assert.deepStrictEqual(model.versionTreeTaskPanelProgress([queuedTreeTask], 'Project', 'progress-1'), {
    currentName: '等待“完善版本文件校验信息”完成', waiting: true,
  }, 'queued version edits must expose their real scheduler wait reason');
  assert.strictEqual(model.versionTreeTaskPanelProgress([queuedTreeTask], 'Other', 'progress-1'), undefined);
  assert.deepStrictEqual(model.versionTreeTaskPanelProgress([{
    ...queuedTreeTask,
    state: 'running',
    progress: 35,
    message: '正在修改版本树',
    metadata: { ...queuedTreeTask.metadata, processedCount: 7, totalCount: 20 },
  }], 'Project', 'progress-1'), {
    percentage: 35, processedCount: 7, totalCount: 20, currentName: '正在修改版本树', waiting: false,
  });
  assert.deepStrictEqual(model.normalizeTrackingPolicy('auxiliary', { trackingEnabled: true, renameFromParent: true, copyMissingFromParent: true }), {
    trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false,
  });
  assert.deepStrictEqual(model.normalizeProgressSetupTrackingPolicy('main', { trackingEnabled: true, renameSources: true, copyMissingFromParent: true }), {
    trackingEnabled: true, renameFromParent: true, copyMissingFromParent: true,
  }, 'the legacy progress setup field must persist the rename-from-parent policy');
  assert.deepStrictEqual(model.normalizeProgressSetupTrackingPolicy('auxiliary', { trackingEnabled: true, renameSources: true, copyMissingFromParent: true }), {
    trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false,
  });
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'original', trackingState: 'ready' }), '原始素材');
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'selection', relationKind: 'auxiliary', trackingState: 'disabled' }), '选片辅助节点');
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'progress', trackingState: 'stale' }), '待刷新');
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'progress', trackingState: 'needs_repair' }), '版本关系需要修复');
  assert.strictEqual(model.trackingStateLabel({ nodeRole: 'broll', trackingState: 'disabled' }), '花絮');
  assert.strictEqual(model.versionTreeNodeBadgeLabel({ nodeRole: 'artifact', artifactKind: 'preview', versionKey: 'legacy-preview-mov' }), '预览');
  assert.strictEqual(model.versionTreeNodeBadgeLabel({ nodeRole: 'artifact', artifactKind: 'transcode', versionKey: 'transcode-mov' }), '转码');
  assert.strictEqual(model.versionTreeNodeBadgeLabel({ nodeRole: 'workflow', artifactKind: 'component_workspace', versionKey: 'plugin-workspace' }), '工作流');
  assert.strictEqual(model.versionTreeNodeBadgeLabel({ nodeRole: 'workflow', sourceMetadata: { category: 'workflow', displayName: '云端校样', parentCapability: 'workflow-input' }, versionKey: 'opaque' }), '云端校样');
  assert.strictEqual(model.versionTreeNodeBadgeLabel({ nodeRole: 'progress', versionKey: '2' }), 'V2');
  assert.strictEqual(model.versionTreeNodeBadgeLabel({ nodeRole: 'broll', versionKey: 'adopt-internal' }), '花絮');
  assert.deepStrictEqual(model.planProgressRootMove('客户/一组/RAW'), { sourceRelativePath: '客户/一组/RAW', targetRelativePath: 'RAW', requiresMove: true });
  assert.strictEqual(model.selectionOutputName('客户/一组/RAW'), '图片选片');
  assert.strictEqual(model.selectionOutputName('客户/一组/MOV'), '视频选片');

  const base = { projectId: 'p', mediaKind: 'image', versionKey: '', displayName: '', folderPath: '', missingSince: undefined, trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false, trackingState: 'disabled', lastTrackedAt: undefined, trackingSnapshot: {}, folderSignature: '', tombstone: {}, repairBatchId: undefined, pendingOperationCount: 0, createdAt: 0, updatedAt: 0 };
  const importedRaw = { ...base, id: 'raw-import', nodeRole: 'original', relationKind: 'main', mediaKind: 'image', versionKey: 'import-d7439bee24773bcbfa2d0a97', folderMissing: false };
  const v1Branch = { ...base, id: 'v1-branch', nodeRole: 'progress', relationKind: 'main', mediaKind: 'image', versionKey: '1_1', parentProgressId: importedRaw.id, folderMissing: false };
  assert.strictEqual(model.isUserVersionKey(importedRaw.versionKey), false, 'import hashes are internal node keys, not user version numbers');
  assert.strictEqual(model.versionKindForParent('1', importedRaw), 'main');
  assert.strictEqual(model.versionKindForParent('1_1', importedRaw), 'branch');
  assert.strictEqual(model.versionKindForParent('1_2', v1Branch), 'main', 'V1_2 is the main continuation of V1_1');
  assert.strictEqual(model.versionKindForParent('1_1_1', v1Branch), 'branch', 'V1_1_1 is a child branch of V1_1');
  assert.strictEqual(model.versionKeyMatchesParentKind('1_8', v1Branch, 'main'), true, 'custom continuation numbers may skip ahead on the same branch');
  assert.strictEqual(model.versionKeyMatchesParentKind('1_1_8', v1Branch, 'branch'), true, 'custom child numbers must retain the complete parent prefix');
  assert.strictEqual(model.versionKeyMatchesParentKind('2_1', v1Branch, 'branch'), false, 'a custom child number cannot claim another parent prefix');
  assert.strictEqual(model.versionKeyWithFinalIndex('1_2', '7'), '1_7', 'only the final numeric segment of a branch-line continuation is user editable');
  assert.strictEqual(model.versionKeyWithFinalIndex('1_1_1', '3'), '1_1_3', 'child branch prefixes must be generated from the complete parent version');
  assert.strictEqual(model.versionKeyWithFinalIndex('1', '05'), '5', 'root version input must normalize leading zeroes without exposing a prefix');
  assert.deepStrictEqual(model.nextVersionKeys([importedRaw], 'image', importedRaw), { main: '1', branch: '1_1' }, 'a branch under an imported RAW source must start at V1_1');
  assert.deepStrictEqual(model.nextVersionKeys([importedRaw, v1Branch], 'image', importedRaw), { main: '1', branch: '1_2' }, 'sibling branches under RAW must increment only the visible child number');
  assert.deepStrictEqual(model.nextVersionKeys([importedRaw, { ...v1Branch, id: 'v2', versionKey: '2' }], 'image', { ...v1Branch, id: 'v2', versionKey: '2' }), { main: '3', branch: '2_1' });
  const v1BranchNext = { ...v1Branch, id: 'v1-branch-next', versionKey: '1_2', parentProgressId: v1Branch.id };
  assert.deepStrictEqual(model.nextVersionKeys([importedRaw, v1Branch], 'image', v1Branch), { main: '1_2', branch: '1_1_1' }, 'the main successor of V1_1 must remain on the V1 branch line');
  assert.deepStrictEqual(model.nextVersionKeys([importedRaw, v1Branch, v1BranchNext], 'image', v1Branch), { main: '1_3', branch: '1_1_1' }, 'a branch-line main successor must skip an occupied sibling number');
  assert.deepStrictEqual(model.nextVersionKeys([importedRaw, v1Branch, v1BranchNext], 'image', v1BranchNext), { main: '1_3', branch: '1_2_1' }, 'a continued branch version must support creating its own child branch');
  assert.strictEqual(model.progressTrackingAction({ ...base, id: 'branch', nodeRole: 'progress', relationKind: 'main', parentProgressId: importedRaw.id, versionKey: '1_1', trackingEnabled: true, trackingState: 'ready' }), 'refresh', 'V1_1 version branches must retain the full tracking workflow');
  assert.strictEqual(model.progressTrackingAction({ ...base, id: 'root-progress', nodeRole: 'progress', relationKind: undefined, parentProgressId: undefined, versionKey: '1', trackingEnabled: true, trackingState: 'ready' }), 'refresh', 'independent root progress must expose baseline refresh');
  assert.strictEqual(model.progressTrackingAction({ ...base, id: 'untracked', nodeRole: 'progress', relationKind: 'main', trackingEnabled: false, trackingState: 'disabled' }), null, 'an untracked node must not offer a refresh action');
  assert.strictEqual(model.progressTrackingAction({ ...base, id: 'broll', mediaKind: 'mixed', nodeRole: 'broll', trackingEnabled: false, trackingState: 'disabled' }), null, 'broll must never enter progress tracking');
  const nodes = [
    { ...base, id: 'root', nodeRole: 'original', relationKind: 'main', folderMissing: false },
    { ...base, id: 'hidden', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'root', folderMissing: true },
    { ...base, id: 'main', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'hidden', folderMissing: false },
    { ...base, id: 'selection', nodeRole: 'selection', relationKind: 'auxiliary', parentProgressId: 'main', folderMissing: false },
  ];
  const graph = model.projectVisibleVersionGraph(nodes);
  assert.deepStrictEqual(graph.folders.map(node => node.id), ['root', 'main', 'selection']);
  assert.deepStrictEqual(graph.edges, [
    { parentId: 'root', childId: 'main', relationKind: 'main' },
    { parentId: 'main', childId: 'selection', relationKind: 'auxiliary' },
  ]);
  const cyclic = model.projectVisibleVersionGraph([
    { ...nodes[0], id: 'a', parentProgressId: 'b' },
    { ...nodes[0], id: 'b', parentProgressId: 'a' },
  ]);
  assert.deepStrictEqual(new Set(cyclic.cycleNodeIds), new Set(['a', 'b']));
  assert.strictEqual(model.progressTrackingAction({ ...nodes[2], relationKind: 'auxiliary', nodeRole: 'selection' }), null);
  const trackedMain = nodes.map(node => node.id === 'main' ? { ...node, trackingEnabled: true, trackingState: 'ready', renameFromParent: true, copyMissingFromParent: true } : node);
  assert.strictEqual(model.progressRelationChangeError(trackedMain, 'main', null), '');
  const trackedMainNode = trackedMain.find(node => node.id === 'main');
  assert.deepStrictEqual(model.trackingPolicyForRelationChange(trackedMainNode, null), {
    trackingEnabled: false,
    trackingState: 'disabled',
    renameFromParent: false,
    copyMissingFromParent: false,
  });
  assert.deepStrictEqual(model.trackingPolicyForRelationChange(trackedMainNode, 'root'), {
    trackingEnabled: true,
    trackingState: 'stale',
    renameFromParent: true,
    copyMissingFromParent: true,
  });
  assert.strictEqual(model.progressRelationChangeError(nodes, 'main', null), '');
  assert.match(model.progressRelationChangeError(nodes, 'selection', null), /不能断开为根节点/);
  assert.strictEqual(model.progressRelationChangeError(nodes, 'main', 'selection'), '', 'selection to progress is a valid workflow_input');

  const semanticNodes = [
    { ...base, id: 'raw-semantic', nodeRole: 'original', relationKind: undefined, folderMissing: false, displayName: '不是靠名称识别', versionKey: 'zzz' },
    { ...base, id: 'camera-jpg', nodeRole: 'original', artifactKind: 'companion', relationKind: undefined, folderMissing: false, displayName: 'RAW', versionKey: '1' },
    { ...base, id: 'generated-jpg', nodeRole: 'artifact', artifactKind: 'preview', relationKind: undefined, folderMissing: false, displayName: '图片后期_999', versionKey: '999' },
    { ...base, id: 'image-selection', nodeRole: 'selection', relationKind: 'auxiliary', parentProgressId: 'raw-semantic', folderMissing: false, displayName: '随意名称', versionKey: '0' },
    { ...base, id: 'team-workflow', nodeRole: 'workflow', artifactKind: 'component_workspace', relationKind: undefined, folderMissing: false, displayName: '也不靠名称', versionKey: '0' },
    { ...base, id: 'broll-semantic', mediaKind: 'mixed', nodeRole: 'broll', relationKind: undefined, folderMissing: false, displayName: '幕后花絮', versionKey: 'adopt-broll' },
    { ...base, id: 'legacy-orphan', nodeRole: 'progress', relationKind: undefined, parentProgressId: undefined, folderMissing: false, displayName: '旧版 V1', versionKey: '1' },
  ];
  const genericWorkflow = { ...base, id: 'generic-workflow', nodeRole: 'workflow', folderMissing: false, sourceMetadata: { category: 'workflow', role: 'component-workspace', displayName: '云端校样', componentId: 'cloud-proofing', parentCapability: 'workflow-input' } };
  const nonParentVersion = { ...base, id: 'non-parent', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'raw-semantic', folderMissing: false, sourceMetadata: { category: 'artifact', role: 'output', parentCapability: 'none' } };
  const semanticEdges = [
    { id: 'companion', projectId: 'p', sourceProgressId: 'raw-semantic', targetProgressId: 'camera-jpg', edgeKind: 'media_companion', createdAt: 0, updatedAt: 0 },
    { id: 'preview', projectId: 'p', sourceProgressId: 'raw-semantic', targetProgressId: 'generated-jpg', edgeKind: 'derived_preview', createdAt: 0, updatedAt: 0 },
    { id: 'invalid-jpg-team', projectId: 'p', sourceProgressId: 'camera-jpg', targetProgressId: 'team-workflow', edgeKind: 'workflow_input', createdAt: 0, updatedAt: 0 },
  ];
  const semanticGraph = model.projectVisibleVersionGraph(semanticNodes, semanticEdges);
  assert.deepStrictEqual(
    semanticGraph.edges.filter(edge => edge.id).map(edge => ({ id: edge.id, parentId: edge.parentId, childId: edge.childId, relationKind: edge.relationKind })),
    [
      { id: 'preview', parentId: 'raw-semantic', childId: 'generated-jpg', relationKind: 'derived_preview' },
      { id: 'companion', parentId: 'raw-semantic', childId: 'camera-jpg', relationKind: 'media_companion' },
    ],
    'the executable graph projection must preserve supplemental edges instead of relying on a source-string assertion',
  );
  assert.deepStrictEqual(model.selectableVersionParents(semanticNodes, { mediaKind: 'image', relationKind: 'main' }).map(node => node.id), ['raw-semantic', 'legacy-orphan'], 'independent roots can parent later versions');
  const cameraSelectionNodes = semanticNodes.map(node => node.id === 'camera-jpg'
    ? { ...node, sourceMetadata: { category: 'original', role: 'companion', parentCapability: 'none' } } : node);
  assert.strictEqual(model.progressRelationChangeError(cameraSelectionNodes, 'image-selection', 'camera-jpg'), '', 'camera JPG can own an auxiliary selection even when structural parenting is disabled');
  assert.match(model.progressRelationChangeError(cameraSelectionNodes, 'legacy-orphan', 'camera-jpg'), /不能作为结构父版本/, 'camera JPG remains excluded from the main version chain');
  assert.deepStrictEqual(model.selectableWorkflowInputs([...semanticNodes, genericWorkflow], 'image').map(node => node.id), ['image-selection', 'team-workflow', 'generic-workflow'], 'component workflow inputs are discovered through generic source metadata');
  assert.strictEqual(model.workflowInputLabel(genericWorkflow), '云端校样');
  assert(!model.selectableVersionParents([...semanticNodes, nonParentVersion], { mediaKind: 'image', relationKind: 'main' }).some(node => node.id === 'non-parent'), 'source metadata can forbid a version from becoming a structural parent');
  assert(!model.projectVisibleVersionGraph(semanticNodes, semanticEdges).edges.some(edge => edge.parentId === 'broll-semantic' || edge.childId === 'broll-semantic'), 'broll must remain outside main/auxiliary and supplemental version edges');
  assert(model.selectableVersionParents(semanticNodes, { mediaKind: 'image', relationKind: 'main' }).some(node => node.id === 'legacy-orphan'), 'a root progress can become the parent of new progress');
  assert.strictEqual(model.defaultMainParentId(semanticNodes, semanticEdges, 'image'), 'legacy-orphan', 'an existing root progress is the visible mainline leaf');
  const videoNodes = [
    { ...base, id: 'mov-semantic', mediaKind: 'video', nodeRole: 'original', relationKind: undefined, folderMissing: false, displayName: '不是 MOV', versionKey: 'transcode-source' },
    { ...base, id: 'mov-transcode', mediaKind: 'video', nodeRole: 'artifact', artifactKind: 'transcode', relationKind: undefined, folderMissing: false, displayName: 'MOV_转码', versionKey: 'transcode-mov' },
  ];
  const videoEdges = [{ id: 'video-transcode-edge', projectId: 'p', sourceProgressId: 'mov-semantic', targetProgressId: 'mov-transcode', edgeKind: 'derived_transcode', createdAt: 0, updatedAt: 0 }];
  assert.strictEqual(model.defaultMainParentId(videoNodes, videoEdges, 'video'), 'mov-semantic', 'MOV/transcode semantics select MOV through roles and graph edges');
  assert.deepStrictEqual(model.defaultWorkflowInputIds(semanticNodes, semanticEdges, 'raw-semantic'), ['image-selection'], 'the first post-production progress defaults to the source selection');
  const v1 = { ...base, id: 'v1', nodeRole: 'progress', relationKind: 'main', parentProgressId: 'raw-semantic', folderMissing: false, displayName: '无版本名称', versionKey: 'not-a-number' };
  assert.strictEqual(model.defaultMainParentId([...semanticNodes, v1], semanticEdges, 'image'), '', 'multiple independent progress leaves require an explicit parent choice');
  assert.deepStrictEqual(model.defaultWorkflowInputIds([...semanticNodes, v1], semanticEdges, 'v1'), [], 'selection is not propagated to later versions');
  assert.deepStrictEqual(model.selectableVersionParents([...semanticNodes, v1], { mediaKind: 'image', relationKind: 'main' }).map(node => node.id), ['raw-semantic', 'legacy-orphan', 'v1'], 'original, root, and connected progress nodes remain manually selectable');
  assert.strictEqual(model.defaultMainParentId([
    semanticNodes[0],
    { ...semanticNodes[0], id: 'other-original' },
  ], [], 'image'), '', 'ambiguous original sources require an explicit user choice');
  const persistedWorkflowEdge = { id: 'workflow', projectId: 'p', sourceProgressId: 'team-workflow', targetProgressId: 'v1', edgeKind: 'workflow_input', createdAt: 0, updatedAt: 0 };
  assert.deepStrictEqual(model.defaultWorkflowInputIds([...semanticNodes, v1], [persistedWorkflowEdge], 'raw-semantic', 'v1'), ['team-workflow', 'image-selection'], 'modify mode preserves persisted workflow inputs and restores the selection input derived from the original parent');
  assert.deepStrictEqual(
    model.workflowInputIdsForRelationChange([...semanticNodes, v1], [persistedWorkflowEdge], 'v1', 'raw-semantic'),
    ['team-workflow', 'image-selection'],
    'manually connecting RAW to V1 atomically preserves workflow inputs and adds the matching selection input',
  );
  assert.deepStrictEqual(
    model.workflowInputIdsForRelationChange([...semanticNodes, v1], [persistedWorkflowEdge], 'v1', 'v1'),
    ['team-workflow'],
    'connecting to another progress removes selection inputs that belong to the original source',
  );
  assert.deepStrictEqual(
    model.workflowInputIdsForRelationChange([...semanticNodes, v1], [
      persistedWorkflowEdge,
      { id: 'selection-input', projectId: 'p', sourceProgressId: 'image-selection', targetProgressId: 'v1', edgeKind: 'workflow_input', createdAt: 0, updatedAt: 0 },
    ], 'v1', null),
    ['team-workflow'],
    'disconnecting original material removes its derived selection input while preserving manually attached workflow inputs',
  );
  const videoSelection = { ...base, id: 'video-selection', mediaKind: 'video', nodeRole: 'selection', relationKind: 'auxiliary', parentProgressId: 'mov-semantic', folderMissing: false };
  const videoV1 = { ...base, id: 'video-v1', mediaKind: 'video', nodeRole: 'progress', relationKind: 'main', folderMissing: false };
  assert.deepStrictEqual(
    model.workflowInputIdsForRelationChange([...videoNodes, videoSelection, videoV1], [], 'video-v1', 'mov-semantic'),
    ['video-selection'],
    'manually connecting MOV to video V1 atomically adds the matching video-selection input',
  );
  console.log('versioning V2 production model tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
