const { applicationWindowFor } = require('../services/application-windows.cjs');
const { getProtectedProjectFolderRegistry } = require('../services/protected-project-folder.cjs');
const path = require('path');
const { createProjectFileTask } = require('../services/project-file-task-service.cjs');
const { createFallbackDragIcon, usableDragIcon } = require('../services/native-file-drag-service.cjs');
const { PUBLISH_PARTIAL_CODE, movePathsSameVolumeBatched, movePathAtomic: defaultMovePathAtomic, publishPathNoClobber: defaultPublishPathNoClobber, releaseCleanupOwnership: defaultReleaseCleanupOwnership } = require('../services/file-transfer-service.cjs');
const { physicalPathKey, identityFromStat, samePathIdentity: defaultSamePathIdentity } = require('../services/file-identity-service.cjs');
const { mapBounded, partitionRenames, createPlanCopyPipeline } = require('../services/file-operation-batches.cjs');
const { createDestinationAllocator, refreshRestoredCleanupOwnership } = require('../services/file-transfer-service.cjs');
const { downloadRemoteImages, stageDroppedImageFiles } = require('../services/remote-image-download-service.cjs');

const INSPIRATION_VIRTUAL_PROJECT_NAME = '.__photoflow_inspiration__';
const isInspirationVirtualProject = projectName => projectName === INSPIRATION_VIRTUAL_PROJECT_NAME;

const filesystemDeviceIdentity = stat => {
  try {
    const device = stat?.dev;
    if (typeof device === 'bigint') return device > 0n ? device.toString() : null;
    return typeof device === 'number' && Number.isSafeInteger(device) && device > 0 ? String(device) : null;
  } catch {
    return null;
  }
};

const sameFilesystemDevice = (sourceStat, destinationStat) => {
  const sourceDevice = filesystemDeviceIdentity(sourceStat);
  const destinationDevice = filesystemDeviceIdentity(destinationStat);
  return sourceDevice !== null && destinationDevice !== null && sourceDevice === destinationDevice;
};

const canUseSingleRenameMove = (platform, movePlan, destinationStat) => movePlan.length === 1
  && platform === 'win32'
  && sameFilesystemDevice(movePlan[0].sourceStat, destinationStat);

const canUseSameVolumeCut = (platform, clipboardOperation, sourceStats, destinationStat) => clipboardOperation === 'cut'
  && platform === 'win32'
  && sourceStats.length > 0
  && sourceStats.every(sourceStat => sameFilesystemDevice(sourceStat, destinationStat));

const committedMediaChangesFor = (items, { removeSources = false, removeOnly = false, includeSource = () => true, includeDestination = () => true } = {}) => (items || []).flatMap(item => {
  const isDirectory = Boolean(item?.isDirectory);
  const changes = [];
  if ((removeSources || removeOnly) && item?.source && includeSource(item.source, item)) changes.push({
    path: path.resolve(item.source), eventType: 'rename', kind: 'missing',
    previousKind: isDirectory ? 'directory' : 'file', previousExtension: isDirectory ? '' : path.extname(item.source).toLocaleLowerCase(),
  });
  if (!removeOnly && item?.destination && includeDestination(item.destination, item)) changes.push({
    path: path.resolve(item.destination), eventType: 'rename', kind: isDirectory ? 'directory' : 'file',
  });
  return changes;
});

const transferRecoveryFields = error => ({
  code: error?.code,
  errorCode: error?.code,
  transferStage: error?.transferStage,
  recoveryPath: error?.recoveryPath,
  recoveryPaths: Array.isArray(error?.recoveryPaths) ? error.recoveryPaths : undefined,
  outcomeUnknown: typeof error?.outcomeUnknown === 'boolean' ? error.outcomeUnknown : undefined,
  published: typeof error?.published === 'boolean' ? error.published : undefined,
  recoveryRequired: typeof error?.recoveryRequired === 'boolean' ? error.recoveryRequired : undefined,
  sourceRetained: typeof error?.sourceRetained === 'boolean' ? error.sourceRetained : undefined,
  cleanupWarning: error?.cleanupWarning || error?.cleanupError,
  ownershipToken: error?.ownershipToken,
  ownershipSnapshot: Array.isArray(error?.ownershipSnapshot) ? error.ownershipSnapshot : undefined,
  uncertainPaths: Array.isArray(error?.uncertainPaths) ? error.uncertainPaths : undefined,
  originalMissing: error?.originalMissing,
  identityVerified: error?.identityVerified,
  deleted: error?.deleted,
  partial: error?.partial,
  nativeError: error?.nativeError,
  nativeCode: error?.nativeCode,
  rollbackError: error?.rollbackError,
  cleanupCode: error?.cleanupCode,
  recoveryAvailable: error?.recoveryAvailable,
  publicationState: error?.publicationState,
  publishedConfirmed: error?.publishedConfirmed,
  phase: error?.phase,
  attemptedStagingPath: error?.attemptedStagingPath,
  stagingExists: typeof error?.stagingExists === 'boolean' ? error.stagingExists : undefined,
  targetExists: typeof error?.targetExists === 'boolean' ? error.targetExists : undefined,
});

const provenPublishedOwnership = async (error, identityMatches, resolvePath) => {
  const entries = (Array.isArray(error?.ownershipSnapshot) ? error.ownershipSnapshot : []).filter(item => item?.path && item?.identity);
  if (error?.published === true && error?.publishedIdentity && error?.destinationPath) entries.push({ path: error.destinationPath, identity: error.publishedIdentity, ownershipToken: error.ownershipToken });
  const byPath = new Map();
  for (const item of entries) byPath.set(physicalPathKey(item.path), item);
  const proven = [];
  const uncertainByKey = new Map();
  for (const candidate of Array.isArray(error?.uncertainPaths) ? error.uncertainPaths : []) {
    const resolved = resolvePath(candidate);
    uncertainByKey.set(physicalPathKey(resolved), resolved);
  }
  for (const [key, item] of byPath) {
    if (uncertainByKey.has(key)) continue;
    if (await identityMatches(item.path, item.identity).catch(() => false)) proven.push(item);
    else uncertainByKey.set(key, resolvePath(item.path));
  }
  if (uncertainByKey.size) error.uncertainPaths = [...uncertainByKey.values()];
  return proven;
};

const registerFileOperationsIpc = context => {
  context = require('../services/rename-performance-diagnostics.cjs').instrumentRenameContext(context);
  context = require('../services/file-operation-diagnostics.cjs').instrumentFileOperationContext(context);
  const { Array, Boolean, BrowserWindow, CANCELLED_CODE, Date, Error, IMAGE_EXTENSIONS, Math, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, activeProjectFileOperations, app, assertDiskSpace, assertExistingInside, assertInside, backgroundTasks, cancelMediaTrackingScan, cancelSystemFileCut, canUseNativeFastCut, capturePathIdentity, clearSystemFileClipboardIfCurrent, clipboard, collectCopyPlan, copyFileAtomic, copyPlannedFiles, crypto, ensureWorkspace, fileOperationState, fs, getProjectPath, ipcMain, movePathAtomic, movePlannedFilesFast, publishPathNoClobber = defaultPublishPathNoClobber, nativeImage, path, process, projectVirtualPaths, pushUndoOperation, readSystemFileClipboard, recycleBinService, releaseCleanupOwnership = defaultReleaseCleanupOwnership, releaseWorkspaceWatchPath, removeCopiedSources, removeCreatedPasteTargets, resumeToastViewAfterNativeDrag, samePathIdentity, scheduleMediaTrackingScan, screen, selectionService, suspendToastViewForNativeDrag, suppressWorkspaceWatchPath, throwIfCancelled, uniqueDestination, versionService, workspaceRepository, writeLog, writeSystemFileClipboard } = context;
  const { isProtectedProjectFolderName, isProtectedProjectFolderPath } = context.protectedProjectFolders || getProtectedProjectFolderRegistry();
  const nativeFileDragFallbackIcon = nativeImage ? createFallbackDragIcon(nativeImage) : null;
  const pasteDecisionTokens = new Map();
  const publishMoves = async (items, options = {}) => {
    if (items.length > 1 && publishPathNoClobber === defaultPublishPathNoClobber) {
      return movePathsSameVolumeBatched(items, options);
    }
    for (const [index, item] of items.entries()) {
      throwIfCancelled?.(options.isCancelled);
      await options.waitIfPaused?.();
      const published = await publishPathNoClobber(item.source, item.destination);
      await options.onMoved?.({ ...item, publishedIdentity: published?.identity }, index + 1);
    }
  };
  const legacyPasteDecisions = new Map();
  const decisionTtlMs = 10 * 60 * 1000;
  const prunePasteDecisions = () => {
    const now = Date.now();
    for (const [token, decision] of pasteDecisionTokens) if (decision.expiresAt <= now) pasteDecisionTokens.delete(token);
    for (const [key, decision] of legacyPasteDecisions) if (decision.expiresAt <= now) legacyPasteDecisions.delete(key);
    while (pasteDecisionTokens.size > 64) pasteDecisionTokens.delete(pasteDecisionTokens.keys().next().value);
    while (legacyPasteDecisions.size > 64) legacyPasteDecisions.delete(legacyPasteDecisions.keys().next().value);
  };
  const captureDecisionIdentity = async candidate => {
    if (typeof capturePathIdentity === 'function') return capturePathIdentity(candidate);
    const stat = await fs.promises.stat(candidate, { bigint: true });
    return { path: path.resolve(candidate), device: String(stat.dev), inode: String(stat.ino), directory: stat.isDirectory(), size: String(stat.size), modifiedNs: String(stat.mtimeNs) };
  };
  const decisionIdentityMatches = async (candidate, expected) => {
    if (typeof samePathIdentity === 'function') return samePathIdentity(candidate, expected);
    const current = await captureDecisionIdentity(candidate).catch(() => null);
    return Boolean(current && expected && current.device === expected.device && current.inode === expected.inode && current.directory === expected.directory);
  };
  const resolveVirtual = (root, relativePath, options = {}) => projectVirtualPaths
    ? projectVirtualPaths.resolve(root, relativePath, options)
    : (() => {
      const physicalPath = path.resolve(root, relativePath || '.');
      const relative = path.relative(root, physicalPath);
      if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) throw new Error('项目路径无效');
      return { projectRoot: root, virtualPath: String(relativePath || '').replace(/\\/g, '/'), physicalPath, mediaRoot: root };
    })();
  const pathInside = (parent, candidate) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const virtualPathFor = (root, physicalPath) => path.relative(root, physicalPath).replace(/\\/g, '/');
  const clipboardPathKey = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
  const physicalPathContains = (parent, candidate) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const registeredProgressForMutation = async (workspacePath, projectName, isRelevant) => {
    const root = ensureWorkspace(workspacePath);
    if (versionService.snapshotProgress) {
      const snapshot = await versionService.snapshotProgress(root, projectName, true);
      if (!snapshot?.success || !Array.isArray(snapshot.progressFolders)) throw new Error(snapshot?.error || '无法读取版本进度登记');
      // Read current registrations rather than caching "no versions". A newly
      // registered or missing progress folder must be protected immediately.
      if (!snapshot.progressFolders.some(isRelevant)) return snapshot;
    }
    return versionService.listProgress(root, projectName, true);
  };


  const assertNoRegisteredProgressRootMutation = async (workspacePath, projectName, resolutions, operation) => {
    if (isInspirationVirtualProject(projectName) || !new Set(['move', 'rename', 'trash', 'cut', 'cut-paste']).has(operation) || !versionService?.listProgress || !resolutions.length) return;
    // Regular files cannot contain a registered progress root. Avoid the
    // progress_list reconciliation (including directory scans and DB writes)
    // for these operations; directories still require it.
    const directoryResolutions = [];
    for (const resolution of resolutions) {
      try {
        if ((await fs.promises.stat(resolution?.physicalPath || resolution)).isDirectory()) directoryResolutions.push(resolution);
      } catch { /* normal missing-path validation follows */ }
    }
    if (!directoryResolutions.length) return;
    const listed = await registeredProgressForMutation(workspacePath, projectName, folder => folder.nodeRole === 'progress');
    if (!listed?.success) throw new Error(listed?.error || '无法读取版本进度登记');
    const registered = (listed.progressFolders || []).filter(folder => folder.nodeRole === 'progress' && folder.folderPath);
    for (const resolution of directoryResolutions) {
      const source = resolution?.physicalPath || resolution;
      const progress = registered.find(folder => {
        const exactPhysical = clipboardPathKey(folder.folderPath) === clipboardPathKey(source);
        const containsPhysical = physicalPathContains(source, folder.folderPath);
        if (operation === 'trash') return containsPhysical && !exactPhysical;
        return containsPhysical;
      });
      if (progress) throw new Error(`已登记的版本进度“${progress.displayName || path.basename(progress.folderPath)}”不能通过普通文件操作或其祖先目录迁移；请使用版本进度专用功能`);
    }
  };


  const assertNoProtectedPasteReplacement = async (workspacePath, projectName, projectRoot, destinations) => {
    if (!destinations.length) return;
    const progressFolders = [];
    if (!isInspirationVirtualProject(projectName) && versionService?.listProgress) {
      const listed = await versionService.listProgress(ensureWorkspace(workspacePath), projectName, true);
      if (!listed?.success) throw new Error(listed?.error || '无法读取版本进度登记');
      progressFolders.push(...(listed.progressFolders || []).filter(folder => folder.nodeRole === 'progress'));
    }
    for (const destination of destinations) {
      const protectedCoreFolder = !context.isOrdinaryProjectRoot?.(projectRoot) && isProtectedProjectFolderPath({ fs, path, projectRoot, candidate: destination });
      const registeredProgress = progressFolders.find(folder => {
        const protectsPhysicalPath = folder.folderPath && physicalPathContains(destination, folder.folderPath);
        return protectsPhysicalPath;
      });
      if (protectedCoreFolder || registeredProgress) {
        const label = registeredProgress?.displayName || path.basename(destination);
        throw new Error(`受保护的项目目标“${label}”不能通过普通粘贴替换；请使用对应的项目或版本管理功能`);
      }
    }
  };
  const clearClipboardIfSnapshotCurrent = async snapshot => {
    if (snapshot?.operation !== 'cut' || !snapshot.sources?.length) return false;
    if (process.platform === 'win32') {
      try {
        const result = await clearSystemFileClipboardIfCurrent(snapshot);
        return Boolean(result?.cleared);
      } catch (error) {
        writeLog('warn', 'Unable to clear completed cut clipboard safely', error);
        return false;
      }
    }
    let current;
    try { current = await readSystemFileClipboard(); }
    catch (error) {
      writeLog('warn', 'Unable to verify cut clipboard ownership before clearing', error);
      return false;
    }
    const expected = new Set(snapshot.sources.map(clipboardPathKey));
    const currentSources = current?.sources || [];
    const actual = new Set(currentSources.map(clipboardPathKey));
    return current?.operation === 'cut'
      && currentSources.length === snapshot.sources.length
      && actual.size === expected.size
      && [...actual].every(source => expected.has(source));
  };

  const copyPlanFingerprint = plan => {
    const records = plan.map(entry => JSON.stringify({
      kind: entry.kind,
      source: path.resolve(entry.source),
      size: Number(entry.size) || 0,
      identity: entry.sourceIdentity || {},
      children: entry.children || [],
    })).sort();
    return crypto.createHash('sha256').update(records.join('\n')).digest('hex');
  };

  const resumeCopyPaste = async interruptedTask => {
    const checkpoint = interruptedTask?.checkpoint || {};
    if (checkpoint.kind !== 'paste-copy-v1' || checkpoint.phase !== 'copying' || !Array.isArray(checkpoint.files) || !checkpoint.files.length) throw new Error('该粘贴任务没有可继续的复制断点');
    const root = path.resolve(getProjectPath(checkpoint.workspacePath, checkpoint.status, checkpoint.projectName));
    const destinationResolution = resolveVirtual(root, checkpoint.targetRelativePath || '', { externalRootMode: 'target' });
    const destinationDir = path.resolve(destinationResolution.physicalPath);
    if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('粘贴目标文件夹当前不可用');
    const incomingRoot = path.join(destinationDir, `.photoflow-paste-${interruptedTask.id}`);
    const incomingStat = await fs.promises.lstat(incomingRoot).catch(() => null);
    if (incomingStat?.isSymbolicLink()) throw new Error('粘贴暂存目录不安全');
    await fs.promises.mkdir(incomingRoot, { recursive: true });
    const safeName = value => typeof value === 'string' && value && path.basename(value) === value && !/[\0\r\n]/.test(value);
    const targets = [];
    const plan = [];
    for (const [index, item] of checkpoint.files.entries()) {
      if (!safeName(item.destinationName) || !safeName(item.stagedName) || item.stagedName !== `${index}-${item.destinationName}`) throw new Error('粘贴断点中的目标名称无效');
      const source = path.resolve(String(item.source || ''));
      const sourceStat = await fs.promises.stat(source).catch(() => null);
      const expectedDirectory = Boolean(item.isDirectory);
      const sourceInvalid = !sourceStat || (expectedDirectory
        ? !sourceStat.isDirectory()
        : !sourceStat.isFile() || sourceStat.size !== Number(item.size) || Math.abs(sourceStat.mtimeMs - Number(item.mtimeMs)) >= 1);
      if (sourceInvalid) throw new Error(`源文件在暂停后发生变化：${path.basename(source)}`);
      const destination = path.join(destinationDir, item.destinationName);
      const stagedDestination = path.join(incomingRoot, item.stagedName);
      if (fs.existsSync(destination)) throw new Error(`目标位置已经出现同名文件：${item.destinationName}`);
      targets.push({ source, destination, stagedDestination, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, isDirectory: expectedDirectory });
      await collectCopyPlan(source, stagedDestination, plan);
    }
    if (targets.some(item => item.isDirectory) && !checkpoint.planFingerprint) throw new Error('文件夹粘贴断点缺少完整性指纹');
    if (checkpoint.planFingerprint && copyPlanFingerprint(plan) !== checkpoint.planFingerprint) throw new Error('源文件夹内容在暂停后发生变化');
    const removeStaleParts = async directory => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) await removeStaleParts(candidate);
        else if (entry.isFile() && entry.name.endsWith('.photoflow-part')) await fs.promises.rm(candidate, { force: true });
      }
    };
    await removeStaleParts(incomingRoot);
    const totalBytes = plan.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    const totalFiles = plan.filter(item => item.kind === 'file').length;
    let bytesCopied = 0;
    let filesCopied = 0;
    const run = () => backgroundTasks.run({
      id: interruptedTask.id,
      type: 'project-file-operation',
      title: `继续粘贴文件 · ${checkpoint.projectName}`,
      cancellable: true,
      pausable: true,
      resumable: true,
      checkpoint,
      progress: interruptedTask.progress,
      resumeFactory: resumeCopyPaste,
      resources: [...targets.map(item => item.source), destinationDir],
      metadata: { operation: 'paste', projectName: checkpoint.projectName, workspacePath: checkpoint.workspacePath, phase: 'copying' },
    }, async task => {
      await copyPlannedFiles(plan, {
        destinationRoot: destinationDir,
        ownershipToken: interruptedTask.id,
        getPartialState: entry => checkpoint.partialFiles?.[path.relative(incomingRoot, entry.destination)],
        onPartialState: (entry, state) => {
          const key = path.relative(incomingRoot, entry.destination);
          checkpoint.partialFiles = { ...checkpoint.partialFiles, [key]: state };
          if (!state) delete checkpoint.partialFiles[key];
          task.saveCheckpoint(checkpoint, totalBytes ? Math.min(98, bytesCopied / totalBytes * 98) : 0, '正在复制，可从断点继续');
          return state ? backgroundTasks?.flush?.() !== false : true;
        },
        isCancelled: () => task.signal.aborted,
        waitIfPaused: () => task.waitIfPaused(),
        isEntryComplete: async entry => {
          const stat = await fs.promises.stat(entry.destination).catch(() => null);
          return entry.kind === 'directory'
            ? Boolean(stat?.isDirectory())
            : Boolean(stat?.isFile() && stat.size === entry.size && Math.abs(stat.mtimeMs - entry.mtime.getTime()) < 1);
        },
        onProgress: ({ bytesDelta, fileCompleted }) => {
          bytesCopied += bytesDelta;
          if (fileCompleted) filesCopied += 1;
          task.report(totalBytes ? Math.min(98, bytesCopied / totalBytes * 98) : 98, `正在继续粘贴 ${filesCopied}/${totalFiles}`, { bytesCopied, totalBytes, filesCopied, totalFiles });
        },
      });
      task.setPausable(false);
      task.saveCheckpoint({ ...checkpoint, phase: 'finalizing' }, 99, '正在完成粘贴');
      const published = [];
      try {
        await publishMoves(targets.map(item => ({ ...item, source: item.stagedDestination })), {
          isCancelled: () => task.signal.aborted,
          onMoved: item => { published.push(item); },
        });
        await fs.promises.rmdir(incomingRoot);
      } catch (error) {
        let restoredAll = !error.outcomeUnknown;
        for (const item of published.reverse()) {
          try {
            if (!await samePathIdentity(item.destination, item.publishedIdentity)) { restoredAll = false; continue; }
            const restored = await publishPathNoClobber(item.destination, item.source);
            await refreshRestoredCleanupOwnership(interruptedTask.id, item.source, restored?.identity);
          } catch { restoredAll = false; }
        }
        if (restoredAll) task.saveCheckpoint(checkpoint, 98, '复制已完成，等待重新完成粘贴');
        else { error.recoveryRequired = true; error.recoveryPaths = [...new Set([...(error.recoveryPaths || []), incomingRoot, ...published.map(item => item.destination).filter(candidate => fs.existsSync(candidate))])]; }
        throw error;
      }
      releaseCleanupOwnership(interruptedTask.id);
      await pushUndoOperation({ kind: 'remove-created', paths: targets.map(item => item.destination), label: '粘贴' }).catch(error => writeLog('warn', 'Unable to record resumed paste undo history', error));
      task.report(100, '文件粘贴完成', { bytesCopied: totalBytes, totalBytes, filesCopied: totalFiles, totalFiles });
      return { count: targets.length, createdPaths: targets.map(item => item.destination) };
    });
    return run();
  };
  backgroundTasks?.registerTypeResumeFactory?.('project-file-operation', resumeCopyPaste, {
    canResume: task => task.checkpoint?.kind === 'paste-copy-v1' && task.checkpoint?.phase === 'copying',
  });

  ipcMain.handle('workspace-file-details', async (_event, workspacePath, status, projectName, relativePaths = []) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requested = Array.isArray(relativePaths) ? relativePaths.slice(0, 500) : [];
      const details = (await Promise.all(requested.map(async relativePath => {
        try {
          const resolved = resolveVirtual(root, relativePath, { externalRootMode: 'target' });
          const safePath = resolved.physicalPath;
          const stat = await fs.promises.stat(safePath);
          // Keep the caller's path spelling as the response identity. On Windows,
          // browse results may contain backslashes while the virtual-path resolver
          // canonicalizes them to forward slashes. Returning the canonical path
          // makes the renderer's metadata map miss the entry that requested it.
          return { relativePath, size: stat.size, createdAt: stat.birthtimeMs || stat.ctimeMs, updatedAt: stat.mtimeMs };
        } catch { return null; }
      }))).filter(Boolean);
      return { success: true, details };
    } catch (error) { return { success: false, details: [], error: error.message || String(error) }; }
  });

  ipcMain.handle('workspace-cancel-file-operation', async (_event, operationId) => {
    const job = activeProjectFileOperations.get(operationId);
    if (!job || job.finishing) return { success: false, error: job?.finishing ? '文件已复制完成，正在整理源文件' : '操作已结束' };
    job.cancelled = true;
    job.cancel?.();
    return { success: true };
  });

  const resolveFileDragSources = (workspacePath, status, projectName, relativePaths) => {
    if (!Array.isArray(relativePaths) || !relativePaths.length) throw new Error('没有可拖动的文件');
    const root = path.resolve(getProjectPath(workspacePath, status, projectName));
    const seenSources = new Set();
    const sources = [];
    const validatedPaths = [];
    const sourceSummary = { directoryCount: 0, fileCount: 0, otherCount: 0 };
    for (const relativePath of relativePaths) {
      if (typeof relativePath !== 'string' || !relativePath) throw new Error('无效的文件路径');
      const source = resolveVirtual(root, relativePath, { externalRootMode: 'target' }).physicalPath;
      const sourceKey = process.platform === 'win32' ? path.resolve(source).toLocaleLowerCase() : path.resolve(source);
      if (seenSources.has(sourceKey)) continue;
      let stat;
      try { stat = fs.statSync(source); }
      catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`文件不存在：${path.basename(source)}`);
        throw error;
      }
      seenSources.add(sourceKey);
      sources.push(source);
      validatedPaths.push(String(relativePath).replace(/\\/g, '/'));
      if (stat.isDirectory()) sourceSummary.directoryCount += 1;
      else if (stat.isFile()) sourceSummary.fileCount += 1;
      else sourceSummary.otherCount += 1;
    }
    if (!sources.length) throw new Error('没有可拖动的文件');
    return {
      sources,
      sourceSummary,
      relativePaths: validatedPaths,
    };
  };

  ipcMain.on('workspace-start-file-drag', async (event, workspacePath, status, projectName, relativePaths = [], dragContext = {}) => {
    let validatedRelativePaths = [];
    let nativeDragStarted = false;
    let toastViewSuspended = false;
    const sessionId = typeof dragContext?.sessionId === 'string' ? dragContext.sessionId.slice(0, 120) : '';
    const sourcePageId = typeof dragContext?.sourcePageId === 'string' ? dragContext.sourcePageId.slice(0, 200) : '';
    const origin = dragContext?.origin === 'version-tree' ? 'version-tree' : 'file-browser';
    const sendDragEnded = () => {
      if (event.sender.isDestroyed()) return;
      const ownerWindow = applicationWindowFor(event.sender, BrowserWindow);
      const contentBounds = ownerWindow?.getContentBounds();
      const cursor = screen.getCursorScreenPoint();
      const clientX = contentBounds ? cursor.x - contentBounds.x : -1;
      const clientY = contentBounds ? cursor.y - contentBounds.y : -1;
      const insideWindow = Boolean(contentBounds && clientX >= 0 && clientY >= 0 && clientX < contentBounds.width && clientY < contentBounds.height);
      writeLog('info', 'Native project file drag completion', { sessionId, origin, clientX, clientY, insideWindow, started: nativeDragStarted });
      event.sender.send('workspace-file-drag-ended', {
        sessionId, sourcePageId, origin, paths: validatedRelativePaths, clientX, clientY, insideWindow,
        started: nativeDragStarted,
      });
    };
    try {
      const resolved = resolveFileDragSources(workspacePath, status, projectName, relativePaths);
      validatedRelativePaths = resolved.relativePaths;
      let icon = nativeFileDragFallbackIcon;
      try {
        const shellIcon = await app.getFileIcon(resolved.sources[0], { size: 'normal' });
        if (usableDragIcon(shellIcon)) icon = shellIcon;
        else writeLog('warn', 'Shell returned an empty native project file drag icon', { projectName });
      } catch (error) {
        writeLog('warn', 'Unable to create native project file drag icon', { projectName, error: error?.message || String(error) });
      }
      if (!icon) throw new Error('无法创建原生拖拽图标');
      if (event.sender.isDestroyed()) return;
      const startedAt = Date.now();
      const details = { count: resolved.sources.length, mode: resolved.sources.length === 1 ? 'file' : 'files', icon: icon === nativeFileDragFallbackIcon ? 'visible-fallback' : 'fresh-shell', ...resolved.sourceSummary };
      writeLog('info', 'Starting native project file drag', details);
      suspendToastViewForNativeDrag?.();
      toastViewSuspended = true;
      event.sender.startDrag(resolved.sources.length === 1
        ? { file: resolved.sources[0], icon }
        : { file: resolved.sources[0], files: resolved.sources, icon });
      writeLog('info', 'Native project file drag ended', { ...details, gestureDurationMs: Math.max(0, Date.now() - startedAt) });
      nativeDragStarted = true;
    } catch (error) {
      writeLog('error', 'Unable to start native project file drag', error);
      if (!event.sender.isDestroyed()) event.sender.send('app-error', error.message || String(error));
    } finally {
      if (toastViewSuspended) resumeToastViewAfterNativeDrag?.();
      sendDragEnded();
    }
  });

  ipcMain.handle('workspace-file-clipboard-status', async () => {
    let fileClipboardError = null;
    try {
      const systemClipboard = await readSystemFileClipboard();
      if (systemClipboard) {
        const systemSources = systemClipboard.sources?.filter(source => fs.existsSync(path.resolve(source))) || [];
        if (systemSources.length > 0) return { success: true, hasFiles: true };
      }
    } catch (error) {
      writeLog('warn', 'Unable to inspect the system file clipboard', error);
      fileClipboardError = error;
    }
    try {
      const image = clipboard.readImage();
      if (image && !image.isEmpty()) return { success: true, hasFiles: true, hasImage: true };
    } catch (error) {
      writeLog('warn', 'Unable to inspect clipboard image data', error);
    }
    if (process.platform === 'win32' && fileClipboardError) return { success: false, hasFiles: false, error: fileClipboardError.message || String(fileClipboardError) };
    if (process.platform === 'win32') return { success: true, hasFiles: false };
    return { success: true, hasFiles: Boolean(fileOperationState.projectFileClipboard?.sources?.some(source => fs.existsSync(source))) };
  });

  ipcMain.handle('workspace-cancel-file-cut', async (_event, workspacePath, status, projectName, relativePaths = []) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const sources = Array.from(new Set(relativePaths.map(relativePath => {
        if (typeof relativePath !== 'string' || !relativePath) throw new Error('无效的剪切路径');
        return resolveVirtual(root, relativePath, { externalRootMode: 'link' }).physicalPath;
      })));
      if (!sources.length) return { success: true, cleared: false, hasFiles: false };
      if (process.platform === 'win32') {
        const result = await cancelSystemFileCut(sources);
        return { success: true, ...result };
      }
      const current = fileOperationState.projectFileClipboard;
      const currentSources = current?.sources || [];
      const expectedKeys = new Set(sources.map(source => path.resolve(source)));
      const matchesExpectedCut = current?.operation === 'cut'
        && currentSources.length === expectedKeys.size
        && currentSources.every(source => expectedKeys.has(path.resolve(source)));
      if (matchesExpectedCut) fileOperationState.projectFileClipboard = null;
      return { success: true, cleared: matchesExpectedCut, hasFiles: !matchesExpectedCut && currentSources.some(source => fs.existsSync(source)) };
    } catch (error) {
      writeLog('warn', 'Unable to cancel project file cut', error);
      return { success: false, cleared: false, hasFiles: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-file-operation', async (event, workspacePath, status, projectName, operation, relativePaths = [], targetRelativePath = '', nextName = '', options = {}) => {
    let suppressedProjectRoot = '';
    let remoteImportTempRoot = '';
    const committedMediaChanges = [];
    const responseContext = { operationId: '', taskNotificationOwned: false, affectedDirectories: [], count: 0 };
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const sourceBelongsToProject = candidate => pathInside(root, candidate);
      const recordCommittedMediaChanges = (items, changeOptions = {}) => committedMediaChanges.push(...committedMediaChangesFor(items, {
        ...changeOptions, includeSource: sourceBelongsToProject, includeDestination: sourceBelongsToProject,
      }));
      const resolveSource = relativePath => resolveVirtual(root, relativePath, { externalRootMode: 'link' });
      const resolveDestination = relativePath => resolveVirtual(root, relativePath, { externalRootMode: 'target' });
      if (operation === 'import-url' || operation === 'import-data') {
        const destinationDir = resolveDestination(targetRelativePath).physicalPath;
        if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('目标文件夹不存在');
        const temporaryRoot = context.remoteImageTemporaryRoot || app?.getPath?.('temp');
        if (!temporaryRoot) throw new Error('无法创建网页图片临时目录');
        remoteImportTempRoot = await fs.promises.mkdtemp(path.join(temporaryRoot, 'photoflow-web-image-'));
        if (operation === 'import-data') {
          relativePaths = await stageDroppedImageFiles(options?.droppedImageFiles, remoteImportTempRoot, { fs, path });
        } else {
          const lookup = context.resolveRemoteHost || (context.dns?.promises?.lookup ? context.dns.promises.lookup.bind(context.dns.promises) : undefined);
          relativePaths = await downloadRemoteImages(relativePaths, remoteImportTempRoot, {
            fetch: context.fetch || globalThis.fetch,
            fs,
            path,
            lookup,
            net: context.net,
          });
        }
        operation = 'import';
      }
      if (new Set(['import', 'move', 'paste', 'trash', 'select', 'rename']).has(operation)) {
        cancelMediaTrackingScan?.(ensureWorkspace(workspacePath), projectName);
        suppressWorkspaceWatchPath?.(root);
        suppressedProjectRoot = root;
      }
      if (operation === 'import') {
        const operationId = crypto.randomUUID();
        let job = { cancelled: false, finishing: false };
        let task = null;
        const publish = payload => task?.publish(payload);
        const createdTargets = [];
        if (!Array.isArray(relativePaths) || !relativePaths.length || relativePaths.length > 500) throw new Error('没有可导入的文件');
        const destinationResolution = resolveDestination(targetRelativePath);
        const destinationDir = destinationResolution.physicalPath;
        if (!fs.existsSync(destinationDir)) throw new Error('目标文件夹不存在');
        const destinationStat = fs.statSync(destinationDir);
        if (!destinationStat.isDirectory()) throw new Error('目标文件夹不存在');
        const sources = Array.from(new Set(relativePaths.map(source => {
          if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('无效的外部文件路径');
          const resolvedSource = path.resolve(source);
          if (!fs.existsSync(resolvedSource)) throw new Error(`文件不存在：${path.basename(resolvedSource)}`);
          if (resolvedSource === destinationDir || destinationDir.startsWith(resolvedSource + path.sep)) throw new Error('不能将文件夹复制到自身或其子文件夹中');
          return resolvedSource;
        })));
        const reservedDestinations = new Set();
        const importPlan = sources.map(source => {
          const stat = fs.statSync(source);
          let destination = path.join(destinationDir, path.basename(source));
          const parsed = path.parse(destination);
          let index = 1;
          while (fs.existsSync(destination) || reservedDestinations.has(destination.toLowerCase())) {
            destination = stat.isDirectory()
              ? path.join(destinationDir, `${path.basename(source)} (${index++})`)
              : path.join(destinationDir, `${parsed.name} (${index++})${parsed.ext}`);
          }
          reservedDestinations.add(destination.toLowerCase());
          return { source, destination, isDirectory: stat.isDirectory() };
        });
        task = createProjectFileTask({
          backgroundTasks, event, operationId, operation: 'import', title: `导入文件 · ${projectName}`,
          projectName, resources: [destinationDir, ...sources], cancelledCode: CANCELLED_CODE,
        });
        job = task.job;
        job.cancel = task.cancel;
        activeProjectFileOperations.set(operationId, job);
        try {
          responseContext.operationId = operationId;
          responseContext.taskNotificationOwned = true;
          await task.start();
          const plan = [];
          publish({ phase: 'scanning', progress: 0, currentName: '', bytesCopied: 0, totalBytes: 0, filesCopied: 0, totalFiles: 0 });
          for (const entry of importPlan) {
            throwIfCancelled(() => job.cancelled);
            await collectCopyPlan(entry.source, entry.destination, plan, { isCancelled: () => job.cancelled });
          }
          const totalBytes = plan.reduce((sum, entry) => sum + entry.size, 0);
          const totalFiles = plan.filter(entry => entry.kind === 'file').length;
          await assertDiskSpace(destinationDir, totalBytes);
          let bytesCopied = 0;
          let filesCopied = 0;
          let lastPublishedAt = 0;
          const reportCopyProgress = (currentName, force = false) => {
            const now = Date.now();
            if (!force && now - lastPublishedAt < 150) return;
            lastPublishedAt = now;
            const progress = totalBytes > 0
              ? Math.min(99, Math.round(bytesCopied / totalBytes * 100))
              : Math.min(99, Math.round(filesCopied / Math.max(1, totalFiles) * 100));
            publish({ phase: 'copying', progress, currentName, bytesCopied, totalBytes, filesCopied, totalFiles });
          };
          reportCopyProgress('', true);
          const transferStats = await copyPlannedFiles(plan, {
            destinationRoot: destinationDir,
            ownershipToken: operationId,
            diskSpaceChecked: true,
            isCancelled: () => job.cancelled,
            waitIfPaused: () => task.waitIfPaused(),
            onCreated: target => createdTargets.push(target),
            onFileStart: entry => reportCopyProgress(path.basename(entry.source)),
            onProgress: ({ entry, bytesDelta, fileCompleted }) => {
              bytesCopied += bytesDelta;
              if (fileCompleted) filesCopied += 1;
              reportCopyProgress(path.basename(entry.source));
            },
          });
          throwIfCancelled(() => job.cancelled);
          task.setPausable(false);
          job.finishing = true;
          publish({ phase: 'finishing', progress: 99, currentName: '正在完成文件导入', bytesCopied, totalBytes, filesCopied, totalFiles });
          if (importPlan.length) await pushUndoOperation({ kind: 'remove-created', paths: importPlan.map(item => item.destination), label: '导入' });
          releaseCleanupOwnership(operationId);
          publish({ phase: 'complete', progress: 100, currentName: '文件导入完成', bytesCopied, totalBytes, filesCopied, totalFiles });
          task.complete('文件导入完成');
          recordCommittedMediaChanges(importPlan.map(item => ({ destination: item.destination, isDirectory: item.isDirectory })));
          writeLog('info', 'External files imported by drag and drop', { projectName, targetRelativePath, count: importPlan.length, operationId, ...transferStats });
          return {
            success: true,
            count: importPlan.length,
            operationId,
            taskNotificationOwned: true,
            createdItems: importPlan.map(item => ({
              name: path.basename(item.destination),
              relativePath: virtualPathFor(root, item.destination, [destinationResolution]),
              isDirectory: item.isDirectory,
            })),
          };
        } catch (error) {
          if (error?.code === PUBLISH_PARTIAL_CODE) {
            const publishedOwnership = await provenPublishedOwnership(error, decisionIdentityMatches, path.resolve);
            const publishedPaths = publishedOwnership.map(item => path.resolve(item.path));
            recordCommittedMediaChanges(importPlan.filter(item => publishedPaths.some(candidate => (
              path.resolve(candidate) === path.resolve(item.destination) && fs.existsSync(item.destination)
            ))).map(item => ({ destination: item.destination, isDirectory: item.isDirectory })));
            const identities = Object.fromEntries(publishedOwnership.map(item => [path.resolve(item.path), item.identity]));
            let recoveryUndo = null;
            try { if (publishedPaths.length) {
              recoveryUndo = await pushUndoOperation({
                kind: 'remove-created', paths: publishedPaths, retainedSourcePaths: [error.sourcePath].filter(Boolean), identities, label: '恢复未完成导入',
              });
            } } catch (undoError) { writeLog('error', 'Unable to record partial import recovery', { operationId, error: undoError.message || String(undoError) }); }
            error.message = `${error.message || String(error)}；导入处于部分完成状态，${recoveryUndo ? '已创建可用撤销记录' : '请保留恢复副本'}：${error.sourcePath}`;
            publish({ phase: 'failed', progress: 99, currentName: '', error: error.message });
            task.fail(error);
            releaseCleanupOwnership(operationId);
            return { success: false, count: 0, operationId, taskNotificationOwned: true, error: error.message, ...transferRecoveryFields(error), recovery: { undoToken: recoveryUndo?.undoToken || '', publishedPaths, retainedSourcePaths: [error.sourcePath].filter(Boolean) } };
          }
          await removeCreatedPasteTargets(createdTargets, { ownershipToken: operationId });
          const cancelled = error?.code === CANCELLED_CODE;
          publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, currentName: '', error: error.message || String(error) });
          if (cancelled) task.cancelled();
          else task.fail(error);
          if (cancelled) return { success: false, cancelled: true, count: 0, operationId, taskNotificationOwned: true, error: '导入已取消' };
          throw error;
        } finally {
          activeProjectFileOperations.delete(operationId);
        }
      }
      const sourceResolutions = relativePaths.map(resolveSource);
      const sources = sourceResolutions.map(item => item.physicalPath);
      await assertNoRegisteredProgressRootMutation(workspacePath, projectName, sourceResolutions, operation);
      if (operation === 'move') {
        const operationId = crypto.randomUUID();
        responseContext.operationId = operationId;
        if (!sources.length) throw new Error('没有可移动的文件');

        const destinationResolution = resolveDestination(targetRelativePath);
        const destinationDir = destinationResolution.physicalPath;
        if (!fs.existsSync(destinationDir)) throw new Error('目标文件夹不存在');
        const destinationStat = fs.statSync(destinationDir);
        if (!destinationStat.isDirectory()) throw new Error('目标文件夹不存在');
        const reservedDestinations = new Set();
        const movePlan = sources.map(source => {
          if (!fs.existsSync(source)) throw new Error(`文件不存在：${path.basename(source)}`);
          const stat = fs.statSync(source);
          if (source === destinationDir || destinationDir.startsWith(source + path.sep)) throw new Error('不能将文件夹移动到自身或其子文件夹中');
          let destination = path.join(destinationDir, path.basename(source));
          const parsed = path.parse(destination);
          let index = 1;
          while (fs.existsSync(destination) || reservedDestinations.has(destination.toLowerCase())) {
            destination = stat.isDirectory()
              ? path.join(destinationDir, `${path.basename(source)} (${index++})`)
              : path.join(destinationDir, `${parsed.name} (${index++})${parsed.ext}`);
          }
          reservedDestinations.add(destination.toLowerCase());
          return { source, destination, sourceStat: stat };
        });
        const affectedDirectories = Array.from(new Set([
          destinationResolution.virtualPath,
          ...sourceResolutions.map(item => path.posix.dirname(item.virtualPath) === '.' ? '' : path.posix.dirname(item.virtualPath)),
        ]));
        responseContext.affectedDirectories = affectedDirectories;
        const singleSameVolumeMove = canUseSingleRenameMove(process.platform, movePlan, destinationStat);
        const batchedSameVolumeMove = process.platform === 'win32' && movePlan.length > 1
          && publishPathNoClobber === defaultPublishPathNoClobber && movePathAtomic === defaultMovePathAtomic
          && movePlan.every(entry => entry.sourceStat.isFile() && sameFilesystemDevice(entry.sourceStat, destinationStat));
        const task = createProjectFileTask({
          backgroundTasks, event, operationId, operation: 'move', title: `移动文件 · ${projectName}`,
          projectName, resources: [destinationDir, ...sources], cancelledCode: CANCELLED_CODE,
        });
        const job = task.job;
        job.cancel = task.cancel;
        const moved = [];
        activeProjectFileOperations.set(operationId, job);
        try {
          responseContext.taskNotificationOwned = true;
          await task.start();
          let discoveredCount = 0;
          let lastScanPublishedAt = 0;
          if (!singleSameVolumeMove) task.publish({ phase: 'scanning', progress: 0, currentName: '正在统计', processedCount: 0, totalCount: movePlan.length });
          if (batchedSameVolumeMove) {
            await movePathsSameVolumeBatched(movePlan, {
              isCancelled: () => job.cancelled,
              ownershipToken: operationId,
              onMoved: (entry, count) => {
                moved.push({ source: entry.source, destination: entry.destination, copied: false, publishedIdentity: entry.publishedIdentity });
                if (count % 256 === 0 || count === movePlan.length) task.publish({ phase: 'moving', progress: Math.round(count / movePlan.length * 100), currentName: path.basename(entry.source), processedCount: count, totalCount: movePlan.length });
              },
            });
          } else {
          for (const [index, entry] of movePlan.entries()) {
            throwIfCancelled(() => job.cancelled);
            task.publish({ phase: 'moving', progress: Math.round(index / Math.max(1, movePlan.length) * 100), currentName: path.basename(entry.source), processedCount: index, totalCount: movePlan.length });
            let result;
            if (singleSameVolumeMove) {
              await publishPathNoClobber(entry.source, entry.destination, { ownershipToken: operationId });
              result = { copied: false };
            } else {
              result = await movePathAtomic(entry.source, entry.destination, {
                ownershipToken: operationId,
                isCancelled: () => job.cancelled,
                onDiscovered: () => {
                  discoveredCount += 1;
                  const now = Date.now();
                  if (now - lastScanPublishedAt < 120) return;
                  lastScanPublishedAt = now;
                  task.publish({ phase: 'scanning', progress: 0, currentName: `正在统计，已发现 ${discoveredCount} 个文件和文件夹`, processedCount: discoveredCount, totalCount: 0 });
                },
              });
            }
            moved.push({ source: entry.source, destination: entry.destination, copied: Boolean(result?.copied) });
          }
          }
          job.finishing = true;
          let warning;
          let watchDegraded = false;
          if (moved.length) await pushUndoOperation({ kind: 'move', moves: moved }).catch(error => {
            warning = '文件已移动，但无法记录撤销操作';
            writeLog('warn', 'Unable to record committed file move undo', error);
          });

          task.publish({ phase: 'complete', progress: 100, currentName: '', processedCount: moved.length, totalCount: movePlan.length });
          task.complete('文件移动完成');
          recordCommittedMediaChanges(movePlan.map(item => ({ source: item.source, destination: item.destination, isDirectory: item.sourceStat.isDirectory() })), { removeSources: true });
          writeLog('info', 'Project files moved by internal drag', { projectName, targetRelativePath, count: moved.length, operationId });
          return {
            success: true,
            cancelled: false,
            errorCode: undefined,
            count: moved.length,
            operationId,
            taskNotificationOwned: true,
            affectedDirectories,
            movedItems: moved.map(entry => ({
              sourceRelativePath: virtualPathFor(root, entry.source, [...sourceResolutions]),
              destinationRelativePath: virtualPathFor(root, entry.destination, [destinationResolution]),
              copied: entry.copied,
            })),
            warning,
            watchDegraded,
          };
        } catch (error) {
          if (singleSameVolumeMove && error?.code === PUBLISH_PARTIAL_CODE) {
            const publishedOwnership = await provenPublishedOwnership(error, decisionIdentityMatches, path.resolve);
            const provenMoves = movePlan.filter(item => publishedOwnership.some(owned => path.resolve(owned.path) === path.resolve(item.destination)));
            recordCommittedMediaChanges(provenMoves.map(item => ({
              source: item.source, destination: item.destination, isDirectory: item.sourceStat.isDirectory(),
            })), { removeSources: true });
            const identities = Object.fromEntries(publishedOwnership.map(item => [path.resolve(item.path), item.identity]));
            let recoveryUndo = null;
            if (provenMoves.length) recoveryUndo = await pushUndoOperation({ kind: 'move', moves: provenMoves, identities, label: '恢复未完成移动' }).catch(undoError => { writeLog('error', 'Unable to record single-move recovery', { operationId, error: undoError.message || String(undoError) }); return null; });
            releaseCleanupOwnership(operationId);
            task.publish({ phase: 'failed', progress: 99, currentName: '', processedCount: 0, totalCount: movePlan.length, error: error.message || String(error) });
            task.fail(error);
            return { success: false, cancelled: false, count: 0, operationId, taskNotificationOwned: true, affectedDirectories, error: error.message || String(error), ...transferRecoveryFields(error), recovery: { undoToken: recoveryUndo?.undoToken || '', publishedPaths: publishedOwnership.map(item => item.path) } };
          }
          let rollbackError = null;
          for (const entry of [...moved].reverse()) {
            try {
              if (entry.publishedIdentity && !await samePathIdentity(entry.destination, entry.publishedIdentity)) throw Object.assign(new Error('移动目标已变化，无法安全回滚'), { code: 'UNDO_IDENTITY_MISMATCH' });
              if (fs.existsSync(entry.destination) && !fs.existsSync(entry.source)) await movePathAtomic(entry.destination, entry.source, { ownershipToken: operationId });
            } catch (candidate) { rollbackError = rollbackError || candidate; }
          }
          const cancelled = error?.code === CANCELLED_CODE;
          const reportedError = rollbackError ? new Error(`${error.message || String(error)}；回滚失败：${rollbackError.message || String(rollbackError)}`) : error;
          if (rollbackError) {
            recordCommittedMediaChanges(moved.filter(entry => fs.existsSync(entry.destination)).map(entry => ({
              destination: entry.destination, isDirectory: movePlan.find(item => path.resolve(item.source) === path.resolve(entry.source))?.sourceStat?.isDirectory(),
            })));
            recordCommittedMediaChanges(moved.filter(entry => !fs.existsSync(entry.source)).map(entry => ({
              source: entry.source, isDirectory: movePlan.find(item => path.resolve(item.source) === path.resolve(entry.source))?.sourceStat?.isDirectory(),
            })), { removeOnly: true });
          }
          task.publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, currentName: '', processedCount: 0, totalCount: movePlan.length, error: reportedError.message || String(reportedError) });
          if (cancelled) task.cancelled(); else task.fail(reportedError);
          return { success: false, cancelled, count: 0, operationId, taskNotificationOwned: true, affectedDirectories, error: cancelled ? '移动已取消' : reportedError.message || String(reportedError), ...transferRecoveryFields(reportedError), errorCode: cancelled ? CANCELLED_CODE : reportedError.code };
        } finally {
          releaseCleanupOwnership(operationId);
          activeProjectFileOperations.delete(operationId);
        }
      }
      if (operation === 'copy' || operation === 'cut') {

        if (!sources.length) throw new Error('未选择文件');
        fileOperationState.projectFileClipboard = process.platform === 'win32' ? null : { operation, sources };
        let clipboardWrite;
        try {
          clipboardWrite = await writeSystemFileClipboard(sources, operation);
        } catch (error) {
          fileOperationState.projectFileClipboard = null;
          writeLog('warn', 'Unable to sync project files to the system clipboard', error);
          throw new Error(`无法写入 Windows 文件剪贴板：${error.message || String(error)}`);
        }
        return { success: true, count: sources.length, clipboardGeneration: clipboardWrite?.sequence };
      }
      if (operation === 'paste') {
        const operationId = crypto.randomUUID();
        responseContext.operationId = operationId;
        const pasteProjectKey = clipboardPathKey(root);
        if ([...activeProjectFileOperations.values()].some(active => active?.operation === 'paste' && active?.projectKey === pasteProjectKey)) {
          throw new Error('当前项目已有文件粘贴任务，请等待完成后再试');
        }
        let affectedDirectories = [];
        let job = { cancelled: false, finishing: false, operation: 'paste', projectKey: pasteProjectKey };
        activeProjectFileOperations.set(operationId, job);
        let task = null;
        const createdTargets = [];
        const stagedReplacements = [];
        const committedTargets = [];
        let topLevelTargets = [];
        let incomingRoot = '';
        let replacementRoot = '';
        let pasteClipboardOperation = 'copy';
        let preserveMovedTargets = false;
        let pasteResumeCheckpoint = null;
        let scanCopyPipeline = null;
        let stopScanCopy = false;
        let abortScanCopy = () => {};
        const preCopiedEntries = new Set();
        const preCopiedIdentities = new Map();
        let preCopiedBytes = 0;
        const publish = payload => task?.publish(payload);
        publish({ phase: 'scanning', progress: 0, currentName: '', bytesCopied: 0, totalBytes: 0 });
        try {
          const destinationResolution = resolveDestination(targetRelativePath);
          const requestedDestination = destinationResolution.physicalPath;
          if (!fs.existsSync(requestedDestination)) throw new Error('目标文件夹不存在');
          const destinationStat = fs.statSync(requestedDestination);
          if (!destinationStat.isDirectory()) throw new Error('目标文件夹不存在');
          const destinationDir = requestedDestination;
          affectedDirectories = [destinationResolution.virtualPath];
          responseContext.affectedDirectories = affectedDirectories;
          let clipboardSnapshot = null;
          let fileClipboardError = null;
          try {
            const systemClipboard = await readSystemFileClipboard();
            if (systemClipboard) {
              const systemSources = (systemClipboard.sources || []).map(source => path.resolve(source)).filter(source => fs.existsSync(source));
              if (systemSources.length) clipboardSnapshot = { operation: systemClipboard.operation, sources: systemSources, sequence: systemClipboard.sequence };
            }
          } catch (error) {
            fileClipboardError = error;
            writeLog('warn', 'Unable to read system file clipboard; checking image clipboard data', error);
          }
          if (!clipboardSnapshot && process.platform !== 'win32' && fileOperationState.projectFileClipboard?.sources?.length) {
            clipboardSnapshot = { operation: fileOperationState.projectFileClipboard.operation, sources: [...fileOperationState.projectFileClipboard.sources] };
          }
          if (!clipboardSnapshot?.sources?.length) {
            let clipboardImage;
            try { clipboardImage = clipboard.readImage(); } catch (error) { writeLog('warn', 'Unable to read clipboard image data', error); }
            if (clipboardImage && !clipboardImage.isEmpty()) {
              const png = clipboardImage.toPNG();
              if (!png.length) throw new Error('剪贴板截图无法转换为 PNG');
              const stamp = new Date();
              const pad = value => String(value).padStart(2, '0');
              const screenshotName = `截图_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
              const destination = uniqueDestination(destinationDir, screenshotName, new Set(), false);
              const temporary = path.join(destinationDir, `.photoflow-paste-${operationId}.png`);
              task = createProjectFileTask({
                backgroundTasks, event, operationId, operation: 'paste', title: `粘贴截图 · ${projectName}`,
                projectName, resources: [destinationDir], cancelledCode: CANCELLED_CODE,
              });
              job = task.job;
              Object.assign(job, { operation: 'paste', projectKey: pasteProjectKey });
              job.cancel = task.cancel;
              activeProjectFileOperations.set(operationId, job);
              responseContext.taskNotificationOwned = true;
              await task.start();
              publish({ phase: 'copying', progress: 10, currentName: screenshotName, bytesCopied: 0, totalBytes: png.length, filesCopied: 0, totalFiles: 1 });
              throwIfCancelled(() => job.cancelled);
              try {
                await fs.promises.writeFile(temporary, png, { flag: 'wx' });
                throwIfCancelled(() => job.cancelled);
                await publishPathNoClobber(temporary, destination, { ownershipToken: operationId });
              } catch (error) {
                if (!error?.outcomeUnknown && !error?.recoveryRequired) await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
                throw error;
              }
              createdTargets.push(destination);
              job.finishing = true;
              await pushUndoOperation({ kind: 'remove-created', paths: [destination], label: '粘贴截图' }).catch(error => writeLog('warn', 'Unable to record screenshot paste undo history', error));
              publish({ phase: 'complete', progress: 100, currentName: screenshotName, bytesCopied: png.length, totalBytes: png.length, filesCopied: 1, totalFiles: 1, count: 1 });
              task.complete('截图已粘贴');
              recordCommittedMediaChanges([{ destination, isDirectory: false }]);
              writeLog('info', 'Clipboard screenshot pasted into project', { projectName, targetRelativePath, destination, operationId });
              return {
                success: true,
                cancelled: false,
                errorCode: undefined,
                count: 1,
                operationId,
                taskNotificationOwned: true,
                affectedDirectories,
                createdItems: [{ name: path.basename(destination), relativePath: virtualPathFor(root, destination, [destinationResolution]) }],
              };
            }
            if (fileClipboardError) {
              if (process.platform === 'win32') throw new Error(`无法读取 Windows 文件剪贴板：${fileClipboardError.message || String(fileClipboardError)}`);
            }
          }
          if (!clipboardSnapshot?.sources?.length) throw new Error('剪贴板中没有文件或文件夹');
          pasteClipboardOperation = clipboardSnapshot.operation;

          const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
          const uniqueSources = [];
          const seenSources = new Set();
          for (const candidate of clipboardSnapshot.sources) {
            const source = path.resolve(candidate);
            const key = pathKey(source);
            if (seenSources.has(key)) continue;
            seenSources.add(key);
            uniqueSources.push(source);
          }

          affectedDirectories = Array.from(new Set([
            ...affectedDirectories,
            ...(clipboardSnapshot.operation === 'cut' ? uniqueSources.map(source => virtualPathFor(root, path.dirname(source))) : []),
          ]));
          responseContext.affectedDirectories = affectedDirectories;
          task = createProjectFileTask({
            backgroundTasks, event, operationId, operation: 'paste', title: `粘贴文件 · ${projectName}`,
            projectName,
            resources: [
              { path: destinationDir, access: 'write' },
              ...uniqueSources.map(source => ({ path: source, access: clipboardSnapshot.operation === 'cut' ? 'write' : 'read' })),
            ],
            cancelledCode: CANCELLED_CODE,
          });
          job = task.job;
          Object.assign(job, { operation: 'paste', projectKey: pasteProjectKey });
          job.cancel = task.cancel;
          activeProjectFileOperations.set(operationId, job);
          responseContext.taskNotificationOwned = true;
          await task.start();
          publish({ phase: 'scanning', progress: 0, currentName: '正在检查文件', bytesCopied: 0, totalBytes: 0 });
          if (clipboardSnapshot.operation === 'cut') {
            const sourcePresence = await mapBounded(clipboardSnapshot.sources, 8, source => fs.promises.lstat(source).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }));
            const missingCutSources = clipboardSnapshot.sources.filter((_source, index) => !sourcePresence[index]);
            if (missingCutSources.length) throw new Error(`剪切源已被其他粘贴任务移动或删除，请重新剪切后再试：${path.basename(missingCutSources[0])}`);
          }
          const requestedItems = await mapBounded(uniqueSources.filter(source => clipboardSnapshot.operation !== 'cut' || pathKey(path.dirname(source)) !== pathKey(destinationDir)), 8, async source => {
            throwIfCancelled?.(() => job.cancelled);
            const sourceStat = await fs.promises.lstat(source, { bigint: true });
            if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error(`不支持粘贴此文件类型：${path.basename(source)}`);
            if (sourceStat.isDirectory() && pathKey(destinationDir).startsWith(`${pathKey(source)}${path.sep}`)) throw new Error('不能将文件夹粘贴到自身内部');
            const desiredDestination = path.join(destinationDir, path.basename(source));
            const sameSource = pathKey(desiredDestination) === pathKey(source);
            const conflictIdentity = sameSource ? null : await captureDecisionIdentity(desiredDestination).catch(error => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
            return { source, sourceStat, sourceIdentity: identityFromStat(source, sourceStat), desiredDestination, sameSource, conflict: Boolean(conflictIdentity), conflictIdentity };
          });
          if (clipboardSnapshot.operation === 'cut') {
            await assertNoRegisteredProgressRootMutation(
              workspacePath,
              projectName,
              uniqueSources.map(source => ({ physicalPath: source, virtualPath: virtualPathFor(root, source) })),
              'cut-paste',
            );
          }
          const sourceStatsByPath = new Map(requestedItems.map(item => [pathKey(item.source), item.sourceStat]));

          const pasteConflicts = requestedItems.filter(item => item.conflict).map(item => ({ source: item.source, destination: item.desiredDestination, isDirectory: Boolean(item.conflictIdentity.directory) }));
          let replaceConflicts = false;
          if (pasteConflicts.length) {
            const names = pasteConflicts.slice(0, 6).map(item => `“${path.basename(item.destination)}”`).join('、');
            const fileCount = pasteConflicts.filter(item => !item.isDirectory).length;
            const folderCount = pasteConflicts.length - fileCount;
            const conflictSummary = [fileCount ? `${fileCount} 个文件` : '', folderCount ? `${folderCount} 个文件夹` : ''].filter(Boolean).join('和');
            const more = pasteConflicts.length > 6 ? ` 等 ${conflictSummary}` : '';
            let conflictPolicy = ['replace', 'keep-both'].includes(options?.pasteConflictPolicy) ? options.pasteConflictPolicy : '';
            const decisionKey = `${pasteProjectKey}\u0000${clipboardPathKey(destinationDir)}`;
            const snapshot = {
              operation: clipboardSnapshot.operation,
              sequence: clipboardSnapshot.sequence,
              sources: requestedItems.map(item => ({ path: clipboardPathKey(item.source), identity: item.sourceIdentity })),
              destination: clipboardPathKey(destinationDir),
              destinationIdentity: await captureDecisionIdentity(destinationDir),
              conflicts: requestedItems.filter(item => item.conflict).map(item => ({ path: item.desiredDestination, identity: item.conflictIdentity })),
              expiresAt: Date.now() + decisionTtlMs,
            };
            const matchesSnapshot = async expected => Boolean(expected
              && expected.expiresAt > Date.now()
              && expected.operation === snapshot.operation
              && expected.sequence === snapshot.sequence
              && expected.destination === snapshot.destination
              && await decisionIdentityMatches(expected.destination, expected.destinationIdentity)
              && expected.sources.length === snapshot.sources.length
              && expected.sources.every((source, index) => source.path === snapshot.sources[index].path)
              && (await mapBounded(expected.sources, 8, source => decisionIdentityMatches(source.path, source.identity))).every(Boolean)
              && expected.conflicts.length === snapshot.conflicts.length
              && (await mapBounded(expected.conflicts, 8, conflict => decisionIdentityMatches(conflict.path, conflict.identity))).every(Boolean));
            const requestedDecisionToken = String(options?.decisionToken || '');
            prunePasteDecisions();
            if (conflictPolicy) {
              const expected = requestedDecisionToken ? pasteDecisionTokens.get(requestedDecisionToken) : legacyPasteDecisions.get(decisionKey) || snapshot;
              if (!await matchesSnapshot(expected)) conflictPolicy = '';
              else {
                if (requestedDecisionToken) pasteDecisionTokens.delete(requestedDecisionToken);
                for (const [token, decision] of pasteDecisionTokens) if (decision === expected) pasteDecisionTokens.delete(token);
                legacyPasteDecisions.delete(decisionKey);
              }
            }
            if (!conflictPolicy) {
              const decisionToken = crypto.randomUUID();
              pasteDecisionTokens.set(decisionToken, snapshot);
              legacyPasteDecisions.set(decisionKey, snapshot);
              publish({ phase: 'complete', progress: 100, currentName: '', count: 0, decisionRequired: true });
              task.complete('等待用户处理同名文件');
              return {
                success: true,
                cancelled: false,
                errorCode: undefined,
                count: 0,
                operationId,
                affectedDirectories,
                requiresDecision: {
                  kind: 'paste-conflict',
                  decisionToken,
                  names: pasteConflicts.slice(0, 6).map(item => path.basename(item.destination)),
                  fileCount,
                  folderCount,
                  message: `目标位置已有 ${names}${more}`,
                  detail: `发现 ${conflictSummary}。选择替换后，仅在新内容准备完成时替换旧项目；选择保留两者时，新项目会自动重命名。`,
                },
              };
            }
            replaceConflicts = conflictPolicy === 'replace';
          }
          if (replaceConflicts) {
            await assertNoProtectedPasteReplacement(
              workspacePath,
              projectName,
              root,
              pasteConflicts.map(item => item.destination),
            );
          }

          topLevelTargets = [];
          const reservedTargets = new Set();
          const replacedDestinations = new Set();
          const replacementIdentities = new Map();
          const allocateDestination = requestedItems.length > 32 ? await createDestinationAllocator(destinationDir) : null;
          for (const item of requestedItems) {
            throwIfCancelled(() => job.cancelled);
            const desiredKey = pathKey(item.desiredDestination);
            let destination;
            if (replaceConflicts && item.conflict && !reservedTargets.has(desiredKey)) {
              destination = item.desiredDestination;
              reservedTargets.add(desiredKey);
              replacedDestinations.add(desiredKey);
              replacementIdentities.set(desiredKey, item.conflictIdentity);
            } else {
              destination = allocateDestination
                ? allocateDestination(path.basename(item.source), item.sourceStat.isDirectory())
                : uniqueDestination(destinationDir, path.basename(item.source), reservedTargets, item.sourceStat.isDirectory());
              reservedTargets.add(pathKey(destination));
            }
            topLevelTargets.push({ source: item.source, destination, isDirectory: item.sourceStat.isDirectory() });
          }

          const sameVolumeCut = canUseSameVolumeCut(
            process.platform,
            clipboardSnapshot.operation,
            topLevelTargets.map(item => sourceStatsByPath.get(pathKey(item.source))),
            destinationStat,
          );
          const nativeFastCut = !sameVolumeCut && clipboardSnapshot.operation === 'cut'
            && typeof canUseNativeFastCut === 'function' && canUseNativeFastCut()
            && typeof movePlannedFilesFast === 'function';
          const sameVolumeTargets = nativeFastCut ? topLevelTargets.filter(item => canUseSameVolumeCut(process.platform, 'cut', [sourceStatsByPath.get(pathKey(item.source))], destinationStat)) : [];
          const sameVolumeSources = new Set(sameVolumeTargets.map(item => pathKey(item.source)));
          const copyTargets = topLevelTargets.filter(item => !sameVolumeSources.has(pathKey(item.source)));
          const plan = [];
          if (!sameVolumeCut) {
            incomingRoot = nativeFastCut ? '' : path.join(destinationDir, `.photoflow-paste-${operationId}`);
            if (clipboardSnapshot.operation === 'copy' && !replaceConflicts && copyTargets.some(item => item.isDirectory)) {
              await fs.promises.mkdir(incomingRoot, { recursive: false });
              createdTargets.push(incomingRoot);
              const scanAborted = new Promise((_resolve, reject) => { abortScanCopy = () => { stopScanCopy = true; reject(Object.assign(new Error('扫描预复制已停止'), { code: CANCELLED_CODE })); }; });
              void scanAborted.catch(() => undefined);
              scanCopyPipeline = createPlanCopyPipeline(async entries => {
                await copyPlannedFiles(entries.filter(entry => entry.kind === 'directory' || entry.size <= 2 * 1024 * 1024), {
                  destinationRoot: destinationDir, ownershipToken: operationId,
                  isCancelled: () => job.cancelled || stopScanCopy, waitIfPaused: () => Promise.race([task.waitIfPaused(), scanAborted]),
                  onEntryComplete: async (entry, result) => { preCopiedEntries.add(entry.destination); if (result?.publishedIdentity) preCopiedIdentities.set(entry.destination, result.publishedIdentity); if (entry.kind === 'file') preCopiedBytes += entry.size; },
                });
              });
            }
            let discoveredEntries = 0;
            let lastScanReport = 0;
            const subPlans = await mapBounded(copyTargets, 8, async (target, index) => {
              target.stagedDestination = nativeFastCut ? target.destination : path.join(incomingRoot, `${index}-${path.basename(target.destination)}`);
              const subPlan = [];
              await collectCopyPlan(target.source, target.stagedDestination, subPlan, { isCancelled: () => job.cancelled, metadataConcurrency: Math.max(1, Math.floor(8 / Math.min(8, copyTargets.length))), onDiscovered: async entry => {
                discoveredEntries++;
                if (Date.now() - lastScanReport >= 150) { lastScanReport = Date.now(); publish({ phase: 'scanning', progress: 0, currentName: `已扫描 ${discoveredEntries} 个项目，已复制 ${preCopiedEntries.size} 项`, filesDiscovered: discoveredEntries, bytesCopied: preCopiedBytes }); }
                await scanCopyPipeline?.push(entry);
              } }).catch(error => { abortScanCopy(); throw error; });
              return subPlan;
            });
            for (const subPlan of subPlans) for (const entry of subPlan) plan.push(entry);
            await scanCopyPipeline?.close();
            await assertDiskSpace(destinationDir, Math.max(0, plan.reduce((sum, entry) => sum + entry.size, 0) - preCopiedBytes));
            if (clipboardSnapshot.operation === 'copy' && !replaceConflicts) {
              pasteResumeCheckpoint = {
                version: 1,
                kind: 'paste-copy-v1',
                phase: 'copying',
                workspacePath,
                status,
                projectName,
                targetRelativePath,
                planFingerprint: copyPlanFingerprint(plan),
                files: await mapBounded(topLevelTargets, 8, async (item, index) => {
                  const stat = sourceStatsByPath.get(pathKey(item.source));
                  return { source: item.source, destinationName: path.basename(item.destination), stagedName: `${index}-${path.basename(item.destination)}`, size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), isDirectory: item.isDirectory };
                }),
              };
              task.saveCheckpoint(pasteResumeCheckpoint, 0, '正在准备可恢复粘贴', { workspacePath, targetRelativePath });
            }
          }

          const stageReplacements = async () => {
            if (!replacedDestinations.size || replacementRoot) return;
            replacementRoot = path.join(destinationDir, `.photoflow-replace-${operationId}`);
            await fs.promises.mkdir(replacementRoot, { recursive: false });
            for (const [index, destination] of [...replacedDestinations].map(key => topLevelTargets.find(item => pathKey(item.destination) === key)?.destination).filter(Boolean).entries()) {
              if (!await samePathIdentity(destination, replacementIdentities.get(pathKey(destination)))) throw new Error(`同名项目“${path.basename(destination)}”在确认后发生变化，请重新粘贴`);
              const backup = path.join(replacementRoot, `${index}-${path.basename(destination)}`);
              const originalIdentity = await capturePathIdentity(destination);
              await publishPathNoClobber(destination, backup);
              stagedReplacements.push({ original: destination, backup, originalIdentity });
            }
          };

          const rollbackStagedReplacements = async () => {
            let retained = 0;
            for (const item of [...stagedReplacements].reverse()) {
              if (!fs.existsSync(item.backup)) continue;
              if (fs.existsSync(item.original)) { retained += 1; continue; }
              await publishPathNoClobber(item.backup, item.original);
            }
            if (replacementRoot && !stagedReplacements.some(item => fs.existsSync(item.backup))) await fs.promises.rm(replacementRoot, { recursive: true, force: true }).catch(() => undefined);
            return retained;
          };

          const finalizeReplacements = async () => {
            const items = [];
            let permanentCount = 0;
            let retainedCount = 0;
            for (const item of stagedReplacements) {
              try {
                const recycled = await recycleBinService.trash(item.backup);
                if (recycled.permanent) permanentCount += 1;
                items.push({ original: item.original, originalIdentity: item.originalIdentity, recyclePidl: recycled.recyclePidl || '', preciseRestore: recycled.preciseRestore !== false, permanent: Boolean(recycled.permanent) });
              } catch (error) {
                retainedCount += 1;
                writeLog('warn', 'Unable to recycle staged replacement; retaining internal undo backup', { path: item.original, error: error.message || String(error) });
                items.push({ original: item.original, originalIdentity: item.originalIdentity, backup: item.backup, backupRoot: replacementRoot, permanent: false });
              }
            }
            if (replacementRoot && !items.some(item => item.backup)) await fs.promises.rm(replacementRoot, { recursive: true, force: true }).catch(() => undefined);
            return { items, permanentCount, retainedCount };
          };
          const cutSourceResolutions = clipboardSnapshot.operation === 'cut'
            ? uniqueSources.map(source => ({ physicalPath: source, virtualPath: virtualPathFor(root, source) }))
            : [];
          if (sameVolumeCut) {
            await stageReplacements();
            const moved = [];
            publish({ phase: 'moving', progress: 0, currentName: '', bytesCopied: 0, totalBytes: 0, filesCopied: 0, totalFiles: topLevelTargets.length });
            try {
              if (topLevelTargets.length > 1 && publishPathNoClobber === defaultPublishPathNoClobber) {
                await movePathsSameVolumeBatched(topLevelTargets, {
                  isCancelled: () => job.cancelled,
                  waitIfPaused: () => task.waitIfPaused(),
                  onMoved: (item, count) => {
                    moved.push(item);
                    if (count % 256 === 0 || count === topLevelTargets.length) publish({ phase: 'moving', progress: Math.round(count / topLevelTargets.length * 100), currentName: path.basename(item.source), filesCopied: count, totalFiles: topLevelTargets.length });
                  },
                });
              } else {
              for (const [index, item] of topLevelTargets.entries()) {
                throwIfCancelled(() => job.cancelled);
                await task.waitIfPaused();
                publish({ phase: 'moving', progress: Math.round(index / Math.max(1, topLevelTargets.length) * 100), currentName: path.basename(item.source), bytesCopied: 0, totalBytes: 0, filesCopied: index, totalFiles: topLevelTargets.length });
                await publishPathNoClobber(item.source, item.destination);
                moved.push({ ...item, publishedIdentity: await capturePathIdentity(item.destination) });
              }
              }
            } catch (error) {
              for (const item of [...moved].reverse()) {
                if (fs.existsSync(item.destination) && !fs.existsSync(item.source) && await samePathIdentity(item.destination, item.publishedIdentity)) await publishPathNoClobber(item.destination, item.source).catch(() => undefined);
              }
              await rollbackStagedReplacements();
              throw error;
            }
            task.setPausable(false);
            job.finishing = true;
            fileOperationState.projectFileClipboard = null;
            await clearClipboardIfSnapshotCurrent(clipboardSnapshot);
            const count = topLevelTargets.length;
            const replacements = await finalizeReplacements();
            if (count) await pushUndoOperation(replacements.items.length ? { kind: 'paste-replace', mode: 'cut', moves: topLevelTargets, items: replacements.items, backupRoot: replacementRoot } : { kind: 'move', moves: topLevelTargets }).catch(error => {
              writeLog('warn', 'Unable to record paste undo history', error);
            });
            const warning = undefined;
            publish({ phase: 'complete', progress: 100, currentName: '', bytesCopied: 0, totalBytes: 0, filesCopied: count, totalFiles: count, count });
            task.complete('文件移动完成');
            recordCommittedMediaChanges(topLevelTargets, { removeSources: true });
            writeLog('info', 'Project files moved by same-volume rename', { projectName, targetRelativePath, count, operationId });
            return { success: true, cancelled: false, errorCode: undefined, count, operationId, taskNotificationOwned: true, affectedDirectories, consumedCutClipboard: true, movedItems: topLevelTargets.map(item => ({ sourceRelativePath: virtualPathFor(root, item.source), destinationRelativePath: virtualPathFor(root, item.destination, [destinationResolution]) })), replacedCount: replacements.items.length, replacedNames: replacements.items.map(item => path.basename(item.original)), replacedPermanentCount: replacements.permanentCount, replacedRetainedCount: replacements.retainedCount, warning };
          }

          const totalBytes = plan.reduce((sum, entry) => sum + entry.size, 0);
          const totalFiles = plan.filter(entry => entry.kind === 'file').length + sameVolumeTargets.length;
          let bytesCopied = 0;
          let filesCopied = 0;
          let sourceCleanupOutcome;
          let lastPublishedAt = 0;
          let displayedCopyBytes = 0;
          const reportCopyProgress = (currentName, force = false) => {
            const now = Date.now();
            if (!force && now - lastPublishedAt < 150) return;
            lastPublishedAt = now;
            displayedCopyBytes = Math.max(displayedCopyBytes, bytesCopied);
            const progress = totalBytes > 0
              ? Math.min(99, Math.round(displayedCopyBytes / totalBytes * 100))
              : Math.min(99, Math.round(filesCopied / Math.max(1, totalFiles) * 100));
            publish({ phase: 'copying', progress, currentName, bytesCopied: displayedCopyBytes, totalBytes, filesCopied, totalFiles });
          };
          const topLevelTargetPaths = new Set(topLevelTargets.map(item => item.stagedDestination));
          const markCreatedTarget = destination => {
            if (topLevelTargetPaths.has(destination) && !createdTargets.includes(destination)) createdTargets.push(destination);
          };
          if (nativeFastCut) {
            await stageReplacements();
            // This path removes each source as it commits. Cancellation may
            // stop subsequent files, but must never delete completed targets.
            preserveMovedTargets = true;
            await publishMoves(sameVolumeTargets, {
              isCancelled: () => job.cancelled,
              waitIfPaused: () => task.waitIfPaused(),
              onMoved: () => { filesCopied++; reportCopyProgress('正在移动同盘项目'); },
            });
            reportCopyProgress('', true);
            const transferStats = await movePlannedFilesFast(plan, {
              ownershipToken: operationId,
              isCancelled: () => job.cancelled,
              waitIfPaused: () => task.waitIfPaused(),
              onTransferProgress: progress => {
                displayedCopyBytes = Math.max(displayedCopyBytes, progress.bytesCopied);
                reportCopyProgress('');
              },
              onCreated: markCreatedTarget,
              onProgress: ({ entry, bytesDelta, fileCompleted }) => {
                bytesCopied += bytesDelta;
                if (fileCompleted) filesCopied += 1;
                reportCopyProgress(path.basename(entry.source));
              },
              onCleanupProgress: ({ processed, total }) => publish({ phase: 'finishing', progress: 99, currentName: `正在移除源文件夹 ${processed}/${total}`, bytesCopied, totalBytes, filesCopied, totalFiles }),
            });
            job.finishing = true;
            task.setPausable(false);
            fileOperationState.projectFileClipboard = null;
            if (process.platform === 'win32') await clearClipboardIfSnapshotCurrent(clipboardSnapshot);
            const count = topLevelTargets.length;
            const replacements = await finalizeReplacements();
            if (count) await pushUndoOperation(replacements.items.length ? { kind: 'paste-replace', mode: 'cut', moves: topLevelTargets, items: replacements.items, backupRoot: replacementRoot } : { kind: 'move', moves: topLevelTargets }).catch(error => writeLog('warn', 'Unable to record native fast paste undo history', error));
            const warning = undefined;
            publish({ phase: 'complete', progress: 100, currentName: '', bytesCopied, totalBytes, filesCopied, totalFiles, count });
            task.complete('文件移动完成');
            recordCommittedMediaChanges(topLevelTargets, { removeSources: true });
            writeLog('info', 'Project files moved by native single-pass cross-volume cut', { projectName, targetRelativePath, count, operationId, ...transferStats });
            return { success: true, cancelled: false, errorCode: undefined, count, operationId, taskNotificationOwned: true, affectedDirectories, consumedCutClipboard: true, movedItems: topLevelTargets.map(item => ({ sourceRelativePath: virtualPathFor(root, item.source), destinationRelativePath: virtualPathFor(root, item.destination, [destinationResolution]) })), replacedCount: replacements.items.length, replacedNames: replacements.items.map(item => path.basename(item.original)), replacedPermanentCount: replacements.permanentCount, replacedRetainedCount: replacements.retainedCount, warning };
          }
          if (!scanCopyPipeline) {
            await fs.promises.mkdir(incomingRoot, { recursive: false });
            createdTargets.push(incomingRoot);
          }
          reportCopyProgress('', true);
          const transferStats = await copyPlannedFiles(plan, {
            destinationRoot: destinationDir,
            ownershipToken: operationId,
            diskSpaceChecked: true,
            isEntryComplete: async entry => preCopiedEntries.has(entry.destination),
            completedIdentity: entry => preCopiedIdentities.get(entry.destination),
            ...(pasteResumeCheckpoint ? {
              getPartialState: entry => pasteResumeCheckpoint.partialFiles?.[path.relative(incomingRoot, entry.destination)],
              onPartialState: (entry, state) => {
                const key = path.relative(incomingRoot, entry.destination);
                pasteResumeCheckpoint.partialFiles = { ...pasteResumeCheckpoint.partialFiles, [key]: state };
                if (!state) delete pasteResumeCheckpoint.partialFiles[key];
                task.saveCheckpoint(pasteResumeCheckpoint, totalBytes ? Math.min(98, bytesCopied / totalBytes * 98) : 0, '正在复制，可从断点继续');
                return state ? backgroundTasks?.flush?.() !== false : true;
              },
            } : {}),
            durable: clipboardSnapshot.operation === 'cut',
            isCancelled: () => job.cancelled,
            waitIfPaused: () => task.waitIfPaused(),
            onCreated: markCreatedTarget,
            onFileStart: entry => reportCopyProgress(path.basename(entry.source)),
            onProgress: ({ entry, bytesDelta, fileCompleted }) => {
              bytesCopied += bytesDelta;
              if (fileCompleted) filesCopied += 1;
              reportCopyProgress(path.basename(entry.source));
            },
          });
          throwIfCancelled(() => job.cancelled);
          if (pasteResumeCheckpoint) task.saveCheckpoint({ ...pasteResumeCheckpoint, phase: 'finalizing' }, 99, '正在完成粘贴');
          task.setPausable(false);
          await stageReplacements();
          try {
            const targetsByDestination = new Map(topLevelTargets.map(item => [item.destination, item]));
            await publishMoves(topLevelTargets.map(item => ({ source: item.stagedDestination, destination: item.destination })), {
              isCancelled: () => job.cancelled,
              onMoved: async item => committedTargets.push({ ...targetsByDestination.get(item.destination), publishedIdentity: item.publishedIdentity || await capturePathIdentity(item.destination) }),
            });
            await fs.promises.rmdir(incomingRoot);
            releaseCleanupOwnership(operationId);
            createdTargets.length = 0;
          } catch (error) {
            for (const item of [...committedTargets].reverse()) {
              if (fs.existsSync(item.destination) && !fs.existsSync(item.stagedDestination) && await samePathIdentity(item.destination, item.publishedIdentity)) {
                const restored = await publishPathNoClobber(item.destination, item.stagedDestination).catch(() => null);
                if (restored?.identity) await refreshRestoredCleanupOwnership(operationId, item.stagedDestination, restored.identity);
              }
            }
            await rollbackStagedReplacements().catch(() => undefined);
            throw error;
          }
          if (clipboardSnapshot.operation === 'cut') {
            job.finishing = true;
            publish({ phase: 'finishing', progress: 99, currentName: '正在移除源文件', bytesCopied, totalBytes, filesCopied, totalFiles });
            sourceCleanupOutcome = await removeCopiedSources(plan, {
              ownershipToken: operationId,
              onCleanupProgress: ({ processed, total }) => publish({ phase: 'finishing', progress: 99, currentName: `正在移除源文件 ${processed}/${total}`, bytesCopied, totalBytes, filesCopied, totalFiles }),
            });
            fileOperationState.projectFileClipboard = null;
            if (process.platform === 'win32') await clearClipboardIfSnapshotCurrent(clipboardSnapshot);
          }
          const count = topLevelTargets.length;
          const replacements = await finalizeReplacements();
          if (count) await pushUndoOperation(replacements.items.length
            ? { kind: 'paste-replace', mode: clipboardSnapshot.operation, moves: topLevelTargets, items: replacements.items, backupRoot: replacementRoot }
            : clipboardSnapshot.operation === 'cut'
              ? { kind: 'move', moves: topLevelTargets }
              : { kind: 'remove-created', paths: topLevelTargets.map(item => item.destination), label: '粘贴' }).catch(error => {
                writeLog('warn', 'Unable to record paste undo history', error);
              });
          const watcherWarning = undefined;
          const warning = [sourceCleanupOutcome?.cleanupWarning ? `文件已移动，但源清理返回提示：${sourceCleanupOutcome.cleanupWarning}` : '', watcherWarning].filter(Boolean).join('；') || undefined;
          publish({ phase: 'complete', progress: 100, currentName: '', bytesCopied, totalBytes, filesCopied, totalFiles, count });
          task.complete('文件粘贴完成');
          recordCommittedMediaChanges(topLevelTargets, { removeSources: clipboardSnapshot.operation === 'cut' });
          writeLog('info', 'Project files pasted', { projectName, targetRelativePath, count, operationId, ...transferStats });
          return { success: true, cancelled: false, errorCode: undefined, count, operationId, taskNotificationOwned: true, affectedDirectories, consumedCutClipboard: clipboardSnapshot.operation === 'cut', createdItems: clipboardSnapshot.operation === 'copy' ? topLevelTargets.map(item => ({ name: path.basename(item.destination), relativePath: virtualPathFor(root, item.destination, [destinationResolution]), isDirectory: item.isDirectory })) : undefined, movedItems: clipboardSnapshot.operation === 'cut' ? topLevelTargets.map(item => ({ sourceRelativePath: virtualPathFor(root, item.source), destinationRelativePath: virtualPathFor(root, item.destination, [destinationResolution]) })) : undefined, replacedCount: replacements.items.length, replacedNames: replacements.items.map(item => path.basename(item.original)), replacedPermanentCount: replacements.permanentCount, replacedRetainedCount: replacements.retainedCount, warning, cleanupWarning: sourceCleanupOutcome?.cleanupWarning, outcomeUnknown: sourceCleanupOutcome?.outcomeUnknown, cleanupPhase: sourceCleanupOutcome?.phase };
        } catch (error) {
          stopScanCopy = true;
          abortScanCopy();
          await scanCopyPipeline?.drain();
          if (error?.code === PUBLISH_PARTIAL_CODE) {
            const publishedOwnership = await provenPublishedOwnership(error, decisionIdentityMatches, path.resolve);
            const publishedPaths = publishedOwnership.map(item => path.resolve(item.path));
            recordCommittedMediaChanges(topLevelTargets.filter(item => publishedPaths.some(candidate => path.resolve(candidate) === path.resolve(item.destination))), {
              removeSources: (job.finishing || preserveMovedTargets) && pasteClipboardOperation === 'cut',
            });
            const retainedSourceRoots = incomingRoot && physicalPathContains(incomingRoot, error.sourcePath || '') ? [incomingRoot] : [];
            const identities = Object.fromEntries(publishedOwnership.map(item => [path.resolve(item.path), item.identity]));
            let recoveryUndo = null;
            try { if (publishedPaths.length) {
              recoveryUndo = await pushUndoOperation(stagedReplacements.length
                ? { kind: 'paste-replace', mode: 'copy', moves: topLevelTargets.filter(item => publishedPaths.includes(item.destination)), items: stagedReplacements, backupRoot: replacementRoot, retainedSourceRoots, identities }
                : { kind: 'remove-created', paths: publishedPaths, retainedSourceRoots, identities, label: '恢复未完成发布' });
            } } catch (undoError) {
              writeLog('error', 'Unable to record partial paste recovery', { operationId, error: undoError.message || String(undoError) });
            }
            error.message = `${error.message || String(error)}；本次粘贴处于部分完成状态，${recoveryUndo ? '已创建可重试的撤销/恢复记录' : '撤销记录创建失败，请保留恢复路径'}：${error.sourcePath || incomingRoot}`;
            releaseCleanupOwnership(operationId);
            publish({ phase: 'failed', progress: 99, currentName: '', error: error.message });
            task?.fail(error);
            return { success: false, operationId, taskNotificationOwned: true, affectedDirectories, error: error.message, ...transferRecoveryFields(error), recovery: { undoToken: recoveryUndo?.undoToken || '', publishedPaths, retainedSourcePaths: [error.sourcePath].filter(Boolean), retainedReplacementPaths: stagedReplacements.map(item => item.backup).filter(candidate => fs.existsSync(candidate)), clipboardOperation: pasteClipboardOperation } };
          }
          // Once cut finalization starts, keeping the completed copies is the only
          // data-safe fallback if removing a source fails partway through.
          if (!job.finishing && !preserveMovedTargets) {
            const cleanup = await removeCreatedPasteTargets(createdTargets, { ownershipToken: operationId });
            if (cleanup?.success === false && cleanup.recoveryPaths?.length) {
              error.recoveryRequired = true;
              error.recoveryPaths = [...new Set([...(error.recoveryPaths || []), ...cleanup.recoveryPaths])];
              error.message = `${error.message || String(error)}；未能确认清理的暂存内容已保留`;
            }
            let retainedReplacementBackups = 0;
            for (const item of [...stagedReplacements].reverse()) {
              if (!fs.existsSync(item.backup)) continue;
              if (fs.existsSync(item.original)) { retainedReplacementBackups += 1; continue; }
              await publishPathNoClobber(item.backup, item.original).catch(() => undefined);
            }
            if (replacementRoot && !stagedReplacements.some(item => fs.existsSync(item.backup))) await fs.promises.rm(replacementRoot, { recursive: true, force: true }).catch(() => undefined);
            if (retainedReplacementBackups) error.message = `${error.message || String(error)}；${retainedReplacementBackups} 个旧同名项目的恢复副本已安全保留，未覆盖后来出现的内容`;
          } else {
            const recoveryNames = [];
            const reservedRecovery = new Set(topLevelTargets.map(item => process.platform === 'win32' ? path.resolve(item.destination).toLowerCase() : path.resolve(item.destination)));
            for (const item of [...stagedReplacements].reverse()) {
              if (!fs.existsSync(item.backup)) continue;
              if (fs.existsSync(item.original)) {
                const stat = await fs.promises.lstat(item.original).catch(() => null);
                const recovery = uniqueDestination(path.dirname(item.original), path.basename(item.original), reservedRecovery, Boolean(stat?.isDirectory()));
                await publishPathNoClobber(item.original, recovery).catch(() => undefined);
                if (fs.existsSync(recovery)) recoveryNames.push(path.basename(recovery));
              }
              if (!fs.existsSync(item.original)) await publishPathNoClobber(item.backup, item.original).catch(() => undefined);
            }
            const retainedReplacementBackup = stagedReplacements.some(item => fs.existsSync(item.backup));
            if (replacementRoot && !retainedReplacementBackup) await fs.promises.rm(replacementRoot, { recursive: true, force: true }).catch(() => undefined);
            if (recoveryNames.length) error.message = `${error.message || String(error)}；原同名项目已恢复，已复制的新内容保留为 ${recoveryNames.join('、')}`;
            else if (retainedReplacementBackup) error.message = `${error.message || String(error)}；旧内容的恢复副本已安全保留，请不要继续修改目标文件并重试撤销`;
            recordCommittedMediaChanges(topLevelTargets.filter(item => fs.existsSync(item.destination)));
            recordCommittedMediaChanges(topLevelTargets.filter(item => !fs.existsSync(item.source)).map(item => ({
              source: item.source, isDirectory: item.isDirectory,
            })), { removeOnly: true });
          }
          if (error?.code === CANCELLED_CODE) {
            publish({ phase: 'cancelled', progress: 0, currentName: '' });
            task?.cancelled();
            writeLog('info', 'Project file paste cancelled', { projectName, operationId });
            return { success: false, cancelled: true, operationId, taskNotificationOwned: true, affectedDirectories, error: preserveMovedTargets || error.recoveryRequired ? error.message : '粘贴已取消', ...transferRecoveryFields(error), errorCode: CANCELLED_CODE };
          }
          publish({ phase: 'failed', progress: 0, currentName: '', error: error.message || String(error) });
          task?.fail(error);
          throw error;
        } finally {
          activeProjectFileOperations.delete(operationId);
        }
      }
      if (operation === 'trash') {
        const existingSourceResolutions = sourceResolutions.filter(resolution => fs.existsSync(resolution.physicalPath));
        const uniqueSourceResolutions = [];
        const seenSourcePaths = new Set();
        for (const resolution of existingSourceResolutions) {
          const sourceKey = clipboardPathKey(resolution.physicalPath);
          if (seenSourcePaths.has(sourceKey)) continue;
          seenSourcePaths.add(sourceKey);
          uniqueSourceResolutions.push(resolution);
        }
        const existingSources = uniqueSourceResolutions.map(resolution => resolution.physicalPath);
        const removedMediaItems = existingSources.map(source => ({ source, isDirectory: fs.lstatSync(source).isDirectory() }));
        const operationId = crypto.randomUUID();
        const affectedDirectories = Array.from(new Set(existingSourceResolutions.map(resolution => {
          const virtual = String(resolution.virtualPath || virtualPathFor(root, resolution.physicalPath, [resolution])).replace(/\\/g, '/');
          const parent = path.posix.dirname(virtual);
          return parent === '.' ? '' : parent;
        })));
        responseContext.operationId = operationId;
        responseContext.affectedDirectories = affectedDirectories;
        const startedAt = Date.now();
        const totalCount = existingSources.length;
        const useBatchTrash = typeof recycleBinService.trashMany === 'function' && existingSources.length > 1;
        const task = createProjectFileTask({
          backgroundTasks, event, operationId, operation: 'trash', title: `删除文件 · ${projectName}`,
          projectName, resources: existingSources, cancellable: true, cancelledCode: CANCELLED_CODE,
        });
        const job = task.job;
        job.cancel = task.cancel;
        activeProjectFileOperations.set(operationId, job);
        const publish = payload => {
          task.publish(payload);
        };
        let processedCount = 0;
        let permanentCount = 0;
        const undoItems = [];
        const workspaceRoot = ensureWorkspace(workspacePath);
        let persistedTrashRecord = null;
        const persistTrashUndo = async () => {
          if (!undoItems.length || persistedTrashRecord) return;
          persistedTrashRecord = await workspaceRepository.addUndoRecord(workspaceRoot, { kind: 'trash', payload: { items: undoItems } });
          await pushUndoOperation({ kind: 'trash', workspaceRoot, persistentId: persistedTrashRecord.id, items: [...undoItems] });
        };
        try {
          responseContext.taskNotificationOwned = true;
          await task.start();
          publish({ phase: 'trashing', progress: 0, currentName: '', processedCount, totalCount });
          if (useBatchTrash) {
            // Bound each non-interruptible Shell call. Account its committed
            // results before observing cancellation, preserving partial undo.
            for (let offset = 0; offset < existingSources.length; offset += 128) {
              if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
              const batchSources = existingSources.slice(offset, offset + 128);
              const originalIdentities = await mapBounded(batchSources, 8, async source => {
                if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
                return capturePathIdentity(source);
              });
              if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
              publish({ phase: 'trashing', progress: Math.round(processedCount / totalCount * 100), currentName: `正在移入回收站（${processedCount}/${totalCount}）`, processedCount, totalCount });
              const batch = await recycleBinService.trashMany(batchSources);
              const batchItems = Array.isArray(batch?.items) ? batch.items : [];
              const batchItemsByPath = new Map(batchItems.flatMap(item => item?.originalPath
                ? [[clipboardPathKey(item.originalPath), item]]
                : []));
              const failures = [];
              for (let index = 0; index < batchSources.length; index += 1) {
                const source = batchSources[index];
                const recycled = batchItemsByPath.get(clipboardPathKey(source))
                  || (batchItems.length === batchSources.length ? batchItems[index] : null);
                if (recycled?.success) {
                  if (recycled.recyclePidl) undoItems.push({ original: source, originalIdentity: originalIdentities[index], recyclePidl: recycled.recyclePidl, preciseRestore: recycled.preciseRestore !== false });
                  if (recycled.permanent) permanentCount += 1;
                  processedCount += 1;
                  responseContext.count = processedCount;
                  recordCommittedMediaChanges([removedMediaItems[offset + index]], { removeOnly: true });
                } else {
                  failures.push({ source, error: recycled?.error || '回收站批量操作未返回该项目的结果' });
                }
              }
              publish({ phase: 'trashing', progress: Math.round((offset + batchSources.length) / totalCount * 100), currentName: '', processedCount, totalCount });
              if (failures.length) {
                const error = new Error(`${failures.length} 个项目未能移入回收站：${path.basename(failures[0].source)}（${failures[0].error}）`);
                error.code = 'RECYCLE_BIN_FAILED';
                throw error;
              }
              await new Promise(resolve => setImmediate(resolve));
            }
          } else {
            for (const source of existingSources) {
              if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
              publish({ phase: 'trashing', progress: Math.round(processedCount / Math.max(1, totalCount) * 100), currentName: path.basename(source), processedCount, totalCount });
              const originalIdentity = await capturePathIdentity(source);
              const recycled = await recycleBinService.trash(source);
              if (recycled.recyclePidl) undoItems.push({ original: source, originalIdentity, recyclePidl: recycled.recyclePidl, preciseRestore: recycled.preciseRestore !== false });
              if (recycled.permanent) permanentCount += 1;
              processedCount += 1;
              responseContext.count = processedCount;
              recordCommittedMediaChanges([removedMediaItems[processedCount - 1]], { removeOnly: true });
              publish({ phase: 'trashing', progress: Math.round(processedCount / Math.max(1, totalCount) * 100), currentName: path.basename(source), processedCount, totalCount });
            }
          }
          let undoUnavailable = false;
          let watchRefreshDegraded = false;
          try {
            await persistTrashUndo();
          } catch (persistError) {
            undoUnavailable = true;
            writeLog('warn', 'Trash completed but its undo record could not be persisted', {
              workspacePath, projectName, error: persistError.message || String(persistError),
            });
          }
          try {

          } catch (watchError) {
            watchRefreshDegraded = true;
            writeLog('warn', 'Trash completed but external watchers could not be refreshed', {
              workspacePath, status, projectName, error: watchError.message || String(watchError),
            });
          }
          publish({ phase: 'complete', progress: 100, currentName: '', processedCount, totalCount });
          task.complete(undoUnavailable ? '文件已移入回收站；应用内撤销暂不可用' : '文件已移入回收站');
          writeLog('info', 'Project files moved to trash', { projectName, count: processedCount, operationId, batch: useBatchTrash, durationMs: Date.now() - startedAt });
          const warning = undoUnavailable
            ? '文件已移入回收站，但应用内撤销记录未能保存；如需恢复，请使用系统回收站。'
            : watchRefreshDegraded ? '文件已移入回收站，但目录监听刷新失败；页面会在后续核对时更新。' : undefined;
          return { success: true, cancelled: false, errorCode: undefined, count: processedCount, permanentCount, operationId, taskNotificationOwned: true, affectedDirectories, undoUnavailable, warning };
        } catch (error) {
          await persistTrashUndo().catch(persistError => writeLog('error', 'Unable to persist partial trash undo record', persistError));
          if (processedCount > 0) {

          }
          const cancelled = error?.code === CANCELLED_CODE;
          publish({ phase: cancelled ? 'cancelled' : 'failed', progress: Math.round(processedCount / Math.max(1, totalCount) * 100), currentName: '', processedCount, totalCount, error: error.message || String(error) });
          if (cancelled) task.cancelled();
          else task.fail(error);
          if (cancelled) return { success: false, cancelled: true, operationId, taskNotificationOwned: true, count: processedCount, affectedDirectories, errorCode: CANCELLED_CODE };
          throw error;
        } finally {
          activeProjectFileOperations.delete(operationId);
        }
      }
      if (operation === 'select') {
        if (!selectionService) throw new Error('选片服务尚未初始化');
        const sourceFolderRelativePath = String(options.sourceFolderRelativePath || '');
        const operationId = crypto.randomUUID();
        const request = {
          workspaceRoot: ensureWorkspace(workspacePath), projectName, projectRoot: root,
          sourceFolderRelativePath, relativePaths, operationId,
        };
        const preflight = await selectionService.preflightManual(request);
        const result = await selectionService.executeManual({ ...request, expectedSignature: preflight.signature });
        if (result?.success && Number(result.copiedCount) > 0) {
          const destination = result.selectionNode?.folderPath
            || resolveDestination(result.targetFolderRelativePath || '').physicalPath;
          if (destination && fs.existsSync(destination)) recordCommittedMediaChanges([{ destination, isDirectory: true }]);
        }
        return result;
      }
      if (operation === 'rename') {
        const operationId = crypto.randomUUID();
        responseContext.operationId = operationId;
        responseContext.affectedDirectories = Array.from(new Set(sources.map(source => {
          const virtual = virtualPathFor(root, source, [...sourceResolutions]);
          const parent = path.posix.dirname(virtual);
          return parent === '.' ? '' : parent;
        })));
        if (!sources.length || !nextName.trim()) throw new Error('请选择文件并输入新名称');

        if (!context.isOrdinaryProjectRoot?.(root) && sources.some(source => isProtectedProjectFolderPath({ fs, path, projectRoot: root, candidate: source }))) {
          throw new Error('该文件夹由项目工作流管理，不能使用普通重命名；进度文件夹请使用“修改进度”');
        }
        const baseName = nextName.trim();
        const explicitNames = Array.isArray(options.renameNames) && options.renameNames.length === sources.length ? options.renameNames.map(name => String(name).trim()) : null;
        const destinations = sources.map((source, index) => {
          const extension = path.extname(source);
          let fileName = explicitNames ? explicitNames[index] : sources.length === 1 ? baseName : `${baseName}_${String(index + 1).padStart(2, '0')}${extension}`;
          if (!fileName || path.basename(fileName) !== fileName || /[<>:"/\\|?*\x00-\x1f]/.test(fileName) || /[. ]$/.test(fileName)) throw new Error(`无效的文件名：${fileName || '空文件名'}`);
          return path.join(path.dirname(source), fileName);
        });
        if (!context.isOrdinaryProjectRoot?.(root) && sources.some((source, index) => path.dirname(source).toLocaleLowerCase() === root.toLocaleLowerCase()
          && fs.statSync(source).isDirectory() && isProtectedProjectFolderName(path.basename(destinations[index])))) {
          throw new Error('该名称保留给项目工作流使用，请输入其他文件夹名称');
        }
        const normalizedDestinations = destinations.map(destination => path.resolve(destination).toLocaleLowerCase());
        if (new Set(normalizedDestinations).size !== normalizedDestinations.length) throw new Error('生成的新文件名存在重复');
        const normalizedSources = new Set(sources.map(source => path.resolve(source).toLocaleLowerCase()));
        for (const [index, destination] of destinations.entries()) {
          const resolution = sourceResolutions[index];
          const allowedRoot = root;
          if (!pathInside(allowedRoot, destination) || path.resolve(destination) === path.resolve(allowedRoot)) throw new Error('无效的文件名');
          if (fs.existsSync(destination) && !normalizedSources.has(path.resolve(destination).toLocaleLowerCase())) throw new Error(`目标名称已被占用：${path.basename(destination)}`);
        }
        const moves = sources.map((source, index) => ({ source, destination: destinations[index] })).filter(move => path.resolve(move.source) !== path.resolve(move.destination));
        const renamedMediaItems = moves.map(move => ({ ...move, isDirectory: fs.lstatSync(move.source).isDirectory() }));
        if (moves.length === 1 && sources.length === 1) {
          // A single filesystem rename is already atomic on the source volume.
          // Avoid the two-hop staging used to make multi-item swaps/cycles safe;
          // it doubles watcher traffic and the latency visible after Enter.
          const caseOnlyRename = clipboardPathKey(moves[0].source) === clipboardPathKey(moves[0].destination);
          if (caseOnlyRename) await fs.promises.rename(moves[0].source, moves[0].destination);
          else await publishPathNoClobber(moves[0].source, moves[0].destination);
        } else {
          const staged = [];
          const directMoved = [];
          const groups = partitionRenames(moves, clipboardPathKey);
          try {
            for (const layer of groups.layers) await publishMoves(layer, { onMoved: item => { directMoved.push(item); } });
            const stagingMoves = groups.staged.map(move => ({
              ...move, temporary: path.join(path.dirname(move.source), `.photoflow-rename-${crypto.randomUUID()}${path.extname(move.source)}`),
            }));
            const stagingBySource = new Map(stagingMoves.map(move => [move.source, move]));
            await publishMoves(stagingMoves.map(move => ({ source: move.source, destination: move.temporary })), {
              onMoved: item => { staged.push({ ...stagingBySource.get(item.source), publishedIdentity: item.publishedIdentity, completed: false }); },
            });
            const stagedByTemporary = new Map(staged.map(move => [move.temporary, move]));
            await publishMoves(staged.map(move => ({ source: move.temporary, destination: move.destination })), {
              onMoved: item => { const move = stagedByTemporary.get(item.source); move.completed = true; move.publishedIdentity = item.publishedIdentity; },
            });
          } catch (error) {
            // First move every published destination back into its private
            // staging slot. This frees all original names before restoration,
            // including swaps and longer rename cycles.
            for (const move of [...staged].reverse()) {
              try {
                if (move.completed && fs.existsSync(move.destination) && !fs.existsSync(move.temporary)
                  && (!move.publishedIdentity || await (samePathIdentity || defaultSamePathIdentity)(move.destination, move.publishedIdentity))) {
                  const restored = await publishPathNoClobber(move.destination, move.temporary);
                  move.publishedIdentity = restored?.identity;
                }
              } catch { /* best-effort rollback; original error is reported below */ }
            }
            for (const move of [...staged].reverse()) {
              try {
                if (fs.existsSync(move.temporary) && !fs.existsSync(move.source)
                  && (!move.publishedIdentity || await (samePathIdentity || defaultSamePathIdentity)(move.temporary, move.publishedIdentity))) await publishPathNoClobber(move.temporary, move.source);
              } catch { /* best-effort rollback; original error is reported below */ }
            }
            for (const move of directMoved.reverse()) {
              try {
                if (fs.existsSync(move.destination) && !fs.existsSync(move.source)
                  && (!move.publishedIdentity || await (samePathIdentity || defaultSamePathIdentity)(move.destination, move.publishedIdentity))) await publishPathNoClobber(move.destination, move.source);
              } catch { /* preserve occupied or changed paths */ }
            }
            recordCommittedMediaChanges(renamedMediaItems.filter(item => fs.existsSync(item.destination)).map(item => ({
              destination: item.destination, isDirectory: item.isDirectory,
            })));
            recordCommittedMediaChanges(renamedMediaItems.filter(item => !fs.existsSync(item.source)), { removeOnly: true });
            throw error;
          }
        }
        writeLog('info', 'Project files renamed', { projectName, count: sources.length });
        let warning;
        let watchDegraded = false;
        if (moves.length) await pushUndoOperation({ kind: 'files', moves }).catch(error => {
          warning = '文件已重命名，但无法记录撤销操作';
          writeLog('warn', 'Unable to record committed file rename undo', error);
        });

        recordCommittedMediaChanges(renamedMediaItems, { removeSources: true });
        const sourceResolutionsByPath = new Map(sources.map((source, index) => [path.resolve(source), sourceResolutions[index]]));
        return {
          success: true,
          cancelled: false,
          errorCode: undefined,
          count: sources.length,
          operationId,
          affectedDirectories: responseContext.affectedDirectories,
          warning,
          watchDegraded,
          movedItems: moves.map(move => {
            const hint = sourceResolutionsByPath.get(path.resolve(move.source));
            const sourceRelativePath = virtualPathFor(root, move.source, [hint]);
            const destinationRelativePath = virtualPathFor(root, move.destination);
            return { sourceRelativePath, destinationRelativePath };
          }),
        };
      }
      throw new Error('不支持的文件操作');
    } catch (error) {
      const errorCode = error && typeof error === 'object' ? error.code : '';
      const transferStage = error && typeof error === 'object' ? error.transferStage : '';
      const affectedPath = error && typeof error === 'object' ? (error.sourcePath || error.destinationPath) : '';
      const affectedName = affectedPath ? path.basename(affectedPath) : '';
      const accessFailure = transferStage === 'inspect-source'
        ? `无法读取源文件${affectedName ? `“${affectedName}”` : ''}，文件可能正被其他程序占用或当前账户没有读取权限`
        : transferStage === 'prepare-target'
          ? `无法在目标文件夹创建${affectedName ? `“${affectedName}”` : '文件'}，请检查目标文件夹权限`
        : transferStage === 'sync-temporary'
          ? `无法完成文件${affectedName ? `“${affectedName}”` : ''}的安全写入校验，源文件已保留`
        : transferStage === 'copy-data'
          ? `复制文件${affectedName ? `“${affectedName}”` : ''}时被系统拒绝，请关闭正在读取该文件的程序后重试`
          : transferStage === 'commit-target'
            ? `写入目标文件${affectedName ? `“${affectedName}”` : ''}时被系统拒绝，请检查目标文件夹权限`
            : '文件正在被其他程序占用或没有访问权限，请关闭相关程序后重试';
      const errorMessage = errorCode === 'EPERM' || errorCode === 'EBUSY' || errorCode === 'EACCES'
        ? accessFailure
        : errorCode === 'ENOSPC'
          ? '目标磁盘空间不足，操作已停止；已创建的不完整副本会自动清理'
          : errorCode === 'ENAMETOOLONG'
            ? '文件路径过长，请缩短项目路径或文件名后重试'
            : errorCode === 'EROFS'
              ? '目标磁盘为只读状态，无法写入文件'
              : errorCode === 'ENOENT' || errorCode === 'ENOTDIR'
                ? '操作中的文件或文件夹已在外部移动或删除，请刷新后重试'
                : error.message || String(error);
      writeLog('error', 'Project file operation failed', { projectName, operation, targetRelativePath, count: relativePaths.length, errorCode: errorCode || undefined, transferStage: transferStage || undefined, sourcePath: error?.sourcePath, destinationPath: error?.destinationPath, nativeError: error?.message || String(error), error: errorMessage });
      return { success: false, operationId: responseContext.operationId || undefined, taskNotificationOwned: responseContext.taskNotificationOwned || undefined, affectedDirectories: responseContext.affectedDirectories, count: responseContext.count || undefined, cancelled: errorCode === CANCELLED_CODE || undefined, error: errorMessage, ...transferRecoveryFields(error), errorCode: errorCode || undefined, transferStage: transferStage || undefined };
    } finally {
      if (remoteImportTempRoot) await fs.promises.rm(remoteImportTempRoot, { recursive: true, force: true }).catch(error => writeLog('warn', 'Unable to clean remote image import staging directory', error));
      if (suppressedProjectRoot) releaseWorkspaceWatchPath?.(suppressedProjectRoot);
      if (committedMediaChanges.length) {
        try { scheduleMediaTrackingScan?.(ensureWorkspace(workspacePath), projectName, committedMediaChanges, false); }
        catch (error) { writeLog('warn', 'Unable to schedule precise media index update after file operation', { projectName, operation, error: error.message || String(error) }); }
      }
    }
  });
};

module.exports = { canUseSameVolumeCut, canUseSingleRenameMove, committedMediaChangesFor, registerFileOperationsIpc, sameFilesystemDevice };
