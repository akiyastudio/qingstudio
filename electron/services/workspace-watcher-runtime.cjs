const { sendToApplicationRenderers } = require('./application-windows.cjs');
const createWorkspaceWatcherRuntime = ({
  fs,
  path,
  platform,
  backgroundTasks,
  catalogs,
  reconcileCatalogDirect,
  getMainWindow,
  getThumbnailService,
  getFileRootWatcherService,
  getMediaCacheConfig,
  getMediaTrackingScanScheduler,
  versionStaleDetectionService,
  isInternalChange,
  describeActionableChanges,
  forgetMissingChanges,
  recordActionableEntry,
  createReconcileTask,
  writeLog,
}) => {
  const workspaces = new Map();
  const suppressions = new Map();
  const suppressionTimers = new Set();
  const catalogReconciliations = new Map();
  let shutdown = false;

  const comparablePath = value => {
    const resolved = path.resolve(String(value || ''));
    return platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
  };
  const pathIsInside = (parent, candidate) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
  const isSuppressedChange = (root, fileName) => {
    const changedPath = comparablePath(path.resolve(root, String(fileName || '')));
    return [...suppressions].some(([suppressedPath, state]) => state.count > 0 && pathIsInside(suppressedPath, changedPath));
  };
  const suppressPath = targetPath => {
    const key = comparablePath(targetPath);
    const state = suppressions.get(key) || { count: 0, targetPath: path.resolve(targetPath) };
    state.count += 1;
    suppressions.set(key, state);
    for (const workspace of workspaces.values()) for (const changedName of workspace.changes.keys()) {
      const candidate = comparablePath(path.resolve(workspace.root, changedName));
      if (pathIsInside(key, candidate)) workspace.changes.delete(changedName);
    }
    getFileRootWatcherService()?.discardChangesInside(targetPath);
  };
  const releasePath = (targetPath, delayMs = 750) => {
    const key = comparablePath(targetPath);
    const state = suppressions.get(key);
    if (!state) return;
    const timer = setTimeout(() => {
      suppressionTimers.delete(timer);
      if (shutdown || suppressions.get(key) !== state) return;
      state.count -= 1;
      if (state.count > 0) return;
      suppressions.delete(key);
      // Native events were intentionally discarded during the mutation. All
      // readers still need a terminal invalidation, including other windows.
      // This is UI-only: mutation producers already schedule precise scans.
      const published = getFileRootWatcherService()?.invalidatePath?.(state.targetPath);
      if (!published) for (const workspace of workspaces.values()) if (pathIsInside(comparablePath(workspace.root), key)) {
        sendToApplicationRenderers(getMainWindow(), 'workspace-files-changed', {
          root: workspace.root, fileName: path.relative(workspace.root, state.targetPath).replace(/\\/g, '/'), eventType: 'rename',
        });
      }
    }, Math.max(0, delayMs));
    suppressionTimers.add(timer);
  };

  const stableCatalogValue = value => Array.isArray(value) ? value.map(stableCatalogValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableCatalogValue(value[key])])) : value;
  const stableCatalogExtra = value => { try { return stableCatalogValue(JSON.parse(value || '{}')); } catch { return value || ''; } };
  const catalogSnapshot = catalog => JSON.stringify((catalog?.projects || []).map(project => ({
    name: project.name, status: project.status, relative_path: project.relative_path,
    filesystem_id: project.filesystem_id, availability: project.availability, missing_since: project.missing_since,
    extra_json: stableCatalogExtra(project.extra_json),
  })).sort((left, right) => `${left.relative_path}\0${left.name}`.localeCompare(`${right.relative_path}\0${right.name}`)));
  const reconcileCatalog = (root, options = {}) => {
    if (shutdown) return Promise.resolve(catalogs.get(root));
    const existing = catalogReconciliations.get(root);
    if (existing) return existing;
    const previousSnapshot = catalogSnapshot(catalogs.get(root));
    const operation = reconcileCatalogDirect(root, options).then(catalog => {
      const mainWindow = getMainWindow();
      if (previousSnapshot !== catalogSnapshot(catalog) && mainWindow && !mainWindow.isDestroyed()) {
        sendToApplicationRenderers(mainWindow, 'workspace-projects-changed', { root, reconciled: true });
      }
      return catalog;
    }).catch(error => {
      if (shutdown) return catalogs.get(root);
      throw error;
    }).finally(() => catalogReconciliations.delete(root));
    catalogReconciliations.set(root, operation);
    return operation;
  };

  const reconcileTask = createReconcileTask({
    backgroundTasks,
    isWorkspaceWatched: root => workspaces.has(comparablePath(root)),
    getProjects: root => catalogs.get(root)?.projects,
    reconcileWorkspaceCatalog: reconcileCatalog,
    writeLog,
  });
  const startReconciliation = workspace => {
    if (workspace.reconciliationTimer) clearInterval(workspace.reconciliationTimer);
    workspace.reconciliationTimer = setInterval(() => { void reconcileTask.run(workspace.root); }, 5 * 60 * 1000);
  };
  const scheduleTrackingScan = (...args) => getMediaTrackingScanScheduler()?.schedule(...args);
  const cancelTrackingScan = (...args) => getMediaTrackingScanScheduler()?.cancel(...args);

  const stop = (stopSchedulers = false) => {
    if (stopSchedulers) shutdown = true;
    for (const workspace of workspaces.values()) {
      clearTimeout(workspace.watchTimer);
      clearInterval(workspace.reconciliationTimer);
      workspace.watcher?.close();
      for (const project of catalogs.get(workspace.root)?.projects || []) cancelTrackingScan(workspace.root, project.name);
    }
    workspaces.clear();
    suppressions.clear();
    for (const timer of suppressionTimers) clearTimeout(timer);
    suppressionTimers.clear();
    reconcileTask.reset();
    if (stopSchedulers) {
      getMediaTrackingScanScheduler()?.stop();
      versionStaleDetectionService.stop();
    }
  };

  const flushChanges = workspace => {
    const { root, changes, knownEntries } = workspace;
    workspace.watchTimer = null;
    if (workspaces.get(comparablePath(root)) !== workspace || shutdown) return;
    const describedChanges = describeActionableChanges(root, [...changes], fs);
    changes.clear();
    forgetMissingChanges(knownEntries, root, describedChanges);
    if (!describedChanges.length) return;
    const changedEntries = describedChanges.map(change => [path.relative(root, change.path), change.eventType]);
    const changedNames = changedEntries.map(([changedName]) => changedName);
    const changedEventTypes = new Map(changedEntries);
    const thumbnailService = getThumbnailService();
    if (thumbnailService) {
      const changesByProject = new Map();
      for (const change of describedChanges) {
        const segments = path.relative(root, change.path).split(/[\\/]/).filter(Boolean);
        if (segments.length < 2) continue;
        const projectRoot = path.join(root, segments[0]);
        if (!changesByProject.has(projectRoot)) changesByProject.set(projectRoot, []);
        changesByProject.get(projectRoot).push(change.path);
      }
      for (const [projectRoot, changedPaths] of changesByProject) {
        void thumbnailService.syncChangedPaths(projectRoot, changedPaths, getMediaCacheConfig()).catch(error => {
          writeLog('warn', 'Unable to update thumbnail index from file watcher', { projectRoot, error: error.message || String(error) });
        });
      }
    }
    const catalog = catalogs.get(root);
    const knownProjectPaths = new Set((catalog?.projects || []).map(project => project.relative_path.toLocaleLowerCase()));
    const changedSegments = changedNames.map(changedName => changedName.split(/[\\/]/).filter(Boolean));
    const catalogRescanNames = new Set(changedEntries.flatMap(([changedName, eventType]) => {
      const segments = changedName.split(/[\\/]/).filter(Boolean);
      const firstSegment = segments[0];
      if (!firstSegment) return [];
      return (segments.length === 1 && eventType === 'rename' || !knownProjectPaths.has(firstSegment.toLocaleLowerCase())) ? [firstSegment] : [];
    }));
    const catalogMayHaveChanged = !changedNames.length || changedSegments.some(segments => segments.length === 1 || !knownProjectPaths.has(String(segments[0] || '').toLocaleLowerCase()));
    const changedProjects = new Set();
    const changedPathsByProject = new Map();
    for (const change of describedChanges) {
      const segments = path.relative(root, change.path).split(/[\\/]/).filter(Boolean);
      if (segments.length < 2) continue;
      const project = catalog?.projects.find(item => item.relative_path.toLocaleLowerCase() === String(segments[0] || '').toLocaleLowerCase());
      if (!project) continue;
      changedProjects.add(project.name);
      if (!changedPathsByProject.has(project.name)) changedPathsByProject.set(project.name, []);
      changedPathsByProject.get(project.name).push(change);
    }
    if (!changedNames.length) for (const project of catalog?.projects || []) changedProjects.add(project.name);
    for (const projectName of changedProjects) scheduleTrackingScan(root, projectName, changedPathsByProject.get(projectName) || [], !changedNames.length);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const changedName of changedNames) sendToApplicationRenderers(mainWindow, 'workspace-files-changed', { root, fileName: changedName, eventType: changedEventTypes.get(changedName) || 'rename' });
    }
    if (catalogMayHaveChanged) {
      void reconcileCatalog(root).then(refreshedCatalog => {
        for (const topLevelName of catalogRescanNames) {
          const project = refreshedCatalog.projects.find(item => item.relative_path.toLocaleLowerCase() === String(topLevelName).toLocaleLowerCase());
          if (project) scheduleTrackingScan(root, project.name, [], true);
        }
      }).catch(error => writeLog('warn', 'Unable to reconcile workspace catalog after file change', { root, error: error.message || String(error) }));
    }
  };

  const watch = root => {
    if (shutdown) return;
    root = path.resolve(root);
    const key = comparablePath(root);
    const existing = workspaces.get(key);
    if (existing?.watcher) return;
    const workspace = existing || { root, watcher: null, watchTimer: null, reconciliationTimer: null, changes: new Map(), knownEntries: new Map() };
    workspaces.set(key, workspace);
    try {
      const watcher = fs.watch(root, { recursive: platform !== 'linux' }, (eventType, fileName) => {
        if (workspaces.get(key) !== workspace || workspace.watcher !== watcher) return;
        if (fileName && (isInternalChange(fileName) || isSuppressedChange(root, fileName))) return;
        recordActionableEntry(workspace.changes, workspace.knownEntries, root, String(fileName || ''), !fileName || eventType === 'rename' ? 'rename' : 'change', fs);
        if (!workspace.watchTimer) workspace.watchTimer = setTimeout(() => flushChanges(workspace), 200);
      });
      workspace.watcher = watcher;
      watcher.on('error', error => {
        if (workspaces.get(key) !== workspace || workspace.watcher !== watcher) return;
        writeLog('warn', 'Workspace file watcher stopped', { root, error: error.message || String(error) });
        watcher.close();
        workspace.watcher = null;
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) sendToApplicationRenderers(mainWindow, 'workspace-projects-changed', { root });
      });
      startReconciliation(workspace);
    } catch (error) {
      writeLog('warn', 'Unable to watch workspace for file changes', error);
      startReconciliation(workspace);
    }
  };

  return {
    watch,
    stop,
    reconcileWorkspaceState: reconcileTask.run,
    reconcileWorkspaceCatalog: reconcileCatalog,
    scheduleMediaTrackingScan: scheduleTrackingScan,
    cancelMediaTrackingScan: cancelTrackingScan,
    suppressWorkspaceWatchPath: suppressPath,
    releaseWorkspaceWatchPath: releasePath,
    isSuppressedWorkspaceChange: isSuppressedChange,
  };
};

module.exports = { createWorkspaceWatcherRuntime };
