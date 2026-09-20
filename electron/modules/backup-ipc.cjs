const { localizeDialogOptions } = require("../services/localization.cjs");
const { t: translateNative } = require("../services/localization.cjs");
const { applicationHostFor, sendToApplicationRenderers } = require('../services/application-windows.cjs');
const path = require('path');

const registerBackupIpc = ({ backupService, credentialService, dialog, ipcMain: electronIpcMain, getMainWindow, shell, writeLog, getTelemetry = () => undefined }) => {
  const channels = [];
  const serializeError = error => ({ success: false, code: typeof error?.code === 'string' ? error.code : 'BACKUP_IPC_FAILED', error: error?.message || String(error) });
  const trusted = event => { const window = applicationHostFor(event.sender) || getMainWindow(); return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents && !event.sender.isDestroyed?.()); };
  const ipcMain = { handle(channel, listener) { channels.push(channel); electronIpcMain.handle(channel, async (event, ...args) => { if (!trusted(event)) throw new Error('Unauthorized IPC sender'); try { return await listener(event, ...args); } catch (error) { return serializeError(error); } }); } };
  const rootPath = value => { if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('无效的工作区路径'); return path.resolve(value); };
  const acceptedTask = (result, logMessage, feature) => {
    if (!result?.success) return { success: false, ...(result?.code ? { code: result.code } : {}), error: result?.error || '后台任务未能登记' };
    if (typeof result.taskId !== 'string' || !result.taskId) return { success: false, code: 'INVALID_ACCEPTANCE', error: '后台任务登记结果无效' };
    if (result.completion && typeof result.completion.then === 'function') {
      void result.completion.then(value => {
        if (feature && !result.deduplicated) getTelemetry()?.track('feature_used', { feature, outcome: value?.cancelled || value?.canceled ? 'cancelled' : value?.success === false || value?.valid === false ? 'failed' : 'succeeded' });
      }, error => {
        if (feature && !result.deduplicated) getTelemetry()?.track('feature_used', { feature, outcome: /cancel|abort/i.test(String(error?.code || '')) ? 'cancelled' : 'failed' });
        writeLog('error', logMessage, error);
      }).catch(() => undefined);
    }
    return { success: true, queued: true, accepted: true, taskId: result.taskId, deduplicated: Boolean(result.deduplicated) };
  };
  const assertDomain = value => {
    const domain = String(value || '');
    if (!['media', 'versioning', 'operations'].includes(domain)) throw new Error('不支持的业务域');
    return domain;
  };
  ipcMain.handle('backup-choose-target', async (_event, currentPath = '') => {
    const result = await dialog.showOpenDialog(getMainWindow(), localizeDialogOptions({
      title: translateNative("native.2ec6efce7b3f"),
      defaultPath: currentPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    }));
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    return { cancelled: false, path: backupService.approveTarget(result.filePaths[0]) };
  });

  ipcMain.handle('backup-status', async (_event, workspacePath) => backupService.status(workspacePath));

  ipcMain.handle('backup-set-nas-target', async (_event, targetPath) => {
    try {
      if (!credentialService.isUncPath(targetPath)) throw new Error('请输入有效的 NAS 共享路径，例如 \\\\studio-nas\\backup');
      return { success: true, path: backupService.approveTarget(targetPath) };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-save-nas-credential', async (_event, request) => {
    try {
      return { success: true, ...await credentialService.saveNasCredential(request || {}) };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-read-nas-credential', async (_event, credentialRef) => {
    try {
      const credential = await credentialService.readNasCredential(credentialRef);
      return { success: true, credential: credential ? { credentialRef: credential.credentialRef || credentialRef, username: credential.username || '' } : null };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-delete-nas-credential', async (_event, credentialRef) => {
    try {
      await credentialService.deleteNasCredential(credentialRef);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-test-connection', async () => {
    try { return { success: true, connection: await backupService.testConnection() }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('backup-space-status', async (_event, workspacePath) => {
    try { return await backupService.spaceStatus(workspacePath); }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('backup-cleanup', async (_event, workspacePath) => {
    try {
      const root = rootPath(workspacePath);
      if (typeof backupService.enqueueCleanup === 'function') return acceptedTask(await backupService.enqueueCleanup(root), 'Backup cleanup failed');
      void backupService.cleanup(root).catch(error => writeLog('error', 'Backup cleanup failed', error));
      return { success: true, queued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-run', async (_event, workspacePath, reason = 'manual') => {
    try {
      const root = rootPath(workspacePath);
      if (typeof backupService.enqueueBackup === 'function') return acceptedTask(await backupService.enqueueBackup(root, reason), 'Workspace backup failed', 'backup_run');
      const current = await backupService.status(root);
      if (!current.enabled) return { success: false, error: '请先启用备份并选择备份位置' };
      void backupService.runBackup(root, reason).then(result => getTelemetry()?.track('feature_used', {feature:'backup_run', outcome:result?.cancelled ? 'cancelled' : result?.success === false ? 'failed' : 'succeeded'}), error => { getTelemetry()?.track('feature_used', {feature:'backup_run', outcome:/cancel|abort/i.test(String(error?.code || '')) ? 'cancelled' : 'failed'}); writeLog('error', 'Workspace backup failed', error); }).catch(() => undefined);
      return { success: true, queued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-run-if-due', async (_event, workspacePath) => {
    try {
      const result = await backupService.runIfDue(workspacePath);
      return { success: true, skipped: Boolean(result?.skipped) };
    } catch (error) {
      writeLog('warn', 'Scheduled workspace backup was not started', { error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-verify', async (_event, workspacePath, snapshotId) => {
    try {
      const root = rootPath(workspacePath);
      if (typeof backupService.enqueueVerify === 'function') return acceptedTask(await backupService.enqueueVerify(root, snapshotId), 'Backup verification failed', 'backup_verify');
      void backupService.verify(root, snapshotId).then(result => getTelemetry()?.track('feature_used', {feature:'backup_verify',outcome:result?.cancelled ? 'cancelled' : result?.success === false || result?.valid === false ? 'failed' : 'succeeded'}), error => {getTelemetry()?.track('feature_used', {feature:'backup_verify',outcome:/cancel|abort/i.test(String(error?.code || '')) ? 'cancelled' : 'failed'});writeLog('error','Backup verification failed',error);}).catch(() => undefined);
      return { success: true, queued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-domain-verify', async (_event, workspacePath, domain) => {
    try { return await backupService.verifyDomain(workspacePath, assertDomain(domain)); }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('backup-domain-run', async (_event, workspacePath, domain) => {
    try { return { success: true, ...await backupService.runDomainBackup(workspacePath, assertDomain(domain)) }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('backup-domain-restore', async (_event, workspacePath, snapshotId, domain) => {
    try { return { success: true, ...await backupService.restoreDomain(workspacePath, snapshotId, assertDomain(domain)) }; }
    catch (error) { writeLog('error', 'Domain restore failed', error); return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('backup-domain-reset', async (_event, workspacePath, domain) => {
    try { return { success: true, ...await backupService.resetDomain(workspacePath, assertDomain(domain)) }; }
    catch (error) { writeLog('error', 'Domain reset failed', error); return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('backup-restore-workspace', async (_event, workspacePath, snapshotId) => {
    try {
      const selected = await dialog.showOpenDialog(getMainWindow(), localizeDialogOptions({
        title: translateNative("native.72f2063aaa16"),
        properties: ['openDirectory', 'createDirectory'],
      }));
      if (selected.canceled || !selected.filePaths[0]) return { success: false, cancelled: true };
      const result = await backupService.restoreWorkspace(workspacePath, snapshotId, selected.filePaths[0]);
      return { success: true, workspacePath: result?.result?.workspacePath || path.resolve(selected.filePaths[0]), savedConfig: result?.result?.savedConfig };
    } catch (error) {
      writeLog('error', 'Workspace restore failed', error);
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-restore-project', async (_event, workspacePath, snapshotId, projectId) => {
    try {
      const result = await backupService.restoreProject(workspacePath, snapshotId, projectId);
      const project = result?.result?.project;
      const window = getMainWindow();
      if (window && !window.isDestroyed()) sendToApplicationRenderers(window, 'workspace-projects-changed', { root: path.resolve(workspacePath), reason: 'project-restored' });
      return { success: true, project };
    } catch (error) {
      writeLog('error', 'Project restore failed', error);
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('backup-open-target', async () => {
    try {
      const status = await backupService.status('');
      if (!status.targetPath) throw new Error('尚未设置备份位置');
      const error = await shell.openPath(status.targetPath);
      if (error) throw new Error(error);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  return () => channels.forEach(channel => electronIpcMain.removeHandler(channel));
};

module.exports = { registerBackupIpc };
