const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Minimal DOM for real React effects; no application data or browser outputs.
class TestEventTarget {
  addEventListener() {}
  removeEventListener() {}
}
class TestNode extends TestEventTarget {
  constructor(nodeType, nodeName, ownerDocument) {
    super();
    Object.assign(this, { nodeType, nodeName, tagName: nodeName, ownerDocument, parentNode: null, childNodes: [], style: {}, attributes: new Map(), nodeValue: '' });
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  insertBefore(child, before) {
    child.parentNode = this;
    const index = this.childNodes.indexOf(before);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }
  removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.childNodes = []; if (value) this.appendChild(Object.assign(new TestNode(3, '#text', this.ownerDocument), { nodeValue: String(value) })); }
  querySelectorAll() { return []; }
  focus() {}
}
const testWindow = Object.assign(new TestEventTarget(), { HTMLElement: TestNode, HTMLIFrameElement: class {}, Node: TestNode, electronAPI: {
  onBackgroundTaskChanged: () => () => {},
  getBackgroundTasks: async () => ({ success: true, revision: 0, tasks: [] }),
} });
const testDocument = Object.assign(new TestEventTarget(), { nodeType: 9, nodeName: '#document', defaultView: testWindow, activeElement: null });
testDocument.createElement = name => new TestNode(1, name.toUpperCase(), testDocument);
testDocument.createElementNS = (_namespace, name) => new TestNode(1, name, testDocument);
testDocument.createTextNode = text => Object.assign(new TestNode(3, '#text', testDocument), { nodeValue: text });
testDocument.documentElement = testDocument.createElement('html');
testDocument.body = testDocument.createElement('body');
testWindow.document = testDocument;
Object.assign(global, { window: testWindow, document: testDocument, Node: TestNode, HTMLElement: TestNode, IS_REACT_ACT_ENVIRONMENT: true });

const React = require('react');
const { createRoot } = require('react-dom/client');
const rootPath = path.resolve(__dirname, '..');
const load = (relativePath, dependencies = {}) => {
  const source = fs.readFileSync(path.join(rootPath, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, { fileName: relativePath, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(loaded, loaded.exports, name => name in dependencies ? dependencies[name] : require(name));
  return loaded.exports;
};
const sessionModel = load('src/features/background-tasks/panel-task-session-model.ts');
const toastModel = load('src/features/background-tasks/task-toast-model.ts');
const streamModel = load('src/features/background-tasks/background-task-stream-model.ts', { './task-toast-model': toastModel });
const taskCenter = load('src/features/background-tasks/TaskCenter.tsx', {
  '../../platform/workspace-window-client': { workspaceWindowContext: () => null },
  './panel-task-session-model': sessionModel,
  './task-toast-model': toastModel,
  './background-task-stream-model': streamModel,
});
const { ToolModal } = load('src/features/workspace/ProjectToolModal.tsx', {
  '../../i18n/LocalizedText': { LocalizedText: ({ value }) => React.createElement('span', null, value) },
  '../../i18n/react': { useLocale: () => {} },
  '../../i18n/runtime': { t: key => key },
  'lucide-react': new Proxy({}, { get: (_target, name) => name === '__esModule' ? true : () => React.createElement('i') }),
  '../../components/LayerProvider': { useEscapeLayer: () => {} },
  '../background-tasks/TaskCenter': taskCenter,
  '../background-tasks/panel-task-session-model': sessionModel,
});
let center;
const Probe = () => { center = taskCenter.useTaskCenter(); return null; };
const pageId = 'page-fixture';
const importKey = sessionModel.panelTaskSessionKey(pageId, 'negative-import');
const brollKey = sessionModel.panelTaskSessionKey(pageId, 'broll');
const tree = (busy, open = true, brollBusy = true) => React.createElement(taskCenter.TaskCenterProvider, null,
  React.createElement(Probe),
  React.createElement(ToolModal, { ownerPageId: pageId, panelKind: 'negative-import', title: 'Import', busy, open, onClose: () => {} }),
  React.createElement(ToolModal, { ownerPageId: pageId, panelKind: 'broll', title: 'B-roll', busy: brollBusy, open: false, onClose: () => {} }),
);

(async () => {
  const container = testDocument.createElement('div');
  const root = createRoot(container);
  const render = async (...args) => React.act(async () => { root.render(tree(...args)); });
  try {
    await render(true);
    assert.equal(center.panelTasks[importKey]?.state, 'running', 'an import publishes its busy session');
    await React.act(async () => { center.dismissPanelTask(importKey); });
    assert.equal(center.panelTasks[importKey]?.state, 'running', 'manual clearing must retain a live import');

    await render(true, false);
    assert.equal(center.panelTasks[importKey]?.state, 'running', 'minimizing the panel must retain a live import');
    await render(false, false);
    assert.equal(center.panelTasks[importKey], undefined, 'finishing while minimized must remove the running busy mirror');
    assert.equal(center.panelTasks[brollKey]?.state, 'running', 'finishing one panel must preserve other live tasks');

    await render(true, false);
    assert.equal(center.panelTasks[importKey]?.state, 'running', 'a later import can reuse the same panel');
    await render(false, true, false);
    assert.equal(center.panelTasks[importKey], undefined, 'finishing or cancelling with the panel open must remove its busy mirror');
    assert.equal(center.panelTasks[brollKey], undefined);
    await render(false, false, false);
    assert.equal(Object.keys(center.panelTasks).length, 0, 'closing an idle panel must not recreate a ghost task');
    console.log('Tool modal busy session lifecycle tests passed');
  } finally { await React.act(async () => { root.unmount(); }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
