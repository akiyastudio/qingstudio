const fs = require('fs');
const path = require('path');

const createWorkspaceService = ({ repository, reconcileRepository = repository, catalogs, assertInside, assertExistingInside, getConfiguredInspirationRoot = () => '' }) => {
  const initialCatalogLoads = new Map();
  const resolveRoot = workspacePath => {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) throw new Error('尚未选择工作目录');
    const requestedPath = path.resolve(workspacePath.trim());
    const isDriveRoot = requestedPath === path.parse(requestedPath).root;
    return isDriveRoot ? path.join(requestedPath, '照片流') : requestedPath;
  };

  const ensureRoot = workspacePath => {
    const root = resolveRoot(workspacePath);
    fs.mkdirSync(root, { recursive: true });
    return root;
  };

  const refreshCatalog = async root => {
    const response = await repository.load(root);
    const projects = Array.isArray(response.projects) ? response.projects : [];
    const catalog = { projects, byName: new Map(projects.map(project => [project.name.toLocaleLowerCase(), project])) };
    catalogs.set(root, catalog);
    return catalog;
  };

  const reconcileCatalog = async (root, options = {}) => {
    const response = await reconcileRepository.syncCatalog(root, options);
    const projects = Array.isArray(response.projects) ? response.projects : [];
    const catalog = { projects, byName: new Map(projects.map(project => [project.name.toLocaleLowerCase(), project])) };
    catalogs.set(root, catalog);
    return catalog;
  };

  const mutateCatalog = async (root, mutation, payload) => {
    const method = repository[mutation];
    if (typeof method !== 'function') throw new Error(`未知工作区变更：${mutation}`);
    await method(root, payload);
    return refreshCatalog(root);
  };

  const comparablePath = value => process.platform === 'win32' ? value.toLocaleLowerCase() : value;

  const resolveNewProjectPath = (workspacePath, projectName) => {
    const root = ensureRoot(workspacePath);
    const name = cleanProjectName(projectName);
    if (!name || name !== String(projectName || '').trim()) throw new Error('无效的项目名称');
    const projectPath = path.resolve(root, name);
    assertInside(root, projectPath, '项目路径');
    return projectPath;
  };

  const getProjectPath = (workspacePath, status, projectName) => {
    const validStatus = typeof status === 'string' && status === status.trim() && status.length > 0 && status.length <= 24 && ![...status].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!validStatus) throw new Error('无效的项目状态');
    if (projectName === '.__photoflow_inspiration__') {
      const inspirationRoot = path.resolve(String(workspacePath || '').trim());
      const configuredValue = String(getConfiguredInspirationRoot() || '').trim();
      if (!configuredValue) throw new Error('尚未配置灵感库文件夹');
      const configuredRoot = path.resolve(configuredValue);
      if (comparablePath(inspirationRoot) !== comparablePath(configuredRoot)) throw new Error('灵感库路径未获用户配置授权');
      if (!fs.existsSync(inspirationRoot)) throw new Error('灵感库文件夹不存在');
      assertExistingInside(path.dirname(inspirationRoot), inspirationRoot, '灵感库路径', true);
      if (comparablePath(fs.realpathSync(inspirationRoot)) !== comparablePath(fs.realpathSync(configuredRoot))) throw new Error('灵感库路径未获用户配置授权');
      return inspirationRoot;
    }
    const root = ensureRoot(workspacePath);
    const row = catalogs.get(root)?.byName.get(String(projectName).toLocaleLowerCase());
    if (!row) throw new Error('项目未在当前工作区注册');
    if (String(row.status || '') !== status) throw new Error('项目状态与目录记录不一致');
    const extra = JSON.parse(row.extra_json || '{}');
    if (extra.importMode === 'reference') {
      if (!path.isAbsolute(row.relative_path)) throw new Error('外部项目登记路径无效');
      const externalRoot = path.resolve(row.relative_path);
      if (!fs.existsSync(externalRoot) || !fs.statSync(externalRoot).isDirectory()) throw new Error('项目文件夹当前离线，请重新连接磁盘');
      if (comparablePath(fs.realpathSync(externalRoot)) !== comparablePath(externalRoot)) throw new Error('外部项目路径已改变，请重新添加项目');
      return externalRoot;
    }
    if (row?.availability === 'missing') throw new Error('项目文件夹当前不可用，请恢复文件夹或重新连接工作区');
    const relativePath = row?.relative_path || projectName;
    const projectPath = path.resolve(root, relativePath);
    assertInside(root, projectPath, '项目路径');
    let archivePath = '';
    try { archivePath = JSON.parse(row?.extra_json || '{}')?.archive?.path || ''; } catch { /* malformed optional metadata is ignored */ }
    if (fs.existsSync(projectPath) && archivePath) {
      const actualTarget = fs.realpathSync(projectPath);
      const recordedTarget = fs.realpathSync(path.resolve(archivePath));
      if (comparablePath(actualTarget) !== comparablePath(recordedTarget)) throw new Error('归档项目链接目标与目录记录不一致');
    } else if (fs.existsSync(projectPath)) {
      assertExistingInside(root, projectPath, '项目路径');
    }
    return projectPath;
  };

  const cleanProjectName = value => String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

  const getReadyProjectPath = async (workspacePath, status, projectName) => {
    if (projectName !== '.__photoflow_inspiration__') {
      const root = ensureRoot(workspacePath);
      if (!catalogs.has(root)) {
        if (!initialCatalogLoads.has(root)) {
          initialCatalogLoads.set(root, refreshCatalog(root).finally(() => initialCatalogLoads.delete(root)));
        }
        await initialCatalogLoads.get(root);
      }
    }
    return getProjectPath(workspacePath, status, projectName);
  };

  return { resolveRoot, ensureRoot, refreshCatalog, reconcileCatalog, mutateCatalog, getProjectPath, getReadyProjectPath, resolveNewProjectPath, cleanProjectName };
};

module.exports = { createWorkspaceService };
