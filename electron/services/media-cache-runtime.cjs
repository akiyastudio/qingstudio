const RAW_DECODER_CACHE_VERSION = 'libraw-rawpy-v1';

const createMediaCacheRuntime = ({
  fs,
  path,
  crypto,
  platform,
  resolveMediaCacheNamespace,
  userDataPath,
  installationId,
  approvedDirectories,
  normalizeCacheSizeGB,
  trackedVersionThumbnailPath,
  versionService,
  mediaRuntimeState,
  imageExtensions,
  rawExtensions,
  videoExtensions,
  thumbnailVersion,
  defaultPriority,
  writeLog,
}) => {
  let thumbnailService = null;
  let imageThumbnailRuntime = null;
  const indexes = new Map();
  const trackedCopies = new Map();

  const attach = dependencies => {
    thumbnailService = dependencies.thumbnailService;
    imageThumbnailRuntime = dependencies.imageThumbnailRuntime;
  };
  const resolveCacheDir = (config = {}) => resolveMediaCacheNamespace({
    path, userDataPath, installationId, configuredDirectory: config.directory,
  });
  const getCacheDir = (config = {}) => {
    const requested = typeof config.directory === 'string' ? config.directory.trim() : '';
    const selectedRoot = path.resolve(requested || path.join(userDataPath, 'media-cache'));
    const cacheDir = resolveCacheDir(config);
    if (!approvedDirectories.has(selectedRoot)) throw new Error('媒体缓存目录未经授权');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    return cacheDir;
  };
  const sourceCacheKey = sourcePath => platform === 'win32' ? path.resolve(sourcePath).toLowerCase() : path.resolve(sourcePath);
  const decodedPreviewCacheFile = (sourcePath, stat, cacheDir, kind) => path.join(cacheDir, crypto.createHash('sha256').update(`decoded-preview|v2|${kind}|${kind === 'raw' ? RAW_DECODER_CACHE_VERSION : 'builtin'}|${sourceCacheKey(sourcePath)}|${stat.size}|${stat.mtimeMs}`).digest('hex') + '.jpg');
  const thumbnailCacheFile = (sourcePath, stat, cacheDir, requestedSize, version = thumbnailVersion) => path.join(cacheDir, crypto.createHash('sha256').update(`thumbnail|v${version}|${rawExtensions.has(path.extname(sourcePath).toLowerCase()) ? RAW_DECODER_CACHE_VERSION : 'builtin'}|${requestedSize}|${sourceCacheKey(sourcePath)}|${stat.size}|${stat.mtimeMs}`).digest('hex') + '.jpg');

  const refreshIndex = async cacheDir => {
    const directory = path.resolve(cacheDir);
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const files = new Map();
    let totalBytes = 0;
    await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
      const filePath = path.join(directory, entry.name);
      try {
        const stat = await fs.promises.stat(filePath);
        files.set(filePath, { size: stat.size, used: stat.atimeMs || stat.mtimeMs });
        totalBytes += stat.size;
      } catch { /* file changed while the cache snapshot was being built */ }
    }));
    const state = indexes.get(directory) || { pendingPaths: new Set(), timer: null, running: false, maxBytes: 50 * 1024 ** 3 };
    state.files = files;
    state.totalBytes = totalBytes;
    state.initialized = true;
    indexes.set(directory, state);
    return state;
  };
  const getIndex = async cacheDir => {
    const directory = path.resolve(cacheDir);
    const current = indexes.get(directory);
    if (current?.initialized) return current;
    if (current?.initializing) return current.initializing;
    const state = current || { pendingPaths: new Set(), timer: null, running: false, maxBytes: 50 * 1024 ** 3 };
    state.initializing = refreshIndex(directory).finally(() => { state.initializing = null; });
    indexes.set(directory, state);
    return state.initializing;
  };
  const updateIndex = async (state, changedPaths) => {
    for (const filePath of changedPaths) {
      const resolved = path.resolve(filePath);
      const previous = state.files.get(resolved);
      try {
        const stat = await fs.promises.stat(resolved);
        state.files.set(resolved, { size: stat.size, used: stat.atimeMs || stat.mtimeMs });
        state.totalBytes += stat.size - (previous?.size || 0);
      } catch {
        if (previous) state.totalBytes -= previous.size;
        state.files.delete(resolved);
      }
    }
  };
  const runMaintenance = async cacheDir => {
    const deadlineAt = Date.now() + 10 * 60 * 1000;
    const directory = path.resolve(cacheDir);
    const state = await getIndex(directory);
    if (state.running) return;
    state.running = true;
    try {
      const changedPaths = [...state.pendingPaths];
      state.pendingPaths.clear();
      await updateIndex(state, changedPaths);
      if (state.totalBytes <= state.maxBytes) return;
      const refreshed = await refreshIndex(directory);
      const protectedPaths = new Set([...trackedCopies.values()].map(pending => {
        const resolved = path.resolve(pending.cachePath);
        return platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
      }));
      await thumbnailService.evictCache({
        cacheRoot: directory,
        bytesToFree: Math.max(0, refreshed.totalBytes - refreshed.maxBytes),
        excludePaths: [...protectedPaths],
        recoverOrphans: true,
        deadlineAt,
      });
      await refreshIndex(directory);
    } finally {
      state.running = false;
      if (state.pendingPaths.size) trimCache(directory, state.maxBytes / 1024 ** 3, []);
    }
  };
  const trimCache = (cacheDir, maxSizeGB, changedPaths = []) => {
    const directory = path.resolve(cacheDir);
    const state = indexes.get(directory) || { pendingPaths: new Set(), timer: null, running: false, maxBytes: 50 * 1024 ** 3 };
    state.maxBytes = normalizeCacheSizeGB(maxSizeGB) * 1024 ** 3;
    for (const filePath of changedPaths) state.pendingPaths.add(path.resolve(filePath));
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void runMaintenance(directory).catch(error => writeLog('warn', 'Media cache maintenance failed', { directory, error: error.message || String(error) }));
    }, 500);
    indexes.set(directory, state);
  };

  const isCompleteJpegFile = filePath => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size < 128) return false;
      const handle = fs.openSync(filePath, 'r');
      try {
        const markers = Buffer.alloc(4);
        fs.readSync(handle, markers, 0, 2, 0);
        fs.readSync(handle, markers, 2, 2, stat.size - 2);
        return markers[0] === 0xff && markers[1] === 0xd8 && markers[2] === 0xff && markers[3] === 0xd9;
      } finally { fs.closeSync(handle); }
    } catch { return false; }
  };
  const decodedPreviewPath = async (sourcePath, stat, cacheConfig, kind) => {
    const cacheDir = getCacheDir(cacheConfig);
    const target = decodedPreviewCacheFile(sourcePath, stat, cacheDir, kind);
    if (isCompleteJpegFile(target)) return target;
    if (fs.existsSync(target)) await thumbnailService?.evictCache({ thumbnailPaths: [target] }).catch(() => undefined);
    try {
      await imageThumbnailRuntime.generateOriginalImagePreviewFile(sourcePath, kind, [{ sizeLabel: `${kind}-preview`, pixels: 0, path: target }]);
      if (!isCompleteJpegFile(target)) return null;
      trimCache(cacheDir, cacheConfig?.maxSizeGB, [target]);
      return target;
    } catch (error) {
      writeLog('warn', 'Browser-compatible image preview generation failed', { sourcePath, kind, error: error.message || String(error) });
      return null;
    }
  };
  const rawPreviewPath = (sourcePath, stat, cacheConfig) => decodedPreviewPath(sourcePath, stat, cacheConfig, 'raw');
  const convertedImagePreviewPath = (sourcePath, stat, cacheConfig) => decodedPreviewPath(sourcePath, stat, cacheConfig, 'image');
  const isCompleteJpegBuffer = buffer => buffer.length >= 128 && buffer[0] === 0xff && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  const readCompleteJpegBuffer = async filePath => {
    let handle;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const buffer = await handle.readFile();
      return isCompleteJpegBuffer(buffer) ? buffer : null;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    } finally { await handle?.close().catch(() => undefined); }
  };
  const writeThumbnailAtomically = async (targetPath, buffer) => {
    if (isCompleteJpegFile(targetPath)) return;
    const temporaryPath = `${targetPath}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.promises.writeFile(temporaryPath, buffer, { flag: 'wx' });
      try {
        await fs.promises.rename(temporaryPath, targetPath);
      } catch (error) {
        if (isCompleteJpegFile(targetPath)) return;
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
        await fs.promises.unlink(targetPath).catch(unlinkError => { if (unlinkError?.code !== 'ENOENT') throw unlinkError; });
        await fs.promises.rename(temporaryPath, targetPath);
      }
    } finally { await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined); }
  };
  const finalizeTrackedThumbnail = async pending => {
    await fs.promises.mkdir(path.dirname(pending.targetPath), { recursive: true });
    if (!isCompleteJpegFile(pending.targetPath)) {
      const buffer = await readCompleteJpegBuffer(pending.cachePath);
      if (!buffer) return false;
      await writeThumbnailAtomically(pending.targetPath, buffer);
    }
    await versionService.setThumbnail(pending.workspaceRoot, { versionId: pending.versionId, thumbnailPath: pending.targetPath });
    return true;
  };
  const persistTrackedThumbnail = async pending => {
    if (pending.finalizing) return;
    pending.finalizing = true;
    const sourceKey = sourceCacheKey(pending.filePath);
    try {
      if (trackedCopies.get(sourceKey) !== pending) return;
      if (await finalizeTrackedThumbnail(pending)) {
        if (trackedCopies.get(sourceKey) === pending) trackedCopies.delete(sourceKey);
        return;
      }
      if (pending.retryCount >= 1) {
        if (trackedCopies.get(sourceKey) === pending) trackedCopies.delete(sourceKey);
        writeLog('warn', 'Unable to finalize ID-based version thumbnail after retry', { versionId: pending.versionId, filePath: pending.filePath });
        return;
      }
      pending.retryCount += 1;
      const result = await thumbnailService.request({
        filePath: pending.filePath, kind: pending.kind, cacheConfig: pending.cacheConfig,
        requestedSize: 640, priority: pending.priority, requireDisk: true, forceRegenerate: true,
      });
      if (result.state === 'READY') {
        if (await finalizeTrackedThumbnail(pending)) {
          if (trackedCopies.get(sourceKey) === pending) trackedCopies.delete(sourceKey);
        } else {
          if (trackedCopies.get(sourceKey) === pending) trackedCopies.delete(sourceKey);
          writeLog('warn', 'Unable to finalize ID-based version thumbnail after retry', { versionId: pending.versionId, filePath: pending.filePath });
        }
      } else if (result.state === 'FAILED' || result.state === 'MISSING') trackedCopies.delete(sourceKey);
    } catch (error) {
      if (trackedCopies.get(sourceKey) === pending) trackedCopies.delete(sourceKey);
      writeLog('warn', 'Unable to finalize ID-based version thumbnail', { versionId: pending.versionId, filePath: pending.filePath, error: error.message || String(error) });
    } finally { pending.finalizing = false; }
  };
  const ensureTrackedVersionThumbnail = async ({ workspaceRoot, photoId, versionId, filePath, priority = defaultPriority }) => {
    try {
      if (!thumbnailService || !fs.existsSync(filePath)) return;
      const stat = await fs.promises.stat(filePath);
      const extension = path.extname(filePath).toLowerCase();
      const kind = rawExtensions.has(extension) ? 'raw' : videoExtensions.has(extension) ? 'video' : imageExtensions.has(extension) ? 'image' : '';
      if (!kind) return;
      const cacheConfig = { ...mediaRuntimeState.activeMediaCacheConfig };
      const pending = {
        workspaceRoot, versionId, filePath, kind, cacheConfig, priority, retryCount: 0, finalizing: false,
        cachePath: thumbnailCacheFile(filePath, stat, getCacheDir(cacheConfig), 640, thumbnailVersion),
        targetPath: trackedVersionThumbnailPath(workspaceRoot, photoId, versionId),
      };
      if (await finalizeTrackedThumbnail(pending)) return;
      trackedCopies.set(sourceCacheKey(filePath), pending);
      const result = await thumbnailService.request({ filePath, kind, cacheConfig, requestedSize: 640, priority, requireDisk: true });
      if (result.state === 'READY') await persistTrackedThumbnail(pending);
      else if (result.state === 'FAILED' || result.state === 'MISSING') trackedCopies.delete(sourceCacheKey(filePath));
    } catch (error) {
      trackedCopies.delete(sourceCacheKey(filePath));
      writeLog('warn', 'Unable to persist ID-based version thumbnail', { versionId, filePath, error: error.message || String(error) });
    }
  };
  const handleThumbnailUpdate = update => {
    const trackedThumbnail = trackedCopies.get(sourceCacheKey(update.filePath));
    if (trackedThumbnail && update.state === 'READY') void persistTrackedThumbnail(trackedThumbnail);
    else if (trackedThumbnail && (update.state === 'FAILED' || update.state === 'MISSING')) trackedCopies.delete(sourceCacheKey(update.filePath));
  };

  return {
    attach,
    indexes,
    resolveMediaCacheDir: resolveCacheDir,
    getMediaCacheDir: getCacheDir,
    refreshMediaCacheIndex: refreshIndex,
    trimMediaCache: trimCache,
    rawPreviewPath,
    convertedImagePreviewPath,
    mediaThumbnailCacheFile: thumbnailCacheFile,
    mediaSourceCacheKey: sourceCacheKey,
    ensureTrackedVersionThumbnail,
    handleThumbnailUpdate,
  };
};

module.exports = { RAW_DECODER_CACHE_VERSION, createMediaCacheRuntime };
