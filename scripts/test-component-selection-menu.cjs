const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');
const { ComponentViewManager } = require('../electron/services/component-view-manager.cjs');

const exportsModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync('src/features/components/component-contribution-scope-model.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: exportsModule, exports: exportsModule.exports });
const { componentContributionAcceptsSelection: accepts, componentFileHandlerForEntry: handlerFor } = exportsModule.exports;
const archive = { kind: 'file', relativePath: 'folder/FILE.ZIP' }, image = { kind: 'image', relativePath: 'folder/a.jpg' }, folder = { kind: 'folder', relativePath: 'folder/nested' };
const manifest = JSON.parse(fs.readFileSync('scripts/fixtures/file-tools-component.json', 'utf8'));
const unzip = manifest.componentHost.contributions.find(item => item.id === 'extract-panel'), add = manifest.componentHost.contributions.find(item => item.id === 'add');
assert.equal(accepts(unzip, []), false);
assert.equal(accepts(unzip, [archive]), true);
assert.equal(accepts(unzip, [image]), false);
assert.equal(accepts(unzip, [archive, image]), false);
assert.equal(accepts(unzip, [{ ...archive, relativePath: 'folder/archive.7z.001' }]), true);
assert.equal(accepts(add, [image, folder]), true);
assert.equal(accepts(add, [archive]), false);
assert.equal(accepts(add, [{ ...folder, viaShortcut: true }]), false);
assert.equal(accepts(add, [{ ...image, readOnly: true }]), false);
assert.equal(accepts({ selection: { minCount: 1, maxCount: 1 } }, [image, folder]), false);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-menu-contract-'));
try {
  fs.mkdirSync(path.join(root, 'ui')); fs.writeFileSync(path.join(root, 'ui', 'index.html'), '<!doctype html>'); fs.writeFileSync(path.join(root, 'service.cjs'), ''); fs.writeFileSync(path.join(root, 'ui', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const descriptor = parseComponentHostManifest(manifest, root);
  const listed = ComponentViewManager.prototype.listContributions.call({ registry: { list: () => [descriptor] } });
  assert.equal(listed.find(item => item.contributionId === 'add').contextMenu, 'root');
  assert.deepEqual(listed.find(item => item.contributionId === 'extract-panel').selection.extensions, unzip.selection.extensions);
  const handler = listed.find(item => item.contributionId === 'browse');
  assert.deepEqual(handler.fileHandler.extensions, unzip.selection.extensions);
  assert(handler.iconUrl.startsWith('photoflow-component://icon/file-tools-fixture'));
  assert.equal(handlerFor(listed, archive), handler);
  assert.equal(handlerFor([], archive), undefined, 'uninstalling or disabling removes handling and icons');
  assert.equal(handlerFor(listed, image), undefined);
  assert.equal(handlerFor(listed, { ...archive, viaShortcut: true }), undefined);
  for (const fileHandler of [{ extensions: ['ZIP'] }, { extensions: [] }, { extensions: ['.zip'], unknown: true }, null]) {
    const invalid = structuredClone(manifest); invalid.componentHost.contributions.find(item => item.id === 'browse').fileHandler = fileHandler;
    assert.throws(() => parseComponentHostManifest(invalid, root), /fileHandler/);
  }
  const placedHandler = structuredClone(manifest); const placedBrowse = placedHandler.componentHost.contributions.find(item => item.id === 'browse'); placedBrowse.placement = 'workspace.folderPanel'; delete placedBrowse.contextMenu;
  assert.throws(() => parseComponentHostManifest(placedHandler, root), /fileHandler/);
  for (const selection of [{ minCount: 2, maxCount: 1 }, { extensions: ['ZIP'] }, { kinds: ['unknown'] }, { extra: true }, []]) {
    const invalid = structuredClone(manifest); invalid.componentHost.contributions[1].selection = selection;
    assert.throws(() => parseComponentHostManifest(invalid, root));
  }
  const invalid = structuredClone(manifest); invalid.componentHost.contributions[1].contextMenu = 'unknown';
  assert.throws(() => parseComponentHostManifest(invalid, root));
  const workspace = fs.readFileSync('src/features/workspace/ProjectWorkspace.tsx', 'utf8');
  assert(workspace.includes('componentContributionAcceptsSelection(contribution, contextMenu ? fileMenuEntries : selectedEntries)'));
  assert(workspace.includes("item.type === 'component.sidePanel' && item.contextMenu === 'root'"));
  assert(workspace.includes("item.contextMenu !== 'none' && item.contextMenu !== 'root'"), 'root actions cannot also appear in grouped context menus');
  console.log('Generic component selection filters, root menus and registry transport tests passed.');
} finally { if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('photoflow-menu-contract-')) fs.rmSync(root, { recursive: true, force: true }); }
