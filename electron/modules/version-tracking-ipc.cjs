const registerVersionTrackingIpc = context => {
  const { backgroundTasks, crypto, ensureWorkspace, fs, getWorkspaceDataRoot = root => root, ipcMain, path, refreshWorkspaceCatalog, runPythonEventAction, scheduleMediaTrackingScan, trackingScanService, versionService, workspaceCatalogs, writeLog: unsafeWriteLog = () => undefined } = context;
  const writeLog = (...args) => {
    try {
      const pending = unsafeWriteLog(...args);
      pending?.catch?.(() => undefined);
    } catch {}
  };
  const trackingCommitJobs = new Map();
  const trackingLaunchJobs = new Map();
  const trackingCompareSessions = new Map();
  const trackingSessionOperations = new Map();
  const acquireTrackingSessionOperation = (key, type) => {
    const token = Symbol(type);
    trackingSessionOperations.set(key, { type, token });
    return token;
  };
  const releaseTrackingSessionOperation = (key, token) => {
    if (trackingSessionOperations.get(key)?.token !== token) return false;
    trackingSessionOperations.delete(key);
    return true;
  };
  const platformKey = value => process.platform === 'win32' ? String(value).toLowerCase() : String(value);
  const trackingSessionKey = (workspaceRoot, sessionId) => `${platformKey(path.resolve(workspaceRoot))}\0${String(sessionId).toLowerCase()}`;
  const trackingLaunchKey = (workspaceRoot, projectName, progressId, mode, restartTask = null) => {
    const identity = restartTask
      ? `restart:${String(restartTask.id || '')}:${String(restartTask.metadata?.sessionId || '').toLowerCase()}`
      : 'start';
    return `${platformKey(path.resolve(workspaceRoot))}\0${platformKey(projectName)}\0${String(progressId).toLowerCase()}\0${mode}\0${identity}`;
  };
  const singleFlight = (jobs, key, worker) => {
    const running = jobs.get(key);
    if (running) return running;
    // Deferring the worker by one microtask guarantees that the map owns the
    // key before the first repository/background-task await can yield.
    const job = Promise.resolve().then(worker);
    jobs.set(key, job);
    void job.finally(() => { if (jobs.get(key) === job) jobs.delete(key); }).catch(() => undefined);
    return job;
  };
  const requireStageSuccess = (result, message) => {
    if (!result || result.success === false) throw new Error(result?.error || message);
    return result;
  };
  const releaseTrackingSessionExclusive = async (workspaceRoot, sessionId) => {
    const key = trackingSessionKey(workspaceRoot, sessionId);
    if (trackingCommitJobs.has(key) || trackingCompareSessions.has(key) || trackingSessionOperations.has(key)) {
      throw new Error('跟踪结果正在提交、确认或比较，暂时不能放弃会话');
    }
    const operationToken = acquireTrackingSessionOperation(key, 'release');
    try {
      return await versionService.releaseTrackingSession(workspaceRoot, sessionId);
    } finally {
      releaseTrackingSessionOperation(key, operationToken);
    }
  };
  const trackingPreviewItems = (prepared, preview = {}) => {
    const pendingSources = new Set((prepared.sourceNames || []).map(String));
    const items = [];
    const historicalSources = new Set();
    for (const match of Array.isArray(prepared.historicalMatches) ? prepared.historicalMatches : []) {
      const sourceName = String(match?.sourceName || '');
      const referenceName = String(match?.referenceName || '');
      if (!sourceName || !referenceName || historicalSources.has(sourceName)) continue;
      historicalSources.add(sourceName);
      items.push({
        kind: 'recognized', status: 'recognized', sourceName, referenceName,
        targetName: String(match?.targetName || sourceName), distance: 0, confidence: '既有关联',
      });
    }
    const append = item => {
      const sourceName = item.sourceName ? String(item.sourceName) : undefined;
      if (sourceName && !pendingSources.has(sourceName)) return;
      if (sourceName) pendingSources.delete(sourceName);
      items.push(item);
    };
    for (const match of Array.isArray(preview.matches) ? preview.matches : []) append({
      kind: 'recognized', status: 'recognized', sourceName: match.source,
      referenceName: match.reference, targetName: match.target || match.source,
      distance: Number(match.distance) || 0, confidence: String(match.confidence || ''),
    });
    for (const suggestion of Array.isArray(preview.suggestions) ? preview.suggestions : []) append({
      kind: 'new', status: 'pending_confirmation', sourceName: suggestion.source,
      referenceName: suggestion.reference, targetName: suggestion.target || suggestion.source,
      distance: Number(suggestion.distance) || 0, confidence: String(suggestion.confidence || ''),
    });
    for (const sourceName of Array.isArray(preview.unmatched) ? preview.unmatched : []) append({
      kind: 'new', status: 'pending_confirmation', sourceName: String(sourceName), targetName: String(sourceName),
      confidence: '未匹配',
    });
    for (const sourceName of pendingSources) items.push({
      kind: 'new', status: 'pending_confirmation', sourceName, targetName: sourceName, confidence: '新增或变化',
    });
    for (const referenceName of prepared.copyCandidateNames || []) items.push({
      kind: 'copy_missing', status: 'pending_confirmation', referenceName: String(referenceName),
      targetName: String(referenceName), confidence: '父版本新增',
    });
    for (const sourceName of prepared.removedNames || []) items.push({
      kind: 'missing', status: 'missing_reference', sourceName: String(sourceName), confidence: '当前版本已缺失',
    });
    return items;
  };

  const executeTrackingCompare = async (workspaceRoot, prepared, task) => {
    task?.throwIfCancelled?.();
    const totalCount = (prepared.sourceNames?.length || 0) + (prepared.historicalMatches?.length || 0)
      + (prepared.copyCandidateNames?.length || 0) + (prepared.removedNames?.length || 0);
    task?.report(0, '正在读取版本媒体', {
      sessionId: prepared.sessionId, progressId: prepared.progressId,
      processedCount: 0, totalCount,
    });
    writeLog('info', 'Version tracking compare started', {
      sessionId: prepared.sessionId, progressId: prepared.progressId, mode: prepared.mode,
      parentFolderPath: prepared.parentFolderPath, progressFolderPath: prepared.progressFolderPath,
      sourceCount: prepared.sourceNames?.length || 0, removedCount: prepared.removedNames?.length || 0,
      historicalMatchCount: prepared.historicalMatches?.length || 0,
      copyCandidateCount: prepared.copyCandidateNames?.length || 0,
    });
    let preview = { matches: [], suggestions: [], unmatched: [], unmatchedReference: [] };
    if (prepared.sourceNames?.length) {
      const trackingDataDirectory = path.join(getWorkspaceDataRoot(workspaceRoot), 'version-tracking');
      const sourceManifestPath = path.join(trackingDataDirectory, `${prepared.sessionId}-sources.json`);
      await fs.promises.mkdir(trackingDataDirectory, { recursive: true });
      await fs.promises.writeFile(sourceManifestPath, JSON.stringify(prepared.sourceNames), 'utf8');
      const onWorkerEvent = event => {
        if (event.type === 'progress' && Number.isFinite(event.progress)) {
          const workerProgress = Math.max(0, Math.min(100, Number(event.progress)));
          task?.report(workerProgress * 0.8, event.message || '正在比较版本媒体', {
            sessionId: prepared.sessionId, progressId: prepared.progressId,
            processedCount: totalCount > 0 ? Math.min(totalCount, Math.round(totalCount * workerProgress / 100)) : 0,
            totalCount,
          });
        } else if (event.type === 'log' || event.type === 'warning') {
          writeLog(event.type === 'warning' ? 'warn' : 'info', 'Version tracking worker event', {
            sessionId: prepared.sessionId, progressId: prepared.progressId, message: event.message || '',
          });
        }
      };
      let events;
      try {
        events = await runPythonEventAction('rename.py', [
          '--folder_a', prepared.parentFolderPath,
          '--folder_b', prepared.progressFolderPath,
          '--preview', '--source_files_file', sourceManifestPath,
        ], 60 * 60 * 1000, task?.signal, onWorkerEvent);
      } finally {
        await fs.promises.rm(sourceManifestPath, { force: true }).catch(() => undefined);
      }
      task?.throwIfCancelled();
      const previewEvent = events.find(event => event.type === 'preview');
      if (!previewEvent) throw new Error('版本对比没有返回匹配结果');
      preview = previewEvent.data || preview;
    }
    task?.throwIfCancelled?.();
    task?.report(80, '正在保存待确认结果');
    const stored = await versionService.storeTrackingPreview(workspaceRoot, {
      sessionId: prepared.sessionId,
      items: trackingPreviewItems(prepared, preview),
    });
    requireStageSuccess(stored, '无法保存版本跟踪待确认结果');
    task?.report(95, '正在保存待确认结果', {
      sessionId: prepared.sessionId, progressId: prepared.progressId,
      processedCount: totalCount, totalCount,
    });
    task?.report(100, '等待确认跟踪图片');
    writeLog('info', 'Version tracking compare completed', {
      sessionId: prepared.sessionId, progressId: prepared.progressId, totalCount,
      itemCount: Array.isArray(stored?.items) ? stored.items.length : undefined,
    });
    return stored;
  };

  const launchTracking = ({ workspaceRoot, projectName, progressId, mode, restartTask = null }) => singleFlight(
    trackingLaunchJobs,
    trackingLaunchKey(workspaceRoot, projectName, progressId, mode, restartTask),
    async () => {
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const previousSessionId = String(restartTask?.metadata?.sessionId || '');
      if (previousSessionId) requireStageSuccess(
        await releaseTrackingSessionExclusive(workspaceRoot, previousSessionId),
        '无法释放中断的版本跟踪会话',
      );
      let created = requireStageSuccess(
        await versionService.createTrackingSession(workspaceRoot, { projectName, progressId, mode }),
        '无法创建版本跟踪会话',
      );
      if (!restartTask && created.reused) {
        const sessionKey = trackingSessionKey(workspaceRoot, created.sessionId);
        const activeTask = backgroundTasks?.list?.().find(task => task.type === 'version-tracking'
          && task.metadata?.sessionId === created.sessionId
          && (task.state === 'queued' || task.state === 'running'));
        const sessionOperation = trackingSessionOperations.get(sessionKey);
        if (trackingCommitJobs.has(sessionKey) || sessionOperation && sessionOperation.type !== 'compare') {
          throw new Error('版本跟踪会话正在执行其他操作，暂时不能恢复');
        }
        if (activeTask) return {
          task: activeTask,
          result: { sessionId: created.sessionId, progressId: created.progressId },
          response: { success: true, taskId: activeTask.id, sessionId: created.sessionId, sessionStatus: created.sessionStatus, resumed: true },
        };
        if (trackingCompareSessions.has(sessionKey) || sessionOperation) {
          throw new Error('版本跟踪会话正在执行其他操作，暂时不能恢复');
        }
        if (created.sessionStatus === 'pending_confirm' || created.sessionStatus === 'committing' || created.sessionStatus === 'failed') {
          return {
            task: null,
            result: { sessionId: created.sessionId, progressId: created.progressId },
            response: { success: true, sessionId: created.sessionId, sessionStatus: created.sessionStatus, resumed: true },
          };
        }
        requireStageSuccess(await releaseTrackingSessionExclusive(workspaceRoot, created.sessionId), '无法释放孤立的版本跟踪会话');
        created = requireStageSuccess(
          await versionService.createTrackingSession(workspaceRoot, { projectName, progressId, mode }),
          '无法重新创建版本跟踪会话',
        );
      }
      const taskId = restartTask?.id || crypto.randomUUID();
      const handle = backgroundTasks?.create?.({
        id: taskId,
        type: 'version-tracking',
        title: mode === 'refresh' ? '刷新版本跟踪' : '比较版本跟踪',
        message: restartTask ? '正在重新开始版本比较' : '等待其他文件操作完成，之后自动开始版本比较',
        runningMessage: '正在准备版本比较',
        cancellable: true,
        resources: [
          { path: created.parentFolderPath, access: 'read' },
          { path: created.progressFolderPath, access: 'read' },
        ],
        concurrencyGroup: 'disk-io',
        concurrencyLimit: 3,
        concurrencyWriteLimit: 2,
        resourceAccess: 'read',
        dedupeKey: `version-tracking:${platformKey(path.resolve(workspaceRoot))}:${progressId}`,
        metadata: {
          workspaceRoot, projectName, mode, sessionId: created.sessionId, progressId: created.progressId,
          processedCount: 0, totalCount: 0,
        },
      }) || {
        task: { id: taskId, metadata: { sessionId: created.sessionId, progressId: created.progressId } },
        context: undefined,
        waitForStart: async () => undefined,
        complete: () => undefined,
        fail: () => undefined,
        cancelled: () => undefined,
      };
      if (handle.deduplicated) {
        const activeSessionId = String(handle.task?.metadata?.sessionId || '');
        if (!activeSessionId) {
          requireStageSuccess(await versionService.releaseTrackingSession(workspaceRoot, created.sessionId), '无法释放未启动的重复版本跟踪会话');
          throw new Error('重复的版本跟踪任务缺少会话标识，已安全取消本次启动');
        }
        if (activeSessionId !== created.sessionId) {
          requireStageSuccess(await versionService.releaseTrackingSession(workspaceRoot, created.sessionId), '无法释放重复的版本跟踪会话');
        }
        const sessionId = activeSessionId;
        return {
          task: handle.task,
          result: { sessionId, progressId: handle.task?.metadata?.progressId || created.progressId },
          response: { success: true, taskId: handle.task?.id, sessionId, sessionStatus: 'comparing', resumed: true },
        };
      }
      const compareSessionKey = trackingSessionKey(workspaceRoot, created.sessionId);
      const compareOperationToken = acquireTrackingSessionOperation(compareSessionKey, 'compare');
      trackingCompareSessions.set(compareSessionKey, compareOperationToken);
      setTimeout(() => void (async () => {
        try {
          await handle.waitForStart();
          const prepared = requireStageSuccess(await trackingScanService.prepareTracking(workspaceRoot, {
            projectName, progressId, mode, sessionId: created.sessionId,
          }), '无法准备版本跟踪比较');
          await executeTrackingCompare(workspaceRoot, prepared, handle.context);
          handle.complete('等待确认跟踪图片');
        } catch (error) {
          if (handle?.context?.signal?.aborted || error?.code === 'TASK_CANCELLED') {
            await versionService.releaseTrackingSession(workspaceRoot, created.sessionId).catch(() => undefined);
            handle.cancelled();
          } else {
            writeLog('error', 'Version tracking compare failed', {
              projectName, progressId, sessionId: created.sessionId,
              error: error?.message || String(error), stack: error?.stack,
            });
            await versionService.failTrackingCommit(workspaceRoot, { sessionId: created.sessionId, error: error?.message || String(error) }).catch(() => undefined);
            handle.fail(error);
          }
        } finally {
          if (trackingCompareSessions.get(compareSessionKey) === compareOperationToken) trackingCompareSessions.delete(compareSessionKey);
          releaseTrackingSessionOperation(compareSessionKey, compareOperationToken);
        }
      })(), 0);
      return {
        task: handle.task,
        result: { sessionId: created.sessionId, progressId: created.progressId },
        response: { success: true, taskId, sessionId: created.sessionId, sessionStatus: 'comparing', resumed: false },
      };
    },
  );

  const restartTrackingTask = async interruptedTask => {
    const workspaceRoot = ensureWorkspace(interruptedTask.metadata?.workspaceRoot);
    const projectName = String(interruptedTask.metadata?.projectName || '');
    const progressId = String(interruptedTask.metadata?.progressId || '');
    const mode = interruptedTask.metadata?.mode === 'refresh' ? 'refresh' : 'compare';
    if (!projectName || !/^[0-9a-z-]{8,128}$/i.test(progressId)) throw new Error('版本跟踪重跑参数无效');
    const launched = await launchTracking({ workspaceRoot, projectName, progressId, mode, restartTask: interruptedTask });
    return { task: launched.task, result: launched.result };
  };
  backgroundTasks?.registerTypeRestartFactory?.('version-tracking', restartTrackingTask, {
    canRestart: task => Boolean(task.metadata?.workspaceRoot && task.metadata?.projectName && task.metadata?.progressId),
  });

  ipcMain.handle('workspace-progress-tracking-start', async (_event, workspacePath, projectName, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const progressId = String(request.progressId || '');
      const mode = request.mode === 'refresh' ? 'refresh' : 'compare';
      if (!String(projectName || '').trim() || !/^[0-9a-z-]{8,128}$/i.test(progressId)) throw new Error('progressId 无效');
      const launched = await launchTracking({ workspaceRoot, projectName: String(projectName), progressId, mode });
      return launched.response;
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-session', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sessionId = String(request.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('sessionId 无效');
      const cursor = request.cursor == null || request.cursor === '' ? 0 : Number(request.cursor);
      const limit = request.limit == null || request.limit === '' ? 100 : Number(request.limit);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new Error('跟踪会话分页参数无效');
      }
      return await versionService.getTrackingSession(workspaceRoot, {
        sessionId, cursor, limit,
      });
    } catch (error) {
      return { success: false, items: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-session-release', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sessionId = String(request.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('sessionId 无效');
      return await releaseTrackingSessionExclusive(workspaceRoot, sessionId);
    } catch (error) {
      return { success: false, released: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('workspace-progress-tracking-decide', async (_event, workspacePath, request = {}) => {
    let operationKey;
    let operationToken;
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sessionId = String(request.sessionId || '');
      const itemId = String(request.itemId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !/^[0-9a-f-]{36}$/i.test(itemId)) throw new Error('跟踪确认标识无效');
      if (request.status !== 'accepted' && request.status !== 'rejected') throw new Error('确认结果只能是 accepted 或 rejected');
      if (request.referenceName) {
        const referenceName = String(request.referenceName || '');
        if (!referenceName || path.basename(referenceName) !== referenceName || /[\x00-\x1f]/.test(referenceName)) throw new Error('上一版本文件名无效');
      }
      operationKey = trackingSessionKey(workspaceRoot, sessionId);
      if (trackingCommitJobs.has(operationKey) || trackingCompareSessions.has(operationKey) || trackingSessionOperations.has(operationKey)) {
        throw new Error('版本跟踪会话正在执行其他操作，暂时不能确认');
      }
      operationToken = acquireTrackingSessionOperation(operationKey, 'decide');
      return await versionService.decideTrackingItem(workspaceRoot, {
        sessionId, itemId,
        status: request.status,
        ...(request.referenceName ? { referenceName: String(request.referenceName) } : {}),
      });
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    } finally {
      if (operationKey && operationToken) releaseTrackingSessionOperation(operationKey, operationToken);
    }
  });

  const runTrackingCommit = async (workspaceRoot, sessionId) => {
    let committedBatchId;
    try {
      const plan = await versionService.getTrackingCommitPlan(workspaceRoot, sessionId);
      if (plan?.success === false && plan.staleSnapshot) return plan;
      requireStageSuccess(plan, '无法读取版本跟踪提交计划');
      if (plan.alreadyCommitted) return requireStageSuccess(
        await versionService.getTrackingSession(workspaceRoot, { sessionId, cursor: 0, limit: 200 }),
        '无法读取已提交的版本跟踪会话',
      );
      if (plan.repairBatchId) {
        const repaired = await versionService.retryBatchOperations(workspaceRoot, plan.repairBatchId);
        requireStageSuccess(repaired, '版本批次修复失败');
        if (repaired.repairRequired) throw Object.assign(new Error('文件操作仍需修复后重试'), { batchId: plan.repairBatchId });
        return requireStageSuccess(
          await trackingScanService.completeTrackingCommit(workspaceRoot, { sessionId, batchId: plan.repairBatchId }),
          '无法完成版本跟踪提交',
        );
      }
      let copiedNames = [];
      if (plan.copyMissingFromParent && (plan.copyReferences || []).length) {
        const copyResult = await versionService.applyTrackingCopies(workspaceRoot, sessionId);
        copiedNames = copyResult?.copiedNames || [];
        if (!copyResult || copyResult.success === false || copyResult.repairRequired) {
          throw Object.assign(new Error(copyResult?.copyErrors?.[0]?.error || copyResult?.error || '补齐文件需要修复后重试'), {
            copyRepairRequired: true,
          });
        }
      }
      if (!(plan.matches || []).length && !(plan.incrementalSources || []).length && !copiedNames.length) {
        return requireStageSuccess(await trackingScanService.completeTrackingCommit(workspaceRoot, { sessionId }), '无法完成版本跟踪提交');
      }
      const result = await versionService.commitBatchCompare(workspaceRoot, {
        projectName: plan.projectName,
        folderA: plan.parentFolderPath,
        folderB: plan.progressFolderPath,
        importKey: `tracking:${sessionId}`,
        displayName: plan.displayName,
        renameSources: plan.renameFromParent,
        reconcileExisting: plan.mode === 'refresh',
        incrementalSources: [...new Set([...(plan.incrementalSources || []), ...copiedNames])],
        matches: [...(plan.matches || []), ...copiedNames.map(name => ({ reference: name, source: name, target: name, distance: 0, confidence: '复制补齐' }))],
      });
      committedBatchId = result?.batch?.id;
      if (result?.repairRequired) {
        await versionService.failTrackingCommit(workspaceRoot, {
          sessionId, batchId: result.batch?.id, error: '文件操作需要修复后重试',
        });
        return { ...result, success: false, sessionId, retryable: true, items: [] };
      }
      requireStageSuccess(result, '版本跟踪批次提交失败');
      const completed = await trackingScanService.completeTrackingCommit(workspaceRoot, { sessionId, batchId: result.batch?.id });
      requireStageSuccess(completed, '无法完成版本跟踪提交');
      scheduleMediaTrackingScan?.(workspaceRoot, plan.projectName, [], true);
      return { ...completed, batch: result.batch, renamedCount: result.renamedCount || 0 };
    } catch (error) {
      if (workspaceRoot && sessionId) await versionService.failTrackingCommit(workspaceRoot, {
        sessionId, batchId: error.batchId || committedBatchId, error: error.message || String(error),
      }).catch(() => undefined);
      return { success: false, sessionId, retryable: true, items: [], error: error.message || String(error) };
    }
  };

  ipcMain.handle('workspace-progress-tracking-commit', async (_event, workspacePath, request = {}) => {
    let taskNotificationOwned = false;
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sessionId = String(request.sessionId || '');
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('sessionId 无效');
      const key = trackingSessionKey(workspaceRoot, sessionId);
      const running = trackingCommitJobs.get(key);
      if (running) return await running;
      if (trackingCompareSessions.has(key) || trackingSessionOperations.has(key)) {
        return { success: false, sessionId, retryable: true, items: [], taskNotificationOwned: false, error: '版本跟踪会话正在执行其他操作，暂时不能提交' };
      }
      const operationToken = acquireTrackingSessionOperation(key, 'commit');
      const job = Promise.resolve().then(async () => {
        const resources = versionService.getTrackingCommitResources
          ? requireStageSuccess(await versionService.getTrackingCommitResources(workspaceRoot, sessionId), '无法读取版本跟踪资源')
          : { parentFolderPath: '', progressFolderPath: '' };
        const execute = async () => {
          const result = await runTrackingCommit(workspaceRoot, sessionId);
          if (!result?.success) {
            const error = new Error(result?.error || '版本跟踪提交失败');
            error.trackingResult = result;
            throw error;
          }
          return result;
        };
        if (backgroundTasks?.run) {
          const executionPromise = backgroundTasks.run({
            type: 'version-tracking-commit',
            title: '提交版本跟踪',
            message: '等待其他文件操作完成',
            runningMessage: '正在提交版本跟踪',
            notificationPolicy: 'progress-toast',
            cancellable: false,
            resources: [
              ...[resources.parentFolderPath, resources.progressFolderPath].filter(Boolean).map(resourcePath => ({ path: resourcePath, access: 'write' })),
              { path: `photoflow-workspace-database/${workspaceRoot}`, access: 'write' },
            ],
            concurrencyGroup: 'disk-io',
            concurrencyLimit: 3,
            concurrencyWriteLimit: 2,
            resourceAccess: 'write',
            dedupeKey: `version-tracking-commit:${platformKey(path.resolve(workspaceRoot))}:${sessionId}`,
            metadata: { workspaceRoot, sessionId },
          }, execute);
          taskNotificationOwned = true;
          try {
            const execution = await executionPromise;
            return { ...(execution.result || { success: false, sessionId, error: '版本跟踪提交没有返回结果' }), taskNotificationOwned: true };
          } catch (error) {
            return { ...(error.trackingResult || { success: false, sessionId, retryable: true, items: [], error: error.message || String(error) }), taskNotificationOwned: true };
          }
        }
        return { ...(await execute()), taskNotificationOwned: false };
      });
      trackingCommitJobs.set(key, job);
      try {
        return await job;
      } finally {
        if (trackingCommitJobs.get(key) === job) trackingCommitJobs.delete(key);
        releaseTrackingSessionOperation(key, operationToken);
      }
    } catch (error) {
      return { ...(error.trackingResult || { success: false, sessionId: String(request.sessionId || ''), retryable: true, items: [], error: error.message || String(error) }), taskNotificationOwned };
    }
  });

  ipcMain.handle('workspace-progress-main-branch-media', async (_event, workspacePath, request = {}) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      return await versionService.getMainBranchMedia(workspaceRoot, {
        progressId: String(request.progressId || ''),
        ...(request.photoId ? { photoId: String(request.photoId) } : {}),
      });
    } catch (error) {
      return { success: false, entries: [], branchProgressIds: [], error: error.message || String(error) };
    }
  });
};

module.exports = { registerVersionTrackingIpc };
