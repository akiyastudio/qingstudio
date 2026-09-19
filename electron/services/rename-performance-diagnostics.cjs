const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

// Explicitly restricted to an isolated smoke process. No paths, names, request
// payloads, or business data are recorded; the runner owns private persistence.
const enabled = process.env.PHOTOFLOW_SMOKE_TEST === '1' && process.env.PHOTOFLOW_RENAME_BENCHMARK === '1';
const scope = new AsyncLocalStorage();
const records = [];
const measureSync = (stage, action) => {
  const record = scope.getStore();
  if (!record || record.finished) return action();
  const started = performance.now();
  let success = false;
  try { const result = action(); success = true; return result; }
  finally { record.stages.push({ stage, startMs: started - record.started, durationMs: performance.now() - started, success }); }
};
const measure = async (stage, action) => {
  const record = scope.getStore();
  if (!record || record.finished) return action();
  const started = performance.now();
  let success = false;
  try { const result = await action(); success = result?.success !== false; return result; }
  finally { record.stages.push({ stage, startMs: started - record.started, durationMs: performance.now() - started, success }); }
};
const instrumentRenameContext = context => {
  if (!enabled) return context;
  const wrapped = { ...context };
  for (const name of ['getProjectPath', 'ensureWorkspace', 'suppressWorkspaceWatchPath', 'releaseWorkspaceWatchPath']) {
    if (typeof context[name] === 'function') wrapped[name] = (...args) => measureSync(name, () => context[name](...args));
  }
  if (context.projectVirtualPaths) {
    wrapped.projectVirtualPaths = Object.create(context.projectVirtualPaths);
    for (const name of ['resolve', 'toVirtualPath']) {
      if (typeof context.projectVirtualPaths[name] === 'function') wrapped.projectVirtualPaths[name] = (...args) => measureSync('virtualPath.' + name, () => context.projectVirtualPaths[name](...args));
    }
  }
  for (const [name, stage] of Object.entries({
    publishPathNoClobber: 'nativeRenameIncludingProcessStartup',
    pushUndoOperation: 'undoIdentityCapture',
    refreshWorkspaceCatalog: 'workspaceCatalogRefresh',
  })) {
    if (typeof context[name] === 'function') wrapped[name] = (...args) => measure(stage, () => context[name](...args));
  }
  if (context.versionService) {
    wrapped.versionService = Object.create(context.versionService);
    for (const [name, stage] of Object.entries({
      listProgress: 'registeredProgressQuery',
      snapshotProgress: 'registeredProgressSnapshot',
      beginProgressTreeUpdate: 'progressMutationLease',
      renameProgressFolder: 'progressDatabaseAndFilesystemCommit',
      renameExternalProgressLinkRoute: 'externalProgressCommit',
    })) {
      if (typeof context.versionService[name] === 'function') wrapped.versionService[name] = (...args) => measure(stage, () => context.versionService[name](...args));
    }
  }
  wrapped.ipcMain = Object.create(context.ipcMain);
  wrapped.ipcMain.handle = (channel, handler) => context.ipcMain.handle(channel, async (...args) => {
    const kind = channel === 'workspace-progress-folder-rename' ? 'progress'
      : channel === 'workspace-file-operation' && args[4] === 'rename' ? 'ordinary' : '';
    if (!kind) return handler(...args);
    const record = { kind, started: performance.now(), stages: [], finished: false, success: false };
    if (records.length >= 500) records.shift();
    records.push(record);
    return scope.run(record, async () => {
      try { const result = await handler(...args); record.success = result?.success === true; return result; }
      finally { record.durationMs = performance.now() - record.started; record.finished = true; }
    });
  });
  return wrapped;
};

module.exports = { instrumentRenameContext, measureRenameSync: measureSync, records, enabled };
