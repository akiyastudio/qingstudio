const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { registerApplicationRenderer, applicationHostFor, sendToApplicationRenderers } = require('./application-windows.cjs');
const { SharedWindowTabs } = require('./shared-window-tabs.cjs');

const CHANNEL = 'workspace-windows';
const MAX_TABS = 48;
const MAX_SEED_BYTES = 2 * 1024 * 1024;
const KINDS = new Set(['home', 'project', 'inspiration', 'component', 'version', 'settings', 'search-all']);
const validateSeed = seed => {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed) || !KINDS.has(seed.kind)
    || Buffer.byteLength(JSON.stringify(seed)) > MAX_SEED_BYTES) throw new Error('无效的标签页');
  if (typeof seed.label !== 'string' || seed.label.length > 512) throw new Error('无效的标签页标题');
  return structuredClone(seed);
};
const contains = (bounds, point) => point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;

// A tab's View (including its component children) moves between windows. Its
// renderer, media elements, task callbacks and IPC identity are never recreated.
class WorkspaceWindowManager {
  constructor({ BrowserWindow, WebContentsView, View, screen, ipcMain, createWindow, loadRenderer, configureSecurity,
    webPreferences, onHostCreated = () => undefined, onHostClosed = () => undefined, onHostMoved = () => undefined, onHostVisibility = () => undefined,
    onLastWindowClose = () => undefined, canQuit = () => false, canMutate = () => true, writeLog = () => undefined, readyTimeoutMs = 30000, sharedTabs = false, transferComponent, pageComponents }) {
    Object.assign(this, { BrowserWindow, WebContentsView, View, screen, ipcMain, createWindow, loadRenderer, configureSecurity,
      webPreferences, onHostCreated, onHostClosed, onHostMoved, onHostVisibility, onLastWindowClose, canQuit, canMutate, writeLog, readyTimeoutMs });
    this.windows = new Map();
    this.tabs = new Map();
    this.revision = 0;
    this.pendingClose = new Map();
    this.panelTasks = new Map();
    this.panelRevision = 0;
    this.validateSeed = validateSeed;
    this.sharedTabs = sharedTabs ? new SharedWindowTabs(this, { transferComponent, pageComponents }) : null;
    this.registerIpc();
  }

  registerWindow(window, { primary = false } = {}) {
    const record = { window, primary, ids: [], activeId: '', closing: false, order: Date.now() };
    this.windows.set(window.id, record);
    window.on('resize', () => this.layout(record));
    window.on('maximize', () => this.sendWindowState(record));
    window.on('unmaximize', () => this.sendWindowState(record));
    window.on('focus', () => { record.order = Date.now(); });
    window.on('close', event => {
      if (this.canQuit() || record.closing) return;
      event.preventDefault();
      if (!this.canMutate()) return;
      if (record.transferring) return;
      if ([...this.windows.values()].filter(item => item.window.isVisible()).length <= 1) this.onLastWindowClose();
      else void this.closeWindow(record).catch(error => this.report(record, error));
    });
    window.on('closed', () => {
      for (const id of [...record.ids]) this.dispose(this.tabs.get(id));
      this.windows.delete(window.id);
      this.publish();
    });
    return record;
  }

  registerRoot(window) {
    const record = this.registerWindow(window, { primary: true });
    const host = this.addTab(record, window.webContents, null, { kind: 'home', label: '主页', key: 'home' }, true);
    record.activeId = host.id;
    return host;
  }

  addTab(record, webContents, contentView, seed, root = false) {
    const events = new EventEmitter();
    const host = { id: randomUUID(), webContents, contentView: contentView || record.window.contentView,
      nativeWindow: record.window, seed, root, visible: root, ready: root, closing: false,
      isDestroyed: () => webContents.isDestroyed(), componentState: null };
    host.on = events.on.bind(events); host.removeListener = events.removeListener.bind(events);
    host.events = events;
    host.getContentBounds = () => host.nativeWindow.getContentBounds();
    this.tabs.set(host.id, host);
    record.ids.push(host.id);
    host.unregister = registerApplicationRenderer(host);
    webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat) {
        event.preventDefault();
        host.nativeWindow.setFullScreen(!host.nativeWindow.isFullScreen());
      }
    });
    webContents.on('render-process-gone', () => { host.ready = false; host.awaitingReady?.reject(new Error('标签页加载失败，请重新打开')); this.publish(); });
    webContents.on('destroyed', () => host.awaitingReady?.reject(new Error('标签页已关闭')));
    this.onHostCreated(host);
    return host;
  }

  context(host) {
    const record = this.windows.get(host.nativeWindow.id);
    return { revision: this.revision, id: host.id, windowId: record.window.id, root: host.root,
      visible: record.activeId === host.id, seed: host.seed,
      sharedTabs: Boolean(this.sharedTabs), tabs: this.sharedTabs ? host.localTabs || [] : record.ids.map(id => this.tabs.get(id)).filter(Boolean).map(tab => ({ id: tab.id, label: tab.seed.label,
        kind: tab.seed.kind, iconUrl: tab.seed.kind === 'component' ? tab.seed.transfer?.componentPage?.iconUrl || tab.seed.action?.iconUrl : undefined, active: idEquals(tab.id, record.activeId), pinned: tab.root, ready: tab.ready })) };
  }

  publish() {
    this.revision += 1;
    for (const host of this.tabs.values()) if (!host.isDestroyed()) {
      try { host.webContents.send(`${CHANNEL}:changed`, this.context(host)); } catch { /* Closing or crashed renderer. */ }
    }
  }

  layout(record) {
    if (record.window.isDestroyed()) return;
    const [width, height] = record.window.getContentSize();
    for (const id of record.ids) {
      const host = this.tabs.get(id);
      if (!host || host.root) continue;
      host.contentView.setBounds({ x: 0, y: 0, width, height });
      host.pageView.setBounds({ x: 0, y: 0, width, height });
      host.events.emit('resize');
    }
  }

  sendWindowState(record) {
    for (const id of record.ids) {
      try { this.tabs.get(id)?.webContents.send('window-maximized-change', record.window.isMaximized()); } catch { /* Closing or crashed renderer. */ }
    }
  }

  activate(record, id) {
    if (!record.ids.includes(id)) throw new Error('标签页不属于此窗口');
    record.requestedActiveId = id;
    if (!this.tabs.get(id)?.ready) { this.publish(); return; }
    record.activeId = id;
    for (const tabId of record.ids) {
      const host = this.tabs.get(tabId);
      const visible = tabId === id;
      if (!host.root) host.contentView.setVisible(visible);
      if (host.visible !== visible) { host.visible = visible; this.onHostVisibility(host, visible); }
    }
    this.layout(record);
    this.tabs.get(id)?.webContents.focus();
    this.publish();
  }

  async open(source, rawSeed, { reuse = true, activate = true, onCreated } = {}) {
    const seed = validateSeed(rawSeed);
    const record = this.windows.get(source.nativeWindow.id);
    const existing = reuse && seed.key && record.ids.map(id => this.tabs.get(id)).find(tab => tab.seed.key === seed.key);
    if (existing) { this.activate(record, existing.id); return existing.openPromise || existing.id; }
    if (this.tabs.size >= MAX_TABS) throw new Error('打开的标签页过多，请先关闭一些标签页');
    const contentView = new this.View();
    const pageView = new this.WebContentsView({ webPreferences: this.webPreferences });
    contentView.addChildView(pageView);
    record.window.contentView.addChildView(contentView);
    contentView.setVisible(false);
    const host = this.addTab(record, pageView.webContents, contentView, seed);
    host.pageView = pageView;
    host.activateOnLoad = activate;
    host.retainOnLoadFailure = Boolean(onCreated);
    this.configureSecurity({ webContents: host.webContents });
    onCreated?.(host);
    if (activate) record.requestedActiveId = host.id;
    this.layout(record);
    this.publish();
    host.openPromise = this.loadTab(host, record);
    return host.openPromise;
  }

  async loadTab(host, record) {
    let timer;
    const ready = new Promise((resolve, reject) => {
      host.awaitingReady = { resolve, reject };
      timer = setTimeout(() => reject(new Error('标签页加载超时，请重新打开')), this.readyTimeoutMs);
    });
    try {
      // Keep the current page visible until the new App has committed its UI.
      // did-finish-load only means the document loaded, not that React is ready.
      await Promise.all([Promise.resolve().then(() => this.loadRenderer(host.webContents)), ready]);
      if (host.isDestroyed() || host.closed || record.window.isDestroyed()) throw new Error('标签页已关闭');
      host.ready = true;
      if (host.activateOnLoad !== false && this.canMutate() && !record.closing && !record.pendingClose && (record.requestedActiveId === host.id || !this.tabs.has(record.activeId))) this.activate(record, host.id);
      else this.publish();
      return host.id;
    } catch (error) { if (!host.retainOnLoadFailure) this.dispose(host); this.publish(); throw error; }
    finally { clearTimeout(timer); host.awaitingReady = null; }
  }

  rendererReady(host, error) {
    if (typeof error === 'string' && error) host.awaitingReady?.reject(new Error(error.slice(0, 512)));
    else host.awaitingReady?.resolve();
  }

  activateNeighbor(record, index) {
    const ready = id => this.tabs.get(id)?.ready;
    this.activate(record, record.ids.slice(index).find(ready) || record.ids.slice(0, index).reverse().find(ready) || record.ids[0]);
  }

  async move(host, destination, index) {
    if (host.root || host.closing || host.moving || !host.ready) throw new Error('此标签页暂时不能移动');
    const source = this.windows.get(host.nativeWindow.id);
    if (source.pendingClose || destination.pendingClose || source.transferring || destination.transferring || source.window.isDestroyed() || destination.window.isDestroyed()) throw new Error('窗口正在切换或关闭，请稍后再移动标签页');
    if (source === destination) { this.reorder(source, host.id, index); return; }
    const oldIndex = source.ids.indexOf(host.id);
    const oldActive = source.activeId;
    const nativeSource = host.nativeWindow;
    host.moving = true;
    source.transferring = true; destination.transferring = true;
    // Native surface reparenting can fail. Keep the original tab until every
    // owned surface has moved, then commit the tab lists atomically.
    try {
      source.window.contentView.removeChildView(host.contentView);
      destination.window.contentView.addChildView(host.contentView);
      host.nativeWindow = destination.window;
      await this.onHostMoved(host, nativeSource);
    } catch (error) {
      if (!destination.window.isDestroyed()) destination.window.contentView.removeChildView(host.contentView);
      source.window.contentView.addChildView(host.contentView);
      host.nativeWindow = nativeSource;
      await Promise.resolve(this.onHostMoved(host, destination.window)).catch(() => undefined);
      this.layout(source);
      host.moving = false;
      source.transferring = false; destination.transferring = false;
      throw error;
    }
    source.ids.splice(oldIndex, 1);
    const minimum = destination.ids.some(id => this.tabs.get(id)?.root) ? 1 : 0;
    destination.ids.splice(Math.max(minimum, Math.min(index ?? destination.ids.length, destination.ids.length)), 0, host.id);
    if (oldActive === host.id && source.ids.length) this.activateNeighbor(source, oldIndex);
    this.activate(destination, host.id);
    destination.window.show(); destination.window.focus();
    if (!source.ids.length && !source.primary) { source.closing = true; source.window.close(); }
    this.sendWindowState(destination);
    host.moving = false;
    source.transferring = false; destination.transferring = false;
  }

  async dropIndex(record, point) {
    const host = this.tabs.get(record.activeId);
    if (!host?.webContents.executeJavaScript || host.isDestroyed()) return record.ids.length;
    const x = (point.x - record.window.getContentBounds().x) / (host.webContents.getZoomFactor?.() || 1);
    let timer;
    try {
      const id = await Promise.race([
        host.webContents.executeJavaScript(`(() => { const tabs = [...document.querySelectorAll('[data-native-tab]')]; return tabs.find(tab => ${JSON.stringify(x)} < tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2)?.dataset.nativeTab || ''; })()`),
        new Promise(resolve => { timer = setTimeout(() => resolve(''), 250); }),
      ]);
      const index = record.ids.indexOf(id);
      return index < 0 ? record.ids.length : index;
    } catch { return record.ids.length; }
    finally { clearTimeout(timer); }
  }

  async detach(host) {
    const point = this.screen.getCursorScreenPoint();
    const workArea = this.screen.getDisplayNearestPoint(point).workArea;
    const width = Math.min(1280, workArea.width), height = Math.min(800, workArea.height);
    const window = this.createWindow({ width, height, x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2) });
    const record = this.registerWindow(window);
    try { await this.move(host, record); } catch (error) { record.closing = true; window.close(); throw error; }
  }

  async merge(source) {
    const destination = this.windows.get(source.nativeWindow.id);
    for (const host of [...this.tabs.values()]) if (!host.root && host.nativeWindow !== destination.window) await this.move(host, destination);
    destination.window.show(); destination.window.focus();
  }

  reorder(record, id, index) {
    const oldIndex = record.ids.indexOf(id);
    if (oldIndex < 0 || this.tabs.get(id)?.root) return;
    record.ids.splice(oldIndex, 1);
    const minimum = record.ids.some(candidate => this.tabs.get(candidate)?.root) ? 1 : 0;
    record.ids.splice(Math.max(minimum, Math.min(Number.isSafeInteger(index) ? index : record.ids.length, record.ids.length)), 0, id);
    this.publish();
  }

  async drop(source, id) {
    const host = this.ownedTab(source, id);
    const point = this.screen.getCursorScreenPoint();
    const candidates = [...this.windows.values()].filter(record => record.window.isVisible() && !record.window.isMinimized())
      .sort((a, b) => b.order - a.order);
    const underPointer = candidates.find(record => contains(record.window.getContentBounds(), point));
    if (underPointer === this.windows.get(source.nativeWindow.id)) return { moved: false };
    if (underPointer) {
      const bounds = underPointer.window.getContentBounds();
      if (point.y - bounds.y > 48) return { moved: false };
      await this.move(host, underPointer, await this.dropIndex(underPointer, point));
    } else {
      const workArea = this.screen.getDisplayNearestPoint(point).workArea;
      const width = Math.min(1280, workArea.width), height = Math.min(800, workArea.height);
      const window = this.createWindow({ width, height,
        x: Math.max(workArea.x, Math.min(point.x - 100, workArea.x + workArea.width - width)),
        y: Math.max(workArea.y, Math.min(point.y - 20, workArea.y + workArea.height - height)) });
      const record = this.registerWindow(window);
      try { await this.move(host, record); } catch (error) { record.closing = true; window.close(); throw error; }
    }
    return { moved: true };
  }

  ownedTab(source, id) {
    const host = this.tabs.get(id);
    if (!host || host.nativeWindow !== source.nativeWindow || host.root) throw new Error('无权操作此标签页');
    return host;
  }

  focusedHost() {
    const record = [...this.windows.values()].filter(item => item.window.isVisible()).sort((a, b) => b.order - a.order)[0];
    return record ? this.tabs.get(record.activeId) : null;
  }

  async prepareQuit() {
    const attempts = [...this.tabs.values()].map(host => this.prepareClose(host, true).catch(() => false));
    let timer;
    try { await Promise.race([Promise.all(attempts), new Promise(resolve => { timer = setTimeout(resolve, 100); })]); }
    finally { clearTimeout(timer); }
  }

  hideAll() {
    if (!this.quitVisibleWindows) this.quitVisibleWindows = [...this.windows.values()].filter(record => record.window.isVisible()).map(record => record.window.id);
    for (const record of this.windows.values()) record.window.hide();
  }
  restoreAfterFailedQuit() {
    for (const id of this.quitVisibleWindows || []) this.windows.get(id)?.window.show();
    this.quitVisibleWindows = null;
  }

  prepareClose(host, quit = false) {
    if (host.isDestroyed() || !host.ready) return Promise.resolve(true);
    const pending = this.pendingClose.get(host.id);
    if (pending) return pending.promise;
    const token = randomUUID();
    const request = { token };
    request.promise = new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.timer = setTimeout(() => { this.pendingClose.delete(host.id); reject(new Error('标签页尚未响应关闭请求，请重试')); }, 30000);
    });
    this.pendingClose.set(host.id, request);
    host.webContents.send(`${CHANNEL}:prepare-close`, { token, quit });
    return request.promise;
  }

  async closeTab(host) {
    if (host.closing || host.moving) return;
    const owner = this.windows.get(host.nativeWindow.id);
    if (owner.ids.length === 1 && !owner.primary && [...this.windows.values()].filter(record => record.window.isVisible()).length <= 1) { this.onLastWindowClose(); return; }
    host.closing = true;
    try {
      if (!await this.prepareClose(host)) return;
      const record = this.windows.get(host.nativeWindow.id);
      const oldIndex = record.ids.indexOf(host.id);
      const wasActive = record.activeId === host.id;
      this.dispose(host);
      if (record.ids.length) {
        if (wasActive) this.activateNeighbor(record, oldIndex);
        else this.publish();
      }
      else { record.closing = true; record.window.close(); }
    } finally { host.closing = false; }
  }

  async closeWindow(record) {
    if (record.pendingClose || record.ids.some(id => this.tabs.get(id)?.moving)) return;
    record.pendingClose = true;
    try {
      for (const id of [...record.ids]) if (!await this.prepareClose(this.tabs.get(id))) return;
      if (record.primary) {
        for (const id of [...record.ids]) if (!this.tabs.get(id).root) this.dispose(this.tabs.get(id));
        if (record.ids.length) this.activate(record, record.ids[0]);
        record.window.hide(); this.publish();
      } else { record.closing = true; record.window.close(); }
    } finally { record.pendingClose = false; }
  }

  dispose(host) {
    if (!host || host.closed) return;
    host.closed = true;
    this.sharedTabs?.dispose(host);
    host.awaitingReady?.reject(new Error('标签页已关闭'));
    this.panelTasks.delete(host.id);
    this.onHostClosed(host);
    host.unregister();
    const record = this.windows.get(host.nativeWindow.id);
    if (record) record.ids = record.ids.filter(id => id !== host.id);
    this.tabs.delete(host.id);
    this.publishPanels();
    if (!host.root) {
      if (!host.nativeWindow.isDestroyed()) host.nativeWindow.contentView.removeChildView(host.contentView);
      if (!host.isDestroyed()) host.webContents.close({ waitForBeforeUnload: false });
    }
  }

  report(record, error) {
    this.writeLog('warn', 'Workspace window operation failed', { error: error.message });
    this.tabs.get(record.activeId)?.webContents.send('app-error', error.message);
  }

  panelSnapshot() {
    return [...this.panelTasks.entries()].flatMap(([nativeTabId, tasks]) => tasks.map(task => ({ ...task, key: `${nativeTabId}:${task.key}`, originKey: task.key, nativeTabId })));
  }
  publishPanels() {
    const snapshot = { revision: ++this.panelRevision, tasks: this.panelSnapshot() };
    sendToApplicationRenderers(null, `${CHANNEL}:panels`, snapshot);
  }
  updatePanels(host, tasks) {
    if (!Array.isArray(tasks) || tasks.length > 64 || Buffer.byteLength(JSON.stringify(tasks)) > 512 * 1024) throw new Error('Invalid panel task snapshot');
    for (const task of tasks) {
      if (!task || !['idle', 'running', 'completed', 'failed'].includes(task.state)
        || ['key', 'ownerPageId', 'panelKind', 'title', 'message'].some(key => typeof task[key] !== 'string' || task[key].length > 4096)
        || !Number.isFinite(task.progress) || !Number.isFinite(task.startedAt) || !Number.isFinite(task.updatedAt)
        || !Array.isArray(task.logs) || task.logs.length > 100) throw new Error('Invalid panel task');
    }
    this.panelTasks.set(host.id, structuredClone(tasks)); this.publishPanels();
  }
  restorePanel(ownerPageId, panelKind, nativeTabId) {
    if (typeof ownerPageId !== 'string' || typeof panelKind !== 'string') return false;
    const host = [...this.tabs.values()].find(tab => (!nativeTabId || tab.id === nativeTabId) && (tab.seed.page?.id === ownerPageId || this.panelTasks.get(tab.id)?.some(task => task.ownerPageId === ownerPageId && task.panelKind === panelKind)));
    if (!host || host.closing || host.isDestroyed()) return false;
    this.activate(this.windows.get(host.nativeWindow.id), host.id);
    if (host.nativeWindow.isMinimized()) host.nativeWindow.restore();
    host.nativeWindow.show(); host.nativeWindow.focus();
    host.webContents.send(`${CHANNEL}:restore-panel`, { ownerPageId, panelKind });
    return true;
  }

  registerIpc() {
    const handle = (name, action) => this.ipcMain.handle(`${CHANNEL}:${name}`, (event, ...args) => {
      const host = applicationHostFor(event.sender);
      if (!host || event.senderFrame !== host.webContents.mainFrame) throw new Error('Unauthorized workspace window sender');
      if (['open', 'drop', 'detach', 'merge', 'reorder', 'close', 'restore-panel'].includes(name) && !this.canMutate()) throw new Error('软件正在退出，请先完成或取消退出');
      return action(host, ...args);
    });
    handle('context', host => this.context(host));
    handle('tabs-publish', (host, tabs) => this.sharedTabs?.publish(host, tabs));
    handle('tab-response', (host, token, result, error) => this.sharedTabs?.respond(host, token, result, error));
    handle('ready', (host, error) => this.rendererReady(host, error));
    handle('panels', () => ({ revision: this.panelRevision, tasks: this.panelSnapshot() }));
    handle('panels-update', (host, tasks) => this.updatePanels(host, tasks));
    handle('restore-panel', (_host, ownerPageId, panelKind, nativeTabId) => this.restorePanel(ownerPageId, panelKind, nativeTabId));
    handle('dismiss-panel', (_host, nativeTabId, key) => {
      const task = this.panelTasks.get(nativeTabId)?.find(item => item.key === key);
      const target = this.tabs.get(nativeTabId);
      if (!task || task.state === 'running' || !target || target.isDestroyed()) return false;
      target.webContents.send(`${CHANNEL}:dismiss-panel`, key); return true;
    });
    handle('open', (host, seed, options) => this.sharedTabs ? this.sharedTabs.open(host, validateSeed(seed)) : this.open(host, seed, { reuse: options?.reuse !== false }));
    // Shared tab lists address renderer-local ids, while a renderer's window
    // context id is the native tab id of its own renderer. Asking to activate
    // that id means "the tab this window is showing".
    handle('activate', (host, id) => {
      if (!this.sharedTabs) return this.activate(this.windows.get(host.nativeWindow.id), id);
      const target = id === host.id ? host.localTabs?.find(tab => tab.active)?.id : id;
      return target ? this.sharedTabs.request(host, 'activate', { id: target }) : undefined;
    });
    handle('update', (host, label) => {
      if (typeof label !== 'string' || label.length > 512) throw new Error('无效的标签页标题');
      if (host.seed.label !== label) { host.seed.label = label; this.publish(); }
    });
    handle('drop', (host, id) => this.sharedTabs ? this.sharedTabs.drop(host, id) : this.drop(host, id));
    handle('detach', (host, id) => this.sharedTabs ? this.sharedTabs.transfer(host, id) : this.detach(this.ownedTab(host, id)));
    handle('merge', host => this.sharedTabs ? this.sharedTabs.merge(host) : this.merge(host));
    handle('reorder', (host, id, index) => { if (this.sharedTabs) return this.sharedTabs.request(host, 'reorder', { id, index }); this.ownedTab(host, id); this.reorder(this.windows.get(host.nativeWindow.id), id, index); });
    handle('close', (host, id) => this.sharedTabs ? this.sharedTabs.request(host, 'close', { id }) : this.closeTab(this.ownedTab(host, id)));
    handle('close-response', (host, token, accepted) => {
      const pending = this.pendingClose.get(host.id);
      if (!pending || pending.token !== token || typeof accepted !== 'boolean') return false;
      clearTimeout(pending.timer); this.pendingClose.delete(host.id); pending.resolve(accepted); return true;
    });
  }
}
const idEquals = (left, right) => left === right;
module.exports = { WorkspaceWindowManager, validateSeed, contains };
