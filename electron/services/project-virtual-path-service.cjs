const fs = require('fs');
const path = require('path');
const normalizeVirtualPath = value => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized ? normalized.split('/') : [];
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) throw new Error('项目路径无效');
  return { normalized, segments };
};
const isInsideOrEqual = (parent, candidate) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const createProjectVirtualPathService = () => {
  const resolve = (projectRoot, virtualPath = '', options = {}) => {
    const root = path.resolve(projectRoot);
    const { normalized, segments } = normalizeVirtualPath(virtualPath);
    const requested = path.resolve(root, ...segments);
    if (!isInsideOrEqual(root, requested)) throw new Error('项目路径超出项目目录');
    const realRoot = fs.realpathSync(root);
    let physicalPath = requested;
    if (fs.existsSync(requested)) {
      physicalPath = fs.realpathSync(requested);
      if (!isInsideOrEqual(realRoot, physicalPath)) throw new Error('项目路径通过重解析点跳出了项目目录');
    } else {
      if (options.mustExist !== false && !options.allowMissingLeaf) throw Object.assign(new Error('文件或文件夹不存在'), { code: 'ENOENT' });
      const parent = fs.realpathSync(path.dirname(requested));
      if (!isInsideOrEqual(realRoot, parent)) throw new Error('目标路径超出项目目录');
      physicalPath = path.join(parent, path.basename(requested));
    }
    return { projectRoot: root, virtualPath: normalized, physicalPath, mediaRoot: realRoot, writable: true };
  };
  const toVirtualPath = (projectRoot, physicalPath, hint) => {
    // Inspiration library shortcuts have their own explicit tool scope.
    if (hint?.viaInspirationShortcut && hint.externalTargetRoot && hint.shortcutVirtualPath) {
      if (!isInsideOrEqual(hint.externalTargetRoot, physicalPath)) throw new Error('工具输出超出灵感素材目录');
      return [hint.shortcutVirtualPath, path.relative(hint.externalTargetRoot, physicalPath).replace(/\\/g, '/')].filter(Boolean).join('/');
    }
    if (!isInsideOrEqual(projectRoot, physicalPath)) throw new Error('物理路径不属于项目');
    return path.relative(projectRoot, physicalPath).replace(/\\/g, '/');
  };
  return { resolve, toVirtualPath };
};
module.exports = { createProjectVirtualPathService, isInsideOrEqual, normalizeVirtualPath };
