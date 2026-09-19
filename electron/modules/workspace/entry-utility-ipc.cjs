const registerEntryUtilityIpc = ({ ipcMain, findLatestPhotoshop, path, getProjectPath, resolveToolSource, fs, spawn, resolveProjectEntry, clipboard, mediaService, app }) => {
  ipcMain.handle('workspace-open-entry-photoshop', async (_event, workspacePath, status, projectName, relativePaths) => {
    try {
      const executable = await findLatestPhotoshop();
      if (!executable) throw new Error('未检测到 Photoshop');
      const paths = Array.isArray(relativePaths) ? relativePaths : [relativePaths];
      if (!paths.length) throw new Error('没有选择要打开的文件');
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const targets = paths.map(relativePath => resolveToolSource(root, relativePath).physicalPath);
      if (targets.some(target => !fs.statSync(target).isFile())) throw new Error('只能用 Photoshop 打开文件');
      return await new Promise(resolve => {
        const child = spawn(executable, targets, { detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', error => resolve({ success: false, error: error.message || String(error) }));
        child.once('spawn', () => { child.unref(); resolve({ success: true, count: targets.length }); });
      });
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('workspace-copy-entry-path', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      clipboard.writeText(resolveProjectEntry(workspacePath, status, projectName, relativePath));
      return { success: true };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('workspace-entry-file-icon', async (_event, filePath) => {
    try {
      const target = await mediaService.authorizeInput(filePath);
      if (!(await fs.promises.stat(target)).isFile()) throw new Error('文件不存在');
      const icon = await app.getFileIcon(target, { size: 'normal' });
      return { success: !icon.isEmpty(), dataUrl: icon.isEmpty() ? undefined : icon.toDataURL() };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
};

module.exports = { registerEntryUtilityIpc };
