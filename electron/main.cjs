const applicationLocalization = require('./services/localization.cjs');
const { app, BrowserWindow, WebContentsView, View, ipcMain: electronIpcMain, Menu, shell, dialog: nativeDialog, protocol, nativeImage, clipboard, screen, safeStorage, session, net: electronNet } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const dns = require('dns');
const nodeNet = require('net');
const { exiftool, exiftoolPath } = require('exiftool-vendored');
const { ThumbnailPipeline, THUMBNAIL_VERSION, PRIORITY, isThumbnailSizeSufficient } = require('./thumbnail-pipeline.cjs');
const { createComponentRegistry } = require('./component-registry.cjs'); const { createComponentHostRegistry } = require('./component-host-contract.cjs');
const { ComponentViewManager } = require('./services/component-view-manager.cjs'); const { createComponentHostCapabilityRuntime } = require('./services/component-host-capability-runtime.cjs');
const { createComponentContentBinding } = require('./services/component-content-binding.cjs');
const { createApplicationWindowRuntime } = require('./services/application-window-runtime.cjs');
const { ComponentServiceManager } = require('./services/component-service-manager.cjs'); const { createConfigMutationService, readConfigFileWithRecovery, registerConfigDrainBeforeQuit } = require('./services/config-mutation-service.cjs');
const { createWorkspaceStorageKeyService } = require('./services/workspace-storage-key-service.cjs');
const { createComponentRpcIpcProxy } = require('./component-rpc-contract.cjs');
const { registerComponentHostIpc } = require('./modules/component-host-ipc.cjs');
const { registerComponentIconProtocol } = require('./modules/component-icon-protocol.cjs');
const { PLUGIN_DEFINITIONS } = require('./plugins/plugin-catalog.cjs');
const { registerBrollImportIpc } = require('./modules/broll-import.cjs');
const { registerSystemIpc } = require('./modules/system-ipc.cjs');
const { registerWorkspaceIpc } = require('./modules/workspace-ipc.cjs');
const { registerFileOperationsIpc } = require('./modules/files-ipc.cjs');
const { registerMediaIpc } = require('./modules/media-ipc.cjs');
const { registerMediaRatingIpc } = require('./modules/media-rating-ipc.cjs');
const { registerVersionIpc } = require('./modules/versions-ipc.cjs');
const { registerSelectionIpc } = require('./modules/selection-ipc.cjs');
const { registerVideoPlaybackIpc } = require('./modules/video-playback-ipc.cjs');
const { registerBackupIpc } = require('./modules/backup-ipc.cjs');
const { registerArchiveIpc } = require('./modules/archive-ipc.cjs');
const { registerStorageUsageIpc } = require('./modules/storage-usage-ipc.cjs');
const { createRecycleBinService } = require('./services/recycle-bin-service.cjs');
const { createFileClipboardService } = require('./services/file-clipboard-service.cjs');
const { createFilePublicationService } = require('./services/file-publication-service.cjs');
const { createShellNewService } = require('./services/shell-new-service.cjs');
const { createMediaAccessService } = require('./services/media-access-service.cjs');
const { createMediaFileResponse } = require('./services/media-response-service.cjs');
const { configureProtectedProjectFolderRegistry } = require('./services/protected-project-folder.cjs');
const { PythonDatabaseClient } = require('./repositories/database-client.cjs');
const { createVersionTreeDatabaseWorkers } = require('./repositories/version-tree-database-workers.cjs');
const { WorkspaceSqliteCoordinator } = require('./services/workspace-sqlite-coordinator.cjs');
const { createWorkspaceRepository } = require('./domains/workspace/public.cjs');
const { createOperationsRepository } = require('./domains/file-operations/public.cjs');
const { createMediaRepository } = require('./domains/media/public.cjs');
const { createEventBus } = require('./services/event-bus.cjs');
const { createDomainCommandJournal } = require('./services/domain-command-journal.cjs');
const { createDomainHealthService } = require('./services/domain-health-service.cjs');
const { createApplicationQuitUi } = require('./services/application-quit-ui.cjs');
const { createBackgroundTaskService } = require('./services/background-task-service.cjs');
const { createProcessSupervisor } = require('./services/process-supervisor.cjs');
const { ComponentLifecycleCoordinator } = require('./services/component-lifecycle-coordinator.cjs');
const { componentDataRoot } = require('./services/component-lifecycle-service.cjs');
const { runApplicationQuit, selectApplicationQuitTasks } = require('./services/application-quit-coordinator.cjs');
const { createBundledPythonRuntime } = require('./services/bundled-python-runtime.cjs');
const { createBackupService } = require('./services/backup-service.cjs');
const { createArchiveService } = require('./services/archive-service.cjs');
const { createCredentialService } = require('./services/credential-service.cjs');
const { createStorageUsageService } = require('./services/storage-usage-service.cjs');
const { loadOrCreateInstallationId, resolveMediaCacheNamespace } = require('./services/media-cache-namespace.cjs');
const { runElectronSmokeProbe } = require('./services/electron-smoke-probe.cjs');
const { createWorkspaceReconcileTask } = require('./services/workspace-reconcile-task.cjs');
const { createWorkspaceWatcherRuntime } = require('./services/workspace-watcher-runtime.cjs');
const { createMediaCacheRuntime } = require('./services/media-cache-runtime.cjs');
const { cleanupRetiredCaptureTimeCache } = require('./services/retired-cache-service.cjs');
const { createPluginService } = require('./services/plugin-service.cjs');
const { createWorkspaceService } = require('./domains/workspace/public.cjs');
const { createFileSystemService } = require('./services/file-system-service.cjs');
const { createThumbnailService } = require('./services/thumbnail-service.cjs');
const { createMediaService } = require('./services/media-service.cjs');
const { parsePythonJsonMessages } = require('./services/python-json-protocol.cjs');
const { createMediaRatingService } = require('./services/media-rating-service.cjs');
const { createRawOrientationService } = require('./services/raw-orientation-service.cjs');
const { createImageThumbnailRuntime } = require('./services/image-thumbnail-runtime.cjs');
const { createVersionService } = require('./domains/versioning/public.cjs');
const { createVersionStaleDetectionService } = require('./services/version-stale-detection-service.cjs');
const { createMediaTrackingScanScheduler } = require('./services/media-tracking-scan-scheduler.cjs');
const { createSelectionService } = require('./services/selection-service.cjs');
const { createTelemetryService } = require('./services/telemetry-service.cjs');
const { createPrivacyService } = require('./privacy-service.cjs');
const { createFileRootWatcherService } = require('./services/file-root-watcher-service.cjs');
const { describeActionableWatchChanges, forgetMissingWatchChanges, recordActionableWatchEntry } = require('./services/watch-change-filter.cjs');
const { createProjectVirtualPathService } = require('./services/project-virtual-path-service.cjs');
const { isInternalWorkspacePath } = require('./infrastructure/internal-workspace-path.cjs');
const cloudConfig = require('./cloud-config.cjs');
const { registerBackgroundTasksIpc } = require('./modules/background-tasks-ipc.cjs');
const { createElectronSecurity, normalizeDevelopmentRendererUrl, normalizeExternalUrl } = require('./security-policy.cjs');
const smokeTestEnabled = process.env.PHOTOFLOW_SMOKE_TEST === '1';
const smokeUserDataPath = String(process.env.PHOTOFLOW_USER_DATA_DIR || '').trim(); const smokeSessionDataPath = String(process.env.PHOTOFLOW_SMOKE_SESSION_DATA_DIR || '').trim();
const developmentUserDataPath = String(process.env.PHOTOFLOW_DEV_USER_DATA_DIR || '').trim();
const developmentSessionDataPath = String(process.env.PHOTOFLOW_DEV_SESSION_DATA_DIR || '').trim();
if (smokeTestEnabled) {
  // Headless/CI Windows sessions may be unable to initialize Electron's GPU
  // child even when Chromium receives --disable-gpu. Disable acceleration at
  // the Electron application layer as well; production startup is unchanged.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  if (!smokeUserDataPath || !path.isAbsolute(smokeUserDataPath) || !smokeSessionDataPath || !path.isAbsolute(smokeSessionDataPath)) throw new Error('smoke userData/sessionData paths must be absolute');
  app.setPath('userData', path.resolve(smokeUserDataPath));
  app.setPath('sessionData', path.resolve(smokeSessionDataPath));
} else if (process.env.NODE_ENV === 'development' && developmentUserDataPath) {
  if (!path.isAbsolute(developmentUserDataPath)) throw new Error('development userData path must be absolute');
  app.setPath('userData', path.resolve(developmentUserDataPath));
  if (developmentSessionDataPath) {
    if (!path.isAbsolute(developmentSessionDataPath)) throw new Error('development sessionData path must be absolute');
    app.setPath('sessionData', path.resolve(developmentSessionDataPath));
  }
} else {
  // Keep user-facing OS labels localized while runtime data stays in a stable,
  // Latin-only directory name.
  app.setPath('userData', path.join(app.getPath('appData'), 'QingStudio-OpenSource'));
}
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'DirectCompositionVideoOverlays');
app.setName('照片流开源版');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
const projectVirtualPaths = createProjectVirtualPathService();
const projectRoot = path.join(__dirname, '..');
const privacyService = createPrivacyService({ app, fs, path, shell, projectRoot });
const userComponentRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'PhotoFlow', 'components')
  : path.join(app.getPath('userData'), 'components');
const componentRegistry = createComponentRegistry({
  projectRoot,
  userComponentRoot,
  isPackaged: app.isPackaged,
});
const componentHostRegistry = createComponentHostRegistry({
  roots: componentRegistry.roots,
  candidateProvider: componentRegistry.hostCandidates,
  admitDescriptor: componentRegistry.admitHostDescriptor,
});
configureProtectedProjectFolderRegistry({ descriptorProvider: componentHostRegistry.list, descriptorRevisionProvider: componentRegistry.hostPolicyRevision });
let componentViewManager; let componentServiceManager; let configMutationService; let toastViewManager;
let componentCapabilityBroker; let abortComponentNetworkRequests;
let getApplicationQuitState = () => 'idle';
const destroyToastViewManager = () => { const manager = toastViewManager; toastViewManager = null; manager?.destroy(); };
const suspendToastViewForNativeDrag = () => (currentApplicationHost()?.toast || toastViewManager)?.suspendForNativeDrag();
const resumeToastViewAfterNativeDrag = () => (currentApplicationHost()?.toast || toastViewManager)?.resumeAfterNativeDrag();

protocol.registerSchemesAsPrivileged([
  { scheme: 'photoflow-player', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'photoflow-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: 'photoflow-component', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
let mediaAccessService;
const toMediaUrl = (filePath, fresh = false) => `photoflow-media://file/${mediaAccessService.grantPath(filePath)}${fresh ? `?request=${crypto.randomUUID()}` : ''}`;

let cachedPhotoshopPath;
let photoshopDiscoveryPromise = null;
const queryPhotoshopRegistry = () => new Promise(resolve => {
  const child = spawn('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe', '/ve'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => { output = (output + data).slice(-16000); });
  child.on('error', () => resolve(''));
  child.on('close', code => resolve(code === 0 ? output : ''));
});

const findLatestPhotoshop = () => {
  if (cachedPhotoshopPath !== undefined) return Promise.resolve(cachedPhotoshopPath);
  if (photoshopDiscoveryPromise) return photoshopDiscoveryPromise;
  photoshopDiscoveryPromise = (async () => {
    if (process.platform !== 'win32') {
      cachedPhotoshopPath = null;
      return cachedPhotoshopPath;
    }

    const candidates = [];
    const addCandidate = (executable, version = []) => {
      if (executable && fs.existsSync(executable)) candidates.push({ executable, version });
    };
    for (const root of [...new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean))]) {
      const adobeRoot = path.join(root, 'Adobe');
      if (!fs.existsSync(adobeRoot)) continue;
      for (const entry of await fs.promises.readdir(adobeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^Adobe Photoshop\b/i.test(entry.name) || /beta/i.test(entry.name)) continue;
        const version = (entry.name.match(/\d+(?:\.\d+)*/g) || []).flatMap(value => value.split('.').map(Number));
        addCandidate(path.join(adobeRoot, entry.name, 'Photoshop.exe'), version);
      }
    }

    if (!candidates.length) {
      const registryOutput = await queryPhotoshopRegistry();
      const match = registryOutput.match(/REG_SZ\s+(.+Photoshop\.exe)\s*$/im);
      if (match) addCandidate(match[1].trim());
    }

    candidates.sort((left, right) => {
      const length = Math.max(left.version.length, right.version.length);
      for (let index = 0; index < length; index += 1) {
        const difference = (right.version[index] || 0) - (left.version[index] || 0);
        if (difference) return difference;
      }
      return right.executable.localeCompare(left.executable, undefined, { numeric: true });
    });
    cachedPhotoshopPath = candidates[0]?.executable || null;
    return cachedPhotoshopPath;
  })().finally(() => { photoshopDiscoveryPromise = null; });
  return photoshopDiscoveryPromise;
};

let mainWindow;
let workspaceWindows;
let loadMainWindowRenderer;

const { createApplicationDialog, currentApplicationHost, sendToApplicationRenderers } = require('./services/application-windows.cjs');

const dialog = createApplicationDialog(nativeDialog);
let telemetryService;
const fileOperationState = { projectFileClipboard: null };
const activeProjectFileOperations = new Map();
const mediaMetadataCache = new Map();
const approvedMediaCacheDirectories = new Set([path.resolve(path.join(app.getPath('userData'), 'media-cache'))]);
const renameHistory = [];
const MAX_UNDO_HISTORY = 50;
const discardUndoOperation = operation => {
  if (!['trash', 'import-with-sources', 'paste-replace'].includes(operation?.kind)) return;
  const removedRoots = new Set();
  for (const item of operation.items || []) {
    if (item.backupRoot && !removedRoots.has(item.backupRoot)) {
      removedRoots.add(item.backupRoot);
      void fs.promises.rm(item.backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};
const pushUndoOperation = async operation => {
  const stored = { ...await addUndoIdentities(operation), undoToken: operation.undoToken || crypto.randomUUID() };
  renameHistory.push(stored);
  // Keep undo data bounded. Entries that fall off the stack intentionally
  // become permanent, matching the behaviour of standard file managers.
  if (renameHistory.length > MAX_UNDO_HISTORY) discardUndoOperation(renameHistory.shift());
  return stored;
};
const removeUndoOperation = undoToken => {
  const index = renameHistory.findIndex(operation => operation.undoToken === undoToken);
  if (index < 0) return false;
  const [removed] = renameHistory.splice(index, 1);
  discardUndoOperation(removed);
  return true;
};
const workspaceCatalogs = new Map();
let shellThumbnailProcess = null;
let shellThumbnailManagedProcess = null;
let shellThumbnailStopPromise = null;
let shellThumbnailOutput = '';
let shellThumbnailRequestId = 0;
let shellThumbnailWorkChain = Promise.resolve();
const shellThumbnailRequests = new Map();
let shellThumbnailUnavailableLogged = false;
let thumbnailPipeline = null;
let thumbnailService = null;
let fileRootWatcherService = null;
let mediaService = null;
let videoPlaybackService = null;
const mediaRuntimeState = {
  activeMediaCacheConfig: { maxSizeGB: 50, directory: '' },
};
const normalizeMediaCacheSizeGB = (value, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};
let mediaTrackingScanScheduler = null;
const isInternalWorkspaceChange = isInternalWorkspacePath;
const nativeConsoleLog = console.log.bind(console);
const nativeConsoleError = console.error.bind(console);
const processSupervisor = createProcessSupervisor({
  writeLog: (...args) => writeLog(...args),
  windowsJobByDefault: true,
  windowsJobOptions: { packaged: app.isPackaged, resourcesPath: process.resourcesPath },
});
const componentLifecycleCoordinator = new ComponentLifecycleCoordinator({ blocker: componentId => processSupervisor.hasUnconfirmedOwner(componentId) });
processSupervisor.lifecycleCoordinator = componentLifecycleCoordinator;
const workspaceSqliteCoordinator = new WorkspaceSqliteCoordinator();

const recycleBinService = createRecycleBinService({ app, shell, projectRoot, processSupervisor, persistentOperations: true });
const fileClipboardService = createFileClipboardService({ app, projectRoot, processSupervisor });
const filePublicationService = createFilePublicationService({ app, projectRoot, processSupervisor, persistentRename: true, persistentOperations: true });
const shellNewService = createShellNewService({
  app, processSupervisor,
  publishNoClobber: (source, destination) => publishPathNoClobber(source, destination),
  onUpdated: types => { if (mainWindow && !mainWindow.isDestroyed()) sendToApplicationRenderers(mainWindow, 'shell-new-types-changed', types); },
  onError: error => writeLog('warn', 'Unable to refresh Windows new-file types', { error: error.message }),
});
const fileSystemService = createFileSystemService({
  recycleBinService,
  shortcutAdapter: {
    platform: process.platform,
    writeShortcutLink: (shortcutPath, details) => shell.writeShortcutLink(shortcutPath, details),
  },
});
const {
  assertExistingInside,
  assertInside,
  assertDiskSpace,
  assertRegularFile,
  CANCELLED_CODE,
  canUseNativeFastCut,
  collectCopyPlan,
  copyFileAtomic,
  copyPlannedFiles,
  moveFileAtomic,
  movePlannedFilesFast,
  movePathAtomic,
  publishPathNoClobber,
  configureNativePublicationService,
  removeCopiedSources,
  removeCreatedPasteTargets,
  throwIfCancelled,
  uniqueDestination,
  capturePathIdentity,
  addUndoIdentities,
  assertUndoIdentity,
  samePathIdentity,
} = fileSystemService;
configureNativePublicationService(filePublicationService);
const eventBus = createEventBus();
mediaAccessService = createMediaAccessService({
  getWorkspaceRoots: () => [...workspaceCatalogs.keys()],
  getAdditionalRoots: () => [
    mediaRuntimeState.activeMediaCacheConfig.directory && approvedMediaCacheDirectories.has(path.resolve(mediaRuntimeState.activeMediaCacheConfig.directory))
      ? resolveMediaCacheDir(mediaRuntimeState.activeMediaCacheConfig) : '',
    path.join(app.getPath('userData'), 'media-cache'),
    path.join(app.getPath('userData'), 'workspace-data'),
  ],
});
const pathExists = async candidate => fs.promises.access(candidate).then(() => true, () => false);

// Persist operational logs outside of the installation directory so they are
// available after an app restart or a packaged-app update.
const getLogDir = () => {
  const logDir = path.join(getConfigDir(), 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  return logDir;
};

const LOG_RETENTION_DAYS = 7;
const cleanupExpiredLogs = async () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const markerPath = path.join(getLogDir(), '.last-cleanup-date');
  if ((await fs.promises.readFile(markerPath, 'utf8').catch(() => '')).trim() === today) return 0;
  const expiresBefore = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    for (const fileName of await fs.promises.readdir(getLogDir())) {
      // Only remove files created by this logger; never touch user files.
      if (!/^photoflow-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) continue;

      const filePath = path.join(getLogDir(), fileName);
      if ((await fs.promises.stat(filePath)).mtimeMs < expiresBefore) {
        await fs.promises.unlink(filePath);
        deletedCount += 1;
      }
    }
    await fs.promises.writeFile(markerPath, today, 'utf8');
  } catch (error) {
    nativeConsoleError('Failed to clean up expired application logs:', error);
  }

  return deletedCount;
};
const formatLogValue = (value) => {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const writeLog = (level, message, details) => {
  const timestamp = new Date().toISOString();
  const suffix = details === undefined ? '' : ` ${formatLogValue(details)}`;
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}\n`;
  const consoleMethod = level === 'error' ? nativeConsoleError : nativeConsoleLog;
  consoleMethod(line.trim());

  try {
    const date = timestamp.slice(0, 10);
    fs.appendFileSync(path.join(getLogDir(), `photoflow-${date}.log`), line, 'utf8');
  } catch (error) {
    nativeConsoleError('Failed to write application log:', error);
  }
};
const backgroundTasks = createBackgroundTaskService({
  eventBus,
  writeLog,
  persistencePath: path.join(app.getPath('userData'), 'background-tasks.json'),
});
eventBus.on('background-task:persistence-error', details => writeLog('error', 'Background task persistence failed', details));
const domainCommandJournal = createDomainCommandJournal({
  filePath: path.join(app.getPath('userData'), 'domain-command-journal.json'),
  writeLog,
});
const domainHealthService = createDomainHealthService();
const databaseHealthOptions = domainId => ({
  domainId,
  onHealthChange: state => {
    domainHealthService.update(domainId, state);
    if (state.state !== 'healthy') writeLog(state.state === 'unavailable' ? 'error' : 'warn', 'Domain health changed', state);
  },
});

const rendererEntryFile = path.join(__dirname, '../artifacts/web/index.html');
const toastViewRendererFile = path.join(__dirname, '../artifacts/web/toast-view.html');
const isDevelopmentRenderer = () => process.env.NODE_ENV === 'development';
const developmentRendererUrl = isDevelopmentRenderer() ? normalizeDevelopmentRendererUrl(process.env.PHOTOFLOW_DEV_SERVER_URL) : '';
const { configureWindowSecurity, ipcMain, openAllowedExternalUrl } = createElectronSecurity({
  electronIpcMain, getMainWindow: () => mainWindow, isDevelopment: isDevelopmentRenderer,
  rendererFile: rendererEntryFile, developmentRendererUrl, shell, writeLog,
});
const getShellThumbnailExecutable = () => app.isPackaged
  ? path.join(process.resourcesPath, 'shell-thumbnail.exe')
  : path.join(__dirname, 'bin', 'shell-thumbnail.exe');

const finishShellThumbnailRequests = () => {
  for (const request of shellThumbnailRequests.values()) {
    clearTimeout(request.timer);
    request.resolve(false);
  }
  shellThumbnailRequests.clear();
};

const stopShellThumbnailProcess = () => {
  const child = shellThumbnailProcess;
  finishShellThumbnailRequests();
  if (shellThumbnailStopPromise) return shellThumbnailStopPromise;
  if (shellThumbnailManagedProcess) {
    const managedProcess = shellThumbnailManagedProcess;
    let stopOperation;
    try { stopOperation = managedProcess.stop('shell-thumbnail-stop'); }
    catch (error) { stopOperation = Promise.reject(error); }
    const completion = Promise.resolve(stopOperation)
      .catch(error => {
        writeLog('warn', 'Windows Shell thumbnail cache helper failed to stop cleanly', { error: error.message || String(error) });
        try { if (child && !child.killed) child.kill(); } catch { /* the supervisor retains ownership after a failed stop */ }
      })
      .finally(() => {
        if (shellThumbnailProcess === child) shellThumbnailProcess = null;
        shellThumbnailOutput = '';
        if (managedProcess.released && shellThumbnailManagedProcess === managedProcess) shellThumbnailManagedProcess = null;
        if (shellThumbnailStopPromise === completion) shellThumbnailStopPromise = null;
      });
    shellThumbnailStopPromise = completion;
    return completion;
  }
  shellThumbnailProcess = null;
  shellThumbnailOutput = '';
  if (child && !child.killed) child.kill();
  return Promise.resolve();
};

const attachShellThumbnailProcess = (child, managedProcess = null) => {
  shellThumbnailProcess = child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    shellThumbnailOutput += data;
    const lines = shellThumbnailOutput.split(/\r?\n/);
    shellThumbnailOutput = lines.pop() || '';
    for (const rawLine of lines) {
      const fields = rawLine.replace(/^\uFEFF/, '').split('\t');
      const request = shellThumbnailRequests.get(fields[0]);
      if (!request) continue;
      managedProcess?.markHealthy({ protocol: 'tab-lines' });
      shellThumbnailRequests.delete(fields[0]);
      clearTimeout(request.timer);
      let accepted = fields[1] === '1' && fs.existsSync(request.targetPath);
      if (accepted) {
        const thumbnail = nativeImage.createFromPath(request.targetPath);
        const size = thumbnail.isEmpty() ? { width: 0, height: 0 } : thumbnail.getSize();
        accepted = isThumbnailSizeSufficient(size.width, size.height, request.requestedSize);
        if (!accepted) {
          try { fs.unlinkSync(request.targetPath); } catch { /* the decoder fallback will recreate it */ }
          writeLog('warn', 'Rejected undersized Windows Shell thumbnail', {
            requestedSize: request.requestedSize,
            actualWidth: size.width,
            actualHeight: size.height,
            sourcePath: request.sourcePath,
          });
        }
      }
      request.resolve(accepted);
    }
  });
  child.on('error', error => {
    writeLog('warn', 'Windows Shell thumbnail cache helper failed to start', { error: error.message || String(error) });
  });
  child.on('exit', (code, signal) => {
    if (shellThumbnailProcess === child) shellThumbnailProcess = null;
    shellThumbnailOutput = '';
    finishShellThumbnailRequests();
    if (code && code !== 0) writeLog('warn', 'Windows Shell thumbnail cache helper exited', { code, signal });
  });
  return child;
};

const ensureShellThumbnailProcess = async () => {
  if (process.platform !== 'win32') return null;
  if (shellThumbnailStopPromise) await shellThumbnailStopPromise;
  if (shellThumbnailProcess && !shellThumbnailProcess.killed) return shellThumbnailProcess;
  if (shellThumbnailManagedProcess && !shellThumbnailManagedProcess.released) {
    if (shellThumbnailManagedProcess.state === 'stopping') return null;
    const child = shellThumbnailManagedProcess.start();
    return child && !child.killed ? child : null;
  }
  const executable = getShellThumbnailExecutable();
  if (!fs.existsSync(executable)) {
    if (!shellThumbnailUnavailableLogged) {
      shellThumbnailUnavailableLogged = true;
      writeLog('warn', 'Windows Shell thumbnail cache helper is unavailable', { executable });
    }
    return null;
  }

  shellThumbnailManagedProcess = processSupervisor.launch({
    id: 'csharp:shell-thumbnail',
    kind: 'csharp-helper',
    command: executable,
    args: [],
    options: { stdio: ['pipe', 'pipe', 'ignore'] },
    restart: { enabled: true, maxRestarts: 3, windowMs: 60000, backoffMs: [100, 400, 1200] },
    onSpawn: attachShellThumbnailProcess,
  });
  return shellThumbnailManagedProcess.child;
};

// Query Explorer's cache first, then optionally ask the installed provider to
// extract in the isolated helper process. Provider work never blocks Electron.
const copyWindowsShellThumbnailNow = async (sourcePath, targetPath, requestedSize, cacheOnly = true) => {
  const child = await ensureShellThumbnailProcess();
  if (!child?.stdin?.writable) return false;
  return new Promise(resolve => {
    const requestId = String(++shellThumbnailRequestId);
    const timer = setTimeout(() => {
      shellThumbnailRequests.delete(requestId);
      resolve(false);
      // A cache-only lookup should finish almost immediately. Restart the helper
      // if a cloud/offline Shell provider stalls so later thumbnails are not
      // trapped behind the same blocked COM request. The stop promise fences the
      // next request until this managed process has fully released its ID.
      if (shellThumbnailProcess === child) void stopShellThumbnailProcess();
    }, cacheOnly ? 1500 : 10000);
    shellThumbnailRequests.set(requestId, { resolve, timer, targetPath, requestedSize, sourcePath });
    const encode = value => Buffer.from(value, 'utf8').toString('base64');
    child.stdin.write(`${requestId}\t${requestedSize}\t${encode(sourcePath)}\t${encode(targetPath)}\t${cacheOnly ? 'cache' : 'generate'}\n`, error => {
      if (!error) return;
      const request = shellThumbnailRequests.get(requestId);
      if (!request) return;
      shellThumbnailRequests.delete(requestId);
      clearTimeout(request.timer);
      request.resolve(false);
    });
  });
};

const copyWindowsShellThumbnail = (sourcePath, targetPath, requestedSize, cacheOnly = true) => {
  // The COM helper is single-threaded. Serialize callers here so later requests
  // do not time out while an earlier provider is still decoding a large video.
  const job = shellThumbnailWorkChain
    .then(() => copyWindowsShellThumbnailNow(sourcePath, targetPath, requestedSize, cacheOnly))
    .catch(error => {
      writeLog('warn', 'Windows Shell thumbnail request failed; using decoder fallback', { error: error.message || String(error) });
      return false;
    });
  shellThumbnailWorkChain = job;
  return job;
};

// Mirror existing main-process console output to the persistent log without
// requiring every call site to be rewritten.
console.log = (...values) => writeLog('info', values.map(formatLogValue).join(' '));
console.warn = (...values) => writeLog('warn', values.map(formatLogValue).join(' '));
console.error = (...values) => writeLog('error', values.map(formatLogValue).join(' '));

function createWindow(loadRenderer = true) {
  destroyToastViewManager();
  ({ mainWindow, workspaceWindows, toastViewManager, loadMainWindowRenderer } = createApplicationWindowRuntime({
    app, BrowserWindow, WebContentsView, View, Menu, screen, ipcMain, electronIpcMain, electronDirectory: __dirname,
    rendererEntryFile, toastViewRendererFile, developmentRendererUrl, smokeTestEnabled, configureWindowSecurity, isDevelopmentRenderer,
    getQuitState: () => getApplicationQuitState(), getComponentViewManager: () => componentViewManager,
    getVideoPlaybackService: () => videoPlaybackService, getTelemetryService: () => telemetryService, writeLog,
  }));
  if (loadRenderer) loadMainWindowRenderer();
}

let pluginService;
const bundledPythonRuntime = createBundledPythonRuntime({
  app,
  projectRoot,
  processSupervisor,
  getPluginService: () => pluginService,
});
const { getRunConfig, runJsonCommand, runPythonEventAction, runPythonJsonAction } = bundledPythonRuntime;

pluginService = createPluginService({ app, registry: componentRegistry, runJsonCommand, processSupervisor });

const extractVideoTimelineFrames = async (filePath, times) => {
  const operationId = crypto.randomUUID();
  const requestRoot = path.join(app.getPath('temp'), 'photoflow', 'video-playback-timeline', operationId);
  const requestPath = path.join(requestRoot, 'request.json');
  const outputDirectory = path.join(requestRoot, 'frames');
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  await fs.promises.writeFile(requestPath, JSON.stringify({ filePath: path.resolve(filePath), times, outputDirectory }), 'utf8');
  try {
    const result = await pluginService.runJsonForCapability('media.video.timeline-frames', [requestPath], 2 * 60 * 1000);
    if (!result?.success || !Array.isArray(result.frames)) throw new Error(result?.error || '播放器组件未返回时间线帧');
    return result.frames;
  } finally {
    await fs.promises.rm(requestRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

const checkForUpdates = async () => {
  if (!mainWindow) return { success: false, error: '主窗口尚未就绪' };
  try {
    if (!cloudConfig.apiBaseUrl) return { success: false, error: '未配置腾讯云更新服务' };
    const currentVersion = app.getVersion();
    const query = new URLSearchParams({
      platform: process.platform,
      arch: process.arch,
      channel: cloudConfig.updateChannel || 'stable',
      currentVersion,
    });
    const response = await fetch(`${cloudConfig.apiBaseUrl.replace(/\/+$/, '')}/v1/updates?${query}`);
    if (!response.ok) throw new Error(`更新服务返回 ${response.status}`);
    const data = await response.json();
    const updateAvailable = data.updateAvailable === true;
    const downloadUrl = updateAvailable ? normalizeExternalUrl(data.downloadUrl) : '';
    if (updateAvailable && !downloadUrl) throw new Error('更新服务返回了不受信任的下载地址');
    const result = {
      success: true,
      updateAvailable,
      currentVersion,
      latestVersion: data.latestVersion,
      url: downloadUrl,
      notes: data.notes || '',
      sha256: data.sha256 || '',
      mandatory: data.mandatory === true,
    };
    telemetryService?.track('update_checked', { update_available: result.updateAvailable });
    if (result.updateAvailable) sendToApplicationRenderers(mainWindow, 'update-available', {
      version: result.latestVersion,
      url: result.url,
      notes: result.notes,
      mandatory: result.mandatory,
    });
    return result;
  } catch (error) {
    console.error('Update check failed:', error);
    return { success: false, error: error.message || String(error) };
  }
};

// 添加打开外部链接的 IPC 处理

// 运行 Python 脚本

const getConfigDir = () => {
  // Keep runtime data under an ASCII-only path. This also prevents legacy
  // command-line tools from corrupting cache paths on Chinese Windows.
  const configDir = app.getPath('userData');
  fs.mkdirSync(configDir, { recursive: true });
  return configDir;
};
const installationId = loadOrCreateInstallationId({ fs, path, crypto, userDataPath: getConfigDir() });

const getConfigPath = () => {
  return path.join(getConfigDir(), 'photoflow_config.json');
};

const readSavedConfig = () => {
  try {
    const config = readConfigFileWithRecovery(fs, getConfigPath());
    const hasCoreConsent = privacyService.hasCoreConsent();
    const initialExperienceConsent = privacyService.getState().experienceProgramGranted === true;
    const configuredTelemetry = config?.telemetry && typeof config.telemetry === 'object' ? config.telemetry : {};
    return {
      ...(config && typeof config === 'object' ? config : {}),
      telemetry: hasCoreConsent
        ? {
            enabled: typeof configuredTelemetry.enabled === 'boolean' ? configuredTelemetry.enabled : initialExperienceConsent,
            crashReports: typeof configuredTelemetry.crashReports === 'boolean' ? configuredTelemetry.crashReports : initialExperienceConsent,
          }
        : { enabled: false, crashReports: false },
    };
  } catch (error) {
    writeLog('warn', 'Unable to read saved configuration', { error: error.message || String(error) });
    return { telemetry: { enabled: false, crashReports: false } };
  }
};

// 生日数据管理

const getUserBirthdaysPath = () => {
  return path.join(getConfigDir(), 'birthdays.json');
};

// 获取系统盘符列表

const WORKSPACE_STATUSES = ['未分类', '策划中', '待拍摄', '后期中', '已归档'];

const workspaceStorageKeyService = createWorkspaceStorageKeyService({
  fs, path, crypto, databaseDir: path.join(app.getPath('userData'), 'workspace-data'), writeLog,
});
const getWorkspaceStorageKey = root => workspaceStorageKeyService.get(root);

const getWorkspaceDatabasePath = root => {
  const databaseDir = path.join(app.getPath('userData'), 'workspace-data');
  fs.mkdirSync(databaseDir, { recursive: true });
  const fileName = `${getWorkspaceStorageKey(root)}.sqlite3`;
  return path.join(databaseDir, fileName);
};

const getWorkspaceDataRoot = root => workspaceStorageKeyService.getDataRootForKey(getWorkspaceStorageKey(root));

const getWorkspaceOperationsDatabasePath = root => path.join(
  getWorkspaceDataRoot(root),
  'databases',
  'operations.sqlite3',
);

const getWorkspaceMediaDatabasePath = root => path.join(
  getWorkspaceDataRoot(root),
  'databases',
  'media.sqlite3',
);
const getWorkspaceVersioningDatabasePath = root => path.join(
  getWorkspaceDataRoot(root),
  'databases',
  'versioning.sqlite3',
);

const getTrackedVersionThumbnailPath = (workspaceRoot, photoId, versionId) => {
  const safeSegment = (value, label) => {
    const segment = String(value || '');
    if (!/^[a-z0-9_-]+$/i.test(segment)) throw new Error(`Invalid ${label}`);
    return segment;
  };
  return path.join(
    app.getPath('userData'),
    'workspace-data',
    getWorkspaceStorageKey(workspaceRoot),
    'thumbnails',
    safeSegment(photoId, 'photo ID'),
    `${safeSegment(versionId, 'version ID')}.jpg`,
  );
};

const workspaceDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:workspace-catalog',
  ...databaseHealthOptions('workspace'),
  // A one-time reconciliation can cascade through thousands of media rows
  // after a project folder disappears outside the app. Do not kill the worker
  // halfway through that recovery and leave the project list empty.
  defaultTimeoutMs: 2 * 60 * 1000,
});
const operationsDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceOperationsDatabasePath,
  writeLog,
  scriptName: 'operations_db.py',
  processSupervisor,
  processId: 'python:operations',
  ...databaseHealthOptions('file-operations'),
});
const operationsRepository = createOperationsRepository(operationsDatabase, getWorkspaceDatabasePath);
const workspaceRepository = createWorkspaceRepository(workspaceDatabase, operationsRepository);
// Run routine integrity checks and backups in an independent process so they
// cannot hold up interactive project-catalog requests.
const workspaceMaintenanceDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:workspace-maintenance',
  ...databaseHealthOptions('workspace-maintenance'),
  defaultTimeoutMs: 30 * 60 * 1000,
});
const workspaceMaintenanceRepository = createWorkspaceRepository(workspaceMaintenanceDatabase);
// Keep interactive media/version/team requests on their own worker.
const mediaDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:media-background',
  ...databaseHealthOptions('media-background'),
  defaultTimeoutMs: 30 * 60 * 1000,
});
// Keep small user-driven mutations away from the worker that also performs
// project synchronization and commit planning.  The Python server processes
// one request at a time, so a dedicated worker prevents clicks such as
// tracking/team confirmations from waiting behind an unrelated long request.
const mediaInteractionDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:media-interaction',
  ...databaseHealthOptions('media-interaction'),
  defaultTimeoutMs: 60 * 1000,
});
const mediaBackgroundRepository = createMediaRepository(mediaDatabase);
const mediaInteractionRepository = createMediaRepository(mediaInteractionDatabase);
// Isolate first-paint reads from slow filesystem reconciliation and mutations.
const { readDatabase: versionReadDatabase, locationDatabase: versionLocationDatabase, readRepository: versionReadRepository, locationRepository: versionLocationRepository } = createVersionTreeDatabaseWorkers({
  coordinator: workspaceSqliteCoordinator, getRunConfig, getDatabasePath: getWorkspaceDatabasePath,
  writeLog, processSupervisor, databaseHealthOptions,
});
const mediaRepository = {
  ...mediaBackgroundRepository,
  syncProject: (root, projectName, _externalRoots, options) => mediaBackgroundRepository.syncProject(root, projectName, [], options),
  syncChangedPaths: (root, projectName, changes, _externalRoots, options) => mediaBackgroundRepository.syncChangedPaths(root, projectName, changes, [], options),
  getPhoto: mediaInteractionRepository.getPhoto,
  createVersion: mediaInteractionRepository.createVersion,
  updateVersion: mediaInteractionRepository.updateVersion,
  listFinalVersions: mediaInteractionRepository.listFinalVersions,
  relocateVersion: mediaInteractionRepository.relocateVersion,
  deleteVersion: mediaInteractionRepository.deleteVersion,
  getVersionDeleteScope: mediaInteractionRepository.getVersionDeleteScope,
  deleteProjectMissingVersion: mediaInteractionRepository.deleteProjectMissingVersion,
  recordCompare: mediaInteractionRepository.recordCompare,
  listProgress: mediaInteractionRepository.listProgress,
  snapshotProgress: versionReadRepository.snapshotProgress,
  snapshotProgressLocations: versionLocationRepository.snapshotProgressLocations,
  registerProgress: mediaInteractionRepository.registerProgress,
  registerProgressWithGraph: mediaInteractionRepository.registerProgressWithGraph,
  adoptMediaFolder: mediaInteractionRepository.adoptMediaFolder,
  revertExternalAdoptions: mediaInteractionRepository.revertExternalAdoptions,
  updateProgressTree: mediaInteractionRepository.updateProgressTree,
  updateProgressRelation: mediaInteractionRepository.updateProgressRelation,
  repairLegacySelectionRelation: mediaInteractionRepository.repairLegacySelectionRelation,
  createVersionGraphEdge: mediaInteractionRepository.createVersionGraphEdge,
  deleteVersionGraphEdge: mediaInteractionRepository.deleteVersionGraphEdge,
  replaceVersionGraphEdgeSource: mediaInteractionRepository.replaceVersionGraphEdgeSource,
  getVersionTreeLayout: versionReadRepository.getVersionTreeLayout,
  saveVersionTreeLayout: mediaInteractionRepository.saveVersionTreeLayout,
  unregisterProgress: mediaInteractionRepository.unregisterProgress,
  deleteMissingProgress: mediaInteractionRepository.deleteMissingProgress,
  registerBatchBaseline: mediaInteractionRepository.registerBatchBaseline,
  commitBatchCompare: mediaInteractionRepository.commitBatchCompare,
  retryBatchOperations: mediaInteractionRepository.retryBatchOperations,
  listBatchOperations: mediaInteractionRepository.listBatchOperations,
  createTrackingSession: mediaInteractionRepository.createTrackingSession,
  prepareTracking: mediaInteractionRepository.prepareTracking,
  storeTrackingPreview: mediaInteractionRepository.storeTrackingPreview,
  getTrackingSession: mediaInteractionRepository.getTrackingSession,
  releaseTrackingSession: mediaInteractionRepository.releaseTrackingSession,
  decideTrackingItem: mediaInteractionRepository.decideTrackingItem,
  getTrackingCommitPlan: mediaInteractionRepository.getTrackingCommitPlan,
  getTrackingCommitResources: mediaInteractionRepository.getTrackingCommitResources,
  applyTrackingCopies: mediaInteractionRepository.applyTrackingCopies,
  completeTrackingCommit: mediaInteractionRepository.completeTrackingCommit,
  failTrackingCommit: mediaInteractionRepository.failTrackingCommit,
  getMainBranchMedia: mediaInteractionRepository.getMainBranchMedia,
};
const notifyVersionChange = change => sendToApplicationRenderers(mainWindow, 'workspace-versions-changed', change);
const versionService = createVersionService({ repository: mediaRepository, onChanged: notifyVersionChange });
let selectionService = null;
const versionStaleDetectionService = createVersionStaleDetectionService({ versionService, backgroundTasks, writeLog });
// Directory walks and deferred full-hash backfills can take minutes on large
// projects. Run scheduled scans on a separate worker so opening a component
// view never waits behind background media tracking work.
const mediaScanDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:media-scan',
  ...databaseHealthOptions('media-scan'),
  defaultTimeoutMs: 30 * 60 * 1000,
});
const mediaScanRepository = createMediaRepository(mediaScanDatabase);
const mediaScanService = createVersionService({ repository: {
  ...mediaScanRepository,
  syncProject: (root, projectName, _externalRoots, options) => mediaScanRepository.syncProject(root, projectName, [], options),
  syncChangedPaths: (root, projectName, changes, _externalRoots, options) => mediaScanRepository.syncChangedPaths(root, projectName, changes, [], options),
} });
// Version comparisons can run alongside a full media-index scan. Give them a
// separate database worker so the scheduler's read concurrency is real rather
// than two UI tasks queued inside one synchronous Python server process.
const trackingScanDatabase = new PythonDatabaseClient({
  coordinator: workspaceSqliteCoordinator,
  getRunConfig,
  getDatabasePath: getWorkspaceDatabasePath,
  writeLog,
  processSupervisor,
  processId: 'python:tracking-scan',
  ...databaseHealthOptions('versioning-scan'),
  defaultTimeoutMs: 30 * 60 * 1000,
});
const trackingScanRepository = createMediaRepository(trackingScanDatabase);
const trackingScanService = createVersionService({ repository: trackingScanRepository, onChanged: notifyVersionChange });
const workspaceService = createWorkspaceService({
  repository: workspaceRepository,
  reconcileRepository: workspaceMaintenanceRepository,
  catalogs: workspaceCatalogs,
  statuses: WORKSPACE_STATUSES,
  assertInside,
  assertExistingInside,
  getConfiguredInspirationRoot: () => readSavedConfig()?.inspirationLibrary?.rootPath || '',
});
const resolveWorkspaceRoot = workspaceService.resolveRoot;
const ensureWorkspace = workspaceService.ensureRoot;
const refreshWorkspaceCatalog = workspaceService.refreshCatalog;
const getReadyProjectPath = workspaceService.getReadyProjectPath;
const reconcileWorkspaceCatalogDirect = workspaceService.reconcileCatalog;
const mutateWorkspaceCatalog = workspaceService.mutateCatalog;
const getProjectPath = workspaceService.getProjectPath;
const isOrdinaryProjectRoot = projectRoot => {
  for (const [workspaceRoot, catalog] of workspaceCatalogs) for (const project of catalog.projects) {
    if (path.resolve(workspaceRoot, project.relative_path).toLowerCase() === path.resolve(projectRoot).toLowerCase()) {
      try { return JSON.parse(project.extra_json || '{}').ordinaryFiles === true; } catch { return false; }
    }
  }
  return false;
};
const cleanProjectName = workspaceService.cleanProjectName;

const stopFileRootWatchers = () => {
  fileRootWatcherService?.stop();
};

const acquireFileRootWatcher = (rootPath, options) => fileRootWatcherService?.acquire(rootPath, options)
  || { success: false, root: path.resolve(rootPath), error: '文件根目录监听服务尚未初始化' };

const releaseFileRootWatcher = (rootPath, options) => fileRootWatcherService?.release(rootPath, options);
const suspendFileRootWatcher = rootPath => fileRootWatcherService?.suspend(rootPath) || 0;
const resumeFileRootWatcher = (rootPath, references) => fileRootWatcherService?.resume(rootPath, references)
  || { success: false, root: path.resolve(rootPath), error: '文件根目录监听服务尚未初始化' };

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif']);
const IMAGE_PREVIEW_CONVERSION_EXTENSIONS = new Set(['.tif', '.tiff', '.heic', '.heif', '.hif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.mpeg', '.mpg', '.mts', '.m2ts', '.crm']);
const RAW_EXTENSIONS = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']);
const HIDDEN_SYSTEM_ENTRY_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store', '.photoflow-workspace-id']);
const mediaCacheRuntime = createMediaCacheRuntime({
  fs, path, crypto, platform: process.platform, resolveMediaCacheNamespace, userDataPath: getConfigDir(), installationId,
  approvedDirectories: approvedMediaCacheDirectories, normalizeCacheSizeGB: normalizeMediaCacheSizeGB,
  trackedVersionThumbnailPath: getTrackedVersionThumbnailPath, versionService, mediaRuntimeState,
  imageExtensions: IMAGE_EXTENSIONS, rawExtensions: RAW_EXTENSIONS, videoExtensions: VIDEO_EXTENSIONS,
  thumbnailVersion: THUMBNAIL_VERSION, defaultPriority: PRIORITY.nearby, writeLog,
});
const {
  indexes: mediaCacheIndexes, resolveMediaCacheDir, getMediaCacheDir, refreshMediaCacheIndex, trimMediaCache,
  rawPreviewPath, convertedImagePreviewPath, mediaThumbnailCacheFile, ensureTrackedVersionThumbnail,
  handleThumbnailUpdate,
} = mediaCacheRuntime;
const workspaceWatcherRuntime = createWorkspaceWatcherRuntime({
  fs, path, platform: process.platform, backgroundTasks, catalogs: workspaceCatalogs,
  reconcileCatalogDirect: reconcileWorkspaceCatalogDirect, getMainWindow: () => mainWindow,
  getThumbnailService: () => thumbnailService, getFileRootWatcherService: () => fileRootWatcherService,
  getMediaCacheConfig: () => mediaRuntimeState.activeMediaCacheConfig,
  getMediaTrackingScanScheduler: () => mediaTrackingScanScheduler, versionStaleDetectionService,
  isInternalChange: isInternalWorkspaceChange, describeActionableChanges: describeActionableWatchChanges,
  forgetMissingChanges: forgetMissingWatchChanges, recordActionableEntry: recordActionableWatchEntry,
  createReconcileTask: createWorkspaceReconcileTask, writeLog,
});
const {
  watch: watchWorkspace, stop: stopWorkspaceWatcher, reconcileWorkspaceState, reconcileWorkspaceCatalog,
  scheduleMediaTrackingScan, cancelMediaTrackingScan, suppressWorkspaceWatchPath, releaseWorkspaceWatchPath,
  isSuppressedWorkspaceChange,
} = workspaceWatcherRuntime;
const mediaRatingService = createMediaRatingService({
  exiftool, fs, path, imageExtensions: IMAGE_EXTENSIONS, rawExtensions: RAW_EXTENSIONS,
  releaseWorkspaceWatchPath, suppressWorkspaceWatchPath, versionService,
  getRegisteredProjectRoots: async root => (await refreshWorkspaceCatalog(root)).projects.flatMap(project => {
    try { return [getProjectPath(root, project.status, project.name)]; } catch { return []; }
  }), writeLog,
  pendingRatingsPath: path.join(app.getPath('userData'), 'pending-media-ratings.json'),
  onInvalidate: filePath => {
    const prefix = `${path.resolve(filePath)}|`;
    for (const key of mediaMetadataCache.keys()) if (key.startsWith(prefix)) mediaMetadataCache.delete(key);
  },
});
selectionService = createSelectionService({
  fs, crypto, copyFileAtomic, versionService, projectVirtualPaths,
  imageExtensions: IMAGE_EXTENSIONS, rawExtensions: RAW_EXTENSIONS, videoExtensions: VIDEO_EXTENSIONS,
});
mediaTrackingScanScheduler = createMediaTrackingScanScheduler({
  backgroundTasks,
  mediaScanService,
  versionStaleDetectionService,
  getProject: (root, projectName) => workspaceCatalogs.get(root)?.byName.get(String(projectName || '').toLocaleLowerCase()),
  onThumbnailCandidate: candidate => { void ensureTrackedVersionThumbnail(candidate); },
  thumbnailPriority: PRIORITY.project,
  writeLog,
});

const rawOrientationCorrection = createRawOrientationService({ exiftool }).correction;
const imageThumbnailRuntime = createImageThumbnailRuntime({
  crypto, fs, nativeImage, spawn, processSupervisor, getRunConfig, runPythonJsonAction,
  getMediaCacheDir, mediaThumbnailCacheFile, copyWindowsShellThumbnail,
  thumbnailVersion: THUMBNAIL_VERSION,
});

thumbnailPipeline = new ThumbnailPipeline({
  getRunConfig,
  processSupervisor,
  databasePath: path.join(getConfigDir(), 'thumbnail-index.sqlite3'),
  getCacheDir: getMediaCacheDir,
  resolveCacheDir: resolveMediaCacheDir,
  cacheFilePath: mediaThumbnailCacheFile,
  generateThumbnailSet: imageThumbnailRuntime.generateThumbnailSet,
  toPreviewUrl: toMediaUrl,
  trimCache: trimMediaCache,
  notify: update => {
    handleThumbnailUpdate(update);
    if (mainWindow && !mainWindow.isDestroyed()) sendToApplicationRenderers(mainWindow, 'thumbnail-state-changed', update);
  },
  log: writeLog,
  concurrency: Math.max(2, Math.min(4, Math.floor((os.availableParallelism?.() || os.cpus().length || 4) / 4))),
  maxBackgroundTasks: 1000,
});
thumbnailService = createThumbnailService({ pipeline: thumbnailPipeline, backgroundTasks, writeLog });
mediaCacheRuntime.attach({ thumbnailService, imageThumbnailRuntime });
fileRootWatcherService = createFileRootWatcherService({
  getMainWindow: () => mainWindow,
  getThumbnailService: () => thumbnailService,
  getMediaCacheConfig: () => mediaRuntimeState.activeMediaCacheConfig,
  isInternalChange: isInternalWorkspaceChange,
  isSuppressedChange: isSuppressedWorkspaceChange,
  writeLog,
});
mediaService = createMediaService({ accessService: mediaAccessService, thumbnailService, toMediaUrl });

const findImportedVideoPreview = require('./services/imported-video-preview.cjs').createImportedVideoPreviewResolver({ fs, path, pathExists });

const formatMetadataValue = value => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(formatMetadataValue).filter(Boolean).join(', ');
  try {
    return JSON.stringify(value, (_key, nestedValue) => typeof nestedValue === 'bigint' ? String(nestedValue) : nestedValue);
  } catch {
    return String(value);
  }
};

const flattenMetadataValue = (group, name, value, depth = 0) => {
  if (depth < 5 && Array.isArray(value) && value.some(item => item && typeof item === 'object')) {
    return value.flatMap((item, index) => flattenMetadataValue(group, `${name}.${index + 1}`, item, depth + 1));
  }
  if (depth < 5 && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([childName, childValue]) => flattenMetadataValue(group, `${name}.${childName}`, childValue, depth + 1));
  }
  const formatted = formatMetadataValue(value);
  return formatted ? [{ group, name, value: formatted }] : [];
};

const writeSystemFileClipboard = (sources, operation) => fileClipboardService.write(sources, operation);
const readSystemFileClipboard = () => fileClipboardService.read();
const clearSystemFileClipboardIfCurrent = snapshot => fileClipboardService.clearIfCurrent(snapshot);
const cancelSystemFileCut = async expectedSources => {
  if (process.platform !== 'win32') return { cleared: false, hasFiles: false };
  const current = await readSystemFileClipboard();
  const expectedKeys = new Set(expectedSources.map(source => path.resolve(source).toLocaleLowerCase()));
  const currentSources = (current?.sources || []).map(source => path.resolve(source));
  const currentKeys = new Set(currentSources.map(source => source.toLocaleLowerCase()));
  const matchesExpectedCut = current?.operation === 'cut'
    && currentSources.length === expectedSources.length
    && currentKeys.size === expectedKeys.size
    && [...currentKeys].every(source => expectedKeys.has(source));
  if (!matchesExpectedCut) return { cleared: false, hasFiles: currentSources.some(source => fs.existsSync(source)) };
  const result = await clearSystemFileClipboardIfCurrent(current);
  return { cleared: Boolean(result.cleared), hasFiles: !result.cleared && Boolean(result.sources?.some(source => fs.existsSync(source))) };
};

const resolveProjectEntry = (workspacePath, status, projectName, relativePath = '') => {
  const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
  return projectVirtualPaths.resolve(projectPath, relativePath, { externalRootMode: 'target' }).physicalPath;
};

const cleanVersionName = value => String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 80);
const supportedVersionFileKind = filePath => {
  const extension = path.extname(filePath).toLowerCase();
  if (RAW_EXTENSIONS.has(extension)) return 'raw';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return '';
};

const buildVersionBatchImportKey = async (folderA, folderB) => {
  const folderStat = await fs.promises.stat(folderA);
  const parentIdentity = folderStat.ino ? `${folderStat.dev}:${folderStat.ino}` : path.resolve(folderA).toLocaleLowerCase();
  const tokens = [`parent:${parentIdentity}`];
  const entries = await fs.promises.readdir(folderB, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(folderB, entry.name);
    if (!supportedVersionFileKind(filePath)) continue;
    const stat = await fs.promises.stat(filePath);
    const sampleSize = Math.min(64 * 1024, stat.size);
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const head = Buffer.alloc(sampleSize);
      if (sampleSize) await handle.read(head, 0, sampleSize, 0);
      const tail = Buffer.alloc(sampleSize);
      if (sampleSize && stat.size > sampleSize) await handle.read(tail, 0, sampleSize, stat.size - sampleSize);
      const content = crypto.createHash('sha256').update(head).update(tail).digest('hex').slice(0, 24);
      // File identity and sampled content make the key stable across the
      // optional source rename while still changing when a return folder is
      // edited or receives additional files.
      tokens.push(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${content}`);
    } finally {
      await handle.close();
    }
  }
  tokens.sort();
  return `folder-snapshot:${crypto.createHash('sha256').update(tokens.join('|')).digest('hex')}`;
};

registerBrollImportIpc({
  ipcMain,
  dialog,
  shell,
  projectVirtualPaths,
  recycleBinService,
  getMainWindow: () => mainWindow,
  getProjectPath,
  getRunConfig,
  processSupervisor,
  writeLog,
  pushUndoOperation,
  activeOperations: activeProjectFileOperations,
  backgroundTasks,
  getTelemetry: () => telemetryService,
});
registerBackgroundTasksIpc({ ipcMain, eventBus, backgroundTasks, getMainWindow: () => mainWindow });
app.whenReady().then(async () => {
  void filePublicationService.warmRename()?.catch(error => writeLog('warn', 'Unable to warm file rename service', { error: error.message }));
  configMutationService = createConfigMutationService({ fs, crypto, getConfigPath, readSavedConfig, legacySettingsAdoptionsProvider: componentHostRegistry.list }); await configMutationService.ready; await configMutationService.adoptLegacySettings();
  registerComponentIconProtocol({ protocol, registry: componentHostRegistry, fs, writeLog });
  const mediaProtocolHandler = async request => {
    try {
      const token = new URL(request.url).pathname.replace(/^\//, '');
      const filePath = mediaAccessService.resolveToken(token);
      if (!filePath) return new Response('Not found', { status: 404 });
      return await createMediaFileResponse(filePath, request);
    } catch (error) {
      writeLog('warn', 'Media protocol request failed', { url: request.url, error: error.message || String(error) });
      return new Response('Bad request', { status: 400 });
    }
  };
  protocol.handle('photoflow-media', mediaProtocolHandler);
  const deletedLogFiles = await cleanupExpiredLogs();
  const deletedCaptureTimeCacheFiles = await cleanupRetiredCaptureTimeCache({ app, fs, path, onError: nativeConsoleError });
  writeLog('info', 'Application started', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, deletedExpiredLogFiles: deletedLogFiles, deletedCaptureTimeCacheFiles });
  const savedStartupConfig = readSavedConfig() || {};
  applicationLocalization.setLanguage(applicationLocalization.normalizeLanguage(savedStartupConfig.language, Object.keys(savedStartupConfig).length ? 'zh-CN' : 'system'), app.getLocale());
  const savedCacheDirectory = String(savedStartupConfig.mediaCache?.directory || '').trim();
  if (savedCacheDirectory) approvedMediaCacheDirectories.add(path.resolve(savedCacheDirectory));
  const startupMediaCacheConfig = {
    maxSizeGB: normalizeMediaCacheSizeGB(savedStartupConfig.mediaCache?.maxSizeGB),
    directory: savedCacheDirectory,
    autoCleanup30Days: savedStartupConfig.mediaCache?.autoCleanup30Days === true,
  };
  mediaRuntimeState.activeMediaCacheConfig = startupMediaCacheConfig;
  telemetryService = createTelemetryService({
    app,
    fs,
    path,
    crypto,
    getConfig: readSavedConfig,
    getLogDir,
    writeLog,
    apiBaseUrl: cloudConfig.apiBaseUrl,
    ingestKey: cloudConfig.ingestKey,
  });
  telemetryService.start();
  // IPC modules capture the BrowserWindow instance, so create it first but do
  // not load renderer code until every channel has been registered.
  createWindow(false);

  const componentContentBinding = createComponentContentBinding({
    path, ensureWorkspace, readSavedConfig, getProjectPath,
    getBoundProject: (workspaceRoot, projectName) => workspaceCatalogs.get(path.resolve(workspaceRoot))?.byName.get(String(projectName || '').toLocaleLowerCase()) || null,
  });
  const capabilityRuntime = createComponentHostCapabilityRuntime({
    getVideoPlaybackService: () => videoPlaybackService,
    ensureWorkspace,
    getWorkspaceDataRoot,
    resolveProjectEntry,
    versionService,
    IMAGE_EXTENSIONS,
    path, fs, crypto, getConfigPath, readSavedConfig, readConfig: configMutationService.read, mutateConfig: configMutationService.mutate,
    getComponentDataRoot: componentId => componentDataRoot(app, componentId, process.env),
    getProjectPath, dialog, mainWindow, mediaService, mediaRatingService, exiftool, shell, backgroundTasks,
    uniqueDestination, ensureTrackedVersionThumbnail, projectVirtualPaths, fileSystemService, runPythonJsonAction, extractVideoTimelineFrames, pluginService, safeStorage, secretsRoot: path.join(app.getPath('userData'), 'component-secrets'),
    lifecycleCoordinator: componentLifecycleCoordinator,
    getBoundProject: (workspaceRoot, projectName) => workspaceCatalogs.get(path.resolve(workspaceRoot))?.byName.get(String(projectName || '').toLocaleLowerCase()) || null,
    RAW_EXTENSIONS, VIDEO_EXTENSIONS, IMAGE_PREVIEW_CONVERSION_EXTENSIONS, resolveComponentContentBinding: componentContentBinding.resolve,
  });
  ({ componentCapabilityBroker, abortComponentNetworkRequests } = capabilityRuntime);
  const { componentInputGrants, componentNotificationService, clearComponentCapabilityState, clearComponentViewState, clearComponentSecretData } = capabilityRuntime;
  componentServiceManager = new ComponentServiceManager({
    registry: componentHostRegistry,
    processSupervisor,
    capabilityBroker: componentCapabilityBroker,
    lifecycleCoordinator: componentLifecycleCoordinator,
    writeLog,
  });
  componentViewManager = new ComponentViewManager({
    setPlaybackPaused:capabilityRuntime.setComponentPlaybackPaused,updatePlaybackBounds:capabilityRuntime.updateComponentPlaybackBounds,refreshPlaybackBounds:capabilityRuntime.refreshComponentPlaybackBounds,
    screen,
    readConfig: configMutationService.read, mutateConfig: configMutationService.mutate,
    WebContentsView,
    mainWindow,
    registry: componentHostRegistry,
    preloadPath: path.join(__dirname, 'component-preload.cjs'),
    partitionSessionProvider: partitionName => session.fromPartition(partitionName),
    mediaProtocolHandler,
    ipcMain: electronIpcMain,
    serviceManager: componentServiceManager, lifecycleCoordinator: componentLifecycleCoordinator, capabilityBroker: componentCapabilityBroker, inputGrantService: componentInputGrants, notificationService: componentNotificationService, clearComponentCapabilityState, clearComponentViewState, resolveOpenContext: componentContentBinding.resolveOpenRequest,
    writeLog,
    onViewStackChanged: () => (currentApplicationHost()?.toast || toastViewManager)?.bringToFront(),
  });
  registerComponentHostIpc({ ipcMain, manager: componentViewManager, mainWindow });
  const componentRpcIpcMain = createComponentRpcIpcProxy({ ipcMain, manager: componentViewManager });

  const { componentTransactionReady } = registerSystemIpc({ Array, Boolean, BrowserWindow, Date, Error, JSON, Object, String, abortComponentNetworkRequests, app, approvedMediaCacheDirectories, backgroundTasks, checkForUpdates, clearComponentSecretData, componentCapabilityBroker, componentServiceManager, componentViewManager, configMutationService, console, crypto, dialog, domainCommandJournal, domainHealthService, exiftoolPath, filePublicationService, fileSystemService, findLatestPhotoshop, fs, getConfigPath, getLogDir, getRunConfig, getUserBirthdaysPath, ipcMain: componentRpcIpcMain, mainWindow, mediaRuntimeState, openAllowedExternalUrl, path, pluginService, privacyService, process, processSupervisor, readSavedConfig, releaseWorkspaceWatchPath, screen, shell, spawn, suppressWorkspaceWatchPath, telemetryService, thumbnailService, undefined, writeLog });
  await componentTransactionReady;
  for (const descriptor of componentHostRegistry.list()) componentCapabilityBroker.assertCapabilities(descriptor);
  registerWorkspaceIpc({ getReadyProjectPath, Array, Boolean, CANCELLED_CODE, Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES, IMAGE_EXTENSIONS, Math, Number, Object, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, WORKSPACE_STATUSES, activeProjectFileOperations, acquireFileRootWatcher, app, assertDiskSpace, assertExistingInside, assertInside, assertRegularFile, assertUndoIdentity, backgroundTasks, cancelMediaTrackingScan, capturePathIdentity, cleanProjectName, clipboard, collectCopyPlan, copyFileAtomic, copyPlannedFiles, componentServiceManager, crypto, dialog, ensureWorkspace, extractVideoTimelineFrames, fileSystemService, findLatestPhotoshop, fs, getProjectPath, getWorkspaceDataRoot, ipcMain: componentRpcIpcMain, mainWindow, mediaRuntimeState, mediaService, moveFileAtomic, movePathAtomic, publishPathNoClobber, mutateWorkspaceCatalog, normalizeMediaCacheSizeGB, path, pathExists, pluginService, projectVirtualPaths, pushUndoOperation, removeUndoOperation, reconcileWorkspaceCatalog, recycleBinService, refreshWorkspaceCatalog, releaseFileRootWatcher, releaseWorkspaceWatchPath, removeCopiedSources, renameHistory, resolveProjectEntry, resolveWorkspaceRoot, resumeFileRootWatcher, runPythonJsonAction, samePathIdentity, scheduleMediaTrackingScan, shell, shellNewService, spawn, suspendFileRootWatcher, suppressWorkspaceWatchPath, telemetryService, thumbnailService, throwIfCancelled, undefined, uniqueDestination, versionService, watchWorkspace, workspaceCatalogs, workspaceMaintenanceRepository, workspaceRepository, writeLog });
  registerFileOperationsIpc({ isOrdinaryProjectRoot, Array, Boolean, BrowserWindow, CANCELLED_CODE, Date, Error, IMAGE_EXTENSIONS, Math, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, activeProjectFileOperations, app, assertDiskSpace, assertExistingInside, assertInside, backgroundTasks, cancelMediaTrackingScan, cancelSystemFileCut, canUseNativeFastCut, capturePathIdentity, clearSystemFileClipboardIfCurrent, clipboard, collectCopyPlan, copyFileAtomic, copyPlannedFiles, crypto, dns, ensureWorkspace, fetch: electronNet.fetch.bind(electronNet), fileOperationState, fs, getProjectPath, ipcMain, movePathAtomic, movePlannedFilesFast, publishPathNoClobber, nativeImage, net: nodeNet, path, process, projectVirtualPaths, pushUndoOperation, readSystemFileClipboard, recycleBinService, releaseWorkspaceWatchPath, removeCopiedSources, removeCreatedPasteTargets, resolveRemoteHost: async hostname => (await electronNet.resolveHost(hostname)).endpoints, resumeToastViewAfterNativeDrag, samePathIdentity, scheduleMediaTrackingScan, screen, selectionService, suspendToastViewForNativeDrag, suppressWorkspaceWatchPath, throwIfCancelled, uniqueDestination, versionService, workspaceRepository, writeLog, writeSystemFileClipboard });
  registerMediaIpc({ Buffer, Date, Error, IMAGE_EXTENSIONS, IMAGE_PREVIEW_CONVERSION_EXTENSIONS, Math, Number, Object, PRIORITY, Promise, RAW_EXTENSIONS, String, VIDEO_EXTENSIONS, approvedMediaCacheDirectories, backgroundTasks, clearTimeout, convertedImagePreviewPath, dialog, exiftool, findImportedVideoPreview, flattenMetadataValue, fs, getMediaCacheDir, ipcMain, mainWindow, mediaCacheIndexes, mediaMetadataCache, mediaRuntimeState, mediaService, normalizeMediaCacheSizeGB, path, rawOrientationCorrection, rawPreviewPath, refreshMediaCacheIndex, setTimeout, thumbnailService, trimMediaCache, undefined, writeLog });
  registerMediaRatingIpc({ IMAGE_EXTENSIONS, RAW_EXTENSIONS, ensureWorkspace, getProjectPath, ipcMain, mediaRatingService, mediaService, path, refreshWorkspaceCatalog, workspaceCatalogs, writeLog });
  registerVersionIpc({ cancelMediaTrackingScan, Array, Boolean, Error, IMAGE_EXTENSIONS, JSON, Math, Number, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, backgroundTasks, buildVersionBatchImportKey, cleanVersionName, copyFileAtomic, crypto, dialog, ensureTrackedVersionThumbnail, ensureWorkspace, fs, getProjectPath, getWorkspaceDataRoot, ipcMain: componentRpcIpcMain, mainWindow, mediaRatingService, mediaScanService, mediaService, path, projectVirtualPaths, recycleBinService, refreshWorkspaceCatalog, releaseWorkspaceWatchPath, resolveProjectEntry, runPythonEventAction, scheduleMediaTrackingScan, supportedVersionFileKind, suppressWorkspaceWatchPath, thumbnailService, trackingScanService, undefined, uniqueDestination, versionService, workspaceCatalogs, writeLog });
  registerSelectionIpc({ ipcMain, path, fs, selectionService, workspaceCatalogs });
  videoPlaybackService = registerVideoPlaybackIpc({ BrowserWindow, app, crypto, dialog, fs, ipcMain, mediaService, path, pluginService, processSupervisor, screen, spawn, writeLog });
  const credentialService = createCredentialService({ writeLog });
  const recoveryClients = [
    workspaceDatabase,
    operationsDatabase,
    workspaceMaintenanceDatabase,
    mediaDatabase,
    mediaInteractionDatabase,
    versionReadDatabase,
    versionLocationDatabase,
    mediaScanDatabase,
    trackingScanDatabase,
  ];
  let recoveryClientUsers = 0;
  let recoveryClientTransition = Promise.resolve();
  const runRecoveryClientTransition = worker => {
    const result = recoveryClientTransition.then(worker, worker);
    recoveryClientTransition = result.catch(() => undefined);
    return result;
  };
  const prepareDomainRecovery = () => runRecoveryClientTransition(async () => {
    if (recoveryClientUsers === 0) {
      const results = await Promise.allSettled(recoveryClients.map(client => client.suspend()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) {
        await Promise.allSettled(recoveryClients.map(client => Promise.resolve().then(() => client.resume())));
        throw new AggregateError(failures, '数据库 client 未能全部退出，已取消恢复');
      }
    }
    recoveryClientUsers += 1;
    let released = false;
    return () => runRecoveryClientTransition(async () => {
      if (released) return;
      released = true;
      recoveryClientUsers = Math.max(0, recoveryClientUsers - 1);
      if (recoveryClientUsers > 0) return;
      const resumes = await Promise.allSettled(recoveryClients.map(client => Promise.resolve().then(() => client.resume())));
      const failures = resumes.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, '数据库恢复完成，但部分 client 未能恢复');
    });
  });
  const backupService = createBackupService({ app, backgroundTasks, credentialService, configMutationService, getConfigPath, getUserBirthdaysPath, getWorkspaceDatabasePath, getWorkspaceOperationsDatabasePath, getWorkspaceMediaDatabasePath, getWorkspaceVersioningDatabasePath, getWorkspaceDataRoot, getWorkspaceDataRootForKey: workspaceStorageKeyService.getDataRootForKey, bindWorkspaceStorageKeyForRestore: workspaceStorageKeyService.bindForRestore, workspaceSqliteCoordinator, prepareDomainRecovery, readSavedConfig, runPythonJsonAction, shell, writeLog, componentServiceManager });
  registerBackupIpc({ backupService, credentialService, dialog, ipcMain, getMainWindow: () => mainWindow, shell, writeLog, getTelemetry: () => telemetryService });
  const archiveService = createArchiveService({ backgroundTasks, movePathAtomic, readSavedConfig, workspaceRepository, writeLog });
  registerArchiveIpc({ archiveService, dialog, ipcMain, getMainWindow: () => mainWindow, shell, writeLog });
  const storageUsageService = createStorageUsageService({ app, backgroundTasks, eventBus, getWorkspaceDatabasePath, getWorkspaceDataRoot, readSavedConfig, resolveMediaCacheDirectory: resolveMediaCacheDir, writeLog });
  registerStorageUsageIpc({ ipcMain, storageUsageService, getMainWindow: () => mainWindow });
  thumbnailService.activateStartupRecovery();
  const startupRecovery = thumbnailService.ensureStartupRecovery(startupMediaCacheConfig);
  await startupRecovery.admitted.catch(error => {
    writeLog('error', 'Thumbnail cache startup recovery failed', { error: error.message || String(error), code: error.code });
  });
  void startupRecovery.completion?.catch(error => {
    writeLog('error', 'Thumbnail cache startup recovery failed after admission', { error: error.message || String(error), code: error.code });
  });
  const smokeRecoveryResult = smokeTestEnabled && startupRecovery.completion
    ? await startupRecovery.completion
    : null;
  // A fast renderer can invoke preload APIs immediately on warm starts.
  if (smokeTestEnabled) {
    await runElectronSmokeProbe({ app, mainWindow, rendererEntryFile, loadRenderer: loadMainWindowRenderer, recoveryResult: smokeRecoveryResult, processSupervisor, componentServiceManager, componentHostRegistry, applicationQuitUi, backgroundTasks, workspaceWindows });
  } else loadMainWindowRenderer();

  setTimeout(checkForUpdates, 3000);
  if (!smokeTestEnabled) {
    const shellNewWarmup = setTimeout(() => { void shellNewService.warm().catch(() => undefined); }, 3000);
    shellNewWarmup.unref?.();
    app.once('before-quit', () => clearTimeout(shellNewWarmup));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let applicationQuitToastSuspended = false;
const applicationQuitUi = createApplicationQuitUi({ ipcMain, getMainWindow: () => workspaceWindows?.focusedHost() || mainWindow, onStateChange: state => {
  const suspended = state.phase !== 'idle';
  if (suspended === applicationQuitToastSuspended) return;
  applicationQuitToastSuspended = suspended;
  if (suspended) toastViewManager?.suspendForNativeDrag(); else toastViewManager?.resumeAfterNativeDrag();
} });
let applicationQuitAccepted = false;
let applicationQuitStartedAt = 0;
let applicationQuitDeadlineTimer = null;
let applicationQuitWindowHidden = false;
let applicationQuitWindowHiddenAt = 0;
const hideApplicationWindowForQuit = () => {
  if (applicationQuitWindowHidden) return;
  applicationQuitWindowHidden = true;
  applicationQuitUi.setPhase('closing');
  mainWindow?.hide();
  workspaceWindows?.hideAll();
  applicationQuitWindowHiddenAt = Date.now();
};
const armApplicationQuitDeadline = () => {
  if (applicationQuitDeadlineTimer) return;
  applicationQuitDeadlineTimer = setTimeout(() => {
    writeLog('error', 'Application quit exceeded deadline; forcing process exit', { elapsedMs: Date.now() - applicationQuitStartedAt });
    hideApplicationWindowForQuit();
    app.exit(0);
  }, 15000);
};
getApplicationQuitState = registerConfigDrainBeforeQuit({
  app, getConfigMutationService: () => configMutationService, writeLog,
  beforeDrain: async () => {
    applicationQuitStartedAt = Date.now();
    if (!applicationQuitAccepted) {
      const pendingTasks = selectApplicationQuitTasks(backgroundTasks.list());
      const confirmed = await applicationQuitUi.confirmAndPrepare(pendingTasks);
      if (!confirmed) throw Object.assign(new Error('用户取消退出'), { code: 'APP_QUIT_CANCELLED' });
      if (pendingTasks.length) applicationQuitStartedAt = Date.now();
      applicationQuitAccepted = true;
      hideApplicationWindowForQuit();
      armApplicationQuitDeadline();
      await workspaceWindows?.prepareQuit();
    }
    if (!componentLifecycleCoordinator.beginApplicationQuit()) throw Object.assign(new Error('组件变更仍在进行，请稍后重试退出'), { code: 'APP_QUIT_BUSY' });
  },
  onQuit: async () => {
    const componentIds = [...new Set(componentHostRegistry.list().map(item => item.componentId))];
    await runApplicationQuit({
      componentIds, processSupervisor, componentServiceManager, componentViewManager, componentLifecycleCoordinator,
      componentCapabilityBroker, abortComponentNetworkRequests, backgroundTasks, writeLog, confirmationAccepted: true,
      startedAt: applicationQuitStartedAt,
      windowHiddenAt: applicationQuitWindowHiddenAt,
      quiesce: () => {
        applicationQuitUi.setPhase('saving');
        void thumbnailService?.stop({ discardAccessTimes: true }).catch(() => undefined);
        mediaTrackingScanScheduler?.stop();
        versionStaleDetectionService.stop();
        stopWorkspaceWatcher(true);
        stopFileRootWatchers();
        telemetryService?.stop();
      },
      saveState: () => configMutationService?.drain({ timeoutMs: 5000 }),
      hideWindow: () => {
        hideApplicationWindowForQuit();
        domainCommandJournal.stop();
      },
      cleanup: [
        () => filePublicationService.stop(),
        () => recycleBinService.stop(),
        () => imageThumbnailRuntime.stop(),
        () => thumbnailService?.stop({ discardAccessTimes: true }),
        () => videoPlaybackService?.dispose(),
        () => exiftool.end(false),
      ],
      teardown: [() => componentServiceManager?.destroy(), () => componentViewManager?.destroy(), () => eventBus.clear()],
    });
  },
  onQuitFailed: async error => {
    workspaceWindows?.restoreAfterFailedQuit();
    componentLifecycleCoordinator.cancelApplicationQuit();
    if (error?.code === 'APP_QUIT_CANCELLED') {
      applicationQuitAccepted = false;
      applicationQuitUi.setPhase('idle');
      return false;
    }
    if (!applicationQuitAccepted) {
      applicationQuitWindowHidden = false;
      applicationQuitWindowHiddenAt = 0;
      applicationQuitUi.setPhase('idle');
      return false;
    }
    writeLog('warn', 'Application cleanup failed after quit acceptance; forcing process exit', { error: error?.message || String(error), code: error?.code });
    hideApplicationWindowForQuit();
    return true;
  },
});
app.on('will-quit', () => {
  if (applicationQuitDeadlineTimer) clearTimeout(applicationQuitDeadlineTimer);
  applicationQuitDeadlineTimer = null;
  destroyToastViewManager();
});

app.on('window-all-closed', () => {
  writeLog('info', 'All application windows closed');
  if (process.platform !== 'darwin') app.quit();
});
process.on('uncaughtException', (error) => {
  writeLog('error', 'Uncaught main-process exception', error);
  telemetryService?.reportCrash('main_uncaught_exception', error);
  if (mainWindow && !mainWindow.isDestroyed()) sendToApplicationRenderers(mainWindow, 'app-error', error.message || '主进程发生未知错误');
});

process.on('unhandledRejection', (reason) => {
  writeLog('error', 'Unhandled main-process promise rejection', reason);
  telemetryService?.reportCrash('main_unhandled_rejection', reason);
  if (mainWindow && !mainWindow.isDestroyed()) sendToApplicationRenderers(mainWindow, 'app-error', reason instanceof Error ? reason.message : String(reason || '后台操作失败'));
});
