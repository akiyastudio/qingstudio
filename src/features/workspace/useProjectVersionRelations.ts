import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ProgressFolder, VersionGraphEdge, WorkspaceProject } from '../../types';
import type { useAppDialog } from '../../components/AppDialogProvider';
import type { useTaskCenter } from '../background-tasks/TaskCenter';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { ProgressRelationMutationQueue, peekVersionTreeSnapshot, progressRelationChangeError, rememberVersionTreeSnapshot, trackingPolicyForRelationChange, workflowInputIdsForRelationChange } from '../versioning/public';

type VersionGraphHistoryEntry = { label: string; undo: () => Promise<void>; redo: () => Promise<void> };
type RelationProject = Pick<WorkspaceProject, 'name' | 'path' | 'status'>;
type BackgroundTasks = ReturnType<typeof useTaskCenter>['backgroundTasks'];
type RelationOptions = {
  active: boolean;
  projectWorkflows: boolean;
  workspacePath: string;
  project: RelationProject;
  progressFolders: ProgressFolder[];
  setProgressFolders: Dispatch<SetStateAction<ProgressFolder[]>>;
  versionGraphEdges: VersionGraphEdge[];
  setVersionGraphEdges: Dispatch<SetStateAction<VersionGraphEdge[]>>;
  onNotice: (message: string, duration?: number) => void;
  appDialog: ReturnType<typeof useAppDialog>;
  backgroundTasks: BackgroundTasks;
  dismissBackgroundTask: (taskId: string) => void;
  trackingConfirmationProgressId: string;
  setTrackingConfirmationProgressId: Dispatch<SetStateAction<string>>;
  setTrackingConfirmationSessionId: Dispatch<SetStateAction<string>>;
  activeRef: MutableRefObject<boolean>;
  projectPathRef: MutableRefObject<string>;
};

const safeStorageGet = (key: string) => { try { return window.localStorage.getItem(key) || ''; } catch { return ''; } };
const safeStorageSet = (key: string, value: string) => { try { window.localStorage.setItem(key, value); } catch { /* optional state */ } };
const safeStorageRemove = (key: string) => { try { window.localStorage.removeItem(key); } catch { /* optional state */ } };
const progressNodeMediaKind = (folder: Pick<ProgressFolder, 'mediaKind'>): 'image' | 'video' | null => folder.mediaKind === 'image' || folder.mediaKind === 'video' ? folder.mediaKind : null;

export const useProjectVersionRelations = ({
  active, projectWorkflows, workspacePath, project,
  progressFolders, setProgressFolders, versionGraphEdges, setVersionGraphEdges,
  onNotice, appDialog, backgroundTasks, dismissBackgroundTask,
  trackingConfirmationProgressId, setTrackingConfirmationProgressId, setTrackingConfirmationSessionId,
  activeRef, projectPathRef,
}: RelationOptions) => {
  const [draggingChildId, setDraggingChildId] = useState('');
  const [hoverParentId, setHoverParentId] = useState('');
  const [pendingRelationChange, setPendingRelationChange] = useState<{ childProgressId: string; parentProgressId: string | null } | null>(null);
  const [relationMutationId, setRelationMutationId] = useState(0);
  const relationMutationIdRef = useRef(0);
  const progressFoldersRef = useRef<ProgressFolder[]>([]);
  useEffect(() => { progressFoldersRef.current = progressFolders; }, [progressFolders]);
  const relationMutationQueueRef = useRef(new ProgressRelationMutationQueue());
  const relationMutationCountsRef = useRef(new Map<string, number>());
  const supplementalEdgeDeletionIdsRef = useRef(new Set<string>());
  const relationUndoStackRef = useRef<VersionGraphHistoryEntry[]>([]);
  const relationRedoStackRef = useRef<VersionGraphHistoryEntry[]>([]);
  const [relationHistoryRevision, setRelationHistoryRevision] = useState(0);
  const [relationMutatingChildIds, setRelationMutatingChildIds] = useState<string[]>([]);
  const automaticProgressLoadKeyRef = useRef('');
  const progressFoldersSnapshotRequestRef = useRef<Promise<ProgressFolder[]> | null>(null);
  const progressFoldersRequestRef = useRef<Promise<ProgressFolder[]> | null>(null);
  const progressFolderRequestGenerationRef = useRef(0);
  const progressFolderLoadKey = `${workspacePath}\0${project.status}\0${project.name}\0${project.path}`;
  const progressFolderLoadKeyRef = useRef(progressFolderLoadKey);
  progressFolderLoadKeyRef.current = progressFolderLoadKey;
  const [initialCachedSnapshot] = useState(() => peekVersionTreeSnapshot(workspacePath, project.name, project.path, project.status));
  const [progressFolderLoadState, setProgressFolderLoadState] = useState<{ key: string; status: 'idle' | 'loading' | 'ready' | 'error'; error: string }>(() => ({
    key: progressFolderLoadKey,
    status: initialCachedSnapshot ? 'ready' : 'idle',
    error: '',
  }));
  const hydratedProgressFolderLoadKeyRef = useRef(progressFolderLoadKey);
  useLayoutEffect(() => {
    if (hydratedProgressFolderLoadKeyRef.current === progressFolderLoadKey) return;
    hydratedProgressFolderLoadKeyRef.current = progressFolderLoadKey;
    progressFolderRequestGenerationRef.current += 1;
    automaticProgressLoadKeyRef.current = '';
    progressFoldersSnapshotRequestRef.current = null;
    progressFoldersRequestRef.current = null;
    const cached = peekVersionTreeSnapshot(workspacePath, project.name, project.path, project.status);
    if (cached) {
      progressFoldersRef.current = cached.progressFolders;
      setProgressFolders(cached.progressFolders);
      setVersionGraphEdges(cached.graphEdges);
      setProgressFolderLoadState({ key: progressFolderLoadKey, status: 'ready', error: '' });
      return;
    }
    progressFoldersRef.current = [];
    setProgressFolders(current => current.length ? [] : current);
    setVersionGraphEdges(current => current.length ? [] : current);
    setProgressFolderLoadState({ key: progressFolderLoadKey, status: 'idle', error: '' });
  }, [progressFolderLoadKey, project.name, project.path, project.status, setProgressFolders, setVersionGraphEdges, workspacePath]);
  const cancelRelationEdit = useCallback(() => {
    setDraggingChildId('');
    setHoverParentId('');
    setPendingRelationChange(null);
  }, []);
  const dismissTrackingTaskForSession = (sessionId: string) => {
    const task = backgroundTasks.find(item => item.type === 'version-tracking' && item.metadata?.sessionId === sessionId);
    if (task) dismissBackgroundTask(task.id);
  };

  const loadProgressFoldersSnapshot = useCallback(async () => {
    if (progressFoldersSnapshotRequestRef.current) return progressFoldersSnapshotRequestRef.current;
    const requestedProjectPath = project.path;
    const requestedLoadKey = `${workspacePath}\0${project.status}\0${project.name}\0${project.path}`;
    const requestedGeneration = progressFolderRequestGenerationRef.current;
    automaticProgressLoadKeyRef.current = requestedLoadKey;
    setProgressFolderLoadState(current => current.key === requestedLoadKey && current.status === 'ready'
      ? current
      : { key: requestedLoadKey, status: 'loading', error: '' });
    const request: Promise<ProgressFolder[]> = projectWorkspaceClient.getProgressFoldersSnapshot(workspacePath, project.name).then(result => {
      if (projectPathRef.current !== requestedProjectPath || progressFolderLoadKeyRef.current !== requestedLoadKey || progressFolderRequestGenerationRef.current !== requestedGeneration) return [];
      if (result.success) {
        const graphEdges = result.graphEdges || [];
        rememberVersionTreeSnapshot(workspacePath, project.name, project.path, project.status, result.progressFolders, graphEdges);
        progressFoldersRef.current = result.progressFolders;
        setProgressFolders(result.progressFolders);
        setVersionGraphEdges(graphEdges);
        setProgressFolderLoadState({ key: requestedLoadKey, status: 'ready', error: '' });
        return result.progressFolders;
      }
      const error = result.error || '未知错误';
      setProgressFolderLoadState({ key: requestedLoadKey, status: 'error', error });
      onNotice(`读取版本进度快照失败：${error}`);
      return [];
    }).catch(error => {
      if (projectPathRef.current !== requestedProjectPath || progressFolderLoadKeyRef.current !== requestedLoadKey || progressFolderRequestGenerationRef.current !== requestedGeneration) return [];
      const message = error instanceof Error ? error.message : String(error);
      setProgressFolderLoadState({ key: requestedLoadKey, status: 'error', error: message });
      onNotice(`读取版本进度快照失败：${message}`);
      return [];
    }).finally(() => {
      if (progressFoldersSnapshotRequestRef.current === request) progressFoldersSnapshotRequestRef.current = null;
    });
    progressFoldersSnapshotRequestRef.current = request;
    return request;
  }, [workspacePath, project.name, project.path, project.status, onNotice]);

  const loadProgressFolders = useCallback(async () => {
    if (progressFoldersRequestRef.current) return progressFoldersRequestRef.current;
    const requestedProjectPath = project.path;
    const requestedLoadKey = `${workspacePath}\0${project.status}\0${project.name}\0${project.path}`;
    const requestedGeneration = progressFolderRequestGenerationRef.current;
    setProgressFolderLoadState(current => current.key === requestedLoadKey && current.status === 'ready'
      ? current
      : { key: requestedLoadKey, status: 'loading', error: '' });
    const request: Promise<ProgressFolder[]> = projectWorkspaceClient.getProgressFolders(workspacePath, project.name).then(result => {
      if (projectPathRef.current !== requestedProjectPath || progressFolderLoadKeyRef.current !== requestedLoadKey || progressFolderRequestGenerationRef.current !== requestedGeneration) return [];
      if (result.success) {
        const graphEdges = result.graphEdges || [];
        rememberVersionTreeSnapshot(workspacePath, project.name, project.path, project.status, result.progressFolders, graphEdges);
        progressFoldersRef.current = result.progressFolders;
        setProgressFolders(result.progressFolders);
        setVersionGraphEdges(graphEdges);
        setProgressFolderLoadState({ key: requestedLoadKey, status: 'ready', error: '' });
        return result.progressFolders;
      }
      const error = result.error || '未知错误';
      setProgressFolderLoadState(current => current.key === requestedLoadKey && current.status === 'ready'
        ? current
        : { key: requestedLoadKey, status: 'error', error });
      onNotice(`读取版本进度失败：${error}`);
      return [];
    }).catch(error => {
      if (projectPathRef.current !== requestedProjectPath || progressFolderLoadKeyRef.current !== requestedLoadKey || progressFolderRequestGenerationRef.current !== requestedGeneration) return [];
      const message = error instanceof Error ? error.message : String(error);
      setProgressFolderLoadState(current => current.key === requestedLoadKey && current.status === 'ready'
        ? current
        : { key: requestedLoadKey, status: 'error', error: message });
      onNotice(`读取版本进度失败：${message}`);
      return [];
    }).finally(() => {
      if (progressFoldersRequestRef.current === request) progressFoldersRequestRef.current = null;
    });
    progressFoldersRequestRef.current = request;
    return request;
  }, [workspacePath, project.name, project.path, project.status, onNotice]);
  useEffect(() => {
    if (!active || !projectWorkflows) return;
    const loadKey = `${workspacePath}\0${project.status}\0${project.name}\0${project.path}`;
    if (automaticProgressLoadKeyRef.current === loadKey) return;
    automaticProgressLoadKeyRef.current = loadKey;
    void loadProgressFoldersSnapshot().then(() => {
      if (activeRef.current && progressFolderLoadKeyRef.current === loadKey) void loadProgressFolders();
    });
  }, [active, loadProgressFolders, loadProgressFoldersSnapshot, project.name, project.path, project.status, projectWorkflows, workspacePath]);
  const pushRelationHistory = (entry: VersionGraphHistoryEntry) => {
    relationUndoStackRef.current.push(entry);
    if (relationUndoStackRef.current.length > 80) relationUndoStackRef.current.shift();
    relationRedoStackRef.current = [];
    setRelationHistoryRevision(value => value + 1);
  };
  const undoVersionGraphAction = async () => {
    const entry = relationUndoStackRef.current.pop();
    if (!entry) return;
    try {
      await entry.undo();
      relationRedoStackRef.current.push(entry);
      onNotice(`已撤销：${entry.label}`);
    } catch (error) {
      relationUndoStackRef.current.push(entry);
      onNotice(`撤销失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally { setRelationHistoryRevision(value => value + 1); }
  };
  const redoVersionGraphAction = async () => {
    const entry = relationRedoStackRef.current.pop();
    if (!entry) return;
    try {
      await entry.redo();
      relationUndoStackRef.current.push(entry);
      onNotice(`已重做：${entry.label}`);
    } catch (error) {
      relationRedoStackRef.current.push(entry);
      onNotice(`重做失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally { setRelationHistoryRevision(value => value + 1); }
  };
  const mutateSupplementalEdge = async (mode: 'create' | 'delete', request: Pick<VersionGraphEdge, 'projectId' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => {
    const result = mode === 'create'
      ? await projectWorkspaceClient.createVersionGraphEdge(workspacePath, request)
      : await projectWorkspaceClient.deleteVersionGraphEdge(workspacePath, request);
    if (!result.success) throw new Error(result.error || '无法更新版本图关系');
    await loadProgressFolders();
  };
  const requestSupplementalEdgeCreate = async (sourceProgressId: string, targetProgressId: string, edgeKind: 'media_companion' | 'derived_preview' | 'derived_transcode' | 'workflow_input') => {
    const source = progressFoldersRef.current.find(folder => folder.id === sourceProgressId);
    const target = progressFoldersRef.current.find(folder => folder.id === targetProgressId);
    if (!source || !target) { onNotice('关系节点不存在，请刷新后重试'); return; }
    const relationLabel = edgeKind === 'media_companion' ? '配套素材' : edgeKind === 'derived_preview' ? '预览产物' : edgeKind === 'derived_transcode' ? '转码产物' : '工作流输入';
    const confirmed = await appDialog.confirm({
      title: `创建${relationLabel}关系？`,
      message: `将“${source.displayName}”连接到“${target.displayName}”。这不会创建版本号，也不会移动文件。`,
      confirmLabel: '创建关系',
    });
    if (!confirmed) return;
    const request = {
      projectId: target.projectId,
      sourceProgressId,
      targetProgressId,
      edgeKind,
    };
    const result = await projectWorkspaceClient.createVersionGraphEdge(workspacePath, request);
    if (!result.success) { onNotice(`创建${relationLabel}关系失败：${result.error || '未知错误'}`, 7000); return; }
    await loadProgressFolders();
    pushRelationHistory({ label: `创建${relationLabel}关系`, undo: () => mutateSupplementalEdge('delete', request), redo: () => mutateSupplementalEdge('create', request) });
    onNotice(`已创建${relationLabel}关系`);
  };
  const requestSupplementalEdgeDelete = async (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => {
    if (supplementalEdgeDeletionIdsRef.current.has(edge.id)) return;
    const child = progressFoldersRef.current.find(folder => folder.id === edge.targetProgressId);
    if (!child) { cancelRelationEdit(); await loadProgressFolders(); return; }
    // Keep all relation mutations behind the same front-end validation entry.
    progressRelationChangeError(progressFoldersRef.current, child.id, child.parentProgressId || null);
    const confirmed = await appDialog.confirm({
      title: '删除补充关系？',
      message: '只会删除这条工作流或媒体关联，不会改变主版本父节点，也不会移动文件。',
      confirmLabel: '删除关系',
      tone: 'danger',
    });
    if (!confirmed) return;
    if (supplementalEdgeDeletionIdsRef.current.has(edge.id)) return;
    supplementalEdgeDeletionIdsRef.current.add(edge.id);
    cancelRelationEdit();
    const request = {
      projectId: child.projectId,
      sourceProgressId: edge.sourceProgressId,
      targetProgressId: edge.targetProgressId,
      edgeKind: edge.edgeKind,
    };
    try {
      const result = await projectWorkspaceClient.deleteVersionGraphEdge(workspacePath, request);
      const alreadyMissing = result.error?.includes('version_graph_edge_not_found');
      if (!result.success && !alreadyMissing) { onNotice(`删除补充关系失败：${result.error || '未知错误'}`, 7000); return; }
      await loadProgressFolders();
      if (!alreadyMissing) pushRelationHistory({ label: '断开补充关系', undo: () => mutateSupplementalEdge('create', request), redo: () => mutateSupplementalEdge('delete', request) });
      onNotice('补充关系已删除');
    } finally {
      supplementalEdgeDeletionIdsRef.current.delete(edge.id);
    }
  };
  const requestSupplementalEdgeReconnect = async (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>, newSourceProgressId: string) => {
    const child = progressFoldersRef.current.find(folder => folder.id === edge.targetProgressId);
    const source = progressFoldersRef.current.find(folder => folder.id === newSourceProgressId);
    if (!child || !source) { onNotice('关系节点不存在，请刷新后重试'); cancelRelationEdit(); return; }
    // Keep the shared structural validator in every relation-mutation entry path.
    progressRelationChangeError(progressFoldersRef.current, child.id, child.parentProgressId || null);
    if (edge.sourceProgressId === newSourceProgressId) { onNotice('补充关系没有变化'); cancelRelationEdit(); return; }
    const confirmed = await appDialog.confirm({
      title: '确认改接关系来源？',
      message: `将这条关系的来源改为“${source.displayName}”。不会改变关系类型、主版本父节点或物理文件。`,
      confirmLabel: '改接关系',
    });
    if (!confirmed) { cancelRelationEdit(); return; }
    const request = {
      projectId: child.projectId,
      sourceProgressId: edge.sourceProgressId,
      targetProgressId: edge.targetProgressId,
      edgeKind: edge.edgeKind,
      newSourceProgressId,
    };
    const result = await projectWorkspaceClient.replaceVersionGraphEdgeSource(workspacePath, request);
    cancelRelationEdit();
    if (!result.success) { onNotice(`改接补充关系失败：${result.error || '未知错误'}`, 7000); return; }
    await loadProgressFolders();
    pushRelationHistory({
      label: '改接补充关系',
      undo: async () => {
        const reverted = await projectWorkspaceClient.replaceVersionGraphEdgeSource(workspacePath, { ...request, sourceProgressId: newSourceProgressId, newSourceProgressId: edge.sourceProgressId });
        if (!reverted.success) throw new Error(reverted.error || '无法撤销改接');
        await loadProgressFolders();
      },
      redo: async () => {
        const repeated = await projectWorkspaceClient.replaceVersionGraphEdgeSource(workspacePath, request);
        if (!repeated.success) throw new Error(repeated.error || '无法重做改接');
        await loadProgressFolders();
      },
    });
    onNotice('补充关系来源已更新');
  };
  const requestProgressRelationChange = async (childProgressId: string, parentProgressId: string | null) => {
    const child = progressFoldersRef.current.find(folder => folder.id === childProgressId);
    const parent = parentProgressId ? progressFoldersRef.current.find(folder => folder.id === parentProgressId) : undefined;
    if (!child) { onNotice('要修改的版本节点不存在，请刷新后重试'); return; }
    const relationError = progressRelationChangeError(progressFoldersRef.current, childProgressId, parentProgressId);
    if (relationError) { onNotice(relationError, 5000); cancelRelationEdit(); return; }
    const desiredWorkflowInputs = child.nodeRole === 'progress'
      ? workflowInputIdsForRelationChange(progressFoldersRef.current, versionGraphEdges, childProgressId, parentProgressId)
      : [];
    const existingWorkflowInputSet = new Set(versionGraphEdges
      .filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === childProgressId)
      .map(edge => edge.sourceProgressId));
    const needsWorkflowInputRepair = desiredWorkflowInputs.length !== existingWorkflowInputSet.size
      || desiredWorkflowInputs.some(id => !existingWorkflowInputSet.has(id));
    if ((child.parentProgressId || null) === parentProgressId && !needsWorkflowInputRepair) {
      onNotice(parent
        ? `“${child.displayName}”已经连接到“${parent.displayName}”；无需重复连接。如需重新比较内容，请刷新该版本的版本跟踪。`
        : '该节点已经是独立根节点，无需重复断开。', 6000);
      cancelRelationEdit();
      return;
    }
    const request = { childProgressId, parentProgressId };
    setPendingRelationChange(request);
    const confirmed = await appDialog.confirm({
      title: '确认修改版本关系？',
      message: child.nodeRole === 'selection'
        ? `将“${child.displayName}”的来源改为“${parent?.displayName || '未知节点'}”。只修改版本关系，不会重新复制选片内容。`
        : parent ? `将“${child.displayName}”连接到“${parent.displayName}”下面。保存后会按新来源重新比较已开启跟踪的版本；不会移动或重命名物理文件夹。` : `将“${child.displayName}”断开为独立根节点，并自动关闭版本跟踪及其附加策略。不会移动或重命名物理文件夹。`,
      confirmLabel: '修改关系',
    });
    if (!confirmed) { cancelRelationEdit(); return; }
    if (child.nodeRole === 'progress' && parentProgressId === null) {
      setPendingRelationChange({ childProgressId, parentProgressId: null });
      setRelationMutatingChildIds(current => current.includes(childProgressId) ? current : [...current, childProgressId]);
      try {
        const activeTrackingTask = backgroundTasks.find(task => task.type === 'version-tracking'
          && task.metadata?.progressId === childProgressId
          && (task.state === 'queued' || task.state === 'running'));
        if (activeTrackingTask) await projectWorkspaceClient.cancelBackgroundTask(activeTrackingTask.id);
        const result = await projectWorkspaceClient.unregisterProgressFolder(workspacePath, project.name, childProgressId);
        if (!result.success) throw new Error(result.error || '无法取消版本登记');
        const sessionKey = `photoflow:tracking-session:${workspacePath}:${project.name}:${childProgressId}`;
        const sessionId = safeStorageGet(sessionKey);
        safeStorageRemove(sessionKey);
        if (sessionId) dismissTrackingTaskForSession(sessionId);
        if (trackingConfirmationProgressId === childProgressId) {
          setTrackingConfirmationProgressId('');
          setTrackingConfirmationSessionId('');
        }
        await loadProgressFolders();
        onNotice('版本关系已断开，该文件夹已恢复为普通文件夹');
      } catch (error) {
        onNotice(`取消版本登记失败：${error instanceof Error ? error.message : String(error)}`, 7000);
      } finally {
        cancelRelationEdit();
        setPendingRelationChange(current => current?.childProgressId === childProgressId ? null : current);
        setRelationMutatingChildIds(current => current.filter(id => id !== childProgressId));
      }
      return;
    }
    if (parent && (child.nodeRole === 'progress' && (parent.nodeRole === 'selection' || parent.nodeRole === 'workflow')
      || child.nodeRole === 'workflow' && parent.nodeRole === 'progress')) {
      const edgeRequest = {
        projectId: child.projectId,
        sourceProgressId: parent.id,
        targetProgressId: child.id,
        edgeKind: 'workflow_input',
      } as const;
      const result = await projectWorkspaceClient.createVersionGraphEdge(workspacePath, edgeRequest);
      cancelRelationEdit();
      if (!result.success) {
        onNotice(`添加工作流输入关系失败：${result.error || '未知错误'}`, 7000);
        return;
      }
      await loadProgressFolders();
      pushRelationHistory({ label: '添加工作流输入', undo: () => mutateSupplementalEdge('delete', edgeRequest), redo: () => mutateSupplementalEdge('create', edgeRequest) });
      onNotice('工作流输入关系已添加');
      return;
    }
    const mutationId = Math.max(relationMutationIdRef.current, relationMutationId) + 1;
    relationMutationIdRef.current = mutationId;
    setRelationMutationId(mutationId);
    relationMutationCountsRef.current.set(childProgressId, (relationMutationCountsRef.current.get(childProgressId) || 0) + 1);
    setRelationMutatingChildIds(current => current.includes(childProgressId) ? current : [...current, childProgressId]);
    const mutationQueue = relationMutationQueueRef.current;
    const mutationGeneration = mutationQueue.captureGeneration();
    try {
      await mutationQueue.enqueue(childProgressId, async () => {
        let latestChild = progressFoldersRef.current.find(folder => folder.id === childProgressId);
        if (!latestChild) latestChild = (await loadProgressFolders()).find(folder => folder.id === childProgressId);
        if (!latestChild) throw new Error('要修改的版本节点不存在，请刷新后重试');
        const previousParentProgressId = latestChild.parentProgressId || null;
        const previousTrackingPolicy = trackingPolicyForRelationChange(latestChild, previousParentProgressId);
        const previousWorkflowInputProgressIds = versionGraphEdges
          .filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === childProgressId)
          .map(edge => edge.sourceProgressId);
        const nextWorkflowInputProgressIds = workflowInputIdsForRelationChange(
          progressFoldersRef.current,
          versionGraphEdges,
          childProgressId,
          parentProgressId,
        );
        const applyProgressGraph = async (
          currentChild: ProgressFolder,
          nextParentProgressId: string | null,
          workflowInputProgressIds: string[],
          trackingPolicy = trackingPolicyForRelationChange(currentChild, nextParentProgressId),
        ) => projectWorkspaceClient.registerProgressWithGraph(workspacePath, project.status, {
          projectName: project.name,
          progress: {
            progressId: currentChild.id,
            mediaKind: progressNodeMediaKind(currentChild) || undefined,
            versionKey: currentChild.versionKey,
            parentProgressId: nextParentProgressId || undefined,
            displayName: currentChild.displayName,
            trackingEnabled: trackingPolicy.trackingEnabled,
            trackingState: trackingPolicy.trackingState,
            renameFromParent: trackingPolicy.renameFromParent,
            copyMissingFromParent: trackingPolicy.copyMissingFromParent,
          },
          workflowInputProgressIds,
        });
        const detachingProgress = latestChild.nodeRole === 'progress' && parentProgressId === null;
        if (detachingProgress) {
          const activeTrackingTask = backgroundTasks.find(task => task.type === 'version-tracking'
            && task.metadata?.progressId === childProgressId
            && (task.state === 'queued' || task.state === 'running'));
          if (activeTrackingTask) await projectWorkspaceClient.cancelBackgroundTask(activeTrackingTask.id);
        }
        const result = latestChild.nodeRole === 'progress'
          ? await applyProgressGraph(latestChild, parentProgressId, nextWorkflowInputProgressIds)
          : await projectWorkspaceClient.updateProgressRelation(workspacePath, project.name, {
            childProgressId,
            parentProgressId,
            expectedUpdatedAt: latestChild.updatedAt,
          });
        if (!mutationQueue.isGenerationCurrent(mutationGeneration)) return;
        if (!result.success || !result.progressFolder) {
          if ((result.error || '').includes('stale_update')) await loadProgressFolders();
          throw new Error(result.error || '未知错误');
        }
        if (latestChild.nodeRole === 'progress') {
          const committedEdges: VersionGraphEdge[] = 'edges' in result && Array.isArray(result.edges) ? result.edges : [];
          const committedWorkflowInputIds = new Set(committedEdges
            .filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === childProgressId)
            .map(edge => edge.sourceProgressId));
          const graphWasPersisted = (result.progressFolder.parentProgressId || null) === parentProgressId
            && committedWorkflowInputIds.size === nextWorkflowInputProgressIds.length
            && nextWorkflowInputProgressIds.every(id => committedWorkflowInputIds.has(id));
          if (!graphWasPersisted) {
            await loadProgressFolders();
            throw new Error('关系写入后校验失败，请刷新后重试');
          }
          const committedChildWorkflowEdges = committedEdges.filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === childProgressId);
          setVersionGraphEdges(current => [
            ...current.filter(edge => edge.edgeKind !== 'workflow_input' || edge.targetProgressId !== childProgressId),
            ...committedChildWorkflowEdges,
          ]);
        }
        const updatedFolder = result.progressFolder;
        setProgressFolders(current => {
          const next = current.map(folder => folder.id === updatedFolder.id ? updatedFolder : folder);
          progressFoldersRef.current = next;
          return next;
        });
        if (detachingProgress) {
          const sessionKey = `photoflow:tracking-session:${workspacePath}:${project.name}:${childProgressId}`;
          const sessionId = safeStorageGet(sessionKey);
          safeStorageRemove(sessionKey);
          if (sessionId) dismissTrackingTaskForSession(sessionId);
          if (trackingConfirmationProgressId === childProgressId) {
            setTrackingConfirmationProgressId('');
            setTrackingConfirmationSessionId('');
          }
        }
        const applyParent = async (
          nextParentProgressId: string | null,
          workflowInputProgressIds: string[],
          trackingPolicy?: ReturnType<typeof trackingPolicyForRelationChange>,
        ) => {
          const currentChild = progressFoldersRef.current.find(folder => folder.id === childProgressId);
          if (!currentChild) throw new Error('要修改的版本节点不存在，请刷新后重试');
          const changed = currentChild.nodeRole === 'progress'
            ? await applyProgressGraph(currentChild, nextParentProgressId, workflowInputProgressIds, trackingPolicy)
            : await projectWorkspaceClient.updateProgressRelation(workspacePath, project.name, { childProgressId, parentProgressId: nextParentProgressId, expectedUpdatedAt: currentChild.updatedAt });
          if (!changed.success) throw new Error(changed.error || '无法更新版本关系');
          await loadProgressFolders();
        };
        if (!(latestChild.nodeRole === 'progress' && previousParentProgressId === null)) {
          pushRelationHistory({
            label: '修改版本父关系',
            undo: () => applyParent(previousParentProgressId, previousWorkflowInputProgressIds, previousTrackingPolicy),
            redo: () => applyParent(parentProgressId, nextWorkflowInputProgressIds),
          });
        }
        if (updatedFolder.nodeRole === 'progress' && updatedFolder.trackingEnabled && parentProgressId) {
          const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, {
            progressId: updatedFolder.id,
            mode: 'refresh',
          });
          if (started.success && started.sessionId) {
            safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${updatedFolder.id}`, started.sessionId);
            setTrackingConfirmationProgressId(updatedFolder.id);
            if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
            await loadProgressFolders();
            onNotice(`版本关系已更新，正在重新比较 ${parent?.displayName || '新来源'} → ${updatedFolder.displayName}；完成后可从任务中心确认。`, 7000);
          } else {
            onNotice(`版本关系已更新，${updatedFolder.displayName} 已标记为待刷新；自动重新比较启动失败：${started.error || '未知错误'}`, 8000);
          }
        } else {
          onNotice(detachingProgress ? '版本关系已断开，版本跟踪已自动关闭' : '版本关系已更新');
        }
      });
    } catch (error) {
      mutationQueue.runIfCurrent(mutationGeneration, () => {
        onNotice(`修改版本关系失败：${error instanceof Error ? error.message : '未知错误'}`, 7000);
      });
    } finally {
      if (mutationQueue.isGenerationCurrent(mutationGeneration)) {
        const remaining = Math.max(0, (relationMutationCountsRef.current.get(childProgressId) || 1) - 1);
        if (remaining) relationMutationCountsRef.current.set(childProgressId, remaining);
        else {
          relationMutationCountsRef.current.delete(childProgressId);
          setRelationMutatingChildIds(current => current.filter(id => id !== childProgressId));
          setPendingRelationChange(current => current?.childProgressId === childProgressId ? null : current);
          setDraggingChildId(current => current === childProgressId ? '' : current);
          setHoverParentId('');
        }
      }
    }
  };
  useEffect(() => {
    // React StrictMode intentionally runs an effect setup/cleanup cycle twice
    // in development. Each setup must therefore own a fresh queue; otherwise
    // the first cleanup permanently disposes every later relation mutation.
    const queue = new ProgressRelationMutationQueue();
    relationMutationQueueRef.current = queue;
    return () => {
      relationMutationIdRef.current += 1;
      queue.dispose();
      relationMutationCountsRef.current.clear();
    };
  }, []);

  return {
    progressFoldersRef, loadProgressFolders, loadProgressFoldersSnapshot,
    progressFoldersReady: progressFolderLoadState.key === progressFolderLoadKey && progressFolderLoadState.status === 'ready',
    progressFoldersLoadError: progressFolderLoadState.key === progressFolderLoadKey && progressFolderLoadState.status === 'error'
      ? progressFolderLoadState.error
      : '',
    dismissTrackingTaskForSession,
    draggingChildId, setDraggingChildId, hoverParentId, setHoverParentId,
    pendingRelationChange, relationMutatingChildIds, relationHistoryRevision,
    canUndoRelation: relationUndoStackRef.current.length > 0,
    canRedoRelation: relationRedoStackRef.current.length > 0,
    resetProgressFolderRequests: () => {
      progressFolderRequestGenerationRef.current += 1;
      progressFoldersSnapshotRequestRef.current = null;
      progressFoldersRequestRef.current = null;
      automaticProgressLoadKeyRef.current = '';
    },
    cancelRelationEdit, undoVersionGraphAction, redoVersionGraphAction,
    requestSupplementalEdgeCreate, requestSupplementalEdgeDelete,
    requestSupplementalEdgeReconnect, requestProgressRelationChange,
  };
};
