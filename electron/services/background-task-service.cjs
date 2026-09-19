const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { resolveBackgroundTaskPolicy } = require('./background-task-policies.cjs');
const { migrateBackgroundTaskPayload } = require('./background-task-migrations.cjs');
const { BACKGROUND_TASK_PERSISTENCE_VERSION, projectBackgroundTaskCapabilities } = require('./background-task-policy-versions.cjs');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const HISTORY_STATES = new Set([...TERMINAL_STATES, 'interrupted']);
const DISMISSIBLE_STATES = new Set([...TERMINAL_STATES, 'interrupted']);
const ACTIVE_STATES = new Set(['queued', 'running', 'pausing', 'paused', 'resuming']);
const MAX_PERSISTENCE_BYTES = 8 * 1024 * 1024;
const MAX_PERSISTED_TASKS = 5000;
const MAX_VALUE_DEPTH = 24;
const MAX_VALUE_NODES = 50000;

const controlledClone = (value, limits = {}, depth = 0, budget = { nodes: 0 }) => {
  const maxDepth = limits.maxDepth || MAX_VALUE_DEPTH;
  const maxNodes = limits.maxNodes || MAX_VALUE_NODES;
  if (depth > maxDepth || ++budget.nodes > maxNodes) throw Object.assign(new Error('background task data exceeds safety limits'), { code: 'TASK_DATA_TOO_LARGE' });
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => controlledClone(item, limits, depth + 1, budget));
  if (typeof value !== 'object') return undefined;
  const clone = {};
  for (const [key, item] of Object.entries(value)) clone[key] = controlledClone(item, limits, depth + 1, budget);
  return clone;
};
const deepFreeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
};
const snapshotDefinition = definition => ({
  ...definition,
  metadata: controlledClone(definition?.metadata || {}),
  checkpoint: controlledClone(definition?.checkpoint),
  resources: deepFreeze(controlledClone(definition?.resources || [])),
  capacities: deepFreeze(controlledClone(definition?.capacities || [])),
});

const createBackgroundTaskService = ({ eventBus, maxHistory = 200, now = () => Date.now(), persistencePath = '', writeLog = () => undefined }) => {
  const tasks = new Map();
  const retryFactories = new Map();
  const resumeFactories = new Map();
  const typeResumeFactories = new Map();
  const restartFactories = new Map();
  const typeRestartFactories = new Map();
  const typeResumeRegistrations = new Map();
  const typeRestartRegistrations = new Map();
  const resumeFactoryOwners = new Map();
  const restartFactoryOwners = new Map();
  const retryFactoryOwners = new Map();
  const autoRestartTimers = new Map();
  const activeByKey = new Map();
  const completionByTaskId = new Map();
  const retryStarts = new Map();
  const resourceWaiters = [];
  const reservations = new Map();
  const retryContext = new AsyncLocalStorage();
  let persistenceTimer = null;
  let revision = 0;
  let resourceLeaseSequence = 0;
  let persistenceReadOnlyReason = '';
  let stopping = false;
  let quiescing = false;
  const shutdownWaiters = new Set();
  const isShutdownRelevant = task => {
    if (!['queued', 'running', 'pausing', 'paused', 'resuming'].includes(task.state)) return false;
    const policy = resolveBackgroundTaskPolicy(task);
    return policy.taskCenterPolicy === 'always' && !policy.foregroundNonBlocking && policy.notificationPolicy !== 'silent';
  };

  const safeLog = (level, message, details) => {
    try { writeLog(level, message, details); } catch (_) { /* logging is best effort */ }
  };
  const safeEmit = (event, payload) => {
    try { eventBus.emit(event, payload); }
    catch (error) { safeLog('warn', 'Background task observer failed', { event, error: error?.message || String(error) }); }
  };

  const normalizeResource = value => {
    const input = String(value || '').trim();
    if (!input) return '';
    const windowsStyle = process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\');
    const pathApi = windowsStyle ? path.win32 : path.posix;
    let normalized = pathApi.normalize(input.replace(windowsStyle ? /\//g : /\\/g, pathApi.sep));
    const root = pathApi.parse(normalized).root;
    while (normalized.length > root.length && normalized.endsWith(pathApi.sep)) normalized = normalized.slice(0, -1);
    if (windowsStyle) normalized = normalized.toLocaleLowerCase('en-US');
    return normalized.replace(/\\/g, '/');
  };
  const normalizeResourceRequest = (value, defaultAccess) => {
    const requestedPath = value && typeof value === 'object' ? value.path : value;
    const normalizedPath = normalizeResource(requestedPath);
    if (!normalizedPath || normalizedPath === '..' || normalizedPath.startsWith('../')) return null;
    const requestedAccess = value && typeof value === 'object' ? value.access : defaultAccess;
    return { path: normalizedPath, access: requestedAccess === 'read' ? 'read' : 'write' };
  };
  const normalizeCapacityRequest = (value, fallback = {}) => {
    const key = String(value && typeof value === 'object' ? value.key || value.kind : value || '').trim().toLocaleLowerCase('en-US');
    if (!key) return null;
    const access = value && typeof value === 'object' ? value.access : fallback.access;
    const limit = value && typeof value === 'object' ? value.limit : fallback.limit;
    const writeLimit = value && typeof value === 'object' ? value.writeLimit : fallback.writeLimit;
    return {
      key,
      access: access === 'read' ? 'read' : 'write',
      limit: Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 1,
      writeLimit: Number.isInteger(Number(writeLimit)) && Number(writeLimit) > 0
        ? Number(writeLimit) : Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 1,
    };
  };
  const isWithin = (value, parent) => value.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
  const resourcesConflict = (left, right) => left === right || isWithin(left, right) || isWithin(right, left);
  const effectiveCapacityFor = key => {
    const declarations = [];
    for (const reservation of reservations.values()) {
      declarations.push(...reservation.capacities.filter(capacity => capacity.key === key));
    }
    for (const waiting of resourceWaiters) {
      declarations.push(...waiting.capacities.filter(capacity => capacity.key === key));
    }
    return declarations.reduce((effective, capacity) => ({
      limit: Math.min(effective.limit, capacity.limit),
      writeLimit: Math.min(effective.writeLimit, capacity.writeLimit),
    }), { limit: Infinity, writeLimit: Infinity });
  };
  const blockingReservationIds = waiter => {
    const blockers = new Set();
    const activeReservations = [...reservations.entries()].filter(([, item]) => item.taskId !== waiter.taskId);
    for (const requestedCapacity of waiter.capacities) {
      const effective = effectiveCapacityFor(requestedCapacity.key);
      const activeInGroup = activeReservations.filter(([, item]) => item.capacities.some(capacity => capacity.key === requestedCapacity.key));
      if (activeInGroup.length >= effective.limit) activeInGroup.forEach(([id]) => blockers.add(id));
      if (requestedCapacity.access === 'write') {
        const activeWriters = activeInGroup.filter(([, item]) => item.capacities.some(capacity => capacity.key === requestedCapacity.key && capacity.access === 'write'));
        if (activeWriters.length >= effective.writeLimit) activeWriters.forEach(([id]) => blockers.add(id));
      }
    }
    for (const [id, active] of activeReservations) {
      const conflicts = waiter.resources.some(left => active.resources.some(right => (
        left.access === 'write' || right.access === 'write'
      ) && resourcesConflict(left.path, right.path)));
      if (conflicts) blockers.add(id);
    }
    return [...blockers];
  };
  const drainResourceWaiters = () => {
    for (let index = 0; index < resourceWaiters.length;) {
      const waiter = resourceWaiters[index];
      if (waiter.signal.aborted) {
        resourceWaiters.splice(index, 1);
        waiter.reject(Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELLED' }));
        continue;
      }
      const blockerIds = blockingReservationIds(waiter);
      if (blockerIds.length) {
        const task = tasks.get(waiter.taskId);
        const blockerTaskIds = [...new Set(blockerIds.map(id => reservations.get(id)?.taskId || id).filter(id => id !== waiter.taskId))];
        const blockerTitles = [...new Set(blockerTaskIds.map(id => tasks.get(id)?.title).filter(Boolean))];
        const message = blockerTitles.length
          ? `等待“${blockerTitles.slice(0, 2).join('、')}”完成${blockerTitles.length > 2 ? '等任务' : ''}`
          : '等待其他文件操作完成';
        if (task && (task.state === 'queued' || waiter.scoped) && (task.message !== message || String(task.blockedByTaskIds || '') !== String(blockerTaskIds))) {
          update(task, { message, blockedByTaskIds: blockerTaskIds });
        }
        index += 1;
        continue;
      }
      resourceWaiters.splice(index, 1);
      waiter.signal.removeEventListener('abort', waiter.abortListener);
      reservations.set(waiter.id, { taskId: waiter.taskId, capacities: waiter.capacities, resources: waiter.resources });
      if (waiter.scoped) {
        const task = tasks.get(waiter.taskId);
        if (task && (task.blockedByTaskIds?.length || waiter.runningMessage)) {
          update(task, { blockedByTaskIds: [], ...(waiter.runningMessage ? { message: waiter.runningMessage } : {}) });
        }
      }
      waiter.resolve(waiter.id);
    }
  };
  const acquireResources = (task, definition, { reservationId = task.id, scoped = false } = {}) => {
    const defaultAccess = definition.resourceAccess === 'read' ? 'read' : 'write';
    const resourcesByIdentity = new Map();
    for (const requested of definition.resources || []) {
      const resource = normalizeResourceRequest(requested, defaultAccess);
      if (!resource) continue;
      const existing = resourcesByIdentity.get(resource.path);
      if (!existing || resource.access === 'write') resourcesByIdentity.set(resource.path, resource);
    }
    const resources = [...resourcesByIdentity.values()];
    const access = resources.some(resource => resource.access === 'write') ? 'write' : defaultAccess;
    const capacitiesByKey = new Map();
    for (const requested of definition.capacities || []) {
      const capacity = normalizeCapacityRequest(requested);
      if (capacity) {
        const existing = capacitiesByKey.get(capacity.key);
        capacitiesByKey.set(capacity.key, existing ? {
          key: capacity.key,
          access: existing.access === 'write' || capacity.access === 'write' ? 'write' : 'read',
          limit: Math.min(existing.limit, capacity.limit),
          writeLimit: Math.min(existing.writeLimit, capacity.writeLimit),
        } : capacity);
      }
    }
    const legacyGroup = String(definition.concurrencyGroup || '').trim().toLocaleLowerCase('en-US');
    if (legacyGroup) {
      const capacity = normalizeCapacityRequest(legacyGroup, {
        access,
        limit: definition.concurrencyLimit,
        writeLimit: definition.concurrencyWriteLimit,
      });
      if (capacity) {
        const existing = capacitiesByKey.get(capacity.key);
        capacitiesByKey.set(capacity.key, existing ? {
          key: capacity.key,
          access: existing.access === 'write' || capacity.access === 'write' ? 'write' : 'read',
          limit: Math.min(existing.limit, capacity.limit),
          writeLimit: Math.min(existing.writeLimit, capacity.writeLimit),
        } : capacity);
      }
    }
    const capacities = [...capacitiesByKey.values()];
    if (!resources.length && !capacities.length) return Promise.resolve('');
    return new Promise((resolve, reject) => {
      const waiter = {
        id: reservationId,
        taskId: task.id,
        resources,
        capacities,
        scoped,
        runningMessage: String(definition.runningMessage || ''),
        signal: task.controller.signal,
        abortListener: drainResourceWaiters,
        resolve,
        reject,
      };
      resourceWaiters.push(waiter);
      task.controller.signal.addEventListener('abort', waiter.abortListener, { once: true });
      drainResourceWaiters();
    });
  };
  const releaseResourceReservation = id => {
    if (!id) return;
    reservations.delete(id);
    const waiterIndex = resourceWaiters.findIndex(waiter => waiter.id === id);
    if (waiterIndex >= 0) {
      const [waiter] = resourceWaiters.splice(waiterIndex, 1);
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
    drainResourceWaiters();
  };
  const releaseTaskResources = taskId => {
    for (const [reservationId, reservation] of reservations) {
      if (reservation.taskId === taskId) reservations.delete(reservationId);
    }
    for (let index = resourceWaiters.length - 1; index >= 0; index -= 1) {
      if (resourceWaiters[index].taskId === taskId) {
        const [waiter] = resourceWaiters.splice(index, 1);
        waiter.signal.removeEventListener('abort', waiter.abortListener);
        waiter.reject(Object.assign(new Error('任务已结束'), { code: 'TASK_FINISHED' }));
      }
    }
    drainResourceWaiters();
  };

  const publicTask = task => {
    const { controller: _controller, pauseRequested: _pauseRequested, pauseWaiters: _pauseWaiters, ...value } = task;
    return controlledClone(value);
  };
  const flushPersistence = () => {
    if (!persistencePath) return true;
    if (persistenceReadOnlyReason) return false;
    try {
      const directory = path.dirname(persistencePath);
      const temporaryPath = `${persistencePath}.tmp`;
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify({
        version: BACKGROUND_TASK_PERSISTENCE_VERSION,
        tasks: [...tasks.values()].filter(task => task.historyPolicy !== 'ephemeral').map(publicTask),
      }), 'utf8');
      fs.renameSync(temporaryPath, persistencePath);
      return true;
    } catch (error) {
      safeEmit('background-task:persistence-error', { error: error?.message || String(error), path: persistencePath });
      return false;
    }
  };
  const schedulePersistence = () => {
    if (!persistencePath || persistenceReadOnlyReason || persistenceTimer) return;
    persistenceTimer = setTimeout(() => {
      persistenceTimer = null;
      flushPersistence();
    }, 200);
    persistenceTimer.unref?.();
  };
  const deleteTaskInternal = id => {
    if (!tasks.has(id)) return false;
    tasks.delete(id);
    retryStarts.delete(id);
    retryFactories.delete(id);
    resumeFactories.delete(id);
    restartFactories.delete(id);
    retryFactoryOwners.delete(id);
    resumeFactoryOwners.delete(id);
    restartFactoryOwners.delete(id);
    return true;
  };
  const emitDelta = (upserts = [], removeIds = []) => {
    if (quiescing) return;
    revision += 1;
    try {
      safeEmit('background-task:changed', {
        revision,
        upserts: upserts.map(publicTask),
        removeIds: [...new Set(removeIds)],
      });
    } catch (error) {
      safeLog('warn', 'Background task delta serialization failed', { error: error?.message || String(error) });
    } finally { schedulePersistence(); }
  };
  const publish = task => {
    if (quiescing) { for (const check of shutdownWaiters) check(); return; }
    const upserts = [];
    const removeIds = [];
    if (task.retryOfTaskId && HISTORY_STATES.has(task.state)) {
      const previous = tasks.get(task.retryOfTaskId);
      if (task.state === 'completed' || task.state === 'failed') {
        if (previous && deleteTaskInternal(previous.id)) removeIds.push(previous.id);
        if (task.historyPolicy === 'ephemeral' || (task.state === 'completed' && resolveBackgroundTaskPolicy(task).successHistory === 'auto-clear')) {
          if (task.state === 'failed') safeLog('error', 'Ephemeral background task failed', {
            taskId: task.id, type: task.type, error: task.error || task.message, metadata: task.metadata,
          });
          if (deleteTaskInternal(task.id)) removeIds.push(task.id);
        } else upserts.push(task);
      } else {
        if (deleteTaskInternal(task.id)) removeIds.push(task.id);
        if (previous) {
          const canRetry = retryFactories.has(previous.id);
          Object.assign(previous, {
            replacedByTaskId: null,
            retryPending: false,
            retryable: canRetry,
            capabilities: { ...previous.capabilities, retryable: canRetry },
            updatedAt: now(),
          });
          upserts.push(previous);
        }
      }
    } else if ((task.historyPolicy === 'ephemeral' || (task.state === 'completed' && resolveBackgroundTaskPolicy(task).successHistory === 'auto-clear')) && HISTORY_STATES.has(task.state)) {
      if (task.state === 'failed') safeLog('error', 'Ephemeral background task failed', {
        taskId: task.id,
        type: task.type,
        error: task.error || task.message,
        metadata: task.metadata,
      });
      if (deleteTaskInternal(task.id)) removeIds.push(task.id);
    } else {
      upserts.push(task);
    }

    const removable = [...tasks.values()]
      .filter(item => HISTORY_STATES.has(item.state) && !item.retryPending)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (tasks.size > maxHistory && removable.length) {
      const oldest = removable.shift();
      if (deleteTaskInternal(oldest.id)) removeIds.push(oldest.id);
    }
    emitDelta(upserts.filter(item => tasks.has(item.id)), removeIds);
  };
  const update = (task, patch) => {
    if (stopping || tasks.get(task.id) !== task) return false;
    Object.assign(task, patch, { updatedAt: now() });
    publish(task);
    return true;
  };
  const removeTask = id => {
    if (!deleteTaskInternal(id)) return false;
    emitDelta([], [id]);
    return true;
  };

  const createHandle = (definition, retryFactory = null, { deferPublish = false } = {}) => {
    if (quiescing) throw Object.assign(new Error('应用正在退出'), { code: 'APP_SHUTTING_DOWN' });
    if (stopping) throw Object.assign(new Error('background task service is stopping'), { code: 'BACKGROUND_TASK_SERVICE_STOPPED' });
    definition = snapshotDefinition(definition);
    const replacementContext = retryContext.getStore();
    const mayClaimRetry = definition.retryReplacement !== false;
    const dedupeKey = definition.dedupeKey || '';
    const activeId = dedupeKey ? activeByKey.get(dedupeKey) : '';
    if (activeId) {
      const activeTask = tasks.get(activeId);
      const mayClaimActive = replacementContext && mayClaimRetry && (
        (activeTask?.retryOfTaskId === replacementContext.task.id && replacementContext.sourceInstanceId === replacementContext.task.instanceId)
        || (replacementContext.kind !== 'retry' && activeTask?.type === replacementContext.task.type)
      );
      if (mayClaimActive) {
        replacementContext.claimed = true;
        replacementContext.replacement = activeTask;
        replacementContext.deduplicated = true;
        replacementContext.resolveStart(activeTask);
      } else if (replacementContext && mayClaimRetry && !replacementContext.closed) {
        replacementContext.conflict = activeTask || null;
        replacementContext.closed = true;
        replacementContext.rejectStart(retryError('RETRY_DEDUPE_CONFLICT', '等价任务已在运行，本次重试未启动'));
      }
      return { deduplicated: true, task: publicTask(activeTask) };
    }
    const replacementSource = replacementContext && mayClaimRetry && !replacementContext.closed && !replacementContext.claimed
      && replacementContext.sourceInstanceId === replacementContext.task?.instanceId
      && replacementContext.task && (tasks.get(replacementContext.task.id) === replacementContext.task || replacementContext.sourceRemoved)
      ? replacementContext.task : null;
    if (replacementContext && mayClaimRetry && !replacementSource) {
      const error = retryError('STALE_TASK_GENERATION', '任务实例已更新，本次重试已取消');
      if (!replacementContext.closed) {
        replacementContext.closed = true;
        replacementContext.rejectStart(error);
      }
      throw error;
    }
    const retryOfTask = replacementContext?.kind === 'retry' ? replacementSource : null;
    const requestedDefinitionId = String(definition.id || '');
    const requestedId = retryOfTask && requestedDefinitionId === retryOfTask.id ? '' : requestedDefinitionId;
    const existing = requestedId ? tasks.get(requestedId) : null;
    if (existing && !TERMINAL_STATES.has(existing.state)) return { deduplicated: true, task: publicTask(existing) };
    // Reusing a fixed ID starts a new generation. Remove every factory and
    // owner belonging to the prior terminal generation before publishing it.
    if (existing) deleteTaskInternal(requestedId);
    const createdAt = now();
    const policy = resolveBackgroundTaskPolicy(definition);
    if (policy.foregroundNonBlocking && definition.resources?.length) {
      throw Object.assign(new Error(`后台维护任务不能持有贯穿任务的资源锁：${definition.type}`), {
        code: 'BACKGROUND_MAINTENANCE_RESOURCE_FORBIDDEN',
      });
    }
    if (policy.foregroundNonBlocking && definition.concurrencyGroup
        && !String(definition.concurrencyGroup).toLocaleLowerCase('en-US').startsWith('background-')) {
      throw Object.assign(new Error(`后台维护任务不能占用前台并发组：${definition.type}`), {
        code: 'BACKGROUND_MAINTENANCE_CAPACITY_FORBIDDEN',
      });
    }
    const resumeFactory = typeof definition.resumeFactory === 'function' ? definition.resumeFactory : null;
    const capabilities = projectBackgroundTaskCapabilities(policy, {
      cancellable: definition.cancellable !== false,
      resumable: Boolean(policy.resumable && resumeFactory),
      retryable: Boolean(retryFactory),
    });
    const task = {
      id: requestedId || crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      type: definition.type,
      title: definition.title || definition.type,
      state: 'queued',
      progress: Math.max(0, Math.min(100, Number(definition.progress) || 0)),
      message: definition.message || '',
      cancellable: capabilities.cancellable,
      retryable: Boolean(retryFactory),
      resumable: capabilities.resumable,
      resumeAvailable: Boolean(resumeFactory),
      restartAvailable: false,
      capabilities,
      resumePolicy: policy.resumePolicy,
      notificationPolicy: policy.notificationPolicy,
      historyPolicy: policy.historyPolicy,
      taskCenterPolicy: policy.taskCenterPolicy,
      retryOfTaskId: retryOfTask?.id || null,
      replacedByTaskId: null,
      retryAttempt: retryOfTask ? Math.max(0, Number(retryOfTask.retryAttempt) || 0) + 1 : Math.max(0, Number(definition.retryAttempt) || 0),
      retryPending: false,
      checkpointVersion: Math.max(1, Number(definition.checkpointVersion) || 1),
      checkpoint: definition.checkpoint,
      metadata: definition.metadata,
      createdAt,
      updatedAt: createdAt,
      startedAt: 0,
      finishedAt: 0,
      controller: new AbortController(),
      pauseRequested: false,
      pauseWaiters: new Set(),
    };
    tasks.set(task.id, task);
    if (dedupeKey) activeByKey.set(dedupeKey, task.id);
    if (retryFactory) retryFactories.set(task.id, retryFactory);
    if (resumeFactory) resumeFactories.set(task.id, resumeFactory);
    let published = false;
    const publishInitial = () => {
      if (published) return;
      published = true;
      if (retryOfTask) {
        emitDelta([retryOfTask, task], []);
        replacementContext.resolveStart(task);
      } else if (replacementSource) {
        emitDelta([task], replacementSource.id === task.id ? [] : [replacementSource.id]);
        replacementContext.resolveStart(task);
      } else publish(task);
    };
    if (replacementSource) {
      replacementContext.claimed = true;
      replacementContext.replacement = task;
      if (retryOfTask) Object.assign(retryOfTask, {
          replacedByTaskId: task.id,
          retryPending: true,
          retryable: false,
          capabilities: { ...retryOfTask.capabilities, retryable: false },
          updatedAt: now(),
        });
    }
    if (!deferPublish) publishInitial();
    const context = {
      id: task.id,
      signal: task.controller.signal,
      report: (progress, message = task.message, metadata) => {
        if (task.controller.signal.aborted || quiescing) return;
        update(task, {
          progress: Math.max(task.progress, Math.max(0, Math.min(100, Number(progress) || 0))),
          message,
          ...(metadata ? { metadata: { ...task.metadata, ...controlledClone(metadata) } } : {}),
        });
      },
      setCancellable: cancellable => {
        if (task.controller.signal.aborted || TERMINAL_STATES.has(task.state)) return;
        const next = Boolean(cancellable);
        update(task, { cancellable: next, capabilities: { ...task.capabilities, cancellable: next } });
      },
      setPausable: pausable => {
        if (task.controller.signal.aborted || TERMINAL_STATES.has(task.state)) return;
        const next = Boolean(pausable);
        update(task, { capabilities: { ...task.capabilities, pausable: next } });
      },
      waitIfPaused: async () => {
        if (!task.pauseRequested) return;
        if (task.state !== 'paused') update(task, { state: 'paused', message: '已暂停' });
        await new Promise(resolve => task.pauseWaiters.add(resolve));
        context.throwIfCancelled();
        if (!task.pauseRequested && (task.state === 'paused' || task.state === 'resuming')) update(task, { state: 'running', message: '正在继续任务' });
      },
      saveCheckpoint: (checkpoint, progress = task.progress, message = task.message, metadata) => {
        if (task.controller.signal.aborted || TERMINAL_STATES.has(task.state)) return;
        update(task, {
          checkpoint: controlledClone(checkpoint),
          progress: Math.max(task.progress, Math.max(0, Math.min(100, Number(progress) || 0))),
          message,
          ...(metadata ? { metadata: { ...task.metadata, ...controlledClone(metadata) } } : {}),
        });
      },
      getCheckpoint: () => controlledClone(task.checkpoint),
      throwIfCancelled: () => {
        if (task.controller.signal.aborted) {
          const error = new Error('任务已取消');
          error.code = 'TASK_CANCELLED';
          throw error;
        }
      },
      acquireResourceLease: async leaseDefinition => {
        context.throwIfCancelled();
        const reservationId = `${task.id}:lease:${++resourceLeaseSequence}`;
        const acquiredId = await acquireResources(task, leaseDefinition || {}, { reservationId, scoped: true });
        try { context.throwIfCancelled(); }
        catch (error) {
          releaseResourceReservation(acquiredId);
          throw error;
        }
        let released = false;
        return {
          id: acquiredId,
          release: () => {
            if (released) return false;
            released = true;
            releaseResourceReservation(acquiredId);
            return true;
          },
        };
      },
      withResources: async (leaseDefinition, worker) => {
        const lease = await context.acquireResourceLease(leaseDefinition);
        try { return await worker(); }
        finally { lease.release(); }
      },
    };
    let finished = false;
    let legacyStartLease = null;
    const finish = patch => {
      if (finished || stopping || tasks.get(task.id) !== task) return;
      finished = true;
      legacyStartLease?.release();
      legacyStartLease = null;
      update(task, { ...patch, finishedAt: now() });
      releaseTaskResources(task.id);
      if (dedupeKey && activeByKey.get(dedupeKey) === task.id) activeByKey.delete(dedupeKey);
    };
    let lifecycleStarted = false;
    const startLifecycle = () => {
      if (lifecycleStarted) return;
      lifecycleStarted = true;
      context.throwIfCancelled();
      update(task, { state: 'running', startedAt: now(), message: definition.runningMessage || task.message, blockedByTaskIds: [] });
    };
    return {
      deduplicated: false,
      task: publicTask(task),
      context,
      publishInitial,
      startLifecycle,
      waitForStart: async () => {
        const requiresLease = Boolean(
          (Array.isArray(definition.resources) && definition.resources.length)
          || (Array.isArray(definition.capacities) && definition.capacities.length)
          || definition.concurrencyGroup,
        );
        if (requiresLease) legacyStartLease = await context.acquireResourceLease(definition);
        startLifecycle();
      },
      complete: (message = task.message || '已完成') => finish({ state: 'completed', progress: 100, message, checkpoint: undefined }),
      fail: error => finish(quiescing && task.controller.signal.aborted ? { state: 'cancelled', error: '', message: '因退出停止' } : { state: 'failed', error: error?.message || String(error), message: error?.message || String(error) }),
      cancelled: () => finish({ state: 'cancelled', error: '', message: '已取消' }),
      isFinished: () => finished,
      snapshot: () => publicTask(task),
    };
  };

  const start = (definition, worker, retryFactory = null) => {
    definition = snapshotDefinition(definition);
    const handle = createHandle(definition, retryFactory, { deferPublish: true });
    if (handle.deduplicated) {
      const completion = completionByTaskId.get(handle.task.id) || Promise.resolve({ task: handle.task, deduplicated: true });
      return { task: handle.task, deduplicated: true, completion };
    }
    // Defer execution one microtask so completion ownership is registered
    // before lifecycle deltas or user code can observe the task.
    const completion = Promise.resolve().then(async () => {
      try {
        handle.startLifecycle();
        const requiresLease = Boolean(
          (Array.isArray(definition.resources) && definition.resources.length)
          || (Array.isArray(definition.capacities) && definition.capacities.length)
          || definition.concurrencyGroup,
        );
        const result = requiresLease
          ? await handle.context.withResources(definition, () => worker(handle.context))
          : await worker(handle.context);
        handle.context.throwIfCancelled();
        handle.complete();
        return { task: tasks.has(handle.task.id) ? publicTask(tasks.get(handle.task.id)) : handle.snapshot(), result };
      } catch (error) {
        const preempted = error?.code === 'DATABASE_PREEMPTED';
        const cancelled = preempted || handle.context.signal.aborted || error?.code === 'TASK_CANCELLED';
        if (cancelled) handle.cancelled();
        else handle.fail(error);
        if (preempted) throw error;
        if (!cancelled) throw error;
        return { task: tasks.has(handle.task.id) ? publicTask(tasks.get(handle.task.id)) : handle.snapshot(), cancelled: true };
      }
    });
    completionByTaskId.set(handle.task.id, completion);
    handle.publishInitial();
    completion.then(
      () => { if (completionByTaskId.get(handle.task.id) === completion) completionByTaskId.delete(handle.task.id); },
      () => { if (completionByTaskId.get(handle.task.id) === completion) completionByTaskId.delete(handle.task.id); },
    );
    // A start() caller may intentionally rely only on task deltas. Attach a
    // rejection observer so worker failures never become unhandled promises;
    // awaiting the original promise still preserves its rejection semantics.
    void completion.catch(() => undefined);
    return { task: tasks.has(handle.task.id) ? publicTask(tasks.get(handle.task.id)) : handle.snapshot(), deduplicated: false, completion };
  };

  const run = (definition, worker, retryFactory = null) => start(definition, worker, retryFactory).completion;

  const cancel = id => {
    const task = tasks.get(id);
    if (!task || TERMINAL_STATES.has(task.state) || !task.cancellable) return false;
    task.controller.abort();
    task.pauseRequested = false;
    for (const resolve of task.pauseWaiters) resolve();
    task.pauseWaiters.clear();
    update(task, { message: '正在取消…', cancellable: false });
    return true;
  };

  const pause = id => {
    const task = tasks.get(id);
    if (!task || task.state !== 'running' || !task.capabilities?.pausable) return false;
    task.pauseRequested = true;
    update(task, { state: 'pausing', message: '正在暂停…' });
    return true;
  };

  const continuePaused = id => {
    const task = tasks.get(id);
    if (!task || !['pausing', 'paused'].includes(task.state) || !task.capabilities?.pausable) return false;
    task.pauseRequested = false;
    const hadWaiters = task.pauseWaiters.size > 0;
    update(task, { state: hadWaiters ? 'resuming' : 'running', message: hadWaiters ? '正在继续任务…' : '任务已继续' });
    for (const resolve of task.pauseWaiters) resolve();
    task.pauseWaiters.clear();
    return true;
  };

  const retryError = (code, message) => Object.assign(new Error(message), { code });
  const retry = id => {
    const factory = retryFactories.get(id);
    const task = tasks.get(id);
    if (!task || task.state !== 'failed') throw retryError('INVALID_STATE', '该任务当前不能重试');
    if (task.retryPending) {
      const replacement = tasks.get(task.replacedByTaskId);
      if (replacement && ACTIVE_STATES.has(replacement.state)) return {
        accepted: true,
        sourceTaskId: task.id,
        replacementTaskId: replacement.id,
        deduplicated: true,
        task: publicTask(replacement),
        completion: completionByTaskId.get(replacement.id) || Promise.resolve({ task: publicTask(replacement), deduplicated: true }),
      };
      throw retryError('RETRY_ALREADY_ACTIVE', '该任务的重试状态正在结算');
    }
    if (!factory) throw retryError('NOT_RETRYABLE', '该任务不支持重试');
    const pendingStart = retryStarts.get(id);
    if (pendingStart) return pendingStart.then(result => ({ ...result, deduplicated: true }));

    let resolveStart;
    let rejectStart;
    const started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    void started.catch(() => undefined);
    const replacementContext = {
      kind: 'retry',
      task,
      sourceInstanceId: task.instanceId,
      replacement: null,
      conflict: null,
      deduplicated: false,
      claimed: false,
      closed: false,
      resolveStart,
      rejectStart,
    };
    const begin = (async () => {
      let execution;
      try {
        execution = retryContext.run(replacementContext, () => factory(publicTask(task)));
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!normalized.code) normalized.code = 'FACTORY_FAILED';
        replacementContext.closed = true;
        rejectStart(normalized);
        throw normalized;
      }
      const completion = execution?.completion ? execution.completion : Promise.resolve(execution);
      void completion.then(
        () => {
          if (replacementContext.claimed || replacementContext.closed) return;
          replacementContext.closed = true;
          rejectStart(retryError('FACTORY_DID_NOT_START', '重试工厂未创建替代任务'));
        },
        error => {
          if (replacementContext.claimed || replacementContext.closed) return;
          replacementContext.closed = true;
          const normalized = error instanceof Error ? error : new Error(String(error));
          if (!normalized.code) normalized.code = 'FACTORY_FAILED';
          rejectStart(normalized);
        },
      );
      const replacement = await started;
      return {
        accepted: true,
        sourceTaskId: task.id,
        replacementTaskId: replacement.id,
        deduplicated: Boolean(replacementContext.deduplicated),
        task: publicTask(replacement),
        completion,
      };
    })();
    retryStarts.set(id, begin);
    begin.then(
      () => { if (retryStarts.get(id) === begin) retryStarts.delete(id); },
      () => { if (retryStarts.get(id) === begin) retryStarts.delete(id); },
    );
    return begin;
  };

  const resume = async id => {
    const factory = resumeFactories.get(id);
    const task = tasks.get(id);
    if (!factory || !task || task.state !== 'interrupted') throw new Error('该任务当前不能继续');
    tasks.delete(id);
    resumeFactories.delete(id);
    resumeFactoryOwners.delete(id);
    let resolveStart;
    let rejectStart;
    const started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    void started.catch(() => undefined);
    const replacementContext = { kind: 'resume', task, sourceInstanceId: task.instanceId, sourceRemoved: true, claimed: false, closed: false, resolveStart, rejectStart };
    try {
      const execution = retryContext.run(replacementContext, () => factory(publicTask(task)));
      const result = await execution;
      if (replacementContext.claimed) await started;
      else emitDelta([], [id]);
      schedulePersistence();
      return result;
    } catch (error) {
      if (replacementContext.claimed) throw error;
      tasks.set(id, task);
      update(task, { state: 'failed', error: error?.message || String(error), message: error?.message || String(error), finishedAt: now(), resumeAvailable: false });
      throw error;
    }
  };

  const registerTypeResumeFactory = (type, factory, options = {}) => {
    const normalizedType = String(type || '');
    if (!normalizedType || typeof factory !== 'function') return () => undefined;
    const registration = {};
    typeResumeFactories.set(normalizedType, factory);
    typeResumeRegistrations.set(normalizedType, registration);
    for (const task of tasks.values()) {
      if (task.type !== normalizedType || task.state !== 'interrupted') continue;
      if (typeof options.canResume === 'function' && !options.canResume(publicTask(task))) continue;
      if (task.checkpoint !== undefined && Math.max(1, Number(task.checkpointVersion) || 1) !== 1) {
        update(task, {
          resumable: false,
          resumeAvailable: false,
          capabilities: { ...task.capabilities, resumable: false },
          message: '保存的任务断点版本与当前软件不兼容，请重新执行任务',
        });
        continue;
      }
      resumeFactories.set(task.id, () => factory(publicTask(task)));
      resumeFactoryOwners.set(task.id, registration);
      update(task, {
        resumable: true,
        resumeAvailable: true,
        capabilities: { ...task.capabilities, resumable: true },
      });
    }
    return () => {
      if (typeResumeRegistrations.get(normalizedType) !== registration) return;
      typeResumeFactories.delete(normalizedType);
      typeResumeRegistrations.delete(normalizedType);
      for (const task of tasks.values()) {
        if (task.type !== normalizedType || task.state !== 'interrupted') continue;
        if (resumeFactoryOwners.get(task.id) === registration) {
          resumeFactories.delete(task.id);
          resumeFactoryOwners.delete(task.id);
        }
        update(task, { resumeAvailable: false });
      }
    };
  };

  const restart = async id => {
    const factory = restartFactories.get(id);
    const task = tasks.get(id);
    if (!factory || !task || task.state !== 'interrupted' || task.resumePolicy !== 'safe-restart') throw new Error('该任务当前不能重新执行');
    tasks.delete(id);
    restartFactories.delete(id);
    restartFactoryOwners.delete(id);
    let resolveStart;
    let rejectStart;
    const started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    void started.catch(() => undefined);
    const replacementContext = { kind: 'restart', task, sourceInstanceId: task.instanceId, sourceRemoved: true, claimed: false, closed: false, resolveStart, rejectStart };
    try {
      const execution = retryContext.run(replacementContext, () => factory(publicTask(task)));
      const result = await execution;
      if (replacementContext.claimed) await started;
      else emitDelta([], [id]);
      schedulePersistence();
      return result;
    } catch (error) {
      if (replacementContext.claimed) throw error;
      tasks.set(id, task);
      const typeFactory = typeRestartFactories.get(task.type);
      const typeRegistration = typeRestartRegistrations.get(task.type);
      if (typeFactory) {
        retryFactories.set(id, () => typeFactory(publicTask(task)));
        retryFactoryOwners.set(id, typeRegistration);
      }
      update(task, {
        state: 'failed', error: error?.message || String(error), message: error?.message || String(error), finishedAt: now(),
        restartAvailable: false, retryable: Boolean(typeFactory), capabilities: { ...task.capabilities, retryable: Boolean(typeFactory) },
      });
      throw error;
    }
  };

  const registerTypeRestartFactory = (type, factory, options = {}) => {
    const normalizedType = String(type || '');
    if (!normalizedType || typeof factory !== 'function') return () => undefined;
    const registration = {};
    const previousRegistration = typeRestartRegistrations.get(normalizedType);
    for (const timer of autoRestartTimers.get(previousRegistration) || []) clearTimeout(timer);
    autoRestartTimers.delete(previousRegistration);
    typeRestartFactories.set(normalizedType, factory);
    typeRestartRegistrations.set(normalizedType, registration);
    const autoRestartIds = [];
    for (const task of tasks.values()) {
      if (task.type === normalizedType && task.state === 'failed' && !task.retryPending
          && (typeof options.canRestart !== 'function' || options.canRestart(publicTask(task)))) {
        retryFactories.set(task.id, () => factory(publicTask(task)));
        retryFactoryOwners.set(task.id, registration);
        update(task, { retryable: true, capabilities: { ...task.capabilities, retryable: true } });
        continue;
      }
      if (task.type !== normalizedType || task.state !== 'interrupted' || task.resumePolicy !== 'safe-restart') continue;
      if (typeof options.canRestart === 'function' && !options.canRestart(publicTask(task))) continue;
      restartFactories.set(task.id, () => factory(publicTask(task)));
      restartFactoryOwners.set(task.id, registration);
      update(task, { restartAvailable: true });
      if (options.autoRestart === true) autoRestartIds.push(task.id);
    }
    const autoRestartDelayMs = Math.max(0, Number(options.autoRestartDelayMs) || 0);
    const ownedTimers = new Set();
    autoRestartTimers.set(registration, ownedTimers);
    for (const id of autoRestartIds) {
      const timer = setTimeout(() => {
        ownedTimers.delete(timer);
        void restart(id).catch(() => undefined);
      }, autoRestartDelayMs);
      timer.unref?.();
      ownedTimers.add(timer);
    }
    return () => {
      if (typeRestartRegistrations.get(normalizedType) !== registration) return;
      for (const timer of autoRestartTimers.get(registration) || []) clearTimeout(timer);
      autoRestartTimers.delete(registration);
      typeRestartFactories.delete(normalizedType);
      typeRestartRegistrations.delete(normalizedType);
      for (const task of tasks.values()) {
        if (task.type !== normalizedType) continue;
        if (task.state === 'interrupted') {
          if (restartFactoryOwners.get(task.id) !== registration) continue;
          restartFactories.delete(task.id);
          restartFactoryOwners.delete(task.id);
          update(task, { restartAvailable: false });
        } else if (task.state === 'failed') {
          if (retryFactoryOwners.get(task.id) !== registration) continue;
          retryFactories.delete(task.id);
          retryFactoryOwners.delete(task.id);
          update(task, { retryable: false, capabilities: { ...task.capabilities, retryable: false } });
        }
      }
    };
  };

  const dismiss = id => {
    const task = tasks.get(id);
    if (!task || !DISMISSIBLE_STATES.has(task.state) || task.retryPending) return false;
    return removeTask(id);
  };

  const upsertExternal = definition => {
    if (stopping || quiescing) return null;
    const id = String(definition?.id || '');
    if (!id || !definition?.type) return null;
    const externalMetadata = controlledClone(definition.metadata || {});
    const requestedState = ['running', 'completed', 'failed', 'cancelled'].includes(definition.state) ? definition.state : 'running';
    const existing = tasks.get(id);
    const startsNewRun = !existing || (TERMINAL_STATES.has(existing.state) && requestedState === 'running');
    if (startsNewRun) createHandle({
      id,
      type: definition.type,
      title: definition.title || definition.type,
      cancellable: definition.cancellable === true,
      resumePolicy: definition.resumePolicy || 'safe-restart',
      notificationPolicy: definition.notificationPolicy || 'progress-toast',
      historyPolicy: definition.historyPolicy,
      taskCenterPolicy: definition.taskCenterPolicy || 'always',
      metadata: externalMetadata,
    });
    const task = tasks.get(id);
    if (!task) return null;
    const progress = Math.max(0, Math.min(100, Number(definition.progress) || 0));
    const nextProgress = requestedState === 'running' && !startsNewRun ? Math.max(task.progress, progress) : progress;
    update(task, {
      state: requestedState,
      progress: requestedState === 'completed' ? 100 : nextProgress,
      message: definition.message || task.message,
      error: requestedState === 'failed' ? definition.error || definition.message || '任务失败' : '',
      metadata: { ...task.metadata, ...externalMetadata, source: 'external-progress-bridge' },
      startedAt: task.startedAt || now(),
      finishedAt: TERMINAL_STATES.has(requestedState) ? now() : 0,
    });
    return publicTask(task);
  };

  const restorePersistedTasks = () => {
    if (!persistencePath) return;
    const readPayload = candidatePath => {
      const stat = fs.statSync(candidatePath);
      if (stat.size > MAX_PERSISTENCE_BYTES) throw Object.assign(new Error('background task history file is too large'), { code: 'TASK_HISTORY_TOO_LARGE' });
      const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('background task history root must be an object');
      if (Number(parsed.version) > BACKGROUND_TASK_PERSISTENCE_VERSION) {
        throw Object.assign(new Error(`background task history version ${parsed.version} is newer than ${BACKGROUND_TASK_PERSISTENCE_VERSION}`), { code: 'TASK_HISTORY_FUTURE_VERSION' });
      }
      if (!Array.isArray(parsed.tasks) || parsed.tasks.length > MAX_PERSISTED_TASKS) {
        throw Object.assign(new Error('background task history task count exceeds safety limits'), { code: 'TASK_HISTORY_TOO_LARGE' });
      }
      controlledClone(parsed);
      return parsed;
    };
    let source;
    try {
      source = readPayload(persistencePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        try { source = readPayload(`${persistencePath}.tmp`); }
        catch (temporaryError) {
          if (temporaryError?.code !== 'ENOENT') {
            persistenceReadOnlyReason = temporaryError?.code || 'TASK_HISTORY_CORRUPT';
            safeEmit('background-task:persistence-error', { error: temporaryError?.message || String(temporaryError), path: `${persistencePath}.tmp`, readOnly: true, reason: persistenceReadOnlyReason });
          }
          return;
        }
      } else {
        persistenceReadOnlyReason = error?.code || 'TASK_HISTORY_CORRUPT';
        safeEmit('background-task:persistence-error', { error: error?.message || String(error), path: persistencePath, readOnly: true, reason: persistenceReadOnlyReason });
        if (error?.code === 'TASK_HISTORY_FUTURE_VERSION') return;
        try {
          source = readPayload(`${persistencePath}.tmp`);
          safeLog('warn', 'Recovered background task history from temporary file in read-only mode', { path: `${persistencePath}.tmp` });
        } catch (_) { return; }
      }
    }
    try {
      const payload = migrateBackgroundTaskPayload(source);
      const restored = payload.tasks;
      for (const value of restored) {
        if (!value?.id || !value?.type) continue;
        const policy = resolveBackgroundTaskPolicy(value);
        if ((value.historyPolicy || policy.historyPolicy) === 'ephemeral') continue;
        const wasActive = ACTIVE_STATES.has(value.state) || value.state === 'interrupted';
        const capabilities = projectBackgroundTaskCapabilities(policy, {
          cancellable: false,
          pausable: value.capabilities?.pausable ?? policy.pausable,
          resumable: false,
          retryable: false,
        });
        const state = wasActive ? 'interrupted' : value.state;
        const message = wasActive
          ? capabilities.resumable ? '任务在上次退出时中断，可从已保存进度继续' : value.resumePolicy === 'safe-restart' ? '任务在上次退出时中断，可安全重新执行' : '任务在上次退出时中断'
          : value.message;
        tasks.set(String(value.id), {
          ...value,
          state,
          message,
          cancellable: false,
          retryable: false,
          resumable: capabilities.resumable,
          resumeAvailable: false,
          restartAvailable: false,
          capabilities,
          resumePolicy: policy.resumePolicy,
          notificationPolicy: policy.notificationPolicy,
          historyPolicy: value.historyPolicy || policy.historyPolicy,
          taskCenterPolicy: policy.taskCenterPolicy,
          retryOfTaskId: value.retryOfTaskId || null,
          replacedByTaskId: value.replacedByTaskId || null,
          retryAttempt: Math.max(0, Number(value.retryAttempt) || 0),
          retryPending: Boolean(value.retryPending),
          controller: new AbortController(),
          pauseRequested: false,
          pauseWaiters: new Set(),
          updatedAt: wasActive ? now() : value.updatedAt,
        });
      }
      for (const replacement of [...tasks.values()]) {
        if (replacement.state !== 'interrupted' || !replacement.retryOfTaskId) continue;
        const previous = tasks.get(replacement.retryOfTaskId);
        deleteTaskInternal(replacement.id);
        if (previous?.state === 'failed') {
          Object.assign(previous, {
            replacedByTaskId: null,
            retryPending: false,
            retryable: false,
            capabilities: { ...previous.capabilities, retryable: false },
          });
        }
      }
      for (const previous of tasks.values()) {
        if (previous.state !== 'failed' || !previous.retryPending) continue;
        const replacement = tasks.get(previous.replacedByTaskId);
        if (replacement?.retryOfTaskId === previous.id) continue;
        Object.assign(previous, {
          replacedByTaskId: null,
          retryPending: false,
          retryable: false,
          capabilities: { ...previous.capabilities, retryable: false },
        });
      }
      const history = [...tasks.values()]
        .filter(task => HISTORY_STATES.has(task.state) && !task.retryPending)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      for (const task of history.slice(maxHistory)) deleteTaskInternal(task.id);
    } catch (error) {
      persistenceReadOnlyReason = persistenceReadOnlyReason || 'TASK_HISTORY_CORRUPT';
      tasks.clear();
      safeEmit('background-task:persistence-error', { error: error?.message || String(error), path: persistencePath, readOnly: true, reason: persistenceReadOnlyReason });
    }
  };

  restorePersistedTasks();

  return {
    beginShutdown: () => {
      if (quiescing) return;
      quiescing = true;
      if (persistenceTimer) clearTimeout(persistenceTimer);
      persistenceTimer = null;
      for (const timers of autoRestartTimers.values()) for (const timer of timers) clearTimeout(timer);
      autoRestartTimers.clear();
      for (const task of tasks.values()) {
        if (TERMINAL_STATES.has(task.state) || task.state === 'interrupted') continue;
        if (task.cancellable || !isShutdownRelevant(task)) {
          task.controller.abort();
          task.pauseRequested = false;
          for (const resolve of task.pauseWaiters) resolve();
          task.pauseWaiters.clear();
        }
      }
    },
    waitForShutdown: ({ timeoutMs = 5000 } = {}) => new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        if ([...tasks.values()].some(isShutdownRelevant)) return;
        clearTimeout(timer); shutdownWaiters.delete(check); resolve();
      };
      shutdownWaiters.add(check);
      timer = setTimeout(() => { shutdownWaiters.delete(check); reject(Object.assign(new Error('仍有文件操作正在结束，请稍后重试退出。'), { code: 'APP_QUIT_BUSY' })); }, timeoutMs);
      check();
    }),
    isShuttingDown: () => quiescing || stopping,
    start,
    run,
    subscribe: listener => {
      const unsubscribe = eventBus.on('background-task:changed', listener);
      return typeof unsubscribe === 'function' ? unsubscribe : () => eventBus.removeListener('background-task:changed', listener);
    },
    create: createHandle,
    cancel,
    pause,
    continuePaused,
    retry,
    resume,
    registerTypeResumeFactory,
    restart,
    registerTypeRestartFactory,
    dismiss,
    upsertExternal,
    flush: flushPersistence,
    list: () => [...tasks.values()].map(publicTask).sort((left, right) => right.createdAt - left.createdAt),
    snapshot: () => ({ revision, tasks: [...tasks.values()].map(publicTask).sort((left, right) => right.createdAt - left.createdAt) }),
    get: id => tasks.has(id) ? publicTask(tasks.get(id)) : null,
    stop: () => {
      if (stopping) return;
      stopping = true;
      for (const timers of autoRestartTimers.values()) for (const timer of timers) clearTimeout(timer);
      autoRestartTimers.clear();
      for (const task of tasks.values()) if (!TERMINAL_STATES.has(task.state)) {
        task.controller.abort();
        for (const resolve of task.pauseWaiters) resolve();
        task.pauseWaiters.clear();
        Object.assign(task, {
          state: 'interrupted',
          message: task.resumePolicy === 'checkpoint' ? '任务在退出时中断，可从已保存进度继续'
            : task.resumePolicy === 'safe-restart' ? '任务在退出时中断，可安全重新执行' : '任务在退出时中断',
          cancellable: false,
          retryable: false,
          resumeAvailable: false,
          restartAvailable: false,
          capabilities: { ...task.capabilities, cancellable: false, retryable: false },
          updatedAt: now(),
        });
        releaseTaskResources(task.id);
      }
      if (persistenceTimer) clearTimeout(persistenceTimer);
      persistenceTimer = null;
      flushPersistence();
    },
  };
};

module.exports = { createBackgroundTaskService };
