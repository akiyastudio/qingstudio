const { spawn } = require('child_process');
const { stopProcessAndWait } = require('../infrastructure/process-termination.cjs');
const { CoordinatedDatabaseClient } = require('./coordinated-database-client.cjs');
const { WorkspaceDatabaseOperationPolicy } = require('./workspace-database-operation-policy.cjs');

const INFRASTRUCTURE_FAILURE_PATTERN = /(?:SQLITE_|database disk image is malformed|database service exited|EPIPE|ECONNRESET|timed out|operation timeout|操作超时|I\/O error|readonly database)/i;
let databaseClientSequence = 0;
const requestAbortError = reason => (
  reason instanceof Error && typeof reason.code === 'string'
    ? reason
    : Object.assign(new Error(reason?.message || '数据库操作已取消'), { code: 'ABORT_ERR', cause: reason })
);
const markOutcomeUnknown = (error, request) => {
  if (request?.idempotent) return error;
  const cloned = new Error(error?.message || String(error), error?.cause ? { cause: error.cause } : undefined);
  Object.assign(cloned, error, { outcome: 'OUTCOME_UNKNOWN', operationId: request?.operationId });
  cloned.name = error?.name || 'Error';
  if (error?.stack) cloned.stack = error.stack;
  return cloned;
};

class PythonDatabaseClient {
  constructor({ getRunConfig, getDatabasePath, writeLog, coordinator, operationPolicy = new WorkspaceDatabaseOperationPolicy(), defaultTimeoutMs = 30000, processStopTimeoutMs = 2000, rollbackSettleMs = 25, scriptName = 'workspace_db.py', processSupervisor = null, processId = '', domainId = '', onHealthChange = () => undefined, failureThreshold = 3, circuitCooldownMs = 5000, maximumPending = 100, maximumProtocolBuffer = 1024 * 1024, maximumProtocolResponse = 16 * 1024 * 1024 }) {
    this.getRunConfig = getRunConfig;
    this.getDatabasePath = getDatabasePath;
    this.writeLog = writeLog;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.scriptName = scriptName;
    this.processSupervisor = processSupervisor;
    this.processId = processId || `python-database:${scriptName}:${++databaseClientSequence}`;
    this.domainId = domainId || this.processId;
    this.onHealthChange = onHealthChange;
    this.failureThreshold = failureThreshold;
    this.circuitCooldownMs = circuitCooldownMs;
    this.maximumPending = maximumPending;
    this.maximumProtocolBuffer = maximumProtocolBuffer;
    this.maximumProtocolResponse = maximumProtocolResponse;
    this.processStopTimeoutMs = processStopTimeoutMs;
    this.rollbackSettleMs = rollbackSettleMs;
    this.health = { domainId: this.domainId, state: 'healthy', failures: 0, circuitOpenedAt: 0, lastError: '', updatedAt: Date.now() };
    this.managedProcess = null;
    this.process = null;
    this.nextId = 0;
    this.pending = new Map();
    this.queued = 0;
    this.processStops = new WeakMap();
    this.stopping = false;
    this.coordinated = new CoordinatedDatabaseClient({
      coordinator,
      operationPolicy,
      getDatabasePath,
      scriptName,
      execute: request => this.callOnce(request.root, request.database, request.action, request.payload, request.timeoutMs, request),
    });
  }

  updateHealth(state, details = {}) {
    this.health = { ...this.health, ...details, state, updatedAt: Date.now() };
    this.onHealthChange({ ...this.health });
  }

  noteSuccess() {
    if (this.health.state !== 'healthy' || this.health.failures) this.updateHealth('healthy', { failures: 0, circuitOpenedAt: 0, lastError: '' });
  }

  noteFailure(error) {
    const message = error?.message || String(error);
    if (!INFRASTRUCTURE_FAILURE_PATTERN.test(message)) return;
    const failures = this.health.failures + 1;
    if (failures >= this.failureThreshold) this.updateHealth('unavailable', { failures, circuitOpenedAt: Date.now(), lastError: message });
    else this.updateHealth('degraded', { failures, lastError: message });
  }

  assertCircuitAvailable() {
    if (this.health.state !== 'unavailable') return;
    if (Date.now() - this.health.circuitOpenedAt >= this.circuitCooldownMs) {
      this.updateHealth('recovering', { lastError: '' });
      return;
    }
    const error = new Error(`${this.domainId} 业务域暂时不可用，请稍后重试`);
    error.code = 'DOMAIN_UNAVAILABLE';
    throw error;
  }

  stopChildAndWait(child, reason, timeoutMs = this.processStopTimeoutMs) {
    const existing = this.processStops.get(child);
    if (existing) return existing;
    let resolveBarrier;
    let rejectBarrier;
    const barrier = new Promise((resolve, reject) => { resolveBarrier = resolve; rejectBarrier = reject; });
    this.processStops.set(child, barrier);
    this.terminationPromise = barrier;
    if (this.process === child) this.process = null;
    const managed = this.managedProcess?.child === child ? this.managedProcess : null;
    if (managed) this.managedProcess = null;
    const stopping = managed
      ? managed.stop(reason, { timeoutMs, rollbackSettleMs: this.rollbackSettleMs })
      : stopProcessAndWait(child, timeoutMs, { rollbackSettleMs: this.rollbackSettleMs });
    Promise.resolve(stopping).then(resolveBarrier, rejectBarrier).finally(() => {
      if (this.terminationPromise === barrier) this.terminationPromise = null;
    });
    return barrier;
  }

  quarantine(databases, error) {
    this.updateHealth('degraded', {
      failures: Math.max(this.failureThreshold, this.health.failures + 1),
      circuitOpenedAt: Date.now(),
      lastError: error?.message || String(error),
    });
    this.coordinated.coordinator.quarantine?.(databases, error);
  }

  ensureProcess() {
    if (this.process && !this.process.killed) return this.process;
    if (this.managedProcess && !this.managedProcess.released) {
      if (this.managedProcess.child && !this.managedProcess.child.killed) return this.managedProcess.child;
      if (this.managedProcess.state === 'restarting') return this.managedProcess.start();
      this.managedProcess.release();
      this.managedProcess = null;
    }
    const run = this.getRunConfig(this.scriptName, ['--server']);
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
    let output = '';
    let finished = false;
    let protocolFailed = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      output += data;
      const lines = output.split(/\r?\n/);
      output = lines.pop() || '';
      if (output.length > this.maximumProtocolBuffer || lines.some(line => line.length > this.maximumProtocolBuffer)) {
        if (protocolFailed) return;
        protocolFailed = true;
        const error = new Error('数据库服务协议响应超过允许上限');
        error.code = 'DATABASE_PROTOCOL_ERROR';
        void this.stopChildAndWait(child, 'protocol-buffer-overflow').then(
          () => finishRequests(error), stopError => finishRequests(stopError),
        );
        return;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          let response = JSON.parse(line);
          managedProcess?.markHealthy({ protocol: 'json-lines' });
          const request = this.pending.get(response.id);
          if (!request || request.child !== child) continue;
          if (response.protocol === 'json-chunk-v1') {
            const index = Number(response.index);
            const total = Number(response.total);
            if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || total > 1024 || index !== request.protocolChunks.length) {
              throw new Error('数据库服务返回了无效的分块响应顺序');
            }
            const chunk = Buffer.from(String(response.data || ''), 'base64');
            request.protocolBytes += chunk.length;
            if (request.protocolBytes > this.maximumProtocolResponse) throw new Error('数据库服务完整响应超过允许上限');
            request.protocolChunks.push(chunk);
            if (index + 1 < total) continue;
            if (request.protocolChunks.length !== total) throw new Error('数据库服务分块响应不完整');
            response = JSON.parse(Buffer.concat(request.protocolChunks, request.protocolBytes).toString('utf8'));
            if (response.id !== request.id) throw new Error('数据库服务分块响应 id 不匹配');
          }
          this.pending.delete(response.id);
          clearTimeout(request.timer);
          request.signal?.removeEventListener?.('abort', request.onAbort);
          if (response.success) {
            this.noteSuccess();
            request.resolve(response.result);
          } else {
            const error = new Error(response.error || '工作区数据库操作失败');
            if (response.code) error.code = response.code;
            if (response.outcome) error.outcome = response.outcome;
            error.operationId = response.operationId || request.operationId;
            this.noteFailure(error);
            request.reject(error);
          }
        } catch (error) {
          this.writeLog('warn', 'Unable to parse database service response', { scriptName: this.scriptName, error: error.message, line: line.slice(0, 500) });
          if (!protocolFailed) {
            protocolFailed = true;
            const protocolError = new Error('数据库服务返回了无效协议响应');
            protocolError.code = 'DATABASE_PROTOCOL_ERROR';
            void this.stopChildAndWait(child, 'protocol-parse-failure').then(
              () => finishRequests(protocolError), stopError => finishRequests(stopError),
            );
          }
          return;
        }
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.stdin.on('error', () => undefined);
    const finishRequests = (error, expectedStop = false) => {
      if (finished) return;
      finished = true;
      if (!expectedStop) this.noteFailure(error);
      if (this.process === child) this.process = null;
      for (const [id, request] of this.pending.entries()) {
        if (request.child !== child) continue;
        clearTimeout(request.timer);
        request.signal?.removeEventListener?.('abort', request.onAbort);
        request.reject(markOutcomeUnknown(error, request));
        this.pending.delete(id);
      }
      if (!expectedStop && !this.stopping && !this.processSupervisor) this.writeLog('warn', 'Database service stopped', { scriptName: this.scriptName, error: error.message || String(error) });
    };
    const finish = error => {
      const barrier = this.processStops.get(child);
      if (barrier) void barrier.then(() => finishRequests(error, true), stopError => finishRequests(stopError));
      else finishRequests(error, Boolean(this.stopping || managedProcess?.stopping || this.processSupervisor?.stopping));
    };
    child.on('error', finish);
    child.on('exit', code => finish(new Error(stderr.trim() || `Workspace database service exited with code ${code}`)));
  }

  call(root, action, payload = {}, timeoutMs = this.defaultTimeoutMs, options = {}) {
    if (this.queued >= this.maximumPending) {
      const error = new Error(`${this.domainId} 请求队列已满`);
      error.code = 'DOMAIN_BACKPRESSURE';
      return Promise.reject(error);
    }
    this.queued += 1;
    return this.coordinated.call(root, action, payload, { ...options, timeoutMs })
      .finally(() => { this.queued = Math.max(0, this.queued - 1); });
  }

  callOnce(root, database, action, payload = {}, timeoutMs = this.defaultTimeoutMs, options = {}) {
    if (this.terminationPromise) return this.terminationPromise.then(() => this.callOnce(root, database, action, payload, timeoutMs, options));
    return new Promise((resolve, reject) => {
      try { this.assertCircuitAvailable(); } catch (error) { reject(error); return; }
      const { signal, deadlineAt, databases = [{ path: database, mode: 'write' }], operationId, idempotent = false } = options;
      if (signal?.aborted) {
        reject(requestAbortError(signal.reason));
        return;
      }
      const remainingMs = Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - Date.now()) : timeoutMs;
      if (remainingMs <= 0) {
        const error = new Error(`工作区数据库操作超时：${action}`);
        error.code = 'DATABASE_TIMEOUT';
        reject(error);
        return;
      }
      if (this.pending.size >= this.maximumPending) {
        const error = new Error(`${this.domainId} 请求队列已满`);
        error.code = 'DOMAIN_BACKPRESSURE';
        reject(error);
        return;
      }
      const child = this.ensureProcess();
      const id = ++this.nextId;
      const terminateRequest = error => {
        const timedOut = this.pending.get(id);
        if (!timedOut || timedOut.child !== child) return;
        this.pending.delete(id);
        clearTimeout(timedOut.timer);
        signal?.removeEventListener?.('abort', timedOut.onAbort);
        this.noteFailure(error);
        const outcomeError = markOutcomeUnknown(error, timedOut);
        void this.stopChildAndWait(child, `request-timeout:${action}`).then(
          () => reject(outcomeError),
          stopError => {
            const outcomeStopError = markOutcomeUnknown(stopError, timedOut);
            this.quarantine(databases, outcomeStopError);
            reject(outcomeStopError);
          },
        );
      };
      const timer = setTimeout(() => {
        const error = new Error(`工作区数据库操作超时：${action}`);
        error.code = 'DATABASE_TIMEOUT';
        terminateRequest(error);
      }, remainingMs);
      const onAbort = () => {
        terminateRequest(requestAbortError(signal.reason));
      };
      const request = { id, root, database, action, payload, operationId };
      const serialized = JSON.stringify(request);
      this.pending.set(id, { id, resolve, reject, timer, child, serialized, onAbort, signal, operationId, idempotent, protocolChunks: [], protocolBytes: 0 });
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        child.stdin.write(`${serialized}\n`, error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending || pending.child !== child) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          signal?.removeEventListener?.('abort', pending.onAbort);
          pending.reject(markOutcomeUnknown(error, pending));
        });
      } catch (error) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        signal?.removeEventListener?.('abort', pending.onAbort);
        pending.reject(markOutcomeUnknown(error, pending));
      }
    });
  }

  stop(timeoutMs = this.processStopTimeoutMs) {
    this.stopping = true;
    const child = this.process;
    if (child) return this.stopChildAndWait(child, 'database-client-stop', timeoutMs);
    if (this.managedProcess) {
      const managed = this.managedProcess;
      this.managedProcess = null;
      return managed.stop('database-client-stop', { timeoutMs, rollbackSettleMs: this.rollbackSettleMs });
    }
    return Promise.resolve({ stopped: true });
  }

  resume() {
    this.stopping = false;
    if (this.health.state === 'unavailable' && !this.health.quarantined) this.updateHealth('recovering', { failures: 0, circuitOpenedAt: 0, lastError: '' });
  }

  async suspend(timeoutMs = 5000) {
    await this.stop(timeoutMs);
  }

  status() {
    return {
      ...this.health,
      quarantined: (this.coordinated.coordinator.status?.().quarantinedDatabases || 0) > 0,
      pending: this.pending.size,
      queued: this.queued,
    };
  }
}

module.exports = { PythonDatabaseClient };
