const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');

let nextId = 1;
const sessions = new Map();
class WebContents extends EventEmitter {
  constructor(partition) {
    super(); this.id = nextId++; this.destroyed = false;
    if (!sessions.has(partition)) {
      const session = { handlers: new Map(), registrations: 0, setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
      session.protocol = { handle: (scheme, handler) => { session.registrations++; session.handlers.set(scheme, handler); } };
      session.webRequest = { onBeforeRequest: handler => { session.beforeRequest = handler; } };
      sessions.set(partition, session);
    }
    this.session = sessions.get(partition);
  }
  isDestroyed() { return this.destroyed; }
  send() {}
  setWindowOpenHandler() {}
  insertCSS() { return Promise.resolve('css'); }
  loadFile() { return Promise.resolve(); }
  close() { this.destroyed = true; this.emit('destroyed'); }
}
class WebContentsView {
  constructor(options) { this.webContents = new WebContents(options.webPreferences.partition); }
  setBounds() {}
  setVisible() {}
}
const ipc = new Map();
const descriptors = ['fixture.media', 'fixture.other'].map(componentId => ({ componentId, componentVersion: '1', contractVersion: 2, componentRoot: __dirname, fullPage: { id: 'main', title: 'Media', entry: __filename }, service: { permissions: [], events: [] } }));
const served = [];
const manager = new ComponentViewManager({
  WebContentsView,
  mainWindow: { isDestroyed: () => false, webContents: { send() {} }, contentView: { addChildView() {}, removeChildView() {} } },
  registry: { resolve: id => descriptors.find(item => item.componentId === id), list: () => descriptors },
  preloadPath: __filename, ipcMain: { handle: (name, handler) => ipc.set(name, handler) },
  mediaProtocolHandler: request => { served.push(request.url); return new Response('authorized-image', { headers: { 'Content-Type': 'image/jpeg' } }); },
});
const allowed = (instance, url, webContentsId = instance.view.webContents.id) => new Promise(resolve => instance.view.webContents.session.beforeRequest({ url, webContentsId }, result => resolve(!result.cancel)));
const urlA = `photoflow-media://file/${'a'.repeat(32)}`;
const urlB = `photoflow-media://file/${'b'.repeat(32)}`;

(async () => {
  try {
    const openedA = await manager.open({ componentId: 'fixture.media', pageId: 'main', workspacePath: __dirname, projectId: 'project-a' });
    const openedB = await manager.open({ componentId: 'fixture.media', pageId: 'main', workspacePath: __dirname, projectId: 'project-b' });
    const openedOther = await manager.open({ componentId: 'fixture.other', pageId: 'main', workspacePath: __dirname, projectId: 'project-a' });
    const a = manager.instancesById.get(openedA.instanceId); const b = manager.instancesById.get(openedB.instanceId); const other = manager.instancesById.get(openedOther.instanceId);
    const session = a.view.webContents.session;
    assert.equal(session, b.view.webContents.session);
    assert.equal(session.registrations, 2, 'a shared component partition registers media and Host player protocols once');
    assert.equal(await allowed(a, urlA), false, 'a URL returned by untrusted component code alone is not a grant');
    a.context.grantMediaUrl(urlA);
    b.context.grantMediaUrl(urlB);
    assert.equal(await allowed(a, urlA), true);
    assert.equal(await allowed(b, urlB), true);
    assert.equal(await allowed(b, urlA), false, 'another project view cannot consume the grant');
    assert.equal(await allowed(other, urlA), false, 'another component cannot consume the grant');
    assert.equal(await allowed(a, 'https://example.com/image.jpg'), false, 'network isolation remains intact');
    assert.equal(await allowed(a, 'photoflow-player://runtime/v1/player.js'), true);
    assert.equal(await allowed(a, 'photoflow-player://runtime/v1/player.css'), true);
    assert.equal(await allowed(a, 'photoflow-player://runtime/v1/timeline.js'), true);
    assert.equal(await allowed(a, 'photoflow-player://runtime/v1/timeline.css'), true);
    for (const url of ['photoflow-player://runtime/v2/player.js','photoflow-player://runtime/v1/secret.js','photoflow-player://runtime/v1/player.js?path=secret','photoflow-player://runtime/v1/player.js#extra']) assert.equal(await allowed(a,url),false);
    assert.equal(await allowed(a,'photoflow-player://runtime/v1/player.js',-1),false);
    assert.equal(await allowed(a,'photoflow-player://runtime/v1/player.js',other.view.webContents.id),false);

    assert.equal(await allowed(a, `${urlA}/extra`), false);
    assert.equal(await allowed(a, `photoflow-media://wrong/${'a'.repeat(32)}`), false);
    assert.equal(await allowed(a, urlA, -1), false, 'requests without a bound component sender fail closed');
    const publicContext = ipc.get('component-sdk:get-context')({ sender: a.view.webContents });
    assert.equal(publicContext.grantMediaUrl, undefined, 'the grant function never crosses the renderer bridge');
    const handler = session.handlers.get('photoflow-media');
    assert.equal(await (await handler(new Request(urlA))).text(), 'authorized-image');
    assert.equal((await handler(new Request(`photoflow-media://file/${'c'.repeat(32)}`))).status, 404);
    manager.close(openedA.instanceId);
    assert.equal(await allowed(b, urlA), false);
    assert.equal((await handler(new Request(urlA))).status, 404, 'closing a view revokes its protocol grants');
    assert.equal(await allowed(b, urlB), true, 'closing a sibling view does not revoke this view');
    const now = Date.now;
    try { Date.now = () => now() + 60 * 60 * 1000 + 1; assert.equal(await allowed(b, urlB), false); }
    finally { Date.now = now; }
    assert.equal(served.length, 1, 'only an authorized media request reached the host response handler');
    console.log('Component media protocol authorization and project isolation tests passed');
  } finally { for (const instance of [...manager.instancesById.values()]) manager.close(instance.instanceId); }
})().catch(error => { console.error(error); process.exitCode = 1; });
