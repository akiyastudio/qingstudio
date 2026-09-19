const { applicationHostFor, sendToApplicationRenderers } = require('../services/application-windows.cjs');
const path = require('path');

const registerArchiveIpc = ({ archiveService, dialog, getMainWindow, ipcMain: electronIpcMain, shell, writeLog }) => {
  const channels = [];
  const trusted = event => { const window = applicationHostFor(event.sender) || getMainWindow(); return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents && !event.sender.isDestroyed?.()); };
  const ipcMain = { handle(channel, listener) { channels.push(channel); electronIpcMain.handle(channel, async (event, ...args) => { if (!trusted(event)) throw new Error('Unauthorized IPC sender'); try { return await listener(event, ...args); } catch (error) { return { success: false, code: typeof error?.code === 'string' ? error.code : 'ARCHIVE_IPC_FAILED', error: error?.message || String(error) }; } }); } };
  const rootPath = value => { if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('无效的工作区路径'); return path.resolve(value); };
  const cleanProjectName = value => { if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\\/\0]/.test(value)) throw new Error('无效的项目名称'); return value.trim(); };
  const cleanProjectReference = value => {
    if (!value || typeof value !== 'object') return cleanProjectName(value);
    const id = String(value.id || '').trim();
    const name = String(value.name || '').trim();
    if (!id || id.length > 255 || /[\\/\0]/.test(id)) throw new Error('无效的项目 ID');
    return { id, ...(name ? { name: cleanProjectName(name) } : {}) };
  };
  const acceptedTask = (result, logMessage, onComplete) => {
    if (!result?.success) return { success: false, ...(result?.code ? { code: result.code } : {}), error: result?.error || '后台任务未能登记' };
    if (typeof result.taskId !== 'string' || !result.taskId) return { success: false, code: 'INVALID_ACCEPTANCE', error: '后台任务登记结果无效' };
    if (result.completion && typeof result.completion.then === 'function') void result.completion.then(onComplete).catch(error => writeLog('error', logMessage, error));
    return { success: true, queued: true, accepted: true, taskId: result.taskId, deduplicated: Boolean(result.deduplicated) };
  };
  ipcMain.handle('archive-choose-target', async (_event, currentPath = '') => {
    const result = await dialog.showOpenDialog(getMainWindow(), { title: '选择 PhotoFlow 项目归档盘', defaultPath: currentPath || undefined, properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    return { cancelled: false, path: archiveService.approveTarget(result.filePaths[0]) };
  });
  ipcMain.handle('archive-status', async () => archiveService.status());
  ipcMain.handle('archive-project', async (_event, workspacePath, projectName) => {
    try {
      const root = rootPath(workspacePath);
      const name = cleanProjectReference(projectName);
      if (typeof archiveService.enqueueArchiveProject === 'function') return acceptedTask(await archiveService.enqueueArchiveProject(root, name), 'Project archive failed', () => {
        const window = getMainWindow();
        if (window && !window.isDestroyed()) sendToApplicationRenderers(window, 'workspace-projects-changed', { root, reason: 'project-archived' });
      });
      void archiveService.archiveProject(root, name).then(() => {
        const window = getMainWindow();
        if (window && !window.isDestroyed()) sendToApplicationRenderers(window, 'workspace-projects-changed', { root: workspacePath, reason: 'project-archived' });
      }).catch(error => writeLog('error', 'Project archive failed', error));
      return { success: true, queued: true };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('archive-move-back', async (_event, workspacePath, projectName, statusAfter) => {
    try {
      const root = rootPath(workspacePath);
      const name = cleanProjectReference(projectName);
      if (typeof archiveService.enqueueMoveBack === 'function') return acceptedTask(await archiveService.enqueueMoveBack(root, name, statusAfter), 'Project move-back failed', () => {
        const window = getMainWindow();
        if (window && !window.isDestroyed()) sendToApplicationRenderers(window, 'workspace-projects-changed', { root, reason: 'project-unarchived' });
      });
      void archiveService.moveBack(root, name, statusAfter).then(() => {
        const window = getMainWindow();
        if (window && !window.isDestroyed()) sendToApplicationRenderers(window, 'workspace-projects-changed', { root: workspacePath, reason: 'project-unarchived' });
      }).catch(error => writeLog('error', 'Project move-back failed', error));
      return { success: true, queued: true };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('archive-open-target', async () => {
    try {
      const current = await archiveService.status();
      if (!current.targetPath) throw new Error('尚未设置归档盘');
      const error = await shell.openPath(current.targetPath);
      if (error) throw new Error(error);
      return { success: true };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  return () => channels.forEach(channel => electronIpcMain.removeHandler(channel));
};

module.exports = { registerArchiveIpc };
