const { isSupportedLocale } = require('./localization.cjs');
const TOAST_VIEW_MAX_ITEMS = 12;
const TOAST_VIEW_MAX_WIDTH = 720;
const TOAST_VIEW_MAX_HEIGHT = 2000;
const TOAST_VIEW_VISIBLE_MAX_HEIGHT = 448;
const TOAST_VIEW_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 5000]);
const TOAST_VIEW_EMPTY_GRACE_MS = 180;
const TOAST_VIEW_MAX_REFLOW_MS = 300;
const TOAST_VIEW_ACTIONS = new Set(['notice-dismiss', 'task-dismiss', 'task-minimize', 'task-pause', 'task-continue', 'task-cancel']);

const finiteInteger = value => Number.isSafeInteger(value);
const validSnapshot = value => value && typeof value === 'object' && !Array.isArray(value)
  && finiteInteger(value.revision) && value.revision >= 0
  && typeof value.dark === 'boolean'
  && finiteInteger(value.top) && value.top >= 0 && value.top <= 2000
  && finiteInteger(value.width) && value.width >= 0 && value.width <= TOAST_VIEW_MAX_WIDTH
  && finiteInteger(value.height) && value.height >= 0 && value.height <= TOAST_VIEW_MAX_HEIGHT
  && Array.isArray(value.notices) && value.notices.length <= TOAST_VIEW_MAX_ITEMS
  && Array.isArray(value.tasks) && value.tasks.length <= 4
  && (value.language === undefined || isSupportedLocale(value.language))
  && finiteInteger(value.overflowCount) && value.overflowCount >= 0 && value.overflowCount <= 10000;

const validAction = value => value && typeof value === 'object' && !Array.isArray(value)
  && TOAST_VIEW_ACTIONS.has(value.action)
  && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200;

const snapshotLayoutKey = snapshot => JSON.stringify({
  language: snapshot.language || 'zh-CN',
  width: snapshot.width,
  notices: snapshot.notices.map(notice => [notice.id, notice.message, notice.count]),
  tasks: snapshot.tasks.map(task => [task.id, task.state]),
  overflow: snapshot.overflowCount > 0,
});

class ToastViewManager {
  constructor({ WebContentsView, mainWindow, ipcMain, preloadPath, rendererFile, developmentRendererUrl = '', writeLog = () => undefined, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    this.WebContentsView = WebContentsView;
    this.mainWindow = mainWindow;
    this.ipcMain = ipcMain;
    this.preloadPath = preloadPath;
    this.rendererFile = rendererFile;
    this.developmentRendererUrl = developmentRendererUrl;
    this.writeLog = writeLog;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.view = null;
    this.ready = false;
    this.nativeDragDepth = 0;
    this.hostVisible = true;
    this.renderedHeight = 0;
    this.loadRetryAttempt = 0;
    this.loadRetryTimer = null;
    this.emptyHideTimer = null;
    this.layoutShrinkTimer = null;
    this.layoutShrinkTarget = null;
    this.presentationVisible = false;
    this.snapshot = { revision: 0, dark: false, top: 40, width: 0, height: 0, notices: [], tasks: [], overflowCount: 0 };
    this.layoutKey = snapshotLayoutKey(this.snapshot);
    this.renderedLayoutKey = '';
    this.renderedRevision = -1;
    this.onWindowResize = () => this.publishPresentation(this.syncBounds());
    this.onUpdate = (event, snapshot) => {
      if (event.sender !== this.mainWindow?.webContents) throw new Error('Unauthorized toast view sender');
      if (!validSnapshot(snapshot)) throw new Error('Invalid toast view snapshot');
      const nextLayoutKey = snapshotLayoutKey(snapshot);
      const layoutChanged = nextLayoutKey !== this.layoutKey;
      if (layoutChanged) this.clearLayoutShrink();
      const previousSnapshot = this.snapshot;
      this.snapshot = Object.freeze({ ...snapshot, notices: Object.freeze([...snapshot.notices]), tasks: Object.freeze([...snapshot.tasks]) });
      this.layoutKey = nextLayoutKey;
      this.sendSnapshot();
      const hasContent = snapshot.notices.length > 0 || snapshot.tasks.length > 0 || snapshot.overflowCount > 0;
      if (!hasContent) {
        this.scheduleEmptyHide();
        return { success: true };
      }
      this.clearEmptyHide();
      if (layoutChanged && !this.presentationVisible) this.renderedHeight = snapshot.height;
      const hostBoundsChanged = snapshot.width !== previousSnapshot.width || snapshot.top !== previousSnapshot.top;
      if (!this.presentationVisible || hostBoundsChanged) {
        const visible = this.syncBounds();
        if (!visible) this.publishPresentation(false);
      }
      return { success: true };
    };
    this.onReady = event => {
      if (event.sender !== this.view?.webContents) return;
      this.clearLoadRetry();
      this.ready = true;
      this.sendSnapshot();
      this.syncBounds();
    };
    this.onLayout = (event, layout) => {
      if (event.sender !== this.view?.webContents || !layout || layout.revision !== this.snapshot.revision) return;
      const height = Number(layout.height);
      if (!finiteInteger(height) || height < 0 || height > TOAST_VIEW_MAX_HEIGHT) return;
      const nextHeight = Math.min(height, TOAST_VIEW_VISIBLE_MAX_HEIGHT);
      if (nextHeight === 0) {
        this.clearLayoutShrink();
        this.scheduleEmptyHide();
        return;
      }
      this.clearEmptyHide();
      if (layout.revision === this.renderedRevision) return;
      if (nextHeight === this.renderedHeight && this.presentationVisible) {
        this.renderedLayoutKey = this.layoutKey;
        this.renderedRevision = layout.revision;
        return;
      }
      const reflowMs = finiteInteger(layout.reflowMs) ? Math.max(0, Math.min(TOAST_VIEW_MAX_REFLOW_MS, layout.reflowMs)) : 0;
      if (this.presentationVisible && nextHeight < this.renderedHeight && reflowMs > 0) {
        this.renderedRevision = layout.revision;
        this.scheduleLayoutShrink(nextHeight, reflowMs, layout.revision);
        return;
      }
      this.clearLayoutShrink();
      this.renderedHeight = nextHeight;
      this.renderedLayoutKey = this.layoutKey;
      this.renderedRevision = layout.revision;
      this.publishPresentation(this.syncBounds());
    };
    this.onAction = (event, action) => {
      if (event.sender !== this.view?.webContents || !validAction(action)) return;
      if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.webContents.isDestroyed()) return;
      this.mainWindow.webContents.send('toast-view:action', Object.freeze({ action: action.action, id: action.id }));
      this.mainWindow.webContents.focus();
    };
    this.registerIpc();
    this.create();
  }

  registerIpc() {
    this.ipcMain.handle('toast-view:update', this.onUpdate);
    this.ipcMain.on('toast-view:ready', this.onReady);
    this.ipcMain.on('toast-view:layout', this.onLayout);
    this.ipcMain.on('toast-view:action', this.onAction);
  }

  create() {
    const view = new this.WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
      },
    });
    this.view = view;
    view.setBackgroundColor('#00000000');
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.on('preload-error', (_event, _preloadPath, error) => this.writeLog('error', 'Toast view preload failed', { error: error?.stack || error?.message || String(error) }));
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame === false) return;
      this.ready = false;
      view.setVisible(false);
      this.publishPresentation(false);
      this.writeLog('error', 'Toast view failed to load', { errorCode, errorDescription, validatedUrl });
      this.scheduleLoadRetry();
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      this.ready = false;
      view.setVisible(false);
      this.publishPresentation(false);
      this.writeLog('error', 'Toast view renderer exited', { reason: details?.reason, exitCode: details?.exitCode });
      if (this.developmentRendererUrl) this.scheduleLoadRetry();
      else this.loadView();
    });
    this.mainWindow.contentView.addChildView(view);
    this.mainWindow.on('resize', this.onWindowResize);
    this.loadView();
  }

  loadView() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    const loading = this.developmentRendererUrl
      ? view.webContents.loadURL(`${this.developmentRendererUrl.replace(/\/$/, '')}/toast-view.html`)
      : view.webContents.loadFile(this.rendererFile);
    // did-fail-load owns diagnostics; this catch only prevents an unhandled
    // rejection and covers implementations that reject without emitting it.
    void Promise.resolve(loading).catch(() => this.scheduleLoadRetry());
  }

  scheduleLoadRetry() {
    // A packaged renderer is local and cannot recover from a missing artifact.
    // Development URLs can temporarily disappear while Vite starts or restarts.
    if (!this.developmentRendererUrl || this.loadRetryTimer !== null) return;
    const delay = TOAST_VIEW_RETRY_DELAYS_MS[Math.min(this.loadRetryAttempt, TOAST_VIEW_RETRY_DELAYS_MS.length - 1)];
    this.loadRetryAttempt += 1;
    this.loadRetryTimer = this.setTimeoutFn(() => {
      this.loadRetryTimer = null;
      this.loadView();
    }, delay);
  }

  clearLoadRetry() {
    if (this.loadRetryTimer !== null) this.clearTimeoutFn(this.loadRetryTimer);
    this.loadRetryTimer = null;
    this.loadRetryAttempt = 0;
  }

  scheduleEmptyHide() {
    if (!this.presentationVisible) {
      this.renderedHeight = 0;
      this.syncBounds();
      return;
    }
    if (this.emptyHideTimer !== null) return;
    this.emptyHideTimer = this.setTimeoutFn(() => {
      this.emptyHideTimer = null;
      const hasContent = this.snapshot.notices.length > 0 || this.snapshot.tasks.length > 0 || this.snapshot.overflowCount > 0;
      if (hasContent) return;
      this.renderedHeight = 0;
      this.renderedLayoutKey = this.layoutKey;
      this.publishPresentation(this.syncBounds());
    }, TOAST_VIEW_EMPTY_GRACE_MS);
  }

  clearEmptyHide() {
    if (this.emptyHideTimer !== null) this.clearTimeoutFn(this.emptyHideTimer);
    this.emptyHideTimer = null;
  }

  scheduleLayoutShrink(height, delay, revision) {
    this.layoutShrinkTarget = { height, revision, layoutKey: this.layoutKey };
    if (this.layoutShrinkTimer !== null) return;
    this.layoutShrinkTimer = this.setTimeoutFn(() => {
      this.layoutShrinkTimer = null;
      const target = this.layoutShrinkTarget;
      this.layoutShrinkTarget = null;
      if (!target || this.layoutKey !== target.layoutKey || this.snapshot.revision !== target.revision) return;
      this.renderedHeight = target.height;
      this.renderedLayoutKey = target.layoutKey;
      this.renderedRevision = target.revision;
      this.publishPresentation(this.syncBounds());
    }, delay);
  }

  clearLayoutShrink() {
    if (this.layoutShrinkTimer !== null) this.clearTimeoutFn(this.layoutShrinkTimer);
    this.layoutShrinkTimer = null;
    this.layoutShrinkTarget = null;
  }

  sendSnapshot() {
    if (!this.ready || !this.view || this.view.webContents.isDestroyed()) return;
    this.view.webContents.send('toast-view:snapshot', this.snapshot);
  }

  publishPresentation(visible) {
    const nextVisible = Boolean(visible);
    if (this.presentationVisible === nextVisible) return;
    this.presentationVisible = nextVisible;
    if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.webContents.isDestroyed()) return;
    this.mainWindow.webContents.send('toast-view:presentation', Object.freeze({ visible: nextVisible }));
  }

  syncBounds() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return false;
    const content = this.mainWindow.getContentBounds();
    const width = Math.min(this.snapshot.width, Math.max(0, content.width - 16));
    const maximumHeight = Math.max(0, content.height - this.snapshot.top - 8);
    const height = Math.min(this.renderedHeight, maximumHeight);
    if (!this.ready || !this.hostVisible || this.nativeDragDepth > 0 || width <= 0 || height <= 0) {
      view.setVisible(false);
      return false;
    }
    view.setBounds({ x: Math.max(0, Math.round((content.width - width) / 2)), y: this.snapshot.top, width, height });
    view.setVisible(true);
    return true;
  }

  bringToFront() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    try { this.mainWindow.contentView.removeChildView(view); } catch { /* already detached */ }
    this.mainWindow.contentView.addChildView(view);
    this.publishPresentation(this.syncBounds());
  }

  setHostVisible(visible) {
    this.hostVisible = Boolean(visible);
    this.publishPresentation(this.syncBounds());
  }

  suspendForNativeDrag() {
    this.nativeDragDepth += 1;
    this.view?.setVisible(false);
    this.publishPresentation(false);
  }

  resumeAfterNativeDrag() {
    this.nativeDragDepth = Math.max(0, this.nativeDragDepth - 1);
    if (this.nativeDragDepth === 0) this.publishPresentation(this.syncBounds());
  }

  destroy() {
    this.clearLoadRetry();
    this.clearEmptyHide();
    this.clearLayoutShrink();
    this.ipcMain.removeHandler('toast-view:update');
    this.ipcMain.removeListener('toast-view:ready', this.onReady);
    this.ipcMain.removeListener('toast-view:layout', this.onLayout);
    this.ipcMain.removeListener('toast-view:action', this.onAction);
    this.mainWindow?.removeListener('resize', this.onWindowResize);
    const view = this.view;
    this.view = null;
    this.ready = false;
    if (!view) return;
    try { this.mainWindow.contentView.removeChildView(view); } catch { /* already detached */ }
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }
}

module.exports = { TOAST_VIEW_EMPTY_GRACE_MS, TOAST_VIEW_MAX_REFLOW_MS, TOAST_VIEW_RETRY_DELAYS_MS, ToastViewManager, snapshotLayoutKey, validAction, validSnapshot };
