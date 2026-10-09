const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileRootWatcherService } = require('../electron/services/file-root-watcher-service.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-root-watcher-'));
  const originalWatch = fs.watch;
  const originalPlatform = process.platform;
  const watchCalls = [];
  const messages = [];
  const thumbnailBatches = [];
  const logs = [];
  let rejectRecursive = false;
  let rejectedDirectory = '';
  fs.watch = (watchedPath, options, callback) => {
    if (rejectRecursive && options.recursive) throw Object.assign(new Error('recursive unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
    if (!options.recursive && rejectedDirectory && path.resolve(watchedPath) === path.resolve(rejectedDirectory)) {
      throw Object.assign(new Error('watch capacity exhausted'), { code: 'ENOSPC' });
    }
    const listeners = new Map();
    const watcher = {
      closed: false,
      close() { this.closed = true; },
      on(name, handler) { listeners.set(name, handler); return this; },
      emit(name, ...args) { listeners.get(name)?.(...args); },
    };
    watchCalls.push({ watchedPath, options, callback, watcher });
    return watcher;
  };
  const service = createFileRootWatcherService({
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, payload) => messages.push(payload) } }),
    getThumbnailService: () => ({ syncChangedPaths: async (_watchRoot, changedPaths) => { thumbnailBatches.push(changedPaths); } }),
    getMediaCacheConfig: () => ({}),
    isInternalChange: () => false,
    isSuppressedChange: () => false,
    writeLog: (...args) => logs.push(args),
  });
  const firstEntries = [];
  const secondEntries = [];
  const fileTarget = path.join(root, 'one.jpg');
  fs.writeFileSync(fileTarget, 'media');
  const first = { publishRoot: path.join(root, 'publish'), virtualPrefix: 'Project/A', onChanged: entries => firstEntries.push(...entries) };
  const second = { publishRoot: path.join(root, 'publish'), virtualPrefix: 'Project/B', fileNameFilter: fileTarget, virtualFileName: 'shortcut.lnk', onChanged: entries => secondEntries.push(...entries) };
  try {
    service.acquire(root, first);
    service.acquire(root, first);
    service.acquire(root, second);
    const references = service.suspend(root);
    assert.equal(references, 3, 'legacy suspend callers must still receive a number');
    assert.equal(service.resume(root, references).success, true, 'numeric resume must restore the internally saved binding snapshot');

    const missingRelease = service.release(root, { publishRoot: first.publishRoot, virtualPrefix: 'wrong' });
    assert.equal(missingRelease.missing, true);
    assert.equal(service.suspend(root), 3, 'an unknown release must not consume another binding reference');
    service.resume(root, 3);
    assert.equal(service.release(root, first), undefined, 'successful release must preserve the legacy undefined return');
    assert.equal(service.suspend(root), 2);
    service.resume(root, 2);

    const activeWatch = watchCalls.at(-1);
    const beforeInvalidation = messages.length;
    assert.equal(service.invalidatePath(fileTarget), true);
    assert(messages.slice(beforeInvalidation).some(message => message.root === first.publishRoot && message.fileName === 'Project/A'));
    assert(messages.slice(beforeInvalidation).some(message => message.root === second.publishRoot && message.fileName === 'Project/B/shortcut.lnk'));
    assert.equal(firstEntries.length, 0, 'terminal UI invalidation does not trigger another media scan');
    assert.equal(thumbnailBatches.length, 0);
    assert.equal(service.invalidatePath(path.join(root, '..', 'unrelated')), false, 'unrelated roots are not invalidated');
    activeWatch.callback('rename', undefined);
    await delay(260);
    assert.equal(firstEntries.length > 0, true, 'folder binding must be restored by numeric resume');
    const externalChange = secondEntries.find(entry => entry.fileName === 'Project/B/shortcut.lnk');
    assert.equal(externalChange.sourcePath, path.resolve(fileTarget), 'missing filename must map a file binding back to its approved target');
    assert.equal(externalChange.fileName, 'Project/B/shortcut.lnk');

    service.stop();
    secondEntries.length = 0;
    thumbnailBatches.length = 0;
    service.acquire(root, second);
    watchCalls.at(-1).callback('change', undefined);
    await delay(260);
    assert.deepEqual(thumbnailBatches.at(-1), [path.resolve(fileTarget)], 'file-only root notifications must not send the parent directory to media sync');
    assert.equal(secondEntries.at(-1).sourcePath, path.resolve(fileTarget));

    // A failed underlying watcher leaves a stale logical binding. Releasing it
    // after re-acquire must not close the new healthy state.
    watchCalls.at(-1).watcher.emit('error', Object.assign(new Error('watch failed'), { code: 'EIO' }));
    assert.equal(messages.some(message => message.watcherStale === true), true);
    service.acquire(root, second);
    const staleRelease = service.release(root, second);
    assert.equal(staleRelease.missing, true);
    assert.equal(staleRelease.stale, true);
    assert.equal(service.suspend(root), 1, 'stale release must leave the newly acquired handle alive');
    service.resume(root, 1);
    service.stop();

    watchCalls.length = 0;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    service.acquire(path.join(root, 'A'));
    service.acquire(path.join(root, 'a'));
    assert.equal(watchCalls.length, 2, 'case-sensitive platforms must not merge A and a watcher roots');
    service.stop();

    watchCalls.length = 0;
    rejectRecursive = true;
    fs.mkdirSync(path.join(root, 'nested', 'child'), { recursive: true });
    service.acquire(root);
    assert.equal(watchCalls.filter(call => call.options.recursive === false).length, 3, 'recursive capability failure must fall back to one watcher per directory');
    const newDirectory = path.join(root, 'later');
    fs.mkdirSync(newDirectory);
    rejectedDirectory = newDirectory;
    const fallbackRootWatch = watchCalls.find(call => !call.options.recursive && path.resolve(call.watchedPath) === path.resolve(root));
    assert.doesNotThrow(() => fallbackRootWatch.callback('rename', 'later'), 'addWatcher failures must not escape the fs.watch callback');
    await delay(260);
    assert.equal(logs.some(([, message, detail]) => message === 'File-root watcher degraded' && detail.error.includes('capacity')), true);
    assert.equal(messages.some(message => message.watcherDegraded === true), true, 'fallback failure must publish a degraded root-level reconcile');
    service.stop();
    rejectRecursive = false;
    rejectedDirectory = '';

    service.resume(root, 2);
    assert.equal(service.release(root), undefined);
    assert.equal(service.release(root), undefined);
    assert.equal(service.release(root).missing, true);
    // Referenced projects rely on this watcher, while ordinary workspace
    // projects also receive workspace-watcher events. A sustained copy must
    // publish changes before the copy stops.
    service.acquire(root, first);
    const burstWatcher = watchCalls.at(-1);
    const beforeBurst = messages.length;
    for (let index = 0; index < 6; index += 1) {
      const name = `burst-${index}.txt`;
      fs.writeFileSync(path.join(root, name), 'synthetic fixture');
      burstWatcher.callback('rename', name);
      await delay(75);
    }
    assert(messages.length > beforeBurst, 'continuous external changes must flush before the burst ends');
    await delay(260);
    for (let index = 0; index < 6; index += 1) {
      assert(messages.slice(beforeBurst).some(message => message.fileName === `Project/A/burst-${index}.txt`), 'all accumulated changes must eventually publish');
    }
    console.log('file root watcher service tests passed');
  } finally {
    service.stop();
    fs.watch = originalWatch;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
