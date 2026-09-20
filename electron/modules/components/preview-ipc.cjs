const { getPreviewRuntime } = require('../../services/component-preview-service.cjs');
const { listPreviewDecoders, decodePreview } = require('../../services/component-preview-decoder-service.cjs');
const { exact } = require('../../services/component-file-resources.cjs');
const validateContext = value => {
  exact(value, ['workspacePath', 'projectId', 'projectName', 'projectStatus', 'scopeRelativePath', 'sourcePageId', 'contentKind'], ['workspacePath', 'projectId', 'projectName', 'projectStatus', 'scopeRelativePath', 'sourcePageId']);
  for (const [key, item] of Object.entries(value)) if (typeof item !== 'string' || item.length > (key === 'workspacePath' ? 4096 : 1024) || item.includes('\0')) throw new TypeError('Invalid preview context');
  if (!value.sourcePageId || value.contentKind !== undefined && !['project', 'inspiration'].includes(value.contentKind)) throw new TypeError('Invalid preview page');
  return value;
};
const registerComponentPreviewIpc = ({ ipcMain, manager, mainRenderer }) => {
  const owners = new Set();
  ipcMain.handle('component-preview:publish', (event, request) => {
    mainRenderer(event); exact(request, ['context', 'update'], ['context', 'update']);
    const owner = event.sender;
    if (!owners.has(owner.id)) { owners.add(owner.id); owner.once('destroyed', () => { owners.delete(owner.id); getPreviewRuntime().preview.clearOwner(owner.id); }); }
    return getPreviewRuntime().preview.publish(owner, manager.resolveOpenContext(validateContext(request.context)), request.update);
  });
  ipcMain.handle('component-preview:seek-result', (event, result) => { mainRenderer(event); getPreviewRuntime().preview.acknowledge(event.sender, result); });
  ipcMain.handle('component-preview:decoders', event => { mainRenderer(event); return listPreviewDecoders(manager); });
  ipcMain.handle('component-preview:thumbnail', async (event, request) => {
    mainRenderer(event);
    try { validateContext(request?.context); return { success: true, ...(await require('../../services/component-thumbnail-service.cjs').componentThumbnail(manager, request, event.sender)) }; }
    catch (error) { return { success: false, error: error.message || String(error), errorCode: error.code || 'COMPONENT_HOST_INTERNAL' }; }
  });
  ipcMain.handle('component-preview:decode', async (event, request) => {
    mainRenderer(event);
    try { validateContext(request?.context); return { success: true, ...(await decodePreview(manager, request, undefined, event.sender)) }; }
    catch (error) { return { success: false, error: error.message || String(error), errorCode: error.code || 'COMPONENT_HOST_INTERNAL' }; }
  });
  ipcMain.handle('component-preview:cancel', async (event, request) => {
    mainRenderer(event); exact(request, ['requestId'], ['requestId']);
    await getPreviewRuntime().videoPreviews.cancel(event.sender, request.requestId); return { success: true };
  });
  ipcMain.handle('component-preview:playback', async (event, request) => {
    mainRenderer(event);
    try { return await getPreviewRuntime().videoPreviews.invoke(event.sender, request); }
    catch (error) { return { success: false, error: error.message || String(error), errorCode: error.code || 'COMPONENT_HOST_INTERNAL' }; }
  });
};
module.exports = { registerComponentPreviewIpc, validateContext };
