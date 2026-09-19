const { sendToApplicationRenderers } = require('../../services/application-windows.cjs');
const registerInspirationIpc = context => {
  const { Array, Error, Set, String, assertExistingInside, fileSystemService, fs, getProjectPath, ipcMain, mainWindow, path, pushUndoOperation, resolveProjectEntry, uniqueDestination, writeLog } = context;
  ipcMain.handle('workspace-add-inspiration-to-project', async (_event, inspirationRoot, targetWorkspacePath, targetStatus, targetProjectName, relativePaths) => {
    const createdTargets = [];
    try {
      const sourceRoot = path.resolve(getProjectPath(inspirationRoot, '未分类', '.__photoflow_inspiration__'));
      const targetRoot = path.resolve(getProjectPath(targetWorkspacePath, targetStatus, targetProjectName));
      const planningFolder = path.join(targetRoot, '策划');
      await fileSystemService.ensureDirectory(planningFolder);
      const requestedPaths = [...new Set((Array.isArray(relativePaths) ? relativePaths : []).map(value => String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean))];
      if (!requestedPaths.length) throw new Error('请先选择要汇聚的文件或文件夹');
      const reserved = new Set();
      let fileCount = 0;
      let shortcutCount = 0;
      for (const relativePath of requestedPaths) {
        const source = path.resolve(resolveProjectEntry(inspirationRoot, '未分类', '.__photoflow_inspiration__', relativePath));
        assertExistingInside(sourceRoot, source, '灵感素材');
        const stat = await fs.promises.stat(source);
        if (stat.isDirectory()) {
          const shortcutPath = uniqueDestination(planningFolder, `${path.basename(source)}.lnk`, reserved);
          const created = fileSystemService.createWindowsShortcut(shortcutPath, { target: source, cwd: source, description: `灵感库：${path.basename(source)}` });
          if (!created) throw new Error(`无法创建文件夹快捷方式：${path.basename(source)}`);
          createdTargets.push(shortcutPath);
          shortcutCount += 1;
          continue;
        }
        if (!stat.isFile()) throw new Error(`不支持的灵感素材：${path.basename(source)}`);
        const destination = uniqueDestination(planningFolder, path.basename(source), reserved);
        await fileSystemService.copy(source, destination);
        createdTargets.push(destination);
        fileCount += 1;
      }
      if (createdTargets.length) await pushUndoOperation({ kind: 'remove-created', paths: createdTargets, label: '灵感汇聚' });
      sendToApplicationRenderers(mainWindow, 'workspace-files-changed', { root: targetRoot, fileName: '策划', eventType: 'rename' });
      writeLog('info', 'Inspiration items added to project planning folder', { targetProjectName, fileCount, shortcutCount, planningFolder });
      return { success: true, count: createdTargets.length, fileCount, shortcutCount, planningFolder };
    } catch (error) {
      await fileSystemService.rollbackCreated(createdTargets);
      writeLog('error', 'Unable to add inspiration items to project', error);
      return { success: false, error: error.message || String(error) };
    }
  });
};

module.exports = { registerInspirationIpc };
