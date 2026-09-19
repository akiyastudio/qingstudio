const { createBatchedSliceMetricsReporter, runSlicedMaintenance } = require('../services/sliced-maintenance-runner.cjs');

const registerMediaIpc = context => {
  const { Buffer, Date, Error, IMAGE_EXTENSIONS, IMAGE_PREVIEW_CONVERSION_EXTENSIONS, Math, Number, Object, PRIORITY, Promise, RAW_EXTENSIONS, String, VIDEO_EXTENSIONS, approvedMediaCacheDirectories, backgroundTasks, clearTimeout, convertedImagePreviewPath, dialog, exiftool, findImportedVideoPreview, flattenMetadataValue, fs, getMediaCacheDir, ipcMain, mainWindow, mediaCacheIndexes, mediaMetadataCache, mediaRuntimeState, mediaService, normalizeMediaCacheSizeGB, path, rawOrientationCorrection, rawPreviewPath, refreshMediaCacheIndex, setTimeout, thumbnailService, trimMediaCache, undefined, writeLog } = context;

  const pngHeaderDimensionFields = (sourcePath, extension) => {
    if (extension !== '.png') return [];
    let descriptor;
    try {
      descriptor = fs.openSync(sourcePath, 'r');
      const header = Buffer.alloc(24);
      if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return [];
      if (header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || header.toString('ascii', 12, 16) !== 'IHDR') return [];
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      if (!width || !height) return [];
      return [
        { group: 'PNG', name: 'ImageWidth', value: String(width) },
        { group: 'PNG', name: 'ImageHeight', value: String(height) },
        { group: 'Composite', name: 'ImageSize', value: `${width}x${height}` },
      ];
    } catch {
      return [];
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* the metadata fallback must not fail while closing */ }
      }
    }
  };

  const withPngHeaderDimensions = (sourcePath, extension, fields) => {
    const hasName = name => fields.some(field => field.name === name);
    if (hasName('ImageWidth') && hasName('ImageHeight')) return fields;
    const fallbacks = pngHeaderDimensionFields(sourcePath, extension);
    return [...fields, ...fallbacks.filter(field => !hasName(field.name))];
  };

  ipcMain.handle('media-thumbnail', async (_event, filePath, kind, cacheConfig = {}, requestedSize = 640, priority = PRIORITY.visible, queueOrder = Number.MAX_SAFE_INTEGER) => {
    try {
      if (!['image', 'raw', 'video'].includes(kind)) throw new Error('媒体类型无效');
      if (!Number.isSafeInteger(requestedSize) || requestedSize < 1 || requestedSize > 8192) throw new Error('缩略图尺寸无效');
      if (!Number.isInteger(priority) || priority < PRIORITY.visible || priority > PRIORITY.project) throw new Error('缩略图优先级无效');
      if (!Number.isSafeInteger(queueOrder)) throw new Error('缩略图队列顺序无效');
      const sourcePath = await mediaService.authorizeInput(filePath);
      const extension = path.extname(sourcePath).toLowerCase();
      const supported = kind === 'raw' ? RAW_EXTENSIONS.has(extension) : kind === 'video' ? VIDEO_EXTENSIONS.has(extension) : IMAGE_EXTENSIONS.has(extension);
      if (!supported || !fs.existsSync(sourcePath)) throw new Error('文件不存在或格式不受支持');
      mediaRuntimeState.activeMediaCacheConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
      const result = await mediaService.requestThumbnail({ filePath: sourcePath, kind, cacheConfig: mediaRuntimeState.activeMediaCacheConfig, requestedSize, priority, queueOrder });
      if (kind !== 'video') return result;
      const isImportedOriginal = path.basename(path.dirname(sourcePath)).toLocaleLowerCase() === 'mov';
      const importedPreview = await findImportedVideoPreview(sourcePath);
      return {
        ...result,
        mediaUrl: importedPreview ? mediaService.toUrl(importedPreview) : isImportedOriginal ? undefined : mediaService.toUrl(sourcePath),
        usingImportedPreview: Boolean(importedPreview),
        importedVideoWithoutPreview: isImportedOriginal && !importedPreview
      };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('media-thumbnail-cancel', async (_event, filePath, requestedSize = 640) => {
    try { return { success: true, cancelled: mediaService.cancelThumbnail(await mediaService.authorizeInput(filePath), requestedSize) }; }
    catch (error) { return { success: false, cancelled: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('media-original', async (_event, filePath, kind, cacheConfig = {}) => {
    try {
      thumbnailService?.noteForegroundActivity();
      const sourcePath = await mediaService.authorizeInput(filePath);
      const extension = path.extname(sourcePath).toLowerCase();
      const supported = kind === 'raw' ? RAW_EXTENSIONS.has(extension) : kind === 'image' ? IMAGE_EXTENSIONS.has(extension) : kind === 'video' ? VIDEO_EXTENSIONS.has(extension) : false;
      if (!supported || !fs.existsSync(sourcePath)) throw new Error('媒体不存在或格式不受支持');
      if (kind === 'video') {
        return { success: true, mediaUrl: mediaService.toUrl(sourcePath, true), original: true };
      }
      if (kind === 'image' && !IMAGE_PREVIEW_CONVERSION_EXTENSIONS.has(extension)) {
        return { success: true, mediaUrl: mediaService.toUrl(sourcePath, true), original: true };
      }

      if (kind === 'image') {
        const stat = await fs.promises.stat(sourcePath);
        const previewPath = await convertedImagePreviewPath(sourcePath, stat, cacheConfig);
        if (!previewPath) throw new Error('图片无法转换为可显示的预览');
        return { success: true, mediaUrl: mediaService.toUrl(previewPath, true), original: false };
      }

      // Chromium cannot decode camera RAW containers directly. Prefer the
      // camera-embedded JPEG, then fall back to the bundled LibRaw decoder.
      const stat = await fs.promises.stat(sourcePath);
      const previewPath = await rawPreviewPath(sourcePath, stat, cacheConfig);
      if (!previewPath) throw new Error('RAW 文件无法生成预览；请检查文件是否损坏或属于当前支持的 RAW 格式');
      // Never replace a slow EXIF read with the identity matrix. The first
      // ExifTool invocation and large RAW containers can legitimately take
      // longer than three seconds; returning identity in that case permanently
      // cached a sideways preview in renderer resource caches.
      const orientation = await rawOrientationCorrection(sourcePath, previewPath, stat);
      return { success: true, mediaUrl: mediaService.toUrl(previewPath, true), original: false, orientation };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('media-metadata', async (_event, filePath) => {
    let sourcePath = '';
    let extension = '';
    try {
      sourcePath = await mediaService.authorizeInput(filePath);
      extension = path.extname(sourcePath).toLowerCase();
      if (![...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...RAW_EXTENSIONS].includes(extension) || !fs.existsSync(sourcePath)) throw new Error('媒体文件不存在或格式不受支持');
      const stat = await fs.promises.stat(sourcePath);
      const cacheKey = `${sourcePath}|${stat.size}|${stat.mtimeMs}`;
      const cached = mediaMetadataCache.get(cacheKey);
      if (cached) return cached;

      const tags = await exiftool.readRaw(sourcePath, ['-G1', '-struct', '-api', 'largefilesupport=1']);
      const extractedFields = Object.entries(tags).flatMap(([qualifiedName, rawValue]) => {
        if (qualifiedName === 'SourceFile') return [];
        const separatorIndex = qualifiedName.indexOf(':');
        const group = separatorIndex > 0 ? qualifiedName.slice(0, separatorIndex) : '其他';
        const name = separatorIndex > 0 ? qualifiedName.slice(separatorIndex + 1) : qualifiedName;
        return flattenMetadataValue(group, name, rawValue);
      });
      const fields = withPngHeaderDimensions(sourcePath, extension, extractedFields);
      const result = { success: true, fields };
      if (mediaMetadataCache.size >= 32) mediaMetadataCache.delete(mediaMetadataCache.keys().next().value);
      mediaMetadataCache.set(cacheKey, result);
      return result;
    } catch (error) {
      writeLog('warn', 'Unable to read media metadata', { filePath, error: error.message || String(error) });
      if (sourcePath && IMAGE_EXTENSIONS.has(extension)) {
        const fields = pngHeaderDimensionFields(sourcePath, extension);
        if (fields.length) return { success: true, fields };
      }
      return { success: false, fields: [], error: error.message || String(error) };
    }
  });

  ipcMain.handle('media-raw-preview', async (_event, filePath, cacheConfig = {}) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      if (!RAW_EXTENSIONS.has(path.extname(sourcePath).toLowerCase()) || !fs.existsSync(sourcePath)) throw new Error('RAW 文件不存在或格式不受支持');
      const preview = await rawPreviewPath(sourcePath, await fs.promises.stat(sourcePath), cacheConfig);
      return preview ? { success: true, previewUrl: mediaService.toUrl(preview) } : { success: false, error: 'RAW 文件既没有可用内嵌预览，也未能通过内置 LibRaw 解码器显影' };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });

  ipcMain.handle('choose-cache-directory', async () => {
    const choice = await dialog.showOpenDialog(mainWindow, { title: '选择缩略图缓存目录', properties: ['openDirectory', 'createDirectory'] });
    if (!choice.canceled && choice.filePaths[0]) approvedMediaCacheDirectories.add(path.resolve(choice.filePaths[0]));
    return choice.canceled ? { cancelled: true } : { path: choice.filePaths[0] };
  });

  ipcMain.handle('media-cache-info', async (_event, cacheConfig = {}) => {
    try {
      const normalizedConfig = { maxSizeGB: normalizeMediaCacheSizeGB(cacheConfig?.maxSizeGB), directory: cacheConfig?.directory || '' };
      const cacheDir = getMediaCacheDir(normalizedConfig);
      const state = await refreshMediaCacheIndex(cacheDir);
      trimMediaCache(cacheDir, normalizedConfig.maxSizeGB);
      return { success: true, path: cacheDir, sizeBytes: state.totalBytes, fileCount: state.files.size };
    }
    catch (error) { return { success: false, path: '', sizeBytes: 0, fileCount: 0, error: error.message || String(error) }; }
  });

  const runCacheCleanup = async (cacheConfig = {}, olderThanDays, options = {}, restartTask = null) => {
    const origin = options?.origin === 'daily-auto' ? 'daily-auto' : 'manual';
    if (origin === 'daily-auto') await thumbnailService.waitForStartupRecovery?.(cacheConfig);
    const cleanupRoot = path.resolve(getMediaCacheDir(cacheConfig));
    const execution = await backgroundTasks.run({
      ...(restartTask?.id ? { id: restartTask.id } : {}),
      type: 'cache-cleanup',
      title: '清理媒体缓存',
      dedupeKey: `cache-cleanup:${origin}:${cleanupRoot.toLocaleLowerCase()}:${Number(olderThanDays) || 'all'}`,
      ...(origin === 'daily-auto' ? { notificationPolicy: 'error-only' } : {}),
      metadata: {
        cacheConfig, olderThanDays, origin,
      },
    }, async task => {
      task.throwIfCancelled();
      task.report(5, '正在分批移除缓存索引');
      const cacheDir = cleanupRoot;
      const days = Number(olderThanDays);
      const cutoff = Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
      let lastPhaseReportAt = 0;
      const reportBlocked = (processedOffset, deadlineAt) => ({ phase, processedCount }) => {
        const totalProcessed = processedOffset + Number(processedCount || 0);
        if (Date.now() - lastPhaseReportAt < 250) return;
        lastPhaseReportAt = Date.now();
        task.report(Math.min(95, 5 + Math.floor(totalProcessed / 64)), `缓存维护：${phase}，已处理 ${totalProcessed} 条`, {
          maintenancePhase: phase,
          processedCount: totalProcessed,
          deadlineAt,
        });
      };
      let result;
      if (origin !== 'daily-auto') {
        const deadlineAt = Date.now() + 10 * 60 * 1000;
        result = await thumbnailService.evictCache({
          cacheRoot: cacheDir,
          ...(cutoff == null ? { all: true } : { beforeMs: cutoff }),
          recoverOrphans: true,
          orphanBeforeMs: cutoff,
          pruneMissing: true,
          task,
          signal: task.signal,
          deadlineAt,
          onBlocked: reportBlocked(0, deadlineAt),
        });
      } else {
        const reportSliceMetrics = createBatchedSliceMetricsReporter({
          writeLog,
          context: { origin: 'daily-auto' },
        });
        const run = await runSlicedMaintenance({
          task,
          initialState: { recoveryCursor: {}, detachPending: true, prunePending: true },
          initialMetrics: { deletedCount: 0, deletedBytes: 0, detachedCount: 0, detachedBytes: 0, prunedSourceCount: 0, repairedMissingCount: 0, recoveryInspectedCount: 0, orphanScanConsumedCount: 0, orphanProgressCount: 0, retryConsumedCount: 0, failedCount: 0 },
          sliceDeadlineMs: 60 * 1000,
          yieldMs: 50,
          runSlice: async ({ state, firstSlice, deadlineAt, signal }) => {
          const slice = await thumbnailService.evictCache({
            cacheRoot: cacheDir,
            ...(state.detachPending ? cutoff == null ? { all: true } : { beforeMs: cutoff } : {}),
            recoverOrphans: true,
            orphanBeforeMs: cutoff,
            pruneMissing: state.prunePending,
            recoveryCursor: state.recoveryCursor,
            recoveryInspectLimit: 128,
            recoveryDeleteLimit: 64,
            recoveryDirectoryInspectLimit: 4096,
            maxDetachBatches: 1,
            maxPruneBatches: 1,
            maxRecoveryPages: 1,
            bumpCacheEpoch: firstSlice,
            task,
            signal,
            deadlineAt,
            onBlocked: reportBlocked(0, deadlineAt),
          });
            return {
              complete: slice.maintenanceComplete === true,
              nextState: {
                recoveryCursor: slice.recoveryCursor || state.recoveryCursor,
                detachPending: slice.detachComplete === false,
                prunePending: slice.pruneComplete === false,
              },
              metricsDelta: Object.fromEntries(['deletedCount', 'deletedBytes', 'detachedCount', 'detachedBytes', 'prunedSourceCount', 'repairedMissingCount', 'recoveryInspectedCount', 'orphanScanConsumedCount', 'orphanProgressCount', 'retryConsumedCount', 'failedCount'].map(field => [field, Number(slice[field]) || 0])),
              processedDelta: slice.processedCount,
              foregroundWaitMs: slice.foregroundWaitMs,
              phase: slice.maintenanceComplete ? 'complete' : slice.detachComplete === false ? 'detach' : slice.pruneComplete === false ? 'prune' : 'orphan-recovery',
            };
          },
          reportProgress: ({ processedCount, phase, deadlineAt, report }) => report(
            Math.min(95, 5 + Math.floor(processedCount / 64)),
            `缓存维护：${phase}，已处理 ${processedCount} 条`,
            { maintenancePhase: phase, processedCount, deadlineAt },
          ),
          reportSliceMetrics,
        });
        result = { ...run.metrics, maintenanceComplete: true };
      }
      task.report(100, `已清理 ${result.deletedCount} 个缓存文件`);
      mediaCacheIndexes.delete(path.resolve(cacheDir));
      return { deletedCount: result.deletedCount, prunedSourceCount: result.prunedSourceCount || 0 };
    }, () => runCacheCleanup(cacheConfig, olderThanDays, { origin }));
    return execution;
  };
  backgroundTasks?.registerTypeRestartFactory?.('cache-cleanup', task => runCacheCleanup(
    task.metadata?.cacheConfig || {}, task.metadata?.olderThanDays, { origin: task.metadata?.origin }, task,
  ));

  ipcMain.handle('media-cache-clear', async (_event, cacheConfig = {}, olderThanDays, options = {}) => {
    try {
      const execution = await runCacheCleanup(cacheConfig, olderThanDays, options);
      return { success: true, deletedCount: execution.result.deletedCount, prunedSourceCount: execution.result.prunedSourceCount, taskId: execution.task.id };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
};

module.exports = { registerMediaIpc };
