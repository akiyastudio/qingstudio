class ThumbnailCoordinator {
  constructor({ touchFlusher = async () => undefined, touchFlushDelayMs = 250, log = () => undefined } = {}) {
    this.touchFlusher = touchFlusher;
    this.touchFlushDelayMs = touchFlushDelayMs;
    this.activeReaders = 0;
    this.maintenanceActive = false;
    this.maintenanceWaiting = 0;
    this.maintenanceYielding = false;
    this.maintenanceYieldResolver = null;
    this.readerQueue = [];
    this.maintenanceQueue = [];
    this.touches = new Map();
    this.touchTimer = null;
    this.touchFlushPromise = null;
    this.touchRetryDelayMs = touchFlushDelayMs;
    this.log = log;
    this.stopped = false;
    this.idleWaiters = new Set();
    this.stopPromise = null;
  }

  withIndexer(worker) { return this.withReader('indexer', worker); }

  withPublisher(worker) { return this.withReader('publisher', worker); }

  withReader(_kind, worker) {
    if (this.stopped) return Promise.reject(Object.assign(new Error('thumbnail coordinator stopped'), { code: 'THUMBNAIL_STOPPED' }));
    return new Promise((resolve, reject) => {
      const run = () => {
        this.activeReaders += 1;
        Promise.resolve().then(worker).then(resolve, reject).finally(() => {
          this.activeReaders -= 1;
          this.drain();
          this.notifyIdle();
        });
      };
      run.cancel = reject;
      // Writer priority: once maintenance is waiting, later readers queue.
      if (!this.maintenanceYielding && !this.maintenanceActive && this.maintenanceWaiting === 0) run();
      else this.readerQueue.push(run);
    });
  }

  async yieldToReaders({ signal, deadlineAt } = {}) {
    if (!this.maintenanceActive || !this.readerQueue.length) return 0;
    if (signal?.aborted) throw signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' });
    const startedAt = Date.now();
    this.maintenanceYielding = true;
    this.maintenanceActive = false;
    const queued = this.readerQueue.splice(0);
    let deadlineTimer = null;
    try {
      const drained = new Promise((resolve, reject) => {
        this.maintenanceYieldResolver = resolve;
        if (Number.isFinite(deadlineAt)) {
          deadlineTimer = setTimeout(() => reject(Object.assign(
            new Error('thumbnail maintenance deadline exceeded while yielding to foreground readers'),
            { code: 'THUMBNAIL_MAINTENANCE_DEADLINE' },
          )), Math.max(1, deadlineAt - Date.now()));
        }
      });
      for (const run of queued) run();
      if (this.activeReaders) await drained;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.maintenanceYieldResolver = null;
      this.maintenanceYielding = false;
      this.maintenanceActive = true;
    }
    if (signal?.aborted) throw signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' });
    return Math.max(0, Date.now() - startedAt);
  }

  withMaintenance(options, worker) {
    if (typeof options === 'function') {
      worker = options;
      options = {};
    }
    const { signal, deadlineAt, onBlocked = () => undefined, onAdmitted = () => undefined } = options || {};
    if (this.stopped) return Promise.reject(Object.assign(new Error('thumbnail coordinator stopped'), { code: 'THUMBNAIL_STOPPED' }));
    if (signal?.aborted) return Promise.reject(signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' }));
    if (Number.isFinite(deadlineAt) && deadlineAt <= Date.now()) {
      return Promise.reject(Object.assign(new Error('thumbnail maintenance deadline exceeded'), { code: 'THUMBNAIL_MAINTENANCE_DEADLINE' }));
    }
    this.maintenanceWaiting += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadlineTimer = null;
      const cleanupWait = () => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const cancelWaiting = error => {
        if (settled) return;
        const index = this.maintenanceQueue.indexOf(run);
        if (index < 0) return;
        this.maintenanceQueue.splice(index, 1);
        this.maintenanceWaiting -= 1;
        settled = true;
        cleanupWait();
        reject(error);
        this.drain();
      };
      const onAbort = () => cancelWaiting(signal.reason || Object.assign(new Error('thumbnail maintenance cancelled'), { code: 'TASK_CANCELLED' }));
      const run = async () => {
        if (settled) return;
        settled = true;
        cleanupWait();
        this.maintenanceWaiting -= 1;
        this.maintenanceActive = true;
        try {
          await this.drainTouches();
          resolve(await worker());
        } catch (error) {
          reject(error);
        } finally {
          this.maintenanceActive = false;
          if (this.touches.size && !this.touchTimer) {
            this.touchTimer = setTimeout(() => {
              this.touchTimer = null;
              void this.flushTouches().catch(error => this.scheduleTouchRetry(error));
            }, this.touchFlushDelayMs);
            this.touchTimer.unref?.();
          }
          this.drain();
          this.notifyIdle();
        }
      };
      run.cancel = cancelWaiting;
      this.maintenanceQueue.push(run);
      onAdmitted({ waiting: this.maintenanceWaiting, activeReaders: this.activeReaders });
      if (this.activeReaders || this.maintenanceActive || this.maintenanceQueue[0] !== run) {
        onBlocked({ phase: this.activeReaders ? 'waiting-indexer-publisher' : 'waiting-maintenance-turn', activeReaders: this.activeReaders });
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (Number.isFinite(deadlineAt)) {
        deadlineTimer = setTimeout(() => cancelWaiting(Object.assign(
          new Error('thumbnail maintenance deadline exceeded while waiting for publish/index'),
          { code: 'THUMBNAIL_MAINTENANCE_DEADLINE' },
        )), Math.max(0, deadlineAt - Date.now()));
      }
      this.drain();
    });
  }

  touch(filePath, sizeLabel) {
    if (this.stopped) return;
    const key = `${filePath}\0${sizeLabel}`;
    this.touches.set(key, { file_path: filePath, size_label: sizeLabel });
    if (this.maintenanceActive || this.maintenanceYielding || this.maintenanceWaiting) return;
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      void this.flushTouches().catch(error => this.scheduleTouchRetry(error));
    }, this.touchFlushDelayMs);
    this.touchTimer.unref?.();
  }

  flushTouches() {
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touchTimer = null;
    if (this.touchFlushPromise) return this.touchFlushPromise;
    if (!this.touches.size) return Promise.resolve({ success: true, count: 0 });
    const touches = [...this.touches.values()];
    this.touches.clear();
    const operation = Promise.resolve().then(() => this.touchFlusher(touches)).then(result => {
      this.touchRetryDelayMs = this.touchFlushDelayMs;
      return result;
    }).catch(error => {
      for (const touch of touches) this.touches.set(`${touch.file_path}\0${touch.size_label}`, touch);
      throw error;
    }).finally(() => {
      if (this.touchFlushPromise === operation) this.touchFlushPromise = null;
      this.notifyIdle();
    });
    this.touchFlushPromise = operation;
    return operation;
  }

  scheduleTouchRetry(error) {
    if (this.stopped || this.touchTimer || !this.touches.size) return;
    this.log('warn', 'Thumbnail access-time flush deferred', { error: error?.message || String(error) });
    const delay = Math.max(this.touchFlushDelayMs, this.touchRetryDelayMs);
    this.touchRetryDelayMs = Math.min(30000, Math.max(delay + 1, delay * 2));
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      void this.flushTouches().catch(nextError => this.scheduleTouchRetry(nextError));
    }, delay);
    this.touchTimer.unref?.();
  }

  async drainTouches() {
    while (this.touchFlushPromise || this.touches.size) {
      if (this.touchFlushPromise) await this.touchFlushPromise;
      else await this.flushTouches();
    }
  }

  async drainTouchesForStop(maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.drainTouches();
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, this.touchFlushDelayMs * (2 ** (attempt - 1)))));
      }
    }
    if (lastError) {
      lastError.pendingTouches = this.touches.size;
      throw lastError;
    }
  }

  drain() {
    if (this.maintenanceYielding) {
      if (!this.activeReaders) this.maintenanceYieldResolver?.();
      return;
    }
    if (this.maintenanceActive || this.activeReaders) return;
    if (this.maintenanceQueue.length) {
      const next = this.maintenanceQueue.shift();
      void next();
      return;
    }
    if (this.maintenanceWaiting) return;
    for (const run of this.readerQueue.splice(0)) run();
  }

  status() {
    return {
      activeReaders: this.activeReaders,
      maintenanceActive: this.maintenanceActive,
      maintenanceWaiting: this.maintenanceWaiting,
      queuedReaders: this.readerQueue.length,
      pendingTouches: this.touches.size,
    };
  }

  isIdle() {
    return this.activeReaders === 0 && !this.maintenanceActive && !this.maintenanceYielding
      && !this.touchFlushPromise && this.readerQueue.length === 0 && this.maintenanceQueue.length === 0;
  }

  notifyIdle() {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  waitForIdle() {
    if (this.isIdle()) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  stop({ discardAccessTimes = false } = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.touchTimer = null;
    if (discardAccessTimes) this.touches.clear();
    const error = Object.assign(new Error('thumbnail coordinator stopped'), { code: 'THUMBNAIL_STOPPED' });
    for (const run of this.readerQueue.splice(0)) run.cancel?.(error);
    for (const run of [...this.maintenanceQueue]) run.cancel?.(error);
    this.notifyIdle();
    this.stopPromise = (async () => {
      await this.waitForIdle();
      await this.drainTouchesForStop();
    })();
    return this.stopPromise;
  }
}

module.exports = { ThumbnailCoordinator };
