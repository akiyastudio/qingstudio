import { LocalizedText } from "../../i18n/LocalizedText";
import { localizedMessage } from "../../i18n/messages";
import { getLocale } from "../../i18n/runtime";
import { PROJECT_FILE_FILTER_OPTIONS, PROJECT_BINARY_RATING_FILTER_OPTIONS, PROJECT_STAR_RATING_FILTER_OPTIONS, trackingStateLabel, versionTreeNodeBadgeLabel } from "../../i18n/built-in-labels";
import { useLocale } from "../../i18n/react";
import { t } from "../../i18n/runtime";
import { workspaceWindowContext, type WorkspaceWindowSeed } from '../../platform/workspace-window-client';
import { type ProjectFileFilter, type ProjectRatingFilter } from './project-file-filter-options';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { usePageState, usePageTransferParticipant, useRestorePageTransferState } from '../../platform/page-transfer-state';
import { createPortal } from 'react-dom';
import { FolderInput, FolderPlus, Folder, Image as ImageIcon, GalleryVerticalEnd, Play, Trash2, Edit, X, Plus, Loader2, CheckCircle2, ExternalLink, Video, ChevronDown, File, FileImage, MemoryStick, LayoutList, Grid2X2, FileText, Copy, Scissors as Cut, ClipboardPaste, CheckSquare, ArrowLeft, ArrowRight, Gauge, PanelLeftOpen, ArrowUpDown, ArrowUp, ArrowDown, AlertTriangle, Search, Filter as Funnel, Info, GripVertical, GitBranch, RefreshCw, Crop } from 'lucide-react';
import { VersionManager } from '../../components/VersionManager';
import { MediaThumbnail } from '../../components/MediaThumbnail';
import { ComponentFileThumbnail } from './ComponentFileThumbnail';
import { ImportSourceControls, type ImportMaterialKind } from '../../components/ImportSourceControls';
import { mergeSourcePaths } from '../../components/source-path-picker-model';
import type { CropRectangle } from '../../components/InteractiveCropEditor';
import { ProjectVersionTree, type VersionTreeCanvasController } from '../../components/ProjectVersionTree';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useVersionChanges } from '../versioning/public';
import { useEscapeLayer } from '../../components/LayerProvider';
import { ConverterView, ImportCard, MatchView, ResearchView, ScreenshotMainImageView, type ImportCompletion } from '../tools/ToolViews';
import { resolveInspectedToolSources } from '../tools/tool-source-selection-model';
import { PROJECT_FILE_BROWSER_CONTEXT } from '../file-browser/browser-context';
import type { FileBrowserContext } from '../file-browser/browser-context';
import { FolderCover, ShortcutEntryIcon, SystemFileIcon } from './FileEntryVisuals';
import { MediaPreviewPane, type PreviewImageCropAnalysis, type PreviewTechnicalMetadata } from './MediaPreviewPane';
import { usePreviewDecoders, decoderForFile } from './usePreviewDecoders';
import { ComponentFolderPanelSurface } from '../components/ComponentFolderPanelSurface';
import { useComponentFolderPanelState } from '../components/useComponentFolderPanelState';
import { WORKSPACE_PANEL_IDS, componentWorkspacePanelId } from '../../contracts/workspace-panels';
import { WorkspacePanelDragSpace } from './WorkspacePanelHeader';
import { ProjectStatusMenu } from './ProjectStatusMenu';
import { normalizeProjectCategoryOrder, PROJECT_TOOLBAR_ACTION_IDS } from '../../types';
import type { AppConfig, ComponentContribution, ComponentHostAction, ComponentPageOpenScope, MediaMetadataField, ProgressFolder, ProjectFileEntry, ProjectFileOperationProgress, ProjectFileSortField, ProjectFilterScope, ProjectToolbarActionId, ShellNewFileType, VersionBatchFileOperation, VersionGraphEdge, WorkspaceProject } from '../../types';
import { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure } from '../../utils/recycleBinFailure';
import { useTaskCenter } from '../background-tasks/TaskCenter';
import { isPanelTaskRestoreForPage, panelTaskSessionKey, type PanelTaskRestoreDetail } from '../background-tasks/panel-task-session-model';
import { FILE_GRID_GAP, FILE_LIST_HEADER_HEIGHT, FILE_LIST_ROW_HEIGHT, FILE_SURFACE_HORIZONTAL_PADDING, FILE_SURFACE_PADDING, calculateFileGridGeometry, fileSurfaceContentWidth, finiteLogicalCanvasSize, hitMarqueeIndices, mergeMarqueeSelection, normalizeMarqueeRect, rectanglesIntersect, viewportPointToContentPoint, type MarqueeRect } from './marquee-selection-model';
import { advanceMarqueeAutoScroll, marqueeAutoScrollDelta } from './marquee-auto-scroll';
import { converterTriggerAction } from './project-panel-lifecycle';
import { PROJECT_BACKGROUND_LOAD_DELAYS_MS, PROJECT_WATCH_FALLBACK_REFRESH_MS, isForegroundDirectoryRefresh, resolveProjectWorkspaceLifecycle, shouldReconcileProjectWatch, type ProjectWorkspaceLifecycleIdentity } from './project-workspace-lifecycle';
import { applyShortcutPreviewState } from './shortcut-preview-state-model';
import { directoryEntryToRevealOnReturn, fileEntryClickIntent, fileEntryDragPaths, fileEntryPointerModifiers, mediaRatingCacheKey, mergeRefreshedEntryMetadata, mergeRefreshedRecursiveDirectoryEntries, mutatedEntryCanBeRevealed, mutatedEntryFiltersNeedReset, ratingMutationPreviewIsCurrent, remapEntryAfterProgressFolderMove, renamedEntryDestinationPath, retainStableGroupOrder, type ProgressFolderEntryLocation } from './file-entry-interaction-model';
import { nativeFileDragDecisionDetails, nativeFileDragOwnerIdentity, nativeFileDragSessionMustReset, nativeFileDragTargetFromElement, tryStartNativeFileDrag } from './native-file-drag-session-model';
import { extractBrowserImageUrls, hasImportableExternalDragData, readBrowserProvidedImageFiles, type DroppedBrowserImageFile } from './browser-image-drop-model';
import { FOLDER_ALPHABET_FILTER_THRESHOLD, FOLDER_ALPHABET_KEYS, availableFolderAlphabetKeys, folderAlphabetKey } from './folder-alphabet-filter-model';
import { useProjectFileQueries } from './useProjectFileQueries';
import { useProjectVersionRelations } from './useProjectVersionRelations';
import { useProgressFolderOnboarding } from './useProgressFolderOnboarding';
import { useDelayedVisibility } from './use-delayed-visibility';
import type { CompareMatch, ProgressCompareConfirmation, ProgressSetupDraft } from './project-progress-workflow-types';
import { createProjectProgressWorkflow } from './createProjectProgressWorkflow';
import { createProjectProgressSetup } from './createProjectProgressSetup';
import { setProjectProgressTrackingState } from './project-progress-tracking-service';
import { inspectProgressRelations } from './progress-tree-model';
import { FolderMarkPanel, TrackingConfirmationPanel, type FolderMarkDraft, VersionProgressPanel, type VersionProgressDraft, defaultWorkflowInputIds, normalizeTrackingPolicy, peekVersionTreeSnapshot, prefetchVersionTreeLayout, progressTrackingAction, selectableVersionParents, versionKindForParent, versionTreeTaskPanelProgress, workflowInputIdsForRelationChange } from '../versioning/public';
import { previewMetadataFieldsForEntry } from '../metadata/metadata-pane-model';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { useProjectFileSelection } from './useProjectFileSelection';
import { defaultProjectFileSortDirection, isFolderLikeEntry, sortProjectFileEntries } from './file-entry-sort-model';
import { pageOwnsFileOperationNotification } from './file-operation-notification-model';
import { presentOfficeExtractionResult, type OfficeExtractionPresentation } from './office-extraction-result-model';
import { addPendingFileOperation, applyPendingFileOperations, claimClipboardGeneration, operationRefreshDirectories, pendingOperationForEntry, pendingPathConflicts, predictUniqueDirectoryName, reconcileDirectoryPaths, removePendingFileOperation, selectionOutsidePendingRenames, type PendingFileOperation, type PendingProjectFileEntry } from './file-operation-state-model';
import { directoryPreviewCacheKey, directoryPreviewCacheKeyWithin, pendingDirectoryPreviewSourceCacheKey, remapDirectoryPreviewCacheKey, remapPendingDirectoryPreviewEntries, settlePendingDirectoryPreviewRenameCaches, shouldCacheDirectoryPreviewResult } from './directory-preview-cache-model';
import { ImportCompletionNotice, ToolModal } from './ProjectToolModal';
import { ComponentToolbarActions, FileListColumnResizeHandle, ViewportContextMenu, ViewportSubmenu } from './ProjectWorkspaceLayout';
import { WorkspaceDockLayout } from './WorkspaceDockLayout';
import { useFilePanelStatusRight, useWorkspacePanelLayout, readWorkspacePanelWidths, usePersistWorkspacePanelWidths } from './useWorkspacePanelLayout';
import { useWorkspacePanelControls } from './useWorkspacePanelControls';
import { fitPanelWidths, resizePanelBoundary, type WorkspacePanelId } from './workspace-panel-model';
import { forgetMediaThumbnailPreviews } from './useProjectThumbnail';
import { isOfficeOpenXmlEntry, isPhotoshopOpenEntry, isScreenshotMainImageEntry, requestCaptureDateTime } from './project-workspace-media-metadata';
import { FILE_LIST_COLUMN_STORAGE_KEYS, FILE_LIST_COLUMNS_CUSTOMIZED_STORAGE_KEY, DEFAULT_FILE_LIST_COLUMN_WIDTHS, FILE_LIST_COLUMN_KEYS, FILE_LIST_GRID_CHROME_WIDTH, clampNumber, fitFileListColumnWidths, groupedResultsAreInitiallyLoading, readStoredBoolean, readStoredNumber, resizeFileListColumnBoundary, scheduleAfterProjectPaint, type FileListColumnBoundary, type FileListColumnWidths } from './project-workspace-layout-model';
import { PhotoshopIcon } from './PhotoshopIcon';
import { useUserFacingToast, type ToastActivityHandle } from '../app/useUserFacingToast';
import { ComponentContributionDock } from '../components/ComponentContributionDock';
import { ComponentIcon } from '../../components/ComponentIcon';
import { componentHostSelectedRelativePaths as safeComponentHostSelectedRelativePaths, mediaContributionScope, resolvePlacedFullPageAction, projectContributionScope, visibleComponentToolbarActions, workspaceToolContributions, type WorkspaceToolPlacement } from '../components/component-contribution-scope-model';
import { mayCommitAsyncOperationResult } from '../file-operation-identity-model';
import type { SelectionEntryDetails } from './multi-selection-metadata-model';
import { FileMetadataPane } from './FileMetadataPane';
import { ProgressPairPreview } from './ProjectProgressPairPreview';
type ProjectFileDragEndResult = Parameters<Parameters<typeof projectWorkspaceClient.onProjectFileDragEnd>[0]>[0];
const FILE_VIRTUAL_OVERSCAN_ROWS = 10;
const DIRECTORY_PREVIEW_RETRY_DELAYS_MS = [120, 480] as const;
const JPG_CONVERSION_EXTENSIONS = new Set(['.png', '.webp', '.heic', '.heif', '.hif', '.avif', '.tif', '.tiff', '.bmp', '.gif']);
type DirectoryPreviewLoadResult = { entries: ProjectFileEntry[]; authoritative: boolean };
type ProjectPanel = 'import' | 'negative-import' | 'broll' | 'file-import' | 'match' | 'research' | 'converter' | 'screenshot-main-image' | 'office-extract' | 'trash' | null;
type MountedProjectPanel = Exclude<ProjectPanel, null>;
const PROJECT_PANEL_TITLES: Record<MountedProjectPanel, string> = {
  import: '从 SD 卡导入',
  'negative-import': '导入 · 原始素材',
  broll: '导入 · 花絮',
  'file-import': '导入 · 其他文件',
  match: '从文件名选片',
  research: '截取分镜帧',
  converter: '图片转 JPG',
  'screenshot-main-image': '提取截图主图',
  'office-extract': '提取文档图片',
  trash: '移入回收站',
};
type ProjectBrowseMode = 'recent' | 'grid' | 'list' | 'version-tree';
const isProjectBrowseMode = (value: unknown): value is ProjectBrowseMode => value === 'recent' || value === 'grid' || value === 'list' || value === 'version-tree';
const DEFAULT_FOLDER_GRID_ICON_SIZE = 132;
const MIN_FOLDER_GRID_ICON_SIZE = 80;
const MAX_FOLDER_GRID_ICON_SIZE = 360;
const normalizeFolderGridIconSize = (value: unknown) => Math.max(MIN_FOLDER_GRID_ICON_SIZE, Math.min(MAX_FOLDER_GRID_ICON_SIZE, Math.round(Number(value) / 4) * 4));
const normalizeProjectRelativePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const safeStorageSet = (key: string, value: string) => { try { window.localStorage.setItem(key, value); } catch { /* optional state */ } };
const safeStorageRemove = (key: string) => { try { window.localStorage.removeItem(key); } catch { /* optional state */ } };
const projectRelativeParentPath = (value: string) => normalizeProjectRelativePath(value).split('/').slice(0, -1).join('/');
const INSPIRATION_DISABLED_IMPORT_KINDS: readonly ImportMaterialKind[] = ['original', 'progress', 'broll'];
const PROTECTED_PROJECT_FOLDER_NAMES = new Set(['raw', 'jpg', 'mov', 'mov_转码', '策划']);
const progressNodeMediaKind = (folder: Pick<ProgressFolder, 'mediaKind'>): 'image' | 'video' | null => folder.mediaKind === 'image' || folder.mediaKind === 'video' ? folder.mediaKind : null;
type ProgressCompareFilter = 'recognized' | 'accepted' | 'new' | 'missing';
type ProgressCompareListItem = {
  key: string;
  source?: string;
  reference?: string;
  match?: CompareMatch;
  category: ProgressCompareFilter;
};
const progressCompareCandidatesFor = (compare: ProgressCompareConfirmation) => [...compare.matches, ...compare.suggestions];
const progressCompareMissingReferencesFor = (compare: ProgressCompareConfirmation) => {
  const acceptedSources = new Set(compare.acceptedSources);
  const acceptedReferences = new Set(progressCompareCandidatesFor(compare)
    .filter(match => acceptedSources.has(match.source))
    .map(match => match.reference));
  return compare.unmatchedReferences.filter(reference => !acceptedReferences.has(reference));
};
const progressCompareNewSourcesFor = (compare: ProgressCompareConfirmation) => {
  const acceptedSources = new Set(compare.acceptedSources);
  return Array.from(new Set([
    ...compare.unmatchedSources,
    ...compare.matches.filter(match => !acceptedSources.has(match.source)).map(match => match.source),
  ])).filter(source => !acceptedSources.has(source));
};
const buildProgressCompareListItems = (compare: ProgressCompareConfirmation, filter: ProgressCompareFilter): ProgressCompareListItem[] => {
  const candidates = progressCompareCandidatesFor(compare);
  const acceptedSources = new Set(compare.acceptedSources);
  if (filter === 'recognized') return compare.matches.map(match => ({ key: `source:${match.source}`, source: match.source, reference: match.reference, match, category: filter }));
  if (filter === 'accepted') return candidates.filter(match => acceptedSources.has(match.source)).map(match => ({ key: `source:${match.source}`, source: match.source, reference: match.reference, match, category: filter }));
  if (filter === 'new') return progressCompareNewSourcesFor(compare).map(source => {
    const match = candidates.find(candidate => candidate.source === source);
    return { key: `source:${source}`, source, reference: match?.reference, match, category: filter };
  });
  return progressCompareMissingReferencesFor(compare).map(reference => {
    const match = candidates.find(candidate => candidate.reference === reference && !acceptedSources.has(candidate.source));
    return { key: `reference:${reference}`, source: match?.source, reference, match, category: filter };
  });
};
const EMPTY_PREVIEW_TECHNICAL_METADATA: PreviewTechnicalMetadata = {};
type ProjectEntryDetails = { size: number; createdAt: number; updatedAt: number; fileCount: number; folderCount: number };
type BatchRenameToken = 'text' | 'original' | 'sequence' | 'letter' | 'datetime' | 'replace';
type BatchRenamePart = {
  id: string;
  type: BatchRenameToken;
  value: string;
  caseMode: 'preserve' | 'upper' | 'lower';
  sequenceStart: number;
  sequenceDigits: number;
  letterCase: 'upper' | 'lower';
  dateSource: 'created' | 'modified';
  dateFormat: string;
  find: string;
  replace: string;
};
const createBatchRenamePart = (type: BatchRenameToken = 'text'): BatchRenamePart => ({
  id: `rename-part-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  type,
  value: '',
  caseMode: 'preserve',
  sequenceStart: 1,
  sequenceDigits: 2,
  letterCase: 'upper',
  dateSource: 'modified',
  dateFormat: 'YYYYMMDD_HHmmss',
  find: '',
  replace: ''
});
const formatBatchRenameDate = (date: Date, pattern: string) => {
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    DD: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0')
  };
  return pattern.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, token => values[token]);
};
const formatBatchRenameLetter = (index: number, letterCase: 'upper' | 'lower') => {
  let value = Math.max(0, index) + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return letterCase === 'lower' ? result.toLocaleLowerCase() : result;
};
type FileBrowserWorkspaceProps = {
  pageId: string;
  initialRelativePath?: string;
  active: boolean;
  activeView: 'project' | 'version';
  project: WorkspaceProject;
  workspacePath: string;
  componentWorkspacePath?: string;
  inspirationTargetWorkspacePath?: string;
  inspirationLibraryRootPath?: string;
  installedComponentIds: ReadonlySet<string>;
  videoToolsAvailable: boolean;
  advancedVideoPlaybackAvailable: boolean;
  componentHostActions?: ComponentHostAction[]; componentContributions?: ComponentContribution[]; onOpenComponentPage?: (action: ComponentHostAction, scope: ComponentPageOpenScope) => void; videoPlaybackSettings: AppConfig['videoPlayback'];
  projectToolbar?: AppConfig['projectToolbar'];
  customProjectCategories?: string[];
  projectCategoryOrder?: string[];
  progressNamePresets?: string[];
  initialPanel: 'import' | 'broll' | 'match' | null;
  importConfig: AppConfig['smartImport'];
  importDefaults: AppConfig['importDefaults'];
  brollConfig: AppConfig['brollImport'];
  videoTools: AppConfig['videoTools'];
  matchConfig: AppConfig['smartMatch'];
  researchConfig: AppConfig['research'];
  mediaCacheConfig: AppConfig['mediaCache'];
  defaultFolderSort: ProjectFileSortField;
  itemOpenMode: AppConfig['itemOpenMode'];
  folderAlphabetFilterEnabled?: boolean;
  versionTreeEnabled?: boolean;
  favoriteDisplayMode?: AppConfig['favoriteDisplayMode'];
  browserContext: FileBrowserContext;
  navigationRequest?: { path: string; id: number };
  onDirectoryChange?: (relativePath: string) => void;
  onOpenInspirationPath?: (relativePath: string) => void;
  onOpenDirectoryPage?: (relativePath: string) => void;
  onOpenToolTab?: (kind: 'version', label: string, version?: WorkspaceWindowSeed['version']) => void;
  onCloseToolTab?: (kind: 'version') => void;
  onImportConfigChange: (config: AppConfig['smartImport']) => void;
  onMatchConfigChange: (config: AppConfig['smartMatch']) => void;
  onResearchConfigChange: (config: AppConfig['research']) => void;
  onNotice: (message: string, duration?: number) => void | (() => void);
  onProjectMoved?: (project: WorkspaceProject) => void;
  onDeleted?: () => void;
};
const isUnsupportedShortcutContent = (entry: ProjectFileEntry) => entry.viaShortcut === true;
const backgroundTaskPathKey = (value: unknown) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
const handledVideoTrimTaskIds = new Set<string>();
const FileBrowserWorkspace = ({ pageId, active, activeView, project, workspacePath, componentWorkspacePath = workspacePath, inspirationTargetWorkspacePath, inspirationLibraryRootPath, installedComponentIds: _installedComponentIds, videoToolsAvailable, advancedVideoPlaybackAvailable, componentHostActions = [], componentContributions = [], onOpenComponentPage = () => undefined, videoPlaybackSettings, projectToolbar = { order: [...PROJECT_TOOLBAR_ACTION_IDS], hidden: [], onlyShowAvailable: false }, customProjectCategories = [], projectCategoryOrder = [], progressNamePresets = [], initialPanel, initialRelativePath = '', importConfig, importDefaults, brollConfig, videoTools, matchConfig, researchConfig, mediaCacheConfig, defaultFolderSort, itemOpenMode, folderAlphabetFilterEnabled = true, versionTreeEnabled = true, favoriteDisplayMode = 'binary', browserContext, navigationRequest, onDirectoryChange, onOpenInspirationPath, onOpenDirectoryPage, onOpenToolTab = () => undefined, onCloseToolTab = () => undefined, onImportConfigChange, onMatchConfigChange, onResearchConfigChange, onNotice, onProjectMoved = () => undefined, onDeleted = () => undefined }: FileBrowserWorkspaceProps) => {
  useLocale();
  const toast = useUserFacingToast();
  const appDialog = useAppDialog();
  const projectStatuses = useMemo<Array<WorkspaceProject['status']>>(() => {
    const values = [...normalizeProjectCategoryOrder(projectCategoryOrder, customProjectCategories), project.status];
    const seen = new Set<string>();
    return values.filter(status => {
      const key = status.toLocaleLowerCase();
      if (status === '未分类' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [customProjectCategories, project.status, projectCategoryOrder]);
  const { backgroundTasks, panelTasks, dismissBackgroundTask, withdrawPanelTask } = useTaskCenter();
  const [folders, setFolders] = useState<Array<{ name: string; path: string; updatedAt: number }>>([]);
  const [initialVersionTreeSnapshot] = useState(() => peekVersionTreeSnapshot(workspacePath, project.name, project.path, project.status));
  const [progressFolders, setProgressFolders] = useState<ProgressFolder[]>(() => initialVersionTreeSnapshot?.progressFolders || []);
  const [versionGraphEdges, setVersionGraphEdges] = useState<VersionGraphEdge[]>(() => initialVersionTreeSnapshot?.graphEdges || []);
  const exportCandidateTimersRef = useRef(new Map<string, number>());
  const exportCandidateChangedAtRef = useRef(new Map<string, number>());
  const offeredExportFoldersRef = useRef(new Set<string>());
  const progressRelationInspection = useMemo(() => inspectProgressRelations(progressFolders), [progressFolders]);
  const orphanedProgressFolders = useMemo(() => progressFolders.filter(folder => folder.nodeRole === 'progress'
    && !folder.parentProgressId && !folder.folderMissing), [progressFolders]);
  const progressRelationNoticeRef = useRef('');
  const orphanedProgressNoticeRef = useRef('');
  useEffect(() => {
    const signature = progressRelationInspection.cycleNodeIds.slice().sort().join(',');
    if (!signature) {
      progressRelationNoticeRef.current = '';
      return;
    }
    if (progressRelationNoticeRef.current === signature) return;
    progressRelationNoticeRef.current = signature;
    console.error('Version relation cycle detected', { projectName: project.name, nodeIds: progressRelationInspection.cycleNodeIds });
    onNotice(`版本关系需要修复：检测到循环节点 ${progressRelationInspection.cycleNodeIds.join('、')}`, 10000);
  }, [onNotice, progressRelationInspection, project.name]);
  useEffect(() => {
    const signature = orphanedProgressFolders.map(folder => folder.id).sort().join(',');
    if (!signature) { orphanedProgressNoticeRef.current = ''; return; }
    if (orphanedProgressNoticeRef.current === signature) return;
    orphanedProgressNoticeRef.current = signature;
    onNotice(`检测到 ${orphanedProgressFolders.length} 个旧版游离进度；已保留数据且不会自动删除。请修改进度并选择有效父版本，或显式取消版本登记。`, 12000);
  }, [onNotice, orphanedProgressFolders]);
  const [fileEntries, setFileEntries] = useState<ProjectFileEntry[]>([]);
  const fileEntriesRef = useRef(fileEntries);
  fileEntriesRef.current = fileEntries;
  const [pendingFileOperations, setPendingFileOperations] = useState<PendingFileOperation[]>([]);
  const pendingFileOperationsRef = useRef(pendingFileOperations);
  pendingFileOperationsRef.current = pendingFileOperations;
  const pendingFileOperationSequenceRef = useRef(0);
  const renderedDirectoryRef = useRef({ path: normalizeProjectRelativePath(initialRelativePath), ready: false });
  const [directoryLoading, setDirectoryLoading] = useState(active);
  const [foregroundDirectoryReady, setForegroundDirectoryReady] = useState(false);
  const [virtualWindow, setVirtualWindow] = useState({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 });
  const virtualWindowRef = useRef(virtualWindow);
  virtualWindowRef.current = virtualWindow;
  const [currentRelativePath, setCurrentRelativePath] = usePageState(pageId, "currentRelativePath", initialRelativePath);
  const [directoryHistory, setDirectoryHistory] = usePageState<{ back: string[]; forward: string[] }>(pageId, "directoryHistory", { back: [], forward: [] });
  const [browseMode, setBrowseMode] = usePageState<ProjectBrowseMode>(pageId, "browseMode", 'grid');
  const browseModeRef = useRef(browseMode);
  browseModeRef.current = browseMode;
  const viewMode: 'list' | 'grid' = browseMode === 'list' ? 'list' : 'grid';
  const recursiveFlatOpen = browseMode === 'recent';
  const versionTreeOpen = browseMode === 'version-tree';
  const [versionTreeHeaderCollapsed, setVersionTreeHeaderCollapsed] = usePageState(pageId, "versionTreeHeaderCollapsed", false);
  const [gridIconSize, setGridIconSize] = usePageState(pageId, "gridIconSize", DEFAULT_FOLDER_GRID_ICON_SIZE);
  const initialGridThumbnailSize = DEFAULT_FOLDER_GRID_ICON_SIZE * Math.min(2, window.devicePixelRatio || 1) <= 320 ? 320 : 640;
  const [gridThumbnailSize, setGridThumbnailSize] = useState(initialGridThumbnailSize);
  useEffect(() => {
    const physicalSize = gridIconSize * Math.min(2, window.devicePixelRatio || 1);
    const desiredSize = physicalSize <= 320 ? 320 : physicalSize <= 640 ? 640 : 1600;
    if (desiredSize <= gridThumbnailSize) return;
    const timer = window.setTimeout(() => setGridThumbnailSize(current => Math.max(current, desiredSize)), 320);
    return () => window.clearTimeout(timer);
  }, [gridIconSize, gridThumbnailSize]);
  useEffect(() => {
    setVersionTreeHeaderCollapsed(false);
  }, [currentRelativePath, versionTreeOpen]);
  const [sortField, setSortField] = usePageState<ProjectFileSortField>(pageId, "sortField", defaultFolderSort);
  const [sortDirection, setSortDirection] = usePageState<'asc' | 'desc'>(pageId, "sortDirection", defaultProjectFileSortDirection(defaultFolderSort));
  useEffect(() => {
    setSortField(defaultFolderSort);
    setSortDirection(defaultProjectFileSortDirection(defaultFolderSort));
  }, [defaultFolderSort]);
  const selectSortField = (field: ProjectFileSortField) => {
    if (field !== sortField) setSortDirection(defaultProjectFileSortDirection(field));
    setSortField(field);
  };
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [searchOpen, setSearchOpen] = usePageState(pageId, "searchOpen", false);
  const [searchQuery, setSearchQuery] = usePageState(pageId, "searchQuery", '');
  const [fileFilter, setFileFilter] = usePageState<ProjectFileFilter>(pageId, "fileFilter", 'all');
  const [folderAlphabetFilter, setFolderAlphabetFilter] = usePageState(pageId, "folderAlphabetFilter", '');
  const [filterScope, setFilterScope] = usePageState<ProjectFilterScope>(pageId, "filterScope", 'current-folder');
  const projectRootScopeSelected = filterScope === 'project-root';
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [ratingFilter, setRatingFilter] = usePageState<ProjectRatingFilter>(pageId, "ratingFilter", 'all');
  const [filterRatings, setFilterRatings] = useState<Record<string, number>>({});
  const [filterRatingsLoading, setFilterRatingsLoading] = useState(false);
  const [filterRatingsCheckedCount, setFilterRatingsCheckedCount] = useState(0);
  const filterRatingSequenceRef = useRef(0);
  useEffect(() => {
    if (favoriteDisplayMode !== 'stars' && ratingFilter !== 'all' && ratingFilter !== 'rated') setRatingFilter('rated');
  }, [favoriteDisplayMode, ratingFilter]);
  const [rootWatchFailed, setRootWatchFailed] = useState(false);
  const [externalWatchRevision, setExternalWatchRevision] = useState(0);
  useEffect(() => {
    if (searchQuery && !searchOpen) setSearchOpen(true);
  }, [searchQuery, searchOpen]);
  const projectWorkspaceRef = useRef<HTMLDivElement>(null);
  const projectColumnLayoutRef = useRef<HTMLDivElement>(null);
  const filesColumnRef = useRef<HTMLDivElement>(null);
  const fileStatusRight = useFilePanelStatusRight(filesColumnRef);
  const filesSurfaceRef = useRef<HTMLDivElement>(null);
  const fileRevealFrameRef = useRef(0);
  const fileRevealPathRef = useRef('');
  const pendingDirectoryReturnRevealRef = useRef<{ directoryPath: string; entryPath: string } | null>(null);
  const didInitializePathRefreshRef = useRef(false);
  const wasActiveRef = useRef(active);
  const activeRef = useRef(active);
  activeRef.current = active;
  const skipNextPathRefreshRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const currentRelativePathRef = useRef('');
  const onDirectoryChangeRef = useRef(onDirectoryChange);
  onDirectoryChangeRef.current = onDirectoryChange;
  const projectPathRef = useRef(project.path);
  projectPathRef.current = project.path;
  const projectLifecycleRef = useRef<ProjectWorkspaceLifecycleIdentity>();
  const watchReconcileStateRef = useRef({ identity: '', externalWatchRevision: -1, lastReconciledAt: 0 });
  const fileRootSubscriptionRef = useRef('');
  const directoryEntriesCacheRef = useRef(new Map<string, ProjectFileEntry[]>());
  const optimisticDirectoryEntriesCacheRef = useRef(new Map<string, ProjectFileEntry[]>());
  const directoryPrefetchesRef = useRef(new Map<string, Promise<DirectoryPreviewLoadResult>>());
  const directoryPreviewRequestTokensRef = useRef(new Map<string, symbol>());
  const shortcutPreviewStatesRef = useRef(new Map<string, Pick<ProjectFileEntry, 'shortcutTargetKind' | 'shortcutBroken'>>());
  const previewRatingCacheRef = useRef(new Map<string, number>());
  const previewRatingRequestsRef = useRef(new Map<string, ReturnType<typeof projectWorkspaceClient.getMediaRating>>());
  const boundWorkspaceCaches = () => {
    const trim = <K, V>(cache: Map<K, V>, limit: number) => {
      while (cache.size > limit) cache.delete(cache.keys().next().value as K);
    };
    trim(directoryEntriesCacheRef.current, 192);
    trim(optimisticDirectoryEntriesCacheRef.current, 96);
    trim(directoryPrefetchesRef.current, 96);
    trim(shortcutPreviewStatesRef.current, 512);
    trim(previewRatingCacheRef.current, 400);
    trim(previewRatingRequestsRef.current, 200);
  };
  useEffect(boundWorkspaceCaches);
  const selectionDragRef = useRef<{
    pointerId: number;
    pointerStartX: number;
    pointerStartY: number;
    startContentX: number;
    startContentY: number;
    lastClientX: number;
    lastClientY: number;
    initialPaths: string[];
    additive: boolean;
    started: boolean;
  } | null>(null);
  const marqueeLayoutRegistryRef = useRef(new Map<string, MarqueeRect>());
  const selectionAutoScrollFrameRef = useRef(0);
  const directoryRefreshTimerRef = useRef(0);
  const pendingDirectoryRefreshesRef = useRef(new Set<string>());
  useEffect(() => () => {
    window.clearTimeout(directoryRefreshTimerRef.current);
    directoryRefreshTimerRef.current = 0;
    pendingDirectoryRefreshesRef.current.clear();
    recursiveDirectoryRefreshSequenceRef.current.clear();
  }, [project.path]);
  const internalDragPathsRef = useRef<string[]>([]);
  const internalDropHandledRef = useRef(false);
  const nativeFileDragSessionRef = useRef<{ id: string; origin: 'file-browser' | 'version-tree'; paths: string[]; folderTabSource: boolean } | null>(null);
  const projectFileDragEndHandlerRef = useRef<(result: ProjectFileDragEndResult) => void>(() => undefined);
  const nativeFileDragOwnerIdentityRef = useRef(nativeFileDragOwnerIdentity(pageId, project.path));
  const suppressDraggedEntryClickRef = useRef<{ path: string; sessionId: string } | null>(null);
  const fileInteractionRevisionRef = useRef(0);
  const selectionResetKey = `${active}|${fileFilter}|${ratingFilter}|${filterScope}|${searchQuery}`;
  const { anchorPathRef: selectionAnchorPathRef, selectedPaths, setSelectedPaths, selectRange: selectProjectFileRange, toggle: toggleProjectFileSelection } = useProjectFileSelection(selectionResetKey);
  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;
  const entryPointerModifiersRef = useRef<{ path: string; additive: boolean; range: boolean; pointerType: 'mouse' | 'pen' | 'touch' } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const recursiveDirectoryRefreshSequenceRef = useRef(new Map<string, number>());
  const recursiveGroupOrderRef = useRef<{ identity: string; paths: string[] }>({ identity: '', paths: [] });
  const clipboardOperationSequenceRef = useRef(0);
  const ratingMutationSequenceRef = useRef(0);
  const previewRatingIdentityRef = useRef('');
  const [cutPaths, setCutPaths] = useState<string[]>([]);
  const [dragTargetPath, setDragTargetPath] = useState('');
  const [recursiveDropTargetPath, setRecursiveDropTargetPath] = useState<string | null>(null);
  const [surfaceDropActive, setSurfaceDropActive] = useState(false);
  const [operationDirectoryPath, setOperationDirectoryPath] = useState('');
  const [previewPath, setPreviewPath] = usePageState(pageId, "previewPath", '');
  const [previewHighlightPath, setPreviewHighlightPath] = usePageState(pageId, "previewHighlightPath", '');
  const [previewMediaPath, setPreviewMediaPath] = usePageState(pageId, "previewMediaPath", '');
  const [postTrimPreviewEntry, setPostTrimPreviewEntry] = useState<ProjectFileEntry>();
  useEffect(() => {
    if (!previewPath) setPreviewMediaPath('');
  }, [previewPath]);
  const [previewTechnicalMetadata, setPreviewTechnicalMetadata] = useState<PreviewTechnicalMetadata>({});
  const [previewMetadataFields, setPreviewMetadataFields] = useState<MediaMetadataField[]>([]);
  const [previewMetadataResolvedPath, setPreviewMetadataResolvedPath] = useState('');
  const [previewMetadataLoading, setPreviewMetadataLoading] = useState(false);
  const [previewMetadataError, setPreviewMetadataError] = useState('');
  const [previewEntryDetails, setPreviewEntryDetails] = useState<ProjectEntryDetails | null>(null);
  const [selectionEntryDetails, setSelectionEntryDetails] = useState<Record<string, SelectionEntryDetails>>({});
  const [selectionEntryDetailsLoading, setSelectionEntryDetailsLoading] = useState(false);
  const [viewportCurrentPath, setViewportCurrentPath] = useState('');
  const [viewportStatus, setViewportStatus] = useState<{ path: string; fileNumber: number; total: number; captureDateTime?: string } | null>(null);
  const previewPanePinnedStorageKey = `photoflow:${browserContext.kind}:preview-pane-pinned`;
  const componentPanels = useComponentFolderPanelState(pageId, browserContext.kind, componentContributions, active && activeView === 'project');
  const { panelOrder, setPanelOrder, filesPaneOpen, setFilesPaneOpen, filesPanePinned, setFilesPanePinned } = useWorkspacePanelLayout(pageId, browserContext.kind, [...WORKSPACE_PANEL_IDS, ...componentPanels.ids]);
  const metadataPanePinnedStorageKey = `photoflow:${browserContext.kind}:metadata-pane-pinned`;
  const previewPaneSuppressedStorageKey = `photoflow:${browserContext.kind}:preview-pane-auto-open-suppressed`;
  const metadataPaneSuppressedStorageKey = `photoflow:${browserContext.kind}:metadata-pane-auto-open-suppressed`;
  const [previewPanePinned, setPreviewPanePinned] = usePageState(pageId, "previewPanePinned", () => readStoredBoolean(previewPanePinnedStorageKey, true));
  const [metadataPanePinned, setMetadataPanePinned] = usePageState(pageId, "metadataPanePinned", () => readStoredBoolean(metadataPanePinnedStorageKey, true));
  const [previewPaneAutoOpenSuppressed, setPreviewPaneAutoOpenSuppressed] = usePageState(pageId, "previewPaneAutoOpenSuppressed", () => readStoredBoolean(previewPaneSuppressedStorageKey, false));
  const [metadataPaneAutoOpenSuppressed, setMetadataPaneAutoOpenSuppressed] = usePageState(pageId, "metadataPaneAutoOpenSuppressed", () => readStoredBoolean(metadataPaneSuppressedStorageKey, false));
  const [previewPaneOpen, setPreviewPaneOpen] = usePageState(pageId, "previewPaneOpen", () => readStoredBoolean(previewPanePinnedStorageKey, true));
  const fileRevealRequestIdRef = useRef(0);
  const [pendingFileReveal, setPendingFileReveal] = useState<{ path: string; requestId: number; align: 'nearest' | 'center' } | null>(null);
  const [directoryReturnHighlightPath, setDirectoryReturnHighlightPath] = useState('');
  const toggleSelected = (relativePath: string) => {
    toggleProjectFileSelection(relativePath);
  };
  const [pendingMutationSelection, setPendingMutationSelection] = useState<{ path: string; align: 'nearest' | 'center'; directoryPath: string; projectPath: string } | null>(null);
  const previousPaneLayoutRef = useRef('');
  const paneLayoutRevealPendingRef = useRef(false);
  const paneLayoutRevealPathRef = useRef('');
  const previewPanePinnedRef = useRef(previewPanePinned);
  const metadataPanePinnedRef = useRef(metadataPanePinned);
  previewPanePinnedRef.current = previewPanePinned;
  metadataPanePinnedRef.current = metadataPanePinned;
  const [metadataPaneOpen, setMetadataPaneOpen] = usePageState(pageId, "metadataPaneOpen", () => readStoredBoolean(metadataPanePinnedStorageKey, true));
  useEffect(() => {
    try { window.localStorage.setItem(previewPanePinnedStorageKey, String(previewPanePinned)); } catch { /* Ignore unavailable storage. */ }
  }, [previewPanePinned, previewPanePinnedStorageKey]);
  useEffect(() => {
    try { window.localStorage.setItem(metadataPanePinnedStorageKey, String(metadataPanePinned)); } catch { /* Ignore unavailable storage. */ }
  }, [metadataPanePinned, metadataPanePinnedStorageKey]);
  useEffect(() => {
    try { window.localStorage.setItem(previewPaneSuppressedStorageKey, String(previewPaneAutoOpenSuppressed)); } catch { /* Ignore unavailable storage. */ }
  }, [previewPaneAutoOpenSuppressed, previewPaneSuppressedStorageKey]);
  useEffect(() => {
    try { window.localStorage.setItem(metadataPaneSuppressedStorageKey, String(metadataPaneAutoOpenSuppressed)); } catch { /* Ignore unavailable storage. */ }
  }, [metadataPaneAutoOpenSuppressed, metadataPaneSuppressedStorageKey]);
  const [columnWidths, setColumnWidths] = usePageState(pageId, "columnWidths", () => ({
    ...readWorkspacePanelWidths(browserContext.kind),
    files: readStoredNumber('photoflow:files-column-width', 560),
    preview: readStoredNumber('photoflow:preview-column-width', 340),
    metadata: readStoredNumber('photoflow:metadata-column-width', 320)
  }));
  usePersistWorkspacePanelWidths(browserContext.kind, columnWidths);
  const [fileListColumnWidths, setFileListColumnWidths] = usePageState<FileListColumnWidths>(pageId, "fileListColumnWidths", () => Object.fromEntries(FILE_LIST_COLUMN_KEYS.map(key => [
    key,
    readStoredNumber(FILE_LIST_COLUMN_STORAGE_KEYS[key], DEFAULT_FILE_LIST_COLUMN_WIDTHS[key]),
  ])) as FileListColumnWidths);
  const [fileListColumnsCustomized, setFileListColumnsCustomized] = usePageState(pageId, "fileListColumnsCustomized", () => readStoredBoolean(FILE_LIST_COLUMNS_CUSTOMIZED_STORAGE_KEY, false));
  const [projectLayoutWidth, setProjectLayoutWidth] = useState(0);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [selectionCanvasSize, setSelectionCanvasSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const cancelSelectionDrag = () => {
      window.cancelAnimationFrame(selectionAutoScrollFrameRef.current);
      selectionAutoScrollFrameRef.current = 0;
      selectionDragRef.current = null;
      setSelectionBox(null);
    };
    window.addEventListener('pointerup', cancelSelectionDrag);
    window.addEventListener('pointercancel', cancelSelectionDrag);
    window.addEventListener('blur', cancelSelectionDrag);
    return () => {
      window.cancelAnimationFrame(selectionAutoScrollFrameRef.current);
      window.removeEventListener('pointerup', cancelSelectionDrag);
      window.removeEventListener('pointercancel', cancelSelectionDrag);
      window.removeEventListener('blur', cancelSelectionDrag);
    };
  }, []);
  const [inlineRenamePath, setInlineRenamePath] = usePageState(pageId, "inlineRenamePath", '');
  const [inlineRenameValue, setInlineRenameValue] = usePageState(pageId, "inlineRenameValue", '');
  const [batchRenameOpen, setBatchRenameOpen] = usePageState(pageId, "batchRenameOpen", false);
  const [batchRenameParts, setBatchRenameParts] = usePageState<BatchRenamePart[]>(pageId, "batchRenameParts", []);
  const [batchExtensionMode, setBatchExtensionMode] = usePageState<'preserve' | 'replace'>(pageId, "batchExtensionMode", 'preserve');
  const [batchExtensionValue, setBatchExtensionValue] = usePageState(pageId, "batchExtensionValue", '');
  const [draggedBatchRenamePartId, setDraggedBatchRenamePartId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [panel, setPanel] = usePageState<ProjectPanel>(pageId, "panel", initialPanel);
  const [mountedPanels, setMountedPanels] = usePageState<Set<MountedProjectPanel>>(pageId, "mountedPanels", () => new Set(initialPanel ? [initialPanel] : []));
  const [negativeSourcePaths, setNegativeSourcePaths] = usePageState<string[]>(pageId, "negativeSourcePaths", []);
  const [brollSourcePaths, setBrollSourcePaths] = usePageState<string[]>(pageId, "brollSourcePaths", []);
  const [deleteBrollSources, setDeleteBrollSources] = usePageState(pageId, "deleteBrollSources", importDefaults.deleteSourceAfterImport);
  const [deleteFileSources, setDeleteFileSources] = usePageState(pageId, "deleteFileSources", importDefaults.deleteSourceAfterImport);
  const [fileImportTarget, setFileImportTarget] = usePageState(pageId, "fileImportTarget", '');
  const [fileImportSourcePaths, setFileImportSourcePaths] = usePageState<string[]>(pageId, "fileImportSourcePaths", []);
  const [panelImportBusy, setPanelImportBusy] = useState<'broll' | 'files' | ''>('');
  const [panelImportResult, setPanelImportResult] = usePageState<{ kind: 'broll' | 'files'; count: number; sourceDeleted: boolean } | null>(pageId, "panelImportResult", null);
  const [sdImportBusy, setSdImportBusy] = useState(false);
  const [negativeImportBusy, setNegativeImportBusy] = useState(false);
  const [researchTargetPath, setResearchTargetPath] = usePageState(pageId, "researchTargetPath", '');
  const [researchTargetPaths, setResearchTargetPaths] = usePageState<string[]>(pageId, "researchTargetPaths", []);
  const [researchTargetHasTxt, setResearchTargetHasTxt] = useState(false);
  const [officeExtractEntries, setOfficeExtractEntries] = usePageState<ProjectFileEntry[]>(pageId, "officeExtractEntries", []);
  const [officeExtractBusy, setOfficeExtractBusy] = useState(false);
  const [officeExtractResult, setOfficeExtractResult] = usePageState<OfficeExtractionPresentation | null>(pageId, "officeExtractResult", null);
  const [officeExtractError, setOfficeExtractError] = usePageState(pageId, "officeExtractError", '');
  const researchInspectionSequenceRef = useRef(0);
  useEffect(() => {
    if (!panel) return;
    setMountedPanels(current => {
      if (current.has(panel)) return current;
      const next = new Set(current);
      next.add(panel);
      return next;
    });
  }, [panel]);
  const projectPanelTaskKey = useCallback((kind: MountedProjectPanel) => panelTaskSessionKey(pageId, kind), [pageId]);
  const projectPanelTask = useCallback((kind: MountedProjectPanel) => panelTasks[projectPanelTaskKey(kind)], [panelTasks, projectPanelTaskKey]);
  const projectPanelIsRunning = useCallback((kind: MountedProjectPanel) => projectPanelTask(kind)?.state === 'running' || backgroundTasks.some(task => (
    ['queued', 'running', 'pausing', 'paused', 'resuming'].includes(task.state)
    && task.metadata?.presentationOwnerPageId === pageId
    && task.metadata?.presentationPanelKind === kind
  )), [backgroundTasks, pageId, projectPanelTask]);
  useEffect(() => {
    const restorePanelTask = (event: Event) => {
      const detail = (event as CustomEvent<PanelTaskRestoreDetail>).detail;
      if (!isPanelTaskRestoreForPage(pageId, detail) || !detail.panelKind || !(detail.panelKind in PROJECT_PANEL_TITLES)) return;
      setPanel(detail.panelKind as MountedProjectPanel);
    };
    window.addEventListener('photoflow:restore-panel-task', restorePanelTask);
    return () => window.removeEventListener('photoflow:restore-panel-task', restorePanelTask);
  }, [pageId]);
  const [inspirationProjects, setInspirationProjects] = useState<WorkspaceProject[]>([]);
  const [inspirationTargetProject, setInspirationTargetProject] = usePageState<WorkspaceProject | null>(pageId, "inspirationTargetProject", null);
  const [gatherPickerPaths, setGatherPickerPaths] = usePageState<string[] | null>(pageId, "gatherPickerPaths", null);
  const [gatheringInspiration, setGatheringInspiration] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  useEffect(() => { if (!active || versionTreeOpen && versionTreeHeaderCollapsed) setShowStatusMenu(false); }, [active, versionTreeOpen, versionTreeHeaderCollapsed]);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [shellNewTypes, setShellNewTypes] = useState<ShellNewFileType[]>([]);
  const [shellNewTypesLoaded, setShellNewTypesLoaded] = useState(false);
  const [shellNewTypesLoading, setShellNewTypesLoading] = useState(false);
  const shellNewTypesRevision = useRef(0);
  const shellNewTypesLastLoadedAt = useRef(0);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showVideoToolsMenu, setShowVideoToolsMenu] = useState(false);
  const [showImageToolsMenu, setShowImageToolsMenu] = useState(false);
  const [showOfficeToolsMenu, setShowOfficeToolsMenu] = useState(false);
  const [showToolbarOverflowMenu, setShowToolbarOverflowMenu] = useState(false);
  const [progressSetup, setProgressSetup] = usePageState<ProgressSetupDraft | null>(pageId, "progressSetup", null);
  const [folderMarkSetup, setFolderMarkSetup] = usePageState<FolderMarkDraft | null>(pageId, "folderMarkSetup", null);
  const [progressImportStep, setProgressImportStep] = usePageState<'source' | 'settings'>(pageId, "progressImportStep", 'source');
  const [pendingProgressFolders, setPendingProgressFolders] = usePageState<Array<{ relativePath: string; name: string; mediaKind: 'image' | 'video' }>>(pageId, "pendingProgressFolders", []);
  const [progressImportCompletion, setProgressImportCompletion] = usePageState(pageId, "progressImportCompletion", '');
  const [progressCompare, setProgressCompare] = usePageState<ProgressCompareConfirmation | null>(pageId, "progressCompare", null);
  const [trackingConfirmationSessionId, setTrackingConfirmationSessionId] = usePageState(pageId, "trackingConfirmationSessionId", '');
  const [trackingConfirmationProgressId, setTrackingConfirmationProgressId] = usePageState(pageId, "trackingConfirmationProgressId", '');
  const { projectWorkflows, gatherToProject, watchRootDirectly, rootRelativeFileEvents, previewOnlyOnMediaClick } = browserContext.capabilities;
  const {
    progressFoldersRef, loadProgressFolders, loadProgressFoldersSnapshot, progressFoldersReady, progressFoldersLoadError, dismissTrackingTaskForSession,
    draggingChildId, setDraggingChildId, hoverParentId, setHoverParentId,
    pendingRelationChange, relationMutatingChildIds, relationHistoryRevision, canUndoRelation, canRedoRelation,
    resetProgressFolderRequests,
    cancelRelationEdit, undoVersionGraphAction, redoVersionGraphAction,
    requestSupplementalEdgeCreate, requestSupplementalEdgeDelete,
    requestSupplementalEdgeReconnect, requestProgressRelationChange,
  } = useProjectVersionRelations({
    active,
    projectWorkflows,
    workspacePath,
    project,
    progressFolders,
    setProgressFolders,
    versionGraphEdges,
    setVersionGraphEdges,
    onNotice,
    appDialog,
    backgroundTasks,
    dismissBackgroundTask,
    trackingConfirmationProgressId,
    setTrackingConfirmationProgressId,
    setTrackingConfirmationSessionId,
    activeRef,
    projectPathRef,
  });
  const versionTreeSlowLoadVisible = useDelayedVisibility(versionTreeOpen && !progressFoldersReady && !progressFoldersLoadError, 300);
  const [progressCompareFilter, setProgressCompareFilter] = usePageState<ProgressCompareFilter>(pageId, "progressCompareFilter", 'recognized');
  const [activeProgressCompareItemKey, setActiveProgressCompareItemKey] = usePageState(pageId, "activeProgressCompareItemKey", '');
  const [workspaceActivityMessage, setWorkspaceActivityMessage] = useState('');
  const workspaceActivityRef = useRef<ToastActivityHandle | null>(null);
  useEffect(() => {
    if (!workspaceActivityMessage) { workspaceActivityRef.current?.dismiss(); workspaceActivityRef.current = null; return; }
    if (workspaceActivityRef.current) workspaceActivityRef.current.update(workspaceActivityMessage);
    else workspaceActivityRef.current = toast.activity(workspaceActivityMessage, { dedupeKey: `workspace-activity:${pageId}` });
  }, [pageId, toast, workspaceActivityMessage]);
  useEffect(() => () => workspaceActivityRef.current?.dismiss(), []);
  const [progressSubmitting, setProgressSubmitting] = useState(false);
  const [progressImportStatus, setProgressImportStatus] = useState<ProjectFileOperationProgress | null>(null);
  const progressSubmittingRef = useRef(false);
  const progressImportOperationIdRef = useRef('');
  // The folder-mark modal reports a busy mirror into the task center while its
  // operation runs, but that modal can be gone before the operation settles
  // (minimized to the background, or closed by the success path) and the drawer
  // never clears a task that is still running. The operation therefore ends its
  // own mirror here instead of leaving it running forever.
  const folderMarkBusyRef = useRef(false);
  useEffect(() => {
    if (folderMarkSetup && progressSubmitting) { folderMarkBusyRef.current = true; return; }
    if (!folderMarkBusyRef.current || progressSubmitting) return;
    folderMarkBusyRef.current = false;
    withdrawPanelTask(panelTaskSessionKey(pageId, 'folder-mark'));
  }, [folderMarkSetup, pageId, progressSubmitting, withdrawPanelTask]);
  const progressMutationStatus = useMemo(() => versionTreeTaskPanelProgress(
    backgroundTasks,
    project.name,
    progressSetup?.mode === 'mark' ? progressSetup.existingProgressId || '' : '',
  ), [backgroundTasks, progressSetup?.existingProgressId, progressSetup?.mode, project.name]);
  const [progressRepair, setProgressRepair] = usePageState<{ progressFolder: ProgressFolder; batchId: string; operations: VersionBatchFileOperation[] } | null>(pageId, "progressRepair", null);
  const [progressRepairBusy, setProgressRepairBusy] = useState(false);
  const closeProgressSetup = useCallback(() => {
    setProgressImportCompletion('');
    setProgressImportStep('source');
    setProgressSetup(null);
  }, []);
  useEscapeLayer(active && Boolean(progressCompare), () => { void closeProgressCompare(); }, !progressSubmitting, true);
  useEscapeLayer(active && Boolean(progressRepair), () => setProgressRepair(null), !progressRepairBusy, true);
  useEscapeLayer(active && Boolean(pendingProgressFolders.length) && !progressSetup && !folderMarkSetup, () => setPendingProgressFolders([]), true, true);
  useEscapeLayer(active && Boolean(draggingChildId || pendingRelationChange), cancelRelationEdit, true, true);
  useEscapeLayer(active && batchRenameOpen, () => setBatchRenameOpen(false), true, true);
  useEscapeLayer(active && confirmDelete, () => setConfirmDelete(false), true, true);
  useEscapeLayer(Boolean(gatherPickerPaths), () => setGatherPickerPaths(null), !gatheringInspiration, true);
  const [fileMenu, setFileMenu] = useState<{ entry: ProjectFileEntry; x: number; y: number } | null>(null);
  const fileMenuSelectionSnapshotRef = useRef<string[]>([]);
  const fileMenuSelectionAnchorSnapshotRef = useRef('');
  const fileMenuSelectionWasImplicitRef = useRef(false);
  const [surfaceMenu, setSurfaceMenu] = useState<{ x: number; y: number; targetRelativePath: string; targetLabel: string; kind: 'files' | 'version-tree-layout' } | null>(null);
  const versionTreeCanvasControllerRef = useRef<VersionTreeCanvasController | null>(null);
  const setVersionTreeCanvasController = useCallback((controller: VersionTreeCanvasController | null) => {
    versionTreeCanvasControllerRef.current = controller;
  }, []);
  const [clipboardHasFiles, setClipboardHasFiles] = useState(false);
  const [clipboardPending, setClipboardPending] = useState(false);
  const clipboardActionPending = {
    cut: pendingFileOperations.some(operation => operation.kind === 'cut'),
    copy: pendingFileOperations.some(operation => operation.kind === 'copy'),
    paste: pendingFileOperations.some(operation => operation.kind === 'paste'),
  };
  const renderClipboardActionIcon = (operation: 'cut' | 'copy' | 'paste', size: number) => {
    if (clipboardActionPending[operation]) return <Loader2 size={size} className="animate-spin" aria-hidden="true"/>;
    const Icon = operation === 'cut' ? Cut : operation === 'copy' ? Copy : ClipboardPaste;
    return <Icon size={size} aria-hidden="true"/>;
  };
  const [photoshopAvailable, setPhotoshopAvailable] = useState(false);
  const [conversionTargets, setConversionTargets] = usePageState<string[]>(pageId, "conversionTargets", []);
  const [conversionCollecting, setConversionCollecting] = useState(false);
  const conversionInspectionSequenceRef = useRef(0);
  const [screenshotMainImageTargets, setScreenshotMainImageTargets] = usePageState<string[]>(pageId, "screenshotMainImageTargets", []);
  const [screenshotMainImageMode, setScreenshotMainImageMode] = usePageState<'extract' | 'crop'>(pageId, "screenshotMainImageMode", 'extract');
  const [versionEntry, setVersionEntry] = usePageState<ProjectFileEntry | null>(pageId, "versionEntry", null);
  const [versionProgressId, setVersionProgressId] = usePageState(pageId, "versionProgressId", '');
  const versionProgressLocationRef = useRef<(ProgressFolderEntryLocation & { progressId: string }) | null>(null);
  const adoptVersionTreeFolderRef = useRef<(entry: Pick<ProjectFileEntry, 'name' | 'relativePath'>, mode: 'original' | 'broll', mediaKind: 'image' | 'video' | 'mixed') => Promise<boolean>>(async () => false);
  const [, setFinalVersionSummary] = useState({ count: 0, availableCount: 0, missingCount: 0 });
  const [finalExporting, setFinalExporting] = useState(false);
  const [finalExportParentId, setFinalExportParentId] = usePageState(pageId, "finalExportParentId", '');
  const [finalViewOpen, setFinalViewOpen] = usePageState(pageId, "finalViewOpen", false);
  const currentFolderRecursiveSearchActive = Boolean(searchQuery.trim()) && filterScope === 'current-folder' && !versionTreeOpen && !finalViewOpen;
  const {
    searchEntries, searchEntriesRef, setSearchEntries, searchLoading, searchError,
    recentHasMore, recentLoadingMore, recentLoadError, setRecentRefreshToken,
    scopeEntries, setScopeEntries, scopeLoading, scopeLoadingMore, scopeError, scopeHasMore, setScopeRefreshToken,
    projectRootFilterActive, changeFilterScope,
  } = useProjectFileQueries({
    active,
    workspacePath,
    project,
    currentRelativePath,
    recursiveFlatOpen,
    currentFolderRecursiveSearchActive,
    versionTreeOpen,
    finalViewOpen,
    filterScope,
    searchQuery,
    fileFilter,
    filesColumnRef,
    selectionAnchorPathRef,
    setSelectedPaths,
    setFilterScope,
  });
  const [, setFinalViewLoading] = useState(false);
  const [finalViewEntries, setFinalViewEntries] = useState<ProjectFileEntry[]>([]);
  const [previewRating, setPreviewRating] = useState(0);
  const [previewRatingLoading, setPreviewRatingLoading] = useState(false);
  const [previewRatingBusy, setPreviewRatingBusy] = useState(false);
  const [drives, setDrives] = useState<string[]>([]);
  usePageTransferParticipant('selection', { read: () => selectedPaths, write: value => setSelectedPaths(value as string[]) });
  usePageTransferParticipant('scrollTop', { read: () => filesColumnRef.current?.scrollTop || 0, write: value => { requestAnimationFrame(() => { if (filesColumnRef.current) filesColumnRef.current.scrollTop = Number(value) || 0; }); } });
  usePageTransferParticipant('operationGuard', { read: () => null, prepare: () => { if (panelImportBusy || sdImportBusy || negativeImportBusy || officeExtractBusy || progressSubmitting || progressRepairBusy || finalExporting || gatheringInspiration || pendingFileOperations.length) throw new Error('当前目录正在完成文件操作，请等待完成后再移动标签页'); } });
  useRestorePageTransferState(pageId, foregroundDirectoryReady);
  const requestFileReveal = useCallback((path: string, align: 'nearest' | 'center' = 'nearest') => {
    fileRevealRequestIdRef.current += 1;
    setPendingFileReveal({ path, requestId: fileRevealRequestIdRef.current, align });
  }, []);
  const selectAndRevealFileEntry = (relativePath: string, align: 'nearest' | 'center' = 'nearest') => {
    const normalizedPath = normalizeProjectRelativePath(relativePath);
    if (!normalizedPath) return;
    setFolderAlphabetFilter('');
    if (mutatedEntryFiltersNeedReset({ searchQuery, fileFilter, ratingFilter, filterScope })) {
      setPendingMutationSelection({
        path: normalizedPath,
        align,
        directoryPath: normalizeProjectRelativePath(currentRelativePathRef.current),
        projectPath: projectPathRef.current,
      });
      setSearchQuery('');
      setFileFilter('all');
      setRatingFilter('all');
      setFilterScope('current-folder');
      return;
    }
    setPendingMutationSelection(null);
    selectionAnchorPathRef.current = normalizedPath;
    setSelectedPaths([normalizedPath]);
    requestFileReveal(normalizedPath, align);
  };
  useEffect(() => {
    if (!pendingMutationSelection) return;
    if (!mutatedEntryCanBeRevealed({
      requestedProjectPath: pendingMutationSelection.projectPath,
      currentProjectPath: projectPathRef.current,
      mutationDirectoryPath: pendingMutationSelection.directoryPath,
      currentDirectoryPath: currentRelativePathRef.current,
      browseMode,
    })) {
      setPendingMutationSelection(null);
      return;
    }
    if (mutatedEntryFiltersNeedReset({ searchQuery, fileFilter, ratingFilter, filterScope })) return;
    setPendingMutationSelection(null);
    selectionAnchorPathRef.current = pendingMutationSelection.path;
    setSelectedPaths([pendingMutationSelection.path]);
    requestFileReveal(pendingMutationSelection.path, pendingMutationSelection.align);
  }, [browseMode, currentRelativePath, fileFilter, filterScope, pendingMutationSelection, project.path, ratingFilter, requestFileReveal, searchQuery]);
  useEffect(() => {
    void projectWorkspaceClient.getPhotoshopStatus().then(result => setPhotoshopAvailable(result.available));
  }, []);
  useEffect(() => projectWorkspaceClient.onProjectFileOperationProgress(progress => {
    if (progress.operation !== 'import-progress') return;
    if (progress.projectName && progress.projectName !== project.name) return;
    setProgressImportStatus(current => ({
      ...progress,
      progress: progress.phase === 'failed' || progress.phase === 'cancelled'
        ? progress.progress
        : Math.max(current?.operationId === progress.operationId ? current.progress : 0, progress.progress),
    }));
    if (progress.phase === 'complete' || progress.phase === 'cancelled' || progress.phase === 'failed') {
      if (progressImportOperationIdRef.current === progress.operationId) progressImportOperationIdRef.current = '';
      return;
    }
    progressImportOperationIdRef.current = progress.operationId;
  }), [project.name]);
  const inspirationMode = browserContext.kind === 'inspiration';
  const componentContentKind: ComponentPageOpenScope['contentKind'] = inspirationMode ? 'inspiration' : 'project';
  const officeImageExtractorAvailable = true;
  const folderBrowseModeStorageKey = `photoflow:folder-browse-modes:${browserContext.kind}:${workspacePath}|${project.name}`;
  const folderGridIconSizeStorageKey = `photoflow:folder-grid-icon-sizes:${browserContext.kind}:${workspacePath}|${project.name}`;
  const readFolderBrowseModes = (): Record<string, ProjectBrowseMode> => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(folderBrowseModeStorageKey) || '{}') as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ProjectBrowseMode] => isProjectBrowseMode(entry[1])));
    } catch {
      return {};
    }
  };
  const storedFolderBrowseMode = (relativePath: string) => readFolderBrowseModes()[normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN')];
  const rememberFolderBrowseMode = (relativePath: string, mode: ProjectBrowseMode) => {
    const normalizedPath = normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN');
    try {
      window.localStorage.setItem(folderBrowseModeStorageKey, JSON.stringify({ ...readFolderBrowseModes(), [normalizedPath]: mode }));
    } catch { /* storage unavailable */ }
  };
  const readFolderGridIconSizes = (): Record<string, number> => {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(folderGridIconSizeStorageKey) || '{}') as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).flatMap(([path, value]) => Number.isFinite(Number(value))
        ? [[path, normalizeFolderGridIconSize(value)] as [string, number]]
        : []));
    } catch {
      return {};
    }
  };
  const gridIconSizeForFolder = (relativePath: string) => readFolderGridIconSizes()[normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN')] ?? DEFAULT_FOLDER_GRID_ICON_SIZE;
  const rememberFolderGridIconSize = (relativePath: string, size: number) => {
    const normalizedPath = normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN');
    const normalizedSize = normalizeFolderGridIconSize(size);
    try {
      window.sessionStorage.setItem(folderGridIconSizeStorageKey, JSON.stringify({ ...readFolderGridIconSizes(), [normalizedPath]: normalizedSize }));
    } catch { /* storage unavailable */ }
    return normalizedSize;
  };
  const selectFolderGridIconSize = (size: number) => setGridIconSize(rememberFolderGridIconSize(currentRelativePath, size));
  const progressFolderParentPath = (folder: ProgressFolder) => {
    const normalizedRoot = project.path.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedFolder = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '');
    const relativePath = normalizedFolder.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)
      ? normalizedFolder.slice(normalizedRoot.length + 1)
      : normalizedFolder.split('/').pop() || '';
    return normalizeProjectRelativePath(relativePath).split('/').slice(0, -1).join('/').toLocaleLowerCase('zh-CN');
  };
  const progressFolderRelativePath = (folder: ProgressFolder) => normalizeProjectRelativePath(
    projectRelativePath(folder.folderPath),
  );
  const hasVersionTreeFor = (foldersToCheck = progressFolders, relativePath = currentRelativePath) => {
    const scopePath = normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN');
    return projectWorkflows && foldersToCheck.some(folder => !folder.folderMissing && progressFolderParentPath(folder) === scopePath);
  };
  const versionTreeModeAvailableFor = (foldersToCheck = progressFolders, relativePath = currentRelativePath) => {
    const scopePath = normalizeProjectRelativePath(relativePath);
    return versionTreeEnabled && projectWorkflows && (!scopePath || hasVersionTreeFor(foldersToCheck, scopePath));
  };
  const browseModeForFolder = (relativePath: string, foldersToCheck = progressFolders): ProjectBrowseMode => {
    const normalizedPath = normalizeProjectRelativePath(relativePath);
    const remembered = storedFolderBrowseMode(normalizedPath);
    if (remembered === 'version-tree' && !versionTreeModeAvailableFor(foldersToCheck, normalizedPath)) return 'grid';
    if (remembered) return remembered;
    return versionTreeEnabled && hasVersionTreeFor(foldersToCheck, normalizedPath) ? 'version-tree' : 'grid';
  };
  const selectFolderBrowseMode = (mode: ProjectBrowseMode) => {
    if (mode === 'version-tree' && !versionTreeModeAvailableFor()) return;
    rememberFolderBrowseMode(currentRelativePath, mode);
    setBrowseMode(mode);
  };
  const projectVersionTreeAvailable = versionTreeModeAvailableFor();
  useEffect(() => {
    if (versionTreeEnabled || browseMode !== 'version-tree') return;
    setBrowseMode('grid');
  }, [browseMode, versionTreeEnabled]);
  useEffect(() => {
    if (!gatherToProject || !inspirationTargetWorkspacePath?.trim()) {
      setInspirationProjects([]);
      setInspirationTargetProject(null);
      return;
    }
    let disposed = false;
    const loadProjects = async () => {
      const result = await projectWorkspaceClient.getWorkspaceProjects(inspirationTargetWorkspacePath);
      if (disposed || !result.success) return;
      const projects = result.statuses.flatMap(group => group.projects).filter(candidate => candidate.availability !== 'missing');
      setInspirationProjects(projects);
      let preferredPath = '';
      try { preferredPath = window.localStorage.getItem('photoflow:inspiration-target-project') || ''; } catch { /* storage unavailable */ }
      setInspirationTargetProject(current => projects.find(candidate => candidate.path === current?.path)
        || projects.find(candidate => candidate.path === preferredPath)
        || null);
    };
    void loadProjects();
    const changed = () => void loadProjects();
    window.addEventListener('workspace-projects-changed', changed);
    return () => { disposed = true; window.removeEventListener('workspace-projects-changed', changed); };
  }, [gatherToProject, inspirationTargetWorkspacePath]);
  useEffect(() => {
    const items = progressCompare ? buildProgressCompareListItems(progressCompare, progressCompareFilter) : [];
    if (!items.length) {
      setActiveProgressCompareItemKey('');
      return;
    }
    setActiveProgressCompareItemKey(current => items.some(item => item.key === current) ? current : items[0].key);
  }, [progressCompare, progressCompareFilter]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem('photoflow:files-column-width', String(Math.round(columnWidths.files)));
        window.localStorage.setItem('photoflow:preview-column-width', String(Math.round(columnWidths.preview)));
        window.localStorage.setItem('photoflow:metadata-column-width', String(Math.round(columnWidths.metadata)));
      } catch { /* unavailable storage */ }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [columnWidths]);
  useEffect(() => {
    if (!fileListColumnsCustomized) return;
    const timer = window.setTimeout(() => {
      try {
        for (const key of FILE_LIST_COLUMN_KEYS) window.localStorage.setItem(FILE_LIST_COLUMN_STORAGE_KEYS[key], String(Math.round(fileListColumnWidths[key])));
        window.localStorage.setItem(FILE_LIST_COLUMNS_CUSTOMIZED_STORAGE_KEY, 'true');
      } catch { /* Ignore unavailable storage. */ }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [fileListColumnWidths, fileListColumnsCustomized]);
  useEffect(() => {
    const layout = projectColumnLayoutRef.current;
    if (!layout) return;
    const measure = () => setProjectLayoutWidth(layout.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active || !foregroundDirectoryReady) return;
    let intervalId = 0;
    const fetchDrives = () => projectWorkspaceClient?.getDrives?.().then(nextDrives => setDrives(current =>
      current.length === nextDrives.length && current.every((drive, index) => drive === nextDrives[index]) ? current : nextDrives
    )).catch(() => undefined);
    const cancelDeferredStart = scheduleAfterProjectPaint(PROJECT_BACKGROUND_LOAD_DELAYS_MS.drives, () => {
      void fetchDrives();
      intervalId = window.setInterval(fetchDrives, 3000);
    });
    return () => {
      cancelDeferredStart();
      window.clearInterval(intervalId);
    };
  }, [active, foregroundDirectoryReady]);
  useEffect(() => {
    if (!active || !foregroundDirectoryReady) return;
    const refreshClipboardStatus = () => projectWorkspaceClient.getProjectFileClipboardStatus()
      .then(result => setClipboardHasFiles(result.success && result.hasFiles))
      .catch(() => undefined);
    const cancelDeferredStart = scheduleAfterProjectPaint(PROJECT_BACKGROUND_LOAD_DELAYS_MS.clipboard, () => {
      void refreshClipboardStatus();
      window.addEventListener('focus', refreshClipboardStatus);
    });
    return () => {
      cancelDeferredStart();
      window.removeEventListener('focus', refreshClipboardStatus);
    };
  }, [active, foregroundDirectoryReady]);
  useEffect(() => {
    const openTrackingConfirmation = (event: Event) => {
      if (!active) return;
      const detail = (event as CustomEvent<{ sessionId?: string; progressId?: string }>).detail;
      const sessionId = String(detail?.sessionId || '');
      const progressId = String(detail?.progressId || '');
      if (!sessionId || !progressId || !progressFolders.some(folder => folder.id === progressId)) return;
      safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressId}`, sessionId);
      setTrackingConfirmationProgressId(progressId);
      setTrackingConfirmationSessionId(sessionId);
    };
    window.addEventListener('photoflow:open-tracking-confirmation', openTrackingConfirmation);
    return () => window.removeEventListener('photoflow:open-tracking-confirmation', openTrackingConfirmation);
  }, [active, progressFolders, workspacePath, project.name]);
  useEffect(() => {
    if (!active) return;
    return projectWorkspaceClient.onBackgroundTaskChanged(delta => {
      for (const task of delta.upserts) {
      if (task.type !== 'version-tracking') continue;
      const progressId = typeof task.metadata.progressId === 'string' ? task.metadata.progressId : '';
      const progress = progressFoldersRef.current.find(folder => folder.id === progressId);
      if (!progressId || !progress?.trackingEnabled) {
        if (!task.retryPending && (task.state === 'completed' || task.state === 'cancelled' || task.state === 'failed')) void dismissBackgroundTask(task.id);
        continue;
      }
      if (task.state !== 'completed') continue;
      const sessionId = typeof task.metadata.sessionId === 'string' ? task.metadata.sessionId : '';
      if (!sessionId) continue;
      safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressId}`, sessionId);
      setTrackingConfirmationProgressId(progressId);
      setTrackingConfirmationSessionId(sessionId);
      }
    });
  }, [active, dismissBackgroundTask, project.name, workspacePath]);
  const loadFinalVersionSummary = useCallback(async () => {
    const result = await projectWorkspaceClient.getFinalVersionSummary(workspacePath, project.status, project.name);
    if (result.success) {
      const summary = { count: result.count, availableCount: result.availableCount, missingCount: result.missingCount };
      setFinalVersionSummary(summary);
      return summary;
    }
    setFinalVersionSummary({ count: 0, availableCount: 0, missingCount: 0 });
    return { count: 0, availableCount: 0, missingCount: 0 };
  }, [workspacePath, project.status, project.name]);
  const loadFinalViewEntries = useCallback(async (showMissingNotice = false) => {
    setFinalViewLoading(true);
    try {
      const result = await projectWorkspaceClient.browseFinalVersions(workspacePath, project.status, project.name);
      if (!result.success) {
        onNotice(`读取喜爱图片失败：${result.error || '未知错误'}`);
        return null;
      }
      setFinalViewEntries(result.entries);
      if (showMissingNotice && result.missingCount) onNotice(`已显示 ${result.availableCount} 张喜爱图片；另有 ${result.missingCount} 张文件已被删除、移动或不在项目中。`, 7000);
      return result;
    } finally {
      setFinalViewLoading(false);
    }
  }, [workspacePath, project.status, project.name, onNotice]);
  const closeFinalVersionView = () => {
    setFinalViewOpen(false);
    setSelectedPaths([]);
    setPreviewPath('');
    setPreviewHighlightPath('');
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setSearchOpen(false);
    setSearchQuery('');
  };
  const reconcileDirectoryUiState = useCallback((directory: string, entries: ProjectFileEntry[]) => {
    const reconcile = (paths: string[]) => reconcileDirectoryPaths(paths, directory, entries, pendingFileOperationsRef.current);
    setSelectedPaths(reconcile);
    setCutPaths(reconcile);
    setPreviewPath(current => current && !reconcile([current]).length ? '' : current);
    setPreviewMediaPath(current => current && !reconcile([current]).length ? '' : current);
    setPreviewHighlightPath(current => current && !reconcile([current]).length ? '' : current);
    selectionAnchorPathRef.current = reconcile([selectionAnchorPathRef.current])[0] || '';
  }, [setSelectedPaths, setPreviewPath, setPreviewMediaPath, setPreviewHighlightPath]);
  const refresh = async (relativePath?: string, options: { includeProjectContents?: boolean } = {}): Promise<boolean> => {
    const safeRelativePath = typeof relativePath === 'string' ? relativePath : currentRelativePathRef.current;
    const requestedPath = safeRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const requestedProjectPath = project.path;
    // Callers that mutate version metadata often invalidate the root while the
    // user is browsing a child folder. Such a refresh must not take ownership
    // of the visible directory's loading state or invalidate its active read.
    if (!isForegroundDirectoryRefresh(requestedPath, currentRelativePathRef.current, requestedProjectPath, projectPathRef.current)) return false;
    const refreshSequence = ++refreshSequenceRef.current;
    const cachedEntries = directoryEntriesCacheRef.current.get(requestedPath);
    const renderedDirectory = renderedDirectoryRef.current;
    const retainedEntries = cachedEntries ?? (renderedDirectory.ready && renderedDirectory.path === requestedPath ? fileEntriesRef.current : undefined);
    if (cachedEntries) {
      setFileEntries(cachedEntries);
      if (activeRef.current) setForegroundDirectoryReady(true);
    }
    setDirectoryLoading(retainedEntries === undefined);
    const contentsPromise = options.includeProjectContents === false ? null : projectWorkspaceClient.getProjectContents(workspacePath, project.status, project.name).then(
      result => ({ result }),
      error => ({ error }),
    );
    let browseResult: Awaited<ReturnType<typeof projectWorkspaceClient.browseProjectFiles>>;
    try {
      browseResult = await projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, requestedPath, mediaCacheConfig);
    } catch (error) {
      if (refreshSequence !== refreshSequenceRef.current
        || !isForegroundDirectoryRefresh(requestedPath, currentRelativePathRef.current, requestedProjectPath, projectPathRef.current)) return false;
      setDirectoryLoading(false);
      if (activeRef.current) setForegroundDirectoryReady(true);
      renderedDirectoryRef.current = { path: requestedPath, ready: true };
      if (retainedEntries === undefined) setFileEntries([]);
      onNotice(`${retainedEntries === undefined ? '读取目录失败' : '目录后台刷新失败，继续显示已有内容'}：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (refreshSequence !== refreshSequenceRef.current
      || !isForegroundDirectoryRefresh(requestedPath, currentRelativePathRef.current, requestedProjectPath, projectPathRef.current)) return false;
    setDirectoryLoading(false);
    if (activeRef.current) setForegroundDirectoryReady(true);
    renderedDirectoryRef.current = { path: requestedPath, ready: true };
    if (browseResult.success) {
      const entries = mergeRefreshedEntryMetadata(browseResult.entries, retainedEntries || []);
      directoryEntriesCacheRef.current.set(requestedPath, entries);
      setFileEntries(entries);
      reconcileDirectoryUiState(requestedPath, entries);
    } else {
      // Never leave entries from the previous directory under a new breadcrumb.
      if (retainedEntries === undefined || browseResult.missingDirectory) setFileEntries([]);
      if (browseResult.missingDirectory && !requestedPath) {
        onNotice(inspirationMode ? '灵感库文件夹已被移动或删除，请在设置中重新选择。' : `项目“${project.name}”已在外部删除，已关闭项目标签`);
        if (projectWorkflows) onDeleted();
        return false;
      }
      if (browseResult.missingDirectory && requestedPath) {
        const parentPath = requestedPath.split('/').slice(0, -1).join('/');
        setDirectoryHistory(current => ({
          back: current.back.filter(path => path !== requestedPath && !path.startsWith(`${requestedPath}/`)),
          forward: current.forward.filter(path => path !== requestedPath && !path.startsWith(`${requestedPath}/`)),
        }));
        onNotice(`文件夹“${requestedPath.split('/').pop()}”已在外部被删除，已返回上一级目录`);
        showDirectory(parentPath);
        return false;
      }
      onNotice(`${retainedEntries === undefined ? '读取目录失败' : '目录后台刷新失败，继续显示已有内容'}：${browseResult.error || '无法读取文件'}`);
    }
    if (!contentsPromise) return browseResult.success;
    const contentsOutcome = await contentsPromise;
    if (refreshSequence !== refreshSequenceRef.current
      || !isForegroundDirectoryRefresh(requestedPath, currentRelativePathRef.current, requestedProjectPath, projectPathRef.current)) return false;
    if ('error' in contentsOutcome) {
      onNotice(`读取${browserContext.title}失败：${contentsOutcome.error instanceof Error ? contentsOutcome.error.message : String(contentsOutcome.error)}`);
      return false;
    }
    const { result } = contentsOutcome;
    if (result.success) setFolders(current => current.length === result.folders.length
      && current.every((folder, index) => folder.path === result.folders[index]?.path
        && folder.name === result.folders[index]?.name
        && folder.updatedAt === result.folders[index]?.updatedAt)
      ? current : result.folders);
    else onNotice(`${inspirationMode ? '读取灵感库' : '读取项目'}失败：${result.error || '无法读取文件夹'}`);
    return browseResult.success;
  };
  const refreshRecursiveDirectory = useCallback(async (relativeDirectoryPath: string) => {
    if (!recursiveFlatOpen && !currentFolderRecursiveSearchActive) return;
    if (searchQuery.trim()) {
      setRecentRefreshToken(current => current + 1);
      return;
    }
    const directoryPath = normalizeProjectRelativePath(relativeDirectoryPath);
    const currentScope = normalizeProjectRelativePath(currentRelativePathRef.current);
    if (currentScope && directoryPath !== currentScope && !directoryPath.startsWith(`${currentScope}/`)) return;
    const sequence = (recursiveDirectoryRefreshSequenceRef.current.get(directoryPath) || 0) + 1;
    recursiveDirectoryRefreshSequenceRef.current.set(directoryPath, sequence);
    const requestedProjectPath = project.path;
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.browseProjectFiles>>;
    try {
      result = await projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, directoryPath, mediaCacheConfig);
    } catch {
      if (recursiveDirectoryRefreshSequenceRef.current.get(directoryPath) === sequence) recursiveDirectoryRefreshSequenceRef.current.delete(directoryPath);
      return;
    }
    if (recursiveDirectoryRefreshSequenceRef.current.get(directoryPath) !== sequence || requestedProjectPath !== projectPathRef.current) return;
    if (!result.success) {
      if (result.missingDirectory && directoryPath) {
        setSearchEntries(current => current.filter(entry => {
          if (entry.viaShortcut) return true;
          const entryPath = normalizeProjectRelativePath(entry.relativePath);
          return projectRelativeParentPath(entryPath) !== directoryPath && !entryPath.startsWith(`${directoryPath}/`);
        }));
        return;
      }
      setRecentRefreshToken(current => current + 1);
      return;
    }
    const nextDirectoryEntries = result.entries.filter(entry => entry.kind !== 'folder');
    reconcileDirectoryUiState(directoryPath, result.entries);
    setSearchEntries(current => mergeRefreshedRecursiveDirectoryEntries(current, nextDirectoryEntries, directoryPath));
    directoryEntriesCacheRef.current.set(directoryPath, result.entries);
  }, [currentFolderRecursiveSearchActive, mediaCacheConfig, project.name, project.path, project.status, recursiveFlatOpen, searchQuery, workspacePath, reconcileDirectoryUiState]);
  const upsertOptimisticDirectoryEntry = (directoryPath: string, entry: ProjectFileEntry, previousRelativePath = '') => {
    const normalizedDirectory = normalizeProjectRelativePath(directoryPath);
    const currentDirectory = normalizeProjectRelativePath(currentRelativePathRef.current);
    const cachedEntries = directoryEntriesCacheRef.current.get(normalizedDirectory);
    if (!cachedEntries && normalizedDirectory !== currentDirectory) return;
    const sourceEntries = cachedEntries ?? fileEntriesRef.current;
    const nextEntries = [
      ...sourceEntries.filter(candidate => candidate.relativePath !== previousRelativePath && candidate.relativePath !== entry.relativePath),
      entry,
    ];
    directoryEntriesCacheRef.current.set(normalizedDirectory, nextEntries);
    if (normalizedDirectory === currentDirectory) setFileEntries(nextEntries);
  };
  const removeOptimisticDirectoryEntry = (directoryPath: string, relativePath: string) => {
    const normalizedDirectory = normalizeProjectRelativePath(directoryPath);
    const currentDirectory = normalizeProjectRelativePath(currentRelativePathRef.current);
    const cachedEntries = directoryEntriesCacheRef.current.get(normalizedDirectory);
    const sourceEntries = cachedEntries ?? (normalizedDirectory === currentDirectory ? fileEntriesRef.current : null);
    if (!sourceEntries) return;
    const nextEntries = sourceEntries.filter(candidate => candidate.relativePath !== relativePath);
    directoryEntriesCacheRef.current.set(normalizedDirectory, nextEntries);
    if (normalizedDirectory === currentDirectory) setFileEntries(nextEntries);
  };
  const settleDirectoryPreviewRenames = (entries: PendingProjectFileEntry[], committed: boolean) => {
    const settled = settlePendingDirectoryPreviewRenameCaches(
      directoryEntriesCacheRef.current,
      optimisticDirectoryEntriesCacheRef.current,
      entries,
      committed,
    );
    if (!settled) return;
    for (const root of settled.invalidatedRequestRoots) {
      const requestKeys = new Set([...directoryPreviewRequestTokensRef.current.keys(), ...directoryPrefetchesRef.current.keys()]);
      for (const key of requestKeys) {
        if (!directoryPreviewCacheKeyWithin(key, root)) continue;
        directoryPreviewRequestTokensRef.current.delete(key);
        directoryPrefetchesRef.current.delete(key);
      }
    }
    if (!committed) return;
    const shortcutSnapshot = new Map(shortcutPreviewStatesRef.current);
    const shortcutUpdates = new Map<string, Pick<ProjectFileEntry, 'shortcutTargetKind' | 'shortcutBroken'>>();
    for (const [sourceStateKey, sourceState] of shortcutSnapshot) {
      for (const { sourceKey, targetKey } of settled.renames) {
        const targetStateKey = remapDirectoryPreviewCacheKey(sourceStateKey, sourceKey, targetKey);
        if (targetStateKey) shortcutUpdates.set(targetStateKey, sourceState);
      }
    }
    for (const key of [...shortcutPreviewStatesRef.current.keys()]) {
      if (settled.renames.some(({ sourceKey, targetKey }) => directoryPreviewCacheKeyWithin(key, sourceKey) || directoryPreviewCacheKeyWithin(key, targetKey))) {
        shortcutPreviewStatesRef.current.delete(key);
      }
    }
    for (const [key, state] of shortcutUpdates) shortcutPreviewStatesRef.current.set(key, state);
  };
  const scheduleDirectoryRefresh = (directoryPaths: string[] = [currentRelativePathRef.current]) => {
    for (const directoryPath of directoryPaths) {
      const normalized = normalizeProjectRelativePath(directoryPath);
      pendingDirectoryRefreshesRef.current.add(normalized);
      directoryEntriesCacheRef.current.delete(normalized);
    }
    window.clearTimeout(directoryRefreshTimerRef.current);
    directoryRefreshTimerRef.current = window.setTimeout(() => {
      directoryRefreshTimerRef.current = 0;
      const directories = [...pendingDirectoryRefreshesRef.current];
      pendingDirectoryRefreshesRef.current.clear();
      if (projectRootScopeSelected) setScopeRefreshToken(current => current + 1);
      else if (recursiveFlatOpen || currentFolderRecursiveSearchActive) {
        for (const directory of directories) void refreshRecursiveDirectory(directory);
      } else {
        const currentPath = normalizeProjectRelativePath(currentRelativePathRef.current);
        const affectsCurrent = directories.some(directory => directory === currentPath
          || (!directory && !currentPath)
          || Boolean(directory && currentPath.startsWith(`${directory}/`)));
        if (affectsCurrent) void refresh(currentPath, { includeProjectContents: directories.some(directory => !directory) });
      }
    }, 180);
  };
  const startPendingFileOperation = (operation: Omit<PendingFileOperation, 'id'>) => {
    if (pendingPathConflicts(pendingFileOperationsRef.current, operation.lockedPaths)) {
      onNotice('所选文件或目标位置正在处理中，请等待当前操作完成');
      return null;
    }
    const pending = { ...operation, projectPath: projectPathRef.current, id: `file-operation-${Date.now()}-${++pendingFileOperationSequenceRef.current}` };
    const next = addPendingFileOperation(pendingFileOperationsRef.current, pending);
    if (next === pendingFileOperationsRef.current) return null;
    pendingFileOperationsRef.current = next;
    setPendingFileOperations(next);
    return pending;
  };
  const clearPendingFileOperation = (operationId: string) => {
    const next = removePendingFileOperation(pendingFileOperationsRef.current, operationId);
    pendingFileOperationsRef.current = next;
    setPendingFileOperations(next);
  };
  const projectOperationIsCurrent = (requestedProjectPath: string) => mayCommitAsyncOperationResult(requestedProjectPath, projectPathRef.current);
  const discardStaleProjectOperation = (requestedProjectPath: string, operation?: PendingFileOperation | null) => {
    if (projectOperationIsCurrent(requestedProjectPath)) return false;
    if (operation) clearPendingFileOperation(operation.id);
    return true;
  };
  const reconcilePendingFileOperation = async (operation: PendingFileOperation, result?: { affectedDirectories?: string[] }, rollbackImmediately = false) => {
    const requestedProjectPath = operation.projectPath || projectPathRef.current;
    if (!projectOperationIsCurrent(requestedProjectPath)) { clearPendingFileOperation(operation.id); return; }
    const directories = operationRefreshDirectories(operation, result);
    if (rollbackImmediately) clearPendingFileOperation(operation.id);
    for (const directory of directories) directoryEntriesCacheRef.current.delete(directory);
    const currentPath = normalizeProjectRelativePath(currentRelativePathRef.current);
    const directoryReconciled = directories.includes(currentPath)
      ? await refresh(currentPath, { includeProjectContents: !currentPath }) : false;
    if (!projectOperationIsCurrent(requestedProjectPath)) { clearPendingFileOperation(operation.id); return; }
    if (recursiveFlatOpen || currentFolderRecursiveSearchActive) {
      await Promise.all(directories.map(directory => refreshRecursiveDirectory(directory)));
      if (!projectOperationIsCurrent(requestedProjectPath)) { clearPendingFileOperation(operation.id); return; }
    }
    if (projectRootScopeSelected) setScopeRefreshToken(current => current + 1);
    if (!rollbackImmediately) clearPendingFileOperation(operation.id);
    // A committed foreground read already contains the filesystem mutation.
    // Retry only when it was superseded/failed, or the recursive view still
    // needs its independent reconciliation. Watcher events retain their own
    // invalidation path for changes arriving after this read.
    if (!projectRootScopeSelected && (!directoryReconciled || recursiveFlatOpen || currentFolderRecursiveSearchActive)) {
      scheduleDirectoryRefresh(directories);
    }
  };
  useEffect(() => {
    const nextIdentity = { pageId, projectId: project.id, projectPath: project.path, projectName: project.name, projectStatus: project.status };
    const lifecycle = resolveProjectWorkspaceLifecycle(projectLifecycleRef.current, nextIdentity, currentRelativePathRef.current, initialRelativePath);
    projectLifecycleRef.current = nextIdentity;
    projectPathRef.current = project.path;
    if (lifecycle.kind === 'none') return;
    refreshSequenceRef.current += 1;
    setForegroundDirectoryReady(false);
    if (lifecycle.kind !== 'refresh') renderedDirectoryRef.current = { path: lifecycle.relativePath, ready: false };
    directoryEntriesCacheRef.current.clear();
    optimisticDirectoryEntriesCacheRef.current.clear();
    directoryPrefetchesRef.current.clear();
    directoryPreviewRequestTokensRef.current.clear();
    pendingFileOperationsRef.current = [];
    setPendingFileOperations([]);
    clipboardOperationSequenceRef.current += 1;
    setCutPaths([]);
    setClipboardPending(false);
    setClipboardHasFiles(false);
    shortcutPreviewStatesRef.current.clear();
    resetProgressFolderRequests();
    if (lifecycle.kind !== 'refresh') setDirectoryLoading(active);
    if (lifecycle.kind === 'refresh') {
      if (active) refresh(lifecycle.relativePath);
      return;
    }
    currentRelativePathRef.current = lifecycle.relativePath;
    setProgressFolders([]);
    setVersionGraphEdges([]);
    setFileEntries([]);
    setDirectoryHistory({ back: [], forward: [] });
    setPreviewPath('');
    setPreviewHighlightPath('');
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setFinalViewOpen(false);
    setFinalViewEntries([]);
    setVersionEntry(null);
    setVersionProgressId('');
    versionProgressLocationRef.current = null;
    setProgressSetup(null);
    setFolderMarkSetup(null);
    setProgressCompare(null);
    setWorkspaceActivityMessage('');
    setPanel(initialPanel);
    setResearchTargetPath('');
    setResearchTargetHasTxt(false);
    setGatherPickerPaths(null);
    setBrowseMode(browseModeForFolder(lifecycle.relativePath, []));
    setGridIconSize(gridIconSizeForFolder(lifecycle.relativePath));
    if (currentRelativePath !== lifecycle.relativePath) skipNextPathRefreshRef.current = true;
    setCurrentRelativePath(lifecycle.relativePath);
    if (active) refresh(lifecycle.relativePath);
  }, [active, initialPanel, initialRelativePath, pageId, project.id, project.name, project.path, project.status, projectWorkflows]);
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      setForegroundDirectoryReady(false);
      refresh(currentRelativePathRef.current);
    } else if (!active) {
      resetProgressFolderRequests();
      setForegroundDirectoryReady(false);
    }
    wasActiveRef.current = active;
  }, [active]);
  useEffect(() => {
    if (!active || currentRelativePath) return;
    const remembered = storedFolderBrowseMode('');
    if (remembered && remembered !== 'version-tree') return;
    const nextMode = browseModeForFolder('');
    setBrowseMode(current => current === nextMode ? current : nextMode);
  }, [active, currentRelativePath, progressFolders, project.path, versionTreeEnabled]);
  useEffect(() => {
    if (!didInitializePathRefreshRef.current) {
      didInitializePathRefreshRef.current = true;
      return;
    }
    if (skipNextPathRefreshRef.current) {
      skipNextPathRefreshRef.current = false;
      return;
    }
    setSelectedPaths([]);
    setPreviewPath('');
    setPreviewHighlightPath('');
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setInlineRenamePath('');
    setInlineRenameValue('');
    setFileMenu(null);
    refresh();
  }, [currentRelativePath]);
  useEffect(() => { setFolderAlphabetFilter(''); }, [currentRelativePath, browseMode, folderAlphabetFilterEnabled]);
  useEffect(() => {
    onDirectoryChangeRef.current?.(currentRelativePath);
  }, [currentRelativePath]);
  useEffect(() => {
    setOperationDirectoryPath(currentRelativePath);
  }, [currentRelativePath, recursiveFlatOpen]);
  useEffect(() => { if (active && projectWorkflows && versionTreeEnabled) prefetchVersionTreeLayout(workspacePath, project.name, ''); }, [active, project.name, projectWorkflows, versionTreeEnabled, workspacePath]);
  useEffect(() => {
    if (!active || !foregroundDirectoryReady) return;
    let disposed = false;
    let watchStarted = false;
    const subscriptionId = crypto.randomUUID();
    fileRootSubscriptionRef.current = subscriptionId;
    const watchIdentity = `${workspacePath}\0${project.status}\0${project.name}\0${project.path}`;
    const previousReconcile = watchReconcileStateRef.current;
    const forceReconcile = previousReconcile.identity !== watchIdentity
      || previousReconcile.externalWatchRevision !== externalWatchRevision;
    const reconcile = shouldReconcileProjectWatch(previousReconcile.lastReconciledAt, Date.now(), forceReconcile);
    const cancelDeferredStart = scheduleAfterProjectPaint(PROJECT_BACKGROUND_LOAD_DELAYS_MS.watcher, () => {
      if (disposed || !activeRef.current) return;
      watchStarted = true;
      setRootWatchFailed(false);
      void projectWorkspaceClient.watchFileRoot(workspacePath, project.status, project.name, { reconcile, subscriptionId }).then(result => {
        if (disposed) return;
        setRootWatchFailed(!result.success || result.degraded === true);
        if (result.reconciled) {
          watchReconcileStateRef.current = { identity: watchIdentity, externalWatchRevision, lastReconciledAt: Date.now() };
          if (projectWorkflows) void loadProgressFolders();
        }
      }).catch(() => { if (!disposed) setRootWatchFailed(true); });
    });
    return () => {
      disposed = true;
      cancelDeferredStart();
      if (fileRootSubscriptionRef.current === subscriptionId) fileRootSubscriptionRef.current = '';
      if (watchStarted) void projectWorkspaceClient.unwatchFileRoot(workspacePath, project.status, project.name, { subscriptionId });
    };
  }, [active, externalWatchRevision, foregroundDirectoryReady, loadProgressFolders, project.name, project.path, project.status, projectWorkflows, watchRootDirectly, workspacePath]);
  useEffect(() => {
    if (!active || !rootWatchFailed) return;
    // Network drives and some virtual filesystems cannot be watched. Keep a
    // low-frequency fallback without making polling the normal code path.
    const interval = window.setInterval(() => {
      const subscriptionId = fileRootSubscriptionRef.current;
      if (!subscriptionId) return;
      void projectWorkspaceClient.watchFileRoot(workspacePath, project.status, project.name, { reconcile: true, subscriptionId }).then(result => {
        if (fileRootSubscriptionRef.current !== subscriptionId) return;
        if (result.success && !result.degraded) setRootWatchFailed(false);
        if (result.reconciled) {
          watchReconcileStateRef.current = {
            identity: `${workspacePath}\0${project.status}\0${project.name}\0${project.path}`,
            externalWatchRevision,
            lastReconciledAt: Date.now(),
          };
          if (projectWorkflows) void loadProgressFolders();
        }
      }).catch(() => { if (activeRef.current) setRootWatchFailed(true); });
      if (projectRootScopeSelected) setScopeRefreshToken(current => current + 1);
      else if (recursiveFlatOpen || currentFolderRecursiveSearchActive) setRecentRefreshToken(current => current + 1);
      else {
        const currentPath = normalizeProjectRelativePath(currentRelativePathRef.current);
        void refresh(currentPath, { includeProjectContents: !currentPath }).catch(() => undefined);
      }
    }, PROJECT_WATCH_FALLBACK_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [active, currentFolderRecursiveSearchActive, externalWatchRevision, loadProgressFolders, project.name, project.path, project.status, projectRootScopeSelected, projectWorkflows, recursiveFlatOpen, rootWatchFailed, watchRootDirectly, workspacePath]);
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    let progressFolderTimer: number | undefined;
    let refreshProjectContents = false;
    const pendingRecursiveDirectories = new Set<string>();
    const normalizedWorkspaceRoot = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
    const normalizedProjectPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const projectPrefix = rootRelativeFileEvents
      ? ''
      : normalizedProjectPath.toLocaleLowerCase().startsWith(`${normalizedWorkspaceRoot}/`)
        ? normalizedProjectPath.slice(normalizedWorkspaceRoot.length + 1)
        : project.name.replace(/\\/g, '/');
    const unsubscribe = projectWorkspaceClient.onWorkspaceFilesChanged(change => {
      if (change.root && change.root.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() !== normalizedWorkspaceRoot) return;
      if (change.watcherFailed && watchRootDirectly) setRootWatchFailed(true);
      const changedPath = (change.fileName || '').replace(/\\/g, '/');
      if (!changedPath) refreshProjectContents = true;
      if (change.eventType === 'rename' && /(?:^|\/)[^/]+\.lnk$/i.test(changedPath)) setExternalWatchRevision(current => current + 1);
      // A change in another project should never make a photo-heavy folder redraw.
      if (projectPrefix && changedPath && changedPath !== projectPrefix && !changedPath.startsWith(`${projectPrefix}/`)) return;
      // Content writes are handled by thumbnail/media tracking. Re-reading the
      // whole directory is only necessary when its membership may have changed.
      if (change.eventType === 'change') {
        // Media writes are reflected by thumbnail events, but ordinary files
        // still need their lightweight details and parent listing refreshed.
        const extension = changedPath.split('.').pop()?.toLocaleLowerCase() || '';
        if (/^(?:avif|bmp|gif|heic|heif|jpe?g|png|raw|tiff?|webp|mp4|mov|mkv|avi|webm|m4v)$/.test(extension)) return;
      }
      if (changedPath) {
        const projectRelativePath = !projectPrefix ? changedPath : changedPath === projectPrefix ? '' : changedPath.slice(projectPrefix.length + 1);
        if (!projectRelativePath || !projectRelativePath.includes('/')) refreshProjectContents = true;
        if (projectWorkflows && (!projectRelativePath || !projectRelativePath.includes('/'))) {
          window.clearTimeout(progressFolderTimer);
          progressFolderTimer = window.setTimeout(() => void loadProgressFolders(), 550);
        }
        const changedParentPath = projectRelativePath.split('/').slice(0, -1).join('/');
        const currentPath = currentRelativePathRef.current.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (changedParentPath !== currentPath) directoryEntriesCacheRef.current.delete(normalizeProjectRelativePath(changedParentPath));
        if (projectRootScopeSelected) {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => setScopeRefreshToken(current => current + 1), 350);
          return;
        }
        if (recursiveFlatOpen || currentFolderRecursiveSearchActive) {
          const normalizedChangedPath = normalizeProjectRelativePath(projectRelativePath);
          const affectsRecursiveScope = !currentPath
            || normalizedChangedPath === currentPath
            || normalizedChangedPath.startsWith(`${currentPath}/`);
          if (!affectsRecursiveScope) return;
          pendingRecursiveDirectories.add(normalizeProjectRelativePath(changedParentPath));
          if (normalizedChangedPath === currentPath) pendingRecursiveDirectories.add(normalizedChangedPath);
          const changedPathWasLoadedFolder = Boolean(normalizedChangedPath) && searchEntriesRef.current.some(entry => {
            if (entry.viaShortcut) return false;
            const entryPath = normalizeProjectRelativePath(entry.relativePath);
            return projectRelativeParentPath(entryPath) === normalizedChangedPath || entryPath.startsWith(`${normalizedChangedPath}/`);
          });
          if (changedPathWasLoadedFolder) pendingRecursiveDirectories.add(normalizedChangedPath);
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            const directories = [...pendingRecursiveDirectories];
            pendingRecursiveDirectories.clear();
            for (const directory of directories) void refreshRecursiveDirectory(directory);
          }, 350);
          return;
        }
        const affectsCurrentDirectory = !projectRelativePath
          || changedParentPath === currentPath
          || projectRelativePath === currentPath
          || Boolean(currentPath && currentPath.startsWith(`${projectRelativePath}/`));
        if (!affectsCurrentDirectory) return;
      }
      if (!changedPath) {
        const currentPath = normalizeProjectRelativePath(currentRelativePathRef.current);
        const currentEntries = directoryEntriesCacheRef.current.get(currentPath) ?? (renderedDirectoryRef.current.ready ? fileEntriesRef.current : undefined);
        directoryEntriesCacheRef.current.clear();
        if (currentEntries) directoryEntriesCacheRef.current.set(currentPath, currentEntries);
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const includeProjectContents = refreshProjectContents;
        refreshProjectContents = false;
        refresh(currentRelativePathRef.current, { includeProjectContents });
        if (finalViewOpen) void loadFinalViewEntries();
      }, 500);
    });
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(progressFolderTimer);
      unsubscribe();
    };
  }, [active, workspacePath, project.path, project.status, project.name, rootRelativeFileEvents, watchRootDirectly, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB, currentFolderRecursiveSearchActive, finalViewOpen, loadFinalViewEntries, projectWorkflows, loadProgressFolders, projectRootScopeSelected, recursiveFlatOpen, refreshRecursiveDirectory]);
  useEffect(() => {
    if (!active) return;
    const unsubscribe = projectWorkspaceClient.onThumbnailStateChanged(update => {
      if (update.state !== 'STALE') return;
      const changedPath = update.filePath.replace(/\\/g, '/').toLocaleLowerCase();
      const applySourceRevision = (entries: ProjectFileEntry[]) => {
        let changed = false;
        const next = entries.map(entry => {
          if (entry.path.replace(/\\/g, '/').toLocaleLowerCase() !== changedPath) return entry;
          changed = true;
          return {
            ...entry,
            size: update.sourceSize ?? entry.size,
            updatedAt: update.sourceMtimeMs ?? Date.now(),
            previewUrl: undefined,
          };
        });
        return changed ? next : entries;
      };
      forgetMediaThumbnailPreviews(update.filePath);
      for (const [relativePath, entries] of directoryEntriesCacheRef.current) {
        const next = applySourceRevision(entries);
        if (next !== entries) directoryEntriesCacheRef.current.set(relativePath, next);
      }
      setFileEntries(applySourceRevision);
      setSearchEntries(applySourceRevision);
      setFinalViewEntries(applySourceRevision);
    });
    return unsubscribe;
  }, [active, previewOnlyOnMediaClick]);
  useEffect(() => {
    const closeMenus = () => {
      const keepToolbarOverflowOpen = Boolean(document.activeElement?.closest('.project-toolbar-overflow-menu'));
      setFileMenu(null);
      setSurfaceMenu(null);
      setShowStatusMenu(false);
      setShowCreateMenu(false);
      setShowImportMenu(false);
      setShowVideoToolsMenu(false);
      setShowImageToolsMenu(false);
      setShowOfficeToolsMenu(false);
      if (!keepToolbarOverflowOpen) setShowToolbarOverflowMenu(false);
      setShowSortMenu(false);
      setShowFilterMenu(false);
    };
    window.addEventListener('click', closeMenus);
    window.addEventListener('photoflow-menu-open', closeMenus);
    return () => { window.removeEventListener('click', closeMenus); window.removeEventListener('photoflow-menu-open', closeMenus); };
  }, []);
  useEffect(() => {
    const closeToolbarOverflow = () => setShowToolbarOverflowMenu(false);
    window.addEventListener('resize', closeToolbarOverflow);
    window.visualViewport?.addEventListener('resize', closeToolbarOverflow);
    return () => {
      window.removeEventListener('resize', closeToolbarOverflow);
      window.visualViewport?.removeEventListener('resize', closeToolbarOverflow);
    };
  }, []);
  const recursiveSearchActive = (recursiveFlatOpen || currentFolderRecursiveSearchActive || projectRootFilterActive) && !finalViewOpen;
  const groupedResultsActive = (recursiveFlatOpen || currentFolderRecursiveSearchActive || projectRootFilterActive) && !finalViewOpen;
  const authoritativeActiveFileEntries = projectRootFilterActive ? scopeEntries : recursiveFlatOpen || currentFolderRecursiveSearchActive ? searchEntries : finalViewOpen ? finalViewEntries : fileEntries;
  const activeFileEntries = useMemo(() => finalViewOpen
    ? authoritativeActiveFileEntries
    : applyPendingFileOperations(
      authoritativeActiveFileEntries,
      projectRootFilterActive || recursiveFlatOpen || currentFolderRecursiveSearchActive ? undefined : currentRelativePath,
      pendingFileOperations,
    ), [authoritativeActiveFileEntries, currentFolderRecursiveSearchActive, currentRelativePath, finalViewOpen, pendingFileOperations, projectRootFilterActive, recursiveFlatOpen]);
  useVersionChanges(active && projectWorkflows, Boolean(pendingRelationChange), workspacePath, project.name, project.id, loadProgressFoldersSnapshot);
  const currentDirectoryFolders = useMemo(() => fileEntries.filter(isFolderLikeEntry), [fileEntries]);
  const folderAlphabetKeys = useMemo(() => availableFolderAlphabetKeys(currentDirectoryFolders.map(entry => entry.name)), [currentDirectoryFolders]);
  const folderAlphabetFilterVisible = folderAlphabetFilterEnabled && browseMode === 'grid' && !finalViewOpen && !recursiveSearchActive && !searchQuery.trim() && fileFilter === 'all' && ratingFilter === 'all' && currentDirectoryFolders.length > FOLDER_ALPHABET_FILTER_THRESHOLD;
  useEffect(() => {
    filterRatingSequenceRef.current += 1;
    const sequence = filterRatingSequenceRef.current;
    setFilterRatingsCheckedCount(0);
    if (!active || ratingFilter === 'all') {
      setFilterRatingsLoading(false);
      return;
    }
    const ratingEntries = activeFileEntries.filter(entry => (!entry.viaShortcut) && (entry.kind === 'image' || entry.kind === 'raw'));
    const cachedRatings: Record<string, number> = {};
    const pending = ratingEntries.filter(entry => {
      if (typeof entry.rating === 'number') {
        cachedRatings[entry.path] = entry.rating;
        return false;
      }
      const cacheKey = mediaRatingCacheKey(entry.path, entry.updatedAt || 0);
      const cached = previewRatingCacheRef.current.get(cacheKey);
      if (cached === undefined) return true;
      cachedRatings[entry.path] = cached;
      return false;
    });
    setFilterRatings(cachedRatings);
    setFilterRatingsCheckedCount(Object.keys(cachedRatings).length);
    if (!pending.length) {
      setFilterRatingsLoading(false);
      return;
    }
    setFilterRatingsLoading(true);
    const readPendingRatings = async () => {
      const collected = { ...cachedRatings };
      for (let offset = 0; offset < pending.length; offset += 200) {
        const batch = pending.slice(offset, offset + 200);
        const result = await projectWorkspaceClient.getMediaRatings(batch.map(entry => ({ path: entry.path, updatedAt: entry.updatedAt || 0 })));
        if (sequence !== filterRatingSequenceRef.current) return;
        for (const item of result.results || []) {
          const rating = item.success ? item.rating : 0;
          previewRatingCacheRef.current.set(mediaRatingCacheKey(item.path, item.updatedAt || 0), rating);
          collected[item.path] = rating;
        }
        setFilterRatings({ ...collected });
        setFilterRatingsCheckedCount(Object.keys(collected).length);
      }
    };
    void readPendingRatings().catch(() => {
      if (sequence === filterRatingSequenceRef.current) setFilterRatings(cachedRatings);
    }).finally(() => {
      if (sequence === filterRatingSequenceRef.current) setFilterRatingsLoading(false);
    });
    return () => { filterRatingSequenceRef.current += 1; };
  }, [active, activeFileEntries, filterScope, ratingFilter]);
  const displayedFileEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase('zh-CN');
    const queryFiltered = normalizedQuery && !recursiveSearchActive ? activeFileEntries.filter(entry => entry.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) : activeFileEntries;
    let filtered = fileFilter === 'all' ? queryFiltered : queryFiltered.filter(entry => {
      if (fileFilter === 'image') return isPhotoshopOpenEntry(entry);
      if (fileFilter === 'video') return entry.kind === 'video';
      return isPhotoshopOpenEntry(entry) || entry.kind === 'video';
    });
    if (ratingFilter !== 'all') {
      filtered = filtered.filter(entry => {
        const rating = typeof entry.rating === 'number' ? entry.rating : filterRatings[entry.path] || 0;
        return ratingFilter === 'rated' ? rating > 0 : rating === Number(ratingFilter);
      });
    }
    if (folderAlphabetFilterVisible && folderAlphabetFilter) {
      filtered = filtered.filter(entry => isFolderLikeEntry(entry) && folderAlphabetKey(entry.name) === folderAlphabetFilter);
    }
    return sortProjectFileEntries(filtered, sortField, sortDirection);
  }, [activeFileEntries, fileFilter, filterRatings, folderAlphabetFilter, folderAlphabetFilterVisible, ratingFilter, searchQuery, recursiveSearchActive, sortDirection, sortField]);
  useEffect(() => {
    const pending = pendingDirectoryReturnRevealRef.current;
    if (!pending || pending.directoryPath !== normalizeProjectRelativePath(currentRelativePath) || directoryLoading) return;
    pendingDirectoryReturnRevealRef.current = null;
    const returnedFolder = fileEntries.find(entry => isFolderLikeEntry(entry) && normalizeProjectRelativePath(entry.relativePath) === pending.entryPath);
    if (!returnedFolder) return;
    selectionAnchorPathRef.current = '';
    setSelectedPaths([]);
    setDirectoryReturnHighlightPath(returnedFolder.relativePath);
    requestFileReveal(returnedFolder.relativePath);
  }, [currentRelativePath, directoryLoading, fileEntries, requestFileReveal]);
  const filteredFileTypeLabel = fileFilter === 'all' ? '文件' : PROJECT_FILE_FILTER_OPTIONS.find(option => option.value === fileFilter)?.label || '文件';
  const searchResultGroups = useMemo(() => {
    if (!groupedResultsActive) return [];
    const groups = new Map<string, ProjectFileEntry[]>();
    for (const entry of displayedFileEntries) {
      const normalizedPath = entry.relativePath.replace(/\\/g, '/');
      const folderPath = entry.parentRelativePath?.replace(/\\/g, '/') ?? normalizedPath.split('/').slice(0, -1).join('/');
      const items = groups.get(folderPath) || [];
      items.push(entry);
      groups.set(folderPath, items);
    }
    const orderedGroups = [...groups.entries()].sort(([leftPath, leftEntries], [rightPath, rightEntries]) => {
      if (recursiveFlatOpen && !searchQuery.trim()) {
        const leftNewest = Math.max(0, ...leftEntries.map(entry => entry.updatedAt));
        const rightNewest = Math.max(0, ...rightEntries.map(entry => entry.updatedAt));
        if (leftNewest !== rightNewest) return rightNewest - leftNewest;
      }
      return leftPath.localeCompare(rightPath, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
    if (!recursiveFlatOpen || searchQuery.trim()) return orderedGroups;
    const identity = `${project.path}\0${normalizeProjectRelativePath(currentRelativePath)}\0all-files`;
    if (recursiveGroupOrderRef.current.identity !== identity) recursiveGroupOrderRef.current = { identity, paths: [] };
    const paths = retainStableGroupOrder(recursiveGroupOrderRef.current.paths, orderedGroups.map(([folderPath]) => folderPath));
    recursiveGroupOrderRef.current = { identity, paths };
    const orderByPath = new Map(paths.map((folderPath, index) => [folderPath, index]));
    return orderedGroups.sort(([leftPath], [rightPath]) => (orderByPath.get(leftPath) ?? Number.MAX_SAFE_INTEGER) - (orderByPath.get(rightPath) ?? Number.MAX_SAFE_INTEGER));
  }, [currentRelativePath, displayedFileEntries, groupedResultsActive, project.path, recursiveFlatOpen, searchQuery]);
  const groupedLoading = projectRootFilterActive ? scopeLoading : searchLoading;
  const groupedError = projectRootFilterActive ? scopeError : searchError;
  const groupedLoadingMore = projectRootFilterActive ? scopeLoadingMore : recentLoadingMore;
  const groupedLoadError = projectRootFilterActive ? scopeError : recentLoadError;
  const groupedHasMore = projectRootFilterActive ? scopeHasMore : recentHasMore;
  const groupedInitialLoading = groupedResultsAreInitiallyLoading(groupedLoading, searchResultGroups.length);
  const renderedFileEntries = displayedFileEntries.slice(virtualWindow.start, virtualWindow.end);
  const pathSegments = currentRelativePath.split(/[\\/]/).filter(Boolean);
  const browserRootLabel = gatherToProject ? browserContext.title : project.name;
  const recursiveScopeLabel = currentRelativePath ? '当前文件夹及其子文件夹' : inspirationMode ? '整个灵感库' : '整个项目';
  const breadcrumbs = pathSegments.map((label, index) => ({
    label: label.toLocaleLowerCase().endsWith('.lnk') ? label.slice(0, -4) : label,
    relativePath: pathSegments.slice(0, index + 1).join('/'),
  }));
  useEffect(() => { setVirtualWindow({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 }); }, [browseMode, currentRelativePath, fileFilter, filterScope, ratingFilter, finalViewOpen, sortField, sortDirection, searchQuery]);
  useEffect(() => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (!container || !surface) return;
    let frameId = 0;
    const update = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const containerRect = container.getBoundingClientRect();
        const surfaceRect = surface.getBoundingClientRect();
        const surfaceTop = surfaceRect.top - containerRect.top + container.scrollTop;
        const visibleTop = Math.max(0, container.scrollTop - surfaceTop - (viewMode === 'list' ? 32 : 0));
        const surfaceWidth = Math.max(1, surface.clientWidth);
        const measuredItem = surface.querySelector<HTMLElement>('[data-entry-path]');
        const gridGeometry = viewMode === 'grid' ? calculateFileGridGeometry(surfaceWidth, gridIconSize, measuredItem?.getBoundingClientRect().height) : null;
        const columns = gridGeometry?.columns || 1;
        const rowHeight = gridGeometry?.rowHeight || FILE_LIST_ROW_HEIGHT;
        const rowPitch = gridGeometry?.rowPitch || FILE_LIST_ROW_HEIGHT;
        const rowCount = Math.ceil(displayedFileEntries.length / columns);
        const firstRow = Math.max(0, Math.floor(visibleTop / rowPitch) - FILE_VIRTUAL_OVERSCAN_ROWS);
        const lastRow = Math.min(rowCount, Math.ceil((visibleTop + container.clientHeight) / rowPitch) + FILE_VIRTUAL_OVERSCAN_ROWS);
        const next = {
          start: firstRow * columns,
          end: Math.min(displayedFileEntries.length, lastRow * columns),
          top: firstRow * rowPitch,
          bottom: Math.max(0, (rowCount - lastRow) * rowPitch),
          rowHeight,
          columns,
        };
        setVirtualWindow(current => current.start === next.start && current.end === next.end && Math.abs(current.top - next.top) < 1 && Math.abs(current.bottom - next.bottom) < 1 && Math.abs(current.rowHeight - next.rowHeight) < 1 && current.columns === next.columns ? current : next);
      });
    };
    update();
    container.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(surface);
    return () => {
      window.cancelAnimationFrame(frameId);
      container.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [currentRelativePath, finalViewOpen, displayedFileEntries.length, viewMode, gridIconSize, previewPaneOpen, metadataPaneOpen, sortField, sortDirection, searchQuery]);
  useEffect(() => {
    if (sortField === 'name') return;
    const missingPaths = fileEntries.filter(entry => entry.updatedAt === 0 || entry.size < 0).map(entry => entry.relativePath);
    if (!missingPaths.length) return;
    let active = true;
    const directoryPath = currentRelativePath;
    const chunks = Array.from({ length: Math.ceil(missingPaths.length / 500) }, (_value, index) => missingPaths.slice(index * 500, (index + 1) * 500));
    Promise.all(chunks.map(paths => projectWorkspaceClient.getProjectFileDetails(workspacePath, project.status, project.name, paths))).then(results => {
      if (!active || directoryPath !== currentRelativePathRef.current) return;
      const detailsByPath = new Map(results.flatMap(result => result.success ? result.details : []).map(detail => [detail.relativePath, detail]));
      if (!detailsByPath.size) return;
      setFileEntries(current => {
        let changed = false;
        const next = current.map(entry => {
          const detail = detailsByPath.get(entry.relativePath);
          if (!detail || entry.size === detail.size && entry.createdAt === detail.createdAt && entry.updatedAt === detail.updatedAt) return entry;
          changed = true;
          return { ...entry, size: detail.size, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
        });
        if (!changed) return current;
        directoryEntriesCacheRef.current.set(directoryPath, next);
        return next;
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [sortField, fileEntries, currentRelativePath, workspacePath, project.status, project.name]);
  useEffect(() => {
    const missingDetails = renderedFileEntries.filter(entry => entry.updatedAt === 0).map(entry => entry.relativePath);
    if (!missingDetails.length) return;
    let active = true;
    const directoryPath = currentRelativePath;
    projectWorkspaceClient.getProjectFileDetails(workspacePath, project.status, project.name, missingDetails).then(result => {
      if (!active || directoryPath !== currentRelativePathRef.current || !result.success || !result.details.length) return;
      const detailsByPath = new Map(result.details.map(detail => [detail.relativePath, detail]));
      setFileEntries(current => {
        let changed = false;
        const next = current.map(entry => {
          const detail = detailsByPath.get(entry.relativePath);
          if (!detail || entry.size === detail.size && entry.createdAt === detail.createdAt && entry.updatedAt === detail.updatedAt) return entry;
          changed = true;
          return { ...entry, size: detail.size, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
        });
        if (!changed) return current;
        directoryEntriesCacheRef.current.set(directoryPath, next);
        return next;
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [currentRelativePath, virtualWindow.start, virtualWindow.end, fileEntries]);

  useEffect(() => {
    const scrollContainer = filesColumnRef.current;
    const filesSurface = filesSurfaceRef.current;
    if (!scrollContainer || !filesSurface) return;
    let frameId = 0;
    const updateCurrentVisibleFile = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const containerRect = scrollContainer.getBoundingClientRect();
        const entriesByPath = new Map(activeFileEntries.map(entry => [entry.relativePath, entry]));
        let currentPath = '';
        let currentScore = Number.NEGATIVE_INFINITY;
        for (const node of filesSurface.querySelectorAll<HTMLElement>('[data-entry-path]')) {
          const path = node.dataset.entryPath || '';
          if (!path || (entriesByPath.get(path) && isFolderLikeEntry(entriesByPath.get(path)!))) continue;
          const rect = node.getBoundingClientRect();
          if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom || rect.right <= containerRect.left || rect.left >= containerRect.right) continue;
          // The last row wins; within that row, use the rightmost file.
          const score = rect.top * 100000 + rect.left;
          if (score > currentScore) {
            currentScore = score;
            currentPath = path;
          }
        }
        setViewportCurrentPath(current => current === currentPath ? current : currentPath);
      });
    };
    updateCurrentVisibleFile();
    scrollContainer.addEventListener('scroll', updateCurrentVisibleFile, { passive: true });
    const resizeObserver = new ResizeObserver(updateCurrentVisibleFile);
    resizeObserver.observe(scrollContainer);
    return () => {
      window.cancelAnimationFrame(frameId);
      scrollContainer.removeEventListener('scroll', updateCurrentVisibleFile);
      resizeObserver.disconnect();
    };
  }, [activeFileEntries, virtualWindow.start, virtualWindow.end, viewMode, gridIconSize, previewPaneOpen, metadataPaneOpen]);

  const loadDirectoryPreviewEntries = useCallback((entry: ProjectFileEntry) => {
    if (entry.kind !== 'folder' && entry.kind !== 'shortcut') return Promise.resolve({ entries: [], authoritative: true });
    const pendingEntry = entry as PendingProjectFileEntry;
    const pendingRename = Boolean(pendingEntry.pendingSourceRelativePath);
    const cacheKey = directoryPreviewCacheKey(entry);
    const applyShortcutState = (state: Pick<ProjectFileEntry, 'shortcutTargetKind' | 'shortcutBroken'>) => {
      const applyState = (entries: ProjectFileEntry[]) => applyShortcutPreviewState(entries, entry.path, entry.updatedAt, state);
      setFileEntries(applyState);
      setScopeEntries(applyState);
      setSearchEntries(applyState);
      for (const [directoryKey, entries] of directoryEntriesCacheRef.current) {
        const next = applyState(entries);
        if (next !== entries) directoryEntriesCacheRef.current.set(directoryKey, next);
      }
    };
    const optimisticCached = pendingRename ? optimisticDirectoryEntriesCacheRef.current.get(cacheKey) : undefined;
    if (optimisticCached) return Promise.resolve({ entries: optimisticCached, authoritative: true });
    const sourceCacheKey = pendingDirectoryPreviewSourceCacheKey(pendingEntry);
    const sourceCached = sourceCacheKey ? directoryEntriesCacheRef.current.get(sourceCacheKey) : undefined;
    if (sourceCached) {
      const remapped = remapPendingDirectoryPreviewEntries(pendingEntry, sourceCached);
      if (remapped) {
        // A cold optimistic read may already be in flight against a path that
        // does not exist yet. Retire it before promoting the authoritative
        // source cache so its late empty result cannot overwrite this cover.
        directoryPreviewRequestTokensRef.current.delete(cacheKey);
        directoryPrefetchesRef.current.delete(cacheKey);
        optimisticDirectoryEntriesCacheRef.current.set(cacheKey, remapped);
        return Promise.resolve({ entries: remapped, authoritative: true });
      }
    }
    // The predicted target is not an authoritative read location until the
    // filesystem transaction commits. In a name swap it is the *other* source
    // directory, so a cold read here would capture the wrong cover.
    if (pendingRename) return Promise.resolve({ entries: [], authoritative: false });
    const cached = directoryEntriesCacheRef.current.get(cacheKey);
    if (cached) {
      const shortcutState = shortcutPreviewStatesRef.current.get(cacheKey);
      if (shortcutState) applyShortcutState(shortcutState);
      return Promise.resolve({ entries: cached, authoritative: true });
    }
    const pending = directoryPrefetchesRef.current.get(cacheKey);
    if (pending) return pending;
    const requestedProjectPath = project.path;
    type BrowseResult = { success: boolean; entries: ProjectFileEntry[]; shortcutTargetKind?: 'folder' | 'file'; shortcutBroken?: boolean };
    const browse = (): Promise<BrowseResult> => entry.kind === 'shortcut'
      ? projectWorkspaceClient.browseProjectShortcutPreview(workspacePath, project.status, project.name, entry.relativePath).then(result => ({ success: result.success, entries: result.entries, shortcutTargetKind: result.success && result.targetKind ? result.targetKind : undefined, shortcutBroken: !result.success }))
      : projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, entry.relativePath, mediaCacheConfig);
    const browseRequest = (async () => {
      let result: BrowseResult = { success: false, entries: [] };
      for (let attempt = 0; attempt <= DIRECTORY_PREVIEW_RETRY_DELAYS_MS.length; attempt += 1) {
        try { result = await browse(); }
        catch { result = { success: false, entries: [], shortcutBroken: entry.kind === 'shortcut' }; }
        if (shouldCacheDirectoryPreviewResult(pendingRename, result) || attempt === DIRECTORY_PREVIEW_RETRY_DELAYS_MS.length) return result;
        await new Promise<void>(resolve => window.setTimeout(resolve, DIRECTORY_PREVIEW_RETRY_DELAYS_MS[attempt]));
      }
      return result;
    })();
    const requestToken = Symbol(cacheKey);
    directoryPreviewRequestTokensRef.current.set(cacheKey, requestToken);
    const request = browseRequest
      .then(result => {
        if (requestedProjectPath !== projectPathRef.current || directoryPreviewRequestTokensRef.current.get(cacheKey) !== requestToken) return { entries: [], authoritative: false };
        if (entry.kind === 'shortcut') {
          const shortcutState = { shortcutTargetKind: result.shortcutTargetKind, shortcutBroken: result.shortcutBroken };
          shortcutPreviewStatesRef.current.set(cacheKey, shortcutState);
          applyShortcutState(shortcutState);
        }
        if (!shouldCacheDirectoryPreviewResult(pendingRename, result)) {
          return { entries: [], authoritative: false };
        }
        if (pendingRename) optimisticDirectoryEntriesCacheRef.current.set(cacheKey, result.entries);
        else directoryEntriesCacheRef.current.set(cacheKey, result.entries);
        return { entries: result.entries, authoritative: true };
      })
      .finally(() => {
        if (directoryPreviewRequestTokensRef.current.get(cacheKey) !== requestToken) return;
        directoryPreviewRequestTokensRef.current.delete(cacheKey);
        directoryPrefetchesRef.current.delete(cacheKey);
      });
    directoryPrefetchesRef.current.set(cacheKey, request);
    return request;
  }, [workspacePath, project.path, project.status, project.name, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB]);
  const prefetchDirectory = (entry: ProjectFileEntry) => {
    if (entry.kind === 'folder' || entry.kind === 'shortcut') void loadDirectoryPreviewEntries(entry);
  };

  const togglePanel = (next: Exclude<ProjectPanel, null>) => setPanel(current => current === next ? null : next);
  const refreshRecursiveResults = (directoryPaths: string | string[] = operationDirectoryPath || currentRelativePath) => {
    if (!recursiveFlatOpen) return;
    const uniqueDirectories = [...new Set((Array.isArray(directoryPaths) ? directoryPaths : [directoryPaths]).map(normalizeProjectRelativePath))];
    for (const directory of uniqueDirectories) void refreshRecursiveDirectory(directory);
  };
  const formatFileSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : size < 1024 * 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
  const openFolder = async (folderName?: string) => {
    const result = await projectWorkspaceClient.openWorkspaceProject(workspacePath, project.status, project.name, folderName);
    if (!result.success) onNotice(`打开文件夹失败：${result.error || '未知错误'}`);
  };
  const moveStatus = async (status: WorkspaceProject['status']) => {
    setShowStatusMenu(false);
    if (status === project.status) return;
    const result = await projectWorkspaceClient.moveWorkspaceProject(workspacePath, project.status, project.name, status);
    if (!result.success || !result.project) { onNotice(`更改状态失败：${result.error || '未知错误'}`); return; }
    onProjectMoved(result.project);
  };
  const importBroll = async () => {
    if (!brollSourcePaths.length) return;
    setShowImportMenu(false);
    setPanelImportResult(null);
    setPanelImportBusy('broll');
    try {
      const result = await projectWorkspaceClient.importBroll(workspacePath, project.status, project.name, { splitVideosOnImport: brollConfig.splitVideosOnImport, transcodeVideosOnImport: brollConfig.transcodeVideosOnImport, transcodeSettings: videoTools.transcode, deleteSourceAfterImport: deleteBrollSources, sourcePaths: brollSourcePaths });
      const pageOwnsNotice = pageOwnsFileOperationNotification(result);
      if (!result.success) { if (pageOwnsNotice) onNotice(`导入花絮失败：${result.error || '未知错误'}`); return; }
      if (result.cancelled) { if (pageOwnsNotice) onNotice('已取消选择花絮文件。'); return; }
      setPanelImportResult({ kind: 'broll', count: result.count || 0, sourceDeleted: deleteBrollSources });
      if (pageOwnsNotice) onNotice(`已导入 ${result.count || 0} 个花絮文件，源文件${deleteBrollSources ? '已删除' : '已保留'}。`);
      if (result.warning) {
        if (isRecycleBinFailure(result.warning)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
        else if (pageOwnsNotice) onNotice(result.warning, 6000);
      }
      refresh();
    } catch (error) {
      onNotice(`导入花絮失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
    } finally {
      setPanelImportBusy('');
    }
  };
  const chooseBrollFiles = async () => {
    const result = await projectWorkspaceClient.chooseBrollSourceFiles();
    if (!result.cancelled && result.paths.length) setBrollSourcePaths(current => mergeSourcePaths(current, result.paths));
  };
  const chooseFilesToImport = async () => {
    const result = await projectWorkspaceClient.chooseProjectImportFiles();
    if (!result.cancelled && result.paths.length) setFileImportSourcePaths(current => mergeSourcePaths(current, result.paths));
  };
  const handleProjectImportRecovery = async (result: Awaited<ReturnType<typeof projectWorkspaceClient.importProjectFiles>>) => {
    if (!result.recoveryRequired) return false;
    directoryEntriesCacheRef.current.clear(); setFileImportSourcePaths([]); setNegativeSourcePaths([]);
    await Promise.all([refresh(''), projectWorkflows ? loadProgressFolders() : Promise.resolve([])]);
    const cleanupSummary = result.recovery?.cleanupErrors.length ? `\n\n仍有 ${result.recovery.cleanupErrors.length} 项未能自动清理。` : '';
    await appDialog.alert({ title: localizedMessage("ui.import.results.have.been.kept.and.76b09c"), message: localizedMessage("ui.folders.and.the.version.tree.have.0e2d0a", { value0: cleanupSummary }), detail: result.error, confirmLabel: localizedMessage("ui.got.it.348f1c") });
    if (pageOwnsFileOperationNotification(result)) onNotice('已刷新保留的导入结果；请先处理现有文件，勿重复导入。', 10_000);
    return true;
  };
  const importFiles = async () => {
    if (!fileImportSourcePaths.length) return;
    const targetRelativePath = fileImportTarget;
    setPanelImportResult(null);
    setPanelImportBusy('files');
    try {
      const result = await projectWorkspaceClient.importProjectFiles(workspacePath, project.status, project.name, targetRelativePath, { deleteSourceAfterImport: deleteFileSources, sourcePaths: fileImportSourcePaths });
      if (await handleProjectImportRecovery(result)) return;
      const pageOwnsNotice = pageOwnsFileOperationNotification(result);
      if (!result.success) { if (pageOwnsNotice) onNotice(`导入失败：${result.error || '未知错误'}`); return; }
      if (result.cancelled) { if (pageOwnsNotice) onNotice('已取消导入。'); return; }
      if (result.watchDegraded) setRootWatchFailed(true);
      setPanelImportResult({ kind: 'files', count: result.count || 0, sourceDeleted: deleteFileSources });
      if (pageOwnsNotice) onNotice(`已导入 ${result.count || 0} 个文件，源文件${deleteFileSources ? '已删除' : '已保留'}。`);
      refresh();
      refreshRecursiveResults(targetRelativePath);
    } catch (error) {
      onNotice(`导入失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
    } finally {
      setPanelImportBusy('');
    }
  };
  const openOfficeImageExtractor = (entries: ProjectFileEntry[]) => {
    const documents = entries.filter(isOfficeOpenXmlEntry);
    if (!documents.length) return;
    setOfficeExtractEntries(documents);
    setOfficeExtractResult(null);
    setOfficeExtractError('');
    setPanel('office-extract');
  };
  const extractOfficeImages = async () => {
    const documents = officeExtractEntries.filter(isOfficeOpenXmlEntry);
    if (!documents.length || officeExtractBusy) return;
    setOfficeExtractResult(null);
    setOfficeExtractError('');
    setOfficeExtractBusy(true);
    onNotice(`正在从 ${documents.length} 个 Office 文档提取图片…`);
    try {
      const result = await projectWorkspaceClient.extractOfficeImages(workspacePath, project.status, project.name, documents.map(entry => entry.relativePath));
      const results = Array.isArray(result.results) ? result.results : [];
      const successful = results.filter(item => item.success);
      const presentation = presentOfficeExtractionResult(result, documents.length);
      if (!presentation) {
        const message = result.error || '未知错误';
        setOfficeExtractError(message);
        onNotice(`提取图片失败：${message}`, 6000);
        return;
      }
      const imageCount = presentation.images;
      const failed = presentation.extractionFailures;
      const empty = successful.filter(item => !item.count);
      setOfficeExtractResult(presentation);
      if (presentation.state === 'publication-failed') onNotice(`图片已提取但发布失败：${presentation.warning}`, 9000);
      else if (imageCount) onNotice(`已从 ${presentation.successful} 个文档提取 ${imageCount} 张图片。`, 7000);
      else onNotice(empty.length ? '所选 Office 文档中没有可提取的图片。' : '没有提取到图片。');
      if (failed.length) onNotice(`${failed.length} 个文档提取失败：${failed.map(item => item.documentName).join('、')}`, 7000);
      directoryEntriesCacheRef.current.clear();
      try {
        await refresh();
      } catch (error) {
        onNotice(`图片已提取完成，但目录刷新失败：${error instanceof Error ? error.message : String(error || '未知错误')}`, 7000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '未知错误');
      setOfficeExtractError(message);
      onNotice(`提取图片失败：${message}`, 6000);
    } finally {
      setOfficeExtractBusy(false);
    }
  };
  const completeSdImport = async (completion: ImportCompletion) => {
    const result = await projectWorkspaceClient.finalizeSdImportedProjects(workspacePath, completion.projectNames, {
      moveProjectAfterImport: importConfig.autoMoveProjectAfterSdImport,
      workProjectNames: completion.workProjectNames, importedPathsByProject: completion.importedPathsByProject,
    });
    await refresh();
    window.dispatchEvent(new Event('workspace-projects-changed'));
    if (!result.success) { onNotice(`整理导入项目失败：${result.error || '未知错误'}`, 7000); return; }
    const latestProject = result.projects.find(item => item.id === project.id || item.name.toLocaleLowerCase() === project.name.toLocaleLowerCase());
    if (latestProject && latestProject.status !== project.status) onProjectMoved(latestProject);
    if (result.failures.length) onNotice(`导入已完成，但有 ${result.failures.length} 个项目的分类更新失败。`, 7000);
    else if (result.movedProjects.some(item => item.id === project.id || item.name.toLocaleLowerCase() === project.name.toLocaleLowerCase())) onNotice('导入完成，项目已移入“后期中”。');
    else onNotice('导入完成，项目分类保持不变。');
  };
  const completeNegativeImport = async () => {
    await refresh();
    if (project.status === '后期中') return;
    const result = await projectWorkspaceClient.moveWorkspaceProject(workspacePath, project.status, project.name, '后期中');
    if (!result.success || !result.project) { onNotice(`项目状态更新失败：${result.error || '未知错误'}`); return; }
    onNotice('导入完成，项目已移入“后期中”。');
    onProjectMoved(result.project);
  };
  const createFolder = async (targetRelativePath = currentRelativePath) => {
    setShowCreateMenu(false);
    const requestedProjectPath = project.path;
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const createDirectly = recursiveFlatOpen || versionTreeOpen || normalizedTarget !== normalizeProjectRelativePath(currentRelativePath);
    let folderName = '新建文件夹';
    if (createDirectly) {
      const answer = await appDialog.prompt({ title: localizedMessage("ui.new.folder.84244a"), message: localizedMessage("ui.enter.a.folder.name.5c96b4"), defaultValue: folderName, confirmLabel: localizedMessage("ui.new.50ef2f") });
      if (!answer?.trim()) return;
      folderName = answer.trim();
    }
    if (projectPathRef.current !== requestedProjectPath) return;
    const targetEntries = directoryEntriesCacheRef.current.get(normalizedTarget)
      || (normalizedTarget === normalizeProjectRelativePath(currentRelativePathRef.current) ? fileEntriesRef.current : []);
    const predictedName = predictUniqueDirectoryName(folderName, targetEntries.map(entry => entry.name));
    const requestedRelativePath = normalizeProjectRelativePath([normalizedTarget, predictedName].filter(Boolean).join('/'));
    const optimisticEntry: ProjectFileEntry = {
      name: predictedName, path: [project.path, requestedRelativePath].filter(Boolean).join('/'), relativePath: requestedRelativePath,
      kind: 'folder', extension: '', size: 0, createdAt: Date.now(), updatedAt: Date.now(),
    };
    const pendingOperation = startPendingFileOperation({
      kind: 'create',
      label: t("ui.creating.7c0305"),
      lockedPaths: [`__directory__/${normalizedTarget || '__root__'}`, requestedRelativePath],
      affectedDirectories: [normalizedTarget],
    });
    if (!pendingOperation) return;
    upsertOptimisticDirectoryEntry(normalizedTarget, optimisticEntry);
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.createProjectFolder>>;
    try { result = await projectWorkspaceClient.createProjectFolder(workspacePath, project.status, project.name, folderName, normalizedTarget, true); }
    catch (error) { if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; } removeOptimisticDirectoryEntry(normalizedTarget, requestedRelativePath); await reconcilePendingFileOperation(pendingOperation, undefined, true); onNotice(`新建文件夹失败：${error instanceof Error ? error.message : String(error)}`); return; }
    if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; }
    if (!result.success) { removeOptimisticDirectoryEntry(normalizedTarget, requestedRelativePath); await reconcilePendingFileOperation(pendingOperation, undefined, true); onNotice(`新建文件夹失败：${result.error || '未知错误'}`); return; }
    const relativePath = normalizeProjectRelativePath(result.folder?.relativePath || [...[normalizedTarget, result.folder?.name || folderName].filter(Boolean)].join('/'));
    const updatedAt = result.folder?.updatedAt || Date.now();
    const createdEntry: ProjectFileEntry = {
      name: result.folder?.name || folderName,
      path: result.folder?.path || [project.path, relativePath].filter(Boolean).join('/'),
      relativePath,
      kind: 'folder',
      extension: '',
      size: 0,
      createdAt: updatedAt,
      updatedAt,
    };
    upsertOptimisticDirectoryEntry(normalizedTarget, createdEntry, requestedRelativePath);
    refreshRecursiveResults(normalizedTarget);
    await reconcilePendingFileOperation(pendingOperation, { affectedDirectories: [normalizedTarget] });
    const canReveal = !createDirectly && mutatedEntryCanBeRevealed({
      requestedProjectPath,
      currentProjectPath: projectPathRef.current,
      mutationDirectoryPath: normalizedTarget,
      currentDirectoryPath: currentRelativePathRef.current,
      browseMode: browseModeRef.current,
    });
    if (!canReveal) {
      onNotice(`已在${normalizedTarget ? `“${normalizedTarget}”` : '项目根目录'}中新建文件夹“${result.folder?.name || folderName}”`);
      return;
    }
    selectAndRevealFileEntry(relativePath);
    setInlineRenamePath(relativePath);
    setInlineRenameValue(result.folder?.name || '新建文件夹');
  };
  useEffect(() => projectWorkspaceClient.onShellNewFileTypesChanged(types => {
    shellNewTypesRevision.current += 1;
    setShellNewTypes(types);
    setShellNewTypesLoaded(true);
  }), []);
  const loadShellNewTypes = async (refresh = false) => {
    if (shellNewTypesLoading || shellNewTypesLoaded && !refresh && Date.now() - shellNewTypesLastLoadedAt.current < 30000) return;
    setShellNewTypesLoading(true);
    const revision = shellNewTypesRevision.current;
    try {
      const result = await projectWorkspaceClient.getShellNewFileTypes(refresh);
      if (!result.success) { onNotice(`读取 Windows 新建文件类型失败：${result.error || '未知错误'}`); return; }
      if (revision !== shellNewTypesRevision.current) return;
      shellNewTypesLastLoadedAt.current = Date.now();
      setShellNewTypes(result.types);
      setShellNewTypesLoaded(true);
    } finally {
      setShellNewTypesLoading(false);
    }
  };
  const toggleCreateMenu = () => {
    const next = !showCreateMenu;
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setShowCreateMenu(next);
    if (next) void loadShellNewTypes();
  };
  const createShellNewFile = async (type: ShellNewFileType, targetRelativePath = currentRelativePath) => {
    setShowCreateMenu(false);
    const requestedProjectPath = project.path;
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const pendingOperation = startPendingFileOperation({
      kind: 'create', label: t("ui.creating.value0.d7f57d", { value0: type.label }),
      lockedPaths: [`__directory__/${normalizedTarget || '__root__'}`],
      affectedDirectories: [normalizedTarget],
    });
    if (!pendingOperation) return;
    setWorkspaceActivityMessage(`正在新建${type.label}…`);
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.createProjectShellNewFile>>;
    try { result = await projectWorkspaceClient.createProjectShellNewFile(workspacePath, project.status, project.name, normalizedTarget, type.id); }
    catch (error) { if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; } setWorkspaceActivityMessage(''); await reconcilePendingFileOperation(pendingOperation, undefined, true); onNotice(`新建${type.label}失败：${error instanceof Error ? error.message : String(error)}`); return; }
    if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; }
    setWorkspaceActivityMessage('');
    if (!result.success || !result.file) { await reconcilePendingFileOperation(pendingOperation, undefined, true); onNotice(`新建${type.label}失败：${result.error || '未知错误'}`); return; }
    const relativePath = normalizeProjectRelativePath(result.file.relativePath);
    upsertOptimisticDirectoryEntry(normalizedTarget, {
      ...result.file,
      relativePath,
      kind: 'file',
      extension: result.file.name.includes('.') ? `.${result.file.name.split('.').pop()!.toLocaleLowerCase()}` : '',
      size: 0,
      createdAt: result.file.updatedAt,
    });
    refreshRecursiveResults(normalizedTarget);
    await reconcilePendingFileOperation(pendingOperation, { affectedDirectories: [normalizedTarget] });
    const canReveal = mutatedEntryCanBeRevealed({
      requestedProjectPath,
      currentProjectPath: projectPathRef.current,
      mutationDirectoryPath: normalizedTarget,
      currentDirectoryPath: currentRelativePathRef.current,
      browseMode: browseModeRef.current,
    });
    if (!canReveal) {
      onNotice(`已在${normalizedTarget ? `“${normalizedTarget}”` : '项目根目录'}中新建${type.label}`);
      return;
    }
    selectAndRevealFileEntry(relativePath);
    setInlineRenamePath(relativePath);
    setInlineRenameValue(result.file.name);
  };
  const {
    progressAppendTarget, progressVersionIsValid, progressComparisonParent, resolvedProgressFolderName,
    progressNameHasConflict, progressVersionHasConflict, progressNameFromDisplayName,
    openProgressSetup, openManualImport, openMarkProgress,
    openNextProgressFromVersionTree, openEmptyProgressFromVersionTree,
  } = createProjectProgressSetup({
    workspacePath, project, currentRelativePath, gatherToProject, importDefaults, progressFolders, progressRelationInspection,
    versionGraphEdges, onNotice, loadProgressFolders, loadDirectoryPreviewEntries, closeProgressSetup,
    setShowCreateMenu, setShowImportMenu, setProgressImportCompletion, setProgressImportStatus,
    setProgressImportStep, setProgressSetup, setPanelImportResult, setFileImportTarget,
    setNegativeSourcePaths, setBrollSourcePaths, setDeleteBrollSources,
    setFileImportSourcePaths, setDeleteFileSources, setPanel, setFolderMarkSetup,
  });
  useProgressFolderOnboarding({
    active, versionTreeEnabled, projectWorkflows, workspacePath, project, rootRelativeFileEvents,
    mediaCacheConfig, appDialog, onNotice, loadProgressFolders, refresh: async (relativePath, options) => { await refresh(relativePath, options); }, currentRelativePathRef,
    directoryEntriesCacheRef, progressFoldersRef, exportCandidateTimersRef, exportCandidateChangedAtRef,
    offeredExportFoldersRef, setFolderMarkSetup, setPendingProgressFolders,
  });
  const projectRelativePath = useCallback((absolutePath: string) => {
    const normalizedRoot = project.path.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    return normalizedPath.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)
      ? normalizedPath.slice(normalizedRoot.length + 1)
      : normalizedPath.split('/').pop() || '';
  }, [project.path]);
  const setProgressTrackingState = (progressFolder: ProgressFolder, trackingState: ProgressFolder['trackingState']) => setProjectProgressTrackingState({ workspacePath, project, progressFolder, relativePath: progressFolderRelativePath(progressFolder), trackingState });
  const {
    submitProgressSetup, unregisterLegacyOrphanProgress, submitFolderMarkSetup,
    progressTrackingRefreshLabel, openProgressRepair,
    retryProgressRepair, refreshProgressTracking, commitProgressCompare, disableProgressTracking,
  } = createProjectProgressWorkflow({
    workspacePath, project, progressSetup, progressCompare, progressSubmitting, progressRepair, progressRepairBusy,
    workspaceActivityMessage, versionProgressId, versionGraphEdges, progressFolders, appDialog, onNotice,
    currentRelativePathRef, directoryEntriesCacheRef, progressFoldersRef, progressImportOperationIdRef,
    progressSubmittingRef, versionProgressLocationRef, loadProgressFolders, refresh: async (relativePath, options) => { await refresh(relativePath, options); }, handleProjectImportRecovery,
    adoptVersionTreeFolder: (...args) => adoptVersionTreeFolderRef.current(...args),
    progressAppendTarget, progressComparisonParent, progressFolderRelativePath, progressNameFromDisplayName,
    progressNameHasConflict, progressVersionHasConflict, progressVersionIsValid, resolvedProgressFolderName,
    progressNodeMediaKind, setFileEntries,
    setFolderMarkSetup, setPendingProgressFolders, setProgressCompare, setProgressFolders,
    setProgressImportCompletion, setProgressRepair, setProgressRepairBusy, setProgressSetup,
    setProgressSubmitting, setRootWatchFailed, setSelectedPaths, setTrackingConfirmationProgressId,
    setTrackingConfirmationSessionId, setVersionEntry, setVersionProgressId, setWorkspaceActivityMessage,
  });
  async function closeProgressCompare() {
    const current = progressCompare;
    if (!current || progressSubmitting) return;
    setProgressCompare(null);
    if (current.trackingRefreshMode !== 'refresh') return;
    try {
      await setProgressTrackingState(current.progressFolder, 'ready');
      await loadProgressFolders();
    } catch (error) {
      onNotice(`恢复原有跟踪状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const moveToTrash = async () => {
    const result = await projectWorkspaceClient.trashWorkspaceProject(workspacePath, project.status, project.name);
    if (!result.success) {
      if (isRecycleBinFailure(result.error, result.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
      else onNotice(`删除项目失败：${result.error || '未知错误'}`);
      return;
    }
    if (result.permanent) onNotice('项目已按 Windows 确认永久删除');
    onDeleted();
  };
  const closeImageConverterPanel = () => {
    conversionInspectionSequenceRef.current += 1;
    setConversionCollecting(false);
    setPanel(null);
  };
  const openImageConverter = async (targetPaths: string | string[]) => {
    const triggerAction = converterTriggerAction(panel === 'converter', projectPanelIsRunning('converter'));
    if (triggerAction === 'restore') { setPanel('converter'); return; }
    if (triggerAction === 'close') { closeImageConverterPanel(); return; }
    const requestedPaths = (Array.isArray(targetPaths) ? targetPaths : [targetPaths]).filter(Boolean);
    if (!requestedPaths.length) { onNotice('请先选择可转换的图片或包含图片的文件夹'); return; }
    const sequence = ++conversionInspectionSequenceRef.current;
    setConversionTargets([]);
    setConversionCollecting(true);
    setPanel('converter');
    while (sequence === conversionInspectionSequenceRef.current) {
      const result = await projectWorkspaceClient.inspectProjectToolSources(workspacePath, project.status, project.name, requestedPaths, false, false, true);
      if (sequence !== conversionInspectionSequenceRef.current) return;
      if (!result.success) {
        setConversionCollecting(false);
        onNotice(`读取图片索引失败：${result.error || '未知错误'}`);
        return;
      }
      if (result.indexed) {
        setConversionTargets(resolveInspectedToolSources(result.sources, result.folderPaths, result.convertibleImagePaths).map(source => source.path));
        setConversionCollecting(false);
        if (!result.convertibleImagePaths.length) onNotice('所选文件或文件夹中没有可转换的图片');
        return;
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, 800));
    }
  };
  const openScreenshotMainImage = (entries: ProjectFileEntry[]) => {
    if (projectPanelIsRunning('screenshot-main-image')) { setPanel('screenshot-main-image'); return; }
    const targets = entries.filter(isScreenshotMainImageEntry).map(entry => entry.relativePath);
    if (!targets.length) return;
    setScreenshotMainImageMode('extract');
    setScreenshotMainImageTargets(targets);
    setPanel('screenshot-main-image');
  };
  const analyzePreviewImageCrop = async (entry: ProjectFileEntry): Promise<PreviewImageCropAnalysis> => {
    if (!isScreenshotMainImageEntry(entry) || isUnsupportedShortcutContent(entry)) {
      return { success: false, error: '当前图片格式暂不支持裁剪' };
    }
    try {
      const analysis = await projectWorkspaceClient.extractScreenshotMainImages(workspacePath, project.status, project.name, [entry.relativePath], { analyzeOnly: true });
      const result = analysis.results[0];
      if (!result?.success || !result.crop || !result.originalSize) return { success: false, error: result?.error || analysis.error || '无法识别可裁剪范围' };
      return {
        success: true,
        crop: result.crop,
        originalSize: result.originalSize,
        snapGuides: result.snapGuides || { x: [0, result.originalSize.width], y: [0, result.originalSize.height] }
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const savePreviewImageCrop = async (entry: ProjectFileEntry, crop: CropRectangle, saveMode: 'replace' | 'new'): Promise<{ success: boolean; error?: string }> => {
    try {
      const extraction = await projectWorkspaceClient.extractScreenshotMainImages(workspacePath, project.status, project.name, [entry.relativePath], { crops: [crop], outputSuffix: '裁剪', saveMode });
      const result = extraction.results[0];
      if (!result?.success || !result.cropped) return { success: false, error: result?.error || extraction.error || '裁剪失败' };
      directoryEntriesCacheRef.current.clear();
      refreshRecursiveResults(projectRelativeParentPath(entry.relativePath));
      await refresh(currentRelativePathRef.current);
      if (finalViewOpen) await loadFinalViewEntries();
      onNotice(saveMode === 'replace' ? `已保存裁剪：${entry.name}` : `已另存为：${result.outputName || '已在原图旁生成裁剪图片'}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const selectEntryRange = (relativePath: string, additive: boolean) => {
    selectProjectFileRange(relativePath, additive, displayedFileEntries);
  };
  const beginInlineRename = (relativePath: string) => {
    const entry = activeFileEntries.find(candidate => candidate.relativePath === relativePath);
    if (!entry) return;
    if (pendingPathConflicts(pendingFileOperationsRef.current, [relativePath])) { onNotice('该项目正在处理中，请稍后再试'); return; }
    if (isProtectedRenameEntry(entry)) { onNotice('该文件夹由工作流管理，请使用“修改进度”。'); return; }
    fileInteractionRevisionRef.current += 1;
    setSelectedPaths([relativePath]);
    setInlineRenamePath(relativePath);
    setInlineRenameValue(entry.name);
  };
  const getInlineRenameSelectionEnd = (entry: ProjectFileEntry) => {
    if (isFolderLikeEntry(entry) || !entry.extension || !entry.name.toLocaleLowerCase().endsWith(entry.extension.toLocaleLowerCase())) return entry.name.length;
    return entry.name.length - entry.extension.length;
  };
  const cancelInlineRename = () => {
    setInlineRenamePath('');
    setInlineRenameValue('');
  };
  const commitInlineRename = async () => {
    if (!inlineRenamePath || pendingPathConflicts(pendingFileOperationsRef.current, [inlineRenamePath])) return;
    const interactionRevision = fileInteractionRevisionRef.current;
    const sourcePath = inlineRenamePath;
    const sourceDirectoryPath = finalViewOpen ? projectRelativeParentPath(sourcePath) : normalizeProjectRelativePath(currentRelativePathRef.current);
    const requestedProjectPath = project.path;
    const entry = activeFileEntries.find(candidate => candidate.relativePath === sourcePath);
    const nextName = inlineRenameValue.trim();
    if (!entry || !nextName || nextName === entry.name) { cancelInlineRename(); return; }
    if (isProtectedRenameEntry(entry)) { cancelInlineRename(); onNotice('该文件夹由项目工作流管理，不能普通重命名。'); return; }
    const progressFolder = registeredProgressFolderForEntry(entry);
    const pathSeparatorIndex = Math.max(entry.path.lastIndexOf('/'), entry.path.lastIndexOf('\\'));
    const optimisticName = nextName;
    const optimisticRelativePath = normalizeProjectRelativePath(`${sourceDirectoryPath}/${optimisticName}`);
    const optimisticPhysicalPath = `${pathSeparatorIndex >= 0 ? entry.path.slice(0, pathSeparatorIndex + 1) : ''}${optimisticName}`;
    const optimisticRenameEntry: PendingProjectFileEntry = {
      ...entry,
      name: optimisticName,
      path: optimisticPhysicalPath,
      relativePath: optimisticRelativePath,
      pendingSourceRelativePath: sourcePath,
    };
    const pendingOperation = startPendingFileOperation({
      kind: 'rename', label: t("ui.renaming.f5dee6"), lockedPaths: [sourcePath, optimisticRelativePath], affectedDirectories: [sourceDirectoryPath],
      tombstonePaths: [sourcePath],
      optimisticEntries: [optimisticRenameEntry],
    });
    if (!pendingOperation) return;
    cancelInlineRename();
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.projectFileOperation>> | Awaited<ReturnType<typeof projectWorkspaceClient.renameProgressFolder>>;
    try {
      result = await (progressFolder?.nodeRole === 'progress'
        ? projectWorkspaceClient.renameProgressFolder(workspacePath, project.status, project.name, {
          progressId: progressFolder.id,
          expectedFolderId: progressFolder.folderId,
          expectedRelativePath: progressFolderRelativePath(progressFolder),
          newName: nextName,
        })
        : projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, 'rename', [sourcePath], sourceDirectoryPath, nextName));
    } catch (error) {
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      await reconcilePendingFileOperation(pendingOperation, undefined, true);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      settleDirectoryPreviewRenames([optimisticRenameEntry], false);
      onNotice(`重命名失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; }
    if (!result.success) {
      await reconcilePendingFileOperation(pendingOperation, 'affectedDirectories' in result ? result : undefined, true);
      settleDirectoryPreviewRenames([optimisticRenameEntry], false);
      onNotice(`重命名失败：${result.error || '未知错误'}`);
      return;
    }
    const renamedPath = ('newRelativePath' in result ? result.newRelativePath : undefined)
      || ('movedItems' in result ? renamedEntryDestinationPath(sourcePath, nextName, result.movedItems) : normalizeProjectRelativePath(`${sourceDirectoryPath}/${nextName}`));
    if (finalViewOpen) {
      clearPendingFileOperation(pendingOperation.id);
      settleDirectoryPreviewRenames([optimisticRenameEntry], true);
      setSelectedPaths(current => current.map(path => path === sourcePath ? renamedPath : path));
      setPreviewPath(current => current === sourcePath ? renamedPath : current);
      setPreviewMediaPath(current => current === sourcePath ? renamedPath : current);
      await loadFinalViewEntries();
      onNotice(`已重命名为“${nextName}”`);
      return;
    }
    const renamedName = renamedPath.split('/').pop() || nextName;
    if (normalizeProjectRelativePath(currentRelativePathRef.current) === sourceDirectoryPath) refreshSequenceRef.current += 1;
    upsertOptimisticDirectoryEntry(sourceDirectoryPath, {
      ...entry,
      name: renamedName,
      path: `${pathSeparatorIndex >= 0 ? entry.path.slice(0, pathSeparatorIndex + 1) : ''}${renamedName}`,
      relativePath: renamedPath,
    }, sourcePath);
    // The backend has committed the rename and the cache now holds its actual
    // destination. Directory/metadata refreshes must not extend the write lock.
    clearPendingFileOperation(pendingOperation.id);
    settleDirectoryPreviewRenames([optimisticRenameEntry], true);
    refreshRecursiveResults(sourceDirectoryPath);
    if (progressFolder?.nodeRole === 'progress') {
      const renamedProgress = 'progressFolder' in result ? result.progressFolder : undefined;
      if (renamedProgress) {
        progressFoldersRef.current = progressFoldersRef.current.map(folder => folder.id === renamedProgress.id ? renamedProgress : folder);
        setProgressFolders(current => current.map(folder => folder.id === renamedProgress.id ? renamedProgress : folder));
        if (versionProgressId === renamedProgress.id) {
          const previousLocation = versionProgressLocationRef.current;
          const nextLocation = { progressId: renamedProgress.id, folderPath: renamedProgress.folderPath, relativePath: renamedPath };
          if (previousLocation) setVersionEntry(current => current ? remapEntryAfterProgressFolderMove(current, previousLocation, nextLocation) : current);
          versionProgressLocationRef.current = nextLocation;
        }
      }
    }
    const canReveal = mutatedEntryCanBeRevealed({
      requestedProjectPath,
      currentProjectPath: projectPathRef.current,
      mutationDirectoryPath: sourceDirectoryPath,
      currentDirectoryPath: currentRelativePathRef.current,
      browseMode: browseModeRef.current,
    });
    if (canReveal && fileInteractionRevisionRef.current === interactionRevision
      && selectedPathsRef.current.length === 1 && selectedPathsRef.current[0] === sourcePath) selectAndRevealFileEntry(renamedPath);
    else setSelectedPaths(current => current.map(path => path === sourcePath ? renamedPath : path));
    onNotice(`已重命名为“${nextName}”`);
    scheduleDirectoryRefresh(operationRefreshDirectories(pendingOperation, 'affectedDirectories' in result ? result : undefined));
    if (progressFolder?.nodeRole === 'progress') await loadProgressFolders();
  };
  const beginRename = (targetPaths = selectedPaths) => {
    if (!targetPaths.length) return;
    if (activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isUnsupportedShortcutContent(entry))) { onNotice('普通快捷方式中的文件是只读浏览内容，不能在项目中重命名'); return; }
    if (activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isProtectedRenameEntry(entry))) { onNotice('所选内容包含工作流文件夹，请使用“修改进度”。'); return; }
    const registeredProgressEntries = activeFileEntries.filter(entry => targetPaths.includes(entry.relativePath) && registeredProgressFolderForEntry(entry)?.nodeRole === 'progress');
    if (registeredProgressEntries.length && targetPaths.length > 1) { onNotice('已登记版本目录暂不支持批量或混合批量重命名，请单独重命名。'); return; }
    if (targetPaths.length === 1) {
      beginInlineRename(targetPaths[0]);
      return;
    }
    if (targetPaths !== selectedPaths) setSelectedPaths(targetPaths);
    setBatchRenameParts([
      createBatchRenamePart('text'),
      createBatchRenamePart('sequence')
    ]);
    setBatchExtensionMode('preserve');
    setBatchExtensionValue('');
    setBatchRenameOpen(true);
  };
  const batchRenameEntries = selectedPaths.map(relativePath => activeFileEntries.find(entry => entry.relativePath === relativePath)).filter((entry): entry is ProjectFileEntry => Boolean(entry));
  const buildBatchRenameNames = () => batchRenameEntries.map((entry, index) => {
    const extension = isFolderLikeEntry(entry) || !entry.extension ? '' : entry.name.slice(-entry.extension.length);
    const originalName = extension && entry.name.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase()) ? entry.name.slice(0, -extension.length) : entry.name;
    let name = '';
    for (const part of batchRenameParts) {
      if (part.type === 'text') name += part.value;
      if (part.type === 'original') {
        name += part.caseMode === 'upper' ? originalName.toLocaleUpperCase() : part.caseMode === 'lower' ? originalName.toLocaleLowerCase() : originalName;
      }
      if (part.type === 'sequence') name += String(part.sequenceStart + index).padStart(part.sequenceDigits, '0');
      if (part.type === 'letter') name += formatBatchRenameLetter(index, part.letterCase);
      if (part.type === 'datetime') {
        const timestamp = part.dateSource === 'created' ? entry.createdAt || entry.updatedAt : entry.updatedAt;
        name += formatBatchRenameDate(timestamp ? new Date(timestamp) : new Date(), part.dateFormat);
      }
      if (part.type === 'replace') name += part.find ? originalName.split(part.find).join(part.replace) : originalName;
    }
    if (!isFolderLikeEntry(entry)) {
      const replacementExtension = batchExtensionValue.trim();
      name += batchExtensionMode === 'preserve' ? extension : replacementExtension ? `${replacementExtension.startsWith('.') ? '' : '.'}${replacementExtension}` : '';
    }
    return name.trim();
  });
  const updateBatchRenamePart = (id: string, changes: Partial<BatchRenamePart>) => {
    setBatchRenameParts(parts => parts.map(part => part.id === id ? { ...part, ...changes } : part));
  };
  const insertBatchRenamePart = (index: number) => {
    setBatchRenameParts(parts => {
      const next = [...parts];
      next.splice(index + 1, 0, createBatchRenamePart());
      return next;
    });
  };
  const moveDraggedBatchRenamePart = (targetId: string) => {
    if (!draggedBatchRenamePartId || draggedBatchRenamePartId === targetId) return;
    setBatchRenameParts(parts => {
      const sourceIndex = parts.findIndex(part => part.id === draggedBatchRenamePartId);
      const targetIndex = parts.findIndex(part => part.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return parts;
      const next = [...parts];
      const [dragged] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, dragged);
      return next;
    });
  };
  const batchRenameNames = buildBatchRenameNames();
  const commitBatchRename = async () => {
    if (!batchRenameNames.length || batchRenameNames.some(name => !name) || selectedPaths.length < 2
      || pendingPathConflicts(pendingFileOperationsRef.current, selectedPaths)) return;
    const requestedProjectPath = projectPathRef.current;
    if (batchRenameEntries.length !== selectedPaths.length || batchRenameNames.length !== selectedPaths.length) {
      onNotice('所选文件已变化，请重新选择后再批量重命名。');
      return;
    }
    if (batchRenameEntries.some(entry => registeredProgressFolderForEntry(entry)?.nodeRole === 'progress')) { onNotice('已登记版本目录暂不支持批量或混合批量重命名，请单独重命名。'); return; }
    const sourcePaths = [...selectedPaths];
    const requestedNames = [...batchRenameNames];
    const optimisticEntries: PendingProjectFileEntry[] = batchRenameEntries.map((entry, index) => {
      const requestedName = requestedNames[index];
      const name = requestedName;
      const parentPath = projectRelativeParentPath(entry.relativePath);
      const relativePath = normalizeProjectRelativePath(`${parentPath}/${name}`);
      const separatorIndex = Math.max(entry.path.lastIndexOf('/'), entry.path.lastIndexOf('\\'));
      return { ...entry, name, path: `${separatorIndex >= 0 ? entry.path.slice(0, separatorIndex + 1) : ''}${name}`, relativePath, pendingSourceRelativePath: batchRenameEntries[index].relativePath };
    });
    const pendingOperation = startPendingFileOperation({
      kind: 'rename', label: t("ui.renaming.items.9c6146"), lockedPaths: [...sourcePaths, ...optimisticEntries.map(entry => entry.relativePath)],
      affectedDirectories: [...new Set(sourcePaths.map(projectRelativeParentPath))], tombstonePaths: sourcePaths, optimisticEntries,
    });
    if (!pendingOperation) return;
    setBatchRenameOpen(false);
    setBatchRenameParts([]);
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.projectFileOperation>>;
    try {
      result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, 'rename', sourcePaths, currentRelativePath, '批量重命名', { renameNames: requestedNames });
    } catch (error) {
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      await reconcilePendingFileOperation(pendingOperation, undefined, true);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      settleDirectoryPreviewRenames(optimisticEntries, false);
      onNotice(`批量重命名失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
    if (!result.success) {
      await reconcilePendingFileOperation(pendingOperation, result, true);
      settleDirectoryPreviewRenames(optimisticEntries, false);
      onNotice(`批量重命名失败：${result.error || '未知错误'}`);
      return;
    }
    const count = sourcePaths.length;
    setSelectedPaths(current => current.filter(path => !sourcePaths.includes(path)));
    onNotice(`已批量重命名 ${count} 个项目`);
    if (finalViewOpen) {
      clearPendingFileOperation(pendingOperation.id);
      settleDirectoryPreviewRenames(optimisticEntries, true);
      await loadFinalViewEntries();
    } else {
      await reconcilePendingFileOperation(pendingOperation, result);
      settleDirectoryPreviewRenames(optimisticEntries, true);
    }
  };
  const openFileMenuAt = (x: number, y: number, entry: ProjectFileEntry, selectEntry = true) => {
    filesSurfaceRef.current?.focus({ preventScroll: true });
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setSurfaceMenu(null);
    setOperationDirectoryPath(isUnsupportedShortcutContent(entry) ? currentRelativePath : projectRelativeParentPath(entry.relativePath));
    fileMenuSelectionSnapshotRef.current = [...selectedPaths];
    fileMenuSelectionAnchorSnapshotRef.current = selectionAnchorPathRef.current;
    fileMenuSelectionWasImplicitRef.current = selectEntry && !selectedPaths.includes(entry.relativePath);
    if (selectEntry) {
      if (!selectedPaths.includes(entry.relativePath)) selectionAnchorPathRef.current = entry.relativePath;
      setSelectedPaths(current => current.includes(entry.relativePath) ? current : [entry.relativePath]);
    }
    setFileMenu({ entry, x, y });
  };
  const openFileMenu = (event: React.MouseEvent, entry: ProjectFileEntry, selectEntry = true) => {
    event.preventDefault();
    event.stopPropagation();
    openFileMenuAt(event.clientX, event.clientY, entry, selectEntry);
  };
  const openSurfaceMenu = (event: React.MouseEvent<HTMLElement>, targetRelativePath = currentRelativePath, targetLabel = '') => {
    if (versionTreeOpen) {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target as Element;
      const blankCanvas = target.closest('[data-version-tree-canvas]') && !target.closest('[data-version-tree-node],[data-edge-id],[data-edge-child-handle],button');
      if (!blankCanvas || normalizeProjectRelativePath(currentRelativePath) || !versionTreeModeAvailableFor()) return;
      filesSurfaceRef.current?.focus({ preventScroll: true });
      window.dispatchEvent(new Event('photoflow-menu-open'));
      setFileMenu(null);
      selectionAnchorPathRef.current = '';
      setSelectedPaths([]);
      setOperationDirectoryPath('');
      setSurfaceMenu({ x: event.clientX, y: event.clientY, targetRelativePath: '', targetLabel: '项目根目录', kind: 'version-tree-layout' });
      void loadShellNewTypes();
      return;
    }
    if ((event.target as HTMLElement).closest('[data-entry-path]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (finalViewOpen) return;
    filesSurfaceRef.current?.focus({ preventScroll: true });
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setFileMenu(null);
    selectionAnchorPathRef.current = '';
    setSelectedPaths([]);
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    setOperationDirectoryPath(normalizedTarget);
    setSurfaceMenu({ x: event.clientX, y: event.clientY, targetRelativePath: normalizedTarget, targetLabel: targetLabel || normalizedTarget || '项目根目录', kind: 'files' });
    void loadShellNewTypes();
  };
  const restoreStandardVersionTreeLayout = async () => {
    const controller = versionTreeCanvasControllerRef.current;
    setSurfaceMenu(null);
    if (!versionTreeOpen || normalizeProjectRelativePath(currentRelativePath) || !versionTreeModeAvailableFor() || !controller) return;
    if (controller.hasManualLayout) {
      const confirmed = await appDialog.confirm({
        title: localizedMessage("ui.reset.the.version.tree.layout.e65f61"),
        message: localizedMessage("ui.restore.the.standard.layout.version.relationships.fa315d"),
        confirmLabel: localizedMessage("ui.refresh.aee887"),
      });
      if (!confirmed) return;
    }
    const success = await controller.refreshLayout();
    if (success) onNotice('版本树已恢复标准排版');
  };
  const showDirectory = (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const returnEntryPath = directoryEntryToRevealOnReturn(currentRelativePathRef.current, normalizedPath);
    pendingDirectoryReturnRevealRef.current = returnEntryPath ? { directoryPath: normalizedPath, entryPath: returnEntryPath } : null;
    setDirectoryReturnHighlightPath('');
    setPreviewHighlightPath('');
    // Invalidate the directory that is still loading before React commits the
    // breadcrumb change, so its late result cannot replace the new folder.
    refreshSequenceRef.current += 1;
    currentRelativePathRef.current = normalizedPath;
    const cachedEntries = directoryEntriesCacheRef.current.get(normalizedPath);
    if (cachedEntries) {
      renderedDirectoryRef.current = { path: normalizedPath, ready: true };
      setFileEntries(cachedEntries);
      setDirectoryLoading(false);
    } else {
      renderedDirectoryRef.current = { path: normalizedPath, ready: false };
      setFileEntries([]);
      setDirectoryLoading(true);
    }
    setSearchOpen(false);
    setSearchQuery('');
    setBrowseMode(browseModeForFolder(normalizedPath));
    setGridIconSize(gridIconSizeForFolder(normalizedPath));
    setCurrentRelativePath(normalizedPath);
  };
  const navigateToDirectory = (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (normalizedPath === currentRelativePath) return;
    setDirectoryHistory(current => ({ back: [...current.back, currentRelativePath], forward: [] }));
    showDirectory(normalizedPath);
  };
  const showVersionTree = () => {
    if (!versionTreeModeAvailableFor()) return;
    setFinalViewOpen(false);
    setSelectedPaths([]);
    setPreviewPath('');
    setPreviewHighlightPath('');
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setSearchOpen(false);
    setSearchQuery('');
    setFileFilter('all');
    rememberFolderBrowseMode(currentRelativePath, 'version-tree');
    setBrowseMode('version-tree');
    if (!progressFoldersReady) {
      void loadProgressFoldersSnapshot().then(() => {
        if (activeRef.current) void loadProgressFolders();
      });
    }
  };
  useEffect(() => {
    if (!navigationRequest) return;
    navigateToDirectory(navigationRequest.path);
  }, [navigationRequest?.id]);
  const navigateBack = () => {
    const target = directoryHistory.back[directoryHistory.back.length - 1];
    if (target === undefined) return;
    setDirectoryHistory(current => ({ back: current.back.slice(0, -1), forward: [currentRelativePath, ...current.forward] }));
    showDirectory(target);
  };
  const navigateForward = () => {
    const target = directoryHistory.forward[0];
    if (target === undefined) return;
    setDirectoryHistory(current => ({ back: [...current.back, currentRelativePath], forward: current.forward.slice(1) }));
    showDirectory(target);
  };
  const openProjectEntry = async (entry: ProjectFileEntry, external = false) => {
    if (isFolderLikeEntry(entry) && !external) { navigateToDirectory(entry.relativePath); return; }
    if (entry.viaShortcut) {
      const linkedResult = await projectWorkspaceClient.openMediaVersion(entry.path);
      if (!linkedResult.success) onNotice(`打开快捷方式中的文件失败：${linkedResult.error || '无法打开文件'}`);
      return;
    }
    if (entry.kind === 'shortcut') {
      const shortcut = await projectWorkspaceClient.resolveProjectShortcut(workspacePath, project.status, project.name, entry.relativePath);
      if (!shortcut.success || !shortcut.target) { onNotice(`打开快捷方式失败：${shortcut.error || '目标不存在'}`, 6000); return; }
      const inspirationRoot = inspirationLibraryRootPath?.trim().replace(/\\/g, '/').replace(/\/+$/g, '') || '';
      const shortcutTarget = shortcut.target.replace(/\\/g, '/').replace(/\/+$/g, '');
      const normalizedRoot = inspirationRoot.toLocaleLowerCase();
      const normalizedTarget = shortcutTarget.toLocaleLowerCase();
      if (shortcut.targetKind === 'folder' && inspirationRoot && onOpenInspirationPath && (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`))) {
        onOpenInspirationPath(shortcutTarget.slice(inspirationRoot.length).replace(/^\/+/, ''));
        return;
      }
    }
    const result = await projectWorkspaceClient.openProjectEntry(workspacePath, project.status, project.name, entry.relativePath);
    if (!result.success) onNotice(`打开文件失败：${result.error || '无法打开文件'}`);
  };


  const progressFolderForMediaEntry = (entry?: ProjectFileEntry) => {
    if (!entry || !['image', 'raw', 'video'].includes(entry.kind)) return undefined;
    const mediaKind = entry.kind === 'video' ? 'video' : 'image';
    const entryPath = entry.path.replace(/\\/g, '/').toLocaleLowerCase();
    return progressFolders.find(folder => {
      const folderPath = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      return folder.mediaKind === mediaKind && !folder.folderMissing
        && folder.nodeRole !== 'selection' && folder.relationKind !== 'auxiliary'
        && (entryPath === folderPath || entryPath.startsWith(`${folderPath}/`));
    });
  };
  const hasVersionProgressForEntry = (entry?: ProjectFileEntry) => Boolean(progressFolderForMediaEntry(entry));
  const versionProgressFolder = versionProgressId ? progressFolders.find(folder => folder.id === versionProgressId) : undefined;
  const versionProgressLocation = versionProgressFolder && !versionProgressFolder.folderMissing ? {
    progressId: versionProgressFolder.id,
    folderPath: versionProgressFolder.folderPath,
    relativePath: progressFolderRelativePath(versionProgressFolder),
  } : null;
  const renderedVersionEntry = versionEntry && versionProgressLocationRef.current && versionProgressLocation
    ? remapEntryAfterProgressFolderMove(versionEntry, versionProgressLocationRef.current, versionProgressLocation)
    : versionEntry;
  useEffect(() => {
    if (!versionProgressLocation) return;
    const previousLocation = versionProgressLocationRef.current;
    if (versionEntry && previousLocation?.progressId === versionProgressLocation.progressId) {
      setVersionEntry(current => current ? remapEntryAfterProgressFolderMove(current, previousLocation, versionProgressLocation) : current);
    }
    versionProgressLocationRef.current = versionProgressLocation;
  }, [versionProgressLocation?.folderPath, versionProgressLocation?.progressId, versionProgressLocation?.relativePath]);
  const openVersions = (entry?: ProjectFileEntry) => {
    const target = entry || selectedEntries[0];
    if (!target || !['image', 'raw', 'video'].includes(target.kind)) {
      onNotice('请先选择一张图片、RAW 或视频');
      return;
    }
    const targetProgressFolder = progressFolderForMediaEntry(target);
    if (!targetProgressFolder) {
      onNotice(`项目尚未录入${target.kind === 'video' ? '视频' : '图片'}进度，请先标记或导入版本进度`);
      return;
    }
    if (workspaceWindowContext()) {
      onOpenToolTab('version', `版本 · ${target.name}`, { entry: target, progressId: targetProgressFolder.id, progressVersionKey: targetProgressFolder.versionKey });
      return;
    }
    versionProgressLocationRef.current = {
      progressId: targetProgressFolder.id,
      folderPath: targetProgressFolder.folderPath,
      relativePath: progressFolderRelativePath(targetProgressFolder),
    };
    setVersionProgressId(targetProgressFolder.id);
    setVersionEntry(target);
    onOpenToolTab('version', `版本 · ${target.name}`);
  };
  const exportFinalVersions = async () => {
    if (finalExporting) return;
    const summary = await loadFinalVersionSummary();
    if (!summary.count) return;
    if (summary.missingCount) {
      onNotice(`有 ${summary.missingCount} 个喜爱图片已被删除或移动，请先重新定位。`, 7000);
      return;
    }
    const latestFolders = await loadProgressFolders();
    const explicitParent = selectableVersionParents(latestFolders, { mediaKind: 'image', relationKind: 'main' })
      .find(folder => folder.id === finalExportParentId);
    if (!explicitParent) {
      onNotice('请先选择喜爱图片新进度要连接的父节点', 6000);
      return;
    }
    const latestRootNumber = latestFolders
      .filter(folder => folder.mediaKind === 'image' && /^\d+$/.test(folder.versionKey))
      .reduce((highest, folder) => Math.max(highest, Number(folder.versionKey)), 0);
    const expectedName = `图片后期_${latestRootNumber + 1}_喜爱`;
    if (!await appDialog.confirm({
      title: localizedMessage("ui.organize.liked.images.6ba9b0"),
      message: localizedMessage("ui.copy.liked.images.into.new.progress.b930cb", { value0: summary.availableCount, value1: expectedName }),
      confirmLabel: localizedMessage("ui.create.and.copy.11b9c2"),
    })) return;
    setFinalExporting(true);
    try {
      const result = await projectWorkspaceClient.exportFinalVersions(workspacePath, project.status, project.name, { parentProgressId: explicitParent.id });
      if (!result.success || !result.folder) throw new Error(result.error || '无法整理喜爱图片');
      directoryEntriesCacheRef.current.clear();
      await loadProgressFolders();
      await loadFinalVersionSummary();
      setFinalViewOpen(false);
      setFinalViewEntries([]);
      setSelectedPaths([]);
      setPreviewPath('');
      setPreviewHighlightPath('');
      setPreviewPaneOpen(previewPanePinnedRef.current);
      setMetadataPaneOpen(metadataPanePinnedRef.current);
      navigateToDirectory(result.folder.relativePath);
      onNotice(`成功复制文件：已将 ${result.count} 张喜爱图片放入“${result.displayName}”。`, 6000);
    } catch (error) {
      onNotice(`整理喜爱图片失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally {
      setFinalExporting(false);
    }
  };
  const openProjectEntriesInPhotoshop = async (entries: ProjectFileEntry[]) => {
    const imagePaths = entries.filter(entry => entry.kind === 'image' || entry.kind === 'raw').map(entry => entry.relativePath);
    if (!imagePaths.length) return;
    const result = await projectWorkspaceClient.openProjectEntriesInPhotoshop(workspacePath, project.status, project.name, imagePaths);
    if (!result.success) onNotice(`用 Photoshop 打开失败：${result.error || '无法打开文件'}`);
  };
  const copyEntryPath = async (entry: ProjectFileEntry) => {
    if (entry.viaShortcut) {
      try {
        await navigator.clipboard.writeText(entry.path);
        onNotice('成功复制文件地址');
      } catch {
        onNotice('复制文件地址失败');
      }
      return;
    }
    const result = await projectWorkspaceClient.copyProjectEntryPath(workspacePath, project.status, project.name, entry.relativePath);
    const typeLabel = isFolderLikeEntry(entry) ? '文件夹' : '文件';
    onNotice(result.success ? '成功复制文字' : `复制${typeLabel}地址失败：${result.error || '未知错误'}`);
  };
  const copyEntryPaths = async (entries: readonly ProjectFileEntry[]) => {
    if (entries.length === 1) {
      await copyEntryPath(entries[0]);
      return;
    }
    if (!entries.length) return;
    try {
      await navigator.clipboard.writeText(entries.map(entry => entry.path).join('\n'));
      onNotice(`已复制 ${entries.length} 个项目的地址`);
    } catch {
      onNotice('复制项目地址失败');
    }
  };
  const copyCurrentDirectoryPath = async (targetRelativePath = currentRelativePath) => {
    const result = await projectWorkspaceClient.copyProjectEntryPath(workspacePath, project.status, project.name, targetRelativePath);
    onNotice(result.success ? '成功复制文字' : `复制文件夹地址失败：${result.error || '未知错误'}`);
  };
  const dismissPreviewFromBlankClick = (drag: NonNullable<typeof selectionDragRef.current>) => {
    if (drag.started || drag.additive) return;
    if (previewPath && (previewPaneOpen || metadataPaneOpen)) {
      paneLayoutRevealPathRef.current = previewPath;
      paneLayoutRevealPendingRef.current = true;
    }
    setPreviewPath('');
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    setPreviewMediaPath('');
    setViewportCurrentPath('');
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
  };
  const stopSelectionAutoScroll = () => {
    window.cancelAnimationFrame(selectionAutoScrollFrameRef.current);
    selectionAutoScrollFrameRef.current = 0;
  };
  const getMarqueeFormulaLayout = () => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (!container || !surface) return null;
    const containerRect = container.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const surfaceTop = surfaceRect.top - containerRect.top + container.scrollTop;
    const contentWidth = fileSurfaceContentWidth(surface.clientWidth);
    if (viewMode === 'list') {
      return {
        kind: 'list' as const,
        rowHeight: Math.max(1, virtualWindowRef.current.rowHeight || FILE_LIST_ROW_HEIGHT),
        columnWidth: contentWidth,
        gap: 0,
        padding: { ...FILE_SURFACE_PADDING, top: surfaceTop + FILE_LIST_HEADER_HEIGHT },
      };
    }
    const measuredItemHeight = surface.querySelector<HTMLElement>('[data-entry-path]')?.getBoundingClientRect().height;
    const geometry = calculateFileGridGeometry(surface.clientWidth, gridIconSize, measuredItemHeight || virtualWindowRef.current.rowHeight || undefined);
    return { ...geometry, padding: { ...geometry.padding, top: surfaceTop } };
  };
  const rebuildMarqueeLayoutRegistry = () => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (!container || !surface) return marqueeLayoutRegistryRef.current;
    const containerRect = container.getBoundingClientRect();
    const registry = new Map<string, MarqueeRect>();
    for (const node of surface.querySelectorAll<HTMLElement>('[data-entry-path]')) {
      const path = node.dataset.entryPath;
      if (!path) continue;
      const rect = node.getBoundingClientRect();
      // Grouped search results and the ordinary file layout currently coexist
      // in the DOM. The ordinary layout is hidden, so its duplicate entry
      // nodes report zero-sized rectangles and must not overwrite the visible
      // search-result geometry registered under the same relative path.
      if (rect.width <= 0 || rect.height <= 0) continue;
      registry.set(path, normalizeMarqueeRect(
        { x: rect.left - containerRect.left + container.scrollLeft, y: rect.top - containerRect.top + container.scrollTop },
        { x: rect.right - containerRect.left + container.scrollLeft, y: rect.bottom - containerRect.top + container.scrollTop },
      ));
    }
    marqueeLayoutRegistryRef.current = registry;
    return registry;
  };
  const updateSelectionDragAtPoint = (clientX: number, clientY: number) => {
    const drag = selectionDragRef.current;
    const container = filesColumnRef.current;
    if (!drag || !container || !drag.started) return;
    const containerRect = container.getBoundingClientRect();
    const current = viewportPointToContentPoint({ x: clientX, y: clientY }, {
      viewportLeft: containerRect.left,
      viewportTop: containerRect.top,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    });
    const selection = normalizeMarqueeRect({ x: drag.startContentX, y: drag.startContentY }, current);
    setSelectionBox({ left: selection.left, top: selection.top, width: selection.width, height: selection.height });
    let hits: string[];
    let logicalWidth = Math.max(container.clientWidth, selection.right);
    let logicalHeight = Math.max(container.clientHeight, selection.bottom);
    if (groupedResultsActive || versionTreeOpen) {
      const registry = rebuildMarqueeLayoutRegistry();
      hits = Array.from(registry.entries()).filter(([, rect]) => rectanglesIntersect(selection, rect)).map(([path]) => path);
      const surface = filesSurfaceRef.current;
      if (surface) {
        const surfaceRect = surface.getBoundingClientRect();
        const surfaceLeft = surfaceRect.left - containerRect.left + container.scrollLeft;
        const surfaceTop = surfaceRect.top - containerRect.top + container.scrollTop;
        logicalWidth = Math.max(logicalWidth, surfaceLeft + surface.scrollWidth);
        logicalHeight = Math.max(logicalHeight, surfaceTop + surface.scrollHeight);
      }
      for (const rect of registry.values()) {
        logicalWidth = Math.max(logicalWidth, rect.right);
        logicalHeight = Math.max(logicalHeight, rect.bottom);
      }
    } else {
      const layout = getMarqueeFormulaLayout();
      if (!layout) return;
      hits = hitMarqueeIndices(selection, displayedFileEntries.length, layout).map(index => displayedFileEntries[index].relativePath);
      const size = finiteLogicalCanvasSize(displayedFileEntries.length, layout, { width: container.clientWidth, height: container.clientHeight }, selection);
      logicalWidth = size.width;
      logicalHeight = size.height;
    }
    setSelectionCanvasSize(currentSize => currentSize.width === logicalWidth && currentSize.height === logicalHeight ? currentSize : { width: logicalWidth, height: logicalHeight });
    setSelectedPaths(mergeMarqueeSelection(drag.initialPaths, hits, drag.additive));
  };
  const runSelectionAutoScroll = () => {
    selectionAutoScrollFrameRef.current = 0;
    const drag = selectionDragRef.current;
    const container = filesColumnRef.current;
    if (!drag || !drag.started || !container) return;
    const result = advanceMarqueeAutoScroll(container, { clientX: drag.lastClientX, clientY: drag.lastClientY });
    if (!result.edgeActive) return;
    if (result.scrolled) updateSelectionDragAtPoint(drag.lastClientX, drag.lastClientY);
    // Keep retrying while the pointer remains at an edge. The logical canvas
    // state may have grown even when its DOM scroll dimensions have not yet
    // been committed during this frame.
    selectionAutoScrollFrameRef.current = window.requestAnimationFrame(runSelectionAutoScroll);
  };
  const queueSelectionAutoScroll = () => {
    const drag = selectionDragRef.current;
    const container = filesColumnRef.current;
    if (!drag?.started || !container) return;
    const containerRect = container.getBoundingClientRect();
    const deltaY = marqueeAutoScrollDelta(drag.lastClientY, containerRect.top, containerRect.bottom);
    const deltaX = marqueeAutoScrollDelta(drag.lastClientX, containerRect.left, containerRect.right);
    if (!deltaY && !deltaX) {
      stopSelectionAutoScroll();
      return;
    }
    if (!selectionAutoScrollFrameRef.current) selectionAutoScrollFrameRef.current = window.requestAnimationFrame(runSelectionAutoScroll);
  };
  const startSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointerTarget = event.target as HTMLElement;
    if (event.button !== 0 || pointerTarget.closest('[data-entry-path], button, input, select, textarea')) return;
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (!container || !surface) return;
    const containerRect = container.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    if (event.clientY < surfaceRect.top) return;
    const recursiveFolder = pointerTarget.closest<HTMLElement>('[data-recursive-folder-path]');
    if (recursiveFolder?.dataset.recursiveFolderReadonly !== 'true') setOperationDirectoryPath(normalizeProjectRelativePath(recursiveFolder?.dataset.recursiveFolderPath || currentRelativePath));
    else if (!recursiveFolder) setOperationDirectoryPath(currentRelativePath);
    surface.focus({ preventScroll: true });
    cancelInlineRename();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const additive = event.ctrlKey || event.metaKey;
    const start = viewportPointToContentPoint({ x: event.clientX, y: event.clientY }, {
      viewportLeft: containerRect.left,
      viewportTop: containerRect.top,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    });
    selectionDragRef.current = {
      pointerId: event.pointerId,
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      startContentX: start.x,
      startContentY: start.y,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      initialPaths: [...selectedPaths],
      additive,
      started: false,
    };
    if (!additive) {
      setSelectedPaths([]);
    }
    setSelectionBox(null);
  };
  const updateSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
      stopSelectionAutoScroll();
      selectionDragRef.current = null;
      setSelectionBox(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      dismissPreviewFromBlankClick(drag);
      return;
    }
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    if (!drag.started) {
      const moved = Math.hypot(event.clientX - drag.pointerStartX, event.clientY - drag.pointerStartY);
      if (moved < 5) return;
      drag.started = true;
    }
    event.preventDefault();
    const additive = drag.additive || event.ctrlKey || event.metaKey;
    if (additive) drag.additive = true;
    updateSelectionDragAtPoint(event.clientX, event.clientY);
    queueSelectionAutoScroll();
  };
  const cancelSelectionDrag = () => {
    stopSelectionAutoScroll();
    selectionDragRef.current = null;
    setSelectionBox(null);
  };
  const finishSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    stopSelectionAutoScroll();
    selectionDragRef.current = null;
    setSelectionBox(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dismissPreviewFromBlankClick(drag);
  };
  useEffect(() => {
    const drag = selectionDragRef.current;
    if (!drag?.started) return;
    const frameId = window.requestAnimationFrame(() => updateSelectionDragAtPoint(drag.lastClientX, drag.lastClientY));
    return () => window.cancelAnimationFrame(frameId);
  }, [columnWidths.files, displayedFileEntries, gridIconSize, groupedResultsActive, metadataPaneOpen, previewPaneOpen, projectLayoutWidth, versionTreeOpen, viewMode, virtualWindow.columns, virtualWindow.rowHeight]);
  const cancelFileCut = async () => {
    if (!cutPaths.length) return;
    const cancelledPaths = [...cutPaths];
    const cancellationSequence = ++clipboardOperationSequenceRef.current;
    setClipboardPending(true);
    setCutPaths([]);
    setClipboardHasFiles(false);
    onNotice('已取消剪切');
    const result = await projectWorkspaceClient.cancelProjectFileCut(workspacePath, project.status, project.name, cancelledPaths);
    if (clipboardOperationSequenceRef.current !== cancellationSequence) return;
    setClipboardPending(false);
    if (!result.success) {
      const status = await projectWorkspaceClient.getProjectFileClipboardStatus();
      if (clipboardOperationSequenceRef.current !== cancellationSequence) return;
      setClipboardPending(false);
      setClipboardHasFiles(status.success && status.hasFiles);
      return;
    }
    setClipboardHasFiles(result.hasFiles);
  };
  const runFileOperation = async (operation: 'trash' | 'copy' | 'cut' | 'paste' | 'rename', nextName?: string, targetPaths = selectedRelativePaths, destinationRelativePath = operationDirectoryPath) => {
    if (operation !== 'paste' && !targetPaths.length) return;
    const requestedProjectPath = projectPathRef.current;
    if (finalViewOpen && operation !== 'copy') { onNotice('当前为只读视图，请到原文件夹修改。'); return; }
    if (operation !== 'paste' && activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isUnsupportedShortcutContent(entry))) { onNotice('普通快捷方式中的文件是只读浏览内容，不能执行此操作'); return; }


    if (operation === 'trash' && projectWorkflows) {
      const normalizedTargets = new Set(targetPaths.map(normalizeProjectRelativePath));
      const affectedProgressFolders = progressFolders.filter(folder => !folder.folderMissing
        && normalizedTargets.has(normalizeProjectRelativePath(projectRelativePath(folder.folderPath))));
      if (affectedProgressFolders.length) {
        const confirmed = await appDialog.confirm({
          title: affectedProgressFolders.length === 1 ? `删除版本 V${affectedProgressFolders[0].versionKey}？` : `删除 ${affectedProgressFolders.length} 个版本文件夹？`,
          message: localizedMessage("ui.the.folder.will.move.to.the.14307c"),
          confirmLabel: localizedMessage("ui.move.to.recycle.bin.361bdf"),
          tone: 'danger',
        });
        if (!projectOperationIsCurrent(requestedProjectPath) || !confirmed) return;
      }
    }
    const isClipboardSelection = operation === 'copy' || operation === 'cut';
    const clipboardOperationSequence = isClipboardSelection ? ++clipboardOperationSequenceRef.current : 0;
    const previousCutPaths = cutPaths;
    const previousClipboardHasFiles = clipboardHasFiles;
    const pasteClipboardGeneration = operation === 'paste' ? clipboardOperationSequenceRef.current + 1 : 0;
    const pasteCutPathsSnapshot = operation === 'paste' ? [...cutPaths] : [];
    const normalizedDestination = normalizeProjectRelativePath(destinationRelativePath);
    const pendingKind = operation === 'trash' ? 'delete' : operation;
    const pendingOperation = operation === 'rename' ? null : startPendingFileOperation({
      kind: pendingKind,
      label: operation === 'trash' ? '正在移入回收站…'
        : operation === 'paste' ? '正在准备粘贴…'
          : operation === 'cut' ? '正在剪切…' : '正在复制…',
      lockedPaths: operation === 'paste'
        ? [`__directory__/${normalizedDestination || '__root__'}`, ...(normalizedDestination ? [normalizedDestination] : []), ...pasteCutPathsSnapshot, ...pasteCutPathsSnapshot.map(path => `__directory__/${projectRelativeParentPath(path) || '__root__'}`)]
        : targetPaths,
      affectedDirectories: operation === 'paste'
        ? [normalizedDestination]
        : targetPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path))),
      tombstonePaths: operation === 'trash' ? targetPaths : undefined,
    });
    if (operation !== 'rename' && !pendingOperation) return;
    if (operation === 'paste') clipboardOperationSequenceRef.current = claimClipboardGeneration(clipboardOperationSequenceRef.current, true);
    if (isClipboardSelection) {
      setClipboardPending(true);
      setCutPaths(operation === 'cut' ? [...targetPaths] : []);
      setClipboardHasFiles(true);
    }
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.projectFileOperation>>;
    try {
      result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, operation, targetPaths, normalizedDestination, nextName);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (result.requiresDecision?.kind === 'paste-conflict') {
        const policy = await appDialog.choice({
          title: localizedMessage("ui.a.project.with.this.name.exists.4e07fe"),
          message: result.requiresDecision.message,
          detail: result.requiresDecision.detail,
          choices: [
            { value: 'replace', label: localizedMessage("ui.replace.and.continue.3fcff1"), tone: 'danger' },
            { value: 'keep-both', label: localizedMessage("ui.keep.both.56437f") },
          ],
          defaultValue: 'keep-both',
        });
        if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
        if (policy !== 'replace' && policy !== 'keep-both') {
          if (pendingOperation) await reconcilePendingFileOperation(pendingOperation, result, true);
          if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
          onNotice('粘贴已取消'); refresh(); return;
        }
        result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, operation, targetPaths, normalizedDestination, nextName, { pasteConflictPolicy: policy });
        if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      }
    } catch (error) {
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (pendingOperation) await reconcilePendingFileOperation(pendingOperation, undefined, true);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
        setClipboardPending(false);
      }
      onNotice(`操作失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
      return;
    }
    if (result.cancelled) {
      if (pendingOperation) await reconcilePendingFileOperation(pendingOperation, result);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
        setClipboardPending(false);
      }
      if (operation === 'trash' && result.count) setSelectedPaths([]);
      if (pageOwnsFileOperationNotification(result)) onNotice('粘贴已取消');
      refresh(); return;
    }
    if (!result.success) {
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
        setClipboardPending(false);
      }
      if (pendingOperation) await reconcilePendingFileOperation(pendingOperation, result, operation === 'copy' || operation === 'cut');
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (operation === 'trash' && result.count) {
        setSelectedPaths(current => current.filter(path => !targetPaths.includes(path)));
        scheduleDirectoryRefresh(result.affectedDirectories);
        refreshRecursiveResults(targetPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path))));
        if (projectWorkflows) {
          await loadProgressFolders();
          if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
        }
      }
      if (operation === 'trash' && isRecycleBinFailure(result.error, result.errorCode)) {
        await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
        if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      } else if (pageOwnsFileOperationNotification(result)) onNotice(`操作失败：${result.error || '未知错误'}`);
      return;
    }
    if (operation === 'copy' || operation === 'cut') {
      if (pendingOperation) clearPendingFileOperation(pendingOperation.id);
      if (clipboardOperationSequenceRef.current !== clipboardOperationSequence) return;
      setCutPaths(operation === 'cut' ? [...targetPaths] : []);
      setClipboardHasFiles(true);
      setClipboardPending(false);
      onNotice(operation === 'copy' ? '成功复制文件' : `已剪切 ${targetPaths.length} 个项目`);
    } else {
      if (operation === 'paste' && result.consumedCutClipboard
        && clipboardOperationSequenceRef.current === pasteClipboardGeneration
        && cutPaths.length === pasteCutPathsSnapshot.length
        && pasteCutPathsSnapshot.every(path => cutPaths.includes(path))) setCutPaths([]);
      if (operation === 'trash') setCutPaths(current => current.filter(path => !targetPaths.includes(path)));
      if (pageOwnsFileOperationNotification(result)) {
        onNotice(operation === 'trash' && result.warning ? result.warning : operation === 'trash'
          ? result.permanentCount
            ? `已删除 ${result.count} 个项目，其中 ${result.permanentCount} 个已按 Windows 确认永久删除`
            : `已移入回收站 ${result.count} 个项目`
          : operation === 'paste'
            ? result.replacedCount
              ? result.replacedRetainedCount
                ? `已粘贴 ${result.count} 个项目；替换了 ${result.replacedCount} 个同名项目，其中 ${result.replacedRetainedCount} 个原项目因回收站操作失败而保留为安全恢复副本${result.replacedPermanentCount ? `，另有 ${result.replacedPermanentCount} 个已按 Windows 确认永久删除，此次替换无法撤销` : ''}`
                : result.replacedPermanentCount
                ? `已粘贴 ${result.count} 个项目；替换了 ${result.replacedCount} 个同名项目，其中 ${result.replacedPermanentCount} 个原项目已按 Windows 确认永久删除，此次替换无法撤销`
                : `已粘贴 ${result.count} 个项目；${result.replacedCount} 个同名项目的原内容已移入回收站`
              : `已粘贴 ${result.count} 个项目`
            : '操作完成', result.warning ? 8000 : undefined);
      }
      setSelectedPaths([]);
      // Both reads describe an already committed mutation. Version metadata
      // must not delay the visible directory's reconciliation and path unlock.
      await Promise.all([
        projectWorkflows && (operation === 'trash' || operation === 'paste') ? loadProgressFolders() : Promise.resolve(),
        pendingOperation ? reconcilePendingFileOperation(pendingOperation, result)
          : Promise.resolve(scheduleDirectoryRefresh(result.affectedDirectories)),
      ]);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      refreshRecursiveResults(operation === 'paste'
        ? normalizedDestination
        : targetPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path))));
    }
  };
  useEffect(() => {
    const handleFileShortcut = (event: KeyboardEvent) => {
      if (!active) return;
      const target = event.target as HTMLElement | null;
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (commandKey && key === 'c' && window.getSelection()?.toString()) return;
      if (commandKey && key === 'f' && !target?.closest('[role="dialog"]')) {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new Event('photoflow-menu-open'));
        setSearchOpen(true);
        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (!target) return;
      const insideFileSurface = Boolean(filesSurfaceRef.current?.contains(target));
      let handled = false;

      if (event.key === 'Escape' && cutPaths.length) {
        void cancelFileCut();
        handled = true;
      } else if (commandKey && !event.altKey && !event.shiftKey && key === 'a') {
        setSelectedPaths(displayedFileEntries.map(entry => entry.relativePath));
        onNotice(`已选择 ${displayedFileEntries.length} 个项目`);
        handled = true;
      } else if (event.key === 'F2' && versionTreeOpen && selectedPaths.length) {
        beginRename();
        handled = true;
      } else if (!insideFileSurface) {
        return;
      } else if (commandKey && !event.altKey && !event.shiftKey && key === 'c' && selectedPaths.length) {
        void runFileOperation('copy');
        handled = true;
      } else if (commandKey && !event.altKey && !event.shiftKey && key === 'x' && selectedPaths.length) {
        void runFileOperation('cut');
        handled = true;
      } else if (commandKey && !event.altKey && !event.shiftKey && key === 'v') {
        void runFileOperation('paste');
        handled = true;
      } else if (event.key === 'Delete' && selectedPaths.length) {
        void runFileOperation('trash');
        handled = true;
      } else if (event.key === 'F2' && selectedPaths.length) {
        beginRename();
        handled = true;
      } else if (event.key === 'Escape' && selectedPaths.length) {
        setSelectedPaths([]);
        onNotice('已退出选择');
        handled = true;
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', handleFileShortcut);
    return () => window.removeEventListener('keydown', handleFileShortcut);
  });
  const selectedEntries = useMemo(() => activeFileEntries.filter(entry => selectedPaths.includes(entry.relativePath)), [activeFileEntries, selectedPaths]);
  const selectedRelativePaths = useMemo(() => selectedEntries.map(entry => entry.relativePath), [selectedEntries]);
  const componentHostSelectedRelativePaths = useMemo(() => safeComponentHostSelectedRelativePaths(selectedEntries), [selectedEntries]);
  const selectedContainsShortcutContent = selectedEntries.some(isUnsupportedShortcutContent);
  const registeredProgressFolderForEntry = (entry?: ProjectFileEntry) => {
    if (!entry) return undefined;
    const entryPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const entryRelativePath = normalizeProjectRelativePath(entry.relativePath).toLocaleLowerCase('zh-CN');
    return progressFolders.find(folder => {
      const folderPath = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      const folderRelativePath = progressFolderRelativePath(folder).toLocaleLowerCase('zh-CN');
      return folderPath === entryPath || folderRelativePath === entryRelativePath;
    });
  };
  const entryIsInsideProgressFolder = (entry: ProjectFileEntry) => {
    const entryPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    return progressFolders.some(folder => {
      const folderPath = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      return entryPath === folderPath || entryPath.startsWith(`${folderPath}/`);
    });
  };
  const isProtectedRenameEntry = (entry: ProjectFileEntry) => {
    if (!isFolderLikeEntry(entry)) return false;
    const normalizedPath = normalizeProjectRelativePath(entry.relativePath);
    if (!normalizedPath || normalizedPath.includes('/')) return false;
    const normalizedName = entry.name.toLocaleLowerCase('zh-CN');
    return !project.ordinaryFiles && PROTECTED_PROJECT_FOLDER_NAMES.has(normalizedName);
  };
  const selectedContainsProtectedRenameEntry = selectedEntries.some(isProtectedRenameEntry);
  const selectedRegisteredProgressRenameEntries = selectedEntries.filter(entry => registeredProgressFolderForEntry(entry)?.nodeRole === 'progress');
  const selectedContainsBlockedProgressRenameEntry = selectedRegisteredProgressRenameEntries.length > 0
    && selectedEntries.length !== 1;
  const selectedProgressFolder = selectedEntries.length === 1 && isFolderLikeEntry(selectedEntries[0]) ? selectedEntries[0] : undefined;
  const selectedRegisteredProgressFolder = registeredProgressFolderForEntry(selectedProgressFolder);
  const selectedEditableProgressFolder = selectedRegisteredProgressFolder?.nodeRole === 'progress' ? selectedRegisteredProgressFolder : undefined;
  const focusedEntry = activeFileEntries.find(entry => entry.relativePath === previewPath);
  useEffect(() => {
    let active = true;
    setSelectionEntryDetails({});
    if (selectedEntries.length < 2) {
      setSelectionEntryDetailsLoading(false);
      return () => { active = false; };
    }
    const targets = selectedEntries.filter(entry => (isFolderLikeEntry(entry) || entry.size < 0) && (!entry.viaShortcut));
    if (!targets.length) {
      setSelectionEntryDetailsLoading(false);
      return () => { active = false; };
    }
    setSelectionEntryDetailsLoading(true);
    void (async () => {
      for (const target of targets) {
        let result: Awaited<ReturnType<typeof projectWorkspaceClient.getProjectEntryDetails>>;
        try { result = await projectWorkspaceClient.getProjectEntryDetails(workspacePath, project.status, project.name, target.relativePath); }
        catch { continue; }
        if (!active) return;
        if (result.success && result.details) {
          setSelectionEntryDetails(current => ({ ...current, [target.path]: result.details! }));
        }
      }
    })().finally(() => { if (active) setSelectionEntryDetailsLoading(false); });
    return () => { active = false; };
  }, [selectedEntries, workspacePath, project.status, project.name]);
  const previewDecoders = usePreviewDecoders();
  const canPreviewEntry = (entry: ProjectFileEntry) => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video' || entry.kind === 'file' && Boolean(decoderForFile(previewDecoders, entry.name));
  const listedPreviewEntry = activeFileEntries.find(entry => entry.relativePath === previewMediaPath && canPreviewEntry(entry));
  const previewEntry = postTrimPreviewEntry?.relativePath === previewMediaPath ? postTrimPreviewEntry : listedPreviewEntry;
  previewRatingIdentityRef.current = previewEntry ? mediaRatingCacheKey(previewEntry.path, previewEntry.updatedAt) : '';
  useEffect(() => {
    ratingMutationSequenceRef.current += 1;
    setPreviewRatingBusy(false);
  }, [previewEntry?.path, previewEntry?.updatedAt]);
  useEffect(() => {
    if (postTrimPreviewEntry && postTrimPreviewEntry.relativePath !== previewMediaPath) setPostTrimPreviewEntry(undefined);
  }, [postTrimPreviewEntry?.relativePath, previewMediaPath]);
  const filesInCurrentDirectory = activeFileEntries.filter(entry => !isFolderLikeEntry(entry));
  const folderOnlyGridCount = browseMode === 'grid' && filesInCurrentDirectory.length === 0 ? displayedFileEntries.filter(isFolderLikeEntry).length : 0;
  const viewportCurrentEntry = filesInCurrentDirectory.find(entry => entry.relativePath === viewportCurrentPath);
  const viewportCurrentFileNumber = viewportCurrentEntry ? filesInCurrentDirectory.findIndex(entry => entry.relativePath === viewportCurrentEntry.relativePath) + 1 : 0;
  const currentPreviewMetadataFields = previewMetadataFieldsForEntry(previewMetadataFields, previewMetadataResolvedPath, focusedEntry?.path);
  const currentPreviewMetadataLoading = Boolean(focusedEntry && (previewMetadataLoading || previewMetadataResolvedPath !== focusedEntry.path));
  const currentPreviewMetadataError = focusedEntry && previewMetadataResolvedPath === focusedEntry.path ? previewMetadataError : '';
  const previewCanMarkFinal = Boolean(previewEntry && (!previewEntry.viaShortcut) && (previewEntry.kind === 'image' || previewEntry.kind === 'raw'));
  const previewRatingCacheKey = previewEntry ? mediaRatingCacheKey(previewEntry.path, previewEntry.updatedAt) : '';
  useEffect(() => {
    let active = true;
    setPreviewRating(0);
    setPreviewRatingLoading(false);
    if (!previewEntry || !previewCanMarkFinal) return () => { active = false; };
    const cached = previewRatingCacheRef.current.get(previewRatingCacheKey);
    if (cached !== undefined) {
      setPreviewRating(cached);
      return () => { active = false; };
    }
    setPreviewRatingLoading(true);
    let request = previewRatingRequestsRef.current.get(previewRatingCacheKey);
    if (!request) {
      request = projectWorkspaceClient.getMediaRating(previewEntry.path);
      previewRatingRequestsRef.current.set(previewRatingCacheKey, request);
      void request.finally(() => previewRatingRequestsRef.current.delete(previewRatingCacheKey)).catch(() => undefined);
    }
    request.then(result => {
      if (!active || !result.success) return;
      if (previewRatingCacheRef.current.size >= 400) previewRatingCacheRef.current.delete(previewRatingCacheRef.current.keys().next().value as string);
      previewRatingCacheRef.current.set(previewRatingCacheKey, result.rating);
      setPreviewRating(result.rating);
    }).catch(() => undefined).finally(() => { if (active) setPreviewRatingLoading(false); });
    return () => { active = false; };
  }, [previewEntry?.path, previewEntry?.updatedAt, previewCanMarkFinal, previewRatingCacheKey]);
  const updatePreviewRating = async (requestedRating: number) => {
    if (!previewEntry || !previewCanMarkFinal || previewRatingBusy) return;
    const targetEntry = previewEntry;
    const targetIdentity = mediaRatingCacheKey(targetEntry.path, targetEntry.updatedAt);
    const mutationSequence = ++ratingMutationSequenceRef.current;
    const previousRating = previewRating;
    setPreviewRating(requestedRating);
    setPreviewRatingBusy(true);
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.setMediaRating>>;
    try {
      result = await projectWorkspaceClient.setMediaRating(workspacePath, targetEntry.path, requestedRating);
    } catch (error) {
      previewRatingCacheRef.current.set(targetIdentity, previousRating);
      if (ratingMutationSequenceRef.current === mutationSequence && previewRatingIdentityRef.current === targetIdentity) {
        setPreviewRating(previousRating);
        setPreviewRatingBusy(false);
        onNotice(`更新图片标星失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const previewIsCurrent = ratingMutationPreviewIsCurrent(mutationSequence, ratingMutationSequenceRef.current, targetIdentity, previewRatingIdentityRef.current);
    if (previewIsCurrent) setPreviewRatingBusy(false);
    if (!result.success) {
      previewRatingCacheRef.current.set(targetIdentity, previousRating);
      if (previewIsCurrent) setPreviewRating(previousRating);
      onNotice(`更新图片标星失败：${result.error || '未知错误'}`);
      return;
    }
    if (previewIsCurrent) setPreviewRating(result.rating);
    if (previewRatingCacheRef.current.size >= 400 && !previewRatingCacheRef.current.has(targetIdentity)) previewRatingCacheRef.current.delete(previewRatingCacheRef.current.keys().next().value as string);
    previewRatingCacheRef.current.set(targetIdentity, result.rating);
    setFilterRatings(current => ({ ...current, [targetEntry.path]: result.rating }));
    const applyRating = (entries: ProjectFileEntry[]) => entries.map(entry => entry.path === targetEntry.path ? { ...entry, rating: result.rating } : entry);
    setFileEntries(applyRating);
    setSearchEntries(applyRating);
    setScopeEntries(applyRating);
    for (const [cacheKey, entries] of directoryEntriesCacheRef.current) directoryEntriesCacheRef.current.set(cacheKey, applyRating(entries));
    if (previewIsCurrent && previewMetadataResolvedPath === targetEntry.path) {
      setPreviewMetadataFields(current => {
        const index = current.findIndex(field => field.name === 'Rating');
        if (index < 0) return [...current, { group: 'XMP', name: 'Rating', value: String(result.rating) }];
        return current.map((field, fieldIndex) => fieldIndex === index ? { ...field, value: String(result.rating) } : field);
      });
    }
    if (finalViewOpen) {
      if (result.rating > 0) setFinalViewEntries(current => current.map(entry => entry.path === targetEntry.path ? { ...entry, rating: result.rating } : entry));
      else {
        setFinalViewEntries(current => current.filter(entry => entry.path !== targetEntry.path));
        if (previewIsCurrent) {
          setPreviewPath('');
          setPreviewHighlightPath('');
          setPreviewPaneOpen(previewPanePinnedRef.current);
          setMetadataPaneOpen(metadataPanePinnedRef.current);
        }
      }
    }
    onNotice(result.rating > 0 ? `已写入 ${result.rating} 星评分` : '已清除图片评分');
  };
  const showCompletedVideoTrim = async (result: { outputPath?: string; relativePath?: string; replaced?: boolean }, sourceRelativePathValue: string) => {
    const sourceRelativePath = normalizeProjectRelativePath(sourceRelativePathValue);
    const targetRelativePath = normalizeProjectRelativePath(result.relativePath || sourceRelativePath);
    if (!result.outputPath || !targetRelativePath) {
      onNotice('视频已导出，但无法定位导出文件', 7000);
      return;
    }
    const sourceEntry = [previewEntry, ...fileEntries, ...searchEntries, ...scopeEntries]
      .find(entry => entry?.relativePath === sourceRelativePath);
    const targetName = targetRelativePath.split('/').pop() || sourceEntry?.name || '裁剪视频.mp4';
    const targetExtensionIndex = targetName.lastIndexOf('.');
    const now = Date.now();
    const targetPreviewEntry: ProjectFileEntry = {
      name: targetName,
      path: result.outputPath,
      relativePath: targetRelativePath,
      kind: 'video',
      extension: targetExtensionIndex >= 0 ? targetName.slice(targetExtensionIndex).toLocaleLowerCase() : sourceEntry?.extension || '',
      size: -1,
      createdAt: result.replaced && sourceEntry ? sourceEntry.createdAt : now,
      updatedAt: now,
    };
    // Replacing a file keeps the same path. Clearing the media path for one
    // render guarantees that the old Windows player handle is discarded.
    setPreviewMediaPath('');
    directoryEntriesCacheRef.current.clear();
    refreshRecursiveResults(projectRelativeParentPath(sourceRelativePath));
    await refresh(currentRelativePathRef.current).catch(error => {
      console.error('Unable to refresh trimmed video directory', error);
    });
    setPostTrimPreviewEntry(targetPreviewEntry);
    selectionAnchorPathRef.current = targetRelativePath;
    setSelectedPaths([targetRelativePath]);
    setPreviewPath(targetRelativePath);
    setPreviewHighlightPath(targetRelativePath);
    setPreviewMediaPath(targetRelativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(true);
    onNotice('裁剪视频完成');
  };
  const trimPreviewVideo = async (start: number, end: number, saveMode: 'new' | 'replace', operationId: string, sourceDuration: number) => {
    if (!previewEntry || previewEntry.kind !== 'video' || isUnsupportedShortcutContent(previewEntry)) return { success: false, error: '当前视频不可剪辑' };
    const sourceRelativePath = previewEntry.relativePath;
    const result = await projectWorkspaceClient.trimProjectVideo(workspacePath, project.status, project.name, sourceRelativePath, { start, end, saveMode, exportMode: videoTools.trim.exportMode, operationId, sourceDuration });
    if (!result.success) {
      if (result.cancelled) {
        onNotice('已取消视频导出');
        return result;
      }
      onNotice(`视频剪辑失败：${result.error || '未知错误'}`, 7000);
      return result;
    }
    // Keep compatibility with a renderer hot reload talking to the previous
    // main-process handler, which returns the final result instead of a start
    // acknowledgement. A full app restart switches to the detached path.
    if (!result.started && result.outputPath) await showCompletedVideoTrim(result, sourceRelativePath);
    return result;
  };
  useEffect(() => {
    if (!active) return;
    const task = backgroundTasks.find(item => item.type === 'video-trim'
      && (item.state === 'completed' || item.state === 'cancelled' || item.state === 'failed')
      && !handledVideoTrimTaskIds.has(item.id)
      && backgroundTaskPathKey(item.metadata?.workspacePath) === backgroundTaskPathKey(workspacePath)
      && item.metadata?.projectStatus === project.status
      && item.metadata?.projectName === project.name);
    if (!task) return;
    const result = task.metadata?.result as { outputPath?: string; relativePath?: string; replaced?: boolean } | undefined;
    // The previous main-process implementation has no result metadata and
    // resolves the original IPC request with the completed file instead.
    if (task.state === 'completed' && !result) return;
    handledVideoTrimTaskIds.add(task.id);
    if (task.state === 'cancelled' || task.state === 'failed') return;
    void showCompletedVideoTrim(result || {}, String(task.metadata?.sourceRelativePath || ''));
  }, [active, backgroundTasks, project.name, project.status, showCompletedVideoTrim, workspacePath]);
  const loadPreviewVideoTimelineFrames = useCallback((times: number[]) => {
    if (!previewEntry || previewEntry.kind !== 'video' || isUnsupportedShortcutContent(previewEntry)) return Promise.resolve({ success: false, error: '当前视频不可读取' });
    return projectWorkspaceClient.getProjectVideoTimelineFrames(workspacePath, project.status, project.name, previewEntry.relativePath, times);
  }, [previewEntry?.kind, previewEntry?.relativePath, previewEntry?.viaShortcut, workspacePath, project.status, project.name]);
  const previewMediaEntries = displayedFileEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
  const scrollFileEntryIntoView = useCallback((relativePath: string, align: 'nearest' | 'center' = 'nearest', requestId?: number): 'complete' | 'scheduled' | 'unavailable' => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    const fileIndex = displayedFileEntries.findIndex(entry => entry.relativePath === relativePath);
    if (fileIndex < 0 || !container || !surface) return 'unavailable';

    const findRenderedNode = () => Array.from(surface.querySelectorAll<HTMLElement>('[data-entry-path]')).find(item => item.dataset.entryPath === relativePath);
    const revealRenderedNode = () => {
      const node = findRenderedNode();
      if (!node) return false;
      const containerRect = container.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const fullyVisible = nodeRect.top >= containerRect.top
        && nodeRect.bottom <= containerRect.bottom
        && nodeRect.left >= containerRect.left
        && nodeRect.right <= containerRect.right;
      if (align === 'center') node.scrollIntoView({ block: 'center', inline: 'nearest' });
      else if (!fullyVisible) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    };

    window.cancelAnimationFrame(fileRevealFrameRef.current);
    fileRevealPathRef.current = '';
    if (revealRenderedNode()) return 'complete';

    fileRevealPathRef.current = relativePath;
    fileRevealFrameRef.current = window.requestAnimationFrame(() => {
      if (fileRevealPathRef.current !== relativePath) return;
      const surfaceWidth = Math.max(1, surface.clientWidth);
      const columns = viewMode === 'list' ? 1 : Math.max(1, Math.floor((surfaceWidth + 12) / (gridIconSize + 12)));
      const cellWidth = viewMode === 'list' ? surfaceWidth : (surfaceWidth - (columns - 1) * 12) / columns;
      const measuredItem = surface.querySelector<HTMLElement>('[data-entry-path]');
      const measuredRowHeight = measuredItem ? measuredItem.getBoundingClientRect().height + (viewMode === 'list' ? 0 : 12) : 0;
      const rowHeight = measuredRowHeight || (viewMode === 'list' ? 48 : cellWidth + 68);
      const targetRow = Math.floor(fileIndex / columns);
      const targetTop = targetRow * rowHeight;
      const targetBottom = targetTop + rowHeight;
      const headerHeight = viewMode === 'list' ? 32 : 0;
      const containerRect = container.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const surfaceTop = surfaceRect.top - containerRect.top + container.scrollTop;
      const visibleTop = Math.max(0, container.scrollTop - surfaceTop - headerHeight);
      const visibleHeight = Math.max(rowHeight, container.clientHeight - headerHeight);
      const nextVisibleTop = targetTop < visibleTop
        ? targetTop
        : targetBottom > visibleTop + visibleHeight ? targetBottom - visibleHeight : visibleTop;
      container.scrollTo({ top: Math.max(0, surfaceTop + headerHeight + nextVisibleTop) });

      let attempts = 0;
      const finishReveal = () => {
        if (fileRevealPathRef.current !== relativePath) return;
        if (revealRenderedNode()) {
          fileRevealPathRef.current = '';
          if (requestId !== undefined) setPendingFileReveal(current => current?.requestId === requestId ? null : current);
          return;
        }
        attempts += 1;
        if (attempts >= 12) {
          fileRevealPathRef.current = '';
          if (requestId !== undefined) setPendingFileReveal(current => current?.requestId === requestId ? null : current);
          return;
        }
        fileRevealFrameRef.current = window.requestAnimationFrame(finishReveal);
      };
      fileRevealFrameRef.current = window.requestAnimationFrame(finishReveal);
    });
    return 'scheduled';
  }, [displayedFileEntries, gridIconSize, viewMode]);
  useEffect(() => () => {
    window.cancelAnimationFrame(fileRevealFrameRef.current);
    fileRevealPathRef.current = '';
  }, []);
  useEffect(() => {
    if (!pendingFileReveal || scrollFileEntryIntoView(pendingFileReveal.path, pendingFileReveal.align, pendingFileReveal.requestId) !== 'complete') return;
    setPendingFileReveal(current => current?.requestId === pendingFileReveal.requestId ? null : current);
  }, [pendingFileReveal, scrollFileEntryIntoView]);
  useEffect(() => {
    const paneLayout = `${previewPaneOpen}:${metadataPaneOpen}`;
    const paneLayoutChanged = previousPaneLayoutRef.current !== '' && previousPaneLayoutRef.current !== paneLayout;
    previousPaneLayoutRef.current = paneLayout;
    if (paneLayoutChanged) paneLayoutRevealPendingRef.current = true;
    const revealPath = previewPath || paneLayoutRevealPathRef.current;
    if (!revealPath) return;
    let frameId = 0;
    let previousWidth = -1;
    let stableFrames = 0;
    let attempts = 0;
    const revealAfterStableLayout = () => {
      const width = filesSurfaceRef.current?.clientWidth || 0;
      stableFrames = width > 0 && Math.abs(width - previousWidth) < 1 ? stableFrames + 1 : 0;
      previousWidth = width;
      attempts += 1;
      const expectedColumns = viewMode === 'list' ? 1 : Math.max(1, Math.floor((width + 12) / (gridIconSize + 12)));
      const virtualLayoutReady = virtualWindowRef.current.columns === expectedColumns && virtualWindowRef.current.rowHeight > 0;
      if ((stableFrames >= 2 && virtualLayoutReady) || attempts >= 24) {
        const align = paneLayoutRevealPendingRef.current ? 'center' : 'nearest';
        paneLayoutRevealPendingRef.current = false;
        if (paneLayoutRevealPathRef.current === revealPath) paneLayoutRevealPathRef.current = '';
        requestFileReveal(revealPath, align);
        return;
      }
      frameId = window.requestAnimationFrame(revealAfterStableLayout);
    };
    frameId = window.requestAnimationFrame(revealAfterStableLayout);
    return () => window.cancelAnimationFrame(frameId);
  }, [previewPath, previewPaneOpen, metadataPaneOpen, requestFileReveal, viewMode, gridIconSize]);
  useEffect(() => {
    let active = true;
    if (browseMode !== 'grid' || !viewportCurrentEntry || viewportCurrentFileNumber <= 0) {
      setViewportStatus(null);
      return () => { active = false; };
    }
    const nextStatus = { path: viewportCurrentEntry.relativePath, fileNumber: viewportCurrentFileNumber, total: filesInCurrentDirectory.length };
    if (!['image', 'raw', 'video'].includes(viewportCurrentEntry.kind)) {
      setViewportStatus(nextStatus);
      return () => { active = false; };
    }
    const timer = window.setTimeout(() => {
      requestCaptureDateTime(viewportCurrentEntry).then(captureDateTime => {
        if (!active) return;
        setViewportStatus(captureDateTime ? { ...nextStatus, captureDateTime } : nextStatus);
      }).catch(() => { if (active) setViewportStatus(nextStatus); });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [browseMode, viewportCurrentEntry?.path, viewportCurrentEntry?.updatedAt, viewportCurrentFileNumber, filesInCurrentDirectory.length]);
  useEffect(() => {
    let active = true;
    setPreviewMetadataFields([]);
    setPreviewMetadataResolvedPath('');
    setPreviewMetadataError('');
    if (!focusedEntry) {
      setPreviewMetadataLoading(false);
      return () => { active = false; };
    }
    if (focusedEntry.kind === 'folder' || focusedEntry.kind === 'file' || focusedEntry.kind === 'shortcut') {
      setPreviewMetadataResolvedPath(focusedEntry.path);
      setPreviewMetadataLoading(false);
      return () => { active = false; };
    }
    setPreviewMetadataLoading(true);
    projectWorkspaceClient.getMediaMetadata(focusedEntry.path).then(result => {
      if (!active) return;
      if (!result.success) {
        setPreviewMetadataError(result.error || '无法读取完整详细信息');
        setPreviewMetadataResolvedPath(focusedEntry.path);
        return;
      }
      setPreviewMetadataFields(result.fields);
      setPreviewMetadataResolvedPath(focusedEntry.path);
    }).catch(error => {
      if (!active) return;
      setPreviewMetadataError(error instanceof Error ? error.message : String(error || '无法读取完整详细信息'));
      setPreviewMetadataResolvedPath(focusedEntry.path);
    }).finally(() => { if (active) setPreviewMetadataLoading(false); });
    return () => { active = false; };
  }, [focusedEntry?.path, focusedEntry?.updatedAt]);
  useEffect(() => {
    let active = true;
    setPreviewEntryDetails(null);
    if (!focusedEntry || (focusedEntry.viaShortcut)) return () => { active = false; };
    projectWorkspaceClient.getProjectEntryDetails(workspacePath, project.status, project.name, focusedEntry.relativePath).then(result => {
      if (active && result.success && result.details) setPreviewEntryDetails(result.details);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [focusedEntry?.path, workspacePath, project.status, project.name]);
  useEffect(() => {
    if (!previewPaneOpen || !previewPath) return;
    let frameId = 0;
    let attempts = 0;
    const focusPreviewEntryNode = () => {
      const entryNode = Array.from(filesSurfaceRef.current?.querySelectorAll<HTMLElement>('[data-entry-path]') || [])
        .find(node => node.dataset.entryPath === previewPath);
      if (entryNode) {
        entryNode.focus({ preventScroll: true });
        return;
      }
      attempts += 1;
      if (attempts < 24) frameId = window.requestAnimationFrame(focusPreviewEntryNode);
    };
    frameId = window.requestAnimationFrame(focusPreviewEntryNode);
    return () => window.cancelAnimationFrame(frameId);
  }, [previewPaneOpen, previewPath]);
  const navigatePreviewMedia = useCallback((direction: -1 | 1) => {
    if (!previewEntry) return;
    const navigableEntries = previewEntry.kind === 'video'
      ? previewMediaEntries.filter(entry => entry.kind === 'video')
      : previewMediaEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw');
    const currentIndex = navigableEntries.findIndex(entry => entry.relativePath === previewEntry.relativePath);
    if (currentIndex < 0) return;
    const nextIndex = clampNumber(currentIndex + direction, 0, navigableEntries.length - 1);
    if (nextIndex === currentIndex) return;
    const nextEntry = navigableEntries[nextIndex];
    setPreviewPath(nextEntry.relativePath);
    setPreviewHighlightPath(nextEntry.relativePath);
    setDirectoryReturnHighlightPath('');
    setPreviewMediaPath(nextEntry.relativePath);
    setPreviewTechnicalMetadata({});
  }, [previewEntry?.relativePath, previewMediaEntries]);
  useEffect(() => {
    const switchPreviewMedia = (event: KeyboardEvent) => {
      if (!previewPaneOpen || !previewEntry || !['image', 'raw'].includes(previewEntry.kind) || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      navigatePreviewMedia(event.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', switchPreviewMedia);
    return () => window.removeEventListener('keydown', switchPreviewMedia);
  }, [previewPaneOpen, previewEntry?.relativePath, previewEntry?.kind, navigatePreviewMedia]);
  const visibleDockPanels = panelOrder.filter(id => id === 'files' ? filesPaneOpen : id === 'preview' ? previewPaneOpen && active && activeView === 'project' : id === 'metadata' ? metadataPaneOpen : componentPanels.controls[id]?.open && active && activeView === 'project');
  const panelLabels = Object.fromEntries(componentPanels.panels.map(item => [componentWorkspacePanelId(item.componentId, item.contributionId), item.label]));
  const displayedColumnWidths = fitPanelWidths(columnWidths, projectLayoutWidth, visibleDockPanels);
  const fileListTrackWidth = Math.max(0, displayedColumnWidths.files - FILE_SURFACE_HORIZONTAL_PADDING * 2 - FILE_LIST_GRID_CHROME_WIDTH);
  const displayedFileListColumnWidths = fileListColumnsCustomized
    ? fileListColumnWidths
    : fitFileListColumnWidths(DEFAULT_FILE_LIST_COLUMN_WIDTHS, fileListTrackWidth);
  const fileListColumnsWidth = FILE_LIST_COLUMN_KEYS.reduce((total, key) => total + displayedFileListColumnWidths[key], FILE_LIST_GRID_CHROME_WIDTH);
  const fileListViewportWidth = Math.max(0, displayedColumnWidths.files - FILE_SURFACE_HORIZONTAL_PADDING * 2);
  const fileListGridStyle = {
    '--file-list-name-width': `${displayedFileListColumnWidths.name}px`,
    '--file-list-modified-width': `${displayedFileListColumnWidths.modified}px`,
    '--file-list-type-width': `${displayedFileListColumnWidths.type}px`,
    '--file-list-size-width': `${displayedFileListColumnWidths.size}px`,
    width: Math.max(fileListColumnsWidth, fileListViewportWidth),
  } as React.CSSProperties;
  const resizeFileListBoundary = (boundary: FileListColumnBoundary, deltaX: number) => {
    setFileListColumnsCustomized(true);
    setFileListColumnWidths(resizeFileListColumnBoundary(displayedFileListColumnWidths, boundary, deltaX));
  };
  const resizeDockBoundary = (left: WorkspacePanelId, right: WorkspacePanelId, delta: number) => setColumnWidths(current =>
    resizePanelBoundary(fitPanelWidths(current, projectLayoutWidth, visibleDockPanels), left, right, delta));
  const canSelectMedia = !finalViewOpen && !selectedContainsShortcutContent && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
  const selectedScreenshotMainImageEntries = selectedEntries.filter(entry => isScreenshotMainImageEntry(entry) && !entryIsInsideProgressFolder(entry));
  const canExtractScreenshotMainImage = !finalViewOpen && selectedScreenshotMainImageEntries.length > 0;
  const selectedResearchTargets = !finalViewOpen && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entry.kind === 'video' || isFolderLikeEntry(entry)) ? selectedEntries : [];
  const selectedVideoSplitTargets = selectedResearchTargets;
  const selectedOfficeExtractEntries = !finalViewOpen && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(isOfficeOpenXmlEntry) ? selectedEntries : [];
  const fileMenuEntrySelected = Boolean(fileMenu && selectedPaths.includes(fileMenu.entry.relativePath));
  const fileMenuTargetPaths = fileMenu
    ? fileMenuEntrySelected ? selectedPaths : [fileMenu.entry.relativePath]
    : selectedPaths;
  const fileMenuContainsShortcutContent = fileMenuTargetPaths.some(path => activeFileEntries.some(entry => entry.relativePath === path && isUnsupportedShortcutContent(entry)));
  const fileMenuEntries = fileMenuTargetPaths.map(relativePath => activeFileEntries.find(entry => entry.relativePath === relativePath)).filter((entry): entry is ProjectFileEntry => Boolean(entry));
  const fileMenuContainsProtectedRenameEntry = fileMenuEntries.some(isProtectedRenameEntry);
  const fileMenuRegisteredProgressRenameEntries = fileMenuEntries.filter(entry => registeredProgressFolderForEntry(entry)?.nodeRole === 'progress');
  const fileMenuContainsBlockedProgressRenameEntry = fileMenuRegisteredProgressRenameEntries.length > 0
    && fileMenuEntries.length !== 1;
  const fileMenuVersionTreeFolder = registeredProgressFolderForEntry(fileMenu?.entry);
  const fileMenuRegisteredProgressFolder = fileMenuVersionTreeFolder?.nodeRole === 'progress' ? fileMenuVersionTreeFolder : undefined;
  const fileMenuScreenshotMainImageEntries = fileMenu
    ? fileMenuEntrySelected ? selectedEntries.filter(entry => isScreenshotMainImageEntry(entry) && !entryIsInsideProgressFolder(entry)) : isScreenshotMainImageEntry(fileMenu.entry) && !entryIsInsideProgressFolder(fileMenu.entry) ? [fileMenu.entry] : []
    : [];
  const canSelectFileMenuMedia = !finalViewOpen && fileMenuTargetPaths.length > 0 && fileMenuTargetPaths.every(path => {
    const entry = activeFileEntries.find(candidate => candidate.relativePath === path);
    return Boolean(entry && !isUnsupportedShortcutContent(entry) && (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'));
  });
  const gatherInspiration = async (targetProject: WorkspaceProject, targetPaths: string[]) => {
    if (!gatherToProject || gatheringInspiration) return;
    if (!inspirationTargetWorkspacePath?.trim()) { onNotice('请先设置项目工作目录'); return; }
    if (!targetPaths.length) { onNotice('请先选择要汇聚的文件或文件夹'); return; }
    setGatheringInspiration(true);
    try {
      const result = await projectWorkspaceClient.addInspirationToProject(workspacePath, inspirationTargetWorkspacePath, targetProject.status, targetProject.name, targetPaths);
      if (!result.success) { onNotice(`汇聚灵感失败：${result.error || '未知错误'}`, 7000); return; }
      setInspirationTargetProject(targetProject);
      try { window.localStorage.setItem('photoflow:inspiration-target-project', targetProject.path); } catch { /* storage unavailable */ }
      window.dispatchEvent(new Event('photoflow:inspiration-target-project-changed'));
      setGatherPickerPaths(null);
      setSelectedPaths([]);
      const details = [result.shortcutCount ? `${result.shortcutCount} 个文件夹快捷方式` : '', result.fileCount ? `${result.fileCount} 个文件` : ''].filter(Boolean).join('、');
      onNotice(`已将${details || `${result.count || 0} 项内容`}添加到项目“${targetProject.name}”的“策划”文件夹`);
    } finally {
      setGatheringInspiration(false);
    }
  };
  const startGatherInspiration = (targetPaths: string[]) => {
    if (!targetPaths.length) { onNotice('请先选择要汇聚的文件或文件夹'); return; }
    if (inspirationTargetProject) void gatherInspiration(inspirationTargetProject, targetPaths);
    else setGatherPickerPaths(targetPaths);
  };
  useEffect(() => {
    if (!gatherToProject) return;
    const addFolder = (event: Event) => {
      const detail = (event as CustomEvent<{ relativePath?: string; chooseProject?: boolean }>).detail;
      const relativePath = detail?.relativePath?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!relativePath) return;
      if (detail.chooseProject) setGatherPickerPaths([relativePath]);
      else startGatherInspiration([relativePath]);
    };
    window.addEventListener('photoflow:inspiration-add-folder-to-project', addFolder);
    return () => window.removeEventListener('photoflow:inspiration-add-folder-to-project', addFolder);
  }, [gatherToProject, inspirationTargetProject, inspirationProjects.length, gatheringInspiration]);
  const openResearchForEntries = async (entries: ProjectFileEntry[]) => {
    if (!entries.length || entries.some(entry => entry.kind !== 'video' && !isFolderLikeEntry(entry))) return;
    if (projectPanelIsRunning('research')) { setPanel('research'); return; }
    const sequence = ++researchInspectionSequenceRef.current;
    const folderEntries = entries.filter(isFolderLikeEntry);
    setResearchTargetPath(entries.length === 1 ? entries[0].path : '');
    setResearchTargetPaths(entries.map(entry => entry.path));
    setResearchTargetHasTxt(false);
    setPanel('research');
    if (!folderEntries.length) return;
    // research.py scans the selected directories itself; the project-wide media
    // index must not block opening or running this tool.
    if (entries.length === 1) {
      void projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, entries[0].relativePath, mediaCacheConfig).then(result => {
        if (sequence !== researchInspectionSequenceRef.current) return;
        setResearchTargetHasTxt(Boolean(result.success && result.entries.some(candidate => candidate.extension.toLocaleLowerCase() === '.txt')));
      }).catch(() => {
        if (sequence === researchInspectionSequenceRef.current) setResearchTargetHasTxt(false);
      });
    }
  };
  const [previewSelectionBusy, setPreviewSelectionBusy] = useState(false);
  const previewSelectionPendingRef = useRef(false);
  const previewSelectionAvailable = Boolean(projectWorkflows && !finalViewOpen && previewEntry && !isUnsupportedShortcutContent(previewEntry) && (previewEntry.kind === 'image' || previewEntry.kind === 'raw'));
  const selectMediaFiles = async (targetPaths = selectedPaths) => {
    if (finalViewOpen) { onNotice('喜爱图片浏览是只读视图，请回到原文件夹进行选片'); return; }
    const targetEntries = activeFileEntries.filter(entry => targetPaths.includes(entry.relativePath));
    const canSelectTargets = targetEntries.length > 0 && targetEntries.length === targetPaths.length && targetEntries.every(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
    if (!canSelectTargets) { onNotice(targetPaths.length ? '只能选择媒体文件' : '请先选择媒体文件'); return; }
    const sourceFolders = new Set(targetEntries.map(entry => projectRelativeParentPath(entry.relativePath)));
    if (sourceFolders.size !== 1) { onNotice('一次手动选片只能选择同一来源文件夹中的媒体。'); return; }
    const sourceFolderRelativePath = [...sourceFolders][0] || '';
    const preflight = await projectWorkspaceClient.preflightManualSelection(project.path, { sourceFolderRelativePath, relativePaths: targetPaths });
    if (!preflight.success || !preflight.signature) { onNotice(`选片预检失败：${preflight.error || '未知错误'}`); return; }
    const decision = await appDialog.choice({
      title: localizedMessage("ui.confirm.manual.selection.259189"),
      message: `${preflight.sourceFolderRelativePath || '项目根目录'} → ${preflight.targetFolderRelativePath || preflight.outputFolderName || '选片输出'}`,
      detail: localizedMessage("ui.matched.value0.existing.value1.conflicts.value2.d9ce36", { value0: preflight.matchedCount || targetPaths.length, value1: preflight.existingCount || 0, value2: preflight.conflictCount || 0, value3: preflight.missingCount || 0 }),
      choices: [{ value: 'execute', label: localizedMessage("ui.confirm.selection.9bf785") }],
      defaultValue: 'execute',
      cancelLabel: localizedMessage("common.cancel"),
      cancelDefault: true,
    });
    if (decision !== 'execute') return;
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.executeManualSelection>>;
    try {
      result = await projectWorkspaceClient.executeManualSelection(project.path, { sourceFolderRelativePath, relativePaths: targetPaths, expectedSignature: preflight.signature, operationId: crypto.randomUUID() });
    } catch (error) {
      onNotice(`选片失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
      return;
    }
    if (!result.success || result.cancelled) {
      if (pageOwnsFileOperationNotification(result)) onNotice(`选片失败：${result.error || (result.cancelled ? '已取消并回滚本次创建内容' : '未知错误')}`);
      return;
    }
    if (pageOwnsFileOperationNotification(result)) onNotice(`已向“${result.targetFolderRelativePath || result.outputFolderName || '选片输出'}”追加 ${result.copiedCount || 0} 个媒体；附属节点已登记。`);
    setSelectedPaths([]);
    await loadProgressFolders();
    directoryEntriesCacheRef.current.clear();
    refresh('');
  };
  const selectPreviewImage = async () => {
    if (!previewSelectionAvailable || !previewEntry || previewSelectionPendingRef.current) return;
    const targetPath = previewEntry.relativePath;
    previewSelectionPendingRef.current = true;
    setPreviewSelectionBusy(true);
    try {
      await selectMediaFiles([targetPath]);
    } catch (error) {
      onNotice(`选片失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      previewSelectionPendingRef.current = false;
      setPreviewSelectionBusy(false);
    }
  };
  const focusEntry = (entry: ProjectFileEntry) => {
    setPreviewPath(entry.relativePath);
    if (entry.kind === 'file' && canPreviewEntry(entry)) { setPreviewMediaPath(entry.relativePath); setPreviewTechnicalMetadata({}); if (previewPanePinned || !previewPaneAutoOpenSuppressed) setPreviewPaneOpen(true); return; }
    if (itemOpenMode === 'double' || (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video')) {
      setPreviewMediaPath('');
      setPreviewTechnicalMetadata({});
    }
  };
  const activateMediaPreview = (entry: ProjectFileEntry) => {
    if (!canPreviewEntry(entry)) return;
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    focusEntry(entry);
    setPreviewMediaPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    if (previewPanePinned || !previewPaneAutoOpenSuppressed) setPreviewPaneOpen(true);
  };
  const openPreviewFromMenu = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video') return;
    setPreviewHighlightPath(entry.relativePath);
    setDirectoryReturnHighlightPath('');
    focusEntry(entry);
    setPreviewMediaPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneAutoOpenSuppressed(false);
    setPreviewPaneOpen(true);
  };
  const { closePreviewPaneByUser, closeMetadataPaneByUser, togglePreviewPanePinned, toggleMetadataPanePinned } = useWorkspacePanelControls({
    extra: componentPanels.controls,
    pageId, active: active && activeView === 'project', order: panelOrder, setOrder: setPanelOrder, setWidths: setColumnWidths,
    files: { open: filesPaneOpen, pinned: filesPanePinned, setOpen: setFilesPaneOpen, setPinned: setFilesPanePinned },
    preview: { open: previewPaneOpen, pinned: previewPanePinned, setOpen: setPreviewPaneOpen, setPinned: setPreviewPanePinned, setSuppressed: setPreviewPaneAutoOpenSuppressed },
    metadata: { open: metadataPaneOpen, pinned: metadataPanePinned, setOpen: setMetadataPaneOpen, setPinned: setMetadataPanePinned, setSuppressed: setMetadataPaneAutoOpenSuppressed },
  });
  const openEntryDetails = (entry: ProjectFileEntry) => {
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    focusEntry(entry);
    setMetadataPaneAutoOpenSuppressed(false);
    setMetadataPaneOpen(true);
  };
  const addSelectionAndSyncOpenPanes = (entry: ProjectFileEntry) => {
    selectionAnchorPathRef.current = entry.relativePath;
    setSelectedPaths(current => current.includes(entry.relativePath) ? current : [...current, entry.relativePath]);
    if (!previewPaneOpen && !metadataPaneOpen) return;
    const isMedia = canPreviewEntry(entry);
    setPreviewPath(entry.relativePath);
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    if (previewPaneOpen) setPreviewMediaPath(isMedia ? entry.relativePath : '');
    setPreviewTechnicalMetadata({});
  };
  const activateEntry = (entry: ProjectFileEntry) => {
    const isMedia = canPreviewEntry(entry);
    if (isMedia) {
      activateMediaPreview(entry);
      if (metadataPanePinned || !previewOnlyOnMediaClick && !metadataPaneAutoOpenSuppressed) setMetadataPaneOpen(true);
      else if (previewOnlyOnMediaClick) setMetadataPaneOpen(false);
      return;
    }
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    focusEntry(entry);
    if (previewPanePinned) setPreviewPaneOpen(true);
    else setPreviewPaneOpen(false);
    if (metadataPanePinned || !metadataPaneAutoOpenSuppressed) setMetadataPaneOpen(true);
    void openProjectEntry(entry);
  };
  const handleEntryClick = (event: React.MouseEvent | React.KeyboardEvent, entry: ProjectFileEntry) => {
    if (!('key' in event) && suppressDraggedEntryClickRef.current?.path === entry.relativePath) { event.preventDefault(); event.stopPropagation(); return; }
    if (pendingOperationForEntry(entry).pendingOperationId) { event.preventDefault(); event.stopPropagation(); return; }
    if (inlineRenamePath === entry.relativePath) return;
    fileInteractionRevisionRef.current += 1;
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    setOperationDirectoryPath(isUnsupportedShortcutContent(entry) ? currentRelativePath : projectRelativeParentPath(entry.relativePath));
    if ('key' in event) {
      event.preventDefault();
      event.stopPropagation();
      activateEntry(entry);
      return;
    }
    const pointerModifiers = entryPointerModifiersRef.current?.path === entry.relativePath ? entryPointerModifiersRef.current : null;
    entryPointerModifiersRef.current = null;
    const range = event.shiftKey || Boolean(pointerModifiers?.range);
    const additive = event.ctrlKey || event.metaKey || Boolean(pointerModifiers?.additive);
    const availableSelection = selectionOutsidePendingRenames(selectedPaths, pendingFileOperationsRef.current);
    const intent = fileEntryClickIntent({ openMode: itemOpenMode, selectionCount: availableSelection.length, entrySelected: availableSelection.includes(entry.relativePath), range, additive, clickCount: event.detail });
    if (intent === 'ignore-repeat') return;
    if (intent === 'range-select') {
      selectEntryRange(entry.relativePath, additive);
      return;
    }
    if (intent === 'toggle-select') {
      toggleSelected(entry.relativePath);
      return;
    }
    if (intent === 'add-and-preview') {
      addSelectionAndSyncOpenPanes(entry);
      return;
    }
    if (intent === 'select') {
      selectionAnchorPathRef.current = entry.relativePath;
      setSelectedPaths([entry.relativePath]);
      if (entry.kind === 'file' && canPreviewEntry(entry)) { activateMediaPreview(entry); setPreviewPaneOpen(true); }
      return;
    }
    if (availableSelection.length !== selectedPaths.length) setSelectedPaths(availableSelection);
    activateEntry(entry);
  };
  const handleEntryDoubleClick = (event: React.MouseEvent, entry: ProjectFileEntry) => {
    if (suppressDraggedEntryClickRef.current?.path === entry.relativePath) { event.preventDefault(); event.stopPropagation(); return; }
    if (pendingOperationForEntry(entry).pendingOperationId) { event.preventDefault(); event.stopPropagation(); return; }
    if (itemOpenMode !== 'double' || inlineRenamePath === entry.relativePath) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    fileInteractionRevisionRef.current += 1;
    activateEntry(entry);
  };
  const handleFileSurfacePointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointerTarget = event.target as HTMLElement;
    // Focusing the entry during the capture phase would blur the rename input
    // before its own pointer handler gets a chance to run.
    if (pointerTarget.closest('[data-inline-rename-input]')) return;
    const target = pointerTarget.closest<HTMLElement>('[data-entry-path]');
    target?.focus({ preventScroll: true });
    if (target?.dataset.entryPath) {
      const relativePath = target.dataset.entryPath;
      entryPointerModifiersRef.current = fileEntryPointerModifiers({
        path: relativePath,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        pointerType: event.pointerType as 'mouse' | 'pen' | 'touch',
      });
    }
  };
  const getEntryDisplayName = (entry: ProjectFileEntry) => entry.kind === 'shortcut' && entry.name.toLocaleLowerCase().endsWith('.lnk')
    ? entry.name.slice(0, -4)
    : entry.name;
  const getEntryTypeLabel = (entry: ProjectFileEntry) => entry.sourceChannel === 'inspiration' ? '灵感库'
    : entry.kind === 'folder' ? '文件夹'
      : entry.kind === 'shortcut' ? '快捷方式'
        : entry.kind === 'raw' ? `RAW · ${entry.extension.slice(1)}`
          : entry.kind === 'video' ? `视频 · ${entry.extension.slice(1)}`
            : entry.extension.slice(1) || '文件';
  const renderEntryName = (entry: ProjectFileEntry, grid = false) => inlineRenamePath === entry.relativePath ? <input
    data-inline-rename-input="true"
    autoFocus
    value={inlineRenameValue}
    onFocus={event => event.currentTarget.setSelectionRange(0, getInlineRenameSelectionEnd(entry))}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onChange={event => setInlineRenameValue(event.target.value)}
    onBlur={() => { void commitInlineRename(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); void commitInlineRename(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelInlineRename(); }
    }}
    className={`${grid ? 'mt-2 w-full text-xs' : 'min-w-0 flex-1 text-sm'} rounded border border-blue-500 bg-white px-1.5 py-0.5 text-slate-800 outline-none ring-2 ring-blue-200`}
  /> : grid ? <p className="mt-2 truncate text-xs font-medium text-slate-700">{getEntryDisplayName(entry)}</p> : <span className="truncate font-medium text-slate-700">{getEntryDisplayName(entry)}</span>;
  const renderEntryIcon = (entry: ProjectFileEntry, large = false, queueOrder = displayedFileEntries.findIndex(candidate => candidate.path === entry.path)) => {
    const visualEntry = entry;
    if (isFolderLikeEntry(visualEntry)) {
      const cover = <FolderCover entry={visualEntry} cacheConfig={mediaCacheConfig} requestedSize={large ? 320 : 160} queueOrder={queueOrder} large={large} loadEntries={loadDirectoryPreviewEntries}/>;
      return <>{cover}</>;
    }
    if (visualEntry.kind === 'shortcut') {
      const shortcutIcon = <ShortcutEntryIcon entry={visualEntry} cacheConfig={mediaCacheConfig} requestedSize={large ? 320 : 160} queueOrder={queueOrder} large={large} loadEntries={loadDirectoryPreviewEntries}/>;
      return large ? <span className="relative flex h-full w-full min-h-0 min-w-0 items-center justify-center">{shortcutIcon}</span> : shortcutIcon;
    }
    const thumbnailDecoder = decoderForFile(previewDecoders.filter(item => item.thumbnails), visualEntry.name);
    if (thumbnailDecoder) return <ComponentFileThumbnail relativePath={visualEntry.relativePath} updatedAt={visualEntry.updatedAt} decoder={thumbnailDecoder} context={{ workspacePath: componentWorkspacePath, projectId: project.id, projectName: project.name, projectStatus: project.status, scopeRelativePath: currentRelativePath, sourcePageId: pageId, contentKind: componentContentKind }} size={large ? gridThumbnailSize : 160} fallback={<SystemFileIcon filePath={visualEntry.path} size={large ? 48 : 28}/>}/>;
    if (visualEntry.kind === 'image' || visualEntry.kind === 'raw' || visualEntry.kind === 'video') return <><MediaThumbnail entry={visualEntry} cacheConfig={mediaCacheConfig} requestedSize={large ? gridThumbnailSize : 160} queueOrder={queueOrder} large={large}/></>;
    return <SystemFileIcon filePath={visualEntry.path} size={large ? 48 : 28}/>;
  };
  const entryHasPreviewState = (entry: ProjectFileEntry) => previewHighlightPath === entry.relativePath || directoryReturnHighlightPath === entry.relativePath;
  const renderEntrySelectionControl = (entry: ProjectFileEntry, list = false) => {
    const selected = selectedPaths.includes(entry.relativePath);
    const pending = Boolean(pendingOperationForEntry(entry).pendingOperationId);
    return <button
      type="button"
      disabled={pending}
      aria-pressed={selected}
      aria-label={`${selected ? t("ui.deselect.74966e") : t("ui.choose.c11330")} ${getEntryDisplayName(entry)}`}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}
      onClick={event => {
        event.stopPropagation();
        if (event.detail > 1) return;
        if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey);
        else toggleSelected(entry.relativePath);
      }}
      className={`${list ? 'file-select-box' : 'file-grid-select'} ${selected ? 'is-selected border-blue-600 bg-blue-600 text-white' : `border-slate-300 ${list ? 'bg-white' : 'bg-white/90'} text-transparent`} ${list ? 'flex h-4 w-4 shrink-0' : 'absolute left-3 top-3 z-10 flex h-4 w-4'} items-center justify-center rounded border`}
    ><CheckSquare size={12}/></button>;
  };
  const entryDragPaths = (entry: ProjectFileEntry) => {
    return fileEntryDragPaths(entry.relativePath, selectedPaths, path => activeFileEntries.some(candidate => candidate.relativePath === path && isUnsupportedShortcutContent(candidate)));
  };
  const resetNativeDragSession = (expectedSessionId: string) => {
    const session = nativeFileDragSessionRef.current;
    if (!session || session.id !== expectedSessionId) return false;
    if (session.folderTabSource) window.dispatchEvent(new Event('photoflow:folder-tab-drag-end'));
    nativeFileDragSessionRef.current = null;
    internalDragPathsRef.current = [];
    internalDropHandledRef.current = false;
    if (suppressDraggedEntryClickRef.current?.sessionId === expectedSessionId) suppressDraggedEntryClickRef.current = null;
    setDragTargetPath(''); setRecursiveDropTargetPath(null); setSurfaceDropActive(false);
    return true;
  };
  const startEntryDrag = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry, origin: 'file-browser' | 'version-tree' = 'file-browser') => {
    event.preventDefault();
    event.stopPropagation();
    const { requestedPaths, dragPaths } = entryDragPaths(entry);
    if (pendingPathConflicts(pendingFileOperationsRef.current, requestedPaths)) { onNotice('所选项目正在处理中，暂时不能拖动'); return; }
    if (!dragPaths.length) return;
    const sessionId = crypto.randomUUID();
    const folderTabSource = origin === 'file-browser' && dragPaths.length === 1 && isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry);
    internalDragPathsRef.current = origin === 'file-browser' ? dragPaths : [];
    internalDropHandledRef.current = false;
    nativeFileDragSessionRef.current = { id: sessionId, origin, paths: dragPaths, folderTabSource };
    suppressDraggedEntryClickRef.current = { path: entry.relativePath, sessionId };
    if (folderTabSource) window.dispatchEvent(new Event('photoflow:folder-tab-drag-start'));
    tryStartNativeFileDrag(() => projectWorkspaceClient.startProjectFileDrag(workspacePath, project.status, project.name, dragPaths, {
      sessionId, sourcePageId: pageId, origin,
    }), () => { if (resetNativeDragSession(sessionId)) onNotice('无法开始文件拖动，请重试'); });
  };
  const finishEntryDrag = () => {
    internalDragPathsRef.current = [];
    setDragTargetPath(''); setRecursiveDropTargetPath(null); setSurfaceDropActive(false);
  };
  useEffect(() => {
    const nextIdentity = nativeFileDragOwnerIdentity(pageId, project.path); const reset = nativeFileDragSessionMustReset(nativeFileDragOwnerIdentityRef.current, nextIdentity, active); nativeFileDragOwnerIdentityRef.current = nextIdentity;
    if (!reset) return;
    if (nativeFileDragSessionRef.current?.folderTabSource) window.dispatchEvent(new Event('photoflow:folder-tab-drag-end'));
    nativeFileDragSessionRef.current = null;
    internalDragPathsRef.current = []; internalDropHandledRef.current = false; suppressDraggedEntryClickRef.current = null;
    setDragTargetPath(''); setRecursiveDropTargetPath(null); setSurfaceDropActive(false);
  }, [active, pageId, project.path]);
  const hasExternalDropData = (event: React.DragEvent<HTMLElement>) => !nativeFileDragSessionRef.current
    && internalDragPathsRef.current.length === 0
    && hasImportableExternalDragData(event.dataTransfer);
  const getExternalDropPayload = async (event: React.DragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer.files);
    const remoteUrls = extractBrowserImageUrls(event.dataTransfer);
    const externalPaths: string[] = [];
    const browserProvidedFiles: File[] = [];
    for (const file of files) {
      let localPath = '';
      try { localPath = projectWorkspaceClient.getPathForFile(file); }
      catch { /* Browser virtual files do not have a local filesystem path. */ }
      if (localPath) externalPaths.push(localPath);
      else browserProvidedFiles.push(file);
    }
    if (externalPaths.length) return { externalPaths, droppedImageFiles: [] as DroppedBrowserImageFile[], remoteUrls: [] as string[] };
    const droppedImageFiles = await readBrowserProvidedImageFiles(browserProvidedFiles);
    return { externalPaths, droppedImageFiles, remoteUrls: droppedImageFiles.length ? [] : remoteUrls };
  };
  const internalMovePathsForTarget = (paths: string[], targetRelativePath: string) => {
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const normalizedSources = paths.map(source => ({ source, normalized: normalizeProjectRelativePath(source) }));
    if (normalizedSources.some(({ normalized }) => normalizedTarget === normalized || normalizedTarget.startsWith(`${normalized}/`))) return [];
    return normalizedSources.filter(({ normalized }) => projectRelativeParentPath(normalized) !== normalizedTarget).map(({ source }) => source);
  };
  const canDropInternalIntoFolder = (entry: ProjectFileEntry) => internalMovePathsForTarget(internalDragPathsRef.current, entry.relativePath).length > 0;
  const resolveNativeDragTarget = (element: Element | null) => nativeFileDragTargetFromElement({ element, surface: filesSurfaceRef.current, currentRelativePath: currentRelativePathRef.current, rootLabel: project.name, normalize: normalizeProjectRelativePath });
  const reportNativeDragDecision = (reason: string, result: { clientX: number; clientY: number; insideWindow: boolean; started: boolean }, targetSource = 'none') => window.electronAPI?.reportRendererInfo?.('Native project file drag decision', nativeFileDragDecisionDetails(reason, result, targetSource));
  const trackingSuggestionsForCreatedItems = (items: Array<{ name: string; relativePath: string; isDirectory: boolean }>) => {
    const folders = items.filter(item => item.isDirectory).map(item => ({
      relativePath: normalizeProjectRelativePath(item.relativePath),
      name: item.name,
      mediaKind: /(mov|video|视频|剪辑|成片)/iu.test(item.name) ? 'video' as const : 'image' as const,
    }));
    const hasRawFolder = folders.some(folder => /^(raw|原片|原图|底片)$/iu.test(folder.name));
    return folders.filter(folder => !(hasRawFolder && /^(jpg|jpeg|preview|previews|proxy|预览|代理)$/iu.test(folder.name)));
  };
  const performDirectoryDrop = async (internalPaths: string[], externalPaths: string[], droppedImageFiles: DroppedBrowserImageFile[], remoteUrls: string[], targetRelativePath: string, targetName: string) => {
    const requestedProjectPath = projectPathRef.current;
    const operation = internalPaths.length ? 'move' : droppedImageFiles.length ? 'import-data' : remoteUrls.length ? 'import-url' : 'import';
    const paths = internalPaths.length ? internalPaths : remoteUrls.length ? remoteUrls : externalPaths;
    const moving = operation === 'move';
    if (!paths.length && !droppedImageFiles.length) return;
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const pendingOperation = startPendingFileOperation({
      kind: moving ? 'move' : 'import', label: moving ? '正在移动…' : droppedImageFiles.length || remoteUrls.length ? '正在保存网页图片…' : '正在导入…',
      lockedPaths: [...internalPaths, `__directory__/${normalizedTarget || '__root__'}`, ...(normalizedTarget ? [normalizedTarget] : [])],
      affectedDirectories: [normalizedTarget, ...internalPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path)))],
      tombstonePaths: moving ? internalPaths : undefined,
    });
    if (!pendingOperation) return;
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.projectFileOperation>>;
    try {
      result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, operation, paths, targetRelativePath, '', droppedImageFiles.length ? { droppedImageFiles } : undefined);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
    } catch (error) {
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      await reconcilePendingFileOperation(pendingOperation, undefined);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      onNotice(`${moving ? '移动' : '导入'}失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
      return;
    }
    const pageOwnsNotice = pageOwnsFileOperationNotification(result);
    if (result.cancelled) { await reconcilePendingFileOperation(pendingOperation, result); if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return; if (pageOwnsNotice) onNotice(moving ? '移动已取消' : '导入已取消'); return; }
    if (!result.success) { await reconcilePendingFileOperation(pendingOperation, result); if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return; if (pageOwnsNotice) onNotice(`${moving ? '移动' : '导入'}失败：${result.error || '未知错误'}`); return; }
    if (moving) setCutPaths(current => current.filter(path => !paths.includes(path)));
    setSelectedPaths([]);
    if (pageOwnsNotice) onNotice(`已${moving ? '移动' : '导入'} ${result.count} 个项目到 ${targetName}`);
    if (!moving && projectWorkflows) {
      const folders = trackingSuggestionsForCreatedItems(result.createdItems || []);
      if (folders.length) setPendingProgressFolders(folders);
    }
    await reconcilePendingFileOperation(pendingOperation, result);
    if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
    refreshRecursiveResults([targetRelativePath, ...internalPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path)))]);
  };
  const handleEntryDragOver = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (!isFolderLikeEntry(entry) || (!canDropInternalIntoFolder(entry) && !hasExternalDropData(event))) return;
    event.preventDefault();
    event.stopPropagation();
    // Electron's native file drag advertises copy support to Windows. Accept it
    // as copy here so the cursor is not shown as forbidden; an internal drop is
    // still completed as a move by the main process.
    event.dataTransfer.dropEffect = 'copy';
    setSurfaceDropActive(false);
    setRecursiveDropTargetPath(null);
    if (dragTargetPath !== entry.relativePath) setDragTargetPath(entry.relativePath);
  };
  const handleEntryDragLeave = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (dragTargetPath === entry.relativePath) setDragTargetPath('');
  };
  const handleEntryDrop = async (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (!isFolderLikeEntry(entry)) return;
    const requestedInternalPaths = [...internalDragPathsRef.current];
    const externalDrop = !requestedInternalPaths.length && hasExternalDropData(event);
    if (externalDrop) { event.preventDefault(); event.stopPropagation(); }
    const internalPaths = internalMovePathsForTarget(requestedInternalPaths, entry.relativePath);
    const { externalPaths, droppedImageFiles, remoteUrls } = requestedInternalPaths.length ? { externalPaths: [], droppedImageFiles: [], remoteUrls: [] } : await getExternalDropPayload(event);
    if (requestedInternalPaths.length ? !internalPaths.length : !externalPaths.length && !droppedImageFiles.length && !remoteUrls.length) {
      if (externalDrop) onNotice('无法读取拖入的文件或网页图片，请重新拖入');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    internalDropHandledRef.current = requestedInternalPaths.length > 0;
    finishEntryDrag();
    setSurfaceDropActive(false);
    await performDirectoryDrop(internalPaths, externalPaths, droppedImageFiles, remoteUrls, entry.relativePath, entry.name);
  };
  const handleRecursiveFolderDragOver = (event: React.DragEvent<HTMLElement>, targetRelativePath: string, readOnly: boolean) => {
    if (readOnly) return;
    const internalPaths = internalMovePathsForTarget(internalDragPathsRef.current, targetRelativePath);
    if (internalDragPathsRef.current.length ? !internalPaths.length : !hasExternalDropData(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setSurfaceDropActive(false);
    setDragTargetPath('');
    setRecursiveDropTargetPath(normalizeProjectRelativePath(targetRelativePath));
  };
  const handleRecursiveFolderDragLeave = (event: React.DragEvent<HTMLElement>, targetRelativePath: string) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (recursiveDropTargetPath === normalizeProjectRelativePath(targetRelativePath)) setRecursiveDropTargetPath(null);
  };
  const handleRecursiveFolderDrop = async (event: React.DragEvent<HTMLElement>, targetRelativePath: string, targetName: string, readOnly: boolean) => {
    if (readOnly) return;
    const requestedInternalPaths = [...internalDragPathsRef.current];
    const externalDrop = !requestedInternalPaths.length && hasExternalDropData(event);
    if (externalDrop) { event.preventDefault(); event.stopPropagation(); }
    const internalPaths = internalMovePathsForTarget(requestedInternalPaths, targetRelativePath);
    const { externalPaths, droppedImageFiles, remoteUrls } = requestedInternalPaths.length ? { externalPaths: [], droppedImageFiles: [], remoteUrls: [] } : await getExternalDropPayload(event);
    if (requestedInternalPaths.length ? !internalPaths.length : !externalPaths.length && !droppedImageFiles.length && !remoteUrls.length) {
      if (externalDrop) onNotice('无法读取拖入的文件或网页图片，请重新拖入');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    internalDropHandledRef.current = requestedInternalPaths.length > 0;
    finishEntryDrag();
    setSurfaceDropActive(false);
    await performDirectoryDrop(internalPaths, externalPaths, droppedImageFiles, remoteUrls, normalizeProjectRelativePath(targetRelativePath), targetName);
  };
  useEffect(() => {
    const acceptInternalFolderDrag = (event: DragEvent) => {
      const session = nativeFileDragSessionRef.current;
      if (!activeRef.current || !session || session.origin !== 'file-browser' || !internalDragPathsRef.current.length) return;
      const target = resolveNativeDragTarget(event.target as HTMLElement | null);
      if (!target || !internalMovePathsForTarget(internalDragPathsRef.current, target.relativePath).length) {
        setDragTargetPath(''); setRecursiveDropTargetPath(null);
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      if (target.element.dataset.entryKind === 'folder') {
        setRecursiveDropTargetPath(null); setDragTargetPath(target.relativePath);
      } else if (target.element.dataset.recursiveFolderPath !== undefined) {
        setDragTargetPath(''); setRecursiveDropTargetPath(target.relativePath);
      } else {
        setDragTargetPath(''); setRecursiveDropTargetPath(null);
      }
    };
    window.addEventListener('dragover', acceptInternalFolderDrag, true);
    return () => window.removeEventListener('dragover', acceptInternalFolderDrag, true);
  }, []);
  projectFileDragEndHandlerRef.current = result => {
    const session = nativeFileDragSessionRef.current;
    if (!session || result.sessionId !== session.id || result.sourcePageId !== pageId) return;
    nativeFileDragSessionRef.current = null;
    const releaseElement = result.insideWindow ? document.elementFromPoint(result.clientX, result.clientY) : null;
    if (session.folderTabSource) window.dispatchEvent(new Event('photoflow:folder-tab-drag-end'));
    const clickSuppression = suppressDraggedEntryClickRef.current;
    window.setTimeout(() => { if (suppressDraggedEntryClickRef.current === clickSuppression) suppressDraggedEntryClickRef.current = null; }, 250);
    const dragPaths = result.paths?.length ? result.paths : session.paths;
    finishEntryDrag();
    if (internalDropHandledRef.current) {
      internalDropHandledRef.current = false; reportNativeDragDecision('html-drop-already-handled', result, 'html-drop'); return;
    }
    if (!result.started) { reportNativeDragDecision('native-drag-not-started', result); return; }
    if (!result.insideWindow) { reportNativeDragDecision('released-outside-window', result); return; }
    const titlebarDropZone = releaseElement?.closest<HTMLElement>('[data-folder-tab-drop-zone="true"]');
    if (session.folderTabSource && titlebarDropZone && dragPaths.length === 1 && onOpenDirectoryPage) {
      const draggedEntry = activeFileEntries.find(entry => normalizeProjectRelativePath(entry.relativePath) === normalizeProjectRelativePath(dragPaths[0]));
      if (draggedEntry && isFolderLikeEntry(draggedEntry) && !isUnsupportedShortcutContent(draggedEntry)) {
        reportNativeDragDecision('folder-tab-opened', result, 'release-hit-test');
        onOpenDirectoryPage(draggedEntry.relativePath);
        return;
      }
    }
    const target = resolveNativeDragTarget(releaseElement);
    if (session.origin === 'version-tree') {
      reportNativeDragDecision(target ? 'version-tree-internal-target-rejected' : 'version-tree-external-drag-ended', result, target ? 'release-hit-test' : 'none');
      return;
    }
    if (!dragPaths.length) { reportNativeDragDecision('empty-source-set', result); return; }
    if (!target) { reportNativeDragDecision('no-internal-target', result); return; }
    const targetRelativePath = target.relativePath;
    const movablePaths = internalMovePathsForTarget(dragPaths, targetRelativePath);
    if (!movablePaths.length) { reportNativeDragDecision('target-is-source-or-current-parent', result, 'release-hit-test'); return; }
    reportNativeDragDecision('internal-move-accepted', result, 'release-hit-test');
    void performDirectoryDrop(movablePaths, [], [], [], targetRelativePath, target.label);
  };
  useEffect(() => projectWorkspaceClient.onProjectFileDragEnd(result => projectFileDragEndHandlerRef.current(result)), []);
  const handleSurfaceDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalDropData(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!surfaceDropActive) setSurfaceDropActive(true);
  };
  const handleSurfaceDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setSurfaceDropActive(false);
  };
  const handleSurfaceDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalDropData(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const { externalPaths, droppedImageFiles, remoteUrls } = await getExternalDropPayload(event);
    setSurfaceDropActive(false);
    if (!externalPaths.length && !droppedImageFiles.length && !remoteUrls.length) { onNotice('无法读取拖入的文件或网页图片，请重新拖入'); return; }
    if (finalViewOpen) { onNotice('喜爱图片浏览是只读视图，不能导入文件'); return; }
    await performDirectoryDrop([], externalPaths, droppedImageFiles, remoteUrls, currentRelativePath, currentRelativePath.split('/').pop() || project.name);
  };
  useEffect(() => {
    const workspace = projectWorkspaceRef.current;
    if (!workspace || viewMode !== 'grid') return;
    const zoomSurface = workspace.closest('main') || workspace;
    const zoomWithWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], .fixed')) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.deltaY < 0 ? 1 : -1;
      const intensity = Math.max(8, Math.min(32, Math.abs(event.deltaY) / 3));
      setGridIconSize(current => rememberFolderGridIconSize(currentRelativePathRef.current, current + direction * intensity));
    };
    zoomSurface.addEventListener('wheel', zoomWithWheel, { capture: true, passive: false });
    return () => {
      zoomSurface.removeEventListener('wheel', zoomWithWheel, true);
    };
  }, [viewMode, folderGridIconSizeStorageKey]);

  const versionTreeStatusLabel = (folder: ProgressFolder) => trackingStateLabel(folder);
  const adoptVersionTreeFolder = async (entry: Pick<ProjectFileEntry, 'name' | 'relativePath'>, mode: 'original' | 'broll', mediaKind: 'image' | 'video' | 'mixed') => {
    const result = await projectWorkspaceClient.adoptVersionTreeFolder(workspacePath, project.status, {
      projectName: project.name,
      relativePath: entry.relativePath,
      mode,
      mediaKind,
    });
    if (!result.success || !result.progressFolder) {
      onNotice(`标记失败：${result.error || '未知错误'}`, 5000);
      return false;
    }
    await loadProgressFolders();
    onNotice(mode === 'original' ? `已将“${entry.name}”设为${mediaKind === 'image' ? '图片' : '视频'}原始素材。` : `已将“${entry.name}”标记为花絮。`);
    return true;
  };
  adoptVersionTreeFolderRef.current = adoptVersionTreeFolder;
  const renderVersionTreeEntry = (entry: ProjectFileEntry, progressFolder?: ProgressFolder, sourceKind?: 'image' | 'video') => {
    const selected = selectedPaths.includes(entry.relativePath);
    const previewed = entryHasPreviewState(entry);
    const returnHighlighted = directoryReturnHighlightPath === entry.relativePath;
    const workflow = progressFolder?.nodeRole === 'workflow';
    const previewArtifact = progressFolder?.nodeRole === 'artifact' && progressFolder.artifactKind === 'preview';
    const transcodeArtifact = progressFolder?.nodeRole === 'artifact' && progressFolder.artifactKind === 'transcode';
    const displayName = getEntryDisplayName(entry);
    const statusLabel = progressFolder
      ? progressFolder.nodeRole === 'original' ? '原始素材'
        : progressFolder.nodeRole === 'broll' ? '花絮'
        : progressFolder.nodeRole === 'selection' || progressFolder.relationKind === 'auxiliary' ? '选片辅助节点'
          : previewArtifact ? '预览产物'
            : transcodeArtifact ? '转码产物'
            : workflow ? '协作工作区'
              : versionTreeStatusLabel(progressFolder)
      : sourceKind === 'image' ? '原始图片素材'
        : sourceKind === 'video' ? '原始视频素材'
          : getEntryTypeLabel(entry);
    return <div
      role="button"
      tabIndex={0}
      draggable={false}
      onDragOver={event => handleEntryDragOver(event, entry)}
      onDragLeave={event => handleEntryDragLeave(event, entry)}
      onDrop={event => void handleEntryDrop(event, entry)}
      data-entry-kind={entry.kind}
      data-drop-capable={isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry) ? 'true' : 'false'}
      data-entry-path={entry.relativePath}
      data-return-highlight={returnHighlighted ? 'true' : undefined}
      onMouseEnter={() => prefetchDirectory(entry)}
      onClick={event => handleEntryClick(event, entry)}
      onDoubleClick={event => handleEntryDoubleClick(event, entry)}
      onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }}
      onContextMenu={event => openFileMenu(event, entry)}
      title={entry.name}
      className={`group relative min-w-0 cursor-default rounded-lg border p-2 text-left transition ${progressFolder ? 'border-transparent bg-slate-500/[0.025] hover:border-blue-300/60 hover:bg-blue-500/[0.04]' : 'overflow-hidden border-transparent hover:bg-blue-50'} ${selected ? 'border-blue-400/80 bg-blue-500/[0.07] ring-1 ring-blue-400/70 shadow-sm focus-visible:outline-none' : ''} ${previewed && !selected ? 'project-file-entry-preview' : ''} ${previewArtifact ? 'border-amber-400/20' : transcodeArtifact ? 'border-blue-400/20' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'border-blue-500 bg-blue-100 ring-2 ring-blue-500' : ''}`}
    >
      {renderEntrySelectionControl(entry)}
      {progressFolder && (progressFolder.nodeRole === 'progress' ? <button type="button" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); openMarkProgress(entry); }} title={t("ui.edit.v.value0.progress.131a3c", { value0: progressFolder.versionKey })} aria-label={t("ui.edit.v.value0.progress.131a3c", { value0: progressFolder.versionKey })} className="absolute right-3 top-3 z-10 rounded-full bg-blue-600 px-2 py-1 text-[10px] font-bold text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-300">{versionTreeNodeBadgeLabel(progressFolder)}</button> : <span className={`absolute right-3 top-3 z-10 rounded-full px-2 py-1 text-[10px] font-bold shadow-sm ${progressFolder.nodeRole === 'selection' || progressFolder.relationKind === 'auxiliary' || workflow ? 'bg-violet-600 text-white' : previewArtifact ? 'bg-amber-500 text-white' : transcodeArtifact ? 'bg-blue-600 text-white' : 'bg-slate-700 text-white'}`}>{versionTreeNodeBadgeLabel(progressFolder)}</span>)}
      {!progressFolder && sourceKind && <span className="absolute right-3 top-3 z-10 rounded-full bg-slate-700 px-2 py-1 text-[10px] font-bold text-white shadow-sm">{t("ui.original.media.2a53f2")}</span>}
      <div className={`relative flex aspect-square items-center justify-center ${previewArtifact ? 'rounded-xl bg-amber-500/[0.035]' : transcodeArtifact ? 'rounded-xl bg-blue-500/[0.035]' : ''}`}>{renderEntryIcon(entry, true)}</div>
      {progressFolder && inlineRenamePath !== entry.relativePath ? <p className="mt-1 truncate text-xs font-medium text-slate-700" title={displayName}>{displayName}</p> : renderEntryName(entry, true)}
      <p className={`mt-0.5 truncate text-[10px] ${progressFolder?.trackingState === 'needs_repair' ? 'font-bold text-amber-600' : 'text-slate-400'}`}><span aria-hidden className="mr-1">●</span>{statusLabel}</p>
    </div>;
  };

  const progressCompareCandidates = progressCompare ? [...progressCompare.matches, ...progressCompare.suggestions] : [];
  const progressCompareAcceptedReferences = new Set(progressCompareCandidates.filter(match => progressCompare?.acceptedSources.includes(match.source)).map(match => match.reference));
  const progressCompareMissingReferences = progressCompare?.unmatchedReferences.filter(reference => !progressCompareAcceptedReferences.has(reference)) || [];
  const progressCompareNewSources = progressCompare ? progressCompareNewSourcesFor(progressCompare) : [];
  const progressCompareListItems = progressCompare ? buildProgressCompareListItems(progressCompare, progressCompareFilter) : [];
  const activeProgressCompareItem = progressCompareListItems.find(item => item.key === activeProgressCompareItemKey);
  const photoshopToolbarAvailable = photoshopAvailable && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(isPhotoshopOpenEntry);
  // Do not recursively inspect folders just to decide whether contextual tools
  // should be visible. Folder-based tools validate and collect their inputs only
  // after the user explicitly starts that workflow.
  const imageConverterToolbarAvailable = !finalViewOpen && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length
    && selectedEntries.some(entry => isFolderLikeEntry(entry) || JPG_CONVERSION_EXTENSIONS.has(entry.extension.toLocaleLowerCase()));
  const videoToolsToolbarAvailable = !finalViewOpen && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length
    && selectedEntries.every(entry => isFolderLikeEntry(entry) || entry.kind === 'video');
  const fileMenuHasVideoTarget = fileMenuEntries.length > 0 && fileMenuEntries.every(entry => isFolderLikeEntry(entry) || entry.kind === 'video');
  const fileMenuHasConvertibleImageTarget = fileMenuEntries.some(entry => isFolderLikeEntry(entry) || JPG_CONVERSION_EXTENSIONS.has(entry.extension.toLocaleLowerCase()));
  const fileMenuHasVideoSplitTarget = !finalViewOpen && fileMenuHasVideoTarget;
  const videoToolPanelContributions = componentContributions.filter(item => item.type === 'component.sidePanel' && item.placement === 'workspace.videoTools');
  const visibleComponentHostActions = visibleComponentToolbarActions(componentHostActions, componentContributions);
  const videoTranscodeContribution = videoToolPanelContributions.find(item => item.componentId === 'video-tools' && item.contributionId === 'transcode');
  const videoSplitContribution = videoToolPanelContributions.find(item => item.componentId === 'video-tools' && item.contributionId === 'split');
  const menuContributions = (placement: WorkspaceToolPlacement) => workspaceToolContributions(componentContributions, placement)
    .filter(item => item !== videoTranscodeContribution && item !== videoSplitContribution);
  const toolbarHasSafeToolSelection = componentHostSelectedRelativePaths.length > 0 && componentHostSelectedRelativePaths.length === selectedEntries.length;
  const fileMenuHasSafeToolSelection = fileMenuEntries.length > 0 && fileMenuEntries.length === fileMenuTargetPaths.length && !fileMenuContainsShortcutContent;
  const fileMenuHasPlacedToolAction = (placement: WorkspaceToolPlacement) => fileMenuHasSafeToolSelection && menuContributions(placement).length > 0;
  const renderPlacedToolActions = (placement: WorkspaceToolPlacement, contextMenu = false) => menuContributions(placement).map(contribution => {
    const available = contextMenu ? fileMenuHasSafeToolSelection : toolbarHasSafeToolSelection || (!selectedEntries.length && contribution.type === 'project.contextAction');
    return <button key={`${contribution.componentId}:${contribution.contributionId}`} type="button" disabled={!available} title={available ? contribution.title : t("ui.select.files.or.folders.9cbf39")} className="project-menu-item" onClick={event => {
      event.stopPropagation();
      const scope = projectContributionScope(currentRelativePath, pageId, contextMenu ? fileMenuTargetPaths : componentHostSelectedRelativePaths, componentContentKind);
      setFileMenu(null); setShowVideoToolsMenu(false); setShowImageToolsMenu(false); setShowOfficeToolsMenu(false); setShowToolbarOverflowMenu(false);
      const action = resolvePlacedFullPageAction(contribution, componentHostActions);
      if (action) onOpenComponentPage(action, scope);
      else window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution, scope } }));
    }}><ComponentIcon src={contribution.iconUrl} size={14}/>{contribution.label}</button>;
  });
  const openVideoToolContribution = (contribution: ComponentContribution | undefined, relativePaths: string[]) => {
    if (!contribution) { onNotice('视频处理插件未安装或不可用'); return; }
    window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution, scope: { scopeRelativePath: currentRelativePath, selectedRelativePaths: relativePaths, sourcePageId: pageId, contentKind: componentContentKind } } }));
  };
  const fileMenuOfficeEntries = !finalViewOpen && fileMenuEntries.length > 0 && fileMenuEntries.every(isOfficeOpenXmlEntry) ? fileMenuEntries : [];
  const fileMenuHasToolActions = Boolean(fileMenu && (fileMenuHasVideoTarget || (['workspace.videoTools', 'workspace.imageTools', 'workspace.officeTools'] as const).some(fileMenuHasPlacedToolAction) || fileMenuHasConvertibleImageTarget || fileMenuScreenshotMainImageEntries.length || fileMenuOfficeEntries.length));
  const selectedCanSetVersionProgress = Boolean(projectWorkflows && selectedProgressFolder && !selectedRegisteredProgressFolder && !isUnsupportedShortcutContent(selectedProgressFolder));
  const versionManagementToolbarAvailable = Boolean(selectedEditableProgressFolder) || selectedCanSetVersionProgress || selectedEntries.length === 1 && hasVersionProgressForEntry(selectedEntries[0]);
  const projectToolbarAvailability: Record<ProjectToolbarActionId, boolean> = {
    'filename-selection': true,
    'select-media': canSelectMedia,
    'video-tools': true,
    'image-tools': true,
    photoshop: photoshopToolbarAvailable,
    'office-extract': true,
    'version-management': versionManagementToolbarAvailable,
  };
  const unavailableProjectToolbarTitle = (label: string, reason: string) => `${label}，${reason}`;
  const projectToolbarButtons: Record<ProjectToolbarActionId, React.ReactNode> = {
    'filename-selection': <button onClick={() => togglePanel('match')} title={t("ui.select.by.file.name.611d95")} aria-label={t("ui.select.by.file.name.611d95")} className="project-action-button"><FileText size={16}/>{t("ui.select.by.file.name.611d95")}</button>,
    'select-media': <button disabled={!canSelectMedia} title={canSelectMedia ? t("ui.selection.add.selected.media.to.the.853ba0") : unavailableProjectToolbarTitle('选片', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '需选择选片源素材使用')} aria-label={t("ui.selection.8c8db6")} onClick={() => void selectMediaFiles()} className="project-action-button"><CheckCircle2 size={16}/>{t("ui.selection.8c8db6")}</button>,
    'video-tools': <div className="project-toolbar-tool-group relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !showVideoToolsMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowVideoToolsMenu(next); }} title={t("ui.video.tools.d2442c")} aria-label={t("ui.video.tools.d2442c")} aria-haspopup="menu" aria-expanded={showVideoToolsMenu} className={`project-action-button ${showVideoToolsMenu || panel === 'research' ? 'bg-blue-50 text-blue-600' : ''}`}><Video size={16}/>{t("ui.video.tools.d2442c")}<ChevronDown size={13}/></button>{showVideoToolsMenu && <div className="project-toolbar-tool-submenu absolute left-0 top-full z-50 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl"><button type="button" disabled={!selectedResearchTargets.length} title={selectedResearchTargets.length ? t("ui.extract.representative.frames.from.the.selected.13bb3d", { value0: selectedResearchTargets.length }) : t("ui.select.videos.or.folders.3439ba")} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); if (selectedResearchTargets.length) void openResearchForEntries(selectedResearchTargets); }} className="project-menu-item"><Video size={14}/>{t("ui.extract.storyboard.frames.079aa5")}</button>{videoTranscodeContribution && <button type="button" disabled={!videoToolsToolbarAvailable} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); openVideoToolContribution(videoTranscodeContribution, selectedEntries.map(entry => entry.relativePath)); }} className="project-menu-item"><Gauge size={14}/>{t("ui.transcode.video.e5fbc2")}</button>}{videoSplitContribution && <button type="button" disabled={!selectedVideoSplitTargets.length} title={selectedVideoSplitTargets.length ? t("ui.split.selected.videos.or.folders.value0.fd538c", { value0: selectedVideoSplitTargets.length }) : t("ui.select.videos.or.folders.3439ba")} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); if (!selectedVideoSplitTargets.length) { onNotice('请先选择视频或文件夹'); return; } openVideoToolContribution(videoSplitContribution, selectedVideoSplitTargets.map(entry => entry.relativePath)); }} className="project-menu-item"><Cut size={14}/>{t("ui.split.video.cd6df3")}</button>}{renderPlacedToolActions('workspace.videoTools')}</div>}</div>,
    'image-tools': <div className="project-toolbar-tool-group relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !showImageToolsMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowImageToolsMenu(next); }} title={t("ui.image.tools.3c27a4")} aria-label={t("ui.image.tools.3c27a4")} aria-haspopup="menu" aria-expanded={showImageToolsMenu} className={`project-action-button ${showImageToolsMenu || panel === 'converter' || panel === 'screenshot-main-image' ? 'bg-blue-50 text-blue-600' : ''}`}><ImageIcon size={16}/>{t("ui.image.tools.3c27a4")}<ChevronDown size={13}/></button>{showImageToolsMenu && <div className="project-toolbar-tool-submenu absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl"><button type="button" disabled={!imageConverterToolbarAvailable} onClick={event => { event.stopPropagation(); setShowImageToolsMenu(false); setShowToolbarOverflowMenu(false); void openImageConverter(selectedEntries.map(entry => entry.relativePath)); }} title={imageConverterToolbarAvailable ? selectedEntries.length > 1 ? t("ui.convert.images.in.the.selected.files.538072", { value0: selectedEntries.length }) : t("ui.convert.selected.images.or.images.in.c4e7d9") : unavailableProjectToolbarTitle('图片转 JPG', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '请选择可转换的图片或文件夹')} className="project-menu-item"><ImageIcon size={14}/>{t("ui.convert.images.to.jpg.c3edb0")}</button><button type="button" disabled={!canExtractScreenshotMainImage} onClick={event => { event.stopPropagation(); setShowImageToolsMenu(false); setShowToolbarOverflowMenu(false); if (!selectedScreenshotMainImageEntries.length) { onNotice('请先选择要提取主图的截图'); return; } openScreenshotMainImage(selectedScreenshotMainImageEntries); }} title={canExtractScreenshotMainImage ? selectedScreenshotMainImageEntries.length > 1 ? t("ui.detect.and.crop.main.image.areas.6187eb", { value0: selectedScreenshotMainImageEntries.length }) : t("ui.detect.and.crop.the.main.image.702a23") : unavailableProjectToolbarTitle('提取截图主图', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '需选择截图图片使用')} className="project-menu-item"><Crop size={14}/>{t("message.b5c73d110d0c", { value0: selectedScreenshotMainImageEntries.length > 1 ? t("ui.value0.images.e723e0", { value0: selectedScreenshotMainImageEntries.length }) : '' })}</button>{renderPlacedToolActions('workspace.imageTools')}</div>}</div>,
    photoshop: <button disabled={!photoshopToolbarAvailable} onClick={() => void openProjectEntriesInPhotoshop(selectedEntries)} title={photoshopToolbarAvailable ? selectedEntries.length > 1 ? t("ui.send.the.selected.images.raw.files.a44636", { value0: selectedEntries.length }) : t("ui.open.selected.images.or.documents.in.a441a2") : unavailableProjectToolbarTitle('用 Photoshop 打开', !photoshopAvailable ? '未检测到 Photoshop' : '需选择图片、RAW 或 PSD/PSB 使用')} aria-label={t("ui.open.selected.images.raw.files.or.f0623b")} className="project-action-button"><PhotoshopIcon size={16}/>{t("message.6b115ac3c9e9", { value0: selectedEntries.length > 1 && photoshopToolbarAvailable ? t("legacy.message.f8514bc52729", { value0: selectedEntries.length }) : '' })}</button>,
    'office-extract': <div className="project-toolbar-tool-group relative" onClick={event => event.stopPropagation()}>
      <button type="button" onClick={() => { const next = !showOfficeToolsMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowOfficeToolsMenu(next); }} title={t("ui.office.documents.3a80cd")} aria-label={t("ui.office.documents.3a80cd")} aria-haspopup="menu" aria-expanded={showOfficeToolsMenu} className={`project-action-button ${showOfficeToolsMenu || panel === 'office-extract' ? 'bg-blue-50 text-blue-600' : ''}`}><FileImage size={16}/>{t("ui.office.documents.3a80cd")}<ChevronDown size={13}/></button>
      {showOfficeToolsMenu && <div className="project-toolbar-tool-submenu absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
        <button type="button" disabled={!selectedOfficeExtractEntries.length} onClick={() => { setShowOfficeToolsMenu(false); setShowToolbarOverflowMenu(false); openOfficeImageExtractor(selectedOfficeExtractEntries); }} title={selectedOfficeExtractEntries.length ? t("ui.extract.images.from.selected.office.documents.6791b0", { value0: selectedOfficeExtractEntries.length }) : t("ui.select.office.documents.24812e")} className="project-menu-item"><FileImage size={14}/>{t("ui.extract.document.images.de3210")}</button>
        {renderPlacedToolActions('workspace.officeTools')}
      </div>}
    </div>,
    'version-management': selectedEditableProgressFolder ? selectedEditableProgressFolder.trackingState === 'needs_repair' ? <button onClick={() => void openProgressRepair(selectedEditableProgressFolder)} title={t("ui.repair.version.batch.continue.incomplete.version.3afef1")} aria-label={t("ui.repair.version.batch.e5ae0a")} className="project-action-button !text-amber-600"><RefreshCw size={16}/>{t("ui.repair.version.batch.e5ae0a")}</button> : <button disabled={selectedEditableProgressFolder.trackingState === 'committing'} onClick={() => void openMarkProgress(selectedProgressFolder!)} title={selectedEditableProgressFolder.trackingState === 'committing' ? unavailableProjectToolbarTitle('版本管理', '版本批次正在提交') : t("ui.edit.current.version.progress.ca440b")} aria-label={t("ui.edit.progress.a52b5e")} className="project-action-button"><GitBranch size={16}/>{selectedEditableProgressFolder.trackingState === 'committing' ? t("ui.committing.6b7046") : t("ui.edit.progress.a52b5e")}</button> : selectedCanSetVersionProgress ? <button onClick={() => void openMarkProgress(selectedProgressFolder!)} title={t("ui.mark.the.purpose.of.selected.folders.b3d9a8")} aria-label={t("ui.mark.folder.aab1f2")} className="project-action-button"><GitBranch size={16}/>{t("ui.mark.f10902")}</button> : selectedEntries.length === 1 && hasVersionProgressForEntry(selectedEntries[0]) ? <button onClick={() => openVersions()} title={t("ui.view.and.manage.media.versions.92efc9")} aria-label={t("ui.version.history.79b622")} className="project-action-button"><GitBranch size={16}/>{t("ui.version.history.79b622")}</button> : <button disabled title={unavailableProjectToolbarTitle('版本管理', '需选择版本文件夹或已纳入版本的媒体')} aria-label={t("ui.version.history.79b622")} className="project-action-button"><GitBranch size={16}/>{t("ui.version.history.79b622")}</button>,
  };
  const hiddenProjectToolbarActions = new Set(projectToolbar.hidden);
  const visibleProjectToolbarActionIds = projectToolbar.order.filter(id => !hiddenProjectToolbarActions.has(id) && (!projectToolbar.onlyShowAvailable || projectToolbarAvailability[id]));
  const hasProjectToolbarActions = visibleProjectToolbarActionIds.length > 0;
  const versionProgressPanelMode: VersionProgressDraft['mode'] | null = progressSetup
    ? progressSetup.mode === 'mark' ? progressSetup.existingProgressId ? 'modify' : 'create' : progressSetup.mode
    : null;
  const versionProgressPanelTitle = progressSetup?.mode === 'mark' && !progressSetup.existingProgressId ? '标记版本进度'
    : progressSetup?.contextLocked ? '创建下一版本'
    : versionProgressPanelMode === 'create' ? '新建进度'
      : versionProgressPanelMode === 'import' ? '导入 · 进度'
        : '修改进度';
  const versionProgressDraft: VersionProgressDraft | null = progressSetup && versionProgressPanelMode ? {
    mode: progressSetup.contextLocked ? 'create-next' : versionProgressPanelMode,
    sourceRelativePath: progressSetup.targetRelativePath || currentRelativePath,
    displayName: progressSetup.progressName,
    mediaKind: progressSetup.mediaKind,
    relationKind: 'main',
    parentProgressId: progressSetup.parentProgressId,
    trackingEnabled: progressSetup.trackingEnabled,
    renameFromParent: progressSetup.renameSources,
    copyMissingFromParent: progressSetup.copyMissingFromParent,
    workflowInputProgressIds: progressSetup.workflowInputProgressIds,
    sourcePaths: progressSetup.sourcePaths,
    deleteSourceAfterImport: progressSetup.deleteSourceAfterImport,

    existingProgressId: progressSetup.existingProgressId,
    versionKey: progressSetup.versionKey,
    versionKind: progressSetup.relation === 'branch' ? 'branch' : 'main',
    contextLocked: progressSetup.contextLocked,
    targetFolderLocked: Boolean(progressSetup.preserveFolderName),
  } : null;
  const finalExportParentOptions = selectableVersionParents(progressFolders, { mediaKind: 'image', relationKind: 'main' });
  const handleFilesColumnWheelCapture = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!versionTreeOpen || event.ctrlKey || event.deltaY === 0) return;
    if (event.deltaY > 0) {
      setVersionTreeHeaderCollapsed(true);
      return;
    }
    const viewport = event.currentTarget.querySelector<HTMLElement>('[data-version-tree-viewport="true"]');
    if (!viewport || viewport.scrollTop <= 2) setVersionTreeHeaderCollapsed(false);
  };

  return (
    <div ref={projectWorkspaceRef} className="flex h-full w-full min-w-0 flex-col animate-in fade-in duration-300">
      {pendingProgressFolders.length > 0 && !progressSetup && !folderMarkSetup && <div role="dialog" aria-modal="true" aria-label={t("ui.mark.folder.purpose.1e134f")} className="fixed inset-0 z-[339] flex items-center justify-center bg-slate-950/45 p-4"><div className="flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="border-b border-slate-200 px-5 py-4"><h3 className="font-bold text-slate-800">{t("ui.mark.folder.purpose.1e134f")}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{t("ui.choose.original.media.progress.or.behind.78746d")}</p></header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5">{pendingProgressFolders.map(folder => <div key={folder.relativePath} className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-3"><Folder size={18} className="shrink-0 text-blue-500"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-700" title={folder.relativePath}>{folder.name}</p><p className="mt-0.5 truncate text-xs text-slate-400">{t("message.695522bae23d", { value0: folder.relativePath, value1: folder.mediaKind === 'video' ? t("ui.video.c20f76") : t("ui.image.d24c10") })}</p></div><button type="button" className="dialog-secondary shrink-0" onClick={() => { const relativePath = folder.relativePath; openMarkProgress({ name: folder.name, path: `${project.path}/${relativePath}`, relativePath, kind: 'folder', extension: '', size: 0, createdAt: Date.now(), updatedAt: Date.now() }, folder.mediaKind); }}>{t("ui.mark.f10902")}</button></div>)}</div>
        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><p className="text-xs text-slate-500">{t("ui.you.can.also.right.click.a.5b2404")}</p><button type="button" onClick={() => setPendingProgressFolders([])} className="dialog-secondary">{t("ui.not.now.44ea05")}</button></footer>
      </div></div>}
      {fileMenu && createPortal(<ViewportContextMenu x={fileMenu.x} y={fileMenu.y} widthClass="w-52" allowSubmenus>
        {isFolderLikeEntry(fileMenu.entry) && !isUnsupportedShortcutContent(fileMenu.entry) && onOpenDirectoryPage && <><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); onOpenDirectoryPage(entry.relativePath); }}><FolderPlus size={14}/>{t("ui.open.in.new.tab.79c5e0")}</button><div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && isFolderLikeEntry(fileMenu.entry) && !fileMenuVersionTreeFolder && <><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openMarkProgress(entry); }}><GitBranch size={14}/>{t("ui.mark.f10902")}</button><div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && fileMenuRegisteredProgressFolder && <><button disabled={fileMenuRegisteredProgressFolder.trackingState === 'committing' || fileMenuRegisteredProgressFolder.trackingState === 'needs_repair'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openMarkProgress(entry); }}><GitBranch size={14}/>{t("ui.edit.progress.a52b5e")}</button>{!fileMenuRegisteredProgressFolder.parentProgressId && <button className="project-menu-item" onClick={() => { const progressFolder = fileMenuRegisteredProgressFolder; setFileMenu(null); void unregisterLegacyOrphanProgress(progressFolder); }}><X size={14}/>{t("ui.unregister.legacy.detached.progress.f90ea2")}</button>}{progressTrackingAction(fileMenuRegisteredProgressFolder) && <button disabled={progressSubmitting || Boolean(workspaceActivityMessage)} title={t("ui.refresh.main.branch.version.tracking.using.749253")} className="project-menu-item" onClick={() => { const progressFolder = fileMenuRegisteredProgressFolder; setFileMenu(null); void refreshProgressTracking(progressFolder); }}><RefreshCw size={14}/>{progressTrackingRefreshLabel(fileMenuRegisteredProgressFolder)}</button>}<div className="my-1 border-t border-slate-100"/></>}
        {gatherToProject && <><button disabled={fileMenuContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); startGatherInspiration(targets); }}><FolderInput size={14}/>{t("message.fb0d370ff144", { value0: inspirationTargetProject ? `“${inspirationTargetProject.name}”` : '…' })}</button>{inspirationTargetProject && <button disabled={fileMenuContainsShortcutContent || gatheringInspiration} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); setGatherPickerPaths(targets); }}><ChevronDown size={14}/>{t("ui.choose.another.project.952baa")}</button>}<div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && canSelectFileMenuMedia && <><button className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); selectMediaFiles(targets); }}><CheckCircle2 size={14}/>{t("ui.selection.8c8db6")}</button><div className="my-1 border-t border-slate-100"/></>}
        {(fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; const restoreSelection = fileMenuSelectionWasImplicitRef.current ? fileMenuSelectionSnapshotRef.current : null; setFileMenu(null); if (restoreSelection) { selectionAnchorPathRef.current = fileMenuSelectionAnchorSnapshotRef.current; setSelectedPaths(restoreSelection); } openPreviewFromMenu(entry); }}><PanelLeftOpen size={14}/>{t("ui.preview.13d61f")}</button>}
        {mediaContributionScope(fileMenuEntries, fileMenu.entry, pageId, componentContentKind) && componentContributions.filter(item => item.type === 'media.contextAction').map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scope = mediaContributionScope(fileMenuEntries, fileMenu.entry, pageId, componentContentKind)!; setFileMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope } })); }}><Plus size={14}/>{item.label}</button>)}
        {componentContributions.filter(item => item.type === 'project.contextAction' && !item.placement).map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scope = projectContributionScope(currentRelativePath, pageId, fileMenuEntries.map(entry => entry.relativePath), componentContentKind); setFileMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope } })); }}><Plus size={14}/>{item.label}</button>)}
        {!isFolderLikeEntry(fileMenu.entry) && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openProjectEntry(entry); }}><ExternalLink size={14}/>{fileMenu.entry.kind === 'shortcut' ? t("ui.open.shortcut.7219d6") : t("ui.open.with.default.application.765f99")}</button>}


        {(fileMenuHasVideoTarget || fileMenuHasPlacedToolAction('workspace.videoTools')) && <ViewportSubmenu><button type="button" aria-haspopup="menu" aria-expanded={false} className="project-menu-item w-full"><Video size={14}/>{t("ui.video.tools.d2442c")}<span className="ml-auto">›</span></button><div className="z-[302] w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl transition">{fileMenuHasVideoTarget && <button className="project-menu-item" onClick={() => { const entries = fileMenuEntries; setFileMenu(null); void openResearchForEntries(entries); }}><Video size={14}/>{t("ui.extract.storyboard.frames.079aa5")}</button>}{fileMenuHasVideoTarget && videoTranscodeContribution && <button className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); openVideoToolContribution(videoTranscodeContribution, targets); }}><Gauge size={14}/>{t("ui.transcode.video.e5fbc2")}</button>}{fileMenuHasVideoTarget && videoSplitContribution && <button disabled={!fileMenuHasVideoSplitTarget} title={fileMenuHasVideoSplitTarget ? t("ui.split.selected.videos.or.folders.value0.fd538c", { value0: fileMenuEntries.length }) : t("ui.select.videos.or.folders.3439ba")} className="project-menu-item" onClick={() => { const targets = fileMenuEntries.map(entry => entry.relativePath); setFileMenu(null); if (!targets.length) return; openVideoToolContribution(videoSplitContribution, targets); }}><Cut size={14}/>{t("ui.split.video.cd6df3")}</button>}{renderPlacedToolActions('workspace.videoTools', true)}</div></ViewportSubmenu>}
        {(fileMenuHasConvertibleImageTarget || fileMenuScreenshotMainImageEntries.length > 0 || fileMenuHasPlacedToolAction('workspace.imageTools')) && <ViewportSubmenu><button type="button" aria-haspopup="menu" aria-expanded={false} className="project-menu-item w-full"><ImageIcon size={14}/>{t("ui.image.tools.3c27a4")}<span className="ml-auto">›</span></button><div className="z-[302] w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl transition">{fileMenuHasConvertibleImageTarget && <button className="project-menu-item" onClick={() => { const targets = fileMenuEntries.map(entry => entry.relativePath); setFileMenu(null); void openImageConverter(targets); }}><ImageIcon size={14}/>{t("ui.convert.images.to.jpg.c3edb0")}</button>}<button disabled={!fileMenuScreenshotMainImageEntries.length} title={fileMenuScreenshotMainImageEntries.length ? fileMenuScreenshotMainImageEntries.length > 1 ? t("ui.extract.main.images.from.screenshots.value0.de0f3b", { value0: fileMenuScreenshotMainImageEntries.length }) : t("ui.extract.main.image.from.screenshot.6cebbf") : t("ui.select.screenshot.images.to.use.this.6bef7f")} className="project-menu-item" onClick={() => { const entries = fileMenuScreenshotMainImageEntries; setFileMenu(null); openScreenshotMainImage(entries); }}><Crop size={14}/>{t("message.b5c73d110d0c", { value0: fileMenuScreenshotMainImageEntries.length > 1 ? t("ui.value0.images.e723e0", { value0: fileMenuScreenshotMainImageEntries.length }) : '' })}</button>{renderPlacedToolActions('workspace.imageTools', true)}</div></ViewportSubmenu>}
        {(officeImageExtractorAvailable && fileMenuOfficeEntries.length > 0 || fileMenuHasPlacedToolAction('workspace.officeTools')) && <ViewportSubmenu>
          <button type="button" aria-haspopup="menu" aria-expanded={false} className="project-menu-item w-full"><FileImage size={14}/>{t("ui.office.documents.3a80cd")}<span className="ml-auto">›</span></button>
          <div className="z-[302] w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl transition">
            <button disabled={!fileMenuOfficeEntries.length} className="project-menu-item" onClick={() => { const entries = fileMenuOfficeEntries; setFileMenu(null); openOfficeImageExtractor(entries); }}><FileImage size={14}/>{t("message.863978020e20", { value0: fileMenuOfficeEntries.length > 1 ? t("legacy.message.eaec13a96979", { value0: fileMenuOfficeEntries.length }) : '' })}</button>
            {renderPlacedToolActions('workspace.officeTools', true)}
          </div>
        </ViewportSubmenu>}
        {photoshopAvailable && isPhotoshopOpenEntry(fileMenu.entry) && <button className="project-menu-item" onClick={() => { const entries = selectedPaths.includes(fileMenu.entry.relativePath) ? selectedEntries.filter(isPhotoshopOpenEntry) : [fileMenu.entry]; setFileMenu(null); void openProjectEntriesInPhotoshop(entries); }}><PhotoshopIcon size={14}/>{t("message.6b115ac3c9e9", { value0: selectedPaths.includes(fileMenu.entry.relativePath) && selectedEntries.filter(isPhotoshopOpenEntry).length > 1 ? t("legacy.message.f8514bc52729", { value0: selectedEntries.filter(isPhotoshopOpenEntry).length }) : '' })}</button>}
        {fileMenuHasToolActions && <div className="my-1 border-t border-slate-100"/>}
        <button disabled={fileMenuContainsShortcutContent || fileMenuContainsProtectedRenameEntry || fileMenuContainsBlockedProgressRenameEntry} title={fileMenuContainsShortcutContent ? t("ui.files.accessed.through.shortcuts.are.read.a5d016") : fileMenuContainsProtectedRenameEntry ? t("ui.this.folder.is.managed.by.the.b7ed82") : fileMenuContainsBlockedProgressRenameEntry ? t("ui.registered.version.folders.do.not.support.5af38a") : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); beginRename(targets); }}><Edit size={14}/>{fileMenuTargetPaths.length > 1 ? t("ui.batch.rename.07b79b") : t("ui.rename.0d0cba")}</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? t("ui.files.accessed.through.shortcuts.are.read.a5d016") : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('cut', undefined, targets); }} aria-busy={clipboardActionPending.cut}>{renderClipboardActionIcon('cut', 14)}{t("ui.cut.410a8e")}</button>
        <button disabled={fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? t("ui.files.accessed.through.shortcuts.are.read.a5d016") : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('copy', undefined, targets); }} aria-busy={clipboardActionPending.copy}>{renderClipboardActionIcon('copy', 14)}{t("ui.copy.63d90d")}</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent || !clipboardHasFiles} title={fileMenuContainsShortcutContent ? t("ui.external.folders.linked.by.shortcuts.are.af3748") : finalViewOpen ? t("ui.liked.images.are.shown.in.a.9907c3") : clipboardHasFiles ? t("ui.paste.into.this.file.s.folder.c0fb69") : t("ui.no.files.in.clipboard.034a58")} className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('paste'); }} aria-busy={clipboardActionPending.paste}>{renderClipboardActionIcon('paste', 14)}{t("ui.paste.335179")}</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? t("ui.files.accessed.through.shortcuts.are.read.a5d016") : undefined} className="project-menu-item project-menu-danger" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('trash', undefined, targets); }}><Trash2 size={14}/>{t("ui.delete.2f9daa")}</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openEntryDetails(entry); }}><Info size={14}/>{t("ui.details.1932da")}</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); copyEntryPath(entry); }}><FileText size={14}/>{isFolderLikeEntry(fileMenu.entry) ? t("ui.copy.folder.path.db276c") : t("ui.copy.file.path.63c2ec")}</button>
        <button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; if (fileMenuEntrySelected) setSelectedPaths(current => current.filter(item => item !== path)); else { selectionAnchorPathRef.current = path; setSelectedPaths(current => [...current, path]); requestFileReveal(path); } setFileMenu(null); }}>{fileMenuEntrySelected ? <X size={14}/> : <CheckSquare size={14}/>} {fileMenuEntrySelected ? t("ui.deselect.74966e") : t("ui.choose.c11330")}</button>
        {projectWorkflows && (fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <div className="my-1 border-t border-slate-100"/>}
        {projectWorkflows && (fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <button disabled={!hasVersionProgressForEntry(fileMenu.entry)} title={hasVersionProgressForEntry(fileMenu.entry) ? t("ui.manage.current.and.past.media.versions.5fac41") : t("ui.mark.or.import.version.progress.first.ef3dfe")} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openVersions(entry); }}><GitBranch size={14}/>{t("ui.version.history.79b622")}</button>}
      </ViewportContextMenu>, document.body)}
      {surfaceMenu && createPortal(<ViewportContextMenu x={surfaceMenu.x} y={surfaceMenu.y} widthClass="w-56" allowSubmenus>
        {surfaceMenu.kind === 'version-tree-layout' && <><button type="button" title={t("ui.reset.version.tree.layout.025556")} className="project-menu-item" onClick={() => void restoreStandardVersionTreeLayout()}><RefreshCw size={14}/>{t("ui.refresh.aee887")}</button><div className="my-1 border-t border-slate-100"/></>}
        <p className="truncate px-2 py-1 text-[11px] font-bold text-slate-400" title={surfaceMenu.targetLabel}>{t("message.2e7b7dc0ffed", { value0: surfaceMenu.targetLabel })}</p>
        {componentContributions.filter(item => item.type === 'project.contextAction' && !item.placement).map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scope = projectContributionScope(surfaceMenu.targetRelativePath, pageId, [], componentContentKind); setSurfaceMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope } })); }}><Plus size={14}/>{item.label}</button>)}
        <ViewportSubmenu><button aria-haspopup="menu" aria-expanded={false} className="project-menu-item w-full"><FolderPlus size={14}/>{t("ui.new.50ef2f")}<span className="ml-auto">›</span></button><div className="z-[302] w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-xl transition">{projectWorkflows && !recursiveFlatOpen && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void openProgressSetup('create'); }}><FolderPlus size={14}/>{t("ui.new.progress.49a246")}</button>}<button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void createFolder(target); }}><Folder size={14}/>{t("ui.new.folder.84244a")}</button><div className="my-1 border-t border-slate-100"/><div className="flex items-center justify-between px-2 pb-1 pt-1"><p className="text-[11px] font-bold text-slate-400">{t("ui.windows.file.types.1a54aa")}</p><button type="button" title={t("ui.rescan.windows.new.file.types.37255a")} disabled={shellNewTypesLoading} onClick={() => void loadShellNewTypes(true)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"><RefreshCw size={12} className={shellNewTypesLoading ? 'animate-spin' : ''}/></button></div><div className="max-h-72 overflow-y-auto">{shellNewTypesLoading && <p className="px-2 py-2 text-xs text-slate-400">{t("ui.loading.the.system.new.menu.fa28a4")}</p>}{!shellNewTypesLoading && shellNewTypes.map(type => <button key={type.id} className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void createShellNewFile(type, target); }}>{type.iconDataUrl ? <img src={type.iconDataUrl} alt="" className="h-4 w-4 shrink-0 object-contain"/> : <File size={14} className="shrink-0"/>}<span className="min-w-0 flex-1 truncate">{type.label}</span><span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{type.extension}</span></button>)}{!shellNewTypesLoading && shellNewTypesLoaded && !shellNewTypes.length && <p className="px-2 py-2 text-xs text-slate-400">{t("ui.no.new.file.types.are.available.83a126")}</p>}</div></div></ViewportSubmenu>
        <ViewportSubmenu><button aria-haspopup="menu" aria-expanded={false} className="project-menu-item w-full"><FolderInput size={14}/>{t("ui.import.576d81")}<span className="ml-auto">›</span></button><div className="z-[302] w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl transition">{projectWorkflows && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); setPanel('import'); }}><MemoryStick size={14}/>{t("ui.import.from.sd.card.48ca18")}</button>}<button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); openManualImport(projectWorkflows ? 'original' : 'files', [], target); }}><FolderInput size={14}/>{t("ui.import.576d81")}</button>{componentContributions.filter(item => item.type === 'project.importProvider').map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scopeRelativePath = surfaceMenu.targetRelativePath; setSurfaceMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope: { scopeRelativePath, selectedRelativePaths: [], sourcePageId: pageId, contentKind: componentContentKind } } })); }}><FolderInput size={14}/>{item.label}</button>)}</div></ViewportSubmenu>
        {componentContributions.filter(item => item.type === 'project.exportProvider').map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scopeRelativePath = surfaceMenu.targetRelativePath; setSurfaceMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope: { scopeRelativePath, selectedRelativePaths: [], sourcePageId: pageId, contentKind: componentContentKind } } })); }}><ExternalLink size={14}/>{item.label}</button>)}
        {projectWorkflows && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); togglePanel('match'); }}><FileText size={14}/>{t("ui.select.by.file.name.611d95")}</button>}
        <div className="my-1 border-t border-slate-100"/>
        <button disabled={!clipboardHasFiles} title={clipboardHasFiles ? t("ui.paste.into.value0.65a178", { value0: surfaceMenu.targetLabel }) : t("ui.no.files.in.clipboard.034a58")} className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void runFileOperation('paste', undefined, [], target); }} aria-busy={clipboardActionPending.paste}>{renderClipboardActionIcon('paste', 14)}{t("ui.paste.335179")}</button>
        <button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void copyCurrentDirectoryPath(target); }}><FileText size={14}/>{t("ui.copy.this.folder.s.path.da20b5")}</button>

        {projectWorkflows && <><div className="my-1 border-t border-slate-100"/><button className="project-menu-item project-menu-danger" onClick={() => { setSurfaceMenu(null); setPanel('trash'); }}><Trash2 size={14}/>{t("ui.move.project.to.recycle.bin.6dedca")}</button></>}
      </ViewportContextMenu>, document.body)}
      <WorkspaceDockLayout containerRef={projectColumnLayoutRef} order={panelOrder} visible={visibleDockPanels} labels={panelLabels} onReorder={setPanelOrder} onResize={resizeDockBoundary}>
      <div ref={filesColumnRef} data-workspace-panel="files" style={{ width: displayedColumnWidths.files, order: panelOrder.indexOf('files') * 2, display: filesPaneOpen ? undefined : 'none' }} onWheelCapture={handleFilesColumnWheelCapture} onPointerDown={startSelectionDrag} onPointerMove={updateSelectionDrag} onPointerUp={finishSelectionDrag} onPointerCancel={cancelSelectionDrag} onLostPointerCapture={cancelSelectionDrag} className={`relative flex min-h-0 flex-col overscroll-contain [overflow-anchor:none] px-6 ${versionTreeOpen ? 'gap-0 overflow-hidden pb-0' : 'gap-3 overflow-auto pb-6'} ${previewPaneOpen || metadataPaneOpen ? 'shrink-0' : 'flex-1'}`}>
        {selectionBox && <div aria-hidden className="marquee-logical-canvas pointer-events-none absolute left-0 top-0 z-20" style={{ width: selectionCanvasSize.width, height: selectionCanvasSize.height }}><div className="absolute border border-blue-500 bg-blue-400/15" style={selectionBox}/></div>}
      {filesPaneOpen && active && activeView === 'project' && (viewportStatus || folderOnlyGridCount > 0) && createPortal(<div role="status" className="pointer-events-none fixed bottom-2 z-[35] flex max-w-[calc(100vw-3rem)] items-center gap-3 rounded-lg border border-white/10 bg-slate-950/80 px-3.5 py-2 text-xs font-medium text-white shadow-xl backdrop-blur-md" style={{ right: fileStatusRight }}>
        {viewportStatus?.captureDateTime && <>
          <span className="truncate" title={viewportStatus.captureDateTime}>{viewportStatus.captureDateTime}</span>
          <span aria-hidden className="h-3 w-px shrink-0 bg-white/25"/>
        </>}
        <span className="shrink-0 font-mono font-bold tabular-nums">{viewportStatus ? `${viewportStatus.fileNumber}/${viewportStatus.total}` : folderOnlyGridCount}</span>
      </div>, document.body)}
      <div data-project-overview-shell="true" className={versionTreeOpen ? `grid transition-[grid-template-rows,margin-bottom] duration-200 ${versionTreeHeaderCollapsed ? 'grid-rows-[0fr]' : 'mb-3 grid-rows-[1fr]'}` : 'contents'}>
      <div className={versionTreeOpen ? 'min-h-0 overflow-hidden' : 'contents'}>
      <div data-project-overview="true" className="flex flex-wrap items-start justify-between gap-3 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="cursor-text select-text text-2xl font-bold text-slate-800">{browserRootLabel}</h2>
          {projectWorkflows && <ProjectStatusMenu open={showStatusMenu && active && !(versionTreeOpen && versionTreeHeaderCollapsed)} status={project.status} statuses={projectStatuses} onOpenChange={setShowStatusMenu} onSelect={moveStatus}/>}
        </div>
        <WorkspacePanelDragSpace id="files" label={t("ui.folder.7c7802")}/>
        <div className="flex items-center gap-2"><button onClick={() => openFolder()} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"><ExternalLink size={16}/>{t("message.544115d7220f", { value0: browserContext.title })}</button>{projectWorkflows && <button onClick={() => setConfirmDelete(true)} title={t("ui.delete.project.f6dc6a")} className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-500 hover:bg-red-50"><Trash2 size={16}/></button>}</div>
      </div>
      </div>
      </div>

      <div className="project-toolbar-wrap sticky top-0 z-30 -mx-6 w-[calc(100%+3rem)] bg-slate-50">
      <div className={`project-toolbar flex w-full flex-nowrap items-center border-b border-slate-200 px-6 py-1 ${selectedPaths.length ? 'project-toolbar--has-selection' : ''}`}>
        <div className="project-toolbar-create-action relative" onClick={event => event.stopPropagation()}>
          <button onClick={toggleCreateMenu} title={t("ui.new.50ef2f")} aria-label={t("ui.new.50ef2f")} aria-haspopup="menu" aria-expanded={showCreateMenu} className="project-action-button"><FolderPlus size={16}/>{t("ui.new.50ef2f")}</button>
          {showCreateMenu && <div className="project-create-menu absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            {projectWorkflows && <button className="project-menu-item" onClick={() => void openProgressSetup('create')}><FolderPlus size={14}/>{t("ui.new.progress.49a246")}</button>}
            <button className="project-menu-item" onClick={() => void createFolder()}><Folder size={14}/>{t("ui.folder.7c7802")}</button>
            <div className="my-1 border-t border-slate-100"/>
            <div className="flex items-center justify-between px-2 pb-1 pt-2"><p className="text-[11px] font-bold text-slate-400">{t("ui.windows.file.types.1a54aa")}</p><button type="button" title={t("ui.rescan.windows.new.file.types.37255a")} aria-label={t("ui.rescan.windows.new.file.types.37255a")} disabled={shellNewTypesLoading} onClick={() => void loadShellNewTypes(true)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"><RefreshCw size={12} className={shellNewTypesLoading ? 'animate-spin' : ''}/></button></div>
            <div className="max-h-72 overflow-y-auto">
              {shellNewTypesLoading && <p className="px-2 py-2 text-xs text-slate-400">{t("ui.loading.the.system.new.menu.fa28a4")}</p>}
              {!shellNewTypesLoading && shellNewTypes.map(type => <button key={type.id} className="project-menu-item flex items-center gap-2" onClick={() => void createShellNewFile(type)}>{type.iconDataUrl ? <img src={type.iconDataUrl} alt="" className="h-4 w-4 shrink-0 object-contain"/> : <File size={14} className="shrink-0"/>}<span className="min-w-0 flex-1 truncate">{type.label}</span><span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{type.extension}</span></button>)}
              {!shellNewTypesLoading && shellNewTypesLoaded && !shellNewTypes.length && <p className="px-2 py-2 text-xs text-slate-400">{t("ui.no.new.file.types.are.available.83a126")}</p>}
            </div>
          </div>}
        </div>
        <div className="project-toolbar-import-action relative" onClick={event => event.stopPropagation()}>
          <button onClick={() => { const next = !showImportMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowImportMenu(next); }} title={t("ui.import.576d81")} aria-label={t("ui.import.576d81")} aria-haspopup="menu" aria-expanded={showImportMenu} className="project-action-button"><FolderInput size={16}/>{t("ui.import.576d81")}</button>
          {showImportMenu && <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            {projectWorkflows && <button className="project-menu-item" onClick={() => { setShowImportMenu(false); setPanel('import'); }}><MemoryStick size={14}/>{t("ui.import.from.sd.card.48ca18")}</button>}
            <button className="project-menu-item" onClick={() => openManualImport(projectWorkflows ? 'original' : 'files')}><FolderInput size={14}/>{t("ui.import.576d81")}</button>
          </div>}
        </div>
        <span aria-hidden className="project-toolbar-core-divider toolbar-divider"/>
        {selectedPaths.length > 0 && <span className="project-toolbar-selection mr-1 self-center text-xs text-slate-500">{t("message.34c2d218520b", { count: selectedPaths.length })}</span>}
        <button disabled={selectedContainsShortcutContent || selectedContainsProtectedRenameEntry || selectedContainsBlockedProgressRenameEntry || !selectedPaths.length} title={selectedContainsShortcutContent ? t("ui.files.accessed.through.shortcuts.are.read.a5d016") : selectedContainsProtectedRenameEntry ? t("ui.the.selected.folder.is.managed.by.e898bb") : selectedContainsBlockedProgressRenameEntry ? t("ui.registered.version.folders.do.not.support.5af38a") : selectedPaths.length > 1 ? t("ui.batch.rename.07b79b") : t("ui.rename.0d0cba")} onClick={() => beginRename()} className="project-action-button compact-hide-file-action"><Edit size={16}/>{selectedPaths.length > 1 ? t("ui.batch.rename.07b79b") : t("ui.rename.0d0cba")}</button>
        <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} title={selectedContainsShortcutContent ? t("ui.files.accessed.through.shortcuts.are.read.a5d016") : finalViewOpen ? t("ui.liked.images.are.shown.in.a.9907c3") : t("ui.cut.410a8e")} onClick={() => runFileOperation('cut')} className="project-action-button compact-hide-file-action" aria-busy={clipboardActionPending.cut}>{renderClipboardActionIcon('cut', 16)}{t("ui.cut.410a8e")}</button>
        <button disabled={selectedContainsShortcutContent || !selectedPaths.length} title={selectedContainsShortcutContent ? t("ui.files.accessed.through.shortcuts.are.read.a5d016") : t("ui.copy.63d90d")} onClick={() => runFileOperation('copy')} className="project-action-button compact-hide-file-action" aria-busy={clipboardActionPending.copy}>{renderClipboardActionIcon('copy', 16)}{t("ui.copy.63d90d")}</button>
        <button disabled={clipboardPending || finalViewOpen || !clipboardHasFiles} title={clipboardPending ? t("ui.synchronizing.system.clipboard.59e07b") : finalViewOpen ? t("ui.liked.images.are.shown.in.a.9907c3") : clipboardHasFiles ? t("ui.paste.into.current.folder.4b85b8") : t("ui.no.files.in.clipboard.034a58")} onClick={() => runFileOperation('paste')} className="project-action-button compact-hide-file-action" aria-busy={clipboardActionPending.paste}>{renderClipboardActionIcon('paste', 16)}{t("ui.paste.335179")}</button>
        <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} title={selectedContainsShortcutContent ? t("ui.files.accessed.through.shortcuts.are.read.a5d016") : finalViewOpen ? t("ui.liked.images.are.shown.in.a.9907c3") : t("ui.delete.2f9daa")} onClick={() => runFileOperation('trash')} className="project-action-button project-action-danger compact-hide-file-action"><Trash2 size={16}/>{t("ui.delete.2f9daa")}</button>
        <button disabled={!selectedPaths.length} title={t("ui.deselect.74966e")} onClick={() => setSelectedPaths([])} className="project-action-button"><X size={16}/>{t("ui.deselect.74966e")}</button>
        <div className="project-toolbar-secondary contents">
        {(gatherToProject || projectWorkflows && hasProjectToolbarActions) && <span aria-hidden className="toolbar-divider"/>}
        {gatherToProject && <div className="flex items-stretch">
          <button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => startGatherInspiration(selectedPaths)} title={inspirationTargetProject ? t("ui.add.selected.inspiration.to.the.folder.eb760f", { value0: inspirationTargetProject.name }) : t("ui.add.selected.inspiration.to.the.target.7fe8b1")} aria-label={t("ui.add.selected.inspiration.to.target.project.92383e")} className="project-action-button inspiration-target-button !rounded-r-none">{gatheringInspiration ? <Loader2 size={16} className="animate-spin"/> : <FolderInput size={16}/>}<span className="truncate">{inspirationTargetProject ? inspirationTargetProject.name : t("ui.add.to.project.a4e92f")}</span></button>
          <button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => setGatherPickerPaths(selectedPaths)} title={t("ui.choose.a.project.to.collect.inspiration.e27e80")} aria-label={t("ui.choose.a.project.to.collect.inspiration.e27e80")} className="project-action-button !rounded-l-none !px-1"><ChevronDown size={14}/></button>
        </div>}
        {inspirationMode && <span aria-hidden className="toolbar-divider"/>}
        {inspirationMode && <>{projectToolbarButtons['image-tools']}{projectToolbarButtons['video-tools']}{projectToolbarButtons['office-extract']}</>}
        <div className={projectWorkflows ? 'contents' : 'hidden'}>
          {visibleProjectToolbarActionIds.map(id => <React.Fragment key={id}>{projectToolbarButtons[id]}</React.Fragment>)}
        </div>
        </div>
        <div className="project-toolbar-component-actions contents"><ComponentToolbarActions actions={visibleComponentHostActions} scope={{ scopeRelativePath: currentRelativePath, selectedRelativePaths: componentHostSelectedRelativePaths, sourcePageId: pageId, contentKind: componentContentKind }} onOpen={onOpenComponentPage}/><ComponentContributionDock contributions={componentContributions.filter(item => item.type !== 'application.command')} project={project} workspacePath={componentWorkspacePath} scope={{ scopeRelativePath: currentRelativePath, selectedRelativePaths, sourcePageId: pageId, contentKind: componentContentKind }} active={active}/></div>
        <div className="project-toolbar-overflow relative" onClick={event => event.stopPropagation()}>
          <button type="button" onClick={() => { const next = !showToolbarOverflowMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowToolbarOverflowMenu(next); }} aria-label={t("ui.expand.toolbar.actions.a5328d")} aria-haspopup="menu" aria-expanded={showToolbarOverflowMenu} className={`project-action-button ${showToolbarOverflowMenu ? 'bg-blue-50 text-blue-600' : ''}`}><ChevronDown size={17} className={`transition-transform ${showToolbarOverflowMenu ? 'rotate-180' : ''}`}/></button>
          {showToolbarOverflowMenu && <div role="menu" aria-label={t("ui.more.toolbar.actions.b67a3d")} className="project-toolbar-overflow-menu absolute left-0 top-full z-50 mt-1 w-56 overflow-visible rounded-lg border border-slate-200 bg-white p-1 shadow-xl" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setShowToolbarOverflowMenu(false); (event.currentTarget.previousElementSibling as HTMLButtonElement | null)?.focus(); } }} onClick={event => { const button = (event.target as HTMLElement).closest('button'); if (button && button.getAttribute('aria-haspopup') !== 'menu') setShowToolbarOverflowMenu(false); }}>
            <div className="project-toolbar-overflow-primary">
              <button disabled={selectedContainsShortcutContent || selectedContainsProtectedRenameEntry || selectedContainsBlockedProgressRenameEntry || !selectedPaths.length} onClick={() => beginRename()} className="project-menu-item"><Edit size={14}/>{selectedPaths.length > 1 ? t("ui.batch.rename.07b79b") : t("ui.rename.0d0cba")}</button>
              <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} onClick={() => runFileOperation('cut')} className="project-menu-item" aria-busy={clipboardActionPending.cut}>{renderClipboardActionIcon('cut', 14)}{t("ui.cut.410a8e")}</button>
              <button disabled={selectedContainsShortcutContent || !selectedPaths.length} onClick={() => runFileOperation('copy')} className="project-menu-item" aria-busy={clipboardActionPending.copy}>{renderClipboardActionIcon('copy', 14)}{t("ui.copy.63d90d")}</button>
              <button disabled={finalViewOpen || !clipboardHasFiles} onClick={() => runFileOperation('paste')} className="project-menu-item" aria-busy={clipboardActionPending.paste}>{renderClipboardActionIcon('paste', 14)}{t("ui.paste.335179")}</button>
              <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} onClick={() => runFileOperation('trash')} className="project-menu-item project-menu-danger"><Trash2 size={14}/>{t("ui.delete.2f9daa")}</button>
            </div>
            <div className="project-toolbar-overflow-compact">
              <div className="my-1 border-t border-slate-100"/>
              <p className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{t("ui.create.and.import.2449e7")}</p>
              {projectWorkflows && <button className="project-menu-item" onClick={() => void openProgressSetup('create')}><FolderPlus size={14}/>{t("ui.new.progress.49a246")}</button>}
              <button className="project-menu-item" onClick={() => void createFolder()}><Folder size={14}/>{t("ui.new.folder.84244a")}</button>
              {shellNewTypes.length > 0 && <div className="max-h-40 overflow-y-auto border-y border-slate-100 py-1">
                {shellNewTypes.map(type => <button key={`compact-${type.id}`} className="project-menu-item" onClick={() => void createShellNewFile(type)}>{type.iconDataUrl ? <img src={type.iconDataUrl} alt="" className="h-3.5 w-3.5 shrink-0 object-contain"/> : <File size={14}/>}<span className="min-w-0 flex-1 truncate">{t("message.156c4526341b", { value0: type.label })}</span></button>)}
              </div>}
              {projectWorkflows && <button className="project-menu-item" onClick={() => setPanel('import')}><MemoryStick size={14}/>{t("ui.import.from.sd.card.48ca18")}</button>}
              <button className="project-menu-item" onClick={() => openManualImport(projectWorkflows ? 'original' : 'files')}><FolderInput size={14}/>{t("ui.import.files.fa3ecf")}</button>
              <div className="my-1 border-t border-slate-100"/>
              <p className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{t("ui.view.1c5c06")}</p>
              <button type="button" onClick={() => { setSearchQuery(''); selectFolderBrowseMode('recent'); }} aria-pressed={browseMode === 'recent'} className={`project-menu-item ${browseMode === 'recent' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><GalleryVerticalEnd size={14}/>{t("ui.all.files.ec36ca")}</button>
              <button type="button" onClick={() => selectFolderBrowseMode('grid')} aria-pressed={browseMode === 'grid'} className={`project-menu-item ${browseMode === 'grid' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><Grid2X2 size={14}/>{t("ui.icon.view.74f348")}</button>
              <button type="button" onClick={() => selectFolderBrowseMode('list')} aria-pressed={browseMode === 'list'} className={`project-menu-item ${browseMode === 'list' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><LayoutList size={14}/>{t("ui.list.view.7dedb0")}</button>
              {projectVersionTreeAvailable && <button type="button" onClick={showVersionTree} aria-pressed={browseMode === 'version-tree'} className={`project-menu-item ${browseMode === 'version-tree' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><GitBranch size={14}/>{t("ui.project.version.tree.2026f6")}</button>}
            </div>
            <div className="project-toolbar-overflow-secondary">
              {(gatherToProject || projectWorkflows && hasProjectToolbarActions) && <div className="my-1 border-t border-slate-100"/>}
              {gatherToProject && <><button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => startGatherInspiration(selectedPaths)} className="project-menu-item">{gatheringInspiration ? <Loader2 size={14} className="animate-spin"/> : <FolderInput size={14}/>}{t("message.b9b0244df8da", { value0: inspirationTargetProject ? `“${inspirationTargetProject.name}”` : t("ui.projects.79f326") })}</button><button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => setGatherPickerPaths(selectedPaths)} className="project-menu-item"><ChevronDown size={14}/>{t("ui.choose.target.project.2b5125")}</button></>}
              {inspirationMode && <>{projectToolbarButtons['image-tools']}{projectToolbarButtons['video-tools']}{projectToolbarButtons['office-extract']}</>}
              {projectWorkflows && visibleProjectToolbarActionIds.map(id => <React.Fragment key={`overflow-${id}`}>{projectToolbarButtons[id]}</React.Fragment>)}
              {visibleComponentHostActions.length > 0 && <><div className="my-1 border-t border-slate-100"/><ComponentToolbarActions overflow actions={visibleComponentHostActions} scope={{ scopeRelativePath: currentRelativePath, selectedRelativePaths: componentHostSelectedRelativePaths, sourcePageId: pageId, contentKind: componentContentKind }} onOpen={onOpenComponentPage}/></>}
            </div>
          </div>}
        </div>
        <div className="project-toolbar-view-actions ml-auto flex shrink-0 items-center gap-1 pl-3">
          <div className="project-toolbar-view-mode-actions contents">
          <button type="button" onClick={() => { setSearchQuery(''); selectFolderBrowseMode('recent'); }} title={t("ui.all.files.including.subfolders.and.folder.55c009")} aria-label={t("ui.all.files.ec36ca")} aria-pressed={browseMode === 'recent'} className={`rounded-md p-1.5 ${browseMode === 'recent' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><GalleryVerticalEnd size={17}/></button>
          <button type="button" onClick={() => selectFolderBrowseMode('grid')} title={t("ui.icon.view.74f348")} aria-label={t("ui.icon.view.74f348")} aria-pressed={browseMode === 'grid'} className={`rounded-md p-1.5 ${browseMode === 'grid' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><Grid2X2 size={17}/></button>
          <button type="button" onClick={() => selectFolderBrowseMode('list')} title={t("ui.list.view.7dedb0")} aria-label={t("ui.list.view.7dedb0")} aria-pressed={browseMode === 'list'} className={`rounded-md p-1.5 ${browseMode === 'list' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><LayoutList size={17}/></button>
          {projectVersionTreeAvailable && <button type="button" onClick={showVersionTree} title={t("ui.project.version.tree.2026f6")} aria-label={t("ui.project.version.tree.2026f6")} aria-pressed={browseMode === 'version-tree'} className={`rounded-md p-1.5 ${browseMode === 'version-tree' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><GitBranch size={17}/></button>}
          </div>
          {(browseMode === 'grid' || browseMode === 'version-tree') && <input aria-label={t("ui.icon.size.7aeb54")} title={t("ui.icon.size.7aeb54")} type="range" min={MIN_FOLDER_GRID_ICON_SIZE} max={MAX_FOLDER_GRID_ICON_SIZE} step="4" value={gridIconSize} onChange={event => selectFolderGridIconSize(Number(event.target.value))} className="compact-hide-slider ml-2 w-24 accent-blue-600"/>}
          <span aria-hidden className="project-toolbar-view-mode-divider mx-1 h-5 w-px bg-slate-200"/>
          <div className="relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !showSortMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowSortMenu(next); }} title={versionTreeOpen ? t("ui.sort.media.in.the.version.tree.125ed0") : recursiveFlatOpen ? t("ui.sort.files.in.each.folder.f11633") : t("ui.sort.a96c9a")} aria-label={t("ui.sort.a96c9a")} aria-haspopup="menu" aria-expanded={showSortMenu} className={`rounded-md p-1.5 ${showSortMenu ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><ArrowUpDown size={17}/></button>{showSortMenu && <div className="sort-menu absolute right-0 top-full z-40 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{([['name', t("ui.file.name.a6e48a")], ['date', t("ui.date.modified.2cbced")], ['size', t("ui.size.50db74")]] as const).map(([field, label]) => <button key={field} type="button" onClick={() => selectSortField(field)} className={`project-menu-item ${sortField === field ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{label}</button>)}<div className="my-1 border-t border-slate-100"/><button type="button" onClick={() => setSortDirection('asc')} className={`project-menu-item ${sortDirection === 'asc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowUp size={14}/><span>{t("ui.ascending.77e947")}</span></button><button type="button" onClick={() => setSortDirection('desc')} className={`project-menu-item ${sortDirection === 'desc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowDown size={14}/><span>{t("ui.descending.6e8e58")}</span></button></div>}</div>
          <div className="relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !searchOpen; window.dispatchEvent(new Event('photoflow-menu-open')); setSearchOpen(next); }} title={versionTreeOpen ? t("ui.find.files.in.version.tree.ctrl.61dd43") : t("ui.find.files.ctrl.f.f72106")} aria-label={t("ui.find.files.51fdfe")} aria-expanded={searchOpen} className={`rounded-md p-1.5 ${searchOpen || searchQuery ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><Search size={17}/></button>{searchOpen && <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"><div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2"><Search size={15} className="shrink-0 text-slate-400"/><input ref={searchInputRef} autoFocus value={searchQuery} onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); } }} placeholder={t("ui.enter.a.file.name.59c307")} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-slate-800 outline-none"/>{searchQuery && <button type="button" onClick={() => setSearchQuery('')} title={t("ui.clear.search.b7f4ca")} className="rounded p-0.5 text-slate-400 hover:bg-slate-200"><X size={14}/></button>}</div></div>}</div>
          <div className="relative" onClick={event => event.stopPropagation()}>
            <button type="button" onClick={() => { const next = !showFilterMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowFilterMenu(next); }} title={versionTreeOpen ? t("ui.filter.files.in.version.tree.e5895a") : t("ui.filter.files.aba83d")} aria-label={t("ui.filter.files.aba83d")} aria-haspopup="menu" aria-expanded={showFilterMenu} className={`rounded-md p-1.5 ${showFilterMenu || filterScope !== 'current-folder' || fileFilter !== 'all' || ratingFilter !== 'all' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><Funnel size={17}/></button>
            {showFilterMenu && <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
              <div><p className="mb-1.5 px-1 text-[11px] font-bold text-slate-400">{t("ui.filter.scope.937fef")}</p><div className="grid grid-cols-2 gap-1">
                <button type="button" aria-pressed={filterScope === 'current-folder'} onClick={() => changeFilterScope('current-folder')} className={`rounded-md px-2 py-1.5 text-xs font-medium ${filterScope === 'current-folder' ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>{t("ui.current.folder.9112e7")}</button>
                <button type="button" aria-pressed={filterScope === 'project-root'} onClick={() => changeFilterScope('project-root')} className={`rounded-md px-2 py-1.5 text-xs font-medium ${filterScope === 'project-root' ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>{browserContext.rootFilterLabel}</button>
              </div></div>
              <div className="mt-2 border-t border-slate-100 pt-2"><p className="mb-1.5 px-1 text-[11px] font-bold text-slate-400">{t("ui.file.type.9a8457")}</p><div className="grid grid-cols-2 gap-1">{PROJECT_FILE_FILTER_OPTIONS.map(option => <button key={option.value} type="button" aria-pressed={fileFilter === option.value} onClick={() => setFileFilter(option.value)} className={`rounded-md px-2 py-1.5 text-xs font-medium ${fileFilter === option.value ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>{option.label}</button>)}</div></div>
              <div className="mt-2 border-t border-slate-100 pt-2"><div className="mb-1.5 flex items-center justify-between gap-2 px-1"><p className="text-[11px] font-bold text-slate-400">{favoriteDisplayMode === 'stars' ? t("ui.star.rating.9c55a4") : t("ui.liked.6c3244")}</p>{ratingFilter !== 'all' && <span className="flex items-center gap-1 text-[10px] text-slate-400">{filterRatingsLoading && <Loader2 size={11} className="animate-spin"/>}{t("message.821833cbf809", { count: filterRatingsCheckedCount })}</span>}</div><div className="grid grid-cols-2 gap-1">{(favoriteDisplayMode === 'stars' ? PROJECT_STAR_RATING_FILTER_OPTIONS : PROJECT_BINARY_RATING_FILTER_OPTIONS).map(option => <button key={option.value} type="button" aria-pressed={ratingFilter === option.value} onClick={() => setRatingFilter(option.value)} className={`rounded-md px-2 py-1.5 text-xs font-medium ${ratingFilter === option.value ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>{option.label}</button>)}</div></div>
              {(fileFilter !== 'all' || ratingFilter !== 'all') && <button type="button" onClick={() => { setFileFilter('all'); setRatingFilter('all'); }} className="mt-2 w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100">{t("ui.clear.filters.657d9c")}</button>}
            </div>}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 items-center px-6 py-1">
        <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-sm text-slate-500">
          {finalViewOpen ? <><button type="button" onClick={closeFinalVersionView} title={t("ui.exit.liked.images.view.9461b4")} aria-label={t("ui.exit.liked.images.view.9461b4")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={17}/></button><span className="inline-flex h-8 shrink-0 items-center px-1.5 font-bold leading-none text-slate-700">{t("ui.liked.6c3244")}</span></> : versionTreeOpen ? <><button type="button" onClick={() => selectFolderBrowseMode('grid')} title={t("ui.back.to.icon.view.8a109e")} aria-label={t("ui.exit.version.tree.00b03a")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"><ArrowLeft size={17}/></button><span className="inline-flex h-8 shrink-0 items-center px-1.5 font-bold leading-none text-slate-700">{browserContext.title}</span><span className="inline-flex h-8 shrink-0 items-center leading-none text-slate-300">/</span><span className="inline-flex h-8 shrink-0 items-center gap-1.5 px-1.5 font-bold leading-none text-blue-700"><GitBranch size={15}/>{t("ui.version.tree.bbdd22")}</span></> : <><button type="button" onClick={navigateBack} disabled={!directoryHistory.back.length} title={t("ui.back.2d1d8c")} aria-label={t("ui.back.2d1d8c")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowLeft size={17}/></button><button type="button" onClick={navigateForward} disabled={!directoryHistory.forward.length} title={t("ui.forward.d681c6")} aria-label={t("ui.forward.d681c6")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowRight size={17}/></button><button type="button" onClick={() => navigateToDirectory('')} title={t("ui.back.to.value0.root.eeabd2", { value0: browserRootLabel })} className="mr-1 inline-flex h-8 shrink-0 items-center rounded border border-transparent px-1.5 font-bold leading-none text-slate-800 transition hover:border-slate-300 hover:bg-slate-100">{browserContext.title}</button>{breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.relativePath || 'root'}><span className="inline-flex h-8 shrink-0 items-center leading-none text-slate-300">/</span><button onClick={() => navigateToDirectory(crumb.relativePath)} title={t("ui.open.value0.6ae1bd", { value0: crumb.label })} className={`inline-flex h-8 min-w-0 items-center truncate rounded border border-transparent px-1.5 text-sm leading-none transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800 ${index === breadcrumbs.length - 1 ? 'font-bold text-slate-700' : ''}`}>{crumb.label}</button></React.Fragment>)}</>}
        </div>
        {finalViewOpen && <div className="ml-auto flex min-w-0 items-center gap-2"><label className="flex min-w-0 items-center gap-1.5 text-xs text-slate-500">{t("ui.parent.node.f363b2")}<select aria-label={t("ui.parent.node.for.liked.image.export.08aed9")} value={finalExportParentId} onChange={event => setFinalExportParentId(event.target.value)} className="max-w-48 rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700"><option value="">{t("ui.choose.da590a")}</option>{finalExportParentOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.displayName}</option>)}</select></label><button type="button" disabled={finalExporting || !finalViewEntries.length || !finalExportParentId} onClick={() => void exportFinalVersions()} className="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40">{finalExporting ? t("ui.organizing.df7fe9") : t("ui.organize.liked.images.c689d4")}</button></div>}
      </div>
      </div>

      {folderAlphabetFilterVisible && <nav aria-label={t("ui.filter.by.folder.initial.c60555")} className="-mt-3 flex flex-wrap items-center gap-1 px-6 pb-2 pt-1">
        <button type="button" aria-pressed={!folderAlphabetFilter} onClick={() => { setFolderAlphabetFilter(''); setSelectedPaths([]); }} className={`rounded px-2 py-1 text-xs font-bold ${!folderAlphabetFilter ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>{t("ui.all.5c55a6")}</button>
        {[...FOLDER_ALPHABET_KEYS, '#'].map(key => { const available = folderAlphabetKeys.includes(key); return <button key={key} type="button" disabled={!available} aria-pressed={folderAlphabetFilter === key} onClick={() => { setFolderAlphabetFilter(key); setSelectedPaths([]); }} className={`h-6 min-w-6 rounded px-1 text-xs font-bold ${folderAlphabetFilter === key ? 'bg-blue-600 text-white' : available ? 'text-slate-500 hover:bg-slate-100 hover:text-slate-800' : 'cursor-default text-slate-300'}`}>{key}</button>; })}
      </nav>}
      {mountedPanels.has('converter') && <ToolModal title={PROJECT_PANEL_TITLES.converter} ownerPageId={pageId} panelKind="converter" open={panel === 'converter'} onClose={closeImageConverterPanel}><ConverterView embedded initialTargetPaths={conversionTargets} sourcesLoading={conversionCollecting}/></ToolModal>}
      {mountedPanels.has('screenshot-main-image') && <ToolModal title={screenshotMainImageMode === 'crop' ? t("ui.crop.image.cf301e") : PROJECT_PANEL_TITLES['screenshot-main-image']} ownerPageId={pageId} panelKind="screenshot-main-image" open={panel === 'screenshot-main-image'} onClose={() => setPanel(null)}><ScreenshotMainImageView embedded cropMode={screenshotMainImageMode === 'crop'} workspacePath={workspacePath} projectStatus={project.status} projectName={project.name} initialRelativePaths={screenshotMainImageTargets} cacheConfig={mediaCacheConfig} onFilesChanged={async () => {
        directoryEntriesCacheRef.current.clear();
        refreshRecursiveResults(screenshotMainImageTargets.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path))));
        await refresh(currentRelativePathRef.current);
        if (finalViewOpen) await loadFinalViewEntries();
      }}/></ToolModal>}
      {mountedPanels.has('import') && <ToolModal title={PROJECT_PANEL_TITLES.import} ownerPageId={pageId} panelKind="import" open={panel === 'import'} busy={sdImportBusy} onClose={() => setPanel(null)}><div className="space-y-4"><div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">{t("message.122dad354443", { value0: project.name })}</p><p className="mt-1 text-xs leading-5 text-blue-600">{t("ui.detect.original.and.behind.the.scenes.17f6bb")}</p></div><ImportCard config={importConfig} drives={drives} workspacePath={workspacePath} destinationPath={project.path} brollDestinationPath={project.path} active={active && panel === 'import'} deleteSourceAfterImport={importDefaults.deleteSourceAfterImport} generateJpgFromRaw={importDefaults.generateJpgFromRaw} splitVideosOnImport={importDefaults.splitVideosOnImport} transcodeVideosOnImport={importDefaults.transcodeVideosOnImport} splitBrollVideosOnImport={brollConfig.splitVideosOnImport} transcodeBrollVideosOnImport={brollConfig.transcodeVideosOnImport} transcodeSettings={videoTools.transcode} videoToolsAvailable={videoToolsAvailable} onBusyChange={setSdImportBusy} onImportConfigChange={onImportConfigChange} onImportComplete={completeSdImport} completedActionLabel={t("common.close")} onCompletedAction={() => setPanel(null)}/></div></ToolModal>}
      {mountedPanels.has('negative-import') && <ToolModal title={PROJECT_PANEL_TITLES['negative-import']} ownerPageId={pageId} panelKind="negative-import" open={panel === 'negative-import'} busy={negativeImportBusy} onClose={() => { setNegativeSourcePaths([]); setPanel(null); }}>
        <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">{t("message.122dad354443", { value0: project.name })}</p><p className="mt-1 text-xs leading-5 text-blue-600">{t("ui.read.files.or.folders.directly.4b129d")}</p></div>
          <ImportCard
            directSource
            importKind="original"
            onImportKindChange={(kind, sourcePaths) => openManualImport(kind, sourcePaths, fileImportTarget || currentRelativePath)}
            workspacePath={workspacePath}
            config={{ ...importConfig, sdPath: negativeSourcePaths[0], sdPaths: negativeSourcePaths }}
            drives={negativeSourcePaths}
            destinationPath={project.path}
            brollDestinationPath={project.path}
            active={active && panel === 'negative-import'}
            deleteSourceAfterImport={importDefaults.deleteSourceAfterImport}
            generateJpgFromRaw={importDefaults.generateJpgFromRaw}
            splitVideosOnImport={importDefaults.splitVideosOnImport}
            transcodeVideosOnImport={importDefaults.transcodeVideosOnImport}
            transcodeSettings={videoTools.transcode}
            videoToolsAvailable={videoToolsAvailable}
            onChooseSourceFiles={() => void projectWorkspaceClient.chooseImportSourceFiles().then(result => { if (!result.cancelled && result.paths.length) setNegativeSourcePaths(current => mergeSourcePaths(current, result.paths)); })}
            onChooseSourceFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => { if (!result.cancelled && result.path) setNegativeSourcePaths(current => mergeSourcePaths(current, [result.path!])); })}
            onDropSourcePaths={paths => setNegativeSourcePaths(paths)}

            onBusyChange={setNegativeImportBusy}
            onImportConfigChange={onImportConfigChange}
            onImportComplete={() => { void completeNegativeImport(); }}
            completedActionLabel={t("common.close")}
            onCompletedAction={() => { setNegativeSourcePaths([]); setPanel(null); }}
          />
        </div>
      </ToolModal>}
      {mountedPanels.has('broll') && <ToolModal
        title={PROJECT_PANEL_TITLES.broll}
        ownerPageId={pageId}
        panelKind="broll"
        open={panel === 'broll'}
        busy={panelImportBusy === 'broll'}
        onClose={() => { setBrollSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
      >
        {panelImportResult?.kind === 'broll' ? <ImportCompletionNotice
          message={t("ui.behind.the.scenes.files.imported.value0.570c19", { value0: panelImportResult.count, value1: panelImportResult.sourceDeleted ? t("ui.deleted.077a6d") : t("ui.kept.e309f2") })}
          onClose={() => { setBrollSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
        /> : <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">{t("message.20cd447b217d", { value0: project.name })}</p><p className="mt-1 text-xs leading-5 text-blue-600">{t("ui.supports.images.and.videos.settings.determine.a65b29")}</p></div>
          <ImportSourceControls
            selectionTitle={t("legacy.476630cec7de")}
            selectionDescription={t("legacy.9e795ddc04d2")}
            selectedPaths={brollSourcePaths}
            onSelectedPathsChange={setBrollSourcePaths}
            onChooseFiles={() => void chooseBrollFiles()}
            onChooseFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => { if (!result.cancelled && result.path) setBrollSourcePaths(current => mergeSourcePaths(current, [result.path!])); })}
            importKind="broll"
            onImportKindChange={kind => openManualImport(kind, brollSourcePaths, fileImportTarget || currentRelativePath)}


            deleteSourceAfterImport={deleteBrollSources}
            onDeleteSourceAfterImportChange={setDeleteBrollSources}
            deleteSourceDescription={t("legacy.62aed4bfc19c")}
            busy={panelImportBusy === 'broll'}
            onStart={() => void importBroll()}
          />
        </div>}
      </ToolModal>}
      {mountedPanels.has('file-import') && <ToolModal
        title={PROJECT_PANEL_TITLES['file-import']}
        ownerPageId={pageId}
        panelKind="file-import"
        open={panel === 'file-import'}
        busy={panelImportBusy === 'files'}
        onClose={() => { setFileImportSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
      >
        {panelImportResult?.kind === 'files' ? <ImportCompletionNotice
          message={t("ui.files.imported.value0.source.files.value1.43143e", { value0: panelImportResult.count, value1: panelImportResult.sourceDeleted ? t("ui.deleted.077a6d") : t("ui.kept.e309f2") })}
          onClose={() => { setFileImportSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
        /> : <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
            <p className="text-sm font-bold text-blue-800">{t("message.122dad354443", { value0: [browserRootLabel, normalizeProjectRelativePath(fileImportTarget)].filter(Boolean).join(' / ') })}</p>
            <p className="mt-1 text-xs leading-5 text-blue-600">{t("ui.import.any.files.into.the.current.3ee2b1")}</p>
          </div>

          <ImportSourceControls
            selectionTitle={t("legacy.f17da1b39359")}
            selectionDescription={t("legacy.3248347f1e07")}
            selectedPaths={fileImportSourcePaths}
            onSelectedPathsChange={setFileImportSourcePaths}
            onChooseFiles={() => void chooseFilesToImport()}
            onChooseFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => { if (!result.cancelled && result.path) setFileImportSourcePaths(current => mergeSourcePaths(current, [result.path!])); })}
            importKind="files"
            onImportKindChange={kind => openManualImport(kind, fileImportSourcePaths, fileImportTarget)}
            disabledImportKinds={inspirationMode ? INSPIRATION_DISABLED_IMPORT_KINDS : undefined}


            deleteSourceAfterImport={deleteFileSources}
            onDeleteSourceAfterImportChange={setDeleteFileSources}
            deleteSourceDescription={t("legacy.79d427b00ec2")}
            busy={panelImportBusy === 'files'}
            onStart={() => void importFiles()}
          />
        </div>}
      </ToolModal>}
      {mountedPanels.has('match') && <ToolModal title={PROJECT_PANEL_TITLES.match} ownerPageId={pageId} panelKind="match" open={panel === 'match'} onClose={() => setPanel(null)}><MatchView embedded config={matchConfig} projectPath={project.path} folderOptions={folders} onUpdateConfig={onMatchConfigChange}/></ToolModal>}
      {mountedPanels.has('research') && <ToolModal title={PROJECT_PANEL_TITLES.research} ownerPageId={pageId} panelKind="research" open={panel === 'research'} onClose={() => { researchInspectionSequenceRef.current += 1; setPanel(null); }}><ResearchView embedded initialTargetPath={researchTargetPath} initialTargetPaths={researchTargetPaths} hasTxtFiles={researchTargetHasTxt} config={researchConfig} onUpdateConfig={onResearchConfigChange}/></ToolModal>}
      {mountedPanels.has('office-extract') && <ToolModal title={PROJECT_PANEL_TITLES['office-extract']} ownerPageId={pageId} panelKind="office-extract" open={panel === 'office-extract'} busy={officeExtractBusy} onClose={() => setPanel(null)}>
        {officeExtractResult ? <div className={`flex min-h-64 flex-col items-center justify-center rounded-xl border px-6 py-10 text-center ${officeExtractResult.state === 'success' ? 'border-emerald-200 bg-emerald-50/70' : 'border-amber-200 bg-amber-50/70'}`}>{officeExtractResult.state === 'success' ? <CheckCircle2 size={42} className="text-emerald-600"/> : <AlertTriangle size={42} className="text-amber-600"/>}<p className="mt-4 text-lg font-bold text-slate-800">{officeExtractResult.state === 'publication-failed' ? t("ui.images.extracted.but.publication.failed.3e7e8f") : officeExtractResult.state === 'partial' ? t("ui.image.extraction.complete.some.documents.failed.a02d34") : t("ui.image.extraction.complete.f0a560")}</p><p className="mt-2 text-sm text-slate-600">{t("message.257082c4e609", { value0: officeExtractResult.documents, value1: officeExtractResult.successful, value2: officeExtractResult.images, value3: officeExtractResult.failed ? t("legacy.message.0a7768777de7", { value0: officeExtractResult.failed }) : '', value4: officeExtractResult.publicationFailures.length ? t("legacy.message.78aad3f24e27", { value0: officeExtractResult.publicationFailures.length }) : '' })}</p>{officeExtractResult.warning && <p className="mt-3 max-w-2xl rounded-lg border border-amber-200 bg-white/70 px-3 py-2 text-sm font-medium leading-6 text-amber-800">{t("message.a63ea1f79e81", { value0: officeExtractResult.warning })}</p>}{officeExtractResult.extractionFailures.length > 0 && <ul className="mt-3 max-w-2xl space-y-1 text-left text-xs text-slate-600">{officeExtractResult.extractionFailures.map(item => <li key={`extract-${item.documentName}`}>{t("message.382d1ae3b76d", { value0: item.documentName, value1: item.error })}</li>)}</ul>}{officeExtractResult.publicationFailures.length > 0 && <ul className="mt-3 max-w-2xl space-y-2 text-left text-xs text-amber-800">{officeExtractResult.publicationFailures.map(item => <li key={`publish-${item.documentName}`} className="rounded-md bg-white/70 px-3 py-2"><span className="font-bold">{t("message.5b92a009431a", { value0: item.documentName })}</span><span className="block"><LocalizedText value={item.error}/></span>{item.outputFolder && <span className="mt-1 block break-all text-slate-600">{t("message.daef9bb73452", { value0: item.outputFolder })}</span>}</li>)}</ul>}{officeExtractResult.outputFolders.length > 0 && <p className="mt-3 max-w-2xl break-all text-xs leading-5 text-slate-500">{t("message.b5c6360c7fe8", { value0: officeExtractResult.outputFolders.join('；') })}</p>}<button type="button" onClick={() => { setOfficeExtractResult(null); setOfficeExtractEntries([]); setPanel(null); }} className="dialog-primary mt-6">{t("common.close")}</button></div> : officeExtractError ? <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50/70 px-6 py-10 text-center"><AlertTriangle size={42} className="text-red-600"/><p className="mt-4 text-lg font-bold text-slate-800">{t("ui.image.extraction.failed.5be7c4")}</p><p className="mt-2 max-w-2xl break-words text-sm text-slate-600"><LocalizedText value={officeExtractError}/></p><div className="mt-6 flex items-center gap-2"><button type="button" onClick={() => { setOfficeExtractError(''); setOfficeExtractEntries([]); setPanel(null); }} className="dialog-secondary">{t("ui.choose.again.9b904c")}</button><button type="button" onClick={() => void extractOfficeImages()} className="dialog-primary">{t("ui.retry.b8784c")}</button></div></div> : <div className="space-y-4">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white"><header className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3"><FileImage size={18} className="text-blue-600"/><div className="min-w-0 flex-1"><p className="text-sm font-bold text-slate-800">{t("message.cd34f8decf51", { count: officeExtractEntries.length })}</p><p className="mt-0.5 text-xs text-slate-500">{t("ui.supports.word.powerpoint.and.excel.documents.9062d3")}</p></div><span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500">{t("message.32c60afe0f08", { count: officeExtractEntries.length })}</span></header><div className="max-h-52 divide-y divide-slate-100 overflow-y-auto">{officeExtractEntries.map(entry => <div key={entry.relativePath} className="flex items-center gap-3 px-4 py-2.5"><span className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-[10px] font-bold text-blue-700">{entry.extension.slice(1).toUpperCase()}</span><span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{entry.name}</span><span className="text-[10px] font-bold text-slate-400">{officeExtractBusy ? t("ui.processing.694b71") : t("ui.waiting.251bc4")}</span></div>)}</div></section>
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">{t("ui.save.beside.the.document.dc1838")}</p><p className="mt-1 text-xs leading-5 text-blue-600">{t("ui.images.are.saved.in.a.document.3d31b8")}</p></div>
          <section className="rounded-xl bg-slate-900 px-4 py-3 text-white"><div className="flex items-center justify-between text-xs font-bold"><span>{officeExtractBusy ? t("ui.extracting.images.72bfde") : t("ui.progress.f81ff5")}</span><span>{officeExtractBusy ? t("ui.processing.694b71") : '0%'}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-700"><div className={`h-full rounded-full bg-blue-500 ${officeExtractBusy ? 'w-2/3 animate-pulse' : 'w-0'}`}/></div><p className="mt-2 text-[10px] text-slate-400">{officeExtractBusy ? t("ui.reading.media.from.the.documents.please.16ef25") : t("ui.waiting.for.the.task.to.start.12f221")}</p></section>
          <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-4"><button type="button" disabled={officeExtractBusy} onClick={() => { setOfficeExtractEntries([]); setPanel(null); }} className="dialog-secondary disabled:opacity-50">{t("ui.choose.again.9b904c")}</button><button type="button" disabled={officeExtractBusy || !officeExtractEntries.length} onClick={() => void extractOfficeImages()} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-50">{officeExtractBusy ? <Loader2 size={16} className="animate-spin"/> : <Play size={16}/>} {officeExtractBusy ? t("ui.extracting.5717be") : t("ui.start.extraction.9f3c3a")}</button></div>
        </div>}
      </ToolModal>}
      {mountedPanels.has('trash') && <ToolModal title={PROJECT_PANEL_TITLES.trash} ownerPageId={pageId} panelKind="trash" open={panel === 'trash'} onClose={() => setPanel(null)}><p className="text-sm text-slate-500">{t("message.b8ca75a57044", { value0: project.name })}</p><button onClick={moveToTrash} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500">{t("ui.confirm.move.to.recycle.bin.c42615")}</button></ToolModal>}
      {gatherPickerPaths && createPortal(<div role="dialog" aria-modal="true" aria-label={t("ui.choose.inspiration.destination.project.13c97f")} className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4"><section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-900">{t("ui.choose.target.project.2b5125")}</h3><p className="mt-1 text-sm text-slate-500">{t("ui.selected.inspiration.will.appear.in.the.1dfce6")}</p></div><button type="button" disabled={gatheringInspiration} onClick={() => setGatherPickerPaths(null)} title={t("common.close")} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"><X size={17}/></button></div><div className="mt-4 max-h-80 space-y-1 overflow-y-auto">{inspirationProjects.map(targetProject => <button key={targetProject.path} type="button" disabled={gatheringInspiration} onClick={() => void gatherInspiration(targetProject, gatherPickerPaths)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm hover:bg-blue-50 ${targetProject.path === inspirationTargetProject?.path ? 'bg-blue-50 font-bold text-blue-700' : 'text-slate-700'}`}><Folder size={17} className="shrink-0 text-blue-500"/><span className="min-w-0 flex-1 truncate">{targetProject.name}</span><span className="shrink-0 text-xs text-slate-400">{targetProject.status}</span></button>)}{!inspirationProjects.length && <p className="rounded-lg bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">{t("ui.no.projects.are.available.in.the.6aae2d")}</p>}</div></section></div>, document.body)}
      {folderMarkSetup && <ToolModal title={t("ui.mark.folder.purpose.1e134f")} ownerPageId={pageId} panelKind="folder-mark" open busy={progressSubmitting} onClose={() => setFolderMarkSetup(null)}><FolderMarkPanel
        draft={folderMarkSetup}
        folders={progressFolders}
        state={progressSubmitting ? 'processing' : 'ready'}
        namePresets={progressNamePresets}
        onChange={setFolderMarkSetup}
        onSubmit={draft => void submitFolderMarkSetup(draft)}
        onClose={() => setFolderMarkSetup(null)}
      /></ToolModal>}
      {progressSetup && versionProgressDraft && versionProgressPanelMode && <ToolModal title={versionProgressPanelTitle} ownerPageId={pageId} panelKind={`version-${versionProgressPanelMode}`} open busy={progressSubmitting} onClose={closeProgressSetup}><VersionProgressPanel
        draft={versionProgressDraft}
        folders={progressFolders}
        state={progressSubmitting ? 'processing' : progressImportCompletion ? 'result' : 'ready'}
        progress={progressSetup.mode === 'import' && progressImportStatus ? {
          percentage: progressImportStatus.progress,
          processedCount: progressImportStatus.filesCopied ?? progressImportStatus.processedCount,
          totalCount: progressImportStatus.totalFiles ?? progressImportStatus.totalCount,
          currentName: progressImportStatus.currentName,
        } : progressMutationStatus}
        message={progressImportCompletion}
        namePresets={progressNamePresets}
        onChange={(draft: VersionProgressDraft) => {
          const policy = normalizeTrackingPolicy('main', draft);
          const draftParent = progressFolders.find(folder => folder.id === draft.parentProgressId);
          const relation: ProgressSetupDraft['relation'] = (draft.versionKind || versionKindForParent(draft.versionKey, draftParent)) === 'branch' ? 'branch' : 'root';
          setProgressSetup(current => current ? {
            ...current,
            mediaKind: draft.mediaKind,
            versionKey: draft.versionKey ?? current.versionKey,
            progressName: draft.displayName,
            preserveFolderName: Boolean(draft.targetFolderLocked),
            relationKind: 'main',
            relation,
            parentProgressId: draft.parentProgressId,
            trackingEnabled: policy.trackingEnabled,
            sourcePaths: draft.sourcePaths || [],
            deleteSourceAfterImport: draft.deleteSourceAfterImport === true,

            renameSources: policy.renameFromParent,
            copyMissingFromParent: policy.copyMissingFromParent,
            workflowInputProgressIds: current.existingProgressId
              ? workflowInputIdsForRelationChange(progressFolders, versionGraphEdges, current.existingProgressId, draft.parentProgressId || null)
              : defaultWorkflowInputIds(progressFolders, versionGraphEdges, draft.parentProgressId),
          } : current);
        }}
        onChooseFiles={() => void projectWorkspaceClient.chooseImportSourceFiles().then(result => {
          if (!result.cancelled && result.paths.length) setProgressSetup(current => current ? { ...current, sourcePaths: mergeSourcePaths(current.sourcePaths, result.paths) } : current);
        })}
        onChooseFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => {
          const sourcePath = result.path;
          if (!result.cancelled && sourcePath) setProgressSetup(current => current ? { ...current, sourcePaths: mergeSourcePaths(current.sourcePaths, [sourcePath]) } : current);
        })}
        importStep={progressImportStep}
        onImportStepChange={setProgressImportStep}
        onImportKindChange={(kind, sourcePaths) => openManualImport(kind, sourcePaths, fileImportTarget || currentRelativePath)}
        onSubmit={() => void submitProgressSetup()}
        onClose={closeProgressSetup}
      /></ToolModal>}
      {trackingConfirmationSessionId && <TrackingConfirmationPanel key={`${workspacePath}:${trackingConfirmationSessionId}`} active={active} sessionId={trackingConfirmationSessionId} workspacePath={workspacePath} progressFolders={progressFolders} cacheConfig={mediaCacheConfig} onNotice={onNotice} onClose={() => setTrackingConfirmationSessionId('')} onCommitted={() => { const committedSessionId = trackingConfirmationSessionId; const committedProgressId = trackingConfirmationProgressId; dismissTrackingTaskForSession(committedSessionId); if (committedProgressId) safeStorageRemove(`photoflow:tracking-session:${workspacePath}:${project.name}:${committedProgressId}`); setTrackingConfirmationSessionId(current => current === committedSessionId ? '' : current); setTrackingConfirmationProgressId(current => current === committedProgressId ? '' : current); void loadProgressFolders().then(() => refresh('')); }} onReleased={() => { dismissTrackingTaskForSession(trackingConfirmationSessionId); if (trackingConfirmationProgressId) safeStorageRemove(`photoflow:tracking-session:${workspacePath}:${project.name}:${trackingConfirmationProgressId}`); setTrackingConfirmationSessionId(''); setTrackingConfirmationProgressId(''); void loadProgressFolders(); }}/>
      }
      {progressCompare && <div role="dialog" aria-modal="true" aria-label={t("ui.confirm.version.relationships.b7ddb7")} className="fixed inset-0 z-[345] flex items-center justify-center bg-slate-950/50 p-4"><div className="flex h-[min(92vh,820px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="border-b border-slate-200 px-5 py-4"><h3 className="text-lg font-bold text-slate-800">{t("ui.confirm.version.relationships.b7ddb7")}</h3><p className="mt-1 text-xs text-slate-500">“{progressCompare.parentFolder.displayName}” → “{progressCompare.progressFolder.displayName}”</p></header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.85fr)_minmax(0,1.65fr)] gap-4 overflow-hidden p-5">
          <div className="flex min-h-0 flex-col"><div aria-label={t("ui.filter.version.relationship.statistics.5507b5")} className="mb-3 flex flex-wrap gap-2 text-xs">
            {([
              ['recognized', t("ui.detected.matches.40af7a"), progressCompare.matches.length, 'border-blue-200 bg-blue-50 text-blue-700', 'border-blue-500 ring-blue-200'],
              ['accepted', t("ui.selected.inheritance.901723"), progressCompare.acceptedSources.length, 'border-emerald-200 bg-emerald-50 text-emerald-700', 'border-emerald-500 ring-emerald-200'],
              ['new', t("ui.new.media.246918"), progressCompareNewSources.length, 'border-slate-200 bg-slate-100 text-slate-600', 'border-slate-500 ring-slate-200'],
              ['missing', t("ui.missing.from.new.version.bb326b"), progressCompareMissingReferences.length, 'border-slate-200 bg-slate-100 text-slate-600', 'border-slate-500 ring-slate-200'],
            ] as const).map(([filter, label, count, colorClass, activeClass]) => <button key={filter} type="button" aria-pressed={progressCompareFilter === filter} onClick={() => setProgressCompareFilter(filter)} className={`rounded-full border px-2.5 py-1 transition hover:brightness-95 focus:outline-none focus-visible:ring-2 ${colorClass} ${progressCompareFilter === filter ? `${activeClass} ring-2` : ''}`}>{label} {count}</button>)}
          </div>
            {progressCompareListItems.length ? <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-200">{progressCompareListItems.map(item => { const match = item.match; const accepted = Boolean(match && progressCompare.acceptedSources.includes(match.source)); const activeItem = activeProgressCompareItemKey === item.key; const suggested = Boolean(match && progressCompare.suggestions.some(candidate => candidate.source === match.source)); const badge = item.category === 'accepted' ? '已继承' : item.category === 'new' ? suggested ? '可继承' : '新素材' : item.category === 'missing' ? suggested ? '有候选' : '未返回' : suggested ? '最佳候选' : match?.confidence || '匹配'; return <div key={item.key} role="button" tabIndex={0} onClick={() => setActiveProgressCompareItemKey(item.key)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveProgressCompareItemKey(item.key); } }} className={`grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 py-2.5 text-xs last:border-0 ${activeItem ? 'border-blue-100 bg-blue-50 ring-1 ring-inset ring-blue-300' : 'border-slate-100 hover:bg-slate-50'}`}>
              {match ? <input type="checkbox" checked={accepted} aria-label={t("ui.use.value0.as.an.inherited.version.d56851", { value0: match.source })} onClick={event => event.stopPropagation()} onChange={() => setProgressCompare(current => current ? { ...current, acceptedSources: accepted ? current.acceptedSources.filter(source => source !== match.source) : [...current.acceptedSources, match.source] } : current)}/> : <span aria-hidden className="h-4 w-4"/>}
              <span className="min-w-0">{item.source ? <span className="block truncate font-medium text-slate-700" title={item.source}>{t("message.a7bd88008857", { value0: item.source })}</span> : <span className="block text-slate-400">{t("ui.current.not.returned.dc1c33")}</span>}{item.reference ? <span className="mt-1 block truncate text-slate-400" title={item.reference}>{t("message.b234c860f605", { value0: item.reference })}</span> : <span className="mt-1 block text-slate-400">{t("ui.previous.no.matching.media.ed2ec0")}</span>}</span>
              <span className={`rounded-full px-2 py-0.5 font-bold ${item.category === 'accepted' ? 'bg-emerald-50 text-emerald-600' : item.category === 'new' || item.category === 'missing' ? 'bg-slate-100 text-slate-500' : suggested ? 'bg-slate-100 text-slate-500' : match?.confidence === '高' ? 'bg-emerald-50 text-emerald-600' : match?.confidence === '中' ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-500'}`}>{badge}</span>
            </div>; })}</div> : <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">{t("ui.no.media.in.this.category.07cdb4")}</p>}
            {progressCompare.renameSources && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t("ui.confirming.renames.checked.new.version.files.679620")}</p>}
            {progressCompare.copyMissingFromParent && <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">{t("message.be7d6decd0fa", { count: progressCompareMissingReferences.length })}</p>}
          </div>
          <ProgressPairPreview match={activeProgressCompareItem ? { source: activeProgressCompareItem.source, reference: activeProgressCompareItem.reference } : undefined} parentFolder={progressCompare.parentFolder} progressFolder={progressCompare.progressFolder} cacheConfig={mediaCacheConfig}/>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><button type="button" onClick={() => progressCompare.reconcileExisting ? void closeProgressCompare() : void disableProgressTracking()} disabled={progressSubmitting} className="dialog-secondary">{progressCompare.trackingRefreshMode === 'establish' ? t("ui.cancel.tracking.setup.c1b168") : progressCompare.trackingRefreshMode === 'refresh' ? t("ui.cancel.rescan.193c00") : progressCompare.reconcileExisting ? t("ui.cancel.reprocessing.cdb59a") : progressCompare.sourceMode === 'mark' ? t("ui.mark.progress.without.tracking.d27ede") : t("ui.keep.import.without.tracking.3909e0")}</button><button type="button" onClick={() => void commitProgressCompare()} disabled={progressSubmitting} className="dialog-primary inline-flex items-center gap-2">{progressSubmitting && <Loader2 size={15} className="animate-spin"/>}{progressCompare.trackingRefreshMode === 'establish' ? t("ui.confirm.and.start.tracking.ef93a9") : progressCompare.reconcileExisting ? t("ui.confirm.and.update.relationships.327ded") : t("ui.confirm.and.start.tracking.ef93a9")}</button></footer>
      </div></div>}
      {progressRepair && <div role="dialog" aria-modal="true" aria-label={t("ui.repair.version.batch.e5ae0a")} className="fixed inset-0 z-[348] flex items-center justify-center bg-slate-950/50 p-4"><div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h3 className="font-bold text-slate-800">{t("ui.repair.version.batch.e5ae0a")}</h3><p className="mt-1 text-xs text-slate-500">{t("message.d0a2a664d828", { value0: progressRepair.progressFolder.displayName })}</p></div><button type="button" disabled={progressRepairBusy} onClick={() => setProgressRepair(null)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"><X size={17}/></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="overflow-hidden rounded-xl border border-slate-200">{progressRepair.operations.length ? progressRepair.operations.map(operation => <div key={operation.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-slate-100 px-4 py-3 text-xs last:border-0"><div className="min-w-0"><p className="truncate font-medium text-slate-700" title={operation.sourcePath}>{operation.sourcePath.replace(/.*[\\/]/, '')} → {operation.targetPath.replace(/.*[\\/]/, '')}</p><p className={`mt-1 leading-5 ${operation.status === 'succeeded' ? 'text-emerald-600' : 'text-red-600'}`}>{operation.status === 'succeeded' ? t("ui.completed.f28461") : operation.error || t("ui.queued.4f021f")}</p></div><span className={`self-start rounded-full px-2 py-1 font-bold ${operation.status === 'succeeded' ? 'bg-emerald-50 text-emerald-600' : operation.status === 'running' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'}`}>{operation.status === 'succeeded' ? t("ui.success.053461") : operation.status === 'running' ? t("ui.processing.694b71") : t("ui.retry.pending.value0.340df9", { value0: operation.attemptCount })}</span></div>) : <p className="px-4 py-8 text-center text-sm text-slate-500">{t("ui.this.batch.has.no.file.operations.bc063e")}</p>}</div></div>
        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><p className="text-xs text-slate-500">{t("ui.retry.processes.only.failed.or.unfinished.d21b92")}</p><div className="flex gap-2"><button type="button" disabled={progressRepairBusy} onClick={() => setProgressRepair(null)} className="dialog-secondary">{t("ui.handle.later.bf639a")}</button><button type="button" disabled={progressRepairBusy || !progressRepair.operations.some(operation => operation.status !== 'succeeded')} onClick={() => void retryProgressRepair()} className="dialog-primary inline-flex items-center gap-2">{progressRepairBusy && <Loader2 size={15} className="animate-spin"/>}{t("ui.retry.unfinished.items.6ea392")}</button></div></footer>
      </div></div>}
      {active && activeView === 'project' && filesPaneOpen && batchRenameOpen && createPortal(<div role="dialog" aria-modal="true" aria-label={t("ui.batch.rename.07b79b")}
        onPointerDown={event => event.stopPropagation()}
        onPointerMove={event => event.stopPropagation()}
        onPointerUp={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
        className="fixed inset-0 z-[330] flex items-center justify-center bg-slate-950/40 p-4"><div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"><header className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><h3 className="font-bold text-slate-800">{t("message.450b12ae46dc", { count: selectedPaths.length })}</h3><p className="mt-1 text-xs text-slate-500">{t("ui.each.row.generates.or.modifies.part.bd3a35")}</p></div><button onClick={() => setBatchRenameOpen(false)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100"><X size={18}/></button></header><div className="min-h-0 flex-1 overflow-y-auto p-5">
        <section>
          <h4 className="mb-2 text-sm font-bold text-slate-700">{t("ui.new.file.name.rules.3ddbe0")}</h4>
          <div className="space-y-2">{batchRenameParts.map((part, index) => <div key={part.id} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); moveDraggedBatchRenamePart(part.id); setDraggedBatchRenamePartId(''); }} className={`flex items-center gap-2 rounded-lg border bg-slate-50 p-2 ${draggedBatchRenamePartId === part.id ? 'border-blue-400 opacity-60' : 'border-slate-200'}`}>
            <button type="button" draggable onDragStart={event => { setDraggedBatchRenamePartId(part.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDraggedBatchRenamePartId('')} title={t("ui.drag.to.reorder.0e4e4a")} className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-200 active:cursor-grabbing"><GripVertical size={17}/></button>
            <select value={part.type} onChange={event => updateBatchRenamePart(part.id, { type: event.target.value as BatchRenameToken })} className="w-32 shrink-0 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm text-slate-700"><option value="text">{t("ui.text.dd8186")}</option><option value="original">{t("ui.current.file.name.507175")}</option><option value="sequence">{t("ui.sequential.numbers.205793")}</option><option value="letter">{t("ui.sequential.letters.8568ce")}</option><option value="datetime">{t("ui.date.and.time.6ac8b7")}</option><option value="replace">{t("ui.text.replacement.4b3444")}</option></select>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {part.type === 'text' && <input autoFocus={index === 0} value={part.value} onChange={event => updateBatchRenamePart(part.id, { value: event.target.value })} placeholder={t("ui.enter.text.or.separator.9e1371")} className="min-w-[180px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"/>}
              {part.type === 'original' && <><span className="text-xs text-slate-500">{t("ui.letter.case.94d82f")}</span><select value={part.caseMode} onChange={event => updateBatchRenamePart(part.id, { caseMode: event.target.value as BatchRenamePart['caseMode'] })} className="min-w-[150px] flex-1 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"><option value="preserve">{t("ui.keep.original.case.b6d943")}</option><option value="upper">{t("ui.uppercase.81adea")}</option><option value="lower">{t("ui.lowercase.0b9bb5")}</option></select></>}
              {part.type === 'sequence' && <><span className="text-xs text-slate-500">{t("ui.starting.value.6be32c")}</span><input type="number" min="0" value={part.sequenceStart} onChange={event => updateBatchRenamePart(part.id, { sequenceStart: Math.max(0, Number(event.target.value) || 0) })} className="w-24 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"/><span className="text-xs text-slate-500">{t("ui.digits.c7cd50")}</span><select value={part.sequenceDigits} onChange={event => updateBatchRenamePart(part.id, { sequenceDigits: Number(event.target.value) })} className="w-24 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm">{[1, 2, 3, 4, 5, 6].map(value => <option key={value} value={value}>{t("message.921011d4494e", { count: value })}</option>)}</select></>}
              {part.type === 'letter' && <><span className="text-xs text-slate-500">{t("ui.letter.case.224b9f")}</span><select value={part.letterCase} onChange={event => updateBatchRenamePart(part.id, { letterCase: event.target.value as BatchRenamePart['letterCase'] })} className="min-w-[130px] flex-1 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"><option value="upper">{t("ui.uppercase.a.b.3cca12")}</option><option value="lower">{t("ui.lowercase.a.b.bbd490")}</option></select></>}
              {part.type === 'datetime' && <><select value={part.dateSource} onChange={event => updateBatchRenamePart(part.id, { dateSource: event.target.value as BatchRenamePart['dateSource'] })} className="w-28 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"><option value="created">{t("ui.date.created.07aa0e")}</option><option value="modified">{t("ui.date.modified.2cbced")}</option></select><select value={part.dateFormat} onChange={event => updateBatchRenamePart(part.id, { dateFormat: event.target.value })} className="min-w-[220px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm"><option value="YYYYMMDD_HHmmss">YYYYMMDD_HHmmss</option><option value="YYYYMMDD">YYYYMMDD</option><option value="HHmmss">HHmmss</option><option value="DDMMYYYY_HHmmss">DDMMYYYY_HHmmss</option><option value="DDMMYYYY">DDMMYYYY</option></select></>}
              {part.type === 'replace' && <><input value={part.find} onChange={event => updateBatchRenamePart(part.id, { find: event.target.value })} placeholder={t("ui.find.f75c67")} className="min-w-[120px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"/><ArrowRight size={14} className="text-slate-400"/><input value={part.replace} onChange={event => updateBatchRenamePart(part.id, { replace: event.target.value })} placeholder={t("ui.replace.with.blank.to.remove.542fdb")} className="min-w-[160px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"/></>}
            </div>
            <button type="button" onClick={() => insertBatchRenamePart(index)} title={t("ui.add.a.row.below.d0fbc2")} className="rounded-md p-2 text-blue-600 hover:bg-blue-50"><Plus size={16}/></button>
            <button type="button" disabled={batchRenameParts.length === 1} onClick={() => setBatchRenameParts(parts => parts.filter(item => item.id !== part.id))} title={t("ui.delete.this.row.5969c6")} className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-30"><X size={16}/></button>
          </div>)}</div>
        </section>
        <section className="mt-5 border-t border-slate-200 pt-5"><h4 className="mb-2 text-sm font-bold text-slate-700">{t("ui.extension.8c19d7")}</h4><div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><select value={batchExtensionMode} onChange={event => setBatchExtensionMode(event.target.value as 'preserve' | 'replace')} className="w-40 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="preserve">{t("ui.keep.extension.261b49")}</option><option value="replace">{t("ui.change.extension.e9e58b")}</option></select>{batchExtensionMode === 'replace' && <input autoFocus value={batchExtensionValue} onChange={event => setBatchExtensionValue(event.target.value.replace(/^\.+/, ''))} placeholder={t("ui.for.example.jpg.81d19c")} className="min-w-[180px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"/>}<span className="text-xs text-slate-400">{t("ui.this.setting.does.not.affect.folders.cacf7b")}</span></div></section>
        <section className="mt-5 border-t border-slate-200 pt-5"><h4 className="mb-2 text-sm font-bold text-slate-700">{t("ui.preview.13d61f")}</h4><div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50">{batchRenameEntries.slice(0, 20).map((entry, index) => <div key={entry.path} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200 px-3 py-2 text-xs last:border-0"><span className="truncate text-slate-500" title={entry.name}>{entry.name}</span><ArrowRight size={13} className="text-slate-300"/><span className="truncate font-medium text-slate-700" title={batchRenameNames[index]}>{batchRenameNames[index] || t("ui.empty.file.name.86b5d5")}</span></div>)}{batchRenameEntries.length > 20 && <p className="px-3 py-2 text-center text-xs text-slate-400">{t("message.98dcd7a48046", { count: batchRenameEntries.length - 20 })}</p>}</div></section>
      </div><footer className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-4"><p className="text-xs text-slate-500">{t("ui.renaming.uses.temporary.files.to.avoid.df1bac")}</p><div className="flex gap-2"><button onClick={() => setBatchRenameOpen(false)} className="dialog-secondary">{t("common.cancel")}</button><button onClick={commitBatchRename} disabled={!batchRenameNames.length || batchRenameNames.some(name => !name) || batchExtensionMode === 'replace' && !batchExtensionValue.trim() || new Set(batchRenameNames.map(name => name.toLocaleLowerCase())).size !== batchRenameNames.length} className="dialog-primary">{t("ui.batch.rename.07b79b")}</button></div></footer></div></div>, document.body)}
      {renderedVersionEntry && <div className={activeView === 'version' ? 'contents' : 'hidden'}><VersionManager active={active && activeView === 'version'} entry={renderedVersionEntry} workspacePath={workspacePath} project={project} cacheConfig={mediaCacheConfig} videoPlaybackSettings={videoPlaybackSettings} progressId={versionProgressFolder?.id || versionProgressId} progressVersionKey={versionProgressFolder?.versionKey} onNotice={onNotice} onVersionStateChanged={() => { if (finalViewOpen) void loadFinalViewEntries(); }} onClose={() => { setVersionEntry(null); setVersionProgressId(''); versionProgressLocationRef.current = null; onCloseToolTab('version'); if (finalViewOpen) void loadFinalViewEntries(); }}/></div>}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {versionTreeOpen ? <div ref={filesSurfaceRef} data-photoflow-file-surface="true" tabIndex={0} onContextMenu={openSurfaceMenu} onPointerDownCapture={handleFileSurfacePointerDownCapture} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} style={{ marginInline: -FILE_SURFACE_HORIZONTAL_PADDING }} className={`relative min-h-0 flex-1 select-none overflow-hidden outline-none transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {!progressFoldersReady ? <div role={progressFoldersLoadError ? 'alert' : versionTreeSlowLoadVisible ? 'status' : undefined} aria-live={progressFoldersLoadError || versionTreeSlowLoadVisible ? 'polite' : undefined} className={`flex h-full min-h-[360px] flex-col items-center justify-center gap-3 border-y border-slate-200 text-sm ${progressFoldersLoadError ? 'text-red-600' : 'text-slate-500'}`}>
            {progressFoldersLoadError ? <><AlertTriangle size={20}/><span>{t("message.9a413ca373dc", { value0: progressFoldersLoadError })}</span><button type="button" onClick={() => void loadProgressFoldersSnapshot().then(() => loadProgressFolders())} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50">{t("ui.reload.7bdd5c")}</button></> : versionTreeSlowLoadVisible ? <><Loader2 size={20} className="animate-spin"/><span>{t("ui.loading.version.relationships.b5bcd7")}</span></> : null}
          </div> : progressRelationInspection.needsRepair ? <div role="alert" className="m-4 rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-900"><div className="flex items-center gap-2 font-bold"><AlertTriangle size={18}/>{t("ui.version.relationships.need.repair.4ac5b6")}</div><p className="mt-2 text-sm">{t("ui.a.cycle.was.detected.version.tree.c6eb80")}</p><p className="mt-2 break-all font-mono text-xs text-amber-700">{t("message.0391976a817c", { value0: progressRelationInspection.cycleNodeIds.join('、') })}</p></div> : <>{orphanedProgressFolders.length > 0 && <div role="alert" className="m-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900"><div className="flex items-center gap-2 font-bold"><AlertTriangle size={18}/>{t("ui.legacy.detached.progress.kept.2a934c")}</div><p className="mt-2 text-sm">{t("ui.these.nodes.are.kept.during.refresh.d3ef41")}</p><p className="mt-2 text-xs text-amber-700">{orphanedProgressFolders.map(folder => folder.displayName).join('、')}</p></div>}<ProjectVersionTree
            active={active && activeView === 'project'}
            progressFolders={progressFolders}
            graphEdges={versionGraphEdges}
            entries={displayedFileEntries}
            structureEntries={fileEntries}
            selectedRelativePaths={selectedPaths}
            filterActive={Boolean(searchQuery.trim() || fileFilter !== 'all' || ratingFilter !== 'all')}
            activeRelativePath={currentRelativePath}
            gridIconSize={gridIconSize}
            workspacePath={workspacePath}
            projectName={project.name}
            projectRelativePath={projectRelativePath}
            renderEntry={renderVersionTreeEntry}
            pendingChildId={pendingRelationChange?.childProgressId || draggingChildId || undefined}
            hoverParentId={hoverParentId || undefined}
            mutatingChildIds={relationMutatingChildIds}
            onBeginRelationEdit={childId => { setDraggingChildId(childId); setHoverParentId(''); }}
            onHoverRelationParent={parentId => setHoverParentId(parentId || '')}
            onRequestRelationChange={(childProgressId, parentProgressId) => void requestProgressRelationChange(childProgressId, parentProgressId)}
            onRequestSupplementalEdgeDelete={edge => void requestSupplementalEdgeDelete(edge)}
            onRequestSupplementalEdgeReconnect={(edge, newSourceProgressId) => void requestSupplementalEdgeReconnect(edge, newSourceProgressId)}
            onRequestSupplementalEdgeCreate={(sourceProgressId, targetProgressId, edgeKind) => void requestSupplementalEdgeCreate(sourceProgressId, targetProgressId, edgeKind)}
            onRequestCreateVersion={(source, entry) => void openNextProgressFromVersionTree(source, entry)}
            onRequestCreateEmptyVersion={(source, branch) => void openEmptyProgressFromVersionTree(source, branch)}
            onRequestEntryContextMenu={openFileMenu}
            onStartFileDrag={(event, entry) => startEntryDrag(event, entry, 'version-tree')}
            canUndoRelation={relationHistoryRevision >= 0 && canUndoRelation}
            canRedoRelation={relationHistoryRevision >= 0 && canRedoRelation}
            onUndoRelation={() => void undoVersionGraphAction()}
            onRedoRelation={() => void redoVersionGraphAction()}
            onCancelRelationEdit={cancelRelationEdit}
            onNotice={onNotice}
            onCanvasControllerChange={setVersionTreeCanvasController}
            onViewportScrollChange={setVersionTreeHeaderCollapsed}
          /></>}
        </div> : <div ref={filesSurfaceRef} data-photoflow-file-surface="true" tabIndex={0} onContextMenu={openSurfaceMenu} onPointerDownCapture={handleFileSurfacePointerDownCapture} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} style={{ marginInline: -FILE_SURFACE_HORIZONTAL_PADDING, paddingInline: FILE_SURFACE_HORIZONTAL_PADDING }} className={`relative min-h-[220px] flex-1 select-none outline-none transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {groupedResultsActive && (groupedInitialLoading ? <p className="py-12 text-center text-sm text-slate-400"><Loader2 size={17} className="mr-2 inline animate-spin"/>{projectRootFilterActive ? t("ui.loading.all.files.in.pages.912aa0") : searchQuery.trim() ? t("message.9887d2a2c7e8", { value0: recursiveScopeLabel }) : t("ui.loading.all.files.140ff9")}</p> : groupedError && !searchResultGroups.length ? <p className="py-8 text-center text-sm text-red-600">{t("message.1b91c3b60194", { value0: groupedError })}</p> : searchResultGroups.length ? <div className="pb-4">
            <p className="flex items-center gap-1.5 px-1 text-xs text-slate-500">{groupedLoading && <Loader2 aria-label={t("ui.refreshing.in.background.371683")} size={13} className="shrink-0 animate-spin"/>}<span>{projectRootFilterActive ? t("ui.loaded.files.in.pages.from.value0.5403d9", { value0: browserContext.title, value1: displayedFileEntries.length }) : searchQuery.trim() ? t("ui.files.found.in.value0.value1.09bed6", { value0: currentRelativePath ? t("ui.value0.and.its.subfolders.097bf2", { value0: currentRelativePath }) : recursiveScopeLabel, value1: displayedFileEntries.length }) : t("ui.files.loaded.from.value0.value1.601c8a", { value0: currentRelativePath ? t("ui.value0.and.its.subfolders.097bf2", { value0: currentRelativePath }) : recursiveScopeLabel, value1: displayedFileEntries.length })}</span></p>
            {searchResultGroups.map(([folderPath, entries], groupIndex) => { const viaShortcut = entries.some(entry => entry.viaShortcut); const readOnlyShortcut = viaShortcut; const folderLabel = viaShortcut ? folderPath.replace(/\.lnk(?=\/|$)/gi, '') : folderPath; const targetLabel = folderLabel || project.name; const normalizedFolderPath = normalizeProjectRelativePath(folderPath); return <section key={folderPath || '__root__'} data-recursive-folder-path={normalizedFolderPath} data-recursive-folder-label={targetLabel} data-recursive-folder-readonly={readOnlyShortcut ? 'true' : 'false'} data-drop-capable={readOnlyShortcut ? 'false' : 'true'} onContextMenu={event => { if (readOnlyShortcut) { event.preventDefault(); event.stopPropagation(); onNotice('快捷方式指向的外部文件夹是只读浏览区域'); } else openSurfaceMenu(event, normalizedFolderPath, targetLabel); }} onDragOver={event => handleRecursiveFolderDragOver(event, normalizedFolderPath, readOnlyShortcut)} onDragLeave={event => handleRecursiveFolderDragLeave(event, normalizedFolderPath)} onDrop={event => void handleRecursiveFolderDrop(event, normalizedFolderPath, targetLabel, readOnlyShortcut)} className={`${groupIndex ? 'mt-5 border-t border-slate-200 pt-4' : 'pt-3'} rounded-lg transition ${recursiveDropTargetPath === normalizedFolderPath ? 'bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}><header className="mb-2 flex min-w-0 items-center gap-2 px-1"><Folder size={16} className="shrink-0 text-blue-500"/>{readOnlyShortcut ? <span title={t("ui.value0.shortcut.3471df", { value0: folderLabel })} className="min-w-0 truncate text-sm font-bold text-slate-700">{folderLabel || t("ui.shortcut.6ab335")} <span className="font-normal text-slate-400">{t("ui.shortcut.9d3af9")}</span></span> : <button type="button" onClick={() => { setSearchQuery(''); navigateToDirectory(folderPath); }} title={t("ui.open.value0.2d0d16", { value0: folderPath || project.name })} className="min-w-0 truncate text-sm font-bold text-slate-700 hover:text-blue-600">{folderPath || t("ui.project.root.3db07c")}</button>}<span className="shrink-0 text-xs text-slate-400">{t("message.d7fc811a3b82", { count: entries.length })}</span></header><div className="grid w-full content-start" style={{ gap: FILE_GRID_GAP, gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{entries.map(entry => <div key={`${entry.relativePath}|${entry.path}`} role="button" tabIndex={0} draggable={!entry.viaShortcut} onDragStart={event => startEntryDrag(event, entry)} data-entry-kind={entry.kind} data-drop-capable={isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry) ? 'true' : 'false'} data-entry-path={entry.relativePath} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.relativePath} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) ? 'bg-blue-50 ring-1 ring-blue-400 focus-visible:outline-none' : ''} ${entryHasPreviewState(entry) && !selectedPaths.includes(entry.relativePath) ? 'project-file-entry-preview' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''}`}>{renderEntrySelectionControl(entry)}<div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div><p className="mt-2 truncate text-xs font-medium text-slate-700">{getEntryDisplayName(entry)}</p><p className="mt-0.5 text-[10px] uppercase text-slate-400">{getEntryTypeLabel(entry)}</p></div>)}</div></section>; })}
            {(!searchQuery.trim() || projectRootFilterActive) && <p className={`py-6 text-center text-xs ${groupedLoadError ? 'text-red-500' : 'text-slate-400'}`}>{groupedLoadError ? t("ui.could.not.load.more.value0.47f435", { value0: groupedLoadError }) : groupedLoadingMore ? <><Loader2 size={14} className="mr-1.5 inline animate-spin"/>{t("ui.loading.more.4c4439")}</> : groupedHasMore ? t("ui.scroll.down.to.load.more.files.981f85") : t("ui.all.files.in.this.scope.are.8bea8f")}</p>}
          </div> : <p className="py-12 text-center text-sm text-slate-400">{projectRootFilterActive ? t("ui.no.value1.in.value0.match.the.798f6d", { value0: browserContext.title, value1: filteredFileTypeLabel }) : searchQuery.trim() ? t("ui.no.files.in.value0.containing.value1.a6d847", { value0: recursiveScopeLabel, value1: searchQuery }) : t("ui.no.value0.to.display.in.this.b1074a", { value0: filteredFileTypeLabel })}</p>)}
          {!groupedResultsActive && searchQuery.trim() && searchLoading && <p className="py-12 text-center text-sm text-slate-400"><Loader2 size={17} className="mr-2 inline animate-spin"/>{t("message.9887d2a2c7e8", { value0: recursiveScopeLabel })}</p>}
          {!groupedResultsActive && searchQuery.trim() && searchError && <p className="py-8 text-center text-sm text-red-600">{t("message.77ae74941c44", { value0: searchError })}</p>}
          <div className={groupedResultsActive || Boolean(searchQuery.trim() && (searchLoading || searchError)) ? 'hidden' : undefined}>
          {directoryLoading ? <div role="status" aria-live="polite" className="flex min-h-[220px] items-center justify-center border-y border-slate-200 text-sm text-slate-500"><Loader2 size={18} className="mr-2 animate-spin"/>{t("ui.loading.4927a5")}</div> : displayedFileEntries.length ? viewMode === 'list' ? <div className="file-list-table border-y border-slate-200 text-sm" style={fileListGridStyle}>
            <div className="file-list-row file-list-heading text-xs font-medium text-slate-500">
              <span className="file-list-heading-cell"><span className="file-list-heading-label">{t("ui.name.d44e9b")}</span><FileListColumnResizeHandle label={t("ui.resize.name.column.8ab65e")} onDrag={deltaX => resizeFileListBoundary(0, deltaX)}/></span>
              <span className="file-list-heading-cell"><span className="file-list-heading-label">{t("ui.date.modified.2cbced")}</span><FileListColumnResizeHandle label={t("ui.resize.date.modified.column.4f2fb9")} onDrag={deltaX => resizeFileListBoundary(1, deltaX)}/></span>
              <span className="file-list-heading-cell"><span className="file-list-heading-label">{t("ui.type.ba4001")}</span><FileListColumnResizeHandle label={t("ui.resize.type.column.d228de")} onDrag={deltaX => resizeFileListBoundary(2, deltaX)}/></span>
              <span className="file-list-heading-cell"><span className="file-list-heading-label">{t("ui.size.50db74")}</span><FileListColumnResizeHandle last label={t("ui.resize.size.column.8910f0")} onDrag={deltaX => resizeFileListBoundary(3, deltaX)}/></span>
            </div>
            {virtualWindow.top > 0 && <div aria-hidden style={{ height: virtualWindow.top }} />}
            {renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-drop-capable={isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry) ? 'true' : 'false'} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`file-list-row group w-full cursor-default border-t border-slate-200 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) ? 'bg-blue-50 focus-visible:outline-none' : ''} ${entryHasPreviewState(entry) && !selectedPaths.includes(entry.relativePath) ? 'project-file-entry-preview' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-inset ring-blue-500' : ''}`}>
              <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">{renderEntrySelectionControl(entry, true)}<span className="relative flex h-9 w-11 shrink-0 items-center justify-center overflow-hidden">{renderEntryIcon(entry)}</span>{renderEntryName(entry)}</span>
              <span className="min-w-0 truncate text-slate-500">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString(getLocale()) : '…'}</span>
              <span className="min-w-0 truncate uppercase text-slate-500">{getEntryTypeLabel(entry)}</span>
              <span className="min-w-0 truncate text-slate-500">{entry.kind === 'folder' ? '' : entry.size >= 0 ? formatFileSize(entry.size) : '…'}</span>
            </div>)}
            {virtualWindow.bottom > 0 && <div aria-hidden style={{ height: virtualWindow.bottom }} />}
          </div> : <><div aria-hidden style={{ height: virtualWindow.top }}/><div className="grid w-full content-start" style={{ gap: FILE_GRID_GAP, gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-drop-capable={isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry) ? 'true' : 'false'} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) ? 'bg-blue-50 ring-1 ring-blue-400 focus-visible:outline-none' : ''} ${entryHasPreviewState(entry) && !selectedPaths.includes(entry.relativePath) ? 'project-file-entry-preview' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-blue-500' : ''}`}>{renderEntrySelectionControl(entry)}<div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div>{renderEntryName(entry, true)}<p className="mt-0.5 text-[10px] uppercase text-slate-400">{getEntryTypeLabel(entry)}</p></div>)}</div><div aria-hidden style={{ height: virtualWindow.bottom }}/></> : <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">{searchQuery ? t("ui.no.files.containing.value0.match.the.5c385a", { value0: searchQuery }) : t("ui.this.folder.contains.no.value0.3ae639", { value0: filteredFileTypeLabel })}</p>}
          </div>
        </div>}
      </section>

      <section className="hidden rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-bold text-slate-800">{t("ui.project.folder.9f3388")}</h3><span className="text-sm text-slate-500">{t("message.d7fc811a3b82", { count: folders.length })}</span></div>
        {folders.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{folders.map(folder => <button key={folder.path} onClick={() => openFolder(folder.name)} title={t("ui.open.value0.2d0d16", { value0: folder.name })} className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition hover:bg-blue-50"><Folder size={64} strokeWidth={1.5} fill="currentColor" className="text-blue-500 drop-shadow-sm transition-transform group-hover:scale-105"/><span className="max-w-full truncate text-sm font-medium text-slate-700">{folder.name}</span></button>)}</div> : <p className="py-8 text-center text-sm text-slate-400">{t("ui.no.subfolders.1c91e1")}</p>}
      </section>

      </div>
      {componentPanels.panels.map(contribution => { const id = componentWorkspacePanelId(contribution.componentId, contribution.contributionId); const control = componentPanels.controls[id]!; return <ComponentFolderPanelSurface key={id} contribution={contribution} project={project} workspacePath={componentWorkspacePath} scope={{ scopeRelativePath: currentRelativePath, selectedRelativePaths, sourcePageId: pageId, contentKind: componentContentKind }} active={active && activeView === 'project'} open={control.open} pinned={control.pinned} width={displayedColumnWidths[id]} order={panelOrder.indexOf(id) * 2} onClose={() => control.setOpen(false)} onTogglePinned={() => control.setPinned(!control.pinned)}/>; })}
      {previewPaneOpen && active && activeView === 'project' && <><MediaPreviewPane previewContext={{ workspacePath: componentWorkspacePath, projectId: project.id, projectName: project.name, projectStatus: project.status, scopeRelativePath: currentRelativePath, sourcePageId: pageId, contentKind: componentContentKind }} decoder={previewEntry ? decoderForFile(previewDecoders, previewEntry.name) : undefined} panelOrder={panelOrder.indexOf('preview') * 2} onSelectImage={() => void selectPreviewImage()} selectionAvailable={previewSelectionAvailable} selectionBusy={previewSelectionBusy} entry={previewEntry} cacheConfig={mediaCacheConfig} width={displayedColumnWidths.preview} pinned={previewPanePinned} keyboardSettings={videoPlaybackSettings} videoTrimExportMode={videoTools.trim.exportMode} videoTrimAvailable={videoToolsAvailable && advancedVideoPlaybackAvailable} photoshopAvailable={photoshopAvailable} ratingAvailable={previewCanMarkFinal} rating={previewRating} ratingMode={favoriteDisplayMode} ratingLoading={previewRatingLoading} ratingBusy={previewRatingBusy} onChangeRating={rating => void updatePreviewRating(rating)} onTogglePinned={togglePreviewPanePinned} onTechnicalMetadata={setPreviewTechnicalMetadata} onNavigate={navigatePreviewMedia} onContextMenu={event => previewEntry && openFileMenu(event, previewEntry, false)} onContextMenuAt={(x, y) => previewEntry && openFileMenuAt(x, y, previewEntry, false)} onAnalyzeImageCrop={analyzePreviewImageCrop} onConfirmImageCrop={savePreviewImageCrop} onTrimVideo={trimPreviewVideo} onLoadVideoTimelineFrames={loadPreviewVideoTimelineFrames} onOpen={() => previewEntry && openProjectEntry(previewEntry)} onOpenInPhotoshop={() => previewEntry && openProjectEntriesInPhotoshop([previewEntry])} onClose={closePreviewPaneByUser}/></>}
      {metadataPaneOpen && <><FileMetadataPane panelOrder={panelOrder.indexOf('metadata') * 2} entry={focusedEntry} selectedEntries={selectedEntries} selectionEntryDetails={selectionEntryDetails} selectionEntryDetailsLoading={selectionEntryDetailsLoading} entryDetails={previewEntryDetails} metadataFields={currentPreviewMetadataFields} metadataLoading={currentPreviewMetadataLoading} metadataError={currentPreviewMetadataError} technicalMetadata={focusedEntry?.relativePath === previewEntry?.relativePath ? previewTechnicalMetadata : EMPTY_PREVIEW_TECHNICAL_METADATA} formatFileSize={formatFileSize} width={displayedColumnWidths.metadata} pinned={metadataPanePinned} onTogglePinned={toggleMetadataPanePinned} onOpen={() => focusedEntry && openProjectEntry(focusedEntry, true)} onCopyPath={() => copyEntryPaths(selectedEntries.length > 1 ? selectedEntries : focusedEntry ? [focusedEntry] : [])} onClose={closeMetadataPaneByUser}/></>}
      </WorkspaceDockLayout>

      {confirmDelete && <div className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/40 p-4"><div role="dialog" aria-modal="true" aria-label={t("ui.delete.project.f6dc6a")} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-800">{t("ui.delete.this.project.8bbed1")}</h3><button onClick={() => setConfirmDelete(false)}><X size={18}/></button></div><p className="text-sm text-slate-500">{t("message.70be90ecc5dc", { value0: project.name })}</p><div className="mt-5 flex justify-end gap-2"><button onClick={() => setConfirmDelete(false)} className="dialog-secondary">{t("common.cancel")}</button><button onClick={async () => { setConfirmDelete(false); await moveToTrash(); }} className="rounded-md bg-red-600 px-3 py-2 text-sm font-bold text-white hover:bg-red-500">{t("ui.delete.project.f6dc6a")}</button></div></div></div>}
    </div>
  );
};

type ProjectWorkspaceProps = Omit<FileBrowserWorkspaceProps, 'browserContext' | 'onDirectoryChange' | 'onOpenToolTab' | 'onCloseToolTab' | 'onNotice'> & {
  pageId: string;
  onDirectoryChange?: (pageId: string, relativePath: string) => void;
  onOpenToolTab?: (pageId: string, kind: 'version', label: string, version?: WorkspaceWindowSeed['version']) => void;
  onCloseToolTab?: (pageId: string, kind: 'version') => void;
};
const ProjectWorkspace = ({ pageId, onDirectoryChange, onOpenToolTab, onCloseToolTab, ...props }: ProjectWorkspaceProps) => {
  const toast = useUserFacingToast();
  const onNotice = useCallback((message: string, duration?: number) => { toast.show(message, duration); }, [toast]);
  const bridgeRef = useRef({ onDirectoryChange, onOpenToolTab, onCloseToolTab });
  bridgeRef.current = { onDirectoryChange, onOpenToolTab, onCloseToolTab };
  const browserContext = useMemo(() => ({ ...PROJECT_FILE_BROWSER_CONTEXT, title: props.project.name }), [props.project.name]);
  const handleDirectoryChange = useCallback((relativePath: string) => bridgeRef.current.onDirectoryChange?.(pageId, relativePath), [pageId]);
  const handleOpenToolTab = useCallback((kind: 'version', label: string, version?: WorkspaceWindowSeed['version']) => bridgeRef.current.onOpenToolTab?.(pageId, kind, label, version), [pageId]);
  const handleCloseToolTab = useCallback((kind: 'version') => bridgeRef.current.onCloseToolTab?.(pageId, kind), [pageId]);
  return <FileBrowserWorkspace {...props} pageId={pageId} onDirectoryChange={handleDirectoryChange} onOpenToolTab={handleOpenToolTab} onCloseToolTab={handleCloseToolTab} browserContext={browserContext} onNotice={onNotice}/>;
};

export { FileBrowserWorkspace, ProjectWorkspace };
