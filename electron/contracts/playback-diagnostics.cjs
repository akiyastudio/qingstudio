const DIAGNOSTIC_FIELDS = new Set(['code', 'severity', 'phase', 'backendId', 'backendVersion', 'protocolVersion', 'exitCode', 'message', 'recoverable']);
const cleanPlaybackDiagnostics = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid playback diagnostic');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!DIAGNOSTIC_FIELDS.has(key)) throw new Error(`unsupported playback diagnostic field: ${key}`);
    if (key === 'recoverable') { if (typeof item !== 'boolean') throw new Error('invalid playback diagnostic recoverable'); result[key] = item; continue; }
    if (key === 'exitCode' || key === 'protocolVersion') { if (!Number.isFinite(Number(item))) throw new Error(`invalid playback diagnostic field: ${key}`); result[key] = Number(item); continue; }
    if (typeof item !== 'string') throw new Error(`invalid playback diagnostic field: ${key}`);
    result[key] = item.slice(0, key === 'message' ? 1000 : 160);
  }
  if (!result.code || !['debug', 'info', 'warning', 'error'].includes(result.severity)) throw new Error('invalid playback diagnostic identity');
  return Object.freeze(result);
};
module.exports = { DIAGNOSTIC_FIELDS, cleanPlaybackDiagnostics };
