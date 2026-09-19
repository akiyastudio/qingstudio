const { sendToApplicationRenderers, applicationHostFor } = require('../services/application-windows.cjs');
const CHANNELS = ['background-tasks-list', 'background-task-cancel', 'background-task-pause', 'background-task-continue', 'background-task-dismiss', 'background-task-resume', 'background-task-restart', 'background-task-retry'];
const EXTERNAL_CHANNELS = new Set(['workspace-screenshot-main-image-progress', 'workspace-selection-progress']);
const SCREENSHOT_PHASES = new Set(['scanning', 'moving', 'copying', 'splitting', 'finishing', 'trashing', 'running', 'complete', 'cancelled', 'failed']);
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const serializeError = (error, fallback = '操作失败') => ({ code: typeof error?.code === 'string' ? error.code : 'BACKGROUND_TASK_FAILED', error: typeof error?.message === 'string' ? error.message : fallback });
const normalizedExternalId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9:._-]{0,199}$/i.test(value) ? value : '';
const boundedText = (value, maximum) => value === undefined ? undefined
  : typeof value === 'string' && value.length <= maximum && !value.includes('\0') ? value : null;
const finiteNumber = (value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, integer = false } = {}) => value === undefined ? undefined
  : typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum && (!integer || Number.isInteger(value)) ? value : null;

const normalizeExternalProgress = (channel, value = {}) => {
  if (!EXTERNAL_CHANNELS.has(channel) || !isPlainObject(value)) return null;
  const progress = finiteNumber(value.progress, { minimum: 0, maximum: 100 });
  if (progress === null) return null;
  const stateFor = phase => phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'cancelled' : phase === 'complete' ? 'completed' : 'running';
  if (channel === 'workspace-screenshot-main-image-progress') {
    const requestId = normalizedExternalId(value.requestId);
    if (!requestId || !SCREENSHOT_PHASES.has(value.phase)) return null;
    const message = boundedText(value.message, 4096);
    const currentName = boundedText(value.currentName, 1024);
    const processedCount = finiteNumber(value.processedCount, { integer: true });
    const totalCount = finiteNumber(value.totalCount, { integer: true });
    if ([message, currentName, processedCount, totalCount].includes(null)) return null;
    return { id: `external:screenshot-main-image:${requestId}`, type: 'screenshot-main-image', title: '提取截图主图', state: stateFor(value.phase), progress: progress ?? 0, message, metadata: { phase: value.phase, requestId, processedCount, totalCount, currentName } };
  }
  const operationId = normalizedExternalId(value.operationId);
  if (!operationId || !['copying', 'complete', 'cancelled', 'failed'].includes(value.phase)) return null;
  const fileName = boundedText(value.fileName, 1024);
  const rawMessage = boundedText(value.message, 4096);
  const error = boundedText(value.error, 4096);
  const bytesCopied = finiteNumber(value.bytesCopied);
  const totalBytes = finiteNumber(value.totalBytes);
  const filesCopied = finiteNumber(value.fileIndex, { integer: true });
  const totalFiles = finiteNumber(value.totalFiles, { integer: true });
  if ([fileName, rawMessage, error, bytesCopied, totalBytes, filesCopied, totalFiles].includes(null)) return null;
  return { id: `external:selection:${operationId}`, type: 'selection-operation', title: '选片文件处理', state: stateFor(value.phase), progress: progress ?? 0, message: fileName || rawMessage || '正在处理选片文件', error, cancellable: true, metadata: { phase: value.phase, operationId, bytesCopied, totalBytes, filesCopied, totalFiles } };
};

const registerBackgroundTasksIpc = ({ ipcMain, eventBus, backgroundTasks, getMainWindow, writeLog }) => {
  const trusted = event => {
    const window = applicationHostFor(event.sender) || getMainWindow();
    return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents
      && !event.sender.isDestroyed?.() && event.senderFrame === event.sender.mainFrame);
  };
  const handle = (channel, listener) => ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('Unauthorized IPC sender');
    try { return await listener(...args); } catch (error) { return { success: false, ...serializeError(error) }; }
  });
  const requireId = value => { if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0')) throw new Error('无效的任务 ID'); return value; };
  const sendTask = delta => { const window = getMainWindow(); if (window && !window.isDestroyed()) sendToApplicationRenderers(window, 'background-task-changed', delta); };
  const unsubscribe = eventBus.on('background-task:changed', sendTask);
  const externalProgressListener = (event, channel, value) => {
    try {
      if (!trusted(event) || typeof channel !== 'string') return;
      const task = normalizeExternalProgress(channel, value);
      if (task) backgroundTasks.upsertExternal(task);
    } catch (error) {
      const details = { channel: typeof channel === 'string' ? channel : '', error: error?.message || String(error) };
      try {
        if (typeof writeLog === 'function') writeLog('warn', 'Background task external progress rejected', details);
        else eventBus.emit('background-task:external-progress-error', details);
      } catch (_) { /* observer failures are isolated */ }
    }
  };
  ipcMain.on('background-task-external-progress', externalProgressListener);
  handle('background-tasks-list', async () => ({ success: true, ...backgroundTasks.snapshot() }));
  handle('background-task-cancel', async id => ({ success: backgroundTasks.cancel(requireId(id)) }));
  handle('background-task-pause', async id => ({ success: backgroundTasks.pause(requireId(id)) }));
  handle('background-task-continue', async id => ({ success: backgroundTasks.continuePaused(requireId(id)) }));
  handle('background-task-dismiss', async id => ({ success: backgroundTasks.dismiss(requireId(id)) }));
  handle('background-task-resume', async id => ({ success: true, task: (await backgroundTasks.resume(requireId(id))).task }));
  handle('background-task-restart', async id => ({ success: true, task: (await backgroundTasks.restart(requireId(id)))?.task }));
  handle('background-task-retry', async id => { const { completion: _completion, ...accepted } = await backgroundTasks.retry(requireId(id)); return { success: true, ...accepted }; });
  return () => { unsubscribe(); ipcMain.removeListener('background-task-external-progress', externalProgressListener); CHANNELS.forEach(channel => ipcMain.removeHandler(channel)); };
};

module.exports = { normalizeExternalProgress, registerBackgroundTasksIpc };
