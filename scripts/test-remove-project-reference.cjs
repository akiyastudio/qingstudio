const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const ts = require('typescript');
const { registerWorkspaceIpc } = require('../electron/modules/workspace-ipc.cjs');
const { createWorkspaceRepository } = require('../electron/repositories/workspace-repository.cjs');
const translations = require('../electron/locales/zh-CN.json');

async function testIpc() {
  const root = path.resolve('synthetic-workspace');
  const rows = [
    { id: 'offline-ref', name: 'Offline', status: '策划中', availability: 'missing', extra_json: '{"importMode":"reference"}' },
    { id: 'online-ref', name: 'Online', status: '策划中', availability: 'available', extra_json: '{"importMode":"reference"}' },
    { id: 'ordinary', name: 'Ordinary', status: '策划中', extra_json: '{"importMode":"copy"}' },
  ];
  const handlers = new Map();
  const calls = [];
  const notifications = [];
  const catalogs = new Map();
  let failRefreshAfterCommit = false;
  let committed = false;
  registerWorkspaceIpc({
    Array, Boolean, Date, Error, Math, Number, Object, Promise, Set, String, fs, path,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    ensureWorkspace: () => root, activeProjectFileOperations: new Map(), workspaceCatalogs: catalogs,
    getProjectPath: () => assert.fail('reference removal cannot require an accessible physical directory'),
    HIDDEN_SYSTEM_ENTRY_NAMES: new Set(), IMAGE_EXTENSIONS: new Set(), RAW_EXTENSIONS: new Set(), VIDEO_EXTENSIONS: new Set(),
    cancelMediaTrackingScan: (_root, name) => calls.push(['cancel', name]),
    recycleBinService: { trash: () => assert.fail('reference removal must never recycle files') },
    refreshWorkspaceCatalog: async () => {
      if (committed && failRefreshAfterCommit) throw new Error('catalog temporarily unavailable');
      const projects = rows.filter(row => !row.deleted);
      const catalog = { projects, byName: new Map(projects.map(row => [row.name.toLowerCase(), row])) };
      catalogs.set(root, catalog);
      return catalog;
    },
    workspaceRepository: { removeProjectReference: async (requestedRoot, payload) => {
      assert.equal(requestedRoot, root);
      const row = rows.find(row => row.id === payload.projectId);
      assert.equal(row.name, payload.name);
      assert.equal(row.status, payload.status);
      row.deleted = true;
      committed = true;
      calls.push(['remove', payload.projectId]);
    } },
    mainWindow: { webContents: { send: (channel, payload) => notifications.push({ channel, ...payload }) } },
    writeLog: () => undefined,
  });
  const remove = handlers.get('workspace-remove-project-reference');
  for (const [status, name, id] of [
    ['策划中', 'Offline', 'stale-id'], ['后期中', 'Offline', 'offline-ref'],
    ['策划中', 'Ordinary', 'ordinary'], ['策划中', 'Unknown', 'unknown'],
  ]) assert.equal((await remove({}, root, status, name, id)).success, false);
  assert.deepEqual(calls, [], 'invalid requests cannot cancel tracking or mutate registrations');
  const offline = await remove({}, root, '策划中', 'Offline', 'offline-ref');
  assert.equal(offline.success, true);
  assert.equal(catalogs.get(root).byName.has('offline'), false);
  assert(notifications.some(message => message.channel === 'workspace-projects-changed' && message.reason === 'project-reference-removed'));
  committed = false;
  failRefreshAfterCommit = true;
  const online = await remove({}, root, '策划中', 'Online', 'online-ref');
  assert.equal(online.success, true, 'a catalog refresh failure must not misreport a committed removal');
  assert.equal(online.catalogRefreshPending, true);
  assert(online.warning);

  const repositoryCalls = [];
  const repository = createWorkspaceRepository({ call: async (...args) => { repositoryCalls.push(args); return { success: true }; } });
  await repository.removeProjectReference(root, { name: 'Offline', status: '策划中', projectId: 'offline-ref' });
  assert.deepEqual(repositoryCalls, [[root, 'delete', { name: 'Offline', status: '策划中', projectId: 'offline-ref', referenceOnly: true }]]);
}

async function testMenu() {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/components/ProjectNavigator.tsx'), 'utf8');
  const parsed = ts.createSourceFile('ProjectNavigator.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let menuExpression;
  let removeDeclaration;
  const visit = node => {
    if (ts.isJsxExpression(node) && node.expression?.getText(parsed).startsWith('menu &&')) menuExpression = node.expression.getText(parsed);
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'removeProjectReference') removeDeclaration = node.getText(parsed);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert(menuExpression && removeDeclaration);
  const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const execute = (code, context) => new Function(...Object.keys(context), compile(code))(...Object.values(context));
  const project = { id: 'offline-ref', name: 'Offline', path: 'D:/missing', status: '策划中', importMode: 'reference', availability: 'missing' };
  const removals = [];
  const menuChanges = [];
  const menuContext = {
    React, menu: { project, x: 1, y: 1 }, backupEnabled: false, backupStatus: { snapshots: [] }, statuses: [],
    window: { innerWidth: 1200, innerHeight: 800 }, t: key => translations[key],
    removeProjectReference: value => removals.push(value), setMenu: value => menuChanges.push(value),
  };
  const findRemove = element => {
    if (!element || typeof element !== 'object') return null;
    if (element.type === 'button' && element.props.children === '移除项目') return element;
    return React.Children.toArray(element.props?.children).map(findRemove).find(Boolean);
  };
  const button = findRemove(execute(`return (${menuExpression});`, menuContext));
  assert(button, 'an offline reference must expose removal even with backups disabled');
  button.props.onClick();
  assert.deepEqual(removals, [project]);
  assert.deepEqual(menuChanges, [null]);
  assert(findRemove(execute(`return (${menuExpression});`, { ...menuContext, menu: { ...menuContext.menu, project: { ...project, availability: 'available' } } })), 'online references also offer registration-only removal');
  assert.equal(execute(`return (${menuExpression});`, { ...menuContext, menu: { ...menuContext.menu, project: { ...project, importMode: 'copy' } } }), false, 'ordinary projects cannot use reference removal');

  let confirmed = false;
  const requests = [];
  const closedProjects = [];
  const errors = [];
  const pending = { current: null };
  const context = {
    pendingProjectActionRef: pending, setPendingProjectAction: () => undefined, setError: value => errors.push(value),
    appDialog: { confirm: async () => confirmed }, localizedMessage: (messageKey, params) => ({ messageKey, params }),
    window: { electronAPI: { removeWorkspaceProjectReference: async (...args) => { requests.push(args); return { success: true }; } } },
    workspaceFor: () => 'C:/owning-workspace', onProjectDeleted: value => closedProjects.push(value),
    toast: { show: () => undefined }, refresh: async () => undefined, t: key => translations[key],
  };
  const action = execute(`const ${removeDeclaration}; return removeProjectReference;`, context);
  await action(project);
  assert.deepEqual(requests, [], 'canceling the confirmation leaves registration and tabs unchanged');
  confirmed = true;
  await action(project);
  assert.deepEqual(requests, [['C:/owning-workspace', '策划中', 'Offline', 'offline-ref']]);
  assert.deepEqual(closedProjects, [project]);
  assert.equal(pending.current, null);
  assert.deepEqual(errors, []);
  context.window.electronAPI.removeWorkspaceProjectReference = async () => ({ success: false, error: 'synthetic failure' });
  await action(project);
  assert.deepEqual(closedProjects, [project], 'failed removal must not close project tabs');
  assert.deepEqual(errors, ['synthetic failure']);
  assert.equal(pending.current, null, 'failed removal releases the optimistic operation state');
}

(async () => {
  await testIpc();
  await testMenu();
  console.log('project reference removal: offline/online IPC, identity guards, repository, menu and confirmation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
