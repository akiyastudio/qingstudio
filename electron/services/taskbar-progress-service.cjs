const ACTIVE_STATES = new Set(['queued', 'running', 'pausing', 'paused', 'resuming']);
const MOVING_STATES = new Set(['running', 'pausing', 'resuming']);

const selectTaskbarProgress = tasks => {
  const active = tasks.filter(task => ACTIVE_STATES.has(task.state)
    && task.taskCenterPolicy !== 'hidden' && task.taskCenterPolicy !== 'attention-only'
    && task.notificationPolicy !== 'silent');
  if (!active.length) return { progress: -1, mode: 'none' };
  const progress = active.reduce((sum, task) => sum + (Number.isFinite(task.progress)
    ? Math.max(0, Math.min(100, task.progress)) : 0), 0) / active.length / 100;
  if (!active.some(task => MOVING_STATES.has(task.state))) {
    if (active.some(task => task.state === 'paused')) return { progress: Math.max(0.01, progress), mode: 'paused' };
    return { progress: 2, mode: 'indeterminate' };
  }
  return progress > 0 ? { progress, mode: 'normal' } : { progress: 2, mode: 'indeterminate' };
};

const createTaskbarProgressService = ({ backgroundTasks, platform = process.platform, writeLog = () => undefined }) => {
  const windows = new Map();
  let timer = null;
  let disposed = false;
  const apply = (window, record, state, force = false) => {
    if (window.isDestroyed()) return;
    const key = `${state.mode}:${state.progress}`;
    if (!force && record.applied === key) return;
    try {
      window.setProgressBar(state.progress, { mode: state.mode });
      record.applied = key;
    } catch (error) {
      // Shell failures must not interrupt the operation whose progress changed.
      try { writeLog('warn', 'Unable to update taskbar progress', { error: error?.message || String(error) }); } catch {}
    }
  };
  const refresh = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (disposed || platform !== 'win32') return;
    const state = selectTaskbarProgress(backgroundTasks.list());
    for (const [window, record] of windows) apply(window, record, state);
  };
  const unsubscribe = platform === 'win32' ? backgroundTasks.subscribe(() => {
    // Coalesce frequent file/byte progress events without delaying completion indefinitely.
    if (disposed || timer !== null) return;
    timer = setTimeout(refresh, 100);
    timer.unref?.();
  }) : () => undefined;
  const detach = window => {
    const record = windows.get(window);
    if (!record) return;
    window.removeListener('ready-to-show', record.onShow);
    window.removeListener('show', record.onShow);
    window.removeListener('closed', record.onClosed);
    windows.delete(window);
  };
  return {
    attach: window => {
      if (disposed || platform !== 'win32' || window.isDestroyed() || windows.has(window)) return;
      const record = {
        applied: null,
        onShow: () => apply(window, record, selectTaskbarProgress(backgroundTasks.list()), true),
        onClosed: () => detach(window),
      };
      windows.set(window, record);
      window.once('ready-to-show', record.onShow);
      window.on('show', record.onShow);
      window.once('closed', record.onClosed);
      apply(window, record, selectTaskbarProgress(backgroundTasks.list()));
    },
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const [window, record] of windows) {
        apply(window, record, { progress: -1, mode: 'none' });
        detach(window);
      }
    },
  };
};

module.exports = { selectTaskbarProgress, createTaskbarProgressService };
