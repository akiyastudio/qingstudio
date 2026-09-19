const admissionError = (code, message) => Object.assign(new Error(message), { code });

const createKeyedAdmissionQueue = () => {
  const states = new Map();
  let stopped = false;
  let tokenSequence = 0;

  const grant = (key, state, waiter = null) => {
    const token = { id: ++tokenSequence, key, released: false, legacyArmed: waiter === null };
    state.active = token;
    const releaseToken = () => release(token);
    const lease = Object.freeze({ key, token: token.id, release: releaseToken });
    if (waiter) {
      // A stale duplicate release(key) from the previous owner must not release
      // the newly promoted owner in the same turn.
      queueMicrotask(() => { if (state.active === token) token.legacyArmed = true; });
      waiter.resolve(lease);
    }
    return lease;
  };

  const acquire = (rawKey, options = {}) => {
    const key = String(rawKey || '');
    if (!key) return Promise.reject(admissionError('ADMISSION_KEY_REQUIRED', 'admission key is required'));
    if (stopped) return Promise.reject(admissionError('ADMISSION_QUEUE_STOPPED', 'admission queue is stopped'));
    if (options.signal?.aborted) return Promise.reject(admissionError('ADMISSION_CANCELLED', `admission cancelled: ${key}`));
    let state = states.get(key);
    if (!state) {
      state = { active: null, waiters: [] };
      states.set(key, state);
      return Promise.resolve(grant(key, state));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal: options.signal, onAbort: null };
      waiter.onAbort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        reject(admissionError('ADMISSION_CANCELLED', `admission cancelled: ${key}`));
      };
      options.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      state.waiters.push(waiter);
    });
  };

  const release = rawKey => {
    const token = rawKey && typeof rawKey === 'object' && Number.isFinite(rawKey.id) ? rawKey : null;
    const key = token ? token.key : String(rawKey || '');
    const state = states.get(key);
    if (!state) return false;
    const active = state.active;
    if (!active || active.released || (token ? active !== token : !active.legacyArmed)) return false;
    active.released = true;
    active.legacyArmed = false;
    while (state.waiters.length) {
      const waiter = state.waiters.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) continue;
      grant(key, state, waiter);
      return true;
    }
    state.active = null;
    states.delete(key);
    return true;
  };

  const stop = () => {
    stopped = true;
    for (const [key, state] of states) {
      const waiting = state.waiters.splice(0);
      for (const waiter of waiting) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.reject(admissionError('ADMISSION_QUEUE_STOPPED', `admission queue stopped: ${key}`));
      }
      if (!state.active) states.delete(key);
    }
  };

  const waitingCount = rawKey => states.get(String(rawKey || ''))?.waiters.length || 0;
  return { acquire, release, stop, waitingCount };
};

module.exports = { createKeyedAdmissionQueue };
