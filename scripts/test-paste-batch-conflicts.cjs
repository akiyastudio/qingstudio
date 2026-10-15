const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { registerFileOperationsIpc } = require('../electron/modules/files-ipc.cjs');
const transfer = require('../electron/services/file-transfer-service.cjs');
const identity = require('../electron/services/file-identity-service.cjs');
const { createFilePublicationService } = require('../electron/services/file-publication-service.cjs');

const testDecisionDialog = async repositoryRoot => {
  // Execute the renderer's actual decision loop with a dialog and IPC harness.
  const source = fs.readFileSync(path.join(repositoryRoot, 'src/features/workspace/ProjectWorkspace.tsx'), 'utf8');
  const start = source.indexOf("      while (result.requiresDecision?.kind === 'paste-conflict')");
  const end = source.indexOf('\n    } catch (error)', start);
  assert(start >= 0 && end > start);
  const body = require('typescript').transpileModule(source.slice(start, end), {}).outputText;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const execute = new AsyncFunction('context', `
    let result = context.result;
    const { appDialog, projectWorkspaceClient, onNotice, reconcilePendingFileOperation } = context;
    const localizedMessage = value => value;
    const discardStaleProjectOperation = () => false;
    const requestedProjectPath = 'project', pendingOperation = {}, workspacePath = 'workspace';
    const project = { status: 'active', name: 'project' }, operation = 'paste', targetPaths = [];
    const normalizedDestination = '', nextName = '', refresh = () => {};
    ${body}
    return result;
  `);
  const decision = (token, allowReplace) => ({ success: true, count: 0, requiresDecision: {
    kind: 'paste-conflict', decisionToken: token, allowReplace, message: 'conflict', detail: 'details',
  } });
  const requests = [];
  const dialogs = [];
  const completed = await execute({
    result: decision('first', false),
    appDialog: { choice: async options => { dialogs.push(options); return 'keep-both'; } },
    projectWorkspaceClient: { projectFileOperation: async (...args) => {
      requests.push(args.at(-1));
      return requests.length === 1 ? decision('fresh', true) : { success: true, count: 2 };
    } },
  });
  assert.deepEqual(dialogs[0].choices.map(option => option.value), ['keep-both'], 'batch dialog excludes ambiguous replacement');
  assert.deepEqual(dialogs[1].choices.map(option => option.value), ['replace', 'keep-both']);
  assert.deepEqual(requests, [
    { pasteConflictPolicy: 'keep-both', decisionToken: 'first' },
    { pasteConflictPolicy: 'keep-both', decisionToken: 'fresh' },
  ], 'a fresh decision is shown again and its token is submitted');
  assert.equal(completed.count, 2);
  let cancelled = false;
  let reconciled = false;
  await execute({
    result: decision('cancel', false), appDialog: { choice: async () => null },
    projectWorkspaceClient: { projectFileOperation: async () => assert.fail('cancel must not paste') },
    reconcilePendingFileOperation: async () => { reconciled = true; },
    onNotice: () => { cancelled = true; },
  });
  assert.equal(cancelled, true);
  assert.equal(reconciled, true, 'cancel releases the pending operation in the renderer');
};

const run = async () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const testBase = path.join(os.tmpdir(), 'qingstudio-file-operation-tests');
  fs.mkdirSync(testBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(testBase, 'paste-batch-conflicts-'));
  const native = createFilePublicationService({ app: { isPackaged: false }, projectRoot: repositoryRoot });
  transfer.configureNativePublicationService(native);
  let fixtureIndex = 0;
  const fixture = ({ operation = 'copy', count = 2, existing = false, kinds = [], names = [], nested = false } = {}) => {
    const fixtureRoot = path.join(root, String(fixtureIndex++));
    const project = path.join(fixtureRoot, 'project');
    fs.mkdirSync(project, { recursive: true });
    if (nested) fs.mkdirSync(path.join(project, 'shared'));
    const sources = Array.from({ length: count }, (_, index) => {
      const parent = path.join(fixtureRoot, `source-${index}`);
      fs.mkdirSync(parent);
      const source = path.join(parent, names[index] || (nested ? 'shared' : 'same.txt'));
      if (kinds[index] === 'directory' || nested) {
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, nested ? 'same.txt' : 'child.txt'), `source ${index}`);
      } else fs.writeFileSync(source, `source ${index}`);
      return source;
    });
    if (existing) fs.writeFileSync(path.join(project, nested ? 'shared/same.txt' : 'same.txt'), 'existing');
    const handlers = new Map();
    const undo = [];
    let cleared = 0;
    registerFileOperationsIpc({
      Array, Boolean, Date, Error, Math, Promise, Set, String, process, crypto, fs, path, ...transfer, ...identity,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} },
      getProjectPath: () => project, ensureWorkspace: () => root,
      activeProjectFileOperations: new Map(), fileOperationState: { projectFileClipboard: null },
      readSystemFileClipboard: async () => ({ operation, sequence: 1, sources }),
      clearSystemFileClipboardIfCurrent: async () => { cleared++; return { cleared: true }; },
      writeLog: () => {}, pushUndoOperation: async entry => { undo.push(entry); },
    });
    return { project, sources, undo, cleared: () => cleared, paste: options => handlers.get('workspace-file-operation')(
      { sender: { isDestroyed: () => false, send: () => {} } }, root, 'active', 'project', 'paste', [], '', '', options,
    ) };
  };
  const preflight = async current => {
    const before = fs.readdirSync(current.project, { recursive: true });
    const result = await current.paste();
    assert.equal(result.success, true, result.error);
    assert.equal(result.requiresDecision?.kind, 'paste-conflict', 'batch collisions must ask before any publication');
    assert.equal(result.requiresDecision.allowReplace, false, 'batch collisions have no unambiguous replacement winner');
    assert.equal(result.count, 0);
    assert.deepEqual(fs.readdirSync(current.project, { recursive: true }), before, 'waiting or cancelling has no filesystem effects');
    assert(current.sources.every(source => fs.existsSync(source)), 'preflight preserves every source');
    assert.equal(current.undo.length, 0);
    assert.equal(current.cleared(), 0);
    return result.requiresDecision.decisionToken;
  };
  const keepBoth = async (current, token, count) => {
    const result = await current.paste({ pasteConflictPolicy: 'keep-both', decisionToken: token });
    assert.equal(result.success, true, result.error);
    assert.equal(result.requiresDecision, undefined);
    assert.equal(result.count, count);
    assert.equal(current.undo.length, 1);
    const publishedItems = result.createdItems || result.movedItems.map(item => ({ relativePath: item.destinationRelativePath }));
    const contents = publishedItems.map(item => {
      const target = path.join(current.project, item.relativePath);
      return fs.readFileSync(fs.statSync(target).isDirectory() ? path.join(target, 'child.txt') : target, 'utf8');
    }).sort();
    assert.deepEqual(contents, Array.from({ length: count }, (_, index) => `source ${index}`).sort());
    return result;
  };
  try {
    await testDecisionDialog(repositoryRoot);
    for (const operation of ['copy', 'cut']) for (const existing of [false, true]) {
      const current = fixture({ operation, existing });
      const token = await preflight(current);
      const refused = await current.paste({ pasteConflictPolicy: 'replace', decisionToken: token });
      assert.equal(refused.requiresDecision?.allowReplace, false, 'replace cannot bypass batch confirmation');
      assert.equal(current.undo.length, 0);
      await keepBoth(current, refused.requiresDecision.decisionToken, 2);
      assert.equal(current.sources.every(source => fs.existsSync(source)), operation === 'copy');
      if (existing) assert.equal(fs.readFileSync(path.join(current.project, 'same.txt'), 'utf8'), 'existing');
    }
    for (const options of [
      { count: 33 }, // Cached name allocator.
      { kinds: ['directory', 'directory'] },
      { kinds: ['directory', 'file'] },
      ...(process.platform === 'win32' ? [{ names: ['same.txt', 'SAME.TXT'] }] : []),
    ]) {
      const current = fixture(options);
      await keepBoth(current, await preflight(current), options.count || 2);
    }
    const nested = fixture({ nested: true });
    await keepBoth(nested, await preflight(nested), 2);
    assert.equal(fs.existsSync(path.join(nested.project, 'shared (1)')), false, 'merged folders detect conflicts at the child destination');

    const changed = fixture();
    const oldToken = await preflight(changed);
    fs.writeFileSync(changed.sources[0], 'changed source');
    const retry = await changed.paste({ pasteConflictPolicy: 'keep-both', decisionToken: oldToken });
    assert.equal(retry.requiresDecision?.kind, 'paste-conflict', 'changed sources require a fresh decision');
    assert.notEqual(retry.requiresDecision.decisionToken, oldToken);
    assert.deepEqual(fs.readdirSync(changed.project), []);
    assert.equal(changed.undo.length, 0);

    const ordinary = fixture({ count: 1, existing: true });
    const ordinaryDecision = await ordinary.paste();
    assert.equal(ordinaryDecision.requiresDecision.allowReplace, true, 'existing destination conflicts retain replace choice');
    const replacement = await ordinary.paste({ pasteConflictPolicy: 'replace', decisionToken: ordinaryDecision.requiresDecision.decisionToken });
    assert.equal(replacement.success, true, replacement.error);
    assert.equal(replacement.requiresDecision, undefined);
    assert.equal(fs.readFileSync(path.join(ordinary.project, 'same.txt'), 'utf8'), 'source 0');

    const distinct = fixture({ names: ['first.txt', 'second.txt'] });
    const distinctResult = await distinct.paste();
    assert.equal(distinctResult.success, true, distinctResult.error);
    assert.equal(distinctResult.requiresDecision, undefined, 'different target names do not ask');
    assert.equal(distinctResult.count, 2);
    console.log('Paste batch conflict tests passed');
  } finally {
    await native.stop();
    transfer.configureNativePublicationService(null);
    // Only remove this test's verified private fixture directory.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(testBase));
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
