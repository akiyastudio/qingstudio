import {
  BUILT_IN_PROJECT_STATUSES,
  DEFAULT_PROGRESS_NAME_PRESETS,
  PROJECT_TOOLBAR_ACTION_IDS,
} from '../../types';
import type { AppConfig, HomeCardId, ProjectToolbarActionId } from '../../types';
import { DEFAULT_SUBTITLE_FONT_SIZE } from './video-player-settings';
import { defaultVideoShortcutBindings } from '../../contracts/video-shortcuts';

export const DEFAULT_HOME_ORDER: HomeCardId[] = ['birthday', 'import', 'inspiration'];
const RESERVED_PROJECT_CATEGORIES = new Set<string>(['未分类', ...BUILT_IN_PROJECT_STATUSES]);

export const normalizeProjectCategories = (value: unknown) => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const name = String(item || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    const hasControlCharacter = [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!name || name.length > 24 || hasControlCharacter || RESERVED_PROJECT_CATEGORIES.has(name) || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= 50) break;
  }
  return result;
};

export const localDateKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

export const normalizeHomeOrder = (value: unknown): HomeCardId[] => {
  const valid = new Set<HomeCardId>(DEFAULT_HOME_ORDER);
  const migrated = Array.isArray(value) ? value : [];
  const ordered = migrated.filter((card): card is HomeCardId => valid.has(card as HomeCardId));
  return [...new Set([...ordered, ...DEFAULT_HOME_ORDER])];
};

export const normalizeProjectToolbar = (value: unknown): AppConfig['projectToolbar'] => {
  const source = value && typeof value === 'object' ? value as Partial<AppConfig['projectToolbar']> : {};
  const valid = new Set<ProjectToolbarActionId>(PROJECT_TOOLBAR_ACTION_IDS);
  const migrateToolbarId = (id: unknown): ProjectToolbarActionId | undefined => {
    if (valid.has(id as ProjectToolbarActionId)) return id as ProjectToolbarActionId;
    if (id === 'storyboard' || id === 'video-transcode' || id === 'video-split') return 'video-tools';
    if (id === 'png-converter' || id === 'screenshot-main-image') return 'image-tools';
    return undefined;
  };
  const order = Array.isArray(source.order) ? source.order.map(migrateToolbarId).filter((id): id is ProjectToolbarActionId => Boolean(id)) : [];
  const hidden = Array.isArray(source.hidden) ? source.hidden.map(migrateToolbarId).filter((id): id is ProjectToolbarActionId => Boolean(id)) : [];
  return {
    order: [...new Set([...order, ...PROJECT_TOOLBAR_ACTION_IDS])],
    hidden: [...new Set(hidden)],
    onlyShowAvailable: source.onlyShowAvailable === true,
  };
};

export const IMAGE_SELECTION_FOLDER_NAME = '';
export const VIDEO_SELECTION_FOLDER_NAME = '';

export const normalizeMediaCacheSize = (value: unknown, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};

export const normalizeVideoPreviewQuality = (value: unknown): AppConfig['smartImport']['videoPreviewQuality'] => value === 'high' ? value : 'medium';

export const isMac = window.navigator.userAgent.includes('Mac');

export const DEFAULT_CONFIG = (userPath: string): AppConfig => ({
  theme: 'system',
  telemetry: { enabled: false, crashReports: false },
  workspacePath: '',
  workspacePaths: [],
  autoCleanupDeletedProjectData: true,
  createPlanningFolder: true,
  customProjectCategories: [],
  projectCategoryOrder: [...BUILT_IN_PROJECT_STATUSES],
  progressNamePresets: [...DEFAULT_PROGRESS_NAME_PRESETS],
  defaultFolderSort: 'date',
  itemOpenMode: 'single',
  folderAlphabetFilterEnabled: true,
  versionTreeEnabled: true,
  favoriteDisplayMode: 'binary',
  usagePreferencesVersion: 0,
  projectToolbar: normalizeProjectToolbar(undefined),
  homeOrder: [...DEFAULT_HOME_ORDER],
  birthdayEnabled: true,
  pinInspirationLibrary: false,
  componentSettings: {},
  componentSettingsRevisions: {},
  videoPlayback: { arrowKeyAction: 'seek', subtitlesEnabled: false, subtitlePreferredLanguages: ['zh', 'chi', 'zho'], subtitleSize: DEFAULT_SUBTITLE_FONT_SIZE, subtitleStyle: 'standard', hdrMode: 'auto', toneMapping: 'auto', targetPeakNits: 400, shortcuts: defaultVideoShortcutBindings() },
  mediaCache: { maxSizeGB: 50, directory: '', autoCleanup30Days: false },
  backup: {
    enabled: false,
    targetType: 'local',
    targetPath: '',
    mode: 'history',
    automaticDaily: true,
    afterImport: true,
    retention: { daily: 7, weekly: 4, monthly: 12 },
    nas: { credentialRef: '', limitEnabled: false, bandwidthLimitMBps: 20, limitStart: '09:00', limitEnd: '18:00' },
  },
  archive: { enabled: false, targetPath: '' },
  importDefaults: { deleteSourceAfterImport: true, generateJpgFromRaw: true, splitVideosOnImport: false, transcodeVideosOnImport: false },
  videoTools: {
    transcode: { container: 'mp4', videoMode: 'h264', quality: 'balanced', resolution: 'original', frameRate: 'original', audioMode: 'aac', subtitleMode: 'copy', colorMode: 'auto', bitDepth: 'auto', frameRateMode: 'preserve', rotation: 'auto', aspectMode: 'preserve', audioTrack: 'all', videoBitrateMbps: null, audioBitrateKbps: 192, encoderPreset: 'balanced', retryCount: 1 },
    trim: { exportMode: 'fast' },
  },
  smartImport: {
    autoStart: false,
    autoMoveProjectAfterSdImport: true,
    sdPath: '',
    sdPaths: [],
    sdDriveTypes: {},
    sdDriveVideoActions: {},
    sdDeviceIds: {},
    sdDevices: [],
    destPath: `${userPath}/Desktop`,
    backupEnabled: false,
    generateVideoPreview: false,
    videoPreviewQuality: 'medium',
    splitLargeFiles: false,
    dateFilter: 'all',
    backupPath: isMac ? `${userPath}/Pictures/Backup` : 'D:/Backup',
  },
  brollImport: { splitVideosOnImport: false, transcodeVideosOnImport: false },
  inspirationLibrary: { rootPath: '' },
  smartMatch: {
    imageDestFolderName: '',
    videoDestFolderName: '',
    imageSourceFolderName: 'raw',
    videoSourceFolderName: 'mov',
  },
  research: { sensitivity: 'standard', minDuration: 0.2 },
});
