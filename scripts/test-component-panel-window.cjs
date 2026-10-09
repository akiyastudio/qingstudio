const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');
const { withApplicationHost } = require('../electron/services/application-windows.cjs');

let nextId = 0;
class Contents extends EventEmitter {
  constructor() { super(); this.id = ++nextId; this.mainFrame = {}; this.session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }; }
  isDestroyed() { return Boolean(this.destroyed); }
  setWindowOpenHandler() {}
  async loadFile() {}
  async insertCSS() { return 'css'; }
  async removeInsertedCSS() {}
  send() {}
  close() { this.destroyed = true; this.emit('destroyed'); }
}
class View {
  constructor() { this.webContents = new Contents(); }
  setBounds(bounds) { this.bounds = bounds; }
  setVisible(value) { this.visible = value; }
  setBorderRadius(radius) { this.radius = radius; }
}
const contentView = () => ({ children: new Set(), addChildView(view) { this.children.add(view); }, removeChildView(view) { this.children.delete(view); } });
class Window extends EventEmitter {
  constructor(options) { super(); this.id = ++nextId; this.options = options; this.webContents = new Contents(); this.contentView = contentView(); Window.all.push(this); }
  isDestroyed() { return Boolean(this.destroyed); }
  getContentSize() { return [this.options.width, this.options.height]; }
  show() { this.shown = true; }
  focus() { this.focused = true; }
  close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); this.webContents.close(); }
}
Window.all = [];

(async () => {
  const repositoryRoot = path.join(__dirname, '..');
  const componentRoot = path.join(repositoryRoot, 'examples', 'hello-component');
  const manifest = JSON.parse(fs.readFileSync(path.join(componentRoot, 'component.json'), 'utf8'));
  const fullPage = manifest.componentHost.contributions.find(item => item.type === 'component.fullPage');
  const rpcMethod = manifest.componentHost.service.rpcMethods[0];
  manifest.componentHost.contributions = [fullPage, {
    type: 'application.homeCard', id: 'home', label: 'Home', description: 'Open the component',
    pageId: fullPage.id, rpcMethods: [rpcMethod],
  }];
  const parsed = parseComponentHostManifest(manifest, componentRoot);
  assert.equal(parsed.contributions[0].type, 'application.homeCard');
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'electron', 'contracts', 'schemas', 'component-manifest-v2.schema.json'), 'utf8').replaceAll('#/$defs/', '#/definitions/'));
  schema.definitions = schema.$defs; delete schema.$defs; delete schema.$schema; delete schema.$id;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  const source = { id: 'source', root: false, webContents: new Contents(), contentView: contentView(), isDestroyed: () => false };
  const descriptor = {
    componentId: 'panel-fixture', displayName: 'Fixture Plugin', componentVersion: '1', contractVersion: 2,
    icon: { mimeType: 'image/svg+xml', entry: path.join(repositoryRoot, 'public', 'app-logo.svg') },
    fullPage: { id: 'main', title: 'Panel', entry: 'fixture.html' },
    pages: [{ id: 'main', title: 'Panel', entry: 'fixture.html' }],
    contributions: [
      { id: 'details', type: 'component.sidePanel', pageId: 'main', title: 'Details', rpcMethods: [] },
      { id: 'home', type: 'application.homeCard', pageId: 'main', title: 'Home', rpcMethods: [] },
    ],
    service: { permissions: ['project.media.read', 'network.fetch'], events: ['fixture.updated.v1'] },
  };
  const handlers = new Map();
  const manager = new ComponentViewManager({ BrowserWindow: Window, nativeImage: { createFromBuffer: bytes => { assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))); return { pluginIcon: true }; } }, WebContentsView: View, mainWindow: source,
    registry: { resolve: () => descriptor }, preloadPath: 'component-preload.cjs', ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  const original = await withApplicationHost(source, () => manager.openContribution({ componentId: 'panel-fixture', contributionId: 'details', type: 'component.sidePanel', workspacePath: 'C:/work', projectId: 'p', projectName: 'Project', projectStatus: 'active', sourcePageId: 'files' }));
  const originalInstance = manager.instancesById.get(original.instanceId);
  const handler = handlers.get('component-sdk:open-panel-window');
  assert.throws(() => handler({ sender: source.webContents, senderFrame: source.webContents.mainFrame }), /Unauthorized/);
  assert.throws(() => handler({ sender: originalInstance.view.webContents, senderFrame: {} }), /Unauthorized/);
  const panelEvent = { sender: originalInstance.view.webContents, senderFrame: originalInstance.view.webContents.mainFrame };
  const result = await handler(panelEvent);
  const window = Window.all[0];
  assert.equal(result.windowId, window.id);
  assert.equal(window.shown, true);
  assert.equal(window.options.frame, true, 'the standalone panel uses native window controls');
  assert.equal(window.options.title, 'Fixture Plugin');
  assert.deepEqual(window.options.icon, { pluginIcon: true });
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.contentView.children.size, 1, 'the new window contains only the component view');
  const second = [...manager.instancesById.values()].find(item => item !== originalInstance);
  assert(second && second.view !== originalInstance.view);
  assert.deepEqual(second.view.bounds, { x: 0, y: 0, width: 900, height: 620 });
  window.options.width = 1040; window.options.height = 700; window.emit('resize');
  assert.deepEqual(second.view.bounds, { x: 0, y: 0, width: 1040, height: 700 });
  assert.equal(second.context.sourcePageId, 'files');
  assert.equal(originalInstance.view.webContents.isDestroyed(), false, 'the original panel stays open');
  window.close();
  assert.equal(second.view.webContents.isDestroyed(), true);
  assert.equal(originalInstance.view.webContents.isDestroyed(), false);
  await handler(panelEvent);
  withApplicationHost(source, () => manager.closeProject('C:/work', 'p'));
  assert.equal(Window.all[1].isDestroyed(), true, 'closing the source project closes its panel windows');
  assert.equal(originalInstance.view.webContents.isDestroyed(), true);
  const reopened = await withApplicationHost(source, () => manager.openContribution({ componentId: 'panel-fixture', contributionId: 'details', type: 'component.sidePanel', workspacePath: 'C:/work', projectId: 'p', projectName: 'Project', projectStatus: 'active', sourcePageId: 'files' }));
  const reopenedInstance = manager.instancesById.get(reopened.instanceId);
  await handler({ sender: reopenedInstance.view.webContents, senderFrame: reopenedInstance.view.webContents.mainFrame });
  await assert.rejects(manager.openHomeContributionWindow(source, { componentId: 'panel-fixture', contributionId: 'details' }), /Unknown component home card/);
  const sourceViewCount = source.contentView.children.size;
  const homeFirst = await manager.openHomeContributionWindow(source, { componentId: 'panel-fixture', contributionId: 'home' });
  const homeSecond = await manager.openHomeContributionWindow(source, { componentId: 'panel-fixture', contributionId: 'home' });
  const homeWindows = Window.all.slice(3);
  assert.equal(homeWindows.length, 2, 'each home card click creates a separate native window');
  assert.notEqual(homeFirst.windowId, homeSecond.windowId);
  const homeInstances = [...manager.instancesById.values()].filter(item => item.context.surface === 'application.homeCard');
  assert.equal(homeInstances.length, 2);
  assert.equal(source.contentView.children.size, sourceViewCount, 'home card views do not enter the main application window');
  for (const [index, child] of homeInstances.entries()) {
    assert.equal(child.context.projectId, '');
    assert.equal(child.context.sourcePageId, '');
    assert.deepEqual(child.context.selectedRelativePaths, []);
    assert.equal(child.context.contributionId, 'home');
    assert.equal(homeWindows[index].contentView.children.size, 1);
    assert.equal(homeWindows[index].options.title, 'Fixture Plugin');
    assert.deepEqual(manager.publicContext(child).permissions, ['network.fetch']);
    assert.deepEqual(manager.publicContext(child).events, []);
  }
  homeWindows[0].close();
  assert.equal(homeInstances[0].view.webContents.isDestroyed(), true);
  assert.equal(homeInstances[1].view.webContents.isDestroyed(), false);
  manager.closeHost(source);
  assert.equal(Window.all[2].isDestroyed(), true, 'closing the source page also closes its panel windows');
  assert.equal(reopenedInstance.view.webContents.isDestroyed(), true);
  assert.equal(homeWindows[1].isDestroyed(), true, 'closing the main application page closes its home card windows');
  console.log('Component panel and home card windows, isolation, layout and cleanup passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
