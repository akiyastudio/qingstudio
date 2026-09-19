const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseComponentHostManifest } = require('../electron/component-host-contract.cjs');

const { inspectDevelopmentComponent } = require('../electron/component-development.cjs');
const repositoryRoot = path.resolve(__dirname, '..');
const examplesRoot = path.join(repositoryRoot, 'examples');
const expectations = {
  'declarative-settings': {
    capabilities: ['component.settings'],
    permissions: ['component.settings'],
  },
  'hello-component': {
    capabilities: ['project.media.page'],
    permissions: ['project.media.read'],
  },
  'host-api': {
    capabilities: [],
    permissions: [],
  },
  'panel-only': {
    capabilities: [],
    permissions: [],
  },
  'project-read': {
    capabilities: ['project.files.page'],
    permissions: ['project.files.read'],
  },
  'project-write': {
    capabilities: ['project.media.ratings.write'],
    permissions: ['project.media.ratings.write'],
  },
};

const exampleNames = fs.readdirSync(examplesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(examplesRoot, entry.name, 'component.json')))
  .map(entry => entry.name)
  .sort();

assert.deepEqual(exampleNames, Object.keys(expectations).sort(), 'examples/README.md and the example contract test must cover every component example');
for (const removedName of ['host-api-v7', 'panel-only-v7', 'project-read-v7', 'project-write-v7']) {
  assert(!fs.existsSync(path.join(examplesRoot, removedName)), `legacy Host API example directory must stay removed: ${removedName}`);
}

const legacyHostApiName = /\.v7\b|\bHost API V7\b|\bHost API 7\b|component-(?:input|media):v7:/i;

for (const name of exampleNames) {
  const root = path.join(examplesRoot, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
  const descriptor = parseComponentHostManifest(manifest, root);
  const expectation = expectations[name];
  assert.equal(inspectDevelopmentComponent(root).id, manifest.id, `${name} source registration`);

  assert.deepEqual(descriptor.service.capabilities, expectation.capabilities, `${name} declares only its documented Host capabilities`);
  assert(descriptor.service.capabilities.every(capability => !/\.v\d+$/.test(capability)), `${name} uses unversioned Host capability names`);
  assert.deepEqual(descriptor.service.permissions, expectation.permissions, `${name} declares only the matching permissions`);
  assert(fs.existsSync(path.join(root, 'service.cjs')), `${name} includes its service entrypoint`);
  assert(fs.existsSync(path.join(root, 'ui', 'index.html')), `${name} includes its UI entrypoint`);

  const serviceSource = fs.readFileSync(path.join(root, 'service.cjs'), 'utf8');
  const exampleText = fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:json|cjs|mjs|js|html|css|md)$/i.test(entry.name))
    .map(entry => fs.readFileSync(path.join(entry.parentPath || entry.path, entry.name), 'utf8'))
    .join('\n');
  assert(!legacyHostApiName.test(exampleText), `${name} contains no legacy Host API V7 names`);
  for (const method of descriptor.service.rpcMethods) {
    assert(serviceSource.includes(method), `${name} implements declared RPC ${method}`);
  }
}

const examplesReadme = fs.readFileSync(path.join(examplesRoot, 'README.md'), 'utf8');
for (const name of exampleNames) assert(examplesReadme.includes(`\`${name}\``), `examples/README.md documents ${name}`);
assert(!legacyHostApiName.test(examplesReadme), 'examples/README.md contains no legacy Host API V7 names');

console.log('Component example manifests, least-privilege declarations, entrypoints, RPCs, and index passed');
