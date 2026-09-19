const { measureFileOperationStage } = require('./file-operation-diagnostics.cjs');

const PHASE_MESSAGES = {
  scanning: '正在统计',
  copying: '正在复制文件',
  moving: '正在移动文件',
  splitting: '正在分割视频',
  trashing: '正在移入回收站',
  finishing: '正在完成数据登记',
};

const createProjectFileTask = ({
  backgroundTasks,
  event,
  operationId,
  operation,
  title,
  projectName,
  resources = [],
  concurrencyGroup = 'disk-io',
  concurrencyLimit = 3,
  concurrencyWriteLimit = 2,
  cancellable = true,
  pausable = ['copy', 'paste', 'import', 'import-project', 'import-broll'].includes(operation),
  cancelledCode = 'FILE_OPERATION_CANCELLED',
  emitLegacyProgress = false,
}) => {
  const definition = {
    id: operationId,
    type: 'project-file-operation',
    title,
    message: '等待其他文件操作完成',
    runningMessage: '正在统计',
    cancellable,
    pausable,
    metadata: { operation, projectName, phase: 'queued' },
  };
  const operationLeaseDefinition = {
    capacities: [{ key: concurrencyGroup, access: 'write', limit: concurrencyLimit, writeLimit: concurrencyWriteLimit }],
    resourceAccess: 'write',
    resources,
    runningMessage: '正在统计',
  };
  const handle = backgroundTasks?.create?.(definition) || null;
  const job = { cancelled: false, finishing: false, taskId: operationId };
  let operationLease = null;
  let startPromise = null;
  let highestProgress = 0;
  if (handle?.context?.signal) {
    handle.context.signal.addEventListener('abort', () => { job.cancelled = true; }, { once: true });
  }
  const releaseOperationLease = () => {
    const lease = operationLease;
    operationLease = null;
    if (!lease) return;
    try { lease.release(); }
    catch (error) { job.releaseError = error?.message || String(error); }
  };

  const publish = payload => {
    const requestedProgress = Math.max(0, Math.min(100, Number(payload.progress) || 0));
    const terminalFailure = payload.phase === 'failed' || payload.phase === 'cancelled';
    const progress = terminalFailure ? requestedProgress : Math.max(highestProgress, requestedProgress);
    if (!terminalFailure) highestProgress = progress;
    const monotonicPayload = { ...payload, progress };
    if (emitLegacyProgress && !event.sender.isDestroyed()) {
      event.sender.send('workspace-file-operation-progress', { operationId, operation, projectName, ...monotonicPayload });
    }
    if (!handle || handle.deduplicated) return;
    const message = monotonicPayload.currentName || PHASE_MESSAGES[monotonicPayload.phase] || title;
    handle.context.report(monotonicPayload.progress, message, {
      operation,
      projectName,
      phase: monotonicPayload.phase,
      currentName: monotonicPayload.currentName || '',
      bytesCopied: monotonicPayload.bytesCopied,
      totalBytes: monotonicPayload.totalBytes,
      filesCopied: monotonicPayload.filesCopied,
      totalFiles: monotonicPayload.totalFiles,
      processedCount: monotonicPayload.processedCount,
      totalCount: monotonicPayload.totalCount,
    });
  };

  return {
    job,
    publish,
    start: nextResources => {
      if (startPromise) return startPromise;
      if (Array.isArray(nextResources)) operationLeaseDefinition.resources = nextResources;
      if (!handle || handle.deduplicated) return Promise.resolve();
      startPromise = (async () => {
        try {
          await measureFileOperationStage('taskQueue', () => handle.waitForStart());
          if (!operationLease) operationLease = await measureFileOperationStage('resourceQueue', () => handle.context.acquireResourceLease(operationLeaseDefinition));
        } catch (error) {
          startPromise = null;
          if (handle.context.signal.aborted || error?.code === 'TASK_CANCELLED') {
            throw Object.assign(new Error('文件操作已取消'), { code: cancelledCode });
          }
          throw error;
        }
      })();
      return startPromise;
    },
    cancel: () => backgroundTasks?.cancel?.(operationId),
    waitIfPaused: () => handle?.context?.waitIfPaused?.() || Promise.resolve(),
    acquireResourceLease: definition => handle?.context?.acquireResourceLease?.(definition),
    withResources: (definition, worker) => typeof handle?.context?.withResources === 'function'
      ? handle.context.withResources(definition, worker)
      : worker(),
    setPausable: pausableValue => handle?.context?.setPausable?.(pausableValue),
    setCancellable: cancellableValue => handle?.context?.setCancellable?.(cancellableValue),
    saveCheckpoint: (checkpoint, progress, message, metadata) => handle?.context?.saveCheckpoint?.(checkpoint, progress, message, metadata),
    complete: message => {
      releaseOperationLease();
      if (handle && !handle.deduplicated) handle.complete(message);
    },
    fail: error => {
      releaseOperationLease();
      if (handle && !handle.deduplicated) handle.fail(error);
    },
    cancelled: () => {
      releaseOperationLease();
      if (handle && !handle.deduplicated) handle.cancelled();
    },
    isFinished: () => !handle || handle.deduplicated || handle.isFinished(),
  };
};

module.exports = { createProjectFileTask };
