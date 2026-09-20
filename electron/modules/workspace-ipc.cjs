const { localizeDialogOptions } = require("../services/localization.cjs");
const { t: translateNative } = require("../services/localization.cjs");
const { sendToApplicationRenderers } = require('../services/application-windows.cjs');
const { getProtectedProjectFolderRegistry } = require('../services/protected-project-folder.cjs');
const { createProjectFileTask } = require('../services/project-file-task-service.cjs');
const { startDetachedBackgroundOperation } = require('../services/detached-background-operation.cjs');
const { replaceVideoFileWithRollback } = require('../services/video-trim-commit-service.cjs');
const { createProjectVirtualPathService } = require('../services/project-virtual-path-service.cjs');
const { normalizeProjectFileListFilter, projectFileListEntryMatchesFilter, projectFileListSessionMatches } = require('./workspace/file-list-contract.cjs');
const { IMPORT_GRAPH_RECEIPT_NAME, createImportReceiptService, validImportSessionId } = require('./workspace/import-receipt-service.cjs');
const { createWorkspaceStoragePolicy } = require('./workspace/storage-policy.cjs');
const { cleanupImportArtifacts } = require('./workspace/import-recovery.cjs');
const { scheduleSdImportedMedia } = require('./workspace/sd-import-media-scan.cjs');
const { createDeletedProjectCleanup } = require('./workspace/deleted-project-cleanup.cjs');
const { formatProjectDate, normalizeProjectDate, readProjectDate } = require('./workspace/project-date.cjs');
const { runWorkspaceMaintenanceWithRetry, workspaceDatabaseTaskResource } = require('./workspace/workspace-maintenance.cjs');
const {
  publishPathNoClobber: defaultPublishPathNoClobber,
  rebaseCleanupOwnership: defaultRebaseCleanupOwnership,
  releaseCleanupOwnership: defaultReleaseCleanupOwnership,
  removeCreatedPasteTargets: defaultRemoveCreatedPasteTargets,
  removeOwnedPathIdentityBound: defaultRemoveOwnedPathIdentityBound,
} = require('../services/file-transfer-service.cjs');
const { registerVideoTimelineIpc } = require('./workspace/video-timeline-ipc.cjs');
const { registerEntryUtilityIpc } = require('./workspace/entry-utility-ipc.cjs');
const { registerInspirationIpc } = require('./workspace/inspiration-ipc.cjs');
const { registerEntryDetailsIpc, registerRecentProjectFileIpc } = require('./workspace/project-file-query-ipc.cjs');
const { registerWorkspaceImportIpc } = require('./workspace/import-ipc.cjs');
const { isInternalWorkspacePathSegment } = require('../infrastructure/internal-workspace-path.cjs');
const { capturePathIdentity: defaultCapturePathIdentity, identityFromStat: defaultIdentityFromStat, samePathIdentity: defaultSamePathIdentity } = require('../services/file-identity-service.cjs');

const INSPIRATION_VIRTUAL_PROJECT_NAME = '.__photoflow_inspiration__';
const registerWorkspaceIpc = context => {
  const getReadyProjectPath = context.getReadyProjectPath || (async (...args) => context.getProjectPath(...args));
  const { Array, Boolean, CANCELLED_CODE, Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES, IMAGE_EXTENSIONS, Math, Number: workspaceNumber = Number, Object, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, WORKSPACE_STATUSES, activeProjectFileOperations, acquireFileRootWatcher, app, assertDiskSpace, assertExistingInside, assertInside, assertRegularFile, assertUndoIdentity, backgroundTasks, cancelMediaTrackingScan, capturePathIdentity, cleanProjectName, clipboard, collectCopyPlan, copyFileAtomic, copyPlannedFiles, componentServiceManager, crypto, dialog, ensureWorkspace, fileSystemService, findLatestPhotoshop, fs, getProjectPath, getWorkspaceDataRoot, ipcMain, mainWindow, mediaRuntimeState, mediaService, moveFileAtomic, movePathAtomic, publishPathNoClobber = defaultPublishPathNoClobber, mutateWorkspaceCatalog, normalizeMediaCacheSizeGB, path, pathExists, pluginService, projectVirtualPaths, pushUndoOperation, rebaseCleanupOwnership = defaultRebaseCleanupOwnership, releaseCleanupOwnership = defaultReleaseCleanupOwnership, removeCreatedPasteTargets = defaultRemoveCreatedPasteTargets, removeOwnedPathIdentityBound = defaultRemoveOwnedPathIdentityBound, removeUndoOperation = () => false, reconcileWorkspaceCatalog, recycleBinService, refreshWorkspaceCatalog, releaseFileRootWatcher, releaseWorkspaceWatchPath, removeCopiedSources, renameHistory, resolveProjectEntry, resolveWorkspaceRoot, resumeFileRootWatcher, runPythonJsonAction, samePathIdentity, scheduleMediaTrackingScan, shell, shellNewService, spawn, suspendFileRootWatcher, suppressWorkspaceWatchPath, telemetryService, thumbnailService, throwIfCancelled, undefined, uniqueDestination, versionService, watchWorkspace, workspaceCatalogs, workspaceMaintenanceRepository, workspaceRepository, writeLog } = context;
  const { isProtectedProjectFolderName, isProtectedProjectFolderPath } = context.protectedProjectFolders || getProtectedProjectFolderRegistry();
  const extractTimelineFrames = context.extractVideoTimelineFrames;
  registerVideoTimelineIpc({ ipcMain, extractVideoTimelineFrames: extractTimelineFrames, resolveProjectEntry, fs, path, VIDEO_EXTENSIONS, writeLog });
  const logSlowWorkspaceInteraction = (operation, startedAt, details = {}) => {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 150) writeLog('info', 'Slow workspace interaction', { operation, elapsedMs, ...details });
  };
  const comparablePath = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);

  const plannedProjectPath = (root, projectName, status = '策划中') => {
    let candidate;
    try { candidate = path.resolve(getProjectPath(root, status, projectName)); }
    catch { candidate = path.resolve(root, projectName); }
    if (typeof assertInside === 'function') assertInside(root, candidate, '项目路径');
    else {
      const relative = path.relative(path.resolve(root), candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('项目路径无效');
    }
    return candidate;
  };
  const captureIdentity = candidate => Promise.resolve((capturePathIdentity || defaultCapturePathIdentity)(candidate));
  const identityMatches = async (candidate, expected) => {
    return (samePathIdentity || defaultSamePathIdentity)(candidate, expected);
  };
  const removeIfOwned = async (candidate, ownership) => {
    if (!candidate || !ownership?.created || !fs.existsSync(candidate)) return false;
    const outcome = await removeOwnedPathIdentityBound(candidate, ownership.identity);
    if (outcome.success) return true;
    throw Object.assign(new Error('无法证明失败回滚目标仍由当前操作完整拥有，内容已保留等待恢复'), {
      code: outcome.code || 'CLEANUP_OWNERSHIP_CONFLICT', recoveryPath: outcome.recoveryPath, outcome,
    });
  };
  const { refreshAfterRepositoryCommit, scheduleCatalogReconcile, notifyProjectsChanged, probeProjectMutation } = require('./workspace/catalog-mutation-notices.cjs').createCatalogMutationNotices({ refreshWorkspaceCatalog, reconcileWorkspaceCatalog, workspaceCatalogs, mainWindow, writeLog, Promise, String });
  const mutationOutcomeUnknownError = cause => Object.assign(new Error(`项目操作结果暂时无法确认，请勿重复执行；后台正在核对目录。${cause?.message ? ` ${cause.message}` : ''}`), {
    code: 'WORKSPACE_MUTATION_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true, cause,
  });
  const recoveryErrorFields = [
    'code', 'recoveryPath', 'outcomeUnknown', 'published', 'originalMissing', 'sourceRetained', 'cleanupWarning',
    'recoveryRequired', 'partial', 'identityVerified', 'deleted', 'rollbackPending', 'nativeError', 'transferStage',
    'stagingExists', 'targetExists', 'recoveryAvailable', 'attemptedStagingPath', 'publicationState', 'publishedConfirmed', 'phase',
  ];
  const recoveryDescriptor = (error, label) => {
    const descriptor = { label, error: error?.message || String(error || '未知错误') };
    for (const field of recoveryErrorFields) if (error?.[field] !== undefined) descriptor[field] = error[field];
    return descriptor;
  };
  const mergeRecoveryError = (primary, secondary, label) => {
    if (!Array.isArray(primary.recoveries)) primary.recoveries = [recoveryDescriptor(primary, '主恢复')];
    const detail = secondary?.message || String(secondary || '未知错误');
    primary.cleanupWarning = [primary.cleanupWarning, `${label}：${detail}`].filter(Boolean).join('；');
    const secondaryRecovery = recoveryDescriptor(secondary, label);
    primary.recoveries.push(secondaryRecovery);
    primary.rollbackRecovery = secondaryRecovery;
    return primary;
  };
  const terminalRecoveryResult = error => Boolean(
    error?.outcomeUnknown || error?.recoveryPath || error?.published === true || error?.deleted === true
    || error?.partial === true || error?.recoveryRequired === true || error?.rollbackPending === true
    || error?.recoveries?.some(recovery => recovery.outcomeUnknown || recovery.recoveryPath || recovery.published === true
      || recovery.deleted === true || recovery.partial === true || recovery.recoveryRequired === true || recovery.rollbackPending === true),
  );
  const serializeUndoRecoveryError = error => {
    const baseMessage = error?.message || String(error);
    const hints = [];
    if (error?.outcomeUnknown) hints.push('恢复结果待确认，请勿重复执行此操作');
    if (error?.recoveryPath) hints.push(`可恢复内容位于：${error.recoveryPath}`);
    if (error?.cleanupWarning) hints.push(`清理提示：${error.cleanupWarning}`);
    for (const recovery of error?.recoveries || []) {
      if (recovery.recoveryPath && recovery.recoveryPath !== error?.recoveryPath) hints.push(`${recovery.label || '恢复步骤'}位置：${recovery.recoveryPath}`);
    }
    const response = { success: false, error: [baseMessage, ...hints].filter(Boolean).join('；') };
    for (const field of recoveryErrorFields) if (error?.[field] !== undefined) response[field] = error[field];
    if (error?.rollbackRecovery) response.rollbackRecovery = error.rollbackRecovery;
    if (Array.isArray(error?.recoveries)) response.recoveries = error.recoveries;
    if (error?.code !== undefined) response.errorCode = error.code;
    return response;
  };
  const restoreDecisionTokens = new Map();
  const legacyRestoreDecisions = new WeakMap();
  const blockedPersistentUndos = new Map();
  const persistentUndoClaimPrefix = '.photoflow-undo-claim-';
  const persistentUndoClaimDirectoryName = '.photoflow-undo-claims';
  const persistentUndoClaimSchema = 2;
  const validWorkspaceId = /^[a-f0-9]{24,64}$/u;
  const persistentUndoClaimMaxBytes = Math.max(256, Number(context.persistentUndoClaimMaxBytes) || 4096);
  const persistentUndoClaimScanLimit = Math.max(1, Number(context.persistentUndoClaimScanLimit) || 64);
  const persistentUndoClaimMaxVisitedEntries = Math.max(1, Number(context.persistentUndoClaimMaxVisitedEntries) || 1024);
  const persistentUndoClaimScanBudgetMs = Math.max(1, Number(context.persistentUndoClaimScanBudgetMs) || 25);
  const persistentUndoClaimThrottleMs = Math.max(0, Number(context.persistentUndoClaimThrottleMs ?? (6 * 60 * 60 * 1000)));
  const persistentUndoClaimRetentionMs = context.persistentUndoClaimRetentionMs === undefined
    ? 7 * 24 * 60 * 60 * 1000 : Math.max(0, Number(context.persistentUndoClaimRetentionMs) || 0);
  const persistentUndoClaimLastScans = new Map();
  const persistentUndoLegacyCursors = new Map();
  const persistentUndoV2Cursors = new Map();
  const persistentUndoPendingCleanups = new Map();
  const persistentUndoPendingCleanupCapacity = Math.max(1, Number(context.persistentUndoPendingCleanupCapacity) || 128);
  const persistentUndoPendingCleanupTimers = new Map();
  const persistentUndoPendingCleanupRetryRunning = new Set();
  const persistentUndoPendingCleanupAttempts = new Map();
  const persistentUndoPendingCleanupRescanNeeded = new Set();
  const persistentUndoPendingCleanupMaxAttempts = Math.max(1, Number(context.persistentUndoPendingCleanupMaxAttempts) || 4);
  const persistentUndoPendingCleanupBaseDelayMs = Math.max(10, Number(context.persistentUndoPendingCleanupBaseDelayMs) || 50);
  const persistentUndoGcScheduled = new Set();
  const persistentUndoGcRunning = new Set();
  const persistentUndoRequestedCanonicalRoots = new Map();
  const persistentUndoRequestedCanonicalCapacity = Math.max(1, Number(context.persistentUndoRequestedCanonicalCapacity) || 64);
  const persistentUndoRequestedCanonicalTtlMs = Math.max(1000, Number(context.persistentUndoRequestedCanonicalTtlMs) || 5 * 60 * 1000);
  const persistentUndoInteractiveLegacyScans = new Map();
  const persistentUndoInteractiveAdmissionTimers = new Map();
  const persistentUndoInteractiveBudgetMs = Math.max(1, Number(context.persistentUndoInteractiveBudgetMs) || 10);
  const persistentUndoInteractiveVisitedLimit = Math.max(1, Number(context.persistentUndoInteractiveVisitedLimit) || 128);
  const persistentUndoInteractiveCapacity = Math.max(1, Number(context.persistentUndoInteractiveCapacity) || 64);
  const persistentUndoInteractiveTtlMs = Math.max(1000, Number(context.persistentUndoInteractiveTtlMs) || 5 * 60 * 1000);
  const blockedPersistentUndoTtlMs = Math.max(1, Number(context.persistentUndoQuarantineTtlMs) || 30 * 60 * 1000);
  const blockedPersistentUndoCapacity = Math.max(1, Number(context.persistentUndoQuarantineCapacity) || 256);
  const persistentUndoClaimPlatform = context.platform || process.platform;
  let persistentUndoQuarantineOverflow = false;
  const persistentUndoKey = (workspaceRoot, persistentId) => `${comparablePath(path.resolve(String(workspaceRoot || '')))}\0${String(persistentId || '')}`;
  const claimFailure = (message, cause) => Object.assign(new Error(message), {
    code: 'CLAIM_PERSIST_FAILED', recoveryRequired: true, rollbackPending: true, cause,
  });
  const readPersistentUndoWorkspaceId = async workspaceRoot => {
    if (typeof context.persistentUndoWorkspaceId === 'function') {
      const injected = String(await context.persistentUndoWorkspaceId(workspaceRoot)).trim().toLocaleLowerCase();
      if (!validWorkspaceId.test(injected)) throw claimFailure('测试注入的稳定工作区 ID 无效');
      return injected;
    }
    const markerPath = path.join(workspaceRoot, '.photoflow-workspace-id');
    let handle;
    try {
      const markerStat = await fs.promises.lstat(markerPath, { bigint: true });
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1n || markerStat.size > 128n) throw new Error('workspace identity marker is unsafe');
      const resolvedMarker = await fs.promises.realpath(markerPath);
      if (comparablePath(resolvedMarker) !== comparablePath(markerPath)) throw new Error('workspace identity marker escaped its canonical path');
      handle = await fs.promises.open(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const workspaceId = String(await handle.readFile({ encoding: 'utf8' })).trim().toLocaleLowerCase();
      if (!validWorkspaceId.test(workspaceId)) throw new Error('workspace identity marker is invalid');
      return workspaceId;
    } catch (cause) {
      throw claimFailure(`无法读取稳定工作区 ID，已拒绝执行：${cause?.message || String(cause)}`, cause);
    } finally { await handle?.close().catch(() => undefined); }
  };
  const persistentUndoClaimDirectory = async (workspaceRoot, create = false) => {
    const directoryPath = path.join(workspaceRoot, persistentUndoClaimDirectoryName);
    try {
      let directoryStat = await fs.promises.lstat(directoryPath, { bigint: true }).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!directoryStat && !create) return null;
      if (!directoryStat) {
        try { await fs.promises.mkdir(directoryPath, { mode: 0o700 }); }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
        directoryStat = await fs.promises.lstat(directoryPath, { bigint: true });
      }
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('claim directory is not a real directory');
      const resolvedDirectory = await fs.promises.realpath(directoryPath);
      const relative = path.relative(workspaceRoot, resolvedDirectory);
      if (comparablePath(resolvedDirectory) !== comparablePath(directoryPath) || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('claim directory escapes the canonical workspace');
      if (persistentUndoClaimPlatform !== 'win32') {
        if (create) await fs.promises.chmod(directoryPath, 0o700);
        const protectedStat = await fs.promises.lstat(directoryPath);
        if ((protectedStat.mode & 0o077) !== 0) throw new Error('claim directory permissions are not 0700');
      }
      if (create) await syncPersistentUndoClaimDirectory(workspaceRoot);
      return directoryPath;
    } catch (cause) {
      throw claimFailure(`持久撤销 claim 目录不安全，已拒绝执行：${cause?.message || String(cause)}`, cause);
    }
  };
  const persistentUndoClaimDescriptor = async (operation, createDirectory = false) => {
    const persistentId = typeof operation?.persistentId === 'string' ? operation.persistentId : '';
    if (!persistentId || persistentId.length > 256 || persistentId.trim() !== persistentId || /[\0\r\n]/.test(persistentId)) {
      throw Object.assign(new Error('持久撤销记录 ID 无效，已拒绝执行'), { code: 'CLAIM_PERSIST_FAILED', recoveryRequired: true, rollbackPending: true });
    }
    let workspaceRoot;
    try { workspaceRoot = await fs.promises.realpath(path.resolve(String(operation.workspaceRoot || ''))); }
    catch (cause) {
      throw Object.assign(new Error(`无法确认持久撤销工作区，已拒绝执行：${cause?.message || String(cause)}`), {
        code: 'CLAIM_PERSIST_FAILED', recoveryRequired: true, rollbackPending: true, cause,
      });
    }
    const workspaceId = await readPersistentUndoWorkspaceId(workspaceRoot);
    const directory = await persistentUndoClaimDirectory(workspaceRoot, createDirectory);
    const digest = crypto.createHash('sha256').update(`${workspaceId}\0${persistentId}`).digest('hex');
    return { workspaceRoot, workspaceId, persistentId, directory, path: directory ? path.join(directory, `${digest}.json`) : null };
  };
  const legacyInteractiveKey = descriptor => `${comparablePath(descriptor.workspaceRoot)}\0${descriptor.workspaceId}\0${descriptor.persistentId}`;
  const rootDirectoryIdentity = async root => {
    const stat = await fs.promises.lstat(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('workspace root identity is unsafe');
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  const closeInteractiveLegacyState = async (key, state) => {
    persistentUndoInteractiveLegacyScans.delete(key);
    await state?.directory?.close().catch(error => { if (error?.code !== 'ERR_DIR_CLOSED') throw error; });
  };
  const pruneInteractiveLegacyScans = async excludeKey => {
    const now = Date.now();
    for (const [key, state] of persistentUndoInteractiveLegacyScans) if (key !== excludeKey && !state.running && !state.scheduled && state.expiresAt <= now) await closeInteractiveLegacyState(key, state);
    while (persistentUndoInteractiveLegacyScans.size > persistentUndoInteractiveCapacity) {
      const candidate = [...persistentUndoInteractiveLegacyScans.entries()].find(([key, state]) => key !== excludeKey && !state.running && !state.scheduled);
      if (!candidate) break;
      const [key, state] = candidate;
      await closeInteractiveLegacyState(key, state);
    }
  };
  const validLegacyMarkerForDescriptor = async (descriptor, entry) => {
    if (!entry.name.startsWith(persistentUndoClaimPrefix)
        || !/^\.photoflow-undo-claim-[0-9a-f]{64}\.json$/u.test(entry.name) || !entry.isFile()) return false;
    let handle;
    try {
      handle = await fs.promises.open(path.join(descriptor.workspaceRoot, entry.name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(persistentUndoClaimMaxBytes)) return false;
      const bytes = await handle.readFile();
      if (bytes.length !== Number(stat.size) || bytes.length > persistentUndoClaimMaxBytes) return false;
      const marker = JSON.parse(bytes.toString('utf8'));
      const createdAt = Date.parse(marker?.createdAt);
      return marker?.schema === 1 && marker?.kind === 'trash' && marker?.id === descriptor.persistentId
        && typeof marker?.createdAt === 'string' && Number.isFinite(createdAt) && new Date(createdAt).toISOString() === marker.createdAt
        && typeof marker?.nonce === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(marker.nonce);
    } catch { return false; }
    finally { await handle?.close().catch(() => undefined); }
  };
  const scheduleInteractiveLegacyContinuation = (descriptor, key, state) => {
    if (state.scheduled || state.complete) return;
    state.scheduled = true;
    setTimeout(() => {
      legacyPersistentUndoClaimStatus(descriptor, true)
        .catch(error => writeLog('warn', 'Legacy undo claim interactive scan continuation failed', { workspaceRoot: descriptor.workspaceRoot, error: error?.message || String(error) }))
        .finally(() => { state.scheduled = false; if (!state.complete && persistentUndoInteractiveLegacyScans.get(key) === state) scheduleInteractiveLegacyContinuation(descriptor, key, state); });
    }, 0);
  };
  const scheduleInteractiveLegacyAdmission = (descriptor, key) => {
    if (persistentUndoInteractiveAdmissionTimers.has(key)) return;
    if (persistentUndoInteractiveAdmissionTimers.size >= persistentUndoInteractiveCapacity) return;
    const timer = setTimeout(() => {
      persistentUndoInteractiveAdmissionTimers.delete(key);
      legacyPersistentUndoClaimStatus(descriptor, true).then(status => {
        if (!status.complete && status.capacityPending) scheduleInteractiveLegacyAdmission(descriptor, key);
      }).catch(error => writeLog('warn', 'Legacy undo claim scan admission retry failed', { workspaceRoot: descriptor.workspaceRoot, error: error?.message || String(error) }));
    }, 25);
    persistentUndoInteractiveAdmissionTimers.set(key, timer);
  };
  const legacyPersistentUndoClaimStatus = async (descriptor, continuation = false) => {
    const key = legacyInteractiveKey(descriptor);
    await pruneInteractiveLegacyScans(key);
    let state = persistentUndoInteractiveLegacyScans.get(key);
    let identity;
    try { identity = await rootDirectoryIdentity(descriptor.workspaceRoot); }
    catch (cause) {
      if (state) await closeInteractiveLegacyState(key, state).catch(() => undefined);
      const admission = persistentUndoInteractiveAdmissionTimers.get(key); if (admission) clearTimeout(admission);
      persistentUndoInteractiveAdmissionTimers.delete(key);
      throw claimFailure(`旧版 claim 扫描期间工作区身份不可用，已停止后台续扫：${cause?.message || String(cause)}`, cause);
    }
    if (state && state.rootIdentity !== identity) { await closeInteractiveLegacyState(key, state); state = null; }
    if (state?.complete) return { exists: state.exists, complete: true };
    if (!state) {
      while (persistentUndoInteractiveLegacyScans.size >= persistentUndoInteractiveCapacity) {
        const candidate = [...persistentUndoInteractiveLegacyScans.entries()].find(([candidateKey, candidateState]) => candidateKey !== key && !candidateState.running && !candidateState.scheduled);
        if (!candidate) { scheduleInteractiveLegacyAdmission(descriptor, key); return { exists: false, complete: false, capacityPending: true }; }
        await closeInteractiveLegacyState(candidate[0], candidate[1]);
      }
      state = { directory: await fs.promises.opendir(descriptor.workspaceRoot), rootIdentity: identity, complete: false, exists: false, scheduled: false, running: false, expiresAt: Date.now() + persistentUndoInteractiveTtlMs };
      persistentUndoInteractiveLegacyScans.set(key, state);
    }
    if (state.running) return { exists: false, complete: false };
    state.running = true;
    const deadline = Date.now() + persistentUndoInteractiveBudgetMs;
    let visited = 0;
    try {
      while (visited < persistentUndoInteractiveVisitedLimit && Date.now() < deadline) {
        const entry = await state.directory.read();
        if (!entry) {
          await state.directory.close().catch(error => { if (error?.code !== 'ERR_DIR_CLOSED') throw error; });
          state.directory = null; state.complete = true; state.exists = false; state.expiresAt = Date.now() + persistentUndoInteractiveTtlMs;
          return { exists: false, complete: true };
        }
        visited += 1;
        if (await validLegacyMarkerForDescriptor(descriptor, entry)) {
          await state.directory.close().catch(error => { if (error?.code !== 'ERR_DIR_CLOSED') throw error; });
          state.directory = null; state.complete = true; state.exists = true; state.expiresAt = Date.now() + persistentUndoInteractiveTtlMs;
          return { exists: true, complete: true };
        }
      }
      state.expiresAt = Date.now() + persistentUndoInteractiveTtlMs;
      scheduleInteractiveLegacyContinuation(descriptor, key, state);
      return { exists: false, complete: false, continuation };
    } catch (cause) {
      await closeInteractiveLegacyState(key, state).catch(() => undefined);
      throw claimFailure(`无法检查旧版持久撤销 claim，已拒绝执行：${cause?.message || String(cause)}`, cause);
    } finally { state.running = false; }
  };
  const persistentUndoClaimStatus = async descriptor => {
    try {
      if (descriptor.path) {
        const stat = await fs.promises.lstat(descriptor.path).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (stat) return { exists: true, complete: true };
      }
      return legacyPersistentUndoClaimStatus(descriptor);
    } catch (cause) {
      if (cause?.code === 'CLAIM_PERSIST_FAILED') throw cause;
      throw claimFailure(`无法确认持久撤销 claim 状态，已拒绝执行：${cause?.message || String(cause)}`, cause);
    }
  };
  /* Legacy marker parsing remains stream-based; an incomplete interactive scan never authorizes restore. */
  const syncPersistentUndoClaimDirectory = async directory => {
    if (persistentUndoClaimPlatform === 'win32') return;
    let handle;
    try { handle = await fs.promises.open(directory, 'r'); await handle.sync(); }
    finally { await handle?.close().catch(() => undefined); }
  };
  const createPersistentUndoClaim = async (operation, descriptor) => {
    if (!descriptor.directory) descriptor = await persistentUndoClaimDescriptor(operation, true);
    const nonce = crypto.randomUUID();
    const marker = { schema: persistentUndoClaimSchema, workspaceId: descriptor.workspaceId, id: descriptor.persistentId, kind: operation.kind, createdAt: new Date().toISOString(), nonce };
    let handle;
    let opened = false;
    try {
      handle = await fs.promises.open(descriptor.path, 'wx', 0o600);
      opened = true;
      await handle.writeFile(`${JSON.stringify(marker)}\n`, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = null;
      await syncPersistentUndoClaimDirectory(descriptor.directory);
      return { ...descriptor, nonce };
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      const exists = cause?.code === 'EEXIST';
      const error = Object.assign(new Error(exists
        ? '该持久撤销记录已被其他进程认领，当前进程不会再次恢复'
        : `无法持久认领撤销记录，已拒绝执行：${cause?.message || String(cause)}`), {
        code: exists ? 'PERSISTENT_UNDO_RECOVERY_PENDING' : 'CLAIM_PERSIST_FAILED',
        recoveryRequired: true, rollbackPending: true, cause, claimExists: exists || opened,
      });
      throw error;
    }
  };
  const pendingPersistentUndoError = (message, cause) => Object.assign(new Error(message), {
    code: 'PERSISTENT_UNDO_RECOVERY_PENDING', recoveryRequired: true, rollbackPending: true, cause,
  });
  const claimPersistentUndoExecution = async (operation, boundRecord, descriptor) => {
    await createPersistentUndoClaim(operation, descriptor);
    let latestAfterClaim;
    try { latestAfterClaim = await workspaceRepository.latestUndoRecord(operation.workspaceRoot); }
    catch (cause) { throw pendingPersistentUndoError(`claim 已持久化，但无法复核撤销 journal；已拒绝执行：${cause?.message || String(cause)}`, cause); }
    if (!latestAfterClaim.record || latestAfterClaim.record.id !== operation.persistentId
        || latestAfterClaim.record.claimToken !== boundRecord.claimToken) {
      throw pendingPersistentUndoError('claim 后的撤销记录版本已变化；当前 tombstone 保留且不会执行');
    }
    let executionClaim;
    try { executionClaim = await workspaceRepository.claimUndoRecordExecution(operation.workspaceRoot, operation.persistentId, boundRecord.claimToken); }
    catch (cause) { throw pendingPersistentUndoError(`持久撤销 claim 已建立，但无法原子隔离执行权；不会执行恢复：${cause?.message || String(cause)}`, cause); }
    if (executionClaim?.claimed !== true) throw pendingPersistentUndoError('持久撤销记录版本已变化或执行权已被其他进程取得；当前 tombstone 保留且不会执行恢复');
    try {
      const shadow = await workspaceRepository.shadowRetireUndoRecord(operation.workspaceRoot, operation.persistentId);
      if (shadow?.retired !== true) throw new Error('core shadow did not acknowledge retired=true');
    }
    catch (cause) { throw pendingPersistentUndoError(`执行权已隔离，但 core retired shadow 持久化失败；不会执行恢复：${cause?.message || String(cause)}`, cause); }
    await context.afterPersistentUndoExecutionClaim?.({ operation, descriptor });
    return descriptor;
  };
  const processPersistentUndoClaimGcCandidate = async ({ root, workspaceId, markerPath, entryName, schema, result, deadline, now }) => {
    if (result.checked >= persistentUndoClaimScanLimit || Date.now() >= deadline) { result.truncated = true; return; }
    result.checked += 1;
    let handle;
    try {
      const expectedName = schema === 2 ? /^([0-9a-f]{64})\.json$/u.exec(entryName) : /^\.photoflow-undo-claim-([0-9a-f]{64})\.json$/u.exec(entryName);
      if (!expectedName) throw Object.assign(new Error('marker name is invalid'), { code: 'MARKER_INVALID' });
      handle = await fs.promises.open(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const beforeStat = await handle.stat({ bigint: true });
      if (!beforeStat.isFile() || beforeStat.isSymbolicLink() || beforeStat.nlink !== 1n || beforeStat.size > BigInt(persistentUndoClaimMaxBytes)) throw Object.assign(new Error('marker is not a bounded single-link regular file'), { code: 'MARKER_INVALID' });
      const buffer = Buffer.alloc(persistentUndoClaimMaxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > persistentUndoClaimMaxBytes || BigInt(bytesRead) !== beforeStat.size) throw Object.assign(new Error('marker exceeds or changed within the size limit'), { code: 'MARKER_TOO_LARGE' });
      const markerBytes = buffer.subarray(0, bytesRead);
      const marker = JSON.parse(markerBytes.toString('utf8'));
      const createdAt = Date.parse(marker?.createdAt);
      const validCreatedAt = typeof marker?.createdAt === 'string' && Number.isFinite(createdAt) && new Date(createdAt).toISOString() === marker.createdAt;
      const validId = typeof marker?.id === 'string' && marker.id.length > 0 && marker.id.length <= 256 && marker.id.trim() === marker.id && !/[\0\r\n]/.test(marker.id);
      const validNonce = typeof marker?.nonce === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(marker.nonce);
      const validWorkspace = schema === 1 || marker?.workspaceId === workspaceId;
      const digest = validId ? crypto.createHash('sha256').update(`${workspaceId}\0${marker.id}`).digest('hex') : '';
      if (marker?.schema !== schema || !validId || !validNonce || marker?.kind !== 'trash' || !validWorkspace || !validCreatedAt
          || createdAt > now + 5 * 60 * 1000 || (schema === 2 && digest !== expectedName[1])) {
        throw Object.assign(new Error('marker schema or identity is invalid'), { code: 'MARKER_INVALID' });
      }
      const retentionCutoffNs = BigInt(Math.trunc(now - persistentUndoClaimRetentionMs)) * 1000000n;
      if (createdAt > now - persistentUndoClaimRetentionMs || beforeStat.mtimeNs > retentionCutoffNs || beforeStat.ctimeNs > retentionCutoffNs) {
        result.skipped += 1; result.warnings.push(`young-marker:${entryName}`); return;
      }
      await context.afterPersistentUndoClaimGcHandleRead?.({ markerPath, marker });
      if (Date.now() >= deadline) { result.skipped += 1; result.truncated = true; return; }
      const afterStat = await handle.stat({ bigint: true });
      const stableHandle = afterStat.isFile() && !afterStat.isSymbolicLink() && afterStat.nlink === 1n
        && String(afterStat.dev) === String(beforeStat.dev) && String(afterStat.ino) === String(beforeStat.ino)
        && afterStat.size === beforeStat.size && afterStat.mtimeNs === beforeStat.mtimeNs && afterStat.ctimeNs === beforeStat.ctimeNs;
      if (!stableHandle) throw Object.assign(new Error('marker handle identity changed while reading'), { code: 'MARKER_CHANGED' });
      const expectedIdentity = { ...defaultIdentityFromStat(markerPath, afterStat), sha256: crypto.createHash('sha256').update(markerBytes).digest('hex') };
      await handle.close(); handle = null;
      if (Date.now() >= deadline) { result.skipped += 1; result.truncated = true; return; }
      let claim;
      try { claim = await workspaceRepository.retireUndoRecordClaim(root, marker.id); }
      catch (error) { result.skipped += 1; result.warnings.push(`journal-retire-failed:${entryName}:${error?.message || String(error)}`); return; }
      if (claim?.retired !== true) { result.skipped += 1; result.warnings.push(`journal-cas-retained:${entryName}`); return; }
      try {
        const shadow = await workspaceRepository.shadowRetireUndoRecord(root, marker.id);
        if (shadow?.retired !== true) throw new Error('core shadow did not acknowledge retired=true');
      }
      catch (error) { result.skipped += 1; result.warnings.push(`shadow-retire-failed:${entryName}:${error?.message || String(error)}`); return; }
      if (Date.now() >= deadline) {
        enqueuePersistentUndoPendingCleanup({ root, markerPath, entryName, expectedIdentity });
        result.skipped += 1; result.truncated = true; result.warnings.push(`deadline-after-retire:${entryName}`); return;
      }
      let deleteDeadlineExpired = false;
      let removed;
      try {
        removed = await removeOwnedPathIdentityBound(markerPath, expectedIdentity, { beforeQuarantineMove: async item => {
          await context.beforePersistentUndoClaimGcDelete?.(item);
          if (Date.now() >= deadline) {
            deleteDeadlineExpired = true;
            throw Object.assign(new Error('claim GC deadline expired before deletion'), { code: 'GC_DEADLINE_EXPIRED' });
          }
        } });
      } catch (error) {
        if (!deleteDeadlineExpired) throw error;
        enqueuePersistentUndoPendingCleanup({ root, markerPath, entryName, expectedIdentity });
        result.skipped += 1; result.truncated = true; result.warnings.push(`delete-deadline:${entryName}`); return;
      }
      if (deleteDeadlineExpired) result.truncated = true;
      if (removed.success) result.removed += 1;
      else { result.skipped += 1; result.warnings.push(`${removed.code || 'cleanup-failed'}:${entryName}`); }
    } catch (error) {
      result.skipped += 1; result.warnings.push(`${error?.code || 'invalid-marker'}:${entryName}`);
    } finally { await handle?.close().catch(() => undefined); }
  };
  const schedulePersistentUndoPendingCleanupRetry = root => {
    const rootKey = comparablePath(root);
    if (persistentUndoPendingCleanupTimers.has(rootKey) || persistentUndoPendingCleanupRetryRunning.has(rootKey)) return;
    const attempt = (persistentUndoPendingCleanupAttempts.get(rootKey) || 0) + 1;
    if (attempt > persistentUndoPendingCleanupMaxAttempts) {
      while (persistentUndoPendingCleanupRescanNeeded.size >= persistentUndoPendingCleanupCapacity) persistentUndoPendingCleanupRescanNeeded.delete(persistentUndoPendingCleanupRescanNeeded.values().next().value);
      persistentUndoPendingCleanupRescanNeeded.add(rootKey); return;
    }
    persistentUndoPendingCleanupAttempts.set(rootKey, attempt);
    context.onPersistentUndoPendingCleanupSchedule?.({ root, attempt });
    const delayMs = persistentUndoPendingCleanupBaseDelayMs * (2 ** (attempt - 1));
    const timer = setTimeout(async () => {
      persistentUndoPendingCleanupTimers.delete(rootKey);
      persistentUndoPendingCleanupRetryRunning.add(rootKey);
      let cursorBusy = false;
      try {
        for (const cursorMap of [persistentUndoV2Cursors, persistentUndoLegacyCursors]) {
          const state = cursorMap.get(rootKey);
          if (state?.running) { state.retryPending = true; cursorBusy = true; break; }
          if (state) { cursorMap.delete(rootKey); await state.directory?.close().catch(() => undefined); }
        }
        if (!cursorBusy) {
          try { await runPersistentUndoClaimGc(root, { continuation: true, pendingRetry: true }); }
          catch (error) { writeLog('warn', 'Persistent undo pending cleanup retry failed', { workspaceRoot: root, error: error?.message || String(error) }); }
        }
      } finally {
        persistentUndoPendingCleanupRetryRunning.delete(rootKey);
        if (cursorBusy) persistentUndoPendingCleanupAttempts.set(rootKey, Math.max(0, attempt - 1));
      }
      if (!cursorBusy && [...persistentUndoPendingCleanups.values()].some(pending => comparablePath(pending.root) === rootKey)
          && !persistentUndoPendingCleanupTimers.has(rootKey) && !persistentUndoPendingCleanupRescanNeeded.has(rootKey)) schedulePersistentUndoPendingCleanupRetry(root);
    }, delayMs);
    persistentUndoPendingCleanupTimers.set(rootKey, timer);
  };
  const enqueuePersistentUndoPendingCleanup = pending => {
    const key = comparablePath(pending.markerPath);
    const rootKey = comparablePath(pending.root);
    for (const cursorMap of [persistentUndoV2Cursors, persistentUndoLegacyCursors]) {
      const state = cursorMap.get(rootKey);
      if (!state) continue;
      cursorMap.delete(rootKey); state.cancelled = true;
      if (!state.running) state.directory?.close().catch(() => undefined);
    }
    if (!persistentUndoPendingCleanups.has(key) && persistentUndoPendingCleanups.size >= persistentUndoPendingCleanupCapacity) {
      const [evictedKey, evicted] = persistentUndoPendingCleanups.entries().next().value;
      persistentUndoPendingCleanups.delete(evictedKey);
      schedulePersistentUndoPendingCleanupRetry(evicted.root);
    }
    persistentUndoPendingCleanups.set(key, pending);
    schedulePersistentUndoPendingCleanupRetry(pending.root);
  };
  const processPersistentUndoPendingCleanups = async ({ root, result, deadline }) => {
    for (const [key, pending] of [...persistentUndoPendingCleanups]) {
      if (comparablePath(pending.root) !== comparablePath(root)) continue;
      if (Date.now() >= deadline || result.checked >= persistentUndoClaimScanLimit) { result.truncated = true; break; }
      persistentUndoPendingCleanups.delete(key);
      result.checked += 1;
      let deadlineExpired = false;
      let removed;
      try {
        removed = await removeOwnedPathIdentityBound(pending.markerPath, pending.expectedIdentity, { beforeQuarantineMove: async item => {
          await context.beforePersistentUndoClaimGcDelete?.(item);
          if (Date.now() >= deadline) { deadlineExpired = true; throw Object.assign(new Error('claim GC deadline expired before pending deletion'), { code: 'GC_DEADLINE_EXPIRED' }); }
        } });
      } catch (error) {
        if (!deadlineExpired) { result.skipped += 1; result.warnings.push(`${error?.code || 'pending-cleanup-failed'}:${pending.entryName}`); continue; }
      }
      if (deadlineExpired) { enqueuePersistentUndoPendingCleanup(pending); result.truncated = true; result.skipped += 1; result.warnings.push(`pending-deadline:${pending.entryName}`); continue; }
      if (removed.success) result.removed += 1;
      else { result.skipped += 1; result.warnings.push(`${removed.code || 'pending-cleanup-failed'}:${pending.entryName}`); }
    }
    if (![...persistentUndoPendingCleanups.values()].some(pending => comparablePath(pending.root) === comparablePath(root))) {
      persistentUndoPendingCleanupAttempts.delete(comparablePath(root));
      persistentUndoPendingCleanupRescanNeeded.delete(comparablePath(root));
    }
  };
  const scheduleLegacyPersistentUndoClaimGcContinuation = root => {
    const key = comparablePath(root); const state = persistentUndoLegacyCursors.get(key);
    if (!state || state.scheduled) return;
    state.scheduled = true;
    setTimeout(() => {
      state.scheduled = false;
      if ([...persistentUndoPendingCleanups.values()].some(pending => comparablePath(pending.root) === key)) return;
      runPersistentUndoClaimGc(root, { continuation: true, skipV2: true }).then(result => {
        if (result.removed || result.warnings.length) writeLog(result.warnings.length ? 'warn' : 'info', 'Legacy persistent undo claim GC continued', { workspaceRoot: root, ...result });
      }).catch(error => writeLog('warn', 'Legacy persistent undo claim GC continuation failed', { workspaceRoot: root, error: error?.message || String(error) }));
    }, 0);
  };
  const scheduleV2PersistentUndoClaimGcContinuation = root => {
    const key = comparablePath(root); const state = persistentUndoV2Cursors.get(key);
    if (!state || state.scheduled) return;
    state.scheduled = true;
    setTimeout(() => {
      state.scheduled = false;
      if ([...persistentUndoPendingCleanups.values()].some(pending => comparablePath(pending.root) === key)) return;
      runPersistentUndoClaimGc(root, { continuation: true }).then(result => {
        if (result.removed || result.warnings.length) writeLog(result.warnings.length ? 'warn' : 'info', 'Persistent undo claim GC continued', { workspaceRoot: root, ...result });
      }).catch(error => writeLog('warn', 'Persistent undo claim GC continuation failed', { workspaceRoot: root, error: error?.message || String(error) }));
    }, 0);
  };
  const scanV2PersistentUndoClaims = async ({ root, workspaceId, claimDirectory, result, deadline, now }) => {
    const key = comparablePath(root);
    let state = persistentUndoV2Cursors.get(key);
    if (!state) {
      state = { directory: await fs.promises.opendir(claimDirectory), directoryPath: claimDirectory, scheduled: false, running: false };
      persistentUndoV2Cursors.set(key, state);
    }
    if (state.directoryPath !== claimDirectory) throw new Error('claim directory identity changed during continuation');
    if (state.running) { result.truncated = true; return; }
    state.running = true;
    let eof = false;
    let failed = false;
    try {
      while (result.visited < persistentUndoClaimMaxVisitedEntries && result.checked < persistentUndoClaimScanLimit && Date.now() < deadline) {
        const entry = await state.directory.read();
        if (!entry) { eof = true; break; }
        result.visited += 1;
        await processPersistentUndoClaimGcCandidate({ root, workspaceId, markerPath: path.join(claimDirectory, entry.name), entryName: entry.name, schema: 2, result, deadline, now });
      }
    } catch (error) { failed = true; throw error; }
    finally {
      state.running = false;
      const retryPending = state.retryPending === true; state.retryPending = false;
      if (eof || failed || state.cancelled) {
        persistentUndoV2Cursors.delete(key);
        await state.directory.close().catch(error => { if (error?.code !== 'ERR_DIR_CLOSED') result.warnings.push(`scan-close-failed:${error?.message || String(error)}`); });
      } else {
        result.truncated = true;
        scheduleV2PersistentUndoClaimGcContinuation(root);
      }
      if (retryPending && [...persistentUndoPendingCleanups.values()].some(pending => comparablePath(pending.root) === key)) schedulePersistentUndoPendingCleanupRetry(root);
    }
  };
  const scanLegacyPersistentUndoClaims = async ({ root, workspaceId, result, deadline, now }) => {
    const key = comparablePath(root);
    let state = persistentUndoLegacyCursors.get(key);
    if (!state) {
      state = { directory: await fs.promises.opendir(root), scheduled: false, running: false };
      persistentUndoLegacyCursors.set(key, state);
    }
    if (state.running) { result.truncated = true; return; }
    state.running = true;
    let eof = false;
    let failed = false;
    try {
      while (result.visited < persistentUndoClaimMaxVisitedEntries && result.checked < persistentUndoClaimScanLimit && Date.now() < deadline) {
        const entry = await state.directory.read();
        if (!entry) { eof = true; break; }
        result.visited += 1;
        if (!entry.name.startsWith(persistentUndoClaimPrefix)) continue;
        await processPersistentUndoClaimGcCandidate({ root, workspaceId, markerPath: path.join(root, entry.name), entryName: entry.name, schema: 1, result, deadline, now });
      }
    } catch (error) { failed = true; throw error; }
    finally {
      state.running = false;
      const retryPending = state.retryPending === true; state.retryPending = false;
      if (eof || failed || state.cancelled) {
        persistentUndoLegacyCursors.delete(key);
        await state.directory.close().catch(error => { if (error?.code !== 'ERR_DIR_CLOSED') result.warnings.push(`scan-close-failed:${error?.message || String(error)}`); });
      } else {
        result.truncated = true;
        scheduleLegacyPersistentUndoClaimGcContinuation(root);
      }
      if (retryPending && [...persistentUndoPendingCleanups.values()].some(pending => comparablePath(pending.root) === key)) schedulePersistentUndoPendingCleanupRetry(root);
    }
  };
  const cleanupPersistentUndoGcRoot = async rootKey => {
    for (const cursorMap of [persistentUndoV2Cursors, persistentUndoLegacyCursors]) {
      const state = cursorMap.get(rootKey);
      if (!state) continue;
      cursorMap.delete(rootKey); state.cancelled = true;
      if (!state.running) await state.directory?.close().catch(() => undefined);
    }
    for (const [key, pending] of persistentUndoPendingCleanups) if (comparablePath(pending.root) === rootKey) persistentUndoPendingCleanups.delete(key);
    const timer = persistentUndoPendingCleanupTimers.get(rootKey); if (timer) clearTimeout(timer);
    persistentUndoPendingCleanupTimers.delete(rootKey); persistentUndoPendingCleanupRetryRunning.delete(rootKey); persistentUndoPendingCleanupAttempts.delete(rootKey);
    persistentUndoClaimLastScans.delete(rootKey); persistentUndoPendingCleanupRescanNeeded.delete(rootKey);
  };
  const knownCanonicalRootKey = requestedKey => {
    const entry = persistentUndoRequestedCanonicalRoots.get(requestedKey);
    if (!entry) return '';
    if (entry.expiresAt <= Date.now()) { persistentUndoRequestedCanonicalRoots.delete(requestedKey); return ''; }
    return entry.canonicalKey;
  };
  const rememberCanonicalRootKey = (requestedKey, canonicalKey) => {
    const now = Date.now();
    for (const [key, entry] of persistentUndoRequestedCanonicalRoots) if (entry.expiresAt <= now) persistentUndoRequestedCanonicalRoots.delete(key);
    if (!persistentUndoRequestedCanonicalRoots.has(requestedKey)) while (persistentUndoRequestedCanonicalRoots.size >= persistentUndoRequestedCanonicalCapacity) persistentUndoRequestedCanonicalRoots.delete(persistentUndoRequestedCanonicalRoots.keys().next().value);
    persistentUndoRequestedCanonicalRoots.set(requestedKey, { canonicalKey, expiresAt: now + persistentUndoRequestedCanonicalTtlMs });
  };
  const runPersistentUndoClaimGc = async (workspaceRoot, options = {}) => {
    const result = { checked: 0, removed: 0, skipped: 0, warnings: [], visited: 0 };
    const startedAt = Date.now();
    const deadline = startedAt + persistentUndoClaimScanBudgetMs;
    const requestedRootKey = comparablePath(path.resolve(String(workspaceRoot || '')));
    const knownCanonicalKey = knownCanonicalRootKey(requestedRootKey);
    let root;
    try { root = await fs.promises.realpath(path.resolve(String(workspaceRoot || ''))); }
    catch (error) {
      await cleanupPersistentUndoGcRoot(requestedRootKey);
      if (knownCanonicalKey && knownCanonicalKey !== requestedRootKey) await cleanupPersistentUndoGcRoot(knownCanonicalKey);
      for (const key of [requestedRootKey, knownCanonicalKey].filter(Boolean)) {
        while (persistentUndoPendingCleanupRescanNeeded.size >= persistentUndoPendingCleanupCapacity) persistentUndoPendingCleanupRescanNeeded.delete(persistentUndoPendingCleanupRescanNeeded.values().next().value);
        persistentUndoPendingCleanupRescanNeeded.add(key);
      }
      result.warnings.push(`workspace-unavailable:${error?.code || error?.message || String(error)}`); return result;
    }
    const throttleKey = comparablePath(root);
    rememberCanonicalRootKey(requestedRootKey, throttleKey);
    const now = Number(context.persistentUndoClaimNowMs?.() ?? Date.now());
    const hasPendingCleanup = [...persistentUndoPendingCleanups.values()].some(pending => comparablePath(pending.root) === throttleKey);
    if (options.continuation && !options.pendingRetry && (hasPendingCleanup || persistentUndoPendingCleanupRescanNeeded.has(throttleKey) || persistentUndoPendingCleanupTimers.has(throttleKey))) { result.deferred = true; return result; }
    let forceRescan = false;
    if (!options.continuation) {
      const forcedCanonical = persistentUndoPendingCleanupRescanNeeded.delete(throttleKey);
      const forcedRequested = persistentUndoPendingCleanupRescanNeeded.delete(requestedRootKey);
      const forcedKnown = Boolean(knownCanonicalKey && persistentUndoPendingCleanupRescanNeeded.delete(knownCanonicalKey));
      forceRescan = forcedCanonical || forcedRequested || forcedKnown;
    }
    if (!options.continuation && !forceRescan && now - (persistentUndoClaimLastScans.get(throttleKey) || 0) < persistentUndoClaimThrottleMs) {
      result.skipped += 1; result.throttled = true; return result;
    }
    if (!options.continuation) persistentUndoClaimLastScans.set(throttleKey, now);
    let workspaceId;
    try { workspaceId = await readPersistentUndoWorkspaceId(root); }
    catch (error) { await cleanupPersistentUndoGcRoot(throttleKey); result.warnings.push(`workspace-id-unavailable:${error?.message || String(error)}`); return result; }
    await processPersistentUndoPendingCleanups({ root, result, deadline });
    if (!options.skipV2 && Date.now() < deadline) {
      let claimDirectory;
      try { claimDirectory = await persistentUndoClaimDirectory(root, false); }
      catch (error) { await cleanupPersistentUndoGcRoot(throttleKey); result.warnings.push(`claim-directory-unsafe:${error?.message || String(error)}`); return result; }
      if (claimDirectory) {
        try {
          await scanV2PersistentUndoClaims({ root, workspaceId, claimDirectory, result, deadline, now });
        } catch (error) { result.warnings.push(`scan-v2-failed:${error?.message || String(error)}`); }
      }
    }
    if (!options.skipLegacy && Date.now() < deadline && result.checked < persistentUndoClaimScanLimit && result.visited < persistentUndoClaimMaxVisitedEntries) {
      try { await scanLegacyPersistentUndoClaims({ root, workspaceId, result, deadline, now }); }
      catch (error) { result.warnings.push(`scan-legacy-failed:${error?.message || String(error)}`); }
    }
    if (![...persistentUndoPendingCleanups.values()].some(pending => comparablePath(pending.root) === throttleKey)) persistentUndoPendingCleanupAttempts.delete(throttleKey);
    return result;
  };
  const schedulePersistentUndoClaimGc = workspaceRoot => {
    const requestedKey = comparablePath(path.resolve(String(workspaceRoot || '')));
    const key = knownCanonicalRootKey(requestedKey) || requestedKey;
    if (persistentUndoGcScheduled.has(key) || persistentUndoGcRunning.has(key)) return;
    persistentUndoGcScheduled.add(key);
    setTimeout(() => {
      persistentUndoGcScheduled.delete(key); persistentUndoGcRunning.add(key);
      runPersistentUndoClaimGc(workspaceRoot).then(result => {
        if (result.removed || result.warnings.length) writeLog(result.warnings.length ? 'warn' : 'info', 'Persistent undo claim GC completed', { workspaceRoot, ...result });
      }).catch(error => writeLog('warn', 'Persistent undo claim GC failed', { workspaceRoot, error: error?.message || String(error) }))
        .finally(() => persistentUndoGcRunning.delete(key));
    }, 0);
  };
  const pruneBlockedPersistentUndos = () => {
    const now = Date.now();
    for (const [key, entry] of blockedPersistentUndos) if (entry.markedUnavailable && entry.expiresAt <= now) blockedPersistentUndos.delete(key);
    while (blockedPersistentUndos.size > blockedPersistentUndoCapacity) {
      const removable = [...blockedPersistentUndos.entries()].find(([, entry]) => entry.markedUnavailable);
      if (!removable) { persistentUndoQuarantineOverflow = true; break; }
      blockedPersistentUndos.delete(removable[0]);
    }
  };
  const blockPersistentUndo = (operation, error) => {
    if (!operation?.persistentId || !operation?.workspaceRoot) return null;
    pruneBlockedPersistentUndos();
    const key = persistentUndoKey(operation.workspaceRoot, operation.persistentId);
    let entry = blockedPersistentUndos.get(key);
    if (!entry) {
      const unpersistedCount = [...blockedPersistentUndos.values()].filter(candidate => !candidate.markedUnavailable).length;
      if (unpersistedCount >= blockedPersistentUndoCapacity) {
        persistentUndoQuarantineOverflow = true;
        return { key, operation, error, markedUnavailable: false, overflow: true, expiresAt: Number.POSITIVE_INFINITY };
      }
      entry = { key, operation, error, markedUnavailable: false };
    }
    entry.error = error;
    entry.expiresAt = entry.markedUnavailable ? Date.now() + blockedPersistentUndoTtlMs : Number.POSITIVE_INFINITY;
    blockedPersistentUndos.set(key, entry);
    return entry;
  };
  const retryMarkPersistentUndoUnavailable = async entry => {
    if (!entry || entry.markedUnavailable) return true;
    let lastError;
    for (const delay of [0, 25, 75]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await workspaceRepository.markUndoRecordUnavailable(entry.operation.workspaceRoot, entry.operation.persistentId);
        entry.markedUnavailable = true;
        const workspaceRoot = entry.operation.workspaceRoot;
        const persistentId = entry.operation.persistentId;
        entry.operation = { workspaceRoot, persistentId };
        entry.error = Object.assign(new Error('该持久撤销记录已标记为不可用，不能再次执行'), { code: 'UNDO_RECORD_UNAVAILABLE', recoveryRequired: true });
        entry.expiresAt = Date.now() + blockedPersistentUndoTtlMs;
        if (entry.key) blockedPersistentUndos.set(entry.key, entry);
        pruneBlockedPersistentUndos();
        return true;
      } catch (error) { lastError = error; }
    }
    const warning = `无法持久标记撤销记录为不可用：${lastError?.message || String(lastError)}`;
    if (!String(entry.error.cleanupWarning || '').includes(warning)) entry.error.cleanupWarning = [entry.error.cleanupWarning, warning].filter(Boolean).join('；');
    entry.expiresAt = Number.POSITIVE_INFINITY;
    return false;
  };
  const decisionTtlMs = 10 * 60 * 1000;
  const pruneRestoreDecisionTokens = () => {
    const now = Date.now();
    for (const [token, decision] of restoreDecisionTokens) if (decision.expiresAt <= now) restoreDecisionTokens.delete(token);
    while (restoreDecisionTokens.size > 64) restoreDecisionTokens.delete(restoreDecisionTokens.keys().next().value);
  };
  const pathIsInside = (root, candidate) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const deferredInterruptedTrimTasks = [];
  for (const task of backgroundTasks?.list?.() || []) {
    if (task.type !== 'video-trim' || task.state !== 'interrupted') continue;
    const generatedPath = String(task.metadata?.generatedPath || '');
    const sourcePath = String(task.metadata?.sourcePath || '');
    if (!generatedPath || !sourcePath || comparablePath(generatedPath) === comparablePath(sourcePath)) continue;
    const generated = path.resolve(generatedPath);
    const source = path.resolve(sourcePath);
    const generatedName = path.basename(generated);
    const sourceParts = path.parse(source);
    const saveMode = task.metadata?.saveMode === 'replace' ? 'replace' : 'new';
    let projectRoot = '';
    try {
      projectRoot = path.resolve(getProjectPath(task.metadata?.workspacePath, task.metadata?.projectStatus, task.metadata?.projectName));
    } catch { deferredInterruptedTrimTasks.push(task); /* retry only after this workspace catalog is loaded */ }
    const validLocation = comparablePath(path.dirname(generated)) === comparablePath(path.dirname(source))
      || Boolean(projectRoot && pathIsInside(projectRoot, generated));
    const validName = path.extname(generated).toLocaleLowerCase() === sourceParts.ext.toLocaleLowerCase()
      && (saveMode === 'replace' ? generatedName.startsWith('.photoflow-trim-output-') : path.parse(generatedName).name.startsWith(`${sourceParts.name}_剪辑`));
    if (!validLocation || !validName) {
      writeLog('warn', 'Skipped unsafe interrupted video trim cleanup path', { generatedPath: generated, sourcePath: source, taskId: task.id });
      continue;
    }
    void (async () => {
      const identity = await captureIdentity(generated);
      if (!await identityMatches(generated, identity)) throw new Error('中断的视频输出在清理前已被替换');
      await fs.promises.rm(generated, { force: true });
    })().catch(error => writeLog('warn', 'Unable to clean interrupted video trim output', { generatedPath, error: error.message || String(error) }));
  }
  const retryDeferredInterruptedTrimCleanup = async workspaceRoot => {
    for (let index = deferredInterruptedTrimTasks.length - 1; index >= 0; index -= 1) {
      const task = deferredInterruptedTrimTasks[index];
      if (comparablePath(task.metadata?.workspacePath || '') !== comparablePath(workspaceRoot)) continue;
      let projectRoot;
      try { projectRoot = path.resolve(getProjectPath(task.metadata.workspacePath, task.metadata.projectStatus, task.metadata.projectName)); }
      catch { continue; }
      const generated = path.resolve(String(task.metadata?.generatedPath || ''));
      const source = path.resolve(String(task.metadata?.sourcePath || ''));
      const validLocation = comparablePath(path.dirname(generated)) === comparablePath(path.dirname(source)) || pathIsInside(projectRoot, generated);
      if (!validLocation || !fs.existsSync(generated)) { deferredInterruptedTrimTasks.splice(index, 1); continue; }
      try {
        const identity = await captureIdentity(generated);
        if (!await identityMatches(generated, identity)) throw new Error('中断的视频输出在延迟清理前已被替换');
        await fs.promises.rm(generated, { force: true });
        deferredInterruptedTrimTasks.splice(index, 1);
      } catch (error) { writeLog('warn', 'Unable to clean deferred interrupted video trim output', { generatedPath: generated, error: error.message || String(error) }); }
    }
  };
  const virtualPaths = projectVirtualPaths || createProjectVirtualPathService();
  const shortcutSourceChannel = shortcutPath => {
    if (!shell?.readShortcutLink) return undefined;
    try {
      const description = String(shell.readShortcutLink(shortcutPath)?.description || '').trim();
      return description.startsWith('灵感库：') ? 'inspiration' : undefined;
    } catch { return undefined; }
  };
  const resolveToolSource = (rootValue, relativePath) => {
    const root = path.resolve(rootValue);
    try {
      const resolved = virtualPaths.resolve(root, relativePath);
      if (path.extname(resolved.physicalPath).toLowerCase() !== '.lnk') return resolved;
      throw new Error('Resolve inspiration shortcut target');
    } catch (managedError) {
      const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const segments = normalized ? normalized.split('/') : [];
      if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) throw managedError;
      const shortcutIndex = segments.findIndex(segment => path.extname(segment).toLowerCase() === '.lnk');
      if (shortcutIndex < 0) throw managedError;
      const shortcutVirtualPath = segments.slice(0, shortcutIndex + 1).join('/');
      const shortcutPath = assertExistingInside(root, path.resolve(root, ...segments.slice(0, shortcutIndex + 1)), '灵感库快捷方式');
      if (shortcutSourceChannel(shortcutPath) !== 'inspiration') throw managedError;
      const details = shell.readShortcutLink(shortcutPath);
      const target = details?.target ? path.resolve(String(details.target)) : '';
      if (!target || !fs.existsSync(target)) throw Object.assign(new Error('灵感库快捷方式目标当前不可用'), { code: 'EXTERNAL_LINK_OFFLINE' });
      const targetStat = fs.statSync(target);
      const childSegments = segments.slice(shortcutIndex + 1);
      if (targetStat.isFile()) {
        if (childSegments.length) throw new Error('灵感库文件快捷方式不能包含子路径');
        const physicalPath = fs.realpathSync(target);
        return {
          projectRoot: root, virtualPath: normalized, physicalPath, mediaRoot: path.dirname(physicalPath),
          shortcutPath, shortcutVirtualPath, externalTargetRoot: physicalPath, externalTargetKind: 'file',
          externalDisplayName: path.basename(shortcutPath, path.extname(shortcutPath)), viaExternalLink: true,
          viaInspirationShortcut: true, isExternalLinkRoot: true, writable: true, offline: false,
        };
      }
      if (!targetStat.isDirectory()) throw new Error('灵感库快捷方式目标类型不受支持');
      const externalTargetRoot = fs.realpathSync(target);
      const requestedPath = assertInside(externalTargetRoot, path.resolve(externalTargetRoot, ...childSegments), '灵感库快捷方式内容', true);
      if (!fs.existsSync(requestedPath)) throw Object.assign(new Error('灵感库快捷方式中的文件或文件夹不存在'), { code: 'ENOENT' });
      const physicalPath = fs.realpathSync(requestedPath);
      assertInside(externalTargetRoot, physicalPath, '灵感库快捷方式内容', true);
      return {
        projectRoot: root, virtualPath: normalized, physicalPath, mediaRoot: externalTargetRoot,
        shortcutPath, shortcutVirtualPath, externalTargetRoot, externalTargetKind: 'folder',
        externalDisplayName: path.basename(shortcutPath, path.extname(shortcutPath)), viaExternalLink: true,
        viaInspirationShortcut: true, isExternalLinkRoot: childSegments.length === 0, writable: true, offline: false,
      };
    }
  };
  const notifyComponentArtifactRelocation = async () => [];
  const { selectWorkspaceForWrite } = createWorkspaceStoragePolicy({ fs, path, ensureWorkspace });
  const {
    acknowledgeImportReceipt, canonicalImportManifestKey, commitImportManifest, importStagingRoots, inspectImportReceipt,
    receiptLocationsForSession, validateImportReceiptManifest,
  } = createImportReceiptService({ crypto, fs, path, pathExists, versionService });
  const isValidProjectStatus = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 24 && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const availableProjectStatuses = catalog => {
    const values = [...WORKSPACE_STATUSES, ...((catalog?.projects || []).map(project => project.status))];
    const seen = new Set();
    return values.filter(status => {
      if (!isValidProjectStatus(status)) return false;
      const key = status.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const isInternalFileOperationEntry = isInternalWorkspacePathSegment;
  const officeOpenXmlExtensions = new Set([
    '.docx', '.docm', '.dotx', '.dotm',
    '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppam',
    '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlam', '.xlsb',
  ]);
  const screenshotMainImageExtensions = new Set(['.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
  const missingProjectRetentionMs = 30 * 24 * 60 * 60 * 1000;
  const activeVideoTrimOperations = new Map();
  const fileListSessionExpiredCode = 'FILE_LIST_SESSION_EXPIRED';
  const fileListCancelledCode = 'FILE_LIST_CANCELLED';
  const fileListSessions = new Map();
  const fileListCursorLocks = new Map();
  const cancelledFileListCursors = new Map();
  const progressImportConflictCache = new Map();
  const workspaceMaintenanceScheduledAt = new Map();
  const workspaceMaintenanceCooldownMs = 24 * 60 * 60 * 1000;
  const acquireCursorLock = async (locks, cursor) => {
    if (!cursor) return () => undefined;
    const previous = locks.get(cursor);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    locks.set(cursor, gate);
    if (previous) await previous;
    return () => { release(); if (locks.get(cursor) === gate) locks.delete(cursor); };
  };
  const watchedProjectFileRoots = new Map();
  const watchedProjectFileRootHealth = new Map();
  const watchedProjectFileRootKey = (workspaceRoot, status, projectName) => `${process.platform === 'win32' ? path.resolve(workspaceRoot).toLocaleLowerCase() : path.resolve(workspaceRoot)}\0${String(status)}\0${process.platform === 'win32' ? String(projectName).toLocaleLowerCase() : String(projectName)}`;
  const externalTrackingChangeHandler = (publishRoot, projectName) => entries => scheduleMediaTrackingScan(
    publishRoot,
    projectName,
    entries.map(entry => ({
      path: entry.sourcePath || path.join(publishRoot, entry.fileName), eventType: entry.eventType,
      kind: entry.kind, observedMtimeMs: entry.observedMtimeMs, observedSize: entry.observedSize,
    })),
  );
  const transientRenameErrorCodes = new Set(['EACCES', 'EBUSY', 'EPERM']);
  const renamePathWithRetry = async (source, destination) => {
    const retryDelays = [0, 80, 180, 360, 700];
    let lastError;
    for (const delay of retryDelays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await fs.promises.rename(source, destination);
        return;
      } catch (error) {
        lastError = error;
        if (!transientRenameErrorCodes.has(error?.code)) throw error;
      }
    }
    throw lastError;
  };
  const pruneFileListSessions = () => {
    const expiry = Date.now() - 10 * 60 * 1000;
    for (const [cursor, session] of fileListSessions) {
      if (session.touchedAt < expiry) fileListSessions.delete(cursor);
    }
    for (const [cursor, cancelledAt] of cancelledFileListCursors) {
      if (cancelledAt < expiry) cancelledFileListCursors.delete(cursor);
    }
  };
  const pruneProgressImportConflictCache = () => {
    const now = Date.now();
    for (const [key, entry] of progressImportConflictCache) {
      if (entry.expiresAt <= now) progressImportConflictCache.delete(key);
    }
    while (progressImportConflictCache.size > 32) progressImportConflictCache.delete(progressImportConflictCache.keys().next().value);
  };

  const { inspectDeletedProject, purgeConfirmedDeletedProject, purgeStaleMissingProject, queuePermanentProjectCleanup } = createDeletedProjectCleanup({
    backgroundTasks, fs, getWorkspaceDataRoot, path, pathExists, recycleBinService,
    renameHistory, setTimeout, thumbnailService, workspaceRepository, writeLog,
  });

  const queueWorkspaceMaintenance = root => {
    if (!workspaceMaintenanceRepository?.runMaintenance) return;
    const now = Date.now();
    if (now - (workspaceMaintenanceScheduledAt.get(root) || 0) < workspaceMaintenanceCooldownMs) return;
    workspaceMaintenanceScheduledAt.set(root, now);
    const run = () => backgroundTasks.run({
      type: 'workspace-database-maintenance',
      title: '维护项目数据库',
      dedupeKey: `workspace-database-maintenance:${root}`,
      cancellable: false,
      // The maintenance repository owns the real exclusive SQLite lease. Do
      // not reserve the presentation-level workspace resource while waiting or
      // running, otherwise foreground tasks queue behind background upkeep.
      resources: [],
      metadata: { root },
    }, async task => {
      task.report(10, '正在检查项目数据库');
      const result = await runWorkspaceMaintenanceWithRetry({ root, repository: workspaceMaintenanceRepository, task });
      task.report(100, '项目数据库维护完成');
      return result;
    }, run);
    const startWhenIdle = () => setTimeout(() => {
      void run().catch(error => {
        if (error?.code === 'DATABASE_PREEMPTED' || error?.code === 'TASK_CANCELLED') {
          startWhenIdle();
          return;
        }
        writeLog('warn', 'Workspace database maintenance deferred', { root, error: error.message || String(error) });
      });
    }, 15000);
    startWhenIdle();
  };

  const existingProjectInspectionCache = new Map();
  const cacheExistingProjectInspection = inspection => {
    const token = crypto.randomUUID();
    const now = Date.now();
    for (const [key, value] of existingProjectInspectionCache) {
      if (value.expiresAt <= now || existingProjectInspectionCache.size >= 32) existingProjectInspectionCache.delete(key);
    }
    existingProjectInspectionCache.set(token, { inspection, expiresAt: now + 10 * 60 * 1000 });
    return token;
  };
  const cachedExistingProjectInspection = async (token, sourcePath) => {
    const cached = existingProjectInspectionCache.get(String(token || ''));
    if (!cached || cached.expiresAt <= Date.now()) return null;
    const requestedSource = path.resolve(sourcePath);
    if (comparablePath(cached.inspection.sourcePath) !== comparablePath(requestedSource)) return null;
    const sourceStat = await fs.promises.stat(requestedSource).catch(() => null);
    if (!sourceStat?.isDirectory()) return null;
    existingProjectInspectionCache.delete(String(token));
    return cached.inspection;
  };

  ipcMain.handle('workspace-cleanup-deleted-projects', async (_event, workspacePath) => {
    try {
      const root = ensureWorkspace(workspacePath);
      await reconcileWorkspaceCatalog(root);
      const result = await workspaceRepository.listDeletedProjects(root);
      const deletedProjects = result.projects || [];
      const probeBatch = await recycleBinService.probeMany(deletedProjects.filter(project => !project.permanent && project.recyclePidl).map(project => project.recyclePidl));
      const probesByPidl = new Map((probeBatch.items || []).map(item => [item.pidl, item]));
      const outcomes = [];
      for (const project of deletedProjects) outcomes.push({ projectId: project.id, name: project.name, ...await purgeConfirmedDeletedProject(root, project, probesByPidl.get(project.recyclePidl)) });
      const staleMissing = await workspaceRepository.listMissingProjects(root, Date.now() - missingProjectRetentionMs);
      for (const project of staleMissing.projects || []) outcomes.push({ projectId: project.id, name: project.name, ...await purgeStaleMissingProject(root, project) });
      const cleanedCount = outcomes.filter(outcome => outcome.cleaned).length;
      const deferredCount = outcomes.filter(outcome => outcome.status === 'deferred').length;
      if (cleanedCount) await refreshWorkspaceCatalog(root);
      return { success: true, checkedCount: outcomes.length, cleanedCount, deferredCount, outcomes, ...(deferredCount ? { warning: `${deferredCount} 个长期离线项目已安全延迟清理，等待只读清理计划支持` } : {}) };
    } catch (error) {
      writeLog('error', 'Unable to clean deleted project data', error);
      return { success: false, checkedCount: 0, cleanedCount: 0, outcomes: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-projects', async (_event, workspacePath) => {
    try {
      const root = ensureWorkspace(workspacePath);
      schedulePersistentUndoClaimGc(root);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      await retryDeferredInterruptedTrimCleanup(root);
      watchWorkspace(root);
      void reconcileWorkspaceCatalog(root).catch(error => {
        writeLog('warn', 'Unable to reconcile workspace catalog after project-list read', { root, error: error.message || String(error) });
      });
      queueWorkspaceMaintenance(root);
      const statuses = availableProjectStatuses(catalog).map(status => {
        const onlineProjects = catalog.projects.filter(project => project.status === status && project.availability !== 'missing');
        const offlineArchivedProjects = catalog.projects.filter(project => {
          if (project.status !== status || project.availability !== 'missing') return false;
          try { return Boolean(JSON.parse(project.extra_json || '{}')?.archive?.path || JSON.parse(project.extra_json || '{}')?.importMode === 'reference'); }
          catch { return false; }
        });
        const projects = [...onlineProjects, ...offlineArchivedProjects]
          .map(project => {
            const projectPath = path.resolve(root, project.relative_path);
            let archive = null;
            try { archive = JSON.parse(project.extra_json || '{}')?.archive || null; } catch { /* malformed optional metadata is ignored */ }
            return {
              id: project.id,
              name: project.name,
              path: projectPath,
              status,
              updatedAt: fs.existsSync(projectPath) ? fs.statSync(projectPath).mtimeMs : project.updated_at,
              projectDate: readProjectDate(project),
              importMode: JSON.parse(project.extra_json || '{}').importMode,
              ordinaryFiles: JSON.parse(project.extra_json || '{}').ordinaryFiles === true,
              availability: project.availability || 'available',
              missingSince: project.missing_since || undefined,
              missingChecks: project.missing_checks || 0,
              archived: Boolean(archive?.path),
              archivePath: archive?.path || undefined,
              archiveVerifiedAt: archive?.verifiedAt || undefined,
              archiveBytes: archive?.bytes || undefined,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        return { status, projects };
      });
      return { success: true, root, statuses };
    } catch (error) {
      writeLog('error', 'Unable to load workspace projects', error);
      return { success: false, error: String(error), statuses: [] };
    }
  });

  ipcMain.handle('workspace-create-project', async (_event, workspacePath, date, name, options) => {
    let projectPath = '';
    let projectOwnership = null;
    let planningPath = '';
    let planningOwnership = null;
    let repositoryCommitted = false;
    try {
      const projectDate = normalizeProjectDate(date);
      const datePart = formatProjectDate(projectDate);
      const namePart = cleanProjectName(name || '');
      const projectName = [datePart, namePart].filter(Boolean).join(' ');
      if (!projectName) throw new Error('请至少填写日期或名称');
      const selectedWorkspace = await selectWorkspaceForWrite(workspacePath, options?.workspacePaths, 0);
      const root = selectedWorkspace.root;
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      if (catalog.byName.has(projectName.toLocaleLowerCase())) throw new Error('同名项目已存在');
      projectPath = plannedProjectPath(root, projectName);
      if (fs.existsSync(projectPath)) throw new Error('同名项目已存在');
      fs.mkdirSync(projectPath, { recursive: false });
      try { projectOwnership = { created: true, identity: await captureIdentity(projectPath) }; }
      catch (error) { throw Object.assign(new Error(`项目目录已创建但无法确认身份，请勿重试；恢复路径：${projectPath}`), { code: 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true, recoveryPath: projectPath }); }
      if (options?.createPlanningFolder !== false) {
        planningPath = path.join(projectPath, '策划');
        fs.mkdirSync(planningPath, { recursive: false });
        try { planningOwnership = { created: true, identity: await captureIdentity(planningPath) }; }
        catch (error) { throw Object.assign(new Error(`策划目录已创建但无法确认身份，请勿重试；恢复路径：${projectPath}`), { code: 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true, recoveryPath: projectPath }); }
        try { projectOwnership = { created: true, identity: await captureIdentity(projectPath) }; }
        catch (error) { throw Object.assign(new Error(`项目布局已创建但无法复核根目录身份，请勿重试；恢复路径：${projectPath}`), { code: 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true, recoveryPath: projectPath }); }
      }
      const addPayload = { name: projectName, status: '策划中', relativePath: path.relative(root, projectPath), extra: projectDate ? { projectDate } : {} };
      let mutation;
      const repositoryMutationAvailable = typeof workspaceRepository?.addProject === 'function';
      try {
        mutation = repositoryMutationAvailable
          ? await workspaceRepository.addProject(root, addPayload)
          : await mutateWorkspaceCatalog(root, 'addProject', addPayload);
      } catch (error) {
        const probe = await probeProjectMutation(root, projectName, row => row.status === '策划中' && path.normalize(row.relative_path || row.relativePath || projectName) === path.normalize(path.relative(root, projectPath)));
        if (probe.state === 'committed') mutation = probe.row;
        else if (probe.state === 'unknown') { repositoryCommitted = true; throw mutationOutcomeUnknownError(error); }
        else throw error;
      }
      repositoryCommitted = true;
      const refreshed = repositoryMutationAvailable ? await refreshAfterRepositoryCommit(root) : { catalog: mutation, catalogRefreshPending: false };
      const projectId = refreshed.catalog?.byName?.get(projectName.toLocaleLowerCase())?.id || mutation?.byName?.get?.(projectName.toLocaleLowerCase())?.id || mutation?.project?.id || mutation?.id;
      if (refreshed.catalogRefreshPending || !projectId) {
        scheduleCatalogReconcile(root);
        notifyProjectsChanged(root, 'project-create-catalog-pending');
        return { success: false, committed: true, catalogRefreshPending: true, errorCode: 'WORKSPACE_CATALOG_REFRESH_PENDING', error: '项目已创建，目录正在刷新；请勿重复创建，稍后从项目列表打开。', warning: refreshed.warning };
      }
      writeLog('info', 'Project created', { projectName, projectPath });
      telemetryService?.track('project_created', { planning_folder: options?.createPlanningFolder !== false });
      return { success: true, workspacePath: root, storageSwitched: selectedWorkspace.switched, project: { id: projectId, name: projectName, path: projectPath, workspacePath: root, status: '策划中', updatedAt: Date.now(), projectDate: projectDate || undefined }, catalogRefreshPending: false };
    } catch (error) {
      if (!repositoryCommitted) {
        let safeToRemoveCreatedLayout = Boolean(projectOwnership?.identity && await identityMatches(projectPath, projectOwnership.identity));
        if (safeToRemoveCreatedLayout && planningOwnership?.identity) {
          const [rootEntries, planningEntries, planningMatches] = await Promise.all([
            fs.promises.readdir(projectPath).catch(() => null), fs.promises.readdir(planningPath).catch(() => null), identityMatches(planningPath, planningOwnership.identity),
          ]);
          safeToRemoveCreatedLayout = Boolean(planningMatches && rootEntries?.length === 1 && rootEntries[0] === path.basename(planningPath) && planningEntries?.length === 0);
        } else if (safeToRemoveCreatedLayout) safeToRemoveCreatedLayout = (await fs.promises.readdir(projectPath).catch(() => ['unknown'])).length === 0;
        if (safeToRemoveCreatedLayout) {
          if (planningOwnership) await removeIfOwned(planningPath, planningOwnership).catch(cleanupError => writeLog('warn', 'Unable to clean failed planning folder creation', cleanupError));
          await removeIfOwned(projectPath, projectOwnership).catch(cleanupError => writeLog('warn', 'Unable to clean failed project creation', cleanupError));
        } else if (projectPath && fs.existsSync(projectPath)) writeLog('warn', 'Failed project creation layout gained unowned content; entire layout retained', { projectPath });
      }
      return { success: false, error: error.message || String(error), errorCode: error?.code || undefined, outcomeUnknown: Boolean(error?.outcomeUnknown), catalogReconcilePending: Boolean(error?.catalogReconcilePending) };
    }
  });

  const inspectExistingProject = async sourcePath => {
    const source = path.resolve(sourcePath);
    const sourceStat = await fs.promises.stat(source);
    if (!sourceStat.isDirectory()) throw new Error('请选择一个项目文件夹');
    const queue = [{ directory: source }];
    let fileCount = 0;
    let folderCount = 0;
    let totalBytes = 0;
    let truncated = false;
    while (queue.length) {
      const current = queue.shift();
      const entries = await fs.promises.readdir(current.directory, { withFileTypes: true });
      const filesToStat = [];
      for (const entry of entries) {
        if (fileCount + folderCount >= 100000) { truncated = true; queue.length = 0; break; }
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          folderCount += 1;
          queue.push({ directory: entryPath });
          continue;
        }
        if (!entry.isFile()) continue;
        fileCount += 1;
        filesToStat.push(entryPath);
      }
      let nextFileIndex = 0;
      await Promise.all(Array.from({ length: Math.min(16, filesToStat.length) }, async () => {
        while (nextFileIndex < filesToStat.length) {
          const entryPath = filesToStat[nextFileIndex++];
          const stat = await fs.promises.stat(entryPath);
          totalBytes += stat.size;
        }
      }));
    }
    return { sourcePath: source, name: path.basename(source), fileCount, folderCount, totalBytes, truncated };
  };

  ipcMain.handle('workspace-choose-existing-project', async () => {
    try {
      const choice = await dialog.showOpenDialog(mainWindow, localizeDialogOptions({ title: translateNative("native.ba101b418a48"), properties: ['openDirectory'] }));
      if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true };
      const inspection = await inspectExistingProject(choice.filePaths[0]);
      return { success: true, ...inspection, inspectionToken: cacheExistingProjectInspection(inspection) };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-inspect-existing-project', async (_event, sourcePath) => {
    try {
      const inspection = await inspectExistingProject(sourcePath);
      return { success: true, ...inspection, inspectionToken: cacheExistingProjectInspection(inspection) };
    }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  const importExistingProjectHandler = async (event, workspacePath, sourcePath, options = {}) => {
    const requestedOperationId = String(options.operationId || '');
    const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedOperationId)
      ? requestedOperationId : crypto.randomUUID();
    if (activeProjectFileOperations.has(operationId)) {
      return { success: false, operationId, error: '该项目接管 operationId 正在执行，请等待原任务完成', duplicateOperation: true };
    }
    const operationReservation = { operation: 'import-project', reserved: true };
    activeProjectFileOperations.set(operationId, operationReservation);
    let task = null;
    let job = { cancelled: false, finishing: false };
    let stagedPath = '';
    let projectPath = '';
    let catalogAdded = false;
    let projectOwnershipRebased = false;
    let rollbackCleanup = null;
    const publish = payload => task?.publish(payload);
    try {
      const mode = String(options.mode || '');
      if (!['copy', 'move', 'reference'].includes(mode)) throw new Error('请选择复制、移动或引用原位置');
      const inspection = await cachedExistingProjectInspection(options.inspectionToken, sourcePath) || await inspectExistingProject(sourcePath);
      const projectName = cleanProjectName(String(options.name || inspection.name || ''));
      if (!projectName) throw new Error('项目名称不能为空');
      if (mode === 'reference') {
        const root = ensureWorkspace(workspacePath);
        const catalog = await refreshWorkspaceCatalog(root);
        const source = await fs.promises.realpath(inspection.sourcePath);
        if (!(await fs.promises.stat(source)).isDirectory()) throw new Error('项目文件夹当前不可用');
        if (catalog.byName.has(projectName.toLocaleLowerCase())) throw new Error('同名项目已存在');
        const roots = [...new Set([root, ...(Array.isArray(options.workspacePaths) ? options.workspacePaths : [])].map(value => ensureWorkspace(value)))];
        for (const workspaceRoot of roots) {
          const workspaceCatalog = workspaceRoot === root ? catalog : await refreshWorkspaceCatalog(workspaceRoot);
          const inside = (parent, child) => { const rel = path.relative(parent, child); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
          if (inside(source, workspaceRoot)) throw new Error('不能把工作目录或其父目录作为项目引用');
          for (const row of workspaceCatalog.projects) {
            const registered = path.resolve(workspaceRoot, row.relative_path);
            const physical = fs.existsSync(registered) ? fs.realpathSync(registered) : registered;
            if (inside(physical, source) || inside(source, physical)) throw new Error('该文件夹与已登记项目重叠，请直接打开已有项目');
          }
        }
        const extra = { importedAt: Date.now(), importedFrom: source, importMode: mode, ordinaryFiles: true };
        let row;
        try {
          await mutateWorkspaceCatalog(root, 'addProject', { name: projectName, status: '策划中', relativePath: source, extra });
          row = workspaceCatalogs.get(root)?.byName.get(projectName.toLocaleLowerCase());
        } catch (error) {
          const probe = await probeProjectMutation(root, projectName, candidate => comparablePath(path.resolve(root, candidate.relative_path)) === comparablePath(source));
          if (probe.state === 'committed') row = probe.row;
          else if (probe.state === 'unknown') throw mutationOutcomeUnknownError(error);
          else throw error;
        }
        if (!row?.id) {
          scheduleCatalogReconcile(root);
          return { success: false, committed: true, catalogRefreshPending: true, error: '项目已登记，目录正在刷新；请勿重复添加，稍后从项目列表打开。' };
        }
        notifyProjectsChanged(root, 'project-imported');
        return { success: true, operationId, project: { id: row?.id, name: projectName, path: source, workspacePath: root, status: '策划中', updatedAt: Date.now(), importMode: mode, ordinaryFiles: true } };
      }
      const selectedWorkspace = await selectWorkspaceForWrite(workspacePath, options?.workspacePaths, inspection.totalBytes);
      const root = selectedWorkspace.root;
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      if (catalog.byName.has(projectName.toLocaleLowerCase())) throw new Error('同名项目已存在');
      projectPath = plannedProjectPath(root, projectName);
      if (fs.existsSync(projectPath)) throw new Error('同名项目已存在');
      const comparableProjectPath = comparablePath(projectPath);
      const comparableSourcePath = comparablePath(inspection.sourcePath);
      if (comparableProjectPath === comparableSourcePath || comparableProjectPath.startsWith(`${comparableSourcePath}${path.sep}`)) throw new Error('不能把项目导入到它自身内部');
      stagedPath = path.join(path.dirname(projectPath), `.photoflow-import-project-${operationId}`);
      if (fs.existsSync(stagedPath)) throw Object.assign(new Error('该接管任务的暂存路径已存在'), { code: 'EEXIST' });
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-project', title: `接管项目 · ${projectName}`,
        projectName, resources: [inspection.sourcePath, path.dirname(projectPath)], cancelledCode: CANCELLED_CODE,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeProjectFileOperations.set(operationId, job);
      await task.start();
      const plan = [];
      publish({ phase: 'scanning', progress: 0, currentName: '正在扫描已有项目', bytesCopied: 0, totalBytes: inspection.totalBytes, filesCopied: 0, totalFiles: inspection.fileCount });
      await collectCopyPlan(inspection.sourcePath, stagedPath, plan, { isCancelled: () => job.cancelled });
      const totalBytes = plan.reduce((sum, entry) => sum + entry.size, 0);
      const totalFiles = plan.filter(entry => entry.kind === 'file').length;
      await assertDiskSpace(path.dirname(projectPath), totalBytes);
      let bytesCopied = 0;
      let filesCopied = 0;
      let lastPublishedAt = 0;
      const report = (currentName, force = false) => {
        const now = Date.now();
        if (!force && now - lastPublishedAt < 150) return;
        lastPublishedAt = now;
        const progress = totalBytes > 0 ? Math.min(99, Math.round(bytesCopied / totalBytes * 100)) : Math.min(99, Math.round(filesCopied / Math.max(1, totalFiles) * 100));
        publish({ phase: 'copying', progress, currentName, bytesCopied, totalBytes, filesCopied, totalFiles });
      };
      report('', true);
      await copyPlannedFiles(plan, {
        destinationRoot: path.dirname(projectPath), diskSpaceChecked: true, durable: mode === 'move', isCancelled: () => job.cancelled,
        ownershipToken: operationId,
        onFileStart: entry => report(path.basename(entry.source)),
        onProgress: ({ entry, bytesDelta, fileCompleted }) => { bytesCopied += bytesDelta; if (fileCompleted) filesCopied += 1; report(path.basename(entry.source)); },
      });
      throwIfCancelled(() => job.cancelled);
      const originalStagedPath = stagedPath;
      const publishedProjectRoot = await publishPathNoClobber(originalStagedPath, projectPath, { ownershipToken: operationId });
      stagedPath = '';
      const publishedRootIdentity = { ...publishedProjectRoot.identity, ...(publishedProjectRoot.nativeIdentity ? { nativeIdentity: publishedProjectRoot.nativeIdentity } : {}) };
      const rebased = await rebaseCleanupOwnership(operationId, originalStagedPath, projectPath, { publishedRootIdentity });
      if (!rebased.success) throw Object.assign(new Error(`项目内容已发布，但 ownership ledger 无法完整映射；已保留恢复目录：${projectPath}`), { code: 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true, recoveryPath: projectPath, cleanupCode: rebased.code });
      projectOwnershipRebased = true;
      const addPayload = { name: projectName, status: '策划中', relativePath: path.relative(root, projectPath), extra: { importedAt: Date.now(), importedFrom: inspection.sourcePath, importMode: mode, ordinaryFiles: true } };
      let mutation;
      const repositoryMutationAvailable = typeof workspaceRepository?.addProject === 'function';
      try {
        mutation = repositoryMutationAvailable
          ? await workspaceRepository.addProject(root, addPayload)
          : await mutateWorkspaceCatalog(root, 'addProject', addPayload);
      } catch (error) {
        const probe = await probeProjectMutation(root, projectName, row => row.status === '策划中' && path.normalize(row.relative_path || row.relativePath || projectName) === path.normalize(path.relative(root, projectPath)));
        if (probe.state === 'committed') mutation = probe.row;
        else if (probe.state === 'unknown') { catalogAdded = true; throw mutationOutcomeUnknownError(error); }
        else throw error;
      }
      catalogAdded = true;
      const refreshed = repositoryMutationAvailable ? await refreshAfterRepositoryCommit(root) : { catalog: mutation, catalogRefreshPending: false };
      const projectId = refreshed.catalog?.byName?.get(projectName.toLocaleLowerCase())?.id || mutation?.byName?.get?.(projectName.toLocaleLowerCase())?.id || mutation?.project?.id || mutation?.id;
      if (refreshed.catalogRefreshPending || !projectId) {
        scheduleCatalogReconcile(root);
        await pushUndoOperation({ kind: 'remove-created', paths: [projectPath], label: '导入已有项目' }).catch(() => undefined);
        publish({ phase: 'complete', progress: 100, currentName: '项目已接管，目录正在刷新', bytesCopied: totalBytes, totalBytes, filesCopied: totalFiles, totalFiles });
        task.complete('项目已接管，目录正在刷新');
        notifyProjectsChanged(root, 'project-import-catalog-pending');
        return { success: false, committed: true, operationId, workspacePath: root, catalogRefreshPending: true, errorCode: 'WORKSPACE_CATALOG_REFRESH_PENDING', error: '项目已接管，目录正在刷新；请勿重复导入，稍后从项目列表打开。', warning: refreshed.warning };
      }
      let sourceRetained = false;
      if (mode === 'move') {
        job.finishing = true;
        publish({ phase: 'finishing', progress: 99, currentName: '正在移除已安全复制的源文件', bytesCopied, totalBytes, filesCopied, totalFiles });
        try {
          await removeCopiedSources(plan, {
            ownershipToken: operationId,
            onCleanupProgress: ({ processed, total }) => publish({ phase: 'finishing', progress: 99, currentName: `正在移除已安全复制的源文件 ${processed}/${total}`, bytesCopied, totalBytes, filesCopied, totalFiles }),
          });
        }
        catch (error) { sourceRetained = true; writeLog('warn', 'Imported project source retained after safe copy', { sourcePath: inspection.sourcePath, error: error.message || String(error) }); }
      }
      const project = { id: projectId, name: projectName, path: projectPath, workspacePath: root, status: '策划中', updatedAt: Date.now(), importMode: mode, ordinaryFiles: true };
      await pushUndoOperation(mode === 'move' && !sourceRetained
        ? { kind: 'external-move', moves: [{ source: inspection.sourcePath, destination: projectPath }] }
        : { kind: 'remove-created', paths: [projectPath], label: '导入已有项目' }).catch(error => writeLog('warn', 'Unable to record imported project undo', error));
      publish({ phase: 'complete', progress: 100, currentName: '项目接管完成', bytesCopied: totalBytes, totalBytes, filesCopied: totalFiles, totalFiles });
      task.complete('项目接管完成');
      notifyProjectsChanged(root, 'project-imported');
      return { success: true, operationId, project, workspacePath: root, storageSwitched: selectedWorkspace.switched, sourceRetained, catalogRefreshPending: false };
    } catch (error) {
      const cancelled = error?.code === CANCELLED_CODE;
      if (stagedPath) {
        const cleanup = await removeCreatedPasteTargets([stagedPath], { ownershipToken: operationId }).catch(cleanupError => ({ success: false, outcomes: [{ path: stagedPath, code: cleanupError?.code || 'CLEANUP_FAILED' }] }));
        rollbackCleanup = cleanup;
        if (!cleanup.success) writeLog('warn', 'Unable to prove complete ownership of failed import staging; recovery retained', { stagedPath, operationId, outcomes: cleanup.outcomes, recoveryPaths: cleanup.recoveryPaths });
        else if (cleanup.cleanupWarning || cleanup.outcomeUnknown) writeLog('warn', 'Failed import staging was deleted with uncertain cleanup durability', { stagedPath, operationId, cleanupWarning: cleanup.cleanupWarning, outcomeUnknown: cleanup.outcomeUnknown, deletedCleanupCount: cleanup.deletedCleanupCount, outcomes: cleanup.outcomes });
      }
      if (projectPath && !catalogAdded && projectOwnershipRebased) {
        const cleanup = await removeCreatedPasteTargets([projectPath], { ownershipToken: operationId }).catch(cleanupError => ({ success: false, outcomes: [{ path: projectPath, code: cleanupError?.code || 'CLEANUP_FAILED' }] }));
        rollbackCleanup = cleanup;
        if (!cleanup.success) writeLog('warn', 'Published failed import tree retained after ownership rebase conflict', { projectPath, operationId, outcomes: cleanup.outcomes, recoveryPaths: cleanup.recoveryPaths });
        else if (cleanup.cleanupWarning || cleanup.outcomeUnknown) writeLog('warn', 'Published failed import tree was deleted with uncertain cleanup durability', { projectPath, operationId, cleanupWarning: cleanup.cleanupWarning, outcomeUnknown: cleanup.outcomeUnknown, deletedCleanupCount: cleanup.deletedCleanupCount, outcomes: cleanup.outcomes });
      } else if (projectPath && !catalogAdded && fs.existsSync(projectPath)) writeLog('warn', 'Published failed import tree retained because complete ownership is unproven', { projectPath, operationId });
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, currentName: '', error: error.message || String(error) });
      if (cancelled) task?.cancelled(); else task?.fail(error);
      return { success: false, cancelled, operationId, error: cancelled ? '项目接管已取消' : error.message || String(error), errorCode: error?.code || undefined, outcomeUnknown: Boolean(error?.outcomeUnknown || rollbackCleanup?.outcomeUnknown), cleanupWarning: rollbackCleanup?.cleanupWarning, deletedCleanupCount: Number(rollbackCleanup?.deletedCleanupCount || 0), recoveryPaths: rollbackCleanup?.recoveryPaths || [], cleanupOutcomes: (rollbackCleanup?.outcomes || []).slice(0, 64), cleanupOutcomeCount: Number(rollbackCleanup?.cleanupOutcomeCount || 0), cleanupOutcomesTruncated: Boolean(rollbackCleanup?.cleanupOutcomesTruncated), catalogReconcilePending: Boolean(error?.catalogReconcilePending) };
    } finally {
      releaseCleanupOwnership(operationId);
      if (activeProjectFileOperations.get(operationId) === job || activeProjectFileOperations.get(operationId) === operationReservation) activeProjectFileOperations.delete(operationId);
    }
  };
  ipcMain.handle('workspace-import-existing-project', importExistingProjectHandler);

  ipcMain.handle('workspace-rename-project', async (_event, workspacePath, status, projectName, dateOrNextName, nextName) => {
    const operationId = crypto.randomUUID();
    const startedAt = Date.now();
    let stageStartedAt = startedAt;
    let stage = 'prepare';
    const markStage = next => {
      const now = Date.now();
      writeLog('info', 'Project rename phase', { operationId, stage, elapsedMs: now - stageStartedAt, totalMs: now - startedAt });
      stage = next;
      stageStartedAt = now;
    };
    let committedCatalog = null;
    let source = '';
    let destination = '';
    let suspendedWatcherToken = null;
    let renameCompleted = false;
    let repositoryCommitted = false;
    let destinationOwnership = null;
    let warning = '';
    let catalogRefreshPending = false;
    let watchPathsSuppressed = false;
    try {
      const legacyCall = typeof dateOrNextName === 'string' && nextName === undefined;
      const projectDate = legacyCall ? undefined : normalizeProjectDate(dateOrNextName);
      const cleanedName = legacyCall
        ? cleanProjectName(dateOrNextName)
        : [formatProjectDate(projectDate), cleanProjectName(nextName || '')].filter(Boolean).join(' ');
      if (!cleanedName) throw new Error('项目名称不能为空');
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      const existingProject = catalog.byName.get(cleanedName.toLocaleLowerCase());
      if (existingProject && existingProject.name.toLocaleLowerCase() !== projectName.toLocaleLowerCase()) throw new Error('同名项目已存在');
      const currentRow = catalog.byName.get(projectName.toLocaleLowerCase());
      if (JSON.parse(currentRow.extra_json || '{}').importMode === 'reference') {
        await mutateWorkspaceCatalog(root, 'renameProject', { name: projectName, nextName: cleanedName, relativePath: currentRow.relative_path, ...(legacyCall ? {} : { projectDate }) });
        notifyProjectsChanged(root, 'project-renamed');
        return { success: true, project: { id: currentRow.id, name: cleanedName, path: currentRow.relative_path, workspacePath: root, status, updatedAt: Date.now(), importMode: 'reference', ordinaryFiles: true, projectDate } };
      }
      source = getProjectPath(workspacePath, status, projectName);
      destination = path.join(path.dirname(source), cleanedName);
      if (!fs.existsSync(source)) throw new Error('项目不存在');
      if (cleanedName !== projectName) {
        if (fs.existsSync(destination)) throw new Error('同名项目已存在');
        cancelMediaTrackingScan(root, projectName);
        suppressWorkspaceWatchPath(source);
        suppressWorkspaceWatchPath(destination);
        watchPathsSuppressed = true;
        suspendedWatcherToken = typeof suspendFileRootWatcher === 'function' ? suspendFileRootWatcher(source) : null;
        markStage('filesystem-move');
        if (typeof context.publishPathNoClobber === 'function') await publishPathNoClobber(source, destination);
        else await renamePathWithRetry(source, destination);
        renameCompleted = true;
        try { destinationOwnership = { created: true, identity: await captureIdentity(destination) }; }
        catch (error) {
          scheduleCatalogReconcile(root);
          return { success: false, error: `项目文件夹已移动，但身份确认失败，请勿重试；后台正在核对目录。${error.message || String(error)}`, errorCode: 'WORKSPACE_MUTATION_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true };
        }
      }
      const previousProjectDate = readProjectDate(catalog.byName.get(projectName.toLocaleLowerCase()));
      markStage('database-rename');
      try {
        const renamePayload = { name: projectName, nextName: cleanedName, relativePath: path.relative(root, destination), ...(legacyCall ? {} : { projectDate }) };
        try {
          if (typeof workspaceRepository?.renameProject === 'function') committedCatalog = await workspaceRepository.renameProject(root, renamePayload);
          else await mutateWorkspaceCatalog(root, 'renameProject', renamePayload);
        } catch (error) {
          const probe = await probeProjectMutation(root, cleanedName, row => row.status === status && path.normalize(row.relative_path || row.relativePath || cleanedName) === path.normalize(path.relative(root, destination)));
          if (probe.state === 'committed') repositoryCommitted = true;
          else if (probe.state === 'unknown') return { success: false, error: mutationOutcomeUnknownError(error).message, errorCode: 'WORKSPACE_MUTATION_OUTCOME_UNKNOWN', outcomeUnknown: true, catalogReconcilePending: true };
          else throw error;
        }
        repositoryCommitted = true;
      } catch (error) {
        if (renameCompleted && !fs.existsSync(source)) {
          if (await identityMatches(destination, destinationOwnership.identity)) {
            try {
              if (typeof context.publishPathNoClobber === 'function') await publishPathNoClobber(destination, source);
              else await renamePathWithRetry(destination, source);
              renameCompleted = false;
            } catch (rollbackError) {
              writeLog('warn', 'Project rename database failure rollback is pending', { error: error.message || String(error), rollbackError: rollbackError.message || String(rollbackError) });
              return { success: false, error: error.message || String(error), outcomeUnknown: true, rollbackPending: true };
            }
          } else {
            return { success: false, error: error.message || String(error), outcomeUnknown: true, rollbackPending: true };
          }
        }
        throw error;
      }
      markStage('catalog-refresh');
      // The rename worker returns its committed catalog. Do not enqueue a
      // second database request behind background work merely to read it again.
      let refreshed;
      if (Array.isArray(committedCatalog?.projects)) {
        const projects = committedCatalog.projects;
        const nextCatalog = { projects, byName: new Map(projects.map(project => [project.name.toLocaleLowerCase(), project])) };
        workspaceCatalogs.set(root, nextCatalog);
        refreshed = { catalog: nextCatalog, catalogRefreshPending: false };
      } else {
        refreshed = await refreshAfterRepositoryCommit(root);
      }
      catalogRefreshPending = refreshed.catalogRefreshPending;
      warning = refreshed.warning || '';
      markStage('post-commit');
      if (cleanedName !== projectName) {
        await notifyComponentArtifactRelocation(root,
          { status, projectName },
          { status, projectName: cleanedName }).catch(error => {
            warning = warning || '项目已改名，但关联组件刷新失败';
            writeLog('warn', 'Project rename component relocation failed after commit', error);
          });
      }
      if (cleanedName !== projectName) await pushUndoOperation({ kind: 'project', source, destination, status, workspaceRoot: root, beforeName: projectName, afterName: cleanedName, beforeProjectDate: previousProjectDate, afterProjectDate: projectDate }).catch(error => {
        warning = warning || '项目已改名，但无法记录撤销操作';
        writeLog('warn', 'Unable to record project rename undo after commit', error);
      });
      return { success: true, project: { id: catalog.byName.get(projectName.toLocaleLowerCase())?.id, name: cleanedName, path: destination, status, updatedAt: Date.now(), projectDate: projectDate === undefined ? previousProjectDate : projectDate || undefined }, catalogRefreshPending, warning: warning || undefined };
    } catch (error) {
      if (suspendedWatcherToken && !renameCompleted && source && fs.existsSync(source) && typeof resumeFileRootWatcher === 'function') {
        resumeFileRootWatcher(source, suspendedWatcherToken);
      }
      const message = transientRenameErrorCodes.has(error?.code)
        ? 'Windows 暂时占用了项目文件夹，软件已暂停内部监听并多次重试。请关闭正在浏览该项目的资源管理器窗口或其他软件后再试。'
        : error.message || String(error);
      if (repositoryCommitted) return { success: true, warning: message, catalogRefreshPending: true };
      return { success: false, error: message };
    } finally {
      markStage('finished');
      if (watchPathsSuppressed) {
        releaseWorkspaceWatchPath(source);
        releaseWorkspaceWatchPath(destination);
      }
    }
  });

  ipcMain.handle('workspace-create-project-folder', async (_event, workspacePath, status, projectName, folderName, relativePath = '', makeUnique = false) => {
    let suppressedFolderPath = '';
    try {
      const cleanedName = cleanProjectName(folderName || '');
      if (!cleanedName) throw new Error('文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const parentResolution = virtualPaths.resolve(projectPath, relativePath, { externalRootMode: 'target' });
      const parentPath = parentResolution.physicalPath;
      if (!(await fs.promises.stat(parentPath).catch(() => null))?.isDirectory()) throw new Error('无效的文件夹位置');
      let actualName = cleanedName;
      let folderPath = path.resolve(parentPath, actualName);
      if (!folderPath.startsWith(parentPath + path.sep)) throw new Error('无效的文件夹名称');
      let index = 2;
      for (;;) {
        suppressWorkspaceWatchPath?.(folderPath);
        suppressedFolderPath = folderPath;
        try { await fs.promises.mkdir(folderPath); break; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!makeUnique) throw new Error('同名文件夹已存在');
          releaseWorkspaceWatchPath?.(suppressedFolderPath);
          suppressedFolderPath = '';
          actualName = `${cleanedName} (${index++})`;
          folderPath = path.resolve(parentPath, actualName);
        }
      }
      await pushUndoOperation({ kind: 'remove-created', paths: [folderPath], label: '新建文件夹' });
      return { success: true, folder: { name: actualName, path: folderPath, relativePath: [parentResolution.virtualPath, actualName].filter(Boolean).join('/'), updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    } finally {
      if (suppressedFolderPath) releaseWorkspaceWatchPath?.(suppressedFolderPath);
    }
  });

  ipcMain.handle('workspace-shell-new-types', async (_event, refresh = false) => {
    try {
      return { success: true, types: await shellNewService.list({ refresh, background: !refresh }) };
    } catch (error) {
      return { success: false, types: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-create-shell-new-file', async (_event, workspacePath, status, projectName, relativePath, typeId) => {
    let suppressedParentPath = '';
    try {
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const parentResolution = virtualPaths.resolve(projectPath, relativePath, { externalRootMode: 'target' });
      const parentPath = parentResolution.physicalPath;
      if (!(await fs.promises.stat(parentPath)).isDirectory()) throw new Error('新建文件位置不是文件夹');
      suppressWorkspaceWatchPath?.(parentPath);
      suppressedParentPath = parentPath;
      const created = await shellNewService.create(typeId, parentPath, uniqueDestination);
      await pushUndoOperation({ kind: 'remove-created', paths: [created.path], label: '新建文件' });
      return { success: true, file: { ...created, relativePath: [parentResolution.virtualPath, path.basename(created.path)].filter(Boolean).join('/'), updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    } finally {
      if (suppressedParentPath) releaseWorkspaceWatchPath?.(suppressedParentPath);
    }
  });

  ipcMain.handle('workspace-rename-project-folder', async (_event, workspacePath, status, projectName, folderName, nextName) => {
    try {
      const cleanedName = cleanProjectName(nextName || '');
      if (!cleanedName) throw new Error('文件夹名称不能为空');
      const projectPath = getProjectPath(workspacePath, status, projectName);
      const row = workspaceCatalogs.get(ensureWorkspace(workspacePath))?.byName.get(projectName.toLocaleLowerCase());
      const ordinaryFiles = JSON.parse(row?.extra_json || '{}').ordinaryFiles === true;
      const source = path.resolve(projectPath, folderName);
      const destination = path.resolve(projectPath, cleanedName);
      if (!source.startsWith(projectPath + path.sep) || !destination.startsWith(projectPath + path.sep)) throw new Error('无效的文件夹路径');
      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('文件夹不存在');
      if (!ordinaryFiles && isProtectedProjectFolderPath({ fs, path, projectRoot: projectPath, candidate: source })) {
        throw new Error('该文件夹由项目工作流管理，不能使用普通重命名');
      }
      if (!ordinaryFiles && isProtectedProjectFolderName(cleanedName)) throw new Error('该名称保留给项目工作流使用');
      if (fs.existsSync(destination)) throw new Error('同名文件夹已存在');
      await fs.promises.rename(source, destination);
      await pushUndoOperation({ kind: 'folder', source, destination, beforeName: folderName, afterName: cleanedName });
      return { success: true, folder: { name: cleanedName, path: destination, updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-undo-rename', async (_event, workspacePath = '', options = {}) => {
    let operation;
    let loadedFromJournal = false;
    let persistentClaimDescriptor;
    let persistentBoundRecord;
    let selectedDecisionOperation;
    try {
      pruneBlockedPersistentUndos();
      const requestedDecisionToken = String(options?.decisionToken || '');
      pruneRestoreDecisionTokens();
      const pendingDecision = requestedDecisionToken ? restoreDecisionTokens.get(requestedDecisionToken) : null;
      if (pendingDecision) {
        operation = pendingDecision.operation;
        const queuedIndex = renameHistory.lastIndexOf(operation);
        if (queuedIndex >= 0) renameHistory.splice(queuedIndex, 1);
      } else operation = renameHistory.pop();
      selectedDecisionOperation = operation;
      if (!operation && workspacePath) {
        const workspaceRoot = resolveWorkspaceRoot(workspacePath);
        schedulePersistentUndoClaimGc(workspaceRoot);
        const latest = await workspaceRepository.latestUndoRecord(workspaceRoot);
        if (latest.record) {
          operation = { kind: latest.record.kind, ...latest.record.payload, persistentId: latest.record.id, workspaceRoot };
          persistentBoundRecord = latest.record;
          loadedFromJournal = true;
        }
      }
      if (!operation) return { success: false, error: '没有可撤销的操作' };
      if (operation.persistentId && operation.workspaceRoot) {
        if (operation.kind === 'trash') {
          persistentClaimDescriptor = await persistentUndoClaimDescriptor(operation);
          const claimStatus = await persistentUndoClaimStatus(persistentClaimDescriptor);
          if (!claimStatus.complete) {
            return serializeUndoRecoveryError(pendingPersistentUndoError('旧版持久撤销 claim 扫描尚未完成；后台将继续检查，当前不会执行恢复'));
          }
          if (claimStatus.exists) {
            const pendingError = Object.assign(new Error('该持久撤销记录已有恢复 tombstone；当前进程不会探测、恢复或修改 journal'), {
              code: 'PERSISTENT_UNDO_RECOVERY_PENDING', recoveryRequired: true, rollbackPending: true,
            });
            const claimed = blockPersistentUndo(operation, pendingError);
            return serializeUndoRecoveryError(claimed.error);
          }
          if (!persistentBoundRecord) {
            const latest = await workspaceRepository.latestUndoRecord(operation.workspaceRoot);
            persistentBoundRecord = latest.record;
          }
          if (!persistentBoundRecord || persistentBoundRecord.id !== operation.persistentId
              || persistentBoundRecord.kind !== 'trash' || !/^[0-9a-f]{64}$/u.test(String(persistentBoundRecord.claimToken || ''))) {
            return serializeUndoRecoveryError(pendingPersistentUndoError('无法将持久撤销操作绑定到当前 ready journal 版本；不会执行恢复'));
          }
          if (requestedDecisionToken && pendingDecision
              && (pendingDecision.persistentId !== persistentBoundRecord.id
                || pendingDecision.claimToken !== persistentBoundRecord.claimToken
                || pendingDecision.workspaceKey !== comparablePath(persistentClaimDescriptor.workspaceRoot)
                || (workspacePath && pendingDecision.workspaceKey !== comparablePath(await fs.promises.realpath(resolveWorkspaceRoot(workspacePath)))))) {
            return serializeUndoRecoveryError(pendingPersistentUndoError('撤销决定绑定的 journal 版本或工作区已变化；旧决定不会被消费，当前不会执行恢复'));
          }
          operation = { kind: persistentBoundRecord.kind, ...persistentBoundRecord.payload, persistentId: persistentBoundRecord.id, workspaceRoot: operation.workspaceRoot };
        }
        const blocked = blockedPersistentUndos.get(persistentUndoKey(operation.workspaceRoot, operation.persistentId));
        if (blocked) {
          await retryMarkPersistentUndoUnavailable(blocked);
          return serializeUndoRecoveryError(blocked.error);
        }
        if (loadedFromJournal && persistentUndoQuarantineOverflow) {
          const overflowError = Object.assign(new Error('持久撤销安全隔离已达到容量上限；为避免重复恢复，当前记录已拒绝执行，请修复操作数据库后重试维护'), {
            code: 'PERSISTENT_UNDO_QUARANTINE_OVERFLOW', recoveryRequired: true, rollbackPending: true,
          });
          const overflowEntry = { key: persistentUndoKey(operation.workspaceRoot, operation.persistentId), operation, error: overflowError, markedUnavailable: false, overflow: true, expiresAt: Number.POSITIVE_INFINITY };
          await retryMarkPersistentUndoUnavailable(overflowEntry);
          return serializeUndoRecoveryError(overflowEntry.error);
        }
      }
      if (operation.kind === 'remove-created') {
        const phase = operation.removeCreatedPhase || (operation.removeCreatedPhase = {});

        const removedPaths = new Set(phase.removedPaths || []);
        if (!phase.pathsRemoved) {
          const pendingRemovalPaths = [...operation.paths, ...(operation.retainedSourceRoots || []), ...(operation.retainedSourcePaths || [])];
          for (const item of pendingRemovalPaths) {
            if (removedPaths.has(item)) continue;
            await assertUndoIdentity(operation, item);
            await fs.promises.rm(item, { recursive: true, force: true });
            removedPaths.add(item);
            phase.removedPaths = [...removedPaths];
          }
          phase.pathsRemoved = true;
        }

        return { success: true, message: `已撤销${operation.label || '文件操作'} ${operation.paths.length} 个项目` };
      }
      if (operation.kind === 'trash') {
        const restoreConflictPolicy = ['rename', 'overwrite'].includes(options?.restoreConflictPolicy) ? options.restoreConflictPolicy : '';
        const restoreConflicts = [];
        const restorePreflight = [];
        for (const item of operation.items) {
          if (item.backup) {
            if (await pathExists(item.original) || !await pathExists(item.backup)) throw new Error('原位置已被占用，或旧版恢复副本不可用');
            restorePreflight.push({ item, action: 'backup', restoreTarget: item.original });
            continue;
          }
          if (!await pathExists(path.parse(item.original).root)) {
            throw Object.assign(new Error('原文件所在磁盘当前未连接，连接磁盘后可以再次撤销'), { code: 'RESTORE_VOLUME_UNAVAILABLE' });
          }
          const originalExists = await pathExists(item.original);
          if (originalExists && await samePathIdentity(item.original, item.originalIdentity)) {
            restorePreflight.push({ item, action: 'already-restored', restoreTarget: item.original });
            continue;
          }
          if (originalExists) restoreConflicts.push(item);
          const probe = await recycleBinService.probe(item.recyclePidl);
          if (!probe.exists) {
            if (operation.persistentId && operation.workspaceRoot) {
              persistentClaimDescriptor ||= await persistentUndoClaimDescriptor(operation);
              await claimPersistentUndoExecution(operation, persistentBoundRecord, persistentClaimDescriptor);
            }
            throw Object.assign(new Error('系统回收站中的文件已不存在，可能已经被还原或清空'), { code: 'RECYCLE_ITEM_MISSING' });
          }
          restorePreflight.push({ item, action: originalExists ? 'conflict' : 'restore', restoreTarget: item.original });
        }
        const conflictSnapshot = [];
        for (const item of restoreConflicts) conflictSnapshot.push({ path: item.original, identity: await captureIdentity(item.original) });
        const snapshotMatches = async expected => Boolean(expected
          && expected.expiresAt > Date.now()
          && expected.persistentId === (operation.persistentId || '')
          && (!operation.persistentId || (expected.claimToken === persistentBoundRecord?.claimToken
            && expected.workspaceKey === comparablePath(persistentClaimDescriptor.workspaceRoot)))
          && expected.sources.length === operation.items.length
          && expected.sources.every((source, index) => source.recyclePidl === (operation.items[index].recyclePidl || '')
            && JSON.stringify(source.originalIdentity) === JSON.stringify(operation.items[index].originalIdentity || null))
          && expected.conflicts.length === conflictSnapshot.length
          && (await Promise.all(expected.conflicts.map(conflict => identityMatches(conflict.path, conflict.identity)))).every(Boolean));
        let decisionValid = false;
        if (restoreConflictPolicy) {
          if (requestedDecisionToken) {
            const sameOperation = operation.persistentId ? Boolean(pendingDecision) : pendingDecision?.operation === selectedDecisionOperation;
            decisionValid = sameOperation && await snapshotMatches(pendingDecision);
          }
          else {
            const legacyDecision = legacyRestoreDecisions.get(operation) || {
              operation,
              persistentId: operation.persistentId || '',
              claimToken: persistentBoundRecord?.claimToken || '',
              workspaceKey: persistentClaimDescriptor ? comparablePath(persistentClaimDescriptor.workspaceRoot) : '',
              sources: operation.items.map(item => ({ recyclePidl: item.recyclePidl || '', originalIdentity: item.originalIdentity || null })),
              conflicts: conflictSnapshot,
              expiresAt: Date.now() + decisionTtlMs,
            };
            decisionValid = await snapshotMatches(legacyDecision);
          }
        }
        if (restoreConflicts.length && (!restoreConflictPolicy || !decisionValid)) {
          renameHistory.push(operation);
          const decisionToken = crypto.randomUUID();
          const decision = {
            operation,
            persistentId: operation.persistentId || '',
            claimToken: persistentBoundRecord?.claimToken || '',
            workspaceKey: persistentClaimDescriptor ? comparablePath(persistentClaimDescriptor.workspaceRoot) : '',
            sources: operation.items.map(item => ({ recyclePidl: item.recyclePidl || '', originalIdentity: item.originalIdentity || null })),
            conflicts: conflictSnapshot,
            expiresAt: Date.now() + decisionTtlMs,
          };
          restoreDecisionTokens.set(decisionToken, decision);
          legacyRestoreDecisions.set(operation, decision);
          const names = restoreConflicts.slice(0, 6).map(item => path.basename(item.original));
          return {
            success: true,
            requiresDecision: {
              kind: 'restore-conflict',
              decisionToken,
              names,
              conflictCount: restoreConflicts.length,
              message: restoreConflicts.length === 1
                ? `“${names[0]}”的原位置已被其他项目占用`
                : `${restoreConflicts.length} 个项目的原位置已被同名项目占用`,
              detail: '可以改名恢复，也可以把当前同名项目移入系统回收站后覆盖恢复。',
            },
          };
        }
        if (requestedDecisionToken) restoreDecisionTokens.delete(requestedDecisionToken);
        legacyRestoreDecisions.delete(operation);
        for (const [token, decision] of restoreDecisionTokens) if (decision.operation === operation) restoreDecisionTokens.delete(token);
        for (const plan of restorePreflight) {
          if (plan.action !== 'conflict') continue;
          if (restoreConflictPolicy === 'rename') {
            const parsed = path.parse(plan.item.original);
            let index = 1;
            do { plan.restoreTarget = path.join(parsed.dir, `${parsed.name} (已恢复${index > 1 ? ` ${index}` : ''})${parsed.ext}`); index += 1; }
            while (await pathExists(plan.restoreTarget));
            plan.action = 'restore';
          } else {
            const confirmedConflict = conflictSnapshot.find(conflict => comparablePath(conflict.path) === comparablePath(plan.item.original));
            if (!confirmedConflict || !await identityMatches(plan.item.original, confirmedConflict.identity)) throw new Error('同名项目在确认后发生变化，请重新恢复');
            plan.action = 'overwrite';
          }
        }
        if (operation.persistentId && operation.workspaceRoot) {
          persistentClaimDescriptor ||= await persistentUndoClaimDescriptor(operation);
          try { await claimPersistentUndoExecution(operation, persistentBoundRecord, persistentClaimDescriptor); }
          catch (claimError) {
            if (claimError.code === 'PERSISTENT_UNDO_RECOVERY_PENDING') {
              const claimed = blockPersistentUndo(operation, claimError);
              return serializeUndoRecoveryError(claimed.error);
            }
            throw claimError;
          }
        }
        const restoredItems = [];
        for (const plan of restorePreflight) {
          const { item } = plan;
          // Compatibility for deletion records created by older app versions.
          if (plan.action === 'backup') {
            await fs.promises.mkdir(path.dirname(item.original), { recursive: true });
            await fs.promises.cp(item.backup, item.original, { recursive: true, preserveTimestamps: true, errorOnExist: true });
            if (item.backupRoot) await fs.promises.rm(item.backupRoot, { recursive: true, force: true });
            continue;
          }
          const restoreTarget = plan.restoreTarget;
          if (plan.action === 'already-restored') {
            restoredItems.push({ item, restoreTarget, restoredIdentity: await captureIdentity(restoreTarget) });
            continue;
          }
          if (plan.action === 'overwrite') {
            const replacementIdentity = await recycleBinService.trash(item.original);
            try {
              await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: item.original });
            } catch (error) {
              try { await recycleBinService.restore({ recyclePidl: replacementIdentity.recyclePidl, originalPath: item.original }); }
              catch (rollbackError) { mergeRecoveryError(error, rollbackError, '恢复当前同名项目失败'); }
              throw error;
            }
            if (operation.workspaceRoot && replacementIdentity.recyclePidl) {
              const replacementRecord = await workspaceRepository.addUndoRecord(operation.workspaceRoot, {
                kind: 'trash', payload: { items: [{ original: item.original, recyclePidl: replacementIdentity.recyclePidl }] },
              });
              await pushUndoOperation({ kind: 'trash', workspaceRoot: operation.workspaceRoot, persistentId: replacementRecord.id, items: [{ original: item.original, recyclePidl: replacementIdentity.recyclePidl }] });
            }
            restoredItems.push({ item, restoreTarget: item.original, restoredIdentity: await captureIdentity(item.original) });
            continue;
          }
          await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: item.original, targetPath: restoreTarget });
          const restoredIdentity = await captureIdentity(restoreTarget);
          if (!await identityMatches(restoreTarget, restoredIdentity)) throw new Error('恢复后的项目身份校验失败');
          restoredItems.push({ item, restoreTarget, restoredIdentity });
        }
        if (operation.projectCatalog && operation.workspaceRoot) {
          const restoredProject = restoredItems.find(entry => comparablePath(entry.item.original) === comparablePath(operation.items[0]?.original)) || restoredItems[0];
          const restoreTarget = restoredProject?.restoreTarget || operation.items[0]?.original;
          const nextName = path.basename(restoreTarget);
          if (operation.projectCatalog.id && operation.projectCatalog.projectId && operation.projectCatalog.id !== operation.projectCatalog.projectId) throw new Error('待恢复项目ID不一致');
          await workspaceRepository.restoreProject(operation.workspaceRoot, {
            ...operation.projectCatalog,
            projectId: operation.projectCatalog.projectId || operation.projectCatalog.id,
            nextName,
            relativePath: path.relative(operation.workspaceRoot, restoreTarget),
            restoreTarget,
            restoreIdentity: restoredProject?.restoredIdentity,
          });
          await refreshWorkspaceCatalog(operation.workspaceRoot);
        }
        if (operation.persistentId && operation.workspaceRoot) {
          try { await workspaceRepository.removeUndoRecord(operation.workspaceRoot, operation.persistentId); }
          catch (cause) {
            throw Object.assign(new Error(`恢复已完成，但撤销 journal 删除失败；claim 已保留：${cause?.message || String(cause)}`), {
              code: 'PERSISTENT_UNDO_RECOVERY_PENDING', outcomeUnknown: true, recoveryRequired: true, rollbackPending: true, cause,
            });
          }
          blockedPersistentUndos.delete(persistentUndoKey(operation.workspaceRoot, operation.persistentId));
        }
        return { success: true, message: `已恢复 ${operation.items.length} 个已删除项目` };
      }
      if (operation.kind === 'import-with-sources') {
        for (const createdPath of operation.createdPaths) await assertUndoIdentity(operation, createdPath);
        if (operation.items.some(item => fs.existsSync(item.original) || !fs.existsSync(item.backup))) throw new Error('导入源文件的恢复副本不可用');
        for (const createdPath of operation.createdPaths) await fs.promises.rm(createdPath, { recursive: true, force: true });
        for (const item of operation.items) {
          await fs.promises.mkdir(path.dirname(item.original), { recursive: true });
          await fs.promises.cp(item.backup, item.original, { recursive: true, preserveTimestamps: true, errorOnExist: true });
          await fs.promises.rm(item.backupRoot, { recursive: true, force: true });
        }
        return { success: true, message: `已撤销导入 ${operation.items.length} 个文件` };
      }
      if (operation.kind === 'paste-replace') {
        const moves = Array.isArray(operation.moves) ? operation.moves : [];
        const replacementItems = Array.isArray(operation.items) ? operation.items : [];
        if (replacementItems.some(item => item.permanent || (!item.backup && !item.recyclePidl))) {
          throw new Error('部分被替换的原项目已由 Windows 永久删除，无法完整撤销此次粘贴');
        }
        if (operation.partialUndoState) {
          const partial = operation.partialUndoState;
          const occupied = replacementItems.find(item => fs.existsSync(item.original));
          if (occupied) throw Object.assign(new Error(`无法继续撤销：“${path.basename(occupied.original)}”被后来出现的未知项目占用；新粘贴内容和旧备份均已保留在 ${partial.undoRoot}`), { code: 'UNDO_PUBLISH_CONFLICT', recoveryRequired: true });
          for (const item of replacementItems) {
            if (item.backup) await publishPathNoClobber(item.backup, item.original);
            else await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: item.original });
          }
          if (operation.mode === 'cut') {
            for (const item of partial.stagedNewItems || []) if (fs.existsSync(item.temporary)) await movePathAtomic(item.temporary, item.source);
          } else {
            for (const item of partial.stagedNewItems || []) if (fs.existsSync(item.temporary)) await fs.promises.rm(item.temporary, { recursive: true, force: true });
          }
          await fs.promises.rm(partial.undoRoot, { recursive: true, force: true }).catch(() => undefined);
          for (const retainedRoot of operation.retainedSourceRoots || []) await fs.promises.rm(retainedRoot, { recursive: true, force: true }).catch(() => undefined);
          operation.partialUndoState = null;
          return { success: true, message: `已继续撤销粘贴并恢复 ${replacementItems.length} 个被替换项目` };
        }
        for (const move of moves) await assertUndoIdentity(operation, move.destination);
        const destinationKeys = new Set(moves.map(move => path.resolve(move.destination).toLocaleLowerCase()));
        if (operation.mode === 'cut' && moves.some(move => fs.existsSync(move.source) && !destinationKeys.has(path.resolve(move.source).toLocaleLowerCase()))) {
          throw new Error('剪切源位置已被占用，无法安全撤销此次粘贴');
        }
        for (const item of replacementItems) {
          if (item.backup) {
            if (!fs.existsSync(item.backup)) throw new Error(`被替换项目“${path.basename(item.original)}”的恢复副本已不存在`);
          } else {
            const probe = await recycleBinService.probe(item.recyclePidl);
            if (!probe.exists) throw Object.assign(new Error(`回收站中的“${path.basename(item.original)}”已不存在，无法撤销替换`), { code: 'PASTE_REPLACEMENT_MISSING' });
          }
        }

        const undoRoot = path.join(path.dirname(moves[0]?.destination || replacementItems[0].original), `.photoflow-undo-paste-${crypto.randomUUID()}`);
        const stagedNewItems = [];
        const restoredOldItems = [];
        let preserveUndoRoot = false;
        await fs.promises.mkdir(undoRoot, { recursive: false });
        try {
          for (const [index, move] of moves.entries()) {
            const temporary = path.join(undoRoot, `new-${index}-${path.basename(move.destination)}`);
            await publishPathNoClobber(move.destination, temporary);
            stagedNewItems.push({ ...move, temporary, movedToSource: false });
          }
          for (const item of replacementItems) {
            if (item.backup) await publishPathNoClobber(item.backup, item.original);
            else await recycleBinService.restore({ recyclePidl: item.recyclePidl, originalPath: item.original });
            restoredOldItems.push(item);
          }
          if (operation.mode === 'cut') {
            for (const item of stagedNewItems) {
              await movePathAtomic(item.temporary, item.source);
              item.movedToSource = true;
            }
          } else {
            for (const item of stagedNewItems) await fs.promises.rm(item.temporary, { recursive: true, force: true });
          }
        } catch (error) {
          for (const [index, item] of [...restoredOldItems].reverse().entries()) {
            if (!fs.existsSync(item.original)) continue;
            const rollbackBackup = path.join(undoRoot, `old-${index}-${path.basename(item.original)}`);
            try {
              await publishPathNoClobber(item.original, rollbackBackup);
              item.backup = rollbackBackup;
              item.backupRoot = undoRoot;
              item.recyclePidl = '';
              item.permanent = false;
              preserveUndoRoot = true;
            } catch { /* a later recovery attempt can report the occupied path */ }
          }
          for (const item of [...stagedNewItems].reverse()) {
            try {
              if (item.movedToSource && fs.existsSync(item.source) && !fs.existsSync(item.temporary)) await movePathAtomic(item.source, item.temporary);
              if (fs.existsSync(item.temporary) && !fs.existsSync(item.destination)) await publishPathNoClobber(item.temporary, item.destination);
            } catch { /* best-effort rollback; preserve every reachable copy */ }
          }
          if (stagedNewItems.some(item => fs.existsSync(item.temporary)) || replacementItems.some(item => item.backup && fs.existsSync(item.backup))) {
            preserveUndoRoot = true;
            operation.partialUndoState = { undoRoot, stagedNewItems: stagedNewItems.map(item => ({ ...item })) };
            error.message = `${error.message || String(error)}；检测到晚到同名占用，未覆盖未知内容；新粘贴内容与旧备份已保留在 ${undoRoot}，清理占用后可再次撤销`;
            error.code = 'UNDO_PUBLISH_CONFLICT';
          }
          if (!preserveUndoRoot) await fs.promises.rm(undoRoot, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        await fs.promises.rm(undoRoot, { recursive: true, force: true }).catch(() => undefined);
        for (const retainedRoot of operation.retainedSourceRoots || []) await fs.promises.rm(retainedRoot, { recursive: true, force: true }).catch(() => undefined);
        const backupRoots = new Set(replacementItems.map(item => item.backupRoot).filter(Boolean));
        for (const backupRoot of backupRoots) await fs.promises.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
        return { success: true, message: `已撤销粘贴并恢复 ${replacementItems.length} 个被替换项目` };
      }
      if (operation.kind === 'external-move') {
        for (const move of operation.moves) await assertUndoIdentity(operation, move.destination);
        if (operation.moves.some(move => fs.existsSync(move.source))) throw new Error('原位置已经被占用，无法安全撤销');
        for (const move of operation.moves) {
          try {
            await fs.promises.rename(move.destination, move.source);
          } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await fs.promises.cp(move.destination, move.source, { recursive: true, preserveTimestamps: true, errorOnExist: true });
            await fs.promises.rm(move.destination, { recursive: true, force: true });
          }
        }
        return { success: true, message: `已撤销导入 ${operation.moves.length} 个文件` };
      }
      if (operation.kind === 'broll-import') {
        const createdPaths = Array.isArray(operation.createdPaths) ? operation.createdPaths : [];
        const moves = Array.isArray(operation.moves) ? operation.moves : [];
        for (const item of createdPaths) await assertUndoIdentity(operation, item);
        for (const move of moves) await assertUndoIdentity(operation, move.destination);
        if (moves.some(item => fs.existsSync(item.source))) throw new Error('花絮原位置已被占用，无法安全撤销');
        for (const item of createdPaths) await fs.promises.rm(item, { force: true });
        for (const move of [...moves].reverse()) {
          try {
            await fs.promises.rename(move.destination, move.source);
          } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await fs.promises.copyFile(move.destination, move.source, fs.constants.COPYFILE_EXCL);
            await fs.promises.rm(move.destination, { force: true });
          }
        }
        return { success: true, message: `已撤销导入花絮 ${createdPaths.length + moves.length} 个文件` };
      }
      if (operation.kind === 'files' || operation.kind === 'move') {
        const moves = operation.moves.map(move => ({ source: move.destination, destination: move.source }));
        const normalizedSources = new Set(moves.map(move => path.resolve(move.source).toLocaleLowerCase()));
        for (const move of moves) await assertUndoIdentity(operation, move.source);
        if (moves.some(move => fs.existsSync(move.destination) && !normalizedSources.has(path.resolve(move.destination).toLocaleLowerCase()))) {
          throw new Error('原名称已被占用，无法撤销');
        }
        const staged = [];
        try {
          for (const move of moves) {
            const temporary = path.join(path.dirname(move.source), `.photoflow-undo-rename-${crypto.randomUUID()}${path.extname(move.source)}`);
            await fs.promises.rename(move.source, temporary);
            staged.push({ ...move, temporary, completed: false });
          }
          for (const move of staged) {
            await movePathAtomic(move.temporary, move.destination);
            move.completed = true;
          }
        } catch (error) {
          for (const move of [...staged].reverse()) {
            try {
              if (move.completed && fs.existsSync(move.destination) && !fs.existsSync(move.source)) await movePathAtomic(move.destination, move.source);
              else if (!move.completed && fs.existsSync(move.temporary) && !fs.existsSync(move.source)) await fs.promises.rename(move.temporary, move.source);
            } catch { /* best-effort rollback; original error is reported below */ }
          }
          throw error;
        }
        return { success: true, message: operation.kind === 'files' ? `已撤销重命名 ${moves.length} 个文件` : `已撤销移动 ${moves.length} 个项目` };
      }
      await assertUndoIdentity(operation, operation.destination);
      if (fs.existsSync(operation.source)) {
        throw new Error('原名称已被占用，无法撤销');
      }
      await fs.promises.rename(operation.destination, operation.source);
      const response = { success: true, message: `已撤销重命名：${operation.afterName} → ${operation.beforeName}` };
      if (operation.kind === 'project') {
        await mutateWorkspaceCatalog(operation.workspaceRoot, 'renameProject', { name: operation.afterName, nextName: operation.beforeName, relativePath: path.relative(operation.workspaceRoot, operation.source), ...(Object.prototype.hasOwnProperty.call(operation, 'beforeProjectDate') ? { projectDate: operation.beforeProjectDate || null } : {}) });
        await notifyComponentArtifactRelocation(operation.workspaceRoot,
          { status: operation.status, projectName: operation.afterName },
          { status: operation.status, projectName: operation.beforeName });
        response.project = { name: operation.beforeName, path: operation.source, status: operation.status, updatedAt: Date.now(), projectDate: operation.beforeProjectDate };
      }
      return response;
    } catch (error) {
      const terminalRecovery = error.code === 'RECYCLE_ITEM_MISSING' || terminalRecoveryResult(error);
      if (operation?.persistentId && operation?.workspaceRoot && terminalRecovery) {
        const blocked = blockPersistentUndo(operation, error);
        await retryMarkPersistentUndoUnavailable(blocked);
      }
      if (operation && !terminalRecovery) renameHistory.push(operation);
      return serializeUndoRecoveryError(error);
    }
  });

  ipcMain.handle('workspace-move-project', async (_event, workspacePath, currentStatus, projectName, nextStatus) => {
    try {
      const root = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(root) || await refreshWorkspaceCatalog(root);
      if (!isValidProjectStatus(nextStatus)) throw new Error('无效的项目状态');
      if (nextStatus === '未分类') throw new Error('未分类仅用于自动发现的新文件夹');
      const source = getProjectPath(workspacePath, currentStatus, projectName);
      if (!fs.existsSync(source)) throw new Error('项目不存在');
      await mutateWorkspaceCatalog(root, 'setProjectStatus', { name: projectName, status: nextStatus });
      await notifyComponentArtifactRelocation(root,
        { status: currentStatus, projectName },
        { status: nextStatus, projectName });
      return { success: true, project: { id: catalog.byName.get(projectName.toLocaleLowerCase())?.id, name: projectName, path: source, status: nextStatus, updatedAt: Date.now() } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-finalize-sd-imports', async (_event, workspacePath, projectNames = [], options = {}) => {
    try {
      const root = ensureWorkspace(workspacePath);
      const targetStatus = '后期中';
      const normalizedNames = values => [...new Set((Array.isArray(values) ? values : [])
        .map(value => cleanProjectName(String(value))).filter(Boolean).map(value => value.toLocaleLowerCase()))];
      const requestedNames = new Set(normalizedNames(projectNames));
      const workNames = new Set(normalizedNames(options.workProjectNames).filter(name => requestedNames.has(name)));
      const moveProjectAfterImport = options.moveProjectAfterImport === true;
      await reconcileWorkspaceCatalog(root);
      const movedNames = new Set();
      const failures = [];
      for (const requestedName of requestedNames) {
        const currentCatalog = await reconcileWorkspaceCatalog(root);
        const row = currentCatalog.projects.find(project => project.name.toLocaleLowerCase() === requestedName);
        if (!row || !workNames.has(requestedName) || !moveProjectAfterImport || row.status !== '待拍摄') continue;
        try {
          await workspaceRepository.setProjectStatus(root, { name: row.name, status: targetStatus });
          try {
            const migrationResults = await notifyComponentArtifactRelocation(root,
              { status: row.status, projectName: row.name },
              { status: targetStatus, projectName: row.name });
            if (migrationResults.some(result => result.state === 'failed')) throw new Error('团队工作流数据迁移失败');
          } catch (migrationError) {
            await workspaceRepository.setProjectStatus(root, { name: row.name, status: row.status }).catch(() => undefined);
            await notifyComponentArtifactRelocation(root,
              { status: targetStatus, projectName: row.name },
              { status: row.status, projectName: row.name }).catch(() => undefined);
            throw migrationError;
          }
          movedNames.add(requestedName);
        } catch (error) {
          failures.push({ projectName: row.name, error: error.message || String(error) });
        }
      }
      const finalCatalog = await reconcileWorkspaceCatalog(root);
      const projects = finalCatalog.projects.flatMap(row => {
        if (!requestedNames.has(row.name.toLocaleLowerCase())) return [];
        const projectPath = path.resolve(root, row.relative_path);
        if (!fs.existsSync(projectPath)) return [];
        return [{ id: row.id, name: row.name, path: projectPath, status: row.status, updatedAt: fs.statSync(projectPath).mtimeMs }];
      });
      await refreshWorkspaceCatalog(root);
      await scheduleSdImportedMedia({ root, projects, importedPathsByProject: options.importedPathsByProject, imageExtensions: IMAGE_EXTENSIONS, rawExtensions: RAW_EXTENSIONS, videoExtensions: VIDEO_EXTENSIONS, fs, path, scheduleMediaTrackingScan });
      sendToApplicationRenderers(mainWindow, 'workspace-projects-changed', { root, reason: 'sd-import-finalized' });
      const movedProjects = projects.filter(project => movedNames.has(project.name.toLocaleLowerCase()));
      const unchangedProjects = projects.filter(project => !movedNames.has(project.name.toLocaleLowerCase()));
      writeLog('info', 'SD imported projects finalized', { root, requested: [...requestedNames], work: [...workNames], moved: movedProjects.length, failures: failures.length });
      return { success: true, projects, movedProjects, unchangedProjects, failures };
    } catch (error) {
      writeLog('error', 'Unable to finalize SD imported folders', error);
      return { success: false, error: error.message || String(error), projects: [], movedProjects: [], unchangedProjects: [], failures: [] };
    }
  });

  ipcMain.handle('workspace-trash-project', async (event, workspacePath, status, projectName) => {
    const operationId = crypto.randomUUID();
    let suppressedProjectPath = '';
    let task = null;
    const publish = payload => task?.publish(payload);
    try {
      const projectPath = getProjectPath(workspacePath, status, projectName);
      if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'trash', title: `删除项目 · ${projectName}`,
        projectName, resources: [projectPath], cancellable: false, cancelledCode: CANCELLED_CODE,
      });
      await task.start();
      publish({ phase: 'trashing', progress: 0, currentName: projectName, processedCount: 0, totalCount: 1 });
      const root = ensureWorkspace(workspacePath);
      const originalIdentity = await capturePathIdentity(projectPath);
      cancelMediaTrackingScan(root, projectName);
      suppressWorkspaceWatchPath(projectPath);
      suppressedProjectPath = projectPath;
      const recycled = await recycleBinService.trash(projectPath);
      const catalogRow = workspaceCatalogs.get(root)?.byName?.get(projectName.toLocaleLowerCase());
      const projectCatalog = { id: catalogRow?.id, projectId: catalogRow?.id, name: projectName, status, relativePath: catalogRow?.relative_path || path.relative(root, projectPath) };
      if (recycled.recyclePidl) {
        const item = { original: projectPath, originalIdentity, recyclePidl: recycled.recyclePidl, preciseRestore: recycled.preciseRestore !== false };
        const record = await workspaceRepository.addUndoRecord(root, { kind: 'trash', payload: { items: [item], projectCatalog } });
        await pushUndoOperation({ kind: 'trash', workspaceRoot: root, persistentId: record.id, items: [item], projectCatalog });
      } else if (recycled.permanent) {
        await workspaceRepository.addUndoRecord(root, {
          kind: 'project-cleanup',
          payload: { items: [{ original: projectPath, originalIdentity, permanent: true }], projectCatalog },
        });
      }
      await mutateWorkspaceCatalog(root, 'softDeleteProject', { name: projectName });
      publish({ phase: 'complete', progress: 100, currentName: projectName, processedCount: 1, totalCount: 1 });
      task.complete('项目已移入回收站');
      if (recycled.permanent) queuePermanentProjectCleanup(root, projectName);
      return { success: true, operationId, permanent: Boolean(recycled.permanent) };
    } catch (error) {
      publish({ phase: 'failed', progress: 0, currentName: projectName, error: error.message || String(error) });
      task?.fail(error);
      return { success: false, error: error.message || String(error), errorCode: error?.code || undefined };
    } finally {
      if (suppressedProjectPath) releaseWorkspaceWatchPath(suppressedProjectPath);
    }
  });

  ipcMain.handle('workspace-project-contents', async (_event, workspacePath, status, projectName) => {
    try {
      const projectPath = await getReadyProjectPath(workspacePath, status, projectName);
      if (!fs.existsSync(projectPath)) throw new Error('项目不存在');
      const entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
      const folders = (await Promise.all(entries
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(async entry => {
          const folderPath = path.join(projectPath, entry.name);
          return { name: entry.name, path: folderPath, updatedAt: (await fs.promises.stat(folderPath)).mtimeMs };
        })))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      return { success: true, folders };
    } catch (error) {
      return { success: false, error: error.message || String(error), folders: [] };
    }
  });

  const watchProjectFileRoot = async (workspacePath, status, projectName, options = {}) => {
    const root = path.resolve(await getReadyProjectPath(workspacePath, status, projectName));
    const publishRoot = path.resolve(ensureWorkspace(workspacePath));
    const relativeRoot = path.relative(publishRoot, root);
    const projectPrefix = relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot) ? projectName : relativeRoot.replace(/\\/g, '/');
    const key = watchedProjectFileRootKey(publishRoot, status, projectName);
    const previousHealth = watchedProjectFileRootHealth.get(key);
    const previousBindings = watchedProjectFileRoots.get(key) || [];
    for (const binding of previousBindings) releaseFileRootWatcher(binding.root, binding.options);
    watchedProjectFileRoots.delete(key);
    watchedProjectFileRootHealth.delete(key);
    mediaService.grantRoot(root);
    const bindings = [{ root, options: { publishRoot, virtualPrefix: projectPrefix, onChanged: externalTrackingChangeHandler(publishRoot, projectName) }, virtualPath: '', external: false }];
    const acquired = [];
    const failedRoots = [];
    for (const binding of bindings) {
      const result = acquireFileRootWatcher(binding.root, binding.options);
      if (!result.success) {
        failedRoots.push({ virtualPath: binding.virtualPath, external: binding.external, error: result.error || '无法监听此位置' });
        continue;
      }
      acquired.push(binding);
    }
    watchedProjectFileRoots.set(key, acquired);
    const mainWatched = acquired.includes(bindings[0]);
    let degraded = !mainWatched || failedRoots.length > 0;
    let reconciliationFailed = false;
    const supportsTrackingReconciliation = projectName !== INSPIRATION_VIRTUAL_PROJECT_NAME;
    let reconciled = false;
    const shouldReconcile = options.reconcile !== false || previousHealth?.degraded && !degraded;
    if (supportsTrackingReconciliation && shouldReconcile && mainWatched) {
      try {
        const reconciliation = await versionService.detectProgressStale(publishRoot, { projectName, changedPaths: [] });
        if (!reconciliation?.success) throw new Error(reconciliation?.error || '无法补扫版本跟踪状态');
        reconciled = true;
      } catch (error) {
        reconciliationFailed = true;
        degraded = true;
        writeLog('warn', 'Unable to reconcile tracking state after watcher install', { projectName, error: error.message || String(error) });
      }
    }
    watchedProjectFileRootHealth.set(key, { degraded });
    return {
      success: mainWatched, root: publishRoot, requiredRoots: bindings.length, watchedRoots: acquired.length,
      failedRoots, degraded, reconciled, reconciliationFailed,
      ...(!mainWatched ? { error: '无法监听项目文件夹' } : {}),
    };
  };

  ipcMain.handle('workspace-watch-file-root', async (_event, workspacePath, status, projectName, options = {}) => {
    const startedAt = Date.now();
    try { return await watchProjectFileRoot(workspacePath, status, projectName, options); }
    catch (error) { return { success: false, error: error.message || String(error) }; }
    finally { logSlowWorkspaceInteraction('watch-file-root', startedAt, { projectName, reconcile: options.reconcile !== false }); }
  });

  ipcMain.handle('workspace-unwatch-file-root', async (_event, workspacePath, status, projectName) => {
    try {
      let root;
      try { root = path.resolve(getProjectPath(workspacePath, status, projectName)); }
      catch { root = path.resolve(String(workspacePath || '')); }
      const publishRoot = path.resolve(ensureWorkspace(workspacePath));
      const key = watchedProjectFileRootKey(publishRoot, status, projectName);
      const bindings = watchedProjectFileRoots.get(key) || [{ root, options: { publishRoot, virtualPrefix: path.relative(publishRoot, root).replace(/\\/g, '/') } }];
      for (const binding of bindings) releaseFileRootWatcher(binding.root, binding.options);
      watchedProjectFileRoots.delete(key);
      watchedProjectFileRootHealth.delete(key);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  registerEntryUtilityIpc({ ipcMain, findLatestPhotoshop, path, getProjectPath, resolveToolSource, fs, spawn, resolveProjectEntry, clipboard, mediaService, app });

  ipcMain.handle('workspace-browse-files', async (_event, workspacePath, status, projectName, relativePath = '', cacheConfig = {}) => {
    const startedAt = Date.now();
    try {
      const projectPath = await getReadyProjectPath(workspacePath, status, projectName);
      const root = path.resolve(projectPath);
      const normalizedRelativePath = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const pathSegments = normalizedRelativePath ? normalizedRelativePath.split('/') : [];
      if (pathSegments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('文件夹路径无效');
      const currentResolution = virtualPaths.resolve(root, normalizedRelativePath, { externalRootMode: 'target' });
      const currentPath = currentResolution.physicalPath;
      const mediaRoot = currentResolution.mediaRoot;
      const currentStat = await fs.promises.stat(currentPath);
      if (!currentStat.isDirectory()) throw new Error('文件夹不存在');
      mediaService.grantRoot(mediaRoot);
      mediaRuntimeState.activeMediaCacheConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
      const directoryEntries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      const entries = directoryEntries
        .filter(entry => !entry.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(entry.name.toLowerCase()) && !isInternalFileOperationEntry(entry.name))
        .map(entry => {
          const entryPath = path.join(currentPath, entry.name);
          let displayPath = entryPath;
          let extension = entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase();
          let kind = entry.isDirectory() ? 'folder' : extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          const sourceChannel = kind === 'shortcut' ? shortcutSourceChannel(entryPath) : undefined;
          const virtualRelativePath = path.relative(root, entryPath).replace(/\\/g, '/');
          return { name: entry.name, path: displayPath, relativePath: virtualRelativePath, kind, extension, size: -1, createdAt: 0, updatedAt: 0, ...(sourceChannel ? { sourceChannel } : {}) };
        })
        .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      // Index only the directory the user opened. Whole-project thumbnail and
      // version scans on every restored project tab made application startup
      // recursively read all source media; watcher events and explicit tools
      // already request the broader reconciliation when it is actually needed.
      void thumbnailService.indexDirectory(mediaRoot, currentPath, entries, mediaRuntimeState.activeMediaCacheConfig);
      logSlowWorkspaceInteraction('browse-files', startedAt, { projectName, relativePath: normalizedRelativePath, entryCount: entries.length });
      return { success: true, path: normalizedRelativePath, entries };
    } catch (error) {
      writeLog('warn', 'Unable to browse project directory', { projectName, relativePath, elapsedMs: Date.now() - startedAt, error: error.message || String(error) });
      return { success: false, missingDirectory: (error?.code === 'ENOENT' || error?.code === 'ENOTDIR'), error: error.message || String(error), entries: [] };
    }
  });

  ipcMain.handle('workspace-inspect-tool-sources', async (_event, workspacePath, status, projectName, relativePaths = [], collectVideos = false, collectDirectConvertibleImages = false, collectRecursiveConvertibleImages = false) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requestedPaths = [...new Set((Array.isArray(relativePaths) ? relativePaths : [])
        .filter(value => typeof value === 'string' && value.length <= 32768))];
      if (!requestedPaths.length) return { success: true, indexed: true, hasVideo: false, hasConvertibleImage: false, videoPaths: [], convertibleImagePaths: [], folderPaths: [], sources: [] };
      if (requestedPaths.length > 4096) throw new Error('一次最多处理 4096 个所选文件或文件夹');
      const resolutions = requestedPaths.map(relativePath => resolveToolSource(root, relativePath));
      const targets = resolutions.map(item => item.physicalPath);
      const folderPaths = [];
      const sources = [];
      for (const target of targets) {
        try {
          const stat = await fs.promises.stat(target);
          if (stat.isDirectory()) {
            folderPaths.push(target);
            sources.push({ path: target, kind: 'folder' });
          } else if (stat.isFile()) sources.push({ path: target, kind: 'file' });
        } catch { /* inspectToolSources reports missing source details */ }
      }
      const targetGroups = new Map();
      resolutions.forEach((resolution, index) => {
        const inspectionRoot = path.resolve(resolution.viaExternalLink ? resolution.mediaRoot : root);
        const group = targetGroups.get(inspectionRoot) || [];
        group.push(targets[index]);
        targetGroups.set(inspectionRoot, group);
      });
      const inspectedGroups = [];
      for (const [inspectionRoot, groupTargets] of targetGroups) {
        mediaService.grantRoot(inspectionRoot);
        const result = await thumbnailService.inspectToolSources(inspectionRoot, groupTargets, collectVideos, collectDirectConvertibleImages, collectRecursiveConvertibleImages);
        inspectedGroups.push(result);
        if (!result.indexed) void thumbnailService.scanProject(inspectionRoot, mediaRuntimeState.activeMediaCacheConfig);
      }
      const indexed = inspectedGroups.every(result => result.indexed);
      const result = {
        indexed,
        hasVideo: inspectedGroups.some(item => item.hasVideo),
        hasConvertibleImage: inspectedGroups.some(item => item.hasConvertibleImage),
        videoPaths: [...new Set(inspectedGroups.flatMap(item => item.videoPaths || []))],
        convertibleImagePaths: [...new Set(inspectedGroups.flatMap(item => item.convertibleImagePaths || []))],
      };
      return { success: true, ...result, folderPaths, sources };
    } catch (error) {
      writeLog('warn', 'Unable to read project tool-source index', { projectName, error: error.message || String(error) });
      return { success: false, indexed: false, hasVideo: false, hasConvertibleImage: false, videoPaths: [], convertibleImagePaths: [], folderPaths: [], sources: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-resolve-shortcut', async (_event, workspacePath, status, projectName, relativePath = '') => {
    try {
      if (process.platform !== 'win32') throw new Error('快捷方式解析目前仅支持 Windows');
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requestedPath = assertInside(root, path.resolve(root, relativePath), '快捷方式路径');
      const shortcutPath = assertExistingInside(root, requestedPath, '快捷方式路径');
      if (path.extname(shortcutPath).toLowerCase() !== '.lnk') throw new Error('所选项目不是 Windows 快捷方式');
      const shortcutStat = await fs.promises.stat(shortcutPath);
      if (!shortcutStat.isFile()) throw new Error('快捷方式文件不存在');
      const details = shell.readShortcutLink(shortcutPath);
      const target = path.resolve(String(details?.target || ''));
      if (!details?.target) throw new Error('快捷方式没有有效目标');
      const targetStat = await fs.promises.stat(target);
      if (!targetStat.isDirectory() && !targetStat.isFile()) throw new Error('快捷方式目标类型不受支持');
      return { success: true, target, targetKind: targetStat.isDirectory() ? 'folder' : 'file' };
    } catch (error) {
      writeLog('warn', 'Unable to resolve project shortcut', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-browse-shortcut-preview', async (_event, workspacePath, status, projectName, relativePath = '') => {
    const timeoutMs = 2000;
    const withShortcutTimeout = (operation, code = 'SHORTCUT_TARGET_OFFLINE') => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('快捷方式目标暂时不可用'), { code })), timeoutMs);
      Promise.resolve(operation).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    try {
      if (process.platform !== 'win32') throw Object.assign(new Error('快捷方式预览目前仅支持 Windows'), { code: 'SHORTCUT_UNSUPPORTED' });
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw Object.assign(new Error('快捷方式相对路径无效'), { code: 'SHORTCUT_INVALID' });
      let requestedPath;
      try { requestedPath = assertInside(root, path.resolve(root, relativePath), '快捷方式路径'); }
      catch { throw Object.assign(new Error('快捷方式路径超出项目范围'), { code: 'SHORTCUT_INVALID' }); }
      let shortcutPath;
      try { shortcutPath = assertExistingInside(root, requestedPath, '快捷方式路径'); }
      catch { throw Object.assign(new Error('快捷方式文件不存在'), { code: 'SHORTCUT_INVALID' }); }
      if (path.extname(shortcutPath).toLowerCase() !== '.lnk') throw Object.assign(new Error('所选项目不是 Windows 快捷方式'), { code: 'SHORTCUT_INVALID' });
      const shortcutStat = await fs.promises.stat(shortcutPath);
      if (!shortcutStat.isFile()) throw Object.assign(new Error('快捷方式文件不存在'), { code: 'SHORTCUT_INVALID' });

      const visited = new Set([shortcutPath.toLocaleLowerCase()]);
      let target = shortcutPath;
      for (let depth = 0; depth < 8; depth += 1) {
        const details = shell.readShortcutLink(target);
        if (!details?.target) throw Object.assign(new Error('快捷方式没有有效目标'), { code: 'SHORTCUT_INVALID' });
        target = path.resolve(String(details.target));
        if (path.extname(target).toLowerCase() !== '.lnk') break;
        const key = target.toLocaleLowerCase();
        if (visited.has(key)) throw Object.assign(new Error('检测到循环快捷方式'), { code: 'SHORTCUT_LOOP' });
        visited.add(key);
        if (depth === 7) throw Object.assign(new Error('快捷方式链过深'), { code: 'SHORTCUT_LOOP' });
      }

      const targetStat = await withShortcutTimeout(fs.promises.stat(target));
      if (targetStat.isFile()) return { success: true, targetKind: 'file', entries: [] };
      if (!targetStat.isDirectory()) throw Object.assign(new Error('快捷方式目标类型不受支持'), { code: 'SHORTCUT_INVALID' });
      const children = await withShortcutTimeout(fs.promises.readdir(target, { withFileTypes: true }));
      mediaService.grantRoot(target);
      const previewLimit = 12;
      const maximumInspectedPreviewChildren = 240;
      const entries = [];
      let inspectedChildren = 0;
      for (const child of children) {
        if (entries.length >= previewLimit || inspectedChildren >= maximumInspectedPreviewChildren) break;
        inspectedChildren += 1;
        if (child.isSymbolicLink() || child.isDirectory() || !child.isFile()) continue;
        const childPath = path.join(target, child.name);
        let stat;
        try { stat = await withShortcutTimeout(fs.promises.stat(childPath)); }
        catch { continue; }
        const extension = path.extname(child.name).toLowerCase();
        const kind = extension === '.lnk' ? 'shortcut'
          : IMAGE_EXTENSIONS.has(extension) ? 'image'
            : RAW_EXTENSIONS.has(extension) ? 'raw'
              : VIDEO_EXTENSIONS.has(extension) ? 'video' : 'file';
        entries.push({ name: child.name, path: childPath, relativePath: child.name, kind, extension, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs || 0, updatedAt: stat.mtimeMs || 0, readOnly: true, viaShortcut: true });
      }
      return { success: true, targetKind: 'folder', entries, truncated: inspectedChildren < children.length };
    } catch (error) {
      const errorCode = error?.code === 'EACCES' || error?.code === 'EPERM' ? 'SHORTCUT_ACCESS_DENIED'
        : error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'SHORTCUT_TARGET_MISSING'
          : String(error?.code || '').startsWith('SHORTCUT_') ? error.code : 'SHORTCUT_TARGET_OFFLINE';
      writeLog('warn', 'Unable to browse project shortcut preview', { projectName, relativePath, errorCode, error: error.message || String(error) });
      return { success: false, targetKind: null, entries: [], errorCode, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-search-files', async (_event, workspacePath, status, projectName, scopeRelativePath = '', query = '') => {
    try {
      const root = path.resolve(await getReadyProjectPath(workspacePath, status, projectName));
      const requestedScope = assertInside(root, path.resolve(root, scopeRelativePath || '.'), '搜索范围', true);
      const scope = assertExistingInside(root, requestedScope, '搜索范围', true);
      const scopeStat = await fs.promises.stat(scope);
      if (!scopeStat.isDirectory()) throw new Error('搜索范围不是文件夹');
      mediaService.grantRoot(root);
      const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
      const entries = [];
      const pending = [{ directory: scope, boundary: await fs.promises.realpath(scope), depth: 0, virtualPath: path.relative(root, scope).replace(/\\/g, '/') }];
      const visited = new Set();
      const maximumDepth = 64;
      const maximumDirectories = 5000;
      const maximumInspectedEntries = 100000;
      const maximumResults = 2000;
      let inspectedEntries = 0;
      let scannedDirectories = 0;
      let skippedCount = 0;
      let truncated = false;

      while (pending.length) {
        const current = pending.pop();
        if (current.depth > maximumDepth || scannedDirectories >= maximumDirectories || inspectedEntries >= maximumInspectedEntries || entries.length >= maximumResults) { truncated = true; skippedCount += 1; continue; }
        const directory = current.directory;
        let directoryReal;
        try { directoryReal = await fs.promises.realpath(directory); } catch { skippedCount += 1; continue; }
        const containment = path.relative(current.boundary, directoryReal);
        if (containment.startsWith('..') || path.isAbsolute(containment)) { skippedCount += 1; continue; }
        const directoryStat = await fs.promises.lstat(directory, { bigint: true }).catch(() => null);
        if (!directoryStat || directoryStat.isSymbolicLink()) { skippedCount += 1; continue; }
        const directoryIdentity = `${directoryStat.dev}:${directoryStat.ino}`;
        if (visited.has(directoryIdentity)) { skippedCount += 1; continue; }
        visited.add(directoryIdentity);
        scannedDirectories += 1;
        let children;
        try {
          children = await fs.promises.readdir(directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a project search directory', { directory, error: error.message || String(error) });
          continue;
        }
        for (const child of children) {
          if (inspectedEntries++ >= maximumInspectedEntries || entries.length >= maximumResults) { truncated = true; skippedCount += 1; break; }
          if (HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) || isInternalFileOperationEntry(child.name)) continue;
          const childPath = path.join(directory, child.name);
          const childStat = await fs.promises.lstat(childPath).catch(() => null);
          if (!childStat || childStat.isSymbolicLink()) { skippedCount += 1; continue; }
          if (childStat.isDirectory()) {
            pending.push({ directory: childPath, boundary: current.boundary, depth: current.depth + 1, virtualPath: [current.virtualPath, child.name].filter(Boolean).join('/') });
            if (!needle || child.name.toLocaleLowerCase('zh-CN').includes(needle)) {
              entries.push({ name: child.name, path: childPath, relativePath: [current.virtualPath, child.name].filter(Boolean).join('/'), kind: 'folder', extension: '', size: -1, createdAt: 0, updatedAt: 0 });
            }
            continue;
          }
          if (!childStat.isFile() || needle && !child.name.toLocaleLowerCase('zh-CN').includes(needle)) continue;
          const extension = path.extname(child.name).toLowerCase();
          const kind = extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          const sourceChannel = kind === 'shortcut' ? shortcutSourceChannel(childPath) : undefined;
          entries.push({ name: child.name, path: childPath, relativePath: [current.virtualPath, child.name].filter(Boolean).join('/'), kind, extension, size: -1, createdAt: 0, updatedAt: 0, ...(sourceChannel ? { sourceChannel } : {}) });
        }
      }
      entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      return { success: true, scope: path.relative(root, scope).replace(/\\/g, '/'), entries, truncated, skippedCount, scannedDirectories, inspectedEntries };
    } catch (error) {
      writeLog('warn', 'Unable to search project files', { projectName, scopeRelativePath, error: error.message || String(error) });
      return { success: false, entries: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-list-files', async (_event, workspacePath, status, projectName, scopeRelativePath = '', requestedPageSize = 120, requestedCursor = '', requestedFilter = {}) => {
    let releaseCursor = () => undefined;
    try {
      releaseCursor = await acquireCursorLock(fileListCursorLocks, String(requestedCursor || ''));
      const root = path.resolve(await getReadyProjectPath(workspacePath, status, projectName));
      const requestedScope = assertInside(root, path.resolve(root, scopeRelativePath || '.'), '文件枚举范围', true);
      const scope = assertExistingInside(root, requestedScope, '文件枚举范围', true);
      const scopeStat = await fs.promises.stat(scope);
      if (!scopeStat.isDirectory()) throw new Error('文件枚举范围不是文件夹');
      mediaService.grantRoot(root);
      const pageSize = Math.min(200, Math.max(1, Number(requestedPageSize) || 120));
      const filter = normalizeProjectFileListFilter(requestedFilter);
      pruneFileListSessions();
      let cursor = String(requestedCursor || '');
      if (cursor && cancelledFileListCursors.has(cursor)) throw Object.assign(new Error('文件枚举已取消'), { code: fileListCancelledCode });
      let session = cursor ? fileListSessions.get(cursor) : null;
      if (cursor && !projectFileListSessionMatches(session, root, scope, filter)) {
        throw Object.assign(new Error('文件枚举会话已失效'), { code: fileListSessionExpiredCode });
      }
      if (!session) {
        while (fileListSessions.size >= 16) {
          const oldest = [...fileListSessions.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
          if (!oldest) break;
          fileListSessions.delete(oldest[0]);
        }
        cursor = crypto.randomUUID();
        session = {
          root,
          scope,
          filterSignature: filter.signature,
          filter,
          pending: [{ directory: scope, boundary: await fs.promises.realpath(scope), depth: 0, offset: 0, virtualPath: path.relative(root, scope).replace(/\\/g, '/') }],
          visitedDirectories: new Set(),

          scannedDirectories: 0,
          inspectedEntries: 0,
          touchedAt: Date.now(),
        };

        fileListSessions.set(cursor, session);
      }
      session.touchedAt = Date.now();
      const maximumDirectoriesPerPage = 32;
      const maximumInspectedEntriesPerPage = 1000;
      let pageScannedDirectories = 0;
      let pageInspectedEntries = 0;
      const entries = [];

      while (session.pending.length && entries.length < pageSize && pageScannedDirectories < maximumDirectoriesPerPage && pageInspectedEntries < maximumInspectedEntriesPerPage) {
        if (session.cancelled) throw Object.assign(new Error('文件枚举已取消'), { code: fileListCancelledCode });
        const current = session.pending.shift();
        if (current.depth > 64) continue;
        const directoryReal = await fs.promises.realpath(current.directory).catch(() => '');
        const containment = directoryReal ? path.relative(current.boundary, directoryReal) : '..';
        if (!directoryReal || containment.startsWith('..') || path.isAbsolute(containment)) continue;
        const directoryStat = await fs.promises.lstat(current.directory, { bigint: true }).catch(() => null);
        if (!directoryStat || directoryStat.isSymbolicLink()) continue;
        const directoryIdentity = `${directoryStat.dev}:${directoryStat.ino}`;
        if (session.visitedDirectories.has(directoryIdentity) && !current.offset) continue;
        session.visitedDirectories.add(directoryIdentity);
        pageScannedDirectories += 1;
        session.scannedDirectories += 1;
        let children;
        try {
          children = await fs.promises.readdir(current.directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a file-list directory', { directory: current.directory, error: error.message || String(error) });
          continue;
        }
        const visibleChildren = children
          .filter(child => !child.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) && !isInternalFileOperationEntry(child.name))
          .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        let offset = Math.max(0, Number(current.offset) || 0);
        for (; offset < visibleChildren.length && entries.length < pageSize && pageInspectedEntries < maximumInspectedEntriesPerPage; offset += 1) {
          const child = visibleChildren[offset];
          const childPath = path.join(current.directory, child.name);
          pageInspectedEntries += 1;
          session.inspectedEntries += 1;
          let stat;
          try { stat = await fs.promises.lstat(childPath); }
          catch (error) {
            writeLog('warn', 'Unable to inspect a file-list entry', { path: childPath, error: error.message || String(error) });
            continue;
          }
          if (session.cancelled) throw Object.assign(new Error('文件枚举已取消'), { code: fileListCancelledCode });
          if (stat.isDirectory()) {
            session.pending.push({ directory: childPath, boundary: current.boundary, depth: current.depth + 1, offset: 0, virtualPath: [current.virtualPath, child.name].filter(Boolean).join('/') });
            continue;
          }
          if (!stat.isFile()) continue;
          const extension = path.extname(child.name).toLowerCase();
          const kind = extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
          if (!projectFileListEntryMatchesFilter(child.name, kind, extension, session.filter)) continue;
          const relativePath = [current.virtualPath, child.name].filter(Boolean).join('/');
          const parentRelativePath = current.virtualPath;
          const sourceChannel = kind === 'shortcut' ? shortcutSourceChannel(childPath) : undefined;
          entries.push({ name: child.name, path: childPath, relativePath, parentRelativePath, parentName: path.basename(current.directory), kind, extension, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs || 0, updatedAt: stat.mtimeMs || 0, ...(sourceChannel ? { sourceChannel } : {}) });
        }
        if (offset < visibleChildren.length) session.pending.unshift({ ...current, offset });
      }
      if (session.cancelled) throw Object.assign(new Error('文件枚举已取消'), { code: fileListCancelledCode });
      const hasMore = session.pending.length > 0;
      if (!hasMore) fileListSessions.delete(cursor);
      return { success: true, scope: path.relative(root, scope).replace(/\\/g, '/'), entries, cursor: hasMore ? cursor : undefined, hasMore, truncated: hasMore, skippedCount: 0, scannedDirectories: session.scannedDirectories, inspectedEntries: session.inspectedEntries };
    } catch (error) {
      writeLog('warn', 'Unable to list project files', { projectName, scopeRelativePath, error: error.message || String(error) });
      return { success: false, entries: [], error: error.message || String(error), errorCode: error?.code === fileListCancelledCode || error?.code === fileListSessionExpiredCode ? error.code : undefined };
    } finally { releaseCursor(); }
  });

  ipcMain.handle('workspace-cancel-list-files', async (_event, requestedCursor = '') => {
    pruneFileListSessions();
    const cursor = String(requestedCursor || '');
    if (!cursor || !fileListSessions.has(cursor)) return { success: false, errorCode: fileListSessionExpiredCode, error: '文件枚举会话已失效' };
    fileListSessions.get(cursor).cancelled = true;
    fileListSessions.delete(cursor);
    cancelledFileListCursors.set(cursor, Date.now());
    return { success: true };
  });

  registerRecentProjectFileIpc({
    Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES, IMAGE_EXTENSIONS, Math, Number: workspaceNumber, Object, Promise, RAW_EXTENSIONS, Set, String,
    VIDEO_EXTENSIONS, assertExistingInside, assertInside, crypto, fs, getProjectPath, ipcMain, isInternalFileOperationEntry,
    mediaService, path, shell, shortcutSourceChannel, virtualPaths, writeLog,
  });

  registerInspirationIpc({
    Array, Error, Set, String, assertExistingInside, fileSystemService, fs, getProjectPath, ipcMain, mainWindow, path, pushUndoOperation,
    resolveProjectEntry, uniqueDestination, writeLog,
  });

  registerEntryDetailsIpc({ Set, String, assertExistingInside, assertInside, fs, getProjectPath, ipcMain, path });

  registerWorkspaceImportIpc({
    sendToApplicationRenderers,
    Array,
    Boolean,
    CANCELLED_CODE,
    Date,
    Error,
    IMAGE_EXTENSIONS,
    IMPORT_GRAPH_RECEIPT_NAME,
    JSON, Math, Number: workspaceNumber,
    Object,
    Promise,
    RAW_EXTENSIONS,
    Set,
    String,
    VIDEO_EXTENSIONS,
    acknowledgeImportReceipt,
    activeProjectFileOperations,
    activeVideoTrimOperations,
    app,
    assertDiskSpace,
    assertExistingInside,
    assertRegularFile,
    backgroundTasks,
    canonicalImportManifestKey,
    captureIdentity,
    cleanProjectName,
    cleanupImportArtifacts,
    collectCopyPlan,
    commitImportManifest,
    comparablePath,
    copyFileAtomic,
    copyPlannedFiles,
    createProjectFileTask,
    crypto,
    dialog,
    ensureWorkspace,
    fs,
    getProjectPath,
    importStagingRoots,
    inspectImportReceipt,
    ipcMain,
    mainWindow,
    mediaRuntimeState,
    mediaService,
    moveFileAtomic,
    movePathAtomic,
    officeOpenXmlExtensions,
    path,
    progressImportConflictCache,
    pruneProgressImportConflictCache,
    pushUndoOperation,
    receiptLocationsForSession,
    reconcileWorkspaceCatalog,
    refreshWorkspaceCatalog,
    releaseCleanupOwnership,
    removeIfOwned,
    removeUndoOperation,
    replaceVideoFileWithRollback,
    resolveProjectEntry,
    resolveToolSource,
    resolveWorkspaceRoot,
    runPythonJsonAction,
    screenshotMainImageExtensions,
    shell,
    startDetachedBackgroundOperation,
    telemetryService,
    thumbnailService,
    undefined,
    uniqueDestination,
    validImportSessionId,
    validateImportReceiptManifest,
    versionService,
    virtualPaths,
    watchProjectFileRoot,
    workspaceCatalogs,
    writeLog,
  });

  return {
    runPersistentUndoClaimGc,

  };
};

module.exports = { normalizeProjectFileListFilter, projectFileListEntryMatchesFilter, projectFileListSessionMatches, registerWorkspaceIpc, runWorkspaceMaintenanceWithRetry, workspaceDatabaseTaskResource };
