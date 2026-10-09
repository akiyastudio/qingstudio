const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const translations = JSON.parse(fs.readFileSync(path.join(root, 'electron/locales/zh-CN.json'), 'utf8'));
const compile = relativePath => ts.transpileModule(
  fs.readFileSync(path.join(root, relativePath), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } },
).outputText;
const load = (source, localRequire) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'require', source)(module, module.exports, localRequire);
  return module.exports;
};
const model = load(compile('src/features/versioning/versioning-v2-model.ts'), require);
const panel = load(compile('src/features/versioning/VersionProgressPanel.tsx'), request => {
  if (request === './versioning-v2-model') return model;
  if (request === '../../components/ImportSourceControls') return { ImportSourceControls: () => null };
  if (request === '../../i18n/LocalizedText') return { LocalizedText: ({ value }) => value };
  if (request === '../../i18n/messages') return { renderText: value => value };
  if (request === '../../i18n/react') return { useLocale: () => undefined };
  if (request === '../../i18n/runtime') return { t: key => translations[key] || key };
  return require(request);
});

const draft = {
  mode: 'create', sourceRelativePath: '', displayName: '', mediaKind: 'image',
  relationKind: 'main', parentProgressId: '', versionKey: '1', versionKind: 'main',
  trackingEnabled: true, renameFromParent: false, copyMissingFromParent: false,
  workflowInputProgressIds: [],
};
const markup = renderToStaticMarkup(React.createElement(panel.VersionProgressPanel, {
  draft, folders: [], onChange() {}, onSubmit() {}, onClose() {},
}));
assert(markup.includes('独立根版本（无父版本）'));
const createButton = markup.match(/<button[^>]*>创建 V1<\/button>/)?.[0];
assert(createButton && !createButton.includes('disabled'), 'the first root version must be submittable without original material');
const trackingChecks = [...markup.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map(match => match[0]);
assert.equal(trackingChecks.length, 3);
assert(!trackingChecks[0].includes('disabled'), 'root tracking may be enabled');
assert(trackingChecks[1].includes('disabled') && trackingChecks[2].includes('disabled'), 'parent-only policies must be disabled on roots');
console.log('parentless version panel tests passed');
