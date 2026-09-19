const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const LEGACY_COMPONENT_TEMP_CACHE_PATHS = Object.freeze({
  'video-tools': Object.freeze([Object.freeze(['photoflow', 'ffmpeg'])]),
});

const inside = (path, root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const componentTemporaryDataPaths = ({ path, tempRoot, componentId }) => {
  const id = componentId;
  if (typeof id !== 'string' || !COMPONENT_ID.test(id)) throw new Error('Invalid component temporary-data identifier');
  const requestedRoot = String(tempRoot || '').trim();
  if (!requestedRoot || !path.isAbsolute(requestedRoot)) throw new Error('Invalid component temporary-data root');
  const root = path.resolve(requestedRoot);
  const candidates = [
    path.join(root, 'photoflow', 'components', id),
    ...(LEGACY_COMPONENT_TEMP_CACHE_PATHS[id] || []).map(parts => path.join(root, ...parts)),
  ].map(candidate => path.resolve(candidate));
  if (candidates.some(candidate => !inside(path, root, candidate))) throw new Error('Component temporary-data path escapes the system temporary directory');
  return [...new Set(candidates)];
};

module.exports = { componentTemporaryDataPaths, LEGACY_COMPONENT_TEMP_CACHE_PATHS };
