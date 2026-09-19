const { EventEmitter } = require('events');
const { spawn: defaultSpawn } = require('child_process');
const { stopProcessAndWait, terminateAndWait } = require('../infrastructure/process-termination.cjs');
const { launchWindowsJobProcess } = require('../infrastructure/windows-job-process.cjs');

const DEFAULT_RESTART_POLICY = Object.freeze({ enabled: false, maxRestarts: 0, windowMs: 60000, backoffMs: [100, 300, 1000] });
const safeError = error => error?.message || String(error || 'unknown error');
const isActiveManagedProcessStatus = status => status?.terminationFailed === true || status?.pid != null || status?.targetPid != null || status?.state === 'restarting';

class ManagedProcess extends EventEmitter {
  constructor(supervisor, specification) {
    super();
    this.supervisor = supervisor;
    this.specification = specification;
    this.id = specification.id;
    this.kind = specification.kind || 'process';
    this.protocol = String(specification.protocol || '');
    this.owner = specification.owner && typeof specification.owner === 'object' ? Object.freeze({ ...specification.owner }) : null;
    this.child = null;
    this.generation = 0;
    this.state = 'idle';
    this.startedAt = 0;
    this.lastHealthyAt = 0;
    this.lastExit = null;
    this.stderrTail = '';
    this.restartTimes = [];
    this.restartTimer = null;
    this.healthTimer = null;
    this.stopping = false;
    this.released = false;
    this.lifecycle = null;
    this.stopPromise = null;
  }

  start() {
    if (this.released) throw new Error(`Managed process has been released: ${this.id}`);
    if (this.lifecycle?.terminationFailed) throw Object.assign(new Error(`Previous managed process generation has not exited: ${this.id}`), { code: 'PROCESS_TERMINATION_FAILED' });
    if (this.lifecycle?.cleanupTimedOut) throw Object.assign(new Error(`Previous managed process cleanup is still pending: ${this.id}`), { code: 'PROCESS_CLEANUP_TIMEOUT' });
    if (this.child && !this.child.killed) return this.child;
    if (this.lifecycle && !this.lifecycle.settled) {
      this.lifecycle.startAfterSettle = true;
      return this.lifecycle.child;
    }
    const lifecycleLease = typeof this.specification.getLifecycleLease === 'function' ? this.specification.getLifecycleLease() : this.specification.lifecycleLease;
    if (this.owner?.componentId) this.supervisor.lifecycleCoordinator?.assertLaunchAllowed?.(this.owner.componentId, lifecycleLease);
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopping = false;
    this.state = 'starting';
    this.startedAt = this.supervisor.now();
    this.lastHealthyAt = 0;
    this.stderrTail = '';
    const generation = ++this.generation;
    const spec = this.specification;
    let child;
    try {
      const spawnProcess = this.supervisor.terminationPlatform === 'win32' && (spec.windowsJob ?? this.supervisor.windowsJobByDefault) === true
        ? this.supervisor.spawnWindowsJobImpl
        : this.supervisor.spawnImpl;
      child = spawnProcess(spec.command, spec.args || [], {
        windowsHide: true,
        ...(spec.options || {}),
      });
    } catch (error) {
      this._failedToStart(error, generation);
      throw error;
    }
    this.child = child;
    let resolveSettled;
    const lifecycle = {
      child, generation, stopRequested: false, settled: false, cleanupPromise: Promise.resolve(),
      startAfterSettle: false, lastHealthyAt: 0, stderrTail: '', finalizePromise: null,
      terminationFailed: false, cleanupTimedOut: false, terminationPromise: null,
      settledPromise: new Promise(resolve => { resolveSettled = resolve; }), resolveSettled,
    };
    this.lifecycle = lifecycle;
    this.state = 'running';
    this._safeLog('info', 'Managed process started', this.details({ pid: child.pid, generation }));
    if (child.ready && typeof child.ready.then === 'function') {
      void child.ready.then(({ targetPid } = {}) => {
        if (this.lifecycle !== lifecycle || lifecycle.settled) return;
        this._safeLog('info', 'Managed Windows Job target started', this.details({ pid: child.pid, targetPid, generation }));
        this._safeEmit('target-spawn', targetPid, child, generation);
      }, error => {
        if (this.lifecycle !== lifecycle || lifecycle.settled) return;
        void this._onError(lifecycle, error);
      });
    }
    child.stderr?.on?.('data', data => {
      if (this.lifecycle !== lifecycle) return;
      lifecycle.stderrTail = (lifecycle.stderrTail + data.toString()).slice(-16000);
      this.stderrTail = lifecycle.stderrTail;
      this._safeEmit('stderr', data, child);
    });
    child.once('error', error => { void this._onError(lifecycle, error); });
    child.once('exit', (code, signal) => { void this._onExit(lifecycle, code, signal); });
    child.once('close', (code, signal) => { void this._onClose(lifecycle, code, signal); });
    try {
      spec.onSpawn?.(child, this._viewForGeneration(lifecycle));
      this._safeEmit('spawn', child, generation);
    } catch (error) {
      this._safeLog('error', 'Managed process spawn hook failed', this.details({ generation, error: safeError(error) }));
      lifecycle.stopRequested = true;
      void this.stop('spawn-hook-failed', { release: false }).catch(stopError => {
        this._safeLog('error', 'Managed process cleanup after spawn hook failed', this.details({ generation, error: safeError(stopError) }));
      });
      throw error;
    }
    const startupTimeoutMs = Number(spec.health?.startupTimeoutMs) || 0;
    if (startupTimeoutMs > 0) {
      this.healthTimer = setTimeout(() => {
        if (this.lifecycle !== lifecycle || lifecycle.settled || lifecycle.lastHealthyAt >= this.startedAt) return;
        this._safeLog('warn', 'Managed process health check timed out', this.details({ generation, startupTimeoutMs }));
        void this.recycle('startup-health-timeout', { restartPolicy: true }).catch(error => this._safeLog('error', 'Managed process recycle failed', this.details({ generation, error: safeError(error) })));
      }, startupTimeoutMs);
      this.healthTimer.unref?.();
    }
    return child;
  }

  markHealthy(metadata = {}, expectedGeneration = this.generation) {
    const lifecycle = this.lifecycle;
    if (Number.isFinite(metadata?.generation) && metadata.generation !== expectedGeneration) return false;
    if (!lifecycle || lifecycle.settled || lifecycle.generation !== expectedGeneration || !this.child || this.child !== lifecycle.child || this.child.killed) return false;
    lifecycle.lastHealthyAt = this.supervisor.now();
    this.lastHealthyAt = lifecycle.lastHealthyAt;
    clearTimeout(this.healthTimer);
    this.healthTimer = null;
    if (this.state !== 'healthy') {
      this.state = 'healthy';
      this._safeLog('info', 'Managed process healthy', this.details(metadata));
    }
    this._safeEmit('healthy', metadata);
    return true;
  }

  async recycle(reason = 'recycle-requested', { timeoutMs = 2000, rollbackSettleMs = 25, restartPolicy = false } = {}) {
    const lifecycle = this.lifecycle;
    if (!lifecycle || lifecycle.settled) return this.start();
    this._safeLog('warn', 'Managed process recycled', this.details({ reason, generation: lifecycle.generation }));
    lifecycle.stopRequested = true;
    await this._terminateLifecycle(lifecycle, timeoutMs, rollbackSettleMs);
    if (!lifecycle.exitObserved && (lifecycle.child.exitCode != null || lifecycle.child.signalCode != null)) {
      await this._onExit(lifecycle, lifecycle.child.exitCode, lifecycle.child.signalCode);
    }
    await this._waitForLifecycle(lifecycle, timeoutMs);
    if (this.released || this.stopping || this.supervisor.stopping) return null;
    if (restartPolicy) {
      this._scheduleRestart(reason);
      return null;
    }
    return this.start();
  }

  stop(reason = 'shutdown', options = {}) {
    if (this.stopPromise) return this.stopPromise;
    if (this.released && this.lifecycle?.settled && !this.lifecycle?.terminationFailed) return Promise.resolve({ stopped: true });
    if (Number.isFinite(options.deadlineAt)) options = { ...options, timeoutMs: Math.max(1, options.deadlineAt - Date.now()) };
    const operation = this._stopOnce(reason, options);
    this.stopPromise = operation.finally(() => { if (this.stopPromise === tracked) this.stopPromise = null; });
    const tracked = this.stopPromise;
    return tracked;
  }

  async _stopOnce(reason = 'shutdown', { release = true, timeoutMs = 2000, rollbackSettleMs = 25 } = {}) {
    this.stopping = true;
    this.state = 'stopping';
    this._restartReason = null;
    clearTimeout(this.restartTimer);
    clearTimeout(this.healthTimer);
    this.restartTimer = null;
    this.healthTimer = null;
    const child = this.child;
    const lifecycle = this.lifecycle;
    if (lifecycle) lifecycle.stopRequested = true;
    try {
      if (lifecycle) await this._terminateLifecycle(lifecycle, timeoutMs, rollbackSettleMs);
      else await stopProcessAndWait(child, timeoutMs, { rollbackSettleMs, platform: this.supervisor.terminationPlatform });
    } catch (error) {
      if (lifecycle) lifecycle.terminationFailed = true;
      this.state = 'failed';
      this.lastExit = { at: this.supervisor.now(), generation: lifecycle?.generation || this.generation, expected: true, terminationPending: true, error: safeError(error) };
      throw error;
    }
    if (lifecycle) lifecycle.terminationFailed = false;
    if (lifecycle && !lifecycle.exitObserved && (child?.exitCode != null || child?.signalCode != null)) {
      await this._onExit(lifecycle, child.exitCode, child.signalCode);
    }
    if (lifecycle) await this._waitForLifecycle(lifecycle, timeoutMs);
    if (this.child === child) this.child = null;
    this.state = 'stopped';
    this._safeLog('info', 'Managed process stopped', this.details({ reason }));
    if (release) this.release();
    return { stopped: true };
  }

  _terminateLifecycle(lifecycle, timeoutMs, rollbackSettleMs) {
    if (lifecycle.terminationPromise) return lifecycle.terminationPromise;
    const operation = stopProcessAndWait(lifecycle.child, timeoutMs, { rollbackSettleMs, platform: this.supervisor.terminationPlatform }).then(result => {
      lifecycle.terminationFailed = false; return result;
    }, error => { lifecycle.terminationFailed = true; throw error; });
    const tracked = operation.finally(() => { if (lifecycle.terminationPromise === tracked) lifecycle.terminationPromise = null; });
    lifecycle.terminationPromise = tracked;
    return tracked;
  }

  release() {
    this.released = true;
    if (this.supervisor.processes.get(this.id) === this) this.supervisor.processes.delete(this.id);
  }

  status() {
    return {
      id: this.id,
      kind: this.kind,
      protocol: this.protocol || undefined,
      owner: this.owner || undefined,
      state: this.state,
      pid: this.child?.pid || null,
      controlPid: this.child?.pid || null,
      targetPid: this.child?.targetPid || null,
      generation: this.generation,
      startedAt: this.startedAt,
      lastHealthyAt: this.lastHealthyAt,
      restartCount: this.restartTimes.length,
      terminationFailed: this.lifecycle?.terminationFailed === true,
      lastExit: this.lastExit,
    };
  }

  details(extra = {}) {
    return { processId: this.id, processKind: this.kind, ...extra };
  }

  _viewForGeneration(lifecycle) {
    const target = this;
    return new Proxy(this, {
      get(_managed, property) {
        if (property === 'markHealthy') return metadata => target.markHealthy(metadata, lifecycle.generation);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(_managed, property, value) { return Reflect.set(target, property, value, target); },
    });
  }

  _safeLog(level, message, details) {
    try { this.supervisor.log(level, message, details); } catch (_) { /* logging must never break ownership */ }
  }

  _safeEmit(event, ...args) {
    try { this.emit(event, ...args); }
    catch (error) { this._safeLog('warn', 'Managed process observer failed', this.details({ event, error: safeError(error) })); }
  }

  _failedToStart(error, generation) {
    this.state = 'failed';
    this.lastExit = { at: this.supervisor.now(), generation, error: safeError(error) };
    this._safeLog('error', 'Managed process failed to start', this.details(this.lastExit));
  }

  async _onError(lifecycle, error) {
    if (this.lifecycle !== lifecycle || lifecycle.settled) return;
    lifecycle.error = error;
    this._safeLog('warn', 'Managed process error', this.details({ generation: lifecycle.generation, error: safeError(error) }));
    this._safeEmit('process-error', error, lifecycle.child);
    this.state = 'failed';
    let terminationFailed = false;
    try {
      await stopProcessAndWait(lifecycle.child, Number(this.specification.errorExitTimeoutMs) || 2000, { platform: this.supervisor.terminationPlatform });
    } catch (terminationError) {
      terminationFailed = true;
      this._safeLog('error', 'Managed process error termination failed', this.details({
        generation: lifecycle.generation, error: safeError(terminationError),
      }));
    }
    if (terminationFailed) {
      lifecycle.terminationFailed = true;
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
      this.lastExit = {
        at: this.supervisor.now(), generation: lifecycle.generation, code: null, signal: null,
        expected: false, error: safeError(error), stderr: lifecycle.stderrTail.trim(), terminationPending: true,
      };
      return { exited: false, terminationPending: true };
    }
    return this._finalizeLifecycle(lifecycle, { error });
  }

  _onExit(lifecycle, code, signal) {
    lifecycle.exitObserved = true;
    if (lifecycle.child.__photoFlowJobManaged && !lifecycle.child.__photoFlowTreeExitConfirmed) {
      lifecycle.terminationFailed = true;
      this.state = 'failed';
      this.lastExit = {
        at: this.supervisor.now(), generation: lifecycle.generation, code, signal, expected: false,
        stderr: lifecycle.stderrTail.trim(), terminationPending: true,
        error: 'Windows Job exited without an authoritative ActiveProcesses=0 confirmation',
      };
      this._safeLog('error', 'Managed Windows Job termination is unconfirmed', this.details(this.lastExit));
      return Promise.resolve(this.lastExit);
    }
    if (lifecycle.child.__photoFlowJobManaged && lifecycle.child.__photoFlowCloseObserved !== true) {
      lifecycle.pendingExit = { code, signal };
      return Promise.resolve(null);
    }
    lifecycle.terminationFailed = false;
    return this._finalizeLifecycle(lifecycle, { code, signal, error: lifecycle.error });
  }

  _finalizeLifecycle(lifecycle, { code = null, signal = null, error = null, terminationFailed = false } = {}) {
    if (lifecycle.finalizePromise) return lifecycle.finalizePromise;
    let resolveFinalize;
    lifecycle.finalizePromise = new Promise(resolve => { resolveFinalize = resolve; });
    void (async () => {
    const current = this.lifecycle === lifecycle;
    lifecycle.terminationFailed = terminationFailed;
    if (current && this.child === lifecycle.child && !terminationFailed) this.child = null;
    if (!current) return this._settleLifecycle(lifecycle);
    clearTimeout(this.healthTimer);
    this.healthTimer = null;
    const expected = this.stopping || lifecycle.stopRequested;
    this.lastExit = {
      at: this.supervisor.now(), generation: lifecycle.generation, code, signal, expected,
      stderr: lifecycle.stderrTail.trim(), ...(error ? { error: safeError(error) } : {}),
    };
    this.state = expected ? 'stopped' : error || terminationFailed ? 'failed' : 'exited';
    this._safeLog(expected || code === 0 ? 'info' : 'warn', 'Managed process exited', this.details(this.lastExit));
    let cleanupTimedOut = false;
    let cleanupFailed = false;
    try {
      const cleanup = this.specification.onExitCleanup?.({ owner: this.owner, child: lifecycle.child, exit: this.lastExit, managedProcess: this });
      lifecycle.cleanupPromise = Promise.resolve(cleanup);
      if (cleanup && typeof cleanup.then === 'function') {
        const cleanupTimeoutMs = Math.max(1, Number(this.specification.cleanupTimeoutMs) || 2000);
        let timeoutTimer;
        const cleanupOutcome = lifecycle.cleanupPromise.then(
          () => ({ settled: true }),
          cleanupError => ({ settled: true, error: cleanupError }),
        );
        const outcome = await Promise.race([
          cleanupOutcome,
          new Promise(resolve => {
            timeoutTimer = setTimeout(() => resolve({ settled: false }), cleanupTimeoutMs);
            timeoutTimer.unref?.();
          }),
        ]);
        if (outcome.settled) {
          clearTimeout(timeoutTimer);
          if (outcome.error) {
            cleanupFailed = true;
            this.lastExit.cleanupError = safeError(outcome.error);
            this._safeLog('warn', 'Managed process exit cleanup failed', this.details({ generation: lifecycle.generation, error: safeError(outcome.error) }));
          }
        } else {
          cleanupTimedOut = true;
          lifecycle.cleanupTimedOut = true;
          this.state = 'failed';
          this.lastExit.cleanupTimedOut = true;
          this._safeLog('error', 'Managed process exit cleanup timed out', this.details({ generation: lifecycle.generation, cleanupTimeoutMs }));
          // Keep lifecycle ownership until the real cleanup settles. The
          // timeout changes policy, but never pretends cleanup completed.
          const eventualOutcome = await cleanupOutcome;
          if (eventualOutcome.error) this._safeLog('warn', 'Managed process late exit cleanup failed', this.details({ generation: lifecycle.generation, error: safeError(eventualOutcome.error) }));
        }
      }
    } catch (error) {
      cleanupFailed = true;
      this.lastExit.cleanupError = safeError(error);
      this._safeLog('warn', 'Managed process exit cleanup failed', this.details({ generation: lifecycle.generation, error: safeError(error) }));
    }
    this._safeEmit('exit', this.lastExit, lifecycle.child);
    this._settleLifecycle(lifecycle);
    if (this.lifecycle !== lifecycle) return;
    if (cleanupTimedOut || cleanupFailed) this.state = 'failed';
    else if (this.specification.ephemeral && !terminationFailed) this.release();
    else if (lifecycle.startAfterSettle && !this.stopping && !this.released && !this.supervisor.stopping && !terminationFailed) this.start();
    else if (!expected && !terminationFailed) this._scheduleRestart(error ? 'process-error' : 'unexpected-exit');
    return this.lastExit;
    })().then(resolveFinalize, finalizeError => {
      this._safeLog('error', 'Managed process finalizer failed', this.details({ generation: lifecycle.generation, error: safeError(finalizeError) }));
      if (this.lifecycle === lifecycle) this.state = 'failed';
      this._settleLifecycle(lifecycle);
      resolveFinalize(this.lastExit);
    });
    return lifecycle.finalizePromise;
  }

  _onClose(lifecycle, code, signal) {
    lifecycle.closeObserved = true;
    if (lifecycle.child.__photoFlowJobManaged && !lifecycle.child.__photoFlowTreeExitConfirmed) return this._onExit(lifecycle, code, signal);
    lifecycle.terminationFailed = false;
    return this._finalizeLifecycle(lifecycle, { code: lifecycle.pendingExit?.code ?? code, signal: lifecycle.pendingExit?.signal ?? signal, error: lifecycle.error });
  }

  _settleLifecycle(lifecycle) {
    if (!lifecycle.settled) {
      lifecycle.settled = true;
      lifecycle.resolveSettled();
    }
    return lifecycle.settledPromise;
  }

  _waitForLifecycle(lifecycle, timeoutMs) {
    if (lifecycle.settled) return lifecycle.settledPromise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const cleanupPending = lifecycle.cleanupTimedOut;
        const error = Object.assign(new Error(cleanupPending
          ? 'managed process cleanup did not settle before timeout'
          : 'managed process lifecycle did not settle after termination'), {
          code: cleanupPending ? 'PROCESS_CLEANUP_TIMEOUT' : 'PROCESS_LIFECYCLE_TIMEOUT',
          pid: lifecycle.child?.pid || null, generation: lifecycle.generation,
        });
        reject(error);
      }, Math.max(1, Number(timeoutMs) || 2000));
      timer.unref?.();
      lifecycle.settledPromise.then(() => { clearTimeout(timer); resolve(); });
    });
  }

  _scheduleRestart(reason) {
    const policy = { ...DEFAULT_RESTART_POLICY, ...(this.specification.restart || {}) };
    if (!policy.enabled || this.stopping || this.released) {
      if (!this.stopping) this.state = 'failed';
      return false;
    }
    const now = this.supervisor.now();
    this.restartTimes = this.restartTimes.filter(value => now - value <= policy.windowMs);
    if (this.restartTimes.length >= policy.maxRestarts) {
      this.state = 'failed';
      this._safeLog('error', 'Managed process restart limit reached', this.details({ reason, maxRestarts: policy.maxRestarts }));
      this._safeEmit('restart-exhausted', this.status());
      return false;
    }
    const attempt = this.restartTimes.length;
    this.restartTimes.push(now);
    const delays = Array.isArray(policy.backoffMs) && policy.backoffMs.length ? policy.backoffMs : [Number(policy.backoffMs) || 0];
    const delayMs = Math.max(0, Number(delays[Math.min(attempt, delays.length - 1)]) || 0);
    this.state = 'restarting';
    this._safeLog('warn', 'Managed process restart scheduled', this.details({ reason, attempt: attempt + 1, delayMs }));
    this._safeEmit('restarting', { reason, attempt: attempt + 1, delayMs });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.released || this.supervisor.stopping) return;
      try {
        this.start();
      } catch (error) {
        this._safeLog('error', 'Managed process restart failed', this.details({ error: safeError(error) }));
        if (['COMPONENT_QUIESCING', 'COMPONENT_TRANSACTION_BLOCKED', 'COMPONENT_RECOVERY_PENDING', 'COMPONENT_TERMINATION_UNCONFIRMED'].includes(error?.code)) this.state = 'failed';
        else this._scheduleRestart('restart-start-failed');
      }
    }, delayMs);
    this.restartTimer.unref?.();
    return true;
  }
}

class ProcessSupervisor {
  constructor({ spawnImpl = defaultSpawn, spawnWindowsJobImpl = null, windowsJobOptions = {}, windowsJobByDefault = false, writeLog = () => undefined, now = () => Date.now(), terminationPlatform = process.platform } = {}) {
    this.spawnImpl = spawnImpl;
    this.spawnWindowsJobImpl = spawnWindowsJobImpl || ((command, args, options) => launchWindowsJobProcess(command, args, options, windowsJobOptions));
    this.writeLog = writeLog;
    this.now = now;
    this.terminationPlatform = terminationPlatform;
    this.windowsJobByDefault = windowsJobByDefault === true;
    this.processes = new Map();
    this.stopping = false;
  }

  log(level, message, details) {
    this.writeLog(level, message, details);
  }

  launch(specification) {
    if (this.stopping) throw new Error('Process supervisor is stopping');
    const id = String(specification?.id || '').trim();
    if (!id) throw new Error('Managed process ID is required');
    const lifecycleLease = typeof specification?.getLifecycleLease === 'function' ? specification.getLifecycleLease() : specification?.lifecycleLease;
    if (specification?.owner?.componentId) this.lifecycleCoordinator?.assertLaunchAllowed?.(specification.owner.componentId, lifecycleLease);
    const existing = this.processes.get(id);
    if (existing && !existing.released) throw new Error(`Managed process already exists: ${id}`);
    const managed = new ManagedProcess(this, { ...specification, id });
    this.processes.set(id, managed);
    try {
      managed.start();
    } catch (error) {
      if (managed.child) {
        void managed.stop('launch-failed').catch(stopError => managed._safeLog('error', 'Managed process launch cleanup failed', managed.details({ error: safeError(stopError) })));
      } else managed.release();
      throw error;
    }
    return managed;
  }

  status(id) {
    return this.processes.get(String(id || ''))?.status() || null;
  }

  list() {
    return [...this.processes.values()].map(process => process.status()).sort((left, right) => left.id.localeCompare(right.id));
  }

  hasWhere(predicate) {
    return [...this.processes.values()].some(process => {
      const status = process.status();
      return predicate(status) && isActiveManagedProcessStatus(status);
    });
  }

  hasUnconfirmedOwner(componentId) {
    const id = String(componentId || '');
    return [...this.processes.values()].some(process => process.owner?.componentId === id && process.lifecycle?.terminationFailed === true);
  }

  async stopWhere(predicate, reason = 'owner-revoked') {
    const matches = [...this.processes.values()].filter(process => predicate(process.status()));
    await Promise.all(matches.map(process => process.stop(reason)));
    return matches.length;
  }

  async stopAll(reason = 'application-shutdown', options = {}) {
    this.stopping = true;
    const processes = [...this.processes.values()];
    const results = await Promise.allSettled(processes.map(process => process.stop(reason, options)));
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      try {
        this.log('error', 'Managed process stop failed', {
          processId: processes[index].id, processKind: processes[index].kind,
          reason, error: safeError(result.reason), code: result.reason?.code, cause: result.reason?.cause ? safeError(result.reason.cause) : undefined,
        });
      } catch { /* logging must not replace the termination failure */ }
    });
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) { this.stopping = false; throw new AggregateError(errors, 'Unable to stop every managed process'); }
    this.processes.clear();
  }

  hasComponentOwnerProcesses(componentId) {
    const id = String(componentId || '');
    return this.hasWhere(status => status.owner?.componentId === id) || this.hasUnconfirmedOwner(id);
  }
}

const createProcessSupervisor = options => new ProcessSupervisor(options);

module.exports = { DEFAULT_RESTART_POLICY, ManagedProcess, ProcessSupervisor, createProcessSupervisor, isActiveManagedProcessStatus, stopProcessAndWait, terminateAndWait };
