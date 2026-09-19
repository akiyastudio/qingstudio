const createServiceHostClient = ({ writeFrame }) => {
  if (typeof writeFrame !== 'function') throw new TypeError('writeFrame is required');
  const pending = new Map();
  let nextId = 1;
  const callHost = (parentId, method, payload = {}) => new Promise((resolve, reject) => {
    const id = `host-${nextId++}`;
    pending.set(id, { resolve, reject });
    writeFrame({ type: 'capability', id, parentId: String(parentId), method: String(method), payload });
  });
  const acceptFrame = frame => {
    if (frame?.type !== 'capability-response') return false;
    const request = pending.get(String(frame.id || ''));
    if (!request) return false;
    pending.delete(String(frame.id));
    if (frame.ok === false) {
      const error = new Error(String(frame.error || 'Host capability failed'));
      error.code = String(frame.errorCode || 'COMPONENT_HOST_INTERNAL');
      error.retryable = frame.retryable === true;
      request.reject(error);
    } else request.resolve(frame.result);
    return true;
  };
  const failAll = error => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  return Object.freeze({ callHost, acceptFrame, failAll });
};
module.exports = { createServiceHostClient };
