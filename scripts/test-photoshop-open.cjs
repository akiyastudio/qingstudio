const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerEntryUtilityIpc } = require('../electron/modules/workspace/entry-utility-ipc.cjs');
const workspaceRoot = path.resolve(__dirname, '../src/features/workspace');

test('mounted Photoshop action opens PSD/PSB, images and RAW; reports launch errors', async () => {
  const workspaceSource = fs.readFileSync(path.join(workspaceRoot, 'ProjectWorkspace.tsx'), 'utf8');
  const action = workspaceSource.slice(workspaceSource.indexOf('const openProjectEntriesInPhotoshop'), workspaceSource.indexOf('const copyEntryPath'));
  const metadataSource = fs.readFileSync(path.join(workspaceRoot, 'project-workspace-media-metadata.ts'), 'utf8');
  const predicate = metadataSource.match(/export const isPhotoshopOpenEntry = ([\s\S]*?);/)[1];
  const isPhotoshopOpenEntry = new Function('PHOTOSHOP_DOCUMENT_EXTENSIONS', `return ${predicate.replace('(entry: ProjectFileEntry)', '(entry)')}`)(new Set(['.psd', '.psb']));
  const calls = [], notices = [];
  let result = { success: true };
  const openPhotoshop = new Function('isPhotoshopOpenEntry', 'projectWorkspaceClient', 'workspacePath', 'project', 'onNotice', `${action.replace('entries: ProjectFileEntry[]', 'entries')}; return openProjectEntriesInPhotoshop;`)(isPhotoshopOpenEntry, {
    openProjectEntriesInPhotoshop: async (...args) => { calls.push(args); return result; },
  }, 'C:/workspace', { status: 'active', name: 'Test' }, message => notices.push(message));
  const entries = [
    { kind: 'file', extension: '.PSD', relativePath: '精修/设计.PSD' },
    { kind: 'file', extension: '.psb', relativePath: '精修/大型.psb' },
    { kind: 'image', extension: '.jpg', relativePath: '照片.jpg' },
    { kind: 'raw', extension: '.cr3', relativePath: '原片.cr3' },
    { kind: 'file', extension: '.txt', relativePath: '备注.txt' },
  ];
  await openPhotoshop(entries);
  assert.deepEqual(calls[0], ['C:/workspace', 'active', 'Test', ['精修/设计.PSD', '精修/大型.psb', '照片.jpg', '原片.cr3']]);
  await openPhotoshop([entries[4]]);
  assert.equal(calls.length, 1);
  assert.deepEqual(notices, []);
  result = { success: false, error: '未检测到 Photoshop' };
  await openPhotoshop([entries[0]]);
  assert.deepEqual(notices, ['用 Photoshop 打开失败：未检测到 Photoshop']);
  const previewPane = fs.readFileSync(path.join(workspaceRoot, 'MediaPreviewPane.tsx'), 'utf8');
  assert(previewPane.includes('photoshopAvailable && isPhotoshopOpenEntry(entry)'), 'preview button must accept PSD/PSB');
});

test('host passes both document paths to Photoshop with intact Unicode and spaces', async () => {
  const handlers = new Map(), launches = [];
  let unreferenced = false;
  const root = path.resolve('C:/workspace/Test');
  registerEntryUtilityIpc({
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    findLatestPhotoshop: async () => 'C:/Program Files/Adobe/Photoshop.exe',
    path, getProjectPath: () => root,
    resolveToolSource: (projectRoot, relativePath) => ({ physicalPath: path.resolve(projectRoot, relativePath) }),
    fs: { statSync: () => ({ isFile: () => true }) },
    spawn: (executable, targets, options) => {
      launches.push({ executable, targets, options });
      const child = new EventEmitter();
      child.unref = () => { unreferenced = true; };
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
  });
  const result = await handlers.get('workspace-open-entry-photoshop')(null, 'C:/workspace', 'active', 'Test', ['精修/设计 文件.PSD', '精修/大型文件.psb']);
  assert.deepEqual(result, { success: true, count: 2 });
  assert.deepEqual(launches[0].targets, [path.join(root, '精修/设计 文件.PSD'), path.join(root, '精修/大型文件.psb')]);
  assert.equal(unreferenced, true);
});
