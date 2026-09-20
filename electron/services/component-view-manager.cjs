const { isHostPlayerAsset, serveHostPlayerAsset } = require('./host-player-assets.cjs');
const hostPlayerSessions = new WeakSet();
const applicationLocalization = require('./localization.cjs');
const path = require('path');
const { fileURLToPath } = require('url');
const { normalizeComponentSettingsFormValues, validateComponentSettingsFormPatch } = require('../contracts/component-settings-form-contract.cjs');
const { getComponentLifecycleLease } = require('./component-lifecycle-context.cjs');

const PAGE_KEY_SEPARATOR = '\u001f';
const mediaToken = value => {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'photoflow-media:' || url.hostname !== 'file' || url.username || url.password || url.port || url.hash) return '';
    return /^\/([A-Za-z0-9_-]{32})$/.exec(url.pathname)?.[1] || '';
  } catch { return ''; }
};
const hasMediaGrant = (instance, token) => Boolean(token && instance && !instance.view.webContents.isDestroyed() && (instance.mediaGrants.get(token) || 0) > Date.now());
const normalizeIdentity = value => String(value || '').trim().replace(/\\/g, '/').toLocaleLowerCase();
const normalizeResolvedTheme = value => value === 'dark' ? 'dark' : 'light';
const normalizeRelativePath = (value, field = 'component scope') => {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (raw.length > 1024 || /^(?:[a-z]:|\/)/i.test(raw)) throw new Error(`Invalid ${field}`);
  const normalized = raw.replace(/\/+$/g, '');
  if (normalized.split('/').some(part => part === '..')) throw new Error(`Invalid ${field}`);
  return normalized;
};
const normalizeOpenScope = request => {
  const scopeRelativePath = normalizeRelativePath(request.scopeRelativePath, 'component scope');
  const selected = Array.isArray(request.selectedRelativePaths) ? request.selectedRelativePaths : [];
  if (selected.length > 10000) throw new Error('Too many component selected paths');
  const selectedRelativePaths = [...new Set(selected.map(value => normalizeRelativePath(value, 'component selected path')).filter(Boolean))];
  if (scopeRelativePath && selectedRelativePaths.some(value => value !== scopeRelativePath && !value.startsWith(`${scopeRelativePath}/`))) throw new Error('Component selection escapes its folder scope');
  const sourcePageId = String(request.sourcePageId || '').trim();
  if (sourcePageId.length > 160) throw new Error('Invalid component source page');
  return { scopeRelativePath, selectedRelativePaths, sourcePageId };
};
const componentPageKey = ({ componentId, pageId, workspacePath, projectId }) => ['project', componentId, String(pageId || '').trim(), normalizeIdentity(workspacePath), String(projectId || '').trim()].join(PAGE_KEY_SEPARATOR);
const componentSettingsPageKey = ({ componentId, pageId }) => ['application.settings', componentId, String(pageId || '').trim()].join(PAGE_KEY_SEPARATOR);
const componentContributionKey = ({ componentId, contributionId, workspacePath, projectId, sourcePageId }, surface) => surface === 'application.command'
  ? [surface, componentId, contributionId].join(PAGE_KEY_SEPARATOR)
  : [surface, componentId, contributionId, normalizeIdentity(workspacePath), String(projectId || ''), surface === 'component.sidePanel' ? String(sourcePageId || '').trim() : ''].join(PAGE_KEY_SEPARATOR);
const validBounds = value => value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))
  && value.width >= 0 && value.height >= 0 && value.width <= 20000 && value.height <= 20000;
const selectComponentPreload = (descriptor, { core }) => {
  const contractVersion = Number(descriptor?.contractVersion);
  if (contractVersion === 2) return core;
  throw new Error(`Unsupported component preload contract: contract=${contractVersion || 'unknown'}`);
};
const diagnosticToken = value => {
  const token = String(value || '').trim();
  return /^[a-z0-9_.:-]{1,80}$/i.test(token) ? token : 'unknown';
};
const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const componentPartition = componentId => {
  if (typeof componentId !== 'string' || !COMPONENT_ID.test(componentId)) throw new Error('Invalid component partition identifier');
  return `persist:component-host-${componentId}`;
};
const waitForWebContentsDestroyed = (webContents, timeoutMs = 1000) => {
  if (!webContents || webContents.isDestroyed?.()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); webContents.removeListener?.('destroyed', finish); resolve(); };
    const timer = setTimeout(() => { webContents.removeListener?.('destroyed', finish); reject(new Error('Timed out waiting for component view destruction')); }, timeoutMs);
    timer.unref?.(); webContents.once?.('destroyed', finish);
  });
};
const filePathHasLink = async (fs, root, candidate) => {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true;
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await fs.promises.lstat(cursor);
    if (stat.isSymbolicLink()) return true;
  }
  return false;
};
const componentSurfaceCss = (theme, surface) => {
  const dark = theme === 'dark';
  const thumb = dark ? '#374151' : '#cbd5e1';
  const hover = dark ? '#4b5563' : '#94a3b8';
  const tokens = dark
    ? '--pf-canvas:#030407;--pf-surface:#090c12;--pf-subtle:#111827;--pf-elevated:#0d1119;--pf-border:#374151;--pf-border-subtle:#1f2937;--pf-text:#e2e8f0;--pf-text-strong:#f8fafc;--pf-muted:#9ca3af;--pf-primary:#2563eb;--pf-primary-hover:#3b82f6;--pf-primary-soft:#071a3d;--pf-focus:#3b82f6;--pf-success:#6ee7b7;--pf-success-soft:#052e2b;--pf-warn:#fcd34d;--pf-warn-soft:#291b05;--pf-danger:#fca5a5;--pf-danger-soft:#2b0b0d;--pf-panel-body:#0b1220;--pf-control-bg:#080e19'
    : '--pf-canvas:#f8fafc;--pf-surface:#ffffff;--pf-subtle:#f1f5f9;--pf-elevated:#ffffff;--pf-border:#cbd5e1;--pf-border-subtle:#e2e8f0;--pf-text:#1e293b;--pf-text-strong:#0f172a;--pf-muted:#64748b;--pf-primary:#2563eb;--pf-primary-hover:#1d4ed8;--pf-primary-soft:#eff6ff;--pf-focus:#3b82f6;--pf-success:#047857;--pf-success-soft:#ecfdf5;--pf-warn:#b45309;--pf-warn-soft:#fffbeb;--pf-danger:#dc2626;--pf-danger-soft:#fef2f2;--pf-panel-body:#ffffff;--pf-control-bg:#ffffff';
  const primitives = surface === 'component.sidePanel' ? `html,body{font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--pf-panel-body);color:var(--pf-text)}*{box-sizing:border-box}button,input,select,textarea{font:inherit}input,select,textarea,.pf-input,.pf-form-input{min-height:36px;border:1px solid var(--pf-border);border-radius:8px;background:var(--pf-control-bg);color:var(--pf-text);padding:.55rem .7rem;outline:none}input:focus,select:focus,textarea:focus,.pf-input:focus,.pf-form-input:focus{border-color:var(--pf-focus);box-shadow:0 0 0 2px color-mix(in srgb,var(--pf-focus) 15%,transparent)}button,.pf-button,.pf-dialog-secondary{min-height:36px;border:1px solid var(--pf-border);border-radius:8px;background:var(--pf-surface);color:var(--pf-text);padding:.55rem .9rem;font-size:.875rem;font-weight:700;transition:background .15s,color .15s;cursor:pointer}button:hover:not(:disabled),.pf-button:hover:not(:disabled),.pf-dialog-secondary:hover:not(:disabled){background:var(--pf-subtle)}button:disabled,input:disabled,select:disabled,textarea:disabled{cursor:not-allowed;opacity:.45}.pf-button-primary,.pf-dialog-primary{border-color:var(--pf-primary);background:var(--pf-primary);color:#fff}.pf-button-primary:hover:not(:disabled),.pf-dialog-primary:hover:not(:disabled){border-color:var(--pf-primary-hover);background:var(--pf-primary-hover)}.pf-button-danger{border-color:color-mix(in srgb,var(--pf-danger) 45%,var(--pf-border));color:var(--pf-danger)}.pf-button-danger:hover:not(:disabled){background:var(--pf-danger-soft)}.pf-panel-card,.pf-panel-section,.pf-card{border:1px solid var(--pf-border-subtle);border-radius:12px;background:var(--pf-canvas);color:var(--pf-text)}.pf-panel-section{padding:16px}label,.pf-form-label{color:var(--pf-muted);font-size:12px;font-weight:700}` : '';
  return `:root{color-scheme:${dark ? 'dark' : 'light'};${tokens};--pf-radius-sm:8px;--pf-radius-md:10px;--pf-radius-lg:12px;--pf-shadow-sm:0 1px 2px rgb(15 23 42 / 8%);--pf-space-1:4px;--pf-space-2:8px;--pf-space-3:12px;--pf-space-4:16px;--pf-space-5:20px;--pf-control-sm:30px;--pf-control-md:36px;--pf-control-lg:40px;--photoflow-scrollbar-thumb:${thumb};--photoflow-scrollbar-thumb-hover:${hover}}${surface === 'component.sidePanel' ? 'body{margin:0;padding:22px}' : ''}${primitives}::-webkit-scrollbar{width:12px;height:12px;background:transparent}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-thumb{border:2px solid transparent;border-radius:9999px;background-color:var(--photoflow-scrollbar-thumb);background-clip:padding-box}::-webkit-scrollbar-thumb:hover{background-color:var(--photoflow-scrollbar-thumb-hover)}::-webkit-scrollbar-button{display:none;width:0;height:0}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}`;
};

const { currentApplicationHost, withApplicationHost } = require('./application-windows.cjs');

class ComponentViewManager {
  get mainWindow() { return currentApplicationHost() || this.defaultHost; }
  set mainWindow(value) { this.defaultHost = value; }
  get hostState() {
    const host = this.mainWindow;
    if (!host.componentState) host.componentState = { activeInstanceId: '', activationGeneration: 0, hostSurfaceState: { rendererToken: '', revision: -1, suspended: false } };
    return host.componentState;
  }
  get activeInstanceId() { return this.hostState.activeInstanceId; }
  set activeInstanceId(value) { this.hostState.activeInstanceId = value; }
  get activationGeneration() { return this.hostState.activationGeneration; }
  set activationGeneration(value) { this.hostState.activationGeneration = value; }
  get hostSurfaceState() { return this.hostState.hostSurfaceState; }
  set hostSurfaceState(value) { this.hostState.hostSurfaceState = value; }
  hostKey(key) { const host = this.mainWindow; return host.id && !host.root && host.nativeWindow ? `${host.id}:${key}` : key; }
  owns(instance) { return instance.host === this.mainWindow || instance.host === this.defaultHost && this.mainWindow.root; }
  assertOwned(id) { const instance = this.instancesById.get(id); if (instance && !this.owns(instance)) throw new Error('Unauthorized component instance'); }
  transferInstance(instanceId, source, destination) {
    const instance = this.instancesById.get(instanceId);
    if (!instance || instance.view.webContents.isDestroyed() || !(instance.host === source || source.root && instance.host === this.defaultHost)) throw new Error('组件页面已失效或不属于当前窗口');
    const baseKey = source.root ? instance.key : instance.key.replace(`${source.id}:`, '');
    const nextKey = destination.root ? baseKey : `${destination.id}:${baseKey}`;
    if (this.instances.has(nextKey) && this.instances.get(nextKey) !== instance) throw new Error('目标窗口已有同一组件页面，请先关闭其中一个');
    const previous = instance.host;
    instance.view.setVisible(false);
    previous.contentView.removeChildView(instance.view);
    try { destination.contentView.addChildView(instance.view); }
    catch (error) { previous.contentView.addChildView(instance.view); this.applyVisibility(instance); throw error; }
    if (instance.hostState.activeInstanceId === instanceId) instance.hostState.activeInstanceId = '';
    this.instances.delete(instance.key);
    instance.key = nextKey; instance.host = destination;
    instance.hostState = withApplicationHost(destination, () => this.hostState);
    instance.logicalActive = false;
    this.instances.set(nextKey, instance);
    this.onViewStackChanged();
  }
  closeHost(host) { host.closed = true; for (const instance of [...this.instances.values()]) if (instance.host === host) this.close(instance.instanceId); this.notificationService?.forgetHost?.(host); }
  constructor({ WebContentsView, mainWindow, screen = null, updatePlaybackBounds = null, refreshPlaybackBounds = null, setPlaybackPaused = null, registry, preloadPath, ipcMain, serviceManager = null, lifecycleCoordinator = null, capabilityBroker = null, inputGrantService = null, notificationService = null, clearComponentCapabilityState = null, clearComponentViewState = clearComponentCapabilityState, partitionSessionProvider = null, mediaProtocolHandler = null, resolveOpenContext = request => request, writeLog = () => undefined, onViewStackChanged = () => undefined, settingsCloseGraceMs = 750, readConfig = null, mutateConfig = null }) {
    this.WebContentsView = WebContentsView;
    this.screen = screen;
    this.setPlaybackPaused = setPlaybackPaused;this.updatePlaybackBounds = updatePlaybackBounds;this.refreshPlaybackBounds = refreshPlaybackBounds;
    this.mainWindow = mainWindow;
    this.registry = registry;
    this.readConfig = readConfig;
    this.mutateConfig = mutateConfig;
    this.preloadPath = preloadPath;
    const inHost=listener=>(event,...args)=>withApplicationHost(this.senderBindings.get(event.sender.id)?.host,()=>listener(event,...args));
    this.ipcMain = {handle:(channel,listener)=>ipcMain.handle(channel,inHost(listener)),on:(channel,listener)=>ipcMain.on?.(channel,inHost(listener))};
    this.clearComponentCapabilityState = clearComponentCapabilityState;
    this.clearComponentViewState = clearComponentViewState;
    this.writeLog = writeLog;
    this.serviceManager = serviceManager;
    this.lifecycleCoordinator = lifecycleCoordinator;
    this.capabilityBroker = capabilityBroker;
    this.inputGrantService = inputGrantService;
    this.notificationService = notificationService;
    this.partitionSessionProvider = partitionSessionProvider;
    this.mediaProtocolHandler = mediaProtocolHandler;
    this.mediaProtocolSessions = new WeakSet();
    this.resolveOpenContext = resolveOpenContext;
    this.onViewStackChanged = onViewStackChanged;
    this.settingsCloseGraceMs = Math.max(0, Number(settingsCloseGraceMs) || 0);
    this.instances = new Map();
    this.instancesById = new Map();
    this.senderBindings = new Map();
    this.rpcMethods = new Map();
    this.resolvedTheme = 'light';
    this.resolvedLocale = applicationLocalization.getLocale();
    this.activeInstanceId = '';
    this.activationGeneration = 0;
    this.partitionSessions = new Map();
    this.capabilityClearOperations = new Map();
    this.viewCapabilityClearOperations = new Map();
    this.failedCapabilityClearIds = new Set();
    this.hostSurfaceState = { rendererToken: '', revision: -1, suspended: false };
    this.registerComponentSdkIpc();
  }

  requestComponentCapabilityClear(componentId, contents = [], timeoutMs = 2000, viewOnly = false) {
    const normalizedId = String(componentId || '');
    componentPartition(normalizedId);
    const pending = this.capabilityClearOperations.get(normalizedId) || (viewOnly && this.viewCapabilityClearOperations.get(normalizedId));
    if (pending) return pending;
    const operations = viewOnly ? this.viewCapabilityClearOperations : this.capabilityClearOperations;
    const previousViewClear = !viewOnly ? this.viewCapabilityClearOperations.get(normalizedId)?.catch(() => undefined) : null;
    const destroyed = Promise.all(contents.map(webContents => waitForWebContentsDestroyed(webContents, timeoutMs)));
    const operation = Promise.all([destroyed, previousViewClear]).then(() => (viewOnly ? this.clearComponentViewState : this.clearComponentCapabilityState)?.(normalizedId)).then(result => {
      this.failedCapabilityClearIds.delete(normalizedId);
      return result;
    }, error => {
      this.failedCapabilityClearIds.add(normalizedId);
      throw error;
    }).finally(() => {
      if (operations.get(normalizedId) === operation) operations.delete(normalizedId);
    });
    operations.set(normalizedId, operation);
    void operation.catch(error => this.writeLog('warn', 'Unable to clear component capability state', { componentId: normalizedId, error: error?.message || String(error) }));
    return operation;
  }

  registerComponentSdkIpc() {
    this.ipcMain.handle('component-sdk:playback-paused',(event,payload)=>{
      const instance=this.senderBindings.get(event.sender.id);
      if(!instance||instance.view.webContents!==event.sender||event.senderFrame&&event.senderFrame!==event.sender.mainFrame||!instance.descriptor.service?.capabilities?.includes('component.runtime.execute')||!instance.descriptor.service?.permissions?.includes('component.runtime.execute'))throw new Error('Unauthorized component sender');
      if(typeof payload?.sessionId!=='string'||!payload.sessionId||payload.sessionId.length>128||typeof payload.paused!=='boolean')throw new Error('Invalid playback pause state');
      if(!this.setPlaybackPaused)throw new Error('Host player is unavailable');
      return this.setPlaybackPaused(payload.sessionId,payload.paused,instance.context);
    });
    this.ipcMain.on('component-sdk:playback-bounds',(event,payload)=>{
      const instance=this.senderBindings.get(event.sender.id);
      if(!instance||instance.view.webContents!==event.sender||event.senderFrame&&event.senderFrame!==event.sender.mainFrame||!instance.descriptor.service?.capabilities?.includes('component.runtime.execute')||!instance.descriptor.service?.permissions?.includes('component.runtime.execute'))return;
      try{this.updatePlaybackBounds?.(payload?.sessionId,payload?.bounds,instance.context,payload?.sequence);}catch{/* Stale or invalid layout messages cannot affect another view. */}
    });

    this.ipcMain.handle('component-sdk:panel-info', (event, payload) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender || event.senderFrame && event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized component sender');
      return this.capabilityBroker.invoke(instance.descriptor, 'component.panel', payload, instance.context);
    });
    this.ipcMain.handle('component-sdk:preview', (event, payload) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender || event.senderFrame && event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized component sender');
      return this.capabilityBroker.invoke(instance.descriptor, 'project.preview', payload, instance.context);
    });
    this.ipcMain.handle('component-sdk:get-context', event => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) throw new Error('Unauthorized component sender');
      return this.publicContext(instance);
    });
    this.ipcMain.handle('component-sdk:rpc', (event, method, payload) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) throw new Error('Unauthorized component sender');
      const normalizedMethod = String(method || '');
      if (instance.context.surface === 'application.settings') {
        if (!instance.settingsPage?.rpcMethods.includes(normalizedMethod)) throw new Error(`Component RPC method is not allowed on the application settings surface: ${normalizedMethod}`);
        if (!this.serviceManager?.supports(instance.context.componentId, normalizedMethod)) throw new Error(`Unknown component service RPC method: ${normalizedMethod}`);
        return this.serviceManager.invoke(instance.context.componentId, normalizedMethod, payload, instance.context);
      }
      if (instance.contribution) { if (!instance.contribution.rpcMethods.includes(normalizedMethod)) throw new Error(`Component RPC method is not allowed for contribution ${instance.contribution.id}: ${normalizedMethod}`); if (!this.serviceManager?.supports(instance.context.componentId, normalizedMethod)) throw new Error(`Unknown component service RPC method: ${normalizedMethod}`); return this.serviceManager.invoke(instance.context.componentId, normalizedMethod, payload, instance.context); }
      const registration = this.rpcMethods.get(normalizedMethod);
      if (registration?.componentId === instance.context.componentId) return registration.handler(event, payload, instance.context);
      if (this.serviceManager?.supports(instance.context.componentId, normalizedMethod)) {
        return this.serviceManager.invoke(instance.context.componentId, normalizedMethod, payload, instance.context);
      }
      throw new Error(`Unknown component RPC method: ${normalizedMethod}`);
    });
    this.ipcMain.handle('component-sdk:notify', (event, payload) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) { const error = new Error('Unauthorized component sender'); error.code = 'NOTIFICATION_UNAUTHORIZED_SENDER'; throw error; }
      if (!this.notificationService) { const error = new Error('Component notification service is unavailable'); error.code = 'NOTIFICATION_HOST_UNAVAILABLE'; throw error; }
      return this.notificationService.publish(instance.descriptor, payload, instance.context);
    });
    this.ipcMain.handle('component-sdk:dialog', (event, payload) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) throw new Error('Unauthorized component sender');
      if (!this.capabilityBroker) throw new Error('Component dialog service is unavailable');
      return this.capabilityBroker.invoke(instance.descriptor, 'dialogs', payload, instance.context);
    });
    this.ipcMain.handle('component-sdk:authorize-files', (event, filePaths) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) throw new Error('Unauthorized component sender');
      if (!instance.descriptor.service?.permissions?.includes('dialogs') || !this.inputGrantService?.grantDroppedInputs) throw new Error('Component dropped-file authorization is unavailable');
      return this.inputGrantService.grantDroppedInputs(filePaths, instance.descriptor, instance.context);
    });
    this.ipcMain.handle('component-sdk:content-size', (event, value) => {
      const instance = this.senderBindings.get(event.sender.id);
      if (!instance || instance.view.webContents !== event.sender) throw new Error('Unauthorized component sender');
      if (!['component.sidePanel', 'application.settings'].includes(instance.context.surface)) return { accepted: false };
      const width = Math.ceil(Number(value?.width)); const height = Math.ceil(Number(value?.height));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 20000 || height > 20000) throw new Error('Invalid component content size');
      if (instance.contentSize?.width === width && instance.contentSize?.height === height) return { accepted: true, changed: false };
      instance.contentSize = Object.freeze({ width, height });
      if (!this.mainWindow?.isDestroyed?.()) this.mainWindow?.webContents?.send?.('component-host:panel-content-size', { instanceId: instance.instanceId, width, height });
      return { accepted: true, changed: true };
    });
  }

  registerRpcMethod(method, handler, componentId) {
    if (this.rpcMethods.has(method)) throw new Error(`Duplicate component RPC method: ${method}`);
    if (!componentId) throw new Error(`Component RPC method must declare an owner: ${method}`);
    this.rpcMethods.set(method, { componentId, handler });
  }

  listToolbarActions() {
    return this.registry.list().filter(item => item.toolbarAction && item.fullPage).map(item => ({
      componentId: item.componentId,
      componentVersion: item.componentVersion,
      contractVersion: item.contractVersion,
      actionId: item.toolbarAction.id,
      label: item.toolbarAction.label,
      pageId: item.fullPage.id,
      pageTitle: item.fullPage.title,
      development: item.development === true,
      ...(item.icon ? { iconUrl: `photoflow-component://icon/${encodeURIComponent(item.componentId)}?v=${encodeURIComponent(item.componentVersion)}` } : {}),
    }));
  }

  listSettingsPages() {
    return this.registry.list().flatMap(item => [
      ...(item.settingsForms || []).map(form => ({
        componentId: item.componentId, componentVersion: item.componentVersion, contractVersion: item.contractVersion,
        pageId: form.id, label: form.label, pageTitle: form.title, renderMode: form.customPage ? 'hybrid' : 'declarative', form: form.form, ...(form.customPage ? { customPageTitle: form.customPage.title } : {}), development: item.development === true,
        ...(item.icon ? { iconUrl: `photoflow-component://icon/${encodeURIComponent(item.componentId)}?v=${encodeURIComponent(item.componentVersion)}` } : {}),
      })),
      ...(item.settingsPages || []).map(page => ({
        componentId: item.componentId, componentVersion: item.componentVersion, contractVersion: item.contractVersion,
        pageId: page.id, label: page.label, pageTitle: page.title, renderMode: 'custom', development: item.development === true,
        ...(item.icon ? { iconUrl: `photoflow-component://icon/${encodeURIComponent(item.componentId)}?v=${encodeURIComponent(item.componentVersion)}` } : {}),
      })),
    ]);
  }

  settingsForm(request) {
    const componentId = String(request?.componentId || ''); const pageId = String(request?.pageId || '');
    const descriptor = this.registry.resolve(componentId);
    const contribution = descriptor?.settingsForms?.find(item => item.id === pageId);
    if (!descriptor || !contribution) throw new Error('Unknown declarative component settings form');
    return { descriptor, contribution };
  }

  declarativeSettingsContext(descriptor) {
    return Object.freeze({ componentId: descriptor.componentId, componentVersion: descriptor.componentVersion, surface: 'application.settings', projectId: '', projectName: '', projectStatus: '', scopeRelativePath: '', selectedRelativePaths: [], sourcePageId: '', contributionId: '' });
  }

  async readSettingsForm(request) {
    this.lifecycleCoordinator?.assertAvailable?.(request?.componentId);
    const { descriptor, contribution } = this.settingsForm(request);
    if (!contribution.form.groups.length) return { revision: 0, values: {} };
    if (!descriptor.service || contribution.form.preferenceScope) {
      if (!this.readConfig) throw new Error('Declarative settings storage is unavailable');
      const config = await this.readConfig();
      const settings = contribution.form.preferenceScope === 'videoPlayback' ? config.videoPlayback : config.componentSettings?.[descriptor.componentId];
      return { revision: Number(config.componentSettingsRevisions?.[descriptor.componentId]) || 0, values: normalizeComponentSettingsFormValues(contribution.form, settings) };
    }
    if (!this.capabilityBroker) throw new Error('Declarative component settings are unavailable');
    const result = await this.capabilityBroker.invoke(descriptor, 'component.settings', { action: 'get' }, this.declarativeSettingsContext(descriptor));
    return { revision: Number(result.revision) || 0, values: normalizeComponentSettingsFormValues(contribution.form, result.settings) };
  }

  async updateSettingsForm(request) {
    this.lifecycleCoordinator?.assertAvailable?.(request?.componentId);
    const { descriptor, contribution } = this.settingsForm(request);
    const patch = validateComponentSettingsFormPatch(contribution.form, request?.patch);
    if (!descriptor.service || contribution.form.preferenceScope) {
      if (!this.mutateConfig) throw new Error('Declarative settings storage is unavailable');
      let result;
      await this.mutateConfig(latest => {
        this.lifecycleCoordinator?.assertAvailable?.(descriptor.componentId);
        const revision = (Number(latest.componentSettingsRevisions?.[descriptor.componentId]) || 0) + 1;
        const playback = contribution.form.preferenceScope === 'videoPlayback';
        const settings = { ...(playback ? latest.videoPlayback : latest.componentSettings?.[descriptor.componentId]), ...patch };
        result = { revision, values: normalizeComponentSettingsFormValues(contribution.form, settings) };
        return { ...latest, ...(playback ? { videoPlayback: settings } : { componentSettings: { ...latest.componentSettings, [descriptor.componentId]: settings } }), componentSettingsRevisions: { ...latest.componentSettingsRevisions, [descriptor.componentId]: revision } };
      });
      return result;
    }
    if (!this.capabilityBroker) throw new Error('Declarative component settings are unavailable');
    const result = await this.capabilityBroker.invoke(descriptor, 'component.settings', { action: 'merge', settings: patch }, this.declarativeSettingsContext(descriptor));
    return { revision: Number(result.revision) || 0, values: normalizeComponentSettingsFormValues(contribution.form, result.settings) };
  }
  listContributions() { return this.registry.list().flatMap(item => (item.contributions || []).map(contribution => ({ componentId: item.componentId, componentVersion: item.componentVersion, contributionId: contribution.id, type: contribution.type, label: contribution.label, title: contribution.title, ...(contribution.description ? { description: contribution.description } : {}), pageId: contribution.pageId, rpcMethods: contribution.rpcMethods, ...(contribution.placement ? { placement: contribution.placement } : {}), ...(item.icon ? { iconUrl: `photoflow-component://icon/${encodeURIComponent(item.componentId)}?v=${encodeURIComponent(item.componentVersion)}` } : {}) }))); }

  async open(request) {
    return this.openSurface(request, 'project');
  }

  async openSettings(request) {
    return this.openSurface(request, 'application.settings');
  }
  async openContribution(request) { const descriptor = this.registry.resolve(request.componentId); const contribution = descriptor?.contributions?.find(item => item.id === request.contributionId && item.type === request.type); if (!contribution) throw new Error('Unknown component contribution'); const surface = contribution.type === 'application.command' ? 'application.command' : contribution.type; return this.openSurface({ ...request, pageId: contribution.pageId, contribution }, surface); }

  releaseSettings(request) {
    const leaseId = String(request?.leaseId || '');
    const key = this.hostKey(componentSettingsPageKey(request || {}));
    const instance = this.instances.get(key);
    if (!instance || instance.context.surface !== 'application.settings' || !instance.settingsLeases?.delete(leaseId)) return false;
    const generation = ++instance.leaseGeneration;
    clearTimeout(instance.settingsCloseTimer);
    instance.settingsCloseTimer = setTimeout(() => {
      instance.settingsCloseTimer = null;
      if (this.instances.get(key) === instance && instance.leaseGeneration === generation && instance.settingsLeases.size === 0) this.close(instance.instanceId);
    }, this.settingsCloseGraceMs);
    instance.settingsCloseTimer.unref?.();
    return true;
  }

  async openSurface(rawRequest, surface) {
    const host = this.mainWindow;
    if (host.closed || host.isDestroyed?.()) throw new Error('Component host is closed');
    const componentId = String(rawRequest?.componentId || '');
    const inheritedLease = getComponentLifecycleLease(rawRequest);
    const lifecycleLease = this.lifecycleCoordinator?.isActiveWorkLease?.(componentId, inheritedLease)
      ? inheritedLease
      : this.lifecycleCoordinator?.acquireWork?.(componentId, `view-open:${String(surface || '')}`);
    const ownsLifecycleLease = Boolean(lifecycleLease && lifecycleLease !== inheritedLease);
    const retainedLifecycleLease = !ownsLifecycleLease ? lifecycleLease?.retain?.() : null;
    try {
    const activationGeneration = ++this.activationGeneration;
    const applicationLevel = surface === 'application.settings' || surface === 'application.command';
    const request = applicationLevel ? rawRequest : this.resolveOpenContext(rawRequest, surface);
    const settingsKey = surface === 'application.settings' ? this.hostKey(componentSettingsPageKey(request)) : '';
    const leaseId = surface === 'application.settings' ? String(request.leaseId || '') : '';
    if (surface === 'application.settings' && !/^[a-z0-9._:-]{8,160}$/i.test(leaseId)) throw new Error('Invalid component settings page lease');
    const descriptor = this.registry.resolve(request.componentId);
    const settingsFormCustomPage = surface === 'application.settings' ? descriptor?.settingsForms?.find(form => form.id === request.pageId)?.customPage : null;
    const declaredSettingsPage = surface === 'application.settings' ? descriptor?.settingsPages?.find(page => page.id === request.pageId) : null;
    const settingsPage = declaredSettingsPage || (settingsFormCustomPage ? { ...settingsFormCustomPage, id: String(request.pageId) } : null); const contribution = request.contribution || null;
    const page = surface === 'application.settings' ? settingsPage : contribution ? descriptor?.pages?.find(item => item.id === contribution.pageId) : descriptor?.fullPage;
    if (!descriptor || !page || page.id !== request.pageId) throw new Error('Unknown component page');
    const pendingCapabilityClear = this.capabilityClearOperations.get(componentId) || this.viewCapabilityClearOperations.get(componentId);
    if (pendingCapabilityClear) await pendingCapabilityClear;
    else if (this.failedCapabilityClearIds.has(componentId)) await this.requestComponentCapabilityClear(componentId);
    this.lifecycleCoordinator?.assertLaunchAllowed?.(componentId, lifecycleLease);
    const retainedSettings = settingsKey ? this.instances.get(settingsKey) : null;
    if (retainedSettings?.context.surface === 'application.settings') {
      if (retainedSettings.descriptor.componentVersion !== descriptor.componentVersion || retainedSettings.page.entry !== page.entry) this.close(retainedSettings.instanceId);
      else {
        clearTimeout(retainedSettings.settingsCloseTimer);
        retainedSettings.settingsCloseTimer = null;
        retainedSettings.settingsLeases.add(leaseId);
        retainedSettings.leaseGeneration += 1;
        retainedSettings.latestOpenGeneration = activationGeneration;
        try {
          await retainedSettings.readyPromise;
          if (this.instances.get(settingsKey) !== retainedSettings || retainedSettings.view.webContents.isDestroyed()) throw new Error('Component page open was superseded');
          if (!retainedSettings.settingsLeases.has(leaseId)) throw new Error('Component settings page lease was released');
          if (!this.activate(retainedSettings.instanceId, activationGeneration)) throw new Error('Component page open was superseded');
          return this.publicInstance(retainedSettings, leaseId);
        } catch (error) { this.releaseSettings(request); throw error; }
      }
    }
    const key = settingsKey || this.hostKey(contribution ? componentContributionKey(request, surface) : componentPageKey(request));
    this.writeLog('info', 'Component page context bound', { componentId: request.componentId, surface, contributionId: contribution?.id || '', projectId: applicationLevel ? '' : String(request.projectId || ''), projectName: applicationLevel ? '' : String(request.projectName || ''), projectStatus: applicationLevel ? '' : String(request.projectStatus || ''), sourcePageId: applicationLevel ? '' : String(request.sourcePageId || '') });
    let existing = this.instances.get(key);
    if (existing && (existing.descriptor.componentVersion !== descriptor.componentVersion || existing.page.entry !== page.entry)) {
      this.close(existing.instanceId);
      existing = null;
    }
    if (existing) {
      existing.latestOpenGeneration = activationGeneration;
      if (surface === 'application.settings') { clearTimeout(existing.settingsCloseTimer); existing.settingsCloseTimer = null; existing.settingsLeases.add(leaseId); existing.leaseGeneration += 1; }
      try { await existing.readyPromise;
      if (this.instances.get(key) !== existing || existing.view.webContents.isDestroyed()) throw new Error('Component page open was superseded');
      if (surface === 'application.settings' && !existing.settingsLeases.has(leaseId)) throw new Error('Component settings page lease was released');
      existing.context = Object.freeze({
        ...existing.context,
        componentVersion: descriptor.componentVersion,
        projectName: !applicationLevel ? String(request.projectName || '') : '',
        projectStatus: !applicationLevel ? String(request.projectStatus || '') : '',
        ...(!applicationLevel ? { contentKind: request.contentKind === 'inspiration' ? 'inspiration' : 'project', contentRootPath: String(request.contentRootPath || '') } : {}),
        ...(!applicationLevel ? normalizeOpenScope(request) : { scopeRelativePath: '', selectedRelativePaths: [], sourcePageId: '' }), contributionId: contribution?.id || '',
      });
      if (!existing.view.webContents.isDestroyed()) existing.view.webContents.send('component-sdk:context-changed', this.publicContext(existing));
      if (!this.activate(existing.instanceId, activationGeneration)) throw new Error('Component page open was superseded');
      return this.publicInstance(existing, leaseId);
      } catch (error) { if (surface === 'application.settings') this.releaseSettings(request); throw error; }
    }
    const replacementCapabilityClear = this.capabilityClearOperations.get(componentId) || this.viewCapabilityClearOperations.get(componentId);
    if (replacementCapabilityClear) await replacementCapabilityClear;
    else if (this.failedCapabilityClearIds.has(componentId)) await this.requestComponentCapabilityClear(componentId);
    this.lifecycleCoordinator?.assertLaunchAllowed?.(componentId, lifecycleLease);
    if (host.closed || host.isDestroyed?.()) throw new Error('Component host is closed');
    const instanceId = `component-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const selectedPreloadPath = selectComponentPreload(descriptor, { core: this.preloadPath });
    const view = new this.WebContentsView({ webPreferences: {
      preload: selectedPreloadPath,
      partition: componentPartition(descriptor.componentId),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    } });
    if (surface === 'component.sidePanel' && typeof view.setBorderRadius === 'function') view.setBorderRadius(15);
    const instance = {
      key, instanceId, view, descriptor, page, settingsPage, contribution, host: this.mainWindow, hostState: this.hostState,
      readyPromise: null,
      mediaGrants: new Map(),
      settingsLeases: new Set(surface === 'application.settings' ? [leaseId] : []),
      leaseGeneration: 1,
      latestOpenGeneration: activationGeneration,
      settingsCloseTimer: null,
      logicalActive: false,
      panelInfo: contribution?.placement === 'workspace.folderPanel' ? { title: contribution.title, subtitle: contribution.description || contribution.label } : null,
      requestedBounds: { x: 0, y: 0, width: 0, height: 0 },
      context: Object.freeze({
        componentId: descriptor.componentId,
        componentVersion: descriptor.componentVersion,
        surface,
        workspacePath: !applicationLevel ? String(request.workspacePath || '') : '',
        projectId: !applicationLevel ? String(request.projectId || '') : '',
        projectName: !applicationLevel ? String(request.projectName || '') : '',
        projectStatus: !applicationLevel ? String(request.projectStatus || '') : '',
        ...(!applicationLevel ? { contentKind: request.contentKind === 'inspiration' ? 'inspiration' : 'project', contentRootPath: String(request.contentRootPath || '') } : {}),
        ...(!applicationLevel ? normalizeOpenScope(request) : { scopeRelativePath: '', selectedRelativePaths: [], sourcePageId: '' }), contributionId: contribution?.id || '',
        eventSender: view.webContents,
        previewOwnerId: this.mainWindow.webContents?.id || 0,
        ...(contribution?.placement === 'workspace.folderPanel' ? { updatePanelInfo: patch => {
          if (this.senderBindings.get(view.webContents.id) !== instance || view.webContents.isDestroyed()) throw new Error('Panel is no longer available');
          if (patch) { instance.panelInfo = { ...instance.panelInfo, ...patch }; instance.host.webContents.send('component-host:panel-info', { instanceId, info: instance.panelInfo }); }
          return { ...instance.panelInfo };
        } } : {}),
        playbackOwner: () => instance.host.nativeWindow || instance.host,
        playbackViewport: () => {const owner=instance.host.nativeWindow||instance.host;return {...view.getBounds(),zoom:view.webContents.getZoomFactor?.()||1,scale:this.screen?.getDisplayMatching(owner.getBounds()).scaleFactor||1,visible:instance.logicalActive&&!view.webContents.isDestroyed()};},
        grantMediaUrl: url => {
          const token = mediaToken(url);
          if (!token || this.senderBindings.get(view.webContents.id) !== instance || view.webContents.isDestroyed()) return;
          const now = Date.now();
          for (const [key, expires] of instance.mediaGrants) if (expires <= now) instance.mediaGrants.delete(key);
          instance.mediaGrants.delete(token);
          instance.mediaGrants.set(token, now + 60 * 60 * 1000);
          while (instance.mediaGrants.size > 8192) instance.mediaGrants.delete(instance.mediaGrants.keys().next().value);
        },
        emitComponentEvent: (topic, payload) => {
          if (!descriptor.service?.events?.includes(String(topic || ''))) return;
          // A background operation keeps its project binding after its original
          // panel closes. Deliver updates to a reopened panel with that binding.
          for (const target of this.instancesById.values()) {
            const keys = ['componentId', 'workspacePath', 'projectId', 'contentKind', 'scopeRelativePath', 'contributionId'];
            if (keys.every(key => String(target.context[key] || '') === String(instance.context[key] || '')) && !target.view.webContents.isDestroyed()) {
              target.view.webContents.send('component-sdk:event', { topic: String(topic), payload });
            }
          }
        },
      }),
    };
    this.instances.set(key, instance);
    this.instancesById.set(instanceId, instance);
    const senderId = view.webContents.id;
    this.senderBindings.set(senderId, instance);
    this.partitionSessions.set(descriptor.componentId, view.webContents.session);
    const partitionSession = view.webContents.session;
    if (partitionSession.protocol?.handle && !hostPlayerSessions.has(partitionSession)) {
      partitionSession.protocol.handle('photoflow-player', serveHostPlayerAsset);
      hostPlayerSessions.add(partitionSession);
    }
    if (this.mediaProtocolHandler && partitionSession.protocol?.handle && !this.mediaProtocolSessions.has(partitionSession)) {
      partitionSession.protocol.handle('photoflow-media', request => {
        const token = mediaToken(request.url);
        const granted = [...this.instancesById.values()].some(target => target.view.webContents.session === partitionSession && hasMediaGrant(target, token));
        return granted ? this.mediaProtocolHandler(request) : new Response('Not found', { status: 404 });
      });
      this.mediaProtocolSessions.add(partitionSession);
    }
    const componentRoot = descriptor.componentRoot ? path.resolve(descriptor.componentRoot) : '';
    let canonicalComponentRoot='';
    if(componentRoot){const componentRootStat = await require('node:fs').promises.lstat(componentRoot);canonicalComponentRoot = await require('node:fs').promises.realpath(componentRoot);if (!componentRootStat.isDirectory() || componentRootStat.isSymbolicLink()) { this.close(instanceId); throw new Error('Component root is unsafe'); }}
    const diagnostic = (level, message, details = {}) => this.writeLog(level, message, {
      componentId: descriptor.componentId,
      contractVersion: descriptor.contractVersion,
      ...details,
    });
    view.webContents.on('preload-error', (_event, _preloadPath, error) => diagnostic('error', 'Component preload failed', {
      errorName: diagnosticToken(error?.name), errorCode: diagnosticToken(error?.code), messageLength: Math.min(String(error?.message || '').length, 10000),
    }));
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame !== false) diagnostic('error', 'Component page failed to load', { errorCode, errorDescription: diagnosticToken(errorDescription) });
    });
    view.webContents.on('render-process-gone', (_event, details) => diagnostic('error', 'Component renderer process exited', {
      reason: diagnosticToken(details?.reason), exitCode: Number(details?.exitCode) || 0,
    }));
    view.webContents.on('console-message', (_event, detailsOrLevel, message, lineNumber) => {
      const details = typeof detailsOrLevel === 'object' ? detailsOrLevel : { level: detailsOrLevel, message, lineNumber };
      if (!['error', 3].includes(details?.level)) return;
      diagnostic('error', 'Component renderer console error', { lineNumber: Number(details?.lineNumber) || 0, messageLength: Math.min(String(details?.message || '').length, 10000) });
    });
    view.webContents.on('before-input-event', (event, input) => {
      if (instance.context.surface !== 'component.sidePanel' || instance.contribution?.placement === 'workspace.folderPanel' || !instance.logicalActive || input?.type !== 'keyDown' || input?.key !== 'Escape') return;
      event.preventDefault();
      if (!instance.host?.isDestroyed?.()) instance.host?.webContents?.send?.('component-host:panel-close-requested', instance.instanceId);
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', event => event.preventDefault());
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.session.webRequest?.onBeforeRequest?.((details, callback) => { void (async () => {
      let allowed = false;
      try {
        const requestUrl = new URL(details.url);
        if (['data:', 'blob:'].includes(requestUrl.protocol)) allowed = true;
        else if (requestUrl.protocol === 'photoflow-player:') {
          const requester = this.senderBindings.get(details.webContentsId);
          allowed = Boolean(requester?.descriptor.componentId === descriptor.componentId && isHostPlayerAsset(details.url));
        }
        else if (requestUrl.protocol === 'photoflow-media:') {
          const requester = this.senderBindings.get(details.webContentsId);
          allowed = Boolean(this.mediaProtocolHandler && requester?.descriptor.componentId === descriptor.componentId && hasMediaGrant(requester, mediaToken(requestUrl.href)));
        }
        else if (requestUrl.protocol === 'file:') {
          if(!componentRoot)throw new Error('Component root is unavailable');
          const fs = require('node:fs'); const candidate = path.resolve(fileURLToPath(requestUrl));
          const stat = await fs.promises.lstat(candidate); const canonicalCandidate = await fs.promises.realpath(candidate);
          const relative = path.relative(canonicalComponentRoot, canonicalCandidate);
          allowed = (stat.isFile() || stat.isDirectory()) && !stat.isSymbolicLink() && !relative.startsWith('..') && !path.isAbsolute(relative) && !await filePathHasLink(fs, componentRoot, candidate);
        }
      } catch { allowed = false; }
      callback({ cancel: !allowed });
    })(); });
    view.webContents.once('destroyed', () => {
      this.senderBindings.delete(senderId);
      if (this.instances.get(key) === instance) this.instances.delete(key);
      if (this.instancesById.get(instanceId) === instance) this.instancesById.delete(instanceId);
      if (![...this.senderBindings.values()].some(bound => bound.context.componentId === descriptor.componentId)) { this.notificationService?.clearComponent?.(descriptor.componentId); void this.requestComponentCapabilityClear(descriptor.componentId, [], 2000, true); }
    });
    if (host.closed || host.isDestroyed?.()) { this.close(instanceId); throw new Error('Component host is closed'); }
    instance.host.contentView.addChildView(view);
    this.onViewStackChanged();
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    instance.readyPromise = Promise.resolve().then(() => view.webContents.loadFile(page.entry)).then(() => {
      if (this.instances.get(key) !== instance || view.webContents.isDestroyed()) throw new Error('Component page open was superseded');
      return this.applySurfaceStyle(instance).then(() => instance);
    });
    try { await instance.readyPromise; }
    catch (error) { if (this.instances.get(key) === instance) this.close(instanceId); throw error; }
    if (surface === 'application.settings' && !instance.settingsLeases.has(leaseId)) throw new Error('Component settings page lease was released');
    if (!this.activate(instanceId, activationGeneration)) {
      if (surface === 'application.settings') this.releaseSettings(request);
      if (instance.latestOpenGeneration === activationGeneration) this.close(instanceId);
      throw new Error('Component page open was superseded');
    }
    return this.publicInstance(instance, leaseId);
    } finally {
      retainedLifecycleLease?.release();
      if (ownsLifecycleLease) lifecycleLease.release();
    }
  }

  publicInstance(instance, leaseId = '') {
    return { instanceId: instance.instanceId, componentId: instance.descriptor.componentId, pageId: instance.page.id, pageTitle: instance.page.title, surface: instance.context.surface, ...(instance.panelInfo ? { panelInfo: instance.panelInfo } : {}), ...(instance.contentSize?.height ? { contentHeight: instance.contentSize.height } : {}), ...(leaseId ? { leaseId } : {}) };
  }

  publicContext(instance) {
    const { playbackOwner: _privatePlaybackOwner, playbackViewport: _privatePlaybackViewport, workspacePath: _privateWorkspacePath, contentRootPath: _privateContentRootPath, previewOwnerId: _previewOwnerId, updatePanelInfo: _updatePanelInfo, eventSender: _privateEventSender, emitComponentEvent: _privateEmit, grantMediaUrl: _privateMediaGrant, ...publicContext } = instance.context;
    const applicationSettings = instance.context.surface === 'application.settings'; const applicationCommand = instance.context.surface === 'application.command'; const applicationSurface = applicationSettings || applicationCommand;
    const permissions = applicationSurface
      ? (instance.descriptor.service?.permissions || []).filter(permission => ['component.settings', 'component.secrets', 'network.fetch', 'component.lifecycle.read', 'component.lifecycle.manage', 'dialogs', 'notifications'].includes(permission))
      : instance.descriptor.service?.permissions || [];
    return {
      ...publicContext,
      permissions,
      events: applicationSurface ? [] : instance.descriptor.service?.events || [],
      themeContractVersion: 1,
      uiContractVersion: 1,
      panelStyleContractVersion: 1,
      panelLayoutContractVersion: 1,
      resolvedTheme: this.resolvedTheme,
      locale: applicationLocalization.getLocale(),
    };
  }

  async applySurfaceStyle(instance) {
    const contents = instance?.view?.webContents;
    if (!contents || contents.isDestroyed() || typeof contents.insertCSS !== 'function') return;
    const previousKey = instance.surfaceCssKey;
    let nextKey;
    try { nextKey = await contents.insertCSS(componentSurfaceCss(this.resolvedTheme, instance.context.surface)); }
    catch (error) { this.writeLog('warn', 'Unable to apply component surface style', { componentId: instance.descriptor?.componentId || '', error: error?.message || String(error) }); return; }
    if (contents.isDestroyed() || this.instancesById.get(instance.instanceId) !== instance) {
      if (nextKey && typeof contents.removeInsertedCSS === 'function') await contents.removeInsertedCSS(nextKey).catch(() => undefined);
      return;
    }
    instance.surfaceCssKey = nextKey;
    if (previousKey && typeof contents.removeInsertedCSS === 'function') await contents.removeInsertedCSS(previousKey).catch(() => undefined);
  }

  setResolvedLocale(value) {
    if (!applicationLocalization.isSupportedLocale(value) || this.resolvedLocale === value) return false;
    this.resolvedLocale = value;
    for (const instance of this.instances.values()) if (!instance.view.webContents.isDestroyed()) instance.view.webContents.send('component-sdk:locale-changed', { contractVersion: 1, locale: value });
    return true;
  }

  setResolvedTheme(value) {
    const resolvedTheme = normalizeResolvedTheme(value);
    if (this.resolvedTheme === resolvedTheme) return false;
    this.resolvedTheme = resolvedTheme;
    for (const instance of this.instances.values()) if (!instance.view.webContents.isDestroyed()) { instance.view.webContents.send('component-sdk:theme-changed', { contractVersion: 1, resolvedTheme }); void this.applySurfaceStyle(instance); }
    return true;
  }

  activate(instanceId, expectedGeneration = null) {
    const docked = this.instancesById.get(instanceId);
    if (docked?.contribution?.placement === 'workspace.folderPanel' && this.owns(docked)) { this.applyVisibility(docked); return true; }
    if (expectedGeneration === null) this.activationGeneration += 1;
    else if (expectedGeneration !== this.activationGeneration) return false;
    const found = !instanceId || [...this.instances.values()].some(instance => instance.instanceId === instanceId && this.owns(instance));
    if (!found) return false;
    this.activeInstanceId = instanceId;
    for (const instance of this.instances.values()) {
      if (!this.owns(instance)) continue;
      if (instance.contribution?.placement === 'workspace.folderPanel') { this.applyVisibility(instance); continue; }
      const active = instance.instanceId === instanceId;
      if (instance.logicalActive !== active) {
        instance.logicalActive = active;
        if (!instance.view.webContents.isDestroyed()) instance.view.webContents.send(active ? 'component-sdk:activate' : 'component-sdk:deactivate');
      }
      this.applyVisibility(instance);
    }
    this.onViewStackChanged();
    return Boolean(instanceId);
  }

  deactivateIfActive(instanceId){if(this.activeInstanceId!==String(instanceId||''))return false;this.activate('');return true;}

  applyVisibility(instance) {
    instance.view.setVisible(instance.logicalActive && !instance.hostState.hostSurfaceState.suspended);
    this.applyBounds(instance);
  }

  setHostSurfaceSuspended(update) {
    const rendererToken = String(update?.rendererToken || '');
    const revision = Number(update?.revision);
    if (!rendererToken || rendererToken.length > 200 || !Number.isSafeInteger(revision) || revision < 0 || typeof update?.suspended !== 'boolean') throw new Error('Invalid host surface state');
    if (rendererToken === this.hostSurfaceState.rendererToken && revision <= this.hostSurfaceState.revision) return false;
    const rendererReloaded = Boolean(this.hostSurfaceState.rendererToken && rendererToken !== this.hostSurfaceState.rendererToken);
    this.hostSurfaceState = { rendererToken, revision, suspended: update.suspended };
    if (rendererReloaded) this.activeInstanceId = '';
    for (const instance of this.instances.values()) {
      if (!this.owns(instance)) continue;
      if (rendererReloaded && instance.logicalActive) {
        instance.logicalActive = false;
        if (!instance.view.webContents.isDestroyed()) instance.view.webContents.send('component-sdk:deactivate');
      }
      this.applyVisibility(instance);
    }
    return true;
  }

  setBounds(instanceId, bounds) {
    if (!validBounds(bounds)) throw new Error('Invalid component page bounds');
    const instance = [...this.instances.values()].find(item => item.instanceId === instanceId);
    if (!instance) return false;
    instance.requestedBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    if (instance.contribution?.placement === 'workspace.folderPanel') {
      const active = bounds.width > 0 && bounds.height > 0;
      if (instance.logicalActive !== active) { instance.logicalActive = active; if (!instance.view.webContents.isDestroyed()) instance.view.webContents.send(active ? 'component-sdk:activate' : 'component-sdk:deactivate'); }
      this.applyVisibility(instance); this.onViewStackChanged(); return true;
    }
    this.applyBounds(instance);
    return true;
  }

  applyBounds(instance) {
    const bounds = instance.logicalActive && !instance.hostState.hostSurfaceState.suspended
      ? instance.requestedBounds
      : { x: 0, y: 0, width: 0, height: 0 };
    instance.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    this.refreshPlaybackBounds?.(instance.context);
  }

  setNotificationRendererReady(ready) { return this.notificationService?.setRendererReady?.(ready) || { ready: false, flushed: 0 }; }

  close(instanceId) {
    const instance = this.instancesById.get(instanceId);
    if (!instance) return false;
    const componentId = instance.descriptor.componentId;
    const lastComponentView = ![...this.senderBindings.values()].some(bound => bound !== instance && bound.context.componentId === componentId);
    if (lastComponentView) void this.requestComponentCapabilityClear(componentId, [instance.view.webContents], 2000, true);
    clearTimeout(instance.settingsCloseTimer);
    instance.settingsCloseTimer = null;
    if (this.instances.get(instance.key) === instance) this.instances.delete(instance.key);
    if (this.instancesById.get(instanceId) === instance) this.instancesById.delete(instanceId);
    if (instance.hostState.activeInstanceId === instanceId) instance.hostState.activeInstanceId = '';
    this.senderBindings.delete(instance.view.webContents.id);
    try { instance.host.contentView.removeChildView(instance.view); } catch { /* already detached */ }
    if (!instance.view.webContents.isDestroyed()) instance.view.webContents.close({ waitForBeforeUnload: false });
    return true;
  }

  closeProject(workspacePath, projectId) {
    const normalizedWorkspace = normalizeIdentity(workspacePath);
    const ids = [...this.instances.values()].filter(instance => this.owns(instance) && normalizeIdentity(instance.context.workspacePath) === normalizedWorkspace && instance.context.projectId === String(projectId)).map(instance => instance.instanceId);
    ids.forEach(id => this.close(id));
    return ids.length;
  }

  closeComponent(componentId) {
    const normalizedId = componentId;
    componentPartition(normalizedId);
    const instances = [...this.instances.values()].filter(instance => instance.descriptor.componentId === normalizedId);
    const capabilityClear = this.requestComponentCapabilityClear(normalizedId, instances.map(instance => instance.view.webContents));
    instances.forEach(instance => this.close(instance.instanceId));
    this.notificationService?.clearComponent?.(normalizedId);
    void capabilityClear;
    return instances.length;
  }

  async closeComponentAndWait(componentId, timeoutMs = 2000) {
    componentPartition(componentId);
    const contents = [...this.instances.values()].filter(instance => instance.descriptor.componentId === componentId).map(instance => instance.view.webContents);
    const capabilityClear = this.requestComponentCapabilityClear(componentId, contents, timeoutMs);
    this.closeComponent(componentId);
    await Promise.all(contents.map(webContents => waitForWebContentsDestroyed(webContents, timeoutMs)));
    await capabilityClear;
    return contents.length;
  }

  async clearComponentPartitionStorage(componentId) {
    const normalizedId = componentId;
    componentPartition(normalizedId);
    await this.closeComponentAndWait(normalizedId);
    const session = this.partitionSessions.get(normalizedId) || this.partitionSessionProvider?.(componentPartition(normalizedId));
    if (!session) throw new Error(`Component partition session is unavailable: ${componentPartition(normalizedId)}`);
    const failures = [];
    for (const operation of [() => session.clearStorageData?.(), () => session.clearCache?.(), () => session.clearAuthCache?.()]) {
      try { await operation(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `Unable to clear component partition ${componentPartition(normalizedId)}`);
    this.partitionSessions.delete(normalizedId);
    return true;
  }

  destroy() { [...this.instances.values()].forEach(instance => this.close(instance.instanceId)); this.notificationService?.destroy?.(); }
  async closeAllAndWait(timeoutMs = 2000) {
    const instances = [...this.instances.values()];
    const contents = instances.map(instance => instance.view.webContents);
    const pendingAtStart = [...this.capabilityClearOperations.values(), ...this.viewCapabilityClearOperations.values()];
    const componentIds = [...new Set([...instances.map(instance => instance.descriptor.componentId), ...this.failedCapabilityClearIds])];
    const capabilityClears = componentIds.map(componentId => this.requestComponentCapabilityClear(componentId, instances.filter(instance => instance.descriptor.componentId === componentId).map(instance => instance.view.webContents), timeoutMs));
    for (const instance of instances) this.close(instance.instanceId);
    await Promise.all(contents.map(webContents => waitForWebContentsDestroyed(webContents, timeoutMs)));
    await Promise.all([...pendingAtStart, ...capabilityClears, ...this.capabilityClearOperations.values()]);
  }
  async destroyAndWait(timeoutMs = 2000) {
    await this.closeAllAndWait(timeoutMs);
    this.notificationService?.destroy?.();
  }
}

module.exports = { ComponentViewManager, componentPageKey, componentPartition, componentSettingsPageKey, componentSurfaceCss, normalizeOpenScope, normalizeResolvedTheme, selectComponentPreload, validBounds, waitForWebContentsDestroyed };
