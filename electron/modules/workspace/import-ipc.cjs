const { localizeDialogOptions } = require("../../services/localization.cjs");
const { t: translateNative } = require("../../services/localization.cjs");
const registerWorkspaceImportIpc = dependencies => {
  const {
    Array,
    Boolean,
    CANCELLED_CODE,
    Date,
    Error,
    IMAGE_EXTENSIONS,
    IMPORT_GRAPH_RECEIPT_NAME,
    JSON,
    Math,
    Number,
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
    sendToApplicationRenderers = (target, channel, payload) => target?.webContents?.send?.(channel, payload),
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
  } = dependencies;

  ipcMain.handle('workspace-create-progress-folder', async (_event, workspacePath, status, projectName, request = {}) => {
    let folderPath = '';
    let folderOwnership = null;
    let registrationCommitted = false;
    try {
      const cleanedName = cleanProjectName(String(request.displayName || ''));
      if (!cleanedName) throw new Error('进度文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      folderPath = path.resolve(projectPath, cleanedName);
      if (!folderPath.startsWith(projectPath + path.sep)) throw new Error('无效的进度文件夹名称');
      if (fs.existsSync(folderPath)) throw new Error('同名进度文件夹已存在');
      await fs.promises.mkdir(folderPath);
      folderOwnership = { created: true, identity: await captureIdentity(folderPath) };
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const registered = await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: request.mediaKind,
        versionKey: request.versionKey,
        parentProgressId: request.parentProgressId,
        displayName: cleanedName,
        folderPath,
        trackingEnabled: false,
      });
      registrationCommitted = true;
      let warning;
      await pushUndoOperation({ kind: 'remove-created', paths: [folderPath], label: '新建版本进度' }).catch(error => {
        warning = '进度文件夹已创建并登记，但无法记录撤销操作';
        writeLog('warn', 'Unable to record progress folder undo after registration', error);
      });
      return {
        success: true,
        progressFolder: registered.progressFolder,
        folder: { name: cleanedName, path: folderPath, relativePath: path.relative(projectPath, folderPath).replace(/\\/g, '/'), updatedAt: Date.now() },
        warning,
      };
    } catch (error) {
      if (!registrationCommitted) await removeIfOwned(folderPath, folderOwnership).catch(cleanupError => writeLog('warn', 'Unable to clean failed progress folder creation', cleanupError));
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-media-workflow-import-commit', async (_event, workspacePath, manifest = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const catalog = workspaceCatalogs.get(workspaceRoot) || await refreshWorkspaceCatalog(workspaceRoot);
      const locations = await receiptLocationsForSession(workspaceRoot, catalog, manifest?.importSessionId);
      if (!locations.length) throw Object.assign(new Error('未找到本次导入回执，已拒绝写入数据库'), { code: 'IMPORT_RECEIPT_ABSENT' });
      const selector = String(manifest?.manifestId || manifest?.projectName || '');
      const canonicalManifests = await Promise.all(locations.map(location => validateImportReceiptManifest(location, selector, manifest)));
      const canonicalKey = canonicalImportManifestKey(canonicalManifests[0]);
      if (canonicalManifests.some(candidate => canonicalImportManifestKey(candidate) !== canonicalKey)) throw Object.assign(
        new Error('多个导入回执内容不一致，已拒绝写入数据库并保留暂存文件'),
        { code: 'IMPORT_RECEIPT_LOCATION_MISMATCH', recoveryRequired: true },
      );
      const canonicalManifest = canonicalManifests[0];
      const result = await commitImportManifest(workspaceRoot, canonicalManifest, locations.length);
      for (const location of locations) await acknowledgeImportReceipt(location, canonicalManifest.manifestId, canonicalManifest);
      return { success: true, ...result };
    } catch (error) {
      writeLog('error', 'Unable to commit imported media workflow graph', { error: error.message || String(error) });
      return {
        success: false, retryable: true, error: error.message || String(error),
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.recoveryRequired ? { recoveryRequired: true } : {}),
      };
    }
  });

  ipcMain.handle('workspace-media-workflow-import-recover', async (_event, workspacePath) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const catalog = await reconcileWorkspaceCatalog(workspaceRoot);
      const recovered = [];
      const failures = [];
      for (const stagingRoot of importStagingRoots(workspaceRoot, catalog)) {
        let sessions = [];
        try { sessions = await fs.promises.readdir(stagingRoot, { withFileTypes: true }); } catch (error) {
          if (error?.code !== 'ENOENT') failures.push({
            stage: 'scan-staging-root', stagingRoot, code: error?.code || 'IMPORT_STAGING_READ_FAILED',
            error: error.message || String(error), recoveryRequired: true,
            recovery: '暂存目录未被修改；请检查目录权限或磁盘状态后重试恢复。',
          });
          continue;
        }
        for (const entry of sessions) {
          if (!entry.isDirectory() || !validImportSessionId(entry.name)) continue;
          const location = { sessionDir: path.join(stagingRoot, entry.name), receiptPath: path.join(stagingRoot, entry.name, IMPORT_GRAPH_RECEIPT_NAME) };
          const inspected = await inspectImportReceipt(location.receiptPath);
          const receipt = inspected.receipt;
          if (!receipt || receipt.importSessionId !== entry.name) {
            failures.push({
              stage: 'read-receipt', importSessionId: entry.name, receiptPath: location.receiptPath,
              code: inspected.status === 'io-error' ? (inspected.error?.code || 'IMPORT_RECEIPT_IO_ERROR') : `IMPORT_RECEIPT_${String(inspected.status).toUpperCase()}`,
              error: inspected.status === 'corrupt' ? '导入回执已损坏，无法安全自动恢复。'
                : inspected.status === 'absent' ? '导入暂存目录缺少回执，无法确认文件归属。'
                  : inspected.error?.message || '导入回执不可读取。',
              recoveryRequired: true,
              recovery: '所有暂存文件均已保留；请修复磁盘或权限问题后重试，或联系支持人员检查回执。',
            });
            continue;
          }
          for (const manifest of receipt.manifests) {
            const projectName = String(manifest?.projectName || '');
            if ((receipt.acknowledgedManifestIds || []).includes(manifest.manifestId)) continue;
            try {
              await commitImportManifest(workspaceRoot, manifest);
              recovered.push({ importSessionId: entry.name, projectName });
              await acknowledgeImportReceipt(location, manifest.manifestId, manifest);
            } catch (error) {
              failures.push({ importSessionId: entry.name, projectName, error: error.message || String(error) });
            }
          }
        }
      }
      return { success: failures.length === 0, recovered, failures };
    } catch (error) {
      return { success: false, recovered: [], failures: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-open-version', async (_event, filePath) => {
    try {
      const target = await mediaService.authorizeInput(filePath);
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-open-project', async (_event, workspacePath, status, projectName, folderName) => {
    try {
      const target = resolveProjectEntry(workspacePath, status, projectName, folderName);
      const error = await shell.openPath(target);
      return { success: !error, error };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-open-entry', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const target = resolveProjectEntry(workspacePath, status, projectName, relativePath);
      const error = await shell.openPath(target);
      return { success: !error, error };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('workspace-extract-office-images', async (_event, workspacePath, status, projectName, relativePaths = []) => {
    try {
      const requestedPaths = Array.isArray(relativePaths) ? relativePaths : [];
      if (!requestedPaths.length) throw new Error('没有选择 Office 文档');
      if (requestedPaths.length > 50) {
        return {
          success: false,
          error: `一次最多处理 50 个 Office 文档；已选择 ${requestedPaths.length} 个，本次未处理任何文档`,
          requestedCount: requestedPaths.length,
          acceptedCount: 0,
          skippedCount: requestedPaths.length,
          results: [],
        };
      }
      const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
      const resolutions = requestedPaths.map(relativePath => resolveToolSource(projectRoot, relativePath));
      const targets = resolutions.map(resolution => resolution.physicalPath);
      for (const target of targets) {
        if (!fs.statSync(target).isFile() || !officeOpenXmlExtensions.has(path.extname(target).toLowerCase())) {
          throw new Error(`不支持此 Office 文件：${path.basename(target)}`);
        }
      }
      const args = ['extract', ...targets.flatMap(target => ['--input', target])];
      const result = await runPythonJsonAction('office_media_extract.py', args, 20 * 60 * 1000);
      const extractionResults = Array.isArray(result?.results) ? result.results : [];
      const successfulResults = extractionResults.filter(item => item?.success);
      // A batch is reported as unsuccessful when any document fails. Preserve the
      // successful items so the renderer can show an accurate partial-completion
      // state instead of making an already-published extraction look unfinished.
      if (!result || (!result.success && !successfulResults.length)) throw new Error(result?.error || '提取图片失败');
      const publishedResults = extractionResults.map(item => ({ ...item }));
      for (let index = 0; index < extractionResults.length; index += 1) {
        const item = extractionResults[index];
        if (!item?.success || !item.outputFolder) continue;
        try {
          const resolution = resolutions[index];
          const outputRoot = resolution.viaExternalLink ? resolution.mediaRoot : projectRoot;
          const outputFolder = assertExistingInside(outputRoot, path.resolve(item.outputFolder), 'Office 图片输出路径');
          if (!fs.statSync(outputFolder).isDirectory()) throw new Error('Office 图片输出不是文件夹');
          publishedResults[index].publishSuccess = true;

        } catch (error) {
          publishedResults[index].publishSuccess = false;
          publishedResults[index].publishError = error.message || String(error);
        }
      }

      sendToApplicationRenderers(mainWindow, 'workspace-files-changed', { root: projectRoot, fileName: '' });
      const publicationFailures = publishedResults.filter(item => item?.success && item.publishSuccess === false);
      return {
        ...result,
        success: Boolean(result.success) && publicationFailures.length === 0,
        requestedCount: requestedPaths.length,
        acceptedCount: requestedPaths.length,
        skippedCount: 0,
        ...(publicationFailures.length ? { error: `已提取图片，但 ${publicationFailures.length} 个结果发布失败；可从输出目录恢复` } : {}),
        results: publishedResults,
      };
    } catch (error) {
      writeLog('warn', 'Office image extraction failed', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), results: [] };
    }
  });

  ipcMain.handle('workspace-extract-screenshot-main-images', async (event, workspacePath, status, projectName, relativePaths = [], options = {}) => {
    const requestId = String(options?.requestId || '');
    const analyzeOnly = options?.analyzeOnly === true;
    const confirmedCrops = Array.isArray(options?.crops) ? options.crops : null;
    const outputSuffix = options?.outputSuffix === '裁剪' ? '裁剪' : '主图';
    const replaceSource = options?.saveMode === 'replace';
    const publish = payload => {
      try {
        if (requestId && event?.sender && !event.sender.isDestroyed()) event.sender.send('workspace-screenshot-main-image-progress', { requestId, ...payload });
      } catch (error) { writeLog('warn', 'Unable to publish screenshot extraction progress', error); }
    };
    try {
      const allRequestedPaths = Array.isArray(relativePaths) ? relativePaths : [];
      const requestedPaths = allRequestedPaths.slice(0, 2000);
      const inputTruncated = allRequestedPaths.length > requestedPaths.length;
      if (!requestedPaths.length) throw new Error('没有选择图片');
      if (replaceSource && (analyzeOnly || !confirmedCrops || requestedPaths.length !== 1)) throw new Error('覆盖保存需要确认单张图片的裁剪范围');
      const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
      const targetResolutions = requestedPaths.map(relativePath => resolveToolSource(projectRoot, relativePath));
      const targets = targetResolutions.map(resolution => resolution.physicalPath);
      if (confirmedCrops && confirmedCrops.length !== targets.length) throw new Error('确认的裁剪范围与图片数量不一致');
      for (const target of targets) {
        if (!fs.statSync(target).isFile() || !screenshotMainImageExtensions.has(path.extname(target).toLowerCase())) {
          throw new Error(`不支持此图片格式：${path.basename(target)}`);
        }
      }
      const results = [];
      const command = analyzeOnly ? 'analyze' : confirmedCrops ? 'crop' : 'extract';
      publish({ phase: analyzeOnly ? 'analyzing' : 'extracting', progress: 0, processedCount: 0, totalCount: targets.length, message: analyzeOnly ? '正在准备分析截图主图…' : '正在准备提取截图主图…' });
      for (let offset = 0; offset < targets.length; offset += 60) {
        const chunk = targets.slice(offset, offset + 60);
        const cropChunk = confirmedCrops?.slice(offset, offset + chunk.length) || [];
        const args = [command, ...(replaceSource ? ['--replace-source'] : []), ...(confirmedCrops && outputSuffix === '裁剪' ? ['--output-suffix', '裁剪'] : []), ...chunk.flatMap((target, index) => {
          if (!confirmedCrops) return ['--input', target];
          const crop = cropChunk[index] || {};
          const values = ['x', 'y', 'width', 'height'].map(key => Math.round(Number(crop[key]) || 0));
          return ['--input', target, '--rectangle', values.join(',')];
        })];
        const payload = await runPythonJsonAction('screenshot_main_image.py', args, 30 * 60 * 1000, message => {
          if (message?.type !== 'progress') return;
          const processedCount = Math.max(0, Math.min(targets.length, offset + Number(message.processedCount || 0)));
          const currentName = String(message.currentName || '');
          const displayIndex = message.phase === 'item-start' ? Math.min(targets.length, processedCount + 1) : processedCount;
          publish({
            phase: analyzeOnly ? 'analyzing' : 'extracting',
            progress: Math.round(processedCount / Math.max(1, targets.length) * 100),
            processedCount,
            totalCount: targets.length,
            currentName,
            message: `${message.phase === 'item-complete' ? '已处理' : analyzeOnly ? '正在分析' : '正在裁剪'} ${displayIndex}/${targets.length}${currentName ? ` · ${currentName}` : ''}`,
          });
        });
        if (!payload?.success && !Array.isArray(payload?.results)) throw new Error(payload?.error || '提取截图主图失败');
        results.push(...(Array.isArray(payload.results) ? payload.results : []));
      }
      const croppedCount = results.filter(result => result?.cropped).length;
      const reviewCount = results.filter(result => result?.needsReview).length;
      const skippedCount = results.filter(result => result?.skipped).length;
      const failedCount = results.filter(result => !result?.success).length;
      publish({ phase: 'complete', progress: 100, processedCount: targets.length, totalCount: targets.length, message: analyzeOnly ? '主图范围分析完成' : '主图提取完成' });
      if (!analyzeOnly) {
        const outputPaths = [];
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          if (!result?.cropped || !result?.output) continue;
          const resolution = targetResolutions[index];
          const outputRoot = resolution?.viaExternalLink ? resolution.mediaRoot : projectRoot;
          const outputPath = assertExistingInside(outputRoot, path.resolve(result.output), '主图输出路径');
          outputPaths.push({ path: outputPath, root: outputRoot });

        }

        for (const item of outputPaths) void thumbnailService.syncChangedPaths(item.root, [item.path], mediaRuntimeState.activeMediaCacheConfig).catch(error => {
          writeLog('warn', 'Unable to queue screenshot main-image thumbnails', { projectName, error: error.message || String(error) });
        });
        const workspaceRoot = path.resolve(resolveWorkspaceRoot(workspacePath));
        sendToApplicationRenderers(mainWindow, 'workspace-files-changed', { root: workspaceRoot, fileName: path.relative(workspaceRoot, projectRoot), eventType: 'rename' });
      }
      return {
        success: failedCount < results.length,
        requestedCount: allRequestedPaths.length,
        acceptedCount: requestedPaths.length,
        truncated: inputTruncated,
        inputSkippedCount: allRequestedPaths.length - requestedPaths.length,
        inputCount: results.length,
        croppedCount,
        reviewCount,
        skippedCount,
        failedCount,
        results,
        ...(failedCount === results.length ? { error: results[0]?.error || '提取截图主图失败' } : {}),
      };
    } catch (error) {
      publish({ phase: 'failed', progress: 0, message: `提取失败：${error.message || String(error)}` });
      writeLog('warn', 'Screenshot main image extraction failed', { projectName, error: error.message || String(error) });
      return { success: false, error: error.message || String(error), results: [] };
    }
  });

  const restartVideoTrim = async interruptedTask => {
    const metadata = interruptedTask.metadata || {};
    const workspacePath = String(metadata.workspacePath || '');
    const status = String(metadata.projectStatus || '');
    const projectName = String(metadata.projectName || '');
    const relativePath = String(metadata.sourceRelativePath || '');
    const start = Number(metadata.start);
    const end = Number(metadata.end);
    const saveMode = metadata.saveMode === 'replace' ? 'replace' : 'new';
    const exportMode = metadata.exportMode === 'fast' ? 'fast' : 'exact';
    if (!workspacePath || !status || !projectName || !relativePath || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('视频裁剪重跑参数无效');
    const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
    const sourceResolution = virtualPaths.resolve(projectRoot, relativePath, { externalRootMode: 'target' });
    const sourcePath = sourceResolution.physicalPath;
    const stat = await fs.promises.stat(sourcePath);
    const extension = path.extname(sourcePath).toLowerCase();
    if (!stat.isFile() || !VIDEO_EXTENSIONS.has(extension)) throw new Error('视频源文件当前不可用');
    const parsed = path.parse(sourcePath);
    const newOutputDirectory = sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'file' ? projectRoot : parsed.dir;
    const generatedPath = saveMode === 'replace'
      ? path.join(parsed.dir, `.photoflow-trim-output-${crypto.randomUUID()}${parsed.ext}`)
      : uniqueDestination(newOutputDirectory, `${parsed.name}_剪辑${parsed.ext}`);
    const cancelDirectory = path.join(app.getPath('temp'), 'photoflow-video-trim');
    const cancelFile = path.join(cancelDirectory, `${interruptedTask.id}.cancel`);
    await fs.promises.mkdir(cancelDirectory, { recursive: true });
    await fs.promises.rm(cancelFile, { force: true });
    const run = () => backgroundTasks.run({
      id: interruptedTask.id,
      type: 'video-trim',
      title: `重新裁剪视频 · ${parsed.base}`,
      cancellable: true,
      resources: [sourcePath],
      capacities: [{ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 }],
      resumePolicy: 'safe-restart',
      metadata: { ...metadata, sourcePath, generatedPath, exportMode },
    }, async task => {
      const requestCancel = () => void fs.promises.writeFile(cancelFile, 'cancel', 'utf8').catch(() => undefined);
      task.signal.addEventListener('abort', requestCancel, { once: true });
      let committed = false;
      try {
        task.report(1, exportMode === 'fast' ? '正在快速导出视频' : '正在重新编码视频');
        const result = await runPythonJsonAction(
          'cut_video.py',
          [sourcePath, '--trim-start', String(start), '--trim-end', String(end), '--output-path', generatedPath, '--trim-mode', exportMode, '--cancel_file', cancelFile],
          60 * 60 * 1000,
          message => {
            if (message?.type !== 'progress') return;
            if (message.phase === 'saving') task.setCancellable(false);
            task.report(Math.max(1, Math.min(98, Number(message.progress) || 0)), String(message.message || (exportMode === 'fast' ? '正在快速导出视频' : '正在重新编码视频')), { phase: String(message.phase || (exportMode === 'fast' ? 'copying' : 'encoding')) });
          },
        );
        if (!result?.success || !fs.existsSync(generatedPath)) throw new Error(result?.error || '视频裁剪重跑失败');
        task.setCancellable(false);
        task.report(99, '正在完成保存', { phase: 'finalizing' });
        const outputRoot = saveMode === 'new' && sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'file'
          ? projectRoot : sourceResolution.viaExternalLink ? sourceResolution.mediaRoot : projectRoot;
        const safeGenerated = assertExistingInside(outputRoot, generatedPath, '视频裁剪输出路径');
        let safeOutput;
        if (saveMode === 'replace') {
          await replaceVideoFileWithRollback({ crypto, fs, path, sourcePath, replacementPath: safeGenerated });
          safeOutput = sourcePath;
        } else safeOutput = safeGenerated;
        committed = true;
        const thumbnailRoot = sourceResolution.viaExternalLink && !(saveMode === 'new' && sourceResolution.externalTargetKind === 'file') ? sourceResolution.mediaRoot : projectRoot;
        void thumbnailService.syncChangedPaths(thumbnailRoot, [safeOutput], mediaRuntimeState.activeMediaCacheConfig).catch(() => undefined);
        const outputRelativePath = saveMode === 'replace' ? sourceResolution.virtualPath
          : sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'folder'
            ? virtualPaths.toVirtualPath(projectRoot, safeOutput, sourceResolution)
            : path.relative(projectRoot, safeOutput).replace(/\\/g, '/');
        sendToApplicationRenderers(mainWindow, 'workspace-files-changed', { root: projectRoot, fileName: outputRelativePath, eventType: saveMode === 'replace' ? 'change' : 'rename' });
        task.report(100, '视频导出完成', { phase: 'complete', result: { outputPath: safeOutput, relativePath: outputRelativePath, duration: end - start, replaced: saveMode === 'replace' } });
        return { outputPath: safeOutput, relativePath: outputRelativePath };
      } finally {
        task.signal.removeEventListener('abort', requestCancel);
        await fs.promises.rm(cancelFile, { force: true }).catch(() => undefined);
        if ((!committed || saveMode === 'replace') && fs.existsSync(generatedPath)) await fs.promises.rm(generatedPath, { force: true }).catch(() => undefined);
      }
    });
    return run();
  };
  backgroundTasks?.registerTypeRestartFactory?.('video-trim', restartVideoTrim, {
    canRestart: task => Boolean(task.metadata?.workspacePath && task.metadata?.projectStatus && task.metadata?.projectName && task.metadata?.sourceRelativePath),
  });

  ipcMain.handle('workspace-trim-video', async (event, workspacePath, status, projectName, relativePath, request = {}) => {
    const requestedOperationId = String(request.operationId || '');
    const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedOperationId)
      ? requestedOperationId
      : crypto.randomUUID();
    let operation = null;
    let taskHandle = null;
    const publish = payload => {
      if (!event.sender.isDestroyed()) event.sender.send('workspace-video-trim-progress', { operationId, ...payload });
      if (taskHandle && !taskHandle.deduplicated && !taskHandle.isFinished()) {
        taskHandle.context.report(payload.progress, payload.message, { phase: payload.phase });
      }
    };
    try {
      if (activeVideoTrimOperations.has(operationId)) throw new Error('该视频导出任务已在运行');
      const projectRoot = path.resolve(getProjectPath(workspacePath, status, projectName));
      const sourceResolution = virtualPaths.resolve(projectRoot, relativePath, { externalRootMode: 'target' });
      const sourcePath = sourceResolution.physicalPath;
      const stat = await fs.promises.stat(sourcePath);
      const extension = path.extname(sourcePath).toLowerCase();
      if (!stat.isFile() || !VIDEO_EXTENSIONS.has(extension)) throw new Error('请选择项目中的视频文件');
      const start = Number(request.start);
      const end = Number(request.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('剪辑时间范围无效');
      const saveMode = request.saveMode === 'replace' ? 'replace' : 'new';
      const exportMode = request.exportMode === 'exact' ? 'exact' : 'fast';
      const parsed = path.parse(sourcePath);
      const sourceRelativePath = sourceResolution.virtualPath;
      const requestedSourceDuration = Number(request.sourceDuration);
      const sourceDuration = Number.isFinite(requestedSourceDuration) && requestedSourceDuration >= end ? requestedSourceDuration : end;
      const newOutputDirectory = sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'file' ? projectRoot : parsed.dir;
      const generatedPath = saveMode === 'replace'
        ? path.join(parsed.dir, `.photoflow-trim-output-${crypto.randomUUID()}${parsed.ext}`)
        : uniqueDestination(newOutputDirectory, `${parsed.name}_剪辑${parsed.ext}`);
      const cancelDirectory = path.join(app.getPath('temp'), 'photoflow-video-trim');
      const cancelFile = path.join(cancelDirectory, `${operationId}.cancel`);
      await fs.promises.mkdir(cancelDirectory, { recursive: true });
      await fs.promises.unlink(cancelFile).catch(() => undefined);
      taskHandle = backgroundTasks.create({
        id: operationId,
        type: 'video-trim',
        title: `${exportMode === 'fast' ? '快速裁剪视频' : '精确裁剪视频'} · ${parsed.base}`,
        cancellable: true,
        resources: [sourcePath],
        capacities: [{ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 }],
        resumePolicy: 'safe-restart',
        metadata: { operationId, workspacePath: path.resolve(workspacePath), projectStatus: status, projectName, sourcePath, sourceRelativePath, generatedPath, saveMode, exportMode, start, end, sourceDuration },
      });
      if (taskHandle.deduplicated) throw new Error('该视频导出任务已在运行');
      operation = { cancelFile, cancelled: false, cancellable: true, taskHandle };
      activeVideoTrimOperations.set(operationId, operation);
      taskHandle.context.signal.addEventListener('abort', () => {
        if (!operation?.cancellable) return;
        operation.cancelled = true;
        void fs.promises.writeFile(cancelFile, 'cancel', 'utf8').catch(() => undefined);
      }, { once: true });
      const runInBackground = async () => {
        try {
          await taskHandle.waitForStart();
          taskHandle.context.throwIfCancelled();
          publish({ phase: 'preparing', progress: 0, message: '正在准备视频…' });
          let safeOutput = '';
          try {
            const result = await runPythonJsonAction(
              'cut_video.py',
              [sourcePath, '--trim-start', String(start), '--trim-end', String(end), '--output-path', generatedPath, '--trim-mode', exportMode, '--cancel_file', cancelFile],
              60 * 60 * 1000,
              message => {
                if (message?.type !== 'progress') return;
                if (message.phase === 'saving') {
                  operation.cancellable = false;
                  taskHandle.context.setCancellable(false);
                }
                publish({
                  phase: String(message.phase || (exportMode === 'fast' ? 'copying' : 'encoding')),
                  progress: Math.max(0, Math.min(99, Number(message.progress) || 0)),
                  message: String(message.message || '正在导出视频…'),
                });
              },
            );
            if (!result?.success || !fs.existsSync(generatedPath)) throw new Error(result?.error || '视频剪辑失败');
            operation.cancellable = false;
            taskHandle.context.setCancellable(false);
            publish({ phase: 'finalizing', progress: 99, message: '正在完成保存…' });
            const outputRoot = saveMode === 'new' && sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'file'
              ? projectRoot : sourceResolution.viaExternalLink ? sourceResolution.mediaRoot : projectRoot;
            const safeGenerated = assertExistingInside(outputRoot, generatedPath, '视频剪辑输出路径');
            if (saveMode === 'replace') {
              const commit = await replaceVideoFileWithRollback({ crypto, fs, path, sourcePath, replacementPath: safeGenerated });
              if (!commit.backupRemoved) writeLog('warn', 'Unable to remove committed video trim backup', { projectName, backupPath: commit.backupPath });
              safeOutput = sourcePath;
            } else safeOutput = safeGenerated;
          } finally {
            if (saveMode === 'replace' && fs.existsSync(generatedPath)) await fs.promises.unlink(generatedPath).catch(() => undefined);
          }
          const thumbnailRoot = sourceResolution.viaExternalLink && !(saveMode === 'new' && sourceResolution.externalTargetKind === 'file')
            ? sourceResolution.mediaRoot : projectRoot;
          void thumbnailService.syncChangedPaths(thumbnailRoot, [safeOutput], mediaRuntimeState.activeMediaCacheConfig).catch(error => {
            writeLog('warn', 'Unable to queue trimmed-video thumbnail', { projectName, error: error.message || String(error) });
          });
          const outputRelativePath = saveMode === 'replace' ? sourceResolution.virtualPath
            : sourceResolution.viaExternalLink && sourceResolution.externalTargetKind === 'folder'
              ? virtualPaths.toVirtualPath(projectRoot, safeOutput, sourceResolution)
              : path.relative(projectRoot, safeOutput).replace(/\\/g, '/');
          sendToApplicationRenderers(mainWindow, 'workspace-files-changed', { root: projectRoot, fileName: outputRelativePath, eventType: saveMode === 'replace' ? 'change' : 'rename' });
          const completedResult = { outputPath: safeOutput, relativePath: outputRelativePath, duration: end - start, replaced: saveMode === 'replace' };
          publish({ phase: 'complete', progress: 100, message: '视频导出完成' });
          taskHandle.context.report(100, '视频导出完成', { phase: 'complete', result: completedResult });
          taskHandle.complete('视频导出完成');
        } catch (error) {
          const cancelled = Boolean(operation?.cancelled || taskHandle?.context.signal.aborted || error?.code === 'TASK_CANCELLED');
          publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, message: cancelled ? '视频导出已取消' : `视频导出失败：${error.message || String(error)}` });
          if (taskHandle && !taskHandle.deduplicated && !taskHandle.isFinished()) {
            if (cancelled) taskHandle.cancelled();
            else taskHandle.fail(error);
          }
          writeLog('warn', 'Video trim failed', { projectName, relativePath, error: error.message || String(error) });
        } finally {
          activeVideoTrimOperations.delete(operationId);
          if (operation?.cancelFile) await fs.promises.unlink(operation.cancelFile).catch(() => undefined);
        }
      };
      return startDetachedBackgroundOperation({
        operationId,
        worker: runInBackground,
        onUnexpectedError: error => writeLog('error', 'Detached video trim worker failed unexpectedly', { projectName, relativePath, error: error.message || String(error) }),
      });
    } catch (error) {
      const cancelled = Boolean(operation?.cancelled || taskHandle?.context.signal.aborted || error?.code === 'TASK_CANCELLED');
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, message: cancelled ? '视频导出已取消' : `视频导出失败：${error.message || String(error)}` });
      if (taskHandle && !taskHandle.deduplicated && !taskHandle.isFinished()) {
        if (cancelled) taskHandle.cancelled();
        else taskHandle.fail(error);
      }
      writeLog('warn', 'Video trim failed', { projectName, relativePath, error: error.message || String(error) });
      return { success: false, operationId, cancelled, error: cancelled ? '视频导出已取消' : error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-cancel-video-trim', async (_event, operationIdValue) => {
    const operationId = String(operationIdValue || '');
    const operation = activeVideoTrimOperations.get(operationId);
    if (!operation || !operation.cancellable) return { success: true, cancelled: false };
    operation.cancelled = true;
    backgroundTasks.cancel(operationId);
    await fs.promises.writeFile(operation.cancelFile, 'cancel', 'utf8');
    return { success: true, cancelled: true };
  });

  ipcMain.handle('workspace-import-files', async (event, workspacePath, status, projectName, relativePath = '', options = {}) => {
    const operationId = crypto.randomUUID();
    let taskNotificationOwned = false;
    let job = { cancelled: false, finishing: false };
    let task = null;
    const publish = payload => task?.publish(payload);
    const moves = [];
    const createdTargets = [];

    let importCleanupRoots = [];
    try {
      const deleteSourceAfterImport = options?.deleteSourceAfterImport === true;
      const preserveOriginal = !deleteSourceAfterImport;
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const destinationResolution = virtualPaths.resolve(projectPath, relativePath, { externalRootMode: 'target' });
      const destinationDir = destinationResolution.physicalPath;
      importCleanupRoots = [projectPath, destinationDir];
      if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error('当前文件夹不存在');
      let sourcePaths = Array.isArray(options?.sourcePaths) ? options.sourcePaths.map(source => String(source)) : [];
      if (!sourcePaths.length) {
        const choice = await dialog.showOpenDialog(mainWindow, localizeDialogOptions({ title: translateNative("native.fe1326e972ce"), properties: ['openFile', 'multiSelections'] }));
        if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0 };
        sourcePaths = choice.filePaths;
      }
      if (sourcePaths.length > 500) throw new Error('一次最多导入 500 个文件');

      const reserved = new Set();
      const sourceInfos = [];
      const transferPlan = [];
      for (const source of sourcePaths) {
        const sourcePath = path.resolve(source);
        const stat = await fs.promises.lstat(sourcePath);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error(`不支持导入此文件类型：${path.basename(sourcePath)}`);
        const destination = uniqueDestination(destinationDir, path.basename(sourcePath), reserved, stat.isDirectory());
        const itemPlan = [];
        await collectCopyPlan(sourcePath, destination, itemPlan, { isCancelled: () => job.cancelled });
        transferPlan.push(...itemPlan);
        sourceInfos.push({
          path: sourcePath,
          stat,
          destination,
          plan: itemPlan,
          size: itemPlan.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0),
          fileCount: itemPlan.filter(entry => entry.kind === 'file').length,
        });
      }
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-files', title: `导入文件 · ${projectName}`,
        projectName, resources: [destinationDir, ...sourceInfos.map(source => source.path)], cancelledCode: CANCELLED_CODE,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeProjectFileOperations.set(operationId, job);
      taskNotificationOwned = true;
      await task.start();
      const totalBytes = sourceInfos.reduce((sum, source) => sum + source.size, 0);
      const totalFiles = sourceInfos.reduce((sum, source) => sum + source.fileCount, 0);
      let completedBytes = 0;
      let completedFiles = 0;
      let lastPublishedAt = 0;
      publish({ phase: 'scanning', progress: 0, bytesCopied: 0, totalBytes, filesCopied: 0, totalFiles });
      const report = currentName => {
        const now = Date.now();
        if (now - lastPublishedAt < 80 && completedBytes < totalBytes) return;
        lastPublishedAt = now;
        publish({ phase: preserveOriginal ? 'copying' : 'moving', progress: totalBytes ? Math.min(99, Math.round(completedBytes / totalBytes * 100)) : 0, currentName, bytesCopied: completedBytes, totalBytes, filesCopied: completedFiles, totalFiles });
      };
      if (preserveOriginal) {
        await assertDiskSpace(destinationDir, totalBytes);
        createdTargets.push(...sourceInfos.map(source => source.destination));
        await copyPlannedFiles(transferPlan, {
          destinationRoot: destinationDir,
          ownershipToken: operationId,
          diskSpaceChecked: true,
          isCancelled: () => job.cancelled,
          onProgress: ({ entry, bytesDelta, fileCompleted }) => {
            completedBytes = Math.min(totalBytes, completedBytes + Math.max(0, bytesDelta || 0));
            if (fileCompleted) completedFiles += 1;
            report(path.basename(entry.source));
          },
        });
      } else {
        for (const sourceInfo of sourceInfos) {
          if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
          let itemBytes = 0;
          let itemFiles = 0;
          await movePathAtomic(sourceInfo.path, sourceInfo.destination, {
            ownershipToken: operationId,
            isCancelled: () => job.cancelled,
            onProgress: progress => {
              const bytesDelta = Number.isFinite(progress?.bytesDelta)
                ? Math.max(0, progress.bytesDelta)
                : Math.max(0, Number(progress?.bytesCopied || 0) - itemBytes);
              itemBytes += bytesDelta;
              completedBytes = Math.min(totalBytes, completedBytes + bytesDelta);
              if (progress?.fileCompleted) {
                itemFiles += 1;
                completedFiles += 1;
              }
              report(path.basename(progress?.entry?.source || sourceInfo.path));
            },
          });
          moves.push({ source: sourceInfo.path, destination: sourceInfo.destination });
          completedBytes = Math.min(totalBytes, completedBytes + Math.max(0, sourceInfo.size - itemBytes));
          completedFiles += Math.max(0, sourceInfo.fileCount - itemFiles);
          report(path.basename(sourceInfo.path));
        }
      }
      job.finishing = true;
      publish({ phase: 'finishing', progress: 99, currentName: '正在完成文件导入', bytesCopied: totalBytes, totalBytes, filesCopied: totalFiles, totalFiles });
      if (preserveOriginal && createdTargets.length) await pushUndoOperation({ kind: 'remove-created', paths: createdTargets, label: '导入' });
      if (!preserveOriginal && moves.length) await pushUndoOperation({ kind: 'external-move', moves });
      writeLog('info', 'Files imported into current project directory', { projectName, relativePath, count: sourcePaths.length, preserveOriginal });
      telemetryService?.track('photos_imported', {
        count_bucket: telemetryService.countBucket(sourcePaths.length),
        source: 'project_files',
        preserve_original: preserveOriginal,
      });
      publish({ phase: 'complete', progress: 100, currentName: '文件导入完成', bytesCopied: totalBytes, totalBytes, filesCopied: totalFiles, totalFiles });
      task.complete('文件导入完成');
      return { success: true, operationId, taskNotificationOwned: true, count: sourcePaths.length };
    } catch (error) {

      const cleanupErrors = [];

      for (const move of [...moves].reverse()) {
        try {
          if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) await movePathAtomic(move.destination, move.source);
        } catch (rollbackError) {
          cleanupErrors.push({ path: move.destination, error: rollbackError.message || String(rollbackError) });
          writeLog('error', 'Unable to roll back project file import', { move, error: rollbackError.message || String(rollbackError) });
        }
      }
      const cleaned = await cleanupImportArtifacts({ fs, targets: createdTargets, cleanupErrors, writeLog, logLabel: 'import', allowedRoots: importCleanupRoots, ownedTargets: createdTargets });

      const cancelled = error?.code === CANCELLED_CODE;
      const leftoverPaths = cleaned.leftoverPaths;
      const recoveryRequired = cleanupErrors.length > 0 || leftoverPaths.length > 0;
      const recoveryMessage = recoveryRequired ? '；部分导入结果已保留，请刷新后处理，勿直接重复导入' : '';
      const failureMessage = `${error.message || String(error)}${recoveryMessage}`;
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, error: failureMessage });
      if (cancelled) task?.cancelled();
      else task?.fail(error);
      if (!cancelled) writeLog('error', 'Project file import failed', error);
      return cancelled
        ? { success: true, cancelled: true, operationId, taskNotificationOwned, count: 0, ...(recoveryRequired ? { recoveryRequired: true, recovery: { operationId, leftoverPaths, cleanupErrors } } : {}) }
        : { success: false, operationId, taskNotificationOwned, error: failureMessage, ...(recoveryRequired ? { recoveryRequired: true, recovery: { operationId, leftoverPaths, cleanupErrors } } : {}) };
    } finally {
      releaseCleanupOwnership(operationId);
      activeProjectFileOperations.delete(operationId);
    }
  });

  ipcMain.handle('workspace-import-progress-files', async (event, workspacePath, status, projectName, folderName, options = {}) => {
    const operationId = crypto.randomUUID();
    let taskNotificationOwned = false;
    let job = { cancelled: false, finishing: false };
    let task = null;
    const publish = payload => task?.publish(payload);
    let createdFolder = '';
    const createdTargets = [];

    let progressCleanupRoots = [];
    const moves = [];
    try {
      const mediaKind = options.mediaKind === 'video' ? 'video' : 'image';
      const deleteSourceAfterImport = options?.deleteSourceAfterImport === true;
      const preserveOriginal = !deleteSourceAfterImport;
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const appendProgressId = String(options.appendProgressId || '');
      const appendProgress = appendProgressId
        ? (await versionService.listProgress(workspaceRoot, projectName)).progressFolders?.find(progress => progress.id === appendProgressId)
        : null;
      if (appendProgressId && (!appendProgress || appendProgress.folderMissing)) throw new Error('要追加的进度文件夹不存在');
      if (appendProgress && (appendProgress.nodeRole !== 'progress' || !appendProgress.parentProgressId || appendProgress.relationKind !== 'main')) throw new Error('只能向已连接有效父版本的普通进度追加文件');
      if (appendProgress && (appendProgress.mediaKind !== mediaKind || appendProgress.versionKey !== String(options.versionKey || ''))) {
        throw new Error('追加目标与所选进度类型或版本号不一致');
      }
      const cleanedName = cleanProjectName(String(appendProgress?.displayName || folderName || ''));
      if (!cleanedName) throw new Error('进度文件夹名称不能为空');
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      const destinationDir = path.resolve(appendProgress ? appendProgress.folderPath : path.join(projectPath, cleanedName));
      progressCleanupRoots = [projectPath, destinationDir];
      assertExistingInside(projectPath, path.dirname(destinationDir), '进度目录', true);
      if (!destinationDir.startsWith(projectPath + path.sep)) throw new Error('无效的进度文件夹名称');

      if (appendProgress ? !fs.existsSync(destinationDir) : fs.existsSync(destinationDir)) {
        throw new Error(appendProgress ? '要追加的进度文件夹不存在' : '同名进度文件夹已存在');
      }
      const extensions = mediaKind === 'video'
        ? [...VIDEO_EXTENSIONS].map(value => value.slice(1))
        : [...new Set([...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS])].map(value => value.slice(1));
      const progressConflictPolicy = ['skip', 'keep-both'].includes(options.progressConflictPolicy) ? options.progressConflictPolicy : '';
      let selectedSourcePaths;
      if (progressConflictPolicy) {
        if (!appendProgress) throw new Error('只能在向已有进度追加文件时处理同名冲突');
        if (!Array.isArray(options.sourcePaths) || !options.sourcePaths.length) throw new Error('同名文件冲突确认已失效，请重新选择文件');
        selectedSourcePaths = options.sourcePaths.map(value => String(value));
      } else if (Array.isArray(options.sourcePaths) && options.sourcePaths.length) {
        selectedSourcePaths = options.sourcePaths.map(value => String(value));
      } else {
        const choice = await dialog.showOpenDialog(mainWindow, localizeDialogOptions({
          title: mediaKind === 'video' ? translateNative("native.ddd8fdb12d26") : translateNative("native.c5885dcc64f5"),
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: mediaKind === 'video' ? translateNative("native.3de55a23c480") : translateNative("native.c3b38d6b6100"), extensions }],
        }));
        if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0 };
        selectedSourcePaths = choice.filePaths;
      }

      const expandedSourcePaths = [];
      const expandSource = async source => {
        const resolved = path.resolve(source);
        const stat = await fs.promises.stat(resolved);
        if (stat.isFile()) { expandedSourcePaths.push(resolved); return; }
        if (!stat.isDirectory()) throw new Error(`不支持的导入来源：${path.basename(resolved)}`);
        const children = await fs.promises.readdir(resolved, { withFileTypes: true });
        for (const child of children) await expandSource(path.join(resolved, child.name));
      };
      for (const source of selectedSourcePaths) await expandSource(source);
      selectedSourcePaths = expandedSourcePaths;
      let sourceInfos = [];
      for (const source of selectedSourcePaths) {
        const sourceInfo = await assertRegularFile(source);
        const extension = path.extname(sourceInfo.path).toLowerCase();
        const supported = mediaKind === 'video' ? VIDEO_EXTENSIONS.has(extension) : IMAGE_EXTENSIONS.has(extension) || RAW_EXTENSIONS.has(extension);
        if (!supported) throw new Error(`所选文件不属于${mediaKind === 'video' ? '视频' : '图片'}进度：${path.basename(sourceInfo.path)}`);
        sourceInfos.push(sourceInfo);
      }
      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-progress', title: `导入版本进度 · ${projectName}`,
        projectName, resources: [destinationDir, ...sourceInfos.map(source => source.path)], cancelledCode: CANCELLED_CODE, emitLegacyProgress: true,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeProjectFileOperations.set(operationId, job);
      taskNotificationOwned = true;
      await task.start();
      let totalBytes = sourceInfos.reduce((sum, source) => sum + source.stat.size, 0);
      publish({ phase: 'scanning', progress: 0, currentName: '正在检查重复文件', bytesCopied: 0, totalBytes, filesCopied: 0, totalFiles: sourceInfos.length });
      let skippedCount = 0;
      const skippedNames = [];
      if (appendProgress) {
        const digestFile = filePath => new Promise((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          const stream = fs.createReadStream(filePath);
          stream.on('data', chunk => {
            if (job.cancelled) {
              stream.destroy(Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE }));
              return;
            }
            hash.update(chunk);
          });
          stream.on('error', reject);
          stream.on('end', () => resolve(hash.digest('hex')));
        });
        const collisionRecords = [];
        for (const sourceInfo of sourceInfos) {
          if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
          const existingPath = path.join(destinationDir, path.basename(sourceInfo.path));
          if (!fs.existsSync(existingPath) || !fs.statSync(existingPath).isFile()) continue;
          const [sourceStat, existingStat] = await Promise.all([fs.promises.stat(sourceInfo.path), fs.promises.stat(existingPath)]);
          collisionRecords.push({ sourcePath: sourceInfo.path, existingPath, sourceStat, existingStat });
        }
        const conflictCacheKey = crypto.createHash('sha256').update(JSON.stringify({
          destinationDir,
          files: collisionRecords.map(record => ({
            sourcePath: record.sourcePath,
            sourceSize: record.sourceStat.size,
            sourceMtimeMs: record.sourceStat.mtimeMs,
            existingPath: record.existingPath,
            existingSize: record.existingStat.size,
            existingMtimeMs: record.existingStat.mtimeMs,
          })),
        })).digest('hex');
        pruneProgressImportConflictCache();
        const cachedConflicts = progressImportConflictCache.get(conflictCacheKey);
        const exactDuplicates = new Set(cachedConflicts?.exactDuplicates || []);
        const conflicts = [...(cachedConflicts?.conflicts || [])];
        if (!cachedConflicts) {
          for (const record of collisionRecords) {
            if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
            const identical = record.sourceStat.size === record.existingStat.size
              && await digestFile(record.sourcePath) === await digestFile(record.existingPath);
            if (identical) exactDuplicates.add(record.sourcePath);
            else conflicts.push(record.sourcePath);
          }
          progressImportConflictCache.set(conflictCacheKey, {
            exactDuplicates: [...exactDuplicates],
            conflicts: [...conflicts],
            expiresAt: Date.now() + 10 * 60 * 1000,
          });
        }
        const keepConflicts = progressConflictPolicy === 'keep-both';
        if (conflicts.length) {
          if (!progressConflictPolicy) {
            const conflictNames = conflicts.slice(0, 6).map(filePath => path.basename(filePath));
            const more = conflicts.length > conflictNames.length ? `等 ${conflicts.length} 个文件` : conflictNames.map(name => `“${name}”`).join('、');
            publish({ phase: 'complete', progress: 100, currentName: '等待处理同名文件', count: 0, decisionRequired: true });
            task.complete('等待用户处理同名文件');
            return {
              success: true,
              operationId,
              count: 0,
              requiresDecision: {
                kind: 'progress-import-conflict',
                names: conflictNames,
                conflictCount: conflicts.length,
                sourcePaths: selectedSourcePaths,
                message: `追加进度时发现 ${more}与现有文件同名，但内容不同。`,
                detail: '可以跳过这些文件，或者保留两份并为新文件自动添加编号。现有进度文件不会被覆盖。',
              },
            };
          }
        }
        const skippedPaths = new Set([...exactDuplicates, ...(keepConflicts ? [] : conflicts)]);
        skippedCount = skippedPaths.size;
        skippedNames.push(...[...skippedPaths].map(filePath => path.basename(filePath)));
        sourceInfos = sourceInfos.filter(sourceInfo => !skippedPaths.has(sourceInfo.path));
      }
      if (!appendProgress) {
        await fs.promises.mkdir(destinationDir);
        createdFolder = destinationDir;
      }
      totalBytes = sourceInfos.reduce((sum, source) => sum + source.stat.size, 0);
      let completedBytes = 0;
      let completedFiles = 0;
      let lastPublishedAt = 0;
      publish({ phase: 'scanning', progress: 0, bytesCopied: 0, totalBytes, filesCopied: 0, totalFiles: sourceInfos.length });
      const report = (sourceInfo, itemBytes) => {
        const now = Date.now();
        if (now - lastPublishedAt < 80 && itemBytes < sourceInfo.stat.size) return;
        lastPublishedAt = now;
        const bytesCopied = Math.min(totalBytes, completedBytes + itemBytes);
        publish({ phase: preserveOriginal ? 'copying' : 'moving', progress: totalBytes ? Math.min(99, Math.round(bytesCopied / totalBytes * 100)) : 0, currentName: path.basename(sourceInfo.path), bytesCopied, totalBytes, filesCopied: completedFiles, totalFiles: sourceInfos.length });
      };
      const reserved = new Set();
      for (const sourceInfo of sourceInfos) {
        if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
        const destination = uniqueDestination(destinationDir, path.basename(sourceInfo.path), reserved);
        if (preserveOriginal) {
          await copyFileAtomic(sourceInfo.path, destination, { ownershipToken: operationId, isCancelled: () => job.cancelled, onProgress: progress => report(sourceInfo, progress.bytesCopied) });
          createdTargets.push(destination);
        } else {
          await moveFileAtomic(sourceInfo.path, destination, { ownershipToken: operationId, isCancelled: () => job.cancelled, onProgress: progress => report(sourceInfo, progress.bytesCopied) });
          moves.push({ source: sourceInfo.path, destination });
        }
        completedBytes += sourceInfo.stat.size;
        completedFiles += 1;
        report(sourceInfo, sourceInfo.stat.size);
      }
      job.finishing = true;
      publish({ phase: 'finishing', progress: 99, currentName: '正在登记版本进度', bytesCopied: totalBytes, totalBytes, filesCopied: sourceInfos.length, totalFiles: sourceInfos.length });
      const registered = appendProgress ? await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind: appendProgress.mediaKind,
        versionKey: appendProgress.versionKey,
        parentProgressId: appendProgress.parentProgressId,
        displayName: appendProgress.displayName,
        folderPath: appendProgress.folderPath,
        trackingEnabled: false,
        trackingState: options.trackingState || appendProgress.trackingState,
        progressId: appendProgress.id,
      }) : await versionService.registerProgress(workspaceRoot, {
        projectName,
        mediaKind,
        versionKey: options.versionKey,
        parentProgressId: options.parentProgressId,
        displayName: cleanedName,
        folderPath: destinationDir,
        trackingEnabled: Boolean(options.trackingEnabled),
        trackingState: options.trackingState,
      });
      if (preserveOriginal && (appendProgress ? createdTargets.length : true)) await pushUndoOperation({ kind: 'remove-created', paths: appendProgress ? createdTargets : [destinationDir], label: appendProgress ? '追加版本进度' : '导入版本进度' });
      else if (moves.length) await pushUndoOperation({ kind: 'external-move', moves });
      writeLog('info', appendProgress ? 'Files appended to progress version' : 'Progress version files imported', { projectName, folderName: cleanedName, mediaKind, count: sourceInfos.length, skippedCount, preserveOriginal });
      telemetryService?.track('photos_imported', {
        count_bucket: telemetryService.countBucket(sourceInfos.length),
        source: appendProgress ? 'progress_version_append' : 'progress_version',
        media_kind: mediaKind,
        preserve_original: preserveOriginal,
      });
      publish({ phase: 'complete', progress: 100, currentName: '版本进度导入完成', bytesCopied: totalBytes, totalBytes, filesCopied: sourceInfos.length, totalFiles: sourceInfos.length });
      task.complete('版本进度导入完成');
      return {
        success: true,
        operationId,
        taskNotificationOwned: true,
        count: sourceInfos.length,
        skippedCount,
        skippedNames,
        appended: Boolean(appendProgress),
        importedPaths: [...createdTargets, ...moves.map(move => move.destination)],
        progressFolder: registered.progressFolder,
        folder: { name: cleanedName, path: destinationDir, relativePath: path.relative(projectPath, destinationDir).replace(/\\/g, '/'), updatedAt: Date.now() },
      };
    } catch (error) {
      const cleanupErrors = [];

      for (const move of [...moves].reverse()) {
        try {
          if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) {
            await moveFileAtomic(move.destination, move.source);
          }
        } catch (rollbackError) {
          cleanupErrors.push({ path: move.destination, error: rollbackError.message || String(rollbackError) });
          writeLog('error', 'Unable to roll back progress import move', { move, error: rollbackError.message || String(rollbackError) });
        }
      }
      const ownedTargets = [...createdTargets, createdFolder].filter(Boolean);
      const cleaned = await cleanupImportArtifacts({ fs, targets: ownedTargets, cleanupErrors, writeLog, logLabel: 'progress import', allowedRoots: progressCleanupRoots, ownedTargets });

      const cancelled = error?.code === CANCELLED_CODE;
      const leftoverPaths = cleaned.leftoverPaths;
      const recoveryRequired = cleanupErrors.length > 0 || leftoverPaths.length > 0;
      const failureMessage = `${error.message || String(error)}${recoveryRequired ? '；部分导入结果已保留，请刷新后处理，勿直接重复导入' : ''}`;
      publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, error: failureMessage });
      if (cancelled) task?.cancelled();
      else task?.fail(error);
      if (!cancelled) writeLog('error', 'Progress version import failed', { projectName, folderName, error: error.message || String(error) });
      const recovery = recoveryRequired ? { recoveryRequired: true, recovery: { operationId, leftoverPaths, cleanupErrors } } : {};
      return cancelled ? { success: true, cancelled: true, operationId, taskNotificationOwned, count: 0, ...recovery } : { success: false, operationId, taskNotificationOwned, error: failureMessage, ...recovery };
    } finally {
      releaseCleanupOwnership(operationId);
      activeProjectFileOperations.delete(operationId);
    }
  });
};

module.exports = { registerWorkspaceImportIpc };
