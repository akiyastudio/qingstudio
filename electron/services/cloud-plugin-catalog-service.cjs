const { normalizeExternalUrl } = require('../security-policy.cjs');

const normalizeCatalogPlugin = value => {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value.id || '')
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120
    || typeof value.latestVersion !== 'string' || !/^\d+\.\d+\.\d+(?:\.[1-9]\d*)?$/.test(value.latestVersion)
    || !Array.isArray(value.capabilities) || value.capabilities.length > 32
    || value.capabilities.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(item))
    || !Array.isArray(value.formats) || value.formats.length > 100
    || value.formats.some(item => typeof item !== 'string' || !/^\.?[a-z0-9]{1,16}$/i.test(item))) return null;
  const homepage = normalizeExternalUrl(value.homepage);
  if (!homepage || !homepage.startsWith('https:')) return null;
  return {
    id: value.id, name: value.name.trim(), homepage, latestVersion: value.latestVersion,
    capabilities: [...new Set(value.capabilities)],
    formats: [...new Set(value.formats.map(item => `.${item.replace(/^\./, '').toLowerCase()}`))],
    // Absent or non-boolean flags never opt users into a download prompt.
    previewPromptEnabled: value.previewPromptEnabled === true,
  };
};

const createCloudPluginCatalogService = ({ apiBaseUrl, fetchImpl = globalThis.fetch, now = Date.now, cacheMs = 60_000 }) => {
  let cached = null; let expiresAt = 0; let pending = null;
  const list = () => {
    if (cached && now() < expiresAt) return Promise.resolve(cached);
    if (pending) return pending;
    pending = (async () => {
      try {
        const base = new URL(apiBaseUrl);
        if (base.protocol !== 'https:') throw new Error('Plugin catalog requires HTTPS');
        const response = await fetchImpl(`${base.href.replace(/\/+$/, '')}/v1/plugins`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
        if (!response.ok) throw new Error(`Plugin catalog HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.plugins) || data.plugins.length > 500) throw new Error('Invalid plugin catalog');
        const ids = new Set();
        const plugins = data.plugins.map(normalizeCatalogPlugin).filter(plugin => {
          if (!plugin || ids.has(plugin.id)) return false;
          ids.add(plugin.id); return true;
        });
        cached = { success: true, plugins }; expiresAt = now() + cacheMs;
        return cached;
      } catch {
        // Do not retain obsolete prompts after a failed refresh or block local preview.
        cached = { success: false, plugins: [] }; expiresAt = now() + Math.min(cacheMs, 15_000);
        return cached;
      } finally { pending = null; }
    })();
    return pending;
  };
  return { list };
};

module.exports = { createCloudPluginCatalogService, normalizeCatalogPlugin };
