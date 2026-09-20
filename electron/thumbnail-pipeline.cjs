const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { spawn } = require('child_process');
const { ThumbnailCoordinator } = require('./services/thumbnail-coordinator.cjs');
const { stopProcessAndWait } = require('./infrastructure/process-termination.cjs');
const { isInternalWorkspacePath } = require('./infrastructure/internal-workspace-path.cjs');

// v3 switches media covers from square crops to full-frame thumbnails.
// v4 rejects undersized Windows Shell images that were previously cached as
// larger tiers and therefore looked visibly soft when the renderer enlarged them.
const THUMBNAIL_VERSION = 4;
const THUMBNAIL_MAINTENANCE_TIMEOUT_MS = 10 * 60 * 1000;
const THUMBNAIL_BACKUP_RECOVERY_PREFIX = 'thumbnail-publish-backup-recovery:';
const THUMBNAIL_SIZES = [
  { label: 'small', pixels: 320 },
  { label: 'medium', pixels: 640 },
  { label: 'large', pixels: 1600 },
];
const PRIORITY = { visible: 0, nearby: 1, directory: 2, project: 3 };
const pathKey = filePath => process.platform === 'win32' ? path.resolve(filePath).toLocaleLowerCase() : path.resolve(filePath);
const taskCompletion = () => {
  let resolve;
  const promise = new Promise(accepted => { resolve = accepted; });
  return { promise, resolve };
};

const chooseSize = requestedSize => {
  const requested = Math.max(1, Number(requestedSize) || 640);
  return THUMBNAIL_SIZES.find(item => requested <= item.pixels) || THUMBNAIL_SIZES[THUMBNAIL_SIZES.length - 1];
};

const isThumbnailSizeSufficient = (width, height, requestedSize) => {
  const longestEdge = Math.max(Number(width) || 0, Number(height) || 0);
  const requested = Math.max(1, Number(requestedSize) || 640);
  return longestEdge >= Math.ceil(requested * 0.75);
};

let thumbnailDatabaseSequence = 0;

class ThumbnailDatabaseClient {
  constructor({ getRunConfig, databasePath, log, serviceArgs = [], processSupervisor = null }) {
    this.getRunConfig = getRunConfig;
    this.databasePath = databasePath;
    this.log = log;
    this.serviceArgs = serviceArgs;
    this.processSupervisor = processSupervisor;
    this.processId = `python:thumbnail-database:${++thumbnailDatabaseSequence}`;
    this.managedProcess = null;
    this.process = null;
    this.nextId = 0;
    this.pending = new Map();
    this.terminationReasons = new WeakMap();
    this.processStops = new WeakMap();
    this.processReady = new WeakMap();
    this.terminationPromise = null;
    this.stopFailure = null;
    this.permanentlyStopped = false;
  }

  stopChildAndWait(child, reason, timeoutMs = 2000) {
    const existing = this.processStops.get(child);
    if (existing) return existing;
    let resolveBarrier;
    let rejectBarrier;
    const barrier = new Promise((resolve, reject) => { resolveBarrier = resolve; rejectBarrier = reject; });
    this.processStops.set(child, barrier);
    this.terminationPromise = barrier;
    this.terminationReasons.set(child, reason);
    if (this.process === child) this.process = null;
    const managed = this.managedProcess?.child === child || this.managedProcess?.lifecycle?.child === child ? this.managedProcess : null;
    const stopping = Promise.resolve().then(() => managed
      ? managed.stop(reason, { timeoutMs, rollbackSettleMs: 25 })
      : stopProcessAndWait(child, timeoutMs, { rollbackSettleMs: 25 }));
    stopping.then(result => {
      this.stopFailure = null;
      if (this.managedProcess === managed) this.managedProcess = null;
      resolveBarrier(result);
    }, error => {
      this.stopFailure = error;
      this.processStops.delete(child);
      try { this.log('error', 'Thumbnail database shutdown could not be confirmed', { processId: this.processId, error: error.message || String(error), code: error.code }); } catch { /* preserve the termination error */ }
      rejectBarrier(error);
    }).finally(() => {
      if (this.terminationPromise === barrier) this.terminationPromise = null;
    });
    return barrier;
  }

  ensureProcess() {
    if (this.permanentlyStopped) throw Object.assign(new Error('thumbnail database client stopped'), { code: 'THUMBNAIL_STOPPED' });
    if (this.stopFailure) throw this.stopFailure;
    if (this.process && !this.process.killed) return this.process;
    if (this.managedProcess && !this.managedProcess.released) {
      if (this.managedProcess.child && !this.managedProcess.child.killed) return this.managedProcess.child;
      if (this.managedProcess.state === 'restarting') return this.managedProcess.start();
      this.managedProcess.release();
      this.managedProcess = null;
    }
    const run = this.getRunConfig('thumbnail_db.py', ['--server', '--db', this.databasePath, ...this.serviceArgs]);
    if (this.processSupervisor) {
      this.managedProcess = this.processSupervisor.launch({
        id: this.processId,
        kind: 'python-worker',
        command: run.command,
        args: run.args,
        options: { stdio: ['pipe', 'pipe', 'pipe'] },
        restart: { enabled: true, maxRestarts: 3, windowMs: 60000, backoffMs: [100, 400, 1200] },
        onSpawn: (child, managed) => this.attachProcess(child, managed),
      });
      return this.managedProcess.child;
    }
    const child = spawn(run.command, run.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.attachProcess(child, null);
    return child;
  }

  attachProcess(child, managedProcess) {
    this.process = child;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.processReady.set(child, ready);
    void ready.catch(() => undefined);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      output += data;
      const lines = output.split(/\r?\n/);
      output = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          managedProcess?.markHealthy({ protocol: 'json-lines' });
          if (response.type === 'ready') {
            this.lastHandshake = response;
            resolveReady(response);
            continue;
          }
          const request = this.pending.get(response.id);
          if (!request || request.child !== child) continue;
          this.pending.delete(response.id);
          clearTimeout(request.timer);
          if (response.success) request.resolve(response.result);
          else {
            const error = new Error(response.error || 'SQLite thumbnail service failed');
            if (response.code) error.code = response.code;
            request.reject(error);
          }
        } catch (error) {
          this.log('warn', 'Unable to parse thumbnail database response', { error: error.message, line: line.slice(0, 500) });
        }
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    // A timed-out service is deliberately killed. Its writable stream may emit
    // EPIPE before the child exit event; consume it here and let pending calls
    // receive the more useful service-termination error below.
    child.stdin.on('error', () => undefined);
    const finishRequests = (error) => {
      rejectReady(error);
      if (this.process === child) this.process = null;
      for (const [id, request] of this.pending.entries()) {
        if (request.child !== child) continue;
        clearTimeout(request.timer);
        request.reject(error);
        this.pending.delete(id);
      }
    };
    const finish = error => {
      const barrier = this.processStops.get(child);
      if (barrier) void barrier.then(() => finishRequests(error), stopError => finishRequests(stopError));
      else finishRequests(error);
    };
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(this.terminationReasons.get(child) || stderr.trim() || `Thumbnail database service exited with code ${code}`)));
  }

  call(op, args = {}, timeoutMs = 30000) {
    if (this.terminationPromise) return this.terminationPromise.then(() => this.call(op, args, timeoutMs));
    const child = this.ensureProcess();
    const ready = this.processReady.get(child);
    if (!ready) return Promise.reject(new Error('Thumbnail database service has no readiness handshake'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('Thumbnail database service readiness timed out'), { code: 'THUMBNAIL_DATABASE_READY_TIMEOUT' });
        void this.stopChildAndWait(child, 'thumbnail-database-readiness-timeout').then(() => reject(error), reject);
      }, Math.min(10000, timeoutMs));
      ready.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    }).then(() => this.callReady(child, op, args, timeoutMs));
  }

  callReady(child, op, args = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        const timedOut = this.pending.get(id);
        if (!timedOut || timedOut.child !== child) return;
        this.pending.delete(id);
        const error = Object.assign(new Error(`Thumbnail database request timed out: ${op}`), { code: 'THUMBNAIL_DATABASE_TIMEOUT' });
        // A synchronous Python handler can be stuck in filesystem I/O. Merely
        // rejecting this request leaves every later operation trapped behind
        // it, so recycle the service and let the caller retry safely via WAL.
        void this.stopChildAndWait(child, `Thumbnail database service recycled after ${op} timed out`).then(() => reject(error), reject);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      try {
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`, error => {
          if (!error) return;
          const request = this.pending.get(id);
          if (!request || request.child !== child) return;
          this.pending.delete(id);
          clearTimeout(request.timer);
          request.reject(error);
        });
      } catch (error) {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        request.reject(error);
      }
    });
  }

  stop(permanent = false) {
    if (permanent) this.permanentlyStopped = true;
    if (this.terminationPromise) return this.terminationPromise;
    const child = this.process;
    if (child) return this.stopChildAndWait(child, 'thumbnail-database-stop');
    if (this.managedProcess) {
      const managed = this.managedProcess;
      if (managed.lifecycle?.child) return this.stopChildAndWait(managed.lifecycle.child, 'thumbnail-database-stop');
      return managed.stop('thumbnail-database-stop');
    }
    return Promise.resolve();
  }
}

class MemoryThumbnailCache {
  constructor(maxBytes = 128 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.totalBytes = 0;
    this.items = new Map();
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    this.items.delete(key);
    this.items.set(key, item);
    return item.filePath;
  }

  put(key, filePath, bytes) {
    const current = this.items.get(key);
    if (current) this.totalBytes -= current.bytes;
    // Cache the durable thumbnail path, not its expiring media-access URL.
    // A fresh grant must be issued every time the thumbnail is returned.
    const item = { bytes, filePath };
    this.items.delete(key);
    this.items.set(key, item);
    this.totalBytes += item.bytes;
    while (this.totalBytes > this.maxBytes && this.items.size > 1) {
      const oldestKey = this.items.keys().next().value;
      const oldest = this.items.get(oldestKey);
      this.items.delete(oldestKey);
      this.totalBytes -= oldest.bytes;
    }
    return item.filePath;
  }

  deleteFile(filePath) {
    const prefix = `${pathKey(filePath)}|`;
    for (const [key, item] of this.items) {
      if (!key.startsWith(prefix)) continue;
      this.items.delete(key);
      this.totalBytes -= item.bytes;
    }
  }

  clear() {
    this.items.clear();
    this.totalBytes = 0;
  }
}

class ThumbnailPipeline {
  constructor({ getRunConfig, databasePath, getCacheDir, cacheFilePath, generateThumbnailSet,
    toPreviewUrl, trimCache, notify, log, concurrency = 2, maxBackgroundTasks = 1000,
    sourceStabilityDelayMs = 350, sourceStabilityProbeMs = 100, processSupervisor = null,
    slowWriteRetryWindowMs = 5000, databaseServiceArgs = [], resolveCacheDir = getCacheDir }) {
    this.databaseConfig = { getRunConfig, databasePath, log, processSupervisor, serviceArgs: databaseServiceArgs };
    this.database = new ThumbnailDatabaseClient(this.databaseConfig);
    this.resolveCacheDir = resolveCacheDir;
    this.coordinator = new ThumbnailCoordinator({
      touchFlusher: touches => this.database.call('touch_thumbnails', { touches }),
      log,
    });
    this.maintenanceContext = new AsyncLocalStorage();
    this.getCacheDir = getCacheDir;
    this.cacheFilePath = cacheFilePath;
    this.generateThumbnailSet = generateThumbnailSet;
    this.toPreviewUrl = toPreviewUrl;
    this.trimCache = trimCache;
    this.notify = notify;
    this.log = log;
    this.concurrency = concurrency;
    this.maxBackgroundTasks = maxBackgroundTasks;
    this.activeWorkers = 0;
    this.memory = new MemoryThumbnailCache();
    this.publicationReads = new Map();
    this.diskTouchTimes = new Map();
    this.tasks = new Map();
    this.queues = [[], [], [], []];
    this.directoryIndexes = new Map();
    this.projectScans = new Map();
    this.projectIndexUpdates = new Map();
    this.projectScanQueue = [];
    this.activeProjectScans = 0;
    this.databaseMaintenanceDepth = 0;
    this.databaseMaintenanceTail = Promise.resolve();
    this.projectScanIdleWaiters = new Set();
    this.projectScanPumpTimer = null;
    this.thumbnailPumpTimer = null;
    this.backgroundResumeTimer = null;
    this.sourceChangeVersions = new Map();
    this.sourceStabilityDelayMs = sourceStabilityDelayMs;
    this.sourceStabilityProbeMs = sourceStabilityProbeMs;
    this.slowWriteRetryWindowMs = slowWriteRetryWindowMs;
    this.lastForegroundActivityAt = Date.now();
    this.directoryIdleDelayMs = 1500;
    this.projectIdleDelayMs = 5000;
    this.stopped = false;
    this.activeCacheRootKey = null;
    this.cacheRootGeneration = 0;
    this.cacheRootTransition = Promise.resolve();
    this.delayedRetryTimers = new Set();
    this.activeProjectScanner = null;
    this.activeOperations = new Set();
  }

  noteForegroundActivity() {
    if (this.stopped) return;
    this.lastForegroundActivityAt = Date.now();
    if (this.backgroundResumeTimer) clearTimeout(this.backgroundResumeTimer);
    this.backgroundResumeTimer = setTimeout(() => {
      this.backgroundResumeTimer = null;
      if (this.stopped) return;
      this.pump();
      this.pumpProjectScans();
    }, this.directoryIdleDelayMs);
  }

  cacheDirectory(cacheConfig = {}) {
    return this.resolveCacheDir(cacheConfig);
  }

  ensureCacheDirectory(cacheConfig = {}) { return this.getCacheDir(cacheConfig); }

  async cacheDirectoryFingerprint(cacheRoot) {
    const signature = async target => {
      const stat = await fs.promises.stat(target, { bigint: true }).catch(() => null);
      if (!stat?.isDirectory()) return 'missing';
      return `${stat.dev}:${stat.ino}:${stat.mtimeNs}`;
    };
    const root = path.resolve(cacheRoot);
    const [rootSignature, stagingSignature] = await Promise.all([
      signature(root),
      signature(path.join(root, '.staging')),
    ]);
    return { version: 1, root: rootSignature, staging: stagingSignature };
  }

  async isSafeManagedCachePath(cacheRoot, candidate) {
    const root = path.resolve(cacheRoot);
    const resolved = path.resolve(candidate);
    const rootStat = await fs.promises.stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) return false;
    const stat = await fs.promises.lstat(resolved).catch(() => null);
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) return false;
    const [realRoot, realParent] = await Promise.all([
      fs.promises.realpath(root).catch(() => null),
      fs.promises.realpath(path.dirname(resolved)).catch(() => null),
    ]);
    if (!realRoot || !realParent) return false;
    const realCandidate = path.join(realParent, path.basename(resolved));
    const relative = path.relative(realRoot, realCandidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const segments = relative.split(path.sep);
    const fileName = segments.at(-1) || '';
    const finalName = /^[0-9a-f]{64}\.jpg$/i.test(fileName) && segments.length === 1;
    const stagingName = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/i.test(fileName)
      && segments.length === 2 && segments[0] === '.staging';
    return finalName || stagingName;
  }

  withIndexer(worker) {
    if (this.maintenanceContext.getStore()?.pipeline === this) return Promise.resolve().then(worker);
    return this.coordinator.withIndexer(worker);
  }

  maintenanceControl() { return this.maintenanceContext.getStore()?.control || null; }

  assertMaintenanceBoundary(control, phase, processedCount = 0) {
    control?.task?.throwIfCancelled?.();
    if (control?.signal?.aborted) throw control.signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' });
    if (Number.isFinite(control?.deadlineAt) && Date.now() >= control.deadlineAt) {
      throw Object.assign(new Error(`thumbnail maintenance deadline exceeded during ${phase}`), {
        code: 'THUMBNAIL_MAINTENANCE_DEADLINE',
        phase,
        processedCount,
      });
    }
    control?.onBlocked?.({ phase, processedCount, deadlineAt: control.deadlineAt });
  }

  maintenanceCallTimeout(control) {
    if (!Number.isFinite(control?.deadlineAt)) return THUMBNAIL_MAINTENANCE_TIMEOUT_MS;
    return Math.max(1, control.deadlineAt - Date.now());
  }

  async runThumbnailMigration(control, options) {
    let migrationCursor = options.migrationCursor && typeof options.migrationCursor === 'object'
      ? options.migrationCursor : {};
    while (true) {
      this.assertMaintenanceBoundary(control, 'thumbnail-cache-migration', control.processedCount);
      const migration = await this.database.call('run_thumbnail_cache_migration', {
        migration_version: options.migrationVersion,
        cursor: migrationCursor,
        limit: 512,
      }, this.maintenanceCallTimeout(control));
      migrationCursor = migration.cursor || migrationCursor;
      await this.database.call('maintenance_state_save', {
        key: options.completeMigrationKey,
        cursor: migrationCursor,
      }, this.maintenanceCallTimeout(control));
      control.processedCount += Number(migration.processed) || 0;
      if (!migration.done) continue;
      await this.database.call('maintenance_state_complete', {
        key: options.completeMigrationKey,
        cursor: { ...migrationCursor, migrationVersion: options.migrationVersion, userVersion: 2 },
      }, this.maintenanceCallTimeout(control));
      return migration;
    }
  }

  async waitForMaintenanceDependency(promise, control, phase) {
    while (true) {
      this.assertMaintenanceBoundary(control, phase, control.processedCount || 0);
      const pending = Symbol('pending');
      const result = await Promise.race([
        Promise.resolve(promise),
        new Promise(resolve => setTimeout(() => resolve(pending), 50)),
      ]);
      if (result !== pending) return result;
    }
  }

  setPersistentState(filePath, state, error = null) {
    return this.withIndexer(() => this.database.call('set_state', { file_path: filePath, state, error }));
  }

  backgroundWaitMs(priority) {
    const delay = priority >= PRIORITY.project ? this.projectIdleDelayMs : this.directoryIdleDelayMs;
    return Math.max(0, this.lastForegroundActivityAt + delay - Date.now());
  }

  scheduleBackgroundResume(waitMs) {
    if (this.stopped) return;
    if (this.backgroundResumeTimer) clearTimeout(this.backgroundResumeTimer);
    this.backgroundResumeTimer = setTimeout(() => {
      this.backgroundResumeTimer = null;
      if (this.stopped) return;
      this.pump();
      this.pumpProjectScans();
    }, Math.max(8, waitMs));
  }

  async waitForBackgroundIdle(priority) {
    let waitMs = this.backgroundWaitMs(priority);
    while (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
      waitMs = this.backgroundWaitMs(priority);
    }
  }

  cacheRootKey(cacheConfig = {}) {
    return pathKey(this.cacheDirectory(cacheConfig));
  }

  activateCacheRoot(cacheConfig = {}) {
    const requestedRoot = this.cacheRootKey(cacheConfig);
    const transition = this.cacheRootTransition.catch(() => undefined).then(async () => {
      if (this.stopped) throw Object.assign(new Error('thumbnail pipeline stopped'), { code: 'THUMBNAIL_STOPPED' });
      if (this.activeCacheRootKey === requestedRoot) return this.cacheRootGeneration;
      const applyRootGeneration = () => {
        this.activeCacheRootKey = requestedRoot;
        this.cacheRootGeneration += 1;
        this.memory.clear();
        for (const task of [...this.tasks.values()]) {
          if (task.input.rootGeneration === this.cacheRootGeneration) continue;
          task.rootObsolete = true;
          task.cancelled = true;
          if (task.running) continue;
          this.tasks.delete(task.key);
          task.resolveCompletion({ state: 'CANCELLED' });
        }
        for (const queue of this.queues) {
          for (let index = queue.length - 1; index >= 0; index -= 1) {
            if (queue[index].cancelled) queue.splice(index, 1);
          }
        }
      };
      if (this.activeCacheRootKey === null) applyRootGeneration();
      else {
        await this.coordinator.withMaintenance(async () => {
          await this.database.call('begin_cache_maintenance', {});
          applyRootGeneration();
        });
      }
      return this.cacheRootGeneration;
    });
    this.activeOperations.add(transition);
    void transition.finally(() => this.activeOperations.delete(transition)).catch(() => undefined);
    this.cacheRootTransition = transition;
    return transition;
  }

  assertRootGeneration(rootGeneration, cacheConfig = {}) {
    if (this.stopped) throw Object.assign(new Error('thumbnail pipeline stopped'), { code: 'THUMBNAIL_STOPPED' });
    if (rootGeneration !== this.cacheRootGeneration || this.cacheRootKey(cacheConfig) !== this.activeCacheRootKey) {
      throw Object.assign(new Error('thumbnail cache root generation changed'), { code: 'ROOT_STALE' });
    }
  }

  assertTaskRootCurrent(task) {
    if (task.rootObsolete) throw Object.assign(new Error('thumbnail cache root generation changed'), { code: 'ROOT_STALE' });
    this.assertRootGeneration(task.input.rootGeneration, task.input.cacheConfig || {});
  }

  trackActiveOperation(operation) {
    const tracked = Promise.resolve(operation);
    this.activeOperations.add(tracked);
    void tracked.finally(() => this.activeOperations.delete(tracked)).catch(() => undefined);
    return tracked;
  }

  taskKey(filePath, cacheConfig = {}) {
    return `${pathKey(filePath)}|root:${this.cacheRootKey(cacheConfig)}`;
  }

  cacheKey(filePath, stat, sizeLabel, cacheConfig = {}) {
    return `${this.taskKey(filePath, cacheConfig)}|${stat.size}|${stat.mtimeMs}|${sizeLabel}|v${THUMBNAIL_VERSION}`;
  }

  async waitForSourceStability(filePath, baselineStat, deadlineAt) {
    let previous = baselineStat;
    let changed = false;
    let stableSince = Date.now();
    while (Date.now() < deadlineAt) {
      let current;
      try {
        current = await fs.promises.stat(filePath);
        if (!current.isFile()) throw Object.assign(new Error('原始文件不存在'), { code: 'ENOENT' });
      } catch (error) {
        if (!error.code) error.code = 'ENOENT';
        throw error;
      }
      if (!previous || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs) {
        changed = true;
        stableSince = Date.now();
        previous = current;
      }
      if (Date.now() - stableSince >= this.sourceStabilityDelayMs) return { stat: current, changed, stable: true };
      await new Promise(resolve => setTimeout(resolve, Math.min(this.sourceStabilityProbeMs, Math.max(1, deadlineAt - Date.now()))));
    }
    return { stat: previous, changed, stable: false };
  }

  targetFor(filePath, stat, cacheConfig, size) {
    return this.cacheFilePath(filePath, stat, this.getCacheDir(cacheConfig), size.pixels, THUMBNAIL_VERSION);
  }

  readPublication(filePath, stat, size, rootGeneration) {
    const key = `${rootGeneration}|${pathKey(filePath)}|${size.label}|${stat.size}|${stat.mtimeMs}`;
    const existing = this.publicationReads.get(key);
    if (existing) return existing;
    const request = this.database.call('get_thumbnail_publish', {
      file_path: filePath, size_label: size.label, source_size: stat.size, source_mtime_ms: stat.mtimeMs,
    });
    this.publicationReads.set(key, request);
    void request.finally(() => { if (this.publicationReads.get(key) === request) this.publicationReads.delete(key); }).catch(() => undefined);
    return request;
  }

  async touchDiskThumbnail(target) {
    const now = Date.now();
    if (now - (this.diskTouchTimes.get(target) || 0) < 60000) return;
    if (this.diskTouchTimes.size >= 4096) this.diskTouchTimes.clear();
    this.diskTouchTimes.set(target, now);
    await fs.promises.utimes(target, new Date(now), new Date(now)).catch(() => { this.diskTouchTimes.delete(target); });
  }

  async readDisk(filePath, stat, cacheConfig, size, rootGeneration, knownPublication) {
    const target = this.targetFor(filePath, stat, cacheConfig, size);
    let handle;
    let invalidThumbnail = false;
    try {
      return await this.coordinator.withIndexer(async () => {
        this.assertRootGeneration(rootGeneration, cacheConfig);
        const durable = knownPublication === undefined ? await this.readPublication(filePath, stat, size, rootGeneration) : knownPublication;
        if (!durable || pathKey(durable.thumbnailPath) !== pathKey(target)) return null;
        const thumbnailStat = await fs.promises.stat(target);
        if (thumbnailStat.size < 128) {
          invalidThumbnail = true;
          throw new Error('thumbnail is empty or damaged');
        }
        handle = await fs.promises.open(target, 'r');
        const markers = Buffer.alloc(4);
        await handle.read(markers, 0, 2, 0);
        await handle.read(markers, 2, 2, thumbnailStat.size - 2);
        if (markers[0] !== 0xff || markers[1] !== 0xd8 || markers[2] !== 0xff || markers[3] !== 0xd9) {
          invalidThumbnail = true;
          throw new Error('thumbnail is empty or damaged');
        }
        await handle.close();
        handle = null;
        await this.touchDiskThumbnail(target);
        const cachedPath = this.memory.put(this.cacheKey(filePath, stat, size.label, cacheConfig), target, thumbnailStat.size);
        this.coordinator.touch(filePath, size.label);
        this.assertRootGeneration(rootGeneration, cacheConfig);
        return { previewUrl: this.toPreviewUrl(cachedPath), target };
      });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error?.code === 'ROOT_STALE' || error?.code === 'THUMBNAIL_STOPPED') throw error;
      // A second renderer request can arrive while the worker for this source
      // is publishing a cache tier. Never let that reader delete a file owned
      // by the in-flight task. Only remove a positively identified stale file.
      if (invalidThumbnail && !this.tasks.has(this.taskKey(filePath, cacheConfig))) {
        await this.evictCache({ thumbnailPaths: [target], cacheRoot: this.cacheDirectory(cacheConfig) }).catch(() => undefined);
      }
      return null;
    }
  }

  request(options) {
    return this.trackActiveOperation(this.requestInternal(options));
  }

  async requestInternal({ filePath, kind, cacheConfig = {}, requestedSize = 640, priority = PRIORITY.visible, queueOrder = Number.MAX_SAFE_INTEGER, requireDisk = false, forceRegenerate = false }) {
    if (this.stopped) return { success: false, state: 'NOT_READY', error: '缩略图服务已停止', cacheLayer: 'source' };
    let rootGeneration;
    try {
      rootGeneration = await this.activateCacheRoot(cacheConfig);
    } catch (error) {
      return { success: false, state: 'NOT_READY', error: error?.message || String(error), cacheLayer: 'source' };
    }
    const sourcePath = path.resolve(filePath);
    // Renderer file lists and watcher events are asynchronous. A just-created
    // publication staging file can therefore survive in one stale render even
    // after directory filtering. Never decode or persist PhotoFlow-owned
    // staging paths: they are deliberately incomplete until atomically renamed.
    if (isInternalWorkspacePath(sourcePath)) {
      return {
        success: false, state: 'NOT_READY', error: '媒体文件仍在发布中', cacheLayer: 'source',
        mediaUrl: kind === 'video' ? null : undefined,
      };
    }
    if (priority <= PRIORITY.nearby) this.noteForegroundActivity();
    const size = chooseSize(requestedSize);
    let stat;
    try {
      stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      void this.setPersistentState(sourcePath, 'MISSING').catch(() => undefined);
      return { success: false, state: 'MISSING', error: '原始文件不存在或磁盘离线' };
    }
    try { this.assertRootGeneration(rootGeneration, cacheConfig); } catch {
      return { success: false, state: 'CANCELLED', error: '缩略图缓存目录已切换', cacheLayer: 'source' };
    }

    let checkedPublication;
    if (!requireDisk && !forceRegenerate) {
      let memoryReady;
      try {
        memoryReady = await this.coordinator.withIndexer(async () => {
          this.assertRootGeneration(rootGeneration, cacheConfig);
          const memoryPath = this.memory.get(this.cacheKey(sourcePath, stat, size.label, cacheConfig));
          if (!memoryPath) return null;
          const durable = checkedPublication = await this.readPublication(sourcePath, stat, size, rootGeneration);
          if (!durable || pathKey(durable.thumbnailPath) !== pathKey(memoryPath)) return null;
          // The current database worker already stats the file while checking
          // its publication. Older workers retain the explicit fallback check.
          const exists = durable.verifiedFile === true || await fs.promises.stat(memoryPath).then(value => value.isFile(), () => false);
          if (!exists) return null;
          await this.touchDiskThumbnail(memoryPath);
          this.coordinator.touch(sourcePath, size.label);
          this.assertRootGeneration(rootGeneration, cacheConfig);
          return { previewUrl: this.toPreviewUrl(memoryPath) };
        });
      } catch (error) {
        if (error?.code === 'ROOT_STALE' || error?.code === 'THUMBNAIL_STOPPED') {
          return { success: false, state: 'CANCELLED', error: '缩略图缓存目录已切换', cacheLayer: 'source' };
        }
        memoryReady = null;
      }
      if (memoryReady) return { success: true, state: 'READY', previewUrl: memoryReady.previewUrl, cacheLayer: 'memory', mediaUrl: kind === 'video' ? null : undefined };
      this.memory.deleteFile(sourcePath);
    }

    // Merge the request into an existing task before touching its output. This
    // closes the read/delete race between a foreground request and generation.
    try { this.assertRootGeneration(rootGeneration, cacheConfig); } catch {
      return { success: false, state: 'CANCELLED', error: '缩略图缓存目录已切换', cacheLayer: 'source' };
    }
    const taskKey = this.taskKey(sourcePath, cacheConfig);
    if (this.tasks.has(taskKey)) {
      this.enqueue({ filePath: sourcePath, kind, cacheConfig, stat, persistState: false, requestedSizes: [size], queueOrder, forceRegenerate, subscribe: true, rootGeneration }, priority);
      return {
        success: true, state: 'QUEUED', cacheLayer: 'source', mediaUrl: kind === 'video' ? null : undefined,
        completion: this.tasks.get(taskKey)?.completion,
      };
    }

    if (!forceRegenerate) {
      let disk;
      try { disk = await this.readDisk(sourcePath, stat, cacheConfig, size, rootGeneration, checkedPublication); } catch (error) {
        if (error?.code === 'ROOT_STALE' || error?.code === 'THUMBNAIL_STOPPED') {
          return { success: false, state: 'CANCELLED', error: '缩略图缓存目录已切换', cacheLayer: 'source' };
        }
        throw error;
      }
      if (disk) return { success: true, state: 'READY', previewUrl: disk.previewUrl, cacheLayer: 'disk', mediaUrl: kind === 'video' ? null : undefined };
    }

    // The database index is durable metadata, not a prerequisite for showing
    // an image. Visible cache misses enter the scheduler immediately; index
    // and state writes are completed asynchronously in the background.
    try { this.assertRootGeneration(rootGeneration, cacheConfig); } catch {
      return { success: false, state: 'CANCELLED', error: '缩略图缓存目录已切换', cacheLayer: 'source' };
    }
    const accepted = this.enqueue({ filePath: sourcePath, kind, cacheConfig, stat, persistState: false, requestedSizes: [size], queueOrder, forceRegenerate, subscribe: true, rootGeneration }, priority);
    if (!accepted) {
      return { success: false, state: 'NOT_READY', error: '缩略图任务队列繁忙，请稍后重试', cacheLayer: 'source', mediaUrl: kind === 'video' ? null : undefined };
    }
    return {
      success: true, state: 'QUEUED', cacheLayer: 'source', mediaUrl: kind === 'video' ? null : undefined,
      completion: this.tasks.get(taskKey)?.completion,
    };
  }

  enqueue(input, priority = PRIORITY.project) {
    const sourcePath = path.resolve(input.filePath);
    if (this.stopped) return false;
    if (!Number.isFinite(input.rootGeneration)) {
      const requestedRoot = this.cacheRootKey(input.cacheConfig || {});
      if (this.activeCacheRootKey === null) {
        this.activeCacheRootKey = requestedRoot;
        this.cacheRootGeneration += 1;
      }
      if (this.activeCacheRootKey !== requestedRoot) return false;
      input = { ...input, rootGeneration: this.cacheRootGeneration };
    }
    if (input.rootGeneration !== this.cacheRootGeneration) return false;
    const key = this.taskKey(sourcePath, input.cacheConfig || {});
    const normalizedPriority = Math.max(0, Math.min(3, Number(priority) || 0));
    if (normalizedPriority <= PRIORITY.nearby) this.noteForegroundActivity();
    const queueOrder = Number.isFinite(Number(input.queueOrder)) ? Number(input.queueOrder) : Number.MAX_SAFE_INTEGER;
    const existing = this.tasks.get(key);
    if (existing) {
      existing.input = { ...existing.input, ...input, filePath: sourcePath };
      existing.order = Math.min(existing.order, queueOrder);
      for (const size of input.requestedSizes || [THUMBNAIL_SIZES[0]]) {
        existing.requestedSizes.set(size.label, size);
        if (input.subscribe) existing.subscribers.set(size.label, (existing.subscribers.get(size.label) || 0) + 1);
        else existing.backgroundDemand.add(size.label);
        if (input.forceRegenerate) existing.completedSizes.delete(size.label);
      }
      if (normalizedPriority < existing.priority && !existing.running) {
        existing.cancelled = true;
        const replacement = {
          key, input: existing.input, requestedSizes: existing.requestedSizes, completedSizes: existing.completedSizes,
          subscribers: existing.subscribers,
          backgroundDemand: existing.backgroundDemand,
          priority: normalizedPriority, order: existing.order, running: false, cancelled: false,
          completion: existing.completion, resolveCompletion: existing.resolveCompletion,
        };
        this.tasks.set(key, replacement);
        this.queues[normalizedPriority].push(replacement);
        this.queues[normalizedPriority].sort((left, right) => left.order - right.order);
        this.schedulePump();
      } else if (!existing.running) {
        this.queues[existing.priority].sort((left, right) => left.order - right.order);
      }
      return true;
    }
    if (normalizedPriority >= PRIORITY.directory && this.tasks.size >= this.maxBackgroundTasks) return false;
    const requestedSizes = new Map((input.requestedSizes || [THUMBNAIL_SIZES[0]]).map(size => [size.label, size]));
    const completion = taskCompletion();
    const task = {
      key, input: { ...input, filePath: sourcePath }, requestedSizes, completedSizes: new Set(),
      subscribers: new Map([...requestedSizes.keys()].map(label => [label, input.subscribe ? 1 : 0])),
      backgroundDemand: new Set(input.subscribe ? [] : requestedSizes.keys()),
      priority: normalizedPriority, order: queueOrder, running: false, cancelled: false,
      completion: completion.promise, resolveCompletion: completion.resolve,
    };
    this.tasks.set(key, task);
    this.queues[normalizedPriority].push(task);
    this.queues[normalizedPriority].sort((left, right) => left.order - right.order);
    if (input.persistState !== false) void this.setPersistentState(sourcePath, 'QUEUED').catch(() => undefined);
    this.schedulePump();
    return true;
  }

  schedulePump() {
    if (this.stopped) return;
    if (this.thumbnailPumpTimer) return;
    // Collect the IntersectionObserver requests from the same render frame so
    // visible tiles can be sorted by their actual list position before work
    // starts. Eight milliseconds is below one 60 Hz frame.
    this.thumbnailPumpTimer = setTimeout(() => {
      this.thumbnailPumpTimer = null;
      if (this.stopped) return;
      this.pump();
    }, 8);
  }

  cancel(filePath, requestedSize) {
    const sourceKey = pathKey(filePath);
    const label = chooseSize(requestedSize).label;
    let settled = false;
    for (const task of [...this.tasks.values()]) {
      if (pathKey(task.input.filePath) !== sourceKey || task.input.rootGeneration !== this.cacheRootGeneration) continue;
      const subscribers = task.subscribers.get(label) || 0;
      if (!subscribers) continue;
      settled = true;
      if (subscribers > 1) {
        task.subscribers.set(label, subscribers - 1);
        continue;
      }
      task.subscribers.delete(label);
      if (task.running) continue;
      if (task.backgroundDemand.has(label)) continue;
      task.requestedSizes.delete(label);
      if (task.requestedSizes.size) continue;
      task.cancelled = true;
      this.tasks.delete(task.key);
      task.resolveCompletion({ state: 'CANCELLED' });
    }
    return settled;
  }

  nextTask(allowBackground) {
    const highestQueue = allowBackground ? PRIORITY.project : PRIORITY.nearby;
    for (let priority = PRIORITY.visible; priority <= highestQueue; priority += 1) {
      const queue = this.queues[priority];
      if (!queue.length) continue;
      if (priority >= PRIORITY.directory) {
        const waitMs = this.backgroundWaitMs(priority);
        if (waitMs > 0) {
          this.scheduleBackgroundResume(waitMs);
          return null;
        }
      }
      while (queue.length) {
        const task = queue.shift();
        if (!task.cancelled && this.tasks.get(task.key) === task) return task;
      }
    }
    return null;
  }

  pump() {
    if (this.stopped) return;
    while (this.activeWorkers < this.concurrency) {
      // Keep one slot free for a newly selected/visible item. Long-running RAW
      // or video background work must not occupy every decoder concurrently.
      const backgroundLimit = Math.max(1, this.concurrency - 1);
      const task = this.nextTask(this.activeWorkers < backgroundLimit);
      if (!task) break;
      task.running = true;
      this.activeWorkers += 1;
      void this.runTask(task).then(
        outcome => task.resolveCompletion(outcome || { state: 'READY' }),
        error => task.resolveCompletion({ state: 'FAILED', error: error?.message || String(error) }),
      ).finally(() => {
        this.activeWorkers -= 1;
        if (this.tasks.get(task.key) === task) this.tasks.delete(task.key);
        this.pump();
      });
    }
  }

  async generateStagedThumbnailSet(filePath, stat, kind, cacheConfig, requestedSizes) {
    const cacheRoot = path.resolve(this.getCacheDir(cacheConfig));
    const stagingRoot = path.join(cacheRoot, '.staging');
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    const plan = new Map(requestedSizes.map(size => [size.label, {
      size,
      stagingPath: path.join(stagingRoot, `${crypto.randomUUID()}.jpg`),
      finalPath: this.targetFor(filePath, stat, cacheConfig, size),
    }]));
    let generated;
    try {
      generated = await this.generateThumbnailSet(
        filePath,
        stat,
        kind,
        cacheConfig,
        requestedSizes.map(size => ({ ...size, path: plan.get(size.label).stagingPath })),
      );
      const staged = [];
      for (const item of generated) {
        const target = plan.get(item.sizeLabel);
        if (!target) continue;
        const returnedPath = path.resolve(item.path);
        if (pathKey(returnedPath) !== pathKey(target.stagingPath)) {
          await fs.promises.rename(returnedPath, target.stagingPath);
        }
        const stagedStat = await fs.promises.stat(target.stagingPath);
        staged.push({
          sizeLabel: item.sizeLabel,
          pixelSize: item.pixelSize,
          stagingPath: target.stagingPath,
          finalPath: target.finalPath,
          fileSize: stagedStat.size,
        });
      }
      return staged;
    } catch (error) {
      await Promise.all([...plan.values()].map(item => fs.promises.unlink(item.stagingPath).catch(() => undefined)));
      throw error;
    }
  }

  async publishStagedThumbnailSet(filePath, capture, staged, advanceVisibility = null) {
    const ownedFinals = [];
    const replacements = [];
    const publishId = crypto.randomUUID();
    let published = [];
    let publishRequest = null;
    let commitAttempted = false;
    let commitConfirmed = false;
    let visibilityAdvanced = false;
    const makeVisible = async () => {
      if (visibilityAdvanced || typeof advanceVisibility !== 'function') return;
      await advanceVisibility(published);
      visibilityAdvanced = true;
    };
    const assertPublishRootCurrent = () => {
      if (Number.isFinite(capture.rootGeneration)
          && (capture.rootGeneration !== this.cacheRootGeneration || capture.cacheRootKey !== this.activeCacheRootKey)) {
        throw Object.assign(new Error('thumbnail cache root changed before publish'), { code: 'ROOT_STALE' });
      }
    };
    const rollbackFinals = async () => {
      const failures = [];
      for (const finalPath of ownedFinals) {
        try { await fs.promises.unlink(finalPath); } catch (error) {
          if (error?.code !== 'ENOENT') failures.push({ finalPath, phase: 'remove-owned-final', error: error?.message || String(error) });
        }
      }
      for (const item of replacements) {
        try { await fs.promises.unlink(item.finalPath); } catch (error) {
          if (error?.code !== 'ENOENT') {
            failures.push({ ...item, phase: 'remove-replacement', error: error?.message || String(error) });
            continue;
          }
        }
        try {
          await fs.promises.rename(item.backupPath, item.finalPath);
          const restored = await fs.promises.stat(item.finalPath);
          if (!restored.isFile() || restored.size !== item.backupSize) throw new Error('restored thumbnail backup failed verification');
          if (item.backupDigest) {
            const digest = crypto.createHash('sha256').update(await fs.promises.readFile(item.finalPath)).digest('hex');
            if (digest !== item.backupDigest) throw new Error('restored thumbnail backup digest mismatch');
          }
        } catch (error) {
          failures.push({ ...item, phase: 'restore-backup', error: error?.message || String(error) });
        }
      }
      if (!failures.length) return;
      const receiptKey = `${THUMBNAIL_BACKUP_RECOVERY_PREFIX}${publishId}`;
      let receiptError = null;
      try {
        await this.database.call('maintenance_state_save', {
          key: receiptKey,
          cursor: {
            version: 1,
            publishId,
            filePath,
            cacheEpoch: capture.cacheEpoch,
            sourceVersion: capture.sourceVersion,
            cacheRoot: replacements[0]?.finalPath ? path.dirname(replacements[0].finalPath) : null,
            published,
            replacements,
            ownedFinals,
            failures,
            createdAt: Date.now(),
          },
        });
      } catch (error) {
        receiptError = error;
      }
      const rollbackError = Object.assign(new Error('thumbnail publish rollback requires recovery'), {
        code: 'THUMBNAIL_PUBLISH_ROLLBACK_INCOMPLETE',
        receiptKey,
        failures,
        receiptError: receiptError?.message || null,
      });
      this.log('error', rollbackError.message, { filePath, receiptKey, failures, receiptError: rollbackError.receiptError });
      throw rollbackError;
    };
    try {
      return await this.coordinator.withPublisher(async () => {
        assertPublishRootCurrent();
        const currentSource = await fs.promises.stat(filePath);
        if (!currentSource.isFile() || currentSource.size !== capture.sourceSize || currentSource.mtimeMs !== capture.sourceMtimeMs) {
          throw Object.assign(new Error('thumbnail source changed before publish'), { code: 'SOURCE_STALE' });
        }
        const currentEpoch = await this.database.call('get_cache_epoch', {});
        if (currentEpoch.cacheEpoch !== capture.cacheEpoch) {
          throw Object.assign(new Error('thumbnail cache epoch changed before publish'), { code: 'EPOCH_STALE' });
        }
        published = [];
        for (const item of staged) {
          await fs.promises.mkdir(path.dirname(item.finalPath), { recursive: true });
          let backupPath = null;
          if (await fs.promises.access(item.finalPath).then(() => true, () => false)) {
            backupPath = path.join(path.dirname(item.stagingPath), `${crypto.randomUUID()}.jpg`);
            const previousStat = await fs.promises.stat(item.finalPath);
            const backupDigest = crypto.createHash('sha256').update(await fs.promises.readFile(item.finalPath)).digest('hex');
            await fs.promises.rename(item.finalPath, backupPath);
            replacements.push({ finalPath: item.finalPath, backupPath, backupSize: previousStat.size, backupDigest });
            try {
              await fs.promises.rename(item.stagingPath, item.finalPath);
            } catch (error) {
              throw error;
            }
          } else {
            await fs.promises.rename(item.stagingPath, item.finalPath);
            ownedFinals.push(item.finalPath);
          }
          const finalStat = await fs.promises.stat(item.finalPath);
          published.push({
            sizeLabel: item.sizeLabel,
            pixelSize: item.pixelSize,
            path: item.finalPath,
            fileSize: finalStat.size,
          });
        }
        publishRequest = {
          publish_id: publishId,
          file_path: filePath,
          cache_epoch: capture.cacheEpoch,
          source_version: capture.sourceVersion,
          source_size: capture.sourceSize,
          source_mtime_ms: capture.sourceMtimeMs,
          source_digest: capture.sourceDigest || null,
          thumbnails: published,
        };
        assertPublishRootCurrent();
        commitAttempted = true;
        await this.database.call('commit_thumbnail_publish', publishRequest);
        commitConfirmed = true;
        assertPublishRootCurrent();
        await makeVisible();
        await Promise.all(replacements.map(item => fs.promises.unlink(item.backupPath).catch(() => undefined)));
        return published;
      });
    } catch (error) {
      await Promise.all(staged.map(item => fs.promises.unlink(item.stagingPath).catch(() => undefined)));
      const explicitlyRejected = !commitConfirmed
        && (!commitAttempted || error?.code === 'EPOCH_STALE' || error?.code === 'SOURCE_STALE');
      if (explicitlyRejected) {
        await rollbackFinals();
        throw error;
      }
      try {
        const outcome = await this.resolveThumbnailPublish(publishId, publishRequest);
        if (outcome?.state === 'COMMITTED') {
          commitConfirmed = true;
          return await this.coordinator.withPublisher(async () => {
            const currentEpoch = await this.database.call('get_cache_epoch', {});
            if (currentEpoch.cacheEpoch !== capture.cacheEpoch) {
              throw Object.assign(new Error('thumbnail cache epoch changed before visibility'), { code: 'EPOCH_STALE' });
            }
            for (const item of published) {
              const finalStat = await fs.promises.stat(item.path).catch(() => null);
              if (!finalStat?.isFile() || finalStat.size !== item.fileSize) {
                throw Object.assign(new Error('published thumbnail disappeared before visibility'), { code: 'SOURCE_STALE' });
              }
            }
            await makeVisible();
            await Promise.all(replacements.map(item => fs.promises.unlink(item.backupPath).catch(() => undefined)));
            return published;
          });
        }
      } catch (resolutionError) {
        if (resolutionError?.code === 'EPOCH_STALE' || resolutionError?.code === 'SOURCE_STALE') {
          if (commitConfirmed) {
            await Promise.all(replacements.map(item => fs.promises.unlink(item.backupPath).catch(() => undefined)));
          } else await rollbackFinals();
          throw resolutionError;
        }
      }
      // Ambiguous after bounded reconnection attempts: keep owned finals. They
      // are either the committed publication or safe orphans for startup
      // recovery; deleting them could corrupt a committed READY row.
      error.publishOutcome = 'unknown';
      this.log('warn', 'Thumbnail publish result remains ambiguous; preserving final files', {
        filePath,
        publishId,
        error: error.message || String(error),
      });
      throw error;
    }
  }

  async resolveThumbnailPublish(publishId, publishRequest, attempts = 4) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const receipt = await this.database.call('resolve_thumbnail_publish', { publish_id: publishId }, 30 * 1000);
        if (receipt?.state === 'COMMITTED') return receipt;
        if (receipt?.state === 'NOT_FOUND' && publishRequest) {
          const result = await this.database.call('commit_thumbnail_publish', publishRequest, 30 * 1000);
          return { state: 'COMMITTED', committed: true, publishId, result };
        }
      } catch (error) {
        if (error?.code === 'EPOCH_STALE' || error?.code === 'SOURCE_STALE') throw error;
        if (attempt === attempts - 1) return null;
        this.log('warn', 'Unable to resolve thumbnail publish result; reconnecting', {
          publishId,
          attempt: attempt + 1,
          error: error.message || String(error),
        });
      }
      if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
    return null;
  }

  async runTask(task) {
    const { filePath, kind, cacheConfig, sourceHash } = task.input;
    let stat;
    try {
      this.assertTaskRootCurrent(task);
      stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw Object.assign(new Error('原始文件不存在'), { code: 'ENOENT' });
    } catch (error) {
      if (this.stopped || error?.code === 'ROOT_STALE' || error?.code === 'THUMBNAIL_STOPPED') return { state: 'CANCELLED' };
      const state = 'MISSING';
      void this.setPersistentState(filePath, state, error.message || String(error)).catch(() => undefined);
      this.notify({ filePath, state, error: error.message || String(error) });
      this.log('warn', 'Thumbnail source is missing', { filePath, kind, state, error: error.message || String(error) });
      return { state, error: error.message || String(error) };
    }
    try {
      this.notify({ filePath, state: 'GENERATING' });
      void this.setPersistentState(filePath, 'GENERATING').catch(() => undefined);
      while (true) {
        const requestedSizes = [...task.requestedSizes.values()].filter(size => !task.completedSizes.has(size.label));
        if (!requestedSizes.length) break;
        let published;
        let attempt = 0;
        let slowWriteDeadline = 0;
        let observedSourceChange = false;
        while (true) {
          try {
            this.assertTaskRootCurrent(task);
            const capture = await this.coordinator.withIndexer(() => this.database.call('capture_thumbnail_publish', {
              file_path: filePath,
              kind,
            }));
            stat = await fs.promises.stat(filePath);
            const staged = await this.generateStagedThumbnailSet(filePath, stat, kind, cacheConfig, requestedSizes);
            try {
              if (!staged.length) throw Object.assign(new Error('缩略图解码未产生输出；源文件可能仍在写入或内容无法解码'), { code: 'ECACHEMISS' });
              this.assertTaskRootCurrent(task);
              published = await this.publishStagedThumbnailSet(
                filePath,
                {
                  ...capture,
                  sourceDigest: sourceHash || null,
                  rootGeneration: task.input.rootGeneration,
                  cacheRootKey: this.cacheRootKey(cacheConfig),
                },
                staged,
                committed => {
                  const urls = {};
                  for (const item of committed) {
                    task.completedSizes.add(item.sizeLabel);
                    const cachedPath = this.memory.put(this.cacheKey(filePath, stat, item.sizeLabel, cacheConfig), item.path, item.fileSize);
                    urls[item.sizeLabel] = this.toPreviewUrl(cachedPath);
                  }
                  this.notify({ filePath, state: 'READY', previewUrls: urls });
                },
              );
            } finally {
              await Promise.all(staged.map(item => fs.promises.unlink(item.stagingPath).catch(() => undefined)));
            }
            break;
          } catch (error) {
            if (error?.code === 'ROOT_STALE' || error?.code === 'THUMBNAIL_STOPPED') throw error;
            let currentStat = null;
            try {
              currentStat = await fs.promises.stat(filePath);
              if (!currentStat.isFile()) currentStat = null;
            } catch { /* source is genuinely missing/offline */ }
            if (currentStat && error?.code === 'EPOCH_STALE' && attempt === 0) {
              attempt += 1;
              this.log('warn', 'Thumbnail cache epoch changed; retrying under the fresh epoch', { filePath, code: error.code });
              await new Promise(resolve => setTimeout(resolve, 25));
              continue;
            }
            const slowWriteCandidate = error?.code === 'ENOENT' || error?.code === 'ECACHEMISS' || error?.code === 'EIMAGEDECODE'
              || error?.code === 'SOURCE_STALE';
            if (currentStat && slowWriteCandidate) {
              if (!slowWriteDeadline) slowWriteDeadline = Date.now() + this.slowWriteRetryWindowMs;
              const baseline = stat || currentStat;
              if (currentStat.size !== baseline.size || currentStat.mtimeMs !== baseline.mtimeMs) observedSourceChange = true;
              const stability = await this.waitForSourceStability(filePath, currentStat, slowWriteDeadline);
              observedSourceChange ||= stability.changed || error?.code === 'SOURCE_STALE';
              stat = stability.stat || currentStat;
              if (stability.stable && (attempt === 0 || observedSourceChange) && Date.now() < slowWriteDeadline) {
                attempt += 1;
                this.log('warn', 'Thumbnail source was not yet readable; retrying after a bounded stability probe', {
                  filePath, code: error?.code, attempt, observedSourceChange,
                });
                continue;
              }
            }
            if (currentStat && (error?.code === 'EPOCH_STALE' || error?.code === 'SOURCE_STALE' || observedSourceChange)) {
              const freshStat = await fs.promises.stat(filePath);
              this.notify({ filePath, state: 'STALE', sourceMtimeMs: freshStat.mtimeMs, sourceSize: freshStat.size });
              void this.setPersistentState(filePath, 'STALE').catch(() => undefined);
              const recoveryCount = Number(task.input.slowWriteRecoveryCount) || 0;
              if (recoveryCount >= 2) throw error;
              const retryTimer = setTimeout(() => {
                this.delayedRetryTimers.delete(retryTimer);
                if (this.stopped || task.input.rootGeneration !== this.cacheRootGeneration) return;
                this.enqueue({
                  ...task.input,
                  filePath,
                  stat: freshStat,
                  forceRegenerate: true,
                  subscribe: false,
                  requestedSizes,
                  slowWriteRecoveryCount: recoveryCount + 1,
                }, task.priority);
              }, this.sourceStabilityDelayMs);
              this.delayedRetryTimers.add(retryTimer);
              return { state: 'STALE' };
            }
            throw error;
          }
        }
        try {
          void this.trackActiveOperation(Promise.resolve().then(() => this.trimCache(
            this.getCacheDir(cacheConfig), cacheConfig.maxSizeGB, published.map(item => item.path),
          )))
            .catch(error => this.log('warn', 'Thumbnail cache trim deferred', { filePath, error: error?.message || String(error) }));
        } catch (error) {
          this.log('warn', 'Thumbnail cache trim deferred', { filePath, error: error?.message || String(error) });
        }
      }
      return { state: 'READY' };
    } catch (error) {
      if (this.stopped || error?.code === 'ROOT_STALE' || error?.code === 'THUMBNAIL_STOPPED') return { state: 'CANCELLED' };
      let sourceExists = false;
      try { sourceExists = (await fs.promises.stat(filePath)).isFile(); } catch { /* source is genuinely missing/offline */ }
      if (this.stopped) return { state: 'CANCELLED' };
      const state = sourceExists ? 'FAILED' : 'MISSING';
      void this.setPersistentState(filePath, state, error.message || String(error)).catch(() => undefined);
      this.notify({ filePath, state, error: error.message || String(error) });
      this.log('warn', 'Thumbnail generation failed', { filePath, kind, state, error: error.message || String(error) });
      return { state, error: error.message || String(error) };
    }
  }

  indexDirectory(projectRoot, directory, entries, cacheConfig) {
    if (this.stopped) return Promise.resolve({ state: 'CANCELLED' });
    const launch = this.activateCacheRoot(cacheConfig).then(rootGeneration => {
      if (this.stopped) return { state: 'CANCELLED' };
      try { this.assertRootGeneration(rootGeneration, cacheConfig); } catch {
        return { state: 'CANCELLED' };
      }
      const directoryKey = `${pathKey(directory)}|${this.cacheRootKey(cacheConfig)}|g${rootGeneration}`;
      const existing = this.directoryIndexes.get(directoryKey);
      if (existing) return existing;
      const job = this.runDirectoryIndex(projectRoot, directory, entries, cacheConfig, rootGeneration)
        .catch(error => {
          if (error?.code !== 'ROOT_STALE' && error?.code !== 'THUMBNAIL_STOPPED') {
            this.log('warn', 'Directory thumbnail index update failed', { directory, error: error.message || String(error) });
          }
          return false;
        })
        .finally(() => this.directoryIndexes.delete(directoryKey));
      this.directoryIndexes.set(directoryKey, job);
      return job;
    });
    this.activeOperations.add(launch);
    void launch.finally(() => this.activeOperations.delete(launch)).catch(() => undefined);
    return launch;
  }

  async runDirectoryIndex(projectRoot, directory, entries, cacheConfig, rootGeneration) {
    if (!Number.isFinite(rootGeneration)) {
      const requestedRoot = this.cacheRootKey(cacheConfig);
      if (this.activeCacheRootKey === null) {
        this.activeCacheRootKey = requestedRoot;
        this.cacheRootGeneration += 1;
      }
      if (this.activeCacheRootKey !== requestedRoot) throw Object.assign(new Error('thumbnail cache root generation changed'), { code: 'ROOT_STALE' });
      rootGeneration = this.cacheRootGeneration;
    }
    // Let the renderer's visible thumbnail requests claim the disk first.
    // Directory indexing touches the same source and cache files and otherwise
    // creates a burst of duplicate I/O while a folder is opening.
    await new Promise(resolve => setTimeout(resolve, 50));
    await this.waitForBackgroundIdle(PRIORITY.directory);
    this.assertRootGeneration(rootGeneration, cacheConfig);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        this.assertRootGeneration(rootGeneration, cacheConfig);
        await this.coordinator.withIndexer(() => this.database.call('sync_directory', { project_root: projectRoot, directory }, 60 * 1000));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 750));
      }
    }
    if (lastError) throw lastError;

    for (const entry of entries) {
      this.assertRootGeneration(rootGeneration, cacheConfig);
      if (!['image', 'raw', 'video'].includes(entry.kind)) continue;
      try {
        const stat = await fs.promises.stat(entry.path);
        const candidates = THUMBNAIL_SIZES.map(size => ({ size, target: this.targetFor(entry.path, stat, cacheConfig, size) }));
        const cached = [];
        for (const item of candidates) if (await fs.promises.access(item.target).then(() => true, () => false)) cached.push(item);
        if (cached.length) {
          const capture = await this.coordinator.withIndexer(() => this.database.call('capture_thumbnail_publish', {
            file_path: entry.path,
            kind: entry.kind,
            project_root: projectRoot,
          }));
          const thumbnails = await Promise.all(cached.map(async item => ({
              sizeLabel: item.size.label,
              pixelSize: item.size.pixels,
              path: item.target,
              fileSize: (await fs.promises.stat(item.target)).size,
          })));
          await this.coordinator.withPublisher(() => {
            this.assertRootGeneration(rootGeneration, cacheConfig);
            return this.database.call('commit_thumbnail_publish', {
              publish_id: crypto.randomUUID(),
              file_path: entry.path,
              cache_epoch: capture.cacheEpoch,
              source_version: capture.sourceVersion,
              source_size: capture.sourceSize,
              source_mtime_ms: capture.sourceMtimeMs,
              source_digest: null,
              thumbnails,
            });
          }).catch(error => {
            if (error?.code === 'ROOT_STALE') throw error;
          });
        }
      } catch (error) {
        if (error?.code === 'ROOT_STALE' || error?.code === 'THUMBNAIL_STOPPED') throw error;
        // The worker will classify missing/offline files.
      }
    }
    // Directory indexing is metadata-only. MediaThumbnail requests visible and
    // near-visible tiles through IntersectionObserver; warming every uncached
    // file here kept HDDs at 100% long after the UI had finished loading.
    return true;
  }

  scanProject(projectRoot, cacheConfig) {
    if (this.stopped) return Promise.resolve({ state: 'CANCELLED' });
    const queueScan = rootGeneration => {
      if (this.stopped) return { state: 'CANCELLED' };
      try { this.assertRootGeneration(rootGeneration, cacheConfig); } catch {
        return { state: 'CANCELLED' };
      }
      const root = path.resolve(projectRoot);
      const scanKey = `${pathKey(root)}|${this.cacheRootKey(cacheConfig)}|g${rootGeneration}`;
      const current = this.projectScans.get(scanKey);
      if (current) return current;
      let resolveScan;
      const scan = new Promise(resolve => { resolveScan = resolve; });
      this.projectScanQueue.push({ root, scanKey, cacheConfig, rootGeneration, resolve: resolveScan });
      this.projectScans.set(scanKey, scan);
      this.pumpProjectScans();
      return scan;
    };
    const requestedRoot = this.cacheRootKey(cacheConfig);
    if (this.activeCacheRootKey === null) {
      this.activeCacheRootKey = requestedRoot;
      this.cacheRootGeneration += 1;
      return queueScan(this.cacheRootGeneration);
    }
    if (this.activeCacheRootKey === requestedRoot) return queueScan(this.cacheRootGeneration);
    const launch = this.activateCacheRoot(cacheConfig).then(queueScan);
    this.activeOperations.add(launch);
    void launch.finally(() => this.activeOperations.delete(launch)).catch(() => undefined);
    return launch;
  }

  async runDatabaseMaintenance(worker, options = {}) {
    if (this.stopped) throw Object.assign(new Error('thumbnail pipeline stopped'), { code: 'THUMBNAIL_STOPPED' });
    const existingContext = this.maintenanceContext.getStore();
    if (existingContext?.pipeline === this) return worker(existingContext.control);
    const control = {
      signal: options.signal || options.task?.signal,
      task: options.task || null,
      deadlineAt: Number.isFinite(options.deadlineAt) ? options.deadlineAt : Date.now() + THUMBNAIL_MAINTENANCE_TIMEOUT_MS,
      onBlocked: options.onBlocked || (() => undefined),
      onAdmitted: options.onAdmitted || (() => undefined),
      processedCount: 0,
      foregroundWaitMs: 0,
    };
    this.assertMaintenanceBoundary(control, 'waiting-maintenance-turn', 0);
    let releaseTurn;
    const previousTurn = this.databaseMaintenanceTail;
    this.databaseMaintenanceTail = new Promise(resolve => { releaseTurn = resolve; });
    this.databaseMaintenanceDepth += 1;
    try {
      await this.waitForMaintenanceDependency(previousTurn, control, 'waiting-maintenance-turn');
      while (this.activeProjectScans) {
        await this.waitForMaintenanceDependency(
          new Promise(resolve => setTimeout(resolve, 50)),
          control,
          'waiting-project-scan',
        );
      }
      return await this.coordinator.withMaintenance({
        signal: control.signal,
        deadlineAt: control.deadlineAt,
        onAdmitted: control.onAdmitted,
        onBlocked: details => control.onBlocked({ ...details, processedCount: control.processedCount, deadlineAt: control.deadlineAt }),
      }, async () => {
        if (typeof options.preflight === 'function') {
          this.assertMaintenanceBoundary(control, 'maintenance-preflight', control.processedCount);
          await options.preflight(control);
        }
        this.assertMaintenanceBoundary(control, 'begin-cache-maintenance', control.processedCount);
        if (options.bumpCacheEpoch !== false) {
          await this.database.call('begin_cache_maintenance', {}, this.maintenanceCallTimeout(control));
        }
        this.memory.clear();
        return this.maintenanceContext.run({ pipeline: this, control }, () => worker(control));
      });
    } finally {
      this.databaseMaintenanceDepth = Math.max(0, this.databaseMaintenanceDepth - 1);
      releaseTurn();
      if (!this.databaseMaintenanceDepth) this.pumpProjectScans();
    }
  }

  async deleteCacheFile(control, filePath, statPhase, deletePhase) {
    this.assertMaintenanceBoundary(control, statPhase, control.processedCount || 0);
    const fileSize = await fs.promises.stat(filePath).then(stat => stat.size, () => 0);
    this.assertMaintenanceBoundary(control, deletePhase, control.processedCount || 0);
    await fs.promises.unlink(filePath);
    // unlink cannot be cancelled once dispatched. Await it while the
    // maintenance turn is still held; the caller records the settled outcome
    // before checking whether the deadline expired during the operation.
    return fileSize;
  }

  async yieldMaintenanceToForeground(control, phase) {
    this.assertMaintenanceBoundary(control, phase, control.processedCount || 0);
    const waited = await this.coordinator.yieldToReaders({ signal: control.signal, deadlineAt: control.deadlineAt });
    control.foregroundWaitMs += Number(waited) || 0;
    await this.coordinator.drainTouches();
    this.assertMaintenanceBoundary(control, phase, control.processedCount || 0);
  }

  async inspectToolSources(projectRoot, filePaths, collectVideos = false, collectDirectConvertibleImages = false, collectRecursiveConvertibleImages = false) {
    if (this.stopped) return { indexed: false, hasVideo: false, hasConvertibleImage: false, videoPaths: [], convertibleImagePaths: [] };
    const root = path.resolve(projectRoot);
    if ([...this.projectScans.keys()].some(key => key.startsWith(`${pathKey(root)}|`))
        || [...this.projectIndexUpdates.keys()].some(key => key.startsWith(`${pathKey(root)}|`))) return { indexed: false, hasVideo: false, hasConvertibleImage: false, videoPaths: [], convertibleImagePaths: [] };
    return this.withIndexer(() => this.database.call('inspect_tool_sources', {
      project_root: root,
      paths: filePaths.map(filePath => path.resolve(filePath)),
      collect_videos: Boolean(collectVideos),
      collect_direct_convertible_images: Boolean(collectDirectConvertibleImages),
      collect_recursive_convertible_images: Boolean(collectRecursiveConvertibleImages),
    }));
  }

  pumpProjectScans() {
    if (this.stopped) return;
    if (this.databaseMaintenanceDepth || this.activeProjectScans || !this.projectScanQueue.length) return;
    // Foreground directory indexes are intentionally drained first. Starting a
    // whole-project metadata scan while other projects are opening can otherwise
    // reintroduce writer-lock contention between the two SQLite connections.
    const idleWaitMs = this.backgroundWaitMs(PRIORITY.project);
    if (this.directoryIndexes.size || idleWaitMs > 0) {
      if (!this.projectScanPumpTimer) {
        this.projectScanPumpTimer = setTimeout(() => {
          this.projectScanPumpTimer = null;
          if (this.stopped) return;
          this.pumpProjectScans();
        }, Math.max(250, idleWaitMs));
      }
      return;
    }
    const job = this.projectScanQueue.shift();
    this.activeProjectScans = 1;
    const scanner = new ThumbnailDatabaseClient({ ...this.databaseConfig, serviceArgs: ['--no-recover'] });
    this.activeProjectScanner = scanner;
    void this.coordinator.withIndexer(() => scanner.call('sync_project', { project_root: job.root }, 30 * 60 * 1000))
      .then(result => {
        this.assertRootGeneration(job.rootGeneration, job.cacheConfig);
        for (const [index, record] of (result.pending || []).entries()) {
          this.enqueue({ filePath: record.path, kind: record.kind, cacheConfig: job.cacheConfig, rootGeneration: job.rootGeneration, sourceHash: record.sourceHash, persistState: false, requestedSizes: [THUMBNAIL_SIZES[0]], queueOrder: index }, PRIORITY.project);
        }
        job.resolve(result);
      })
      .catch(error => {
        this.log('warn', 'Project thumbnail index scan failed', { projectRoot: job.root, error: error.message || String(error) });
        job.resolve(undefined);
      })
      .finally(() => {
        scanner.stop();
        if (this.activeProjectScanner === scanner) this.activeProjectScanner = null;
        this.projectScans.delete(job.scanKey);
        this.activeProjectScans = 0;
        for (const resolve of this.projectScanIdleWaiters) resolve();
        this.projectScanIdleWaiters.clear();
        this.pumpProjectScans();
      });
  }

  async syncChangedPaths(projectRoot, filePaths, cacheConfig) {
    if (this.stopped) return { queued: 0, projectScanScheduled: false, cancelled: true };
    const root = path.resolve(projectRoot);
    const rootGeneration = await this.activateCacheRoot(cacheConfig);
    if (this.stopped) return { queued: 0, projectScanScheduled: false, cancelled: true };
    try { this.assertRootGeneration(rootGeneration, cacheConfig); } catch {
      return { queued: 0, projectScanScheduled: false, cancelled: true };
    }
    const updateKey = `${pathKey(root)}|${this.cacheRootKey(cacheConfig)}|g${rootGeneration}`;
    this.projectIndexUpdates.set(updateKey, (this.projectIndexUpdates.get(updateKey) || 0) + 1);
    const operation = this.runChangedPathSync(root, filePaths, cacheConfig, rootGeneration);
    this.activeOperations.add(operation);
    try {
      return await operation;
    } catch (error) {
      if (error?.code === 'ROOT_STALE' || error?.code === 'THUMBNAIL_STOPPED') {
        return { queued: 0, projectScanScheduled: false, cancelled: true };
      }
      throw error;
    } finally {
      this.activeOperations.delete(operation);
      const remaining = (this.projectIndexUpdates.get(updateKey) || 1) - 1;
      if (remaining > 0) this.projectIndexUpdates.set(updateKey, remaining);
      else this.projectIndexUpdates.delete(updateKey);
    }
  }

  async runChangedPathSync(projectRoot, filePaths, cacheConfig, rootGeneration) {
    if (!Number.isFinite(rootGeneration)) {
      const requestedRoot = this.cacheRootKey(cacheConfig);
      if (this.activeCacheRootKey === null) {
        this.activeCacheRootKey = requestedRoot;
        this.cacheRootGeneration += 1;
      }
      if (this.activeCacheRootKey !== requestedRoot) return { queued: 0, projectScanScheduled: false, cancelled: true };
      rootGeneration = this.cacheRootGeneration;
    }
    this.assertRootGeneration(rootGeneration, cacheConfig);
    const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif']);
    const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.mpeg', '.mpg', '.mts', '.m2ts']);
    const rawExtensions = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']);
    const mediaExtensions = new Set([...imageExtensions, ...videoExtensions, ...rawExtensions]);
    const visibleFilePaths = filePaths.filter(filePath => !isInternalWorkspacePath(filePath));
    const mediaPaths = [...new Map(visibleFilePaths
      .filter(filePath => mediaExtensions.has(path.extname(filePath).toLowerCase()))
      .map(filePath => [pathKey(filePath), path.resolve(filePath)])).values()];
    const needsProjectScan = visibleFilePaths.some(filePath => !mediaExtensions.has(path.extname(filePath).toLowerCase()));

    // Editors often emit several watcher events while a file is still being
    // replaced. Keep the old thumbnail visible during that short window, then
    // invalidate it only after size and mtime have settled. A newer event
    // supersedes the pending probe for the same path.
    const changed = await Promise.all(mediaPaths.map(async filePath => {
      const key = pathKey(filePath);
      const version = (this.sourceChangeVersions.get(key) || 0) + 1;
      this.sourceChangeVersions.set(key, version);
      this.memory.deleteFile(filePath);
      await new Promise(resolve => setTimeout(resolve, this.sourceStabilityDelayMs));
      this.assertRootGeneration(rootGeneration, cacheConfig);
      if (this.sourceChangeVersions.get(key) !== version) return null;
      try {
        let stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) throw new Error('not a file');
        await new Promise(resolve => setTimeout(resolve, this.sourceStabilityProbeMs));
        if (this.sourceChangeVersions.get(key) !== version) return null;
        const confirmed = await fs.promises.stat(filePath);
        if (!confirmed.isFile()) throw new Error('not a file');
        if (confirmed.size !== stat.size || confirmed.mtimeMs !== stat.mtimeMs) {
          await new Promise(resolve => setTimeout(resolve, this.sourceStabilityDelayMs));
          if (this.sourceChangeVersions.get(key) !== version) return null;
          stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) throw new Error('not a file');
        } else {
          stat = confirmed;
        }
        this.sourceChangeVersions.delete(key);
        this.assertRootGeneration(rootGeneration, cacheConfig);
        const extension = path.extname(filePath).toLowerCase();
        const kind = videoExtensions.has(extension) ? 'video' : rawExtensions.has(extension) ? 'raw' : 'image';
        this.notify({ filePath, state: 'STALE', sourceMtimeMs: stat.mtimeMs, sourceSize: stat.size });
        this.enqueue({ filePath, kind, cacheConfig, rootGeneration, stat, persistState: false, requestedSizes: [THUMBNAIL_SIZES[0]], forceRegenerate: true }, PRIORITY.nearby);
        return filePath;
      } catch (error) {
        if (error?.code === 'ROOT_STALE' || error?.code === 'THUMBNAIL_STOPPED') return null;
        if (this.sourceChangeVersions.get(key) !== version) return null;
        this.sourceChangeVersions.delete(key);
        this.notify({ filePath, state: 'MISSING' });
        return null;
      }
    }));
    if (mediaPaths.length) {
      this.assertRootGeneration(rootGeneration, cacheConfig);
      await this.coordinator.withIndexer(() => this.database.call('sync_paths', { project_root: projectRoot, paths: mediaPaths, calculate_hash: false }, 60 * 1000))
        .catch(error => this.log('warn', 'Thumbnail watcher index update deferred', { projectRoot, error: error.message || String(error) }));
    }
    this.assertRootGeneration(rootGeneration, cacheConfig);
    if (needsProjectScan) void this.scanProject(projectRoot, cacheConfig);
    return { queued: mediaPaths.length, projectScanScheduled: needsProjectScan };
  }

  async invalidateDeleted(deletedPaths, beforeMs) {
    if (!beforeMs) {
      for (const [filePath, task] of this.tasks) {
        if (task.running) continue;
        task.cancelled = true;
        this.tasks.delete(filePath);
      }
    }
    return this.evictCache(deletedPaths
      ? { thumbnailPaths: deletedPaths }
      : beforeMs ? { beforeMs } : { all: true });
  }

  async listCacheCleanupCandidates(beforeMs, cacheRoot = null) {
    if (this.stopped) throw Object.assign(new Error('thumbnail pipeline stopped'), { code: 'THUMBNAIL_STOPPED' });
    return this.database.call('list_cache_cleanup', { before_ms: beforeMs, cache_root: cacheRoot }, THUMBNAIL_MAINTENANCE_TIMEOUT_MS);
  }

  async replayPublishBackupReceipts(cacheRoot, control) {
    let afterKey = '';
    let recoveredCount = 0;
    while (true) {
      const page = await this.database.call('maintenance_state_list_prefix', {
        prefix: THUMBNAIL_BACKUP_RECOVERY_PREFIX,
        after_key: afterKey,
        limit: 128,
      }, this.maintenanceCallTimeout(control));
      for (const entry of page.entries || []) {
        const cursor = entry.cursor && typeof entry.cursor === 'object' ? entry.cursor : {};
        const replacements = Array.isArray(cursor.replacements) && cursor.replacements.length
          ? cursor.replacements
          : (cursor.failures || []).filter(item => item?.backupPath && item?.finalPath);
        const ownedFinals = Array.isArray(cursor.ownedFinals) ? cursor.ownedFinals : [];
        const relevant = replacements.some(item => item?.finalPath && pathKey(path.dirname(item.finalPath)) === pathKey(cacheRoot))
          || ownedFinals.some(value => value && pathKey(path.dirname(value)) === pathKey(cacheRoot));
        if (!relevant) continue;
        const ownership = cursor.publishId
          ? await this.database.call('claim_thumbnail_backup_recovery', {
            publish_id: cursor.publishId,
            thumbnail_paths: [...new Set([
              ...replacements.map(item => item.finalPath),
              ...ownedFinals,
            ].filter(Boolean))],
          }, this.maintenanceCallTimeout(control))
          : { state: 'SUPERSEDED', committed: false };
        if (ownership?.state === 'COMMITTED' || ownership?.state === 'SUPERSEDED') {
          const failures = [];
          for (const item of replacements) {
            const backupPath = path.resolve(item.backupPath);
            if (!await this.isSafeManagedCachePath(cacheRoot, backupPath)) {
              failures.push({ backupPath, phase: 'validate-committed-backup', error: 'unsafe managed cache path' });
              continue;
            }
            try { await fs.promises.unlink(backupPath); } catch (error) {
              if (error?.code !== 'ENOENT') failures.push({ backupPath, phase: 'remove-committed-backup', error: error?.message || String(error) });
            }
          }
          if (failures.length) {
            throw Object.assign(new Error('committed thumbnail backup cleanup remains incomplete'), {
              code: 'THUMBNAIL_PUBLISH_BACKUP_RECOVERY_INCOMPLETE', receiptKey: entry.key, failures,
            });
          }
          await this.database.call('maintenance_state_delete', { key: entry.key }, this.maintenanceCallTimeout(control));
          recoveredCount += 1;
          control.processedCount += 1;
          continue;
        }
        const failures = [];
        for (const item of replacements) {
          const finalPath = path.resolve(item.finalPath);
          const backupPath = path.resolve(item.backupPath);
          if (!await this.isSafeManagedCachePath(cacheRoot, finalPath)
              || !await this.isSafeManagedCachePath(cacheRoot, backupPath)) {
            failures.push({ finalPath, backupPath, phase: 'validate-recovery-paths', error: 'unsafe managed cache path' });
            continue;
          }
          const [backupStat, finalStat] = await Promise.all([
            fs.promises.stat(backupPath).catch(() => null),
            fs.promises.stat(finalPath).catch(() => null),
          ]);
          if (!backupStat) {
            if (finalStat?.isFile() && item.backupDigest) {
              const digest = crypto.createHash('sha256').update(await fs.promises.readFile(finalPath)).digest('hex');
              if (digest === item.backupDigest) continue;
            }
            failures.push({ finalPath, backupPath, phase: 'locate-backup', error: 'thumbnail rollback backup is missing' });
            continue;
          }
          if (!backupStat.isFile() || (Number.isFinite(item.backupSize) && backupStat.size !== item.backupSize)) {
            failures.push({ finalPath, backupPath, phase: 'verify-backup', error: 'thumbnail rollback backup failed verification' });
            continue;
          }
          if (item.backupDigest) {
            const digest = crypto.createHash('sha256').update(await fs.promises.readFile(backupPath)).digest('hex');
            if (digest !== item.backupDigest) {
              failures.push({ finalPath, backupPath, phase: 'verify-backup', error: 'thumbnail rollback backup digest mismatch' });
              continue;
            }
          }
          const displacedPath = path.join(path.dirname(backupPath), `${crypto.randomUUID()}.jpg`);
          let displaced = false;
          try {
            if (finalStat) {
              await fs.promises.rename(finalPath, displacedPath);
              displaced = true;
            }
            await fs.promises.rename(backupPath, finalPath);
            const restored = await fs.promises.stat(finalPath);
            if (!restored.isFile() || restored.size !== backupStat.size) throw new Error('restored thumbnail backup failed verification');
            if (item.backupDigest) {
              const digest = crypto.createHash('sha256').update(await fs.promises.readFile(finalPath)).digest('hex');
              if (digest !== item.backupDigest) throw new Error('restored thumbnail backup digest mismatch');
            }
            if (displaced) await fs.promises.unlink(displacedPath).catch(() => undefined);
          } catch (error) {
            if (displaced && !await fs.promises.stat(finalPath).then(() => true, () => false)) {
              await fs.promises.rename(displacedPath, finalPath).catch(() => undefined);
            }
            failures.push({ finalPath, backupPath, displacedPath: displaced ? displacedPath : null, phase: 'restore-backup', error: error?.message || String(error) });
          }
        }
        for (const value of ownedFinals) {
          const finalPath = path.resolve(value);
          if (!await this.isSafeManagedCachePath(cacheRoot, finalPath)) {
            failures.push({ finalPath, phase: 'validate-owned-final', error: 'unsafe managed cache path' });
            continue;
          }
          try { await fs.promises.unlink(finalPath); } catch (error) {
            if (error?.code !== 'ENOENT') failures.push({ finalPath, phase: 'remove-owned-final', error: error?.message || String(error) });
          }
        }
        if (failures.length) {
          await this.database.call('maintenance_state_save', {
            key: entry.key,
            cursor: { ...cursor, replayFailures: failures, lastReplayAt: Date.now() },
          }, this.maintenanceCallTimeout(control)).catch(() => undefined);
          throw Object.assign(new Error('thumbnail publish backup recovery remains incomplete'), {
            code: 'THUMBNAIL_PUBLISH_BACKUP_RECOVERY_INCOMPLETE',
            receiptKey: entry.key,
            failures,
          });
        }
        await this.database.call('maintenance_state_delete', { key: entry.key }, this.maintenanceCallTimeout(control));
        recoveredCount += 1;
        control.processedCount += 1;
      }
      const nextAfterKey = page.afterKey || afterKey;
      if (page.done !== false || !(page.entries || []).length || nextAfterKey === afterKey) break;
      afterKey = nextAfterKey;
    }
    return { recoveredCount };
  }

  async evictCache(options = {}) {
    return this.runDatabaseMaintenance(async control => {
      this.memory.clear();
      const backupRecovery = options.cacheRoot && options.recoverOrphans
        ? await this.replayPublishBackupReceipts(path.resolve(options.cacheRoot), control)
        : { recoveredCount: 0 };
      const physicalPaths = new Map();
      let detachedCount = 0;
      let detachedBytes = 0;
      let prunedSourceCount = 0;
      let repairedMissingCount = 0;
      let recoveryInspectedCount = 0;
      let orphanScanConsumedCount = 0;
      let orphanProgressCount = 0;
      let retryConsumedCount = 0;
      let detachComplete = true;
      let pruneComplete = options.pruneMissing !== true;
      let recoveryComplete = options.recoverOrphans !== true;
      let completedRecoveryCursor = options.recoveryCursor && typeof options.recoveryCursor === 'object'
        ? options.recoveryCursor : {};
      const collect = result => {
        detachedCount += Number(result?.detachedCount) || 0;
        detachedBytes += Number(result?.detachedBytes) || 0;
        for (const claim of result?.deletionClaims || []) {
          if (!claim?.path || !claim?.cacheRoot) continue;
          const resolved = path.resolve(claim.path);
          physicalPaths.set(pathKey(resolved), { path: resolved, cacheRoot: path.resolve(claim.cacheRoot) });
        }
        // Compatibility with the pre-claim database protocol: only paths
        // positively returned by a successful detach count as declarations.
        // Never fall back to the caller's selector values.
        if (!result?.deletionClaims && Number(result?.detachedCount) > 0) {
          const declaredRoot = path.resolve(options.cacheRoot || this.cacheDirectory({}));
          for (const value of (result.thumbnailPaths || []).slice(0, Number(result.detachedCount))) {
            const resolved = path.resolve(value);
            physicalPaths.set(pathKey(resolved), { path: resolved, cacheRoot: declaredRoot });
          }
        }
        control.processedCount = detachedCount;
      };

      let detachBatchCount = 0;
      const maxDetachBatches = Number.isFinite(Number(options.maxDetachBatches))
        ? Math.max(1, Number(options.maxDetachBatches)) : Number.POSITIVE_INFINITY;
      const detachSelector = async selector => {
        while (true) {
          this.assertMaintenanceBoundary(control, 'detach-cache-batch', control.processedCount);
          const result = await this.database.call('detach_cache_batch', { ...selector, limit: 512 }, this.maintenanceCallTimeout(control));
          detachBatchCount += 1;
          collect(result);
          await this.yieldMaintenanceToForeground(control, 'yield-after-detach-batch');
          if (result.done || (options.bytesToFree && detachedBytes >= Number(options.bytesToFree))) break;
          if (detachBatchCount >= maxDetachBatches) {
            detachComplete = false;
            break;
          }
        }
      };

      if (options.thumbnailPaths) {
        const values = [...new Set(options.thumbnailPaths.map(value => path.resolve(value)))];
        for (let offset = 0; offset < values.length; offset += 512) {
          await detachSelector({ thumbnail_paths: values.slice(offset, offset + 512) });
          if (!detachComplete) break;
        }
      } else if (options.sourcePaths) {
        const values = [...new Set(options.sourcePaths.map(value => path.resolve(value)))];
        for (let offset = 0; offset < values.length; offset += 512) {
          await detachSelector({ source_paths: values.slice(offset, offset + 512) });
          if (!detachComplete) break;
        }
      } else if (options.all || options.beforeMs != null || options.bytesToFree) {
        await detachSelector({
          cache_root: options.cacheRoot || null,
          before_ms: options.beforeMs ?? null,
          all_cache: options.all === true || options.bytesToFree != null,
          exclude_paths: options.excludePaths || [],
        });
      }

      if (options.pruneMissing && detachComplete) {
        let pruneBatchCount = 0;
        const maxPruneBatches = Number.isFinite(Number(options.maxPruneBatches))
          ? Math.max(1, Number(options.maxPruneBatches)) : Number.POSITIVE_INFINITY;
        while (true) {
          this.assertMaintenanceBoundary(control, 'prune-missing-batch', control.processedCount);
          const result = await this.database.call('prune_missing_batch', { limit: 512, cache_root: options.cacheRoot || null }, this.maintenanceCallTimeout(control));
          collect(result);
          prunedSourceCount += Number(result.sourceCount) || 0;
          // Sources without thumbnail rows still make durable progress. Include
          // them before returning a bounded slice, not only during recovery.
          control.processedCount = detachedCount + prunedSourceCount;
          pruneBatchCount += 1;
          await this.yieldMaintenanceToForeground(control, 'yield-after-prune-batch');
          if (result.done) {
            pruneComplete = true;
            break;
          }
          if (pruneBatchCount >= maxPruneBatches) break;
        }
      }

      const deletedPaths = [];
      const failedPaths = [];
      const physicalRetryFailures = [];
      const physicalRetryClears = [];
      let deletedBytes = 0;
      const physicalDeletionPlan = physicalPaths.size
        ? await this.database.call('prepare_thumbnail_deletions', {
          thumbnail_paths: [...physicalPaths.values()].map(claim => claim.path),
        }, this.maintenanceCallTimeout(control))
        : { deletablePaths: [] };
      for (const candidate of physicalDeletionPlan.deletablePaths || []) {
        const filePath = path.resolve(candidate);
        const claim = physicalPaths.get(pathKey(filePath));
        this.assertMaintenanceBoundary(control, 'delete-cache-files', control.processedCount + deletedPaths.length + failedPaths.length);
        const requestedRootMatches = !options.cacheRoot || pathKey(options.cacheRoot) === pathKey(claim?.cacheRoot || '');
        if (!claim || !requestedRootMatches || !await this.isSafeManagedCachePath(claim.cacheRoot, filePath)) {
          failedPaths.push(filePath);
          this.log('warn', 'Skipped unsafe thumbnail cache deletion path', { cacheRoot: claim?.cacheRoot, filePath });
          continue;
        }
        try {
          const fileSize = await this.deleteCacheFile(control, filePath, 'stat-cache-file', 'delete-cache-file');
          deletedPaths.push(filePath);
          deletedBytes += fileSize;
          physicalRetryClears.push(filePath);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            deletedPaths.push(filePath);
            physicalRetryClears.push(filePath);
          } else {
            failedPaths.push(filePath);
          physicalRetryFailures.push({ path: filePath, cacheRoot: claim.cacheRoot, error: error?.message || String(error) });
          }
        }
        this.assertMaintenanceBoundary(control, 'delete-cache-file-settled', control.processedCount + deletedPaths.length + failedPaths.length);
      }
      if (physicalRetryClears.length) {
        await this.database.call('clear_orphan_delete_retries', {
          thumbnail_paths: physicalRetryClears,
        }, this.maintenanceCallTimeout(control));
      }
      if (physicalRetryFailures.length) {
        const failuresByRoot = new Map();
        for (const failure of physicalRetryFailures) {
          if (!failuresByRoot.has(failure.cacheRoot)) failuresByRoot.set(failure.cacheRoot, []);
          failuresByRoot.get(failure.cacheRoot).push({ path: failure.path, error: failure.error });
        }
        for (const [cacheRoot, failures] of failuresByRoot) {
          await this.database.call('record_orphan_delete_failures', {
            cache_root: cacheRoot,
            failures,
          }, this.maintenanceCallTimeout(control));
        }
      }

      if (detachComplete && pruneComplete && options.recoverOrphans && options.cacheRoot
          && (!options.bytesToFree || deletedBytes < Number(options.bytesToFree))) {
        let recoveryCursor = completedRecoveryCursor;
        let recoveryPageCount = 0;
        const maxRecoveryPages = Number.isFinite(Number(options.maxRecoveryPages))
          ? Math.max(1, Number(options.maxRecoveryPages)) : Number.POSITIVE_INFINITY;
        const attempted = new Set([
          ...[...physicalPaths.values()].map(value => pathKey(value.path)),
          ...(options.excludePaths || []).map(value => pathKey(value)),
        ]);
        while (true) {
          const pageFailureCount = failedPaths.length;
          this.assertMaintenanceBoundary(control, 'recover-cache-publications', control.processedCount + deletedPaths.length + failedPaths.length);
          const recovered = await this.database.call('recover_cache_publications', {
            cache_root: options.cacheRoot,
            before_ms: options.orphanBeforeMs ?? options.beforeMs ?? null,
            exclude_paths: options.excludePaths || [],
            scan_root_orphans: options.scanRootOrphans !== false,
            generation: String(recoveryCursor.generation || ''),
            generation_max_row_id: Number(recoveryCursor.generationMaxRowId) || 0,
            after_row_id: Number(recoveryCursor.afterRowId) || 0,
            inspect_limit: Math.max(1, Number(options.recoveryInspectLimit) || 2048),
            delete_limit: Math.max(1, Number(options.recoveryDeleteLimit) || 512),
            directory_inspect_limit: Math.max(1, Number(options.recoveryDirectoryInspectLimit) || 2048),
            directory_cursor: recoveryCursor.directory || {},
            orphan_recheck_at: Number(recoveryCursor.orphanRecheckAt) || 0,
            orphan_retention_ms: Math.max(0, Number(options.orphanRetentionMs) || 0),
          }, this.maintenanceCallTimeout(control));
          recoveryPageCount += 1;
          recoveryComplete = recovered.done === true;
          recoveryCursor = recovered.cursor || {
            generation: String(recoveryCursor.generation || ''),
            generationMaxRowId: Number(recovered.generationMaxRowId) || 0,
            afterRowId: Number(recovered.afterRowId) || 0,
            lastCompletedAt: 0,
            directory: recovered.directoryCursor || {},
            orphanRecheckAt: Number(recovered.orphanRecheckAt) || 0,
          };
          completedRecoveryCursor = recoveryCursor;
          repairedMissingCount += Number(recovered.repairedMissingCount) || 0;
          recoveryInspectedCount += Number(recovered.inspectedCount) || 0;
          orphanScanConsumedCount += Number(recovered.orphanScanConsumedCount) || 0;
          retryConsumedCount += Number(recovered.retryConsumedCount) || 0;
          orphanProgressCount += Number(recovered.orphanProgressCount ?? recovered.orphanScanConsumedCount) || 0;
          control.processedCount = detachedCount + recoveryInspectedCount + prunedSourceCount + orphanProgressCount;
          await this.yieldMaintenanceToForeground(control, 'yield-after-orphan-page');
          if (!recovered.orphanPaths?.length) {
            if (options.completeMaintenanceKey) {
              await this.database.call('maintenance_state_save', {
                key: options.completeMaintenanceKey,
                cursor: recoveryCursor,
              }, this.maintenanceCallTimeout(control));
            }
            if (recovered.done || recoveryPageCount >= maxRecoveryPages) break;
            continue;
          }
          let newCandidateCount = 0;
          const clearedRetryPaths = [];
          const retryFailures = [];
          const orphanDeletionPlan = await this.database.call('prepare_thumbnail_deletions', {
            thumbnail_paths: recovered.orphanPaths,
          }, this.maintenanceCallTimeout(control));
          const reindexedCandidateCount = Number(orphanDeletionPlan.indexedPaths?.length) || 0;
          orphanProgressCount += reindexedCandidateCount;
          control.processedCount += reindexedCandidateCount;
          for (const value of orphanDeletionPlan.deletablePaths || []) {
            if (options.bytesToFree && deletedBytes >= Number(options.bytesToFree)) break;
            this.assertMaintenanceBoundary(control, 'delete-orphan-files', control.processedCount + deletedPaths.length + failedPaths.length);
            const filePath = path.resolve(value);
            const candidateKey = pathKey(filePath);
            if (attempted.has(candidateKey)) continue;
            attempted.add(candidateKey);
            newCandidateCount += 1;
            if (!await this.isSafeManagedCachePath(options.cacheRoot, filePath)) {
              failedPaths.push(filePath);
              retryFailures.push({ path: filePath, error: 'unsafe managed cache path' });
              this.log('warn', 'Skipped unsafe thumbnail orphan deletion path', { cacheRoot: options.cacheRoot, filePath });
              continue;
            }
            try {
              const fileSize = await this.deleteCacheFile(control, filePath, 'stat-orphan-file', 'delete-orphan-file');
              deletedPaths.push(filePath);
              deletedBytes += fileSize;
              clearedRetryPaths.push(filePath);
            } catch (error) {
              if (error?.code === 'ENOENT') {
                deletedPaths.push(filePath);
                clearedRetryPaths.push(filePath);
              } else {
                failedPaths.push(filePath);
                retryFailures.push({ path: filePath, error: error?.message || String(error) });
              }
            }
            this.assertMaintenanceBoundary(control, 'delete-orphan-file-settled', control.processedCount + deletedPaths.length + failedPaths.length);
          }
          if (clearedRetryPaths.length) {
            await this.database.call('clear_orphan_delete_retries', {
              thumbnail_paths: clearedRetryPaths,
            }, this.maintenanceCallTimeout(control));
            orphanProgressCount += clearedRetryPaths.length;
            control.processedCount += clearedRetryPaths.length;
          }
          if (retryFailures.length) {
            await this.database.call('record_orphan_delete_failures', {
              cache_root: options.cacheRoot,
              failures: retryFailures,
            }, this.maintenanceCallTimeout(control));
          }
          if (options.completeMaintenanceKey && failedPaths.length === pageFailureCount) {
            await this.database.call('maintenance_state_save', {
              key: options.completeMaintenanceKey,
              cursor: recoveryCursor,
            }, this.maintenanceCallTimeout(control));
          }
          if (options.failOnDeleteError && failedPaths.length > pageFailureCount) break;
          if (recovered.done || recoveryPageCount >= maxRecoveryPages || newCandidateCount === 0
              || (options.bytesToFree && deletedBytes >= Number(options.bytesToFree))) break;
        }
      }

      const result = {
        success: true,
        detachedCount,
        detachedBytes,
        deletedBytes,
        deletedCount: deletedPaths.length,
        failedCount: failedPaths.length,
        deletedPaths,
        failedPaths,
        prunedSourceCount,
        repairedMissingCount,
        recoveryInspectedCount,
        orphanScanConsumedCount,
        orphanProgressCount,
        retryConsumedCount,
        backupRecoveryCount: backupRecovery.recoveredCount,
        detachComplete,
        pruneComplete,
        recoveryComplete,
        maintenanceComplete: detachComplete && pruneComplete && recoveryComplete,
        recoveryCursor: completedRecoveryCursor,
        processedCount: control.processedCount,
        foregroundWaitMs: control.foregroundWaitMs,
      };
      if (options.failOnDeleteError && failedPaths.length) {
        throw Object.assign(new Error(`thumbnail cache recovery left ${failedPaths.length} unsafe or unavailable paths`), {
          code: 'THUMBNAIL_CACHE_RECOVERY_INCOMPLETE',
          result,
        });
      }
      if (options.completeMaintenanceKey && detachComplete && pruneComplete && recoveryComplete) {
        if (options.cacheRoot) {
          completedRecoveryCursor = {
            ...completedRecoveryCursor,
            cacheFingerprint: await this.cacheDirectoryFingerprint(options.cacheRoot),
          };
          result.recoveryCursor = completedRecoveryCursor;
        }
        await this.database.call('maintenance_state_complete', {
          key: options.completeMaintenanceKey,
          cursor: completedRecoveryCursor,
        }, this.maintenanceCallTimeout(control));
      }
      return result;
    }, {
      signal: options.signal,
      deadlineAt: options.deadlineAt,
      task: options.task,
      onBlocked: options.onBlocked,
      onAdmitted: options.onAdmitted,
      bumpCacheEpoch: options.bumpCacheEpoch,
      preflight: options.completeMigrationKey
        ? control => this.runThumbnailMigration(control, options)
        : options.verifyIntegrity
          ? control => this.database.call('check_integrity', {}, this.maintenanceCallTimeout(control))
          : null,
    });
  }

  async maintenanceState(key) {
    return this.withIndexer(() => this.database.call('maintenance_state_get', { key }));
  }

  async saveMaintenanceState(key, cursor) {
    return this.withIndexer(() => this.database.call('maintenance_state_save', { key, cursor }));
  }

  async cleanupOrphanCache(cacheRoot, beforeMs, intervalMs) {
    void intervalMs;
    return this.evictCache({ cacheRoot, recoverOrphans: true, orphanBeforeMs: beforeMs });
  }

  async invalidateSources(sourcePaths) {
    return this.evictCache({ sourcePaths: sourcePaths || [] });
  }

  async pruneMissingSources() {
    return this.evictCache({ pruneMissing: true });
  }

  stop(options = {}) {
    if (this.stopPromise) return this.stopPromise;
    let resolveStop;
    let rejectStop;
    this.stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this.stopped = true;
    if (this.projectScanPumpTimer) clearTimeout(this.projectScanPumpTimer);
    if (this.thumbnailPumpTimer) clearTimeout(this.thumbnailPumpTimer);
    if (this.backgroundResumeTimer) clearTimeout(this.backgroundResumeTimer);
    this.projectScanPumpTimer = null;
    this.thumbnailPumpTimer = null;
    this.sourceChangeVersions.clear();
    this.projectIndexUpdates.clear();
    for (const resolve of this.projectScanIdleWaiters) resolve();
    this.projectScanIdleWaiters.clear();
    this.backgroundResumeTimer = null;
    this.memory.clear();
    for (const timer of this.delayedRetryTimers) clearTimeout(timer);
    this.delayedRetryTimers.clear();
    this.activeProjectScanner?.stop?.();
    for (const task of this.tasks.values()) task.resolveCompletion({ state: 'CANCELLED' });
    this.tasks.clear();
    for (const queue of this.queues) queue.length = 0;
    for (const scan of this.projectScanQueue.splice(0)) scan.resolve?.({ state: 'CANCELLED' });
    this.projectScans.clear();
    const coordinatorCanStopDatabaseImmediately = this.coordinator.isIdle()
      && this.coordinator.status().pendingTouches === 0;
    const coordinatorStop = this.coordinator.stop(options);
    const coordinatorStopSettled = coordinatorStop.then(
      value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }),
    );
    let immediateDatabaseStop = null;
    if (coordinatorCanStopDatabaseImmediately) {
      try {
        immediateDatabaseStop = Promise.resolve(this.database.stop(true));
      } catch (error) {
        immediateDatabaseStop = Promise.reject(error);
      }
    }
    const immediateDatabaseStopSettled = immediateDatabaseStop?.then(
      value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }),
    ) || null;
    const shutdown = (async () => {
      while (this.activeWorkers || this.activeProjectScans || this.activeOperations.size || this.directoryIndexes.size
          || this.databaseMaintenanceDepth) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await this.databaseMaintenanceTail;
      const coordinatorResult = await coordinatorStopSettled;
      const databaseResult = immediateDatabaseStopSettled
        ? await immediateDatabaseStopSettled
        : await Promise.resolve().then(() => this.database.stop(true)).then(
          value => ({ status: 'fulfilled', value }),
          reason => ({ status: 'rejected', reason }),
        );
      const errors = [coordinatorResult, databaseResult]
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'thumbnail pipeline shutdown failed');
    })();
    void shutdown.then(resolveStop, rejectStop);
    return this.stopPromise;
  }
}

module.exports = { ThumbnailPipeline, THUMBNAIL_SIZES, THUMBNAIL_VERSION, PRIORITY, chooseSize, isThumbnailSizeSufficient };
