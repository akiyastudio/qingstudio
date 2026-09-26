const assert = require('node:assert/strict');
const waitFor = async (check, description) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`Shared-window smoke timed out: ${description}`);
};
const ownerOf = (manager, id) => [...manager.tabs.values()].find(host => host.localTabs?.some(tab => tab.id === id));
const drag = async (manager, source, id, point, outside) => {
  const originalScreen = manager.screen, sourceWindow = source.nativeWindow;
  manager.screen = { getCursorScreenPoint: () => point, getDisplayNearestPoint: point => originalScreen.getDisplayNearestPoint(point) };
  try {
    const position = await source.webContents.executeJavaScript(`(() => { const rect = document.querySelector('[data-native-tab="${id}"]').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
    source.nativeWindow.focus(); source.webContents.focus();
    source.webContents.sendInputEvent({ type: 'mouseMove', ...position });
    source.webContents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 });
    source.webContents.sendInputEvent({ type: 'mouseMove', x: position.x + 20, y: position.y, modifiers: ['leftButtonDown'] });
    await new Promise(resolve => setTimeout(resolve, 50));
    source.webContents.sendInputEvent({ type: 'mouseMove', ...outside, modifiers: ['leftButtonDown'] });
    source.webContents.sendInputEvent({ type: 'mouseUp', ...outside, button: 'left', clickCount: 1 });
    await waitFor(() => { const host = ownerOf(manager, id); return host && host !== source && host.nativeWindow !== sourceWindow; }, 'tab moves to another renderer only when moved to another window');
    return ownerOf(manager, id);
  } finally { manager.screen = originalScreen; }
};
const runSharedWindowSmokeProbe = async ({ mainWindow, manager }) => {
  const root = [...manager.tabs.values()].find(host => host.root);
  const seed = await mainWindow.webContents.executeJavaScript(`(async () => {
    const api = window.electronAPI, config = await api.loadConfig();
    if (!(await api.savePrivacyConsent({ acceptCore: true, experienceProgramGranted: false })).success) throw new Error('Fixture consent failed');
    if (!(await api.saveConfig({ ...config, usagePreferencesVersion: 999 })).success) throw new Error('Fixture config failed');
    const catalog = await api.getWorkspaceProjects(config.workspacePath);
    const project = catalog.statuses.flatMap(group => group.projects)[0]; project.workspacePath = config.workspacePath;
    return { kind: 'project', label: project.name, page: { id: 'shared-smoke-project', kind: 'project', projectId: project.id, project, currentRelativePath: '', initialRelativePath: '', operation: null } };
  })()`);
  // Consent was installed by the fixture API; reload once to enter the normal
  // already-running application before measuring ordinary project opens.
  await mainWindow.webContents.loadURL(mainWindow.webContents.getURL());
  await waitFor(() => mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('[data-native-tab="home"]') && document.querySelector('main'))`), 'root application ready');
  const loadRenderer = manager.loadRenderer;
  let rendererLoads = 0;
  manager.loadRenderer = contents => { rendererLoads++; return loadRenderer(contents); };
  try {
    const open = async seed => mainWindow.webContents.executeJavaScript(`(async () => { const before = performance.now(); const id = await window.electronAPI.workspaceWindows.open(${JSON.stringify(seed)}); return { id, elapsedMs: Math.round(performance.now() - before) }; })()`);
    const project = await open(seed);
    const folder = await open({ ...seed, label: '素材', page: { ...seed.page, id: 'shared-smoke-folder', currentRelativePath: '素材', initialRelativePath: '素材' } });
    assert.equal(manager.tabs.size, 1, 'opening projects and folders must share the existing renderer');
    assert.equal(rendererLoads, 0, 'ordinary tabs must not load an application document');
    assert.equal(manager.windows.size, 1);
    assert.equal(await mainWindow.webContents.executeJavaScript(`document.body.textContent.includes('正在启动')`), false);
    await mainWindow.webContents.executeJavaScript(`window.electronAPI.workspaceWindows.activate(${JSON.stringify(project.id)})`);
    await waitFor(() => mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('button[aria-label="查找文件"]'))`), 'project controls ready');
    await mainWindow.webContents.executeJavaScript(`document.querySelector('button[aria-label="查找文件"]').click()`);
    await waitFor(() => mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('input[placeholder="输入文件名"]'))`), 'file search input');
    await mainWindow.webContents.executeJavaScript(`(() => { const input = document.querySelector('input[placeholder="输入文件名"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'smoke'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await mainWindow.webContents.executeJavaScript(`window.electronAPI.workspaceWindows.activate(${JSON.stringify(folder.id)})`);
    const originalBounds = mainWindow.getContentBounds();
    const detached = await drag(manager, root, project.id, { x: originalBounds.x + originalBounds.width + 100, y: originalBounds.y + 100 }, { x: originalBounds.width + 100, y: 100 });
    assert.equal(rendererLoads, 1, 'detaching creates exactly one application renderer');
    assert.equal(manager.windows.size, 2);
    assert.equal(root.localTabs.find(tab => tab.active)?.id, folder.id, 'moving an inactive tab preserves the source window selection');
    await waitFor(() => detached.webContents.executeJavaScript(`document.querySelector('input[placeholder="输入文件名"]')?.value === 'smoke'`), 'search draft survives detach');
    await waitFor(() => detached.webContents.executeJavaScript(`Boolean(document.querySelector('button[aria-label="展开项目栏"]'))`), 'detached sidebar collapsed');
    const sharedProject = seed.page.project;
    const refreshPath = '素材/window-refresh-fixture';
    const createResult = await detached.webContents.executeJavaScript(`window.electronAPI.createProjectFolder(${JSON.stringify(sharedProject.workspacePath)}, ${JSON.stringify(sharedProject.status)}, ${JSON.stringify(sharedProject.name)}, 'window-refresh-fixture', '素材')`);
    assert.equal(createResult.success, true, createResult.error);
    const peerHasEntry = () => mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('[data-entry-path="${refreshPath}"]'))`);
    await waitFor(peerHasEntry, 'creating a folder in one window refreshes the other window');
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-entry-path="${refreshPath}"]').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
    const peerDeleteDisabled = () => mainWindow.webContents.executeJavaScript(`document.querySelector('.project-action-button.project-action-danger.compact-hide-file-action')?.disabled === true`);
    await waitFor(async () => !await peerDeleteDisabled(), 'the peer window selects the folder before it is deleted elsewhere');
    const deleteResult = await detached.webContents.executeJavaScript(`window.electronAPI.projectFileOperation(${JSON.stringify(sharedProject.workspacePath)}, ${JSON.stringify(sharedProject.status)}, ${JSON.stringify(sharedProject.name)}, 'trash', [${JSON.stringify(refreshPath)}], '素材')`);
    assert.equal(deleteResult.success, true, deleteResult.error);
    await waitFor(async () => !await peerHasEntry(), 'deleting in one window removes the entry from the other window');
    await waitFor(peerDeleteDisabled, 'the peer window clears its stale selection after deletion');
    detached.nativeWindow.setBounds({ x: originalBounds.x + 100, y: originalBounds.y + 100, width: 900, height: 600 });
    await new Promise(resolve => setTimeout(resolve, 250));
    const detachedWindow = detached.nativeWindow;
    const merged = await drag(manager, detached, project.id, { x: originalBounds.x + 350, y: originalBounds.y + 20 }, { x: 250, y: -80 });
    assert.equal(merged, root);
    await waitFor(() => detachedWindow.isDestroyed(), 'merged renderer closes with its empty window');
    assert.equal(rendererLoads, 1, 'merging reuses the existing destination renderer');
    assert.equal(manager.tabs.size, 1);
    await waitFor(() => mainWindow.webContents.executeJavaScript(`document.querySelector('input[placeholder="输入文件名"]')?.value === 'smoke'`), 'search draft survives merge');
    await mainWindow.webContents.executeJavaScript(`window.electronAPI.workspaceWindows.close(${JSON.stringify(project.id)})`);
    await mainWindow.webContents.executeJavaScript(`window.electronAPI.workspaceWindows.close(${JSON.stringify(folder.id)})`);
    let quietSince = Date.now();
    await waitFor(async () => {
      const active = await mainWindow.webContents.executeJavaScript(`window.electronAPI.getBackgroundTasks().then(snapshot => snapshot.tasks.some(task => ['version-media-rescan', 'version-stale-detection'].includes(task.type) && ['queued', 'running', 'pausing', 'paused', 'resuming', 'interrupted'].includes(task.state)))`);
      if (active) quietSince = Date.now();
      return Date.now() - quietSince >= 2000;
    }, 'folder indexing settles');
    process.stdout.write('PHOTOFLOW_TAB_TIMING=' + JSON.stringify({ projectMs: project.elapsedMs, folderMs: folder.elapsedMs, ordinaryRendererLoads: 0, detachRendererLoads: rendererLoads }) + '\n');
    return true;
  } finally { manager.loadRenderer = loadRenderer; }
};
module.exports = { runSharedWindowSmokeProbe };
