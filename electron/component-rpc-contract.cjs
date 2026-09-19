const MAX_COMPONENT_RPC_PAYLOAD_BYTES = 2 * 1024 * 1024;

const sanitizePayload = (payload, fields = null) => {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Component RPC payload must be an object');
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_COMPONENT_RPC_PAYLOAD_BYTES) throw new RangeError('Component RPC payload is too large');
  const cloned = JSON.parse(serialized);
  return Array.isArray(fields) ? Object.fromEntries(fields.filter(field => Object.hasOwn(cloned, field)).map(field => [field, cloned[field]])) : cloned;
};

const createComponentRpcIpcProxy = ({ ipcMain, manager, compatibilityRegistrars = [] }) => ({
  ...ipcMain,
  handle(channel, handler) {
    ipcMain.handle(channel, handler);
    for (const register of compatibilityRegistrars) register({ channel, handler, manager });
  },
  on: (...args) => ipcMain.on(...args),
  once: (...args) => ipcMain.once(...args),
  removeHandler: (...args) => ipcMain.removeHandler(...args),
});

module.exports = { MAX_COMPONENT_RPC_PAYLOAD_BYTES, createComponentRpcIpcProxy, sanitizePayload };
