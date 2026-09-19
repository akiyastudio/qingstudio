const cleanupImportArtifacts = async ({
  fs,
  targets = [],
  cleanupErrors = [],
  writeLog = () => undefined,
  logLabel = 'import',
  allowedRoots,
  ownedTargets,
}) => {
  const path = require('path');
  const comparable = value => {
    const resolved = path.resolve(String(value || '')).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  const roots = [...new Set((Array.isArray(allowedRoots) ? allowedRoots : []).filter(Boolean))];
  const ownership = new Set((Array.isArray(ownedTargets) ? ownedTargets : []).filter(Boolean).map(comparable));
  const authorize = async target => {
    if (!Array.isArray(allowedRoots) || !Array.isArray(ownedTargets)) throw new Error('缺少 allowedRoots/ownedTargets 清理授权，已拒绝删除');
    const resolved = path.resolve(target);
    if (!ownership.has(comparable(resolved))) throw new Error('拒绝清理非本次导入创建的目标');
    const matchingRoot = roots.find(root => {
      const relative = path.relative(path.resolve(root), resolved);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!matchingRoot) throw new Error('清理目标不在允许根目录内，或目标就是根目录本身');
    const realRoot = await fs.promises.realpath(matchingRoot);
    const parentReal = await fs.promises.realpath(path.dirname(resolved));
    const parentRelative = path.relative(realRoot, parentReal);
    if (parentRelative.startsWith('..') || path.isAbsolute(parentRelative)) throw new Error('清理目标父目录经 realpath 后逃逸允许根目录');
    const stat = await fs.promises.lstat(resolved).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat && !stat.isSymbolicLink()) {
      const realTarget = await fs.promises.realpath(resolved);
      const relative = path.relative(realRoot, realTarget);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('清理目标经 realpath 后逃逸允许根目录');
    }
  };
  for (const target of [...new Set(targets.filter(Boolean))]) {
    try {
      await authorize(target);
      await fs.promises.rm(target, { recursive: true, force: true });
      if (fs.existsSync(target)) throw new Error('清理后目标仍然存在');
    } catch (error) {
      cleanupErrors.push({ path: target, error: error.message || String(error) });
      writeLog('error', `Unable to remove failed ${logLabel} target`, { path: target, error: error.message || String(error) });
    }
  }
  const leftoverPaths = [...new Set(targets.filter(target => target && fs.existsSync(target)))];
  return {
    cleanupErrors,
    leftoverPaths,
  };
};

module.exports = { cleanupImportArtifacts };
