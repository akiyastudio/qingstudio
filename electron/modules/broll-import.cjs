const { localizeDialogOptions } = require("../services/localization.cjs");
const { t: translateNative } = require("../services/localization.cjs");
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { terminateAndWait } = require('../infrastructure/process-termination.cjs');
const { samePathIdentity } = require('../services/file-identity-service.cjs');
const {
  CANCELLED_CODE,
  assertDiskSpace,
  assertInside,
  assertRegularFile,
  copyFileAtomic,
  moveFileAtomic,
  publishPathNoClobber,
  releaseCleanupOwnership,
  uniqueDestination,
} = require('../services/file-transfer-service.cjs');
const { createProjectFileTask } = require('../services/project-file-task-service.cjs');

const BROLL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.hif', '.mp4', '.mov', '.avi', '.m4v', '.mkv', '.mpeg', '.mpg', '.mts', '.m2ts']);
const BROLL_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.m4v', '.mkv', '.mpeg', '.mpg', '.mts', '.m2ts']);
const FOUR_GB = 4 * 1024 * 1024 * 1024;
const MAX_BROLL_FILES = 500;
const WORKER_STDOUT_LIMIT = 2 * 1024 * 1024;
const WORKER_DEADLINE_MS = 6 * 60 * 60 * 1000;
const WORKER_CANCEL_GRACE_MS = 1500;
const WORKER_TERMINATION_MS = 5000;
const DISK_SAFETY_RATIO = 1.1;
const DISK_SAFETY_BYTES = 64 * 1024 * 1024;
let brollProcessSequence = 0;

const isReliableSameDevice = (sourceDev, destinationDev) => {
  const source = String(sourceDev ?? '');
  const destination = String(destinationDev ?? '');
  return Boolean(source && source !== '0' && destination && destination !== '0' && source === destination);
};

const estimateBrollDiskRequirements = ({ sources, preserveOriginal, splitLargeFiles, transcodeVideos, transcodeSettings, destinationDev }) => {
  const shouldSplit = item => splitLargeFiles && BROLL_VIDEO_EXTENSIONS.has(item.extension) && item.stat.size > FOUR_GB;
  const copyBytes = sources.reduce((sum, item) => sum + (preserveOriginal && !shouldSplit(item) ? item.stat.size : 0), 0);
  const moveBytes = sources.reduce((sum, item) => {
    const provenSameDevice = isReliableSameDevice(item.stat.dev, destinationDev);
    return sum + (!preserveOriginal && !shouldSplit(item) && !provenSameDevice ? item.stat.size : 0);
  }, 0);
  const splitBytes = sources.reduce((sum, item) => sum + (shouldSplit(item) ? item.stat.size : 0), 0);
  const explicitBitrate = Number(transcodeSettings?.videoBitrateMbps);
  // Exact bitrate/duration preflight remains authoritative in the worker.
  // Keep host-side admission conservative without multiplying small jobs into
  // false ENOSPC failures merely because a high bitrate was selected.
  const transcodeMultiplier = explicitBitrate > 0 ? 1.5 : 1.25;
  const transcodeInputBytes = sources.reduce((sum, item) => sum + (transcodeVideos && BROLL_VIDEO_EXTENSIONS.has(item.extension) ? item.stat.size : 0), 0);
  // Include one input-sized fallback because private staging prefers a
  // hardlink but must safely fall back to a real copy.
  const transcodeBytes = Math.ceil(transcodeInputBytes * (transcodeMultiplier + 1));
  const rawTotalBytes = copyBytes + moveBytes + splitBytes + transcodeBytes;
  return {
    copyBytes, moveBytes, splitBytes, transcodeBytes, rawTotalBytes,
    requiredBytes: rawTotalBytes > 0 ? Math.ceil(rawTotalBytes * DISK_SAFETY_RATIO + DISK_SAFETY_BYTES) : 0,
  };
};

const splitFamilyExists = async (directoryPath, stem, extension) => {
  const prefix = `${stem}_part`;
  const normalizedPrefix = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  const normalizedExtension = String(extension || '').toLowerCase();
  const directory = await fs.promises.opendir(directoryPath);
  try {
    let entry;
    while ((entry = await directory.read()) !== null) {
      const comparableName = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
      if (comparableName.startsWith(normalizedPrefix) && path.extname(entry.name).toLowerCase() === normalizedExtension) return true;
    }
    return false;
  } finally { await directory.close().catch(() => undefined); }
};

const uniqueSplitDestination = async (directoryPath, fileName, reserved) => {
  let target = uniqueDestination(directoryPath, fileName, reserved);
  while (await splitFamilyExists(directoryPath, path.parse(target).name, path.extname(target))) {
    target = uniqueDestination(directoryPath, fileName, reserved);
  }
  return target;
};

const launchWorker = (processSupervisor, prefix, command, args) => {
  if (processSupervisor) {
    const managed = processSupervisor.launch({
    id: `python:${prefix}:${++brollProcessSequence}`,
      kind: 'python-job', command, args,
      options: { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }, ephemeral: true,
    });
    return { child: managed.child, managed };
  }
  return { child: spawn(command, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }), managed: null };
};

const terminateWorkerTree = async ({ child, managed }, deadlineAt) => {
  if (!child) return;
  // On Windows the supervisor / terminateAndWait owns the tree kill and its
  // exit fence. A preliminary taskkill races that fence and can make the
  // subsequent confirmed termination fail with "process not found".
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* process group may already be gone */ }
  }
  if (managed?.stop) {
    try {
      await managed.stop('broll-worker-termination', { timeoutMs: Math.max(1, deadlineAt - Date.now()), release: true });
      if (process.platform !== 'win32' && child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group exited */ }
      return;
    }
    catch { /* retain the lower-level confirmed-exit fallback */ }
  }
  await terminateAndWait(child, deadlineAt);
  if (process.platform !== 'win32' && child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group exited */ }
};

const cancelledError = () => Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const insidePath = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const identityKey = (stat, realPath) => {
  const dev = stat?.dev;
  const ino = stat?.ino;
  if (dev !== undefined && ino !== undefined && String(ino) !== '0') {
    const birth = stat?.birthtimeNs ?? stat?.birthtimeMs ?? '';
    const ctime = stat?.ctimeNs ?? stat?.ctimeMs ?? '';
    const size = stat?.size ?? '';
    return `${String(dev)}:${String(ino)}:${String(birth)}:${String(ctime)}:${String(size)}`;
  }
  const fallback = [
    stat?.size ?? '', stat?.mtimeNs ?? stat?.mtimeMs ?? '', stat?.birthtimeNs ?? stat?.birthtimeMs ?? '',
    stat?.ctimeNs ?? stat?.ctimeMs ?? '', stat?.mode ?? '', stat?.isDirectory?.() ? 'directory' : stat?.isSymbolicLink?.() ? 'symlink' : 'file',
  ];
  return `path:${pathKey(realPath)}:${fallback.map(String).join(':')}`;
};
const throwIfCancelled = isCancelled => { if (isCancelled?.()) throw cancelledError(); };
const pathEntryExists = candidate => { try { fs.lstatSync(candidate); return true; } catch { return false; } };

const expandBrollSourcePaths = async (selectedPaths, { isCancelled = () => false, waitIfPaused = async () => undefined, maxFiles = MAX_BROLL_FILES } = {}) => {
  const discovered = [];
  const identities = new Set();
  const addFile = async filePath => {
    throwIfCancelled(isCancelled);
    await waitIfPaused();
    const resolved = path.resolve(filePath);
    const stat = await fs.promises.lstat(resolved, { bigint: true });
    if (!stat.isFile()) return;
    const realPath = await fs.promises.realpath(resolved);
    const identity = identityKey(stat, realPath);
    if (identities.has(identity)) return;
    identities.add(identity);
    discovered.push(realPath);
    if (discovered.length > maxFiles) throw new Error(`一次最多导入 ${maxFiles} 个花絮文件`);
  };
  const directories = [];
  for (const selectedPath of selectedPaths) {
    throwIfCancelled(isCancelled);
    await waitIfPaused();
    const resolved = path.resolve(selectedPath);
    const stat = await fs.promises.lstat(resolved);
    if (stat.isDirectory()) {
      directories.push(resolved);
      continue;
    }
    if (!stat.isFile()) throw new Error(`不支持导入此文件类型：${path.basename(resolved)}`);
    if (!BROLL_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error(`不支持的花絮文件格式：${path.basename(resolved)}`);
    }
    await addFile(resolved);
  }
  while (directories.length) {
    throwIfCancelled(isCancelled);
    await waitIfPaused();
    const current = directories.pop();
    const childDirectories = [];
    const directory = await fs.promises.opendir(current);
    try {
      let entry;
      while ((entry = await directory.read()) !== null) {
        throwIfCancelled(isCancelled);
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) childDirectories.push(candidate);
        else if (entry.isFile() && BROLL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) await addFile(candidate);
      }
    } finally { await directory.close().catch(() => undefined); }
    // The current Dir is closed before descendants enter the work stack, so
    // arbitrarily deep trees retain at most one live directory handle.
    directories.push(...childDirectories);
  }
  return discovered.sort((left, right) => left.localeCompare(right));
};

const snapshotDirectory = async directory => {
  const snapshot = new Map();
  for (const name of await fs.promises.readdir(directory)) {
    const candidate = path.join(directory, name);
    try {
      const stat = await fs.promises.lstat(candidate, { bigint: true });
      let identityPath = candidate;
      if (!stat.isSymbolicLink()) try { identityPath = await fs.promises.realpath(candidate); } catch { /* the name still belongs to the baseline */ }
      snapshot.set(pathKey(candidate), identityKey(stat, identityPath));
    } catch {
      // Even an unreadable entry name is pre-existing and must never become
      // cleanup ownership for this attempt.
      snapshot.set(pathKey(candidate), 'baseline-unreadable');
    }
  }
  return snapshot;
};

const captureEntryIdentitySync = candidate => {
  const resolved = path.resolve(candidate);
  const stat = fs.lstatSync(resolved, { bigint: true });
  let identityPath = resolved;
  if (!stat.isSymbolicLink()) try { identityPath = fs.realpathSync(resolved); } catch { /* retain strict lstat identity */ }
  return { path: resolved, identity: identityKey(stat, identityPath), size: stat.size, fileIdentity: fileIdentityFromStat(resolved, stat) };
};

const fileIdentityFromStat = (filePath, stat) => ({
  path: path.resolve(filePath),
  device: String(stat.dev ?? 0),
  inode: String(stat.ino ?? 0),
  size: String(stat.size ?? 0),
  modifiedNs: String(stat.mtimeNs ?? BigInt(Math.trunc(Number(stat.mtimeMs || 0) * 1e6))),
  directory: stat.isDirectory(),
});

const claimRegularFile = async (candidate, root, before = new Map()) => {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('媒体 worker 返回了无效输出路径');
  const resolved = path.resolve(candidate);
  const rootReal = await fs.promises.realpath(root);
  const stat = await fs.promises.lstat(resolved, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`媒体 worker 输出不是普通文件：${path.basename(resolved)}`);
  const real = await fs.promises.realpath(resolved);
  if (!insidePath(rootReal, real)) throw new Error(`媒体 worker 输出越出目标目录：${path.basename(resolved)}`);
  const key = pathKey(resolved);
  if (before.has(key)) throw new Error(`媒体 worker 返回了不属于本次任务的文件：${path.basename(resolved)}`);
  return { path: resolved, identity: identityKey(stat, real), size: stat.size, fileIdentity: fileIdentityFromStat(resolved, stat) };
};

const ownedRegularFile = async (candidate, root, before) => {
  const owned = await claimRegularFile(candidate, root, before);
  const resolved = owned.path;
  if (owned.size <= 0n) throw new Error(`媒体 worker 生成了空文件：${path.basename(resolved)}`);
  if (!BROLL_VIDEO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error(`媒体 worker 生成了无效视频类型：${path.basename(resolved)}`);
  return owned;
};

const removeOwnedFile = async owned => {
  if (!owned?.path || !owned.identity) return false;
  try {
    if (owned.fileIdentity) {
      if (!await samePathIdentity(owned.path, owned.fileIdentity)) return false;
      if (owned.identity.startsWith('publication:')) {
        await fs.promises.rm(owned.path, { force: true });
        return true;
      }
    }
    const stat = await fs.promises.lstat(owned.path, { bigint: true });
    const identityPath = stat.isSymbolicLink() ? owned.path : await fs.promises.realpath(owned.path);
    const currentIdentity = identityKey(stat, identityPath);
    if (currentIdentity !== owned.identity) return false;
    await fs.promises.rm(owned.path, { recursive: stat.isDirectory(), force: true });
    return true;
  } catch { return false; }
};

const pathStillOwned = async owned => {
  try {
    if (owned.fileIdentity) {
      if (!await samePathIdentity(owned.path, owned.fileIdentity)) return false;
      if (owned.identity.startsWith('publication:')) return true;
    }
    const stat = await fs.promises.lstat(owned.path, { bigint: true });
    const identityPath = stat.isSymbolicLink() ? owned.path : await fs.promises.realpath(owned.path);
    return identityKey(stat, identityPath) === owned.identity;
  } catch { return false; }
};

const checkpointMoves = records => records.map(record => ({
  source: record.source,
  destination: record.destination,
  state: record.state,
  sourceIdentity: record.sourceOwnership.identity,
  sourceSize: String(record.sourceOwnership.size),
}));

const undoIdentities = ownedPaths => Object.fromEntries(ownedPaths.map(owned => [path.resolve(owned.path), {
  ...owned.fileIdentity,
  // The shared undo verifier otherwise treats a reused non-zero inode as
  // sufficient. Force its size+mtime branch so replace-in-place during the
  // asynchronous undo persistence window is rejected.
  device: '0', inode: '0',
}]));
const invalidateStoredUndo = (stored, reason) => {
  if (!stored || typeof stored !== 'object') return false;
  stored.kind = 'remove-created';
  stored.paths = [];
  stored.moves = [];
  stored.identities = {};
  stored.label = '已失效的花絮导入（安全空操作）';
  stored.metadata = { ...(stored.metadata || {}), invalidated: true, invalidationReason: reason };
  return true;
};
const sameStableFileId = (left, right) => left?.device !== '0' && left?.inode !== '0'
  && right?.device !== '0' && right?.inode !== '0'
  && left.device === right.device && left.inode === right.inode && left.directory === right.directory;
const sameCapturedFileIdentity = (left, right) => sameStableFileId(left, right)
  || (left?.size === right?.size && left?.modifiedNs === right?.modifiedNs && left?.directory === right?.directory);

const newOwnedFiles = async (directory, before, predicate = () => true) => {
  const owned = [];
  for (const name of await fs.promises.readdir(directory).catch(() => [])) {
    const candidate = path.join(directory, name);
    if (before.has(pathKey(candidate)) || !predicate(name)) continue;
    try { owned.push(await ownedRegularFile(candidate, directory, before)); } catch { /* invalid entries are not safe to claim */ }
  }
  return owned;
};

const ownedFromPublication = async (target, publication) => {
  const stat = await fs.promises.lstat(target, { bigint: true });
  const real = await fs.promises.realpath(target);
  return {
    path: path.resolve(target), identity: identityKey(stat, real), size: stat.size,
    fileIdentity: publication.identity || fileIdentityFromStat(target, stat), nativeIdentity: publication.nativeIdentity,
  };
};

const ownedPublicationFallback = (target, publication) => ({
  path: path.resolve(target),
  identity: `publication:${publication.identity?.device || ''}:${publication.identity?.inode || ''}:${publication.identity?.size || ''}:${publication.identity?.modifiedNs || ''}`,
  size: BigInt(publication.identity?.size || 0), fileIdentity: publication.identity, nativeIdentity: publication.nativeIdentity,
});

const publishStagedFile = async (stagedOwned, target) => {
  if (!await pathStillOwned(stagedOwned)) throw new Error(`媒体 staging 产物在发布前已被替换：${path.basename(stagedOwned.path)}`);
  const publication = await publishPathNoClobber(stagedOwned.path, target);
  try { return await ownedFromPublication(target, publication); }
  catch (error) { error.publishedOwned = ownedPublicationFallback(target, publication); throw error; }
};

const runJsonLineWorker = ({ getRunConfig, processSupervisor, prefix, script, args, label, onMessage, isCancelled, deadlineMs = WORKER_DEADLINE_MS, stdoutLimit = WORKER_STDOUT_LIMIT, cancelGraceMs = WORKER_CANCEL_GRACE_MS }) => new Promise((resolve, reject) => {
  const cancelFile = path.join(os.tmpdir(), `photoflow-broll-${crypto.randomUUID()}.cancel`);
  let workerProcess;
  let child;
  try {
    const runConfig = getRunConfig(script, [...args, '--cancel_file', cancelFile]);
    workerProcess = launchWorker(processSupervisor, prefix, runConfig.command, runConfig.args);
    child = workerProcess.child;
    if (!child?.stdout || !child?.stderr) throw new Error(`${label}进程未正确启动`);
  } catch (error) {
    try { fs.rmSync(cancelFile, { force: true }); } catch { /* no worker owns the file */ }
    reject(error);
    return;
  }
  const deadlineAt = Date.now() + Math.max(1, deadlineMs);
  let buffer = '';
  let stderr = '';
  let stdoutBytes = 0;
  let reportedError = '';
  let success = false;
  let settled = false;
  let terminating = false;
  let cancelRequested = false;
  let graceTimer = null;
  const cleanup = () => {
    clearTimeout(deadlineTimer);
    clearInterval(cancelTimer);
    clearTimeout(graceTimer);
    try { fs.rmSync(cancelFile, { force: true }); } catch { /* best effort after worker exit */ }
  };
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback(value);
  };
  const fail = error => finish(reject, error);
  const terminateThenFail = error => {
    if (settled || terminating) return;
    terminating = true;
    void terminateWorkerTree(workerProcess, Date.now() + WORKER_TERMINATION_MS).then(() => fail(error), fail);
  };
  const consumeLine = line => {
    if (!line.trim()) return;
    let payload;
    try { payload = JSON.parse(line); }
    catch { throw Object.assign(new Error(`${label} 返回了非法 JSON 行`), { code: 'BROLL_WORKER_PROTOCOL' }); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.type !== 'string') {
      throw Object.assign(new Error(`${label} 返回了无效 JSON 消息`), { code: 'BROLL_WORKER_PROTOCOL' });
    }
    if (payload.type === 'error') reportedError = payload.message || `${label}失败`;
    if (payload.type === 'success') success = true;
    onMessage?.(payload);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => {
    if (settled || terminating) return;
    stdoutBytes += Buffer.byteLength(data, 'utf8');
    if (stdoutBytes > stdoutLimit) return terminateThenFail(Object.assign(new Error(`${label} 输出超过安全上限`), { code: 'BROLL_WORKER_STDOUT_LIMIT' }));
    const lines = (buffer + data).split(/\r?\n/);
    buffer = lines.pop() || '';
    try { for (const line of lines) consumeLine(line); } catch (error) { terminateThenFail(error); }
  });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  child.once('error', error => terminateThenFail(error));
  child.once('close', code => {
    if (terminating || settled) return;
    void (async () => {
      if (buffer.trim()) consumeLine(buffer);
      if (cancelRequested || isCancelled?.()) throw cancelledError();
      if (code !== 0 || reportedError) throw new Error(reportedError || stderr.trim() || `${label}进程退出，代码 ${code}`);
      if (!success) throw new Error(`${label}未返回成功消息`);
      return { code };
    })().then(value => finish(resolve, value), fail);
  });
  const requestCancel = () => {
    if (cancelRequested || settled || terminating) return;
    cancelRequested = true;
    try { fs.writeFileSync(cancelFile, 'cancelled'); } catch (error) { return terminateThenFail(error); }
    graceTimer = setTimeout(() => terminateThenFail(cancelledError()), Math.max(0, cancelGraceMs));
    graceTimer.unref?.();
  };
  const cancelTimer = setInterval(() => { if (isCancelled?.()) requestCancel(); }, 100);
  cancelTimer.unref?.();
  const deadlineTimer = setTimeout(() => terminateThenFail(Object.assign(new Error(`${label}处理超时`), { code: 'BROLL_WORKER_TIMEOUT' })), Math.max(1, deadlineAt - Date.now()));
  deadlineTimer.unref?.();
  if (isCancelled?.()) requestCancel();
});

const runSplitter = async ({ getRunConfig, processSupervisor, source, outputDirectory, outputStem, extension, onProgress, isCancelled, workerOptions = {} }) => {
  const prefix = `${outputStem}_part`;
  const stagingDirectory = await fs.promises.mkdtemp(path.join(outputDirectory, '.photoflow-broll-split-'));
  const before = await snapshotDirectory(stagingDirectory);
  const predicate = name => name.startsWith(prefix) && path.extname(name).toLowerCase() === extension;
  const published = [];
  try {
    await runJsonLineWorker({
      getRunConfig, processSupervisor, prefix: 'broll-split', script: 'cut_video.py',
      args: [source, '--output-dir', stagingDirectory, '--output-stem', outputStem], label: '视频分割', isCancelled, ...workerOptions,
      onMessage: payload => {
        if (Number.isFinite(Number(payload.progress))) onProgress(Number(payload.progress), payload.message || '正在分割视频');
      },
    });
    const owned = await newOwnedFiles(stagingDirectory, before, predicate);
    owned.sort((left, right) => left.path.localeCompare(right.path));
    if (owned.length < 2) throw new Error(`视频分割未生成完整分段：${path.basename(source)}`);
    for (const staged of owned) published.push(await publishStagedFile(staged, path.join(outputDirectory, path.basename(staged.path))));
    return published;
  } catch (error) {
    if (error.publishedOwned) published.push(error.publishedOwned);
    for (const owned of [...published].reverse()) await removeOwnedFile(owned);
    throw error;
  } finally { await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined); }
};

const runTranscoder = async ({ getRunConfig, processSupervisor, source, outputDirectory = path.dirname(source), settings, onProgress, isCancelled, workerOptions = {} }) => {
  const stagingDirectory = await fs.promises.mkdtemp(path.join(outputDirectory, '.photoflow-broll-transcode-'));
  const stagedSource = path.join(stagingDirectory, path.basename(source));
  let published = null;
  try {
    throwIfCancelled(isCancelled);
    try { await fs.promises.link(source, stagedSource); }
    catch { await fs.promises.copyFile(source, stagedSource, fs.constants.COPYFILE_EXCL); }
    const before = await snapshotDirectory(stagingDirectory);
    const args = [
    stagedSource,
    '--container', settings?.container || 'mp4',
    '--video-mode', settings?.videoMode || 'h264',
    '--quality', settings?.quality || 'balanced',
    '--resolution', settings?.resolution || 'original',
    '--frame-rate', settings?.frameRate || 'original',
    '--audio-mode', settings?.audioMode || 'aac',
    '--subtitle-mode', settings?.subtitleMode || 'copy',
    '--color-mode', settings?.colorMode || 'auto',
    '--bit-depth', settings?.bitDepth || 'auto',
    '--frame-rate-mode', settings?.frameRateMode || 'preserve',
    '--rotation', settings?.rotation || 'auto',
    '--aspect-mode', settings?.aspectMode || 'preserve',
    '--audio-track', settings?.audioTrack || 'all',
    '--audio-bitrate-kbps', String(settings?.audioBitrateKbps || 192),
    '--encoder-preset', settings?.encoderPreset || 'balanced',
    '--retry-count', '1',
    ...(Number(settings?.videoBitrateMbps) > 0 ? ['--video-bitrate-mbps', String(settings.videoBitrateMbps)] : []),
    '--output-mode', 'new',
    ];
    let output = '';
    await runJsonLineWorker({
      getRunConfig, processSupervisor, prefix: 'broll-transcode', script: 'ffmpeg_transcode.py', args,
      label: '视频转码', isCancelled, ...workerOptions,
      onMessage: payload => {
        if (Number.isFinite(Number(payload.progress))) onProgress(Number(payload.progress), payload.message || '正在转码视频');
        if (payload.type === 'success' && Array.isArray(payload.outputs) && payload.outputs.length === 1) output = payload.outputs[0];
      },
    });
    const owned = await ownedRegularFile(output, stagingDirectory, before);
    const target = uniqueDestination(outputDirectory, path.basename(owned.path), new Set());
    published = await publishStagedFile(owned, target);
    return published;
  } catch (error) {
    if (error.publishedOwned) published = error.publishedOwned;
    if (published) await removeOwnedFile(published);
    throw error;
  } finally { await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined); }
};

const registerBrollImportIpc = ({
  ipcMain,
  dialog,
  shell,
  recycleBinService,
  getMainWindow,
  getProjectPath,
  getRunConfig,
  processSupervisor,
  writeLog,
  pushUndoOperation,
  activeOperations,
  backgroundTasks,
  getTelemetry,
}) => {
  ipcMain.handle('choose-broll-source-files', async () => {
    const choice = await dialog.showOpenDialog(getMainWindow(), localizeDialogOptions({
      title: translateNative("native.2c97181c8cf4"),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: translateNative("native.c6133c6932ee"), extensions: [...BROLL_EXTENSIONS].map(value => value.slice(1)) }],
    }));
    return choice.canceled ? { cancelled: true, paths: [] } : { paths: choice.filePaths };
  });

  ipcMain.handle('workspace-import-broll', async (event, workspacePath, status, projectName, options = {}) => {
    const operationId = crypto.randomUUID();
    let taskNotificationOwned = false;
    let job = { cancelled: false, finishing: false };
    let task = null;
    const publish = payload => task?.publish(payload);
    const createdPaths = [];
    const createdOwnedPaths = [];
    const moves = [];
    const moveOwnership = [];
    const moveRecords = [];
    let committed = false;
    let committedResponse = null;
    let undoPersisted = false;
    let persistedUndoEntry = null;
    const logSafely = (...args) => { try { writeLog(...args); } catch { /* logging cannot change transaction state */ } };
    try {
      const deleteSourceAfterImport = options?.deleteSourceAfterImport === true;
      const preserveOriginal = !deleteSourceAfterImport;
      const splitLargeFiles = Boolean(options?.splitVideosOnImport ?? options?.splitLargeFiles);
      const transcodeVideos = Boolean(options?.transcodeVideosOnImport);
      const transcodeSettings = options?.transcodeSettings || {};
      const projectPath = path.resolve(getProjectPath(workspacePath, status, projectName));
      let sourcePaths = Array.isArray(options?.sourcePaths) ? options.sourcePaths.map(source => String(source)) : [];
      if (!sourcePaths.length) {
        const choice = await dialog.showOpenDialog(getMainWindow(), localizeDialogOptions({
          title: translateNative("native.2c97181c8cf4"),
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: translateNative("native.c6133c6932ee"), extensions: [...BROLL_EXTENSIONS].map(value => value.slice(1)) }],
        }));
        if (choice.canceled || !choice.filePaths.length) return { success: true, cancelled: true, count: 0, splitCount: 0, clearedCount: 0 };
        sourcePaths = choice.filePaths;
      }
      if (sourcePaths.length > 500) throw new Error('一次最多导入 500 个花絮文件或文件夹');

      const destinationDir = assertInside(projectPath, path.join(projectPath, '花絮'), '花絮目录');
      await fs.promises.mkdir(destinationDir, { recursive: true });

      task = createProjectFileTask({
        backgroundTasks, event, operationId, operation: 'import-broll', title: `导入花絮 · ${projectName}`,
        projectName,
        resources: [destinationDir, ...sourcePaths.map(source => path.resolve(source))],
        concurrencyGroup: 'disk-io',
        concurrencyLimit: 3,
        concurrencyWriteLimit: 2,
        cancelledCode: CANCELLED_CODE,
      });
      job = task.job;
      job.cancel = task.cancel;
      activeOperations.set(operationId, job);
      taskNotificationOwned = true;
      await task.start();
      publish({ phase: 'scanning', progress: 0, totalBytes: 0, bytesCopied: 0, totalFiles: 0, filesCopied: 0 });
      sourcePaths = await expandBrollSourcePaths(sourcePaths, { isCancelled: () => job.cancelled, waitIfPaused: task.waitIfPaused });
      if (!sourcePaths.length) throw new Error('所选文件夹中没有可导入的花絮媒体文件');
      const sources = [];
      const sourceIdentities = new Set();
      for (const selected of sourcePaths) {
        throwIfCancelled(() => job.cancelled);
        await task.waitIfPaused();
        const info = await assertRegularFile(selected);
        const extension = path.extname(info.path).toLowerCase();
        if (!BROLL_EXTENSIONS.has(extension)) throw new Error(`不支持的花絮文件格式：${path.basename(info.path)}`);
        const identity = identityKey(await fs.promises.lstat(info.path, { bigint: true }), await fs.promises.realpath(info.path));
        if (sourceIdentities.has(identity)) continue;
        sourceIdentities.add(identity);
        sources.push({ ...info, extension });
      }
      const totalBytes = sources.reduce((sum, item) => sum + item.stat.size, 0);
      const destinationStat = await fs.promises.stat(destinationDir);
      const diskRequirements = estimateBrollDiskRequirements({
        sources, preserveOriginal, splitLargeFiles, transcodeVideos, transcodeSettings, destinationDev: destinationStat.dev,
      });
      await assertDiskSpace(destinationDir, diskRequirements.requiredBytes);
      await task.saveCheckpoint?.({ phase: 'prepared', sourcePaths: sources.map(item => item.path), destinationDir }, 0, '已建立花絮导入事务');
      publish({ phase: 'copying', progress: 0, totalBytes, bytesCopied: 0, totalFiles: sources.length, filesCopied: 0 });

      const reserved = new Set();
      const sourcesToTrash = [];
      let completedBytes = 0;
      let completedFiles = 0;
      let splitCount = 0;
      let transcodeCount = 0;
      let lastPublishedAt = 0;
      const report = (item, itemBytes, phase = 'copying', detail) => {
        const now = Date.now();
        if (now - lastPublishedAt < 80 && itemBytes < item.stat.size) return;
        lastPublishedAt = now;
        const bytesCopied = Math.min(totalBytes, completedBytes + itemBytes);
        publish({
          phase,
          progress: totalBytes ? Math.min(99, Math.round(bytesCopied / totalBytes * 100)) : 0,
          currentName: detail || path.basename(item.path),
          bytesCopied,
          totalBytes,
          filesCopied: completedFiles,
          totalFiles: sources.length,
        });
      };

      for (const item of sources) {
        if (job.cancelled) throw Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });
        const shouldSplit = splitLargeFiles && BROLL_VIDEO_EXTENSIONS.has(item.extension) && item.stat.size > FOUR_GB;
        const targetPath = shouldSplit
          ? await uniqueSplitDestination(destinationDir, path.basename(item.path), reserved)
          : uniqueDestination(destinationDir, path.basename(item.path), reserved);
        let importedVideoPaths = [];
        if (shouldSplit) {
          const outputStem = path.parse(targetPath).name;
          task.setPausable(false);
          const outputs = await task.withResources({
            capacities: [{ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 }],
            runningMessage: '正在分割视频',
          }, () => runSplitter({
            getRunConfig,
            processSupervisor,
            source: item.path,
            outputDirectory: destinationDir,
            outputStem,
            extension: item.extension,
            isCancelled: () => job.cancelled,
            onProgress: (progress, message) => report(item, item.stat.size * Math.max(0, Math.min(100, progress)) / 100, 'splitting', message),
          })).finally(() => task.setPausable(true));
          createdOwnedPaths.push(...outputs);
          createdPaths.push(...outputs.map(output => output.path));
          importedVideoPaths = outputs.map(output => output.path);
          splitCount += 1;
          if (!preserveOriginal) sourcesToTrash.push(item.path);
        } else if (preserveOriginal) {
          const copied = await copyFileAtomic(item.path, targetPath, {
            ownershipToken: operationId,
            isCancelled: () => job.cancelled,
            waitIfPaused: task.waitIfPaused,
            durable: true,
            onProgress: progress => report(item, progress.bytesCopied),
          });
          createdPaths.push(targetPath);
          const publishedOwnership = ownedPublicationFallback(targetPath, { identity: copied.publishedIdentity, nativeIdentity: copied.nativePublishedIdentity });
          createdOwnedPaths.push(publishedOwnership);
          const validatedOwnership = await claimRegularFile(targetPath, destinationDir);
          if (!await pathStillOwned(publishedOwnership) || !sameCapturedFileIdentity(validatedOwnership.fileIdentity, publishedOwnership.fileIdentity)) {
            throw new Error(`花絮复制产物在登记期间已被替换：${path.basename(targetPath)}`);
          }
          createdOwnedPaths[createdOwnedPaths.length - 1] = validatedOwnership;
          if (BROLL_VIDEO_EXTENSIONS.has(item.extension)) importedVideoPaths = [targetPath];
        } else {
          const sourceOwnership = await claimRegularFile(item.path, path.dirname(item.path));
          const moveRecord = { source: item.path, destination: targetPath, sourceOwnership, destinationOwnership: null, state: 'pending' };
          moveRecords.push(moveRecord);
          await task.saveCheckpoint?.({ phase: 'executing', moves: checkpointMoves(moveRecords), createdPaths: [...createdPaths], destinationDir }, undefined, '已持久记录待移动花絮文件');
          throwIfCancelled(() => job.cancelled);
          const moved = isReliableSameDevice(item.stat.dev, destinationStat.dev)
            ? await publishPathNoClobber(item.path, targetPath, { ownershipToken: operationId }).then(published => ({
              copied: false,
              publishedIdentity: published.identity,
              nativePublishedIdentity: published.nativeIdentity,
            }))
            : await moveFileAtomic(item.path, targetPath, {
              ownershipToken: operationId,
              isCancelled: () => job.cancelled,
              waitIfPaused: task.waitIfPaused,
              durable: true,
              onProgress: progress => report(item, progress.bytesCopied),
          });
          const capturedDestinationOwnership = captureEntryIdentitySync(targetPath);
          const publishedPhysicalIdentity = { ...moved.publishedIdentity };
          // The publication returned a complete physical identity. Validate it
          // destructively here without requesting an additional large-file digest.
          delete publishedPhysicalIdentity.sha256;
          if (!await samePathIdentity(targetPath, publishedPhysicalIdentity, { destructive: true })) {
            throw new Error(`花絮移动产物与发布身份不一致：${path.basename(targetPath)}`);
          }
          moveRecord.destinationOwnership = capturedDestinationOwnership;
          moveRecord.state = 'moved';
          await task.saveCheckpoint?.({ phase: 'executing', moves: checkpointMoves(moveRecords), createdPaths: [...createdPaths], destinationDir }, undefined, '已持久记录花絮移动结果');
          const owned = await claimRegularFile(targetPath, destinationDir);
          if (owned.identity !== moveRecord.destinationOwnership.identity) throw new Error(`花絮移动产物在登记期间已被替换：${path.basename(targetPath)}`);
          moveRecord.destinationOwnership = owned;
          moveRecord.state = 'claimed';
          moves.push({ source: item.path, destination: targetPath });
          moveOwnership.push(owned);
          await task.saveCheckpoint?.({ phase: 'executing', moves: checkpointMoves(moveRecords), createdPaths: [...createdPaths], destinationDir }, undefined, '已确认花絮移动产物身份');
          if (BROLL_VIDEO_EXTENSIONS.has(item.extension)) importedVideoPaths = [targetPath];
          if (moved.copied) logSafely('info', 'B-roll crossed filesystems and was copied atomically before source removal', { source: item.path, destination: targetPath });
        }
        if (transcodeVideos) {
          for (const videoPath of importedVideoPaths) {
            task.setPausable(false);
            const output = await task.withResources({
              capacities: [{ key: 'heavy-media', access: 'write', limit: 1, writeLimit: 1 }],
              runningMessage: '正在转码视频',
            }, () => runTranscoder({
              getRunConfig,
              processSupervisor,
              source: videoPath,
              outputDirectory: destinationDir,
              settings: transcodeSettings,
              isCancelled: () => job.cancelled,
              onProgress: (progress, message) => report(item, item.stat.size * Math.max(0, Math.min(100, progress)) / 100, 'transcoding', message),
            })).finally(() => task.setPausable(true));
            createdOwnedPaths.push(output);
            createdPaths.push(output.path);
            transcodeCount += 1;
          }
        }
        completedBytes += item.stat.size;
        completedFiles += 1;
        report(item, item.stat.size);
      }

      for (const owned of [...createdOwnedPaths, ...moveOwnership]) {
        if (!await pathStillOwned(owned)) throw new Error(`花絮导入产物在提交前已被替换：${path.basename(owned.path)}`);
      }
      throwIfCancelled(() => job.cancelled);
      job.finishing = true;
      task.setPausable(false);
      task.setCancellable(false);
      publish({ phase: 'finishing', progress: 99, currentName: '正在完成花絮导入', bytesCopied: totalBytes, totalBytes, filesCopied: sources.length, totalFiles: sources.length });
      const ownedAtCommit = [...createdOwnedPaths, ...moveOwnership];
      const operationIdentityMap = undoIdentities(ownedAtCommit);
      const undoToken = crypto.randomUUID();
      if (createdPaths.length && moves.length) persistedUndoEntry = await pushUndoOperation({ kind: 'broll-import', createdPaths: [...createdPaths], moves: [...moves], identities: operationIdentityMap, undoToken, label: '导入花絮' });
      else if (createdPaths.length) persistedUndoEntry = await pushUndoOperation({ kind: 'remove-created', paths: [...createdPaths], identities: operationIdentityMap, undoToken, label: '导入花絮' });
      else if (moves.length) persistedUndoEntry = await pushUndoOperation({ kind: 'external-move', moves: [...moves], identities: operationIdentityMap, undoToken });
      undoPersisted = true;
      for (const owned of ownedAtCommit) {
        if (!await pathStillOwned(owned)) {
          invalidateStoredUndo(persistedUndoEntry, 'post-push ownership changed');
          const boundaryError = new Error(`花絮导入产物在撤销提交期间已被替换：${path.basename(owned.path)}`);
          boundaryError.code = 'BROLL_COMMIT_OWNERSHIP_CHANGED';
          boundaryError.recoveryRequired = true;
          boundaryError.recoveryPaths = [owned.path];
          throw boundaryError;
        }
      }
      committed = true;
      try { await task.saveCheckpoint?.({ phase: 'committed', createdPaths: [...createdPaths], sourcesToTrash: [...sourcesToTrash] }, 99, '花絮导入事务已提交'); }
      catch (error) { logSafely('error', 'Unable to checkpoint committed B-roll transaction', error); }
      let clearedCount = moves.length;
      const cleanupWarnings = [];
      for (const source of sourcesToTrash) {
        try {
          await recycleBinService.trash(source);
          clearedCount += 1;
        } catch (error) {
          cleanupWarnings.push(`${path.basename(source)}：${error.message || String(error)}`);
        }
      }

      const warningParts = [];
      if (sourcesToTrash.length) warningParts.push('已删除的源文件位于系统回收站，撤销只会移除导入产物');
      if (cleanupWarnings.length) warningParts.push(`部分源文件未能移入回收站：${cleanupWarnings.join('；')}`);
      const warning = warningParts.join('；');
      committedResponse = { success: true, operationId, taskNotificationOwned: true, count: sources.length, splitCount, transcodeCount, clearedCount, warning: warning || undefined };
      try { publish({ phase: 'complete', progress: 100, currentName: '花絮导入完成', bytesCopied: totalBytes, totalBytes, filesCopied: sources.length, totalFiles: sources.length }); }
      catch (error) { logSafely('error', 'Unable to publish committed B-roll completion', error); }
      try { task.complete('花絮导入完成'); } catch (error) { logSafely('error', 'Unable to complete committed B-roll task', error); }
      logSafely('info', 'B-roll imported', { projectPath, count: sources.length, splitCount, transcodeCount, clearedCount, totalBytes, warning });
      try {
        const telemetry = getTelemetry?.();
        telemetry?.track('photos_imported', { count_bucket: telemetry.countBucket(sources.length), source: 'broll', media_kind: 'mixed' });
      } catch (error) { logSafely('error', 'Unable to record committed B-roll telemetry', error); }
      return committedResponse;
    } catch (error) {
      if (committed) {
        logSafely('error', 'Committed B-roll import encountered a notification failure', error);
        return committedResponse || { success: true, operationId, taskNotificationOwned: true, warning: '花絮导入已提交，但完成通知失败' };
      }

      const recoveryPaths = new Set(Array.isArray(error.recoveryPaths) ? error.recoveryPaths : []);
      const requireRecovery = (...paths) => {
        error.recoveryRequired = true;
        for (const candidate of paths) if (candidate) recoveryPaths.add(path.resolve(candidate));
      };
      if (undoPersisted) for (const owned of [...createdOwnedPaths, ...moveOwnership]) {
        if (!await pathStillOwned(owned)) requireRecovery(owned.path);
      }
      for (let index = moveRecords.length - 1; index >= 0; index -= 1) {
        const record = moveRecords[index];
        try {
          const sourceExists = fs.existsSync(record.source);
          const destinationExists = fs.existsSync(record.destination);
          if (sourceExists) {
            if (!await pathStillOwned(record.sourceOwnership) || destinationExists) requireRecovery(record.source, destinationExists ? record.destination : null);
            continue;
          }
          if (!destinationExists) {
            requireRecovery(record.source, record.destination);
            continue;
          }
          const destinationOwned = record.destinationOwnership && await pathStillOwned(record.destinationOwnership);
          if (!destinationOwned) {
            requireRecovery(record.source, record.destination);
            continue;
          }
          await moveFileAtomic(record.destination, record.source, { durable: true, ownershipToken: operationId });
        } catch (rollbackError) {
          requireRecovery(record.source, record.destination);
          logSafely('error', 'Unable to roll back B-roll move', { move: { source: record.source, destination: record.destination }, error: rollbackError.message || String(rollbackError) });
        }
      }
      if (!committed) for (const created of [...createdOwnedPaths].reverse()) await removeOwnedFile(created);
      if (recoveryPaths.size) error.recoveryPaths = [...recoveryPaths];
      const cancelled = error?.code === CANCELLED_CODE;
      try { publish({ phase: cancelled ? 'cancelled' : 'failed', progress: 0, error: error.message || String(error) }); } catch { /* preserve the operation result */ }
      try { if (cancelled) task?.cancelled(); else task?.fail(error); } catch { /* preserve the operation result */ }
      if (!cancelled) logSafely('error', 'B-roll import failed', { projectName, error: error.message || String(error) });
      return cancelled
        ? { success: true, cancelled: true, operationId, taskNotificationOwned, count: 0, splitCount: 0, clearedCount: 0, ...(error.recoveryRequired ? { recoveryRequired: true, recoveryPaths: error.recoveryPaths } : {}) }
        : { success: false, operationId, taskNotificationOwned, error: error.message || String(error), ...(error.recoveryRequired ? { recoveryRequired: true, recoveryPaths: error.recoveryPaths } : {}) };
    } finally {
      activeOperations.delete(operationId);
      releaseCleanupOwnership(operationId);
    }
  });
};

module.exports = {
  registerBrollImportIpc,
  _test: {
    expandBrollSourcePaths,
    estimateBrollDiskRequirements,
    isReliableSameDevice,
    identityKey,
    splitFamilyExists,
    uniqueSplitDestination,
    runJsonLineWorker,
    runSplitter,
    runTranscoder,
    snapshotDirectory,
    ownedRegularFile,
    removeOwnedFile,
    terminateWorkerTree,
  },
};
