const cancelledError = key => Object.assign(new Error(`Dirty runner cancelled: ${key}`), { code: 'DIRTY_RUNNER_CANCELLED' });

const createDirtyCoalescingRunner = ({
  merge,
  worker,
  hasWork = batch => Boolean(batch),
  delayMs = 0,
  retryDelays = [250, 1000, 3000],
  onError = () => undefined,
  completedStateTtlMs = 60 * 1000,
  maxRetainedStates = 256,
}) => {
  if (typeof merge !== 'function' || typeof worker !== 'function') throw new TypeError('dirty runner requires merge and worker');
  const states = new Map();
  let stopped = false;
  const ticketCompletions = new WeakMap();
  const retentionTtl = Number.isFinite(Number(completedStateTtlMs)) && Number(completedStateTtlMs) >= 0
    ? Math.min(24 * 60 * 60 * 1000, Number(completedStateTtlMs)) : 60 * 1000;
  const retainedStateLimit = Number.isInteger(Number(maxRetainedStates)) && Number(maxRetainedStates) > 0
    ? Math.min(4096, Number(maxRetainedStates)) : 256;

  const createState = key => ({
    key,
    pendingBatch: null,
    inFlightBatch: null,
    generation: 0,
    completedGeneration: 0,
    retryTimer: null,
    executionPromise: null,
    inFlightGeneration: 0,
    retryAttempt: 0,
    nextRetryDelay: null,
    waiters: [],
    cancelled: false,
    controller: new AbortController(),
    predecessor: null,
    flushRequested: false,
    ticketCompletions: [],
    cleanupTimer: null,
    completedAt: 0,
    lastResult: undefined,
  });

  const createTicketCompletion = generation => {
    let resolve;
    let reject;
    const record = { generation, settled: false };
    record.promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    record.resolve = value => { if (!record.settled) { record.settled = true; resolve(value); } };
    record.reject = error => { if (!record.settled) { record.settled = true; reject(error); } };
    void record.promise.catch(() => undefined);
    return record;
  };

  const settleCompleted = state => {
    const remaining = [];
    for (const waiter of state.waiters) {
      if (waiter.generation <= state.completedGeneration) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.resolve(state.lastResult);
      }
      else remaining.push(waiter);
    }
    state.waiters = remaining;
    for (const record of state.ticketCompletions) {
      if (record.generation <= state.completedGeneration) record.resolve(state.lastResult);
    }
    state.ticketCompletions = state.ticketCompletions.filter(record => !record.settled);
  };

  const rejectTicketCompletions = (state, error) => {
    for (const record of state.ticketCompletions) record.reject(error);
    state.ticketCompletions = [];
  };

  const rejectWaiters = (state, error) => {
    const waiters = state.waiters;
    state.waiters = [];
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.reject(error);
    }
    rejectTicketCompletions(state, error);
  };

  const retireState = state => {
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
    if (states.get(state.key) === state) states.delete(state.key);
  };

  const waitForTicketCompletion = (record, ticket) => {
    const signal = ticket?.signal;
    if (!signal) return record.promise;
    if (signal.aborted) return Promise.reject(cancelledError(ticket?.key));
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(cancelledError(ticket?.key));
      };
      signal.addEventListener('abort', abort, { once: true });
      record.promise.then(value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      }, error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
    });
  };

  const retainCompletedState = state => {
    if (state.cancelled || state.predecessor || state.executionPromise || state.retryTimer || hasWork(state.pendingBatch)) return;
    state.completedAt = Date.now();
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    state.cleanupTimer = setTimeout(() => retireState(state), retentionTtl);
    state.cleanupTimer.unref?.();
    const retained = [...states.values()]
      .filter(candidate => candidate.completedAt > 0 && !candidate.executionPromise && !candidate.predecessor && !candidate.retryTimer)
      .sort((left, right) => left.completedAt - right.completedAt);
    while (retained.length > retainedStateLimit) retireState(retained.shift());
  };

  const schedule = (state, waitMs) => {
    if (state.cancelled || state.executionPromise || state.retryTimer || state.predecessor || !hasWork(state.pendingBatch)) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      void execute(state);
    }, Math.max(0, Number(waitMs) || 0));
  };

  const execute = state => {
    if (state.cancelled || state.predecessor || state.executionPromise || !hasWork(state.pendingBatch)) return state.executionPromise;
    state.inFlightBatch = state.pendingBatch;
    state.inFlightGeneration = state.generation;
    state.pendingBatch = null;
    const batch = state.inFlightBatch;
    const generation = state.inFlightGeneration;
    state.flushRequested = false;
    const workerExecution = Promise.resolve().then(() => worker({ key: state.key, batch, generation, signal: state.controller.signal }));
    const execution = workerExecution.then(result => {
      if (state.cancelled || states.get(state.key) !== state) return;
      // Only success acknowledges the in-flight delta.
      state.inFlightBatch = null;
      state.completedGeneration = Math.max(state.completedGeneration, generation);
      state.retryAttempt = 0;
      state.lastResult = result;
      settleCompleted(state);
    }, error => {
      if (state.cancelled || states.get(state.key) !== state) return;
      // Merge failed work before changes that arrived during execution. The
      // merge contract must preserve dominant flags such as fullScan.
      try {
        state.pendingBatch = merge(state.inFlightBatch, state.pendingBatch);
      } catch (mergeError) {
        state.inFlightBatch = null;
        rejectWaiters(state, mergeError);
        state.cancelled = true;
        states.delete(state.key);
        return;
      }
      state.inFlightBatch = null;
      const retryIndex = state.retryAttempt;
      state.retryAttempt += 1;
      const willRetry = retryIndex < retryDelays.length;
      // onError is a detached observer. Its sync/async failures are owned, but
      // it can neither delay nor alter the worker retry/rejection transition.
      void Promise.resolve().then(() => onError(error, {
        key: state.key, batch: state.pendingBatch, generation, willRetry, retryAttempt: state.retryAttempt,
      })).catch(() => undefined);
      if (willRetry) state.nextRetryDelay = retryDelays[retryIndex];
      else rejectWaiters(state, error);
    });
    state.executionPromise = execution;
    void execution.finally(() => {
      if (state.executionPromise === execution) state.executionPromise = null;
      if (state.cancelled) {
        if (states.get(state.key) === state) states.delete(state.key);
        return;
      }
      if (states.get(state.key) !== state) return;
      if (state.nextRetryDelay != null) {
        const retryDelay = state.nextRetryDelay;
        state.nextRetryDelay = null;
        schedule(state, retryDelay);
        return;
      }
      if (hasWork(state.pendingBatch) && !state.retryTimer) {
        const retrying = state.retryAttempt > 0;
        if (!retrying) schedule(state, 0);
        return;
      }
      retainCompletedState(state);
    }).catch(error => {
      // Internal state transitions must always own their rejection.
      if (!state.cancelled && states.get(state.key) === state) {
        state.cancelled = true;
        rejectWaiters(state, error);
        states.delete(state.key);
      }
    });
    return execution;
  };

  const enqueue = (key, delta, options = {}) => {
    const normalizedKey = String(key || '');
    if (!normalizedKey) throw new TypeError('dirty runner key is required');
    if (stopped) throw Object.assign(new Error('dirty runner has stopped'), { code: 'DIRTY_RUNNER_STOPPED' });
    if (options.signal?.aborted) throw cancelledError(normalizedKey);
    let state = states.get(normalizedKey);
    if (!state || state.cancelled) {
      const predecessor = state?.executionPromise || state?.predecessor || null;
      state = createState(normalizedKey);
      if (predecessor) {
        state.predecessor = Promise.resolve(predecessor).catch(() => undefined).then(() => {
          state.predecessor = null;
          if (state.cancelled) {
            if (states.get(normalizedKey) === state) states.delete(normalizedKey);
            return;
          }
          if (states.get(normalizedKey) !== state) return;
          if (state.flushRequested) void execute(state);
          else schedule(state, delayMs);
        });
        void state.predecessor.catch(error => {
          if (states.get(normalizedKey) !== state) return;
          state.predecessor = null;
          state.cancelled = true;
          rejectWaiters(state, error);
          states.delete(normalizedKey);
        });
      }
      states.set(normalizedKey, state);
    }
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
    state.completedAt = 0;
    state.pendingBatch = merge(state.pendingBatch, delta);
    state.generation += 1;
    // New external work reopens an exhausted retry cycle.
    if (!state.executionPromise && !state.retryTimer && state.retryAttempt > retryDelays.length) state.retryAttempt = 0;
    schedule(state, delayMs);
    const ticket = Object.freeze({ key: normalizedKey, generation: state.generation, signal: options.signal || null });
    const completion = createTicketCompletion(state.generation);
    state.ticketCompletions.push(completion);
    ticketCompletions.set(ticket, completion);
    return ticket;
  };

  const flush = ticket => {
    const state = states.get(String(ticket?.key || ''));
    const generation = Number(ticket?.generation) || 0;
    const ticketCompletion = ticket && typeof ticket === 'object' ? ticketCompletions.get(ticket) : null;
    if (!state || state.cancelled) return ticketCompletion
      ? waitForTicketCompletion(ticketCompletion, ticket)
      : Promise.reject(cancelledError(ticket?.key));
    if (state.completedGeneration >= generation) return Promise.resolve(state.lastResult);
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryAttempt = 0;
    const promise = ticketCompletion ? waitForTicketCompletion(ticketCompletion, ticket) : new Promise((resolve, reject) => {
      const waiter = { generation, resolve, reject, signal: ticket?.signal, onAbort: null };
      waiter.onAbort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        reject(cancelledError(ticket?.key));
      };
      waiter.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      state.waiters.push(waiter);
    });
    if (state.predecessor) state.flushRequested = true;
    else if (!state.executionPromise) void execute(state);
    return promise;
  };

  const cancel = key => {
    const normalizedKey = String(key || '');
    const state = states.get(normalizedKey);
    if (!state) return false;
    state.cancelled = true;
    state.controller.abort();
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.pendingBatch = null;
    rejectWaiters(state, cancelledError(normalizedKey));
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
    if (!state.executionPromise && !state.predecessor) states.delete(normalizedKey);
    return true;
  };

  const stop = () => {
    stopped = true;
    for (const key of [...states.keys()]) cancel(key);
  };

  const pendingCount = () => [...states.values()].filter(state => (
    hasWork(state.pendingBatch) || state.inFlightBatch || state.executionPromise || state.predecessor || state.retryTimer
  )).length;

  const getState = key => {
    const state = states.get(String(key || ''));
    return state ? { ...state, waiters: state.waiters.length } : null;
  };

  return { enqueue, flush, cancel, stop, pendingCount, getState };
};

module.exports = { createDirtyCoalescingRunner };
