const crypto = require('crypto');
const path = require('path');
const { createBatchedSliceMetricsReporter, runSlicedMaintenance } = require('./sliced-maintenance-runner.cjs');

const RECOVERY_TYPE = 'thumbnail-cache-recovery';
const MIGRATION_VERSION = 'thumbnail-cache-migration-v2';
const RECONCILIATION_VERSION = 'thumbnail-reconcile-publications-v1';
const ACTIVE_STATES = new Set(['queued', 'running', 'pausing', 'paused', 'resuming']);
const RECOVERY_SLICE_DEADLINE_MS = 60 * 1000;
const RECOVERY_SLICE_DELAY_MS = 50;
const RECOVERY_INSPECT_LIMIT = 128;
const RECOVERY_DELETE_LIMIT = 64;
// Directory enumeration resolves each cache path while holding the maintenance
// lock. Keep pages small so foreground thumbnail reads/publishes can run between
// pages even on Windows volumes where those metadata calls are comparatively slow.
const RECOVERY_DIRECTORY_INSPECT_LIMIT = 128;
const RECOVERY_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000;
const recoverableStartupFailure = task => /(?:request timed out|deadline exceeded|maintenance deadline)/i.test(String(task?.error || task?.message || ''));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accepted, failed) => { resolve = accepted; reject = failed; });
  return { promise, resolve, reject };
};

const createThumbnailService = ({ pipeline, backgroundTasks, writeLog = pipeline.log || (() => undefined), now = () => Date.now() }) => {
  const recoveryRuns = new Map();
  const startupGeneration = crypto.randomUUID();
  let unregisterRecoveryRestart = null;
  let unregisterGenerateRestart = null;
  let stopped = false;
  let stopPromise = null;
  const recoveryWaits = new Set();

  const recoveryDescriptor = (cacheConfig = {}) => {
    const cacheRoot = path.resolve(pipeline.cacheDirectory(cacheConfig));
    const rootIdentity = process.platform === 'win32' ? cacheRoot.toLocaleLowerCase() : cacheRoot;
    const rootHash = crypto.createHash('sha256').update(rootIdentity).digest('hex');
    const migrationKey = MIGRATION_VERSION;
    const maintenanceKey = `${RECONCILIATION_VERSION}:${rootHash}`;
    return { cacheConfig, cacheRoot, migrationKey, maintenanceKey };
  };

  const startRecovery = (cacheConfig = {}, restartTask = null) => {
    if (stopped) throw Object.assign(new Error('thumbnail service stopped'), { code: 'THUMBNAIL_STOPPED' });
    const descriptor = recoveryDescriptor(cacheConfig);
    const admission = deferred();
    let admitted = false;
    let taskId = restartTask?.id || null;
    const admit = details => {
      if (admitted) return;
      admitted = true;
      admission.resolve({ taskId, maintenanceKey: descriptor.maintenanceKey, ...details });
    };
    const retryFactory = () => startRecovery(cacheConfig);
    const execution = backgroundTasks.start({
      ...(restartTask?.id ? { id: restartTask.id } : {}),
      type: RECOVERY_TYPE,
      title: '修复缩略图缓存索引',
      dedupeKey: `${RECOVERY_TYPE}:${descriptor.maintenanceKey}`,
      notificationPolicy: 'error-only',
      resumePolicy: 'safe-restart',
      cancellable: false,
      metadata: {
        cacheConfig, cacheRoot: descriptor.cacheRoot, migrationVersion: MIGRATION_VERSION,
        reconciliationVersion: RECONCILIATION_VERSION, migrationKey: descriptor.migrationKey, maintenanceKey: descriptor.maintenanceKey,
      },
    }, async task => {
      const cacheRoot = path.resolve(await pipeline.ensureCacheDirectory(cacheConfig));
      if (cacheRoot !== descriptor.cacheRoot) throw new Error('缩略图缓存目录在恢复入队前发生变化');
      let lastPhaseReportAt = 0;
      task.report(5, '正在检查缩略图缓存一致性', { maintenancePhase: 'startup-recovery' });
      const [migrationState, reconciliationState] = await Promise.all([
        pipeline.maintenanceState(descriptor.migrationKey),
        pipeline.maintenanceState(descriptor.maintenanceKey),
      ]);
      const previousCursor = reconciliationState.cursor && typeof reconciliationState.cursor === 'object'
        ? reconciliationState.cursor : {};
      const currentCacheFingerprint = typeof pipeline.cacheDirectoryFingerprint === 'function'
        ? await pipeline.cacheDirectoryFingerprint(cacheRoot) : null;
      const cacheFingerprintMatches = Boolean(currentCacheFingerprint && previousCursor.cacheFingerprint
        && JSON.stringify(currentCacheFingerprint) === JSON.stringify(previousCursor.cacheFingerprint));
      const orphanRecheckDue = Number(previousCursor.orphanRecheckAt) > 0
        && now() >= Number(previousCursor.orphanRecheckAt);
      if (reconciliationState.completed && cacheFingerprintMatches && !orphanRecheckDue) {
        admit({ skipped: true, unchangedCache: true });
        return {
          success: true, skipped: true, unchangedCache: true,
          completedAt: reconciliationState.completedAt || previousCursor.lastCompletedAt,
          generation: previousCursor.generation,
        };
      }
      if (previousCursor.generation === startupGeneration && Number(previousCursor.lastCompletedAt) > 0
          && (!currentCacheFingerprint || !previousCursor.cacheFingerprint)) {
        admit({ skipped: true });
        return { success: true, skipped: true, completedAt: previousCursor.lastCompletedAt, generation: startupGeneration };
      }
      let recoveryCursor = previousCursor.generation && !Number(previousCursor.lastCompletedAt)
        ? previousCursor
        : { generation: startupGeneration, generationMaxRowId: 0, afterRowId: 0, lastCompletedAt: 0, directory: {} };
      await pipeline.saveMaintenanceState(descriptor.maintenanceKey, recoveryCursor);
      const orphanBeforeMs = now() - RECOVERY_ORPHAN_RETENTION_MS;
      const reportSliceMetrics = createBatchedSliceMetricsReporter({
        writeLog,
        context: { origin: 'startup-recovery' },
        now,
      });
      const run = await runSlicedMaintenance({
        task,
        initialState: { recoveryCursor, prunePending: true },
        initialMetrics: { repairedMissingCount: 0, recoveryInspectedCount: 0, orphanScanConsumedCount: 0, orphanProgressCount: 0, retryConsumedCount: 0, deletedCount: 0, deletedBytes: 0, detachedCount: 0, detachedBytes: 0, prunedSourceCount: 0, failedCount: 0 },
        sliceDeadlineMs: RECOVERY_SLICE_DEADLINE_MS,
        yieldMs: RECOVERY_SLICE_DELAY_MS,
        runSlice: async ({ state, firstSlice, deadlineAt, signal }) => {
          const result = await pipeline.evictCache({
          cacheRoot,
          verifyIntegrity: firstSlice && !migrationState.completed,
          completeMigrationKey: firstSlice && !migrationState.completed ? descriptor.migrationKey : '',
          migrationVersion: MIGRATION_VERSION,
          migrationCursor: migrationState.cursor || {},
          recoverOrphans: true,
          scanRootOrphans: !String(cacheConfig?.directory || '').trim(),
          orphanBeforeMs,
          orphanRetentionMs: RECOVERY_ORPHAN_RETENTION_MS,
          pruneMissing: state.prunePending,
          maxPruneBatches: 1,
          failOnDeleteError: true,
          completeMaintenanceKey: descriptor.maintenanceKey,
          recoveryCursor: state.recoveryCursor,
          recoveryInspectLimit: RECOVERY_INSPECT_LIMIT,
          recoveryDeleteLimit: RECOVERY_DELETE_LIMIT,
          recoveryDirectoryInspectLimit: RECOVERY_DIRECTORY_INSPECT_LIMIT,
          maxRecoveryPages: 1,
          bumpCacheEpoch: firstSlice,
          task,
          signal,
          deadlineAt,
          onAdmitted: details => admit({ maintenance: details }),
          onBlocked: ({ phase, processedCount }) => {
            if (Date.now() - lastPhaseReportAt < 250) return;
            lastPhaseReportAt = Date.now();
            task.report(Math.min(95, 5 + Math.floor(Number(processedCount || 0) / 64)), `缓存修复：${phase}，正在处理当前分片`, {
              maintenancePhase: phase,
              processedCount,
              deadlineAt,
            });
          },
          });
          const metricsDelta = Object.fromEntries(['repairedMissingCount', 'recoveryInspectedCount', 'orphanScanConsumedCount', 'orphanProgressCount', 'retryConsumedCount', 'deletedCount', 'deletedBytes', 'detachedCount', 'detachedBytes', 'prunedSourceCount', 'failedCount'].map(field => [field, Number(result[field]) || 0]));
          return {
            complete: result.maintenanceComplete === true,
            nextState: { recoveryCursor: result.recoveryCursor || state.recoveryCursor, prunePending: result.pruneComplete === false },
            metricsDelta,
            processedDelta: result.processedCount,
            foregroundWaitMs: result.foregroundWaitMs,
            phase: result.maintenanceComplete ? 'complete' : result.pruneComplete === false ? 'prune' : 'orphan-recovery',
          };
        },
        reportProgress: ({ processedCount, phase, deadlineAt, report }) => report(
          Math.min(95, 5 + Math.floor(processedCount / 64)),
          `缓存修复：${phase}，已处理 ${processedCount} 条`,
          { maintenancePhase: phase, processedCount, deadlineAt },
        ),
        reportSliceMetrics,
      });
      recoveryCursor = run.state.recoveryCursor;
      const aggregate = { success: true, ...run.metrics, recoveryCursor, maintenanceComplete: true };
      task.report(100, `缓存索引修复完成：${aggregate.repairedMissingCount} 条缺失缓存，${aggregate.deletedCount} 个孤立文件`);
      return aggregate;
    }, retryFactory);
    taskId = execution.task.id;
    const completion = execution.completion.then(result => {
      if (!admitted) admit({ completedBeforeAdmission: true });
      return result;
    }, error => {
      if (!admitted) admission.reject(error);
      throw error;
    }).finally(() => {
      if (recoveryRuns.get(descriptor.maintenanceKey)?.completion === completion) recoveryRuns.delete(descriptor.maintenanceKey);
    });
    const run = { ...execution, admitted: admission.promise, completion, descriptor };
    void completion.catch(() => undefined);
    recoveryRuns.set(descriptor.maintenanceKey, run);
    return run;
  };

  const activateStartupRecovery = () => {
    if (stopped) return;
    if (unregisterRecoveryRestart) return;
    unregisterRecoveryRestart = backgroundTasks.registerTypeRestartFactory?.(RECOVERY_TYPE, task => (
      startRecovery(task.metadata?.cacheConfig || {}, task)
    ), {
      canRestart: task => Boolean(task.metadata?.maintenanceKey && task.metadata?.cacheRoot),
      autoRestart: true,
      autoRestartDelayMs: 5000,
    }) || (() => undefined);
  };

  const ensureStartupRecovery = (cacheConfig = {}) => {
    if (stopped) throw Object.assign(new Error('thumbnail service stopped'), { code: 'THUMBNAIL_STOPPED' });
    const descriptor = recoveryDescriptor(cacheConfig);
    const existing = backgroundTasks.list().find(task => (
      task.type === RECOVERY_TYPE
      && task.metadata?.maintenanceKey === descriptor.maintenanceKey
      && (ACTIVE_STATES.has(task.state) || task.state === 'failed' || task.state === 'interrupted')
    ));
    if (!existing) return startRecovery(cacheConfig);
    if (ACTIVE_STATES.has(existing.state)) {
      const active = recoveryRuns.get(descriptor.maintenanceKey);
      if (active) return active;
      const completion = (async () => {
        while (true) {
          if (stopped) throw Object.assign(new Error('thumbnail service stopped while waiting for recovery'), { code: 'THUMBNAIL_STOPPED' });
          const current = backgroundTasks.get?.(existing.id)
            || backgroundTasks.list().find(task => task.id === existing.id);
          if (!current) throw new Error('缩略图缓存启动修复任务已丢失');
          if (!ACTIVE_STATES.has(current.state)) {
            if (current.state === 'completed') return current.result;
            throw new Error(current.error || current.message || '缩略图缓存启动修复失败');
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      })();
      recoveryWaits.add(completion);
      void completion.finally(() => recoveryWaits.delete(completion)).catch(() => undefined);
      void completion.catch(() => undefined);
      return {
        task: existing,
        admitted: Promise.resolve({ taskId: existing.id, maintenanceKey: descriptor.maintenanceKey, reused: true }),
        completion,
        descriptor,
      };
    }
    if (existing.state === 'failed') {
      if (recoverableStartupFailure(existing) && existing.retryable) {
        const retried = Promise.resolve().then(() => backgroundTasks.retry(existing.id));
        const admitted = retried.then(accepted => ({
          taskId: accepted.replacementTaskId || accepted.task?.id || existing.id,
          maintenanceKey: descriptor.maintenanceKey,
          automaticRetry: true,
        }));
        const completion = retried.then(accepted => accepted.completion);
        void completion.catch(() => undefined);
        return { task: existing, admitted, completion, descriptor };
      }
      return { task: existing, admitted: Promise.resolve({ taskId: existing.id, failed: true, reused: true }), completion: null, descriptor };
    }
    const restarted = backgroundTasks.restart(existing.id);
    const admitted = restarted.then(run => run?.admitted || { taskId: existing.id, restarted: true });
    const completion = restarted.then(run => run?.completion || run);
    void completion.catch(() => undefined);
    return { task: existing, admitted, completion, descriptor };
  };

  const recoverCache = (cacheConfig = {}, restartTask = null) => startRecovery(cacheConfig, restartTask).completion;
  const waitForStartupRecovery = async (cacheConfig = {}) => {
    const descriptor = recoveryDescriptor(cacheConfig);
    const run = recoveryRuns.get(descriptor.maintenanceKey) || ensureStartupRecovery(cacheConfig);
    await run.admitted;
    if (run.completion) await run.completion;
    const failed = backgroundTasks.list().find(task => (
      task.type === RECOVERY_TYPE
      && task.metadata?.maintenanceKey === descriptor.maintenanceKey
      && task.state === 'failed'
    ));
    if (failed) throw new Error(failed.error || '缩略图缓存启动修复失败');
  };
  const requestThumbnail = async (request, restartTask = null) => {
    if (stopped) return { success: false, state: 'NOT_READY', error: '缩略图服务已停止' };
    const { awaitReady = false, ...input } = request;
    const normalizedFilePath = path.resolve(request.filePath);
    const normalizedSize = Math.max(1, Number(request.requestedSize) || 640);
    const normalizedRequest = { ...input, filePath: normalizedFilePath, requestedSize: normalizedSize };
    const pipelineResult = await pipeline.request(normalizedRequest);
    const { completion: generationCompletion, ...immediateResult } = pipelineResult;
    if (!generationCompletion) return immediateResult;
    const run = () => {
      const execution = backgroundTasks.start({
        ...(restartTask?.id ? { id: restartTask.id } : {}),
        type: 'thumbnail-generate',
        title: `生成缩略图：${path.basename(normalizedFilePath)}`,
        dedupeKey: `thumbnail-generate:${process.platform === 'win32' ? normalizedFilePath.toLocaleLowerCase() : normalizedFilePath}:${normalizedSize}:${recoveryDescriptor(normalizedRequest.cacheConfig || {}).maintenanceKey}`,
        cancellable: false,
        metadata: {
          ...normalizedRequest,
        },
      }, async task => {
        task.report(10, '正在生成缩略图');
        const outcome = await generationCompletion;
        if (outcome?.state === 'FAILED') {
          throw Object.assign(new Error(outcome.error || '缩略图生成失败'), { code: 'THUMBNAIL_GENERATION_FAILED' });
        }
        return outcome;
      }, () => requestThumbnail(normalizedRequest));
      return execution;
    };
    const execution = run();
    if (awaitReady) {
      // Capability callers need a finished derivative URL; unlike viewport
      // callers, they cannot consume the later thumbnail-ready event.
      const outcome = await generationCompletion;
      if (stopped) return { success: false, state: 'NOT_READY', error: '缩略图服务已停止' };
      if (outcome?.state !== 'READY') return { ...outcome, success: false, taskId: execution.task.id };
      const { completion: _completion, ...ready } = await pipeline.request({ ...normalizedRequest, forceRegenerate: false });
      return { ...ready, taskId: execution.task.id };
    }
    return { ...immediateResult, taskId: execution.task.id };
  };
  const service = {
    request: requestThumbnail,
    cancel: (filePath, requestedSize) => pipeline.cancel(filePath, requestedSize),
    noteForegroundActivity: () => pipeline.noteForegroundActivity(),
    indexDirectory: (...args) => pipeline.indexDirectory(...args),
    scanProject: (...args) => pipeline.scanProject(...args),
    inspectToolSources: (...args) => pipeline.inspectToolSources(...args),
    syncChangedPaths: (...args) => pipeline.syncChangedPaths(...args),
    runDatabaseMaintenance: (worker, options) => pipeline.runDatabaseMaintenance(worker, options),
    activateStartupRecovery,
    ensureStartupRecovery,
    waitForStartupRecovery,
    recoverCache,
    evictCache: options => pipeline.evictCache(options),
    invalidateDeleted: (...args) => pipeline.invalidateDeleted(...args),
    listCacheCleanupCandidates: (...args) => pipeline.listCacheCleanupCandidates(...args),
    cleanupOrphanCache: (...args) => pipeline.cleanupOrphanCache(...args),
    invalidateSources: (...args) => pipeline.invalidateSources(...args),
    pruneMissingSources: () => pipeline.pruneMissingSources(),
    stop: (options = {}) => {
      if (stopPromise) return stopPromise;
      stopped = true;
      unregisterRecoveryRestart?.();
      unregisterRecoveryRestart = null;
      unregisterGenerateRestart?.();
      unregisterGenerateRestart = null;
      const pipelineStop = (async () => pipeline.stop(options))();
      stopPromise = (async () => {
        const results = await Promise.allSettled([
          ...[...recoveryRuns.values()].map(run => run.completion).filter(Boolean),
          ...recoveryWaits,
          pipelineStop,
        ]);
        const pipelineResult = results.at(-1);
        if (pipelineResult?.status === 'rejected') throw pipelineResult.reason;
      })();
      return stopPromise;
    },
  };
  unregisterGenerateRestart = backgroundTasks.registerTypeRestartFactory?.('thumbnail-generate', task => service.request({
    filePath: task.metadata?.filePath,
    kind: task.metadata?.kind,
    cacheConfig: task.metadata?.cacheConfig,
    requestedSize: task.metadata?.requestedSize,
    priority: task.metadata?.priority,
    queueOrder: task.metadata?.queueOrder,
    requireDisk: task.metadata?.requireDisk,
    forceRegenerate: task.metadata?.forceRegenerate,
  }, task)) || (() => undefined);
  return service;
};

module.exports = { createThumbnailService };
