const { sendToApplicationRenderers, sendToRequestingRenderer, applicationWindowFor } = require('../services/application-windows.cjs');
const { validateRendererPythonInvocation } = require('../security-policy.cjs');
const { mergeConcurrentConfig } = require('../services/concurrent-config.cjs');
const { listStorageDevices } = require('../services/storage-device-service.cjs');
const { encodeImportVideoToolRequest, importWorkerCompletionIssue, serializeImportWorkerControl } = require('../contracts/import-worker-protocol.cjs');
const { decideComponentStatusRefresh, nextComponentProbeTimestamps } = require('../services/component-status-refresh-policy.cjs');
const { componentDataRoot, createComponentLifecycleService } = require('../services/component-lifecycle-service.cjs');
const { createComponentTransactionService, nodeIdentity: componentPathIdentity } = require('../services/component-transaction-service.cjs');
const { HOST_CAPABILITIES } = require('../component-host-contract.cjs');
const { componentTemporaryDataPaths } = require('../compatibility/component-cache-paths.cjs');
const { captureComponentTreeIdentity, captureVerifiedComponentTreeIdentity, cleanupOwnedComponentPath, componentSubtreeIdentity, extractComponentArchive, inspectComponentArchive, reserveComponentInstallCapacity, snapshotComponentArchive, validateComponentCleanupReceipt, verifyComponentTreeIdentity } = require('../component-package-archive.cjs');
const { componentInstallTimeoutMs } = require('../component-zip64.cjs');
const { PLUGIN_DEFINITIONS } = require('../plugins/plugin-catalog.cjs');
const { validateComponentPackageInspection } = require('../component-registry.cjs');
const { requestAppConfirmation } = require('../services/app-dialog-confirmation.cjs');
const { requestComponentInstallConfirmation } = require('../services/component-install-confirmation.cjs');

const normalizeSdImportAutoMove = value => value !== false;
const copyComponentIntoStaging = async (fsApi, pathApi, source, staging) => {
  // Both trees are installer-owned and immutable until publication. Same-volume
  // hard links avoid a second full payload write; deleting preparation names
  // leaves staging files intact. Cross-volume/unsupported links use normal copy.
  for (const name of await fsApi.promises.readdir(source)) {
    const from = pathApi.join(source, name); const to = pathApi.join(staging, name);
    const stat = await fsApi.promises.lstat(from);
    if (stat.isSymbolicLink()) throw new Error('组件暂存来源包含链接');
    if (stat.isDirectory()) {
      await fsApi.promises.mkdir(to).catch(error => { if (error.code === 'EEXIST') throw Object.assign(new Error('组件暂存目标已存在'), { code: 'ERR_FS_CP_EEXIST' }); throw error; });
      await copyComponentIntoStaging(fsApi, pathApi, from, to);
    } else if (stat.isFile()) {
      try { await fsApi.promises.link(from, to); }
      catch (error) {
        if (error.code === 'EEXIST') throw Object.assign(new Error('组件暂存目标已存在'), { code: 'ERR_FS_CP_EEXIST' });
        if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'EMLINK'].includes(error.code)) throw error;
        await fsApi.promises.cp(from, to, { force: false, errorOnExist: true });
      }
    } else throw new Error('组件暂存来源不是普通文件或目录');
  }
};
const relativePathEscapes = (pathApi, relative) => pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathApi.sep}`);
const componentTemporaryCleanupTargets = ({ path, tempRoot, installRoot, receipts }) => {
  const seen = new Set();
  const targets = [];
  for (const receipt of receipts || []) {
    if (receipt?.manualRecovery) continue;
    validateComponentCleanupReceipt(receipt, { disposable: true });
    const parent = path.dirname(receipt.path);
    const name = path.basename(receipt.path);
    const packageStage = parent === path.resolve(tempRoot) && /^photoflow-component-package-[a-z0-9][a-z0-9._-]{0,79}-[a-f0-9-]{36}$/.test(name);
    const packageSnapshot = parent === path.resolve(tempRoot) && /^photoflow-component-package-[a-z0-9][a-z0-9._-]{0,79}-[a-f0-9-]{36}\.zip$/.test(name);
    const installStage = parent === path.resolve(installRoot) && /^\.[a-z0-9][a-z0-9._-]{0,79}-install-\d+-\d+-[a-f0-9-]{36}$/.test(name);
    if (receipt.kind === 'directory' ? !packageStage && !installStage : !packageSnapshot) throw new Error('自动清理只允许程序创建的组件暂存文件');
    if (seen.has(receipt.path)) continue;
    seen.add(receipt.path);
    const target = { path: receipt.path, kind: receipt.kind, nodeIdentity: receipt.nodeIdentity };
    if (receipt.kind === 'file') Object.assign(target, { size: receipt.size, sha256: receipt.sha256, mode: receipt.mode });
    targets.push(target);
  }
  return targets;
};
const createDurableCleanupAdmission = ({ start, flush, worker, receipts }) => {
  let state = 'pending';
  const completion = start(async task => { if (state !== 'admitted') throw Object.assign(new Error('组件清理尚未完成持久 admission'), { cleanupPendingReceipts: receipts }); return worker(task); });
  if (flush() !== true) { state = 'rejected'; return { admitted: false, completion }; }
  state = 'admitted';
  return { admitted: true, completion };
};
const awaitDurableCleanupRestart = async admissionPromise => {
  const admission = await admissionPromise;
  if (!admission?.admitted) throw Object.assign(new Error('组件清理重启未获得持久 admission'), { cleanupPendingReceipts: admission?.targets || [] });
  return admission.completion;
};

const registerHostCapabilities = (componentCapabilityBroker, registrations) => {
  for (const [method, handler] of registrations) {
    if (!HOST_CAPABILITIES.has(method)) throw new Error(`System IPC cannot register undeclared host capability: ${method}`);
    componentCapabilityBroker.register(method, handler);
  }
};

const transitionComponentEnabled = async ({ componentId, enabled, pluginService, componentCapabilityBroker, componentViewManager, componentServiceManager, processSupervisor, abortComponentNetworkRequests, transitionLease }) => {
  const id = String(componentId || '').trim();
  if (typeof enabled !== 'boolean') throw new TypeError('组件启用状态必须是布尔值');
  const component = pluginService.list().find(item => item.id === id);
  if (!component?.installed) throw new Error('组件尚未安装或发现');
  const currentlyEnabled = component.enabled !== false;
  if (currentlyEnabled === enabled) return { componentId: id, enabled };
  if (enabled) return pluginService.setComponentEnabled(id, true);
  if (!component.compatible) throw new Error('组件当前不可用，无需禁用');
  const capabilityBarrier = componentCapabilityBroker.blockComponent(id);
  let stateChanged = false;
  try {
    transitionLease?.requestStop?.();
    await componentServiceManager?.stop?.(id, 'component-disabled');
    await processSupervisor?.stopWhere?.(status => status.owner?.componentId === id, 'component-disabled');
    await (componentViewManager?.closeComponentAndWait?.(id) ?? componentViewManager?.closeComponent?.(id));
    abortComponentNetworkRequests?.(id);
    await capabilityBarrier.drain({ timeoutMs: 7500 });
    await transitionLease?.promote?.();
    pluginService.setComponentEnabled(id, false); stateChanged = true;
    return { componentId: id, enabled: false };
  } catch (error) {
    if (stateChanged) pluginService.setComponentEnabled(id, true);
    throw error;
  } finally { capabilityBarrier.release(); }
};

const PYTHON_BACKGROUND_TASK_PROFILES = Object.freeze({
  'png_to_jpg.py': Object.freeze({ title: '图片转 JPG', type: 'python-tool', concurrencyGroup: 'disk-io', concurrencyLimit: 3, concurrencyWriteLimit: 2 }),
  'research.py': Object.freeze({ title: '截取分镜帧', type: 'python-tool', concurrencyGroup: 'heavy-media', concurrencyLimit: 1, concurrencyWriteLimit: 1 }),
  'ffmpeg_transcode.py': Object.freeze({ title: '视频转码', type: 'python-tool', concurrencyGroup: 'heavy-media', concurrencyLimit: 1, concurrencyWriteLimit: 1 }),
  'cut_video.py': Object.freeze({ title: '视频切割', type: 'python-tool', concurrencyGroup: 'heavy-media', concurrencyLimit: 1, concurrencyWriteLimit: 1 }),
});

const shouldTrackPythonToolAsBackgroundTask = (scriptName, args = []) => Boolean(PYTHON_BACKGROUND_TASK_PROFILES[scriptName])
  && !args.includes('--inspect-only');

const PYTHON_WORKER_RESOURCE_PROFILES = Object.freeze({
  'classify.py': Object.freeze({
    'video-split': Object.freeze({ capacities: [Object.freeze({ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 })] }),
    'video-transcode': Object.freeze({ capacities: [Object.freeze({ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 })] }),
    'video-preview': Object.freeze({ capacities: [Object.freeze({ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 })] }),
    'raw-jpg': Object.freeze({ capacities: [Object.freeze({ key: 'cpu-heavy', access: 'write', limit: 1, writeLimit: 1 })] }),
  }),
});

const resolvePythonWorkerResourceLease = (scriptName, payload) => {
  const leaseId = String(payload?.leaseId || '');
  const profile = String(payload?.profile || '');
  const phase = String(payload?.phase || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  if (!/^[a-z0-9-]{8,100}$/i.test(leaseId)) throw new Error('Invalid worker resource lease identifier');
  const definition = PYTHON_WORKER_RESOURCE_PROFILES[scriptName]?.[profile];
  if (!definition) throw new Error('Worker requested an unsupported resource profile');
  return {
    leaseId,
    profile,
    definition: {
      capacities: definition.capacities.map(capacity => ({ ...capacity })),
      runningMessage: phase || '正在执行资源密集阶段',
    },
  };
};

const normalizePythonTaskPresentation = value => {
  if (!value || typeof value !== 'object') return null;
  const ownerPageId = String(value.ownerPageId || '').trim().slice(0, 160);
  const panelKind = String(value.panelKind || '').trim().slice(0, 80);
  const title = String(value.title || '').trim().slice(0, 160);
  return ownerPageId && panelKind ? { ownerPageId, panelKind, title } : null;
};

const pythonToolResourcePaths = (scriptName, args, pathApi) => {
  const paths = [];
  const addDirectoryFor = value => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const resolved = pathApi.resolve(normalized);
    if (resolved) paths.push(pathApi.dirname(resolved));
  };
  const addDirectory = value => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const resolved = pathApi.resolve(normalized);
    if (resolved) paths.push(resolved);
  };
  const addTranscodeDestinationFamily = value => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const resolved = pathApi.resolve(normalized).replace(/[\\/]+/g, '/').toLocaleLowerCase();
    if (resolved) paths.push(`photoflow-transcode-destination/${resolved}`);
  };
  if (scriptName === 'research.py') {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--path' && args[index + 1]) addDirectoryFor(args[++index]);
    }
  } else {
    const valueOptions = new Set(scriptName === 'png_to_jpg.py'
      ? ['--quality']
      : scriptName === 'ffmpeg_transcode.py'
        ? ['--container', '--video-mode', '--quality', '--resolution', '--frame-rate', '--audio-mode', '--subtitle-mode', '--color-mode', '--bit-depth', '--frame-rate-mode', '--rotation', '--aspect-mode', '--audio-track', '--video-bitrate-mbps', '--audio-bitrate-kbps', '--encoder-preset', '--retry-count', '--output-mode', '--source-folder']
        : ['--output-dir', '--output-stem', '--trim-start', '--trim-end', '--output-path', '--timeline-frames']);
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      if (valueOptions.has(value)) {
        const optionValue = args[++index];
        if (value === '--source-folder') {
          addDirectory(optionValue);
          addTranscodeDestinationFamily(optionValue);
        }
        else if (value === '--output-dir') addDirectory(optionValue);
        else if (value === '--output-path') addDirectoryFor(optionValue);
        continue;
      }
      if (!String(value || '').startsWith('--')) addDirectoryFor(value);
    }
  }
  return [...new Set(paths)].map(resourcePath => ({ path: resourcePath, access: 'write' }));
};

const RESERVED_PROJECT_CATEGORIES = new Set(['未分类', '策划中', '待拍摄', '后期中', '已归档']);
const normalizeCustomProjectCategories = value => {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const name = String(item || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    const hasControlCharacter = [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!name || name.length > 24 || hasControlCharacter || RESERVED_PROJECT_CATEGORIES.has(name) || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= 50) break;
  }
  return result;
};
const normalizeProjectCategoryOrder = (value, customCategories) => {
  const available = ['策划中', '待拍摄', '后期中', '已归档', ...customCategories];
  const byKey = new Map(available.map(name => [name.toLocaleLowerCase(), name]));
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const key = String(item || '').trim().toLocaleLowerCase();
    const name = byKey.get(key);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  for (const name of available) {
    const key = name.toLocaleLowerCase();
    if (!seen.has(key)) result.push(name);
  }
  return result;
};
const normalizeProgressNamePresets = value => {
  const source = Array.isArray(value) ? value : ['调色后', '修脸后', '完成版'];
  const result = [];
  const seen = new Set();
  for (const item of source) {
    const name = String(item || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    const invalid = [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!name || name.length > 24 || invalid || seen.has(key)) continue;
    seen.add(key); result.push(name);
    if (result.length >= 50) break;
  }
  return result;
};

const PRIVACY_CONSENT_BOOLEAN_FIELDS = ['acceptCore', 'revokeCore', 'experienceProgramGranted', 'faceRecognitionGranted'];
const validatePrivacyConsentRequest = request => {
  if (!request || typeof request !== 'object' || Array.isArray(request) || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) {
    throw new TypeError('隐私同意请求必须是普通对象');
  }
  for (const field of PRIVACY_CONSENT_BOOLEAN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(request, field) && typeof request[field] !== 'boolean') throw new TypeError(`隐私同意字段 ${field} 必须是布尔值`);
  }
  if (request.acceptCore === true && request.revokeCore === true) throw new TypeError('不能同时接受和撤回核心同意');
  return request;
};

const COMPONENT_INSTALL_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const validateComponentInstallRequest = request => {
  if (!request || typeof request !== 'object' || Array.isArray(request) || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) throw new TypeError('组件安装请求必须是普通对象');
  const keys = Object.keys(request);
  if (keys.length !== 1 || keys[0] !== 'componentId') throw new TypeError('组件安装请求字段无效');
  if (typeof request.componentId !== 'string' || !COMPONENT_INSTALL_ID.test(request.componentId)) throw new TypeError('组件 ID 无效');
  return { componentId: request.componentId };
};
const confirmComponentPackageInstall = async ({ componentId, componentName = componentId, componentVersion, requestConfirmation }) => {
  return await requestConfirmation({
    title: `安装“${componentName}”？`,
    message: `版本 ${componentVersion} · 安装组件可能存在风险`,
    detail: '组件可访问或修改你的文件、连接网络并运行程序。请确认后继续安装。',
  }) === true;
};
const confirmComponentBackgroundStop = async ({ componentId, componentName = componentId, action, processSupervisor, mainWindow, requestConfirmation = presentation => requestAppConfirmation(mainWindow?.webContents, presentation) }) => {
  const active = processSupervisor?.hasComponentOwnerProcesses?.(componentId) === true
    || processSupervisor?.hasWhere?.(status => status.owner?.componentId === componentId) === true
    || processSupervisor?.hasUnconfirmedOwner?.(componentId) === true;
  if (!active) return true;
  const messages = {
    disable: { title: '插件仍在后台运行', message: '禁用此插件需要先关闭它的全部后台进程。', detail: '', continueLabel: '关闭后台进程并继续禁用' },
    install: { title: '更新需要关闭插件后台进程', message: '安装或更新此插件前，需要关闭它的全部后台进程。', detail: '', continueLabel: '关闭后台进程并继续安装或更新' },
    uninstall: { title: '插件仍在后台运行', message: `“${componentName}”仍有后台进程。`, detail: '继续卸载需要先关闭该插件的全部后台进程。', continueLabel: '关闭后台进程并继续卸载' },
  };
  const presentation = messages[action];
  if (!presentation) throw new Error('组件后台停止确认动作无效');
  return await requestConfirmation({
    title: presentation.title, message: presentation.message, detail: presentation.detail,
    confirmLabel: presentation.continueLabel, cancelDefault: true,
  }) === true;
};
const snapshotComponentTrust = (componentId, manifest) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('组件快照清单无效');
  if (manifest.id !== componentId) throw new Error(`组件 ID 不匹配：需要 ${componentId}，实际为 ${manifest.id || '未填写'}`);
  if (manifest.apiVersion !== 1) throw new Error(`组件接口版本不兼容：${manifest.apiVersion || '未填写'}`);
  if (typeof manifest.version !== 'string' || !manifest.version.trim() || manifest.version.length > 128) throw new Error('组件版本无效');
  return { componentId, componentVersion: manifest.version };
};
const directoryNodeIdentity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
const sameDirectoryNode = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
const readDirectoryNodeIdentity = async (fsApi, target, label = '目录') => {
  const stat = await fsApi.promises.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}不是安全的普通目录`);
  return directoryNodeIdentity(stat);
};
const assertDirectoryNodeIdentity = async (fsApi, target, expected, label = '目录') => {
  const actual = await readDirectoryNodeIdentity(fsApi, target, label);
  if (!sameDirectoryNode(actual, expected)) throw new Error(`${label}在安装期间被替换`);
  return true;
};
const prepareSafeComponentInstallContainer = async ({ fs: fsApi, path: pathApi, installRoot, componentId }) => {
  const resolvedRoot = pathApi.resolve(installRoot);
  const volumeRoot = pathApi.parse(resolvedRoot).root;
  let current = volumeRoot;
  const segments = pathApi.relative(volumeRoot, resolvedRoot).split(pathApi.sep).filter(Boolean);
  for (const segment of segments) {
    current = pathApi.join(current, segment);
    let stat = await fsApi.promises.lstat(current).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) { await fsApi.promises.mkdir(current, { recursive: false }); stat = await fsApi.promises.lstat(current); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`组件安装路径包含链接或非目录项：${current}`);
  }
  const canonicalRoot = await fsApi.promises.realpath(resolvedRoot);
  const container = pathApi.join(resolvedRoot, componentId);
  let containerStat = await fsApi.promises.lstat(container).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!containerStat) { await fsApi.promises.mkdir(container, { recursive: false }); containerStat = await fsApi.promises.lstat(container); }
  if (!containerStat.isDirectory() || containerStat.isSymbolicLink()) throw new Error('组件容器包含链接或非目录项');
  const canonicalContainer = await fsApi.promises.realpath(container);
  const relative = pathApi.relative(canonicalRoot, canonicalContainer);
  if (relative !== componentId || relativePathEscapes(pathApi, relative)) throw new Error('组件容器真实路径越过安装根目录');
  return {
    installRoot: resolvedRoot,
    container,
    rootIdentity: await readDirectoryNodeIdentity(fsApi, resolvedRoot, '组件安装根目录'),
    containerIdentity: directoryNodeIdentity(containerStat),
  };
};
const createComponentInstallAdmission = () => {
  const active = new Set();
  return componentId => {
    if (active.has(componentId)) throw new Error('此组件正在安装，请等待当前安装完成');
    active.add(componentId);
    let released = false;
    return () => { if (!released) { released = true; active.delete(componentId); } };
  };
};
const enterComponentInstallTransition = async ({ componentId, componentCapabilityBroker, componentViewManager, componentServiceManager, processSupervisor, abortComponentNetworkRequests, transitionLease }) => {
  if (typeof componentCapabilityBroker?.blockComponent !== 'function' || typeof componentViewManager?.closeComponent !== 'function' || typeof componentServiceManager?.stop !== 'function' || typeof processSupervisor?.stopWhere !== 'function' || typeof abortComponentNetworkRequests !== 'function') throw new Error('组件安装 transition gate 不完整');
  const barrier = componentCapabilityBroker.blockComponent(componentId);
  try {
    transitionLease?.requestStop?.();
    await componentServiceManager.stop(componentId, 'component-install');
    await processSupervisor.stopWhere(status => status.owner?.componentId === componentId, 'component-install');
    await (componentViewManager.closeComponentAndWait?.(componentId) ?? componentViewManager.closeComponent(componentId));
    abortComponentNetworkRequests(componentId);
    await barrier.drain({ timeoutMs: 7500 });
    await transitionLease?.promote?.();
    return barrier;
  } catch (error) {
    barrier.release();
    throw error;
  }
};

const savePrivacyConsentWithConfig = async ({ request, privacyService, configMutationService, telemetryService }) => {
  let validatedRequest;
  try { validatedRequest = validatePrivacyConsentRequest(request); }
  catch (error) { return { success: false, error: error.message || String(error) }; }
  const state = await privacyService.saveConsent(validatedRequest);
  if (validatedRequest.revokeCore !== true) return { success: true, state };

  const disabledTelemetry = { enabled: false, crashReports: false };
  let telemetryDisabled = false;
  let telemetryError;
  try {
    if (typeof telemetryService?.disableAndPurge !== 'function') throw new Error('遥测服务不支持安全停用');
    await telemetryService.disableAndPurge();
    telemetryDisabled = true;
  }
  catch (error) { telemetryError = error; }

  let savedConfig;
  try {
    savedConfig = await configMutationService.mutate(current => ({
      ...current,
      telemetry: { ...(current?.telemetry && typeof current.telemetry === 'object' ? current.telemetry : {}), ...disabledTelemetry },
    }));
  } catch (error) {
    const runtimeStatus = telemetryDisabled ? '且本进程遥测已停止' : '，但本进程遥测停止状态也无法确认';
    return {
      success: false,
      error: `核心同意已撤回${runtimeStatus}；无法持久化遥测关闭状态：${error.message || String(error)}`,
      state,
      consentRevoked: true,
      telemetryDisabled,
      configPersisted: false,
    };
  }

  try { await telemetryService.syncConsent(savedConfig.telemetry); telemetryDisabled = true; telemetryError = undefined; }
  catch (error) { telemetryError ||= error; }
  if (telemetryError) {
    return {
      success: false,
      error: `核心同意已撤回且遥测配置已关闭，但无法确认本进程遥测已完全停止：${telemetryError.message || String(telemetryError)}`,
      state,
      consentRevoked: true,
      telemetryDisabled,
      configPersisted: true,
      savedConfig,
    };
  }
  return { success: true, state, savedConfig };
};

const registerSystemIpc = context => {
  const { Array, Boolean, BrowserWindow, Date, Error, JSON, Object, String, abortComponentNetworkRequests, app, approvedMediaCacheDirectories, backgroundTasks, checkForUpdates, clearComponentSecretData, componentCapabilityBroker, componentServiceManager, componentViewManager, configMutationService, console, crypto, dialog, domainCommandJournal, domainHealthService, exiftoolPath, filePublicationService, fileSystemService, findLatestPhotoshop, fs, getConfigPath, getLogDir, getResourceBirthdaysPath, getRunConfig, getUserBirthdaysPath, ipcMain, mainWindow, mediaRuntimeState, openAllowedExternalUrl, path, pluginService, privacyService, process, processSupervisor, readSavedConfig, releaseWorkspaceWatchPath, screen, shell, spawn, suppressWorkspaceWatchPath, telemetryService, thumbnailService, undefined, writeLog } = context;
  if (!configMutationService?.mutate) throw new Error('System IPC requires the shared config mutation service');
  const lifecycleCoordinator = processSupervisor?.lifecycleCoordinator;
  const componentCleanupPublicationService = filePublicationService;
  const mutateConfig = configMutationService.mutate;
  ipcMain.handle('domain-health-status', () => ({
    success: true,
    domains: domainHealthService?.status?.() || [],
    commands: domainCommandJournal?.status?.().filter(command => command.status !== 'completed') || [],
  }));
  ipcMain.handle('domain-command-retry', (_event, commandId) => {
    const normalized = String(commandId || '').trim();
    if (!/^[a-z0-9._:-]{1,128}$/i.test(normalized)) return { success: false, error: '无效的跨域任务标识' };
    const retried = Boolean(domainCommandJournal?.retryDead?.(normalized));
    return retried ? { success: true } : { success: false, error: '任务不存在或尚未进入失败队列' };
  });
  const activePythonTasks = new Map();
  const rememberPythonTask = (requestId, invocationId, task) => {
    const requests = activePythonTasks.get(requestId) || new Map();
    requests.set(invocationId, task);
    activePythonTasks.set(requestId, requests);
  };
  const forgetPythonTask = (requestId, invocationId) => {
    const requests = activePythonTasks.get(requestId);
    if (!requests) return;
    requests.delete(invocationId);
    if (!requests.size) activePythonTasks.delete(requestId);
  };

  const componentRoot = componentId => path.join(pluginService.installRoot, String(componentId));

  const componentStatusCachePath = path.join(app.getPath('userData'), 'component-status-cache.json');
  const componentRuntimeProbeTtlMs = 24 * 60 * 60 * 1000;
  const componentRuntimeRetryDelayMs = 30 * 60 * 1000;
  let componentStatusCache = { updatedAt: 0, lastDetailedAt: 0, lastDetailedAttemptAt: 0, components: [], integrityTokens: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(componentStatusCachePath, 'utf8'));
    if (Array.isArray(parsed?.components)) componentStatusCache = parsed;
  } catch { /* the cache is optional */ }
  let componentStatusDirty = false;
  let componentStatusRefreshActive = false;
  let componentStatusRefreshActiveForce = false;
  let componentStatusGeneration = 0;
  let componentStatusRefreshTimer = null;
  let componentStatusForceQueued = false;

  const mergeCachedComponentStatuses = components => components.map(component => {
    const cached = componentStatusCache.components.find(item => item.id === component.id);
    const compatibleCache = cached
      && cached.installed === component.installed
      && String(cached.version || '') === String(component.version || '');
    const merged = {
      ...(compatibleCache ? cached : {}),
      ...component,
      sizeBytes: compatibleCache ? Number(cached.sizeBytes || 0) : Number(component.sizeBytes || 0),
      packagePath: component.packagePath,
    };
    if (compatibleCache && cached.integrityStatus === 'invalid') Object.assign(merged, {
      compatible: false,
      status: 'integrity-invalid',
      integrityStatus: 'invalid',
      error: cached.error,
    });
    return merged;
  });

  const refreshDetailedComponentStatuses = async (task, { forceRuntimeProbe = false } = {}) => {
    const refreshGeneration = componentStatusGeneration;
    task?.report(5, '正在后台读取组件占用空间');
    const listedComponents = pluginService.list();
    const integrityTokens = {};
    for (const component of listedComponents) {
      if (!component.installed || component.source !== 'user') continue;
      try { integrityTokens[component.id] = pluginService.componentIntegrityToken(component.id, component.path); }
      catch { integrityTokens[component.id] = ''; }
    }
    const reusableIntegrity = listedComponents.every(component => {
      const cached = componentStatusCache.components.find(item => item.id === component.id);
      if (!cached || cached.installed !== component.installed || String(cached.version || '') !== String(component.version || '')) return false;
      if (!component.installed || component.source !== 'user') return true;
      return Boolean(integrityTokens[component.id] && componentStatusCache.integrityTokens?.[component.id] === integrityTokens[component.id]);
    });
    const policy = decideComponentStatusRefresh({
      force: forceRuntimeProbe,
      dirty: componentStatusDirty,
      integrityReusable: reusableIntegrity,
      lastDetailedAt: componentStatusCache.lastDetailedAt,
      lastDetailedAttemptAt: componentStatusCache.lastDetailedAttemptAt,
      runtimeProbeTtlMs: componentRuntimeProbeTtlMs,
      failureRetryDelayMs: componentRuntimeRetryDelayMs,
    });
    if (!reusableIntegrity) {
      for (const component of listedComponents) {
        const token = integrityTokens[component.id];
        if (token && componentStatusCache.integrityTokens?.[component.id] === token) pluginService.seedIntegrityToken(component.id, component.path, token);
      }
    }
    const components = reusableIntegrity ? mergeCachedComponentStatuses(listedComponents) : await pluginService.listWithSizes();
    // An install/uninstall may have completed while this scan was in flight.
    // Never publish its pre-mutation catalog over the fresh list.
    if (refreshGeneration !== componentStatusGeneration) return { count: 0, stale: true };
    const probeTimestamps = nextComponentProbeTimestamps({
      attempted: policy.shouldProbeRuntime,
      succeeded: true,
      lastDetailedAt: componentStatusCache.lastDetailedAt,
      lastDetailedAttemptAt: componentStatusCache.lastDetailedAttemptAt,
    });
    componentStatusCache = {
      updatedAt: Date.now(),
      ...probeTimestamps,
      components,
      integrityTokens,
    };
    componentStatusDirty = componentStatusGeneration !== refreshGeneration;
    await fs.promises.writeFile(componentStatusCachePath, JSON.stringify(componentStatusCache), 'utf8').catch(error => {
      writeLog('warn', 'Unable to persist component status cache', { error: error.message || String(error) });
    });
    task?.report(100, '组件状态已刷新');
    if (refreshGeneration === componentStatusGeneration && mainWindow && !mainWindow.isDestroyed()) sendToApplicationRenderers(mainWindow, 'components-status-changed', {
      success: true,
      components,
      installPath: pluginService.installRoot,
    });
    return { count: components.length };
  };

  const queueComponentStatusRefresh = (force = false) => {
    if (componentStatusRefreshActive) {
      componentStatusForceQueued ||= force && !componentStatusRefreshActiveForce;
      return;
    }
    if (componentStatusRefreshTimer) {
      if (!force) return;
      clearTimeout(componentStatusRefreshTimer);
      componentStatusRefreshTimer = null;
    }
    if (!force && !componentStatusDirty && Date.now() - Number(componentStatusCache.updatedAt || 0) < 5 * 60 * 1000) return;
    const execute = async task => {
      try { return await refreshDetailedComponentStatuses(task, { forceRuntimeProbe: force }); }
      finally {
        componentStatusRefreshActive = false;
        componentStatusRefreshActiveForce = false;
        if (componentStatusDirty || componentStatusForceQueued) {
          const queuedForce = componentStatusForceQueued || componentStatusDirty;
          componentStatusForceQueued = false;
          setTimeout(() => queueComponentStatusRefresh(queuedForce), 100);
        }
      }
    };
    const launch = () => {
      componentStatusRefreshTimer = null;
      if (componentStatusRefreshActive) return;
      componentStatusRefreshActive = true;
      componentStatusRefreshActiveForce = force;
      if (!backgroundTasks?.run) {
        void execute().catch(error => writeLog('warn', 'Background component status refresh failed', { error: error.message || String(error) }));
        return;
      }
      const run = () => backgroundTasks.run({
        type: 'component-status-refresh',
        title: '刷新组件状态',
        dedupeKey: 'component-status-refresh',
        cancellable: false,
      }, execute, run);
      void run().catch(error => writeLog('warn', 'Background component status refresh failed', { error: error.message || String(error) }));
    };
    componentStatusRefreshTimer = setTimeout(launch, force ? 100 : 15000);
  };

  const invalidateComponentStatus = () => {
    componentStatusGeneration += 1;
    componentStatusDirty = true;
    queueComponentStatusRefresh(true);
  };
  const componentLifecycleService = createComponentLifecycleService({
    app, backgroundTasks, pluginService, spawn, processSupervisor,
    developmentActionRoot: path.resolve(__dirname, '..', '..', 'scripts'),
    invalidateComponentStatus, writeLog,
  });
  registerHostCapabilities(componentCapabilityBroker, [
    ['component.lifecycle', componentLifecycleService.invoke],
  ]);

  backgroundTasks?.registerTypeRestartFactory?.('component-status-refresh', task => {
    componentStatusRefreshActive = true;
    const execute = async taskContext => {
      try { return await refreshDetailedComponentStatuses(taskContext); }
      finally { componentStatusRefreshActive = false; }
    };
    return backgroundTasks.run({
      id: task.id,
      type: 'component-status-refresh',
      title: '刷新组件状态',
      dedupeKey: 'component-status-refresh',
      cancellable: false,
    }, execute);
  }, { autoRestart: true });

  const queueSystemFilesystemCleanup = async (paths, title, restartTask = null) => {
    const allowedRoots = [app.getPath('temp'), pluginService.installRoot].map(candidate => path.resolve(candidate));
    const targets = componentTemporaryCleanupTargets({ path, tempRoot: app.getPath('temp'), installRoot: pluginService.installRoot, receipts: paths });
    if (!targets.length) return { admitted: false, reason: 'no-valid-receipts' };
    const execute = async task => {
      task?.report(10, title);
      const failures = [];
      for (const target of targets) {
        try {
          const root = allowedRoots.find(candidate => {
            const relative = path.relative(candidate, target.path);
            return relative && !relativePathEscapes(path, relative);
          });
          // These uniquely named extraction/copy stages are disposable. Persist
          // their root ownership, keeping large file lists out of task history.
          // Runtime and user data never enter this queue.
          await cleanupOwnedComponentPath(target, { root, allowMissing: true, allowPartial: true, disposable: true });
        } catch (error) {
          failures.push({ target, error });
          writeLog('warn', 'Deferred system cleanup failed', { path: target.path, error: error.message || String(error) });
        }
      }
      if (failures.length) throw Object.assign(new Error('仍有 ' + failures.length + ' 个系统暂存路径等待清理'), {
        cleanupPendingPaths: failures.map(item => item.target.path), cleanupPendingReceipts: failures.map(item => item.target),
      });
      return { removedCount: targets.length };
    };
    if (!backgroundTasks?.run) {
      writeLog('warn', 'Persistent background task service unavailable; component cleanup retained for manual recovery', { targets: targets.map(target => target.path) });
      return { admitted: false, reason: 'persistence-unavailable', targets };
    }
    const dedupeKey = `system-filesystem-cleanup:${crypto.createHash('sha256').update(JSON.stringify(targets.map(target => ({ path: target.path, kind: target.kind, nodeIdentity: target.nodeIdentity })))).digest('hex').slice(0, 24)}`;
    let retryFactory;
    const admit = (sourceTask = restartTask, { reuseId = false } = {}) => {
      const taskMetadata = { targets, title };
      return createDurableCleanupAdmission({ start: worker => backgroundTasks.run({ ...(reuseId && sourceTask?.id ? { id: sourceTask.id } : {}), type: 'system-filesystem-cleanup', title, dedupeKey, cancellable: false, metadata: taskMetadata }, worker, retryFactory), flush: () => backgroundTasks.flush?.(), worker: task => execute(task), receipts: targets });
    };
    retryFactory = failedTask => awaitDurableCleanupRestart(Promise.resolve(admit(failedTask)));
    const admission = admit(restartTask, { reuseId: Boolean(restartTask?.id) });
    const launched = admission.completion;
    if (!admission.admitted) {
      void launched.catch(error => writeLog('warn', 'Rejected component cleanup admission', { error: error.message || String(error) }));
      throw Object.assign(new Error('组件清理 receipt 无法同步持久化，已保留恢复对象'), { cleanupPendingReceipts: targets });
    }
    void launched.catch(error => writeLog('warn', 'Deferred system cleanup failed', { error: error.message || String(error) }));
    const durableCompletion = launched.then(completion => {
      if (completion?.task?.state === 'completed' && backgroundTasks.flush?.() !== true) throw Object.assign(new Error('组件清理任务完成状态无法同步持久化'), { cleanupPendingReceipts: targets });
      return completion;
    });
    void durableCompletion.catch(() => undefined);
    return { admitted: true, completion: durableCompletion };
  };
  backgroundTasks?.registerTypeRestartFactory?.('system-filesystem-cleanup', task => awaitDurableCleanupRestart(queueSystemFilesystemCleanup(task.metadata?.targets || [], task.metadata?.title || task.title, task)), { autoRestart: true });

  const recycleManaged = async (root, target, label = path.basename(target)) => {
    let stat;
    try { stat = await fs.promises.lstat(target); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    const resolvedRoot = path.resolve(root); const resolvedTarget = path.resolve(target);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || stat.isSymbolicLink()) throw new Error(`${label}越过受管目录或包含链接`);
    const [canonicalRoot, canonicalTarget] = await Promise.all([fs.promises.realpath(resolvedRoot), fs.promises.realpath(resolvedTarget)]);
    const canonicalRelative = path.relative(canonicalRoot, canonicalTarget);
    if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) throw new Error(`${label}的真实路径越过受管目录`);
    await shell.trashItem(resolvedTarget);
  };
  const componentCleanupSteps = (componentId, clearUserData) => {
    const steps = [];
    if (clearUserData) {
      steps.push({ name: 'partition', run: async () => { if (await componentViewManager?.clearComponentPartitionStorage?.(componentId) !== true) throw new Error('组件浏览器分区未执行清理'); } });
      steps.push({ name: 'workspace', run: async () => {
        const workspaceDataRoot = path.join(app.getPath('userData'), 'workspace-data');
        const entries = await fs.promises.readdir(workspaceDataRoot, { withFileTypes: true }).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const workspaceRoot = path.join(workspaceDataRoot, entry.name);
          await recycleManaged(workspaceRoot, path.join(workspaceRoot, 'components', componentId));
          await recycleManaged(workspaceRoot, path.join(workspaceRoot, componentId));
          for (const suffix of ['', '-wal', '-shm']) await recycleManaged(workspaceRoot, path.join(workspaceRoot, 'databases', `${componentId}.sqlite3${suffix}`));
        }
      } });
      steps.push({ name: 'temporary', run: async () => {
        const tempRoot = app.getPath('temp');
        for (const target of componentTemporaryDataPaths({ path, tempRoot, componentId })) await recycleManaged(tempRoot, target);
      } });
      steps.push({ name: 'lifecycle', run: async () => {
        const target = componentDataRoot(app, componentId, process.env);
        await recycleManaged(path.dirname(target), target, '组件 lifecycle 数据');
      } });
      steps.push({ name: 'settings', run: () => mutateConfig(config => {
        const componentSettings = { ...(config.componentSettings || {}) };
        const componentSettingsRevisions = { ...(config.componentSettingsRevisions || {}) };
        if (!Object.prototype.hasOwnProperty.call(componentSettings, componentId)) return config;
        delete componentSettings[componentId];
        componentSettingsRevisions[componentId] = configMutationService.nextRevision(componentSettingsRevisions[componentId]);
        return { ...config, componentSettings, componentSettingsRevisions };
      }) });
      steps.push({ name: 'secrets', run: () => { if (typeof clearComponentSecretData !== 'function') throw new Error('组件私密数据清理依赖不可用'); return clearComponentSecretData(componentId); } });
    }
    return steps;
  };
  const commitComponentHostState = async componentId => {
    await componentServiceManager?.stop?.(componentId, 'component-transaction-commit');
    await configMutationService.adoptLegacySettings();
  };
  const componentTransactions = createComponentTransactionService({
    fs, path, crypto, installRoot: pluginService.installRoot, preparationRoot: app.getPath('temp'), captureTreeIdentity: captureComponentTreeIdentity, verifyTreeIdentity: verifyComponentTreeIdentity,
    cleanupOwnedPath: cleanupOwnedComponentPath,
    getComponentEnabled: componentId => pluginService.list().find(item => item.id === componentId)?.enabled !== false,
    setComponentEnabled: (componentId, enabled) => pluginService.setComponentEnabled(componentId, enabled),
    clearComponentEnabledState: componentId => pluginService.clearComponentEnabledState(componentId),
    recoverInstallHostState: commitComponentHostState,
    cleanupProvider: componentCleanupSteps,
    onBlocked: (componentId, error) => lifecycleCoordinator?.blockPersistent?.(componentId, error),
    onUnblocked: componentId => lifecycleCoordinator?.unblockPersistent?.(componentId),
    onCorrupt: () => lifecycleCoordinator?.blockForCorruptTransaction?.(),
    onWarning: error => writeLog('warn', 'Completed component transaction metadata cleanup deferred', { error: error.message || String(error) }),
  });
  lifecycleCoordinator?.beginStartupRecovery?.();
  const componentTransactionReady = componentTransactions.recover().catch(error => {
    writeLog('error', 'Component transaction startup recovery failed', { error: error.message || String(error), code: error.code });
    lifecycleCoordinator?.blockForCorruptTransaction?.();
    throw error;
  }).finally(() => lifecycleCoordinator?.completeStartupRecovery?.());
  const recoverPendingComponentTransaction = async componentId => {
    if (!await componentTransactions.hasPendingJournal(componentId)) return [];
    const recoveryTransition = lifecycleCoordinator?.acquireRecovery?.(componentId);
    const barrier = componentCapabilityBroker.blockComponent(componentId);
    try {
      recoveryTransition?.requestStop?.();
      await componentServiceManager?.stop?.(componentId, 'component-transaction-recovery');
      await processSupervisor?.stopWhere?.(status => status.owner?.componentId === componentId, 'component-transaction-recovery');
      await (componentViewManager?.closeComponentAndWait?.(componentId) ?? componentViewManager?.closeComponent?.(componentId));
      abortComponentNetworkRequests?.(componentId);
      await barrier.drain({ timeoutMs: 7500 });
      await recoveryTransition?.promote?.();
      if (processSupervisor?.hasComponentOwnerProcesses?.(componentId)) throw Object.assign(new Error('组件后台进程树终止状态仍未确认'), { code: 'PROCESS_TERMINATION_FAILED' });
      return await componentTransactions.recover(componentId);
    } finally { barrier.release(); recoveryTransition?.release?.(); }
  };

  const resolvePreparedPackage = async (packageRoot, pattern, description) => {
    await fs.promises.mkdir(packageRoot, { recursive: true });
    const entries = await fs.promises.readdir(packageRoot, { withFileTypes: true });
    const archives = entries
      .filter(entry => entry.isFile() && pattern.test(entry.name))
      .map(entry => path.join(packageRoot, entry.name));
    if (archives.length > 1) throw new Error(`组件安装包目录中存在多个${description}版本，请只保留一个 ZIP`);
    if (archives.length === 1) return archives[0];
    throw new Error(`未在组件安装包目录中找到${description}：${packageRoot}`);
  };
  const resolveComponentPackage = componentId => Promise.resolve(pluginService.resolvePackage(componentId).packagePath);
  const resolvePackageForDeletion = async (kind, componentId = '') => {
    let archivePath;
    let allowedRoot;
    if (kind === 'component') {
      const known = pluginService.list().find(component => component.id === componentId);
      if (!known) throw new Error(`未知组件：${componentId}`);
      archivePath = await resolveComponentPackage(componentId);
      allowedRoot = pluginService.installRoot;
    } else throw new Error('不支持的安装包类型');
    const resolvedRoot = path.resolve(allowedRoot);
    const resolvedArchive = path.resolve(archivePath);
    const relative = path.relative(resolvedRoot, resolvedArchive);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(resolvedArchive) !== resolvedRoot || path.extname(resolvedArchive).toLowerCase() !== '.zip') {
      throw new Error('安装包路径校验失败');
    }
    return resolvedArchive;
  };

  ipcMain.on('renderer-error-log', (_event, message, details) => {
    const text = String(message || '未知错误').slice(0, 500);
    const detailText = String(details || '').slice(0, 4000);
    const isCrash = /(?:Uncaught|界面渲染失败|React 界面渲染失败)/i.test(text)
      && !/(?:\[hmr\]|validateDOMNesting)/i.test(`${text}\n${detailText}`);
    writeLog(isCrash ? 'error' : 'warn', `Renderer: ${text}`, detailText);
    if (!isCrash) return;
    const error = new Error(String(message || 'Renderer error'));
    error.stack = String(details || error.stack || '');
    telemetryService?.reportCrash('renderer_error', error);
  });

  ipcMain.on('renderer-info-log', (_event, message, details) => {
    const text = String(message || 'Renderer info').slice(0, 500);
    const detailText = String(details || '').slice(0, 4000);
    writeLog('info', `Renderer: ${text}`, detailText);
  });

  ipcMain.on('telemetry-track', (_event, eventName, properties) => {
    telemetryService?.track(eventName, properties);
  });

  ipcMain.on('open-external', (_event, url) => {
    void openAllowedExternalUrl(url).catch(error => writeLog('warn', 'Blocked external URL', { url, error: error.message || String(error) }));
  });

  ipcMain.handle('privacy-consent-state', async () => privacyService.getState());
  ipcMain.handle('privacy-consent-save', async (_event, request) => {
    try {
      return await savePrivacyConsentWithConfig({ request, privacyService, configMutationService, telemetryService });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
  ipcMain.handle('privacy-open-legal-document', async (_event, documentId) => privacyService.openLegalDocument(documentId));
  ipcMain.handle('privacy-clear-telemetry-local-data', async () => {
    try {
      telemetryService?.clearLocalData();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('check-for-updates', async () => checkForUpdates());
  ipcMain.handle('submit-feedback', async (_event, message) => telemetryService.submitFeedback(message));

  ipcMain.handle('set-theme', async (_event, theme) => {
    if (!mainWindow) return;
    const isDark = theme === 'dark';
    (applicationWindowFor(_event.sender, BrowserWindow) || mainWindow).setBackgroundColor(isDark ? '#030407' : '#f8fafc');
    componentViewManager?.setResolvedTheme(isDark ? 'dark' : 'light');
  });

  ipcMain.on('window-minimize', event => applicationWindowFor(event.sender, BrowserWindow)?.minimize());

  ipcMain.handle('window-toggle-maximize', event => {
    const targetWindow = applicationWindowFor(event.sender, BrowserWindow);
    if (!targetWindow) return false;
    if (targetWindow.isMaximized()) targetWindow.unmaximize();
    else targetWindow.maximize();
    return targetWindow.isMaximized();
  });

  ipcMain.on('window-close', event => applicationWindowFor(event.sender, BrowserWindow)?.close());

  ipcMain.handle('window-is-maximized', event => applicationWindowFor(event.sender, BrowserWindow)?.isMaximized() ?? false);
  const fullscreenRestoreState = new WeakMap();
  ipcMain.handle('window-set-fullscreen', (event, enabled) => {
    const targetWindow = applicationWindowFor(event.sender, BrowserWindow);
    if (!targetWindow || targetWindow.isDestroyed()) return false;
    const next = Boolean(enabled);
    if (next) {
      if (!fullscreenRestoreState.has(targetWindow)) fullscreenRestoreState.set(targetWindow, {
        alwaysOnTop: targetWindow.isAlwaysOnTop(),
        fullScreen: targetWindow.isFullScreen(),
        kiosk: targetWindow.isKiosk(),
        maximized: targetWindow.isMaximized(),
      });
      if (process.platform === 'win32') {
        // A frameless maximized window can remain below the always-on-top
        // Windows taskbar. Kiosk plus the screen-saver z-order guarantees the
        // media surface covers the complete display until preview full-screen exits.
        targetWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        targetWindow.setKiosk(true);
        targetWindow.show();
        targetWindow.focus();
        targetWindow.moveTop();
        return targetWindow.isKiosk() && targetWindow.isAlwaysOnTop();
      }
      targetWindow.setFullScreen(true);
      return targetWindow.isFullScreen();
    }
    const restore = fullscreenRestoreState.get(targetWindow);
    targetWindow.setKiosk(restore?.kiosk ?? false);
    targetWindow.setFullScreen(restore?.fullScreen ?? false);
    targetWindow.setAlwaysOnTop(restore?.alwaysOnTop ?? false);
    if (restore?.maximized && !targetWindow.isMaximized()) targetWindow.maximize();
    fullscreenRestoreState.delete(targetWindow);
    return false;
  });

  ipcMain.handle('cursor-screen-point', () => screen.getCursorScreenPoint());

  ipcMain.handle('components-list', async (_event, force = false) => {
    const components = mergeCachedComponentStatuses(pluginService.list());
    queueComponentStatusRefresh(force === true);
    return { success: true, components, installPath: pluginService.installRoot };
  });

  ipcMain.handle('components-open-folder', async (_event, componentId = '') => {
    try {
      const installRoot = pluginService.ensureInstallRoot();
      let installPath = installRoot;
      if (componentId) {
        const known = pluginService.list().find(component => component.id === componentId);
        if (!known) throw new Error(`未知组件：${componentId}`);
        installPath = known.source === 'development' ? known.path : componentRoot(componentId);
        if (known.source !== 'development') await fs.promises.mkdir(installPath, { recursive: true });
      }
      const error = await shell.openPath(installPath);
      if (error) throw new Error(error);
      return { success: true, path: installPath };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('components-set-enabled', async (_event, componentId, enabled) => {
    let transitionLease;
    try {
      transitionLease = lifecycleCoordinator?.acquire?.(componentId, enabled ? '启用' : '禁用', { stopOnly: enabled === false });
      if (enabled === false && !await confirmComponentBackgroundStop({ componentId, action: 'disable', processSupervisor, lifecycleCoordinator, dialog, mainWindow })) return { success: false, cancelled: true };
      const result = await transitionComponentEnabled({ componentId, enabled, pluginService, componentCapabilityBroker, componentViewManager, componentServiceManager, processSupervisor, abortComponentNetworkRequests, transitionLease });
      invalidateComponentStatus();
      writeLog('info', result.enabled ? 'Component enabled' : 'Component disabled', { componentId: result.componentId });
      return { success: true, enabled: result.enabled };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    } finally { transitionLease?.release?.(); }
  });

  ipcMain.handle('logs-open-folder', async () => {
    try {
      const logDir = getLogDir();
      const error = await shell.openPath(logDir);
      if (error) throw new Error(error);
      return { success: true, path: logDir };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('logs-clear', async () => {
    try {
      let deletedCount = 0;
      const logDir = getLogDir();
      for (const fileName of await fs.promises.readdir(logDir)) {
        // Keep the operation scoped to files created by PhotoFlow's logger.
        if (!/^photoflow-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) continue;
        const filePath = path.join(logDir, fileName);
        const stat = await fs.promises.lstat(filePath).catch(() => null);
        if (!stat?.isFile()) continue;
        await fs.promises.unlink(filePath);
        deletedCount += 1;
      }
      return { success: true, deletedCount };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('interface-cache-clear', async event => {
    try {
      const targetSession = event.sender.session;
      const clearedBytes = await targetSession.getCacheSize().catch(() => 0);
      await targetSession.clearCache();
      return { success: true, clearedBytes };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  const acquireComponentInstall = createComponentInstallAdmission();
  ipcMain.handle('components-install', async (event, request) => {
    let stagingPath = '';
    let packageStagePath = '';
    let packageSnapshotPath = '';
    let packageSnapshotNodeIdentity = null;
    let packageSnapshotReceipt = null;
    let packageStageNodeIdentity = null;
    let packageStageTreeIdentity = null;
    let componentId = '';
    let releaseInstall = null;
    let installTransitionLease = null;
    let capabilityBarrier = null;
    let stagingNodeIdentity = null;
    let componentTreeIdentity = null;
    let capacityReservation = null;
    let installVolumeReservation = null;
    let installResponse = null;
    let packageCleanupAttempted = false;
    let installOperationId = '';
    const installAbortController = new AbortController();
    const abortInstall = () => installAbortController.abort();
    event.sender?.once?.('destroyed', abortInstall);
    try {
      await componentTransactionReady;
      ({ componentId } = validateComponentInstallRequest(request));
      if (!app.isPackaged) throw new Error('开发环境组件由源码提供，请在打包版本中测试安装');
      const discoveredPackage = pluginService.resolvePackage(componentId);
      const archivePath = discoveredPackage.packagePath;
      const archiveStat = await fs.promises.lstat(archivePath);
      if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error('组件包必须是普通文件且不能是链接');
      capacityReservation = await reserveComponentInstallCapacity(app.getPath('temp'), archiveStat.size + 128 * 1024 * 1024);
      const operation = { signal: installAbortController.signal, deadlineAt: Date.now() + componentInstallTimeoutMs(archiveStat.size) };
      const assertInstallActive = () => { if (operation.signal.aborted) throw Object.assign(new Error('组件安装已取消'), { name: 'AbortError' }); if (Date.now() >= operation.deadlineAt) throw Object.assign(new Error('组件安装超时'), { name: 'AbortError' }); };
      installOperationId = crypto.randomUUID();
      packageStagePath = path.join(app.getPath('temp'), `photoflow-component-package-${componentId}-${installOperationId}`);
      packageSnapshotPath = `${packageStagePath}.zip`;
      const sourceIdentity = await snapshotComponentArchive(archivePath, packageSnapshotPath, operation);
      const packageSnapshotStat = await fs.promises.lstat(packageSnapshotPath);
      packageSnapshotNodeIdentity = directoryNodeIdentity(packageSnapshotStat);
      packageSnapshotReceipt = { path: packageSnapshotPath, kind: 'file', nodeIdentity: packageSnapshotNodeIdentity, size: packageSnapshotStat.size, sha256: sourceIdentity.sha256, mode: packageSnapshotStat.mode & 0o777 };
      const packageSizeBytes = sourceIdentity.size;
      const snapshotPackage = inspectComponentArchive(packageSnapshotPath, { ...operation, inspectionToken: sourceIdentity.inspectionToken });
      operation.deadlineAt = Date.now() + componentInstallTimeoutMs(packageSizeBytes, snapshotPackage.totalUncompressedBytes);
      validateComponentPackageInspection(snapshotPackage, { expectedId: componentId, platform: process.platform, arch: process.arch });
      await capacityReservation.resize(packageSizeBytes + snapshotPackage.totalUncompressedBytes + 64 * 1024 * 1024);
      installVolumeReservation = await reserveComponentInstallCapacity(pluginService.installRoot, snapshotPackage.totalUncompressedBytes + 128 * 1024 * 1024);
      const snapshotTrust = snapshotComponentTrust(componentId, snapshotPackage.manifest);
      const componentName = PLUGIN_DEFINITIONS[componentId]?.name || String(snapshotPackage.manifest.displayName || snapshotPackage.manifest.name || componentId).slice(0, 120);
      const confirmed = await confirmComponentPackageInstall({ ...snapshotTrust, componentName, requestConfirmation: presentation => requestComponentInstallConfirmation(event.sender, presentation, operation) });
      if (!confirmed) return installResponse = { success: false, cancelled: true };
      if (!await confirmComponentBackgroundStop({ componentId, action: 'install', processSupervisor, lifecycleCoordinator, dialog, mainWindow })) return installResponse = { success: false, cancelled: true };
      const recoveredTransactions = await recoverPendingComponentTransaction(componentId);
      const recoveredInstall = recoveredTransactions.find(result => result.kind === 'install' && result.status === 'committed');
      if (recoveredInstall) return { success: true, recovered: true, operationId: recoveredInstall.operationId };
      if (lifecycleCoordinator) { installTransitionLease = lifecycleCoordinator.acquire(componentId, '安装或更新'); releaseInstall = () => installTransitionLease.release(); }
      else releaseInstall = acquireComponentInstall(componentId);
      capabilityBarrier = await enterComponentInstallTransition({ componentId, componentCapabilityBroker, componentViewManager, componentServiceManager, processSupervisor, abortComponentNetworkRequests, transitionLease: installTransitionLease });
      const extractedPackage = await extractComponentArchive(snapshotPackage, packageStagePath, operation);
      packageStageNodeIdentity = await readDirectoryNodeIdentity(fs, packageStagePath, '组件包展开暂存目录');
      packageStageTreeIdentity = extractedPackage.treeIdentity;
      const manifestDirectory = path.dirname(extractedPackage.manifestEntry);
      const componentRoot = path.resolve(packageStagePath, manifestDirectory === '.' ? '' : manifestDirectory);
      const stagedRelative = path.relative(packageStagePath, componentRoot);
      if (relativePathEscapes(path, stagedRelative)) throw new Error('组件清单路径越界');
      const manifest = extractedPackage.manifest;
      snapshotComponentTrust(componentId, manifest);
      const entrypoints = manifest.entrypoints || {};
      const relativeEntry = entrypoints[`${process.platform}-${process.arch}`] || entrypoints[process.platform] || entrypoints.default;
      if (typeof relativeEntry !== 'string' || !relativeEntry.trim()) throw new Error('组件没有适用于当前系统的入口文件');
      const sourceEntry = path.resolve(componentRoot, relativeEntry);
      const sourceRelative = path.relative(componentRoot, sourceEntry);
      if (!sourceRelative || relativePathEscapes(path, sourceRelative)) throw new Error('组件入口路径无效');
      if (!(await fs.promises.stat(sourceEntry).catch(() => null))?.isFile()) throw new Error(`组件入口不存在：${relativeEntry}`);
      for (const relativeFile of Array.isArray(manifest.requiredFiles) ? manifest.requiredFiles : []) {
        if (typeof relativeFile !== 'string' || !relativeFile.trim()) throw new Error('组件必需文件路径无效');
        const sourceFile = path.resolve(componentRoot, relativeFile);
        const requiredRelative = path.relative(componentRoot, sourceFile);
        if (!requiredRelative || relativePathEscapes(path, requiredRelative)) throw new Error(`组件必需文件路径无效：${relativeFile}`);
        if (!(await fs.promises.stat(sourceFile).catch(() => null))?.isFile()) throw new Error(`组件必需文件不存在：${relativeFile}`);
      }
      await pluginService.verifyComponentDirectoryAsync(componentId, componentRoot, true);
      componentTreeIdentity = componentSubtreeIdentity(extractedPackage.treeIdentity, extractedPackage.manifestEntry);
      const componentSizeBytes = componentTreeIdentity.reduce((total, entry) => total + (entry.kind === 'file' ? entry.size : 0), 0);
      await installVolumeReservation.resize((componentSizeBytes * 2) + 128 * 1024 * 1024);
      // Extraction already read back the tree. Check the copied destination
      // against that receipt below instead of rehashing the source twice.

      const installLocation = await prepareSafeComponentInstallContainer({ fs, path, installRoot: pluginService.installRoot, componentId });
      const { installRoot, container } = installLocation;
      const destination = path.join(container, 'runtime');
      stagingPath = path.join(installRoot, `.${componentId}-install-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
      assertInstallActive();
      await fs.promises.mkdir(stagingPath);
      stagingNodeIdentity = await readDirectoryNodeIdentity(fs, stagingPath, '组件发布暂存目录');
      await copyComponentIntoStaging(fs, path, componentRoot, stagingPath);
      stagingNodeIdentity = await readDirectoryNodeIdentity(fs, stagingPath, '组件发布暂存目录');
      componentTreeIdentity = await captureVerifiedComponentTreeIdentity(stagingPath, componentTreeIdentity);
      assertInstallActive();
      await assertDirectoryNodeIdentity(fs, installRoot, installLocation.rootIdentity, '组件安装根目录');
      await assertDirectoryNodeIdentity(fs, container, installLocation.containerIdentity, '组件容器');
      const packageCleanupPaths = [
        packageStagePath && packageStageNodeIdentity && packageStageTreeIdentity ? { path: packageStagePath, kind: 'directory', nodeIdentity: packageStageNodeIdentity, treeIdentity: packageStageTreeIdentity } : null,
        packageSnapshotReceipt,
      ].filter(Boolean);
      const previous = pluginService.list().find(item => item.id === componentId);
      const transactionStagingPath = stagingPath; const transactionStagingIdentity = stagingNodeIdentity;
      const transactionResult = await componentTransactions.install({
        operationId: installOperationId, componentId, container, destination, stagingPath: transactionStagingPath, stagingIdentity: transactionStagingIdentity,
        stagingTreeIdentity: componentTreeIdentity, preparationCleanup: packageCleanupPaths, previousInstalled: Boolean(previous?.installed), previousEnabled: previous ? previous.enabled !== false : false, desiredEnabled: true,
        validatePublished: target => pluginService.verifyComponentDirectoryAsync(componentId, target, true),
        commitHostState: () => commitComponentHostState(componentId),
        onAdmitted: () => { stagingPath = ''; stagingNodeIdentity = null; packageCleanupAttempted = true; packageStagePath = ''; packageSnapshotPath = ''; },
      });
      invalidateComponentStatus();
      writeLog('info', 'Component installed', { componentId, destination });
      return installResponse = { success: true, installed: true, packageSizeBytes, operationId: transactionResult.operationId, cleanupPending: false };
    } catch (error) {
      const pendingCleanup = Array.isArray(error?.cleanupPendingReceipts) && error.cleanupPendingReceipts.length ? error.cleanupPendingReceipts : error?.cleanupPendingPaths;
      writeLog('error', 'Component installation failed', { componentId, operationId: installOperationId, code: error.code, error: error.message || String(error), stack: error.stack });
      if (!packageCleanupAttempted && Array.isArray(pendingCleanup) && pendingCleanup.length) await queueSystemFilesystemCleanup(pendingCleanup, `清理“${componentId || '未知'}”组件失败暂存文件`).catch(cleanupError => { error.message = `${error.message || String(error)}；${cleanupError.message || String(cleanupError)}`; });
      return { success: false, error: error.message || String(error), operationId: error?.journal?.operationId || error?.transactionRecord?.operationId, cleanupPending: Boolean(error?.journal) || error?.cleanupPending === true || Boolean(pendingCleanup?.length), outcomeUnknown: Boolean(error?.outcomeUnknown), ...(error?.recoveryPath ? { recoveryPath: error.recoveryPath } : {}) };
    } finally {
      const deferredCleanup = [
        stagingPath && stagingNodeIdentity ? { path: stagingPath, kind: 'directory', nodeIdentity: stagingNodeIdentity, treeIdentity: componentTreeIdentity } : null,
        !packageCleanupAttempted && packageStagePath && packageStageNodeIdentity && packageStageTreeIdentity ? { path: packageStagePath, kind: 'directory', nodeIdentity: packageStageNodeIdentity, treeIdentity: packageStageTreeIdentity } : null,
        !packageCleanupAttempted && packageSnapshotPath && packageSnapshotReceipt,
      ].filter(Boolean);
      if (deferredCleanup.length) await queueSystemFilesystemCleanup(deferredCleanup, `恢复“${componentId || '未知组件'}”安装临时文件`).catch(cleanupError => writeLog('warn', 'Deferred component cleanup admission failed', { componentId, error: cleanupError.message || String(cleanupError) }));
      capabilityBarrier?.release?.();
      releaseInstall?.();
      await capacityReservation?.release?.();
      await installVolumeReservation?.release?.();
      event.sender?.removeListener?.('destroyed', abortInstall);
    }
  });

  ipcMain.handle('components-delete-package', async (_event, kind, componentId = '') => {
    try {
      const archivePath = await resolvePackageForDeletion(String(kind || ''), String(componentId || ''));
      if (!componentCleanupPublicationService?.nativeAvailable?.()) throw new Error('对象身份绑定删除服务不可用，安装包已保留');
      const handle = await fs.promises.open(archivePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let stat;
      try {
        stat = await handle.stat();
        if (!stat.isFile()) throw new Error('安装包不是普通文件');
        const native = await componentCleanupPublicationService.inspectPath(archivePath);
        if (!native?.success || !native.identity) throw new Error('安装包原生身份检查不完整');
        const linked = await fs.promises.lstat(archivePath);
        if (linked.isSymbolicLink() || linked.dev !== stat.dev || linked.ino !== stat.ino || linked.size !== stat.size || linked.mtimeMs !== stat.mtimeMs || linked.ctimeMs !== stat.ctimeMs) throw new Error('安装包在删除检查期间被替换');
        const hash = crypto.createHash('sha256'); for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
        const after = await handle.stat(); const afterPath = await fs.promises.lstat(archivePath);
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || afterPath.dev !== stat.dev || afterPath.ino !== stat.ino) throw new Error('安装包在哈希期间被替换或修改');
        const deleted = await componentCleanupPublicationService.compareDeleteFile({ target: archivePath, sha256: hash.digest('hex'), size: stat.size, identity: native.identity });
        if (!deleted?.success || deleted.deleted !== true || deleted.outcomeUnknown) throw new Error('安装包对象身份绑定删除未完全提交');
      } finally { await handle.close().catch(() => undefined); }
      writeLog('info', 'Installed package deleted after user confirmation', { kind, componentId, archivePath, deletedBytes: stat.size });
      return { success: true, deletedBytes: stat.size };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('components-uninstall', async (_event, componentId, options = {}) => {
    let transitionLease;
    try {
      await componentTransactionReady;
      const recoveryComponentId = String(componentId || '');
      if (!app.isPackaged) throw new Error('开发环境组件由源码提供，不能在应用内卸载');
      const clearUserData = options?.clearUserData === true;
      if (clearUserData && typeof clearComponentSecretData !== 'function') throw new Error('组件私密数据清理依赖不可用');
      const promptComponent = pluginService.list().find(item => item.id === componentId);
      if (!await confirmComponentBackgroundStop({ componentId: recoveryComponentId, componentName: promptComponent?.name || recoveryComponentId, action: 'uninstall', processSupervisor, lifecycleCoordinator, dialog, mainWindow })) return { success: false, cancelled: true };
      const recoveredTransactions = await recoverPendingComponentTransaction(recoveryComponentId);
      const recoveredUninstall = recoveredTransactions.find(result => result.kind === 'uninstall' && result.status === 'committed');
      if (recoveredUninstall) { invalidateComponentStatus(); return { success: true, recovered: true, dataCleared: recoveredUninstall.clearUserData, cleanupWarnings: [], operationId: recoveredUninstall.operationId }; }
      const component = pluginService.list().find(item => item.id === componentId);
      if (!component?.installed) throw new Error('组件尚未安装');
      if (component.source !== 'user') throw new Error('此组件不在用户组件目录中，不能通过组件管理卸载');
      transitionLease = lifecycleCoordinator?.acquire?.(componentId, '卸载', { stopOnly: true });
      const installRoot = path.resolve(pluginService.installRoot);
      const componentPath = path.resolve(component.path);
      const containerPath = path.basename(componentPath) === 'runtime' ? path.dirname(componentPath) : componentPath;
      const relative = path.relative(installRoot, containerPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(containerPath) !== componentId) throw new Error('组件目录校验失败');
      const capabilityBarrier = componentCapabilityBroker.blockComponent(componentId);
      try {
      transitionLease?.requestStop?.();
      await componentServiceManager?.stop?.(componentId, 'component-uninstall');
      await processSupervisor?.stopWhere?.(status => status.owner?.componentId === componentId, 'component-uninstall');
      await componentViewManager?.closeComponentAndWait?.(componentId);
      abortComponentNetworkRequests?.(componentId);
      await capabilityBarrier.drain({ timeoutMs: 7500 });
      await transitionLease?.promote?.();
      const uninstallPath = clearUserData || componentPath === containerPath ? containerPath : componentPath;
      const uninstallStat = await fs.promises.lstat(uninstallPath);
      if (!uninstallStat.isDirectory() || uninstallStat.isSymbolicLink()) throw new Error('组件卸载目标不是安全的普通目录');
      const result = await componentTransactions.uninstall({
        componentId, container: containerPath, destination: componentPath, targetPath: uninstallPath,
        targetIdentity: componentPathIdentity(uninstallStat), targetTreeIdentity: await captureComponentTreeIdentity(uninstallPath),
        clearUserData, previousEnabled: component.enabled !== false,
      });
      invalidateComponentStatus();
      writeLog('info', 'Component uninstalled', { componentId, componentPath: uninstallPath, clearUserData, operationId: result.operationId });
      return { success: true, dataCleared: clearUserData, cleanupWarnings: [], operationId: result.operationId };
      } finally { capabilityBarrier.release(); }
    } catch (error) {
      writeLog('error', 'Component uninstall failed', { componentId, clearUserData: options?.clearUserData === true, code: error.code, error: error.message || String(error), stack: error.stack, operationId: error?.journal?.operationId || error?.transactionRecord?.operationId });
      return { success: false, error: error.message || String(error), operationId: error?.journal?.operationId || error?.transactionRecord?.operationId, cleanupPending: Boolean(error?.journal) || error?.cleanupPending === true, outcomeUnknown: Boolean(error?.outcomeUnknown) };
    } finally { transitionLease?.release?.(); }
  });

  ipcMain.handle('cancel-python', async (_event, requestId) => {
    const normalizedRequestId = String(requestId || '');
    const tasks = [...(activePythonTasks.get(normalizedRequestId)?.values() || [])];
    const coordinatorResults = tasks.map(task => task.backgroundTaskId && backgroundTasks?.cancel?.(task.backgroundTaskId) === true);
    const coordinatorCancelled = coordinatorResults.some(Boolean);
    if (!tasks.length) return coordinatorCancelled ? { success: true } : { success: false, error: '任务已经结束或不存在。' };
    try {
      const cancelFiles = [...new Set(tasks.map(task => task.cancelFile).filter(Boolean))];
      await Promise.all(cancelFiles.map(filePath => fs.promises.writeFile(filePath, 'cancel', 'utf8')));
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('control-python', async (_event, requestId, action) => {
    const tasks = [...(activePythonTasks.get(String(requestId || ''))?.values() || [])];
    if (!['pause', 'resume'].includes(action)) return { success: false, error: '不支持的任务控制操作。' };
    const pauseFiles = [...new Set(tasks.map(task => task.pauseFile).filter(Boolean))];
    if (!pauseFiles.length) return { success: false, error: '任务已经结束或不支持暂停。' };
    try {
      if (action === 'pause') await Promise.all(pauseFiles.map(filePath => fs.promises.writeFile(filePath, 'pause', 'utf8')));
      else await Promise.all(pauseFiles.map(filePath => fs.promises.rm(filePath, { force: true })));
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.on('run-python', async (event, scriptName, args = [], requestId = '', requestedPresentation) => {
    let command;
    let spawnArgs;
    try {
      const invocation = validateRendererPythonInvocation(scriptName, args, requestId);
      scriptName = invocation.scriptName;
      args = invocation.args;
      requestId = invocation.requestId;
    } catch (error) {
      writeLog('warn', 'Rejected renderer Python invocation', { scriptName, error: error.message || String(error) });
      event.sender.send('python-event', { type: 'error', message: '不允许启动该工具', scriptName: String(scriptName || ''), requestId: String(requestId || '') });
      event.sender.send('python-event', { type: 'complete', message: '任务未启动', data: { exitCode: 1 }, scriptName: String(scriptName || ''), requestId: String(requestId || '') });
      return;
    }
    const normalizedRequestId = String(requestId || '');
    const taskPresentation = normalizePythonTaskPresentation(requestedPresentation);
    const invocationId = crypto.randomUUID();
    const stageArgumentIndex = scriptName === 'classify.py' ? args.indexOf('--stage') : -1;
    const classifyStage = stageArgumentIndex >= 0 ? String(args[stageArgumentIndex + 1] || '') : '';
    const writesImportFiles = scriptName === 'classify.py' && ['plan', 'import', 'broll'].includes(classifyStage);
    const tracksImportTask = scriptName === 'classify.py' && ['plan', 'import', 'broll'].includes(classifyStage);
    const cancellableClassify = scriptName === 'classify.py' && ['plan', 'import', 'broll'].includes(classifyStage);
    const cancellable = (scriptName === 'catch.py' || scriptName === 'cut_video.py' || scriptName === 'ffmpeg_transcode.py' || cancellableClassify) && /^[a-z0-9-]{8,80}$/i.test(normalizedRequestId);
    const cancelFile = cancellable ? path.join(app.getPath('temp'), `photoflow-cancel-${normalizedRequestId}.flag`) : '';
    const pauseFile = scriptName === 'ffmpeg_transcode.py' && cancellable ? path.join(app.getPath('temp'), `photoflow-pause-${normalizedRequestId}.flag`) : '';
    let runtimeArgs = cancellable ? [...args, '--cancel_file', cancelFile] : [...args];
    if (pauseFile) runtimeArgs.push('--pause_file', pauseFile);
    if (scriptName === 'classify.py' && ['plan', 'import', 'broll'].includes(classifyStage)) {
      if (['plan', 'import', 'broll'].includes(classifyStage)) runtimeArgs.push('--resource_protocol');
      try {
        const bundledExifTool = await exiftoolPath();
        if (bundledExifTool) runtimeArgs.push('--exiftool_path', String(bundledExifTool));
      } catch (error) {
        writeLog('warn', 'Unable to resolve bundled ExifTool for import metadata', { error: error.message || String(error) });
      }
    }
    const destinationArgumentIndex = scriptName === 'classify.py' ? args.indexOf('--dest_path') : -1;
    const importDestination = destinationArgumentIndex >= 0 ? path.resolve(String(args[destinationArgumentIndex + 1] || '')) : '';
    let backgroundTaskId = tracksImportTask ? `${normalizedRequestId}:${classifyStage}:${invocationId}` : '';
    let importTask = null;
    let toolTask = null;
    let importOperationLease = null;
    let toolOperationLease = null;
    let importTargets = importDestination ? [importDestination] : [];
    if (tracksImportTask && normalizedRequestId) {
      const sdPathIndex = args.indexOf('--sd_path');
      const sourcePathsIndex = args.indexOf('--source_paths');
      const routeIndex = args.indexOf('--project_routes');
      let sourcePaths = sdPathIndex >= 0 ? [String(args[sdPathIndex + 1] || '')] : [];
      if (sourcePathsIndex >= 0) {
        try { sourcePaths = JSON.parse(String(args[sourcePathsIndex + 1] || '[]')).map(String); } catch { sourcePaths = []; }
      }
      if (routeIndex >= 0) {
        try {
          const routedTargets = Object.values(JSON.parse(String(args[routeIndex + 1] || '{}'))).map(value => String(value || '')).filter(Boolean).map(value => path.resolve(value));
          if (routedTargets.length) importTargets = [...new Set(routedTargets)];
        } catch { /* invalid route data is reported by the Python worker */ }
      }
      const directSource = args.includes('--direct_source');
      const destinationName = importDestination ? path.basename(importDestination) : '';
      const importTitle = classifyStage === 'plan' ? (directSource ? '分析底片素材' : '分析 SD 卡素材') : directSource ? '导入底片' : classifyStage === 'broll' ? '从 SD 卡导入花絮' : '从 SD 卡导入';
      importTask = backgroundTasks?.create?.({
        id: backgroundTaskId,
        type: 'project-file-operation',
        title: destinationName ? `${importTitle} · ${destinationName}` : importTitle,
        message: classifyStage === 'plan' ? '等待扫描素材' : '等待其他文件操作完成',
        runningMessage: classifyStage === 'plan' ? '正在读取拍摄日期并匹配项目' : '正在准备导入',
        metadata: { operation: directSource ? 'import-negative' : 'import-sd', importStage: classifyStage, projectName: destinationName, phase: classifyStage === 'plan' ? 'scanning' : 'queued', destinationPath: importDestination, requestId: normalizedRequestId },
      }) || null;
      if (importTask && !importTask.deduplicated) {
        if (cancelFile) rememberPythonTask(normalizedRequestId, invocationId, { process: null, cancelFile, pauseFile, backgroundTaskId });
        importTask.context.signal.addEventListener('abort', () => {
          if (cancelFile) fs.promises.writeFile(cancelFile, 'cancel', 'utf8').catch(() => undefined);
        }, { once: true });
        try {
          await importTask.waitForStart();
          importOperationLease = await importTask.context.acquireResourceLease({
            capacities: writesImportFiles ? [{ key: 'disk-io', access: 'write', limit: 3, writeLimit: 2 }] : [],
            resourceAccess: writesImportFiles ? 'write' : 'read',
            resources: [...(writesImportFiles ? importTargets : []), ...sourcePaths].filter(Boolean),
            runningMessage: classifyStage === 'plan' ? '正在读取拍摄日期并匹配项目' : '正在准备导入',
          });
        } catch (error) {
          importTask.cancelled();
          forgetPythonTask(normalizedRequestId, invocationId);
          if (cancelFile) fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
          event.sender.send('python-event', { type: 'cancelled', message: '导入已取消', scriptName, requestId });
          event.sender.send('python-event', { type: 'complete', message: '任务未启动', data: { exitCode: 0 }, scriptName, requestId });
          return;
        }
      }
    }
    const toolProfile = PYTHON_BACKGROUND_TASK_PROFILES[scriptName];
    if (!tracksImportTask && shouldTrackPythonToolAsBackgroundTask(scriptName, args) && normalizedRequestId) {
      backgroundTaskId = `python-tool:${normalizedRequestId}`;
      const presentationMetadata = taskPresentation ? {
        presentationOwnerPageId: taskPresentation.ownerPageId,
        presentationPanelKind: taskPresentation.panelKind,
      } : {};
      const taskResources = pythonToolResourcePaths(scriptName, args, path);
      toolTask = backgroundTasks?.create?.({
        id: backgroundTaskId,
        type: toolProfile.type,
        title: taskPresentation?.title || toolProfile.title,
        message: '等待任务资源',
        runningMessage: '正在启动任务',
        cancellable,
        notificationPolicy: 'progress-toast',
        resumePolicy: 'atomic',
        metadata: { scriptName, requestId: normalizedRequestId, phase: 'queued', ...presentationMetadata },
      }) || null;
      if (toolTask && !toolTask.deduplicated) {
        if (cancelFile) rememberPythonTask(normalizedRequestId, invocationId, { process: null, cancelFile, pauseFile, backgroundTaskId });
        toolTask.context.signal.addEventListener('abort', () => {
          if (cancelFile) fs.promises.writeFile(cancelFile, 'cancel', 'utf8').catch(() => undefined);
        }, { once: true });
        try {
          await toolTask.waitForStart();
          toolOperationLease = await toolTask.context.acquireResourceLease({
            capacities: [{
              key: toolProfile.concurrencyGroup,
              access: 'write',
              limit: toolProfile.concurrencyLimit,
              writeLimit: toolProfile.concurrencyWriteLimit,
            }],
            resourceAccess: 'write',
            resources: taskResources,
            runningMessage: '正在启动任务',
          });
        } catch (error) {
          toolTask.cancelled();
          forgetPythonTask(normalizedRequestId, invocationId);
          if (cancelFile) fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
          event.sender.send('python-event', { type: 'cancelled', message: '任务已取消', scriptName, requestId });
          event.sender.send('python-event', { type: 'complete', message: '任务未启动', data: { exitCode: 0 }, scriptName, requestId });
          return;
        }
      }
    }
    const importWatchSuppressedPaths = [];
    let importWatchFinalized = false;
    const importedMediaPaths = new Set();
    const finalizeImportWatch = succeeded => {
      if (!importWatchSuppressedPaths.length || importWatchFinalized) return;
      importWatchFinalized = true;
      for (const targetPath of importWatchSuppressedPaths) releaseWorkspaceWatchPath(targetPath, 250);
      if (!succeeded) return;
      setTimeout(() => {
        for (const targetPath of importWatchSuppressedPaths) {
          const changedPaths = [...importedMediaPaths].filter(candidate => {
            const relative = path.relative(targetPath, candidate);
            return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
          });
          if (changedPaths.length) {
            void thumbnailService?.syncChangedPaths(targetPath, changedPaths, mediaRuntimeState.activeMediaCacheConfig).catch(error => {
              writeLog('warn', 'Post-import thumbnail update deferred', { importDestination: targetPath, error: error.message || String(error) });
            });
          }
          if (mainWindow && !mainWindow.isDestroyed()) sendToApplicationRenderers(mainWindow, 'workspace-files-changed', {
            root: path.dirname(targetPath),
            fileName: path.basename(targetPath),
            eventType: 'rename',
          });
        }
      }, 600);
    };
    const releaseOperationLeases = () => {
      importOperationLease?.release();
      toolOperationLease?.release();
      importOperationLease = null;
      toolOperationLease = null;
    };
    try {
      if (cancelFile) fs.rmSync(cancelFile, { force: true });
      if (pauseFile) fs.rmSync(pauseFile, { force: true });
      ({ command, args: spawnArgs } = getRunConfig(scriptName, runtimeArgs));
      if (writesImportFiles) {
        for (const targetPath of importTargets) {
          if (!targetPath || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) continue;
          suppressWorkspaceWatchPath(targetPath);
          importWatchSuppressedPaths.push(targetPath);
        }
      }
    } catch (error) {
      importTask?.fail(error);
      toolTask?.fail(error);
      forgetPythonTask(normalizedRequestId, invocationId);
      event.sender.send('python-event', { type: 'error', message: error.message || String(error), scriptName, requestId });
      event.sender.send('python-event', {
        type: 'complete',
        message: '任务未启动',
        data: { exitCode: 1 },
        scriptName,
        requestId,
      });
      return;
    }

    // --- 插入权限修复代码开始 ---
    if (process.platform === 'darwin' && app.isPackaged) {
      try {
        // 检查文件是否存在并尝试赋予 755 权限 (rwxr-xr-x)
        if (fs.existsSync(command)) {
          fs.chmodSync(command, 0o755);
          console.log(`Successfully set permissions for: ${command}`);
        }
      } catch (err) {
        console.error(`Failed to set permissions for ${command}:`, err);
      }
    }

    console.log(`Executing: ${command} ${spawnArgs.join(' ')}`);

    try {
      // 注意：windowsHide: true 可以隐藏弹出的黑框
      const managedProcess = processSupervisor?.launch({
        id: `python:renderer-tool:${invocationId}`,
        kind: 'python-job', command, args: spawnArgs, options: {}, ephemeral: true,
      });
      const pyProcess = managedProcess?.child || spawn(command, spawnArgs, { windowsHide: true });
      if (cancellable) rememberPythonTask(normalizedRequestId, invocationId, { process: pyProcess, cancelFile, pauseFile, backgroundTaskId });
      let stdoutBuffer = '';
      let importFailed = false;
      let importCompletionIssue = '';
      let importCancelled = false;
      let importProgress = 0;
      let toolFailed = false;
      let toolCancelled = false;
      let toolProgress = 0;
      let workerClosed = false;
      const pendingWorkerResourceLeases = new Map();
      const activeWorkerResourceLeases = new Map();
      const pendingWorkerVideoTools = new Map();
      const sendWorkerControl = payload => {
        if (workerClosed || !pyProcess.stdin?.writable) return false;
        pyProcess.stdin.write(serializeImportWorkerControl(payload), error => {
          if (error && !workerClosed) writeLog('warn', 'Unable to send Python worker resource control', { error: error.message || String(error) });
        });
        return true;
      };
      const releaseWorkerResourceLease = leaseId => {
        const lease = activeWorkerResourceLeases.get(leaseId);
        if (!lease) return false;
        activeWorkerResourceLeases.delete(leaseId);
        lease.release();
        return true;
      };
      const releaseAllWorkerResourceLeases = () => {
        for (const leaseId of [...activeWorkerResourceLeases.keys()]) releaseWorkerResourceLease(leaseId);
      };
      const clearAllWorkerResourceWaits = () => {
        for (const heartbeat of pendingWorkerResourceLeases.values()) clearInterval(heartbeat);
        pendingWorkerResourceLeases.clear();
      };
      const abortAllWorkerVideoTools = reason => {
        for (const pending of pendingWorkerVideoTools.values()) {
          clearInterval(pending.heartbeat);
          if (!pending.controller.signal.aborted) pending.controller.abort(reason);
        }
        pendingWorkerVideoTools.clear();
      };
      const requestWorkerResourceLease = payload => {
        let request;
        try { request = resolvePythonWorkerResourceLease(scriptName, payload); }
        catch (error) {
          sendWorkerControl({ type: 'resource_denied', leaseId: String(payload?.leaseId || ''), error: error.message || String(error) });
          return;
        }
        if (pendingWorkerResourceLeases.has(request.leaseId) || activeWorkerResourceLeases.has(request.leaseId)) {
          sendWorkerControl({ type: 'resource_denied', leaseId: request.leaseId, error: 'Duplicate worker resource lease identifier' });
          return;
        }
        if (pendingWorkerResourceLeases.size + activeWorkerResourceLeases.size >= 4) {
          sendWorkerControl({ type: 'resource_denied', leaseId: request.leaseId, error: 'Too many worker resource leases' });
          return;
        }
        const sendWaiting = () => sendWorkerControl({ type: 'resource_waiting', leaseId: request.leaseId, profile: request.profile });
        sendWaiting();
        const waitingHeartbeat = setInterval(sendWaiting, 5000);
        pendingWorkerResourceLeases.set(request.leaseId, waitingHeartbeat);
        const acquire = importTask?.context?.acquireResourceLease
          ? importTask.context.acquireResourceLease(request.definition)
          : Promise.resolve({ id: '', release: () => false });
        void acquire.then(lease => {
          clearInterval(waitingHeartbeat);
          pendingWorkerResourceLeases.delete(request.leaseId);
          if (workerClosed) {
            lease.release();
            return;
          }
          activeWorkerResourceLeases.set(request.leaseId, lease);
          if (!sendWorkerControl({ type: 'resource_granted', leaseId: request.leaseId, profile: request.profile })) {
            releaseWorkerResourceLease(request.leaseId);
          }
        }).catch(error => {
          clearInterval(waitingHeartbeat);
          pendingWorkerResourceLeases.delete(request.leaseId);
          sendWorkerControl({ type: 'resource_denied', leaseId: request.leaseId, error: error.message || String(error) });
        });
      };
      const requestWorkerVideoTool = payload => {
        const requestId = String(payload?.requestId || '');
        const action = String(payload?.action || '');
        if (!/^video-[1-9][0-9]{0,5}$/.test(requestId) || !['probe-creation-time', 'preview', 'split', 'transcode'].includes(action) || !payload?.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload) || Buffer.byteLength(JSON.stringify(payload.payload)) > 256 * 1024 || pendingWorkerVideoTools.has(requestId)) {
          sendWorkerControl({ type: 'video_tool_result', requestId, ok: false, error: 'Invalid video tool request' });
          return;
        }
        const controller = new AbortController();
        const sendHeartbeat = () => sendWorkerControl({
          type: 'video_tool_progress', requestId, message: action === 'transcode' ? '正在转码视频' : '正在处理视频', progress: 0,
        });
        sendHeartbeat();
        const heartbeat = setInterval(sendHeartbeat, 5000);
        const pending = { controller, heartbeat };
        pendingWorkerVideoTools.set(requestId, pending);
        const encoded = encodeImportVideoToolRequest(payload.payload, action);
        Promise.resolve().then(() => pluginService.runJson('video-tools', ['bridge', encoded], 4 * 60 * 60 * 1000, message => {
          const text = String(message?.message || '').slice(0, 500);
          if (text) sendWorkerControl({ type: 'video_tool_progress', requestId, message: text, progress: Math.max(0, Math.min(100, Number(message?.progress) || 0)) });
        }, controller.signal)).then(result => {
          sendWorkerControl({ type: 'video_tool_result', requestId, ok: true, result: result?.result || {} });
        }).catch(error => {
          if (!workerClosed) sendWorkerControl({ type: 'video_tool_result', requestId, ok: false, error: error.message || String(error) });
        }).finally(() => {
          clearInterval(heartbeat);
          if (pendingWorkerVideoTools.get(requestId) === pending) pendingWorkerVideoTools.delete(requestId);
        });
      };
      const handlePythonOutputLine = line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const jsonMsg = JSON.parse(trimmed);
          managedProcess?.markHealthy({ protocol: 'renderer-python-events' });
          if (jsonMsg.type === 'resource_request') {
            requestWorkerResourceLease(jsonMsg.data);
            return;
          }
          if (jsonMsg.type === 'resource_release') {
            releaseWorkerResourceLease(String(jsonMsg.data?.leaseId || ''));
            return;
          }
          if (jsonMsg.type === 'video_tool_request') {
            requestWorkerVideoTool(jsonMsg.data);
            return;
          }
          if (tracksImportTask && ['warning', 'error'].includes(jsonMsg.type)) {
            writeLog(jsonMsg.type === 'error' ? 'error' : 'warn', 'Import worker reported a problem', {
              stage: classifyStage, requestId, message: String(jsonMsg.message || '').slice(0, 2000),
            });
          }
          sendToRequestingRenderer(mainWindow, 'python-event', { ...jsonMsg, scriptName, requestId });
          if (jsonMsg.type === 'success' && Array.isArray(jsonMsg.data?.importedPaths)) {
            for (const importedPath of jsonMsg.data.importedPaths) {
              const resolved = path.resolve(String(importedPath || ''));
              if (importTargets.some(target => {
                const relative = path.relative(target, resolved);
                return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
              })) importedMediaPaths.add(resolved);
            }
          }
          if (importTask && !importTask.deduplicated) {
            importCompletionIssue = importWorkerCompletionIssue(jsonMsg, args.includes('--delete_source')) || importCompletionIssue;
            if (jsonMsg.type === 'error') importFailed = true;
            if (jsonMsg.type === 'cancelled') importCancelled = true;
            if (jsonMsg.type === 'progress' || jsonMsg.type === 'status') {
              if (jsonMsg.type === 'progress' && Number.isFinite(Number(jsonMsg.progress))) importProgress = Number(jsonMsg.progress);
              importTask.context.report(importProgress, jsonMsg.message || '正在导入', {
                phase: jsonMsg.type === 'progress' ? 'copying' : 'scanning',
                bytesCopied: Number(jsonMsg.data?.bytesCopied) || 0,
                totalBytes: Number(jsonMsg.data?.totalBytes) || 0,
                filesCopied: Number(jsonMsg.data?.filesCopied) || 0,
                totalFiles: Number(jsonMsg.data?.totalFiles) || 0,
              });
            }
          }
          if (toolTask && !toolTask.deduplicated) {
            if (jsonMsg.type === 'error') toolFailed = true;
            if (jsonMsg.type === 'cancelled') toolCancelled = true;
            if (jsonMsg.type === 'progress' || jsonMsg.type === 'status') {
              if (jsonMsg.type === 'progress' && Number.isFinite(Number(jsonMsg.progress))) toolProgress = Number(jsonMsg.progress);
              toolTask.context.report(toolProgress, jsonMsg.message || `正在执行${toolProfile.title}`, {
                phase: jsonMsg.type === 'progress' ? 'processing' : 'starting',
                currentName: String(jsonMsg.data?.currentName || jsonMsg.data?.fileName || ''),
                processedCount: Number(jsonMsg.data?.processedCount ?? jsonMsg.data?.filesProcessed) || 0,
                totalCount: Number(jsonMsg.data?.totalCount ?? jsonMsg.data?.totalFiles) || 0,
              });
            }
          }

          if (jsonMsg.type === 'log' || jsonMsg.type === 'error') {
            sendToRequestingRenderer(mainWindow, 'python-log', {
              timestamp: new Date().toLocaleTimeString(),
              message: jsonMsg.message,
              type: jsonMsg.type === 'error' ? 'error' : 'info'
            });
          }
        } catch {
          console.log('Raw Python Output:', trimmed);
          sendToRequestingRenderer(mainWindow, 'python-log', {
            timestamp: new Date().toLocaleTimeString(),
            message: trimmed,
            type: 'info'
          });
        }
      };

      pyProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        lines.forEach(handlePythonOutputLine);
      });

      pyProcess.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
          console.error("Python Stderr:", message);
          sendToRequestingRenderer(mainWindow, 'python-log', {
              timestamp: new Date().toLocaleTimeString(),
              message: message,
              type: 'error'
          });
        }
      });

      pyProcess.on('close', (code) => {
        workerClosed = true;
        abortAllWorkerVideoTools(Object.assign(new Error('导入进程已结束'), { code: 'TASK_CANCELLED' }));
        clearAllWorkerResourceWaits();
        releaseAllWorkerResourceLeases();
        releaseOperationLeases();
        if (stdoutBuffer.trim()) handlePythonOutputLine(stdoutBuffer);
        stdoutBuffer = '';
        const cancelledByCoordinator = Boolean(importTask?.context?.signal.aborted);
        const toolCancelledByCoordinator = Boolean(toolTask?.context?.signal.aborted);
        if (cancelledByCoordinator && !importCancelled) {
          importCancelled = true;
          sendToRequestingRenderer(mainWindow, 'python-event', { type: 'cancelled', message: classifyStage === 'plan' ? '素材分析已取消' : '导入已取消', scriptName, requestId });
        } else if (toolCancelledByCoordinator && !toolCancelled) {
          toolCancelled = true;
          sendToRequestingRenderer(mainWindow, 'python-event', { type: 'cancelled', message: '任务已取消', scriptName, requestId });
        } else if (code !== 0 && importTask && !importFailed && !importCancelled) {
          importFailed = true;
          sendToRequestingRenderer(mainWindow, 'python-event', { type: 'error', message: classifyStage === 'plan' ? '素材分析失败' : `导入进程异常退出（代码 ${code}）`, scriptName, requestId });
        } else if (code !== 0 && toolTask && !toolFailed && !toolCancelled) {
          toolFailed = true;
          sendToRequestingRenderer(mainWindow, 'python-event', { type: 'error', message: `任务进程异常退出（代码 ${code}）`, scriptName, requestId });
        }
        // 可以在这里针对特定脚本做处理，比如 classify 退出不一定代表错误
        console.log(`${scriptName} finished with code ${code}`);
        sendToRequestingRenderer(mainWindow, 'python-log', {
            timestamp: new Date().toLocaleTimeString(),
            message: `${scriptName} Process finished`,
            type: code === 0 ? 'success' : 'warning'
        });
        sendToRequestingRenderer(mainWindow, 'python-event', {
          type: 'complete',
          message: code === 0 ? '任务进程已结束' : `任务进程异常退出（代码 ${code}）`,
          data: { exitCode: code },
          scriptName,
          requestId,
        });
        if (cancellable) {
          forgetPythonTask(normalizedRequestId, invocationId);
          fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
          if (pauseFile) fs.promises.rm(pauseFile, { force: true }).catch(() => undefined);
        }
        if (importTask && !importTask.deduplicated) {
          if (importCancelled || importTask.context.signal.aborted) importTask.cancelled();
          else if (code === 0 && !importFailed && importCompletionIssue) importTask.fail(new Error(importCompletionIssue));
          else if (code === 0 && !importFailed) importTask.complete(classifyStage === 'plan' ? '素材分析完成' : '导入完成');
          else importTask.fail(new Error(code === 0 ? '导入失败' : `导入进程异常退出（代码 ${code}）`));
        }
        if (toolTask && !toolTask.deduplicated) {
          if (toolCancelled || toolTask.context.signal.aborted) toolTask.cancelled();
          else if (code === 0 && !toolFailed) toolTask.complete(`${toolProfile.title}完成`);
          else toolTask.fail(new Error(code === 0 ? `${toolProfile.title}失败` : `任务进程异常退出（代码 ${code}）`));
        }
        finalizeImportWatch(classifyStage !== 'plan' && code === 0 && !importFailed && !importCancelled);
      });

      // 监听启动错误（比如 exe 不存在）
      pyProcess.on('error', (err) => {
         workerClosed = true;
         abortAllWorkerVideoTools(err);
         clearAllWorkerResourceWaits();
         releaseAllWorkerResourceLeases();
         releaseOperationLeases();
         importTask?.fail(err);
         toolTask?.fail(err);
         finalizeImportWatch(false);
         if (cancellable) {
           forgetPythonTask(normalizedRequestId, invocationId);
           fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
           if (pauseFile) fs.promises.rm(pauseFile, { force: true }).catch(() => undefined);
         }
         console.error('Failed to start process:', err);
         sendToRequestingRenderer(mainWindow, 'python-event', {
           type: 'error',
           message: `Failed to launch ${scriptName}: ${err.message}`,
           scriptName,
           requestId
         });
      });

    } catch (e) {
      releaseOperationLeases();
      importTask?.fail(e);
      toolTask?.fail(e);
      forgetPythonTask(normalizedRequestId, invocationId);
      finalizeImportWatch(false);
      console.error("Spawn Error:", e);
      event.sender.send('python-event', {
        type: 'error',
        message: `Failed to launch ${scriptName}: ${(e && e.message) || String(e)}`,
        scriptName,
        requestId,
      });
      event.sender.send('python-event', {
        type: 'complete',
        message: '任务未启动',
        data: { exitCode: 1 },
        scriptName,
        requestId,
      });
    }
  });

  ipcMain.handle('getUserPath', async (event) => {
    try {
      const userPath = app.getPath('home').replace(/\\/g, '/');
      console.log('✅ User Path detected (Node.js):', userPath);
      return userPath;

    } catch (error) {
      console.error('❌ Error getting user path:', error);
      return "";
    }
  });

  ipcMain.handle('saveConfig', async (event, config, baseline) => {
    try {
      const customProjectCategories = normalizeCustomProjectCategories(config?.customProjectCategories);
      const workspacePaths = [config?.workspacePath, ...(Array.isArray(config?.workspacePaths) ? config.workspacePaths : [])]
        .map(value => String(value || '').trim())
        .filter((value, index, values) => value && values.findIndex(candidate => path.resolve(candidate).toLocaleLowerCase() === path.resolve(value).toLocaleLowerCase()) === index);
      const normalizedConfig = {
        ...config,
        smartImport: {
          ...config?.smartImport,
          autoMoveProjectAfterSdImport: normalizeSdImportAutoMove(config?.smartImport?.autoMoveProjectAfterSdImport),
        },
        workspacePath: workspacePaths[0] || '',
        workspacePaths,
        customProjectCategories,
        projectCategoryOrder: normalizeProjectCategoryOrder(config?.projectCategoryOrder, customProjectCategories),
        progressNamePresets: normalizeProgressNamePresets(config?.progressNamePresets),
        telemetry: {
          enabled: privacyService.hasCoreConsent() && config?.telemetry?.enabled === true,
          crashReports: privacyService.hasCoreConsent() && config?.telemetry?.crashReports === true,
        },
      };
      const requestedCacheDirectory = String(config?.mediaCache?.directory || '').trim();
      const savedCacheDirectory = String(readSavedConfig()?.mediaCache?.directory || '').trim();
      if (requestedCacheDirectory && (!savedCacheDirectory || path.resolve(requestedCacheDirectory) !== path.resolve(savedCacheDirectory))
        && !approvedMediaCacheDirectories.has(path.resolve(requestedCacheDirectory))) {
        throw new Error('缓存目录必须通过系统文件夹选择器授权');
      }
      if (requestedCacheDirectory) approvedMediaCacheDirectories.add(path.resolve(requestedCacheDirectory));
      const savedConfig = await mutateConfig(current => configMutationService.mergeRendererConfig(mergeConcurrentConfig(baseline, normalizedConfig, current), current));
      telemetryService?.syncConsent(savedConfig.telemetry);
      sendToApplicationRenderers(mainWindow, 'config-changed', savedConfig);
      console.log('✅ Config saved to:', getConfigPath());
      return { success: true, savedConfig };
    } catch (error) {
      console.error('❌ Failed to save config:', error);
      return { success: false, error: String(error) };
    }
  });

  const readBirthdays = () => {
    try {
      const userPath = getUserBirthdaysPath();
      if (!fs.existsSync(userPath)) {
        const resourcePath = getResourceBirthdaysPath();
        if (!fs.existsSync(resourcePath)) return {};
        console.log('Initialize birthdays.json from resources...');
        fs.copyFileSync(resourcePath, userPath);
      }
      const parsed = JSON.parse(fs.readFileSync(userPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      console.error('Error reading birthdays.json:', error);
      return {};
    }
  };

  const loadConfigSnapshot = () => {
    const configPath = getConfigPath();
    if (!configMutationService.hasSnapshot()) return null;
    console.log('✅ Config loaded from:', configPath);
    const config = readSavedConfig();
    if (config?.mediaCache?.directory) approvedMediaCacheDirectories.add(path.resolve(config.mediaCache.directory));
    return config;
  };

  ipcMain.handle('loadConfig', async () => {
    try {
      const config = loadConfigSnapshot();
      if (config) return config;
      console.log('⚠️ No config file found, will use defaults');
      return null;
    } catch (error) {
      console.error('❌ Failed to load config:', error);
      return null;
    }
  });

  ipcMain.handle('load-startup-snapshot', async () => ({
    config: loadConfigSnapshot(),
    birthdays: readBirthdays(),
  }));

  ipcMain.handle('get-birthdays', async () => {
    return readBirthdays();
  });

  ipcMain.handle('save-birthdays', async (event, newContent) => {
    try {
      if (!newContent || typeof newContent !== 'object' || Array.isArray(newContent)) throw new Error('生日数据格式无效');
      const normalized = {};
      for (const [rawName, rawDate] of Object.entries(newContent)) {
        const name = String(rawName).trim();
        const match = String(rawDate).trim().match(/^(\d{1,2})(?:\.|月\.?)(\d{1,2})日?$/);
        if (!name || !match) throw new Error(`生日记录格式无效：${rawName || '未命名'}`);
        const month = Number(match[1]);
        const day = Number(match[2]);
        const probe = new Date(2000, month - 1, day);
        if (month < 1 || month > 12 || day < 1 || day > 31 || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
          throw new Error(`生日日期无效：${name}`);
        }
        normalized[name] = `${month}.${day}`;
      }
      // 始终写入用户目录，确保有权限
      const userPath = getUserBirthdaysPath();
      fs.writeFileSync(userPath, JSON.stringify(normalized, null, 4), 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('Error writing birthdays.json:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('getStorageDevices', async () => {
    try {
      return await listStorageDevices(process.platform);
    } catch (error) {
      console.error('Error getting storage devices:', error);
      throw error;
    }
  });

  // Kept for older renderer bundles during staged upgrades.
  ipcMain.handle('getDrives', async () => {
    try {
      return (await listStorageDevices(process.platform)).devices.map(device => device.mountPath);
    } catch (error) {
      console.error('Error getting drives:', error);
      return [];
    }
  });

  ipcMain.handle('choose-workspace-directory', async (_event, currentPath = '') => {
    const defaultPath = currentPath && fs.existsSync(currentPath) && fs.statSync(currentPath).isDirectory() ? currentPath : undefined;
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作文件夹',
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    });
    return choice.canceled ? { cancelled: true } : { path: choice.filePaths[0] };
  });

  ipcMain.handle('choose-import-source-files', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的底片文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '照片、RAW 与视频', extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'hif', 'arw', 'cr2', 'cr3', 'dng', 'nef', 'orf', 'mp4', 'mov', 'avi', 'crm', 'rwl', 'raf', '3fr', 'fff'] }],
    });
    return choice.canceled ? { cancelled: true, paths: [] } : { paths: choice.filePaths };
  });

  ipcMain.handle('choose-project-import-files', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的文件',
      properties: ['openFile', 'multiSelections'],
    });
    return choice.canceled ? { cancelled: true, paths: [] } : { paths: choice.filePaths };
  });

  ipcMain.handle('choose-video-files', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择视频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'crm', 'mts', 'm2ts', 'ts'] }],
    });
    return choice.canceled ? { cancelled: true, paths: [] } : { paths: choice.filePaths };
  });

  ipcMain.handle('choose-video-folder', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: '选择包含视频的文件夹',
      properties: ['openDirectory'],
    });
    return choice.canceled ? { cancelled: true } : { path: choice.filePaths[0] };
  });

  ipcMain.handle('inspect-source-paths', async (_event, requestedPaths = [], options = {}) => {
    try {
      const includeFolderFiles = options?.includeFolderFiles === true;
      const previewExtensions = new Set((Array.isArray(options?.extensions) ? options.extensions : [])
        .map(value => String(value || '').replace(/^\./, '').toLocaleLowerCase())
        .filter(value => /^[a-z0-9]{1,12}$/.test(value))
        .slice(0, 64));
      const previewFolder = async rootPath => {
        const files = [];
        const pending = [rootPath];
        let count = 0;
        let inspected = 0;
        let truncated = false;
        while (pending.length && inspected < 20_000) {
          const directory = pending.shift();
          let handle;
          try { handle = await fs.promises.opendir(directory); }
          catch { truncated = true; continue; }
          for await (const child of handle) {
            inspected += 1;
            if (inspected > 20_000) { truncated = true; break; }
            if (child.isSymbolicLink()) { truncated = true; continue; }
            const candidate = path.join(directory, child.name);
            if (child.isDirectory()) { pending.push(candidate); continue; }
            if (!child.isFile()) continue;
            const extension = path.extname(child.name).slice(1).toLocaleLowerCase();
            if (previewExtensions.size && !previewExtensions.has(extension)) continue;
            count += 1;
            if (files.length < 2_000) files.push(path.relative(rootPath, candidate).replace(/\\/g, '/'));
            else truncated = true;
          }
        }
        if (pending.length) truncated = true;
        return { count, files, truncated };
      };
      const sourceRequests = (Array.isArray(requestedPaths) ? requestedPaths : [])
        .filter(value => typeof value === 'string' && value.trim() && value.length <= 32768)
        .map(value => value.trim().replace(/^["']+|["']+$/g, ''))
        .filter((value, index, values) => values.findIndex(candidate => {
          const candidatePath = path.resolve(candidate);
          const currentPath = path.resolve(value);
          return process.platform === 'win32'
            ? candidatePath.toLocaleLowerCase() === currentPath.toLocaleLowerCase()
            : candidatePath === currentPath;
        }) === index)
        .map(value => ({ path: value, resolvedPath: path.resolve(value) }))
        .slice(0, 4096);
      const sources = [];
      const missingPaths = [];
      for (const source of sourceRequests) {
        try {
          const stat = await fs.promises.stat(source.resolvedPath);
          if (stat.isDirectory()) sources.push({ path: source.path, kind: 'folder', ...(includeFolderFiles ? { preview: await previewFolder(source.resolvedPath) } : {}) });
          else if (stat.isFile()) sources.push({ path: source.path, kind: 'file' });
          else missingPaths.push(source.path);
        } catch { missingPaths.push(source.path); }
      }
      return { success: true, sources, missingPaths };
    } catch (error) {
      return { success: false, sources: [], missingPaths: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('photoshop-status', async () => {
    const executable = await findLatestPhotoshop();
    return { available: Boolean(executable) };
  });
  return { componentTransactionReady };
};

module.exports = { copyComponentIntoStaging, awaitDurableCleanupRestart, componentTemporaryCleanupTargets, confirmComponentBackgroundStop, confirmComponentPackageInstall, createComponentInstallAdmission, createDurableCleanupAdmission, enterComponentInstallTransition, normalizeSdImportAutoMove, prepareSafeComponentInstallContainer, pythonToolResourcePaths, registerHostCapabilities, registerSystemIpc, resolvePythonWorkerResourceLease, savePrivacyConsentWithConfig, shouldTrackPythonToolAsBackgroundTask, snapshotComponentTrust, transitionComponentEnabled, validateComponentInstallRequest, validatePrivacyConsentRequest };
