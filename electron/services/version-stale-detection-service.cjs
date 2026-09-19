const path = require('path');
const { createDirtyCoalescingRunner } = require('./dirty-coalescing-runner.cjs');

const mergeDetectionBatch = (current, delta) => {
  const left = current || {};
  const right = delta || {};
  const fullScan = Boolean(left.fullScan || right.fullScan);
  return {
    root: right.root || left.root,
    projectName: right.projectName || left.projectName,
    changedPaths: fullScan ? new Set() : new Set([...(left.changedPaths || []), ...(right.changedPaths || [])]),
    fullScan,
    restartTask: right.restartTask || left.restartTask || null,
  };
};

const createVersionStaleDetectionService = ({ versionService, backgroundTasks = null, delayMs = 1500, runnerRetryDelays = undefined, writeLog = () => undefined }) => {
  const keyPart = value => process.platform === 'win32' ? String(value).toLocaleLowerCase() : String(value);
  const keyFor = (root, projectName) => `${keyPart(path.resolve(root))}\0${keyPart(projectName || '')}`;
  let runner;

  const enqueueRetry = (key, batch, restartTask = null) => {
    const ticket = runner.enqueue(key, { ...batch, restartTask });
    return runner.flush(ticket);
  };

  const executeWrapper = async ({ key, batch }) => {
    // Query persisted tracking state before publishing a task or scanning files.
    // Do not cache negative answers: enabling tracking must take effect on the
    // next filesystem event without restarting the application.
    if (!await versionService.hasProgressToCheck(batch.root, batch.projectName)) {
      if (batch.restartTask?.id) backgroundTasks?.dismiss(batch.restartTask.id);
      return { success: true, skipped: true };
    }
    const payload = { projectName: batch.projectName, changedPaths: batch.fullScan ? [] : [...batch.changedPaths] };
    const executeDatabaseWork = task => versionService.detectProgressStale(batch.root, payload, {
      signal: task?.signal, background: true,
    });
    if (!backgroundTasks?.run) return executeDatabaseWork();
    const execution = await backgroundTasks.run({
      ...(batch.restartTask?.id ? { id: batch.restartTask.id } : {}),
      type: 'version-stale-detection',
      title: `检查版本跟踪 · ${batch.projectName}`,
      notificationPolicy: 'silent',
      cancellable: false,
      // detectProgressStale acquires short database-coordinator leases itself.
      // Do not turn this silent maintenance task into a workspace-wide blocker.
      resources: [],
      metadata: {
        workspaceRoot: batch.root, projectName: batch.projectName,
        changedPaths: batch.fullScan ? [] : [...batch.changedPaths], fullScan: batch.fullScan,
      },
    }, executeDatabaseWork, () => enqueueRetry(key, batch));
    backgroundTasks.dismiss(execution.task.id);
    return execution;
  };

  runner = createDirtyCoalescingRunner({
    merge: mergeDetectionBatch,
    hasWork: batch => Boolean(batch?.root && batch?.projectName),
    worker: executeWrapper,
    delayMs,
    ...(runnerRetryDelays ? { retryDelays: runnerRetryDelays } : {}),
    onError: (error, context) => {
      if (error?.code === 'DATABASE_PREEMPTED' || error?.code === 'TASK_CANCELLED') return;
      writeLog('warn', 'Unable to detect stale version tracking nodes', {
        projectName: context.batch?.projectName, retryAttempt: context.retryAttempt,
        willRetry: context.willRetry, error: error.message || String(error),
      });
    },
  });

  backgroundTasks?.registerTypeRestartFactory?.('version-stale-detection', task => enqueueRetry(
    keyFor(task.metadata?.workspaceRoot, task.metadata?.projectName),
    mergeDetectionBatch(null, {
      root: task.metadata?.workspaceRoot, projectName: task.metadata?.projectName,
      changedPaths: task.metadata?.changedPaths || [], fullScan: task.metadata?.fullScan === true,
    }),
    task,
  ), {
    canRestart: task => Boolean(task.metadata?.workspaceRoot && task.metadata?.projectName),
    autoRestart: true,
  });

  const schedule = (root, projectName, changedPaths = [], fullScan = false) => {
    if (!projectName) return null;
    return runner.enqueue(keyFor(root, projectName), {
      root: path.resolve(root), projectName: String(projectName),
      changedPaths: fullScan ? [] : changedPaths.map(value => path.resolve(value)), fullScan,
    });
  };

  const cancel = (root, projectName) => runner.cancel(keyFor(root, projectName));
  return { schedule, cancel, stop: runner.stop, pendingCount: runner.pendingCount, flush: runner.flush, runner };
};

module.exports = { createVersionStaleDetectionService, mergeDetectionBatch };
