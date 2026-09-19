const { sendToApplicationRenderers } = require('./application-windows.cjs');
const fs = require('fs');
const path = require('path');
const { describeActionableWatchChanges, forgetMissingWatchChanges, recordActionableWatchEntry } = require('./watch-change-filter.cjs');

const createFileRootWatcherService = ({ getMainWindow, getThumbnailService, getMediaCacheConfig, isInternalChange, isSuppressedChange, writeLog }) => {
  const watchers = new Map();
  const suspendedSnapshots = new Map();
  const staleReleaseCounts = new Map();
  let nextGeneration = 1;
  const foldCase = value => process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  const comparable = value => foldCase(path.resolve(value));
  const comparableText = value => foldCase(String(value || ''));
  const pathIsInside = (parent, candidate) => {
    const relative = path.relative(parent, candidate);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const normalizeBinding = (root, options = {}) => ({
    publishRoot: path.resolve(options.publishRoot || root),
    virtualPrefix: String(options.virtualPrefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    fileNameFilter: options.fileNameFilter ? path.resolve(options.fileNameFilter) : '',
    fileNameFilterKey: options.fileNameFilter ? comparable(options.fileNameFilter) : '',
    virtualFileName: String(options.virtualFileName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    onChanged: options.onChanged,
  });
  const bindingKey = binding => `${comparable(binding.publishRoot)}\0${comparableText(binding.virtualPrefix)}\0${binding.fileNameFilterKey}\0${comparableText(binding.virtualFileName)}`;
  const staleReleaseKey = (rootKey, normalizedBindingKey) => `${rootKey}\0${normalizedBindingKey}`;
  const closeState = state => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    for (const watcher of state.watchers) watcher?.close();
    state.watchers.clear();
    state.watcher = null;
  };
  const publish = (state, changes) => {
    const mainWindow = getMainWindow();
    for (const binding of state.bindings.values()) {
      const publishedEntries = [];
      for (const change of changes) {
        const changedName = path.relative(state.root, change.path);
        const { eventType } = change;
        if (changedName && binding.fileNameFilter && comparable(path.join(state.root, changedName)) !== binding.fileNameFilterKey) continue;
        let publishedChange = change;
        if (!changedName && binding.fileNameFilter) {
          try {
            const stat = fs.statSync(binding.fileNameFilter);
            publishedChange = {
              ...change, path: binding.fileNameFilter, kind: stat.isDirectory() ? 'directory' : 'file',
              observedMtimeMs: Number(stat.mtimeMs) || 0,
              observedSize: stat.isFile() ? Number(stat.size) || 0 : undefined,
            };
          } catch { publishedChange = { ...change, path: binding.fileNameFilter, kind: 'missing' }; }
        }
        const fileName = [binding.virtualPrefix, binding.virtualFileName || changedName].filter(Boolean).join('/').replace(/\\/g, '/');
        publishedEntries.push({ ...publishedChange, fileName, sourcePath: publishedChange.path, ...(state.degraded ? { watcherDegraded: true } : {}) });
        if (mainWindow && !mainWindow.isDestroyed()) sendToApplicationRenderers(mainWindow, 'workspace-files-changed', {
          root: binding.publishRoot, fileName, eventType,
          viaExternalLink: Boolean(binding.virtualPrefix || binding.virtualFileName),
          ...(state.degraded ? { watcherDegraded: true } : {}),
        });
      }
      if (publishedEntries.length && binding.onChanged) {
        try { binding.onChanged(publishedEntries); }
        catch (error) { writeLog('warn', 'Unable to publish file-root tracking changes', { root: state.root, error: error.message || String(error) }); }
      }
    }
  };
  const flush = state => {
    state.timer = null;
    const changes = describeActionableWatchChanges(state.root, [...state.changes], fs);
    state.changes.clear();
    forgetMissingWatchChanges(state.knownEntries, state.root, changes);
    if (!changes.length) return;
    const thumbnailService = getThumbnailService();
    if (thumbnailService) {
      const changedPaths = [...new Set(changes.flatMap(change => {
        if (path.relative(state.root, change.path)) return [change.path];
        const filteredTargets = [...state.bindings.values()].filter(binding => binding.fileNameFilter).map(binding => binding.fileNameFilter);
        const hasFolderBinding = [...state.bindings.values()].some(binding => !binding.fileNameFilter);
        return [...filteredTargets, ...(hasFolderBinding ? [change.path] : [])];
      }))];
      void thumbnailService.syncChangedPaths(state.root, changedPaths, getMediaCacheConfig()).catch(error => {
        writeLog('warn', 'Unable to update file-root thumbnails', { root: state.root, error: error.message || String(error) });
      });
    }
    publish(state, changes);
  };
  const scheduleFlush = state => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => flush(state), 200);
  };
  const failState = (state, error) => {
    if (watchers.get(state.key) !== state) return;
    writeLog('warn', 'File-root watcher stopped', { root: state.root, error: error.message || String(error) });
    for (const [normalizedBindingKey, binding] of state.bindings) {
      const staleKey = staleReleaseKey(state.key, normalizedBindingKey);
      staleReleaseCounts.set(staleKey, (staleReleaseCounts.get(staleKey) || 0) + binding.references);
    }
    closeState(state);
    watchers.delete(state.key);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) for (const binding of state.bindings.values()) {
      sendToApplicationRenderers(mainWindow, 'workspace-files-changed', {
        root: binding.publishRoot, fileName: binding.virtualPrefix, eventType: 'rename', watcherFailed: true, watcherStale: true,
        viaExternalLink: Boolean(binding.virtualPrefix),
      });
    }
  };
  const markDegraded = (state, error, directory = state.root) => {
    if (state.started && watchers.get(state.key) !== state) return;
    state.degraded = true;
    writeLog('warn', 'File-root watcher degraded', { root: state.root, directory, error: error.message || String(error) });
    recordActionableWatchEntry(state.changes, state.knownEntries, state.root, '', 'rename', fs);
    scheduleFlush(state);
  };
  const recordWatchEvent = (state, watchedDirectory, eventType, fileName) => {
    const directoryName = path.relative(state.root, watchedDirectory);
    const rootLevel = fileName == null || String(fileName) === '';
    const changedName = rootLevel ? directoryName : path.join(directoryName, String(fileName));
    if (changedName && (isInternalChange(changedName) || isSuppressedChange(state.root, changedName))) return;
    recordActionableWatchEntry(state.changes, state.knownEntries, state.root, changedName, rootLevel || eventType === 'rename' ? 'rename' : 'change', fs);
    scheduleFlush(state);
    if (state.directoryWatchers && eventType === 'rename') {
      try { syncDirectoryWatchers(state); }
      catch (error) { markDegraded(state, error, watchedDirectory); }
    }
  };
  const addWatcher = (state, directory, recursive) => {
    const watcher = fs.watch(directory, { recursive }, (eventType, fileName) => {
      try { recordWatchEvent(state, directory, eventType, fileName); }
      catch (error) { markDegraded(state, error, directory); }
    });
    watcher.on('error', error => {
      if (!state.directoryWatchers) { failState(state, error); return; }
      watcher.close();
      state.watchers.delete(watcher);
      for (const [key, current] of state.directoryWatchers) if (current === watcher) state.directoryWatchers.delete(key);
      markDegraded(state, error, directory);
    });
    state.watchers.add(watcher);
    if (!state.watcher) state.watcher = watcher;
    return watcher;
  };
  const listDirectories = state => {
    const directories = [state.root];
    for (let index = 0; index < directories.length; index += 1) {
      let entries;
      try { entries = fs.readdirSync(directories[index], { withFileTypes: true }); }
      catch (error) { markDegraded(state, error, directories[index]); continue; }
      for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) directories.push(path.join(directories[index], entry.name));
    }
    return directories;
  };
  function syncDirectoryWatchers(state) {
    if (!state.directoryWatchers || (state.started && watchers.get(state.key) !== state)) return;
    const wanted = new Map(listDirectories(state).map(directory => [comparable(directory), directory]));
    for (const [key, watcher] of state.directoryWatchers) {
      if (wanted.has(key)) continue;
      watcher.close();
      state.watchers.delete(watcher);
      state.directoryWatchers.delete(key);
    }
    for (const [key, directory] of wanted) {
      if (state.directoryWatchers.has(key)) continue;
      try { state.directoryWatchers.set(key, addWatcher(state, directory, false)); }
      catch (error) {
        markDegraded(state, error, directory);
        if (!state.started && key === state.key) throw error;
      }
    }
  }
  const startWatching = state => {
    try {
      // Construction itself probes recursive support; supported Linux Node
      // versions use one watcher, older versions get a watcher per directory.
      addWatcher(state, state.root, true);
    } catch (error) {
      closeState(state);
      if (!['ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'ERR_INVALID_ARG_VALUE'].includes(error?.code)) throw error;
      state.directoryWatchers = new Map();
      syncDirectoryWatchers(state);
    }
    state.started = true;
  };
  const acquire = (rootPath, options = {}) => {
    const root = path.resolve(rootPath);
    const key = comparable(root);
    const normalized = normalizeBinding(root, options);
    const normalizedBindingKey = bindingKey(normalized);
    const existing = watchers.get(key);
    if (existing) {
      const binding = existing.bindings.get(normalizedBindingKey) || { ...normalized, references: 0 };
      if (options.onChanged) binding.onChanged = options.onChanged;
      binding.references += 1;
      existing.bindings.set(normalizedBindingKey, binding);
      existing.references += 1;
      return { success: true, root, watcherGeneration: existing.generation };
    }
    const state = {
      root, key, generation: nextGeneration++, references: 1, watcher: null, watchers: new Set(), directoryWatchers: null,
      timer: null, changes: new Map(), knownEntries: new Map(),
      bindings: new Map([[normalizedBindingKey, { ...normalized, references: 1 }]]), started: false, degraded: false,
    };
    try {
      startWatching(state);
      watchers.set(key, state);
      return { success: true, root, watcherGeneration: state.generation };
    } catch (error) {
      closeState(state);
      writeLog('warn', 'Unable to watch file root', { root, error: error.message || String(error) });
      return { success: false, root, error: error.message || String(error) };
    }
  };
  const release = (rootPath, options = {}) => {
    const root = path.resolve(rootPath);
    const key = comparable(root);
    const normalizedBindingKey = bindingKey(normalizeBinding(root, options));
    const staleKey = staleReleaseKey(key, normalizedBindingKey);
    const staleReferences = staleReleaseCounts.get(staleKey) || 0;
    if (staleReferences > 0) {
      if (staleReferences === 1) staleReleaseCounts.delete(staleKey);
      else staleReleaseCounts.set(staleKey, staleReferences - 1);
      return { success: false, released: false, missing: true, stale: true };
    }
    const state = watchers.get(key);
    if (!state) return { success: false, released: false, missing: true };
    const binding = state.bindings.get(normalizedBindingKey);
    if (!binding || binding.references <= 0) return { success: false, released: false, missing: true };
    binding.references -= 1;
    state.references -= 1;
    if (binding.references <= 0) state.bindings.delete(normalizedBindingKey);
    if (state.references > 0) return undefined;
    closeState(state);
    watchers.delete(state.key);
    return undefined;
  };
  const suspend = rootPath => {
    const key = comparable(rootPath);
    const state = watchers.get(key);
    if (!state) return 0;
    const snapshot = {
      root: state.root,
      references: state.references,
      totalReferences: state.references,
      bindings: [...state.bindings.values()].map(binding => ({
        publishRoot: binding.publishRoot, virtualPrefix: binding.virtualPrefix,
        fileNameFilter: binding.fileNameFilter, virtualFileName: binding.virtualFileName,
        onChanged: binding.onChanged, references: binding.references,
      })),
    };
    suspendedSnapshots.set(key, snapshot);
    closeState(state);
    watchers.delete(key);
    return snapshot.totalReferences;
  };
  const resume = (rootPath, snapshotOrReferences = 1) => {
    if (!snapshotOrReferences || typeof snapshotOrReferences === 'number') {
      const referenceCount = Math.max(0, Number(snapshotOrReferences) || 0);
      if (!referenceCount) return { success: true, root: path.resolve(rootPath) };
      const savedSnapshot = suspendedSnapshots.get(comparable(rootPath));
      if (savedSnapshot && savedSnapshot.totalReferences === referenceCount) return resume(rootPath, savedSnapshot);
      let result;
      for (let index = 0; index < referenceCount; index += 1) {
        result = acquire(rootPath);
        if (!result.success) {
          for (let rollback = 0; rollback < index; rollback += 1) release(rootPath);
          return result;
        }
      }
      return result;
    }
    const acquired = [];
    for (const binding of Array.isArray(snapshotOrReferences.bindings) ? snapshotOrReferences.bindings : []) {
      const options = {
        publishRoot: binding.publishRoot, virtualPrefix: binding.virtualPrefix,
        fileNameFilter: binding.fileNameFilter, virtualFileName: binding.virtualFileName, onChanged: binding.onChanged,
      };
      const references = Math.max(0, Number(binding.references) || 0);
      for (let index = 0; index < references; index += 1) {
        const result = acquire(rootPath, options);
        if (!result.success) {
          for (const item of acquired.reverse()) release(rootPath, item);
          return result;
        }
        acquired.push(options);
      }
    }
    if (!acquired.length && Number(snapshotOrReferences.totalReferences ?? snapshotOrReferences.references) > 0) {
      return resume(rootPath, Number(snapshotOrReferences.totalReferences ?? snapshotOrReferences.references));
    }
    suspendedSnapshots.delete(comparable(rootPath));
    return { success: true, root: path.resolve(rootPath) };
  };
  const discardChangesInside = targetPath => {
    const suppressed = comparable(targetPath);
    for (const state of watchers.values()) for (const changedName of state.changes.keys()) {
      const candidate = comparable(path.resolve(state.root, changedName));
      if (pathIsInside(suppressed, candidate)) state.changes.delete(changedName);
    }
  };
  const stop = () => {
    for (const state of watchers.values()) closeState(state);
    watchers.clear();
    suspendedSnapshots.clear();
    staleReleaseCounts.clear();
  };
  return { acquire, release, suspend, resume, discardChangesInside, stop };
};

module.exports = { createFileRootWatcherService };
