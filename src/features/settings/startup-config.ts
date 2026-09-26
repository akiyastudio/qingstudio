import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { normalizeLanguage, setLanguage } from '../../i18n/runtime';
import { workspaceWindowStartup } from '../../platform/workspace-window-client';
import { rebaseConfigDraft } from './remote-config-model';
import { registerApplicationQuitFlush } from '../app/application-quit-client';
import { LEGACY_VIDEO_PLAYBACK_SETTINGS_ID } from '../../compatibility/legacy-video-playback-settings';
import { normalizeVideoShortcutBindings } from '../../contracts/video-shortcuts';
import { normalizeProgressNamePresets, normalizeProjectCategoryOrder, normalizeWorkspacePaths, type AppConfig } from '../../types';
import { DEFAULT_CONFIG, IMAGE_SELECTION_FOLDER_NAME, VIDEO_SELECTION_FOLDER_NAME, isMac, normalizeHomeOrder, normalizeMediaCacheSize, normalizeProjectCategories, normalizeProjectToolbar, normalizeVideoPreviewQuality } from '../app/app-config';
import { normalizeSubtitleFontSize } from '../app/video-player-settings';
import { normalizeSavedSdDeviceRecords, normalizeSavedSdDriveVideoActions } from '../tools/sd-startup-import-model';
import { normalizeVideoTranscodeSettings } from '../tools/video-transcode-model';

export type StartupConfigNormalization = {
  config: AppConfig;
  persistencePasses: readonly boolean[];
};

export const normalizeStartupConfig = (fileConfig: AppConfig): StartupConfigNormalization => {
  const storedResearch = fileConfig.componentSettings?.['research-tools'] as AppConfig['research'] | undefined;
  const legacyResearch = storedResearch || fileConfig.research;
  const legacyInspiration = fileConfig.inspirationLibrary as AppConfig['inspirationLibrary'] & Partial<AppConfig['research']>;
  const legacyThreshold = legacyResearch?.ssimThreshold;
  const inspirationLibrary: AppConfig['inspirationLibrary'] = { rootPath: legacyInspiration?.rootPath || '' };
  const researchSettings: AppConfig['research'] = {
    sensitivity: legacyResearch?.sensitivity ?? legacyInspiration?.sensitivity ?? (legacyThreshold !== undefined && legacyThreshold >= 0.98 ? 'high' : legacyThreshold !== undefined && legacyThreshold <= 0.85 ? 'low' : 'standard'),
    minDuration: legacyResearch?.minDuration ?? legacyInspiration?.minDuration ?? 0.2,
  };
  const legacyAdvancedVideo = fileConfig.componentSettings?.[LEGACY_VIDEO_PLAYBACK_SETTINGS_ID] as Partial<AppConfig['videoPlayback']> | undefined;
  const videoPlayback: AppConfig['videoPlayback'] = {
    arrowKeyAction: fileConfig.videoPlayback?.arrowKeyAction === 'navigate' ? 'navigate' : fileConfig.videoPlayback?.arrowKeyAction === 'seek' ? 'seek' : legacyAdvancedVideo?.arrowKeyAction === 'navigate' ? 'navigate' : 'seek',
    subtitlesEnabled: fileConfig.videoPlayback?.subtitlesEnabled === true,
    subtitlePreferredLanguages: Array.isArray(fileConfig.videoPlayback?.subtitlePreferredLanguages) ? fileConfig.videoPlayback.subtitlePreferredLanguages.map(value => String(value).trim().toLowerCase()).filter(Boolean).slice(0, 8) : ['zh', 'chi', 'zho'],
    subtitleSize: normalizeSubtitleFontSize(fileConfig.videoPlayback?.subtitleSize),
    subtitleStyle: fileConfig.videoPlayback?.subtitleStyle === 'high-contrast' ? 'high-contrast' : 'standard',
    hdrMode: ['sdr', 'hdr-passthrough', 'tone-map'].includes(String(fileConfig.videoPlayback?.hdrMode)) ? fileConfig.videoPlayback!.hdrMode : 'auto',
    toneMapping: ['bt2390', 'reinhard', 'mobius', 'hable'].includes(String(fileConfig.videoPlayback?.toneMapping)) ? fileConfig.videoPlayback!.toneMapping : 'auto',
    targetPeakNits: Math.max(100, Math.min(4000, Number(fileConfig.videoPlayback?.targetPeakNits) || 400)),
    shortcuts: normalizeVideoShortcutBindings(fileConfig.videoPlayback?.shortcuts),
  };
  const configuredImageSource = fileConfig.smartMatch?.imageSourceFolderName;
  const configuredVideoSource = fileConfig.smartMatch?.videoSourceFolderName;
  const savedSdPaths = (Array.isArray(fileConfig.smartImport?.sdPaths) && fileConfig.smartImport.sdPaths.length ? fileConfig.smartImport.sdPaths : fileConfig.smartImport?.sdPath ? [fileConfig.smartImport.sdPath] : []).map((drive: string) => isMac ? drive : drive.replace(/\\/g, '/').replace(/\/DCIM\/?$/i, '/'));
  const sdVideoActionDefaults = {
    work: {
      splitVideosOnImport: fileConfig.importDefaults?.splitVideosOnImport ?? fileConfig.smartImport?.splitLargeFiles ?? false,
      transcodeVideosOnImport: fileConfig.importDefaults?.transcodeVideosOnImport ?? fileConfig.smartImport?.generateVideoPreview ?? false,
    },
    broll: {
      splitVideosOnImport: fileConfig.brollImport?.splitVideosOnImport ?? fileConfig.importDefaults?.splitVideosOnImport ?? fileConfig.brollImport?.splitLargeFiles ?? false,
      transcodeVideosOnImport: fileConfig.brollImport?.transcodeVideosOnImport ?? fileConfig.importDefaults?.transcodeVideosOnImport ?? fileConfig.smartImport?.generateVideoPreview ?? false,
    },
  };
  const savedSdDevices = normalizeSavedSdDeviceRecords(fileConfig.smartImport?.sdDevices, savedSdPaths, fileConfig.smartImport?.sdDeviceIds, fileConfig.smartImport?.sdDriveTypes, sdVideoActionDefaults);
  const savedSdDriveVideoActions = normalizeSavedSdDriveVideoActions(fileConfig.smartImport?.sdDriveVideoActions, savedSdPaths, fileConfig.smartImport?.sdDriveTypes, sdVideoActionDefaults);
  const componentSettings: AppConfig['componentSettings'] = { ...fileConfig.componentSettings };
  delete componentSettings[LEGACY_VIDEO_PLAYBACK_SETTINGS_ID];
  delete componentSettings['research-tools'];
  delete componentSettings['office-media-extractor'];
  const legacyConfig = { ...fileConfig } as AppConfig & { folderOpenMode?: 'single' | 'double'; fileImport?: { preserveOriginal?: boolean }; brollImport: AppConfig['brollImport'] & { clearSource?: boolean } };
  const legacyFolderOpenMode = legacyConfig.folderOpenMode;
  const legacyFileImport = legacyConfig.fileImport;
  const legacyBrollClearSource = legacyConfig.brollImport?.clearSource;
  delete legacyConfig.folderOpenMode;
  delete legacyConfig.fileImport;
  const customProjectCategories = normalizeProjectCategories(fileConfig.customProjectCategories);
  const configuredWorkspacePaths = normalizeWorkspacePaths(fileConfig.workspacePath, fileConfig.workspacePaths);
  let normalizedConfig = {
    ...legacyConfig,
    theme: fileConfig.theme ?? 'system',
    language: normalizeLanguage(fileConfig.language),
    telemetry: { enabled: fileConfig.telemetry?.enabled === true, crashReports: fileConfig.telemetry?.crashReports === true },
    workspacePath: fileConfig.workspacePath?.trim() ?? '',
    autoCleanupDeletedProjectData: fileConfig.autoCleanupDeletedProjectData ?? true,
    createPlanningFolder: fileConfig.createPlanningFolder ?? true,
    customProjectCategories,
    projectCategoryOrder: normalizeProjectCategoryOrder(fileConfig.projectCategoryOrder, customProjectCategories),
    defaultFolderSort: fileConfig.defaultFolderSort ?? 'date',
    itemOpenMode: fileConfig.itemOpenMode === 'double' || legacyFolderOpenMode === 'double' ? 'double' : 'single',
    favoriteDisplayMode: fileConfig.favoriteDisplayMode === 'stars' ? 'stars' : 'binary',
    usagePreferencesVersion: Number(fileConfig.usagePreferencesVersion) || 0,
    projectToolbar: normalizeProjectToolbar(fileConfig.projectToolbar),
    homeOrder: normalizeHomeOrder(fileConfig.homeOrder),
    birthdayEnabled: fileConfig.birthdayEnabled ?? true,
    pinInspirationLibrary: fileConfig.pinInspirationLibrary === true,
    componentSettings,
    videoPlayback,
    mediaCache: { maxSizeGB: normalizeMediaCacheSize(fileConfig.mediaCache?.maxSizeGB), directory: fileConfig.mediaCache?.directory ?? '', autoCleanup30Days: fileConfig.mediaCache?.autoCleanup30Days ?? false },
    backup: { enabled: fileConfig.backup?.enabled === true, targetType: fileConfig.backup?.targetType === 'nas' || (fileConfig.backup?.targetType === undefined && fileConfig.backup?.targetPath?.startsWith('\\\\')) ? 'nas' : 'local', targetPath: fileConfig.backup?.targetPath ?? '', mode: fileConfig.backup?.mode === 'latest' ? 'latest' : 'history', automaticDaily: fileConfig.backup?.automaticDaily ?? true, afterImport: fileConfig.backup?.afterImport ?? true, retention: { daily: Math.max(1, Number(fileConfig.backup?.retention?.daily) || 7), weekly: Math.max(0, Number(fileConfig.backup?.retention?.weekly) || 4), monthly: Math.max(0, Number(fileConfig.backup?.retention?.monthly) || 12) }, nas: { credentialRef: fileConfig.backup?.nas?.credentialRef ?? '', limitEnabled: fileConfig.backup?.nas?.limitEnabled === true, bandwidthLimitMBps: Math.max(1, Number(fileConfig.backup?.nas?.bandwidthLimitMBps) || 20), limitStart: fileConfig.backup?.nas?.limitStart || '09:00', limitEnd: fileConfig.backup?.nas?.limitEnd || '18:00' } },
    archive: { enabled: fileConfig.archive?.enabled === true, targetPath: fileConfig.archive?.targetPath ?? '' },
    importDefaults: { deleteSourceAfterImport: fileConfig.importDefaults?.deleteSourceAfterImport ?? !(legacyFileImport?.preserveOriginal ?? false), generateJpgFromRaw: fileConfig.importDefaults?.generateJpgFromRaw ?? true, splitVideosOnImport: fileConfig.importDefaults?.splitVideosOnImport ?? fileConfig.smartImport?.splitLargeFiles ?? false, transcodeVideosOnImport: fileConfig.importDefaults?.transcodeVideosOnImport ?? fileConfig.smartImport?.generateVideoPreview ?? false },
    videoTools: { transcode: normalizeVideoTranscodeSettings(fileConfig.videoTools?.transcode) },
    smartImport: { ...fileConfig.smartImport, sdPath: savedSdPaths[0] || '', sdPaths: savedSdPaths, sdDriveTypes: fileConfig.smartImport?.sdDriveTypes ?? {}, sdDriveVideoActions: savedSdDriveVideoActions, sdDeviceIds: fileConfig.smartImport?.sdDeviceIds ?? {}, sdDevices: savedSdDevices, backupEnabled: false, generateVideoPreview: false, videoPreviewQuality: normalizeVideoPreviewQuality(fileConfig.smartImport?.videoPreviewQuality), splitLargeFiles: false, dateFilter: fileConfig.smartImport?.dateFilter === 'today' || fileConfig.smartImport?.dateFilter === 'today_yesterday' ? fileConfig.smartImport.dateFilter : 'all' },
    brollImport: { splitVideosOnImport: fileConfig.brollImport?.splitVideosOnImport ?? fileConfig.importDefaults?.splitVideosOnImport ?? fileConfig.brollImport?.splitLargeFiles ?? false, transcodeVideosOnImport: fileConfig.brollImport?.transcodeVideosOnImport ?? fileConfig.importDefaults?.transcodeVideosOnImport ?? fileConfig.smartImport?.generateVideoPreview ?? false },
    inspirationLibrary,
    smartMatch: { imageDestFolderName: IMAGE_SELECTION_FOLDER_NAME, videoDestFolderName: VIDEO_SELECTION_FOLDER_NAME, imageSourceFolderName: configuredImageSource === undefined || configuredImageSource.toLowerCase() === 'raw' ? 'raw' : configuredImageSource, videoSourceFolderName: configuredVideoSource === undefined || configuredVideoSource.toLowerCase() === 'mov' ? 'mov' : configuredVideoSource },
    research: researchSettings,
  } as AppConfig;
  normalizedConfig.componentSettingsRevisions = { ...(fileConfig.componentSettingsRevisions || {}) };
  normalizedConfig.videoTools.trim = { exportMode: fileConfig.videoTools?.trim?.exportMode === 'exact' ? 'exact' : 'fast' };
  normalizedConfig.folderAlphabetFilterEnabled = fileConfig.folderAlphabetFilterEnabled !== false;
  normalizedConfig.versionTreeEnabled = fileConfig.versionTreeEnabled !== false;
  normalizedConfig.progressNamePresets = normalizeProgressNamePresets(fileConfig.progressNamePresets);
  normalizedConfig.smartImport.autoMoveProjectAfterSdImport = fileConfig.smartImport?.autoMoveProjectAfterSdImport ?? true;
  normalizedConfig.smartMatch.sourceFolderRelativePath = fileConfig.smartMatch?.sourceFolderRelativePath;
  normalizedConfig = { ...normalizedConfig, workspacePath: configuredWorkspacePaths[0] || '', workspacePaths: configuredWorkspacePaths };

  return {
    config: normalizedConfig,
    persistencePasses: [
      fileConfig.videoTools?.trim?.exportMode !== normalizedConfig.videoTools.trim.exportMode,
      JSON.stringify(fileConfig.workspacePaths) !== JSON.stringify(normalizedConfig.workspacePaths) || fileConfig.smartImport?.autoMoveProjectAfterSdImport === undefined || JSON.stringify(fileConfig.smartImport?.sdDevices) !== JSON.stringify(savedSdDevices) || JSON.stringify(fileConfig.smartImport?.sdDriveVideoActions) !== JSON.stringify(savedSdDriveVideoActions) || fileConfig.folderAlphabetFilterEnabled === undefined || fileConfig.versionTreeEnabled === undefined || JSON.stringify(fileConfig.progressNamePresets) !== JSON.stringify(normalizedConfig.progressNamePresets),
      fileConfig.workspacePath !== normalizedConfig.workspacePath || fileConfig.autoCleanupDeletedProjectData === undefined || fileConfig.createPlanningFolder === undefined || JSON.stringify(fileConfig.customProjectCategories) !== JSON.stringify(normalizedConfig.customProjectCategories) || JSON.stringify(fileConfig.projectCategoryOrder) !== JSON.stringify(normalizedConfig.projectCategoryOrder) || fileConfig.defaultFolderSort === undefined || fileConfig.itemOpenMode !== normalizedConfig.itemOpenMode || fileConfig.favoriteDisplayMode !== normalizedConfig.favoriteDisplayMode || fileConfig.usagePreferencesVersion !== normalizedConfig.usagePreferencesVersion || legacyFolderOpenMode !== undefined || fileConfig.birthdayEnabled === undefined || fileConfig.pinInspirationLibrary === undefined || !fileConfig.backup || fileConfig.backup?.targetType === undefined || !fileConfig.backup?.nas || !fileConfig.archive || !fileConfig.importDefaults || fileConfig.importDefaults?.splitVideosOnImport === undefined || fileConfig.importDefaults?.transcodeVideosOnImport === undefined || !fileConfig.videoTools?.transcode || legacyFileImport !== undefined || legacyBrollClearSource !== undefined || !Array.isArray(fileConfig.smartImport?.sdPaths) || !fileConfig.smartImport?.sdDriveTypes || !fileConfig.smartImport?.sdDeviceIds || fileConfig.mediaCache?.maxSizeGB !== normalizedConfig.mediaCache.maxSizeGB || fileConfig.mediaCache?.autoCleanup30Days === undefined || fileConfig.smartImport.backupEnabled || fileConfig.smartImport?.videoPreviewQuality !== normalizedConfig.smartImport.videoPreviewQuality || fileConfig.smartImport?.splitLargeFiles === undefined || fileConfig.smartImport?.dateFilter !== normalizedConfig.smartImport.dateFilter || !fileConfig.brollImport || fileConfig.brollImport?.splitVideosOnImport === undefined || fileConfig.brollImport?.transcodeVideosOnImport === undefined || !fileConfig.inspirationLibrary || JSON.stringify(fileConfig.research) !== JSON.stringify(researchSettings) || fileConfig.smartMatch?.imageDestFolderName !== IMAGE_SELECTION_FOLDER_NAME || fileConfig.smartMatch?.videoDestFolderName !== VIDEO_SELECTION_FOLDER_NAME || configuredImageSource !== normalizedConfig.smartMatch.imageSourceFolderName || configuredVideoSource !== normalizedConfig.smartMatch.videoSourceFolderName || JSON.stringify(fileConfig.homeOrder) !== JSON.stringify(normalizedConfig.homeOrder) || JSON.stringify(fileConfig.projectToolbar) !== JSON.stringify(normalizedConfig.projectToolbar) || JSON.stringify(fileConfig.componentSettings) !== JSON.stringify(normalizedConfig.componentSettings),
      JSON.stringify(fileConfig.videoTools?.transcode) !== JSON.stringify(normalizedConfig.videoTools.transcode),
    ],
  };
};

export const useStartupConfig = () => {
  const [initialConfig] = useState(() => {
    const startup = workspaceWindowStartup();
    return startup ? normalizeStartupConfig(startup.config).config : null;
  });
  const [config, updateConfig] = useState<AppConfig | null>(initialConfig);
  const draft = useRef({ config: initialConfig, baseline: workspaceWindowStartup()?.config || initialConfig });
  const setConfig = useCallback((next: SetStateAction<AppConfig | null>) => {
    const value = typeof next === 'function' ? next(draft.current.config) : next;
    draft.current.config = value;
    updateConfig(value);
  }, []);
  const saveConfig = useCallback((value: AppConfig, baseline?: AppConfig) => window.electronAPI.saveConfig(value, baseline || draft.current.baseline || undefined), []);

  const [startupSdAutoStart, setStartupSdAutoStart] = useState(false);
  const [startupBirthdays, setStartupBirthdays] = useState<Record<string, string> | null>(null);
  const [configLoaded, setConfigLoaded] = useState(Boolean(initialConfig));
  const [showWorkspaceSetup, setShowWorkspaceSetup] = useState(Boolean(initialConfig && !initialConfig.workspacePaths.length));
  useEffect(() => {
    if (!configLoaded) return;
    return window.electronAPI.onConfigChanged?.(snapshot => {
      const remote = normalizeStartupConfig(snapshot).config;
      setLanguage(normalizeLanguage(remote.language));
      const current = draft.current;
      draft.current = current.config && current.baseline ? rebaseConfigDraft(current.config, current.baseline, remote) : { config: remote, baseline: remote };
      updateConfig(draft.current.config);
    });
  }, [configLoaded]);
  useEffect(() => registerApplicationQuitFlush(async () => {
    if (!configLoaded || !config) return;
    const result = await saveConfig(config);
    if (!result.success) throw new Error(result.error || '设置未能保存');
  }), [configLoaded, config, saveConfig]);

  useEffect(() => {
    if (initialConfig) { setLanguage(normalizeLanguage(initialConfig.language)); return; }
    const loadConfig = async () => {
      try {
        if (window.electronAPI?.loadConfig) {
          const startupSnapshot = await window.electronAPI.loadStartupSnapshot?.();
          const fileConfig = startupSnapshot ? startupSnapshot.config : await window.electronAPI.loadConfig();
          if (startupSnapshot) setStartupBirthdays(startupSnapshot.birthdays || {});
          if (fileConfig) {
            const normalized = normalizeStartupConfig(fileConfig);
            setLanguage(normalizeLanguage(normalized.config.language));
            if (!normalized.config.workspacePaths.length) setShowWorkspaceSetup(true);
            setStartupSdAutoStart(normalized.config.smartImport.autoStart === true);
            draft.current.baseline = fileConfig;
            setConfig(normalized.config);
            if (normalized.persistencePasses.some(Boolean) && typeof window.electronAPI?.saveConfig === 'function') {
              const saved = await saveConfig(normalized.config);
              if (saved.success && saved.savedConfig) draft.current.baseline = saved.savedConfig;
            }
            console.log('📋 Configuration loaded from file');
          } else if (window.electronAPI?.getUserPath) {
            const userPath = await window.electronAPI.getUserPath();
            if (userPath) {
              const defaultConfig = DEFAULT_CONFIG(userPath);
              setLanguage(normalizeLanguage(defaultConfig.language));
              draft.current.baseline = null;
              setConfig(defaultConfig);
              if (typeof window.electronAPI?.saveConfig === 'function') {
                const saved = await saveConfig(defaultConfig);
                if (saved.success && saved.savedConfig) draft.current.baseline = saved.savedConfig;
              }
              setShowWorkspaceSetup(true);
              console.log('📋 Configuration created with user path:', userPath);
            } else {
              console.error('❌ Failed to get user path');
            }
          }
        }
      } catch (error) {
        console.error('Failed to load config:', error);
        const fallbackUserPath = await window.electronAPI?.getUserPath?.().catch(() => '') || '';
        setConfig(DEFAULT_CONFIG(fallbackUserPath));
        setShowWorkspaceSetup(true);
      } finally {
        setConfigLoaded(true);
      }
    };
    void loadConfig();
  }, [initialConfig, saveConfig, setConfig]);

  return { config, setConfig, saveConfig, configLoaded, showWorkspaceSetup, setShowWorkspaceSetup, startupBirthdays, startupSdAutoStart };
};
