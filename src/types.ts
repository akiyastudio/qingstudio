import type { ToastViewAction, ToastViewApi, ToastViewPresentation, ToastViewSnapshot } from './features/app/toast-view-contract';

export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export type ToolType = 'home' | 'search-all' | 'inspiration' | 'project' | 'project-version' | 'component' | 'settings' | 'dashboard' | 'match' | 'video_split';

export type Theme = 'light' | 'dark' | 'system';
export type VideoTranscodeSettings = {
  container: 'mp4' | 'mov' | 'mkv';
  videoMode: 'h264' | 'h265' | 'av1' | 'prores' | 'copy';
  quality: 'high' | 'balanced' | 'small';
  resolution: 'original' | '2160p' | '1080p' | '720p';
  frameRate: 'original' | '24' | '25' | '30' | '50' | '60';
  audioMode: 'copy' | 'aac' | 'remove';
  subtitleMode: 'copy' | 'burn' | 'remove';
  colorMode: 'auto' | 'sdr' | 'hdr10' | 'hlg' | 'hdr-to-sdr';
  bitDepth: 'auto' | '8' | '10';
  frameRateMode: 'preserve' | 'cfr' | 'vfr';
  rotation: 'auto' | '0' | '90' | '180' | '270';
  aspectMode: 'preserve' | 'square-pixels';
  audioTrack: 'all' | 'first';
  videoBitrateMbps: number | null;
  audioBitrateKbps: 96 | 128 | 160 | 192 | 256 | 320;
  encoderPreset: 'fast' | 'balanced' | 'quality';
  retryCount: 0 | 1 | 2 | 3;
};
export type ProjectToolSource = {
  path: string;
  kind: 'file' | 'folder';
};
export type HomeCardId = 'birthday' | 'import' | 'inspiration';
export const PROJECT_TOOLBAR_ACTION_IDS = [
  'filename-selection', 'select-media', 'photoshop', 'video-tools', 'image-tools',
  'office-extract', 'version-management',
] as const;
export type ProjectToolbarActionId = typeof PROJECT_TOOLBAR_ACTION_IDS[number];
export interface ProjectToolbarSettings {
  order: ProjectToolbarActionId[];
  hidden: ProjectToolbarActionId[];
  onlyShowAvailable: boolean;
}
export type ProjectFileSortField = 'name' | 'date' | 'size';
export const BUILT_IN_PROJECT_STATUSES = ['策划中', '待拍摄', '后期中', '已归档'] as const;
export type BuiltInProjectStatus = typeof BUILT_IN_PROJECT_STATUSES[number];
/** Project status names are persisted values; built-ins are reserved and users may add more. */
export type ProjectStatus = '未分类' | BuiltInProjectStatus | (string & {});
export interface VideoPlaybackSettings {
  arrowKeyAction: 'seek' | 'navigate';
  subtitlesEnabled: boolean;
  subtitlePreferredLanguages: string[];
  subtitleSize: number;
  subtitleStyle: 'standard' | 'high-contrast';
  hdrMode: 'auto' | 'sdr' | 'hdr-passthrough' | 'tone-map';
  toneMapping: 'auto' | 'bt2390' | 'reinhard' | 'mobius' | 'hable';
  targetPeakNits: number;
  shortcuts: Record<string, string[]>;
}
export interface ResearchSettings {
  sensitivity: 'low' | 'standard' | 'high';
  minDuration: number;
  /** legacy config field */
  ssimThreshold?: number;
}
export interface InspirationLibrarySettings {
  rootPath: string;
}
export interface ComponentSettingsMap {
  /** Component-owned opaque JSON; the application never interprets component namespaces. */
  [componentId: string]: unknown;
}
export const PROJECT_STATUS_LABELS: Record<string, string> = {
  未分类: '未分类',
  策划中: '策划中',
  待拍摄: '待拍摄',
  后期中: '后期中',
  已归档: '已归档'
};
export const projectStatusLabel = (status: ProjectStatus) => PROJECT_STATUS_LABELS[status] || status;
export const normalizeProjectCategoryOrder = (value: unknown, customCategories: readonly string[] = []) => {
  const available = [...BUILT_IN_PROJECT_STATUSES, ...customCategories];
  const byKey = new Map(available.map(name => [name.toLocaleLowerCase(), name]));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const key = String(item || '').trim().toLocaleLowerCase();
    const name = byKey.get(key);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  for (const name of available) {
    const key = name.toLocaleLowerCase();
    if (!seen.has(key)) result.push(name);
  }
  return result;
};
export const DEFAULT_PROGRESS_NAME_PRESETS = ['调色后', '修脸后', '完成版'] as const;
export const normalizeProgressNamePresets = (value: unknown) => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : DEFAULT_PROGRESS_NAME_PRESETS) {
    const name = String(item || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    const invalid = [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!name || name.length > 24 || invalid || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= 50) break;
  }
  return result;
};
export const normalizeWorkspacePaths = (primary: unknown, paths: unknown) => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of [primary, ...(Array.isArray(paths) ? paths : [])]) {
    const workspacePath = String(value || '').trim();
    const key = workspacePath.toLocaleLowerCase();
    if (!workspacePath || seen.has(key)) continue;
    seen.add(key);
    result.push(workspacePath);
  }
  return result;
};
export interface ProjectDate {
  year: number;
  month: number;
  day?: number;
  precision: 'month' | 'day';
}
export interface WorkspaceProject {
  importMode?: 'copy' | 'move' | 'reference';
  ordinaryFiles?: boolean;
  id: string;
  name: string;
  path: string;
  /** Workspace root that owns this project when multiple roots are configured. */
  workspacePath?: string;
  status: ProjectStatus;
  updatedAt: number;
  projectDate?: ProjectDate;
  availability?: 'available' | 'missing';
  missingSince?: number;
  missingChecks?: number;
  archived?: boolean;
  archivePath?: string;
  archiveVerifiedAt?: number;
  archiveBytes?: number;
}
export interface WorkspaceStatusGroup { status: ProjectStatus; projects: WorkspaceProject[]; }

export interface BackupSnapshotSummary {
  id: string;
  createdAt: number;
  files: number;
  bytes: number;
  projects: number;
  projectItems?: Array<{ id: string; name: string; status: ProjectStatus; relativePath: string }>;
  reason: string;
  mode: 'history' | 'latest';
}

export interface BackupStatus {
  success: boolean;
  enabled: boolean;
  state: 'unconfigured' | 'offline' | 'never-backed-up' | 'running' | 'protected' | 'error';
  targetPath?: string;
  isNas?: boolean;
  connection?: BackupConnectionStatus;
  mode?: 'history' | 'latest';
  latestAt?: number;
  latestSnapshotId?: string;
  snapshotCount?: number;
  task?: BackgroundTask;
  snapshots: BackupSnapshotSummary[];
  error?: string;
}

export interface BackupConnectionStatus {
  connected: boolean;
  isNas: boolean;
  checkedAt?: number;
  latencyMs?: number;
  speedMBps?: number;
  totalBytes?: number;
  freeBytes?: number;
  error?: string;
}

export interface BackupSpaceStatus {
  success: boolean;
  targetPath?: string;
  snapshotCount?: number;
  workspaceSnapshotCount?: number;
  objectCount?: number;
  logicalBytes?: number;
  actualBytes?: number;
  referencedBytes?: number;
  deduplicatedBytes?: number;
  currentBytes?: number;
  historyBytes?: number;
  internalBytes?: number;
  reclaimableBytes?: number;
  expiredSnapshotCount?: number;
  estimatedReclaimableBytes?: number;
  totalBytes?: number;
  freeBytes?: number;
  error?: string;
}

export interface StorageUsageItem {
  kind: 'workspace' | 'inspiration' | 'archive' | 'backup' | 'cache' | 'internal';
  label: string;
  path: string;
  bytes: number;
  measured: boolean;
}

export interface StorageVolumeUsage {
  id: string;
  label: string;
  root: string;
  online: boolean;
  totalBytes?: number;
  freeBytes?: number;
  photoflowBytes: number;
  otherBytes: number;
  items: StorageUsageItem[];
}

export interface StorageUsageOverview {
  success: boolean;
  updatedAt: number;
  scanning: boolean;
  stale: boolean;
  volumes: StorageVolumeUsage[];
  error?: string;
}

export interface AppConfig {
  theme: Theme;
  telemetry: {
    enabled: boolean;
    crashReports: boolean;
  };
  workspacePath: string;
  /** All project roots; workspacePath is the default write destination. */
  workspacePaths: string[];
  autoCleanupDeletedProjectData: boolean;
  createPlanningFolder: boolean;
  customProjectCategories: string[];
  projectCategoryOrder: string[];
  progressNamePresets: string[];
  defaultFolderSort: ProjectFileSortField;
  itemOpenMode: 'single' | 'double';
  folderAlphabetFilterEnabled: boolean;
  versionTreeEnabled: boolean;
  favoriteDisplayMode: 'stars' | 'binary';
  usagePreferencesVersion: number;
  projectToolbar: ProjectToolbarSettings;
  homeOrder: HomeCardId[];
  birthdayEnabled: boolean;
  pinInspirationLibrary: boolean;
  componentSettings: ComponentSettingsMap;
  /** Host-owned optimistic concurrency revisions for opaque component settings. */
  componentSettingsRevisions: Record<string, number>;
  /** Built-in controls for the native video player. */
  videoPlayback: VideoPlaybackSettings;
  mediaCache: {
    maxSizeGB: number;
    directory: string;
    autoCleanup30Days: boolean;
  };
  backup: {
    enabled: boolean;
    targetType: 'local' | 'nas';
    targetPath: string;
    mode: 'history' | 'latest';
    automaticDaily: boolean;
    afterImport: boolean;
    retention: {
      daily: number;
      weekly: number;
      monthly: number;
    };
    nas: {
      credentialRef: string;
      limitEnabled: boolean;
      bandwidthLimitMBps: number;
      limitStart: string;
      limitEnd: string;
    };
  };
  archive: {
    enabled: boolean;
    targetPath: string;
  };
  importDefaults: {
    deleteSourceAfterImport: boolean;
    generateJpgFromRaw: boolean;
    splitVideosOnImport: boolean;
    transcodeVideosOnImport: boolean;
  };
  videoTools: {
    transcode: VideoTranscodeSettings;
    trim: {
      exportMode: 'fast' | 'exact';
    };
  };
  smartImport: {
    autoStart: boolean;
    autoMoveProjectAfterSdImport: boolean;
    sdPath: string;
    sdPaths: string[];
    sdDriveTypes: Record<string, 'work' | 'broll'>;
    sdDriveVideoActions: Record<string, {
      splitVideosOnImport: boolean;
      transcodeVideosOnImport: boolean;
    }>;
    sdDeviceIds: Record<string, string>;
    sdDevices: ConfiguredSdDevice[];
    destPath: string;
    backupEnabled: boolean;
    backupPath: string;
    generateVideoPreview: boolean;
    videoPreviewQuality: 'medium' | 'high';
    splitLargeFiles: boolean;
    dateFilter: 'all' | 'today' | 'today_yesterday';
  };
  brollImport: {
    splitVideosOnImport: boolean;
    transcodeVideosOnImport: boolean;
    /** legacy config field */
    splitLargeFiles?: boolean;
  };
  inspirationLibrary: InspirationLibrarySettings;
  smartMatch: {
    imageDestFolderName: string;
    videoDestFolderName: string;
    sourceFolderRelativePath?: string;
    imageSourceFolderName?: string;
    videoSourceFolderName?: string;
    /** legacy config field */
    destFolderName?: string;
  };
  /** Built-in storyboard analysis settings. */
  research: ResearchSettings;
}

export interface ConfiguredSdDevice {
  deviceId: string;
  lastMountPath: string;
  type: 'work' | 'broll';
  splitVideosOnImport: boolean;
  transcodeVideosOnImport: boolean;
  confirmedAt: number;
  enabled: boolean;
}

export interface StorageDevice {
  id: string;
  aliases?: string[];
  mountPath: string;
  label: string;
  removable: boolean;
  driveType: number;
  identityStable: boolean;
  hasSupportedMedia: boolean;
  eligibleForSdImport: boolean;
}

export interface StorageDeviceInventoryResult {
  devices: StorageDevice[];
  complete: boolean;
  deviceErrors?: Array<{ mountPath: string; error: string }>;
  warning?: string;
  error?: string;
}

export interface PrivacyConsentState {
  privacyNoticeVersion: string;
  privacyNoticeAcceptedAt: string;
  termsVersion: string;
  termsAcceptedAt: string;
  faceRulesVersion: string;
  faceRecognitionGrantedAt: string;
  faceRecognitionGranted: boolean;
  experienceProgramGranted: boolean;
  currentPrivacyNoticeVersion: string;
  currentTermsVersion: string;
  currentFaceRulesVersion: string;
}

export type LegalDocumentId = 'privacy' | 'terms' | 'face' | 'information-list' | 'third-parties' | 'permissions' | 'children' | 'customer-data' | 'open-source';

export interface ProjectFileEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: 'folder' | 'image' | 'video' | 'raw' | 'shortcut' | 'file';
  extension: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  previewUrl?: string;
  /** Rating stored in the media file's XMP metadata. */
  rating?: number;
  /** Entry discovered by following a folder shortcut in recursive mode. */
  viaShortcut?: boolean;
  /** Known channel that created an ordinary shortcut. */
  sourceChannel?: 'inspiration';
  /** External shortcut previews never grant mutation capabilities. */
  readOnly?: boolean;
  shortcutTargetKind?: 'folder' | 'file';
  shortcutBroken?: boolean;
  /** Project-root-relative parent directory, supplied by recursive enumeration. */
  parentRelativePath?: string;
  parentName?: string;
}

export interface ProjectFileListFilter {
  query?: string;
  kinds?: Array<'file' | 'image' | 'raw' | 'video' | 'shortcut'>;
  extensions?: string[];
}

export type ProjectFilterScope = 'current-folder' | 'project-root';

export interface ProjectFileListResult {
  success: boolean;
  scope?: string;
  entries: ProjectFileEntry[];
  cursor?: string;
  hasMore?: boolean;
  truncated?: boolean;
  scannedDirectories?: number;
  inspectedEntries?: number;
  error?: string;
  errorCode?: 'FILE_LIST_SESSION_EXPIRED' | 'FILE_LIST_CANCELLED';
}

export interface ShellNewFileType {
  id: string;
  extension: string;
  label: string;
  method: 'null' | 'data' | 'template';
  iconDataUrl?: string;
}

export type ThumbnailState = 'NOT_READY' | 'QUEUED' | 'GENERATING' | 'READY' | 'STALE' | 'FAILED' | 'MISSING';

export interface MediaMetadataField {
  group: string;
  name: string;
  value: string;
}

export interface TrackedPhoto {
  id: string;
  projectId: string;
  mediaType: 'image' | 'video';
  originalName: string;
  displayName: string;
  currentVersionId: string;
  originalFilePath: string;
  captureTime?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MediaVersion {
  id: string;
  photoId: string;
  parentVersionId?: string;
  versionNumber: number;
  displayVersionKey?: string;
  versionName: string;
  versionType: 'original' | 'first' | 'second' | 'third' | 'primary' | 'secondary' | 'custom' | string;
  filePath: string;
  fileSize: number;
  fileModifiedAt?: number;
  thumbnailPath?: string;
  author?: string;
  note: string;
  status: string;
  isCurrent: boolean;
  isFinal: boolean;
  fileMissing: boolean;
  contentChanged: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MediaVersionBundle {
  success: boolean;
  photo?: TrackedPhoto;
  versions: MediaVersion[];
  nextVersionNumber?: number;
  cancelled?: boolean;
  warning?: string;
  error?: string;
}

export interface VersionBatch {
  id: string;
  projectId: string;
  sequence: number;
  displayName: string;
  sourceFolderPath: string;
  parentBatchId?: string;
  parentSequence?: number;
  status: 'importing' | 'applying' | 'ready' | 'needs_repair' | 'failed' | string;
  itemCount: number;
  matchedCount: number;
  newCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProgressFolder {
  id: string;
  projectId: string;
  mediaKind: 'image' | 'video' | 'mixed';
  versionKey: string;
  parentProgressId?: string;
  parentVersionKey?: string;
  displayName: string;
  folderPath: string;
  folderId: string;
  folderMissing: boolean;
  missingSince?: number;
  nodeRole: 'original' | 'progress' | 'selection' | 'artifact' | 'workflow' | 'broll';
  artifactKind?: string;
  /** Generic source semantics supplied by the version producer or component. */
  sourceMetadata?: VersionSourceMetadata;
  relationKind?: 'main' | 'auxiliary';
  trackingEnabled: boolean;
  renameFromParent: boolean;
  copyMissingFromParent: boolean;
  trackingState: 'disabled' | 'pending_compare' | 'pending_confirm' | 'committing' | 'ready' | 'stale' | 'needs_repair';
  lastTrackedAt?: number;
  trackingSnapshot: Record<string, unknown> | unknown[];
  folderSignature?: string;
  tombstone: Record<string, unknown>;
  repairBatchId?: string;
  pendingOperationCount?: number;
  createdAt: number;
  updatedAt: number;
}

export type ComponentDataDomainId = 'media' | 'versioning' | 'operations' | `component:${string}` | (string & {});

export interface VersionSourceMetadata {
  category: 'original' | 'progress' | 'selection' | 'artifact' | 'workflow' | 'supplemental' | string;
  role?: 'primary' | 'companion' | 'preview' | 'component-workspace' | string;
  displayName?: string;
  componentId?: string;
  parentCapability?: 'structural' | 'workflow-input' | 'none';
}

export interface MediaWorkflowImportManifest {
  schemaVersion: 2;
  projectName: string;
  importSessionId: string;
  artifacts: Array<{
    relativePath: string;
    mediaKind: 'image' | 'video';
    importSlot: 'raw' | 'camera_jpg' | 'generated_jpg' | 'mov' | 'video_transcode';
    displayName: string;
  }>;
}

export interface VersionGraphEdge {
  id: string;
  projectId: string;
  sourceProgressId: string;
  targetProgressId: string;
  edgeKind: 'media_companion' | 'derived_preview' | 'derived_transcode' | 'workflow_input';
  createdAt: number;
  updatedAt: number;
}

export interface LegacySelectionRelationRepair {
  progressId: string;
  projectId: string;
  legacyName: string;
  expectedSourceName: string;
  reason: 'source_missing' | 'source_ambiguous' | 'selection_already_exists';
  candidateIds: string[];
}

export interface VersionTreeLayoutPosition {
  nodeKey: string;
  x: number;
  y: number;
  updatedAt?: number;
}

export interface VersionTreeLayoutResult {
  success: boolean;
  scopeKey?: string;
  revision: number;
  updatedAt?: number;
  positions: VersionTreeLayoutPosition[];
  error?: string;
}

export type TrackingConfirmationItemStatus = 'recognized' | 'pending_confirmation' | 'accepted' | 'missing_reference' | 'rejected';
export type TrackingConfirmationStatus = TrackingConfirmationItemStatus;

export interface TrackingConfirmationItem {
  id: string;
  kind: 'recognized' | 'new' | 'copy_missing' | 'missing';
  sourceName?: string;
  referenceName?: string;
  targetName?: string;
  status: TrackingConfirmationItemStatus;
  distance?: number;
  confidence?: string;
}

export type ProgressTrackingItem = TrackingConfirmationItem;

export interface ProgressTrackingSession {
  id: string;
  progressId: string;
  parentProgressId: string;
  mode: 'compare' | 'refresh';
  status: 'comparing' | 'pending_confirm' | 'committing' | 'committed' | 'failed' | 'cancelled';
  renameFromParent: boolean;
  copyMissingFromParent: boolean;
  committedBatchId?: string;
  error: string;
  total: number;
  unresolvedCount: number;
}

export interface ProgressTrackingSessionResult {
  success: boolean;
  session?: ProgressTrackingSession;
  items: ProgressTrackingItem[];
  nextCursor?: number | null;
  error?: string;
}

export interface MainBranchMediaEntry {
  branchIndex: number;
  progressId: string;
  parentProgressId?: string;
  nodeRole: 'original' | 'progress';
  relationKind?: 'main';
  photoId: string;
  originalName: string;
  version: MediaVersion;
}

export interface SelectionPreflightResult {
  success: boolean;
  operationId?: string;
  cancelled?: boolean;
  sourceFolderRelativePath?: string;
  targetFolderRelativePath?: string;
  outputFolderName?: string;
  matchedCount?: number;
  filesToCopy?: number;
  existingCount?: number;
  conflictCount?: number;
  missingCount?: number;
  unsupportedCount?: number;
  imageCount?: number;
  videoCount?: number;
  totalBytes?: number;
  existingPaths?: string[];
  conflictPaths?: string[];
  missingKeywords?: string[];
  unsupportedPaths?: string[];
  items?: Array<{
    sourceRelativePath: string;
    destinationRelativePath?: string;
    mediaKind?: 'image' | 'video';
    status: 'planned' | 'copied' | 'skipped_existing' | 'destination_collision' | 'unsupported';
  }>;
  signature?: string;
  error?: string;
}

export interface SelectionExecutionResult extends SelectionPreflightResult {
  operationId?: string;
  taskNotificationOwned?: boolean;
  copiedCount?: number;
  cancelled?: boolean;
  sourceProgressId?: string;
  selectionProgressId?: string;
  selectionNode?: ProgressFolder;
}

export interface VersionBatchFileOperation {
  id: string;
  batchId: string;
  operationType: 'rename' | 'copy';
  sourcePath: string;
  targetPath: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  attemptCount: number;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export interface ComponentStatus {
  id: string;
  name: string;
  description: string;
  capability: string;
  /** Manifest-declared runtime capabilities; component identity is not a feature contract. */
  capabilities?: string[];
  installed: boolean;
  /** False when the installed component is intentionally disabled by the user. */
  enabled?: boolean;
  compatible: boolean;
  version: string;
  path: string;
  source: 'user' | 'development' | 'missing' | string;
  sizeBytes: number;
  error?: string;
  status?: 'pending-install' | 'installed' | 'disabled' | 'update-available' | 'incompatible' | 'invalid' | 'integrity-invalid' | 'package-invalid' | string;
  integrityStatus?: 'verified' | 'pinned-unverified' | 'unsigned' | 'invalid' | string;
  integrityMessage?: string;
  packageVersion?: string;
  packageSizeBytes?: number;
  packageCompatible?: boolean;
  packageError?: string;
  updateAvailable?: boolean;
  runtimeAvailable?: boolean;
  provider?: string;
  runtimeError?: string;
  packagePath?: string;
  packageInspectionStatus?: 'manifest-bounded' | 'fully-verified' | string;
}

export interface ComponentInstallRequest {
  componentId: string;
}

export interface ComponentHostAction {
  componentId: string;
  componentVersion: string;
  contractVersion: 1 | 2;
  actionId: string;
  label: string;
  pageId: string;
  pageTitle: string;
  development?: boolean;
  /** Host-issued URL for a validated package-local icon. */
  iconUrl?: string;
}

export type ComponentSettingsValue = string | number | boolean;
export interface ComponentSettingsFormOption { value: string; label: string; description?: string }
export type ComponentSettingsFormField =
  | { id: string; type: 'toggle'; label: string; description?: string; default: boolean }
  | { id: string; type: 'select'; label: string; description?: string; default: string; options: ComponentSettingsFormOption[] }
  | { id: string; type: 'text'; label: string; description?: string; default: string; placeholder?: string; maxLength: number }
  | { id: string; type: 'number' | 'range'; label: string; description?: string; default: number; min: number; max: number; step: number; suffix?: string };
export interface ComponentSettingsFormGroup { id: string; title: string; description?: string; fields: ComponentSettingsFormField[] }
export interface ComponentSettingsForm { help?: Array<{ title: string; description: string }>; schemaVersion: 1; groups: ComponentSettingsFormGroup[]; preferenceScope?: 'videoPlayback'; notices?: Array<{ title: string; description: string; license: string; sourceUrl: string; licenseUrl: string }> }
export type ComponentSettingsPageContribution = {
  componentId: string;
  componentVersion: string;
  contractVersion: 2;
  pageId: string;
  label: string;
  pageTitle: string;
  development?: boolean;
  iconUrl?: string;
} & ({ renderMode: 'custom'; form?: never; customPageTitle?: never } | { renderMode: 'declarative'; form: ComponentSettingsForm; customPageTitle?: never } | { renderMode: 'hybrid'; form: ComponentSettingsForm; customPageTitle: string });

export interface ComponentPageOpenScope {
  /** Folder visible when the toolbar action was invoked. */
  scopeRelativePath: string;
  /** Complete safe project selection supplied by the Host; an empty list means restore component history only. */
  selectedRelativePaths: string[];
  /** Owning browser page used for auditable reopen context. */
  sourcePageId: string;
  /** Host-validated content boundary used by project-like file browsers. */
  contentKind?: 'project' | 'inspiration';
}
export type ComponentContributionType = 'component.sidePanel' | 'media.contextAction' | 'project.contextAction' | 'project.importProvider' | 'project.exportProvider' | 'application.command';
export interface ComponentContribution { componentId: string; componentVersion: string; contributionId: string; type: ComponentContributionType; label: string; title: string; description?: string; pageId: string; rpcMethods: string[]; /** folderPanel is limited to component.sidePanel. */ placement?: 'workspace.videoTools' | 'workspace.folderPanel'; iconUrl?: string }

export interface ComponentPageInstance {
  identity: string;
  componentId: string;
  componentVersion: string;
  pageId: string;
  title: string;
  workspacePath: string;
  projectId: string;
  projectName: string;
  instanceId: string;
  /** Stable titlebar id that this tab was first inserted after. */
  insertAfterTabId: string;
  iconUrl?: string;
}

export interface VideoPlayerState {
  sessionId: string;
  playerId: string;
  requestId: string;
  type: 'ready' | 'loading' | 'file-loaded' | 'state' | 'subtitle-tracks' | 'audio-tracks' | 'statistics' | 'display-output' | 'diagnostic' | 'ended' | 'input' | 'navigate' | 'context-menu' | 'pointer-activity' | 'escape' | 'stopped' | 'error' | 'fatal';
  time?: number;
  duration?: number;
  paused?: boolean;
  buffering?: boolean;
  muted?: boolean;
  volume?: number;
  speed?: number;
  width?: number;
  height?: number;
  direction?: -1 | 1;
  x?: number;
  y?: number;
  error?: string;
  errorCode?: PlaybackErrorCode;
  attempts?: PlaybackAttempt[];
  suggestedFallback?: 'chromium' | 'component' | 'system-player' | 'none';
  subtitleTracks?: VideoSubtitleTrack[];
  subtitleTrackId?: string | null;
  subtitleVisible?: boolean;
  subtitleDelay?: number;
  audioTracks?: VideoAudioTrack[];
  audioTrackId?: string | null;
  input?: {
    kind: 'pointer-button' | 'key' | 'pointer-move';
    button?: 'left' | 'right';
    key?: string;
    code?: string;
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
    meta?: boolean;
    repeat?: boolean;
    clickCount?: number;
    x?: number;
    y?: number;
  };
  statistics?: VideoPlaybackStatistics;
  display?: { displayId: string; scaleFactor: number; colorSpace: string; hdrAvailable: boolean; reason: string; bounds: { x: number; y: number; width: number; height: number } | null };
  diagnostic?: { code: string; severity: 'debug' | 'info' | 'warning' | 'error'; phase?: string; backendId?: string; backendVersion?: string; protocolVersion?: number; exitCode?: number; message?: string; recoverable?: boolean };
}

export interface VideoPlaybackStatistics { level: 'basic' | 'detailed'; container?: string; videoCodec?: string; audioCodec?: string; decoder?: string; hardwareDecoder?: string; hardwareDecoding?: boolean; pixelFormat?: string; bitDepth?: number; colorPrimaries?: string; transfer?: string; colorMatrix?: string; hdrFormat?: string; sourceFps?: number; displayFps?: number; droppedFrames?: number; delayedFrames?: number; avSyncMs?: number; cacheSeconds?: number; cacheBytes?: number; gpuApi?: string; gpuAdapter?: string; renderer?: string; toneMapping?: string }

export interface VideoPlaybackBackendDescriptor {
  backendId: string;
  protocolVersion: 1;
  transport: 'chromium' | 'media-playback-backend-v1';
  displayName: string;
  backendVersion: string;
  priority: number;
  probe: {
    support: 'probably' | 'maybe' | 'unknown';
    basis: string;
    containers: string[];
    codecs: { video: string[]; audio: string[] };
    extensions: string[];
  };
  features: {
    transforms: { aspectModes: Array<'source' | 'contain' | 'cover' | '16:9' | '4:3' | '1:1'>; rotation: boolean; flip: boolean; crop: boolean };
    hdr: { passthrough: boolean; toneMapping: boolean; algorithms: Array<'auto' | 'bt2390' | 'reinhard' | 'mobius' | 'hable'>; targetPeakControl: boolean };
    statistics: { basic: boolean; decode: boolean; hdr: boolean; timing: boolean; cache: boolean; gpu: boolean; maxUpdateHz: number };
    subtitles: { embedded: boolean; external: boolean; ass: boolean; styles: boolean };
    hardwareDecoding: { supported: boolean; selectable: boolean; softwareFallback: boolean };
    capture: { sourceFrame: boolean; displayedFrame: boolean };
  };
}

/** Legacy type alias for the compatibility IPC surface. */
export type AdvancedVideoState = VideoPlayerState;

export interface VideoSubtitleTrack {
  id: string;
  stableId: string;
  source: 'embedded' | 'external';
  language?: string;
  title?: string;
  format?: string;
  path?: string;
  selected: boolean;
}
export interface VideoAudioTrack { id: string; stableId: string; language?: string; title?: string; codec?: string; channels?: number; sampleRate?: number; selected: boolean }

export interface ProjectFileOperationProgress {
  operationId: string;
  projectName?: string;
  operation: 'paste' | 'import' | 'import-project' | 'trash' | 'import-broll' | 'import-files' | 'import-progress' | 'import-sd' | 'import-negative';
  phase: 'scanning' | 'moving' | 'copying' | 'splitting' | 'finishing' | 'trashing' | 'complete' | 'cancelled' | 'failed';
  progress: number;
  currentName?: string;
  bytesCopied?: number;
  totalBytes?: number;
  filesCopied?: number;
  totalFiles?: number;
  processedCount?: number;
  totalCount?: number;
  count?: number;
  error?: string;
}

export interface BackgroundTask {
  id: string;
  type: string;
  title: string;
  state: 'queued' | 'running' | 'pausing' | 'paused' | 'interrupted' | 'resuming' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  cancellable: boolean;
  retryable: boolean;
  resumable: boolean;
  resumeAvailable: boolean;
  restartAvailable: boolean;
  capabilities: {
    cancellable: boolean;
    pausable: boolean;
    resumable: boolean;
    retryable: boolean;
  };
  resumePolicy: 'checkpoint' | 'safe-restart' | 'atomic';
  notificationPolicy: 'progress-toast' | 'progress-and-result' | 'result-only' | 'error-only' | 'silent';
  taskCenterPolicy: 'always' | 'attention-only' | 'hidden';
  historyPolicy: 'persistent' | 'ephemeral';
  retryOfTaskId?: string | null;
  replacedByTaskId?: string | null;
  retryAttempt: number;
  retryPending: boolean;
  checkpointVersion?: number;
  checkpoint?: unknown;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  finishedAt: number;
  /** Active tasks whose resource reservations currently block this queued task. */
  blockedByTaskIds?: string[];
  error?: string;
}

export interface BackgroundTaskDelta {
  revision: number;
  upserts: BackgroundTask[];
  removeIds: string[];
}

export interface AppUpdateInfo {
  version: string;
  url: string;
  notes: string;
  mandatory: boolean;
}

export interface OfficeImageExtractionItem {
  document: string;
  documentName: string;
  success: boolean;
  count: number;
  totalBytes?: number;
  outputFolder?: string;
  files?: string[];
  message?: string;
  error?: string;
  publishSuccess?: boolean;
  publishError?: string;
}

export interface OfficeImageExtractionResult {
  success: boolean;
  documentCount?: number;
  successfulCount?: number;
  failedCount?: number;
  imageCount?: number;
  requestedCount?: number;
  acceptedCount?: number;
  skippedCount?: number;
  results: OfficeImageExtractionItem[];
  error?: string;
  warning?: string;
}

export interface WorkspaceRecoveryDescriptor {
  label?: string;
  error?: string;
  code?: string;
  errorCode?: string;
  recoveryPath?: string;
  outcomeUnknown?: boolean;
  published?: boolean;
  originalMissing?: boolean;
  sourceRetained?: boolean;
  cleanupWarning?: string | boolean;
  recoveryRequired?: boolean;
  partial?: boolean;
  identityVerified?: boolean;
  deleted?: boolean;
  rollbackPending?: boolean;
  nativeError?: number | string;
  transferStage?: string;
  stagingExists?: boolean;
  targetExists?: boolean;
  recoveryAvailable?: boolean;
  attemptedStagingPath?: string;
  publicationState?: 'not-started' | 'not-published' | 'published' | 'unknown' | 'outcome-unknown';
  publishedConfirmed?: boolean;
  phase?: string;
}

export interface UndoLastRenameResult extends WorkspaceRecoveryDescriptor {
  success: boolean;
  message?: string;
  project?: WorkspaceProject;
  requiresDecision?: { kind: 'restore-conflict'; decisionToken: string; names: string[]; conflictCount: number; message: string; detail: string };
  recoveries?: WorkspaceRecoveryDescriptor[];
  rollbackRecovery?: WorkspaceRecoveryDescriptor;
}

export interface IElectronAPI {
  readonly apiContractVersion: number;
  readonly workspaceWindows?: import('./contracts/workspace-windows').WorkspaceWindowsAPI;
  onConfigChanged?: (callback: (config: AppConfig) => void) => () => void;
  onPythonEvent: any;
  runScript: (scriptName: string, args?: string[], requestId?: string, presentation?: { ownerPageId: string; panelKind: string; title?: string }) => void;
  cancelPythonTask: (requestId: string) => Promise<{ success: boolean; error?: string }>;
  controlPythonTask: (requestId: string, action: 'pause' | 'resume') => Promise<{ success: boolean; error?: string }>;
  getBirthdays: () => Promise<Record<string, string>>;
  saveBirthdays: (data: Record<string, string>) => Promise<{success: boolean, error?: string}>;
  loadConfig: () => Promise<AppConfig | null>;
  loadStartupSnapshot?: () => Promise<{ config: AppConfig | null; birthdays: Record<string, string> }>;
  saveConfig: (config: AppConfig) => Promise<{success: boolean, savedConfig?: AppConfig, error?: string}>;
  getPrivacyConsentState: () => Promise<PrivacyConsentState>;
  savePrivacyConsent: (request: { acceptCore?: boolean; revokeCore?: boolean; experienceProgramGranted?: boolean; faceRecognitionGranted?: boolean }) => Promise<{ success: boolean; state?: PrivacyConsentState; error?: string }>;
  openLegalDocument: (documentId: LegalDocumentId) => Promise<{ success: boolean; path?: string; error?: string }>;
  clearTelemetryLocalData: () => Promise<{ success: boolean; error?: string }>;
  getUserPath: () => Promise<string>;
  onUpdateAvailable: (callback: (info: AppUpdateInfo) => void) => () => void;
  openExternal: (url: string) => void;
  checkForUpdates: () => Promise<{ success: boolean; updateAvailable?: boolean; currentVersion?: string; latestVersion?: string; url?: string; notes?: string; sha256?: string; mandatory?: boolean; error?: string }>;
  submitFeedback: (message: string) => Promise<{ success: boolean; error?: string }>;
  getComponents: (force?: boolean) => Promise<{ success: boolean; components: ComponentStatus[]; installPath: string; error?: string }>;
  getComponentHostActions: () => Promise<{ success: boolean; actions: ComponentHostAction[]; error?: string }>;
  getComponentSettingsPages: () => Promise<{ success: boolean; pages: ComponentSettingsPageContribution[]; error?: string }>;
  readComponentSettingsForm: (request: { componentId: string; pageId: string }) => Promise<{ success: boolean; revision?: number; values?: Record<string, ComponentSettingsValue>; error?: string }>;
  updateComponentSettingsForm: (request: { componentId: string; pageId: string; patch: Record<string, ComponentSettingsValue> }) => Promise<{ success: boolean; revision?: number; values?: Record<string, ComponentSettingsValue>; error?: string }>;
  getComponentContributions: () => Promise<{ success: boolean; contributions: ComponentContribution[]; error?: string }>;
  onComponentPanelInfoChanged: (callback: (value: { instanceId: string; info: { title: string; subtitle: string } }) => void) => () => void;
  publishComponentPreview: (request: { context: import('./contracts/component-preview').PreviewPageContext; update: { sequence: number; video: import('./contracts/component-preview').PreviewVideo | null; closed?: true } }) => Promise<{ accepted: boolean }>;
  getPreviewDecoders: () => Promise<import('./contracts/component-preview').PreviewDecoder[]>;
  decodeComponentPreview: (request: import('./contracts/component-preview').PreviewDecodeRequest) => Promise<import('./contracts/component-preview').PreviewDecodeResult>;
  onComponentPreviewSeek: (callback: (value: import('./contracts/component-preview').PreviewSeekCommand) => void) => () => void;
  acknowledgeComponentPreviewSeek: (result: { requestId: string; accepted: boolean }) => void;
  openComponentPage: (request: { componentId: string; pageId: string; workspacePath: string; projectId: string; projectName: string; projectStatus: ProjectStatus; scopeRelativePath?: string; selectedRelativePaths?: string[]; sourcePageId?: string; contentKind?: 'project' | 'inspiration' }) => Promise<{ success: boolean; page?: { instanceId: string; componentId: string; pageId: string; pageTitle: string }; error?: string }>;
  openComponentSettingsPage: (request: { componentId: string; pageId: string; leaseId: string }) => Promise<{ success: boolean; page?: { instanceId: string; componentId: string; pageId: string; pageTitle: string; surface: 'application.settings'; leaseId: string }; error?: string }>;
  openComponentContribution: (request: { componentId: string; contributionId: string; type: ComponentContributionType; workspacePath?: string; projectId?: string; projectName?: string; projectStatus?: ProjectStatus; scopeRelativePath?: string; selectedRelativePaths?: string[]; sourcePageId?: string; contentKind?: 'project' | 'inspiration' }) => Promise<{ success: boolean; page?: { instanceId: string; componentId: string; pageId: string; pageTitle: string; surface: ComponentContributionType; contentHeight?: number; panelInfo?: { title: string; subtitle: string } }; error?: string }>;
  onComponentPanelCloseRequested: (callback: (instanceId: string) => void) => () => void;
  onComponentPanelContentSizeChanged: (callback: (value: { instanceId: string; width: number; height: number }) => void) => () => void;
  onComponentProjectDirectoryOpenRequested: (callback: (request: { workspacePath: string; projectId: string; projectName: string; projectStatus: ProjectStatus; relativePath: string }) => void) => () => void;
  releaseComponentSettingsPage: (request: { componentId: string; pageId: string; leaseId: string }) => Promise<{ success: boolean }>;
  activateComponentPage: (request: { instanceId: string; deactivateIfActive?: true }) => Promise<{ success: boolean }>;
  setHostSurfaceSuspended: (update: { rendererToken: string; revision: number; suspended: boolean }) => Promise<{ success: boolean }>;
  updateToastView: (snapshot: ToastViewSnapshot) => Promise<{ success: boolean }>;
  onToastViewAction: (callback: (action: ToastViewAction) => void) => () => void;
  onToastViewPresentation: (callback: (presentation: ToastViewPresentation) => void) => () => void;
  setComponentNotificationReady: (update: { rendererToken: string; revision: number; ready: boolean }) => Promise<{ ready: boolean; flushed: number; stale?: boolean }>;
  setComponentPageBounds: (instanceId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean }>;
  closeComponentPage: (instanceId: string) => Promise<{ success: boolean }>;
  closeProjectComponentPages: (workspacePath: string, projectId: string) => Promise<{ success: boolean; closedCount: number }>;
  onComponentsStatusChanged: (callback: (result: { success: boolean; components: ComponentStatus[]; installPath: string; error?: string }) => void) => () => void;
  openComponentsFolder: (componentId?: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  openLogsFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
  clearLogs: () => Promise<{ success: boolean; deletedCount?: number; error?: string }>;
  clearInterfaceCache: () => Promise<{ success: boolean; clearedBytes?: number; error?: string }>;
  getCursorScreenPoint: () => Promise<{ x: number; y: number }>;
  installComponent: (request: ComponentInstallRequest, confirm: (presentation: { title: string; message: string; detail: string }) => Promise<boolean>) => Promise<{ success: boolean; cancelled?: boolean; recovered?: boolean; packageSizeBytes?: number; operationId?: string; cleanupPending?: boolean; outcomeUnknown?: boolean; error?: string }>;
  setComponentEnabled: (componentId: string, enabled: boolean) => Promise<{ success: boolean; enabled?: boolean; cancelled?: boolean; error?: string }>;
  deleteComponentPackage: (kind: 'component' | 'advanced', componentId?: string) => Promise<{ success: boolean; deletedBytes?: number; error?: string }>;
  uninstallComponent: (componentId: string, options: { clearUserData: boolean }) => Promise<{ success: boolean; cancelled?: boolean; recovered?: boolean; dataCleared?: boolean; cleanupWarnings?: string[]; operationId?: string; cleanupPending?: boolean; outcomeUnknown?: boolean; error?: string }>;
  getStorageDevices: () => Promise<StorageDeviceInventoryResult>;
  getDomainHealth: () => Promise<{ success: boolean; domains: Array<{ domainId: string; componentId?: string; displayName?: string; state: 'healthy' | 'degraded' | 'unavailable' | 'recovering'; failures: number; lastError: string; updatedAt: number }>; commands: Array<{ commandId: string; target: string; type: string; status: 'pending' | 'processing' | 'dead'; attempts: number; error: string }> }>;
  retryDomainCommand: (commandId: string) => Promise<{ success: boolean; error?: string }>;
  getDrives: () => Promise<string[]>;
  setTheme: (theme: Theme) => Promise<void>;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => void;
  getApplicationQuitState: () => Promise<ApplicationQuitState>;
  respondToApplicationQuit: (requestId: string, confirmed: boolean, error?: string) => Promise<{ accepted: boolean }>;
  onAppConfirmation: (callback: (options: { requestId: string; title: string; message: string; detail?: string; confirmLabel?: string; cancelDefault?: boolean }) => Promise<boolean>) => () => void;
  onAppConfirmationClosed: (callback: (requestId: string) => void) => () => void;
  onApplicationQuitState: (callback: (state: ApplicationQuitState) => void) => () => void;
  isWindowMaximized: () => Promise<boolean>;
  setWindowFullscreen: (enabled: boolean) => Promise<boolean>;
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  getWorkspaceProjects: (workspacePath: string) => Promise<{ success: boolean; root?: string; statuses: WorkspaceStatusGroup[]; error?: string }> ;
  onWorkspaceFilesChanged: (callback: (change: { root: string; fileName: string; eventType?: 'rename' | 'change'; reconciled?: boolean; watcherFailed?: boolean }) => void) => () => void;
  onWorkspaceProjectsChanged: (callback: (change: { root: string }) => void) => () => void;
  createWorkspaceProject: (workspacePath: string, date: ProjectDate | null, name: string, options?: { createPlanningFolder?: boolean; workspacePaths?: string[] }) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  chooseExistingProject: () => Promise<{ success: boolean; cancelled?: boolean; sourcePath?: string; inspectionToken?: string; name?: string; fileCount?: number; folderCount?: number; totalBytes?: number; truncated?: boolean; error?: string }>;
  inspectExistingProject: (sourcePath: string) => Promise<{ success: boolean; sourcePath?: string; inspectionToken?: string; name?: string; fileCount?: number; folderCount?: number; totalBytes?: number; truncated?: boolean; error?: string }>;
  importExistingProject: (workspacePath: string, sourcePath: string, options: { name: string; mode: 'copy' | 'move' | 'reference'; operationId?: string; inspectionToken?: string; workspacePaths?: string[] }) => Promise<{ success: boolean; cancelled?: boolean; operationId?: string; project?: WorkspaceProject; sourceRetained?: boolean; error?: string }>;
  renameWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, date: ProjectDate | null, nextName: string) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  renameProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, nextName: string) => Promise<{ success: boolean; folder?: { name: string; path: string; updatedAt: number }; error?: string }> ;
  createProjectFolder: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, relativePath?: string, makeUnique?: boolean) => Promise<{ success: boolean; folder?: { name: string; path: string; relativePath?: string; updatedAt: number }; error?: string }> ;
  getShellNewFileTypes: (refresh?: boolean) => Promise<{ success: boolean; types: ShellNewFileType[]; error?: string }>;
  onShellNewFileTypesChanged: (callback: (types: ShellNewFileType[]) => void) => () => void;
  createProjectShellNewFile: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string, typeId: string) => Promise<{ success: boolean; file?: { name: string; path: string; relativePath: string; extension: string; updatedAt: number }; error?: string }>;
  undoLastRename: (workspacePath?: string, options?: { restoreConflictPolicy?: 'rename' | 'overwrite'; decisionToken?: string }) => Promise<UndoLastRenameResult>;
  moveWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, nextStatus: ProjectStatus) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }> ;
  finalizeSdImportedProjects: (workspacePath: string, projectNames: string[], options: { moveProjectAfterImport: boolean; workProjectNames: string[]; importedPathsByProject: Record<string, string[]> }) => Promise<{ success: boolean; projects: WorkspaceProject[]; movedProjects: WorkspaceProject[]; unchangedProjects: WorkspaceProject[]; failures: Array<{ projectName: string; error: string }>; error?: string }>;
  trashWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; operationId?: string; permanent?: boolean; error?: string; errorCode?: string }>;
  cleanupDeletedWorkspaceProjects: (workspacePath: string) => Promise<{ success: boolean; checkedCount: number; cleanedCount: number; outcomes: Array<{ projectId: string; name: string; cleaned: boolean; status: 'in_recycle_bin' | 'missing' | 'restored' | 'unknown'; removedArtifactCount?: number }>; error?: string }>;

  getProjectContents: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; folders: Array<{ name: string; path: string; updatedAt: number }>;error?: string }> ;
  watchFileRoot: (workspacePath: string, status: ProjectStatus, name: string, options?: { reconcile?: boolean }) => Promise<{ success: boolean; root?: string; requiredRoots?: number; watchedRoots?: number; failedRoots?: Array<{ virtualPath: string; external: boolean; error: string }>; degraded?: boolean; reconciled?: boolean; reconciliationFailed?: boolean; error?: string }>;
  unwatchFileRoot: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; error?: string }>;
  browseProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, relativePath?: string, cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; path?: string; entries: ProjectFileEntry[]; missingDirectory?: boolean; error?: string }>;
  inspectProjectToolSources: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[], collectVideos?: boolean, collectDirectConvertibleImages?: boolean, collectRecursiveConvertibleImages?: boolean) => Promise<{ success: boolean; indexed: boolean; hasVideo: boolean; hasConvertibleImage: boolean; videoPaths: string[]; convertibleImagePaths: string[]; folderPaths: string[]; sources: ProjectToolSource[]; error?: string }>;
  resolveProjectShortcut: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; target?: string; targetKind?: 'folder' | 'file'; error?: string }>;
  browseProjectShortcutPreview: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; targetKind: 'folder' | 'file' | null; entries: ProjectFileEntry[]; truncated?: boolean; errorCode?: 'SHORTCUT_INVALID' | 'SHORTCUT_LOOP' | 'SHORTCUT_TARGET_MISSING' | 'SHORTCUT_TARGET_OFFLINE' | 'SHORTCUT_ACCESS_DENIED' | 'SHORTCUT_UNSUPPORTED'; error?: string }>;
  searchProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, scopeRelativePath: string, query: string) => Promise<{ success: boolean; scope?: string; entries: ProjectFileEntry[]; error?: string }>;
  listProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, scopeRelativePath?: string, pageSize?: number, cursor?: string, filter?: ProjectFileListFilter) => Promise<ProjectFileListResult>;
  cancelListProjectFiles: (cursor: string) => Promise<{ success: boolean; errorCode?: 'FILE_LIST_SESSION_EXPIRED'; error?: string }>;
  listRecentProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, scopeRelativePath: string, limit?: number, cursor?: string) => Promise<{ success: boolean; scope?: string; entries: ProjectFileEntry[]; cursor?: string; hasMore?: boolean; truncated?: boolean; scannedDirectories?: number; error?: string; errorCode?: 'RECENT_FILES_SESSION_EXPIRED' }>;
  cancelRecentProjectFiles: (cursor: string) => Promise<{ success: boolean; errorCode?: 'RECENT_FILES_SESSION_EXPIRED'; error?: string }>;
  listWorkspaceFolders: (workspacePath: string, status: ProjectStatus, name: string) => Promise<{ success: boolean; folders: Array<{ name: string; relativePath: string; parentRelativePath: string; depth: number }>; truncated?: boolean; skippedCount?: number; error?: string }>;
  addInspirationToProject: (inspirationRoot: string, targetWorkspacePath: string, targetStatus: ProjectStatus, targetProjectName: string, relativePaths: string[]) => Promise<{ success: boolean; count?: number; fileCount?: number; shortcutCount?: number; planningFolder?: string; error?: string }>;
  extractOfficeImages: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<OfficeImageExtractionResult>;
  extractScreenshotMainImages: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[], options?: { requestId?: string; analyzeOnly?: boolean; crops?: Array<{ x: number; y: number; width: number; height: number }>; outputSuffix?: '主图' | '裁剪'; saveMode?: 'new' | 'replace' }) => Promise<{
    success: boolean;
    inputCount?: number;
    croppedCount?: number;
    skippedCount?: number;
    failedCount?: number;
    reviewCount?: number;
    results: Array<{
      input: string;
      inputName: string;
      success: boolean;
      cropped: boolean;
      skipped?: boolean;
      analyzed?: boolean;
      detected?: boolean;
      needsReview?: boolean;
      output?: string;
      outputName?: string;
      confidence?: number;
      crop?: { x: number; y: number; width: number; height: number };
      snapGuides?: { x: number[]; y: number[] };
      originalSize?: { width: number; height: number };
      outputSize?: { width: number; height: number };
      reason?: string;
      error?: string;
    }>;
    error?: string;
  }>;
  trimProjectVideo: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string, request: { start: number; end: number; saveMode: 'new' | 'replace'; exportMode: 'fast' | 'exact'; operationId: string; sourceDuration: number }) => Promise<{ success: boolean; started?: boolean; operationId?: string; outputPath?: string; relativePath?: string; duration?: number; replaced?: boolean; cancelled?: boolean; error?: string }>;
  cancelProjectVideoTrim: (operationId: string) => Promise<{ success: boolean; cancelled: boolean; error?: string }>;
  onProjectVideoTrimProgress: (callback: (progress: { operationId: string; phase: 'preparing' | 'encoding' | 'verifying' | 'saving' | 'finalizing' | 'complete' | 'cancelled' | 'failed' | string; progress: number; message: string }) => void) => () => void;
  getProjectVideoTimelineFrames: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string, times: number[]) => Promise<{ success: boolean; frames?: string[]; error?: string }>;
  onScreenshotMainImageProgress: (callback: (progress: { requestId: string; phase: 'extracting' | 'complete' | 'failed' | string; progress: number; processedCount?: number; totalCount?: number; currentName?: string; message: string }) => void) => () => void;
  getProjectFileDetails: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<{ success: boolean; details: Array<{ relativePath: string; size: number; createdAt: number; updatedAt: number }>; error?: string }>;
  getProjectEntryDetails: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; details?: { size: number; createdAt: number; updatedAt: number; fileCount: number; folderCount: number }; error?: string }>;
  getMediaVersions: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<MediaVersionBundle>;
  updateMediaVersion: (workspacePath: string, request: { versionId: string; versionName?: string; note?: string; isFinal?: boolean; makeCurrent?: boolean }) => Promise<MediaVersionBundle>;
  relocateMediaVersion: (workspacePath: string, status: ProjectStatus, name: string, request: { photoId: string; versionId: string; filePath?: string; force?: boolean }) => Promise<MediaVersionBundle & { requiresDecision?: { kind: 'version-fingerprint-mismatch'; filePath: string; message: string; detail: string } }>;
  deleteMediaVersion: (workspacePath: string, request: { photoId: string; versionId: string; trashFile?: boolean }) => Promise<MediaVersionBundle>;
  getMediaVersionDeleteScope: (workspacePath: string, versionId: string) => Promise<{ success: boolean; versionNumber: number; versionCount: number; missingCount: number; allMissing: boolean; childCount: number; selectedChildCount: number; error?: string }>;
  deleteProjectMissingMediaVersion: (workspacePath: string, versionId: string) => Promise<{ success: boolean; deletedCount: number; versionNumber?: number; reparentedCount?: number; removedArtifactCount?: number; error?: string }>;
  recordMediaVersionCompare: (workspacePath: string, request: { photoId: string; leftVersionId: string; rightVersionId: string; compareMode: string }) => Promise<{ success: boolean; error?: string }>;
  openMediaVersion: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  getProgressFoldersSnapshot: (workspacePath: string, projectName: string) => Promise<{ success: boolean; progressFolders: ProgressFolder[]; graphEdges: VersionGraphEdge[]; legacySelectionRelationRepairs: LegacySelectionRelationRepair[]; error?: string }>;
  getProgressFolders: (workspacePath: string, projectName: string) => Promise<{ success: boolean; progressFolders: ProgressFolder[]; graphEdges: VersionGraphEdge[]; legacySelectionRelationRepairs: LegacySelectionRelationRepair[]; error?: string }>;
  getSelectionSourceFolders: (projectPath: string, request?: { cursor?: string; pageSize?: number; operationId?: string }) => Promise<{ success: boolean; operationId?: string; folders: Array<{ name: string; relativePath: string }>; nextCursor?: string | null; truncated: boolean; cancelled?: boolean; error?: string }>;
  preflightFilenameSelection: (projectPath: string, request: { sourceFolderRelativePath: string; mediaKind?: 'image' | 'video'; keywords: string[]; operationId?: string }) => Promise<SelectionPreflightResult>;
  executeFilenameSelection: (projectPath: string, request: { sourceFolderRelativePath: string; mediaKind?: 'image' | 'video'; keywords: string[]; expectedSignature: string; operationId: string }) => Promise<SelectionExecutionResult>;
  preflightManualSelection: (projectPath: string, request: { sourceFolderRelativePath: string; relativePaths: string[]; operationId?: string }) => Promise<SelectionPreflightResult>;
  executeManualSelection: (projectPath: string, request: { sourceFolderRelativePath: string; relativePaths: string[]; expectedSignature: string; operationId: string }) => Promise<SelectionExecutionResult>;
  cancelSelectionOperation: (operationId: string) => Promise<{ success: boolean }>;
  onSelectionOperationProgress: (callback: (progress: { operationId: string; phase: 'listing_source_folders' | 'scanning_source' | 'copying' | string; directoriesScanned?: number; directoriesDiscovered?: number; filesScanned?: number; maxDirectories?: number; maxFiles?: number; fileName?: string; fileIndex?: number; totalFiles?: number; fileBytesCopied?: number; fileTotalBytes?: number; bytesCopied?: number; totalBytes?: number; progress?: number }) => void) => () => void;
  getFinalVersionSummary: (workspacePath: string, status: ProjectStatus, projectName: string) => Promise<{ success: boolean; count: number; availableCount: number; missingCount: number; error?: string }>;
  browseFinalVersions: (workspacePath: string, status: ProjectStatus, projectName: string) => Promise<{ success: boolean; count: number; availableCount: number; missingCount: number; entries: ProjectFileEntry[]; error?: string }>;
  exportFinalVersions: (workspacePath: string, status: ProjectStatus, projectName: string, request: { parentProgressId: string }) => Promise<{ success: boolean; count: number; displayName?: string; versionKey?: string; progressFolder?: ProgressFolder; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  getMediaRating: (filePath: string) => Promise<{ success: boolean; rating: number; error?: string }>;
  getMediaRatings: (entries: Array<{ path: string; updatedAt: number }>) => Promise<{ success: boolean; results: Array<{ path: string; updatedAt: number; success: boolean; rating: number; error?: string }>; checked: number; error?: string }>;
  setMediaRating: (workspacePath: string, filePath: string, rating: number) => Promise<{ success: boolean; rating: number; error?: string }>;
  createProgressFolder: (workspacePath: string, status: ProjectStatus, projectName: string, request: { mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; displayName: string }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  registerProgressWithGraph: (workspacePath: string, status: ProjectStatus, request: { projectName: string; progress: { progressId?: string; relativePath?: string; mediaKind?: 'image' | 'video'; versionKey?: string; parentProgressId?: string; displayName?: string; trackingEnabled?: boolean; trackingState?: ProgressFolder['trackingState']; renameFromParent?: boolean; copyMissingFromParent?: boolean; moveToRoot?: boolean }; workflowInputProgressIds: string[] }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; edges?: VersionGraphEdge[]; relativePath?: string; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  adoptVersionTreeFolder: (workspacePath: string, status: ProjectStatus, request: { projectName: string; relativePath: string; mode: 'original' | 'companion' | 'preview' | 'transcode' | 'broll'; mediaKind: 'image' | 'video' | 'mixed'; sourceProgressId?: string }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; edge?: VersionGraphEdge | null; error?: string }>;
  registerProgressFolder: (workspacePath: string, status: ProjectStatus, projectName: string, request: { relativePath: string; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; displayName: string; trackingEnabled: boolean; renameFromParent?: boolean; copyMissingFromParent?: boolean; trackingState?: ProgressFolder['trackingState']; progressId?: string; moveToRoot?: boolean }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; relativePath?: string; error?: string }>;
  updateProgressFolder: (workspacePath: string, status: ProjectStatus, projectName: string, request: { progressId: string; versionKey: string; parentProgressId?: string; trackingEnabled: boolean; trackingState?: ProgressFolder['trackingState']; renameFromParent: boolean; copyMissingFromParent: boolean }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; progressFolders?: ProgressFolder[]; error?: string }>;
  renameProgressFolder: (workspacePath: string, status: ProjectStatus, projectName: string, request: { progressId: string; expectedFolderId: string; expectedRelativePath: string; newName: string }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; progressFolders?: ProgressFolder[]; oldRelativePath?: string; newRelativePath?: string; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; error?: string }>;
  updateProgressRelation: (workspacePath: string, projectName: string, request: { childProgressId: string; parentProgressId: string | null; expectedUpdatedAt?: number }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; error?: string }>;
  repairLegacySelectionRelation: (workspacePath: string, projectName: string, request: { progressId: string; sourceProgressId?: string; action?: 'connect' | 'keep-independent' }) => Promise<{ success: boolean; progressFolder?: ProgressFolder; keptIndependent?: boolean; error?: string }>;
  commitMediaWorkflowImport: (workspacePath: string, manifest: MediaWorkflowImportManifest) => Promise<{ success: boolean; importSessionId?: string; nodes?: ProgressFolder[]; edges?: VersionGraphEdge[]; retryable?: boolean; error?: string }>;
  recoverMediaWorkflowImports: (workspacePath: string) => Promise<{ success: boolean; recovered: Array<{ importSessionId: string; projectName: string }>; failures: Array<{ importSessionId: string; projectName: string; error: string }>; error?: string }>;
  createVersionGraphEdge: (workspacePath: string, request: Pick<VersionGraphEdge, 'projectId' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => Promise<{ success: boolean; edge?: VersionGraphEdge; error?: string }>;
  deleteVersionGraphEdge: (workspacePath: string, request: Pick<VersionGraphEdge, 'projectId' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => Promise<{ success: boolean; error?: string }>;
  replaceVersionGraphEdgeSource: (workspacePath: string, request: Pick<VersionGraphEdge, 'projectId' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'> & { newSourceProgressId: string }) => Promise<{ success: boolean; edge?: VersionGraphEdge; error?: string }>;
  getVersionTreeLayout: (workspacePath: string, projectName: string, scopeKey: string) => Promise<VersionTreeLayoutResult>;
  saveVersionTreeLayout: (workspacePath: string, projectName: string, request: { scopeKey: string; expectedRevision: number; mode: 'patch' | 'replace'; positions: VersionTreeLayoutPosition[] }) => Promise<{ success: boolean; scopeKey?: string; revision?: number; updatedAt?: number; error?: string }>;
  unregisterProgressFolder: (workspacePath: string, projectName: string, progressId: string) => Promise<{ success: boolean; progressId?: string; versionKey?: string; relativePath?: string; reparentedProgressCount?: number; error?: string }>;
  deleteMissingProgressFolder: (workspacePath: string, projectName: string, progressId: string) => Promise<{ success: boolean; progressId?: string; versionKey?: string; deletedVersionCount?: number; deletedBatchCount?: number; reparentedProgressCount?: number; removedArtifactCount?: number; error?: string }>;
  registerVersionBaseline: (workspacePath: string, status: ProjectStatus, projectName: string, relativePath: string) => Promise<{ success: boolean; batch?: VersionBatch; error?: string }>;
  compareVersionFolders: (workspacePath: string, status: ProjectStatus, projectName: string, referenceRelativePath: string, sourceRelativePath: string, sourceNames?: string[]) => Promise<{ success: boolean; matches: Array<{ source: string; reference: string; target: string; confidence: string; distance: number }>; suggestions: Array<{ source: string; reference: string; target: string; confidence: string; distance: number }>; unmatched: string[]; unmatchedReference: string[]; error?: string }>;
  commitVersionBatch: (workspacePath: string, status: ProjectStatus, projectName: string, request: { folderA: string; folderB: string; importKey: string; displayName?: string; renameSources?: boolean; copyMissingReferences?: string[]; reconcileExisting?: boolean; incrementalSources?: string[]; matches: Array<{ reference: string; source: string; target?: string; distance: number; confidence: string }> }) => Promise<{ success: boolean; alreadyCommitted?: boolean; reconciled?: boolean; repairRequired?: boolean; operationCount?: number; referenceBatch?: VersionBatch; batch?: VersionBatch; renamedCount?: number; renameErrors?: Array<{ operationId?: string; source: string; target: string; error: string }>; copiedMissingCount?: number; copyMissingErrors?: Array<{ name: string; error: string }>; error?: string }>;
  startProgressTracking: (workspacePath: string, projectName: string, request: { progressId: string; mode: 'compare' | 'refresh' }) => Promise<{ success: boolean; taskId?: string; sessionId?: string; sessionStatus?: ProgressTrackingSession['status']; resumed?: boolean; error?: string }>;
  getProgressTrackingSession: (workspacePath: string, request: { sessionId: string; cursor?: number; limit?: number }) => Promise<ProgressTrackingSessionResult>;
  releaseProgressTrackingSession: (workspacePath: string, request: { sessionId: string }) => Promise<{ success: boolean; released: boolean; sessionId?: string; error?: string }>;
  decideProgressTrackingItem: (workspacePath: string, request: { sessionId: string; itemId: string; status: 'accepted' | 'rejected'; referenceName?: string }) => Promise<{ success: boolean; item?: ProgressTrackingItem; error?: string }>;
  commitProgressTracking: (workspacePath: string, request: { sessionId: string }) => Promise<ProgressTrackingSessionResult & { batch?: VersionBatch; renamedCount?: number; repairRequired?: boolean; retryable?: boolean; taskNotificationOwned: boolean }>;
  getProgressMainBranchMedia: (workspacePath: string, request: { progressId?: string; photoId?: string }) => Promise<{ success: boolean; progressId?: string; branchProgressIds: string[]; entries: MainBranchMediaEntry[]; error?: string }>;
  getVersionBatchOperations: (workspacePath: string, batchId: string) => Promise<{ success: boolean; batch?: VersionBatch; operations: VersionBatchFileOperation[]; error?: string }>;
  retryVersionBatchOperations: (workspacePath: string, batchId: string) => Promise<{ success: boolean; repairRequired?: boolean; batch?: VersionBatch; renamedCount?: number; renameErrors?: Array<{ operationId?: string; source: string; target: string; error: string }>; error?: string }>;
  getMediaThumbnail: (filePath: string, kind: 'image' | 'raw' | 'video', cacheConfig?: AppConfig['mediaCache'], requestedSize?: number, priority?: 0 | 1 | 2 | 3, queueOrder?: number) => Promise<{ success: boolean; taskId?: string; state?: ThumbnailState; previewUrl?: string; mediaUrl?: string; usingImportedPreview?: boolean; importedVideoWithoutPreview?: boolean; cacheLayer?: 'memory' | 'disk' | 'source'; error?: string }>;
  cancelMediaThumbnail: (filePath: string, requestedSize?: number) => Promise<{ success: boolean; cancelled: boolean; error?: string }>;
  onThumbnailStateChanged: (callback: (update: { filePath: string; state: ThumbnailState; previewUrls?: Partial<Record<'small' | 'medium' | 'large', string>>; sourceMtimeMs?: number; sourceSize?: number; error?: string }) => void) => () => void;
  startVideoPlayer: (filePath: string, settings: VideoPlaybackSettings, playerId: string, requestId: string, backendId?: string) => Promise<{ success: boolean; sessionId?: string; playerId?: string; requestId?: string; error?: string; errorCode?: PlaybackErrorCode; recoverable?: boolean; suggestedFallback?: 'chromium'|'component'|'system-player'|'none' }>;
  getVideoPlaybackBackends: (filePath: string, browserProbe: 'probably' | 'maybe' | 'unsupported' | 'unknown') => Promise<{ success: boolean; backends: VideoPlaybackBackendDescriptor[]; error?: string }>;
  getVideoDisplayCapabilities: () => Promise<{ success: boolean; display: { displayId: string; scaleFactor: number; colorSpace: string; hdrAvailable: boolean; reason: string; bounds: { x: number; y: number; width: number; height: number } | null }; error?: string }>;
  getVideoPlaybackSource: (filePath: string) => Promise<{ success: boolean; mediaUrl?: string; error?: string }>;
  setVideoPlayerBounds: (sessionId: string, bounds: { x: number; y: number; width: number; height: number; visible: boolean; overlayHole?: { x: number; y: number; width: number; height: number; radius?: number }; controlsOverlayHole?: { x: number; y: number; width: number; height: number }; cornerOverlayHole?: { x: number; y: number; width: number; height: number } }) => void;
  setAdvancedVideoBounds: (sessionId: string, bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
    overlayHole?: { x: number; y: number; width: number; height: number; radius?: number };
    controlsOverlayHole?: { x: number; y: number; width: number; height: number };
    cornerOverlayHole?: { x: number; y: number; width: number; height: number };
  }) => void;
  controlVideoPlayer: (sessionId: string, request: { action: 'play' | 'pause' | 'seek' | 'frame-step' | 'frame-back-step' | 'volume' | 'mute' | 'speed' | 'stop' | 'subtitle-select' | 'subtitle-visible' | 'subtitle-delay' | 'subtitle-style' | 'audio-select' | 'transform' | 'hdr-mode' | 'tone-mapping' | 'statistics-level'; value?: number | boolean | string; fontSize?: VideoPlaybackSettings['subtitleSize']; style?: VideoPlaybackSettings['subtitleStyle']; transform?: { aspectMode: 'source' | 'contain' | 'cover' | '16:9' | '4:3' | '1:1'; rotation: 0 | 90 | 180 | 270; flipHorizontal: boolean; flipVertical: boolean; crop?: {x:number;y:number;width:number;height:number} }; hdrMode?: VideoPlaybackSettings['hdrMode']; toneMapping?:VideoPlaybackSettings['toneMapping'];targetPeakNits?:number; statisticsLevel?: 'off' | 'basic' | 'detailed' }) => void;
  chooseVideoSubtitle: (sessionId: string) => Promise<{ success: boolean; cancelled?: boolean; path?: string; error?: string }>;
  chooseVideoSubtitleFile: () => Promise<{ success: boolean; cancelled?: boolean; format?: 'vtt' | 'srt' | 'ass' | 'ssa'; name?: string; mediaUrl?: string; error?: string }>;
  addVideoSubtitle: (sessionId: string, filePath: string) => Promise<{ success: boolean; error?: string }>;
  captureVideoPlayerFrame: (sessionId: string, mode?: 'sourceFrame'|'displayedFrame') => Promise<{ success: boolean; path?: string; error?: string }>;
  publishVideoPlayerFrame: (filePath: string, bytes: Uint8Array) => Promise<{ success: boolean; path?: string; error?: string }>;
  stopVideoPlayer: (sessionId: string) => Promise<{ success: boolean }>;
  onVideoPlayerState: (callback: (state: VideoPlayerState) => void) => () => void;
  captureAdvancedVideoFrame: (sessionId: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  stopAdvancedVideo: (sessionId: string) => Promise<{ success: boolean }>;
  onAdvancedVideoState: (callback: (state: AdvancedVideoState) => void) => () => void;
  getMediaOriginal: (filePath: string, kind: 'image' | 'raw' | 'video', cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; mediaUrl?: string; original?: boolean; orientation?: { matrix: number[]; swapsAxes: boolean; rawOrientation: number; embeddedOrientation: number }; error?: string }>;
  getMediaMetadata: (filePath: string) => Promise<{ success: boolean; fields: MediaMetadataField[]; error?: string }>;
  reportRendererError: (message: string, details?: string) => void;
  reportRendererInfo: (message: string, details?: string) => void;
  trackTelemetry: (eventName: string, properties?: Record<string, string | number | boolean>) => void;
  onAppError: (callback: (message: string) => void) => () => void;
  onComponentNotification: (callback: (value: { type: 'notification'; id: string; componentId: string; surface: 'project' | 'application.settings' | ComponentContributionType; notification: { tone: 'info' | 'success' | 'warning' | 'error'; message: string; dedupeKey?: string } } | { type: 'purge'; componentId: string }) => void) => () => void;
  getRawPreview: (filePath: string, cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; previewUrl?: string; error?: string }>;
  projectFileOperation: (workspacePath: string, status: ProjectStatus, projectName: string, operation: 'trash' | 'copy' | 'cut' | 'paste' | 'rename' | 'select' | 'move' | 'import' | 'import-url' | 'import-data', paths: string[], targetRelativePath?: string, nextName?: string, options?: { sourceFolderRelativePath?: string; imageDestFolderName?: string; videoDestFolderName?: string; renameNames?: string[]; pasteConflictPolicy?: 'replace' | 'keep-both'; droppedImageFiles?: Array<{ name: string; type: string; bytes: ArrayBuffer }> }) => Promise<{ success: boolean; cancelled?: boolean; count?: number; permanentCount?: number; imageCount?: number; videoCount?: number; operationId?: string; taskNotificationOwned?: boolean; clipboardGeneration?: number; consumedCutClipboard?: boolean; affectedDirectories?: string[]; moves?: Array<{ sourceRelativePath: string; destinationRelativePath: string }>; movedItems?: Array<{ sourceRelativePath: string; destinationRelativePath: string; copied?: boolean }>; createdItems?: Array<{ name: string; relativePath: string; isDirectory: boolean }>; replacedCount?: number; replacedNames?: string[]; replacedPermanentCount?: number; replacedRetainedCount?: number; requiresDecision?: { kind: 'paste-conflict'; names: string[]; fileCount: number; folderCount: number; message: string; detail: string }; undoUnavailable?: boolean; warning?: string; error?: string; errorCode?: string }>;
  getProjectFileClipboardStatus: () => Promise<{ success: boolean; hasFiles: boolean; error?: string }>;
  cancelProjectFileCut: (workspacePath: string, status: ProjectStatus, projectName: string, paths: string[]) => Promise<{ success: boolean; cleared: boolean; hasFiles: boolean; error?: string }>;
  getPathForFile: (file: File) => string;
  startProjectFileDrag: (workspacePath: string, status: ProjectStatus, projectName: string, paths: string[], context: { sessionId: string; sourcePageId: string; origin: 'file-browser' | 'version-tree' }) => void;
  onProjectFileDragEnd: (callback: (result: { sessionId: string; sourcePageId: string; origin: 'file-browser' | 'version-tree'; paths: string[]; clientX: number; clientY: number; insideWindow: boolean; started: boolean }) => void) => () => void;
  onProjectFileOperationProgress: (callback: (progress: ProjectFileOperationProgress) => void) => () => void;
  cancelProjectFileOperation: (operationId: string) => Promise<{ success: boolean; error?: string }>;
  chooseCacheDirectory: () => Promise<{ cancelled?: boolean; path?: string }>;
  chooseWorkspaceDirectory: (currentPath?: string) => Promise<{ success?: boolean; cancelled?: boolean; path?: string }>;
  chooseImportSourceFiles: () => Promise<{ cancelled?: boolean; paths: string[] }>;
  chooseProjectImportFiles: () => Promise<{ cancelled?: boolean; paths: string[] }>;
  chooseBrollSourceFiles: () => Promise<{ cancelled?: boolean; paths: string[] }>;
  chooseVideoFiles: () => Promise<{ cancelled?: boolean; paths: string[] }>;
  chooseVideoFolder: () => Promise<{ cancelled?: boolean; path?: string }>;
  inspectSourcePaths: (paths: string[], options?: { includeFolderFiles?: boolean; extensions?: string[] }) => Promise<{ success: boolean; sources: Array<{ path: string; kind: 'file' | 'folder'; preview?: { count: number; files: string[]; truncated: boolean } }>; missingPaths: string[]; error?: string }>;
  getMediaCacheInfo: (cacheConfig?: AppConfig['mediaCache']) => Promise<{ success: boolean; path: string; sizeBytes: number; fileCount: number; error?: string }>;
  clearMediaCache: (cacheConfig?: AppConfig['mediaCache'], olderThanDays?: number, options?: { origin?: 'manual' | 'daily-auto' }) => Promise<{ success: boolean; deletedCount?: number; prunedSourceCount?: number; taskId?: string; error?: string }>;
  getStorageUsageOverview: (force?: boolean) => Promise<StorageUsageOverview>;
  getBackgroundTasks: () => Promise<{ success: boolean; revision: number; tasks: BackgroundTask[] }>;
  cancelBackgroundTask: (id: string) => Promise<{ success: boolean }>;
  pauseBackgroundTask: (id: string) => Promise<{ success: boolean }>;
  continueBackgroundTask: (id: string) => Promise<{ success: boolean }>;
  dismissBackgroundTask: (id: string) => Promise<{ success: boolean }>;
  resumeBackgroundTask: (id: string) => Promise<{ success: boolean; task?: BackgroundTask; error?: string }>;
  restartBackgroundTask: (id: string) => Promise<{ success: boolean; task?: BackgroundTask; error?: string }>;
  retryBackgroundTask: (id: string) => Promise<{
    success: boolean;
    accepted?: boolean;
    sourceTaskId?: string;
    replacementTaskId?: string;
    deduplicated?: boolean;
    task?: BackgroundTask;
    code?: string;
    error?: string;
  }>;
  onBackgroundTaskChanged: (callback: (delta: BackgroundTaskDelta) => void) => () => void;
  chooseBackupTarget: (currentPath?: string) => Promise<{ cancelled: boolean; path?: string }>;
  getBackupStatus: (workspacePath: string) => Promise<BackupStatus>;
  setNasBackupTarget: (targetPath: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  saveNasCredential: (request: { remotePath: string; username: string; password: string }) => Promise<{ success: boolean; credentialRef?: string; username?: string; error?: string }>;
  readNasCredential: (credentialRef: string) => Promise<{ success: boolean; credential?: { username: string } | null; error?: string }>;
  deleteNasCredential: (credentialRef: string) => Promise<{ success: boolean; error?: string }>;
  testBackupConnection: () => Promise<{ success: boolean; connection?: BackupConnectionStatus; error?: string }>;
  getBackupSpaceStatus: (workspacePath: string) => Promise<BackupSpaceStatus>;
  cleanupBackup: (workspacePath: string) => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  runBackup: (workspacePath: string, reason?: 'manual' | 'daily' | 'after-import') => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  runBackupIfDue: (workspacePath: string) => Promise<{ success: boolean; skipped?: boolean; error?: string }>;
  verifyBackup: (workspacePath: string, snapshotId: string) => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  verifyDomainStorage: (workspacePath: string, domain: ComponentDataDomainId) => Promise<{ success: boolean; state?: string; schemaVersion?: number; error?: string }>;
  runDomainBackup: (workspacePath: string, domain: ComponentDataDomainId) => Promise<{ success: boolean; path?: string; error?: string }>;
  restoreDomainBackup: (workspacePath: string, snapshotId: string, domain: ComponentDataDomainId) => Promise<{ success: boolean; error?: string }>;
  resetDomainStorage: (workspacePath: string, domain: ComponentDataDomainId) => Promise<{ success: boolean; quarantine?: string; requiresReindex?: boolean; error?: string }>;
  restoreBackupWorkspace: (workspacePath: string, snapshotId: string) => Promise<{ success: boolean; cancelled?: boolean; workspacePath?: string; savedConfig?: AppConfig; error?: string }>;
  restoreBackupProject: (workspacePath: string, snapshotId: string, projectId: string) => Promise<{ success: boolean; project?: WorkspaceProject; error?: string }>;
  openBackupTarget: () => Promise<{ success: boolean; error?: string }>;
  chooseArchiveTarget: (currentPath?: string) => Promise<{ cancelled: boolean; path?: string }>;
  getArchiveStatus: () => Promise<{ success: boolean; enabled: boolean; state: 'unconfigured' | 'connected' | 'offline'; targetPath?: string; totalBytes?: number; freeBytes?: number; error?: string }>;
  archiveWorkspaceProject: (workspacePath: string, projectName: string) => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  moveArchivedProjectBack: (workspacePath: string, projectName: string, statusAfter?: Exclude<ProjectStatus, '已归档'>) => Promise<{ success: boolean; queued?: boolean; error?: string }>;
  openArchiveTarget: () => Promise<{ success: boolean; error?: string }>;
  openWorkspaceProject: (workspacePath: string, status: ProjectStatus, name: string, folderName?: string) => Promise<{ success: boolean; error?: string }> ;
  openProjectEntry: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
  getPhotoshopStatus: () => Promise<{ available: boolean }>;
  openProjectEntriesInPhotoshop: (workspacePath: string, status: ProjectStatus, name: string, relativePaths: string[]) => Promise<{ success: boolean; count?: number; error?: string }>;
  copyProjectEntryPath: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
  getFileIcon: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  importProjectFiles: (workspacePath: string, status: ProjectStatus, name: string, relativePath: string, options: { deleteSourceAfterImport: boolean; sourcePaths?: string[]; mediaKind?: 'image' | 'video' }) => Promise<{ success: boolean; operationId?: string; taskNotificationOwned?: boolean; cancelled?: boolean; watchDegraded?: boolean; count?: number; items?: Array<{ relativePath: string; sourcePath: string; kind: 'file' | 'folder' }>; recoveryRequired?: boolean; recovery?: { operationId: string; leftoverPaths: string[]; cleanupErrors: Array<{ path: string; error: string }> }; error?: string }>;
  importProgressFiles: (workspacePath: string, status: ProjectStatus, name: string, folderName: string, options: { deleteSourceAfterImport: boolean; mediaKind: 'image' | 'video'; versionKey: string; parentProgressId?: string; trackingEnabled: boolean; trackingState?: ProgressFolder['trackingState']; appendProgressId?: string; progressConflictPolicy?: 'skip' | 'keep-both'; sourcePaths?: string[] }) => Promise<{ success: boolean; operationId?: string; taskNotificationOwned?: boolean; cancelled?: boolean; watchDegraded?: boolean; appended?: boolean; count?: number; skippedCount?: number; skippedNames?: string[]; importedPaths?: string[]; progressFolder?: ProgressFolder; folder?: { name: string; path: string; relativePath: string; updatedAt: number }; recoveryRequired?: boolean; recovery?: { operationId: string; leftoverPaths: string[]; cleanupErrors: Array<{ path: string; error: string }> }; requiresDecision?: { kind: 'progress-import-conflict'; names: string[]; conflictCount: number; sourcePaths: string[]; message: string; detail: string }; error?: string }>;
  importBroll: (workspacePath: string, status: ProjectStatus, name: string, options: { splitVideosOnImport: boolean; transcodeVideosOnImport: boolean; transcodeSettings: VideoTranscodeSettings; deleteSourceAfterImport: boolean; sourcePaths?: string[] }) => Promise<{ success: boolean; operationId?: string; taskNotificationOwned?: boolean; cancelled?: boolean; count?: number; splitCount?: number; transcodeCount?: number; clearedCount?: number; warning?: string; error?: string}>;
}

declare global {
  interface Window {
    electronAPI: IElectronAPI;
    toastViewAPI: ToastViewApi;
  }
}
import type { PlaybackAttempt, PlaybackErrorCode } from './contracts/playback-errors';

export type ApplicationQuitState = { revision?: number; phase: "idle" | "confirming" | "saving" | "closing" | "failed"; requestId?: string; message?: string; tasks?: Array<{ id: string; title: string; state: string; progress: number }> };
