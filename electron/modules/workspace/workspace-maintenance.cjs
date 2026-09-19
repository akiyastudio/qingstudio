const WORKSPACE_MAINTENANCE_LOCK_RETRY_DELAYS_MS = [1000, 2500, 5000, 10000, 20000];
const workspaceDatabaseTaskResource = root => ({ path: `photoflow-workspace-database/${root}`, access: 'write' });
const isDatabaseLockedError = error => error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
const cancellableWait = (delay, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELLED' })); return; }
  const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELLED' })); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delay);
  signal?.addEventListener('abort', onAbort, { once: true });
});

const runWorkspaceMaintenanceWithRetry = async ({
  root,
  repository,
  task,
  wait = (delay, signal) => cancellableWait(delay, signal),
  retryDelays = WORKSPACE_MAINTENANCE_LOCK_RETRY_DELAYS_MS,
}) => {
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    task?.throwIfCancelled?.();
    try {
      return await repository.runMaintenance(root, { signal: task?.signal, priority: -10, preemptible: true });
    } catch (error) {
      if (!isDatabaseLockedError(error) || attempt >= retryDelays.length) throw error;
      const delay = retryDelays[attempt];
      task?.report?.(10, `项目数据库正忙，${Math.max(1, Math.ceil(delay / 1000))} 秒后自动重试`, { maintenanceAttempt: attempt + 2 });
      await wait(delay, task?.signal);
    }
  }
};

module.exports = { runWorkspaceMaintenanceWithRetry, workspaceDatabaseTaskResource };
