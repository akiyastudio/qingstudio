const { applicationHostFor } = require('../services/application-windows.cjs');
const registerCompressedFilesIpc = ({ ipcMain, service }) => {
  const owners = new Set();
  ipcMain.handle('compressed-files', async (event, request) => {
    const host = applicationHostFor(event.sender);
    if (!host || host.isDestroyed() || host.webContents !== event.sender) throw new Error('Unauthorized IPC sender');
    const owner = event.sender.id;
    if (!owners.has(owner)) { owners.add(owner); event.sender.once('destroyed', () => { owners.delete(owner); void service.closeOwner(owner); }); }
    try { return { success: true, result: await service.request(owner, request) }; }
    catch (error) { return { success: false, code: error.code || 'COMPRESSION_FAILED', error: error.message || String(error) }; }
  });
  return () => { ipcMain.removeHandler('compressed-files'); void service.destroy(); };
};
module.exports = { registerCompressedFilesIpc };
