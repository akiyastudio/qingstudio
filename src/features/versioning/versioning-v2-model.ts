import type { BackgroundTask, ProgressFolder, VersionGraphEdge } from '../../types';

const VERSIONING_VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'mpeg', 'mpg', 'mts', 'm2ts', 'crm']);
const VERSIONING_RAW_EXTENSIONS = new Set(['cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'dng', 'rwl', '3fr', 'fff', 'iiq', 'pef', 'srw']);
export const versioningMediaKind = (filePath: string): 'image' | 'raw' | 'video' => {
  const extension = filePath.split('.').pop()?.toLocaleLowerCase() || '';
  if (VERSIONING_VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (VERSIONING_RAW_EXTENSIONS.has(extension)) return 'raw';
  return 'image';
};

export type VersionPanelKind = 'create' | 'create-next' | 'import' | 'modify' | 'confirm';
export type VersionPanelState = 'ready' | 'move_confirm' | 'processing' | 'waiting_confirmation' | 'loading' | 'committing' | 'result' | 'failure';
export type VersionRelationKind = 'main' | 'auxiliary';
export type VersionTrackingPolicy = Pick<ProgressFolder, 'trackingEnabled' | 'renameFromParent' | 'copyMissingFromParent'>;
export type VersionPanelTaskProgress = {
  percentage?: number;
  processedCount?: number;
  totalCount?: number;
  currentName?: string;
  waiting?: boolean;
};

export const versionSourceMetadata = (folder: Pick<ProgressFolder, 'nodeRole' | 'artifactKind' | 'sourceMetadata'>) => folder.sourceMetadata
  || {
    category: folder.nodeRole,
    role: folder.artifactKind,
    parentCapability: folder.nodeRole === 'original' || folder.nodeRole === 'progress'
      ? 'structural' as const
      : folder.nodeRole === 'selection' || folder.nodeRole === 'workflow'
        ? 'workflow-input' as const
        : 'none' as const,
  };

export const VERSION_PANEL_DEFINITIONS: Record<VersionPanelKind, { title: string; states: readonly VersionPanelState[] }> = {
  create: { title: '新建进度', states: ['ready', 'processing', 'result', 'failure'] },
  'create-next': { title: '创建下一版本', states: ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure'] },
  import: { title: '导入进度', states: ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure'] },
  modify: { title: '修改进度', states: ['ready', 'move_confirm', 'processing', 'waiting_confirmation', 'result', 'failure'] },
  confirm: { title: '确认版本匹配', states: ['loading', 'waiting_confirmation', 'committing', 'result', 'failure'] },
};

const taskMetadataCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? value
  : undefined;

export const versionTreeTaskPanelProgress = (
  tasks: readonly BackgroundTask[],
  projectName: string,
  progressId: string,
): VersionPanelTaskProgress | undefined => {
  if (!progressId) return undefined;
  const task = tasks.find(candidate => candidate.type === 'version-tree-update'
    && candidate.metadata?.projectName === projectName
    && candidate.metadata?.progressId === progressId
    && (candidate.state === 'queued' || candidate.state === 'running'));
  if (!task) return undefined;
  const processedCount = taskMetadataCount(task.metadata?.processedCount);
  const totalCount = taskMetadataCount(task.metadata?.totalCount);
  return {
    ...(task.progress > 0 ? { percentage: task.progress } : {}),
    ...(processedCount !== undefined ? { processedCount } : {}),
    ...(totalCount !== undefined ? { totalCount } : {}),
    currentName: task.message || (task.state === 'queued' ? '正在等待其他文件操作完成…' : '正在修改版本树…'),
    waiting: task.state === 'queued',
  };
};

export const normalizeVersionPath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

export const exportedImageFolderCandidate = (relativePath: string) => {
  const parts = normalizeVersionPath(relativePath).split('/').filter(Boolean);
  const exportIndex = parts.findIndex(part => /^(?:jpg|jpeg)$/iu.test(part) || part.endsWith('导出'));
  return exportIndex < 0 ? '' : parts.slice(0, exportIndex + 1).join('/');
};

export const exportedImageFolderCandidates = (relativePaths: readonly string[]) => [...new Set(relativePaths
  .map(exportedImageFolderCandidate)
  .filter(Boolean))];

const EXPORT_FOLDER_PROMPT_STORAGE_PREFIX = 'photoflow:export-folder-prompt-shown:v1:';

export const exportFolderPromptStorageKey = (identity: string) => `${EXPORT_FOLDER_PROMPT_STORAGE_PREFIX}${encodeURIComponent(identity)}`;

export const exportFolderPromptWasShown = (storage: Pick<Storage, 'getItem'> | undefined, identity: string) => {
  if (!storage || !identity) return false;
  try {
    return storage.getItem(exportFolderPromptStorageKey(identity)) === '1';
  } catch {
    return false;
  }
};

export const rememberExportFolderPromptShown = (storage: Pick<Storage, 'setItem'> | undefined, identity: string) => {
  if (!storage || !identity) return;
  try {
    storage.setItem(exportFolderPromptStorageKey(identity), '1');
  } catch {
    // In-memory deduplication remains available when persistent storage is unavailable.
  }
};

export const isUserVersionKey = (value: string) => /^\d+(?:_\d+)*$/.test(value);

export const versionKeyWithFinalIndex = (suggestedVersionKey: string, value: string) => {
  const digits = value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  const parts = suggestedVersionKey.split('_');
  const prefix = parts.length > 1 ? `${parts.slice(0, -1).join('_')}_` : '';
  return `${prefix}${digits}`;
};

export const versionKindForParent = (
  versionKey: string | undefined,
  parent?: Pick<ProgressFolder, 'nodeRole' | 'versionKey'>,
): 'main' | 'branch' => {
  if (!versionKey || !isUserVersionKey(versionKey)) return 'main';
  const parentKey = parent?.nodeRole === 'progress' && isUserVersionKey(parent.versionKey) ? parent.versionKey : '';
  if (!parentKey) return versionKey.includes('_') ? 'branch' : 'main';
  const versionParts = versionKey.split('_');
  const parentParts = parentKey.split('_');
  return versionParts.length === parentParts.length + 1 && versionKey.startsWith(`${parentKey}_`)
    ? 'branch'
    : 'main';
};

export const versionKeyMatchesParentKind = (
  versionKey: string | undefined,
  parent: Pick<ProgressFolder, 'nodeRole' | 'versionKey'> | undefined,
  versionKind: 'main' | 'branch',
) => {
  if (!versionKey || !isUserVersionKey(versionKey)) return false;
  const parts = versionKey.split('_');
  if (!parent) return versionKind === 'main' && parts.length === 1;
  if (parent.nodeRole !== 'progress' || !isUserVersionKey(parent.versionKey)) {
    return versionKind === 'branch' ? parts.length === 2 : parts.length === 1;
  }
  const parentParts = parent.versionKey.split('_');
  if (versionKind === 'branch') {
    return parts.length === parentParts.length + 1 && versionKey.startsWith(`${parent.versionKey}_`);
  }
  if (parts.length !== parentParts.length) return false;
  return parentParts.length === 1 || parts.slice(0, -1).join('_') === parentParts.slice(0, -1).join('_');
};

export const nextVersionKeys = (
  folders: ProgressFolder[],
  mediaKind: ProgressFolder['mediaKind'],
  parent?: ProgressFolder,
  excludeProgressId = '',
) => {
  const versions = folders.filter(folder => folder.id !== excludeProgressId
    && folder.mediaKind === mediaKind
    && folder.nodeRole === 'progress'
    && folder.relationKind !== 'auxiliary'
    && isUserVersionKey(folder.versionKey));
  const parentKey = parent?.nodeRole === 'progress' && isUserVersionKey(parent.versionKey) ? parent.versionKey : '';
  const nextAtDepth = (base: string) => {
    const baseParts = base ? base.split('_') : [];
    const prefix = baseParts.length > 1 ? `${baseParts.slice(0, -1).join('_')}_` : '';
    const depth = baseParts.length || 1;
    return versions.reduce((highest, folder) => {
      const parts = folder.versionKey.split('_');
      if (parts.length !== depth || (prefix && !folder.versionKey.startsWith(prefix))) return highest;
      return Math.max(highest, Number(parts.at(-1)) || 0);
    }, 0) + 1;
  };
  // A main successor stays on its parent's visible line. Thus V2 advances to
  // V3, while V1_1 advances to V1_2 instead of jumping back to global V3.
  const main = parentKey.includes('_')
    ? `${parentKey.split('_').slice(0, -1).join('_')}_${nextAtDepth(parentKey)}`
    : String(nextAtDepth(parentKey));
  if (!parent) return { main, branch: '' };
  // Original/artifact nodes use internal keys such as `import-<hash>`. Those
  // keys identify database nodes and must never leak into a user version name.
  // A branch directly below an original source starts at the first visible
  // version line, while a branch below V2/V2_1 keeps that visible prefix.
  const branchBase = parentKey || '1';
  const prefix = `${branchBase}_`;
  const parentDepth = branchBase.split('_').length;
  const child = versions.reduce((highest, folder) => {
    const parts = folder.versionKey.split('_');
    return folder.versionKey.startsWith(prefix) && parts.length === parentDepth + 1
      ? Math.max(highest, Number(parts.at(-1)) || 0)
      : highest;
  }, 0) + 1;
  return { main, branch: `${branchBase}_${child}` };
};

export const normalizeTrackingPolicy = (relationKind: VersionRelationKind, requested: Partial<VersionTrackingPolicy>): VersionTrackingPolicy => {
  if (relationKind === 'auxiliary') return { trackingEnabled: false, renameFromParent: false, copyMissingFromParent: false };
  const trackingEnabled = Boolean(requested.trackingEnabled);
  return {
    trackingEnabled,
    renameFromParent: trackingEnabled && Boolean(requested.renameFromParent),
    copyMissingFromParent: trackingEnabled && Boolean(requested.copyMissingFromParent),
  };
};

export const normalizeProgressSetupTrackingPolicy = (relationKind: VersionRelationKind, requested: {
  trackingEnabled?: boolean;
  renameSources?: boolean;
  copyMissingFromParent?: boolean;
}): VersionTrackingPolicy => normalizeTrackingPolicy(relationKind, {
  trackingEnabled: requested.trackingEnabled,
  renameFromParent: requested.renameSources,
  copyMissingFromParent: requested.copyMissingFromParent,
});

export const versionNodeRole = (relationKind: VersionRelationKind): ProgressFolder['nodeRole'] => relationKind === 'auxiliary' ? 'selection' : 'progress';

export const trackingStateLabel = (folder: Pick<ProgressFolder, 'nodeRole' | 'relationKind' | 'trackingState'>) => {
  if (folder.nodeRole === 'original') return '原始素材';
  if (folder.nodeRole === 'broll') return '花絮';
  if (folder.nodeRole === 'selection' || folder.relationKind === 'auxiliary') return '选片辅助节点';
  if (folder.nodeRole === 'artifact') return '派生产物';
  if (folder.nodeRole === 'workflow') return '工作流节点';
  if (folder.trackingState === 'disabled') return '未跟踪';
  if (folder.trackingState === 'ready') return '已跟踪';
  if (folder.trackingState === 'stale') return '待刷新';
  if (folder.trackingState === 'needs_repair') return '版本关系需要修复';
  return '跟踪处理中';
};

export const versionTreeNodeBadgeLabel = (folder: Pick<ProgressFolder, 'nodeRole' | 'relationKind' | 'artifactKind' | 'sourceMetadata' | 'versionKey'>) => {
  const source = versionSourceMetadata(folder);
  if (source.displayName) return source.displayName;
  if (folder.nodeRole === 'original') return '原始素材';
  if (folder.nodeRole === 'broll') return '花絮';
  if (folder.nodeRole === 'selection' || folder.relationKind === 'auxiliary') return '选片';
  if (folder.nodeRole === 'artifact' && folder.artifactKind === 'preview') return '预览';
  if (folder.nodeRole === 'artifact' && folder.artifactKind === 'transcode') return '转码';
  if (folder.nodeRole === 'artifact') return '派生产物';
  if (folder.nodeRole === 'workflow') return '工作流';
  return `V${folder.versionKey}`;
};

export const progressTrackingAction = (folder: ProgressFolder): 'refresh' | 'resume' | 'repair' | null => {
  if (folder.folderMissing || folder.nodeRole !== 'progress' || folder.relationKind !== 'main' || !folder.parentProgressId) return null;
  if (folder.trackingState === 'needs_repair') return 'repair';
  if (!folder.trackingEnabled || folder.trackingState === 'disabled') return null;
  if (folder.trackingState === 'pending_compare' || folder.trackingState === 'pending_confirm' || folder.trackingState === 'committing') return 'resume';
  return 'refresh';
};

export const progressTrackingActionLabel = (folder: ProgressFolder) => {
  const action = progressTrackingAction(folder);
  if (action === 'repair') return '修复版本关系';
  if (action === 'resume') return '继续版本跟踪';
  return action === 'refresh' ? '刷新版本跟踪' : '';
};

export const requiresProgressRootMove = (relativePath: string, nodeRole: ProgressFolder['nodeRole']) => nodeRole === 'progress' && normalizeVersionPath(relativePath).includes('/');

export const planProgressRootMove = (relativePath: string) => {
  const sourceRelativePath = normalizeVersionPath(relativePath);
  const targetRelativePath = sourceRelativePath.split('/').pop() || '';
  return { sourceRelativePath, targetRelativePath, requiresMove: Boolean(targetRelativePath && sourceRelativePath !== targetRelativePath) };
};

export const isStructuralMainParent = (folder: ProgressFolder) => !folder.folderMissing
  && versionSourceMetadata(folder).parentCapability === 'structural'
  && folder.relationKind !== 'auxiliary'
  && (folder.nodeRole === 'progress' && Boolean(folder.parentProgressId) && folder.relationKind === 'main'
    || folder.nodeRole === 'original' && folder.artifactKind !== 'companion' && folder.artifactKind !== 'preview');

export const selectableVersionParents = (folders: ProgressFolder[], draft: { mediaKind: ProgressFolder['mediaKind']; relationKind: VersionRelationKind; existingProgressId?: string }) => {
  const byParent = new Map<string, string[]>();
  folders.forEach(folder => {
    if (!folder.parentProgressId) return;
    const children = byParent.get(folder.parentProgressId) || [];
    children.push(folder.id);
    byParent.set(folder.parentProgressId, children);
  });
  const excluded = new Set<string>();
  const stack = draft.existingProgressId ? [draft.existingProgressId] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (excluded.has(id)) continue;
    excluded.add(id);
    stack.push(...(byParent.get(id) || []));
  }
  return folders.filter(folder => !folder.folderMissing
    && folder.mediaKind === draft.mediaKind
    && !excluded.has(folder.id)
    && isStructuralMainParent(folder));
};

export const defaultMainParentId = (
  folders: ProgressFolder[],
  graphEdges: VersionGraphEdge[],
  mediaKind: ProgressFolder['mediaKind'],
) => {
  const candidates = selectableVersionParents(folders, { mediaKind, relationKind: 'main' });
  const candidateIds = new Set(candidates.map(folder => folder.id));
  const progressNodes = candidates.filter(folder => folder.nodeRole === 'progress');
  if (progressNodes.length) {
    const progressParentIds = new Set(progressNodes.map(folder => folder.parentProgressId).filter((id): id is string => Boolean(id) && candidateIds.has(id!)));
    const leaves = progressNodes.filter(folder => !progressParentIds.has(folder.id));
    return leaves.length === 1 ? leaves[0].id : '';
  }

  const originals = candidates.filter(folder => folder.nodeRole === 'original');
  const companionTargets = new Set(graphEdges
    .filter(edge => edge.edgeKind === 'media_companion' || edge.edgeKind === 'derived_preview' || edge.edgeKind === 'derived_transcode')
    .map(edge => edge.targetProgressId));
  const semanticSources = originals.filter(folder => !companionTargets.has(folder.id));
  return semanticSources.length === 1 ? semanticSources[0].id : '';
};

export const selectableWorkflowInputs = (folders: ProgressFolder[], mediaKind: ProgressFolder['mediaKind']) => folders.filter(folder => !folder.folderMissing
  && folder.mediaKind === mediaKind
  && versionSourceMetadata(folder).parentCapability === 'workflow-input');

export const workflowInputLabel = (folder: ProgressFolder) => versionSourceMetadata(folder).displayName
  || (folder.nodeRole === 'workflow' ? '组件工作流' : folder.mediaKind === 'video' ? '视频选片' : '图片选片');

export const defaultWorkflowInputIds = (
  folders: ProgressFolder[],
  graphEdges: VersionGraphEdge[],
  parentProgressId: string,
  existingProgressId?: string,
) => {
  const persistedInputIds = existingProgressId ? graphEdges
    .filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === existingProgressId)
    .map(edge => edge.sourceProgressId) : [];
  const parent = folders.find(folder => folder.id === parentProgressId);
  if (!parent || parent.nodeRole !== 'original' || parent.folderMissing) return persistedInputIds;
  const selections = folders.filter(folder => !folder.folderMissing
    && folder.nodeRole === 'selection'
    && folder.mediaKind === parent.mediaKind
    && folder.parentProgressId === parent.id);
  if (existingProgressId) return [...new Set([...persistedInputIds, ...selections.map(folder => folder.id)])];
  const hasMainProgress = folders.some(folder => !folder.folderMissing
    && folder.nodeRole === 'progress'
    && folder.relationKind !== 'auxiliary'
    && folder.parentProgressId === parent.id);
  if (hasMainProgress) return [];
  return selections.length === 1 ? [selections[0].id] : [];
};

/** Build the workflow-input side of a manual structural relation change. */
export const workflowInputIdsForRelationChange = (
  folders: ProgressFolder[],
  graphEdges: VersionGraphEdge[],
  childProgressId: string,
  parentProgressId: string | null,
) => {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const existingInputIds = graphEdges
    .filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === childProgressId)
    .map(edge => edge.sourceProgressId);
  const preservedWorkflowIds = existingInputIds.filter(id => {
    const source = byId.get(id);
    return source?.nodeRole === 'workflow' && versionSourceMetadata(source).parentCapability === 'workflow-input';
  });
  const parent = parentProgressId ? byId.get(parentProgressId) : undefined;
  const matchingSelectionIds = parent?.nodeRole === 'original'
    ? folders
      .filter(folder => !folder.folderMissing
        && folder.nodeRole === 'selection'
        && folder.mediaKind === parent.mediaKind
        && folder.parentProgressId === parent.id)
      .map(folder => folder.id)
    : [];
  return [...new Set([...preservedWorkflowIds, ...matchingSelectionIds])];
};

export const trackingPolicyForRelationChange = (
  folder: ProgressFolder,
  parentProgressId: string | null,
) => parentProgressId ? {
  trackingEnabled: folder.trackingEnabled,
  trackingState: folder.trackingEnabled ? 'stale' as const : 'disabled' as const,
  renameFromParent: folder.renameFromParent,
  copyMissingFromParent: folder.copyMissingFromParent,
} : {
  trackingEnabled: false,
  trackingState: 'disabled' as const,
  renameFromParent: false,
  copyMissingFromParent: false,
};

export const progressRelationChangeError = (folders: ProgressFolder[], childId: string, parentId: string | null) => {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const child = byId.get(childId);
  if (!child) return '子节点不存在';
  if (child.nodeRole === 'original') return '原始素材不能拥有父节点';
  if (child.nodeRole === 'broll') return '花絮不进入版本关系';
  if (child.nodeRole === 'artifact') return '产物节点不使用结构父关系';
  if (parentId === null) {
    if (child.nodeRole === 'selection') return '选片节点不能断开为根节点';
    return '';
  }
  const parent = byId.get(parentId);
  if (parent && !parent.folderMissing && parent.mediaKind === child.mediaKind
    && child.nodeRole === 'progress' && versionSourceMetadata(parent).parentCapability === 'workflow-input') return '';
  if (parent && !parent.folderMissing && parent.mediaKind === child.mediaKind
    && versionSourceMetadata(child).parentCapability === 'workflow-input' && parent.nodeRole === 'progress') return '';
  if (child.nodeRole === 'workflow') return '组件工作流只能接收兼容的普通版本作为输入';
  if (!parent || parent.folderMissing) return '候选父节点不存在或已经失效';
  if (childId === parentId) return '节点不能连接到自己';
  if (parent.mediaKind !== child.mediaKind) return '父子节点媒体类型不一致';
  if (parent.nodeRole === 'selection' || parent.relationKind === 'auxiliary') return '不能挂到选片或附属分支下';
  if (versionSourceMetadata(parent).parentCapability !== 'structural') return '所选来源不能作为结构父版本';
  let cursor: ProgressFolder | undefined = parent;
  const visited = new Set<string>();
  while (cursor?.parentProgressId && !visited.has(cursor.id)) {
    if (cursor.parentProgressId === childId) return '不能挂到自己的后代下面';
    visited.add(cursor.id);
    cursor = byId.get(cursor.parentProgressId);
  }
  return '';
};

export type VisibleVersionEdge = { id?: string; parentId: string; childId: string; relationKind: VersionRelationKind | VersionGraphEdge['edgeKind'] };
export type VisibleVersionGraph = { folders: ProgressFolder[]; edges: VisibleVersionEdge[]; cycleNodeIds: string[] };

export const projectVisibleVersionGraph = (folders: ProgressFolder[], graphEdges: VersionGraphEdge[] = []): VisibleVersionGraph => {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const visible = folders.filter(folder => !folder.folderMissing);
  const cycleNodeIds = new Set<string>();
  const edges: VisibleVersionEdge[] = [];
  for (const start of folders) {
    const order = new Map<string, number>();
    const chain: string[] = [];
    let cursor: ProgressFolder | undefined = start;
    while (cursor) {
      const repeatedAt = order.get(cursor.id);
      if (repeatedAt !== undefined) {
        chain.slice(repeatedAt).forEach(id => cycleNodeIds.add(id));
        break;
      }
      order.set(cursor.id, chain.length);
      chain.push(cursor.id);
      cursor = cursor.parentProgressId ? byId.get(cursor.parentProgressId) : undefined;
    }
  }
  for (const folder of visible) {
    let parentId = folder.parentProgressId;
    const visited = new Set([folder.id]);
    while (parentId) {
      if (visited.has(parentId)) { visited.forEach(id => cycleNodeIds.add(id)); parentId = undefined; break; }
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) { parentId = undefined; break; }
      if (!parent.folderMissing) {
        if (cycleNodeIds.has(parent.id) || cycleNodeIds.has(folder.id)) parentId = undefined;
        break;
      }
      // Auxiliary descendants do not jump across a missing source. Main
      // descendants reconnect only through main ancestors.
      if (folder.relationKind === 'auxiliary') { parentId = undefined; break; }
      parentId = parent.relationKind === 'auxiliary' || parent.nodeRole === 'selection' ? undefined : parent.parentProgressId;
    }
    if (parentId) edges.push({ parentId, childId: folder.id, relationKind: folder.relationKind || 'main' });
  }
  for (const edge of [...graphEdges].sort((left, right) => left.edgeKind.localeCompare(right.edgeKind) || left.sourceProgressId.localeCompare(right.sourceProgressId) || left.targetProgressId.localeCompare(right.targetProgressId) || left.id.localeCompare(right.id))) {
    const source = byId.get(edge.sourceProgressId);
    const target = byId.get(edge.targetProgressId);
    if (!source || !target || source.folderMissing || target.folderMissing) continue;
    if (edge.edgeKind === 'workflow_input') {
      const valid = target.nodeRole === 'workflow'
        ? versionSourceMetadata(target).parentCapability === 'workflow-input' && source.nodeRole === 'progress'
        : target.nodeRole === 'progress' && versionSourceMetadata(source).parentCapability === 'workflow-input';
      if (!valid) continue;
    }
    edges.push({ id: edge.id, parentId: edge.sourceProgressId, childId: edge.targetProgressId, relationKind: edge.edgeKind });
  }
  return { folders: visible, edges, cycleNodeIds: [...cycleNodeIds] };
};

export const selectionOutputName = (sourceRelativePath: string) => {
  const name = normalizeVersionPath(sourceRelativePath).split('/').pop() || '';
  if (name.toLocaleLowerCase() === 'raw') return '图片选片';
  if (name.toLocaleLowerCase() === 'mov') return '视频选片';
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('来源文件夹名无效');
  return `${name}_选片`;
};
