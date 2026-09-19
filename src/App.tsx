import { lazyPage } from './features/app/lazyPage';
import { useWorkspaceWindow } from './features/app/useWorkspaceWindow';
import { useSharedAppTabs } from './features/app/useSharedAppTabs';
import { PageTransferContext } from './platform/page-transfer-state';
import { useNativeProjectSynchronization } from './features/app/useNativeProjectSynchronization';
import { workspaceWindowContext, workspaceWindowStartup, openNativeWorkspaceTab, nativeProjectSeed, type WorkspaceWindowSeed } from './platform/workspace-window-client';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ChevronRight, Lightbulb, Search } from 'lucide-react';
import { useAppDialog } from './components/AppDialogProvider';
import { ProjectNavigator } from './components/ProjectNavigator';
import { SidebarSettingsButton } from './components/SidebarSettingsButton';
import { AppErrorBoundary } from './features/app/AppErrorBoundary';
import { BackupHomeCard, StartupWindowFrame, UpdateModal } from './features/app/AppChrome';
import { AppTitlebar, type WorkspaceToolTab } from './features/app/AppTitlebar';
import { componentTabId, inspirationTabId, projectTabId, workspaceToolTabId } from './features/app/useTitlebarTabOrder';
import { useTitlebarTabScroll } from './features/app/useTitlebarTabScroll';
import { useBackgroundTaskDrawerWidthPersistence, useWindowSidebarState, useSidebarWidthPersistence, useViewportWidth } from './features/app/useAppShellLayoutState';
import { useWorkspaceTabs } from './features/app/useWorkspaceTabs';
import { useFolderTabNavigation } from './features/app/useFolderTabNavigation';
import { browserPageActivation } from './features/app/workspace-tab-model';
import { WorkspacePanelMenu } from './features/app/WorkspacePanelMenu';
import { BackgroundTaskIndicator } from './features/background-tasks/BackgroundTaskIndicator';
import { useTaskCenter } from './features/background-tasks/TaskCenter';
import { useUserFacingToast } from './features/app/useUserFacingToast';
import { useRendererErrorReporting } from './features/app/useRendererErrorReporting';
import { ComponentPageSurface } from './features/components/ComponentPageSurface'; import { ComponentSettingsPageSurface } from './features/components/ComponentSettingsPageSurface';
import { ComponentDeclarativeSettingsSurface } from './features/components/ComponentDeclarativeSettingsSurface';
import { ComponentContributionDock } from './features/components/ComponentContributionDock';
import { componentCapabilityIsAvailable } from './features/components/component-availability-model';
import { useComponentPages } from './features/components/useComponentPages';
import { useComponentCatalog } from './features/components/useComponentCatalog';
import { componentSettingsSectionKey } from './features/settings/component-settings-page-model';
import { UsagePreferencesOnboarding, USAGE_PREFERENCES_VERSION } from './features/settings/UsagePreferencesOnboarding';
import type { BuiltInSettingsSection, SettingsSection } from './features/settings/SettingsFeature';
import { useStartupConfig } from './features/settings/startup-config';
import { DashboardView, MatchView, VideoSplitView, type ImportCompletion } from './features/tools/ToolViews';
import { useStartupSdAutoImport } from './features/tools/use-startup-sd-auto-import';
import type { GlobalSearchSource } from './features/search/SearchAllPage';
import type { AppConfig, AppUpdateInfo, BackupStatus, ComponentHostAction, ComponentPageOpenScope, ComponentSettingsPageContribution, HomeCardId, ToolType, WorkspaceProject } from './types';
import { ColumnResizeHandle } from './features/app/AppShellLayout';
import { BACKGROUND_TASK_DRAWER_DEFAULT_WIDTH, BACKGROUND_TASK_DRAWER_MAX_WIDTH, BACKGROUND_TASK_DRAWER_MIN_WIDTH, BACKGROUND_TASK_DRAWER_STORAGE_KEY, clampNumber, readStoredNumber } from './features/app/app-shell-layout-model';
import { DEFAULT_CONFIG, DEFAULT_HOME_ORDER, localDateKey } from './features/app/app-config';
const VersionManager = lazyPage<React.ComponentProps<typeof import('./components/VersionManager')['VersionManager']>>(() => import('./components/VersionManager').then(module => ({ default: module.VersionManager })), 'version');
const ProjectWorkspace = lazyPage<React.ComponentProps<typeof import('./features/workspace/ProjectWorkspace')['ProjectWorkspace']>>(() => import('./features/workspace/ProjectWorkspace').then(module => ({ default: module.ProjectWorkspace })), 'project');
const PrivacyConsentPage = lazyPage<React.ComponentProps<typeof import('./features/settings/SettingsFeature')['PrivacyConsentPage']>>(() => import('./features/settings/SettingsFeature').then(module => ({ default: module.PrivacyConsentPage })));
const SettingsNavigator = lazyPage<React.ComponentProps<typeof import('./features/settings/SettingsFeature')['SettingsNavigator']>>(() => import('./features/settings/SettingsFeature').then(module => ({ default: module.SettingsNavigator })), 'settings');
const SettingsPage = lazyPage<React.ComponentProps<typeof import('./features/settings/SettingsFeature')['SettingsPage']>>(() => import('./features/settings/SettingsFeature').then(module => ({ default: module.SettingsPage })), 'settings');
const WorkspaceSetupPage = lazyPage<React.ComponentProps<typeof import('./features/settings/SettingsFeature')['WorkspaceSetupPage']>>(() => import('./features/settings/SettingsFeature').then(module => ({ default: module.WorkspaceSetupPage })));
const InspirationLibraryNavigator = lazyPage<React.ComponentProps<typeof import('./features/inspiration/InspirationLibrary')['InspirationLibraryNavigator']>>(() => import('./features/inspiration/InspirationLibrary').then(module => ({ default: module.InspirationLibraryNavigator })), 'inspiration');
const InspirationLibraryPage = lazyPage<React.ComponentProps<typeof import('./features/inspiration/InspirationLibrary')['InspirationLibraryPage']>>(() => import('./features/inspiration/InspirationLibrary').then(module => ({ default: module.InspirationLibraryPage })), 'inspiration');
const SearchAllPage = lazyPage<React.ComponentProps<typeof import('./features/search/SearchAllPage')['SearchAllPage']>>(() => import('./features/search/SearchAllPage').then(module => ({ default: module.SearchAllPage })), 'search-all');

type WorkspaceToolKind = 'version';
// --- 主组件 ---
const App: React.FC = () => {
  const appDialog = useAppDialog();
  const initialWindow = workspaceWindowContext();
  const nativeSeed = initialWindow?.seed;
  const nativeTabsEnabled = Boolean(initialWindow);
  const [activeTab, setActiveTab] = useState<ToolType>(nativeSeed?.kind === 'version' ? 'project-version' : nativeSeed?.kind || 'home');
  const [searchAllTabOpen, setSearchAllTabOpen] = useState(nativeSeed?.kind === 'search-all');
  const [settingsTabOpen, setSettingsTabOpen] = useState(nativeSeed?.kind === 'settings');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>((nativeSeed?.settingsSection || 'general') as SettingsSection);
  const { config, setConfig, configLoaded, showWorkspaceSetup, setShowWorkspaceSetup, startupBirthdays, startupSdAutoStart } = useStartupConfig();
  const [privacyStateLoaded, setPrivacyStateLoaded] = useState(Boolean(workspaceWindowStartup()));
  const [privacyConsentRequired, setPrivacyConsentRequired] = useState(workspaceWindowStartup()?.privacyConsentRequired ?? true);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [selectedProject, setSelectedProject] = useState<WorkspaceProject | null>(nativeSeed?.scope?.contentKind === 'inspiration' ? null : nativeSeed?.project || nativeSeed?.page?.project || null);
  const { pages: projectPages, activePageId, createPage: createLocalPage, activatePage, updatePagePath, closePage, updateProject, closeProject, selectSidebarProject, requestInspirationPath: requestLocalInspirationPath, ensureInspirationRoot, resetInspirationPages } = useWorkspaceTabs(nativeSeed?.page ? { pages: [nativeSeed.page], activePageId: nativeSeed.page.id } : undefined);
  const createPage = useCallback((page: Parameters<typeof createLocalPage>[0]) => {
    if (!nativeTabsEnabled) return createLocalPage(page);
    const seed = nativeProjectSeed(page); openNativeWorkspaceTab(seed, false); return seed.page!.id;
  }, [createLocalPage, nativeTabsEnabled]);
  const requestInspirationPath = useCallback((rootPath: string, relativePath: string) => {
    if (!nativeTabsEnabled) return requestLocalInspirationPath(rootPath, relativePath);
    openNativeWorkspaceTab(nativeProjectSeed({ kind: 'inspiration', projectId: `inspiration:${rootPath}`, project: null, inspirationRootPath: rootPath, currentRelativePath: relativePath, initialRelativePath: relativePath, operation: null }));
  }, [nativeTabsEnabled, requestLocalInspirationPath]);
  const { dismissPanelTasksByOwnerPageId, panelTasks } = useTaskCenter(); const openPageIds = useMemo(() => new Set(projectPages.map(page => page.id)), [projectPages]);
  const [workspaceToolTabs, setWorkspaceToolTabs] = useState<WorkspaceToolTab[]>([]);
  const [, setProjectDestination] = useState<string | null>(null);
  const toast = useUserFacingToast();
  const showNotice = useCallback((message: string, durationOrTone?: number | 'info' | 'success' | 'warning' | 'error') => {
    toast.show(message, durationOrTone);
  }, [toast]);
  const nativeWindow = useWorkspaceWindow(showNotice, Boolean(configLoaded && config && privacyStateLoaded));
  const autoBackedUpImportTasksRef = useRef(new Set<string>()); const cacheCleanupCheckedRef = useRef(false);
  const [homeOrder, setHomeOrder] = useState<HomeCardId[]>(DEFAULT_HOME_ORDER); const [draggedHomeCard, setDraggedHomeCard] = useState<HomeCardId | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber('photoflow:sidebar-width', 256));
  const { sidebarCollapsed, toggleSidebar } = useWindowSidebarState(nativeWindow);
  const [backgroundTaskDrawerOpen, setBackgroundTaskDrawerOpen] = useState(false);
  const [backgroundTaskDrawerWidth, setBackgroundTaskDrawerWidth] = useState(() => clampNumber(readStoredNumber(BACKGROUND_TASK_DRAWER_STORAGE_KEY, BACKGROUND_TASK_DRAWER_DEFAULT_WIDTH), BACKGROUND_TASK_DRAWER_MIN_WIDTH, BACKGROUND_TASK_DRAWER_MAX_WIDTH));
  const backgroundTaskDrawerHostRef = useRef<HTMLDivElement>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus>({ success: true, enabled: false, state: 'unconfigured', snapshots: [] });
  const [backupProjectFocus, setBackupProjectFocus] = useState<WorkspaceProject | null>(null);
  const titlebarTabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const restorePanelTask = (event: Event) => {
      const ownerPageId = (event as CustomEvent<{ ownerPageId?: string }>).detail?.ownerPageId;
      const page = projectPages.find(item => item.id === ownerPageId);
      if (!page) return;
      activatePage(page.id);
      if (page.project) {
        setSelectedProject(page.project); setProjectDestination(page.project.path); setActiveTab('project');
      } else if (page.kind === 'inspiration') {
        setSelectedProject(null); setProjectDestination(null); setActiveTab('inspiration');
      }
    };
    window.addEventListener('photoflow:restore-panel-task', restorePanelTask);
    return () => window.removeEventListener('photoflow:restore-panel-task', restorePanelTask);
  }, [activatePage, projectPages]);
  const handleComponentSettingsPagesChanged = useCallback((pages: ComponentSettingsPageContribution[]) => {
    setSettingsSection(current => current.startsWith('component:') && !pages.some(page => componentSettingsSectionKey(page) === current) ? 'components' : current);
  }, []);
  const { components, componentInstallPath, componentsLoading, componentSettingsPages, refreshComponents, handleComponentsChanged } = useComponentCatalog({
    onError: showNotice,
    onSettingsPagesChanged: handleComponentSettingsPagesChanged,
  });
  const selectedComponentSettingsPage = useMemo(() => componentSettingsPages.find(page => componentSettingsSectionKey(page) === settingsSection), [componentSettingsPages, settingsSection]);
  const reportComponentSettingsError = useCallback((message: string) => showNotice(`打开组件设置页失败：${message}`), [showNotice]);
  const installedComponentIds = useMemo(() => new Set(components.filter(component => component.installed && component.enabled !== false).map(component => component.id)), [components]);
  const videoToolsAvailable = useMemo(() => componentCapabilityIsAvailable(components, 'media.video.processing'), [components]);
  const advancedVideoPlaybackAvailable = useMemo(() => componentCapabilityIsAvailable(components, 'media.video.playback.advanced'), [components]);
  const componentHost = useComponentPages({ browserPages: projectPages, components, initialPage: nativeSeed?.transfer?.componentPage, catalogReady: !componentsLoading, onProjectFallback: page => { activatePage(page.id); if (page.project) { setSelectedProject(page.project); setProjectDestination(page.project.path); setActiveTab('project'); } else if (page.kind === 'inspiration') { setSelectedProject(null); setProjectDestination(null); setActiveTab('inspiration'); } }, onHomeFallback: () => { setSelectedProject(null); setProjectDestination(null); setActiveTab('home'); } });
  const { actions: componentHostActions, contributions: componentContributions, pages: componentPages, activeIdentity: activeComponentPageIdentity } = componentHost;

  const componentBootStarted = useRef(false);
  useNativeProjectSynchronization(nativeTabsEnabled, [...projectPages.flatMap(page => page.project ? [page.project] : []), ...(selectedProject ? [selectedProject] : [])], config?.workspacePath || '', next => {
    updateProject(next); setSelectedProject(current => current?.id === next.id ? next : current);
    if (nativeSeed?.kind === 'component' && nativeSeed.project?.id === next.id && nativeSeed.action && componentBootStarted.current && next.availability !== 'missing') {
      void componentHost.open(nativeSeed.action, next, nativeSeed.workspacePath || '', 'home', nativeSeed.scope);
    }
  });
  useEffect(() => {
    if (nativeSeed?.transfer?.componentPage || nativeSeed?.kind !== 'component' || !configLoaded || componentsLoading || !components.length || componentBootStarted.current) return;
    componentBootStarted.current = true;
    if (nativeSeed.action && nativeSeed.project) {
      void componentHost.open(nativeSeed.action, nativeSeed.project, nativeSeed.workspacePath || '', 'home', nativeSeed.scope)
        .then(opened => { if (!opened) showNotice('组件页面未能打开，请关闭标签页后重试', 'error'); })
        .catch(error => showNotice(String(error.message || error), 'error'));
    }
  }, [componentHost.open, configLoaded, componentsLoading, components.length, nativeSeed, showNotice]);
  useEffect(() => {
    if (!nativeTabsEnabled || initialWindow?.sharedTabs) return;
    const page = projectPages[0];
    const label = page ? (page.project?.name || '灵感库') + (page.currentRelativePath ? ' · ' + page.currentRelativePath.split('/').filter(Boolean).pop() : '') : nativeSeed?.kind === 'component' && selectedProject ? `${nativeSeed.action?.label || '组件'} · ${selectedProject.name}` : nativeSeed?.label;
    if (label) void window.electronAPI.workspaceWindows!.update(label).catch(() => undefined);
  }, [nativeTabsEnabled, nativeSeed?.label, nativeSeed?.kind, nativeSeed?.action?.label, projectPages, selectedProject]);

  useSidebarWidthPersistence(sidebarWidth);
  useBackgroundTaskDrawerWidthPersistence(backgroundTaskDrawerWidth);

  useEffect(() => { if (activeTab !== 'component') void componentHost.deactivate(); }, [activeTab, componentHost.deactivate]);

  const previousInspirationRootRef = useRef<string>(); const previousInspirationPinnedRef = useRef<boolean>();
  useEffect(() => {
    if (!configLoaded || !config) return;
    const rootPath = config.inspirationLibrary.rootPath.trim();
    if (nativeTabsEnabled) {
      if (initialWindow?.root && config.pinInspirationLibrary && (previousInspirationRootRef.current !== rootPath || previousInspirationPinnedRef.current !== true)) requestInspirationPath(rootPath, '');
      previousInspirationRootRef.current = rootPath; previousInspirationPinnedRef.current = config.pinInspirationLibrary;
      return;
    }
    const previousRootPath = previousInspirationRootRef.current;
    const rootChanged = previousInspirationRootRef.current !== rootPath;
    const pinChanged = previousInspirationPinnedRef.current !== config.pinInspirationLibrary;
    previousInspirationRootRef.current = rootPath;
    previousInspirationPinnedRef.current = config.pinInspirationLibrary;
    if (!rootChanged) {
      if (pinChanged && config.pinInspirationLibrary) ensureInspirationRoot(rootPath);
      return;
    }
    const previousInspirationProjectId = previousRootPath ? `inspiration:${previousRootPath}` : '';
    const activeWasInspiration = projectPages.some(page => page.id === activePageId && page.kind === 'inspiration')
      || componentPages.some(page => page.identity === activeComponentPageIdentity && page.projectId === previousInspirationProjectId);
    if (previousInspirationProjectId) componentHost.disposeProject(config.workspacePath, previousInspirationProjectId);
    resetInspirationPages(rootPath, config.pinInspirationLibrary);
    if (activeWasInspiration) { setSelectedProject(null); setActiveTab(config.pinInspirationLibrary ? 'inspiration' : 'home'); }
  }, [activeComponentPageIdentity, activePageId, componentHost.disposeProject, componentPages, config, configLoaded, ensureInspirationRoot, projectPages, resetInspirationPages]);

  const { titlebarTabScroll, titlebarTabDragProps, scrollTitlebarTabs, handleTitlebarTabWheel } = useTitlebarTabScroll({
    nativeRevision: nativeWindow?.revision,
    tabsRef: titlebarTabsRef,
    componentPages,
    configLoaded,
    activeTab,
    activePageId,
    projectPages,
    pinInspirationLibrary: config?.pinInspirationLibrary,
    searchAllTabOpen,
    settingsTabOpen,
    workspaceToolTabs,
  });

  const viewportWidth = useViewportWidth();

  useEffect(() => {
    if (nativeTabsEnabled && !initialWindow?.root || !config?.mediaCache.autoCleanup30Days || cacheCleanupCheckedRef.current) return;
    const storageKey = 'photoflow:maintenance:cache-cleanup-date';
    const today = localDateKey();
    if (window.localStorage.getItem(storageKey) === today) {
      cacheCleanupCheckedRef.current = true;
      return;
    }
    cacheCleanupCheckedRef.current = true;
    const timer = window.setTimeout(() => {
      void window.electronAPI.clearMediaCache(config.mediaCache, 30, { origin: 'daily-auto' }).then(result => {
        if (result.success) window.localStorage.setItem(storageKey, today);
      });
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [config?.mediaCache.autoCleanup30Days, config?.mediaCache.directory, config?.mediaCache.maxSizeGB]);
  // Keep the user's preferred width untouched while the window is compact.
  // The rendered width may shrink temporarily and returns automatically when
  // the window is enlarged again.
  const renderedSidebarWidth = clampNumber(sidebarWidth, 128, Math.min(420, Math.max(128, viewportWidth - 700)));
  const backgroundTaskDrawerMaximumWidth = Math.min(BACKGROUND_TASK_DRAWER_MAX_WIDTH, Math.max(BACKGROUND_TASK_DRAWER_MIN_WIDTH, viewportWidth - (sidebarCollapsed ? 0 : renderedSidebarWidth) - 420));
  const renderedBackgroundTaskDrawerWidth = clampNumber(backgroundTaskDrawerWidth, BACKGROUND_TASK_DRAWER_MIN_WIDTH, backgroundTaskDrawerMaximumWidth);

  useEffect(() => {
    const showTextCopyNotice = (event: ClipboardEvent) => {
      const target = event.target;
      let selectedText = event.clipboardData?.getData('text/plain') || '';
      if (!selectedText && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        const selectionStart = target.selectionStart ?? 0;
        const selectionEnd = target.selectionEnd ?? selectionStart;
        selectedText = target.value.slice(selectionStart, selectionEnd);
      }
      if (!selectedText) selectedText = window.getSelection()?.toString() || '';
      if (selectedText) showNotice('成功复制文字');
    };
    window.addEventListener('copy', showTextCopyNotice);
    return () => window.removeEventListener('copy', showTextCopyNotice);
  }, [showNotice]);

  useRendererErrorReporting(showNotice);


  useEffect(() => {
    if (!configLoaded || workspaceWindowStartup()) return;
    const getConsentState = window.electronAPI?.getPrivacyConsentState;
    if (window.electronAPI?.apiContractVersion !== 1 || typeof getConsentState !== 'function') {
      setPrivacyConsentRequired(true);
      setPrivacyStateLoaded(true);
      showNotice('组件版本不一致。请重启软件，仍无效时重新安装。');
      return;
    }
    void getConsentState().then(state => {
      setPrivacyConsentRequired(state.privacyNoticeVersion !== state.currentPrivacyNoticeVersion || state.termsVersion !== state.currentTermsVersion);
    }).catch(() => setPrivacyConsentRequired(true)).finally(() => setPrivacyStateLoaded(true));
  }, [configLoaded, showNotice]);

  useEffect(() => {
    if (!configLoaded) return;
    window.electronAPI?.trackTelemetry?.('feature_opened', { feature: activeTab });
  }, [activeTab, configLoaded]);

  const refreshBackupStatus = useCallback(async () => {
    if (!config?.workspacePath) return;
    const next = await window.electronAPI.getBackupStatus(config.workspacePath);
    setBackupStatus(next);
  }, [config?.workspacePath]);

  useEffect(() => {
    if (!configLoaded || !config?.workspacePath) return;
    void window.electronAPI.recoverMediaWorkflowImports(config.workspacePath).then(result => { if (result.failures.length) showNotice('媒体已导入，部分关系将在下次启动时重试恢复。'); }).catch(() => undefined); void refreshBackupStatus();
    if ((!nativeTabsEnabled || initialWindow?.root) && config.backup.enabled && config.backup.automaticDaily) void window.electronAPI.runBackupIfDue(config.workspacePath);
  }, [configLoaded, config?.workspacePath, config?.backup.enabled, config?.backup.automaticDaily, config?.backup.targetPath, refreshBackupStatus, showNotice]);

  useEffect(() => window.electronAPI.onBackgroundTaskChanged(delta => {
    for (const task of delta.upserts) {
      if (task.type === 'workspace-backup' || task.type === 'backup-verify' || task.type.endsWith('-restore')) void refreshBackupStatus();
      const operation = String(task.metadata?.operation || '');
      const importStage = String(task.metadata?.importStage || '');
      if (nativeTabsEnabled && !initialWindow?.root || !config?.backup.enabled || !config.backup.afterImport || task.state !== 'completed' || !operation.startsWith('import') || importStage === 'plan') continue;
      if (autoBackedUpImportTasksRef.current.has(task.id)) continue;
      autoBackedUpImportTasksRef.current.add(task.id);
      void window.electronAPI.runBackup(config.workspacePath, 'after-import');
    }
  }), [config?.backup.enabled, config?.backup.afterImport, config?.workspacePath, refreshBackupStatus]);

  useEffect(() => {
    if (!config) return;

    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const isDark = config.theme === 'dark' || (config.theme === 'system' && systemTheme.matches);
      document.documentElement.classList.toggle('dark', isDark);
      window.electronAPI?.setTheme?.(isDark ? 'dark' : 'light');
    };

    applyTheme();
    systemTheme.addEventListener('change', applyTheme);
    return () => systemTheme.removeEventListener('change', applyTheme);
  }, [config?.theme]);
  useEffect(() => {
    if (window.electronAPI?.onUpdateAvailable) {
      const cleanup = window.electronAPI.onUpdateAvailable(info => {
        console.log("Update available:", info);
        setUpdateInfo({ ...info, mandatory: info.mandatory === true });
      });
      return cleanup;
    }
  }, []);

  useEffect(() => {
    if (config?.homeOrder?.length) setHomeOrder(config.homeOrder);
  }, [config?.homeOrder]);

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      if (!target?.closest('[data-photoflow-file-surface="true"]')) return;
      event.preventDefault();
      const undoWorkspacePath = activeTab === 'inspiration' ? config?.inspirationLibrary.rootPath : selectedProject?.workspacePath || config?.workspacePath;
      let result = await window.electronAPI.undoLastRename(undoWorkspacePath);
      let restoreDecisionAttempts = 0;
      while (result.requiresDecision?.kind === 'restore-conflict') {
        if (restoreDecisionAttempts >= 3) { showNotice('原位置占用状态持续变化，请稍后重试撤销', 'warning'); return; }
        restoreDecisionAttempts += 1;
        const decision = result.requiresDecision;
        const policy = await appDialog.choice({
          title: '原位置已有同名项目',
          message: decision.message,
          detail: decision.detail,
          choices: [
            { value: 'rename', label: '改名恢复' },
            { value: 'overwrite', label: '覆盖恢复', tone: 'danger' },
          ],
          defaultValue: 'rename',
        });
        if (policy !== 'rename' && policy !== 'overwrite') { showNotice('已取消撤销'); return; }
        result = await window.electronAPI.undoLastRename(undoWorkspacePath, { restoreConflictPolicy: policy, decisionToken: decision.decisionToken });
      }
      if (result.requiresDecision) { showNotice('撤销仍需确认，请稍后重试', 'warning'); return; }
      showNotice(result.success ? (result.message || '\u5df2\u64a4\u9500\u4e0a\u4e00\u6b21\u91cd\u547d\u540d') : (result.error || '\u6682\u65e0\u53ef\u64a4\u9500\u7684\u91cd\u547d\u540d'), result.success ? 'success' : 'error');
      if (result.success) {
        if (result.project) {
          openProjectTab(result.project, null, selectedProject?.path);
        }
        window.dispatchEvent(new Event('workspace-projects-changed'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab, appDialog, config?.inspirationLibrary.rootPath, config?.workspacePath, showNotice, selectedProject?.path, selectedProject?.workspacePath]);

  const reorderHomeCards = (target: HomeCardId) => {
    if (!draggedHomeCard || draggedHomeCard === target) return;
    const next = [...homeOrder];
    const from = next.indexOf(draggedHomeCard);
    const to = next.indexOf(target);
    next.splice(from, 1);
    next.splice(to, 0, draggedHomeCard);
    setHomeOrder(next);
    if (config) handleConfigUpdate({ ...config, homeOrder: next });
  };
  const handleConfigUpdate = async (newConfig: AppConfig, options?: { applyAfterSave?: boolean }) => {
    if (!options?.applyAfterSave) setConfig(newConfig);
    try {
      if (window.electronAPI?.saveConfig) {
        const result = await window.electronAPI.saveConfig(newConfig);
        if (result.success) {
          const savedConfig = result.savedConfig || newConfig;
          if (options?.applyAfterSave) setConfig(savedConfig);
          else setConfig(current => current ? { ...current, componentSettings: savedConfig.componentSettings, componentSettingsRevisions: savedConfig.componentSettingsRevisions } : savedConfig);
          console.log('✅ Configuration saved successfully');
          return true;
        } else {
          window.electronAPI.reportRendererError('保存设置失败', result.error);
          showNotice(`保存设置失败：${result.error || '未知错误'}`);
          return false;
        }
      }
      if (options?.applyAfterSave) setConfig(newConfig);
      return true;
    } catch (error) {
      window.electronAPI.reportRendererError('保存设置异常', error instanceof Error ? error.stack : String(error));
      showNotice(`保存设置失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const getDefaultSettings = useCallback(async () => {
    const userPath = await window.electronAPI.getUserPath().catch(() => '');
    const defaults = DEFAULT_CONFIG(userPath || '');
    return { ...defaults, telemetry: config?.telemetry || defaults.telemetry, workspacePath: config?.workspacePath || '', workspacePaths: config?.workspacePaths || [], usagePreferencesVersion: config?.usagePreferencesVersion || USAGE_PREFERENCES_VERSION };
  }, [config?.telemetry, config?.usagePreferencesVersion, config?.workspacePath, config?.workspacePaths]);

  const handleWorkspaceSetup = async (newConfig: AppConfig) => {
    await handleConfigUpdate(newConfig);
    if (newConfig.workspacePath.trim()) setShowWorkspaceSetup(false);
  };
  const acceptInternalBetaPrivacy = async (joinExperienceProgram: boolean) => {
    if (!config) return;
    const consent = await window.electronAPI.savePrivacyConsent({ acceptCore: true, experienceProgramGranted: joinExperienceProgram });
    if (!consent.success) {
      showNotice(`保存隐私确认失败：${consent.error || '未知错误'}`);
      return;
    }
    const saved = await handleConfigUpdate({ ...config, telemetry: { enabled: joinExperienceProgram, crashReports: joinExperienceProgram } });
    if (saved) setPrivacyConsentRequired(false);
  };
  const openProjectTab = (project: WorkspaceProject, operation: 'import' | 'broll' | 'match' | null = null, replacePath?: string) => {
    if (replacePath !== undefined) {
      updateProject(project);
      setWorkspaceToolTabs(current => current.map(tab => tab.projectId === project.id ? { ...tab, projectPath: project.path } : tab));
      setSelectedProject(current => current?.id === project.id ? project : current);
      if (projectPages.some(page => page.id === activePageId && page.projectId === project.id)) setProjectDestination(project.path);
      return;
    }
    if (nativeTabsEnabled) {
      openNativeWorkspaceTab(nativeProjectSeed({ kind: 'project', projectId: project.id, project, currentRelativePath: '', initialRelativePath: '', operation })); return;
    }
    const rootPage = projectPages.find(page => page.projectId === project.id && page.currentRelativePath === '');
    if (projectPages.some(page => page.projectId === project.id)) updateProject(project);
    if (rootPage) activatePage(rootPage.id);
    else createPage({ kind: 'project', projectId: project.id, project, currentRelativePath: '', initialRelativePath: '', operation });
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project');
  };
  const activateProjectPage = (pageId: string) => {
    const page = projectPages.find(candidate => candidate.id === pageId);
    if (!page?.project) return;
    activatePage(pageId);
    setSelectedProject(page.project);
    setProjectDestination(page.project.path);
    setActiveTab('project');
  };
  const selectSidebarProjectPage = (project: WorkspaceProject, replacePath?: string) => {
    if (replacePath !== undefined) {
      openProjectTab(project, null, replacePath);
      return;
    }
    if (nativeTabsEnabled) { openProjectTab(project); return; }
    selectSidebarProject(project);
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project');
  };
  const openProjectDirectoryPage = (project: WorkspaceProject, initialRelativePath: string) => {
    if (nativeTabsEnabled) { openNativeWorkspaceTab(nativeProjectSeed({ kind: 'project', projectId: project.id, project, currentRelativePath: initialRelativePath, initialRelativePath, operation: null }), false); return; }
    createPage({ kind: 'project', projectId: project.id, project, currentRelativePath: initialRelativePath, initialRelativePath, operation: null });
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project');
  };
  useEffect(() => window.electronAPI.onComponentProjectDirectoryOpenRequested(request => {
    void (async () => {
      let project = projectPages.find(page => page.projectId === request.projectId && page.project)?.project || null;
      if (!project) {
        const result = await window.electronAPI.getWorkspaceProjects(request.workspacePath);
        const matched = result.success
          ? result.statuses.flatMap(group => group.projects).find(candidate => candidate.id === request.projectId)
          : undefined;
        if (matched) project = { ...matched, workspacePath: result.root || request.workspacePath };
      }
      if (!project) {
        showNotice(`无法在软件内打开“${request.projectName}”的任务文件夹`, 'error');
        return;
      }
      if (nativeTabsEnabled) { openNativeWorkspaceTab(nativeProjectSeed({ kind: 'project', projectId: project.id, project, currentRelativePath: request.relativePath, initialRelativePath: request.relativePath, operation: null }), false); return; }
      createPage({ kind: 'project', projectId: project.id, project, currentRelativePath: request.relativePath, initialRelativePath: request.relativePath, operation: null });
      setSelectedProject(project);
      setProjectDestination(project.path);
      setActiveTab('project');
    })().catch(error => showNotice(`打开任务文件夹失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }), [createPage, projectPages, showNotice]);
  const openWorkspaceToolTab = (ownerPageId: string, project: WorkspaceProject, kind: WorkspaceToolKind, label: string, version?: WorkspaceWindowSeed['version']) => {
    if (nativeTabsEnabled && version) { openNativeWorkspaceTab({ kind: 'version', label, project, workspacePath: project.workspacePath || config?.workspacePath, version, key: `version:${project.id}:${version.entry.relativePath}` }); return; }
    setWorkspaceToolTabs(current => {
      const existing = current.find(tab => tab.ownerPageId === ownerPageId && tab.kind === kind);
      return existing
        ? current.map(tab => tab === existing ? { ...tab, projectId: project.id, projectPath: project.path, label } : tab)
        : [...current, { ownerPageId, projectId: project.id, projectPath: project.path, kind, label, busy: false }];
    });
    activatePage(ownerPageId);
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project-version');
  };
  const activateWorkspaceToolTab = (tab: WorkspaceToolTab, project: WorkspaceProject) => {
    activatePage(tab.ownerPageId);
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project-version');
  };
  const activateComponentPageTab = (page: typeof componentPages[number]) => {
    const browserPage = projectPages.find(candidate => candidate.projectId === page.projectId);
    if (browserPage?.project) { setSelectedProject(browserPage.project); setProjectDestination(browserPage.project.path); }
    else if (browserPage?.kind === 'inspiration') { setSelectedProject(null); setProjectDestination(null); }
    componentHost.activate(page); setActiveTab('component');
  };
  const openComponentPage = async (action: ComponentHostAction, project: WorkspaceProject, workspacePath: string, scope?: ComponentPageOpenScope) => {
    if (nativeTabsEnabled) { openNativeWorkspaceTab({ kind: 'component', label: `${action.label} · ${project.name}`, action, project, workspacePath, scope, key: `component:${workspacePath}:${project.id}:${action.componentId}:${action.pageId}:${scope?.scopeRelativePath || ''}` }); return; }
    const insertAfterTabId = activeTab === 'home' ? 'home'
      : activeTab === 'settings' ? 'settings'
        : activeTab === 'component' && activeComponentPageIdentity ? componentTabId(activeComponentPageIdentity)
          : activeTab === 'project-version' && activePageId ? workspaceToolTabId(activePageId, 'version')
            : activeTab === 'inspiration' && activePageId ? inspirationTabId(activePageId)
              : activePageId ? projectTabId(activePageId) : 'home';
    if (scope?.contentKind === 'inspiration') { setSelectedProject(null); setProjectDestination(null); }
    else { setSelectedProject(project); setProjectDestination(project.path); }
    setActiveTab('component');
    if (!await componentHost.open(action, project, workspacePath, insertAfterTabId, scope)) setActiveTab(scope?.contentKind === 'inspiration' ? 'inspiration' : 'project');
  };
  const closeComponentPageTab = (page: typeof componentPages[number]) => componentHost.close(page);
  const disposeProjectComponentPages = componentHost.disposeProject;
  const closeWorkspaceToolTab = async (ownerPageId: string, kind: WorkspaceToolKind) => {
    setWorkspaceToolTabs(current => current.filter(item => item.ownerPageId !== ownerPageId || item.kind !== kind));
    const closingActiveTab = activePageId === ownerPageId
      && activeTab === 'project-version';
    if (closingActiveTab) setActiveTab('project');
  };
  const showHomeTab = () => {
    if (nativeTabsEnabled && nativeSeed?.kind !== 'home') { openNativeWorkspaceTab({ kind: 'home', label: '主页', key: 'home' }); return; }
    setSelectedProject(null); setProjectDestination(null); setActiveTab('home');
  };
  const openSearchAllTab = () => {
    if (nativeTabsEnabled) { openNativeWorkspaceTab({ kind: 'search-all', label: '全局搜索', key: 'search-all' }); return; }
    setSearchAllTabOpen(true);
    setSelectedProject(null);
    setProjectDestination(null);
    setActiveTab('search-all');
  };
  const closeSearchAllTab = () => {
    setSearchAllTabOpen(false);
    if (activeTab === 'search-all') showHomeTab();
  };
  const openGlobalSearchFolder = (source: GlobalSearchSource, relativePath: string) => {
    if (source.kind === 'inspiration') {
      if (nativeTabsEnabled) { requestInspirationPath(source.workspacePath, relativePath); return; }
      requestInspirationPath(source.workspacePath, relativePath);
      setSelectedProject(null);
      setProjectDestination(null);
      setActiveTab('inspiration');
      return;
    }
    openProjectDirectoryPage(source.project, relativePath);
  };
  const openInspirationTab = () => {
    if (!config) return;
    requestInspirationPath(config.inspirationLibrary.rootPath.trim(), '');
    if (nativeTabsEnabled) return;
    setSelectedProject(null);
    setActiveTab('inspiration');
  };
  const disposePageOwnedUi = useCallback((pageIds: string[]) => {
    if (!pageIds.length) return; const pageIdSet = new Set(pageIds);
    for (const pageId of pageIds) dismissPanelTasksByOwnerPageId(pageId);
    setWorkspaceToolTabs(current => current.filter(tab => !pageIdSet.has(tab.ownerPageId)));
  }, [dismissPanelTasksByOwnerPageId]);
  const closeInspirationTab = (pageId: string) => {
    const page = projectPages.find(candidate => candidate.id === pageId);
    if (!page || page.kind !== 'inspiration') return;
    if (config?.pinInspirationLibrary && page.currentRelativePath === '' && !projectPages.some(candidate => candidate.kind === 'inspiration' && candidate.id !== pageId && candidate.currentRelativePath === '')) return;
    const closingIndex = projectPages.findIndex(candidate => candidate.id === pageId);
    const remaining = projectPages.filter(candidate => candidate.id !== pageId);
    disposePageOwnedUi([pageId]);
    closePage(pageId);
    if (activeTab !== 'inspiration' || activePageId !== pageId) return;
    const nextPage = remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)];
    if (nextPage?.kind === 'inspiration') { setSelectedProject(null); setProjectDestination(null); setActiveTab('inspiration'); }
    else if (nextPage?.project) { setSelectedProject(nextPage.project); setProjectDestination(nextPage.project.path); setActiveTab('project'); }
    else showHomeTab();
  };
  const activateInspiration = () => {
    setSelectedProject(null);
    setProjectDestination(null);
    setActiveTab('inspiration');
  };
  const { navigationRequests: browserNavigationRequests, openInNewTab: openInspirationDirectoryPage, navigateCurrent: navigateInspiration, sourceDragActive: folderTabSourceDragActive, dropProps: folderTabDropProps } = useFolderTabNavigation({ rootPath: config?.inspirationLibrary.rootPath.trim() || '', pages: projectPages, activePageId, createPage, requestInspirationPath, activateInspiration, openProjectInNewTab: project => openProjectDirectoryPage(project, '') });
  const openSettingsTab = async () => {
    if (nativeTabsEnabled) { openNativeWorkspaceTab({ kind: 'settings', label: '设置', key: 'settings', settingsSection }); return; }
    if (activeTab === 'component') await componentHost.deactivate(); setSettingsTabOpen(true);
    setActiveTab('settings');
  };
  const openBackupSettings = (project?: WorkspaceProject) => {
    setBackupProjectFocus(project || null);
    setSettingsSection('backup');
    if (nativeTabsEnabled) { openNativeWorkspaceTab({ kind: 'settings', label: '备份设置', key: 'settings:backup', settingsSection: 'backup', project }); return; }
    openSettingsTab();
  };
  const closeSettingsTab = () => {
    setSettingsTabOpen(false);
    if (activeTab === 'settings') showHomeTab();
  };
  const closeProjectTab = async (pageId: string, _force = false) => {
    const page = projectPages.find(candidate => candidate.id === pageId);
    if (!page?.project) return;
    const remaining = projectPages.filter(candidate => candidate.id !== pageId);
    const closingIndex = projectPages.findIndex(candidate => candidate.id === pageId);
    disposePageOwnedUi([pageId]);
    closePage(pageId);
    if ((activeTab !== 'project' && activeTab !== 'project-version') || activePageId !== pageId) return;
    const nextPage = remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)];
    if (nextPage?.project) {
      activatePage(nextPage.id); setActiveTab('project');
      setSelectedProject(nextPage.project); setProjectDestination(nextPage.project.path);
    } else if (nextPage?.kind === 'inspiration') {
      activatePage(nextPage.id);
      setSelectedProject(null);
      setProjectDestination(null);
      setActiveTab('inspiration');
    } else showHomeTab();
  };
  const closeAllPagesForProject = (project: WorkspaceProject) => {
    const closingPageIds = projectPages.filter(page => page.projectId === project.id).map(page => page.id); const activeBelongsToProject = projectPages.some(page => page.id === activePageId && page.projectId === project.id) || componentPages.some(page => page.identity === activeComponentPageIdentity && page.projectId === project.id); const remaining = projectPages.filter(page => page.projectId !== project.id);
    disposePageOwnedUi(closingPageIds);
    disposeProjectComponentPages(project.workspacePath || config?.workspacePath || '', project.id);
    closeProject(project.id);
    if (!activeBelongsToProject) return;
    const nextPage = remaining[0];
    const nextActivation = browserPageActivation(nextPage);
    if (nextPage) activatePage(nextPage.id);
    setSelectedProject(nextActivation.selectedProject);
    setProjectDestination(nextActivation.projectDestination);
    setActiveTab(nextActivation.activeTab);
  };
  const handleHomeImportComplete = async (completion: ImportCompletion) => { if (!config) return;
    const result = await window.electronAPI.finalizeSdImportedProjects(config.workspacePath, completion.projectNames, { moveProjectAfterImport: config.smartImport.autoMoveProjectAfterSdImport, workProjectNames: completion.workProjectNames, importedPathsByProject: completion.importedPathsByProject });
    if (!result.success) { showNotice(`整理导入项目失败：${result.error || '未知错误'}`); return; }
    if (result.failures.length) showNotice(`导入已完成，但有 ${result.failures.length} 个项目的分类更新失败。`);
    else if (result.movedProjects.length) showNotice('导入完成，项目已移入“后期中”。');
    else showNotice('导入完成，项目分类保持不变。');
    if (result.projects.length === 1) openProjectTab(result.projects[0]); window.dispatchEvent(new Event('workspace-projects-changed'));
  };
  // 等待配置加载完成再渲染主界面
  const handleProjectAction = (action: 'import' | 'broll' | 'match', project: WorkspaceProject) => {
    openProjectTab(project, action);
  };
  const windowTabs = useSharedAppTabs({ context: nativeWindow, seed: nativeSeed, projectPages, componentPages, componentHost,
    activeTab, activePageId, selectedProject, activeComponentId: activeComponentPageIdentity, settingsOpen: settingsTabOpen, settingsSection, searchOpen: searchAllTabOpen,
    workspacePath: config?.workspacePath || '', sidebarCollapsed, runningPageIds: new Set(Object.values(panelTasks).filter(task => task.state === 'running' && !task.nativeTabId).map(task => task.ownerPageId)),
    setActiveTab, setSelectedProject, setSettingsOpen: setSettingsTabOpen, setSettingsSection: section => setSettingsSection(section as SettingsSection), setSearchOpen: setSearchAllTabOpen,
    createPage: createLocalPage, activatePage, releasePage: id => { closePage(id); disposePageOwnedUi([id]); }, onError: showNotice });
  const startupSdImportRequest = useStartupSdAutoImport({ enabledAtLaunch: startupSdAutoStart && (!nativeTabsEnabled || initialWindow?.root === true), enabledNow: config?.smartImport.autoStart === true && (!nativeTabsEnabled || initialWindow?.root === true), ready: Boolean(configLoaded && privacyStateLoaded && !privacyConsentRequired && config && !showWorkspaceSetup && config.usagePreferencesVersion >= USAGE_PREFERENCES_VERSION), onStart: showHomeTab });
  if (!configLoaded || !config || !privacyStateLoaded) {
    return (
      <>
      <StartupWindowFrame>
      <div data-application-startup className="flex h-screen w-full items-center justify-center overflow-hidden bg-slate-950 text-white">
        <div className="flex flex-col items-center gap-6 text-center">
          <img src="./app-logo.svg" className="brand-logo h-20 w-20" alt="照片流" />
          <div className="space-y-2">
            <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-500 to-indigo-400 bg-clip-text text-transparent">照片流</h2>
            <p className="text-sm text-slate-400">正在启动…</p>
          </div>
          <span className="win11-spinner" aria-label="正在加载" />
        </div>
      </div>
      </StartupWindowFrame>
      </>
    );
  }
  if (updateInfo?.mandatory) return <StartupWindowFrame><UpdateModal {...updateInfo} onClose={() => undefined}/></StartupWindowFrame>;
  if (privacyConsentRequired) return <StartupWindowFrame><PrivacyConsentPage onAccept={acceptInternalBetaPrivacy}/></StartupWindowFrame>;
  if (config.usagePreferencesVersion < USAGE_PREFERENCES_VERSION) return <StartupWindowFrame><UsagePreferencesOnboarding config={config} onSave={nextConfig => handleConfigUpdate(nextConfig, { applyAfterSave: true })}/></StartupWindowFrame>;

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-slate-50 text-slate-900 font-sans selection:bg-blue-500/30">
      {updateInfo && (
        <UpdateModal
          version={updateInfo.version}
          url={updateInfo.url}
          notes={updateInfo.notes}
          mandatory={updateInfo.mandatory}
          onClose={() => setUpdateInfo(null)}
        />
      )}

      <AppTitlebar
        nativeWindowContext={windowTabs.context}
        nativeWindowActions={nativeWindow?.sharedTabs ? windowTabs.actions : undefined}
        onWindowError={showNotice}
        activeTab={activeTab}
        activePageId={activePageId}
        activeComponentPageIdentity={activeComponentPageIdentity}
        sidebarCollapsed={sidebarCollapsed}
        renderedSidebarWidth={renderedSidebarWidth}
        searchAllTabOpen={searchAllTabOpen}
        settingsTabOpen={settingsTabOpen}
        pinInspirationLibrary={config.pinInspirationLibrary}
        projectPages={projectPages}
        workspaceToolTabs={workspaceToolTabs}
        componentPages={componentPages}
        components={components}
        titlebarTabsRef={titlebarTabsRef}
        titlebarTabScroll={titlebarTabScroll}
        titlebarTabDragProps={titlebarTabDragProps}
        handleTitlebarTabWheel={handleTitlebarTabWheel}
        folderTabDropProps={folderTabDropProps}
        folderTabSourceDragActive={folderTabSourceDragActive}
        onSidebarCollapsedChange={toggleSidebar}
        onScrollTabs={scrollTitlebarTabs}
        onShowHome={showHomeTab}
        onOpenSearch={openSearchAllTab}
        onCloseSearch={closeSearchAllTab}
        onActivateInspiration={pageId => { activatePage(pageId); setSelectedProject(null); setActiveTab('inspiration'); }}
        onCloseInspiration={closeInspirationTab}
        onActivateProject={activateProjectPage}
        onCloseProject={pageId => void closeProjectTab(pageId)}
        onActivateWorkspaceTool={activateWorkspaceToolTab}
        onCloseWorkspaceTool={tab => void closeWorkspaceToolTab(tab.ownerPageId, tab.kind)}
        onActivateComponent={activateComponentPageTab}
        onCloseComponent={page => void closeComponentPageTab(page)}
        onOpenSettings={() => void openSettingsTab()}
        onCloseSettings={closeSettingsTab}
        trailingContent={<>
          <WorkspacePanelMenu pageId={activeTab === 'project' || activeTab === 'inspiration' ? activePageId : null} backgroundOpen={backgroundTaskDrawerOpen} onBackgroundOpenChange={setBackgroundTaskDrawerOpen}/>
          <BackgroundTaskIndicator ownerPageIds={openPageIds} open={backgroundTaskDrawerOpen} onOpenChange={setBackgroundTaskDrawerOpen} drawerHostRef={backgroundTaskDrawerHostRef}/>
          {componentContributions.some(item => item.type === 'application.command') && <div className="app-titlebar-control flex shrink-0 items-center px-2"><ComponentContributionDock contributions={componentContributions.filter(item => item.type === 'application.command')}/></div>}
        </>}
      />

      {showWorkspaceSetup ? <WorkspaceSetupPage config={config} onSave={handleWorkspaceSetup}/> : <div className="flex min-h-0 flex-1">
      {/* Sidebar */}
      <aside style={{ width: sidebarCollapsed ? 0 : renderedSidebarWidth }} className="relative z-30 flex min-w-0 shrink-0 flex-col overflow-hidden bg-white transition-[width] duration-200">
        {activeTab === 'settings' && <SettingsNavigator activeSection={settingsSection} componentPages={componentSettingsPages}
          onSelect={section => { setSettingsSection(section); if (section === 'backup' || section === 'storage') setBackupProjectFocus(null); }}/>
        }
        {projectPages.some(page => page.kind === 'inspiration') && <div className={activeTab === 'inspiration' ? 'contents' : 'hidden'}><InspirationLibraryNavigator active={activeTab === 'inspiration'} rootPath={config.inspirationLibrary.rootPath} targetWorkspacePath={config.workspacePath} currentRelativePath={projectPages.find(page => page.id === activePageId && page.kind === 'inspiration')?.currentRelativePath || ''} onNavigate={navigateInspiration} onOpenInNewTab={openInspirationDirectoryPage} onOpenSettings={openSettingsTab}/></div>}
        {activeTab !== 'settings' && activeTab !== 'inspiration' && <><ProjectNavigator
          workspacePath={config.workspacePath}
          workspacePaths={config.workspacePaths}
          backupEnabled={config.backup.enabled}
          backupStatus={backupStatus}
          autoCleanupDeletedProjectData={config.autoCleanupDeletedProjectData}
          createPlanningFolder={config.createPlanningFolder}
          customProjectCategories={config.customProjectCategories}
          projectCategoryOrder={config.projectCategoryOrder}
          selectedProject={selectedProject}
          onSelectProject={(project, replacePath) => selectSidebarProjectPage(project, replacePath)}
          onProjectAction={handleProjectAction}
          onProjectDeleted={closeAllPagesForProject}
          onWorkspacesResolved={workspacePaths => { if (workspacePaths.length) handleConfigUpdate({ ...config, workspacePath: workspacePaths[0], workspacePaths }); }}
          onOpenBackup={openBackupSettings}

        />
        <SidebarSettingsButton onClick={openSettingsTab}/></>}
      </aside>
      {!sidebarCollapsed && <ColumnResizeHandle label="调整项目栏宽度" onDrag={deltaX => setSidebarWidth(width => clampNumber(width + deltaX, 128, 420))}/>}

      {/* Main Content */}
      <main aria-busy={Boolean(windowTabs.transferring)} style={windowTabs.transferring ? { pointerEvents: 'none' } : undefined} onKeyDownCapture={event => { if (windowTabs.transferring) { event.preventDefault(); event.stopPropagation(); } }} className={`relative min-w-0 flex-1 bg-slate-50 ${activeTab.startsWith('project') || activeTab === 'search-all' || activeTab === 'inspiration' || activeTab === 'component' || (activeTab === 'settings' && selectedComponentSettingsPage) ? 'overflow-hidden p-0' : activeTab === 'settings' ? 'overflow-auto p-0' : 'overflow-auto p-8'}`}>
        <div className={activeTab === 'home' ? 'mx-auto max-w-6xl space-y-4' : 'hidden'}>{homeOrder.filter(card => card !== 'birthday' || config.birthdayEnabled).map(card => {
          const dragProps = {
            draggable: true,
            onDragStart: () => setDraggedHomeCard(card),
            onDragEnd: () => setDraggedHomeCard(null),
            onDragOver: (event: React.DragEvent<HTMLButtonElement>) => event.preventDefault(),
            onDrop: (event: React.DragEvent<HTMLButtonElement>) => {
              event.preventDefault();
              reorderHomeCards(card);
              setDraggedHomeCard(null);
            }
          };
          const content = card === 'birthday'
            ? <DashboardView section="birthday" initialBirthdays={startupBirthdays || undefined} workspacePath={config.workspacePath} config={config.smartImport} importDefaults={config.importDefaults} brollConfig={config.brollImport} videoTools={config.videoTools} videoToolsAvailable={videoToolsAvailable} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} dragProps={dragProps}/>
            : card === 'import'
              ? <DashboardView section="import" active={activeTab === 'home'} startupAutoImportRequest={startupSdImportRequest} workspacePath={config.workspacePath} config={config.smartImport} importDefaults={config.importDefaults} brollConfig={config.brollImport} videoTools={config.videoTools} videoToolsAvailable={videoToolsAvailable} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} onImportComplete={handleHomeImportComplete} dragProps={dragProps}/>
              : <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <button type="button" onClick={openInspirationTab} className="group flex min-w-0 items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-5 text-left transition hover:border-blue-400 hover:bg-blue-50 hover:shadow-sm">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><Lightbulb size={22}/></span>
                    <span className="min-w-0 flex-1"><span className="block text-base font-bold text-slate-800">灵感库</span><span className="mt-1 block truncate text-xs text-slate-500">整理和浏览灵感素材</span></span>
                    <ChevronRight size={19} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500"/>
                  </button>
                  <BackupHomeCard status={backupStatus} onOpen={() => openBackupSettings()} onRun={() => { void window.electronAPI.runBackup(config.workspacePath, 'manual').then(result => { if (!result.success) showNotice(result.error || '无法开始备份', 'error'); else void refreshBackupStatus(); }); }}/>
                  <button type="button" onClick={openSearchAllTab} className="group flex min-w-0 items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-5 text-left transition hover:border-blue-400 hover:bg-blue-50 hover:shadow-sm">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Search size={22}/></span>
                    <span className="min-w-0 flex-1"><span className="block text-base font-bold text-slate-800">全局搜索</span><span className="mt-1 block truncate text-xs text-slate-500">检索工作目录和灵感库文件</span></span>
                    <ChevronRight size={19} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500"/>
                  </button>
                </div>;
          return <div key={card} className={draggedHomeCard === card ? 'opacity-40' : undefined}>{content}</div>;
        })}</div>
        {windowTabs.versions.map(tab => tab.seed.version && tab.seed.project && <PageTransferContext.Provider key={tab.id} value={tab.id}><div className={activeTab === 'project-version' && windowTabs.activeVersionId === tab.id ? 'h-full w-full' : 'hidden'}><VersionManager active={activeTab === 'project-version' && windowTabs.activeVersionId === tab.id} entry={tab.seed.version.entry} workspacePath={tab.seed.workspacePath || config.workspacePath} project={tab.seed.project} cacheConfig={config.mediaCache} videoPlaybackSettings={config.videoPlayback} progressId={tab.seed.version.progressId} progressVersionKey={tab.seed.version.progressVersionKey} onNotice={showNotice} onVersionStateChanged={() => window.dispatchEvent(new Event('workspace-projects-changed'))} onClose={() => windowTabs.closeVersion(tab.id)}/></div></PageTransferContext.Provider>)}
        {searchAllTabOpen && <PageTransferContext.Provider value="search-all"><div className={activeTab === 'search-all' ? 'h-full w-full' : 'hidden'}><SearchAllPage active={activeTab === 'search-all'} config={config} onOpenFolder={openGlobalSearchFolder} onNotice={showNotice}/></div></PageTransferContext.Provider>}
        {projectPages.filter(page => page.kind === 'inspiration').map(page => { const active = activeTab === 'inspiration' && activePageId === page.id; return <PageTransferContext.Provider key={page.id} value={page.id}><div className={active ? 'h-full w-full' : 'hidden'}><InspirationLibraryPage pageId={page.id} active={active} initialRelativePath={page.initialRelativePath} navigationRequest={browserNavigationRequests[page.id]} config={config} components={components} componentHostActions={componentHostActions} componentContributions={componentContributions} onOpenComponentPage={openComponentPage} onUpdateConfig={handleConfigUpdate} onDirectoryChange={updatePagePath} onOpenDirectoryPage={openInspirationDirectoryPage}/></div></PageTransferContext.Provider>; })}
        {activeTab === 'settings' && !selectedComponentSettingsPage && <SettingsPage activeSection={settingsSection as BuiltInSettingsSection} backupProjectFocus={backupProjectFocus} onClearBackupProjectFocus={() => setBackupProjectFocus(null)} config={config} components={components} componentInstallPath={componentInstallPath} componentsLoading={componentsLoading} onRefreshComponents={() => refreshComponents(true)} onComponentsChanged={handleComponentsChanged} onSave={handleConfigUpdate} onConfigRestored={setConfig} getDefaultSettings={getDefaultSettings}/>}
        {activeTab === 'settings' && selectedComponentSettingsPage?.renderMode === 'custom' && <ComponentSettingsPageSurface key={`${selectedComponentSettingsPage.componentId}:${selectedComponentSettingsPage.pageId}:${selectedComponentSettingsPage.componentVersion}`} page={selectedComponentSettingsPage} onError={reportComponentSettingsError}/>}
        {activeTab === 'settings' && ['declarative', 'hybrid'].includes(selectedComponentSettingsPage?.renderMode || '') && <ComponentDeclarativeSettingsSurface key={`${selectedComponentSettingsPage!.componentId}:${selectedComponentSettingsPage!.pageId}:${selectedComponentSettingsPage!.componentVersion}`} page={selectedComponentSettingsPage as Extract<ComponentSettingsPageContribution, { renderMode: 'declarative' | 'hybrid' }>}/>}
        {componentPages.map(page => <ComponentPageSurface key={page.identity} page={page} active={activeTab === 'component' && activeComponentPageIdentity === page.identity}/>)}
        {projectPages.filter(page => page.project).map(page => { const project = page.project!;
          const active = (activeTab === 'project' || !nativeWindow?.sharedTabs && activeTab === 'project-version') && activePageId === page.id;
          const activeView = activeTab === 'project-version' ? 'version' : 'project';
          return <PageTransferContext.Provider key={page.id} value={page.id}><div className={active ? 'h-full w-full' : 'hidden'}><ProjectWorkspace
            pageId={page.id}
            active={active}
            activeView={activeView}
            project={project}
            workspacePath={project.workspacePath || config.workspacePath}
            inspirationLibraryRootPath={config.inspirationLibrary.rootPath}
            installedComponentIds={installedComponentIds}
            videoToolsAvailable={videoToolsAvailable}
            advancedVideoPlaybackAvailable={advancedVideoPlaybackAvailable}
            componentHostActions={componentHostActions} componentContributions={componentContributions} onOpenComponentPage={(action, scope) => void openComponentPage(action, project, project.workspacePath || config.workspacePath, scope)}
            videoPlaybackSettings={config.videoPlayback}
            projectToolbar={config.projectToolbar}
            customProjectCategories={config.customProjectCategories}
            projectCategoryOrder={config.projectCategoryOrder}
            progressNamePresets={config.progressNamePresets}
            initialPanel={page.operation}
            initialRelativePath={page.initialRelativePath}
            onDirectoryChange={updatePagePath}
            importConfig={config.smartImport}
            importDefaults={config.importDefaults}
            brollConfig={config.brollImport}
            videoTools={config.videoTools}
            matchConfig={config.smartMatch}
            researchConfig={config.research}
            mediaCacheConfig={config.mediaCache}
            defaultFolderSort={config.defaultFolderSort}
            itemOpenMode={config.itemOpenMode}
            folderAlphabetFilterEnabled={config.folderAlphabetFilterEnabled}
            versionTreeEnabled={config.versionTreeEnabled}
            favoriteDisplayMode={config.favoriteDisplayMode}
            onOpenInspirationPath={navigateInspiration}
            onOpenDirectoryPage={relativePath => openProjectDirectoryPage(project, relativePath)}
            onOpenToolTab={(pageId, kind, label, version) => openWorkspaceToolTab(pageId, project, kind, label, version)}
            onCloseToolTab={(pageId, kind) => void closeWorkspaceToolTab(pageId, kind)}
            onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })}
            onMatchConfigChange={(smartMatch: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch })}
            onResearchConfigChange={(research: AppConfig['research']) => handleConfigUpdate({ ...config, research })}
            onProjectMoved={nextProject => {
              nextProject = { ...nextProject, workspacePath: project.workspacePath || config.workspacePath };
              updateProject(nextProject);
              setWorkspaceToolTabs(current => current.map(tab => tab.projectId === project.id ? { ...tab, projectPath: nextProject.path } : tab));
              setSelectedProject(nextProject);
              setProjectDestination(nextProject.path);
              window.dispatchEvent(new Event('workspace-projects-changed'));
            }}
            onDeleted={() => {
              closeAllPagesForProject(project);
              window.dispatchEvent(new Event('workspace-projects-changed'));
            }}
          /></div></PageTransferContext.Provider>;
        })}

        {activeTab === 'match' && <MatchView config={config.smartMatch} projectPath={selectedProject?.path} onUpdateConfig={(newConfig: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch: newConfig })} />}

        {activeTab === 'video_split' && <VideoSplitView />}
      </main>
      {backgroundTaskDrawerOpen && <ColumnResizeHandle
        label="调整后台任务面板宽度"
        value={renderedBackgroundTaskDrawerWidth}
        minimum={BACKGROUND_TASK_DRAWER_MIN_WIDTH}
        maximum={backgroundTaskDrawerMaximumWidth}
        onReset={() => setBackgroundTaskDrawerWidth(BACKGROUND_TASK_DRAWER_DEFAULT_WIDTH)}
        onDrag={deltaX => setBackgroundTaskDrawerWidth(width => clampNumber(width - deltaX, BACKGROUND_TASK_DRAWER_MIN_WIDTH, backgroundTaskDrawerMaximumWidth))}
      />}
      <div ref={backgroundTaskDrawerHostRef} style={{ width: renderedBackgroundTaskDrawerWidth }} className={backgroundTaskDrawerOpen ? 'shrink-0 overflow-hidden bg-white' : 'hidden'}/>
      </div>}
    </div>
  );
};

const RootApp = () => <AppErrorBoundary><App/></AppErrorBoundary>;
export default RootApp;
