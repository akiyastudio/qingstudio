const { sendToApplicationRenderers } = require('../../services/application-windows.cjs');
const createCatalogMutationNotices = ({ refreshWorkspaceCatalog, reconcileWorkspaceCatalog, workspaceCatalogs, mainWindow, writeLog, Promise, String }) => {
  const refreshAfterRepositoryCommit = async root => {
    try { return { catalog: await refreshWorkspaceCatalog(root), catalogRefreshPending: false }; }
    catch (error) {
      writeLog('warn', 'Workspace mutation committed but catalog refresh failed', { root, error: error.message || String(error) });
      if (typeof reconcileWorkspaceCatalog === 'function') {
        setTimeout(() => Promise.resolve(reconcileWorkspaceCatalog(root)).catch(reconcileError => writeLog('warn', 'Deferred workspace catalog reconcile failed', reconcileError)), 0);
      }
      return { catalog: workspaceCatalogs.get(root), catalogRefreshPending: true, warning: '项目操作已完成，目录刷新将在后台重试' };
    }
  };
  const scheduleCatalogReconcile = root => {
    if (typeof reconcileWorkspaceCatalog !== 'function') return;
    setTimeout(() => Promise.resolve(reconcileWorkspaceCatalog(root)).catch(error => writeLog('warn', 'Deferred workspace catalog reconcile failed', error)), 0);
  };
  const notifyProjectsChanged = (root, reason) => {
    try { sendToApplicationRenderers(mainWindow, 'workspace-projects-changed', { root, reason }); }
    catch (error) { writeLog('warn', 'Unable to publish committed workspace project change', { root, reason, error: error.message || String(error) }); }
  };
  const probeProjectMutation = async (root, projectName, predicate) => {
    try {
      const catalog = await refreshWorkspaceCatalog(root);
      const row = catalog?.byName?.get(projectName.toLocaleLowerCase()) || catalog?.projects?.find(project => project.name?.toLocaleLowerCase() === projectName.toLocaleLowerCase());
      return { state: row && predicate(row) ? 'committed' : 'not-committed', catalog, row };
    } catch (error) {
      scheduleCatalogReconcile(root);
      return { state: 'unknown', error };
    }
  };
  return { refreshAfterRepositoryCommit, scheduleCatalogReconcile, notifyProjectsChanged, probeProjectMutation };
};
module.exports = { createCatalogMutationNotices };
