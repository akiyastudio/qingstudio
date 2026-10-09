const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerSelectionIpc } = require('../electron/modules/selection-ipc.cjs');
const { createWorkspaceService } = require('../electron/services/workspace-service.cjs');
const { createSelectionService } = require('../electron/services/selection-service.cjs');
const { assertInside, assertExistingInside } = require('../electron/services/file-transfer-service.cjs');

const run = async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-selection-paths-'));
  try {
    const workspaceRoot = path.join(temporaryRoot, 'workspace');
    fs.mkdirSync(workspaceRoot);
    const catalog = { projects: [], byName: new Map() };
    const catalogs = new Map([[workspaceRoot, catalog]]);
    const workspaceService = createWorkspaceService({ repository: {}, catalogs, assertInside, assertExistingInside });
    const addProject = (name, relativePath, extra = {}) => {
      const row = { name, status: '后期中', relative_path: relativePath, extra_json: JSON.stringify(extra) };
      catalog.projects.push(row);
      catalog.byName.set(name.toLocaleLowerCase(), row);
      return row;
    };
    const putSource = root => {
      fs.mkdirSync(path.join(root, 'RAW'), { recursive: true });
      fs.writeFileSync(path.join(root, 'RAW', 'IMG_9701.JPG'), 'synthetic selection fixture');
    };
    const realSelection = createSelectionService({
      fs, crypto, versionService: { listProgress: async () => ({ success: true, progressFolders: [] }) },
      imageExtensions: new Set(['.jpg']), rawExtensions: new Set(['.cr3']), videoExtensions: new Set(['.mov']),
    });
    const executionRequests = [];
    const execute = async request => { executionRequests.push(request); return { success: true }; };
    const handlers = new Map();
    registerSelectionIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, path, fs,
      workspaceCatalogs: catalogs, getProjectPath: workspaceService.getProjectPath,
      selectionService: { ...realSelection, executeManual: execute, executeFilename: execute },
    });
    const request = {
      sourceFolderRelativePath: 'RAW', relativePaths: ['RAW/IMG_9701.JPG'], keywords: '9701',
      workspaceRoot: temporaryRoot, projectRoot: temporaryRoot, projectName: 'untrusted-renderer-value',
    };
    const channels = [
      'workspace-selection-manual-preflight', 'workspace-selection-filename-preflight',
      'workspace-selection-source-folders', 'workspace-selection-manual-execute', 'workspace-selection-filename-execute',
    ];
    const assertAllowed = async (root, name) => {
      for (const channel of channels) {
        const result = await handlers.get(channel)(null, root, request);
        assert.equal(result.success, true, `${name}: ${channel}: ${result.error}`);
        if (channel.endsWith('preflight')) assert.equal(result.matchedCount, 1);
      }
      for (const captured of executionRequests.splice(0)) {
        assert.equal(captured.workspaceRoot, workspaceRoot, 'renderer cannot override the registered workspace');
        assert.equal(captured.projectRoot, root, 'execution receives the authorized project root');
        assert.equal(captured.projectName, name, 'renderer cannot override the registered project name');
      }
    };
    const assertDenied = async (root, description, errorPattern) => {
      for (const channel of channels) {
        const result = await handlers.get(channel)(null, root, request);
        assert.equal(result.success, false, `${description}: ${channel}`);
        if (errorPattern) assert.match(result.error, errorPattern);
      }
      assert.equal(executionRequests.length, 0, 'denied roots must never reach execution');
    };

    const ordinaryRoot = path.join(workspaceRoot, 'Ordinary');
    putSource(ordinaryRoot);
    addProject('Ordinary', 'Ordinary');
    await assertAllowed(ordinaryRoot, 'Ordinary');

    const externalRoot = path.join(temporaryRoot, 'external');
    putSource(externalRoot);
    const referenceRoot = fs.realpathSync(externalRoot);
    const referenceRow = addProject('Referenced', referenceRoot, { importMode: 'reference' });
    await assertAllowed(referenceRoot, 'Referenced');
    referenceRow.extra_json = '{}';
    await assertDenied(referenceRoot, 'absolute registration without reference authorization');
    referenceRow.extra_json = JSON.stringify({ importMode: 'reference' });

    const archiveStorage = path.join(temporaryRoot, 'archive-storage');
    putSource(archiveStorage);
    const archiveRoot = path.join(workspaceRoot, 'Archived');
    fs.symlinkSync(archiveStorage, archiveRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const archiveRow = addProject('Archived', 'Archived', { archive: { path: archiveStorage } });
    await assertAllowed(archiveRoot, 'Archived');
    archiveRow.extra_json = JSON.stringify({ archive: { path: referenceRoot } });
    await assertDenied(archiveRoot, 'archive link target differs from registration', /链接目标.*不一致/);
    archiveRow.extra_json = '{}';
    await assertDenied(archiveRoot, 'ordinary project link escapes workspace');

    const unregisteredRoot = path.join(temporaryRoot, 'unregistered');
    putSource(unregisteredRoot);
    await assertDenied(unregisteredRoot, 'unregistered external directory', /未在当前工作区登记/);
    const offlineRoot = path.join(temporaryRoot, 'offline-reference');
    addProject('Offline', offlineRoot, { importMode: 'reference' });
    await assertDenied(offlineRoot, 'offline reference', /离线/);

    console.log('selection project authorization: passed (ordinary, reference, archive, tampered links, unregistered, offline)');
  } finally {
    const relative = path.relative(os.tmpdir(), temporaryRoot);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

run().catch(error => { console.error(error); process.exitCode = 1; });
