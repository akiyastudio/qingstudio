const path = require('path');
const { getComponentLifecycleLease, withComponentLifecycleLease } = require('./component-lifecycle-context.cjs');

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_CAPABILITIES_PER_REQUEST = 128;
// A four-hour task can poll cancellation every 200ms (72,000 calls), as well
// as publish progress and outputs. Keep ordinary RPCs small, but grant a
// bounded task budget only after the broker has actually started a Host task.
const MAX_TASK_CAPABILITIES_PER_REQUEST = 256 * 1024;
const TASK_CAPABILITY_WINDOW_MS = 1000;
const MAX_TASK_CAPABILITIES_PER_WINDOW = 128;
const MAX_CONCURRENT_CAPABILITIES = 8;
const MAX_PENDING_WRITE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const LONG_REQUEST_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const BACKUP_RESTORE_INVOCATION = Symbol('component-backup-restore-invocation');
const isUnboundedLifecycleAction = (method, payload) => method === 'component.lifecycle' && ['install','repair'].includes(String(payload?.action || ''));

const cloneRequestPayload = payload => {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Component service payload must be an object');
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_LINE_BYTES) throw new RangeError('Component service payload is too large');
  return JSON.parse(serialized);
};

const serviceEnvironment = (source = process.env) => Object.fromEntries([
  'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
].filter(key => typeof source[key] === 'string' && source[key]).map(key => [key, source[key]]));

const publicContext = (context, componentBackupRestore = false) => Object.freeze({
  componentId: context.componentId,
  componentVersion: context.componentVersion,
  surface: context.surface || 'project',
  ...(context.contentKind ? { contentKind: context.contentKind } : {}),
  componentBackupRestore: componentBackupRestore === true,
  projectId: context.projectId,
  projectName: context.projectName,
  projectStatus: context.projectStatus,
});

const prepareReady = session => {
  session.readySettled = false;
  session.ready = new Promise((resolve, reject) => {
    session.readyResolve = value => { session.readySettled = true; resolve(value); };
    session.readyReject = error => { session.readySettled = true; reject(error); };
  });
};
const rememberCompletedParent = (session, id) => {
  (session.completedParentIds ||= new Map()).set(String(id), Date.now());
  while (session.completedParentIds.size > 256) session.completedParentIds.delete(session.completedParentIds.keys().next().value);
};

class ComponentServiceManager {
  constructor({ registry, processSupervisor, capabilityBroker, lifecycleCoordinator = null, executablePath = process.execPath, writeLog = () => undefined, requestTimeoutMs = REQUEST_TIMEOUT_MS, longRequestTimeoutMs = LONG_REQUEST_TIMEOUT_MS }) {
    this.registry = registry;
    this.processSupervisor = processSupervisor;
    this.capabilityBroker = capabilityBroker;
    this.lifecycleCoordinator = lifecycleCoordinator;
    this.executablePath = executablePath;
    this.writeLog = writeLog;
    this.requestTimeoutMs = requestTimeoutMs;
    this.longRequestTimeoutMs = longRequestTimeoutMs;
    this.sessions = new Map();
    this.sessionTransitions = new Map();
    this.nextRequestId = 1;
    this.storageSnapshotBarrier = null;
    this.activeInvocations = 0;
    this.activityWaiters = new Set();
    this.backupRestoreLeaseTail = Promise.resolve();
    this.backupRestoreLeaseCount = 0;
    this.backupRestoreIdle = Promise.resolve();
    this.releaseBackupRestoreIdle = null;
    this.quarantinedComponents = new Map();
    this.destroyed = false;
    this.destroying = false;
    this.destroyPromise = null;
  }

  supports(componentId, method) {
    if (this.quarantinedComponents.has(String(componentId || ''))) return false;
    const descriptor = this.registry.resolve(componentId);
    const normalizedMethod = String(method || '');
    return Boolean(descriptor?.service?.rpcMethods.includes(normalizedMethod) && !descriptor.service.hostOnlyRpcMethods?.includes(normalizedMethod) && !this.isBackupRestoreMethod(descriptor, normalizedMethod));
  }

  isBackupRestoreMethod(descriptor, method) {
    const declaration = descriptor?.service?.backupRestore;
    return Boolean(declaration && [declaration.workspace?.method, declaration.project?.method].filter(Boolean).includes(String(method || '')));
  }

  backupRestoreDescriptors() {
    return this.registry.list().filter(descriptor => descriptor?.service?.backupRestore);
  }

  backupSnapshotDescriptors() {
    return this.registry.list().map(descriptor => ({
      componentId: descriptor.componentId,
      componentVersion: descriptor.componentVersion,
      service: descriptor.service ? { backupRestore: descriptor.service.backupRestore || null, rpcMethods: descriptor.service.rpcMethods || [] } : null,
    }));
  }

  quarantine(componentId, reason = 'component-quarantined') { this.quarantinedComponents.set(String(componentId || ''), String(reason)); }
  assertNotQuarantined(componentId) { if (this.quarantinedComponents.has(String(componentId || ''))) { const error = new Error(`Component ${componentId} is quarantined`); error.code = 'COMPONENT_QUARANTINED'; throw error; } }
  async clearQuarantineAfterRepair(componentId) {
    const id = String(componentId || ''); const reason = this.quarantinedComponents.get(id); if (!reason) return false;
    await this.stop(id, 'component-quarantine-repair'); this.quarantinedComponents.delete(id);
    try { const descriptor = this.registry.resolve(id); if (!descriptor) throw new Error(`Unknown component: ${id}`); const session = await this.ensureSession(descriptor); await session.ready; return true; }
    catch (error) { this.quarantinedComponents.set(id, reason); throw error; }
  }

  async prepareBackupRestore(componentIds) {
    for (const componentId of [...new Set((componentIds || []).map(String))]) {
      this.assertNotQuarantined(componentId);
      const descriptor = this.registry.resolve(componentId);
      if (!descriptor?.service?.backupRestore) throw new Error(`Unknown component backup restore owner: ${componentId}`);
      this.capabilityBroker.assertCapabilities(descriptor);
      const lifecycleLease = this.lifecycleCoordinator?.acquireWork?.(componentId, 'backup-restore-prepare');
      try { const session = await this.ensureSession(descriptor, lifecycleLease); await session.ready; }
      finally { lifecycleLease?.release(); }
    }
    return true;
  }

  async invokeBackupRestore(componentId, mode, payload, boundContext = {}) {
    this.assertNotQuarantined(componentId);
    if (!['workspace', 'project'].includes(mode)) throw new TypeError('Invalid component backup restore mode');
    const descriptor = this.registry.resolve(componentId);
    const hook = descriptor?.service?.backupRestore?.[mode];
    if (!hook) { const error = new Error(`Component ${componentId} does not support ${mode} backup restore`); error.code = mode === 'project' ? 'COMPONENT_PROJECT_RESTORE_UNSUPPORTED' : 'COMPONENT_WORKSPACE_RESTORE_UNSUPPORTED'; throw error; }
    return this.withBackupRestoreLease([componentId], invoke => invoke(componentId, mode, payload, boundContext));
  }

  async withBackupRestoreLease(componentIds, worker) {
    if (this.backupRestoreLeaseCount++ === 0) this.backupRestoreIdle = new Promise(resolve => { this.releaseBackupRestoreIdle = resolve; });
    let releaseTurn;
    const previousTurn = this.backupRestoreLeaseTail;
    this.backupRestoreLeaseTail = new Promise(resolve => { releaseTurn = resolve; });
    await previousTurn;
    try { return await this.withBackupRestoreLeaseExclusive(componentIds, worker); }
    finally {
      releaseTurn();
      this.backupRestoreLeaseCount -= 1;
      if (this.backupRestoreLeaseCount === 0) { this.releaseBackupRestoreIdle?.(); this.releaseBackupRestoreIdle = null; }
    }
  }

  async withBackupRestoreLeaseExclusive(componentIds, worker) {
    if (!Array.isArray(componentIds) || typeof worker !== 'function') throw new TypeError('Invalid component backup restore lease');
    const normalizedIds = [...new Set(componentIds.map(String))];
    const lifecycleLeases = new Map();
    try {
      for (const componentId of normalizedIds) lifecycleLeases.set(componentId, this.lifecycleCoordinator?.acquireWork?.(componentId, 'backup-restore'));
    let preparedSessions;
    while (true) {
      if (this.storageSnapshotBarrier) await this.storageSnapshotBarrier.released;
      preparedSessions = new Map();
      for (const componentId of normalizedIds) {
        this.assertNotQuarantined(componentId);
        const descriptor = this.registry.resolve(componentId);
        if (!descriptor) throw new Error(`Unknown component: ${componentId}`);
        this.capabilityBroker.assertCapabilities(descriptor);
        const session = await this.ensureSession(descriptor, lifecycleLeases.get(componentId)); await session.ready; preparedSessions.set(componentId, session);
      }
      if (!this.storageSnapshotBarrier) break;
    }
    let releaseBarrier;
    const barrier = { released: new Promise(resolve => { releaseBarrier = resolve; }), release: () => releaseBarrier() };
    this.storageSnapshotBarrier = barrier;
    try {
      if (this.activeInvocations > 0) {
        let timer; let notify;
        try {
          await Promise.race([
            new Promise(resolve => { notify = resolve; this.activityWaiters.add(resolve); }),
            new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('Component service is busy; backup restore was deferred'); error.code = 'COMPONENT_BUSY'; reject(error); }, this.requestTimeoutMs); timer.unref?.(); }),
          ]);
        } finally { clearTimeout(timer); if (notify) this.activityWaiters.delete(notify); }
      }
      const invoke = async (componentId, mode, payload, boundContext = {}) => {
        if (!['workspace', 'project'].includes(mode)) throw new TypeError('Invalid component backup restore mode');
        const descriptor = this.registry.resolve(componentId); const hook = descriptor?.service?.backupRestore?.[mode];
        if (!hook || !preparedSessions.has(componentId)) throw new Error(`Component ${componentId} is outside the backup restore lease`);
        return this.invokeOnce(descriptor, hook.method, cloneRequestPayload(payload), {
          ...boundContext, componentId: descriptor.componentId, componentVersion: descriptor.componentVersion, surface: 'backup.restore',
        }, preparedSessions.get(componentId), true, BACKUP_RESTORE_INVOCATION, lifecycleLeases.get(componentId));
      };
      return await worker(invoke);
    } finally {
      if (this.storageSnapshotBarrier === barrier) this.storageSnapshotBarrier = null;
      releaseBarrier();
    }
    } finally {
      for (const lifecycleLease of lifecycleLeases.values()) lifecycleLease?.release();
    }
  }

  async invoke(componentId, method, payload, boundContext) {
    if (this.destroying || this.destroyed) throw new Error('Component service manager is destroying or destroyed');
    if (this.quarantinedComponents.has(String(componentId || ''))) { const error = new Error(`Component ${componentId} is quarantined`); error.code = 'COMPONENT_QUARANTINED'; throw error; }
    const inheritedLease = getComponentLifecycleLease(boundContext);
    const lifecycleLease = this.lifecycleCoordinator?.isActiveWorkLease?.(componentId, inheritedLease)
      ? inheritedLease
      : this.lifecycleCoordinator?.acquireWork?.(componentId, `service-rpc:${String(method || '')}`);
    const ownsLifecycleLease = Boolean(lifecycleLease && lifecycleLease !== inheritedLease);
    const retainedLifecycleLease = !ownsLifecycleLease ? lifecycleLease?.retain?.() : null;
    try { return await this.invokeWithLease(componentId, method, payload, boundContext, lifecycleLease); }
    finally { retainedLifecycleLease?.release(); if (ownsLifecycleLease) lifecycleLease.release(); }
  }

  async invokeWithLease(componentId, method, payload, boundContext, lifecycleLease) {
    while (this.backupRestoreLeaseCount > 0 || this.storageSnapshotBarrier) {
      if (this.backupRestoreLeaseCount > 0) await this.backupRestoreIdle;
      if (this.storageSnapshotBarrier) await this.storageSnapshotBarrier.released;
    }
    this.activeInvocations += 1;
    try {
    const descriptor = this.registry.resolve(componentId);
    if (!descriptor?.service?.rpcMethods.includes(String(method || ''))) throw new Error(`Unknown component service RPC method: ${method}`);
    this.capabilityBroker.assertCapabilities(descriptor);
    const normalizedMethod = String(method || '');
    if (this.isBackupRestoreMethod(descriptor, normalizedMethod)) {
      const error = new Error(`Component backup restore method is host-only: ${normalizedMethod}`);
      error.code = 'COMPONENT_HOST_ONLY_METHOD';
      throw error;
    }
    const normalizedPayload = cloneRequestPayload(payload);
    return await this.invokeOnce(descriptor, normalizedMethod, normalizedPayload, boundContext, null, false, null, lifecycleLease);
    } finally {
      this.activeInvocations -= 1;
      if (this.activeInvocations === 0) {
        for (const notify of this.activityWaiters) notify();
        this.activityWaiters.clear();
      }
    }
  }

  async invokeOnce(descriptor, method, payload, boundContext, preparedSession = null, forceLongTimeout = false, invocationIdentity = null, lifecycleLease = null) {
    if (this.isBackupRestoreMethod(descriptor, method) && invocationIdentity !== BACKUP_RESTORE_INVOCATION) {
      const error = new Error(`Component backup restore method is host-only: ${method}`);
      error.code = 'COMPONENT_HOST_ONLY_METHOD';
      throw error;
    }
    const session = preparedSession || await this.ensureSession(descriptor, lifecycleLease);
    await session.ready;
    const id = String(this.nextRequestId++);
    const message = { type: 'request', id, method, payload, context: {
      ...publicContext(boundContext, invocationIdentity === BACKUP_RESTORE_INVOCATION),
      permissions: ['application.settings', 'application.command'].includes(boundContext.surface)
        ? (descriptor.service.permissions || []).filter(permission => ['component.settings', 'component.secrets', 'network.fetch', 'component.lifecycle.read', 'component.lifecycle.manage', 'dialogs', 'notifications'].includes(permission))
        : descriptor.service.permissions || [],
    } };
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const pending = { resolve, reject, timer: null, context: withComponentLifecycleLease(boundContext, lifecycleLease), method, startedAt, lastCapability: '', capabilityStartedAt: 0, activeCapabilities: 0, capabilityCount: 0, seenCapabilityIds: new Set(), deferredResponse: null, longTimeoutArmed: forceLongTimeout, deadlineDisabled: false, onTimeout: null };
      pending.onTimeout = () => {
        if (session.pending.get(id) !== pending) return;
        session.pending.delete(id);
        rememberCompletedParent(session, id);
        let cancelError = null;
        try { this.writeFrame(session, { type: 'cancel', id, reason: 'deadline-exceeded' }); }
        catch (error) { cancelError = error; }
        const elapsedMs = Date.now() - startedAt;
        const capability = pending.lastCapability
          ? `; last capability ${pending.lastCapability} for ${Math.max(0, Date.now() - pending.capabilityStartedAt)}ms`
          : '; no capability response was pending';
        const error = new Error(`Component service request timed out after ${elapsedMs}ms: ${descriptor.componentId}.${method}${capability}`);
        error.code = 'COMPONENT_HOST_TIMEOUT';
        reject(error);
        try { this.writeLog('warn', 'Component service request timed out', { componentId: descriptor.componentId, method, elapsedMs, lastCapability: pending.lastCapability || '', pendingCount: session.pending.size }); } catch { /* Timeout rejection must not depend on logging. */ }
        if (cancelError) try { this.writeLog('warn', 'Component service timeout cancellation could not be delivered', { componentId: descriptor.componentId, method, error: cancelError.message || String(cancelError) }); } catch { /* Best effort only. */ }
      };
      pending.timer = setTimeout(pending.onTimeout, pending.longTimeoutArmed ? this.longRequestTimeoutMs : this.requestTimeoutMs);
      pending.timer.unref?.();
      session.pending.set(id, pending);
      try { this.writeFrame(session, message); }
      catch (error) { clearTimeout(pending.timer); session.pending.delete(id); reject(error); }
    });
  }

  async ensureSession(descriptor, lifecycleLease = null) {
    const ownedLease = lifecycleLease ? null : this.lifecycleCoordinator?.acquireWork?.(descriptor?.componentId, 'service-session');
    try { return await this.ensureSessionWithLease(descriptor, lifecycleLease || ownedLease); }
    finally { ownedLease?.release(); }
  }

  async ensureSessionWithLease(descriptor, lifecycleLease) {
    if (this.destroying || this.destroyed) throw new Error('Component service manager is destroying or destroyed');
    this.assertNotQuarantined(descriptor?.componentId);
    if (this.storageSnapshotBarrier) {
      await this.storageSnapshotBarrier.released;
      return this.ensureSessionWithLease(descriptor, lifecycleLease);
    }
    const componentId = descriptor.componentId;
    const existing = this.sessions.get(componentId);
    if (existing && existing.version === descriptor.componentVersion && !existing.managed.released) return existing;
    const activeTransition = this.sessionTransitions.get(componentId);
    if (activeTransition) { await activeTransition; return this.ensureSessionWithLease(descriptor, lifecycleLease); }
    const transition = (async () => {
      const current = this.sessions.get(componentId);
      if (current && current.version === descriptor.componentVersion && !current.managed.released) return current;
      if (current) await current.managed.stop('component-version-changed');
      const service = descriptor.service;
      const nodeRuntime = service.runtime === 'node';
      const command = nodeRuntime ? this.executablePath : service.entry;
      const developmentRuntimeArgs = descriptor.developmentRuntime
        ? ['--photoflow-development-command', descriptor.developmentRuntime.command, ...descriptor.developmentRuntime.argsPrefix.flatMap(value => ['--photoflow-development-arg', value])]
        : [];
      const args = nodeRuntime ? [service.entry, ...developmentRuntimeArgs] : developmentRuntimeArgs;
      const options = {
        cwd: path.dirname(service.entry),
        env: { ...serviceEnvironment(), ...(nodeRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      const session = {
        descriptor, version: descriptor.componentVersion, pending: new Map(), completedParentIds: new Map(),
        ready: null, readyResolve: null, readyReject: null, readySettled: false, managed: null,
      };
      prepareReady(session);
      session.managed = this.processSupervisor.launch({
        id: `component-service:${componentId}`,
        kind: 'component-service', command, args, options, owner: { componentId }, getLifecycleLease: () => this.lifecycleCoordinator?.currentLease?.(componentId), windowsJob: true,
        health: { startupTimeoutMs: 15000 },
        restart: { enabled: true, maxRestarts: 2, windowMs: 60000, backoffMs: [100, 500] },
        onSpawn: (child, managed) => this.attach(session, child, managed),
      });
      if (this.destroying || this.destroyed) { await session.managed.stop('component-service-manager-destroy'); throw new Error('Component service manager is destroying or destroyed'); }
      session.managed.on('restart-exhausted', () => {
        if (!session.readySettled) session.readyReject(new Error('Component service restart limit reached'));
      });
      this.sessions.set(componentId, session);
      return session;
    })();
    this.sessionTransitions.set(componentId, transition);
    try { return await transition; }
    finally { if (this.sessionTransitions.get(componentId) === transition) this.sessionTransitions.delete(componentId); }
  }

  attach(session, child, managed) {
    if (session.readySettled) prepareReady(session);
    let fragments = []; let bufferedBytes = 0; let recycled = false;
    const acceptLine = bytes => {
      if (recycled) return;
      const lineBytes = bytes.length && bytes[bytes.length - 1] === 13 ? bytes.subarray(0, -1) : bytes;
      let frame;
      try { frame = JSON.parse(lineBytes.toString('utf8')); } catch { recycled = true; managed.recycle('invalid-protocol-frame'); return; }
      void this.handleFrame(session, frame, managed).catch(error => {
        recycled = true;
        this.writeLog('warn', 'Component service protocol handling failed', { componentId: session.descriptor.componentId, error: error.message || String(error) });
        managed.recycle('protocol-handler-failed');
      });
    };
    const onData = value => {
      if (recycled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        if (bufferedBytes + segment.length > MAX_LINE_BYTES) { recycled = true; fragments = []; bufferedBytes = 0; managed.recycle('oversized-protocol-frame'); return; }
        if (segment.length) { fragments.push(segment); bufferedBytes += segment.length; }
        if (newline < 0) return;
        const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, bufferedBytes);
        fragments = []; bufferedBytes = 0; acceptLine(line); offset = newline + 1;
      }
    };
    child.stdout.on('data', onData);
    const recycleSafely=reason=>{if(recycled)return;recycled=true;try{managed.recycle(reason);}catch{/* stream errors must not crash the host */}};
    child.stdout.on('error', () => recycleSafely('stdout-error'));
    child.stderr?.on?.('data', value => { try { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); this.writeLog('warn', 'Component service stderr', { componentId: session.descriptor.componentId, byteCount: Math.min(bytes.length, MAX_LINE_BYTES) }); } catch { /* diagnostic streams are best effort */ } });
    child.stderr?.on?.('error', () => recycleSafely('stderr-error'));
    child.stdin?.on?.('error', () => recycleSafely('stdin-error'));
    child.stdout.on('end', () => {
      if (!recycled && bufferedBytes) { recycled = true; managed.recycle('unterminated-protocol-frame'); }
    });
    child.once('exit', () => {
      recycled = true; fragments = []; bufferedBytes = 0; child.stdout.removeListener('data', onData);
      if (!session.readySettled) { const error=new Error(`Component service failed before ready: ${session.descriptor.componentId}`);error.code='COMPONENT_HOST_SERVICE_START_FAILED';session.readyReject(error); }
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        const error = new Error(`Component service exited before completing ${session.descriptor.componentId}.${pending.method}`);
        error.code = 'COMPONENT_HOST_SERVICE_EXITED';
        pending.reject(error);
      }
      session.pending.clear();
    });
  }

  async handleFrame(session, frame, managed) {
    if (frame?.type === 'ready' && Number(frame.protocolVersion) === session.descriptor.service.protocolVersion) {
      managed.markHealthy({ protocol: `component-service-v${frame.protocolVersion}` });
      session.readyResolve();
      return;
    }
    if (frame?.type === 'response') {
      const pending = session.pending.get(String(frame.id || ''));
      if (!pending) return;
      if (frame.ok !== true && frame.ok !== false) throw new Error('Component service response must declare a boolean ok result');
      if (pending.activeCapabilities > 0) {
        if (pending.deferredResponse) throw new Error('Component service sent duplicate parent responses');
        pending.deferredResponse = frame;
        return;
      }
      session.pending.delete(String(frame.id));
      rememberCompletedParent(session, frame.id);
      clearTimeout(pending.timer);
      if (frame.ok === false) {
        const error = new Error(String(frame.error || 'Component service request failed'));
        error.code = String(frame.errorCode || 'COMPONENT_SERVICE_REQUEST_FAILED');
        error.retryable = frame.retryable === true;
        pending.reject(error);
      } else pending.resolve(frame.result);
      return;
    }
    if (frame?.type === 'capability') {
      const parent = session.pending.get(String(frame.parentId || ''));
      if (!parent) { if (session.completedParentIds?.has(String(frame.parentId || ''))) throw new Error('Component service sent a capability after its parent completed'); this.writeFrame(session, { type: 'capability-response', id: frame.id, ok: false, error: 'Unknown parent request' }); return; }
      if (parent.deferredResponse) throw new Error('Component service sent a capability after its parent response');
      const capabilityId = String(frame.id || '');
      if (!capabilityId || capabilityId.length > 128 || parent.seenCapabilityIds.has(capabilityId)) throw new Error('Component service sent an invalid or duplicate capability id');
      const capabilityLimit = parent.hostTaskStarted ? MAX_TASK_CAPABILITIES_PER_REQUEST : MAX_CAPABILITIES_PER_REQUEST;
      if (parent.activeCapabilities >= MAX_CONCURRENT_CAPABILITIES || parent.capabilityCount >= capabilityLimit) throw new Error('Component service exceeded nested capability limits');
      if (parent.hostTaskStarted) {
        const now = Date.now();
        if (parent.taskCapabilityWindowStartedAt === undefined || now - parent.taskCapabilityWindowStartedAt >= TASK_CAPABILITY_WINDOW_MS) {
          parent.taskCapabilityWindowStartedAt = now;
          parent.taskCapabilityWindowCount = 0;
        }
        if (parent.taskCapabilityWindowCount >= MAX_TASK_CAPABILITIES_PER_WINDOW) throw new Error('Component service exceeded task capability rate limit');
        parent.taskCapabilityWindowCount += 1;
      }
      parent.seenCapabilityIds.add(capabilityId); parent.capabilityCount += 1; parent.activeCapabilities += 1; this.activeInvocations += 1;
      parent.lastCapability = String(frame.method || '');
      const capabilityStartedAt = Date.now();
      parent.capabilityStartedAt = capabilityStartedAt;
      try {
        const invocation = this.capabilityBroker.invoke(session.descriptor, frame.method, frame.payload, parent.context);
        if ((isUnboundedLifecycleAction(frame.method, frame.payload) || frame.method === 'component.runtime.execute' && frame.payload?.action === 'execute' && frame.payload?.timeoutMs === 0 && frame.payload?.task?.background === true && typeof frame.payload?.control?.cancelArgument === 'string' && frame.payload.control.cancelArgument.length > 0) && !parent.deadlineDisabled) {
          clearTimeout(parent.timer);
          parent.longTimeoutArmed = true;
          parent.deadlineDisabled = true;
          parent.timer = null;
        } else if (((frame.method === 'component.lifecycle' && ['preflight', 'verify-package', 'uninstall'].includes(String(frame.payload?.action || '')))
          || frame.method === 'tasks'
          || frame.method === 'component.runtime.execute' && frame.payload?.action === 'execute'
          || frame.method === 'project.media.process') && !parent.longTimeoutArmed && !parent.deadlineDisabled) {
          clearTimeout(parent.timer);
          parent.longTimeoutArmed = true;
          parent.timer = setTimeout(parent.onTimeout, this.longRequestTimeoutMs);
          parent.timer.unref?.();
        }
        const result = await invocation;
        if (frame.method === 'tasks' && ['start', 'resume'].includes(String(frame.payload?.action || '')) && result?.task && result.cancelled !== true) {
          parent.hostTaskStarted = true;
        }
        this.writeFrame(session, { type: 'capability-response', id: frame.id, ok: true, result });
      } catch (error) {
        this.writeFrame(session, { type: 'capability-response', id: frame.id, ok: false, error: error.message || String(error), errorCode: error.code || 'COMPONENT_HOST_INTERNAL', retryable: error.retryable === true });
      } finally {
        parent.activeCapabilities -= 1; this.activeInvocations -= 1;
        if (this.activeInvocations === 0) { for (const notify of this.activityWaiters) notify(); this.activityWaiters.clear(); }
        if (session.pending.get(String(frame.parentId || '')) === parent && parent.capabilityStartedAt === capabilityStartedAt) {
          parent.lastCapability = '';
          parent.capabilityStartedAt = 0;
        }
        if (session.pending.get(String(frame.parentId || '')) === parent && parent.activeCapabilities === 0 && parent.deferredResponse) {
          const deferred = parent.deferredResponse; parent.deferredResponse = null;
          await this.handleFrame(session, deferred, managed);
        }
      }
      return;
    }
    if (frame?.type === 'metric') {
      this.writeLog('info', 'Component service migration phase', {
        componentId: session.descriptor.componentId,
        migration: String(frame.migration || ''), phase: String(frame.phase || ''),
        itemCount: Math.max(0, Number(frame.itemCount) || 0), byteCount: Math.max(0, Number(frame.byteCount) || 0),
        elapsedMs: Math.max(0, Number(frame.elapsedMs) || 0), state: String(frame.state || ''),
      });
      return;
    }
    managed.recycle('unexpected-protocol-frame');
  }

  writeFrame(session, value) {
    const child = session.managed.child;
    if (!child?.stdin?.writable) throw new Error('Component service is unavailable');
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > MAX_LINE_BYTES || Number(child.stdin.writableLength || 0) + bytes.length > MAX_PENDING_WRITE_BYTES) throw new Error('Component service input backpressure limit exceeded');
    child.stdin.write(bytes);
  }

  async stop(componentId, reason = 'component-service-stop', options = {}) {
    const id = String(componentId || '');
    await this.sessionTransitions.get(id)?.catch(() => undefined);
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.managed.stop(reason, options);
    if (this.sessions.get(id) === session) this.sessions.delete(id);
    return true;
  }

  async stopAll(reason = 'component-services-stop', options = {}) {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map(componentId => this.stop(componentId, reason, options)));
    return ids.length;
  }

  async quiesceForStorageSnapshot({ timeoutMs = 5000 } = {}) {
    if (this.destroying || this.destroyed) throw new Error('Component service manager is destroying or destroyed');
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 5000);
    const beforeDeadline = (promise, message = 'Component service is busy; storage snapshot was deferred') => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { const error = new Error(message); error.code = 'COMPONENT_BUSY'; throw error; }
      let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error(message); error.code = 'COMPONENT_BUSY'; reject(error); }, remaining); timer.unref?.(); })]).finally(() => clearTimeout(timer));
    };
    if (this.backupRestoreLeaseCount > 0) await beforeDeadline(this.backupRestoreIdle);
    if (this.storageSnapshotBarrier) {
      await beforeDeadline(this.storageSnapshotBarrier.released);
    }
    let releaseBarrier;
    let barrierReleased = false;
    const barrier = { released: new Promise(resolve => { releaseBarrier = resolve; }), release: () => { if (!barrierReleased) { barrierReleased = true; releaseBarrier(); } } };
    this.storageSnapshotBarrier = barrier;
    let descriptors = []; let stopWork = null;
    try {
    if (this.activeInvocations > 0) {
      let timer;
      let activityNotify;
      try {
        await Promise.race([
          new Promise(resolve => { activityNotify = resolve; this.activityWaiters.add(resolve); }),
            new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('Component service is busy; storage snapshot was deferred'); error.code = 'COMPONENT_BUSY'; reject(error); }, Math.max(1, deadline - Date.now())); }),
        ]);
      } finally { clearTimeout(timer); if (activityNotify) this.activityWaiters.delete(activityNotify); }
    }
    await beforeDeadline(Promise.allSettled([...this.sessionTransitions.values()]));
    descriptors = [...this.sessions.values()].map(session => session.descriptor);
    stopWork = Promise.allSettled(descriptors.map(descriptor => this.stop(descriptor.componentId, 'component-storage-snapshot')));
    const stopResults = await beforeDeadline(stopWork);
    const stopErrors = stopResults.filter(result => result.status === 'rejected').map(result => result.reason);
    if (stopErrors.length) {
      throw new AggregateError(stopErrors, 'Unable to quiesce every component service for storage snapshot');
    }
    let resumed = false;
    return async () => {
      if (resumed) return;
      resumed = true;
      if (this.storageSnapshotBarrier === barrier) this.storageSnapshotBarrier = null;
      barrier.release();
      const results = await Promise.allSettled(descriptors.map(descriptor => this.ensureSession(descriptor)));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Unable to resume every component service after storage snapshot');
    };
    } catch (error) {
      if (this.storageSnapshotBarrier === barrier) this.storageSnapshotBarrier = null;
      barrier.release();
      const restore = async () => { if (stopWork) await stopWork; if (!this.destroyed) await Promise.allSettled(descriptors.map(descriptor => this.ensureSession(descriptor))); };
      void restore().catch(failure => { try { this.writeLog('warn', 'Component services could not be fully restored after quiesce failure', { error: failure.message || String(failure) }); } catch { /* best effort */ } });
      throw error;
    }
  }

  async destroy() {
    if (this.destroyed) return;
    if(this.destroyPromise)return this.destroyPromise;
    this.destroying=true;
    const operation=(async()=>{const barrier = this.storageSnapshotBarrier;this.storageSnapshotBarrier = null;barrier?.release();await Promise.allSettled([...this.sessionTransitions.values()]);const sessions=[...this.sessions.entries()];const results=await Promise.allSettled(sessions.map(([,session])=>session.managed.stop('component-service-manager-destroy')));results.forEach((result,index)=>{if(result.status==='fulfilled'&&this.sessions.get(sessions[index][0])===sessions[index][1])this.sessions.delete(sessions[index][0]);});const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,'Unable to stop every component service during destroy');this.destroyed=true;this.destroying=false;})();
    this.destroyPromise=operation;try{await operation;}finally{if(this.destroyPromise===operation)this.destroyPromise=null;}
  }
}

module.exports = { ComponentServiceManager, LONG_REQUEST_TIMEOUT_MS, MAX_CAPABILITIES_PER_REQUEST, MAX_TASK_CAPABILITIES_PER_REQUEST, MAX_TASK_CAPABILITIES_PER_WINDOW, TASK_CAPABILITY_WINDOW_MS, MAX_CONCURRENT_CAPABILITIES, MAX_LINE_BYTES, MAX_PENDING_WRITE_BYTES, REQUEST_TIMEOUT_MS, cloneRequestPayload, isUnboundedLifecycleAction, prepareReady, publicContext, serviceEnvironment };
