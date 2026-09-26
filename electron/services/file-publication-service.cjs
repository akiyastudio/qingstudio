const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { terminateAndWait } = require('../infrastructure/process-termination.cjs');
let sequence = 0;
const publicationBatchTimeoutMs = itemCount => Math.min(10 * 60 * 1000, Math.max(120000, Number(itemCount) * 2000));
const runPublicationJson = (command, args, timeoutMs, processSupervisor, options = {}) => new Promise((resolve, reject) => {
  const spawnImpl = options.spawnImpl || spawn;
  const child = processSupervisor ? processSupervisor.launch({ id: `csharp:file-publication:${++sequence}`, kind: 'csharp-helper', command, args, options: { stdio: ['ignore', 'pipe', 'pipe'] }, ephemeral: true }).child : spawnImpl(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let settled = false; let terminating = false;
  const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let progressBuffer = '';
  child.stdout.on('data', data => {
    stdout = (stdout + data).slice(-1024 * 1024);
    if (!options.onProgress) return;
    progressBuffer += data;
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop().slice(-65536);
    for (const line of lines) {
      let value;
      try { value = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { continue; }
      if (value?.type === 'copy-progress') options.onProgress(value);
    }
  }); child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  child.on('error', error => { if (!terminating) finish(error); }); child.on('close', code => { if (terminating) return; const line = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).pop(); let payload; try { payload = line ? JSON.parse(line) : null; } catch {} if (!payload) return finish(new Error(stderr.trim() || `文件发布服务未返回有效 JSON（代码 ${code}）`)); if (!payload.success) return finish(Object.assign(new Error(payload.error || '文件发布服务失败'), { code: payload.code || 'FILE_PUBLICATION_FAILED', nativeError: payload.nativeError, phase: payload.phase, recoveryPath: payload.recoveryPath, recoveryPathBase64: payload.recoveryPathBase64, originalMissing: payload.originalMissing, deleted: payload.deleted, cleanupWarning: payload.cleanupWarning, publishedPath: payload.publishedPath, published: payload.published, publishedConfirmed: payload.publishedConfirmed, publicationState: payload.publicationState, outcomeUnknown: payload.outcomeUnknown, identity: payload.identity })); finish(null, payload); });
  const timer = setTimeout(() => { if (settled || terminating) return; terminating = true; const timeoutError = Object.assign(new Error('文件发布服务响应超时，操作结果未知'), { code: 'FILE_PUBLICATION_TIMEOUT', outcomeUnknown: true }); void terminateAndWait(child, Date.now() + (options.terminationTimeoutMs || 5000), options.terminationOptions).then(() => finish(timeoutError), terminationError => finish(Object.assign(timeoutError, { terminationError, pid: child.pid || null }))); }, timeoutMs);
});
const digest = async filePath => { const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(filePath); for await (const chunk of stream) hash.update(chunk); return hash.digest('hex'); };
const createFilePublicationService = ({ app, projectRoot, processSupervisor = null, platform = process.platform, invokeOverride = null, spawnImpl = null, persistentRename = false, persistentOperations = false, batchTimeoutMs = publicationBatchTimeoutMs, portableFaultInjector = async () => undefined }) => {
  const MAX_BATCH_ITEMS = 2048;
  const MAX_BATCH_MANIFEST_BYTES = 512 * 1024;
  const binaryName = platform === 'win32' ? 'file-publication-service.exe' : 'file-publication-service';
  const executable = () => app.isPackaged ? path.join(process.resourcesPath, binaryName) : path.join(projectRoot, 'electron', 'bin', binaryName);
  const ensure = () => { if (!fs.existsSync(executable())) { const error = new Error(`${platform === 'win32' ? 'Windows' : 'POSIX'} 原子文件发布服务不可用`); error.code = 'FILE_PUBLICATION_SERVICE_MISSING'; throw error; } };
  const createWorker = () => ({ pending: 0, worker: require('./persistent-rename-service.cjs').createPersistentRenameService({ protocol: 'photoflow-files-v1', idleMs: processSupervisor ? 0 : 2000, launch: () => {
    ensure();
    const args = ['serve-operations'];
    return processSupervisor
      ? processSupervisor.launch({ id: `csharp:file-operation:${++sequence}`, kind: 'csharp-helper', command: executable(), args, options: { stdio: ['pipe', 'pipe', 'pipe'] }, ephemeral: true, windowsJob: true }).child
      : (spawnImpl || spawn)(executable(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } }) });
  const pools = persistentOperations && platform === 'win32' && !invokeOverride ? { copy: [createWorker(), createWorker()], metadata: [createWorker()] } : null;
  const decodeRecoveryPath = (encoded, original, suffix = 'photoflow-recovery-') => {
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Object.assign(new Error('文件发布服务返回了无效的恢复路径编码'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.includes(0)) throw Object.assign(new Error('文件发布服务返回了无效的恢复路径编码'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw Object.assign(new Error('文件发布服务返回了无效的恢复路径编码'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    if (!path.isAbsolute(decoded) || path.normalize(decoded) !== decoded) throw Object.assign(new Error('文件发布服务返回了非规范恢复路径'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    const recoveryPath = path.resolve(decoded);
    const expected = path.resolve(original);
    const recoveryDirectory = path.dirname(recoveryPath);
    const privateQuarantine = path.dirname(recoveryDirectory) === path.dirname(expected) && path.basename(recoveryDirectory).startsWith('.photoflow-quarantine-') && path.basename(recoveryPath) === path.basename(expected);
    const legacyRecovery = recoveryDirectory === path.dirname(expected) && path.basename(recoveryPath).startsWith(`${path.basename(expected)}.${suffix}`);
    if (!privateQuarantine && !legacyRecovery) throw Object.assign(new Error('文件发布服务返回了越界恢复路径'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    return recoveryPath;
  };
  const invoke = async (operation, values, timeout = 120000, runOptions = {}) => {
    try {
      if (invokeOverride) return await invokeOverride(operation, values);
      ensure();
      if (pools) {
        const pool = operation.startsWith('copy-') ? pools.copy : pools.metadata;
        const slot = pool.reduce((left, right) => left.pending <= right.pending ? left : right);
        slot.pending++;
        try { return await slot.worker.request({ operation, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) }, { timeoutMs: timeout, onProgress: runOptions.onProgress }); }
        finally { slot.pending--; }
      }
      const args = [operation]; for (const [key, value] of Object.entries(values)) args.push(`--${key}`, String(value));
      return await runPublicationJson(executable(), args, timeout, processSupervisor, { ...runOptions, ...(spawnImpl ? { spawnImpl } : {}) });
    } catch (error) {
      error.operation = operation;
      if (error.recoveryPathBase64) {
        const original = operation === 'compare-delete-file' ? values.target : operation === 'commit-cross-volume-file' ? values.source : null;
        if (!original) throw Object.assign(new Error('文件发布服务在不支持的操作中返回了恢复路径'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', operation });
        error.recoveryPath = decodeRecoveryPath(error.recoveryPathBase64, original);
      }
      throw error;
    }
  };
  const renameWorker = persistentRename && platform === 'win32' && !invokeOverride
    ? require('./persistent-rename-service.cjs').createPersistentRenameService({ idleMs: processSupervisor ? 0 : 60000, launch: () => {
      ensure();
      const args = ['serve-moves'];
      return processSupervisor
        ? processSupervisor.launch({ id: `csharp:file-rename:${++sequence}`, kind: 'csharp-helper', command: executable(), args, options: { stdio: ['pipe', 'pipe', 'pipe'] }, ephemeral: true, windowsJob: true }).child
        : (spawnImpl || spawn)(executable(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } }) : null;
  const moveNoReplace = (source, target) => renameWorker
    ? renameWorker.move(path.resolve(source), path.resolve(target)).catch(error => { error.operation = 'move-no-replace'; throw error; })
    : invoke('move-no-replace', { source: path.resolve(source), target: path.resolve(target) });
  const moveNoReplaceBatch = async requests => {
    if (!Array.isArray(requests) || requests.length === 0) return [];
    if (requests.length > MAX_BATCH_ITEMS) throw Object.assign(new Error(`单次批量发布不得超过 ${MAX_BATCH_ITEMS} 项`), { code: 'EINVAL' });
    const manifest = path.join(os.tmpdir(), `photoflow-publication-${process.pid}-${crypto.randomUUID()}.batch`);
    const contents = requests.map((request, index) => {
      const source = path.resolve(request.source);
      const target = path.resolve(request.target);
      if (typeof request.identity !== 'string' || !request.identity) throw Object.assign(new Error('批量发布缺少预捕获源身份'), { code: 'EINVAL' });
      return `${index}\t${Buffer.from(source, 'utf8').toString('base64')}\t${Buffer.from(target, 'utf8').toString('base64')}\t${Buffer.from(request.identity, 'utf8').toString('base64')}`;
    }).join('\n');
    if (Buffer.byteLength(contents) > MAX_BATCH_MANIFEST_BYTES) throw Object.assign(new Error('批量发布清单过大'), { code: 'EINVAL' });
    let handle;
    try {
      handle = await fs.promises.open(manifest, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      const payload = await invoke('move-no-replace-batch', { manifest }, batchTimeoutMs(requests.length));
      const results = Array.isArray(payload?.results) ? payload.results : [];
      const completed = [];
      for (const item of results) {
        const index = Number(item?.index);
        if (!Number.isInteger(index) || index < 0 || index >= requests.length || index !== completed.length) throw Object.assign(new Error('批量文件发布服务返回了无效的结果索引'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', completed });
        if (!item.success) {
          const recoveryPath = item.recoveryPathBase64 ? decodeRecoveryPath(item.recoveryPathBase64, requests[index].source) : item.recoveryPath;
          throw Object.assign(new Error(item.error || '批量文件发布失败'), { code: item.code || 'FILE_PUBLICATION_FAILED', nativeError: item.nativeError, phase: item.phase, failedIndex: index, completed, recoveryPath, recoveryPathBase64: item.recoveryPathBase64, originalMissing: item.originalMissing, deleted: item.deleted, cleanupWarning: item.cleanupWarning, publishedPath: item.publishedPath, published: item.published, publishedConfirmed: item.publishedConfirmed, publicationState: item.publicationState, outcomeUnknown: item.outcomeUnknown, identity: item.identity });
        }
        if (typeof item.identity !== 'string' || !item.identity) throw Object.assign(new Error('批量文件发布服务未返回已发布对象身份'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', completed });
        completed.push({ index, strategy: item.strategy || 'native-batch-move-no-replace', identity: item.identity });
      }
      if (completed.length !== requests.length) throw Object.assign(new Error('批量文件发布服务返回了不完整的结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', completed });
      return completed;
    } catch (error) {
      if (!Array.isArray(error.completed)) error.completed = [];
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.rm(manifest, { force: true }).catch(() => undefined);
    }
  };
  const inspectPathsBatch = async paths => {
    if (!Array.isArray(paths) || paths.length === 0) return [];
    if (paths.length > MAX_BATCH_ITEMS * 2) throw Object.assign(new Error(`单次批量检查不得超过 ${MAX_BATCH_ITEMS * 2} 项`), { code: 'EINVAL' });
    const manifest = path.join(os.tmpdir(), `photoflow-inspection-${process.pid}-${crypto.randomUUID()}.batch`);
    const contents = paths.map((candidate, index) => `${index}\t${Buffer.from(path.resolve(candidate), 'utf8').toString('base64')}`).join('\n');
    if (Buffer.byteLength(contents) > MAX_BATCH_MANIFEST_BYTES) throw Object.assign(new Error('批量检查清单过大'), { code: 'EINVAL' });
    let handle;
    try {
      handle = await fs.promises.open(manifest, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      const payload = await invoke('inspect-path-batch', { manifest });
      const results = Array.isArray(payload?.results) ? payload.results : [];
      if (results.length !== paths.length || results.some((item, index) => Number(item?.index) !== index)) throw Object.assign(new Error('批量身份检查服务返回了不完整结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
      return results;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.rm(manifest, { force: true }).catch(() => undefined);
    }
  };
  const deletePathsBatch = async requests => {
    if (!Array.isArray(requests) || requests.length === 0) return [];
    if (requests.length > MAX_BATCH_ITEMS) throw Object.assign(new Error(`单次安全清理不得超过 ${MAX_BATCH_ITEMS} 项`), { code: 'EINVAL' });
    const manifest = path.join(os.tmpdir(), `photoflow-cleanup-${process.pid}-${crypto.randomUUID()}.batch`);
    const contents = requests.map((request, index) => `${index}\t${Buffer.from(path.resolve(request.path), 'utf8').toString('base64')}\t${Buffer.from(request.identity, 'utf8').toString('base64')}`).join('\n');
    if (Buffer.byteLength(contents) > MAX_BATCH_MANIFEST_BYTES) throw Object.assign(new Error('批量清理清单过大'), { code: 'EINVAL' });
    let handle;
    try {
      handle = await fs.promises.open(manifest, 'wx', 0o600); await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      const payload = await invoke('delete-paths-batch', { manifest });
      const results = Array.isArray(payload?.results) ? payload.results : [];
      if (results.length !== requests.length || results.some((item, index) => Number(item?.index) !== index)) throw Object.assign(new Error('批量安全清理服务返回了不完整结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
      for (let index = 0; index < results.length; index += 1) {
        const encoded = results[index]?.recoveryPathBase64;
        if (!encoded) continue;
        const original = path.resolve(requests[index].path);
        const recoveryPath = decodeRecoveryPath(encoded, original, 'photoflow-quarantine-');
        results[index].recoveryPath = recoveryPath;
      }
      return results;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.rm(manifest, { force: true }).catch(() => undefined);
    }
  };
  const compareDeleteFilesBatch = async requests => {
    if (!Array.isArray(requests) || requests.length === 0) return [];
    if (requests.length > MAX_BATCH_ITEMS) throw Object.assign(new Error(`单次摘要清理不得超过 ${MAX_BATCH_ITEMS} 项`), { code: 'EINVAL' });
    const manifest = path.join(os.tmpdir(), `photoflow-compare-cleanup-${process.pid}-${crypto.randomUUID()}.batch`);
    const rootPath = path.resolve(requests[0]?.rootPath || '');
    if (!path.isAbsolute(rootPath) || requests.some(request => path.resolve(request.rootPath || '') !== rootPath)) throw Object.assign(new Error('批量摘要清理缺少唯一隔离根'), { code: 'EINVAL' });
    const directories = new Map();
    for (const request of requests) for (const directory of request.parentChain || []) {
      const resolved = path.resolve(directory.path); const existing = directories.get(resolved);
      if (typeof directory.identity !== 'string' || !directory.identity || existing && existing !== directory.identity) throw Object.assign(new Error('批量摘要清理父链身份无效或冲突'), { code: 'EINVAL' });
      directories.set(resolved, directory.identity);
    }
    if (!directories.has(rootPath)) throw Object.assign(new Error('批量摘要清理父链缺少隔离根'), { code: 'EINVAL' });
    const header = [`R\t${Buffer.from(rootPath, 'utf8').toString('base64')}`, ...[...directories].map(([directory, identity]) => `D\t${Buffer.from(directory, 'utf8').toString('base64')}\t${Buffer.from(identity, 'utf8').toString('base64')}`)];
    const files = requests.map((request, index) => {
      if (typeof request.identity !== 'string' || !request.identity || !/^[a-f0-9]{64}$/i.test(String(request.sha256 || '')) || !/^\d+$/.test(String(request.size))) throw Object.assign(new Error('批量摘要清理缺少有效身份、大小或 SHA-256'), { code: 'EINVAL' });
      return `F\t${index}\t${Buffer.from(path.resolve(request.path), 'utf8').toString('base64')}\t${Buffer.from(request.identity, 'utf8').toString('base64')}\t${String(request.size)}\t${String(request.sha256).toLowerCase()}`;
    });
    const contents = [...header, ...files].join('\n');
    if (Buffer.byteLength(contents) > MAX_BATCH_MANIFEST_BYTES) throw Object.assign(new Error('批量摘要清理清单过大'), { code: 'EINVAL' });
    let handle;
    try {
      handle = await fs.promises.open(manifest, 'wx', 0o600); await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      const payload = await invoke('compare-delete-files-batch', { manifest, 'manifest-size': Buffer.byteLength(contents), 'manifest-sha256': crypto.createHash('sha256').update(contents).digest('hex') }, batchTimeoutMs(requests.length));
      const results = Array.isArray(payload?.results) ? payload.results : [];
      if (results.length !== requests.length || results.some((item, index) => Number(item?.index) !== index)) throw Object.assign(new Error('批量摘要清理服务返回了不完整结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
      for (let index = 0; index < results.length; index += 1) if (results[index]?.recoveryPathBase64) results[index].recoveryPath = decodeRecoveryPath(results[index].recoveryPathBase64, path.resolve(requests[index].path), 'photoflow-quarantine-');
      return results;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.rm(manifest, { force: true }).catch(() => undefined);
    }
  };
  const copyFilesNativeBatch = async (requests, options = {}) => {
    const deleteSource = options.deleteSource === true;
    if (!Array.isArray(requests) || requests.length === 0) return [];
    if (platform !== 'win32') throw Object.assign(new Error('当前平台不支持单遍原生文件复制'), { code: 'ENOTSUP' });
    if (requests.length > MAX_BATCH_ITEMS) throw Object.assign(new Error(`单次原生复制不得超过 ${MAX_BATCH_ITEMS} 项`), { code: 'EINVAL' });
    const manifest = path.join(os.tmpdir(), `photoflow-fast-copy-${process.pid}-${crypto.randomUUID()}.batch`);
    const contents = requests.map((request, index) => {
      if (typeof request.identity !== 'string' || !request.identity || !/^\d+$/.test(String(request.size)) || !/^-?\d+$/.test(String(request.lastWriteTime)) || !/^-?\d+$/.test(String(request.changeTime))) throw Object.assign(new Error('原生复制缺少有效源快照'), { code: 'EINVAL' });
      return `F\t${index}\t${Buffer.from(path.resolve(request.source), 'utf8').toString('base64')}\t${Buffer.from(path.resolve(request.target), 'utf8').toString('base64')}\t${Buffer.from(request.identity, 'utf8').toString('base64')}\t${request.size}\t${request.lastWriteTime}\t${request.changeTime}`;
    }).join('\n');
    if (Buffer.byteLength(contents) > MAX_BATCH_MANIFEST_BYTES) throw Object.assign(new Error('原生复制清单过大'), { code: 'EINVAL' });
    let handle;
    let control;
    try {
      handle = await fs.promises.open(manifest, 'wx', 0o600); await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      if (options.onProgress || options.waitIfPaused || options.isCancelled) control = await require('./native-copy-control.cjs').createNativeCopyControl(os.tmpdir(), options);
      const operation = deleteSource ? 'copy-cut-files-batch' : 'copy-files-batch';
      const payload = await invoke(operation, { manifest, 'manifest-size': Buffer.byteLength(contents), 'manifest-sha256': crypto.createHash('sha256').update(contents).digest('hex'), ...(options.durable === true ? { durable: 'true' } : {}), ...(control ? { control: control.filePath } : {}), ...(options.resumeState ? { 'resume-path': options.resumeState.path, 'resume-identity': options.resumeState.nativeIdentity } : {}), ...(options.parallelism ? { parallelism: options.parallelism } : {}) }, 30 * 60 * 1000, {
        onProgress: value => { try { options.onProgress?.(value); } catch (error) { control?.fail(error); } },
      });
      const results = Array.isArray(payload?.results) ? payload.results : [];
      const indexed = new Map();
      for (const item of results) {
        const index = Number(item?.index);
        if (!Number.isInteger(index) || index < 0 || index >= requests.length || indexed.has(index)) throw Object.assign(new Error('原生复制服务返回了无效结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', completed: [] });
        indexed.set(index, item);
      }
      const completed = [];
      const failures = [];
      for (const [index, item] of [...indexed].sort((left, right) => left[0] - right[0])) {
        if (!item.success) { failures.push({ index, item }); continue; }
        if (item.sourceDeleted !== deleteSource || typeof item.identity !== 'string' || !/^[a-f0-9]{64}$/i.test(String(item.sha256 || ''))) throw Object.assign(new Error('原生复制服务未返回完整提交凭据'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', completed });
        completed.push({ index, identity: item.identity, sha256: item.sha256, sourceDeleted: deleteSource, published: true, resumedBytes: Number(item.resumedBytes) || 0 });
      }
      // The parallel copy can report more than one failure: every worker that was
      // already running when the first one failed still records its own result.
      // Keeping only the first would let the caller count one published target
      // when several were, so every failure is passed on. The thrown error keeps
      // describing the first failure (its stage is the most advanced one, and its
      // source/destination paths are what existing callers expect), while
      // `failures` carries the whole set with each item's own stage.
      //
      // The native layer names the phase that failed (pre-publication,
      // target-validation or source-cleanup). It is passed through untouched
      // along with the original native code and message: callers decide what to
      // tell the user, and only a confirmed source-cleanup failure may be
      // answered with advice to remove the original.
      if (failures.length) {
        const { index, item } = failures[0];
        throw Object.assign(new Error(item.error || '原生复制失败'), {
          code: item.code || 'FILE_PUBLICATION_FAILED',
          nativeError: item.nativeError || 0,
          stage: typeof item.stage === 'string' ? item.stage : '',
          failedIndex: index,
          failures: failures.map(failure => ({
            index: failure.index,
            stage: typeof failure.item.stage === 'string' ? failure.item.stage : '',
            published: failure.item.published === true,
            sourceDeleted: failure.item.sourceDeleted === true,
            code: failure.item.code || 'FILE_PUBLICATION_FAILED',
            sourcePath: requests[failure.index].source,
            destinationPath: requests[failure.index].target,
          })),
          completed,
          published: item.published === true,
          sourceDeleted: item.sourceDeleted === true,
          destinationPath: requests[index].target,
          sourcePath: requests[index].source,
          identity: item.identity,
          sha256: item.sha256,
        });
      }
      if (completed.length !== requests.length) throw Object.assign(new Error('原生复制服务返回了不完整结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR', completed });
      if (control?.getError()) throw Object.assign(control.getError(), { completed });
      return completed;
    } finally {
      if (control) await control.close().catch(() => undefined);
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.rm(manifest, { force: true }).catch(() => undefined);
    }
  };
  const copyFilesBatch = (requests, options = {}) => copyFilesNativeBatch(requests, { ...options, deleteSource: false, durable: options.durable === true });
  const copyCutFilesBatch = (requests, options = {}) => copyFilesNativeBatch(requests, { ...options, deleteSource: true, durable: true });
  const deleteDirectoriesBatch = async requests => {
    if (!Array.isArray(requests) || requests.length === 0) return [];
    if (requests.length > MAX_BATCH_ITEMS) throw Object.assign(new Error(`单次目录清理不得超过 ${MAX_BATCH_ITEMS} 项`), { code: 'EINVAL' });
    const rootPath = path.resolve(requests[0]?.rootPath || ''); const directories = new Map();
    if (requests.some(request => path.resolve(request.rootPath || '') !== rootPath)) throw Object.assign(new Error('批量目录清理缺少唯一隔离根'), { code: 'EINVAL' });
    for (const request of requests) { for (const directory of request.parentChain || []) { const resolved = path.resolve(directory.path); const existing = directories.get(resolved); if (typeof directory.identity !== 'string' || !directory.identity || existing && existing !== directory.identity) throw Object.assign(new Error('批量目录清理父链身份无效或冲突'), { code: 'EINVAL' }); directories.set(resolved, directory.identity); } const target = path.resolve(request.path); const existing = directories.get(target); if (typeof request.identity !== 'string' || !request.identity || existing && existing !== request.identity) throw Object.assign(new Error('批量目录清理目标身份无效或冲突'), { code: 'EINVAL' }); directories.set(target, request.identity); }
    if (!directories.has(rootPath)) throw Object.assign(new Error('批量目录清理缺少隔离根身份'), { code: 'EINVAL' });
    const lines = [`R\t${Buffer.from(rootPath).toString('base64')}`, ...[...directories].map(([directory, identity]) => `D\t${Buffer.from(directory).toString('base64')}\t${Buffer.from(identity).toString('base64')}`), ...requests.map((request, index) => `T\t${index}\t${Buffer.from(path.resolve(request.path)).toString('base64')}\t${Buffer.from(request.identity).toString('base64')}`)];
    const contents = lines.join('\n'); if (Buffer.byteLength(contents) > MAX_BATCH_MANIFEST_BYTES) throw Object.assign(new Error('批量目录清理清单过大'), { code: 'EINVAL' });
    const manifest = path.join(os.tmpdir(), `photoflow-directory-cleanup-${process.pid}-${crypto.randomUUID()}.batch`); let handle;
    try { handle = await fs.promises.open(manifest, 'wx', 0o600); await handle.writeFile(contents); await handle.sync(); await handle.close(); handle = null; const payload = await invoke('delete-directories-batch', { manifest, 'manifest-size': Buffer.byteLength(contents), 'manifest-sha256': crypto.createHash('sha256').update(contents).digest('hex') }, batchTimeoutMs(requests.length)); const results = Array.isArray(payload?.results) ? payload.results : []; if (results.length !== requests.length || results.some((item, index) => Number(item?.index) !== index)) throw Object.assign(new Error('批量目录清理服务返回了不完整结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' }); return results; }
    finally { if (handle) await handle.close().catch(() => undefined); await fs.promises.rm(manifest, { force: true }).catch(() => undefined); }
  };
  const createPortableQuarantine = async candidate => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const directory = path.join(path.dirname(candidate), `.photoflow-quarantine-${crypto.randomUUID()}`);
      try { await fs.promises.mkdir(directory, { mode: 0o700 }); const directoryHandle = process.platform === 'win32' ? null : await fs.promises.open(directory, 'r'); const directoryStat = directoryHandle ? await directoryHandle.stat() : await fs.promises.lstat(directory); return { directory, recovery: path.join(directory, path.basename(candidate)), directoryHandle, directoryIdentity: `${directoryStat.dev}:${directoryStat.ino}` }; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw Object.assign(new Error('无法创建私有恢复目录'), { code: 'EEXIST' });
  };
  const inspectPortable = async targetPath => { const stat = await fs.promises.lstat(targetPath); return { success: true, identity: `${stat.dev}:${stat.ino}`, directory: stat.isDirectory() }; };
  const closeQuarantineDirectory = async quarantine => { if (quarantine.directoryHandle) { await quarantine.directoryHandle.close().catch(() => undefined); quarantine.directoryHandle = null; } };
  const assertPrivateDirectory = async quarantine => { const linked = await fs.promises.lstat(quarantine.directory); const held = quarantine.directoryHandle ? await quarantine.directoryHandle.stat() : linked; if (`${held.dev}:${held.ino}` !== quarantine.directoryIdentity || `${linked.dev}:${linked.ino}` !== quarantine.directoryIdentity) throw Object.assign(new Error('私有恢复目录身份已变化'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); };
  const moveToQuarantine = async (original, quarantine) => { try { return await moveNoReplace(original, quarantine.recovery); } catch (error) { if (fs.existsSync(quarantine.recovery)) { error.recoveryPath = quarantine.recovery; error.originalMissing = !fs.existsSync(original); } else { await closeQuarantineDirectory(quarantine); await fs.promises.rmdir(quarantine.directory).catch(() => undefined); } await closeQuarantineDirectory(quarantine); throw error; } };
  const digestHandle = async handle => { const hash = crypto.createHash('sha256'); const stream = handle.createReadStream({ autoClose: false, start: 0 }); for await (const chunk of stream) hash.update(chunk); return hash.digest('hex'); };
  const assertRecoveryIdentity = async (handle, recovery, identity, label) => { const [held, linked] = await Promise.all([handle.stat(), fs.promises.lstat(recovery)]); assertPortableIdentity(held, identity, label); if (`${linked.dev}:${linked.ino}` !== `${held.dev}:${held.ino}`) throw Object.assign(new Error(`${label}私有恢复路径身份已变化`), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); return held; };
  const assertPortableIdentity = (stat, identity, label) => { if (!identity || `${stat.dev}:${stat.ino}` !== identity) throw Object.assign(new Error(`${label}身份已变化`), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); };
  const syncPortableDirectory = async directory => { if (process.platform === 'win32') return; const handle = await fs.promises.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } };
  const finalizePortableDeletion = async (quarantine, original) => { await portableFaultInjector('after-unlink-before-private-rmdir', { quarantine, original }); if (quarantine.directoryHandle) await quarantine.directoryHandle.sync(); await closeQuarantineDirectory(quarantine); await fs.promises.rmdir(quarantine.directory); await portableFaultInjector('after-private-rmdir-before-parent-fsync', { quarantine, original }); await syncPortableDirectory(path.dirname(original)); };
  const annotatePortableCleanupFailure = (error, deleted, quarantine, original) => { if (deleted) { error.deleted = true; error.outcomeUnknown = true; error.cleanupWarning = true; error.phase = 'post-unlink-cleanup'; error.recoveryPath = undefined; } else error.recoveryPath = fs.existsSync(quarantine.recovery) ? quarantine.recovery : undefined; error.originalMissing = !fs.existsSync(original); return error; };
  const portableCompareDelete = async ({ target, sha256, size, identity }) => { const resolved = path.resolve(target); const quarantine = await createPortableQuarantine(resolved); let handle; let deleted = false; await moveToQuarantine(resolved, quarantine); try { handle = await fs.promises.open(quarantine.recovery, 'r'); const stat = await assertRecoveryIdentity(handle, quarantine.recovery, identity, '补偿目标'); if (!stat.isFile() || stat.size !== Number(size) || await digestHandle(handle) !== sha256) throw Object.assign(new Error('补偿目标身份或摘要不匹配'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); await assertPrivateDirectory(quarantine); await assertRecoveryIdentity(handle, quarantine.recovery, identity, '补偿目标'); await fs.promises.unlink(quarantine.recovery); deleted = true; await handle.close(); handle = null; await finalizePortableDeletion(quarantine, resolved); return { success: true, deleted: true }; } catch (error) { if (handle) await handle.close().catch(() => undefined); await closeQuarantineDirectory(quarantine); throw annotatePortableCleanupFailure(error, deleted, quarantine, resolved); } };
  const portableCommitTreeFile = async ({ source, target, sha256, size, identity }) => { const resolved = path.resolve(source); const quarantine = await createPortableQuarantine(resolved); let handle; let deleted = false; await moveToQuarantine(resolved, quarantine); try { handle = await fs.promises.open(quarantine.recovery, 'r'); const sourceStat = await assertRecoveryIdentity(handle, quarantine.recovery, identity, '跨卷源文件'); const [targetStat, sourceHash, targetHash] = await Promise.all([fs.promises.stat(target), digestHandle(handle), digest(target)]); if (sourceStat.size !== Number(size) || targetStat.size !== Number(size) || sourceHash !== sha256 || targetHash !== sha256) throw Object.assign(new Error('跨卷文件身份或摘要不匹配'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); await assertPrivateDirectory(quarantine); await assertRecoveryIdentity(handle, quarantine.recovery, identity, '跨卷源文件'); await fs.promises.unlink(quarantine.recovery); deleted = true; await handle.close(); handle = null; await finalizePortableDeletion(quarantine, resolved); return { success: true, deleted: true }; } catch (error) { if (handle) await handle.close().catch(() => undefined); await closeQuarantineDirectory(quarantine); throw annotatePortableCleanupFailure(error, deleted, quarantine, resolved); } };
  const portableDeleteDirectory = async ({ source, identity }) => { const resolved = path.resolve(source); const quarantine = await createPortableQuarantine(resolved); let handle; let deleted = false; await moveToQuarantine(resolved, quarantine); try { handle = await fs.promises.open(quarantine.recovery, 'r'); const stat = await assertRecoveryIdentity(handle, quarantine.recovery, identity, '源目录'); if (!stat.isDirectory() || (await fs.promises.readdir(quarantine.recovery)).length) throw Object.assign(new Error('源目录身份变化或不为空'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' }); await assertPrivateDirectory(quarantine); await assertRecoveryIdentity(handle, quarantine.recovery, identity, '源目录'); await fs.promises.rmdir(quarantine.recovery); deleted = true; await handle.close(); handle = null; await finalizePortableDeletion(quarantine, resolved); return { success: true, deleted: true }; } catch (error) { if (handle) await handle.close().catch(() => undefined); await closeQuarantineDirectory(quarantine); throw annotatePortableCleanupFailure(error, deleted, quarantine, resolved); } };
  return {
    warmRename: () => renameWorker?.warm(),
    stop: () => Promise.all([renameWorker?.stop(), ...Object.values(pools || {}).flat().map(slot => slot.worker.stop())]),
    moveNoReplace,
    moveNoReplaceBatch,
    inspectPathsBatch,
    deletePathsBatch,
    compareDeleteFilesBatch,
    ...(platform === 'win32' ? { copyFilesBatch, copyCutFilesBatch } : {}),
    deleteDirectoriesBatch,
    commitCrossVolumeFile: async request => {
      return invoke('commit-cross-volume-file', { source: path.resolve(request.source), staged: path.resolve(request.staged), target: path.resolve(request.target), sha256: request.sha256, size: request.size, 'source-identity': request.sourceIdentity }, 30 * 60 * 1000);
    },
    compareDeleteFile: request => invoke('compare-delete-file', { target: path.resolve(request.target), sha256: request.sha256, size: request.size, identity: request.identity }),
    inspectPath: targetPath => invoke('inspect-path', { path: path.resolve(targetPath) }),
    commitTreeFile: request => platform === 'win32' ? invoke('commit-tree-file', { source: path.resolve(request.source), target: path.resolve(request.target), sha256: request.sha256, size: request.size, identity: request.identity }) : portableCommitTreeFile(request),
    deleteEmptyDirectory: request => platform === 'win32' ? invoke('delete-empty-directory', { source: path.resolve(request.source), identity: request.identity }) : portableDeleteDirectory(request),
    nativeAvailable: () => Boolean(invokeOverride) || fs.existsSync(executable()), platform, executable,
  };
};
module.exports = { createFilePublicationService, publicationBatchTimeoutMs, runPublicationJson };
