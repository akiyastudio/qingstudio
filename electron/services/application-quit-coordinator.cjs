const { isActiveManagedProcessStatus } = require('./process-supervisor.cjs');
const { resolveBackgroundTaskPolicy } = require('./background-task-policies.cjs');

const QUIT_TASK_STATES = new Set(['queued', 'running', 'pausing', 'paused', 'resuming']);
const selectApplicationQuitTasks = tasks => tasks.filter(task => {
  if (!QUIT_TASK_STATES.has(task.state)) return false;
  const policy = resolveBackgroundTaskPolicy(task);
  return policy.taskCenterPolicy === 'always' && !policy.foregroundNonBlocking && policy.notificationPolicy !== 'silent';
});

const applicationQuitTaskDetail = tasks => {
  const labels = { queued: '等待中', running: '进行中', pausing: '暂停中', paused: '已暂停', resuming: '恢复中' };
  const lines = tasks.slice(0, 5).map(task => {
    const title = String(task.title || '未命名任务').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160);
    return `• ${title}（${labels[task.state] || '未完成'}）`;
  });
  if (tasks.length > 5) lines.push(`另有 ${tasks.length - 5} 个任务`);
  return `退出后，以下任务将停止：\n${lines.join('\n')}`;
};

const registerMainWindowQuitGuard = ({ window, app, getQuitState, platform = process.platform }) => {
  if (platform === 'darwin') return () => undefined;
  const onClose = event => {
    const state = getQuitState();
    if (state === 'ready') return;
    event.preventDefault();
    if (state === 'idle') app.quit();
  };
  window.on('close', onClose);
  return () => window.removeListener?.('close', onClose);
};

const runApplicationQuit = async ({
  componentIds, processSupervisor, componentServiceManager, componentViewManager,
  componentLifecycleCoordinator, componentCapabilityBroker, abortComponentNetworkRequests,
  backgroundTasks, confirmPendingTasks, confirmationAccepted = false,
  quiesce = () => undefined, saveState = () => undefined, hideWindow = () => undefined,
  teardown = [], cleanup = [], writeLog = () => undefined, cleanupBudgetMs = 2000,
  startedAt = Date.now(), windowHiddenAt = 0,
}) => {
  const timings = {};
  const mark = phase => { timings[phase] = Date.now() - startedAt; };
  if (!confirmationAccepted) {
    const pendingTasks = selectApplicationQuitTasks(backgroundTasks.list());
    if (pendingTasks.length && !await confirmPendingTasks(pendingTasks)) {
      componentLifecycleCoordinator.cancelApplicationQuit();
      throw Object.assign(new Error('用户取消退出'), { code: 'APP_QUIT_CANCELLED' });
    }
  }
  const barriers = [];
  const bounded = (promise, deadlineAt, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(label + '尚未结束，请重试退出。'), { code: 'APP_QUIT_BUSY' })), Math.max(1, deadlineAt - Date.now()));
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  try {
    backgroundTasks.beginShutdown?.();
    await quiesce();
    mark('admissionStoppedMs');
    await hideWindow();
    mark('windowHiddenMs');
    if (windowHiddenAt >= startedAt && windowHiddenAt <= Date.now()) timings.windowHiddenMs = windowHiddenAt - startedAt;
    await backgroundTasks.waitForShutdown?.({ timeoutMs: 5000 });
    await saveState();
    componentLifecycleCoordinator.requestApplicationStop();
    backgroundTasks.stop?.();
    mark('stateSavedMs');

    const initialStatuses = processSupervisor.list();
    const guardedComponentIds = [...new Set([...componentIds, ...initialStatuses.map(status => status.owner?.componentId).filter(Boolean)])];
    for (const componentId of guardedComponentIds) {
      barriers.push(componentCapabilityBroker.blockComponent(componentId));
      abortComponentNetworkRequests?.(componentId);
    }
    const deadlineAt = Date.now() + cleanupBudgetMs;
    const remaining = () => Math.max(1, deadlineAt - Date.now());
    const cleanupPending = Promise.allSettled(cleanup.map(operation => Promise.resolve().then(() => operation({ deadlineAt }))));
    await bounded(Promise.all([
      processSupervisor.stopAll('application-quit', { deadlineAt }),
      componentServiceManager?.stopAll('application-quit', { deadlineAt }),
      componentViewManager?.closeAllAndWait(remaining()),
    ]), deadlineAt, '后台服务');
    await bounded(Promise.all([
      ...barriers.map(barrier => barrier.drain({ timeoutMs: remaining() })),
      componentLifecycleCoordinator.waitForAllWork({ timeoutMs: remaining() }),
    ]), deadlineAt, '后台操作');
    const remainingProcesses = processSupervisor.list().filter(isActiveManagedProcessStatus);
    const unconfirmedOwners = guardedComponentIds.filter(id => processSupervisor.hasUnconfirmedOwner?.(id));
    if (remainingProcesses.length || unconfirmedOwners.length) throw Object.assign(new Error('后台服务的退出状态尚未确认'), { code: 'PROCESS_TERMINATION_FAILED', componentIds: unconfirmedOwners });
    mark('processesStoppedMs');
    try {
      const results = await bounded(cleanupPending, deadlineAt, '缓存收尾');
      for (const result of results) if (result.status === 'rejected') writeLog('warn', 'Application cleanup deferred', { error: result.reason?.message || String(result.reason) });
    } catch (error) { writeLog('warn', 'Application cleanup deferred', { error: error.message }); }
    componentLifecycleCoordinator.commitApplicationQuit();
    const results = await Promise.allSettled(teardown.map(operation => Promise.resolve().then(operation)));
    for (const result of results) if (result.status === 'rejected') writeLog('warn', 'Post-commit application teardown warning', { error: result.reason?.message || String(result.reason) });
    mark('completedMs');
    writeLog('info', 'Application quit timing', { startedAt, ...timings });
    return { committed: true, timings };
  } catch (error) {
    barriers.forEach(barrier => barrier.release());
    componentLifecycleCoordinator.cancelApplicationQuit();
    writeLog('warn', 'Application quit paused', { ...timings, elapsedMs: Date.now() - startedAt, error: error.message });
    throw error;
  }
};

module.exports = { registerMainWindowQuitGuard, runApplicationQuit, selectApplicationQuitTasks, applicationQuitTaskDetail };
