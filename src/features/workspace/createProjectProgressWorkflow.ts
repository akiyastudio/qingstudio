import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ProgressFolder, ProjectFileEntry, VersionBatchFileOperation, VersionGraphEdge, WorkspaceProject } from '../../types';
import type { useAppDialog } from '../../components/AppDialogProvider';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { defaultWorkflowInputIds, isUserVersionKey, normalizeProgressSetupTrackingPolicy, normalizeTrackingPolicy, progressTrackingAction, progressTrackingActionLabel, selectableVersionParents, versionKindForParent, type FolderMarkDraft } from '../versioning/public';
import { remapEntryAfterProgressFolderMove } from './file-entry-interaction-model';
import { pageOwnsFileOperationNotification } from './file-operation-notification-model';
import type { ProgressFolderEntryLocation } from './file-entry-interaction-model';
import type { ProgressCompareConfirmation, ProgressSetupDraft } from './project-progress-workflow-types';

type ProgressRepair = { progressFolder: ProgressFolder; batchId: string; operations: VersionBatchFileOperation[] };
type RegisterProgress = {
  relativePath?: string; progressId?: string; moveToRoot?: boolean; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string;
  displayName: string; trackingEnabled: boolean; trackingState: ProgressFolder['trackingState'];
  renameFromParent: boolean; copyMissingFromParent: boolean;
};
type Options = {
  workspacePath: string;
  project: WorkspaceProject;
  progressSetup: ProgressSetupDraft | null;
  progressCompare: ProgressCompareConfirmation | null;
  progressSubmitting: boolean;
  progressRepair: ProgressRepair | null;
  progressRepairBusy: boolean;
  workspaceActivityMessage: string;
  versionProgressId: string;
  versionGraphEdges: VersionGraphEdge[];
  progressFolders: ProgressFolder[];
  appDialog: ReturnType<typeof useAppDialog>;
  onNotice: (message: string, duration?: number) => void;
  currentRelativePathRef: MutableRefObject<string>;
  directoryEntriesCacheRef: MutableRefObject<Map<string, ProjectFileEntry[]>>;
  progressFoldersRef: MutableRefObject<ProgressFolder[]>;
  progressImportOperationIdRef: MutableRefObject<string>;
  progressSubmittingRef: MutableRefObject<boolean>;
  versionProgressLocationRef: MutableRefObject<(ProgressFolderEntryLocation & { progressId: string }) | null>;
  loadProgressFolders: () => Promise<ProgressFolder[]>;
  refresh: (relativePath?: string, options?: { includeProjectContents?: boolean }) => Promise<void>;
  handleProjectImportRecovery: (result: Awaited<ReturnType<typeof projectWorkspaceClient.importProjectFiles>>) => Promise<boolean>;
  adoptVersionTreeFolder: (entry: Pick<ProjectFileEntry, 'name' | 'relativePath'>, mode: 'original' | 'broll', mediaKind: 'image' | 'video' | 'mixed') => Promise<boolean>;
  progressAppendTarget: (draft: ProgressSetupDraft) => ProgressFolder | undefined;
  progressComparisonParent: (draft: ProgressSetupDraft) => ProgressFolder | undefined;
  progressFolderRelativePath: (folder: ProgressFolder) => string;
  progressNameFromDisplayName: (displayName: string, mediaKind: 'image' | 'video', versionKey: string, fallback: string) => string;
  progressNameHasConflict: (draft: ProgressSetupDraft) => boolean;
  progressVersionHasConflict: (draft: ProgressSetupDraft) => boolean;
  progressVersionIsValid: (draft: ProgressSetupDraft) => boolean;
  resolvedProgressFolderName: (draft: ProgressSetupDraft) => string;
  progressNodeMediaKind: (folder: Pick<ProgressFolder, 'mediaKind'>) => 'image' | 'video' | null;
  setFileEntries: Dispatch<SetStateAction<ProjectFileEntry[]>>;
  setFolderMarkSetup: Dispatch<SetStateAction<FolderMarkDraft | null>>;
  setPendingProgressFolders: Dispatch<SetStateAction<Array<{ relativePath: string; name: string; mediaKind: 'image' | 'video' }>>>;
  setProgressCompare: Dispatch<SetStateAction<ProgressCompareConfirmation | null>>;
  setProgressFolders: Dispatch<SetStateAction<ProgressFolder[]>>;
  setProgressImportCompletion: Dispatch<SetStateAction<string>>;
  setProgressRepair: Dispatch<SetStateAction<ProgressRepair | null>>;
  setProgressRepairBusy: Dispatch<SetStateAction<boolean>>;
  setProgressSetup: Dispatch<SetStateAction<ProgressSetupDraft | null>>;
  setProgressSubmitting: Dispatch<SetStateAction<boolean>>;
  setRootWatchFailed: Dispatch<SetStateAction<boolean>>;
  setSelectedPaths: Dispatch<SetStateAction<string[]>>;
  setTrackingConfirmationProgressId: Dispatch<SetStateAction<string>>;
  setTrackingConfirmationSessionId: Dispatch<SetStateAction<string>>;
  setVersionEntry: Dispatch<SetStateAction<ProjectFileEntry | null>>;
  setVersionProgressId: Dispatch<SetStateAction<string>>;
  setWorkspaceActivityMessage: Dispatch<SetStateAction<string>>;
};

const safeStorageSet = (key: string, value: string) => { try { window.localStorage.setItem(key, value); } catch { /* optional state */ } };
const progressNodeMediaKindFallback = (folder: Pick<ProgressFolder, 'mediaKind'>): 'image' | 'video' | null => folder.mediaKind === 'image' || folder.mediaKind === 'video' ? folder.mediaKind : null;

export const createProjectProgressWorkflow = ({
  workspacePath, project, progressSetup, progressCompare, progressSubmitting, progressRepair, progressRepairBusy,
  workspaceActivityMessage, versionProgressId, versionGraphEdges, progressFolders, appDialog, onNotice,
  currentRelativePathRef, directoryEntriesCacheRef, progressFoldersRef, progressImportOperationIdRef,
  progressSubmittingRef, versionProgressLocationRef, loadProgressFolders, refresh, handleProjectImportRecovery,
  adoptVersionTreeFolder, progressAppendTarget, progressComparisonParent, progressFolderRelativePath,
  progressNameFromDisplayName, progressNameHasConflict, progressVersionHasConflict, progressVersionIsValid,
  resolvedProgressFolderName, progressNodeMediaKind = progressNodeMediaKindFallback,
  setFileEntries, setFolderMarkSetup, setPendingProgressFolders, setProgressCompare,
  setProgressFolders, setProgressImportCompletion, setProgressRepair, setProgressRepairBusy, setProgressSetup,
  setProgressSubmitting, setRootWatchFailed, setSelectedPaths, setTrackingConfirmationProgressId,
  setTrackingConfirmationSessionId, setVersionEntry, setVersionProgressId, setWorkspaceActivityMessage,
}: Options) => {
  const registerProgressWithWorkflow = (progress: RegisterProgress, workflowInputProgressIds: string[]) => projectWorkspaceClient.registerProgressWithGraph(workspacePath, project.status, {
    projectName: project.name,
    progress,
    workflowInputProgressIds,
  });
  const submitProgressSetup = async (requestedDraft?: ProgressSetupDraft) => {
    const draft = requestedDraft || progressSetup;
    if (!draft || progressSubmittingRef.current) return;
    if (!progressVersionIsValid(draft)) { onNotice('版本号格式或分支层级无效，请检查后重试。'); return; }
    if (progressVersionHasConflict(draft)) { onNotice(`版本 V${draft.versionKey} 已存在，请使用其他版本号。`); return; }
    const appendTarget = progressAppendTarget(draft);
    if (appendTarget?.trackingState === 'needs_repair' || appendTarget?.trackingState === 'committing') {
      onNotice(appendTarget.trackingState === 'needs_repair' ? '请先修复当前版本批次，再追加文件。' : '当前版本批次仍在提交，请稍后再追加。');
      return;
    }
    const trackingEnabled = appendTarget ? appendTarget.trackingState !== 'disabled' : normalizeProgressSetupTrackingPolicy(draft.relationKind, draft).trackingEnabled;
    const parentFolder = appendTarget
      ? progressFolders.find(folder => folder.id === appendTarget.parentProgressId && !folder.folderMissing)
      : progressComparisonParent(draft);
    progressImportOperationIdRef.current = '';
    progressSubmittingRef.current = true;
    setProgressSubmitting(true);
    let taskOwnedImportFailure = false;
    try {
      if (draft.mode === 'create') {
        if (progressNameHasConflict(draft)) { onNotice('生成的版本文件夹名称已存在，请修改版本号或名称。'); return; }
        const generatedName = resolvedProgressFolderName(draft);
        const policy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
        const registered = await registerProgressWithWorkflow({
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          ...policy,
          trackingState: policy.trackingEnabled ? 'pending_compare' : 'disabled',
        }, draft.workflowInputProgressIds);
        if (!registered.success || !registered.progressFolder || !registered.folder) throw new Error(registered.error || '无法原子创建进度和版本 V2 关系');
        setProgressSetup(null);
        setProgressFolders(current => current.some(folder => folder.id === registered.progressFolder!.id) ? current.map(folder => folder.id === registered.progressFolder!.id ? registered.progressFolder! : folder) : [...current, registered.progressFolder!]);
        directoryEntriesCacheRef.current.delete('');
        if (!currentRelativePathRef.current) {
          const folderEntry: ProjectFileEntry = { ...registered.folder, kind: 'folder', extension: '', size: 0, createdAt: registered.folder.updatedAt };
          setFileEntries(current => current.some(entry => entry.relativePath === folderEntry.relativePath) ? current : [...current, folderEntry]);
        }
        onNotice(`已创建${draft.mediaKind === 'image' ? '图片' : '视频'}进度“${generatedName}”（版本 V${draft.versionKey}）`);
        void loadProgressFolders();
        void refresh('');
        return;
      }

      if (draft.mode === 'mark' && draft.existingProgressId) {
        let existingProgress = progressFolders.find(folder => folder.id === draft.existingProgressId);
        if (!existingProgress) throw new Error('没有找到要修改的版本节点');
        let relativePath = progressFolderRelativePath(existingProgress);
        const previousVersionLocation = versionProgressLocationRef.current;
        let folderRenamed = false;
        const generatedName = resolvedProgressFolderName(draft);
        const currentFolderName = relativePath.split('/').pop() || existingProgress.displayName;
        if (!draft.preserveFolderName && generatedName !== currentFolderName) {
          const renamed = await projectWorkspaceClient.renameProgressFolder(workspacePath, project.status, project.name, {
            progressId: existingProgress.id,
            expectedFolderId: existingProgress.folderId,
            expectedRelativePath: relativePath,
            newName: generatedName,
          });
          if (!renamed.success || !renamed.progressFolder) throw new Error(renamed.error || '无法修改版本文件夹名称');
          existingProgress = renamed.progressFolder;
          relativePath = renamed.newRelativePath || progressFolderRelativePath(renamed.progressFolder);
          folderRenamed = true;
          directoryEntriesCacheRef.current.clear();
        }
        const policy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
        const policyChanged = existingProgress.trackingEnabled !== policy.trackingEnabled
          || existingProgress.renameFromParent !== policy.renameFromParent
          || existingProgress.copyMissingFromParent !== policy.copyMissingFromParent
          || existingProgress.parentProgressId !== (draft.parentProgressId || undefined)
          || (existingProgress.relationKind || 'main') !== draft.relationKind;
        const updated = await projectWorkspaceClient.updateProgressFolder(workspacePath, project.status, project.name, {
          progressId: existingProgress.id,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          trackingEnabled: policy.trackingEnabled,
          trackingState: policy.trackingEnabled && policyChanged ? 'pending_compare' : policy.trackingEnabled ? existingProgress.trackingState : 'disabled',
          renameFromParent: policy.renameFromParent,
          copyMissingFromParent: policy.copyMissingFromParent,
        });
        if (!updated.success || !updated.progressFolder) throw new Error(updated.error || '无法更新版本信息或跟踪策略');
        setProgressSetup(null);
        if (versionProgressId === existingProgress.id) {
          const nextVersionLocation = {
            progressId: updated.progressFolder.id,
            folderPath: updated.progressFolder.folderPath,
            relativePath: progressFolderRelativePath(updated.progressFolder),
          };
          if (folderRenamed && previousVersionLocation) setVersionEntry(current => current ? remapEntryAfterProgressFolderMove(current, previousVersionLocation, nextVersionLocation) : current);
          versionProgressLocationRef.current = nextVersionLocation;
          setVersionProgressId(updated.progressFolder.id);
        }
        progressFoldersRef.current = progressFoldersRef.current.map(folder => folder.id === updated.progressFolder!.id ? updated.progressFolder! : folder);
        setProgressFolders(current => current.map(folder => folder.id === updated.progressFolder!.id ? updated.progressFolder! : folder));
        setSelectedPaths([relativePath]);
        if (folderRenamed) await refresh('');
        if (policy.trackingEnabled && draft.relationKind === 'main' && draft.parentProgressId && policyChanged) {
          const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, { progressId: updated.progressFolder.id, mode: existingProgress.trackingEnabled ? 'refresh' : 'compare' });
          if (!started.success || !started.sessionId) {
            await loadProgressFolders();
            onNotice(`进度修改已保存，但跟踪启动失败：${started.error || '可从“继续版本跟踪”重试'}`, 8000);
            return;
          }
          safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${updated.progressFolder.id}`, started.sessionId);
          setTrackingConfirmationProgressId(updated.progressFolder.id);
          if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
        } else {
          onNotice(`已修改进度“${updated.progressFolder.displayName}”。`);
        }
        void loadProgressFolders();
        return;
      }

      if (draft.mode === 'mark') {
        if (progressNameHasConflict(draft)) { onNotice('生成的版本文件夹名称已存在，请修改版本号或名称。'); return; }
        const generatedName = resolvedProgressFolderName(draft);
        if (!draft.targetRelativePath) throw new Error('没有找到要标记的文件夹');
        let targetRelativePath = draft.targetRelativePath;
        const currentFolderName = targetRelativePath.split('/').pop() || generatedName;
        if (!draft.preserveFolderName && generatedName !== currentFolderName) {
          const parentRelativePath = targetRelativePath.split('/').slice(0, -1).join('/');
          const renamed = await projectWorkspaceClient.projectFileOperation(
            workspacePath, project.status, project.name, 'rename', [targetRelativePath], parentRelativePath, generatedName,
          );
          if (!renamed.success) throw new Error(renamed.error || '无法修改待标记文件夹名称');
          targetRelativePath = [parentRelativePath, generatedName].filter(Boolean).join('/');
          directoryEntriesCacheRef.current.clear();
        }
        const moveToRoot = draft.relationKind === 'main' && targetRelativePath.includes('/');
        if (moveToRoot) setWorkspaceActivityMessage('正在安全移动文件夹到项目根目录…');
        setWorkspaceActivityMessage(`正在标记${draft.mediaKind === 'image' ? '图片' : '视频'}进度…`);
        const policy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
        const registered = await registerProgressWithWorkflow({
          relativePath: targetRelativePath,
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          ...policy,
          trackingState: policy.trackingEnabled ? 'pending_compare' : 'disabled',
          progressId: draft.existingProgressId,
          moveToRoot,
        }, draft.workflowInputProgressIds);
        if (!registered.success || !registered.progressFolder) throw new Error(registered.error || '无法登记进度文件夹');
        targetRelativePath = registered.relativePath || targetRelativePath;
        const progressFolder = registered.progressFolder;
        const openCreatedProgressEditor = () => {
          if (!draft.openEditorAfterCreate) return;
          const createdParent = progressFoldersRef.current.find(folder => folder.id === progressFolder.parentProgressId) || parentFolder;
          setProgressSetup({
            ...draft,
            mode: 'mark',
            relation: versionKindForParent(progressFolder.versionKey, createdParent) === 'branch' ? 'branch' : 'root',
            relationKind: progressFolder.relationKind || 'main',
            parentProgressId: progressFolder.parentProgressId || '',
            versionKey: progressFolder.versionKey,
            progressName: progressNameFromDisplayName(progressFolder.displayName, draft.mediaKind, progressFolder.versionKey, progressFolder.displayName),
            trackingEnabled: progressFolder.trackingEnabled,
            renameSources: progressFolder.renameFromParent,
            copyMissingFromParent: progressFolder.copyMissingFromParent,
            targetRelativePath,
            existingProgressId: progressFolder.id,
            preserveFolderName: targetRelativePath.includes('/') || targetRelativePath.split('/').pop() !== progressFolder.displayName,
            contextLocked: undefined,
            openEditorAfterCreate: undefined,
          });
        };
        setProgressSetup(null);
        await loadProgressFolders();
        directoryEntriesCacheRef.current.clear();
        await refresh('');
        setSelectedPaths([targetRelativePath]);

        if (!policy.trackingEnabled || draft.relationKind === 'auxiliary') {
          setWorkspaceActivityMessage('');
          onNotice(`已将“${generatedName}”登记为${draft.relationKind === 'auxiliary' ? '选片辅助节点' : '版本进度'}。`);
          openCreatedProgressEditor();
          return;
        }
        if (!parentFolder) {
          setWorkspaceActivityMessage('正在建立首个版本的跟踪记录…');
          const baseline = await projectWorkspaceClient.registerVersionBaseline(workspacePath, project.status, project.name, targetRelativePath);
          if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
          await loadProgressFolders();
          setWorkspaceActivityMessage('');
          onNotice(`已标记并建立首版跟踪：${progressFolder.displayName}`);
          openCreatedProgressEditor();
          return;
        }

        const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, { progressId: progressFolder.id, mode: 'compare' });
        if (!started.success || !started.sessionId) {
          setWorkspaceActivityMessage('');
          await loadProgressFolders();
          directoryEntriesCacheRef.current.clear();
          await refresh('');
          onNotice(`版本“${progressFolder.displayName}”已登记，但跟踪启动失败；可从修改进度或“继续版本跟踪”重试：${started.error || '未知错误'}`, 9000);
          openCreatedProgressEditor();
          return;
        }
        safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressFolder.id}`, started.sessionId);
        setTrackingConfirmationProgressId(progressFolder.id);
        if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
        setWorkspaceActivityMessage('');
        openCreatedProgressEditor();
        return;
      }

      if (progressNameHasConflict(draft)) { onNotice('生成的版本文件夹名称已存在，请修改版本号或名称。'); return; }
      const generatedName = resolvedProgressFolderName(draft);
      setWorkspaceActivityMessage('');
      const importOptions: Parameters<typeof projectWorkspaceClient.importProgressFiles>[4] = {
        deleteSourceAfterImport: draft.deleteSourceAfterImport,

        sourcePaths: draft.sourcePaths,
        mediaKind: draft.mediaKind,
        versionKey: draft.versionKey,
        parentProgressId: appendTarget?.parentProgressId || draft.parentProgressId || undefined,
        trackingEnabled,
        trackingState: trackingEnabled ? 'pending_compare' : 'disabled',
        appendProgressId: appendTarget?.id,
      };
      let imported = await projectWorkspaceClient.importProgressFiles(workspacePath, project.status, project.name, generatedName, importOptions);
      if (imported.requiresDecision?.kind === 'progress-import-conflict') {
        const decision = imported.requiresDecision;
        const policy = await appDialog.choice({
          title: '追加进度时发现同名文件',
          message: decision.message,
          detail: decision.detail,
          choices: [
            { value: 'skip', label: '跳过同名文件' },
            { value: 'keep-both', label: '保留两份' },
          ],
          defaultValue: 'skip',
          cancelLabel: '取消追加',
          cancelDefault: true,
        });
        if (policy !== 'skip' && policy !== 'keep-both') {
          setWorkspaceActivityMessage('');
          setProgressSetup(null);
          return;
        }
        imported = await projectWorkspaceClient.importProgressFiles(workspacePath, project.status, project.name, generatedName, {
          ...importOptions,
          progressConflictPolicy: policy,
          sourcePaths: decision.sourcePaths,
        });
      }
      if (await handleProjectImportRecovery(imported)) {
        setWorkspaceActivityMessage('');
        setProgressSetup(null);
        return;
      }
      if (!imported.success) {
        taskOwnedImportFailure = !pageOwnsFileOperationNotification(imported);
        throw new Error(imported.error || '导入失败');
      }
      if (imported.watchDegraded) setRootWatchFailed(true);
      if (imported.cancelled || !imported.folder) {
        setWorkspaceActivityMessage('');
        setProgressSetup(null);
        return;
      }
      if (!imported.progressFolder) throw new Error('版本进度没有完成数据库登记');
      const importPolicy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
      const v2Imported = await registerProgressWithWorkflow({
        relativePath: imported.folder.relativePath,
        mediaKind: draft.mediaKind,
        versionKey: draft.versionKey,
        parentProgressId: appendTarget?.parentProgressId || draft.parentProgressId || undefined,
        displayName: generatedName,
        ...importPolicy,
        trackingState: importPolicy.trackingEnabled ? 'pending_compare' : 'disabled',
        progressId: imported.progressFolder.id,
      }, draft.workflowInputProgressIds);
      if (!v2Imported.success || !v2Imported.progressFolder) throw new Error(v2Imported.error || '无法保存导入进度的 V2 关系');
      const progressFolder = v2Imported.progressFolder;
      await loadProgressFolders();
      await refresh('');

      const skippedSummary = imported.skippedCount ? `；已跳过 ${imported.skippedCount} 个重复或冲突文件` : '';
      if (appendTarget && !(imported.count || 0)) {
        setWorkspaceActivityMessage('');
        setProgressImportCompletion(`没有向“${progressFolder.displayName}”追加新文件${skippedSummary}。`);
        return;
      }

      if (!trackingEnabled) {
        setWorkspaceActivityMessage('');
        setProgressImportCompletion(appendTarget
          ? `已向“${progressFolder.displayName}”追加 ${imported.count || 0} 个文件${skippedSummary}；沿用未开启版本跟踪的设置。`
          : `已导入 ${imported.count || 0} 个文件；此项目未开启版本跟踪。`);
        return;
      }
      if (!parentFolder) {
        setWorkspaceActivityMessage(appendTarget ? '正在把本次追加文件写入首版跟踪记录…' : '正在建立首个版本的跟踪记录…');
        const baseline = await projectWorkspaceClient.registerVersionBaseline(workspacePath, project.status, project.name, imported.folder.relativePath);
        if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
        await loadProgressFolders();
        setWorkspaceActivityMessage('');
        setProgressImportCompletion(appendTarget
          ? `已向“${progressFolder.displayName}”追加 ${imported.count || 0} 个文件并更新首版跟踪${skippedSummary}。`
          : `已导入并建立首版跟踪：${progressFolder.displayName}`);
        return;
      }

      setProgressSetup(null);
      const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, { progressId: progressFolder.id, mode: appendTarget ? 'refresh' : 'compare' });
      if (!started.success || !started.sessionId) {
        setWorkspaceActivityMessage('');
        await loadProgressFolders();
        directoryEntriesCacheRef.current.clear();
        await refresh('');
        const message = `文件已导入且版本“${progressFolder.displayName}”已登记，但跟踪启动失败；可从“继续版本跟踪”重试：${started.error || '未知错误'}`;
        setProgressImportCompletion(message);
        onNotice(message, 9000);
        return;
      }
      safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressFolder.id}`, started.sessionId);
      setTrackingConfirmationProgressId(progressFolder.id);
      if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
      setWorkspaceActivityMessage('');
    } catch (error) {
      setWorkspaceActivityMessage('');
      const action = draft.mode === 'create' ? '创建' : draft.mode === 'import' ? '导入' : draft.existingProgressId ? '修改' : '标记';
      // The notice only carries the message, so a failure here used to leave no
      // trace at all. Report the code and stack so a "still busy" outcome can be
      // traced to the request that actually lost its lease.
      const detail = error as { code?: unknown; action?: unknown; workerId?: unknown; leaseWaitMs?: unknown; outcome?: unknown; stack?: unknown };
      window.electronAPI?.reportRendererError?.(
        `${action}版本进度失败`,
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          code: typeof detail?.code === 'string' ? detail.code : undefined,
          failedAction: typeof detail?.action === 'string' ? detail.action : undefined,
          workerId: typeof detail?.workerId === 'string' ? detail.workerId : undefined,
          leaseWaitMs: typeof detail?.leaseWaitMs === 'number' ? detail.leaseWaitMs : undefined,
          outcome: typeof detail?.outcome === 'string' ? detail.outcome : undefined,
          mode: draft.mode,
          progressId: draft.existingProgressId,
          stack: typeof detail?.stack === 'string' ? detail.stack.slice(0, 1500) : undefined,
        }),
      );
      if (!taskOwnedImportFailure) onNotice(`${action}版本进度失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      progressSubmittingRef.current = false;
      setProgressSubmitting(false);
    }
  };
  const unregisterLegacyOrphanProgress = async (progressFolder: ProgressFolder) => {
    if (progressFolder.nodeRole !== 'progress' || progressFolder.parentProgressId) return;
    const confirmed = await appDialog.confirm({
      title: '取消旧版游离进度登记？',
      message: `“${progressFolder.displayName}”会恢复为普通文件夹；只移除版本元数据，不会删除或移动文件。`,
      confirmLabel: '取消版本登记',
      tone: 'danger',
    });
    if (!confirmed) return;
    const result = await projectWorkspaceClient.unregisterProgressFolder(workspacePath, project.name, progressFolder.id);
    if (!result.success) { onNotice(`取消版本登记失败：${result.error || '未知错误'}`, 7000); return; }
    await loadProgressFolders();
    onNotice(`已保留“${progressFolder.displayName}”的物理文件夹并移除旧版游离进度元数据。`);
  };
  const submitFolderMarkSetup = async (draft: FolderMarkDraft) => {
    if (progressSubmittingRef.current) return;
    if (draft.purpose === 'progress') {
      const panelDraft = draft.progress;
      const parent = selectableVersionParents(progressFolders, { mediaKind: panelDraft.mediaKind, relationKind: 'main' })
        .find(folder => folder.id === panelDraft.parentProgressId);
      if (!parent || !isUserVersionKey(panelDraft.versionKey || '')) {
        onNotice('请先选择同媒体类型的原始素材或有效进度父节点。');
        return;
      }
      const policy = normalizeTrackingPolicy('main', panelDraft);
      const setup: ProgressSetupDraft = {
        mode: 'mark',
        mediaKind: panelDraft.mediaKind,
        relation: (panelDraft.versionKind || versionKindForParent(panelDraft.versionKey, parent)) === 'branch' ? 'branch' : 'root',
        relationKind: 'main',
        parentProgressId: parent.id,
        versionKey: panelDraft.versionKey || '',
        progressName: panelDraft.displayName,
        trackingEnabled: policy.trackingEnabled,
        deleteSourceAfterImport: false,

        sourcePaths: [],
        renameSources: policy.renameFromParent,
        copyMissingFromParent: policy.copyMissingFromParent,
        workflowInputProgressIds: defaultWorkflowInputIds(progressFolders, versionGraphEdges, parent.id),
        targetRelativePath: draft.relativePath,
        preserveFolderName: Boolean(panelDraft.targetFolderLocked),
      };
      setFolderMarkSetup(null);
      setPendingProgressFolders(current => current.filter(folder => folder.relativePath !== draft.relativePath));
      setProgressSetup(setup);
      await submitProgressSetup(setup);
      return;
    }
    progressSubmittingRef.current = true;
    setProgressSubmitting(true);
    try {
      const adopted = await adoptVersionTreeFolder(
        { name: draft.folderName, relativePath: draft.relativePath },
        draft.purpose,
        draft.purpose === 'broll' ? 'mixed' : draft.mediaKind,
      );
      if (adopted) {
        setFolderMarkSetup(null);
        setPendingProgressFolders(current => current.filter(folder => folder.relativePath !== draft.relativePath));
      }
    } finally {
      progressSubmittingRef.current = false;
      setProgressSubmitting(false);
    }
  };
  const trackingParentForProgress = (progressFolder: ProgressFolder, sourceFolders = progressFolders) => sourceFolders.find(folder => folder.id === progressFolder.parentProgressId && !folder.folderMissing);
  const progressTrackingRefreshLabel = (progressFolder: ProgressFolder) => progressTrackingActionLabel(progressFolder);
  const openProgressRepair = async (progressFolder: ProgressFolder) => {
    if (!progressFolder.repairBatchId) { onNotice('没有找到可修复的版本批次，请刷新版本跟踪。'); return; }
    setWorkspaceActivityMessage('正在读取失败的文件操作…');
    const result = await projectWorkspaceClient.getVersionBatchOperations(workspacePath, progressFolder.repairBatchId);
    setWorkspaceActivityMessage('');
    if (!result.success) { onNotice(`读取修复任务失败：${result.error || '未知错误'}`); return; }
    setProgressRepair({ progressFolder, batchId: progressFolder.repairBatchId, operations: result.operations });
  };
  const retryProgressRepair = async () => {
    if (!progressRepair || progressRepairBusy) return;
    setProgressRepairBusy(true);
    const retried = await projectWorkspaceClient.retryVersionBatchOperations(workspacePath, progressRepair.batchId);
    const refreshed = await projectWorkspaceClient.getVersionBatchOperations(workspacePath, progressRepair.batchId);
    setProgressRepairBusy(false);
    if (refreshed.success) setProgressRepair(current => current ? { ...current, operations: refreshed.operations } : current);
    await loadProgressFolders();
    directoryEntriesCacheRef.current.clear();
    await refresh('');
    if (retried.success && !retried.repairRequired) {
      setProgressRepair(null);
      onNotice('文件操作已全部修复，版本批次已完成。');
      return;
    }
    onNotice(`仍有 ${retried.renameErrors?.length || 0} 个文件操作需要处理：${retried.error || retried.renameErrors?.[0]?.error || '请检查文件占用或目标名称冲突'}`, 7000);
  };
  const refreshProgressTracking = async (requestedProgress: ProgressFolder) => {
    if (progressSubmitting || workspaceActivityMessage) return;
    if (!progressTrackingAction(requestedProgress)) { onNotice('选片、预览和协作内容不参与版本跟踪。'); return; }
    if (requestedProgress.trackingState === 'needs_repair' && requestedProgress.repairBatchId) { await openProgressRepair(requestedProgress); return; }
    setProgressSubmitting(true);
    try {
      const latestFolders = await loadProgressFolders();
      const progressFolder = latestFolders.find(folder => folder.id === requestedProgress.id) || requestedProgress;
      if (progressFolder.folderMissing) throw new Error('当前进度文件夹已经丢失');
      const parentFolder = trackingParentForProgress(progressFolder, latestFolders.length ? latestFolders : progressFolders);
      const relativePath = progressFolderRelativePath(progressFolder);
      if (!parentFolder) {
        setWorkspaceActivityMessage('正在重新扫描首个版本并更新项目跟踪…');
        const baseline = await projectWorkspaceClient.registerVersionBaseline(workspacePath, project.status, project.name, relativePath);
        if (!baseline.success) throw new Error(baseline.error || '无法更新项目跟踪');
        await loadProgressFolders();
        directoryEntriesCacheRef.current.clear();
        await refresh('');
        setVersionEntry(current => current ? { ...current, updatedAt: Date.now() } : current);
        onNotice(`已更新 ${progressFolder.displayName} 的 V${progressFolder.versionKey} 项目跟踪`);
        return;
      }
      const sessionStorageKey = `photoflow:tracking-session:${workspacePath}:${project.name}:${progressFolder.id}`;
      const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, {
        progressId: progressFolder.id,
        mode: progressFolder.lastTrackedAt || progressFolder.trackingState === 'stale' ? 'refresh' : 'compare',
      });
      if (!started.success || !started.sessionId) throw new Error(started.error || '无法启动版本跟踪任务');
      safeStorageSet(sessionStorageKey, started.sessionId);
      setTrackingConfirmationProgressId(progressFolder.id);
      if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') {
        setTrackingConfirmationSessionId(started.sessionId);
        if (started.sessionStatus === 'failed') {
          onNotice('已恢复上次失败的跟踪会话，可检查后重试。');
          return;
        }
        onNotice(started.sessionStatus === 'committing' ? '已恢复上次未完成的跟踪提交，可继续提交。' : '已恢复待确认的版本跟踪会话。');
        return;
      }
      onNotice(`已在后台开始比较 ${parentFolder.displayName} → ${progressFolder.displayName}，完成后可从任务中心打开确认面板。`);
    } catch (error) {
      onNotice(`刷新版本跟踪失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally {
      setWorkspaceActivityMessage('');
      setProgressSubmitting(false);
    }
  };
  const commitProgressCompare = async () => {
    if (!progressCompare || progressSubmitting) return;
    setProgressSubmitting(true);
    setWorkspaceActivityMessage('正在确认版本关系并写入素材历史…');
    const accepted = new Set(progressCompare.acceptedSources);
    const candidates = [...progressCompare.matches, ...progressCompare.suggestions];
    const acceptedMatches = candidates.filter(match => accepted.has(match.source));
    const acceptedReferences = new Set(acceptedMatches.map(match => match.reference));
    const result = await projectWorkspaceClient.commitVersionBatch(workspacePath, project.status, project.name, {
      folderA: progressCompare.parentFolder.folderPath,
      folderB: progressCompare.progressFolder.folderPath,
      importKey: crypto.randomUUID(),
      displayName: progressCompare.progressFolder.displayName,
      renameSources: progressCompare.renameSources,
      copyMissingReferences: progressCompare.copyMissingFromParent ? progressCompare.unmatchedReferences.filter(reference => !acceptedReferences.has(reference)) : [],
      reconcileExisting: Boolean(progressCompare.reconcileExisting),
      incrementalSources: progressCompare.incrementalSources,
      matches: acceptedMatches,
    });
    if (!result.success) {
      setProgressSubmitting(false);
      setWorkspaceActivityMessage('');
      onNotice(`建立版本跟踪失败：${result.error || '未知错误'}`);
      return;
    }
    const committedProgressFolder = progressCompare.progressFolder;
    setProgressSubmitting(false);
    setWorkspaceActivityMessage('');
    setProgressCompare(null);
    const latestProgressFolders = await loadProgressFolders();
    directoryEntriesCacheRef.current.clear();
    await refresh('');
    setVersionEntry(current => current ? { ...current, updatedAt: Date.now() } : current);
    const renameWarning = result.renameErrors?.length ? `，${result.renameErrors.length} 个文件未能同步重命名` : '';
    const copySummary = result.copiedMissingCount ? `，从上一版本补齐 ${result.copiedMissingCount} 个文件` : '';
    const copyWarning = result.copyMissingErrors?.length ? `，${result.copyMissingErrors.length} 个缺失文件复制失败` : '';
    const actionLabel = progressCompare.trackingRefreshMode === 'refresh' ? '已更新' : '已建立';
    if (result.repairRequired && result.batch?.id) {
      const repairFolder = latestProgressFolders.find(folder => folder.id === committedProgressFolder.id) || { ...committedProgressFolder, trackingEnabled: false, trackingState: 'needs_repair' as const, repairBatchId: result.batch.id, pendingOperationCount: result.renameErrors?.length || 0 };
      await openProgressRepair(repairFolder);
      onNotice(`版本关系已写入，但有 ${result.renameErrors?.length || 0} 个文件操作需要修复。`, 7000);
      return;
    }
    onNotice(`${actionLabel} V${progressCompare.parentFolder.versionKey} → V${progressCompare.progressFolder.versionKey} 的版本关系：${result.batch?.matchedCount || 0} 个延续版本，${result.batch?.newCount || 0} 个新素材${copySummary}${renameWarning}${copyWarning}`);
  };
  const disableProgressTracking = async () => {
    if (!progressCompare || progressSubmitting) return;
    setProgressSubmitting(true);
    const mediaKind = progressNodeMediaKind(progressCompare.progressFolder);
    if (!mediaKind) { setProgressSubmitting(false); onNotice('混合媒体节点不能修改版本跟踪。'); return; }
    const relativePath = progressFolderRelativePath(progressCompare.progressFolder);
    const result = await projectWorkspaceClient.registerProgressFolder(workspacePath, project.status, project.name, {
      relativePath,
      mediaKind,
      versionKey: progressCompare.progressFolder.versionKey,
      parentProgressId: progressCompare.progressFolder.parentProgressId,
      displayName: progressCompare.progressFolder.displayName,
      trackingEnabled: false,
      trackingState: 'disabled',
    });
    setProgressSubmitting(false);
    if (!result.success) { onNotice(`关闭项目跟踪失败：${result.error || '未知错误'}`); return; }
    setProgressCompare(null);
    await loadProgressFolders();
    onNotice(progressCompare.sourceMode === 'mark' ? '文件夹已标记为进度，但没有建立项目版本跟踪。' : '本次导入已保留，但没有建立项目版本跟踪。');
  };
  return {
    submitProgressSetup, unregisterLegacyOrphanProgress, submitFolderMarkSetup,
    progressTrackingRefreshLabel, openProgressRepair,
    retryProgressRepair, refreshProgressTracking, commitProgressCompare,
    disableProgressTracking,
  };
};
