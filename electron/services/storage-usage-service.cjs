const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
const DIRTY_STATE_VERSION = 1;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OFFLINE_RETRY_MIN_MS = 30 * 1000;
const OFFLINE_RETRY_MAX_MS = 15 * 60 * 1000;
const BACKUP_STORE_DIRECTORY = '.photoflow-backup';

const exists = filePath => fs.promises.access(filePath).then(() => true, error => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});
const comparable = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const volumeRoot = value => {
  const resolved = path.resolve(value);
  if (process.platform === 'win32') {
    const unc = resolved.match(/^(\\\\[^\\]+\\[^\\]+)/);
    if (unc) return `${unc[1]}\\`;
  }
  return path.parse(resolved).root || resolved;
};
const roleDetails = {
  workspace: { label: '工作区项目', priority: 1 },
  inspiration: { label: '灵感库', priority: 2 },
  cache: { label: '缓存和数据', priority: 3 },
  internal: { label: '缓存和数据', priority: 3 },
  archive: { label: '归档项目', priority: 4 },
  backup: { label: '备份数据', priority: 5 },
};

const createStorageUsageService = ({ app, backgroundTasks, eventBus, getWorkspaceDatabasePath, getWorkspaceDataRoot, readSavedConfig, resolveMediaCacheDirectory, writeLog }) => {
  const cachePath = path.join(app.getPath('userData'), 'storage-usage-cache.json');
  const dirtyPath = path.join(app.getPath('userData'), 'storage-usage-dirty.json');
  const invalidatingTaskTypes = new Set(['project-file-operation', 'project-archive', 'project-unarchive', 'workspace-backup', 'backup-cleanup', 'workspace-restore', 'project-restore', 'cache-cleanup', 'deleted-project-cleanup']);
  const mutationActiveStates = new Set(['queued', 'running', 'pausing', 'paused', 'resuming']);
  const activeMutationTasks = () => backgroundTasks.list().filter(task => invalidatingTaskTypes.has(task.type) && mutationActiveStates.has(task.state));
  const offlinePathError = async (error, sourcePath) => {
    const code = String(error?.code || '').toUpperCase();
    if (['ENOENT', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ENODEV', 'ENXIO', 'ETIMEDOUT'].includes(code)) return true;
    const resolved = path.resolve(sourcePath);
    const unc = process.platform === 'win32' && resolved.startsWith('\\\\');
    if (unc && code === 'UNKNOWN') return true;
    if (unc && code === 'EACCES' && typeof fs.promises.statfs === 'function') {
      try { await fs.promises.statfs(volumeRoot(resolved)); return false; }
      catch (probeError) { return ['ENOENT', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ENODEV', 'ENXIO', 'ETIMEDOUT', 'UNKNOWN'].includes(String(probeError?.code || '').toUpperCase()); }
    }
    if (process.platform === 'win32' && code === 'UNKNOWN' && /^[A-Za-z]:\\/.test(resolved)) {
      try { await fs.promises.access(volumeRoot(resolved)); }
      catch (rootError) { return ['ENOENT', 'ENODEV', 'ENXIO', 'UNKNOWN'].includes(String(rootError?.code || '').toUpperCase()); }
    }
    return false;
  };
  let invalidatedAt = 0;
  let dirtyGeneration = 0;
  let dirtyLoadPromise = null;
  let dirtyUpdatePromise = Promise.resolve();
  let dirtyCorrupt = false;
  let offlineNextRetryAt = 0;
  let offlineRetryDelayMs = OFFLINE_RETRY_MIN_MS;
  const dirtyTaskStates = new Map();
  const loadDirtyGeneration = async () => {
    if (!dirtyLoadPromise) dirtyLoadPromise = fs.promises.readFile(dirtyPath, 'utf8').then(text => {
      try { return JSON.parse(text); }
      catch { dirtyCorrupt = true; return null; }
    }, error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }).then(value => {
      dirtyGeneration = Number.isSafeInteger(value?.generation) && value.generation >= 0 ? value.generation : (dirtyCorrupt ? 1 : 0);
      for (const [id, state] of Array.isArray(value?.taskStates) ? value.taskStates : []) if (typeof id === 'string' && typeof state === 'string') dirtyTaskStates.set(id, state);
    });
    await dirtyLoadPromise;
    return dirtyGeneration;
  };
  const persistDirtyGeneration = async generation => {
    const temporary = `${dirtyPath}.${process.pid}.${Date.now()}.tmp`;
    const taskStates = [...dirtyTaskStates.entries()].slice(-512);
    await fs.promises.writeFile(temporary, JSON.stringify({ version: DIRTY_STATE_VERSION, generation, taskStates }), 'utf8');
    await fs.promises.rename(temporary, dirtyPath).catch(async error => {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await fs.promises.rm(dirtyPath, { force: true });
      await fs.promises.rename(temporary, dirtyPath);
    });
  };
  eventBus?.on('background-task:changed', delta => {
    const relevant = (delta?.upserts || []).filter(task => invalidatingTaskTypes.has(task.type) && ['running', 'completed', 'failed', 'cancelled', 'canceled'].includes(task.state));
    if (relevant.length) {
      dirtyUpdatePromise = dirtyUpdatePromise.then(() => loadDirtyGeneration()).then(() => {
        let changed = false;
        for (const task of relevant) {
          const id = String(task.id || `${task.type}:${task.dedupeKey || ''}`);
          const state = task.state === 'canceled' ? 'cancelled' : task.state;
          if (dirtyTaskStates.get(id) === state) continue;
          dirtyTaskStates.delete(id); dirtyTaskStates.set(id, state);
          dirtyGeneration += 1; changed = true;
        }
        if (!changed) return undefined;
        invalidatedAt = Date.now();
        return persistDirtyGeneration(dirtyGeneration);
      }).catch(error => writeLog?.('warn', 'Storage usage dirty state update failed', { error: error.message || String(error) }));
    }
  });

  const workspaceId = async root => {
    try {
      const id = (await fs.promises.readFile(path.join(root, '.photoflow-workspace-id'), 'utf8')).trim();
      if (!id || id.includes('\0') || id === '.' || id === '..' || path.basename(id) !== id || id.includes('/') || id.includes('\\')) throw new Error('工作区 ID 不是安全的单路径组件');
      return id;
    }
    catch (error) { if (await offlinePathError(error, root)) return ''; throw error; }
  };

  const configuredSources = async () => {
    const config = readSavedConfig() || {};
    const workspaceRoots = [config.workspacePath, ...(Array.isArray(config.workspacePaths) ? config.workspacePaths : [])]
      .map(value => String(value || '').trim())
      .filter((value, index, values) => value && values.findIndex(candidate => comparable(candidate) === comparable(value)) === index);
    const sources = [];
    const add = (kind, sourcePath) => {
      if (!sourcePath) return;
      const absolute = path.resolve(sourcePath);
      const key = `${kind}:${comparable(absolute)}`;
      if (!sources.some(item => item.key === key)) sources.push({ key, kind, label: roleDetails[kind].label, path: absolute });
    };
    const workspaceIds = [];
    for (const workspaceRoot of workspaceRoots) {
      add('workspace', workspaceRoot);
      const id = await workspaceId(workspaceRoot);
      if (id) {
        workspaceIds.push(id);
        add('internal', getWorkspaceDataRoot(workspaceRoot));
        add('internal', getWorkspaceDatabasePath(workspaceRoot));
      }
    }
    const inspirationRoot = String(config.inspirationLibrary?.rootPath || '').trim();
    if (inspirationRoot) add('inspiration', inspirationRoot);
    const archiveTarget = String(config.archive?.targetPath || '').trim();
    if (archiveTarget) for (const id of workspaceIds) add('archive', path.join(archiveTarget, id));
    const backupTarget = String(config.backup?.targetPath || '').trim();
    if (backupTarget) add('backup', path.join(backupTarget, BACKUP_STORE_DIRECTORY));
    const cacheRoot = typeof resolveMediaCacheDirectory === 'function'
      ? resolveMediaCacheDirectory(config.mediaCache || {})
      : String(config.mediaCache?.directory || '').trim() || path.join(app.getPath('userData'), 'media-cache');
    add('cache', cacheRoot);
    const canonical = await Promise.all(sources.map(async source => {
      let online = true;
      const physical = await fs.promises.realpath(source.path).catch(async error => {
        if (await offlinePathError(error, source.path)) { online = false; return path.resolve(source.path); }
        throw error;
      });
      return { ...source, physicalKey: comparable(physical), online };
    }));
    return canonical.sort((left, right) => left.key.localeCompare(right.key));
  };

  const signatureFor = sources => JSON.stringify(sources.map(item => [item.kind, comparable(item.path), item.physicalKey]));
  const readCache = async signature => {
    if (dirtyCorrupt) return null;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
      if (parsed?.version !== CACHE_VERSION || parsed.signature !== signature || !Array.isArray(parsed.sources)) return null;
      const updatedAt = Number(parsed.updatedAt);
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || updatedAt > Date.now() + 5 * 60 * 1000
        || !Number.isSafeInteger(parsed.generation) || parsed.generation < 0
        || parsed.sources.some(source => !source || typeof source !== 'object'
          || typeof source.key !== 'string' || typeof source.kind !== 'string' || typeof source.path !== 'string'
          || !Number.isSafeInteger(Number(source.bytes)) || Number(source.bytes) < 0
          || !Number.isSafeInteger(Number(source.files)) || Number(source.files) < 0
          || typeof source.online !== 'boolean')) return null;
      return parsed;
    } catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  };
  const writeCache = async value => {
    const temporary = `${cachePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await fs.promises.rm(cachePath, { force: true });
    await fs.promises.rename(temporary, cachePath);
  };

  const scanPath = async (sourcePath, task, state, excludedPaths = new Set()) => {
    const initial = await fs.promises.lstat(sourcePath).catch(async error => {
      if (await offlinePathError(error, sourcePath)) return null;
      throw error;
    });
    if (!initial) return { bytes: 0, files: 0, online: false };
    if (initial.isSymbolicLink()) return { bytes: 0, files: 0, online: true };
    if (initial.isFile()) return { bytes: initial.size, files: 1, online: true };
    let bytes = 0;
    let files = 0;
    const pending = [sourcePath];
    while (pending.length) {
      task.throwIfCancelled();
      const directory = pending.pop();
      const handle = await fs.promises.opendir(directory);
      try { for await (const entry of handle) {
        task.throwIfCancelled();
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (excludedPaths.has(comparable(absolute))) continue;
        if (entry.isDirectory()) pending.push(absolute);
        else if (entry.isFile()) {
          const stat = await fs.promises.stat(absolute);
          task.throwIfCancelled();
          bytes += stat.size; files += 1;
        }
        state.processed += 1;
        if (state.processed % 256 === 0) {
          task.report(Math.min(95, 5 + state.processed / 2000), `正在统计文件，占用 ${Math.round(bytes / 1024 / 1024)} MB`, { processedEntries: state.processed });
          await new Promise(resolve => setImmediate(resolve));
        }
      } } finally { await handle.close().catch(error => { if (error?.code !== 'ERR_DIR_CLOSED') throw error; }); }
    }
    return { bytes, files, online: true };
  };

  const capacityFor = async sourcePath => {
    const available = async candidate => fs.promises.access(candidate).then(() => true, async error => {
      if (await offlinePathError(error, candidate)) return false;
      throw error;
    });
    if (typeof fs.promises.statfs !== 'function') return { online: await available(sourcePath) };
    let probe = path.resolve(sourcePath);
    const root = volumeRoot(probe);
    while (!await available(probe)) {
      if (comparable(probe) === comparable(root)) return { online: false };
      const parent = path.dirname(probe);
      if (parent === probe) return { online: false };
      probe = parent;
    }
    const stat = await fs.promises.statfs(probe);
    return { online: true, totalBytes: Number(stat.blocks) * Number(stat.bsize), freeBytes: Number(stat.bavail) * Number(stat.bsize) };
  };

  const runScan = async (sources, signature, restartTask = null) => backgroundTasks.run({
    ...(restartTask?.id ? { id: restartTask.id } : {}),
    type: 'storage-usage-scan',
    title: '统计 PhotoFlow 存储占用',
    dedupeKey: 'storage-usage-scan',
    cancellable: true,
    metadata: { signature, sourceCount: sources.length },
  }, async task => {
    await dirtyUpdatePromise;
    if (activeMutationTasks().length) throw Object.assign(new Error('存在活动的数据变更任务，已延后存储占用扫描'), { code: 'STORAGE_USAGE_SCAN_MUTATION_ACTIVE' });
    const scanGeneration = await loadDirtyGeneration();
    const state = { processed: 0 };
    const measured = [];
    for (const [index, source] of sources.entries()) {
      task.report(index / Math.max(1, sources.length) * 95, `正在统计${source.label}`);
      const excludedPaths = new Set(sources.filter(other => other.key !== source.key && inside(source.path, other.path)).map(other => comparable(other.path)));
      const result = await scanPath(source.path, task, state, excludedPaths);
      measured.push({ ...source, ...result });
    }
    await dirtyUpdatePromise;
    await loadDirtyGeneration();
    if (activeMutationTasks().length) throw Object.assign(new Error('扫描结束时仍有活动的数据变更任务，结果已丢弃'), { code: 'STORAGE_USAGE_SCAN_MUTATION_ACTIVE' });
    if (dirtyGeneration !== scanGeneration) {
      const error = new Error('存储占用扫描期间数据发生变化，结果已丢弃');
      error.code = 'STORAGE_USAGE_SCAN_DIRTY';
      throw error;
    }
    if (dirtyCorrupt) { await persistDirtyGeneration(dirtyGeneration); dirtyCorrupt = false; }
    const cache = { version: CACHE_VERSION, signature, generation: scanGeneration, updatedAt: Date.now(), sources: measured };
    await writeCache(cache);
    task.report(100, '存储占用统计完成', { updatedAt: cache.updatedAt });
    return cache;
  });

  const overview = async (force = false) => {
    await dirtyUpdatePromise;
    await loadDirtyGeneration();
    const sources = await configuredSources();
    const signature = signatureFor(sources);
    let cache = await readCache(signature);
    const active = backgroundTasks.list().some(task => task.type === 'storage-usage-scan' && ['queued', 'running'].includes(task.state));
    const mutationActive = activeMutationTasks().length > 0;
    const cachedByKeyForFreshness = new Map((cache?.sources || []).map(item => [item.key, item]));
    const connectivityChanged = sources.some(source => Boolean(cachedByKeyForFreshness.get(source.key)?.online) !== Boolean(source.online));
    const offlineResult = sources.some(source => !source.online) || (cache?.sources || []).some(source => source.online === false);
    const stale = !cache || Number(cache.generation ?? 0) !== dirtyGeneration || Number(cache.updatedAt || 0) < invalidatedAt
      || Date.now() - Number(cache.updatedAt || 0) >= CACHE_MAX_AGE_MS || connectivityChanged || offlineResult;
    const now = Date.now();
    const allSourcesOnline = sources.every(source => source.online);
    if (allSourcesOnline) { offlineNextRetryAt = 0; offlineRetryDelayMs = OFFLINE_RETRY_MIN_MS; }
    const retryAllowed = force || connectivityChanged || !offlineResult || now >= offlineNextRetryAt;
    const shouldStart = (force || stale) && retryAllowed && !active && !mutationActive;
    if (shouldStart) {
      if (offlineResult) {
        offlineNextRetryAt = now + offlineRetryDelayMs;
        offlineRetryDelayMs = Math.min(OFFLINE_RETRY_MAX_MS, offlineRetryDelayMs * 2);
      }
      void runScan(sources, signature).catch(error => writeLog?.('warn', 'Storage usage scan failed', { error: error.message || String(error) }));
    }
    if (!cache) cache = { updatedAt: 0, sources: [] };
    const cachedByKey = new Map(cache.sources.map(item => [item.key, item]));
    const volumes = new Map();
    const countedPhysicalPaths = new Map();
    for (const source of sources) {
      const root = volumeRoot(source.path);
      const id = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
      if (!volumes.has(id)) {
        const capacity = await capacityFor(source.path);
        volumes.set(id, { id, label: root.replace(/[\\/]$/, '') || root, root, online: capacity.online, totalBytes: capacity.totalBytes, freeBytes: capacity.freeBytes, photoflowBytes: 0, items: [] });
      }
      const volume = volumes.get(id);
      if (!source.online) volume.online = false;
      const cached = cachedByKey.get(source.key);
      const bytes = Number(cached?.bytes || 0);
      const physicalKey = source.physicalKey;
      const counted = countedPhysicalPaths.get(physicalKey);
      if (!counted) { volume.photoflowBytes += bytes; countedPhysicalPaths.set(physicalKey, { bytes, volume }); }
      else if (bytes > counted.bytes) { counted.volume.photoflowBytes += bytes - counted.bytes; counted.bytes = bytes; }
      volume.items.push({ kind: source.kind, label: source.label, path: source.path, bytes, measured: Boolean(cached) });
    }
    for (const volume of volumes.values()) {
      volume.items.sort((left, right) => roleDetails[left.kind].priority - roleDetails[right.kind].priority || left.path.localeCompare(right.path));
      const used = Number(volume.totalBytes || 0) - Number(volume.freeBytes || 0);
      volume.otherBytes = Math.max(0, used - volume.photoflowBytes);
    }
    const nowActive = backgroundTasks.list().some(task => task.type === 'storage-usage-scan' && ['queued', 'running'].includes(task.state));
    const orderedVolumes = [...volumes.values()].sort((left, right) => {
      const priority = volume => Math.min(...volume.items.map(item => roleDetails[item.kind].priority));
      return priority(left) - priority(right)
        || String(left.label || left.root).localeCompare(String(right.label || right.root), undefined, { numeric: true, sensitivity: 'base' });
    });
    return { success: true, updatedAt: Number(cache.updatedAt || 0), scanning: nowActive || shouldStart, stale, blockedByMutation: mutationActive,
      ...(offlineResult && offlineNextRetryAt > now ? { nextRetryAt: offlineNextRetryAt } : {}), volumes: orderedVolumes };
  };

  backgroundTasks.registerTypeRestartFactory?.('storage-usage-scan', async task => {
    const sources = await configuredSources();
    return runScan(sources, signatureFor(sources), task);
  }, { autoRestart: true });

  return { overview };
};

module.exports = { createStorageUsageService };
