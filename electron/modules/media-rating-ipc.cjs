const registerMediaRatingIpc = ({
  IMAGE_EXTENSIONS, RAW_EXTENSIONS, ensureWorkspace, getProjectPath, ipcMain,
  mediaRatingService, mediaService, path, refreshWorkspaceCatalog, workspaceCatalogs, writeLog,
}) => {
  const assertRateable = sourcePath => {
    const extension = path.extname(sourcePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension) && !RAW_EXTENSIONS.has(extension)) throw new Error('只有图片和 RAW 文件可以标星');
  };
  ipcMain.handle('workspace-media-rating-read', async (_event, filePath) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      assertRateable(sourcePath);
      return { success: true, rating: await mediaRatingService.read(sourcePath) };
    } catch (error) {
      return { success: false, rating: 0, error: error.message || String(error) };
    }
  });
  ipcMain.handle('workspace-media-rating-read-batch', async (_event, requestedEntries = []) => {
    const entries = Array.isArray(requestedEntries) ? requestedEntries.slice(0, 200) : [];
    if (!entries.length) return { success: true, results: [], checked: 0 };
    const results = new Array(entries.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(6, entries.length) }, async () => {
      while (cursor < entries.length) {
        const index = cursor++;
        const requested = entries[index] || {};
        const requestedPath = String(requested.path || '');
        const updatedAt = Number(requested.updatedAt) || 0;
        try {
          const sourcePath = await mediaService.authorizeInput(requestedPath);
          assertRateable(sourcePath);
          results[index] = { path: requestedPath, updatedAt, success: true, rating: await mediaRatingService.read(sourcePath, updatedAt) };
        } catch (error) {
          results[index] = { path: requestedPath, updatedAt, success: false, rating: 0, error: error.message || String(error) };
        }
      }
    });
    await Promise.all(workers);
    return { success: true, results, checked: results.length };
  });
  ipcMain.handle('workspace-media-rating-write', async (_event, workspacePath, filePath, rating) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const sourcePath = mediaService.authorizeWorkspaceInput
        ? await mediaService.authorizeWorkspaceInput(workspaceRoot, filePath)
        : await mediaService.authorizeInput(filePath);
      assertRateable(sourcePath);
      return { success: true, rating: await mediaRatingService.write(workspaceRoot, sourcePath, rating) };
    } catch (error) {
      writeLog('warn', 'Unable to write media rating metadata', { filePath, rating, error: error.message || String(error) });
      return { success: false, rating: 0, error: error.message || String(error) };
    }
  });
  ipcMain.handle('workspace-final-version-summary', async (_event, workspacePath, status, projectName) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      const summary = mediaRatingService.summarizeProject
        ? await mediaRatingService.summarizeProject(path.resolve(getProjectPath(workspacePath, status, projectName)), { workspaceRoot, projectName })
        : { count: (await mediaRatingService.listProject(path.resolve(getProjectPath(workspacePath, status, projectName)), { workspaceRoot, projectName })).length, skippedDirectories: 0 };
      return { success: true, count: summary.count, availableCount: summary.count, missingCount: 0 };
    } catch (error) {
      return { success: false, count: 0, availableCount: 0, missingCount: 0, error: error.message || String(error) };
    }
  });
  ipcMain.handle('workspace-final-version-browse', async (_event, workspacePath, status, projectName) => {
    try {
      const workspaceRoot = ensureWorkspace(workspacePath);
      if (!workspaceCatalogs.has(workspaceRoot)) await refreshWorkspaceCatalog(workspaceRoot);
      const entries = await mediaRatingService.listProject(path.resolve(getProjectPath(workspacePath, status, projectName)), { workspaceRoot, projectName });
      return { success: true, count: entries.length, availableCount: entries.length, missingCount: 0, entries };
    } catch (error) {
      return { success: false, count: 0, availableCount: 0, missingCount: 0, entries: [], error: error.message || String(error) };
    }
  });
};

module.exports = { registerMediaRatingIpc };
