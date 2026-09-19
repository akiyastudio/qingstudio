import type { Dispatch, SetStateAction } from 'react';
import type { AppConfig, ProgressFolder, ProjectFileEntry, ProjectFileOperationProgress, VersionGraphEdge, WorkspaceProject } from '../../types';
import type { ImportMaterialKind } from '../../components/ImportSourceControls';
import { createFolderMarkDraft, defaultFolderMarkPurpose, defaultMainParentId, defaultWorkflowInputIds, isUserVersionKey, nextVersionKeys, selectableVersionParents, versionKeyMatchesParentKind, versionKindForParent, type FolderMarkDraft } from '../versioning/public';
import { collectProgressSubtree } from './progress-tree-model';
import { isFolderLikeEntry } from './file-entry-sort-model';
import type { ProgressSetupDraft } from './project-progress-workflow-types';

type Options = {
  workspacePath: string;
  project: Pick<WorkspaceProject, 'name' | 'status'>;
  currentRelativePath: string;
  gatherToProject: boolean;
  importDefaults: AppConfig['importDefaults'];
  progressFolders: ProgressFolder[];
  progressRelationInspection: { needsRepair: boolean };
  versionGraphEdges: VersionGraphEdge[];
  onNotice: (message: string, duration?: number) => void;
  loadProgressFolders: () => Promise<ProgressFolder[]>;
  loadDirectoryPreviewEntries: (entry: ProjectFileEntry) => Promise<{ entries: ProjectFileEntry[]; authoritative: boolean }>;
  closeProgressSetup: () => void;
  setShowCreateMenu: Dispatch<SetStateAction<boolean>>;
  setShowImportMenu: Dispatch<SetStateAction<boolean>>;
  setProgressImportCompletion: Dispatch<SetStateAction<string>>;
  setProgressImportStatus: Dispatch<SetStateAction<ProjectFileOperationProgress | null>>;
  setProgressImportStep: Dispatch<SetStateAction<'source' | 'settings'>>;
  setProgressSetup: Dispatch<SetStateAction<ProgressSetupDraft | null>>;
  setPanelImportResult: Dispatch<SetStateAction<{ kind: 'broll' | 'files'; count: number; sourceDeleted: boolean } | null>>;
  setFileImportTarget: Dispatch<SetStateAction<string>>;
  setNegativeSourcePaths: Dispatch<SetStateAction<string[]>>;
  setBrollSourcePaths: Dispatch<SetStateAction<string[]>>;
  setDeleteBrollSources: Dispatch<SetStateAction<boolean>>;
  setFileImportSourcePaths: Dispatch<SetStateAction<string[]>>;
  setDeleteFileSources: Dispatch<SetStateAction<boolean>>;
  setPanel: (panel: 'negative-import' | 'broll' | 'file-import' | null) => void;
  setFolderMarkSetup: Dispatch<SetStateAction<FolderMarkDraft | null>>;
};

const normalizeProjectRelativePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const isUnsupportedShortcutContent = (entry: ProjectFileEntry) => entry.viaShortcut === true;
const progressNodeMediaKind = (folder: Pick<ProgressFolder, 'mediaKind'>): 'image' | 'video' | null => folder.mediaKind === 'image' || folder.mediaKind === 'video' ? folder.mediaKind : null;

export const createProjectProgressSetup = ({
  currentRelativePath, gatherToProject, importDefaults, progressFolders, progressRelationInspection,
  versionGraphEdges, onNotice, loadProgressFolders, loadDirectoryPreviewEntries, closeProgressSetup,
  setShowCreateMenu, setShowImportMenu, setProgressImportCompletion, setProgressImportStatus,
  setProgressImportStep, setProgressSetup, setPanelImportResult, setFileImportTarget,
  setNegativeSourcePaths, setBrollSourcePaths, setDeleteBrollSources,
  setFileImportSourcePaths, setDeleteFileSources, setPanel, setFolderMarkSetup,
}: Options) => {
  const progressFolderPrefix = (mediaKind: 'image' | 'video') => mediaKind === 'image' ? '图片后期' : '视频后期';
  const buildProgressFolderName = (mediaKind: 'image' | 'video', versionKey: string, progressName: string) => {
    const baseName = `${progressFolderPrefix(mediaKind)}_${versionKey}`;
    return progressName.trim() ? `${baseName}_${progressName.trim()}` : baseName;
  };
  const progressAppendTarget = (draft: ProgressSetupDraft) => draft.mode === 'import'
    ? progressFolders.find(folder => !folder.folderMissing && folder.mediaKind === draft.mediaKind && folder.versionKey === draft.versionKey)
    : undefined;
  const progressVersionIsValid = (draft: ProgressSetupDraft) => {
    if (progressRelationInspection.needsRepair) return false;
    if (!isUserVersionKey(draft.versionKey)) return false;
    if (!draft.parentProgressId) return false;
    const parent = selectableVersionParents(progressFolders, draft).find(folder => folder.id === draft.parentProgressId);
    return Boolean(parent && !progressSubtreeIds(draft.existingProgressId).has(parent.id)
      && versionKeyMatchesParentKind(draft.versionKey, parent, draft.relation === 'branch' ? 'branch' : 'main'));
  };
  const progressSubtreeIds = (progressId?: string) => {
    return collectProgressSubtree(progressFolders, progressId).visitedIds;
  };
  const progressComparisonParent = (draft: ProgressSetupDraft) => progressFolders.find(folder => folder.id === draft.parentProgressId && !folder.folderMissing);
  const resolvedProgressFolderName = (draft: ProgressSetupDraft) => {
    const appendTarget = progressAppendTarget(draft);
    if (appendTarget) return appendTarget.displayName;
    if (draft.existingProgressId) return buildProgressFolderName(draft.mediaKind, draft.versionKey, draft.progressName);
    if (draft.preserveFolderName) return draft.targetRelativePath?.split('/').pop() || draft.progressName.trim() || buildProgressFolderName(draft.mediaKind, draft.versionKey, '');
    return buildProgressFolderName(draft.mediaKind, draft.versionKey, draft.progressName);
  };
  const progressNameHasConflict = (draft: ProgressSetupDraft) => {
    if (progressAppendTarget(draft)) return false;
    const generatedName = resolvedProgressFolderName(draft).toLocaleLowerCase('zh-CN');
    return progressFolders.some(folder => !folder.folderMissing && folder.id !== draft.existingProgressId && folder.displayName.toLocaleLowerCase('zh-CN') === generatedName);
  };
  const progressVersionHasConflict = (draft: ProgressSetupDraft) => draft.mode !== 'import' && progressFolders.some(folder => !folder.folderMissing
    && folder.id !== draft.existingProgressId && folder.nodeRole === 'progress'
    && folder.mediaKind === draft.mediaKind && folder.versionKey === draft.versionKey);
  const progressNameFromDisplayName = (displayName: string, mediaKind: 'image' | 'video', versionKey: string, fallback: string) => {
    const generatedBase = `${progressFolderPrefix(mediaKind)}_${versionKey}`;
    if (displayName === generatedBase) return '';
    const generatedPrefix = `${generatedBase}_`;
    return displayName.startsWith(generatedPrefix) ? displayName.slice(generatedPrefix.length) : fallback;
  };
  const makeProgressDraft = (mode: 'create' | 'import' | 'mark', mediaKind: 'image' | 'video', relation: 'root' | 'branch', parentProgressId = '', sourceFolders = progressFolders): ProgressSetupDraft => {
    const structuralParents = selectableVersionParents(sourceFolders, { mediaKind, relationKind: 'main' });
    const requestedParent = structuralParents.find(folder => folder.id === parentProgressId);
    const semanticDefaultParentId = defaultMainParentId(sourceFolders, versionGraphEdges, mediaKind);
    const selectedParent = requestedParent || structuralParents.find(folder => folder.id === semanticDefaultParentId);
    if (relation === 'branch' && !selectedParent) throw new Error('分支进度缺少有效的结构父节点');
    const actualRelation = relation === 'branch' ? 'branch' : 'root';
    const parentId = selectedParent?.id || '';
    const versionKey = selectedParent
      ? relation === 'branch' ? nextVersionKeys(sourceFolders, mediaKind, selectedParent).branch : nextVersionKeys(sourceFolders, mediaKind, selectedParent).main
      : '';
    return { mode, mediaKind, relation: actualRelation, relationKind: 'main', parentProgressId: parentId, versionKey, progressName: '', trackingEnabled: Boolean(parentId) && mode !== 'create', deleteSourceAfterImport: importDefaults.deleteSourceAfterImport, sourcePaths: [], renameSources: false, copyMissingFromParent: false, workflowInputProgressIds: parentId ? defaultWorkflowInputIds(sourceFolders, versionGraphEdges, parentId) : [] };
  };
  const openProgressSetup = (mode: 'create' | 'import', sourcePaths: string[] = []) => {
    setShowCreateMenu(false);
    setShowImportMenu(false);
    setProgressImportCompletion('');
    setProgressImportStatus(null);
    setProgressImportStep(mode === 'import' ? 'source' : 'settings');
    // The cached list is already loaded when the project opens. Render the
    // editor immediately and reconcile the list in the background instead of
    // making the dialog wait on a database IPC round trip.
    setProgressSetup({ ...makeProgressDraft(mode, 'image', 'root', '', progressFolders), sourcePaths });
    void loadProgressFolders();
  };
  const openManualImport = (kind: ImportMaterialKind, sourcePaths: string[] = [], targetRelativePath = currentRelativePath) => {
    const availableKind = gatherToProject ? 'files' : kind;
    setShowImportMenu(false);
    setPanelImportResult(null);
    setFileImportTarget(targetRelativePath);
    if (availableKind === 'progress') {
      setPanel(null);
      openProgressSetup('import', sourcePaths);
      return;
    }
    closeProgressSetup();
    if (availableKind === 'original') {
      setNegativeSourcePaths(sourcePaths);
      setPanel('negative-import');
      return;
    }
    if (availableKind === 'broll') {
      setBrollSourcePaths(sourcePaths);
      setDeleteBrollSources(importDefaults.deleteSourceAfterImport);
      setPanel('broll');
      return;
    }
    setFileImportTarget(targetRelativePath);
    setFileImportSourcePaths(sourcePaths);
    setDeleteFileSources(importDefaults.deleteSourceAfterImport);
    setPanel('file-import');
  };
  const makeMarkProgressDraft = (entry: ProjectFileEntry, targetRelativePath: string, sourceFolders: ProgressFolder[]): ProgressSetupDraft | null => {
    const normalizedPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const registered = sourceFolders.find(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === normalizedPath);
    if (registered) {
      const mediaKind = progressNodeMediaKind(registered);
      if (registered.nodeRole !== 'progress' || !mediaKind) return null;
      const registeredParent = sourceFolders.find(folder => folder.id === registered.parentProgressId);
      const normalizedVersionKey = isUserVersionKey(registered.versionKey)
        ? registered.versionKey
        : nextVersionKeys(sourceFolders, mediaKind, registeredParent, registered.id).main;
      return {
        mode: 'mark',
        mediaKind,
        relation: versionKindForParent(normalizedVersionKey, registeredParent) === 'branch' ? 'branch' : 'root',
        relationKind: registered.relationKind || 'main',
        parentProgressId: registered.parentProgressId || '',
        versionKey: normalizedVersionKey,
        progressName: progressNameFromDisplayName(registered.displayName, mediaKind, registered.versionKey, entry.name),
        trackingEnabled: registered.trackingState !== 'disabled',
        deleteSourceAfterImport: true,

        sourcePaths: [],
        renameSources: registered.renameFromParent,
        copyMissingFromParent: registered.copyMissingFromParent,
        targetRelativePath,
        existingProgressId: registered.id,
        preserveFolderName: targetRelativePath.includes('/') || entry.name !== registered.displayName,
        workflowInputProgressIds: defaultWorkflowInputIds(sourceFolders, versionGraphEdges, registered.parentProgressId || '', registered.id),
      };
    }
    return null;
  };
  const openMarkProgress = async (entry: ProjectFileEntry, preferredMediaKind?: 'image' | 'video') => {
    const resolvedEntry = entry;
    const targetRelativePath = resolvedEntry.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (resolvedEntry.kind !== 'folder') {
      onNotice('只有文件夹可以创建版本进度。');
      return;
    }
    if (resolvedEntry.viaShortcut) {
      onNotice('快捷方式指向的外部目录不能移动或登记为版本进度。');
      return;
    }
    const normalizedFolderPath = resolvedEntry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const registered = progressFolders.find(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === normalizedFolderPath);
    if (!registered) {
      const mediaKind: 'image' | 'video' = preferredMediaKind || (/(mov|video|视频|剪辑|成片)/iu.test(resolvedEntry.name) ? 'video' : 'image');
      const folderEntries = targetRelativePath.includes('/') ? [] : (await loadDirectoryPreviewEntries(resolvedEntry)).entries;
      const initialPurpose = defaultFolderMarkPurpose(targetRelativePath, folderEntries.some(candidate => candidate.kind === 'raw'));
      setProgressImportCompletion('');
      setProgressImportStatus(null);
      setFolderMarkSetup(createFolderMarkDraft({ relativePath: targetRelativePath, folderName: resolvedEntry.name }, initialPurpose, progressFolders, mediaKind));
      void loadProgressFolders();
      return;
    }
    const initialDraft = makeMarkProgressDraft(resolvedEntry, targetRelativePath, progressFolders);
    if (!initialDraft) {
      onNotice('当前文件夹由对应功能管理，不能在版本设置面板中修改。');
      return;
    }
    // Show the cached draft immediately. A slow database or network drive must
    // not keep the dialog invisible while progress-folder locations are synced.
    setProgressSetup(initialDraft);
    void loadProgressFolders().then(latestFolders => {
      if (!latestFolders.length && progressFolders.length) return;
      const latestDraft = makeMarkProgressDraft(resolvedEntry, targetRelativePath, latestFolders);
      if (!latestDraft) {
        setProgressSetup(current => current === initialDraft ? null : current);
        onNotice('当前文件夹已不再是可修改的进度。');
        return;
      }
      // Do not replace fields after the user has started editing or closed the
      // dialog. Unchanged drafts can safely adopt the refreshed registration.
      setProgressSetup(current => current === initialDraft ? latestDraft : current);
    });
  };
  const openNextProgressFromVersionTree = async (source: ProgressFolder, entry: ProjectFileEntry) => {
    if (!isFolderLikeEntry(entry) || isUnsupportedShortcutContent(entry) || source.folderMissing || (source.nodeRole !== 'original' && source.nodeRole !== 'progress')) {
      onNotice('请选择项目内的普通文件夹来创建下一版本。');
      return;
    }
    const targetRelativePath = normalizeProjectRelativePath(entry.relativePath);
    const latestFolders = await loadProgressFolders();
    const targetPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase('zh-CN');
    if (latestFolders.some(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase('zh-CN') === targetPath)) {
      onNotice('该文件夹已经是版本树节点，不能重复创建版本。');
      return;
    }
    const completeDraft = (draft: ProgressSetupDraft): ProgressSetupDraft => ({
      ...draft,
      progressName: entry.name,
      targetRelativePath,
      trackingEnabled: false,
      preserveFolderName: true,
    });
    const latestSource = latestFolders.find(folder => folder.id === source.id) || source;
    const mediaKind = progressNodeMediaKind(latestSource);
    if (!mediaKind) { onNotice('混合媒体节点不能作为图片或视频版本进度父节点。'); return; }
    const nextDraft = completeDraft(makeProgressDraft('mark', mediaKind, 'root', latestSource.id, latestFolders));
    setProgressImportCompletion('');
    setProgressImportStatus(null);
    setProgressImportStep('settings');
    setProgressSetup({ ...nextDraft, contextLocked: true });
  };
  const openEmptyProgressFromVersionTree = async (source: ProgressFolder, branch: boolean) => {
    if (source.folderMissing || source.nodeRole !== 'progress') {
      onNotice('只能从有效的版本进度创建下一版本。');
      return;
    }
    const latestFolders = await loadProgressFolders();
    const latestSource = latestFolders.find(folder => folder.id === source.id);
    if (!latestSource) { onNotice('来源版本已发生变化，请刷新后重试。'); return; }
    const mediaKind = progressNodeMediaKind(latestSource);
    if (!mediaKind) { onNotice('混合媒体节点不能创建版本进度。'); return; }
    const draft = makeProgressDraft('create', mediaKind, branch ? 'branch' : 'root', source.id, latestFolders);
    setProgressSetup({ ...draft, trackingEnabled: true, contextLocked: true });
  };
  return {
    progressAppendTarget, progressVersionIsValid, progressComparisonParent, resolvedProgressFolderName,
    progressNameHasConflict, progressVersionHasConflict, progressNameFromDisplayName,
    openProgressSetup, openManualImport, openMarkProgress,
    openNextProgressFromVersionTree, openEmptyProgressFromVersionTree,
  };
};
