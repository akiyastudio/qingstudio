const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { terminateAndWait } = require('../infrastructure/process-termination.cjs');
let recycleProcessSequence = 0;

const probeManyIndividually = async (values, probe, { maximum = 5000, concurrency = 8, deadlineAt = Date.now() + 120000 } = {}) => {
  if (!Array.isArray(values) || values.length > maximum) throw Object.assign(new Error('回收站探测项目数量过多'), { code: 'EINVAL' });
  const items = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      const pidl = values[index];
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) { items[index] = { success: false, exists: false, pidl, error: '回收站批量探测超时', code: 'RECYCLE_PROBE_TIMEOUT', outcomeUnknown: true }; continue; }
      try { items[index] = { pidl, ...await probe(pidl, Math.min(15000, remaining)) }; }
      catch (error) {
        items[index] = { success: false, exists: false, pidl, error: error.message || String(error) };
        if (error.code) items[index].code = error.code;
        if (error.outcomeUnknown) items[index].outcomeUnknown = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker));
  return { success: true, items };
};

const trashManyIndividually = async (resolvedPaths, trashItem) => {
  const items = [];
  let aborted = false;
  for (const resolved of resolvedPaths) {
    if (aborted) { items.push({ success: false, originalPath: resolved, recyclePidl: '', preciseRestore: false, permanent: false, error: '前序回收站操作失败，未执行此项', code: 'ABORTED', aborted: true }); continue; }
    try {
      await trashItem(resolved);
      items.push({ success: true, originalPath: resolved, recyclePidl: '', preciseRestore: false, permanent: false });
    } catch (error) {
      const failed = { success: false, originalPath: resolved, recyclePidl: '', preciseRestore: false, permanent: false, error: error.message || String(error) };
      if (error.code) failed.code = error.code;
      items.push(failed);
      aborted = true;
    }
  }
  return { success: true, aborted, items };
};

const runJson = (command, args, timeoutMs = 120000, stdin = '', processSupervisor = null) => new Promise((resolve, reject) => {
  const child = processSupervisor
    ? processSupervisor.launch({
      id: `csharp:recycle-bin:${++recycleProcessSequence}`,
      kind: 'csharp-helper', command, args, options: { stdio: ['pipe', 'pipe', 'pipe'] }, ephemeral: true,
    }).child
    : spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let terminating = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(value);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin);
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-2 * 1024 * 1024); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  child.on('error', error => { if (!terminating) finish(error); });
  child.on('close', code => {
    if (terminating) return;
    const lines = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    let payload;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { payload = JSON.parse(lines[index]); break; } catch { /* keep searching */ }
    }
    if (!payload) return finish(Object.assign(new Error(stderr.trim() || `回收站辅助程序未返回有效结果（代码 ${code}）`), { unstructuredHelperFailure: true, helperExitCode: code }));
    if (!payload.success) {
      const errorCode = payload.code || (args[0] === 'trash' ? 'RECYCLE_BIN_FAILED' : undefined);
      const error = Object.assign(new Error(payload.error || '回收站操作失败'), { code: errorCode, hresult: payload.hresult, transient: payload.transient, invalidPidl: payload.invalidPidl, nativeError: payload.nativeError, phase: payload.phase, recoveryPath: payload.recoveryPath, attemptedStagingPath: payload.attemptedStagingPath, recoveryAvailable: payload.recoveryAvailable, staged: payload.staged, originalMissing: payload.originalMissing, published: payload.published, publishedConfirmed: payload.publishedConfirmed, publicationState: payload.publicationState, outcomeUnknown: payload.outcomeUnknown, identityVerified: payload.identityVerified, items: payload.items });
      return finish(error);
    }
    finish(null, payload);
  });
  const timer = setTimeout(() => {
    if (settled || terminating) return;
    terminating = true;
    const timeoutError = Object.assign(new Error('回收站操作超时，操作结果未知'), { code: 'RECYCLE_BIN_TIMEOUT', outcomeUnknown: true });
    void terminateAndWait(child, Date.now() + 5000).then(
      () => finish(timeoutError),
      terminationError => finish(Object.assign(timeoutError, { terminationError, pid: child.pid || null }))
    );
  }, timeoutMs);
});

const createRecycleBinService = ({ app, shell, projectRoot, processSupervisor = null, restoreTimeoutMs = 120000, nativeAvailableOverride = null, persistentOperations = false }) => {
  const executable = () => app.isPackaged
    ? path.join(process.resourcesPath, 'recycle-bin-service.exe')
    : path.join(projectRoot, 'electron', 'bin', 'recycle-bin-service.exe');

  const nativeAvailable = () => nativeAvailableOverride === null ? process.platform === 'win32' && fs.existsSync(executable()) : nativeAvailableOverride === true;
  const worker = persistentOperations && process.platform === 'win32' ? require('./persistent-rename-service.cjs').createPersistentRenameService({ protocol: 'photoflow-recycle-v1', idleMs: processSupervisor ? 0 : 2000, launch: () => processSupervisor
    ? processSupervisor.launch({ id: `csharp:recycle-bin:${++recycleProcessSequence}`, kind: 'csharp-helper', command: executable(), args: ['serve'], options: { stdio: ['pipe', 'pipe', 'pipe'] }, ephemeral: true, windowsJob: true }).child
    : spawn(executable(), ['serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) }) : null;

  const trash = async filePath => {
    const resolved = path.resolve(filePath);
    if (nativeAvailable()) {
      if (worker) return worker.request({ operation: 'trash', path: resolved });
      return runJson(executable(), ['trash', '--path', resolved], 120000, '', processSupervisor);
    }
    if (process.platform === 'win32') {
      const error = new Error('Windows 回收站服务未安装，已取消删除以避免无法撤销');
      error.code = 'RECYCLE_SERVICE_MISSING';
      throw error;
    }
    await shell.trashItem(resolved);
    return { success: true, originalPath: resolved, recyclePidl: '', preciseRestore: false };
  };

  const trashMany = async filePaths => {
    const resolvedPaths = Array.from(new Set((Array.isArray(filePaths) ? filePaths : []).map(filePath => path.resolve(filePath))));
    if (!resolvedPaths.length) return { success: true, items: [] };
    if (nativeAvailable()) {
      const timeoutMs = Math.min(15 * 60 * 1000, 120000 + resolvedPaths.length * 2000);
      if (worker) return worker.request({ operation: 'trash-many', values: JSON.stringify(resolvedPaths) }, { timeoutMs });
      return runJson(executable(), ['trash-many'], timeoutMs, JSON.stringify(resolvedPaths), processSupervisor);
    }
    if (process.platform === 'win32') {
      const error = new Error('Windows 回收站服务未安装，已取消删除以避免无法撤销');
      error.code = 'RECYCLE_SERVICE_MISSING';
      throw error;
    }
    return trashManyIndividually(resolvedPaths, resolved => shell.trashItem(resolved));
  };

  const restore = async ({ recyclePidl, originalPath, targetPath = originalPath }) => {
    if (!recyclePidl || !nativeAvailable()) {
      const error = new Error('当前系统无法从软件内精确恢复，请打开系统回收站手动还原');
      error.code = 'MANUAL_RESTORE_REQUIRED';
      throw error;
    }
    const evidenceOriginal = path.resolve(originalPath);
    const target = path.resolve(targetPath);
    const occupied = await fs.promises.lstat(target).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (occupied) throw Object.assign(new Error('恢复目标当前已被占用，未启动回收站恢复'), { code: 'RECYCLE_RESTORE_TARGET_OCCUPIED', phase: 'preflight', outcomeUnknown: false, published: false, publishedConfirmed: true, publicationState: 'not-started', targetExists: true, targetPreexisting: true, recoveryAvailable: false, staged: false });
    const staging = path.join(path.dirname(target), `.photoflow-restore-${crypto.randomUUID()}-${path.basename(target)}`);
    const targetPreexisting = false;
    if (fs.existsSync(staging)) throw Object.assign(new Error('恢复暂存路径在启动前已存在'), { code: 'RECYCLE_BIN_PROTOCOL_ERROR', attemptedStagingPath: staging, recoveryAvailable: false, staged: false });
    try { return await runJson(executable(), ['restore', '--pidl', recyclePidl, '--original', evidenceOriginal, '--target', target, '--staging', staging], restoreTimeoutMs, '', processSupervisor); }
    catch (error) {
      if (error.recoveryPath && path.resolve(error.recoveryPath) !== staging) { const stagingExists = fs.existsSync(staging); throw Object.assign(new Error('回收站辅助程序返回了未获批准的恢复路径'), { code: 'RECYCLE_BIN_PROTOCOL_ERROR', recoveryPath: stagingExists ? staging : undefined, attemptedStagingPath: staging, recoveryAvailable: stagingExists, staged: stagingExists, originalMissing: !fs.existsSync(target), outcomeUnknown: true, cause: error }); }
      const stagingExists = fs.existsSync(staging);
      const targetExists = fs.existsSync(target);
      if (error.unstructuredHelperFailure) {
        error.code = 'RECYCLE_RESTORE_OUTCOME_UNKNOWN';
        error.outcomeUnknown = true;
      }
      const reliablePublished = !targetPreexisting && targetExists && !stagingExists && error.published === true && error.identityVerified === true;
      if (stagingExists) error.recoveryPath = staging;
      else delete error.recoveryPath;
      error.attemptedStagingPath = staging;
      error.recoveryAvailable = stagingExists;
      error.staged = stagingExists;
      if (reliablePublished) { error.published = true; error.publishedConfirmed = true; error.publicationState = 'published'; }
      else if (!targetExists || targetPreexisting) { error.published = false; error.publishedConfirmed = true; error.publicationState = 'not-published'; }
      else { delete error.published; error.publishedConfirmed = false; error.publicationState = 'unknown'; }
      error.stagingExists = stagingExists;
      error.targetExists = targetExists;
      error.targetPreexisting = targetPreexisting;
      if (error.originalMissing === undefined) error.originalMissing = !targetExists;
      throw error;
    }
  };

  const probe = async (recyclePidl, timeoutMs = 15000) => {
    if (!recyclePidl || !nativeAvailable()) return { success: true, exists: false };
    return runJson(executable(), ['probe', '--pidl', recyclePidl], Math.max(1, Math.min(15000, timeoutMs)), '', processSupervisor);
  };

  const probeMany = async recyclePidls => {
    const values = Array.from(new Set((Array.isArray(recyclePidls) ? recyclePidls : []).filter(Boolean).map(String)));
    if (values.length > 5000) throw Object.assign(new Error('回收站探测项目数量过多'), { code: 'EINVAL' });
    if (!values.length || !nativeAvailable()) return { success: true, items: [] };
    const deadlineAt = Date.now() + 120000;
    try {
      return await runJson(executable(), ['probe-many'], Math.min(120000, 15000 + values.length * 250), JSON.stringify(values), processSupervisor);
    } catch {
      return probeManyIndividually(values, probe, { maximum: 5000, concurrency: 8, deadlineAt });
    }
  };

  return { trash, trashMany, restore, probe, probeMany, nativeAvailable, stop: () => worker?.stop() };
};

module.exports = { createRecycleBinService, probeManyIndividually, trashManyIndividually, runJson };
