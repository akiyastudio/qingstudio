const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');

(async () => {
  const handlers = new Map(); let calls = 0;
  const host = { contentView: { removeChildView() {} } };
  const manager = new ComponentViewManager({
    mainWindow: host, registry: {}, preloadPath: '', WebContentsView: function () {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    serviceManager: { supports: () => true, invoke: async () => { calls++; return { ready: true }; } },
  });
  const contents = new EventEmitter(); contents.id = 123; contents.isDestroyed = () => false;
  contents.close = () => {}; // Electron may dispatch pagehide IPC before destroyed.
  const instance = { instanceId: 'test', key: 'test', host, hostState: manager.hostState,
    descriptor: { componentId: 'fixture' }, context: { componentId: 'fixture' }, view: { webContents: contents } };
  manager.instances.set(instance.key, instance); manager.instancesById.set(instance.instanceId, instance);
  manager.senderBindings.set(contents.id, instance);
  // Avoid unrelated storage cleanup; this test covers the real close and IPC paths.
  manager.requestComponentCapabilityClear = async () => {};
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/component-preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => { api = value; } }, webUtils: {},
      ipcRenderer: { on() {}, invoke: async (channel, ...args) => handlers.get(channel)({ sender: contents }, ...args) } }),
    window: { addEventListener() {} },
  });
  assert.equal((await api.rpc('fixture.status.v1', {})).ready, true);
  assert.equal(calls, 1);
  assert.equal(manager.close(instance.instanceId), true);
  assert.equal(manager.senderBindings.has(contents.id), false, 'close immediately revokes service access');
  await assert.rejects(api.rpc('fixture.stop.v1', {}), error => error.code === 'COMPONENT_VIEW_CLOSED');
  assert.equal(calls, 1, 'closing-page cleanup must not execute a service');
  assert.throws(() => handlers.get('component-sdk:rpc')({ sender: { id: contents.id } }, 'fixture.stop.v1', {}), /Unauthorized/, 'another object with the former sender ID remains unauthorized');
  assert.throws(() => handlers.get('component-sdk:rpc')({ sender: { id: 999 } }, 'fixture.stop.v1', {}), /Unauthorized/);
  console.log('Component RPC close cancellation, preload error propagation and sender isolation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
