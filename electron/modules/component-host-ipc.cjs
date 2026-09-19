const { applicationHostFor } = require('../services/application-windows.cjs');
const registerComponentHostIpc = ({ ipcMain, manager, mainWindow }) => {
  const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
  const exact = (value, allowed, required = []) => {
    if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new TypeError('Invalid component host request');
    return value;
  };
  const text = (value, maximum, required = true) => {
    if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || required && !value.trim()) throw new TypeError('Invalid component host text field');
    return value;
  };
  const instanceId = value => text(value, 200, false);
  const openRequest = (value, contribution = false) => {
    const allowed = contribution
      ? ['componentId', 'contributionId', 'type', 'workspacePath', 'projectId', 'projectName', 'projectStatus', 'scopeRelativePath', 'selectedRelativePaths', 'sourcePageId', 'contentKind']
      : ['componentId', 'pageId', 'workspacePath', 'projectId', 'projectName', 'projectStatus', 'scopeRelativePath', 'selectedRelativePaths', 'sourcePageId', 'contentKind'];
    const required = contribution ? ['componentId', 'contributionId', 'type'] : ['componentId', 'pageId', 'workspacePath', 'projectId', 'projectName', 'projectStatus'];
    exact(value, allowed, required); text(value.componentId, 80); text(contribution ? value.contributionId : value.pageId, 80);
    for (const field of ['workspacePath', 'projectId', 'projectName', 'projectStatus', 'scopeRelativePath', 'sourcePageId']) if (value[field] !== undefined) text(value[field], field === 'workspacePath' ? 4096 : 512, false);
    if (value.contentKind !== undefined && !['project', 'inspiration'].includes(value.contentKind)) throw new TypeError('Invalid component content kind');
    if (value.selectedRelativePaths !== undefined && (!Array.isArray(value.selectedRelativePaths) || value.selectedRelativePaths.length > 10000 || value.selectedRelativePaths.some(item => typeof item !== 'string' || item.length > 1024 || item.includes('\0')))) throw new TypeError('Invalid component selection');
    return value;
  };
  const settingsRequest = (value, update = false) => { exact(value, update ? ['componentId', 'pageId', 'patch'] : ['componentId', 'pageId'], update ? ['componentId', 'pageId', 'patch'] : ['componentId', 'pageId']); text(value.componentId, 80); text(value.pageId, 80); if (update && (!plain(value.patch) || Buffer.byteLength(JSON.stringify(value.patch)) > 256 * 1024)) throw new TypeError('Invalid component settings patch'); return value; };
  const mainRenderer = event => {
    const host = applicationHostFor(event.sender) || mainWindow;
    if (!host || host.isDestroyed() || event.sender !== host.webContents
      || !event.senderFrame || event.senderFrame !== host.webContents.mainFrame) throw new Error('Unauthorized component host sender');
  };
  require('./component-preview-ipc.cjs').registerComponentPreviewIpc({ ipcMain, manager, mainRenderer });
  ipcMain.handle('component-host-list', event => { mainRenderer(event); return { success: true, actions: manager.listToolbarActions() }; });
  ipcMain.handle('component-host-settings-list', event => { mainRenderer(event); return { success: true, pages: manager.listSettingsPages() }; });
  ipcMain.handle('component-host-settings-form-read', (event, request) => { mainRenderer(event); return manager.readSettingsForm(settingsRequest(request)).then(result => ({ success: true, ...result }), error => ({ success: false, error: error.message || String(error) })); });
  ipcMain.handle('component-host-settings-form-update', (event, request) => { mainRenderer(event); return manager.updateSettingsForm(settingsRequest(request, true)).then(result => ({ success: true, ...result }), error => ({ success: false, error: error.message || String(error) })); });
  ipcMain.handle('component-host-contributions-list', event => { mainRenderer(event); return { success: true, contributions: manager.listContributions() }; });
  ipcMain.handle('component-host-open', (event, request) => { mainRenderer(event); return manager.open(openRequest(request)).then(page => ({ success: true, page }), error => ({ success: false, error: error.message || String(error) })); });
  ipcMain.handle('component-host-settings-open', (event, request) => { mainRenderer(event); exact(request, ['componentId', 'pageId', 'leaseId'], ['componentId', 'pageId', 'leaseId']); text(request.componentId, 80); text(request.pageId, 80); text(request.leaseId, 160); return manager.openSettings(request).then(page => ({ success: true, page }), error => ({ success: false, error: error.message || String(error) })); });
  ipcMain.handle('component-host-contribution-open', (event, request) => { mainRenderer(event); return manager.openContribution(openRequest(request, true)).then(page => ({ success: true, page }), error => ({ success: false, error: error.message || String(error) })); });
  ipcMain.handle('component-host-settings-release', (event, request) => { mainRenderer(event); exact(request, ['componentId', 'pageId', 'leaseId'], ['componentId', 'pageId', 'leaseId']); text(request.componentId, 80); text(request.pageId, 80); text(request.leaseId, 160); return { success: manager.releaseSettings(request) }; });
  ipcMain.handle('component-host-activate', (event, value) => { mainRenderer(event);exact(value,['instanceId','deactivateIfActive'],['instanceId']);const id=instanceId(value.instanceId);manager.assertOwned?.(id);if(value.deactivateIfActive!==undefined&&value.deactivateIfActive!==true)throw new TypeError('Invalid conditional component deactivation');return { success: value.deactivateIfActive === true ? manager.deactivateIfActive(id) : manager.activate(id) }; });
  ipcMain.handle('component-host-set-suspended', (event, update) => {
    mainRenderer(event);
    exact(update, ['rendererToken', 'revision', 'suspended'], ['rendererToken', 'revision', 'suspended']);
    return { success: manager.setHostSurfaceSuspended(update) };
  });
  ipcMain.handle('component-host-notifications-ready', (event, update) => {
    mainRenderer(event);
    exact(update, ['rendererToken', 'revision', 'ready'], ['rendererToken', 'revision', 'ready']);
    return manager.setNotificationRendererReady(update);
  });
  ipcMain.handle('component-host-set-bounds', (event, value, bounds) => { mainRenderer(event); exact(bounds, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height']); manager.assertOwned?.(instanceId(value)); return { success: manager.setBounds(instanceId(value), bounds) }; });
  ipcMain.handle('component-host-close', (event, value) => { mainRenderer(event); manager.assertOwned?.(instanceId(value)); return { success: manager.close(instanceId(value)) }; });
  ipcMain.handle('component-host-close-project', (event, workspacePath, projectId) => { mainRenderer(event); text(workspacePath, 4096); text(projectId, 160); return { success: true, closedCount: manager.closeProject(workspacePath, projectId) }; });
};

module.exports = { registerComponentHostIpc };
