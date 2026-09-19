const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const exists = filePath => fs.promises.access(filePath).then(() => true, () => false);
const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const sha256File = async filePath => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};
const safeComponent = (value, label) => {
  const text = String(value || '');
  if (!text || text.includes('\0') || text === '.' || text === '..' || path.basename(text) !== text || text.includes('/') || text.includes('\\')) throw new Error(`${label}无效`);
  return text;
};
const assertPhysicalDirectory = async (candidate, label) => {
  const resolved = path.resolve(candidate);
  let cursor = resolved;
  while (true) {
    const ancestor = await fs.promises.lstat(cursor).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (ancestor?.isSymbolicLink()) throw new Error(`${label}包含链接或重解析祖先`);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const stat = await fs.promises.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}不是安全的物理目录`);
  const real = await fs.promises.realpath(resolved);
  if (!samePath(real, resolved)) throw new Error(`${label}解析到其他物理位置`);
  return real;
};
const samePath = (left, right) => (process.platform === 'win32' ? path.resolve(left).toLocaleLowerCase() : path.resolve(left))
  === (process.platform === 'win32' ? path.resolve(right).toLocaleLowerCase() : path.resolve(right));
const assertSafeDestinationAncestors = async (approvedRoot, destination) => {
  const rootReal = await fs.promises.realpath(approvedRoot);
  if (!inside(rootReal, destination) || samePath(rootReal, destination)) throw new Error('归档目标路径越界');
  let cursor = path.resolve(destination);
  while (inside(rootReal, cursor) && !samePath(rootReal, cursor)) {
    const stat = await fs.promises.lstat(cursor).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`归档目标祖先不是安全的物理目录：${cursor}`);
      if (!inside(rootReal, await fs.promises.realpath(cursor))) throw new Error(`归档目标祖先真实路径越界：${cursor}`);
    }
    cursor = path.dirname(cursor);
  }
  if (!samePath(rootReal, cursor)) throw new Error('归档目标不在获批根目录内');
};

// Resolve both ends through their nearest existing ancestor.  This is used
// immediately before every path mutation as a best-effort guard against an
// ancestor being exchanged for a junction between preflight and rename.
const assertCanonicalContainment = async (root, candidate, label, { allowLeafLink = false, allowMissing = false } = {}) => {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  if (!inside(rootResolved, candidateResolved) || samePath(rootResolved, candidateResolved)) throw new Error(`${label}越过授权根目录或等于根目录`);
  const rootStat = await fs.promises.lstat(rootResolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${label}授权根目录不是安全的物理目录`);
  const rootReal = await fs.promises.realpath(rootResolved);
  let cursor = candidateResolved;
  let leaf = true;
  while (true) {
    const stat = await fs.promises.lstat(cursor).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat) {
      if (stat.isSymbolicLink() && leaf && allowLeafLink) {
        cursor = path.dirname(cursor);
        leaf = false;
        continue;
      }
      if (stat.isSymbolicLink()) throw new Error(`${label}包含链接或重解析祖先`);
      const real = await fs.promises.realpath(cursor);
      if (!inside(rootReal, real) || samePath(rootReal, real) && !samePath(cursor, rootResolved)) throw new Error(`${label}真实路径越过授权根目录`);
      if (leaf && !allowLeafLink && !stat.isDirectory()) throw new Error(`${label}不是安全的物理目录`);
      return { rootReal, candidateReal: real, exists: samePath(cursor, candidateResolved) };
    }
    leaf = false;
    const parent = path.dirname(cursor);
    if (parent === cursor || !inside(rootResolved, parent)) throw new Error(`${label}没有位于授权根目录内的现存祖先`);
    cursor = parent;
    if (!allowMissing && samePath(cursor, rootResolved)) {
      // The leaf may be absent, but its nearest existing ancestor must still
      // be inspected below; allowMissing only controls the returned state.
    }
  }
};

const createArchiveService = ({ backgroundTasks, movePathAtomic, readSavedConfig, workspaceRepository, writeLog }) => {
  const approvedTargets = new Set();
  const comparable = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
  const approveTarget = value => {
    if (!value) return '';
    const resolved = path.resolve(value);
    approvedTargets.add(comparable(resolved));
    return resolved;
  };
  const isApprovedTarget = value => Boolean(value) && approvedTargets.has(comparable(value));
  approveTarget(readSavedConfig()?.archive?.targetPath);

  const workspaceId = async root => (await fs.promises.readFile(path.join(root, '.photoflow-workspace-id'), 'utf8')).trim();
  const projectReference = value => value && typeof value === 'object'
    ? { id: String(value.id || '').trim(), name: String(value.name || '').trim() }
    : { id: '', name: String(value || '').trim() };
  const destinationFor = async (root, target, projectName) => {
    const id = safeComponent(await workspaceId(root), '工作区 ID');
    const name = safeComponent(projectName, '项目名称');
    const targetReal = await assertPhysicalDirectory(target, '归档盘');
    const destination = path.resolve(targetReal, id, name);
    if (!inside(targetReal, destination) || samePath(targetReal, destination)) throw new Error('归档目标路径无效');
    await assertSafeDestinationAncestors(targetReal, destination);
    return { destination, targetReal };
  };
  const parseArchive = row => {
    try { return JSON.parse(row?.extra_json || '{}')?.archive || null; }
    catch { return null; }
  };
  const scanTree = async (root, withHashes = false) => {
    const files = [];
    let fileCount = 0;
    let bytes = 0;
    const pending = [{ absolute: root, relative: '' }];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of await fs.promises.readdir(directory.absolute, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory.absolute, entry.name);
        const relative = path.join(directory.relative, entry.name);
        if (entry.isDirectory()) pending.push({ absolute, relative });
        else if (entry.isFile()) {
          const size = (await fs.promises.stat(absolute)).size;
          fileCount += 1;
          bytes += size;
          if (withHashes) files.push({ absolute, relative, size });
        }
      }
    }
    if (withHashes) files.sort((left, right) => left.relative.localeCompare(right.relative));
    const sampleStep = Math.max(1, Math.floor(files.length / 20));
    const samples = withHashes ? await Promise.all(files.filter((_file, index) => index % sampleStep === 0).slice(0, 20).map(async file => ({ relative: file.relative, size: file.size, hash: await sha256File(file.absolute) }))) : [];
    return { fileCount, bytes, samples };
  };
  const verifyDestination = async (destination, expected) => {
    await assertPhysicalDirectory(destination, '归档副本');
    const actual = await scanTree(destination, false);
    if (actual.fileCount !== expected.fileCount || actual.bytes !== expected.bytes) throw new Error('归档副本文件数量或大小校验失败');
    for (const sample of expected.samples) {
      const candidate = path.resolve(destination, sample.relative);
      if (!inside(destination, candidate) || !await exists(candidate) || await sha256File(candidate) !== sample.hash) throw new Error(`归档副本抽检失败：${sample.relative}`);
    }
    return actual;
  };
  const createLink = async (target, linkPath) => fs.promises.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

  const status = async () => {
    const config = readSavedConfig()?.archive || {};
    const target = String(config.targetPath || '').trim();
    if (!config.enabled || !target) return { success: true, enabled: false, state: 'unconfigured' };
    const online = await exists(target);
    const stat = online && typeof fs.promises.statfs === 'function' ? await fs.promises.statfs(target).catch(() => null) : null;
    return {
      success: true,
      enabled: true,
      state: online ? 'connected' : 'offline',
      targetPath: target,
      totalBytes: stat ? Number(stat.blocks) * Number(stat.bsize) : undefined,
      freeBytes: stat ? Number(stat.bavail) * Number(stat.bsize) : undefined,
    };
  };

  const archiveProject = async (workspaceRoot, projectName, resumeTask = null, startOnly = false) => {
    const root = path.resolve(workspaceRoot);
    await assertPhysicalDirectory(root, '工作区');
    const config = readSavedConfig()?.archive || {};
    const target = String(config.targetPath || '').trim();
    if (!config.enabled || !target || !isApprovedTarget(target)) throw new Error('请先在“备份与恢复”中设置归档盘');
    if (!await exists(target)) throw new Error('归档盘当前未连接');
    if (inside(root, target) || inside(target, root)) throw new Error('归档盘不能位于工作区内部，也不能包含工作区');
    const catalog = await workspaceRepository.load(root);
    const requested = projectReference(projectName);
    const requestedId = String(resumeTask?.metadata?.projectId || requested.id || '');
    const project = (catalog.projects || []).find(row => !row.is_deleted && requestedId && String(row.id) === requestedId)
      || (catalog.projects || []).find(row => !row.is_deleted && requested.name && String(row.name).toLocaleLowerCase() === requested.name.toLocaleLowerCase());
    if (!project) throw new Error('项目不存在');
    if (parseArchive(project)?.path && !resumeTask?.id) throw new Error('项目已经位于归档盘');
    const source = path.resolve(root, project.relative_path);
    if (!inside(root, source) || samePath(root, source)) throw new Error('项目文件夹当前不可用');
    const { destination } = await destinationFor(root, target, project.name);
    if (resumeTask?.metadata?.archivePath && !samePath(resumeTask.metadata.archivePath, destination)) throw new Error('归档任务目标与当前获批位置不一致');
    if (!await exists(source) && !await exists(destination)) throw new Error('项目文件夹当前不可用');
    if (await exists(destination) && !resumeTask?.id) throw new Error('归档盘中已存在同名项目');
    const run = () => backgroundTasks.start({
      ...(resumeTask?.id ? { id: resumeTask.id } : {}),
      type: 'project-archive',
      title: `归档项目 · ${project.name}`,
      dedupeKey: `project-archive:${project.id}`,
      cancellable: false,
      resumable: true,
      checkpoint: resumeTask?.checkpoint,
      progress: resumeTask?.progress,
      resources: [source, target],
      metadata: { workspacePath: root, projectId: project.id, projectName: project.name, archivePath: destination },
      resumeFactory: taskSnapshot => archiveProject(root, project.name, taskSnapshot),
    }, async task => {
      const savedCheckpoint = task.getCheckpoint() || {};
      task.report(5, '正在统计并抽检源项目');
      const sourceStat = await fs.promises.lstat(source).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (sourceStat && !sourceStat.isSymbolicLink()) await assertCanonicalContainment(root, source, '归档源项目');
      await assertCanonicalContainment(path.resolve(target), destination, '归档目标', { allowMissing: true });
      const expected = savedCheckpoint.expected || await scanTree(sourceStat && !sourceStat.isSymbolicLink() ? source : destination, true);
      task.saveCheckpoint({ version: 1, phase: 'moving', expected }, 20, '正在移动到归档盘');
      if (!await exists(destination)) {
        if (!sourceStat || sourceStat.isSymbolicLink()) throw new Error('归档源项目不可用');
        await assertCanonicalContainment(root, source, '归档源项目');
        await assertCanonicalContainment(path.resolve(target), destination, '归档目标', { allowMissing: true });
        await movePathAtomic(source, destination);
        await assertCanonicalContainment(path.resolve(target), destination, '归档目标');
      }
      let linked = false;
      let metadataCommitted = savedCheckpoint.phase === 'metadataCommitted';
      try {
        task.saveCheckpoint({ version: 1, phase: 'verifying', expected }, 75, '正在验证归档副本');
        await verifyDestination(destination, expected);
        const currentSource = await fs.promises.lstat(source).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (!currentSource) {
          await assertCanonicalContainment(path.resolve(target), destination, '归档链接目标');
          await assertCanonicalContainment(root, source, '归档链接位置', { allowMissing: true });
          await createLink(destination, source);
          linked = true;
        } else if (!currentSource.isSymbolicLink()) throw new Error('工作区原位置已被其他目录占用');
        else if (!samePath(await fs.promises.realpath(source), await fs.promises.realpath(destination))) throw new Error('工作区归档链接指向了其他位置');
        task.saveCheckpoint({ version: 1, phase: 'finalizing', expected }, 90, '正在登记归档状态');
        if (!metadataCommitted) {
          await workspaceRepository.archiveProject(root, { name: project.name, archivePath: destination, verifiedAt: Date.now(), fileCount: expected.fileCount, bytes: expected.bytes });
          metadataCommitted = true;
          task.saveCheckpoint({ version: 1, phase: 'metadataCommitted', expected }, 95, '归档状态已登记');
        }
        await workspaceRepository.syncCatalog(root);
        task.report(100, '项目已归档并验证');
        return { projectName: project.name, archivePath: destination, ...expected };
      } catch (error) {
        if (metadataCommitted) throw error;
        const rollbackErrors = [];
        if (linked) try { await fs.promises.unlink(source); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        if (await exists(destination) && !await exists(source)) try {
          await assertCanonicalContainment(path.resolve(target), destination, '归档回滚源项目');
          await assertCanonicalContainment(root, source, '归档回滚目标', { allowMissing: true });
          await movePathAtomic(destination, source);
          await assertCanonicalContainment(root, source, '归档回滚目标');
        }
        catch (rollbackError) { rollbackErrors.push(rollbackError); writeLog?.('error', 'Archive rollback failed', rollbackError); }
        if (rollbackErrors.length) {
          task.saveCheckpoint({ version: 1, phase: 'rollbackPending', expected, rollbackErrors: rollbackErrors.map(item => item.message || String(item)) }, 95, '归档失败，回滚等待重试');
          throw new AggregateError([error, ...rollbackErrors], `归档失败且回滚未完成：${error.message || String(error)}`);
        }
        throw error;
      }
    }, () => archiveProject(root, project.name));
    const execution = run();
    return startOnly ? execution : execution.completion;
  };

  const moveBack = async (workspaceRoot, projectName, statusAfter = '后期中', resumeTask = null, startOnly = false) => {
    const root = path.resolve(workspaceRoot);
    await assertPhysicalDirectory(root, '工作区');
    const catalog = await workspaceRepository.load(root);
    const requested = projectReference(projectName);
    const requestedId = String(resumeTask?.metadata?.projectId || requested.id || '');
    const project = (catalog.projects || []).find(row => !row.is_deleted && requestedId && String(row.id) === requestedId)
      || (catalog.projects || []).find(row => !row.is_deleted && requested.name && String(row.name).toLocaleLowerCase() === requested.name.toLocaleLowerCase());
    const archive = parseArchive(project) || (resumeTask?.metadata?.archivePath ? { path: resumeTask.metadata.archivePath, ...(resumeTask.checkpoint?.expected || {}) } : null);
    if (!project || !archive?.path) throw new Error('项目没有归档位置记录');
    const sourceLink = path.resolve(root, project.relative_path);
    if (!inside(root, sourceLink) || samePath(root, sourceLink)) throw new Error('移回目标路径无效');
    const config = readSavedConfig()?.archive || {};
    const approvedRoot = String(config.targetPath || '').trim();
    if (!config.enabled || !approvedRoot || !isApprovedTarget(approvedRoot) || !await exists(approvedRoot)) throw new Error('归档盘当前未连接或未经授权');
    const { destination: archivePath } = await destinationFor(root, approvedRoot, project.name);
    if (!samePath(archive.path, archivePath) || (resumeTask?.metadata?.archivePath && !samePath(resumeTask.metadata.archivePath, archivePath))) throw new Error('归档记录不在当前获批位置');
    const archiveAvailable = await exists(archivePath);
    const resumedSource = resumeTask?.id ? await fs.promises.lstat(sourceLink).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error)) : null;
    const moveAlreadyCommitted = Boolean(resumedSource?.isDirectory() && !resumedSource.isSymbolicLink());
    if (!archiveAvailable && !moveAlreadyCommitted) throw new Error('归档盘当前未连接');
    const run = () => backgroundTasks.start({
      ...(resumeTask?.id ? { id: resumeTask.id } : {}),
      type: 'project-unarchive',
      title: `移回工作盘 · ${project.name}`,
      dedupeKey: `project-unarchive:${project.id}`,
      cancellable: false,
      resumable: true,
      checkpoint: resumeTask?.checkpoint,
      progress: resumeTask?.progress,
      resources: [sourceLink, archivePath],
      metadata: { workspacePath: root, projectId: project.id, projectName: project.name, archivePath, statusAfter },
      resumeFactory: taskSnapshot => moveBack(root, project.name, statusAfter, taskSnapshot),
    }, async task => {
      const savedCheckpoint = task.getCheckpoint() || {};
      const expected = savedCheckpoint.expected || {
        ...(archive.fileCount != null ? { fileCount: Number(archive.fileCount) } : {}),
        ...(archive.bytes != null ? { bytes: Number(archive.bytes) } : {}),
      };
      const linkStat = await fs.promises.lstat(sourceLink).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (linkStat?.isSymbolicLink()) {
        await assertCanonicalContainment(root, sourceLink, '工作区归档链接', { allowLeafLink: true });
        await assertCanonicalContainment(path.resolve(approvedRoot), archivePath, '归档源项目');
        if (!samePath(await fs.promises.realpath(sourceLink), await fs.promises.realpath(archivePath))) throw new Error('工作区归档链接指向了其他位置');
        await fs.promises.unlink(sourceLink);
      }
      else if (linkStat && await exists(archivePath)) throw new Error('工作区原位置已被其他目录占用');
      let metadataCommitted = savedCheckpoint.phase === 'metadataCommitted';
      try {
        task.saveCheckpoint({ version: 1, phase: 'moving', expected }, 15, '正在移回工作盘');
        if (await exists(archivePath)) {
          await assertCanonicalContainment(path.resolve(approvedRoot), archivePath, '归档源项目');
          await assertCanonicalContainment(root, sourceLink, '工作区移回目标', { allowMissing: true });
          await movePathAtomic(archivePath, sourceLink);
          await assertCanonicalContainment(root, sourceLink, '工作区移回目标');
        }
        else if (!await exists(sourceLink)) throw new Error('归档项目和工作区项目均不可用');
        const verified = await scanTree(sourceLink, false);
        if ((expected.fileCount != null && Number.isFinite(Number(expected.fileCount)) && verified.fileCount !== Number(expected.fileCount))
          || (expected.bytes != null && Number.isFinite(Number(expected.bytes)) && verified.bytes !== Number(expected.bytes))) throw new Error('移回后的项目校验失败');
        task.saveCheckpoint({ version: 1, phase: 'finalizing', expected }, 90, '正在登记移回状态');
        if (!metadataCommitted) {
          await workspaceRepository.unarchiveProject(root, { name: project.name, status: statusAfter });
          metadataCommitted = true;
          task.saveCheckpoint({ version: 1, phase: 'metadataCommitted', expected }, 95, '移回状态已登记');
        }
        await workspaceRepository.syncCatalog(root);
        task.report(100, '项目已移回工作盘');
        return { projectName: project.name, path: sourceLink, status: statusAfter };
      } catch (error) {
        if (metadataCommitted) throw error;
        const rollbackErrors = [];
        if (await exists(sourceLink) && !await exists(archivePath)) try {
          await assertCanonicalContainment(root, sourceLink, '移回回滚源项目');
          await assertCanonicalContainment(path.resolve(approvedRoot), archivePath, '移回回滚目标', { allowMissing: true });
          await movePathAtomic(sourceLink, archivePath);
          await assertCanonicalContainment(path.resolve(approvedRoot), archivePath, '移回回滚目标');
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        if (!await fs.promises.lstat(sourceLink).catch(statError => statError?.code === 'ENOENT' ? null : Promise.reject(statError))) try {
          await assertCanonicalContainment(root, sourceLink, '移回回滚链接位置', { allowMissing: true });
          await assertCanonicalContainment(path.resolve(approvedRoot), archivePath, '移回回滚链接目标');
          await createLink(archivePath, sourceLink);
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        if (rollbackErrors.length) {
          task.saveCheckpoint({ version: 1, phase: 'rollbackPending', expected, rollbackErrors: rollbackErrors.map(item => item.message || String(item)) }, 95, '移回失败，回滚等待重试');
          throw new AggregateError([error, ...rollbackErrors], `移回失败且回滚未完成：${error.message || String(error)}`);
        }
        throw error;
      }
    }, () => moveBack(root, project.name, statusAfter));
    const execution = run();
    return startOnly ? execution : execution.completion;
  };

  const accepted = async starter => {
    try {
      const execution = await starter();
      void execution.completion.catch(() => undefined);
      return { success: true, taskId: execution.task.id, deduplicated: execution.deduplicated, completion: execution.completion };
    } catch (error) {
      return { success: false, error: error.message || String(error), code: error.code || undefined };
    }
  };
  const enqueueArchiveProject = (workspaceRoot, projectName) => accepted(() => archiveProject(workspaceRoot, projectName, null, true));
  const enqueueMoveBack = (workspaceRoot, projectName, statusAfter = '后期中') => accepted(() => moveBack(workspaceRoot, projectName, statusAfter, null, true));

  backgroundTasks.registerTypeResumeFactory?.('project-archive', task => archiveProject(task.metadata?.workspacePath, task.metadata?.projectName, task));
  backgroundTasks.registerTypeResumeFactory?.('project-unarchive', task => moveBack(task.metadata?.workspacePath, task.metadata?.projectName, task.metadata?.statusAfter || '后期中', task));

  return { approveTarget, isApprovedTarget, status, archiveProject, enqueueArchiveProject, moveBack, enqueueMoveBack };
};

module.exports = { createArchiveService };
