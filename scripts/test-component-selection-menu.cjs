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
const { componentContributionAcceptsSelection: accepts } = exportsModule.exports;
const archive = { kind: 'file', relativePath: 'folder/FILE.ZIP' }, image = { kind: 'image', relativePath: 'folder/a.jpg' }, folder = { kind: 'folder', relativePath: 'folder/nested' };
const manifest = {
  "apiVersion": 1,
  "id": "menu-fixture",
  "version": "1.0.0",
  "componentHost": {
    "contractVersion": 2,
    "contributions": [
      {
        "type": "component.fullPage",
        "id": "panel-ui",
        "title": "Menu fixture",
        "entry": "ui/index.html"
      },
      {
        "type": "component.sidePanel",
        "id": "extract-panel",
        "label": "Extract",
        "pageId": "panel-ui",
        "placement": "workspace.officeTools",
        "contextMenu": "none",
        "selection": {
          "minCount": 1,
          "kinds": [
            "file"
          ],
          "extensions": [
            ".zip",
            ".7z",
            ".rar",
            ".001",
            ".tar",
            ".gz",
            ".bz2",
            ".xz"
          ]
        },
        "rpcMethods": [
          "sample.context.v1",
          "sample.media-page.v1"
        ]
      },
      {
        "type": "component.sidePanel",
        "id": "add",
        "label": "Create archive",
        "pageId": "panel-ui",
        "contextMenu": "root",
        "selection": {
          "minCount": 1,
          "kinds": [
            "file",
            "folder",
            "image",
            "raw",
            "video"
          ],
          "excludedExtensions": [
            ".zip",
            ".7z",
            ".rar",
            ".001",
            ".tar",
            ".gz",
            ".bz2",
            ".xz"
          ]
        },
        "rpcMethods": [
          "sample.context.v1",
          "sample.media-page.v1"
        ]
      }
    ],
    "service": {
      "protocolVersion": 1,
      "runtime": "node",
      "entrypoints": {
        "default": "service.cjs"
      },
      "rpcMethods": [
        "sample.context.v1",
        "sample.media-page.v1"
      ],
      "capabilities": [
        "project.media.page"
      ],
      "permissions": [
        "project.media.read"
      ],
      "events": []
    }
  }
};
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
  fs.mkdirSync(path.join(root, 'ui')); fs.writeFileSync(path.join(root, 'ui', 'index.html'), '<!doctype html>'); fs.writeFileSync(path.join(root, 'service.cjs'), '');
  const descriptor = parseComponentHostManifest(manifest, root);
  const listed = ComponentViewManager.prototype.listContributions.call({ registry: { list: () => [descriptor] } });
  assert.equal(listed.find(item => item.contributionId === 'add').contextMenu, 'root');
  assert.deepEqual(listed.find(item => item.contributionId === 'extract-panel').selection.extensions, unzip.selection.extensions);
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
