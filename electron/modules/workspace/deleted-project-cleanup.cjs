const crypto = require('crypto');

const createDeletedProjectCleanup = ({
  backgroundTasks, fs, getWorkspaceDataRoot, path, pathExists, recycleBinService,
  renameHistory, setTimeout, thumbnailService, workspaceRepository, writeLog,
}) => {
  const inspectDeletedProject = async (root, project, prefetchedProbe = null) => {
    const originalPath = path.resolve(root, project.relativePath);
    const relative = path.relative(root, originalPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ...project, originalPath, recycleStatus: 'unknown', statusDetail: '项目原路径无效，已保留数据' };
    }
    if (await pathExists(originalPath)) return { ...project, originalPath, recycleStatus: 'restored', statusDetail: '原项目路径已重新出现' };
    if (project.permanent) return { ...project, originalPath, recycleStatus: 'missing', statusDetail: '项目已由 Windows 永久删除' };
    if (!project.recyclePidl || !recycleBinService.nativeAvailable()) {
      return { ...project, originalPath, recycleStatus: 'unknown', statusDetail: '当前无法可靠检查系统回收站，已保留数据' };
    }
    try {
      const probe = prefetchedProbe || await recycleBinService.probe(project.recyclePidl);
      if (probe.success === false || probe.error) throw new Error(probe.error || '无法检查回收站项目');
      return probe.exists
        ? { ...project, originalPath, recycleStatus: 'in_recycle_bin', statusDetail: '项目仍在系统回收站中' }
        : { ...project, originalPath, recycleStatus: 'missing', statusDetail: '回收站条目和原项目路径均不存在' };
    } catch (error) {
      return { ...project, originalPath, recycleStatus: 'unknown', statusDetail: error.message || String(error) };
    }
  };

  const removeInternalProjectArtifacts = async (root, purgeResult) => {
    const dataRoot = path.resolve(getWorkspaceDataRoot(root));
    const dataRootReal = await fs.promises.realpath(dataRoot).catch(() => dataRoot);
    const candidates = [
      ...(purgeResult.artifactPaths || []),
      ...(purgeResult.photoIds || []).map(photoId => path.join(dataRoot, 'thumbnails', photoId)),
    ];
    const safeCandidates = [...new Set(candidates)].flatMap(candidate => {
      if (!candidate) return [];
      const resolved = path.resolve(candidate);
      const relative = path.relative(dataRoot, resolved);
      return !relative || relative.startsWith('..') || path.isAbsolute(relative) ? [] : [resolved];
    });
    const verifyArtifactPath = async resolved => {
      const relative = path.relative(dataRoot, resolved);
      let current = dataRoot;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('清理路径包含符号链接');
      }
      const candidateReal = await fs.promises.realpath(resolved);
      const realRelative = path.relative(dataRootReal, candidateReal);
      if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('清理路径越过工作区数据目录');
      const stat = await fs.promises.lstat(resolved, { bigint: true });
      return { device: stat.dev.toString(), inode: stat.ino.toString(), directory: stat.isDirectory() };
    };
    let removedCount = 0;
    const failedArtifacts = [];
    for (let offset = 0; offset < safeCandidates.length; offset += 8) {
      const results = await Promise.all(safeCandidates.slice(offset, offset + 8).map(async resolved => {
        let quarantine = '';
        let quarantinedPath = '';
        try {
          if (!await pathExists(resolved)) return true;
          const identity = await verifyArtifactPath(resolved);
          const current = await fs.promises.lstat(resolved, { bigint: true });
          if (current.dev.toString() !== identity.device || current.ino.toString() !== identity.inode || current.isDirectory() !== identity.directory) throw new Error('清理目标在删除前已被替换');
          quarantine = path.join(path.dirname(resolved), `.photoflow-deleted-project-cleanup-${crypto.randomUUID()}`);
          quarantinedPath = path.join(quarantine, 'payload');
          await fs.promises.mkdir(quarantine, { recursive: false });
          await fs.promises.rename(resolved, quarantinedPath);
          const quarantined = await fs.promises.lstat(quarantinedPath, { bigint: true });
          if (quarantined.dev.toString() !== identity.device || quarantined.ino.toString() !== identity.inode || quarantined.isDirectory() !== identity.directory) {
            throw Object.assign(new Error('清理目标在隔离时已被替换，内容已保留'), { recoveryPath: quarantinedPath });
          }
          await fs.promises.rm(quarantinedPath, { recursive: true, force: true });
          await fs.promises.rmdir(quarantine).catch(() => undefined);
          return true;
        } catch (error) {
          let recoveryPath = error.recoveryPath || '';
          if (quarantinedPath && await pathExists(quarantinedPath) && !await pathExists(resolved)) {
            try {
              await fs.promises.rename(quarantinedPath, resolved);
              recoveryPath = '';
              if (quarantine) await fs.promises.rmdir(quarantine).catch(() => undefined);
            } catch (restoreError) {
              recoveryPath = quarantinedPath;
              error.restoreError = restoreError.message || String(restoreError);
            }
          }
          writeLog('warn', 'Unable to remove deleted project artifact', { path: resolved, recoveryPath, error: error.message || String(error) });
          failedArtifacts.push({ path: resolved, recoveryPath: recoveryPath || undefined, error: error.message || String(error), restoreError: error.restoreError });
          return false;
        }
      }));
      removedCount += results.filter(Boolean).length;
    }
    return { removedCount, failedArtifacts };
  };

  const purgeDeletedProjectData = async (root, project, task) => {
    task?.report(15, `正在准备清理“${project.name}”的数据`);
    const cleanupPlan = await workspaceRepository.getDeletedProjectCleanupPlan(root, project.id);
    task?.report(35, `正在清理“${project.name}”的缩略图和内部文件`);
    const artifactCleanup = await removeInternalProjectArtifacts(root, cleanupPlan);
    if (artifactCleanup.failedArtifacts.length) {
      throw Object.assign(new Error(`仍有 ${artifactCleanup.failedArtifacts.length} 个项目内部文件等待安全清理`), {
        code: 'DELETED_PROJECT_CLEANUP_PENDING', recoveryRequired: true, failedArtifacts: artifactCleanup.failedArtifacts,
      });
    }
    const removedArtifactCount = artifactCleanup.removedCount;
    await thumbnailService.evictCache({ sourcePaths: cleanupPlan.sourcePaths || [] }).catch(error => {
      writeLog('warn', 'Unable to clear deleted project thumbnail cache', { project: project.name, error: error.message || String(error) });
    });
    task?.report(80, `正在完成“${project.name}”的数据清理`);
    const purgeResult = await workspaceRepository.purgeDeletedProject(root, project.id);
    for (let index = renameHistory.length - 1; index >= 0; index -= 1) {
      const operation = renameHistory[index];
      const sameWorkspace = operation.workspaceRoot && (process.platform === 'win32'
        ? path.resolve(operation.workspaceRoot).toLocaleLowerCase() === path.resolve(root).toLocaleLowerCase()
        : path.resolve(operation.workspaceRoot) === path.resolve(root));
      const sameProject = operation.projectCatalog?.id
        ? operation.projectCatalog.id === project.id
        : operation.projectCatalog?.name?.toLocaleLowerCase() === project.name.toLocaleLowerCase();
      if (sameWorkspace && (sameProject || (purgeResult.removedUndoIds || []).includes(operation.persistentId))) renameHistory.splice(index, 1);
    }
    writeLog('info', 'Purged unavailable deleted project data', { root, project: project.name, photoCount: purgeResult.photoIds?.length || 0, removedArtifactCount });
    return { removedArtifactCount, purgeResult };
  };

  const purgeConfirmedDeletedProject = async (root, project, prefetchedProbe = null) => {
    const inspected = await inspectDeletedProject(root, project, prefetchedProbe);
    if (inspected.recycleStatus !== 'missing') return { cleaned: false, status: inspected.recycleStatus };
    const { removedArtifactCount } = await purgeDeletedProjectData(root, project);
    return { cleaned: true, status: 'missing', removedArtifactCount };
  };

  const purgeStaleMissingProject = async (root, project) => {
    // Automatic purge must remain disabled until the Python protocol exposes a
    // read-only missing-project cleanup plan and a durable purge outbox. Calling
    // purgeMissingProject first makes artifact failures impossible to enumerate
    // or retry because the owning database row has already been removed.
    writeLog('warn', 'Deferred stale missing project cleanup because no read-only cleanup plan is available', { root, projectId: project.id, projectName: project.name });
    return { cleaned: false, status: 'deferred', reason: 'cleanup-plan-unavailable' };
  };

  const runPermanentProjectCleanup = (root, projectName, restartTask = null) => backgroundTasks.run({
    ...(restartTask?.id ? { id: restartTask.id } : {}),
    type: 'deleted-project-cleanup', title: `清理已永久删除项目：${projectName}`,
    dedupeKey: `deleted-project-cleanup:${root}:${projectName.toLocaleLowerCase()}`,
    cancellable: false, metadata: { root, projectName },
  }, async task => {
    const deleted = await workspaceRepository.listDeletedProjects(root);
    const project = (deleted.projects || []).find(item => item.name.toLocaleLowerCase() === projectName.toLocaleLowerCase());
    return project ? purgeDeletedProjectData(root, project, task) : { skipped: true };
  });

  const queuePermanentProjectCleanup = (root, projectName) => {
    setTimeout(() => void runPermanentProjectCleanup(root, projectName).catch(error => {
      writeLog('warn', 'Permanent project cleanup deferred until a later startup', { root, project: projectName, error: error.message || String(error) });
    }), 15000);
  };

  backgroundTasks?.registerTypeRestartFactory?.('deleted-project-cleanup', task => runPermanentProjectCleanup(task.metadata?.root, task.metadata?.projectName, task));
  return { inspectDeletedProject, purgeConfirmedDeletedProject, purgeStaleMissingProject, queuePermanentProjectCleanup };
};

module.exports = { createDeletedProjectCleanup };
