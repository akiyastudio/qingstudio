const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const waitFor = async (check, description) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Workspace window smoke timed out: ${description}`);
};

const dragTab = async (manager, tab, screenPoint, outside) => {
  const realScreen = manager.screen;
  // Keep the user's physical cursor untouched. Chromium receives actual mouse
  // input events; only the OS cursor reading used by the drop resolver is fixed.
  manager.screen = { getCursorScreenPoint: () => screenPoint, getDisplayNearestPoint: point => realScreen.getDisplayNearestPoint(point) };
  try {
    tab.nativeWindow.focus(); tab.webContents.focus();
    const rect = await tab.webContents.executeJavaScript(`(() => { const tab = document.querySelector('[data-native-tab="${tab.id}"]'); if (!tab) throw new Error('Drag source tab missing'); const rect = tab.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
    tab.webContents.sendInputEvent({ type: 'mouseMove', ...rect });
    tab.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
    tab.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x + 20, y: rect.y, modifiers: ['leftButtonDown'] });
    await new Promise(resolve => setTimeout(resolve, 50));
    tab.webContents.sendInputEvent({ type: 'mouseMove', ...outside, modifiers: ['leftButtonDown'] });
    tab.webContents.sendInputEvent({ type: 'mouseUp', ...outside, button: 'left', clickCount: 1 });
    const window = tab.nativeWindow;
    await waitFor(() => tab.nativeWindow !== window, 'pointer drag transfers the tab');
  } finally { manager.screen = realScreen; }
};

// Called only inside the isolated application smoke fixture. It uses the real
// preload, React application, native tab container and shared backend services.
const runWorkspaceWindowSmokeProbe = async ({ mainWindow, manager }) => {
  if (manager.sharedTabs) return require('./shared-window-smoke-probe.cjs').runSharedWindowSmokeProbe({ mainWindow, manager });
  const loadRenderer = manager.loadRenderer;
  const startupLogs = [];
  manager.loadRenderer = async contents => {
    // Initialize the DevTools target before issuing Page commands; a newly
    // constructed WebContentsView has not navigated to a document yet.
    await contents.loadURL('about:blank');
    contents.on('console-message', (_event, details, legacyMessage) => {
      const message = typeof details === 'object' ? details.message : legacyMessage;
      if (/Configuration (?:loaded|created)/.test(message)) startupLogs.push(message);
    });
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Page.enable');
    await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__startupSplashSeen = false;
      new MutationObserver(() => {
        // The shared HTML document has a static fallback behind the hidden
        // native View. A child App must never mount its own startup screen.
        if (document.querySelector('[data-application-startup]')) window.__startupSplashSeen = true;
      }).observe(document, { childList: true, subtree: true, characterData: true });
    ` });
    try { await loadRenderer(contents); } finally { if (contents.debugger.isAttached()) contents.debugger.detach(); }
  };
  const assertOpenedPage = async contents => {
    const state = await contents.executeJavaScript(`({ splash: window.__startupSplashSeen, startupText: document.body.textContent.includes('正在启动'), page: Boolean(document.querySelector('[data-native-tab]') && document.querySelector('main')) })`);
    assert.deepEqual(state, { splash: false, startupText: false, page: true }, 'opening a tab must return a committed page without rendering the application startup splash');
    assert.equal(startupLogs.length, 0, 'new tabs must not rerun root configuration initialization');
  };
  try {
  const id = await mainWindow.webContents.executeJavaScript(`(async () => {
    const api = window.electronAPI;
    const config = await api.loadConfig();
    const consent = await api.savePrivacyConsent({ acceptCore: true, experienceProgramGranted: false });
    if (!consent.success) throw new Error('Fixture consent failed');
    const saved = await api.saveConfig({ ...config, usagePreferencesVersion: 999 });
    if (!saved.success) throw new Error(saved.error);
    const catalog = await api.getWorkspaceProjects(config.workspacePath);
    const project = catalog.statuses.flatMap(group => group.projects)[0];
    if (!project) throw new Error('Fixture project missing');
    project.workspacePath = config.workspacePath;
    return api.workspaceWindows.open({ kind: 'project', label: project.name, page: {
      id: 'window-smoke-project-page', kind: 'project', projectId: project.id, project,
      currentRelativePath: '', initialRelativePath: '', operation: null
    }});
  })()`);
  const tab = manager.tabs.get(id);
  assert(tab && !tab.root);
  const contents = tab.webContents;
  await assertOpenedPage(contents);
  await waitFor(() => contents.executeJavaScript(`Boolean(document.querySelector('[data-native-tab]') && document.querySelector('main'))`), 'application tab UI');
  const folderSeed = { ...tab.seed, label: '素材', page: { ...tab.seed.page, id: 'window-smoke-folder-page', currentRelativePath: '素材', initialRelativePath: '素材' } };
  const folderId = await contents.executeJavaScript(`window.electronAPI.workspaceWindows.open(${JSON.stringify(folderSeed)})`);
  const folder = manager.tabs.get(folderId);
  await assertOpenedPage(folder.webContents);
  assert.equal(manager.windows.get(tab.nativeWindow.id).activeId, folderId);
  await contents.executeJavaScript(`window.electronAPI.workspaceWindows.close(${JSON.stringify(folderId)})`);
  await waitFor(() => folder.webContents.isDestroyed(), 'folder tab closes');
  const token = randomUUID();
  await contents.executeJavaScript(`window.__windowTransferToken = ${JSON.stringify(token)}`);
  const originalWindow = tab.nativeWindow;
  const originalBounds = originalWindow.getContentBounds();
  await dragTab(manager, tab, { x: originalBounds.x + originalBounds.width + 120, y: originalBounds.y + 100 }, { x: originalBounds.width + 120, y: 100 });
  const detachedWindow = tab.nativeWindow;
  assert.notEqual(detachedWindow, originalWindow);
  assert.equal(await contents.executeJavaScript('window.__windowTransferToken'), token);
  const working = await contents.executeJavaScript(`(async () => {
    const api = window.electronAPI;
    const config = await api.loadConfig();
    const catalog = await api.getWorkspaceProjects(config.workspacePath);
    const background = await api.getBackgroundTasks();
    return { catalog: catalog.success, background: background.success, title: Boolean(document.querySelector('[data-native-tab]')) };
  })()`);
  assert.deepEqual(working, { catalog: true, background: true, title: true });
  if (process.env.PHOTOFLOW_SMOKE_WORKSPACE_SCREENSHOT) {
    const path = require('node:path');
    const fs = require('node:fs');
    const privateRoot = require('../../scripts/project-output-paths.cjs').privateRootFor(path.resolve(__dirname, '../..'));
    const output = path.resolve(process.env.PHOTOFLOW_SMOKE_WORKSPACE_SCREENSHOT);
    const relative = path.relative(privateRoot, output);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Window screenshot must be inside the private output root');
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    // Let the window's 200ms sidebar layout transition finish before capturing.
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.promises.writeFile(output, (await contents.capturePage()).toPNG());
  }
  detachedWindow.setBounds({ x: originalBounds.x + 100, y: originalBounds.y + 100, width: 800, height: 500 });
  await new Promise(resolve => setTimeout(resolve, 100));
  await dragTab(manager, tab, { x: originalBounds.x + 350, y: originalBounds.y + 20 }, { x: 250, y: -80 });
  await waitFor(() => detachedWindow.isDestroyed(), 'empty window closes');
  assert.equal(tab.nativeWindow, originalWindow);
  assert.equal(await contents.executeJavaScript('window.__windowTransferToken'), token);
  await mainWindow.webContents.executeJavaScript(`window.electronAPI.workspaceWindows.close(${JSON.stringify(id)})`);
  await waitFor(() => contents.isDestroyed(), 'application tab closes');
  assert.equal(manager.tabs.size, 1);
  // Opening a real folder can register version metadata and schedule indexing.
  // Let that work settle before the separate shutdown probe deliberately queues
  // interrupted tasks and verifies a clean next launch. Include the 1.5s debounce.
  let quietSince = Date.now();
  await waitFor(async () => {
    const active = await mainWindow.webContents.executeJavaScript(`window.electronAPI.getBackgroundTasks().then(snapshot => snapshot.tasks.some(task => ['version-media-rescan', 'version-stale-detection'].includes(task.type) && ['queued', 'running', 'pausing', 'paused', 'resuming', 'interrupted'].includes(task.state)))`);
    if (active) quietSince = Date.now();
    return Date.now() - quietSince >= 2000;
  }, 'folder indexing settles before the independent shutdown probe');
  return true;
  } finally { manager.loadRenderer = loadRenderer; }
};
module.exports = { runWorkspaceWindowSmokeProbe };
