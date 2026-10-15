const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBackgroundTaskService } = require('../electron/services/background-task-service.cjs');
const { createTaskbarProgressService, selectTaskbarProgress } = require('../electron/services/taskbar-progress-service.cjs');

const nativeElectron = process.versions.electron ? require('electron') : null;
if (nativeElectron) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-taskbar-native-'));
  nativeElectron.app.setPath('userData', profile);
  nativeElectron.app.setPath('sessionData', profile);
}

const task = (state, progress = 0, extra = {}) => ({ state, progress, taskCenterPolicy: 'always', notificationPolicy: 'progress-toast', ...extra });
const none = { progress: -1, mode: 'none' };
assert.deepEqual(selectTaskbarProgress([]), none);
assert.deepEqual(selectTaskbarProgress(['completed', 'failed', 'cancelled', 'interrupted'].map(state => task(state, 75))), none,
  'finished and historical tasks must never leave a progress indicator behind');
assert.deepEqual(selectTaskbarProgress([task('running', 50)]), { progress: 0.5, mode: 'normal' });
assert.deepEqual(selectTaskbarProgress([task('running', 20), task('running', 80), task('completed', 100)]), { progress: 0.5, mode: 'normal' },
  'only unfinished tasks contribute to the aggregate');
assert.deepEqual(selectTaskbarProgress([task('queued', 70)]), { progress: 2, mode: 'indeterminate' });
assert.deepEqual(selectTaskbarProgress([task('running')]), { progress: 2, mode: 'indeterminate' });
assert.deepEqual(selectTaskbarProgress([task('running', NaN)]), { progress: 2, mode: 'indeterminate' });
assert.deepEqual(selectTaskbarProgress([task('running', 150)]), { progress: 1, mode: 'normal' });
assert.deepEqual(selectTaskbarProgress([task('running', -20)]), { progress: 2, mode: 'indeterminate' });
assert.deepEqual(selectTaskbarProgress([task('paused', 40)]), { progress: 0.4, mode: 'paused' });
assert.deepEqual(selectTaskbarProgress([task('paused')]), { progress: 0.01, mode: 'paused' }, 'a paused operation needs a visible yellow indicator even at zero');
assert.deepEqual(selectTaskbarProgress([task('paused', 40), task('running', 60)]), { progress: 0.5, mode: 'normal' });
assert.deepEqual(selectTaskbarProgress([task('pausing', 30)]), { progress: 0.3, mode: 'normal' });
assert.deepEqual(selectTaskbarProgress([task('resuming', 30)]), { progress: 0.3, mode: 'normal' });
assert.deepEqual(selectTaskbarProgress([
  task('running', 20, { taskCenterPolicy: 'hidden' }),
  task('running', 20, { taskCenterPolicy: 'attention-only' }),
  task('running', 20, { notificationPolicy: 'silent' }),
]), none, 'routine invisible maintenance must not keep the taskbar busy');

class Window extends EventEmitter {
  calls = [];
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  setProgressBar(progress, options) { this.calls.push({ progress, ...options }); }
  close() { this.destroyed = true; this.emit('closed'); }
}
const waitForUpdate = () => new Promise(resolve => setTimeout(resolve, 130));

(async () => {
  const eventBus = new EventEmitter();
  const backgroundTasks = createBackgroundTaskService({ eventBus });
  const service = createTaskbarProgressService({ backgroundTasks, platform: 'win32' });
  const root = new Window();
  const detached = new Window();
  const update = (id, state, progress = 0) => backgroundTasks.upsertExternal({ id, type: 'selection-operation', title: 'Synthetic test task', state, progress });
  try {
    service.attach(root);
    assert.deepEqual(root.calls.at(-1), none);
    update('copy', 'running');
    await waitForUpdate();
    assert.deepEqual(root.calls.at(-1), { progress: 2, mode: 'indeterminate' });

    const count = root.calls.length;
    for (let progress = 1; progress <= 60; progress++) update('copy', 'running', progress);
    await waitForUpdate();
    assert.equal(root.calls.length, count + 1, 'byte-level updates must coalesce into one native call');
    assert.deepEqual(root.calls.at(-1), { progress: 0.6, mode: 'normal' });

    service.attach(detached);
    assert.deepEqual(detached.calls.at(-1), { progress: 0.6, mode: 'normal' }, 'new windows immediately inherit the current task progress');
    root.emit('show');
    assert.equal(root.calls.length, count + 2, 'showing/restoring the window must reapply the native state');
    update('copy', 'completed', 100);
    await waitForUpdate();
    assert.deepEqual(root.calls.at(-1), none);
    assert.deepEqual(detached.calls.at(-1), none);

    for (const ending of ['cancelled', 'failed']) {
      update('copy', 'running', 30);
      service.refresh();
      assert.deepEqual(root.calls.at(-1), { progress: 0.3, mode: 'normal' });
      update('copy', ending, 30);
      service.refresh();
      assert.deepEqual(root.calls.at(-1), none, `${ending} must clear progress immediately on refresh`);
    }
    detached.close();
    const closedCount = detached.calls.length;
    update('copy', 'running', 20);
    service.refresh();
    assert.equal(detached.calls.length, closedCount, 'closed windows must not receive native calls');
    assert.equal(detached.listenerCount('show'), 0);

    const broken = new Window();
    broken.setProgressBar = () => { throw new Error('Synthetic shell failure'); };
    service.attach(broken);
    update('copy', 'running', 40);
    service.refresh();
    assert.deepEqual(root.calls.at(-1), { progress: 0.4, mode: 'normal' }, 'one shell failure must not block progress in other windows');
    service.dispose();
    assert.deepEqual(root.calls.at(-1), none);
    assert.equal(root.listenerCount('show'), 0);
    assert.equal(eventBus.listenerCount('background-task:changed'), 0);
    const disposedCount = root.calls.length;
    update('copy', 'running', 70);
    await waitForUpdate();
    assert.equal(root.calls.length, disposedCount, 'disposed observers and timers must remain inactive');
  } finally {
    service.dispose();
    backgroundTasks.stop();
  }
  for (const platform of ['darwin', 'linux']) {
    const service = createTaskbarProgressService({ platform, backgroundTasks: {
      list: () => { throw new Error('Unsupported platforms must not query tasks'); },
      subscribe: () => { throw new Error('Unsupported platforms must not subscribe'); },
    } });
    const window = new Window();
    service.attach(window); service.refresh(); service.dispose();
    assert.equal(window.calls.length, 0);
  }
  console.log('Taskbar progress model, task events, native window lifecycle and cleanup passed.');
  if (nativeElectron) {
    await nativeElectron.app.whenReady();
    const window = new nativeElectron.BrowserWindow({ show: false, webPreferences: { sandbox: true, offscreen: true } });
    const calls = [];
    const errors = [];
    const nativeSetProgressBar = window.setProgressBar.bind(window);
    window.setProgressBar = (progress, options) => {
      nativeSetProgressBar(progress, options);
      calls.push({ progress, ...options });
    };
    const backgroundTasks = createBackgroundTaskService({ eventBus: new EventEmitter() });
    const service = createTaskbarProgressService({ backgroundTasks, writeLog: (_level, _message, details) => errors.push(details) });
    try {
      service.attach(window);
      await window.loadURL('about:blank');
      backgroundTasks.upsertExternal({ id: 'native-copy', type: 'selection-operation', state: 'running', progress: 45 });
      service.refresh();
      assert.deepEqual(calls.at(-1), { progress: 0.45, mode: 'normal' });
      backgroundTasks.upsertExternal({ id: 'native-copy', type: 'selection-operation', state: 'completed' });
      service.refresh();
      assert.deepEqual(calls.at(-1), none);
      assert.deepEqual(errors, [], 'native Windows taskbar calls must succeed');
      console.log('Electron native taskbar progress API smoke test passed.');
    } finally {
      service.dispose();
      backgroundTasks.stop();
      window.destroy();
    }
    nativeElectron.app.quit();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
  nativeElectron?.app.exit(1);
});
