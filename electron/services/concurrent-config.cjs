const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Apply only fields edited since this renderer's last snapshot. An unchanged
// window must never restore old values over another window's saved settings.
const mergeConcurrentConfig = (base, requested, current, field = '') => {
  if (base === undefined && !field) return requested;
  if (equal(requested, base)) return current;
  if (equal(current, base) || equal(current, requested)) return requested;
  if (object(base) && object(requested) && object(current)) {
    const result = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(requested), ...Object.keys(current)])) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const value = !field && ['componentSettings', 'componentSettingsRevisions'].includes(key)
        ? requested[key] : mergeConcurrentConfig(base[key], requested[key], current[key], field ? `${field}.${key}` : key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  throw Object.assign(new Error('其他窗口刚修改了同一项设置，请检查后再保存。'), { code: 'CONFIG_CONCURRENT_EDIT', field });
};
module.exports = { mergeConcurrentConfig };
