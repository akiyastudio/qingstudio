const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
const componentPanelCapability = (payload, context) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !['get', 'update'].includes(payload.action) || Object.keys(payload).some(key => !(payload.action === 'get' ? ['action'] : ['action', 'title', 'subtitle']).includes(key))) throw hostError(CODES.INVALID_REQUEST, 'Invalid panel metadata request');
  if (typeof context?.updatePanelInfo !== 'function') throw hostError(CODES.PERMISSION_DENIED, 'Panel metadata requires a bound folder panel');
  for (const key of ['title', 'subtitle']) if (payload[key] !== undefined && (typeof payload[key] !== 'string' || payload[key].length > (key === 'title' ? 160 : 240) || /[\x00-\x1f]/.test(payload[key]) || key === 'title' && !payload[key].trim())) throw hostError(CODES.INVALID_REQUEST, `Invalid panel ${key}`);
  return context.updatePanelInfo(payload.action === 'get' ? null : Object.fromEntries(['title', 'subtitle'].filter(key => payload[key] !== undefined).map(key => [key, payload[key]])));
};
module.exports = { componentPanelCapability };
