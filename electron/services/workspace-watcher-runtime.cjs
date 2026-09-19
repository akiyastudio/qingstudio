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
  let watcher = null;
  let watchedRoot = '';
  let watchTimer = null;
  let reconciliationTimer = null;
  const changes = new Map();
  const knownEntries = new Map();
  const suppressions = new Map();
  const catalogReconciliations = new Map();
  let shutdown = false;

  const comparablePath = value => {
    const resolved = path.resolve(String(value || ''));
    return platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
  };
  const pathIsInside = (parent, candidate) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
  const isSuppressedChange = (root, fileName) => {
    const changedPath = comparablePath(path.resolve(root, String(fileName || '')));
    return [...suppressions].some(([suppressedPath, count]) => count > 0 && pathIsInside(suppressedPath, changedPath));
  };
  const suppressPath = targetPath => {
    const key = comparablePath(targetPath);
    suppressions.set(key, (suppressions.get(key) || 0) + 1);
    for (const changedName of changes.keys()) {
      const candidate = comparablePath(path.resolve(watchedRoot || path.dirname(targetPath), changedName));
      if (pathIsInside(key, candidate)) changes.delete(changedName);
    }
    getFileRootWatcherService()?.discardChangesInside(targetPath);
  };
  const releasePath = (targetPath, delayMs = 750) => {
    const key = comparablePath(targetPath);
    setTimeout(() => {
      const remaining = (suppressions.get(key) || 0) - 1;
      if (remaining > 0) suppressions.set(key, remaining);
      else suppressions.delete(key);
    }, Math.max(0, delayMs));
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
    getWatchedWorkspacePath: () => watchedRoot,
    getProjects: root => catalogs.get(root)?.projects,
    reconcileWorkspaceCatalog: reconcileCatalog,
    writeLog,
  });
  const startReconciliation = root => {
    if (reconciliationTimer) clearInterval(reconciliationTimer);
    reconciliationTimer = setInterval(() => { void reconcileTask.run(root); }, 5 * 60 * 1000);
  };
  const scheduleTrackingScan = (...args) => getMediaTrackingScanScheduler()?.schedule(...args);
  const cancelTrackingScan = (...args) => getMediaTrackingScanScheduler()?.cancel(...args);

  const stop = (stopSchedulers = false) => {
    if (stopSchedulers) shutdown = true;
    const previousRoot = watchedRoot;
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
    watcher?.close();
    watcher = null;
    watchedRoot = '';
    changes.clear();
    knownEntries.clear();
    suppressions.clear();
    if (reconciliationTimer) clearInterval(reconciliationTimer);
    reconciliationTimer = null;
    reconcileTask.reset();
    if (previousRoot) for (const project of catalogs.get(previousRoot)?.projects || []) cancelTrackingScan(previousRoot, project.name);
    if (stopSchedulers) {
      getMediaTrackingScanScheduler()?.stop();
      versionStaleDetectionService.stop();
    }
  };

  const flushChanges = root => {
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
    if (watchedRoot === root && watcher) return;
    stop();
    try {
      watcher = fs.watch(root, { recursive: platform !== 'linux' }, (eventType, fileName) => {
        if (isInternalChange(fileName) || !fileName || isSuppressedChange(root, fileName)) return;
        recordActionableEntry(changes, knownEntries, root, String(fileName), eventType === 'rename' ? 'rename' : 'change', fs);
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => flushChanges(root), 200);
      });
      watcher.on('error', error => {
        writeLog('warn', 'Workspace file watcher stopped', { root, error: error.message || String(error) });
        watcher?.close();
        watcher = null;
        watchedRoot = '';
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) sendToApplicationRenderers(mainWindow, 'workspace-projects-changed', { root });
      });
      watchedRoot = root;
      startReconciliation(root);
    } catch (error) {
      writeLog('warn', 'Unable to watch workspace for file changes', error);
      watchedRoot = root;
      startReconciliation(root);
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
