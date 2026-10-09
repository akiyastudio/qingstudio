const registerSelectionIpc = ({ ipcMain, path, fs, selectionService, workspaceCatalogs, getProjectPath }) => {
  const resolveRegisteredProject = requestedProjectPath => {
    const requested = path.resolve(String(requestedProjectPath || ''));
    for (const [workspaceRoot, catalog] of workspaceCatalogs) {
      for (const project of catalog.projects || []) {
        const registeredPath = path.resolve(workspaceRoot, project.relative_path);
        if (registeredPath.toLocaleLowerCase() !== requested.toLocaleLowerCase()) continue;
        // Use the same authorization as other project tools, including registered
        // references and archive links whose real directories are outside the workspace.
        const projectRoot = getProjectPath(workspaceRoot, project.status, project.name);
        if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new Error('项目文件夹不存在');
        return { workspaceRoot, projectName: project.name, projectRoot };
      }
    }
    throw new Error('项目未在当前工作区登记');
  };
  const requestFor = (projectPath, request) => ({ ...request, ...resolveRegisteredProject(projectPath) });
  const publishProgress = (event, progress) => {
    if (typeof event?.sender?.send !== 'function') return false;
    event.sender.send('workspace-selection-progress', progress);
    return true;
  };
  const handle = (method, options = {}) => async (event, projectPath, request = {}) => {
    let trustedRequest;
    let terminalOperationId = '';
    let taskNotificationOwned = false;
    try {
      trustedRequest = requestFor(projectPath, request);
      trustedRequest.onProgress = progress => publishProgress(event, progress);
      const result = await selectionService[method](trustedRequest);
      if (options.publishTerminal) {
        const operationId = String(result?.operationId || trustedRequest.operationId || '');
        if (operationId) {
          const phase = result?.cancelled ? 'cancelled' : result?.success === false ? 'failed' : 'complete';
          const message = phase === 'complete' ? '选片文件处理完成' : phase === 'cancelled' ? '选片文件处理已取消' : result?.error || '选片文件处理失败';
          if (publishProgress(event, { operationId, phase, progress: phase === 'complete' ? 100 : 0, message, ...(phase === 'failed' ? { error: message } : {}) })) {
            terminalOperationId = operationId;
            taskNotificationOwned = true;
          }
        }
      }
      return options.publishTerminal
        ? { ...result, ...(terminalOperationId ? { operationId: terminalOperationId } : {}), ...(taskNotificationOwned ? { taskNotificationOwned: true } : {}) }
        : result;
    } catch (error) {
      if (options.publishTerminal) {
        const operationId = String(trustedRequest?.operationId || request?.operationId || '');
        if (operationId) {
          const message = error.message || String(error);
          if (publishProgress(event, { operationId, phase: 'failed', progress: 0, message, error: message })) {
            terminalOperationId = operationId;
            taskNotificationOwned = true;
          }
        }
      }
      return { success: false, error: error.message || String(error), ...(terminalOperationId ? { operationId: terminalOperationId } : {}), ...(taskNotificationOwned ? { taskNotificationOwned: true } : {}) };
    }
  };

  ipcMain.handle('workspace-selection-filename-preflight', handle('preflightFilename'));
  ipcMain.handle('workspace-selection-source-folders', handle('listSourceFolders'));
  ipcMain.handle('workspace-selection-filename-execute', handle('executeFilename', { publishTerminal: true }));
  ipcMain.handle('workspace-selection-manual-preflight', handle('preflightManual'));
  ipcMain.handle('workspace-selection-manual-execute', handle('executeManual', { publishTerminal: true }));
  ipcMain.handle('workspace-selection-cancel', async (_event, operationId) => ({
    success: selectionService.cancel(String(operationId || '')),
  }));
};

module.exports = { registerSelectionIpc };
