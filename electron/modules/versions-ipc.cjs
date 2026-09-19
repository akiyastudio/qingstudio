const { registerVersionTrackingIpc } = require('./version-tracking-ipc.cjs');
const { getProtectedProjectFolderRegistry } = require('../services/protected-project-folder.cjs');

const registerVersionIpc = context => {
  context = require('../services/rename-performance-diagnostics.cjs').instrumentRenameContext(context);
  const { Array, Boolean, Error, IMAGE_EXTENSIONS, JSON, Math, Number, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, backgroundTasks, buildVersionBatchImportKey, cleanVersionName, copyFileAtomic, crypto, dialog, ensureTrackedVersionThumbnail, ensureWorkspace, fs, getProjectPath, getWorkspaceDataRoot, ipcMain, mainWindow, mediaRatingService, mediaScanService, mediaService, path, projectVirtualPaths, recycleBinService, refreshWorkspaceCatalog, releaseWorkspaceWatchPath, resolveProjectEntry, runPythonEventAction, scheduleMediaTrackingScan, supportedVersionFileKind, suppressWorkspaceWatchPath, thumbnailService, versionService, trackingScanService = mediaScanService || versionService, undefined, uniqueDestination, workspaceCatalogs, writeLog: unsafeWriteLog = () => undefined } = context;
  const writeLog = (...args) => {
    try {
      const pending = unsafeWriteLog(...args);
      pending?.catch?.(() => undefined);
    } catch {}
  };
  const logSlowVersionTreeRead = (operation, startedAt, projectName) => {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 250) writeLog('info', 'Slow version-tree read', { operation, elapsedMs, projectName });
  };
  const protectedProjectFolders = context.protectedProjectFolders || getProtectedProjectFolderRegistry();
  const pendingRelocateDecisions = new Map();
  const RELOCATE_DECISION_TTL_MS = 5 * 60 * 1000;
  const RELOCATE_DECISION_LIMIT = 256;
  const listRatedProjectMedia = (projectPath, workspaceRoot, projectName) => mediaRatingService.listProject(projectPath, { workspaceRoot, projectName });
  const validProgressFolderName = value => Boolean(value && path.basename(value) === value && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value));
  const validOpaqueId = value => Boolean(value && value.length <= 128 && !/[\x00-\x1f]/.test(value));
  const compatibleBoolean = (value, fieldName) => {
    if (value == null || value === false || value === 0) return false;
    if (value === true || value === 1) return true;
    throw new Error(`${fieldName} 必须是布尔值`);
  };
  const normalizeProjectRelativePath = value => {
    const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized || normalized.length > 1024 || path.isAbsolute(normalized)
      || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('项目相对路径无效');
    }
    return normalized;
  };
  const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relocateDecisionKey = (workspaceRoot, versionId) => `${pathKey(workspaceRoot)}\0${String(versionId).toLowerCase()}`;
  const pruneRelocateDecisions = now => {
    for (const [key, decision] of pendingRelocateDecisions) {
      if (decision.expiresAt <= now) pendingRelocateDecisions.delete(key);
    }
    while (pendingRelocateDecisions.size >= RELOCATE_DECISION_LIMIT) {
      pendingRelocateDecisions.delete(pendingRelocateDecisions.keys().next().value);
    }
  };
  const isValidProgressParent = (folder, mediaKind) => Boolean(folder && !folder.folderMissing
    && folder.mediaKind === mediaKind
    && (folder.nodeRole === 'original' && !folder.artifactKind
      || folder.nodeRole === 'progress' && folder.parentProgressId && folder.relationKind === 'main'));
  const isInside = (root, candidate) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const removeCleanupArtifacts = async (workspaceRoot, cleanup = {}) => {
    const dataRoot = path.resolve(getWorkspaceDataRoot(workspaceRoot));
    const removed = new Set();
    for (const item of cleanup.deletedVersions || []) {
      if (item.thumbnailPath) {
        const thumbnailPath = path.resolve(item.thumbnailPath);
        const managed = path.basename(thumbnailPath).toLocaleLowerCase() === `${item.id}.jpg`.toLocaleLowerCase()
          && path.basename(path.dirname(thumbnailPath)).toLocaleLowerCase() === String(item.photoId).toLocaleLowerCase()
          && path.basename(path.dirname(path.dirname(thumbnailPath))).toLocaleLowerCase() === 'thumbnails'
          && isInside(dataRoot, thumbnailPath);
        if (managed) {
          await fs.promises.rm(thumbnailPath, { force: true }).catch(() => undefined);
          removed.add(thumbnailPath);
        }
      }
    }
    await thumbnailService.evictCache({ sourcePaths: cleanup.sourcePaths || [] }).catch(error => {
      writeLog('warn', 'Unable to clear deleted version thumbnail cache', { error: error.message || String(error) });
    });
    return removed.size;
  };

  const queueCleanupArtifacts = (workspaceRoot, cleanup = {}, title = '清理版本内部文件', restartTask = null) => {
    const snapshot = {
      deletedVersions: [...(cleanup.deletedVersions || [])],
      sourcePaths: [...(cleanup.sourcePaths || [])],
    };
    const execute = async task => {
      task?.report(20, title);
      const removedArtifactCount = await removeCleanupArtifacts(workspaceRoot, snapshot);
      task?.report(100, '内部文件清理完成');
      return { removedArtifactCount };
    };
    if (!backgroundTasks?.run) {
      setTimeout(() => void execute().catch(error => writeLog('warn', 'Deferred artifact cleanup failed', { error: error.message || String(error) })), 0);
      return;
    }
    const dedupeKey = `internal-artifact-cleanup:${crypto.randomUUID()}`;
    const run = () => backgroundTasks.run({
      ...(restartTask?.id ? { id: restartTask.id } : {}),
      type: 'internal-artifact-cleanup',
      title,
      dedupeKey,
      cancellable: false,
      metadata: { workspaceRoot, snapshot, title },
    }, execute, run);
    if (restartTask?.id) return run();
    setTimeout(() => void run().catch(error => writeLog('warn', 'Deferred artifact cleanup failed', { error: error.message || String(error) })), 250);
  };

  ipcMain.handle('workspace-media-versions', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const filePath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('素材文件不存在');
      const extension = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension) && !RAW_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) throw new Error('只有图片、RAW 和视频可以建立版本');
      const result = await versionService.getMedia(workspaceRoot, { projectName, filePath });
      for (const version of result.versions || []) {
        if (!version.thumbnailPath || !fs.existsSync(version.thumbnailPath)) {
          void ensureTrackedVersionThumbnail({ workspaceRoot, photoId: result.photo.id, versionId: version.id, filePath: version.filePath });
        }
      }
      return result;
    } catch (error) {
      writeLog('error', 'Unable to load media versions', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), versions: [] };
    }
  });

  ipcMain.handle('workspace-progress-folders-snapshot', async (_event, workspacePath, projectName) => {
    const startedAt = Date.now();
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      return await versionService.snapshotProgress(workspaceRoot, projectName, true);
    } catch (error) {
      return { success: false, error: error.message || String(error), progressFolders: [], graphEdges: [], legacySelectionRelationRepairs: [] };
    } finally {
      logSlowVersionTreeRead('progress-snapshot', startedAt, projectName);
    }
  });

  ipcMain.handle('workspace-progress-folders', async (_event, workspacePath, projectName) => {
    const startedAt = Date.now();
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      return await versionService.snapshotProgressLocations(workspaceRoot, projectName, true);
    } catch (error) {
      return { success: false, error: error.message || String(error), progressFolders: [], graphEdges: [], legacySelectionRelationRepairs: [] };
    } finally {
      logSlowVersionTreeRead('progress-locations', startedAt, projectName);
    }
  });

  ipcMain.handle('workspace-progress-delete-missing', async (_event, workspacePath, projectName, progressId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      await versionService.syncProject(workspaceRoot, projectName);
      const result = await versionService.deleteMissingProgress(workspaceRoot, { projectName, progressId });
      queueCleanupArtifacts(workspaceRoot, result, '清理已移除失效进度的内部文件');
      return { ...result, cleanupQueued: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-unregister', async (_event, workspacePath, projectName, progressId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const progress = (listed.progressFolders || []).find(folder => folder.id === String(progressId || ''));
      if (!progress || progress.nodeRole !== 'progress') throw new Error('要取消登记的版本进度不存在或角色不允许');
      return await versionService.unregisterProgress(workspaceRoot, { projectName, progressId: progress.id });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-final-version-export', async (_event, workspacePath, status, projectName, request = {}) => {
    let folderPath = '';
    let createdDirectory = false;
    let registrationCommitted = false;
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const ratedEntries = await listRatedProjectMedia(projectPath, workspaceRoot, projectName);
      if (!ratedEntries.length) throw new Error('当前项目还没有标星的图片');

      const progressResult = await versionService.listProgress(workspaceRoot, projectName);
      const imageRoots = (progressResult.progressFolders || [])
        .filter(progress => progress.mediaKind === 'image' && /^\d+$/.test(progress.versionKey))
        .sort((left, right) => Number(left.versionKey) - Number(right.versionKey));
      const versionKey = String((imageRoots.at(-1) ? Number(imageRoots.at(-1).versionKey) : 0) + 1);
      const parentProgressId = String(request.parentProgressId || '');
      const explicitParent = (progressResult.progressFolders || []).find(progress => progress.id === parentProgressId);
      if (!isValidProgressParent(explicitParent, 'image')) {
        throw new Error('export_parent_required: 请选择明确的图片主分支父节点');
      }
      const displayName = `图片后期_${versionKey}_喜爱`;
      folderPath = path.resolve(projectPath, displayName);
      if (!folderPath.startsWith(projectPath + path.sep)) throw new Error('喜爱图片进度文件夹路径无效');
      if (fs.existsSync(folderPath)) throw new Error(`文件夹“${displayName}”已经存在`);

      const executeExport = async () => {
        try {
          await fs.promises.mkdir(folderPath);
          createdDirectory = true;
          const reserved = new Set();
          const copiedFiles = [];
          for (const entry of ratedEntries) {
            const sourcePath = await mediaService.authorizeInput(entry.path);
            const destinationPath = uniqueDestination(folderPath, path.basename(sourcePath), reserved);
            await copyFileAtomic(sourcePath, destinationPath);
            copiedFiles.push(destinationPath);
          }
          const registered = await versionService.registerProgress(workspaceRoot, {
            projectName,
            mediaKind: 'image',
            versionKey,
            parentProgressId: explicitParent.id,
            displayName,
            folderPath,
            trackingEnabled: false,
            sourceMetadata: { category: 'favorite-export', role: 'output', displayName },
          });
          if (registered?.success) registrationCommitted = true;
          if (!registered?.success || !registered.progressFolder) throw new Error(registered?.error || '无法登记喜爱图片进度');
          return { copiedFiles, registered };
        } catch (error) {
          if (createdDirectory && !registrationCommitted && fs.existsSync(folderPath)) {
            await fs.promises.rm(folderPath, { recursive: true, force: true }).catch(() => undefined);
            createdDirectory = false;
          }
          throw error;
        }
      };
      const exportResult = backgroundTasks?.run
        ? await backgroundTasks.run({
          type: 'final-version-export',
          title: '导出喜爱图片',
          notificationPolicy: 'progress-toast',
          cancellable: false,
          resources: [{ path: folderPath, access: 'write' }, { path: `photoflow-workspace-database/${workspaceRoot}`, access: 'write' }],
          concurrencyGroup: 'disk-io',
          concurrencyLimit: 3,
          concurrencyWriteLimit: 2,
          resourceAccess: 'write',
          metadata: { workspaceRoot, projectName, folderPath },
        }, executeExport)
        : { result: await executeExport() };
      const { copiedFiles, registered } = exportResult.result || {};
      if (!copiedFiles || !registered) throw new Error('喜爱图片导出没有返回结果');
      writeLog('info', 'Final versions exported to progress folder', { projectName, displayName, count: copiedFiles.length });
      return {
        success: true,
        count: copiedFiles.length,
        displayName,
        versionKey,
        progressFolder: registered.progressFolder,
        folder: {
          name: displayName,
          path: folderPath,
          relativePath: path.relative(projectPath, folderPath).replace(/\\/g, '/'),
          updatedAt: Date.now(),
        },
      };
    } catch (error) {
      if (createdDirectory && !registrationCommitted && folderPath && fs.existsSync(folderPath)) await fs.promises.rm(folderPath, { recursive: true, force: true }).catch(() => undefined);
      writeLog('error', 'Unable to export final versions', { projectName, error: error.message || String(error) });
      return { success: false, count: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-register', async (_event, workspacePath, status, projectName, request = {}) => {
    let movedFrom = '';
    let movedTo = '';
    let moveRollbackError = null;
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const allowed = ['relativePath', 'mediaKind', 'versionKey', 'parentProgressId', 'displayName', 'trackingEnabled', 'trackingState', 'renameFromParent', 'copyMissingFromParent', 'progressId', 'moveToRoot'];
      if (!request || Object.keys(request).some(key => !allowed.includes(key))) {
        throw new Error('progress_payload_invalid: renderer 不能提交节点角色、绝对路径或关系类型');
      }
      const mediaKind = String(request.mediaKind || '');
      const parentProgressId = String(request.parentProgressId || '').trim();
      const progressId = String(request.progressId || '').trim();
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const existing = progressId ? (listed.progressFolders || []).find(folder => folder.id === progressId) : null;
      const parent = (listed.progressFolders || []).find(folder => folder.id === parentProgressId);
      if (!['image', 'video'].includes(mediaKind) || !parentProgressId || !isValidProgressParent(parent, mediaKind)) {
        throw new Error('progress_parent_required: 版本进度必须选择同媒体类型的原始素材或进度父节点');
      }
      if (progressId && (!existing || existing.nodeRole !== 'progress')) {
        throw new Error('progress_target_invalid: 只能更新普通版本进度');
      }
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const resolution = projectVirtualPaths.resolve(projectPath, request.relativePath, { externalRootMode: 'target' });
      let folderPath = resolution.physicalPath;
      if (!fs.statSync(folderPath).isDirectory()) throw new Error('版本进度文件夹不存在');
      if (request.moveToRoot && path.dirname(folderPath).toLocaleLowerCase() !== projectPath.toLocaleLowerCase()) {
        if (fs.lstatSync(folderPath).isSymbolicLink()) throw new Error('快捷方式或链接目录不能移动为版本进度');
        const targetPath = path.join(projectPath, path.basename(folderPath));
        if (fs.existsSync(targetPath)) throw new Error(`项目根目录已存在同名文件夹“${path.basename(folderPath)}”`);
        movedFrom = folderPath;
        movedTo = targetPath;
        suppressWorkspaceWatchPath(folderPath);
        suppressWorkspaceWatchPath(targetPath);
        await fs.promises.rename(folderPath, targetPath);
        folderPath = targetPath;
      }
      const registered = await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind,
        versionKey: request.versionKey,
        parentProgressId,
        displayName: request.displayName || path.basename(folderPath),
        folderPath,
        trackingEnabled: Boolean(request.trackingEnabled),
        trackingState: request.trackingState,
        nodeRole: 'progress',
        relationKind: 'main',
        renameFromParent: Boolean(request.renameFromParent),
        copyMissingFromParent: Boolean(request.copyMissingFromParent),
        progressId: progressId || undefined,
      });
      if (!registered?.success || !registered.progressFolder) throw new Error(registered?.error || '无法登记版本进度');
      return {
        ...registered,
        relativePath: path.relative(projectPath, folderPath).replace(/\\/g, '/'),
      };
    } catch (error) {
      if (movedFrom && movedTo && fs.existsSync(movedTo) && !fs.existsSync(movedFrom)) {
        try {
          await fs.promises.rename(movedTo, movedFrom);
        } catch (rollbackError) {
          moveRollbackError = rollbackError;
          writeLog('error', 'Unable to roll back progress root move after registration failure', {
            source: movedFrom, destination: movedTo, error: rollbackError.message || String(rollbackError),
          });
        }
      }
      const message = error.message || String(error);
      return { success: false, error: moveRollbackError ? `${message}；文件夹回滚失败：${moveRollbackError.message || String(moveRollbackError)}` : message };
    } finally {
      if (movedFrom) releaseWorkspaceWatchPath(movedFrom);
      if (movedTo) releaseWorkspaceWatchPath(movedTo);
    }
  });

  ipcMain.handle('workspace-progress-register-with-graph', async (_event, workspacePath, status, request = {}) => {
    let createdDirectory = '';
    let movedFrom = '';
    let movedTo = '';
    let moveRollbackError = null;
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      if (!request || Object.keys(request).some(key => !['projectName', 'progress', 'workflowInputProgressIds'].includes(key))) {
        throw new Error('progress_graph_payload_invalid: 请求字段无效');
      }
      const projectName = String(request.projectName || '').trim();
      const progress = request.progress && typeof request.progress === 'object' ? request.progress : {};
      const allowedProgressFields = ['progressId', 'relativePath', 'mediaKind', 'versionKey', 'parentProgressId', 'displayName', 'trackingEnabled', 'trackingState', 'renameFromParent', 'copyMissingFromParent', 'moveToRoot'];
      if (Object.keys(progress).some(key => !allowedProgressFields.includes(key))) {
        throw new Error('progress_graph_payload_invalid: renderer 不能提交节点角色、绝对路径或图边类型');
      }
      const workflowInputProgressIds = Array.isArray(request.workflowInputProgressIds)
        ? request.workflowInputProgressIds.map(value => String(value || '').trim()) : null;
      if (!projectName || !workflowInputProgressIds || workflowInputProgressIds.some(value => !value)
        || new Set(workflowInputProgressIds).size !== workflowInputProgressIds.length) {
        throw new Error('progress_graph_payload_invalid: 项目或工作流输入无效');
      }
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      let databaseProgress = {};
      const progressId = String(progress.progressId || '').trim();
      const updatesProgress = Object.entries(progress).some(([key, value]) => key !== 'progressId' && value !== undefined);
      let existing = null;
      if (progressId) {
        const listed = await versionService.listProgress(workspaceRoot, projectName, true);
        existing = (listed.progressFolders || []).find(item => item.id === progressId);
        if (!existing || existing.folderMissing) throw new Error('progress_graph_target_invalid: 目标节点不存在');
      }
      if (progressId && !updatesProgress) {
        databaseProgress = { progressId: existing.id };
      } else {
        const displayName = String(progress.displayName || '').trim();
        const mediaKind = String(progress.mediaKind || '');
        const versionKey = String(progress.versionKey || '').trim();
        const parentProgressId = String(progress.parentProgressId || '').trim();
        const listed = await versionService.listProgress(workspaceRoot, projectName, true);
        const parent = (listed.progressFolders || []).find(folder => folder.id === parentProgressId);
        if (existing && existing.nodeRole !== 'progress') throw new Error('progress_graph_target_invalid: 只能更新普通版本进度');
        if (!validProgressFolderName(displayName) || !['image', 'video'].includes(mediaKind) || !versionKey
          || !parentProgressId || !isValidProgressParent(parent, mediaKind)) {
          throw new Error('progress_graph_payload_invalid: 新进度字段无效');
        }
        let folderResolution = progress.relativePath !== undefined
          ? projectVirtualPaths.resolve(projectPath, String(progress.relativePath || ''), { externalRootMode: 'target' })
          : null;
        let folderPath = folderResolution?.physicalPath
          || (existing?.folderPath ? path.resolve(existing.folderPath) : path.resolve(projectPath, displayName));
        if (!isInside(projectPath, folderPath)) throw new Error('progress_graph_folder_invalid: 进度目录必须位于当前项目内');
        if (!fs.existsSync(folderPath)) {
          if (progress.relativePath !== undefined || existing) throw new Error('progress_graph_folder_invalid: 要登记的文件夹不存在');
          await fs.promises.mkdir(folderPath);
          createdDirectory = folderPath;
        } else if (!fs.statSync(folderPath).isDirectory()) {
          throw new Error(`同名路径不是文件夹：${displayName}`);
        }
        if (progress.moveToRoot && path.dirname(folderPath).toLocaleLowerCase() !== projectPath.toLocaleLowerCase()) {
          if (fs.lstatSync(folderPath).isSymbolicLink()) throw new Error('快捷方式或链接目录不能移动为版本进度');
          const targetPath = path.join(projectPath, path.basename(folderPath));
          if (fs.existsSync(targetPath)) throw new Error(`项目根目录已存在同名文件夹“${path.basename(folderPath)}”`);
          movedFrom = folderPath;
          movedTo = targetPath;
          suppressWorkspaceWatchPath(folderPath);
          suppressWorkspaceWatchPath(targetPath);
          await fs.promises.rename(folderPath, targetPath);
          folderPath = targetPath;
        }
        databaseProgress = {
          progressId: progressId || undefined,
          mediaKind, versionKey, displayName, folderPath,
          parentProgressId,
          relationKind: 'main',
          trackingEnabled: Boolean(progress.trackingEnabled),
          trackingState: progress.trackingState || undefined,
          renameFromParent: Boolean(progress.renameFromParent),
          copyMissingFromParent: Boolean(progress.copyMissingFromParent),
        };
      }
      const registered = await versionService.registerProgressWithGraph(workspaceRoot, {
        projectName, progress: databaseProgress, workflowInputProgressIds,
      });
      if (!registered?.success || !registered.progressFolder) throw new Error(registered?.error || '进度和工作流关系提交失败');
      const relativePath = path.relative(projectPath, registered.progressFolder.folderPath).replace(/\\/g, '/');
      return {
        ...registered,
        relativePath,
        folder: {
          name: path.basename(registered.progressFolder.folderPath),
          path: registered.progressFolder.folderPath,
          relativePath,
          updatedAt: Date.now(),
        },
      };
    } catch (error) {
      if (movedFrom && movedTo && fs.existsSync(movedTo) && !fs.existsSync(movedFrom)) {
        try {
          await fs.promises.rename(movedTo, movedFrom);
        } catch (rollbackError) {
          moveRollbackError = rollbackError;
          writeLog('error', 'Unable to roll back progress root move after graph registration failure', {
            source: movedFrom, destination: movedTo, error: rollbackError.message || String(rollbackError),
          });
        }
      }
      if (createdDirectory && fs.existsSync(createdDirectory)) {
        try {
          if ((await fs.promises.readdir(createdDirectory)).length === 0) await fs.promises.rmdir(createdDirectory);
        } catch (cleanupError) {
          writeLog('warn', 'Unable to remove empty progress folder after graph rollback', { path: createdDirectory, error: cleanupError.message || String(cleanupError) });
        }
      }
      const message = error.message || String(error);
      return { success: false, error: moveRollbackError ? `${message}；文件夹回滚失败：${moveRollbackError.message || String(moveRollbackError)}` : message };
    } finally {
      if (movedFrom) releaseWorkspaceWatchPath(movedFrom);
      if (movedTo) releaseWorkspaceWatchPath(movedTo);
    }
  });

  ipcMain.handle('workspace-progress-adopt-media', async (_event, workspacePath, status, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const allowed = ['projectName', 'relativePath', 'mode', 'mediaKind', 'sourceProgressId'];
      if (!request || Object.keys(request).some(key => !allowed.includes(key))) {
        throw new Error('media_adopt_payload_invalid: 请求字段无效');
      }
      const projectName = String(request.projectName || '').trim();
      const relativePath = String(request.relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const mode = String(request.mode || '');
      const mediaKind = String(request.mediaKind || '');
      const sourceProgressId = String(request.sourceProgressId || '').trim();
      if (!projectName || !relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..')
        || !['original', 'companion', 'preview', 'transcode', 'broll'].includes(mode)
        || (mode === 'broll' ? mediaKind !== 'mixed' : !['image', 'video'].includes(mediaKind))
        || mode === 'transcode' && mediaKind !== 'video') {
        throw new Error('media_adopt_payload_invalid: 项目内相对路径和素材类型必填');
      }
      if ((mode === 'original' || mode === 'broll') && sourceProgressId || (mode === 'companion' || mode === 'preview' || mode === 'transcode') && !sourceProgressId) {
        throw new Error('media_adopt_payload_invalid: 来源节点无效');
      }
      const resolution = projectVirtualPaths.resolve(path.resolve(getProjectPath(workspacePath, status, projectName)), relativePath, { externalRootMode: 'target' });
      const folderPath = resolution.physicalPath;
      if (!isInside(path.resolve(getProjectPath(workspacePath, status, projectName)), folderPath)) throw new Error('目录必须位于当前项目内');
      if (!fs.statSync(folderPath).isDirectory()) throw new Error('media_adopt_folder_invalid: 目标必须是文件夹');
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const source = sourceProgressId ? (listed.progressFolders || []).find(folder => folder.id === sourceProgressId) : null;
      if (sourceProgressId && (mode === 'companion'
        ? !source || source.folderMissing || source.mediaKind !== mediaKind || source.nodeRole !== 'original' || source.artifactKind
        : !isValidProgressParent(source, mediaKind))) {
        throw new Error('media_adopt_source_invalid: 来源不属于当前项目');
      }
      return await versionService.adoptMediaFolder(workspaceRoot, {
        projectName, folderPath, mode, mediaKind,
        ...(sourceProgressId ? { sourceProgressId } : {}),
      });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-relation-update', async (_event, workspacePath, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const projectNodeIds = new Set((listed.progressFolders || []).map(folder => folder.id));
      const child = (listed.progressFolders || []).find(folder => folder.id === String(request.childProgressId || ''));
      const childProgressId = String(request.childProgressId || '');
      const parentProgressId = request.parentProgressId == null ? null : String(request.parentProgressId);
      if (!projectNodeIds.has(childProgressId) || parentProgressId && !projectNodeIds.has(parentProgressId)) {
        throw new Error('relation_project_mismatch: 父子节点不属于当前项目');
      }
      if (child?.nodeRole === 'progress' && parentProgressId === null) {
        throw new Error('progress_detach_requires_unregister: 断开进度必须显式取消版本登记');
      }
      return await versionService.updateProgressRelation(workspaceRoot, {
        childProgressId,
        parentProgressId,
        ...(request.expectedUpdatedAt == null ? {} : { expectedUpdatedAt: Number(request.expectedUpdatedAt) }),
      });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  const mutateVersionGraphEdge = async (workspacePath, request, mutation) => {
    const workspaceRoot = ensureWorkspace(workspacePath);
    if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
    const projectId = String(request?.projectId || '');
    const sourceProgressId = String(request?.sourceProgressId || '');
    const targetProgressId = String(request?.targetProgressId || '');
    const edgeKind = String(request?.edgeKind || '');
    if (!validOpaqueId(projectId) || !validOpaqueId(sourceProgressId) || !validOpaqueId(targetProgressId)
      || !['media_companion', 'derived_preview', 'derived_transcode', 'workflow_input'].includes(edgeKind)) {
      throw new Error('version_graph_edge_payload_invalid: 项目、节点或关系类型无效');
    }
    return mutation(workspaceRoot, { projectId, sourceProgressId, targetProgressId, edgeKind });
  };

  ipcMain.handle('workspace-version-graph-edge-create', async (_event, workspacePath, request = {}) => {
    try {
      return await mutateVersionGraphEdge(workspacePath, request, (root, payload) => versionService.createVersionGraphEdge(root, payload));
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-graph-edge-delete', async (_event, workspacePath, request = {}) => {
    try {
      return await mutateVersionGraphEdge(workspacePath, request, (root, payload) => versionService.deleteVersionGraphEdge(root, payload));
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-graph-edge-replace-source', async (_event, workspacePath, request = {}) => {
    try {
      const newSourceProgressId = String(request?.newSourceProgressId || '');
      if (!validOpaqueId(newSourceProgressId)) throw new Error('version_graph_edge_payload_invalid: 新来源节点无效');
      return await mutateVersionGraphEdge(workspacePath, request, (root, payload) => versionService.replaceVersionGraphEdgeSource(root, {
        ...payload,
        newSourceProgressId,
      }));
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  const normalizeVersionTreeScope = value => {
    const raw = String(value || '').trim().replace(/\\/g, '/');
    if (raw.length > 1024 || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new Error('version_tree_scope_invalid: scopeKey 必须是项目内相对路径');
    const parts = raw.split('/').filter(part => part && part !== '.');
    if (parts.includes('..')) throw new Error('version_tree_scope_invalid: scopeKey 不能包含 ..');
    return parts.join('/');
  };

  const versionTreeEntryNodeBelongsToScope = (nodeKey, scopeKey) => {
    if (!nodeKey.startsWith('entry:')) return false;
    const relativePath = nodeKey.slice('entry:'.length);
    if (!relativePath || relativePath.length > 1024 || relativePath.includes('\\')) return false;
    let normalizedPath;
    try { normalizedPath = normalizeVersionTreeScope(relativePath); } catch { return false; }
    if (normalizedPath !== relativePath) return false;
    const parentScope = normalizedPath.split('/').slice(0, -1).join('/');
    return parentScope.toLocaleLowerCase('zh-CN') === scopeKey.toLocaleLowerCase('zh-CN');
  };

  ipcMain.handle('workspace-version-tree-layout-get', async (_event, workspacePath, projectName, scopeKey = '') => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      return await versionService.getVersionTreeLayout(workspaceRoot, { projectName, scopeKey: normalizeVersionTreeScope(scopeKey) });
    } catch (error) {
      return { success: false, error: error.message || String(error), revision: 0, positions: [] };
    }
  });

  ipcMain.handle('workspace-version-tree-layout-save', async (_event, workspacePath, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const scopeKey = normalizeVersionTreeScope(request.scopeKey);
      const mode = request.mode === 'patch' || request.mode === 'replace' ? request.mode : '';
      const expectedRevision = request.expectedRevision;
      const positions = Array.isArray(request.positions) ? request.positions : [];
      if (!mode || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || positions.length > 1000) throw new Error('version_tree_layout_payload_invalid: 布局请求无效');
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const allowedNodeKeys = new Set((listed.progressFolders || []).map(folder => `progress:${folder.id}`));
      const seen = new Set();
      const normalizedPositions = positions.map(position => {
        const nodeKey = String(position?.nodeKey || '');
        const x = position?.x;
        const y = position?.y;
        if ((!allowedNodeKeys.has(nodeKey) && !versionTreeEntryNodeBelongsToScope(nodeKey, scopeKey)) || seen.has(nodeKey)) throw new Error('version_tree_layout_node_invalid: 节点不属于当前项目');
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) throw new Error('version_tree_layout_coordinate_invalid: 坐标无效');
        seen.add(nodeKey);
        return { nodeKey, x, y };
      });
      return await versionService.saveVersionTreeLayout(workspaceRoot, { projectName, scopeKey, expectedRevision, mode, positions: normalizedPositions });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-legacy-selection-relation-repair', async (_event, workspacePath, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const listed = await versionService.listProgress(workspaceRoot, projectName, true);
      const progressId = String(request.progressId || '');
      const sourceProgressId = String(request.sourceProgressId || '');
      const requestedAction = request.action == null || request.action === '' ? 'connect' : String(request.action);
      if (!['connect', 'keep-independent'].includes(requestedAction)) throw new Error('legacy_selection_repair_action_invalid: 修复操作无效');
      const action = requestedAction;
      const projectNodeIds = new Set((listed.progressFolders || []).map(folder => folder.id));
      const repairIds = new Set((listed.legacySelectionRelationRepairs || []).map(repair => repair.progressId));
      if (!repairIds.has(progressId) || !projectNodeIds.has(progressId) || action === 'connect' && !projectNodeIds.has(sourceProgressId)) {
        throw new Error('legacy_selection_repair_project_mismatch: 修复节点不属于当前项目');
      }
      return await versionService.repairLegacySelectionRelation(workspaceRoot, action === 'keep-independent'
        ? { progressId, action }
        : { progressId, sourceProgressId });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-update', async (_event, workspacePath, status, projectName, request = {}) => {
    let mutationHandle = null;
    let mutationToken = '';
    let mutationWorkspaceRoot = '';
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      mutationWorkspaceRoot = workspaceRoot;
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      mutationHandle = backgroundTasks?.create?.({
        type: 'version-tree-update',
        title: '修改版本树',
        message: '等待版本比较和其他文件操作完成',
        runningMessage: '正在修改版本树',
        cancellable: false,
        resources: [projectPath],
        concurrencyGroup: 'disk-io',
        concurrencyLimit: 3,
        concurrencyWriteLimit: 2,
        resourceAccess: 'write',
        metadata: { projectName, progressId: String(request.progressId || '') },
      }) || null;
      await mutationHandle?.waitForStart?.();
      const mutation = await versionService.beginProgressTreeUpdate(workspaceRoot, { projectName });
      mutationToken = mutation.mutationToken;
      const listed = await versionService.listProgress(workspaceRoot, projectName);
      const progressFolders = Array.isArray(listed.progressFolders) ? listed.progressFolders : [];
      const current = progressFolders.find(progress => progress.id === request.progressId);
      if (!current || current.nodeRole !== 'progress') throw new Error('要修改的进度不存在或角色不允许修改');
      if (request.mediaKind && request.mediaKind !== current.mediaKind) throw new Error('修改进度时不能改变图片或视频类型');

      const versionKey = String(request.versionKey || '').trim();
      if (!/^\d+(?:_\d+)*$/.test(versionKey)) throw new Error('无效的版本编号');
      const requestedParentId = String(request.parentProgressId || '').trim();
      if (!requestedParentId) throw new Error('progress_parent_required: 版本进度必须保留有效父节点');
      const requestedParent = requestedParentId ? progressFolders.find(progress => progress.id === requestedParentId) : null;
      if (!isValidProgressParent(requestedParent, current.mediaKind)) throw new Error('父版本进度不存在');
      const updated = await versionService.updateProgressTree(workspaceRoot, {
        projectName,
        mutationToken,
        primaryProgressId: current.id,
        updates: [{
          id: current.id,
          mediaKind: current.mediaKind,
          versionKey,
          parentProgressId: requestedParentId,
          trackingEnabled: request.trackingEnabled === undefined ? Boolean(current.trackingEnabled) : Boolean(request.trackingEnabled),
          trackingState: request.trackingState || current.trackingState,
          renameFromParent: request.renameFromParent === undefined ? Boolean(current.renameFromParent) : Boolean(request.renameFromParent),
          copyMissingFromParent: request.copyMissingFromParent === undefined ? Boolean(current.copyMissingFromParent) : Boolean(request.copyMissingFromParent),
        }],
      });
      // The write reservation above ends with the tree mutation. The deferred
      // media scheduler coalesces repeated refreshes and never holds a task-wide
      // project or workspace-database reservation.
      if (scheduleMediaTrackingScan) setTimeout(() => scheduleMediaTrackingScan(workspaceRoot, projectName, [], true), 250);
      mutationToken = '';
      mutationHandle?.complete?.('版本树已更新');
      return updated;
    } catch (error) {
      if (mutationToken && mutationWorkspaceRoot) {
        await versionService.finishProgressTreeUpdate(mutationWorkspaceRoot, { projectName, mutationToken }).catch(finishError => {
          writeLog('error', 'Unable to release progress-tree mutation lease', { projectName, error: finishError.message || String(finishError) });
        });
      }
      mutationHandle?.fail?.(error);
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-folder-rename', async (_event, workspacePath, status, projectName, request = {}) => {
    let mutationToken = '';
    let workspaceRoot = '';
    let oldPath = '';
    let newPath = '';
    try {
      if (!request || typeof request !== 'object'
        || Object.keys(request).some(key => !['progressId', 'expectedFolderId', 'expectedRelativePath', 'newName'].includes(key))) {
        throw new Error('progress_folder_rename_payload_invalid: 请求字段无效');
      }
      workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      context.cancelMediaTrackingScan?.(workspaceRoot, projectName);
      // An explicit progress ID already identifies this mutation. Read its
      // persisted snapshot without reconciling every folder in the project.
      // Externally moved/missing paths still take the recovery-aware list path.
      let listed = versionService.snapshotProgress
        ? await versionService.snapshotProgress(workspaceRoot, projectName, true)
        : await versionService.listProgress(workspaceRoot, projectName, true);
      let current = (listed.progressFolders || []).find(progress => progress.id === String(request.progressId || ''));
      if (versionService.snapshotProgress && (!listed.success || !current || !fs.existsSync(current.folderPath))) {
        listed = await versionService.listProgress(workspaceRoot, projectName, true);
        current = (listed.progressFolders || []).find(progress => progress.id === String(request.progressId || ''));
      }
      if (!current || current.nodeRole !== 'progress') throw new Error('progress_folder_rename_role_invalid: 只能重命名已登记的 progress 目录');
      const expectedRelativePath = normalizeProjectRelativePath(request.expectedRelativePath);
      const currentRelativePath = path.relative(projectPath, path.resolve(current.folderPath)).replace(/\\/g, '/');
      if (!request.expectedFolderId || request.expectedFolderId !== current.folderId) {
        throw new Error('progress_folder_identity_mismatch: 当前目录已变化，请刷新后重试');
      }

      if (expectedRelativePath !== currentRelativePath) throw new Error('progress_folder_identity_mismatch: 当前目录已变化，请刷新后重试');

      oldPath = path.resolve(current.folderPath);
      const newName = String(request.newName || '');
      if (!validProgressFolderName(newName)) throw new Error('progress_folder_name_invalid: 进度名称无效');
      newPath = path.resolve(path.dirname(oldPath), newName);
      if (path.dirname(newPath) !== path.dirname(oldPath)) throw new Error('progress_folder_name_invalid: 进度名称无效');
      if (protectedProjectFolders.isProtectedProjectFolderName(request.newName)) throw new Error('progress_folder_name_reserved: 该名称保留给固定工作流使用');
      suppressWorkspaceWatchPath(oldPath);
      suppressWorkspaceWatchPath(newPath);
      const mutation = await versionService.beginProgressTreeUpdate(workspaceRoot, { projectName });
      mutationToken = mutation.mutationToken;
      const result = await versionService.renameProgressFolder(workspaceRoot, {
        projectName,
        progressId: current.id,
        expectedFolderId: request.expectedFolderId,
        expectedRelativePath,
        newName,
        reservedProjectFolderNames: protectedProjectFolders.progressRelocationReservedNames(),
        mutationToken,
      });
      mutationToken = '';
      // The committed progress and exact new path are returned below. Catalog
      // refresh is presentation maintenance and must not extend the write lock.
      void refreshWorkspaceCatalog(workspaceRoot).catch(refreshError => { writeLog('warn', 'Unable to refresh workspace catalog after committed progress rename', { projectName, error: refreshError.message || String(refreshError) }); });
      if (scheduleMediaTrackingScan) setTimeout(() => scheduleMediaTrackingScan(workspaceRoot, projectName, [], true), 250);
      return result;
    } catch (error) {
      if (mutationToken && workspaceRoot) await versionService.finishProgressTreeUpdate(workspaceRoot, { projectName, mutationToken }).catch(() => undefined);
      return { success: false, error: error.message || String(error) };
    } finally {
      if (oldPath) releaseWorkspaceWatchPath(oldPath);
      if (newPath) releaseWorkspaceWatchPath(newPath);
    }
  });

  ipcMain.handle('workspace-version-register-baseline', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const folderPath = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      if (!fs.statSync(folderPath).isDirectory()) throw new Error('版本进度文件夹不存在');
      return await versionService.registerBatchBaseline(workspaceRoot, { projectName, folderPath });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  registerVersionTrackingIpc({ backgroundTasks, copyFileAtomic, crypto, ensureWorkspace, fs, getWorkspaceDataRoot, ipcMain, path, refreshWorkspaceCatalog, runPythonEventAction, scheduleMediaTrackingScan, trackingScanService, versionService, workspaceCatalogs, writeLog });

  ipcMain.handle('workspace-version-compare-preview', async (_event, workspacePath, status, projectName, referenceRelativePath, sourceRelativePath, sourceNames) => {
    let sourceManifestPath = '';
    try {
      const folderA = resolveProjectEntry(workspacePath, status, projectName, referenceRelativePath);
      const folderB = resolveProjectEntry(workspacePath, status, projectName, sourceRelativePath);
      if (!fs.statSync(folderA).isDirectory() || !fs.statSync(folderB).isDirectory()) throw new Error('版本对比必须选择两个文件夹');
      if (folderA.toLocaleLowerCase() === folderB.toLocaleLowerCase()) throw new Error('上一版本和新版本不能是同一个文件夹');
      const selectedSourceNames = Array.isArray(sourceNames) ? [...new Set(sourceNames.map(value => String(value || '')).filter(value => value && path.basename(value) === value))] : [];
      if (selectedSourceNames.length) {
        const trackingDataDirectory = path.join(getWorkspaceDataRoot(workspacePath), 'version-tracking');
        fs.mkdirSync(trackingDataDirectory, { recursive: true });
        sourceManifestPath = path.join(trackingDataDirectory, `${crypto.randomUUID()}-sources.json`);
        fs.writeFileSync(sourceManifestPath, JSON.stringify(selectedSourceNames), 'utf8');
      }
      writeLog('info', 'Comparing progress version folders', { projectName, folderA, folderB, selectedSourceCount: selectedSourceNames.length });
      const events = await runPythonEventAction('rename.py', ['--folder_a', folderA, '--folder_b', folderB, '--preview', ...(sourceManifestPath ? ['--source_files_file', sourceManifestPath] : [])], 60 * 60 * 1000);
      const preview = events.find(event => event.type === 'preview');
      if (!preview) throw new Error('版本对比没有返回匹配结果');
      return {
        success: true,
        matches: Array.isArray(preview.data?.matches) ? preview.data.matches : [],
        suggestions: Array.isArray(preview.data?.suggestions) ? preview.data.suggestions : [],
        unmatched: Array.isArray(preview.data?.unmatched) ? preview.data.unmatched : [],
        unmatchedReference: Array.isArray(preview.data?.unmatchedReference) ? preview.data.unmatchedReference : [],
      };
    } catch (error) {
      writeLog('error', 'Unable to compare progress version folders', { projectName, referenceRelativePath, sourceRelativePath, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), matches: [], suggestions: [], unmatched: [], unmatchedReference: [] };
    } finally {
      if (sourceManifestPath) {
        try { fs.unlinkSync(sourceManifestPath); } catch {}
      }
    }
  });

  ipcMain.handle('workspace-version-batch-commit', async (_event, workspacePath, status, projectName, request = {}) => {
    const copiedMissingPaths = [];
    let batchPersisted = false;
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('版本批次请求无效');
      const renameSources = compatibleBoolean(request.renameSources, '版本批次字段 renameSources');
      const reconcileExisting = compatibleBoolean(request.reconcileExisting, '版本批次字段 reconcileExisting');
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const realProjectPath = fs.realpathSync(projectPath);
      const resolveBatchFolder = value => {
        const folderPath = path.resolve(String(value || ''));
        const relative = path.relative(projectPath, folderPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('批次必须选择项目内的两个不同子文件夹');
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) throw new Error('批次文件夹不存在');
        const realFolderPath = fs.realpathSync(folderPath);
        const realRelative = path.relative(realProjectPath, realFolderPath);
        if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('批次文件夹的真实路径超出项目范围');
        return { folderPath, realFolderPath };
      };
      const resolvedFolderA = resolveBatchFolder(request.folderA);
      const resolvedFolderB = resolveBatchFolder(request.folderB);
      const folderA = resolvedFolderA.folderPath;
      const folderB = resolvedFolderB.folderPath;
      if (folderA.toLocaleLowerCase() === folderB.toLocaleLowerCase()) throw new Error('对照批次的来源和目标不能是同一个文件夹');
      if (pathKey(resolvedFolderA.realFolderPath) === pathKey(resolvedFolderB.realFolderPath)) throw new Error('对照批次的来源和目标不能指向同一个物理文件夹');
      const importKey = await buildVersionBatchImportKey(folderA, folderB);
      if (request.matches !== undefined && !Array.isArray(request.matches)) throw new Error('匹配结果必须是数组');
      if ((request.matches || []).length > 20000) throw new Error('匹配结果数量过多');
      const matches = (request.matches || []).map(match => {
        if (!match || typeof match !== 'object' || Array.isArray(match)) throw new Error('匹配结果格式无效');
        const reference = String(match.reference || '');
        const source = String(match.source || '');
        const target = String(match.target || source);
        if (!reference || path.basename(reference) !== reference || !source || path.basename(source) !== source || !target || path.basename(target) !== target) throw new Error('匹配结果包含无效文件名');
        return {
          reference,
          source,
          target,
          distance: Number.isFinite(Number(match.distance)) ? Number(match.distance) : 1000000,
          confidence: String(match.confidence || '').slice(0, 20),
        };
      });
      const copyMissingErrors = [];
      const reservedDestinations = new Set();
      if (request.copyMissingReferences !== undefined && !Array.isArray(request.copyMissingReferences)) throw new Error('补齐文件列表必须是数组');
      if ((request.copyMissingReferences || []).length > 20000) throw new Error('补齐文件数量过多');
      const missingReferences = [...new Set((request.copyMissingReferences || []).map(value => String(value || '')))];
      for (const reference of missingReferences) {
        try {
          if (!reference || path.basename(reference) !== reference) throw new Error('无效文件名');
          const sourcePath = path.resolve(folderA, reference);
          if (path.dirname(sourcePath).toLocaleLowerCase() !== folderA.toLocaleLowerCase()) throw new Error('文件不在上一版本文件夹中');
          if (!supportedVersionFileKind(sourcePath)) throw new Error('不是支持的媒体文件');
          const destinationPath = uniqueDestination(folderB, reference, reservedDestinations);
          await copyFileAtomic(sourcePath, destinationPath);
          copiedMissingPaths.push(destinationPath);
          const copiedName = path.basename(destinationPath);
          matches.push({ reference, source: copiedName, target: copiedName, distance: 0, confidence: '复制补齐' });
        } catch (error) {
          copyMissingErrors.push({ name: reference, error: error.message || String(error) });
        }
      }
      if (request.incrementalSources !== undefined && !Array.isArray(request.incrementalSources)) throw new Error('增量文件列表必须是数组');
      if ((request.incrementalSources || []).length > 20000) throw new Error('增量文件数量过多');
      const incrementalSources = (request.incrementalSources || []).map(value => {
        const name = String(value || '');
        if (!name || path.basename(name) !== name) throw new Error('增量文件列表包含无效文件名');
        return name;
      });
      const result = await versionService.commitBatchCompare(workspaceRoot, {
        projectName,
        folderA,
        folderB,
        importKey,
        displayName: cleanVersionName(request.displayName || path.basename(folderB)) || path.basename(folderB),
        renameSources,
        reconcileExisting,
        incrementalSources,
        matches,
      });
      if (!result) throw new Error('版本批次提交没有返回结果');
      if (!result.success && !result.repairRequired) throw new Error(result.error || '版本批次提交失败');
      batchPersisted = true;
      writeLog(result.repairRequired ? 'warn' : 'info', result.repairRequired ? 'Version batch requires repair' : 'Version batch committed', {
        projectName, folderA, folderB, matchCount: matches.length,
        copiedMissingCount: copiedMissingPaths.length, copyMissingErrorCount: copyMissingErrors.length,
        batch: result.batch?.sequence,
      });
      return { ...result, copiedMissingCount: copiedMissingPaths.length, copyMissingErrors };
    } catch (error) {
      if (!batchPersisted) await Promise.all(copiedMissingPaths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => undefined)));
      writeLog('error', 'Unable to commit version batch', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-batch-operations', async (_event, workspacePath, batchId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const normalizedBatchId = String(batchId || '');
      if (!/^[0-9a-f-]{36}$/i.test(normalizedBatchId)) throw new Error('版本批次标识无效');
      return await versionService.listBatchOperations(workspaceRoot, normalizedBatchId);
    } catch (error) {
      return { success: false, operations: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-batch-retry', async (_event, workspacePath, batchId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const normalizedBatchId = String(batchId || '');
      if (!/^[0-9a-f-]{36}$/i.test(normalizedBatchId)) throw new Error('版本批次标识无效');
      const result = await versionService.retryBatchOperations(workspaceRoot, normalizedBatchId);
      if (!result) return { success: false, error: '版本批次修复没有返回结果' };
      if (!result.success) return result;
      writeLog(result.success ? 'info' : 'warn', 'Version batch repair attempted', {
        batchId: normalizedBatchId,
        remainingErrors: result.renameErrors?.length || 0,
      });
      return result;
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-update', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      return await versionService.updateVersion(workspaceRoot, {
        versionId: request.versionId,
        ...(request.versionName !== undefined ? { versionName: cleanVersionName(request.versionName) } : {}),
        ...(request.note !== undefined ? { note: String(request.note).slice(0, 2000) } : {}),
        ...(request.isFinal !== undefined ? { isFinal: Boolean(request.isFinal) } : {}),
        ...(request.makeCurrent ? { makeCurrent: true } : {}),
      });
    } catch (error) {
      return { success: false, error: error.message || String(error), versions: [] };
    }
  });

  ipcMain.handle('workspace-version-relocate', async (_event, workspacePath, status, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(key => !['photoId', 'versionId', 'filePath', 'force'].includes(key))) throw new Error('重新定位请求无效');
      const photoId = String(request.photoId || '');
      const versionId = String(request.versionId || '');
      if (!validOpaqueId(photoId) || !validOpaqueId(versionId)) throw new Error('重新定位的版本标识无效');
      if (![undefined, null, false, true, 0, 1].some(value => Object.is(value, request.force))) throw new Error('重新定位确认字段必须是布尔值');
      const force = request.force === true;
      const resolvedProjectPath = getProjectPath(workspacePath, status, projectName);
      if (typeof resolvedProjectPath !== 'string' || !resolvedProjectPath) throw new Error('当前项目路径无效');
      path.resolve(resolvedProjectPath);
      const bundle = await versionService.getPhoto(workspaceRoot, photoId);
      if (!bundle?.success || !bundle.photo || !(bundle.versions || []).some(version => version.id === versionId)) throw new Error(bundle?.error || '重新定位的版本不存在');
      const catalog = workspaceCatalogs.get(workspaceRoot);
      const catalogProject = catalog?.byName?.get(String(projectName).toLocaleLowerCase())
        || catalog?.projects?.find(project => project.name === projectName);
      if (!catalogProject?.id || !bundle.photo.projectId || catalogProject.id !== bundle.photo.projectId) throw new Error('重新定位的版本不属于当前项目');
      const now = Date.now();
      pruneRelocateDecisions(now);
      const decisionKey = relocateDecisionKey(workspaceRoot, versionId);
      const pendingDecision = force ? pendingRelocateDecisions.get(decisionKey) : null;
      pendingRelocateDecisions.delete(decisionKey);
      if (force && (!pendingDecision || pendingDecision.expiresAt <= now)) throw new Error('重新定位确认已失效，请重新选择文件');
      let filePath = request.filePath ? path.resolve(request.filePath) : '';
      if (!filePath) {
        const choice = await dialog.showOpenDialog(mainWindow, {
          title: '重新定位版本文件',
          properties: ['openFile'],
          filters: [{ name: '图片和视频', extensions: [...new Set([...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS, ...VIDEO_EXTENSIONS])].map(value => value.slice(1)) }, { name: '所有文件', extensions: ['*'] }]
        });
        if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, versions: [] };
        filePath = path.resolve(choice.filePaths[0]);
      }
      filePath = path.resolve(await mediaService.authorizeInput(filePath));
      if (!fs.existsSync(filePath)) throw new Error('重新定位的文件不存在');
      const fileStat = fs.statSync(filePath);
      if (!fileStat.isFile()) throw new Error('重新定位的文件不存在');
      if (!supportedVersionFileKind(filePath)) throw new Error('重新定位的文件不是支持的图片、RAW 或视频');
      if (force && (pathKey(pendingDecision.filePath) !== pathKey(filePath)
        || pendingDecision.photoId !== photoId
        || pendingDecision.projectId !== bundle.photo.projectId
        || pendingDecision.size !== Number(fileStat.size)
        || pendingDecision.mtimeMs !== Number(fileStat.mtimeMs))) {
        throw new Error('重新定位确认已失效，请重新选择文件');
      }
      let result;
      try {
        result = await versionService.relocateVersion(workspaceRoot, { versionId, filePath, force });
      } catch (error) {
        pendingRelocateDecisions.delete(decisionKey);
        throw error;
      }
      if (!result) {
        pendingRelocateDecisions.delete(decisionKey);
        throw new Error('重新定位版本没有返回结果');
      }
      if (result.fingerprintMismatch) {
        pendingRelocateDecisions.set(decisionKey, {
          filePath,
          photoId,
          projectId: bundle.photo.projectId,
          size: Number(fileStat.size),
          mtimeMs: Number(fileStat.mtimeMs),
          expiresAt: Date.now() + RELOCATE_DECISION_TTL_MS,
        });
        return {
          success: true,
          versions: [],
          requiresDecision: {
            kind: 'version-fingerprint-mismatch',
            filePath,
            message: '所选文件与原版本的内容指纹不一致',
            detail: '继续会保留原 Photo ID 和 Version ID，但把该版本标记为“内容已变化”。',
          },
        };
      }
      pendingRelocateDecisions.delete(decisionKey);
      if (!result.success) return result;
      void ensureTrackedVersionThumbnail({ workspaceRoot, photoId, versionId, filePath });
      writeLog('info', 'Media version relocated', { projectName, photoId, versionId, filePath });
      return result;
    } catch (error) {
      return { success: false, error: error.message || String(error), versions: [] };
    }
  });

  ipcMain.handle('workspace-version-delete', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const bundle = await versionService.getPhoto(workspaceRoot, request.photoId);
      const version = bundle.versions?.find(item => item.id === request.versionId);
      if (!version) throw new Error('版本不存在');
      const result = await versionService.deleteVersion(workspaceRoot, request.versionId);
      queueCleanupArtifacts(workspaceRoot, result, '清理已删除版本的内部文件');
      let warning;
      if (request.trashFile && fs.existsSync(version.filePath)) {
        try { await recycleBinService.trash(version.filePath); }
        catch (error) { warning = `版本记录已删除，但文件移入回收站失败：${error.message || String(error)}`; }
      }
      return { ...result, warning };
    } catch (error) {
      return { success: false, error: error.message || String(error), versions: [] };
    }
  });

  ipcMain.handle('workspace-version-delete-scope', async (_event, workspacePath, versionId) => {
    try {
      return await versionService.getVersionDeleteScope(ensureWorkspace(workspacePath), versionId);
    } catch (error) {
      return { success: false, versionNumber: 0, versionCount: 0, missingCount: 0, allMissing: false, childCount: 0, selectedChildCount: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-delete-project-missing', async (_event, workspacePath, versionId) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const result = await versionService.deleteProjectMissingVersion(workspaceRoot, versionId);
      queueCleanupArtifacts(workspaceRoot, result, '清理缺失版本的内部文件');
      return { ...result, cleanupQueued: true };
    } catch (error) {
      return { success: false, deletedCount: 0, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-version-compare-record', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(key => !['photoId', 'leftVersionId', 'rightVersionId', 'compareMode'].includes(key))) throw new Error('版本对比记录请求无效');
      const photoId = String(request.photoId || '');
      const leftVersionId = String(request.leftVersionId || '');
      const rightVersionId = String(request.rightVersionId || '');
      const compareMode = String(request.compareMode || 'side-by-side');
      if (!validOpaqueId(photoId) || !validOpaqueId(leftVersionId) || !validOpaqueId(rightVersionId) || leftVersionId === rightVersionId
        || !['side-by-side', 'split', 'overlay', 'blink', 'difference'].includes(compareMode)) throw new Error('版本对比记录参数无效');
      const bundle = await versionService.getPhoto(workspaceRoot, photoId);
      const versionIds = new Set((bundle?.versions || []).map(version => version.id));
      if (!bundle?.success || !versionIds.has(leftVersionId) || !versionIds.has(rightVersionId)) throw new Error(bundle?.error || '版本对比节点不属于同一素材');
      return await versionService.recordCompare(workspaceRoot, { photoId, leftVersionId, rightVersionId, compareMode });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

};

module.exports = { registerVersionIpc };
