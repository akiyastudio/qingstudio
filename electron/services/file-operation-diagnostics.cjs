const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');

const scope = new AsyncLocalStorage();

// Opt-in diagnostics contain durations and counts only, never file paths or
// clipboard payloads. Nested stages overlap; their durations are not additive.
const appendStage = (record, name, started, success) => {
  if (!record || record.finished) return;
  const stage = record.stages[name] ||= { calls: 0, durationMs: 0, failures: 0 };
  stage.calls += 1;
  stage.durationMs += performance.now() - started;
  if (!success) stage.failures += 1;
};

const measureFileOperationStage = async (name, action) => {
  const record = scope.getStore();
  if (!record || record.finished) return action();
  const started = performance.now();
  let success = false;
  try { const result = await action(); success = result?.success !== false; return result; }
  finally { appendStage(record, name, started, success); }
};

const measureSync = (name, action) => {
  const record = scope.getStore();
  if (!record || record.finished) return action();
  const started = performance.now();
  let success = false;
  try { const result = action(); success = true; return result; }
  finally { appendStage(record, name, started, success); }
};

const instrumentFileOperationContext = context => {
  if (process.env.PHOTOFLOW_FILE_OPERATION_DIAGNOSTICS !== '1') return context;
  const wrapped = { ...context };
  for (const [name, stage] of Object.entries({
    collectCopyPlan: 'copyPlan', copyPlannedFiles: 'copyFiles', copyFileAtomic: 'copyFile',
    movePathAtomic: 'movePath', movePlannedFilesFast: 'nativeCut',
    publishPathNoClobber: 'publish', pushUndoOperation: 'undoIdentity',
    removeCopiedSources: 'removeCopiedSources',
  })) {
    if (typeof context[name] === 'function') wrapped[name] = (...args) => measureFileOperationStage(stage, () => context[name](...args));
  }
  for (const [serviceName, methods] of Object.entries({
    recycleBinService: { trash: 'recycle', trashMany: 'recycleBatch' },
    workspaceRepository: { addUndoRecord: 'undoPersistence' },
    versionService: { snapshotProgress: 'progressSnapshot', listProgress: 'progressList' },
  })) {
    if (!context[serviceName]) continue;
    wrapped[serviceName] = Object.create(context[serviceName]);
    for (const [name, stage] of Object.entries(methods)) {
      if (typeof context[serviceName][name] === 'function') wrapped[serviceName][name] = (...args) => measureFileOperationStage(stage, () => context[serviceName][name](...args));
    }
  }
  if (context.projectVirtualPaths) {
    for (const name of ['resolve']) {
      if (typeof context.projectVirtualPaths[name] === 'function') wrapped.projectVirtualPaths[name] = (...args) => measureSync(name, () => context.projectVirtualPaths[name](...args));
    }
  }
  wrapped.ipcMain = Object.create(context.ipcMain);
  wrapped.ipcMain.handle = (channel, handler) => context.ipcMain.handle(channel, channel !== 'workspace-file-operation' ? handler : async (...args) => {
    const operation = ['copy', 'cut', 'paste', 'trash', 'rename', 'move', 'select', 'import', 'import-url', 'import-data'].includes(args[4]) ? args[4] : 'unknown';
    const record = { requestId: randomUUID(), operation, requestedCount: Array.isArray(args[5]) ? args[5].length : 0, stages: {}, finished: false };
    const started = performance.now();
    return scope.run(record, async () => {
      let success = false;
      try { const result = await handler(...args); success = result?.success === true; return result; }
      finally {
        record.finished = true;
        try { context.writeLog?.('info', 'File operation timing', { requestId: record.requestId, operation: record.operation, requestedCount: record.requestedCount, success, durationMs: performance.now() - started, stages: record.stages }); }
        catch { /* diagnostics must not affect filesystem results */ }
      }
    });
  });
  return wrapped;
};

module.exports = { instrumentFileOperationContext, measureFileOperationStage };
