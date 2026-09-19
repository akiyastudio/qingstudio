const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');

const normalizeIdentity = value => String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLocaleLowerCase();

const createComponentContentBinding = ({ path, ensureWorkspace, readSavedConfig, getBoundProject, getProjectPath }) => {
  const inspirationBinding = () => {
    const config = readSavedConfig?.() || {};
    const configuredRoot = String(config.inspirationLibrary?.rootPath || '').trim();
    const configuredWorkspace = String(config.workspacePath || config.workspacePaths?.[0] || '').trim();
    if (!configuredRoot || !configuredWorkspace) throw hostError(CODES.NOT_FOUND, 'Inspiration library binding is unavailable');
    const workspaceRoot = ensureWorkspace(configuredWorkspace);
    const projectRoot = path.resolve(configuredRoot);
    return {
      contentKind: 'inspiration',
      workspaceRoot,
      projectRoot,
      project: { id: `inspiration:${configuredRoot}`, name: '.__photoflow_inspiration__', status: '未分类' },
    };
  };

  const resolveOpenRequest = request => {
    if (request?.contentKind !== 'inspiration') return { ...request, contentKind: 'project', contentRootPath: '' };
    const binding = inspirationBinding();
    return {
      ...request,
      contentKind: binding.contentKind,
      contentRootPath: binding.projectRoot,
      workspacePath: binding.workspaceRoot,
      projectId: binding.project.id,
      projectName: binding.project.name,
      projectStatus: binding.project.status,
    };
  };

  const resolve = context => {
    if (context?.contentKind === 'inspiration') {
      const binding = inspirationBinding();
      if (normalizeIdentity(context.workspacePath) !== normalizeIdentity(binding.workspaceRoot)
        || normalizeIdentity(context.contentRootPath) !== normalizeIdentity(binding.projectRoot)
        || String(context.projectId || '') !== binding.project.id) {
        throw hostError(CODES.PERMISSION_DENIED, 'Inspiration library binding changed or is invalid');
      }
      return binding;
    }
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const project = getBoundProject?.(workspaceRoot, context.projectName);
    if (!project || String(project.id || '') !== String(context.projectId || '')) throw hostError(CODES.NOT_FOUND, 'Bound project is unavailable');
    return {
      contentKind: 'project',
      workspaceRoot,
      project,
      projectRoot: path.resolve(getProjectPath(workspaceRoot, project.status || context.projectStatus, project.name || context.projectName)),
    };
  };

  return { resolveOpenRequest, resolve };
};

module.exports = { createComponentContentBinding };
