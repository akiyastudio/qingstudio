const { applicationHostFor } = require('../services/application-windows.cjs');
const registerStorageUsageIpc = ({ ipcMain, storageUsageService, getMainWindow, assertTrustedSender }) => {
  const channel = 'storage-usage-overview';
  ipcMain.handle(channel, async (event, force = false) => {
    const mainWindow = applicationHostFor(event.sender) || getMainWindow?.();
    const exactMainWindowSender = Boolean(mainWindow && !mainWindow.isDestroyed?.()
      && event?.sender === mainWindow.webContents && !event.sender.isDestroyed?.()
      && event.senderFrame === event.sender.mainFrame);
    const trusted = exactMainWindowSender
      && (typeof assertTrustedSender !== 'function' || assertTrustedSender(event) === true);
    if (!trusted) throw new Error('Unauthorized IPC sender');
    if (!storageUsageService || typeof storageUsageService.overview !== 'function') {
      return { success: false, updatedAt: 0, scanning: false, stale: true, volumes: [], code: 'STORAGE_USAGE_UNAVAILABLE', error: '存储用量服务不可用' };
    }
    if (force !== false && force !== true) return { success: false, updatedAt: 0, scanning: false, stale: true, volumes: [], code: 'INVALID_ARGUMENT', error: 'force 只接受 true' };
    try { return await storageUsageService.overview(force === true); }
    catch (error) { return { success: false, updatedAt: 0, scanning: false, stale: true, volumes: [], code: typeof error?.code === 'string' ? error.code : 'STORAGE_USAGE_FAILED', error: error.message || String(error) }; }
  });
  return () => ipcMain.removeHandler(channel);
};

module.exports = { registerStorageUsageIpc };
