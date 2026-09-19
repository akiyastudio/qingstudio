const INSPIRATION_VIRTUAL_PROJECT_NAME = '.__photoflow_inspiration__';

const registerRecentProjectFileIpc = context => {
  const { Date, Error, HIDDEN_SYSTEM_ENTRY_NAMES, IMAGE_EXTENSIONS, Math, Number, Object, Promise, RAW_EXTENSIONS, Set, String, VIDEO_EXTENSIONS, assertExistingInside, assertInside, crypto, fs, getProjectPath, ipcMain, isInternalFileOperationEntry, mediaService, path, shell, shortcutSourceChannel, writeLog } = context;
  const recentFilesSessionExpiredCode = 'RECENT_FILES_SESSION_EXPIRED';
  const recentFileSessions = new Map();
  const recentCursorLocks = new Map();
  const acquireCursorLock = async (locks, cursor) => {
    if (!cursor) return () => undefined;
    const previous = recentCursorLocks.get(cursor);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    recentCursorLocks.set(cursor, gate);
    if (previous) await previous;
    return () => { release(); if (recentCursorLocks.get(cursor) === gate) recentCursorLocks.delete(cursor); };
  };
  const pruneRecentFileSessions = () => {
    const expiry = Date.now() - 10 * 60 * 1000;
    for (const [cursor, session] of recentFileSessions) {
      if (session.touchedAt < expiry) recentFileSessions.delete(cursor);
    }
  };
  ipcMain.handle('workspace-recent-files', async (_event, workspacePath, status, projectName, scopeRelativePath = '', requestedLimit = 120, requestedCursor = '') => {
    let releaseCursor = () => undefined;
    try {
      releaseCursor = await acquireCursorLock(recentCursorLocks, String(requestedCursor || ''));
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const requestedScope = assertInside(root, path.resolve(root, scopeRelativePath || '.'), '最近文件范围', true);
      const scope = assertExistingInside(root, requestedScope, '最近文件范围', true);
      const scopeStat = await fs.promises.stat(scope);
      if (!scopeStat.isDirectory()) throw new Error('最近文件范围不是文件夹');
      mediaService.grantRoot(root);
      const pageSize = Math.min(240, Math.max(1, Number(requestedLimit) || 120));
      pruneRecentFileSessions();
      let cursor = String(requestedCursor || '');
      let session = cursor ? recentFileSessions.get(cursor) : null;
      if (cursor && (!session || session.root !== root || session.scope !== scope)) {
        throw Object.assign(new Error('递归显示会话已失效，正在自动重新加载'), { code: recentFilesSessionExpiredCode });
      }
      if (!session) {
        while (recentFileSessions.size >= 16) {
          const oldest = [...recentFileSessions.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
          if (!oldest) break;
          recentFileSessions.delete(oldest[0]);
        }
        cursor = crypto.randomUUID();
        session = {
          root,
          scope,
          pending: [{ directory: scope, priority: Number.MAX_SAFE_INTEGER, offset: 0, virtualPath: path.relative(root, scope).replace(/\\/g, '/'), viaShortcut: false }],
          visitedDirectories: new Set([path.resolve(scope).toLowerCase()]),
          candidates: [],
          scannedDirectories: 0,
          inspectedEntries: 0,
          touchedAt: Date.now(),
        };
        recentFileSessions.set(cursor, session);
      }
      if (!session.visitedDirectories) {
        session.visitedDirectories = new Set([
          path.resolve(scope).toLowerCase(),
          ...session.pending.map(candidate => path.resolve(candidate.directory).toLowerCase()),
        ]);
      }
      session.touchedAt = Date.now();
      const maximumDirectoriesPerPage = 64;
      const maximumInspectedEntriesPerPage = 4000;
      let pageScannedDirectories = 0;
      let pageInspectedEntries = 0;
      while (session.pending.length && pageScannedDirectories < maximumDirectoriesPerPage && pageInspectedEntries < maximumInspectedEntriesPerPage) {
        if (session.cancelled) throw Object.assign(new Error('最近文件会话已取消'), { code: recentFilesSessionExpiredCode });
        session.pending.sort((left, right) => right.priority - left.priority);
        const current = session.pending.shift();
        let children;
        try {
          children = await fs.promises.readdir(current.directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a recent-files directory', { directory: current.directory, error: error.message || String(error) });
          continue;
        }
        pageScannedDirectories += 1;
        session.scannedDirectories += 1;
        const allVisibleChildren = children
          .filter(child => !child.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) && !isInternalFileOperationEntry(child.name));
        const startOffset = Math.max(0, Number(current.offset) || 0);
        const visibleChildren = allVisibleChildren.slice(startOffset, startOffset + Math.max(0, maximumInspectedEntriesPerPage - pageInspectedEntries));
        if (startOffset + visibleChildren.length < allVisibleChildren.length) {
          session.pending.push({ ...current, offset: startOffset + visibleChildren.length });
        }
        pageInspectedEntries += visibleChildren.length;
        session.inspectedEntries += visibleChildren.length;
        for (let offset = 0; offset < visibleChildren.length; offset += 64) {
          const batch = visibleChildren.slice(offset, offset + 64);
          const inspected = await Promise.all(batch.map(async child => {
            const childPath = path.join(current.directory, child.name);
            try {
              return { child, childPath, stat: await fs.promises.stat(childPath) };
            } catch (error) {
              writeLog('warn', 'Unable to inspect a recent-files entry', { path: childPath, error: error.message || String(error) });
              return null;
            }
          }));
          if (session.cancelled) throw Object.assign(new Error('最近文件会话已取消'), { code: recentFilesSessionExpiredCode });
          for (const item of inspected) {
            if (!item) continue;
            const virtualRelativePath = [current.virtualPath, item.child.name].filter(Boolean).join('/');
            if (item.stat.isDirectory()) {
              const directoryKey = path.resolve(item.childPath).toLowerCase();
              if (!session.visitedDirectories.has(directoryKey)) {
                session.visitedDirectories.add(directoryKey);
                session.pending.push({ directory: item.childPath, priority: item.stat.mtimeMs || item.stat.birthtimeMs || 0, offset: 0, virtualPath: virtualRelativePath, viaShortcut: current.viaShortcut });
              }
              continue;
            }
            if (!item.stat.isFile()) continue;
            let extension = path.extname(item.child.name).toLowerCase();
            let kind = extension === '.lnk' ? 'shortcut' : IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : RAW_EXTENSIONS.has(extension) ? 'raw' : 'file';
            const sourceChannel = extension === '.lnk' ? shortcutSourceChannel(item.childPath) : undefined;
            session.candidates.push({ name: item.child.name, path: item.childPath, relativePath: virtualRelativePath, kind, extension, size: item.stat.size, createdAt: item.stat.birthtimeMs || item.stat.ctimeMs || 0, updatedAt: item.stat.mtimeMs || 0, viaShortcut: Boolean(current.viaShortcut), ...(sourceChannel ? { sourceChannel } : {}) });
            if (extension === '.lnk' && process.platform === 'win32') {
              try {
                const details = shell.readShortcutLink(item.childPath);
                const target = details?.target ? path.resolve(String(details.target)) : '';
                if (!target) continue;
                const targetStat = await fs.promises.stat(target);
                const directoryKey = path.resolve(target).toLowerCase();
                if (!targetStat.isDirectory() || session.visitedDirectories.has(directoryKey)) continue;
                session.visitedDirectories.add(directoryKey);
                mediaService.grantRoot(target);
                session.pending.push({ directory: target, priority: targetStat.mtimeMs || targetStat.birthtimeMs || item.stat.mtimeMs || 0, offset: 0, virtualPath: virtualRelativePath, viaShortcut: true });
              } catch (error) {
                writeLog('warn', 'Unable to follow a recent-files folder shortcut', { shortcut: item.childPath, error: error.message || String(error) });
              }
            }
          }
        }
        if (session.candidates.length >= pageSize) {
          const recentThreshold = [...session.candidates].sort((left, right) => right.updatedAt - left.updatedAt)[pageSize - 1]?.updatedAt || 0;
          const newestPendingDirectory = session.pending.reduce((newest, candidate) => Math.max(newest, candidate.priority), 0);
          if (newestPendingDirectory <= recentThreshold) break;
        }
      }
      session.candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      const entries = session.candidates.splice(0, pageSize);
      const hasMore = session.pending.length > 0 || session.candidates.length > 0;
      if (!hasMore) recentFileSessions.delete(cursor);
      return {
        success: true,
        scope: path.relative(root, scope).replace(/\\/g, '/'),
        entries,
        cursor: hasMore ? cursor : undefined,
        hasMore,
        truncated: hasMore,
        scannedDirectories: session.scannedDirectories,
      };
    } catch (error) {
      writeLog('warn', 'Unable to list recent project files', { projectName, scopeRelativePath, error: error.message || String(error) });
      return {
        success: false,
        entries: [],
        error: error.message || String(error),
        errorCode: error?.code === recentFilesSessionExpiredCode ? recentFilesSessionExpiredCode : undefined,
      };
    } finally { releaseCursor(); }
  });

  ipcMain.handle('workspace-cancel-recent-files', async (_event, requestedCursor = '') => {
    pruneRecentFileSessions();
    const cursor = String(requestedCursor || '');
    const session = cursor ? recentFileSessions.get(cursor) : null;
    if (!session) return { success: false, errorCode: recentFilesSessionExpiredCode, error: '最近文件会话已失效' };
    session.cancelled = true;
    recentFileSessions.delete(cursor);
    return { success: true };
  });

  ipcMain.handle('workspace-folder-tree', async (_event, workspacePath, status, projectName) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const folders = [];
      const pending = [{ directory: root, boundary: await fs.promises.realpath(root), relativePath: '', depth: 0 }];
      const maximumFolders = 20000;
      const maximumDepth = 64;
      const visited = new Set();
      let folderLimitReached = false;
      let skippedCount = 0;

      while (pending.length) {
        const current = pending.pop();
        if (current.depth > maximumDepth) { skippedCount += 1; continue; }
        const directoryReal = await fs.promises.realpath(current.directory).catch(() => '');
        const containment = directoryReal ? path.relative(current.boundary, directoryReal) : '..';
        const directoryStat = await fs.promises.lstat(current.directory, { bigint: true }).catch(() => null);
        if (!directoryReal || containment.startsWith('..') || path.isAbsolute(containment) || !directoryStat || directoryStat.isSymbolicLink()) { skippedCount += 1; continue; }
        const identity = `${directoryStat.dev}:${directoryStat.ino}`;
        if (visited.has(identity)) { skippedCount += 1; continue; }
        visited.add(identity);
        let children;
        try {
          children = await fs.promises.readdir(current.directory, { withFileTypes: true });
        } catch (error) {
          writeLog('warn', 'Unable to read a folder-tree directory', { directory: current.directory, error: error.message || String(error) });
          continue;
        }
        const candidateDirectories = children
          .filter(child => child.isDirectory() && !child.isSymbolicLink() && !HIDDEN_SYSTEM_ENTRY_NAMES.has(child.name.toLowerCase()) && !isInternalFileOperationEntry(child.name))
          .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        const directories = [];
        for (const child of candidateDirectories) {
          const childStat = await fs.promises.lstat(path.join(current.directory, child.name)).catch(() => null);
          if (childStat?.isDirectory() && !childStat.isSymbolicLink()) directories.push(child);
          else skippedCount += 1;
        }
        for (const child of directories) {
          if (folders.length >= maximumFolders) { folderLimitReached = true; break; }
          const relativePath = [current.relativePath, child.name].filter(Boolean).join('/');
          folders.push({ name: child.name, relativePath, parentRelativePath: current.relativePath, depth: current.depth });
        }
        if (folderLimitReached) break;
        for (let index = directories.length - 1; index >= 0; index -= 1) {
          const child = directories[index];
          const childPath = path.join(current.directory, child.name);
          pending.push({ directory: childPath, boundary: current.boundary, relativePath: [current.relativePath, child.name].filter(Boolean).join('/'), depth: current.depth + 1 });
        }
      }
      folders.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      return { success: true, folders, truncated: folderLimitReached, skippedCount };
    } catch (error) {
      return { success: false, folders: [], error: error.message || String(error) };
    }
  });
};

const registerEntryDetailsIpc = context => {
  const { Set, String, assertExistingInside, assertInside, fs, getProjectPath, ipcMain, path } = context;
  ipcMain.handle('workspace-entry-details', async (_event, workspacePath, status, projectName, relativePath) => {
    try {
      const root = path.resolve(getProjectPath(workspacePath, status, projectName));
      const target = assertExistingInside(root, assertInside(root, path.resolve(root, relativePath), '文件路径', true), '文件路径', true);
      const stat = await fs.promises.stat(target);
      let size = stat.isFile() ? stat.size : 0;
      let fileCount = stat.isFile() ? 1 : 0;
      let folderCount = 0;
      let truncated = false;
      let skippedCount = 0;
      if (stat.isDirectory()) {
        const boundaryReal = await fs.promises.realpath(target);
        const pending = [{ directory: target, depth: 0 }];
        const visited = new Set();
        const maximumDepth = 64;
        const maximumEntries = 100000;
        while (pending.length) {
          const current = pending.pop();
          if (current.depth > maximumDepth || fileCount + folderCount >= maximumEntries) { truncated = true; skippedCount += 1; continue; }
          const directoryReal = await fs.promises.realpath(current.directory);
          const containment = path.relative(boundaryReal, directoryReal);
          if (containment.startsWith('..') || path.isAbsolute(containment)) { skippedCount += 1; continue; }
          const directoryStat = await fs.promises.lstat(current.directory, { bigint: true });
          const identity = `${directoryStat.dev}:${directoryStat.ino}`;
          if (visited.has(identity)) { skippedCount += 1; continue; }
          visited.add(identity);
          for (const entry of await fs.promises.readdir(current.directory, { withFileTypes: true })) {
            if (fileCount + folderCount >= maximumEntries) { truncated = true; skippedCount += 1; break; }
            const entryPath = path.join(current.directory, entry.name);
            const entryStat = await fs.promises.lstat(entryPath);
            if (entryStat.isSymbolicLink()) { skippedCount += 1; continue; }
            if (entryStat.isDirectory()) { folderCount += 1; pending.push({ directory: entryPath, depth: current.depth + 1 }); }
            else if (entryStat.isFile()) { fileCount += 1; size += entryStat.size; }
          }
        }
      }
      return { success: true, details: { size, createdAt: stat.birthtimeMs || stat.ctimeMs, updatedAt: stat.mtimeMs, fileCount, folderCount, truncated, skippedCount } };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  });
};

module.exports = { registerEntryDetailsIpc, registerRecentProjectFileIpc };
