import type { VersionTreeLayoutResult } from '../../types';

type CachedVersionTreeLayout = VersionTreeLayoutResult & { success: true; cachedAt: number };

const MAX_CACHED_LAYOUTS = 128;
const layouts = new Map<string, CachedVersionTreeLayout>();
const requests = new Map<string, Promise<VersionTreeLayoutResult>>();

const normalizedPart = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase('zh-CN');
const layoutKey = (workspacePath: string, projectName: string, scopeKey: string) => [workspacePath, projectName, scopeKey]
  .map(normalizedPart)
  .join('\0');

const trimCache = () => {
  while (layouts.size > MAX_CACHED_LAYOUTS) layouts.delete(layouts.keys().next().value!);
};

export const peekVersionTreeLayout = (workspacePath: string, projectName: string, scopeKey: string) =>
  layouts.get(layoutKey(workspacePath, projectName, scopeKey));

export const rememberVersionTreeLayout = (
  workspacePath: string,
  projectName: string,
  scopeKey: string,
  result: VersionTreeLayoutResult,
) => {
  if (!result.success) return;
  const key = layoutKey(workspacePath, projectName, scopeKey);
  layouts.delete(key);
  layouts.set(key, { ...result, success: true, cachedAt: Date.now() });
  trimCache();
};

export const loadVersionTreeLayout = (workspacePath: string, projectName: string, scopeKey: string, forceFresh = false) => {
  const key = layoutKey(workspacePath, projectName, scopeKey);
  const cached = layouts.get(key);
  if (cached && !forceFresh) return Promise.resolve<VersionTreeLayoutResult>(cached);
  const pending = requests.get(key);
  if (pending) return pending;
  const request = window.electronAPI.getVersionTreeLayout(workspacePath, projectName, scopeKey)
    .then(result => {
      rememberVersionTreeLayout(workspacePath, projectName, scopeKey, result);
      return result;
    })
    .finally(() => {
      if (requests.get(key) === request) requests.delete(key);
    });
  requests.set(key, request);
  return request;
};

export const prefetchVersionTreeLayout = (workspacePath: string, projectName: string, scopeKey = '') => {
  // Activation prefetch is cache-first. Explicit refresh still passes
  // forceFresh through loadVersionTreeLayout, while ordinary tab switches must
  // not enqueue a redundant database read ahead of the relationship snapshot.
  void loadVersionTreeLayout(workspacePath, projectName, scopeKey).catch(() => undefined);
};

export const clearVersionTreeLayoutCacheForTests = () => {
  layouts.clear();
  requests.clear();
};
