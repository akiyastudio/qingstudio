const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accepted, failed) => { resolve = accepted; reject = failed; });
  return { promise, resolve, reject };
};

async function testSlowReads() {
  const { createDirectoryRefreshQueue } = await import(pathToFileURL(path.resolve(__dirname, '../src/features/workspace/directory-refresh-queue.ts')).href);
  const enqueue = createDirectoryRefreshQueue();
  const firstRead = deferred();
  const secondRead = deferred();
  const reads = [];
  const first = enqueue('external/root', false, async includeContents => {
    reads.push(includeContents);
    return firstRead.promise;
  });
  const second = enqueue('external/root', true, async () => assert.fail('only the latest queued callback should run'));
  for (let event = 0; event < 20; event += 1) {
    assert.equal(enqueue('external/root', false, async includeContents => {
      reads.push(includeContents);
      return secondRead.promise;
    }), second, 'watcher bursts share one follow-up read and completion');
  }
  assert.deepEqual(reads, [false], 'a slow foreground read is never superseded by same-directory events');
  assert.equal(await enqueue('external/child', false, async () => 'child'), 'child', 'navigation to another folder does not wait for the old read');
  firstRead.resolve('first visible files');
  assert.equal(await first, 'first visible files', 'the initial listing commits before waiting for the follow-up');
  assert.deepEqual(reads, [false, true], 'coalescing must preserve project-contents invalidation');
  secondRead.resolve('updated files');
  assert.equal(await second, 'updated files');

  const failedRead = deferred();
  const failure = enqueue('external/root', false, () => failedRead.promise);
  const failureAssertion = assert.rejects(failure, /offline/);
  const retry = enqueue('external/root', false, async () => 'reconnected');
  failedRead.reject(new Error('offline'));
  await failureAssertion;
  assert.equal(await retry, 'reconnected', 'a failed directory read must still release its queued retry');
  assert.equal(await enqueue('external/root', false, async () => 'warm refresh'), 'warm refresh', 'a settled queue releases all state');
}

async function testMountedDirectoryReads() {
  const { createDirectoryRefreshQueue } = await import(pathToFileURL(path.resolve(__dirname, '../src/features/workspace/directory-refresh-queue.ts')).href);
  const source = fs.readFileSync(path.resolve(__dirname, '../src/features/workspace/ProjectWorkspace.tsx'), 'utf8');
  const parsed = ts.createSourceFile('ProjectWorkspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ['refresh', 'readDirectory'].includes(node.name.getText(parsed)) && node.initializer) {
      declarations.set(node.name.getText(parsed), `const ${node.getText(parsed)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(declarations.size, 2, 'exercise the actual foreground refresh and directory reader');
  const requests = [];
  const displayed = [];
  const context = {
    workspacePath: 'C:/workspace', project: { path: 'D:/external', name: 'External', status: 'active' }, mediaCacheConfig: {},
    currentRelativePathRef: { current: '' }, projectPathRef: { current: 'D:/external' },
    refreshSequenceRef: { current: 0 }, directoryRefreshEpochRef: { current: 0 },
    directoryRefreshQueueRef: { current: createDirectoryRefreshQueue() },
    directoryEntriesCacheRef: { current: new Map() }, renderedDirectoryRef: { current: { path: '', ready: false } },
    fileEntriesRef: { current: [] }, activeRef: { current: true },
    normalizeProjectRelativePath: value => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    isForegroundDirectoryRefresh: (directory, currentDirectory, project, currentProject) => directory === currentDirectory && project === currentProject,
    projectWorkspaceClient: { browseProjectFiles: (_workspace, _status, _name, directory) => {
      const read = deferred();
      requests.push({ directory, ...read });
      return read.promise;
    } },
    archiveDirectory: { contains: () => false, browse: async () => null },
    mergeRefreshedEntryMetadata: entries => entries,
    setFileEntries: entries => displayed.push(entries), setForegroundDirectoryReady: () => undefined,
    setDirectoryLoading: () => undefined, reconcileDirectoryUiState: () => undefined, onNotice: () => undefined,
  };
  const compiled = ts.transpileModule([...declarations.values()].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const refresh = new Function(...Object.keys(context), `${compiled}\nreturn refresh;`)(...Object.values(context));
  const first = refresh('', { includeProjectContents: false });
  const followup = refresh('', { includeProjectContents: false });
  for (let event = 0; event < 10; event += 1) void refresh('', { includeProjectContents: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  requests[0].resolve({ success: true, entries: ['first root listing'] });
  assert.equal(await first, true);
  assert.deepEqual(displayed.at(-1), ['first root listing'], 'watcher overlap cannot discard a slow initial root listing');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  requests[1].resolve({ success: true, entries: ['updated root listing'] });
  assert.equal(await followup, true);
  assert.deepEqual(displayed.at(-1), ['updated root listing']);

  const oldRead = refresh('', { includeProjectContents: false });
  const obsoleteFollowup = refresh('', { includeProjectContents: false });
  context.directoryRefreshEpochRef.current += 1;
  context.refreshSequenceRef.current += 1;
  context.currentRelativePathRef.current = 'child';
  const child = refresh('child', { includeProjectContents: false });
  await new Promise(resolve => setImmediate(resolve));
  requests[3].resolve({ success: true, entries: ['child listing'] });
  assert.equal(await child, true);
  requests[2].resolve({ success: true, entries: ['obsolete root listing'] });
  assert.equal(await oldRead, false);
  assert.equal(await obsoleteFollowup, false);
  assert.equal(requests.length, 4, 'a queued read from before navigation cannot start later and supersede the new directory');
  assert.deepEqual(displayed.at(-1), ['child listing']);
}

function watcherFixture(overrides = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/features/workspace/ProjectWorkspace.tsx'), 'utf8');
  const parsed = ts.createSourceFile('ProjectWorkspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effectBody;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'useEffect') {
      const callback = node.arguments[0];
      if (ts.isArrowFunction(callback) && callback.body.getText(parsed).includes('const pendingRecursiveDirectories')) effectBody = callback.body.getText(parsed);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert(effectBody, 'exercise the actual renderer watcher subscription');
  let now = 0;
  let nextId = 0;
  let listener;
  const timers = new Map();
  const refreshes = [];
  const recursiveRefreshes = [];
  const scopeRefreshes = [];
  const context = {
    active: true, workspacePath: 'C:/workspace', project: { path: 'D:/external', name: 'External' },
    rootRelativeFileEvents: false, projectWorkflows: false, projectRootScopeSelected: false,
    recursiveFlatOpen: false, currentFolderRecursiveSearchActive: false, finalViewOpen: false,
    currentRelativePathRef: { current: '' }, directoryEntriesCacheRef: { current: new Map() },
    renderedDirectoryRef: { current: { ready: false } }, fileEntriesRef: { current: [] }, searchEntriesRef: { current: [] },
    normalizeProjectRelativePath: value => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    projectRelativeParentPath: value => value.split('/').slice(0, -1).join('/'),
    projectWorkspaceClient: { onWorkspaceFilesChanged: callback => { listener = callback; return () => { listener = undefined; }; } },
    window: {
      setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout: id => timers.delete(id),
    },
    setRootWatchFailed: () => undefined, setExternalWatchRevision: () => undefined,
    loadProgressFolders: () => undefined, loadFinalViewEntries: () => undefined,
    refresh: (directory, options) => refreshes.push({ at: now, directory, ...options }),
    refreshRecursiveDirectory: directory => recursiveRefreshes.push(directory),
    setScopeRefreshToken: () => scopeRefreshes.push(now),
    ...overrides,
  };
  const compiled = ts.transpileModule(`function install() ${effectBody}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const cleanup = new Function(...Object.keys(context), `${compiled}\nreturn install();`)(...Object.values(context));
  const advance = milliseconds => {
    const target = now + milliseconds;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    now = target;
  };
  return {
    advance, cleanup, refreshes, recursiveRefreshes, scopeRefreshes,
    change: fileName => listener({ root: 'C:/workspace', fileName, eventType: 'rename' }),
  };
}

function testContinuousChanges() {
  for (const mode of ['directory', 'recursive', 'scope']) {
    const fixture = watcherFixture({ recursiveFlatOpen: mode === 'recursive', projectRootScopeSelected: mode === 'scope' });
    fixture.change('AnotherProject/unrelated.txt');
    fixture.advance(600);
    assert.equal(fixture.refreshes.length + fixture.recursiveRefreshes.length + fixture.scopeRefreshes.length, 0, 'another project cannot trigger a refresh');
    for (let event = 0; event < 12; event += 1) {
      fixture.change(`External/file-${event}.txt`);
      fixture.advance(mode === 'directory' ? 100 : 400);
    }
    if (mode === 'directory') {
      assert(fixture.refreshes.length >= 2, 'continuous external root writes must refresh while the burst is still active');
      assert(fixture.refreshes.every(refresh => refresh.directory === '' && refresh.includeProjectContents), 'root refreshes also reload folder contents');
    } else if (mode === 'recursive') assert(fixture.recursiveRefreshes.length >= 2, 'recursive views retain their independent refresh path');
    else assert(fixture.scopeRefreshes.length >= 2, 'project-wide filters retain their independent refresh path');
    const count = fixture.refreshes.length + fixture.recursiveRefreshes.length + fixture.scopeRefreshes.length;
    fixture.cleanup();
    fixture.advance(1000);
    assert.equal(fixture.refreshes.length + fixture.recursiveRefreshes.length + fixture.scopeRefreshes.length, count, 'closing the view cancels pending refresh timers');
  }
}

(async () => {
  await testSlowReads();
  await testMountedDirectoryReads();
  testContinuousChanges();
  console.log('directory refresh starvation regression tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
