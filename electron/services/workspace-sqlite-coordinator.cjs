const path = require('path');

const MODES = new Set(['read', 'write', 'exclusive']);

const abortError = reason => {
  const error = reason instanceof Error ? reason : new Error('数据库协调请求已取消');
  if (!error.code) error.code = 'ABORT_ERR';
  return error;
};

const timeoutError = label => {
  const error = new Error(`等待数据库协调租约超时${label ? `：${label}` : ''}`);
  error.code = 'DATABASE_COORDINATOR_TIMEOUT';
  return error;
};

const normalizeDatabasePath = value => {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
};

const normalizeRequest = databases => {
  const byPath = new Map();
  for (const database of databases || []) {
    if (!database?.path) throw new TypeError('数据库协调请求缺少 path');
    if (!MODES.has(database.mode)) throw new TypeError(`无效的数据库锁级别：${database.mode}`);
    const normalizedPath = normalizeDatabasePath(database.path);
    const previous = byPath.get(normalizedPath);
    const rank = { read: 0, write: 1, exclusive: 2 };
    if (!previous || rank[database.mode] > rank[previous.mode]) {
      byPath.set(normalizedPath, { path: normalizedPath, mode: database.mode });
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
};

const conflicts = (left, right) => {
  if (left.path !== right.path) return false;
  if (left.mode === 'exclusive' || right.mode === 'exclusive') return true;
  return left.mode === 'write' && right.mode === 'write';
};

class WorkspaceSqliteCoordinator {
  constructor() {
    this.active = new Map();
    this.queue = [];
    this.quarantined = new Map();
    this.preemptRequested = new Set();
    this.sequence = 0;
  }

  quarantine(databases, cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause || '数据库已隔离'));
    for (const database of normalizeRequest(databases)) {
      this.quarantined.set(database.path, { error, at: Date.now() });
    }
    this.drain();
  }

  clearQuarantine(databases) {
    for (const database of normalizeRequest(databases)) this.quarantined.delete(database.path);
    this.drain();
  }

  quarantineError(entry) {
    const blocked = entry.databases.find(database => database.mode !== 'read' && this.quarantined.has(database.path));
    if (!blocked) return null;
    const cause = this.quarantined.get(blocked.path)?.error;
    const error = new Error(`数据库已隔离，拒绝新的写入：${blocked.path}${cause?.message ? `（${cause.message}）` : ''}`);
    error.code = 'DATABASE_QUARANTINED';
    error.cause = cause;
    return error;
  }

  run({ databases, signal, deadlineAt, label = '', priority = 0, preemptible = false, onPreempt = null } = {}, worker) {
    if (typeof worker !== 'function') return Promise.reject(new TypeError('数据库协调 worker 必须是函数'));
    let normalized;
    try { normalized = normalizeRequest(databases); } catch (error) { return Promise.reject(error); }
    if (!normalized.length) return Promise.resolve().then(worker);
    const quarantinedError = this.quarantineError({ databases: normalized });
    if (quarantinedError) return Promise.reject(quarantinedError);
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (Number.isFinite(deadlineAt) && deadlineAt <= Date.now()) return Promise.reject(timeoutError(label));

    return new Promise((resolve, reject) => {
      const entry = {
        id: ++this.sequence, databases: normalized, signal, deadlineAt, label, worker, resolve, reject,
        priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
        preemptible: preemptible === true && typeof onPreempt === 'function', onPreempt,
        preemptRequested: false, timer: null, onAbort: null, settled: false,
      };
      entry.onAbort = () => this.cancel(entry, abortError(signal.reason));
      signal?.addEventListener?.('abort', entry.onAbort, { once: true });
      if (Number.isFinite(deadlineAt)) {
        entry.timer = setTimeout(() => this.cancel(entry, timeoutError(label)), Math.max(0, deadlineAt - Date.now()));
        entry.timer.unref?.();
      }
      this.queue.push(entry);
      this.preemptLowerPriority(entry);
      this.drain();
    });
  }

  preemptLowerPriority(entry) {
    const active = new Map();
    for (const database of entry.databases) {
      for (const reservation of this.active.get(database.path) || []) {
        if (conflicts(database, reservation)) active.set(reservation.id, reservation);
      }
    }
    for (const reservation of active.values()) {
      if (!reservation.preemptible || this.preemptRequested.has(reservation.id) || reservation.priority >= entry.priority) continue;
      this.preemptRequested.add(reservation.id);
      try {
        reservation.onPreempt(Object.assign(new Error(`数据库后台操作正在让路：${reservation.label || reservation.id}`), {
          code: 'DATABASE_PREEMPTED',
        }));
      } catch {
        this.preemptRequested.delete(reservation.id);
      }
    }
  }

  cancel(entry, error) {
    if (entry.settled) return;
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1);
    entry.settled = true;
    this.cleanup(entry);
    entry.reject(error);
    this.drain();
  }

  canGrant(entry, queueIndex) {
    for (const database of entry.databases) {
      for (const active of this.active.get(database.path) || []) {
        if (conflicts(database, active)) return false;
      }
    }
    // Do not jump ahead of an older conflicting request. Independent database
    // requests may still proceed, avoiding global head-of-line blocking.
    for (let index = 0; index < queueIndex; index += 1) {
      const older = this.queue[index];
      if (older.priority >= entry.priority
          && older.databases.some(left => entry.databases.some(right => conflicts(left, right)))) return false;
    }
    return true;
  }

  drain() {
    let granted = true;
    while (granted) {
      granted = false;
      let selectedIndex = -1;
      for (let index = 0; index < this.queue.length; index += 1) {
        const entry = this.queue[index];
        const quarantinedError = this.quarantineError(entry);
        if (quarantinedError) {
          this.queue.splice(index, 1);
          entry.settled = true;
          this.cleanup(entry);
          entry.reject(quarantinedError);
          granted = true;
          break;
        }
        if (!this.canGrant(entry, index)) continue;
        if (selectedIndex < 0 || entry.priority > this.queue[selectedIndex].priority) selectedIndex = index;
      }
      if (granted) continue;
      if (selectedIndex < 0) continue;
      const [entry] = this.queue.splice(selectedIndex, 1);
      this.grant(entry);
      granted = true;
    }
  }

  grant(entry) {
    entry.settled = true;
    this.cleanup(entry);
    for (const database of entry.databases) {
      const active = this.active.get(database.path) || [];
      active.push({
        id: entry.id, path: database.path, mode: database.mode, priority: entry.priority,
        preemptible: entry.preemptible, onPreempt: entry.onPreempt, label: entry.label,
      });
      this.active.set(database.path, active);
    }
    Promise.resolve()
      .then(() => entry.worker())
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.preemptRequested.delete(entry.id);
        for (const database of entry.databases) {
          const remaining = (this.active.get(database.path) || []).filter(item => item.id !== entry.id);
          if (remaining.length) this.active.set(database.path, remaining);
          else this.active.delete(database.path);
        }
        this.drain();
      });
  }

  cleanup(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
  }

  status() { return { activeDatabases: this.active.size, waiting: this.queue.length, quarantinedDatabases: this.quarantined.size }; }
}

module.exports = { WorkspaceSqliteCoordinator, normalizeDatabasePath };
