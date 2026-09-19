const path = require('node:path');
const { WorkspaceWindowManager } = require('./workspace-window-manager.cjs');
const { ToastViewManager } = require('./toast-view-manager.cjs');
const { createToastHostIpc } = require('./toast-host-ipc.cjs');

const createApplicationWindowRuntime = ({ app, BrowserWindow, WebContentsView, View, Menu, screen, ipcMain, electronIpcMain,
  electronDirectory, rendererEntryFile, toastViewRendererFile, developmentRendererUrl, smokeTestEnabled,
  configureWindowSecurity, isDevelopmentRenderer, getQuitState, getComponentViewManager, getVideoPlaybackService, getTelemetryService, writeLog }) => {
  Menu.setApplicationMenu(null);
  const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, ...(smokeTestEnabled ? { offscreen: true } : {}) };
  const pagePreferences = { ...preferences, preload: path.join(electronDirectory, 'preload.cjs') };
  const createNativeWindow = (bounds, webPreferences = preferences) => new BrowserWindow({
    ...bounds, show: false, frame: false, thickFrame: true, backgroundColor: '#f8fafc',
    icon: app.isPackaged ? undefined : path.join(electronDirectory, '../packaging/icon.ico'), webPreferences,
  });
  const mainWindow = createNativeWindow({ width: 1280, height: 800 }, pagePreferences);
  const loadRenderer = contents => isDevelopmentRenderer() ? contents.loadURL(developmentRendererUrl) : contents.loadFile(rendererEntryFile);
  const configureRenderer = host => {
    configureWindowSecurity(host);
    const contents = host.webContents;
    contents.on('render-process-gone', (_event, details) => getTelemetryService()?.reportCrash('renderer', new Error(`Renderer process exited: ${details.reason}`), { reason: details.reason, exit_code: details.exitCode }));
    contents.on('preload-error', (_event, preloadPath, error) => writeLog('error', 'Application preload failed', { preloadPath, error: error?.stack || error?.message || String(error) }));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => { if (isMainFrame) writeLog('error', 'Application renderer failed to load', { errorCode, errorDescription, validatedUrl }); });
    contents.on('console-message', (_event, details) => { if (details?.level === 'error' || details?.level === 3) writeLog('error', 'Renderer console error', { message: details.message, lineNumber: details.lineNumber, sourceId: details.sourceId }); });
  };
  const createToast = host => new ToastViewManager({ WebContentsView, mainWindow: host, ipcMain: createToastHostIpc(electronIpcMain, host),
    preloadPath: path.join(electronDirectory, 'toast-view-preload.cjs'), rendererFile: toastViewRendererFile, developmentRendererUrl, writeLog });
  configureRenderer(mainWindow);
  let toastViewManager;
  const workspaceWindows = new WorkspaceWindowManager({
    BrowserWindow, WebContentsView, View, screen, ipcMain, configureSecurity: configureRenderer,
    sharedTabs: true, transferComponent: (id, source, destination) => getComponentViewManager().transferInstance(id, source, destination),
    pageComponents: (host, pageId) => pageId ? [...getComponentViewManager().instancesById.values()].filter(instance => instance.host === host && instance.contribution && instance.context.sourcePageId === pageId).map(instance => instance.instanceId) : [],
    webPreferences: { ...pagePreferences, backgroundThrottling: false }, createWindow: createNativeWindow, loadRenderer,
    onHostCreated: host => { if (!host.root) host.toast = createToast(host); },
    onHostClosed: host => { host.toast?.destroy(); getComponentViewManager()?.closeHost(host); },
    onHostMoved: host => getVideoPlaybackService()?.moveHost?.(host.webContents, host.nativeWindow) || Promise.resolve(),
    onHostVisibility: (host, visible) => { getVideoPlaybackService()?.setHostVisible?.(host.webContents, visible); (host.toast || (host.root ? toastViewManager : null))?.setHostVisible(visible); },
    onLastWindowClose: () => app.quit(), canQuit: () => getQuitState() === 'ready', canMutate: () => getQuitState() === 'idle', writeLog,
  });
  const root = workspaceWindows.registerRoot(mainWindow);
  toastViewManager = createToast(mainWindow);
  mainWindow.center();
  mainWindow.once('ready-to-show', () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.maximize(); mainWindow.show();
    workspaceWindows.sendWindowState(workspaceWindows.windows.get(root.nativeWindow.id));
  });
  return { mainWindow, workspaceWindows, toastViewManager, loadMainWindowRenderer: () => {
    if (!mainWindow.isDestroyed()) void loadRenderer(mainWindow.webContents);
  } };
};
module.exports = { createApplicationWindowRuntime };
