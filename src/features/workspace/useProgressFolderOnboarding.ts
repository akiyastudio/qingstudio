import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AppConfig, ProgressFolder, ProjectFileEntry, WorkspaceProject } from '../../types';
import type { useAppDialog } from '../../components/AppDialogProvider';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { createFolderMarkDraft, exportedImageFolderCandidate, exportedImageFolderCandidates, exportFolderPromptWasShown, rememberExportFolderPromptShown, type FolderMarkDraft } from '../versioning/public';
import { pageOwnsFileOperationNotification } from './file-operation-notification-model';

type Options = {
  active: boolean;
  versionTreeEnabled: boolean;
  projectWorkflows: boolean;
  workspacePath: string;
  project: Pick<WorkspaceProject, 'name' | 'path' | 'status' | 'ordinaryFiles'>;
  rootRelativeFileEvents: boolean;
  mediaCacheConfig: AppConfig['mediaCache'];
  appDialog: ReturnType<typeof useAppDialog>;
  onNotice: (message: string, duration?: number) => void;
  loadProgressFolders: () => Promise<ProgressFolder[]>;
  refresh: (relativePath?: string, options?: { includeProjectContents?: boolean }) => Promise<void>;
  currentRelativePathRef: MutableRefObject<string>;
  directoryEntriesCacheRef: MutableRefObject<Map<string, ProjectFileEntry[]>>;
  progressFoldersRef: MutableRefObject<ProgressFolder[]>;
  exportCandidateTimersRef: MutableRefObject<Map<string, number>>;
  exportCandidateChangedAtRef: MutableRefObject<Map<string, number>>;
  offeredExportFoldersRef: MutableRefObject<Set<string>>;
  setFolderMarkSetup: Dispatch<SetStateAction<FolderMarkDraft | null>>;
  setPendingProgressFolders: Dispatch<SetStateAction<Array<{ relativePath: string; name: string; mediaKind: 'image' | 'video' }>>>;
};
const normalizeProjectRelativePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

export const useProgressFolderOnboarding = ({
  active, versionTreeEnabled, projectWorkflows, workspacePath, project, rootRelativeFileEvents,
  mediaCacheConfig, appDialog, onNotice, loadProgressFolders, refresh, currentRelativePathRef,
  directoryEntriesCacheRef, progressFoldersRef, exportCandidateTimersRef, exportCandidateChangedAtRef,
  offeredExportFoldersRef, setFolderMarkSetup, setPendingProgressFolders,
}: Options) => {
  useEffect(() => {
    if (project.ordinaryFiles || !active || !versionTreeEnabled || !projectWorkflows) return;
    let disposed = false;
    const normalizedWorkspaceRoot = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
    const normalizedProjectPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const projectPrefix = rootRelativeFileEvents
      ? ''
      : normalizedProjectPath.toLocaleLowerCase().startsWith(`${normalizedWorkspaceRoot}/`)
        ? normalizedProjectPath.slice(normalizedWorkspaceRoot.length + 1)
        : project.name.replace(/\\/g, '/');
    const comparableProjectPrefix = projectPrefix.toLocaleLowerCase();
    const candidateKeyPrefix = `${normalizedProjectPath.toLocaleLowerCase()}|`;
    const candidateKey = (relativePath: string) => `${candidateKeyPrefix}${normalizeProjectRelativePath(relativePath).toLocaleLowerCase()}`;
    const scheduleCandidate = (projectRelativePath: string) => {
      const candidate = exportedImageFolderCandidate(projectRelativePath);
      if (!candidate) return;
      const key = candidateKey(candidate);
      exportCandidateChangedAtRef.current.set(key, Date.now());
      if (offeredExportFoldersRef.current.has(key) || exportFolderPromptWasShown(window.localStorage, key)) {
        offeredExportFoldersRef.current.add(key);
        return;
      }
      const previousTimer = exportCandidateTimersRef.current.get(key);
      if (previousTimer) window.clearTimeout(previousTimer);
      const timer = window.setTimeout(async () => {
        exportCandidateTimersRef.current.delete(key);
        const inspected = await projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, candidate, mediaCacheConfig);
        if (disposed || !inspected.success) return;
        const mediaCount = inspected.entries.filter(entry => entry.kind === 'image' || entry.kind === 'raw').length;
        if (!mediaCount) return;
        const candidatePath = `${normalizedProjectPath}/${candidate}`.replace(/\/+$/, '').toLocaleLowerCase();
        if (progressFoldersRef.current.some(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() === candidatePath)) {
          offeredExportFoldersRef.current.add(key);
          return;
        }
        offeredExportFoldersRef.current.add(key);
        rememberExportFolderPromptShown(window.localStorage, key);
        const folderName = candidate.split('/').pop() || candidate;
        const jpegFolder = /^(?:jpg|jpeg)$/iu.test(folderName);
        const accepted = await appDialog.confirm({
          title: jpegFolder ? '发现新的 JPEG 导出文件夹' : '发现新的“_导出”文件夹',
          message: `项目内位置：“${project.name}/${candidate}”\n文件夹中有 ${mediaCount} 张导出图片，是否创建为新的图片版本进度？`,
          detail: candidate.includes('/')
            ? '确认后会把整个导出文件夹移动到项目根目录，再打开版本设置供你确认名称、父版本和版本号。'
            : '该文件夹已位于项目根目录，确认后会打开版本设置供你确认名称、父版本和版本号。',
          confirmLabel: '创建新版本',
        });
        if (disposed || !accepted) return;
        if (Date.now() - (exportCandidateChangedAtRef.current.get(key) || 0) < 5000) {
          offeredExportFoldersRef.current.delete(key);
          onNotice(`“${folderName}”仍在写入，导出停止后会再次询问。`);
          scheduleCandidate(candidate);
          return;
        }
        let targetRelativePath = candidate;
        if (candidate.includes('/')) {
          const moved = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, 'move', [candidate], '');
          if (!moved.success || !moved.movedItems?.[0]?.destinationRelativePath) {
            if (pageOwnsFileOperationNotification(moved)) onNotice(`移动导出文件夹失败：${moved.error || '未知错误'}`);
            return;
          }
          targetRelativePath = normalizeProjectRelativePath(moved.movedItems[0].destinationRelativePath);
          offeredExportFoldersRef.current.add(candidateKey(targetRelativePath));
        }
        directoryEntriesCacheRef.current.clear();
        void refresh(currentRelativePathRef.current);
        const targetName = targetRelativePath.split('/').pop() || folderName;
        const latestFolders = await loadProgressFolders();
        setPendingProgressFolders(current => current.filter(folder => folder.relativePath !== targetRelativePath));
        setFolderMarkSetup(createFolderMarkDraft({ relativePath: targetRelativePath, folderName: targetName }, 'progress', latestFolders, 'image'));
      }, 5000);
      exportCandidateTimersRef.current.set(key, timer);
    };
    const scanExistingCandidates = async () => {
      // The watcher only reports changes made after it starts. Reconcile folder
      // names on activation so exports completed in the background are not lost.
      await loadProgressFolders();
      const listed = await projectWorkspaceClient.listWorkspaceFolders(workspacePath, project.status, project.name);
      if (disposed || !listed.success) return;
      const candidates = exportedImageFolderCandidates(listed.folders
        .map(folder => folder.relativePath));
      const presentKeys = new Set(candidates.map(candidateKey));
      for (const key of offeredExportFoldersRef.current) {
        if (key.startsWith(candidateKeyPrefix) && !presentKeys.has(key)) offeredExportFoldersRef.current.delete(key);
      }
      for (const candidate of candidates) scheduleCandidate(candidate);
    };
    const unsubscribe = projectWorkspaceClient.onWorkspaceFilesChanged(change => {
      if (change.root && change.root.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() !== normalizedWorkspaceRoot) return;
      const changedPath = (change.fileName || '').replace(/\\/g, '/');
      if (!changedPath) return;
      const comparableChangedPath = changedPath.toLocaleLowerCase();
      if (projectPrefix && comparableChangedPath !== comparableProjectPrefix && !comparableChangedPath.startsWith(`${comparableProjectPrefix}/`)) return;
      const projectRelativePath = !projectPrefix ? changedPath : changedPath === projectPrefix ? '' : changedPath.slice(projectPrefix.length + 1);
      scheduleCandidate(projectRelativePath);
    });
    void scanExistingCandidates();
    return () => {
      disposed = true;
      unsubscribe();
      for (const timer of exportCandidateTimersRef.current.values()) window.clearTimeout(timer);
      exportCandidateTimersRef.current.clear();
      exportCandidateChangedAtRef.current.clear();
    };
  }, [project.ordinaryFiles, active, loadProgressFolders, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB, project.name, project.path, project.status, projectWorkflows, rootRelativeFileEvents, versionTreeEnabled, workspacePath]);
};
