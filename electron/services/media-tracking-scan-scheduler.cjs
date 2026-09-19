const path = require('path');
const crypto = require('crypto');
const { createDirtyCoalescingRunner } = require('./dirty-coalescing-runner.cjs');
const { createKeyedAdmissionQueue } = require('./keyed-admission-queue.cjs');
const { isMediaRelevantChange } = require('./watch-change-filter.cjs');
const { MEDIA_RESCAN_POLICY_VERSION } = require('./background-task-policy-versions.cjs');
const { MAX_CHANGED_PATHS } = require('../contracts/media-sync-limits.cjs');

const CASE_INSENSITIVE_PATHS = process.platform === 'win32';
const THUMBNAIL_CANDIDATE_CONCURRENCY = 8;
const platformKey = value => CASE_INSENSITIVE_PATHS ? value.toLocaleLowerCase() : value;
const comparablePath = value => platformKey(path.resolve(value));

const normalizeChange = value => {
  const inputPath = typeof value === 'string' ? value : value?.path;
  if (typeof inputPath !== 'string' || !inputPath.trim()) return null;
  return typeof value === 'string'
    ? { path: path.resolve(value), eventType: 'rename', kind: 'missing' }
    : { ...value, path: path.resolve(inputPath), eventType: value?.eventType === 'rename' ? 'rename' : 'change', kind: ['file', 'directory', 'missing'].includes(value?.kind) ? value.kind : 'missing' };
};

const coalesceMediaChanges = values => {
  const byPath = new Map();
  for (const raw of values || []) {
    const change = normalizeChange(raw);
    if (!change?.path || !isMediaRelevantChange(change)) continue;
    const key = comparablePath(change.path);
    const previous = byPath.get(key);
    if (!previous
        || previous.kind === 'missing' && change.kind !== 'missing'
        || change.eventType === 'rename' && previous.eventType !== 'rename') byPath.set(key, change);
  }
  const ordered = [...byPath.values()].sort((left, right) => left.path.length - right.path.length);
  const collapsed = [];
  const directories = new Set();
  for (const change of ordered) {
    let covered = false;
    for (let parent = path.dirname(change.path);;) {
      if (directories.has(comparablePath(parent))) { covered = true; break; }
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    if (!covered) { collapsed.push(change); if (change.kind === 'directory') directories.add(comparablePath(change.path)); }
  }
  return collapsed;
};

const mergeMediaScanBatch = (current, delta) => {
  const left = current || {};
  const right = delta || {};
  let fullScan = Boolean(left.fullScan || right.fullScan);
  let changes;
  try {
    changes = right.fullScan
      ? coalesceMediaChanges(left.changes || left.changedPaths || [])
      : left.fullScan
        ? coalesceMediaChanges(left.changes || left.changedPaths || [])
        : coalesceMediaChanges([...(left.changes || left.changedPaths || []), ...(right.changes || right.changedPaths || [])]);
  } catch (error) {
    if (error?.code !== 'MEDIA_SYNC_PATHS_LIMIT') throw error;
    fullScan = true;
    changes = [];
  }
  return {
    root: right.root || left.root,
    projectName: right.projectName || left.projectName,
    changes,
    fullScan,
    snapshotId: right.snapshotId || left.snapshotId || crypto.randomUUID(),
    restartTask: right.restartTask || left.restartTask || null,
  };
};

const createMediaTrackingScanScheduler = ({
  backgroundTasks,
  mediaScanService,
  versionStaleDetectionService,
  getProject,
  onThumbnailCandidate = () => undefined,
  thumbnailPriority,
  writeLog = () => undefined,
  delayMs = 1500,
  runnerRetryDelays = undefined,
}) => {
  const keyFor = (root, projectName) => `${comparablePath(root)}\0${platformKey(String(projectName || ''))}`;
  const replayKeyFor = (root, projectName, taskId) => `${keyFor(root, projectName)}\0replay:${String(taskId || crypto.randomUUID())}`;
  const workspaceKey = root => comparablePath(root);
  const workspaceAdmission = createKeyedAdmissionQueue();
  const admissionControllers = new Map();
  const replayKeysByProject = new Map();
  const cancellationEpochs = new Map();
  let stopped = false;
  let runner;

  const cancellationEpoch = key => cancellationEpochs.get(key) || 0;
  const trackReplayKey = (projectKey, replayKey) => {
    let keys = replayKeysByProject.get(projectKey);
    if (!keys) {
      keys = new Set();
      replayKeysByProject.set(projectKey, keys);
    }
    keys.add(replayKey);
  };
  const untrackReplayKey = (projectKey, replayKey) => {
    const keys = replayKeysByProject.get(projectKey);
    if (!keys) return;
    keys.delete(replayKey);
    if (!keys.size) replayKeysByProject.delete(projectKey);
  };

  const enqueueRetry = (key, batch, restartTask = null) => {
    if (stopped) return Promise.resolve({ skipped: true, reason: 'scheduler-stopped' });
    const ticket = runner.enqueue(key, { ...batch, restartTask });
    return runner.flush(ticket);
  };

  const executeWrapper = async ({ key, batch, signal }) => {
    if (stopped) return { skipped: true, reason: 'scheduler-stopped' };
    // Keep each persisted manifest within the repository's contract. Stable
    // child snapshot IDs make retries idempotent without a whole-project scan.
    if (!batch.fullScan && batch.changes.length > MAX_CHANGED_PATHS) {
      return backgroundTasks.run({
        type: 'version-media-rescan', title: '分批更新媒体索引', resources: [], cancellable: false,
        // A small durable guard covers the gap between child tasks. After a
        // process interruption a fresh scan also catches unjournaled events.
        metadata: { workspaceRoot: batch.root, projectName: batch.projectName, fullScan: true, incrementalChunkGuard: true, snapshotId: batch.snapshotId, mediaRescanPolicyVersion: MEDIA_RESCAN_POLICY_VERSION },
      }, async guard => {
        if (backgroundTasks.flush?.() === false) throw Object.assign(new Error('无法保存分批索引恢复记录'), { code: 'MEDIA_SYNC_CHECKPOINT_FAILED' });
        const chunkSignal = AbortSignal.any([signal, guard.signal].filter(Boolean));
        const chunks = [];
        for (let offset = 0; offset < batch.changes.length; offset += MAX_CHANGED_PATHS) {
          if (chunkSignal.aborted) throw Object.assign(new Error('媒体索引任务已取消'), { code: 'TASK_CANCELLED' });
          const digest = crypto.createHash('sha256').update(`${batch.snapshotId}:${offset}`).digest('hex');
          const snapshotId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
          const completed = await executeWrapper({ key, signal: chunkSignal, batch: { ...batch, changes: batch.changes.slice(offset, offset + MAX_CHANGED_PATHS), snapshotId, restartTask: null } });
          chunks.push(true);
          // Completed chunk manifests need not consume the bounded task journal.
          // Failed chunks remain persisted with their immutable snapshot IDs.
          if (completed?.task?.id) backgroundTasks.dismiss?.(completed.task.id);
          guard.report(Math.min(99, Math.round((offset + MAX_CHANGED_PATHS) / batch.changes.length * 100)), `已处理 ${Math.min(offset + MAX_CHANGED_PATHS, batch.changes.length)}/${batch.changes.length} 条变更`);
          await new Promise(resolve => setImmediate(resolve));
        }
        return { chunks: chunks.length };
      }, () => enqueueRetry(key, batch));
    }
    const projectKey = keyFor(batch.root, batch.projectName);
    const epoch = cancellationEpoch(projectKey);
    const project = getProject(batch.root, batch.projectName);
    if (!project || project.availability === 'missing') {
      if (batch.restartTask?.id) throw new Error('项目目录尚未加载，自动索引将在目录可用后重试');
      return { skipped: true };
    }
    const projectPath = path.resolve(batch.root, project.relative_path);
    const controller = new AbortController();
    admissionControllers.set(key, controller);
    const admissionKey = workspaceKey(batch.root);
    let admitted = false;
    try {
      await workspaceAdmission.acquire(admissionKey, { signal: controller.signal });
      admitted = true;
      const execution = await backgroundTasks.run({
      ...(batch.restartTask?.id ? { id: batch.restartTask.id } : {}),
      type: 'version-media-rescan',
      title: '更新版本媒体索引',
      concurrencyGroup: 'background-disk-io',
      concurrencyLimit: 2,
      concurrencyWriteLimit: 2,
      resourceAccess: 'read',
      cancellable: false,
      // The repository coordinator serializes each prepare/apply/finalize call.
      // A task-wide database reservation would make unrelated foreground work
      // wait for the complete project scan instead of only the current batch.
      resources: [],
      metadata: {
        workspaceRoot: batch.root, projectName: batch.projectName, projectPath,
        changedPaths: batch.changes.map(change => change.path), changes: batch.changes, fullScan: batch.fullScan,
        snapshotId: batch.snapshotId,
        mediaRescanPolicyVersion: MEDIA_RESCAN_POLICY_VERSION,
      },
    }, async task => {
      const operationSignal = AbortSignal.any([signal, task.signal].filter(Boolean));
      task.report(5, '正在扫描项目媒体文件');
      const result = batch.fullScan
        ? await mediaScanService.syncProject(batch.root, batch.projectName, [], { signal: operationSignal, background: true })
        : await mediaScanService.syncChangedPaths(batch.root, batch.projectName, batch.changes, [], { snapshotId: batch.snapshotId, signal: operationSignal, background: true });
      task.report(95, '正在完成版本媒体索引');
      return result;
      }, () => enqueueRetry(key, batch));
      // Candidate fan-out is part of the wrapper. Manual and automatic retries
      // therefore cannot report success while skipping thumbnail scheduling.
      const thumbnailCandidates = (execution.result?.thumbnailCandidates || []).slice(0, 750);
      let nextCandidateIndex = 0;
      const scheduleCandidateWorker = async () => {
        while (nextCandidateIndex < thumbnailCandidates.length) {
          const candidateIndex = nextCandidateIndex;
          nextCandidateIndex += 1;
          const candidate = thumbnailCandidates[candidateIndex];
          if (stopped || cancellationEpoch(projectKey) !== epoch) return;
          try {
            await Promise.resolve(onThumbnailCandidate({
              workspaceRoot: batch.root,
              photoId: candidate.photoId,
              versionId: candidate.versionId,
              filePath: candidate.filePath,
              priority: thumbnailPriority,
            }));
          } catch (error) {
            writeLog('warn', 'Unable to schedule media thumbnail candidate', {
              projectName: batch.projectName, filePath: candidate.filePath, error: error.message || String(error),
            });
          }
          if (candidateIndex % 32 === 31) await new Promise(resolve => setImmediate(resolve));
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(THUMBNAIL_CANDIDATE_CONCURRENCY, thumbnailCandidates.length) },
        () => scheduleCandidateWorker(),
      ));
      return execution;
    } finally {
      if (admissionControllers.get(key) === controller) admissionControllers.delete(key);
      if (admitted) workspaceAdmission.release(admissionKey);
    }
  };

  runner = createDirtyCoalescingRunner({
    merge: mergeMediaScanBatch,
    hasWork: batch => Boolean(batch?.root && batch?.projectName),
    worker: executeWrapper,
    delayMs,
    ...(runnerRetryDelays ? { retryDelays: runnerRetryDelays } : {}),
    onError: (error, context) => {
      if (error?.code === 'DATABASE_PREEMPTED' || error?.code === 'TASK_CANCELLED') return;
      writeLog('warn', 'Media version tracking scan deferred', {
        projectName: context.batch?.projectName, retryAttempt: context.retryAttempt,
        willRetry: context.willRetry, error: error.message || String(error),
      });
    },
  });

  backgroundTasks?.registerTypeRestartFactory?.('version-media-rescan', async task => {
    const projectKey = keyFor(task.metadata?.workspaceRoot, task.metadata?.projectName);
    const replayKey = replayKeyFor(task.metadata?.workspaceRoot, task.metadata?.projectName, task.id);
    const epoch = cancellationEpoch(projectKey);
    trackReplayKey(projectKey, replayKey);
    try {
      const result = await enqueueRetry(replayKey, mergeMediaScanBatch(null, {
      root: task.metadata?.workspaceRoot, projectName: task.metadata?.projectName,
      changes: task.metadata?.changes || task.metadata?.changedPaths || [], fullScan: task.metadata?.fullScan !== false,
      snapshotId: task.metadata?.snapshotId,
      }), task);
      // Watcher events are not journaled across process downtime. A successful
      // immutable-manifest replay must therefore be followed by a fresh full
      // scan on the normal lane, using a newly generated snapshot id.
      if (!stopped && cancellationEpoch(projectKey) === epoch) {
        schedule(task.metadata?.workspaceRoot, task.metadata?.projectName, [], true);
      }
      return result;
    } finally {
      untrackReplayKey(projectKey, replayKey);
    }
  }, {
    canRestart: task => Boolean(task.metadata?.workspaceRoot && task.metadata?.projectName)
      && (task.metadata?.fullScan === true || Number(task.metadata?.mediaRescanPolicyVersion || 0) >= MEDIA_RESCAN_POLICY_VERSION),
    autoRestart: true,
    // Let startup catalog/database maintenance take the writer first. Restored
    // media work is recoverable and should not hold routine maintenance behind
    // a many-project replay wave.
    autoRestartDelayMs: 30000,
  });

  const schedule = (root, projectName, changes = [], fullScan = false) => {
    if (stopped) return null;
    if (!projectName) return null;
    const project = getProject(root, projectName);
    if (!project || project.availability === 'missing') return null;
    let effectiveFullScan = fullScan;
    let normalizedChanges;
    try { normalizedChanges = fullScan ? [] : coalesceMediaChanges(changes); }
    catch (error) {
      if (error?.code !== 'MEDIA_SYNC_PATHS_LIMIT') throw error;
      effectiveFullScan = true;
      normalizedChanges = [];
    }
    if (!effectiveFullScan && !normalizedChanges.length) return null;
    versionStaleDetectionService.schedule(root, projectName, normalizedChanges.map(change => change.path), effectiveFullScan);
    return runner.enqueue(keyFor(root, projectName), {
      root: path.resolve(root), projectName: String(projectName),
      changes: normalizedChanges, fullScan: effectiveFullScan, snapshotId: crypto.randomUUID(),
    });
  };

  const cancel = (root, projectName) => {
    if (!projectName) return;
    const key = keyFor(root, projectName);
    cancellationEpochs.set(key, cancellationEpoch(key) + 1);
    admissionControllers.get(key)?.abort();
    runner.cancel(key);
    for (const replayKey of replayKeysByProject.get(key) || []) {
      admissionControllers.get(replayKey)?.abort();
      runner.cancel(replayKey);
    }
    replayKeysByProject.delete(key);
    versionStaleDetectionService.cancel(root, projectName);
  };

  const stop = () => {
    stopped = true;
    for (const controller of admissionControllers.values()) controller.abort();
    admissionControllers.clear();
    replayKeysByProject.clear();
    workspaceAdmission.stop();
    runner.stop();
  };

  return { schedule, cancel, stop, pendingCount: runner.pendingCount, flush: runner.flush, runner, workspaceAdmission };
};

module.exports = { coalesceMediaChanges, createMediaTrackingScanScheduler, mergeMediaScanBatch, MEDIA_RESCAN_POLICY_VERSION, MAX_CHANGED_PATHS };
