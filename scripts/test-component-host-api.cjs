const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Ajv = require('ajv');
const { parseComponentHostManifest, HOST_CAPABILITIES, CAPABILITY_PERMISSIONS } = require('../electron/component-host-contract.cjs');
const { ComponentCapabilityBroker } = require('../electron/services/component-capability-broker.cjs');
const { registerComponentProjectCapabilities, resetComponentHostCapabilityStateForTest, stableUuid, STAGE_TTL_MS } = require('../electron/services/component-project-capabilities.cjs');
const { createServiceHostClient } = require('../component-sdk/service.cjs');
const { createMediaRepository } = require('../electron/domains/media/public.cjs');
const { createVersionService } = require('../electron/services/version-service.cjs');
const { registerHostCapabilities } = require('../electron/modules/system-ipc.cjs');

const systemCapabilityRegistrations = [];
registerHostCapabilities({ register: (method, handler) => systemCapabilityRegistrations.push([method, handler]) }, [
  ['component.lifecycle', () => undefined],
]);
assert.deepEqual(systemCapabilityRegistrations.map(([method]) => method), ['component.lifecycle'], 'system IPC registers the supported lifecycle capability');
assert.throws(() => registerHostCapabilities({ register: () => assert.fail('undeclared capability reached the broker') }, [
  ['component.lifecycle.invalid', () => undefined],
]), /undeclared host capability/, 'system IPC capability registration is constrained by the Host contract');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-host-'));
// Some Host drains use unref'ed deadline timers. Keep the test process alive
// until the entire async suite finishes instead of silently exiting mid-suite.
const testDeadline = setTimeout(() => { throw new Error('Component Host API integration test timed out before completion'); }, 30000);
const workspaceRoot = path.join(sandbox, 'workspace');
const projectRoot = path.join(workspaceRoot, 'active', 'Project');
const dataRoot = path.join(workspaceRoot, '.data');
const componentDataDirectoryRoot = path.join(sandbox, 'component-data', 'fixture-component');
const imagePath = path.join(projectRoot, 'images', 'one.jpg');
const externalRoot = path.join(sandbox, 'outside-project');
const externalImagePath = path.join(externalRoot, 'outside.jpg');
const configPath = path.join(sandbox, 'config.json');
fs.mkdirSync(path.dirname(imagePath), { recursive: true });
fs.mkdirSync(dataRoot, { recursive: true });
fs.writeFileSync(imagePath, Buffer.from('jpeg-fixture'));
fs.mkdirSync(externalRoot, { recursive: true });
fs.writeFileSync(externalImagePath, Buffer.from('external-jpeg-fixture'));
fs.writeFileSync(configPath, '{}');

const calls = [];
const bundle = {
  photo: { id: 'photo-1', projectId: 'project-1', originalName: 'one.jpg' },
  versions: [{ id: 'version-1', photoId: 'photo-1', filePath: imagePath, isCurrent: true }],
};
const externalBundle = { photo: { id: 'photo-external', projectId: 'project-1', originalName: 'outside.jpg' }, versions: [{ id: 'version-external', photoId: 'photo-external', filePath: externalImagePath, isCurrent: true }] };
const secondImagePath = path.join(projectRoot, 'images', 'two.jpg');
fs.writeFileSync(secondImagePath, Buffer.from('second-local-jpeg-fixture'));
const secondBundle = { photo: { id: 'photo-2', projectId: 'project-1', originalName: 'two.jpg' }, versions: [{ id: 'version-2', photoId: 'photo-2', filePath: secondImagePath, isCurrent: true }] };
const bundles = new Map([['photo-1', bundle], ['photo-2', secondBundle], ['photo-external', externalBundle]]);
const databaseClient = {
  call: async (_root, action, payload) => {
    calls.push({ action, payload });
    if (action === 'media_get_photo') return bundles.get(String(payload.photoId));
    if (action === 'media_get') return path.resolve(payload.filePath) === path.resolve(externalImagePath) ? externalBundle : bundle;
    if (action === 'progress_list') return { success: true, progressFolders: [{ id: 'progress-original', mediaKind: 'image', nodeRole: 'original', folderPath: projectRoot }], edges: [] };
    if (action === 'progress_register_with_graph') return { success: true, progressFolder: { id: 'progress-created', mediaKind: payload.progress.mediaKind, nodeRole: 'progress', folderPath: payload.progress.folderPath, sourceMetadata: payload.progress.sourceMetadata }, edges: [{ id: 'edge-created', sourceProgressId: payload.progress.parentProgressId, targetProgressId: 'progress-created' }] };
    if (action === 'progress_relation_update') return { success: true, childProgressId: payload.childProgressId, parentProgressId: payload.parentProgressId };
    if (action === 'media_create_version') {
      const target = bundles.get(String(payload.photoId));
      if (!(target.versions || []).some(item => item.id === payload.versionId)) target.versions.push({ id: payload.versionId, photoId: payload.photoId, parentVersionId: payload.parentVersionId, filePath: payload.filePath, isCurrent: true });
      return { success: true, created: payload, ...target };
    }
    throw new Error(`Unexpected media repository action: ${action}`);
  },
  stop() {},
};
const repository = createMediaRepository(databaseClient);
const versionService = createVersionService({ repository });
assert.equal(typeof versionService.createVersion, 'function');
assert.equal(versionService.completeTeamIdentity, undefined, 'the production media repository composition exposes only generic version operations');
assert.equal(versionService.listComponentPrivateRows, undefined, 'the production media repository composition must not expose component-owned tables');

const manifestRoot = path.join(sandbox, 'manifest');
fs.mkdirSync(path.join(manifestRoot, 'ui'), { recursive: true });
fs.writeFileSync(path.join(manifestRoot, 'ui', 'index.html'), '<!doctype html>');
fs.writeFileSync(path.join(manifestRoot, 'ui', 'settings.html'), '<!doctype html>');
fs.writeFileSync(path.join(manifestRoot, 'service.cjs'), '');
const coreCapabilities = [...HOST_CAPABILITIES].slice(0, 13);
const allPermissions = [...new Set(coreCapabilities.map(capability => CAPABILITY_PERMISSIONS[capability])), 'component.lifecycle.manage'];
const manifest = {
  apiVersion: 1, id: 'fixture-component', version: '1.0.0',
  componentHost: {
    contractVersion: 2,
    adoptionGrants: ['component.storage.previous.v1', 'project.output.existing.v1'],
    contributions: [
      { type: 'workspace.toolbarAction', id: 'open', label: 'Fixture', pageId: 'main' },
      { type: 'component.fullPage', id: 'main', title: 'Fixture', entry: 'ui/index.html' },
      { type: 'application.settingsPage', id: 'settings', label: 'Fixture settings', title: 'Fixture settings page', entry: 'ui/settings.html', rpcMethods: ['fixture.settings.v1'] },
    ],
    service: {
      protocolVersion: 1, runtime: 'node', entrypoints: { default: 'service.cjs' }, rpcMethods: ['fixture.run.v1', 'fixture.settings.v1'],
      capabilities: coreCapabilities, permissions: allPermissions, events: ['fixture.progress.v1'], runtimeActions: [],
    },
  },
};
const descriptor = parseComponentHostManifest(manifest, manifestRoot);
assert.throws(() => parseComponentHostManifest({ ...manifest, apiVersion: 2 }, manifestRoot), /manifest apiVersion/);
const { apiVersion: _manifestApiVersion, ...missingManifestApiVersion } = manifest;
assert.throws(() => parseComponentHostManifest(missingManifestApiVersion, manifestRoot), /manifest apiVersion/);
const restoreManifest = structuredClone(manifest);
restoreManifest.componentHost.service.rpcMethods.push('fixture.restore.workspace.v1');
restoreManifest.componentHost.service.backupRestore = { transactionProtocolVersion: 1, sourceManifestProtocolVersion: 1, receiptProtocolVersion: 1, workspace: { method: 'fixture.restore.workspace.v1' }, sources: [{ scope: 'component-storage', path: 'fixture-component/storage.sqlite3', format: 'fixture-v1' }] };
const restoreDescriptor = parseComponentHostManifest(restoreManifest, manifestRoot);
assert.equal(restoreDescriptor.service.backupRestore.sources[0].path, 'fixture-component/storage.sqlite3');
assert.deepEqual(restoreDescriptor.service.hostOnlyRpcMethods, ['fixture.restore.workspace.v1'], 'restore hooks are explicitly host-only service methods');
const duplicateRestoreHook = structuredClone(restoreManifest); duplicateRestoreHook.componentHost.service.backupRestore.project = { method: 'fixture.restore.workspace.v1' };
assert.throws(() => parseComponentHostManifest(duplicateRestoreHook, manifestRoot), /hook methods must be unique/);
const settingsExposeRestore = structuredClone(restoreManifest); settingsExposeRestore.componentHost.contributions.find(item => item.type === 'application.settingsPage').rpcMethods.push('fixture.restore.workspace.v1');
assert.throws(() => parseComponentHostManifest(settingsExposeRestore, manifestRoot), /host-only RPC method/);
const contributionExposeRestore = structuredClone(restoreManifest); contributionExposeRestore.componentHost.contributions.push({ type: 'application.command', id: 'restore', label: 'Restore', pageId: 'main', rpcMethods: ['fixture.restore.workspace.v1'] });
assert.throws(() => parseComponentHostManifest(contributionExposeRestore, manifestRoot), /host-only RPC method/);
for (const forbiddenDatabase of ['operations.sqlite3', 'media.sqlite3', 'versioning.sqlite3', 'other-component.sqlite3']) {
  const maliciousRestore = structuredClone(restoreManifest); maliciousRestore.componentHost.service.backupRestore.sources = [{ scope: 'domain-database', path: forbiddenDatabase, format: 'stolen-v1' }];
  assert.throws(() => parseComponentHostManifest(maliciousRestore, manifestRoot), /domain database source is not owned/, `a component cannot claim ${forbiddenDatabase}`);
}
const backslashRestoreManifest = structuredClone(restoreManifest); backslashRestoreManifest.componentHost.service.backupRestore.sources[0].path = 'fixture-component\\storage.sqlite3';
assert.throws(() => parseComponentHostManifest(backslashRestoreManifest, manifestRoot), /Invalid component backup restore source/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, service: { ...manifest.componentHost.service, capabilities: [...coreCapabilities, ' notifications'] } } }, manifestRoot), /exact and unique/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, service: { ...manifest.componentHost.service, permissions: [...allPermissions, allPermissions[0]] } } }, manifestRoot), /exact and unique/);
for (let legacyVersion = 2; legacyVersion <= 6; legacyVersion += 1) {
  const legacyMethod = `project.media.page.v${legacyVersion}`;
  assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, service: { ...manifest.componentHost.service, capabilities: [legacyMethod], permissions: ['project.media.read'] } } }, manifestRoot), /unknown host capability/);
}
assert.deepEqual(descriptor.settingsPages.map(page => ({ id: page.id, label: page.label, relativeEntry: page.relativeEntry, rpcMethods: page.rpcMethods })), [{ id: 'settings', label: 'Fixture settings', relativeEntry: 'ui/settings.html', rpcMethods: ['fixture.settings.v1'] }]);
assert.deepEqual(descriptor.service.permissions, allPermissions);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: manifest.componentHost.contributions.map(item => item.type === 'application.settingsPage' ? { ...item, rpcMethods: ['fixture.undeclared.v1'] } : item) } }, manifestRoot), /not declared by the service/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: manifest.componentHost.contributions.map(item => item.type === 'application.settingsPage' ? { ...item, entry: '..\/escape.html' } : item) } }, manifestRoot), /escapes component root/);
for (const invalid of [
  { id: 42 }, { id: ' settings' }, { label: 42 }, { label: ` ${'x'.repeat(80)}` }, { title: { bad: true } }, { title: 'Fixture ' }, { entry: ' ui/settings.html' }, { entry: `${'x'.repeat(513)}` }, { rpcMethods: 'fixture.settings.v1' }, { rpcMethods: [] },
  { rpcMethods: [' fixture.settings.v1'] }, { rpcMethods: [`${'x'.repeat(129)}.v1`] },
  { rpcMethods: ['fixture.settings.v1', 'fixture.settings.v1'] }, { rpcMethods: ['fixture.settings.v1', 3] },
  { rpcMethods: Array.from({ length: 33 }, (_value, index) => `fixture.settings-${index}.v1`) },
]) assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: manifest.componentHost.contributions.map(item => item.type === 'application.settingsPage' ? { ...item, ...invalid } : item), service: { ...manifest.componentHost.service, rpcMethods: [...manifest.componentHost.service.rpcMethods, ...Array.from({ length: 33 }, (_value, index) => `fixture.settings-${index}.v1`)] } } }, manifestRoot), /settings page/);
const outsideSettingsRoot = path.join(sandbox, 'outside-settings');
fs.mkdirSync(outsideSettingsRoot, { recursive: true }); fs.writeFileSync(path.join(outsideSettingsRoot, 'settings.html'), '<!doctype html>');
const linkedSettings = path.join(manifestRoot, 'linked-settings');
try {
  fs.symlinkSync(outsideSettingsRoot, linkedSettings, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, contributions: manifest.componentHost.contributions.map(item => item.type === 'application.settingsPage' ? { ...item, entry: 'linked-settings/settings.html' } : item) } }, manifestRoot), /linked path/);
} catch (error) { if (!['EPERM', 'EACCES'].includes(error?.code)) throw error; }
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, service: { ...manifest.componentHost.service, permissions: allPermissions.filter(value => value !== 'project.output.write') } } }, manifestRoot), /requires permission project\.output\.write/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, compatibility: {} } }, manifestRoot), /Unknown component host field/);
assert.throws(() => parseComponentHostManifest({ ...manifest, componentHost: { ...manifest.componentHost, unsafeExtension: true } }, manifestRoot), /Unknown component host field/);
assert.throws(() => parseComponentHostManifest({ ...manifest, id: 'Fixture-Component' }, manifestRoot), /component id/);
const camelCaseContribution = structuredClone(manifest); camelCaseContribution.componentHost.contributions[0].id = 'openPanel';
assert.equal(parseComponentHostManifest(camelCaseContribution, manifestRoot).toolbarAction.id, 'openPanel', 'internal contribution identifiers retain their case and are not component identities');
for (const field of ['hostApiVersion', 'minHostApiVersion', 'maxHostApiVersion', 'negotiatedHostApiVersion']) assert.throws(() => parseComponentHostManifest({ ...manifest, [field]: 1 }, manifestRoot), /Obsolete component manifest Host API version field/);
const manifestWith = mutate => { const value = structuredClone(manifest); mutate(value); return value; };
for (const mutate of [
  value => { value.id = 7; },
  value => { value.version = ['1']; },
  value => { value.componentHost.contributions[0].label = { toString: () => 'Open' }; },
  value => { value.componentHost.contributions[1].entry = ['ui/index.html']; },
  value => { value.componentHost.service.entrypoints.default = 3; },
  value => { value.componentHost.service.rpcMethods[0] = ['fixture.run.v1']; },
  value => { value.componentHost.service.events = [3]; },
  value => { value.componentHost.service.runtimeActions = [3]; },
  value => { value.componentHost.service.lifecycleActions = []; },
]) assert.throws(() => parseComponentHostManifest(manifestWith(mutate), manifestRoot), /Invalid|must be|bounded|exact/);
for (const schema of ['component-manifest-v2.schema.json', 'component-host-api.schema.json', 'component-service-protocol-v1.schema.json']) JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'contracts', 'schemas', schema), 'utf8'));
const componentManifestSchema2020 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'contracts', 'schemas', 'component-manifest-v2.schema.json'), 'utf8'));
// The repository's installed Ajv 6 validates draft-07. Adapt only the test copy;
// the published contract remains draft 2020-12 with $defs.
const componentManifestSchema = JSON.parse(JSON.stringify(componentManifestSchema2020).replaceAll('#/$defs/', '#/definitions/'));
componentManifestSchema.definitions = componentManifestSchema.$defs; delete componentManifestSchema.$defs; delete componentManifestSchema.$schema; delete componentManifestSchema.$id;
const validateComponentManifest = new Ajv({ allErrors: true }).compile(componentManifestSchema);
const schemaFixture = structuredClone(restoreManifest);
schemaFixture.componentHost.legacySettingsAdoptions = [{ topLevelKey: 'legacyFixtureSettings' }];
assert.equal(validateComponentManifest(schemaFixture), true, JSON.stringify(validateComponentManifest.errors));
const placedProjectActionSchemaFixture = structuredClone(schemaFixture);
placedProjectActionSchemaFixture.componentHost.contributions.push({ type: 'project.contextAction', id: 'video-action', label: 'Video action', pageId: 'main', placement: 'workspace.videoTools', rpcMethods: ['fixture.run.v1'] });
assert.equal(validateComponentManifest(placedProjectActionSchemaFixture), true, JSON.stringify(validateComponentManifest.errors), 'schema accepts project.contextAction in workspace.videoTools');
for (const invalidType of ['media.contextAction', 'project.importProvider', 'project.exportProvider', 'application.command']) {
  const invalidPlacedContribution = structuredClone(placedProjectActionSchemaFixture);
  invalidPlacedContribution.componentHost.contributions.at(-1).type = invalidType;
  assert.equal(validateComponentManifest(invalidPlacedContribution), false, `schema rejects ${invalidType} in workspace.videoTools`);
}
const invalidManifest = mutate => { const value = structuredClone(schemaFixture); mutate(value); assert.equal(validateComponentManifest(value), false, 'strict component manifest schema must reject an invalid adoption/restore declaration'); };
invalidManifest(value => { value.id = 'Fixture-Component'; });
const camelCaseSchemaFixture = structuredClone(schemaFixture); camelCaseSchemaFixture.componentHost.contributions[0].id = 'openPanel'; assert.equal(validateComponentManifest(camelCaseSchemaFixture), true, JSON.stringify(validateComponentManifest.errors));
invalidManifest(value => { value.componentHost.legacySettingsAdoptions[0].unknown = true; });
invalidManifest(value => { value.componentHost.legacySettingsAdoptions.push(structuredClone(value.componentHost.legacySettingsAdoptions[0])); });
invalidManifest(value => { value.componentHost.legacySettingsAdoptions = Array.from({ length: 9 }, (_unused, index) => ({ topLevelKey: `legacy${index}` })); });
invalidManifest(value => { value.componentHost.legacySettingsAdoptions[0].topLevelKey = 'legacy-setting' });
invalidManifest(value => { value.componentHost.service.backupRestore.unknown = true; });
invalidManifest(value => { delete value.componentHost.service.backupRestore.workspace; });
invalidManifest(value => { value.componentHost.service.backupRestore.workspace.method = 'fixture.restore'; });
invalidManifest(value => { value.componentHost.service.backupRestore.sources = []; });
invalidManifest(value => { value.componentHost.service.backupRestore.sources[0].path = '../fixture.sqlite3'; });
invalidManifest(value => { value.componentHost.service.backupRestore.sources[0].path = 'fixture-component\\storage.sqlite3'; });
invalidManifest(value => { value.componentHost.service.backupRestore.sources[0].path = ' fixture-component/storage.sqlite3'; });
invalidManifest(value => { value.componentHost.service.backupRestore.sources[0].extra = true; });
const capabilitySchema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'contracts', 'schemas', 'component-host-api.schema.json'), 'utf8'));
const schemaMethods = Object.values(capabilitySchema.$defs).map(value => value?.properties?.method?.const).filter(Boolean).sort();
assert.deepEqual(schemaMethods, [...HOST_CAPABILITIES].sort(), 'machine-readable schema must discriminate every supported capability method');
const dialogResults = capabilitySchema.$defs.dialogs.properties.result.oneOf; assert.equal(dialogResults.length, 5); const selectionResult = dialogResults.find(item => item.required?.includes('inputs')); assert.equal(selectionResult.additionalProperties, false); assert.equal(selectionResult.properties.inputs.maxItems, 2000); assert.equal(selectionResult.properties.inputs.items.additionalProperties, false); assert.equal(selectionResult.properties.truncated.type, 'boolean', 'dialogs schema and SDK expose the bounded directory truncation flag');
const runtimeSources = [
  'electron/services/component-project-capabilities.cjs',
  'electron/services/component-project-read-capabilities.cjs',
  'electron/services/component-file-resources.cjs',
  'electron/services/component-transfer-capabilities.cjs',
  'electron/services/component-project-write-capabilities.cjs',
  'electron/services/component-runtime-execution-service.cjs',
  'electron/services/component-host-capability-runtime.cjs',
  'electron/modules/system-ipc.cjs',
].map(relative => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8')).join('\n');
const runtimeMethods = [...new Set([...runtimeSources.matchAll(/(?:\.register\(|\[)\s*'([a-z][a-zA-Z0-9.-]*)'/g)].map(match => match[1]).filter(method => HOST_CAPABILITIES.has(method)))].sort();
assert.deepEqual(runtimeMethods, [...HOST_CAPABILITIES].sort(), 'runtime registrations must implement every Host API capability exactly once');
assert(!JSON.stringify(capabilitySchema).includes('apiVersion'), 'Host capability response schemas are unversioned');
const draft7CapabilitySchema = JSON.parse(JSON.stringify(capabilitySchema).replaceAll('#/$defs/', '#/definitions/'));
draft7CapabilitySchema.definitions = draft7CapabilitySchema.$defs; delete draft7CapabilitySchema.$defs; delete draft7CapabilitySchema.$schema; delete draft7CapabilitySchema.$id;
const sampleFor = (schema, definitions = draft7CapabilitySchema.definitions) => {
  if (schema.$ref) return sampleFor(definitions[schema.$ref.split('/').at(-1)], definitions);
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.enum) return structuredClone(schema.enum[0]);
  if (schema.oneOf) return sampleFor(schema.oneOf[0], definitions);
  if (schema.anyOf && !schema.type && !schema.properties) return sampleFor(schema.anyOf[0], definitions);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object' || schema.properties) return Object.fromEntries((schema.required || []).map(key => [key, sampleFor(schema.properties[key], definitions)]));
  if (type === 'array') return Array.from({ length: schema.minItems || 0 }, () => sampleFor(schema.items, definitions));
  if (type === 'integer' || type === 'number') return schema.minimum || 0;
  if (type === 'boolean') return true;
  if (type === 'null') return null;
  if (type === 'string') {
    if (schema.pattern?.includes('36')) return '00000000-0000-4000-8000-000000000000';
    if (schema.pattern?.startsWith('^secret:v1:')) return 'secret:v1:00000000-0000-4000-8000-000000000000';
    if (schema.pattern?.startsWith('^component-input:')) return 'component-input:fixture';
    if (schema.pattern?.startsWith('^data:image')) return 'data:image/jpeg;base64,AA==';
    if (schema.pattern?.includes('64')) return 'a'.repeat(64);
    return 'fixture';
  }
  return {};
};
const ajv = new Ajv({ allErrors: true, schemaId: 'auto' });
for (const method of HOST_CAPABILITIES) {
  const name = Object.keys(capabilitySchema.$defs).find(key => capabilitySchema.$defs[key]?.properties?.method?.const === method);
  assert(name, `missing schema for ${method}`);
  const resultSchema = JSON.parse(JSON.stringify(draft7CapabilitySchema.definitions[name].properties.result));
  const validateResult = ajv.compile({ ...resultSchema, definitions: draft7CapabilitySchema.definitions });
  assert.equal(validateResult({}), false, `${method} must reject an empty result`);
  for (const [branchIndex, branch] of (resultSchema.oneOf || [resultSchema]).entries()) {
    const valid = sampleFor(branch); assert.equal(validateResult(valid), true, `${method} result branch ${branchIndex} must pass: ${JSON.stringify(validateResult.errors)}`);
    assert.equal(validateResult({ ...valid, apiVersion: 7 }), false, `${method} result branch ${branchIndex} must reject legacy apiVersion`);
    assert.equal(validateResult({ ...valid, unknownResultField: true }), false, `${method} result branch ${branchIndex} must reject unknown fields`);
    const firstRequired = Object.keys(valid)[0]; assert(firstRequired, `${method} result branch ${branchIndex} must have an identity field`);
    const missing = { ...valid }; delete missing[firstRequired]; assert.equal(validateResult(missing), false, `${method} result branch ${branchIndex} must reject a missing required field`);
  }
}
const mediaProcessResultSchema = JSON.parse(JSON.stringify(draft7CapabilitySchema.definitions.projectMediaProcess.properties.result));
const validateMediaProcessResult = ajv.compile({ ...mediaProcessResultSchema, definitions: draft7CapabilitySchema.definitions });
assert.equal(validateMediaProcessResult({ action: 'video.timelineFrames' }), false, 'timeline results require frames');
assert.equal(validateMediaProcessResult({ action: 'video.timelineFrames', frames: [], outputs: [] }), false, 'timeline results cannot claim office outputs');
assert.equal(validateMediaProcessResult({ action: 'office.extractImages', receiptId: '00000000-0000-4000-8000-000000000000', operationId: '00000000-0000-4000-8000-000000000000', outputs: [], frames: [] }), false, 'office results cannot claim timeline frames');
const progressManageResultSchema = JSON.parse(JSON.stringify(draft7CapabilitySchema.definitions.projectProgressManage.properties.result));
const validateProgressManageResult = ajv.compile({ ...progressManageResultSchema, definitions: draft7CapabilitySchema.definitions });
const receiptId = '00000000-0000-4000-8000-000000000000';
assert.equal(validateProgressManageResult({ receiptId, action: 'update' }), false, 'progress update results require progress');
assert.equal(validateProgressManageResult({ receiptId, action: 'unregister' }), false, 'progress unregister results require progressId');
assert.equal(validateProgressManageResult({ receiptId, action: 'edgeCreate' }), false, 'edge creation results require edge');
assert.equal(validateProgressManageResult({ receiptId, action: 'edgeDelete', edge: {} }), false, 'edge deletion results cannot claim a created edge');
const lifecycleResultSchema = JSON.parse(JSON.stringify(draft7CapabilitySchema.definitions.lifecycle.properties.result));
const validateLifecycleResult = ajv.compile({ ...lifecycleResultSchema, definitions: draft7CapabilitySchema.definitions });
const lifecycleResult = sampleFor(lifecycleResultSchema);
assert.equal(validateLifecycleResult({ ...lifecycleResult, componentId: 'Fixture' }), false, 'Host API component identity remains lowercase-only');
assert.equal(validateLifecycleResult({ ...lifecycleResult, state: 'inactive' }), false, 'Host API lifecycle state rejects undeclared values');
const storageVariants = capabilitySchema.$defs.storage.properties.result.oneOf;
const pendingStorageSchema = storageVariants.find(value => value.properties?.adoption?.properties?.state?.const === 'pending');
const committedStorageSchema = storageVariants.find(value => value.properties?.adoption?.properties?.state?.const === 'committed');
assert(pendingStorageSchema && !Object.hasOwn(pendingStorageSchema.properties, 'dataPath') && !Object.hasOwn(pendingStorageSchema.properties, 'databasePath'), 'pending storage schema grants no path');
for (const field of ['schemaVersion', 'kind', 'state', 'componentId', 'startedAt']) assert(pendingStorageSchema.properties.adoption.required.includes(field), `pending adoption requires ${field}`);
for (const field of ['adoptedDataRoot', 'adoptedDatabase', 'legacyDataRoot', 'legacyDatabasePath', 'databaseSha256', 'copiedFileCount', 'copiedByteCount']) assert(committedStorageSchema.properties.adoption.required.includes(field), `committed adoption requires ${field}`);
const writtenFrames = [];
const typedHostClient = createServiceHostClient({ writeFrame: frame => writtenFrames.push(frame) });
const typedCall = typedHostClient.callHost('parent-1', 'component.lifecycle', { action: 'describe' });
assert(typedHostClient.acceptFrame({ type: 'capability-response', id: writtenFrames[0].id, ok: true, result: {  state: 'active' } }));

const broker = new ComponentCapabilityBroker();
const thumbnailRequests = [];
const mediaGrants = [];
let returnOriginalAsThumbnail = false;
const originalUrl = 'photoflow-media://original/one.jpg';
const mediaService = {
  grantPath: value => { mediaGrants.push(value); return value; },
  grantRoot: value => value,
  toUrl: () => originalUrl,
  requestThumbnail: async request => {
    thumbnailRequests.push(request);
    return { previewUrl: returnOriginalAsThumbnail ? originalUrl : `photoflow-media://derived/${request.requestedSize}/one.jpg` };
  },
};
const openedPaths = [];
const projectDirectoryRequests = [];
const shell = { openPath: async filePath => { openedPaths.push(filePath); return ''; }, showItemInFolder: filePath => { openedPaths.push(filePath); } };
// Deliberately provide a retired link record: it must not expand project access.
const legacyManagedLink = { shortcutVirtualPath: 'External', externalTargetRoot: externalRoot, externalTargetKind: 'folder', offline: false };
let legacyLinkEnumerationCount = 0;
const virtualResolveCalls = [];
const projectVirtualPaths = {
  listManagedExternalLinks: () => { legacyLinkEnumerationCount += 1; return [legacyManagedLink]; },
  toVirtualPath: (_root, candidate) => `External/${path.relative(externalRoot, candidate).replace(/\\/g, '/')}`,
  resolve: (_root, relativePath, options = {}) => {
    virtualResolveCalls.push({ relativePath, options });
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (normalized === 'External' || normalized.startsWith('External/')) return { physicalPath: path.join(externalRoot, normalized.slice('External'.length).replace(/^\//, '')), mediaRoot: externalRoot, viaExternalLink: true };
    return { physicalPath: path.join(projectRoot, normalized), mediaRoot: projectRoot, viaExternalLink: false };
  },
};
const taskHandles = new Map();
const backgroundTasks = {
  create(definition) {
    let finished = false;
    const controller = new AbortController();
    const snapshot = { id: definition.id, state: 'running', checkpoint: definition.checkpoint, metadata: definition.metadata };
    const handle = {
      task: snapshot,
      context: { signal: controller.signal, report: (progress, message) => Object.assign(snapshot, { progress, message }), saveCheckpoint: checkpoint => { snapshot.checkpoint = checkpoint; } },
      waitForStart: async () => undefined, isFinished: () => finished, snapshot: () => ({ ...snapshot }),
      complete: message => { finished = true; Object.assign(snapshot, { state: 'completed', message }); },
      fail: error => { finished = true; Object.assign(snapshot, { state: 'failed', error: error.message }); },
    };
    taskHandles.set(snapshot.id, { handle, controller }); return handle;
  },
  get: id => taskHandles.get(id)?.handle.snapshot() || null,
  cancel: id => { const found = taskHandles.get(id); if (!found) return false; found.controller.abort(); found.handle.task.state = 'cancelled'; return true; },
};
let config = {};
const atomicJson = async ({ filePath, value }) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.promises.rm(filePath, { force: true });
  await fs.promises.rename(temporary, filePath);
};
let safeOpenDialogResult = { canceled: true, filePaths: [] };
const registrationOptions = overrides => ({
  broker, ensureWorkspace: value => path.resolve(value), getWorkspaceDataRoot: () => dataRoot,
  resolveProjectEntry: (_workspace, _status, _name, relative) => projectVirtualPaths.resolve(projectRoot, relative, { externalRootMode: 'target' }).physicalPath,
  versionService, IMAGE_EXTENSIONS: new Set(['.jpg']), VIDEO_EXTENSIONS: new Set(['.mp4']), RAW_EXTENSIONS: new Set(['.cr3']),
  path, fs, crypto, getConfigPath: () => configPath, readSavedConfig: () => config,
  getComponentDataRoot: () => componentDataDirectoryRoot,
  readConfig: async () => config,
  mutateConfig: async mutator => { config = await mutator(config); await atomicJson({ filePath: configPath, value: config }); return config; },
  getProjectPath: () => projectRoot,
  dialog: { showOpenDialog: async () => safeOpenDialogResult },
  requestConfirmation: async () => true,
  mainWindow: { webContents: { send: (channel, value) => projectDirectoryRequests.push({ channel, value }) } },
  mediaService, backgroundTasks, ensureTrackedVersionThumbnail: async () => undefined, shell,
  getBoundProject: () => ({ id: 'project-1', name: 'Project', status: 'active' }),
  projectVirtualPaths,
  ...overrides,
});
const projectDomain = registerComponentProjectCapabilities(registrationOptions());
broker.register('component.lifecycle', (payload, _context, ownedDescriptor) => ({ componentId: ownedDescriptor.componentId, componentVersion: ownedDescriptor.componentVersion, permissions: ownedDescriptor.service.permissions, events: ownedDescriptor.service.events, lifecycleActions: [], state: payload.action === 'describe' ? 'active' : 'active' }));
assert(broker.assertCapabilities(descriptor));
const context = { componentId: descriptor.componentId, componentVersion: descriptor.componentVersion, workspacePath: workspaceRoot, projectId: 'project-1', projectName: 'Project', projectStatus: 'active', emitComponentEvent: (topic, event) => { context.lastEvent = { topic, event }; } };

(async () => {
  assert.equal((await typedCall).state, 'active', 'service-side Host helper correlates capability responses');
  const firstPage = await broker.invoke(descriptor, 'project.media.page', { pageSize: 10, kinds: ['image'] }, context);
  assert(firstPage.items.some(item => item.relativePath === 'images/one.jpg'));
  assert(firstPage.items.some(item => item.relativePath === 'images/two.jpg'));
  assert(firstPage.items.every(item => !item.viaExternalLink && !item.relativePath.startsWith('External/')), 'retired in-project external links must not participate in media pagination');
  assert.equal(firstPage.page.hasMore, false, 'excluded legacy links must not create phantom continuation pages');
  assert.equal(legacyLinkEnumerationCount, 0, 'media pagination must not consult the retired external-link registry');
  const grantsBeforeMetadata = mediaGrants.length; const thumbnailsBeforeMetadata = thumbnailRequests.length;
  const metadataOnly = await broker.invoke(descriptor, 'project.media.variants', { photoId: 'photo-1', versionId: 'version-1', variants: [] }, context);
  assert.equal(metadataOnly.input, undefined, 'metadata-only media descriptions do not mint input grants');
  assert.equal(mediaGrants.length, grantsBeforeMetadata, 'metadata-only media descriptions do not mint media URL grants');
  assert.equal(thumbnailRequests.length, thumbnailsBeforeMetadata, 'metadata-only media descriptions do not request thumbnails');
  const issuedMediaUrls = []; context.grantMediaUrl = url => issuedMediaUrls.push(url);
  const variants = await broker.invoke(descriptor, 'project.media.variants', { photoId: 'photo-1', versionId: 'version-1', variants: ['thumbnail', 'preview', 'original'] }, context);
  assert.deepEqual(issuedMediaUrls, Object.values(variants.variants).map(value => value.url), 'only Host-authorized variants are granted to the bound component view');
  const reservationVariant = await broker.invoke(descriptor, 'project.media.variants', { photoId: 'photo-1', versionId: 'version-1', variants: ['original'] }, context);
  const realNow = Date.now; const issuedAt = realNow();
  try {
    Date.now = () => issuedAt + 9 * 60 * 1000;
    const reserved = await projectDomain.reserveInputs([reservationVariant.input.token], descriptor, context, 'reservation-expiry-test');
    Date.now = () => issuedAt + 11 * 60 * 1000;
    assert.notEqual(reserved[0].filePath, imagePath, 'active reservation materializes a component-private input without extending its authorization');
    assert(fs.existsSync(reserved[0].filePath));
    await assert.rejects(projectDomain.peekInput(reservationVariant.input.token, descriptor, context), error => error.code === 'COMPONENT_HOST_CONFLICT', 'active reservation is not pruned after original expiry');
    projectDomain.releaseReservation('reservation-expiry-test');
    assert.equal(await projectDomain.peekInput(reservationVariant.input.token, descriptor, context), reserved[0].filePath, 'release restores only the bounded remaining lifetime of the private snapshot');
  } finally { Date.now = realNow; }
  const freshInputVariant = await broker.invoke(descriptor, 'project.media.variants', { photoId: 'photo-1', versionId: 'version-1', variants: ['original'] }, context);
  assert.notEqual(variants.variants.thumbnail.url, variants.variants.original.url, 'a JPEG thumbnail must be a generated derivative rather than its original URL');
  assert.deepEqual(thumbnailRequests.map(item => item.requestedSize), [320, 1600]);
  assert(thumbnailRequests.every(item => item.awaitReady === true), 'media capability variants wait for a completed derivative');
  returnOriginalAsThumbnail = true;
  await assert.rejects(broker.invoke(descriptor, 'project.media.variants', { relativePath: 'images/one.jpg', variants: ['thumbnail'] }, context), error => error.code === 'COMPONENT_HOST_VARIANT_UNAVAILABLE');
  await assert.rejects(broker.invoke(descriptor, 'project.media.variants', { relativePath: 'images/one.jpg', variants: ['preview'] }, context), error => error.code === 'COMPONENT_HOST_VARIANT_UNAVAILABLE');
  returnOriginalAsThumbnail = false;
  const grantsBeforeExternalRejection = mediaGrants.length;
  for (const reference of [{ photoId: 'photo-external', versionId: 'version-external' }, { relativePath: 'External/outside.jpg' }]) {
    await assert.rejects(broker.invoke(descriptor, 'project.media.variants', { ...reference, variants: ['original'] }, context), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED', 'a stale external-link record cannot authorize a file outside the bound project');
  }
  assert.equal(mediaGrants.length, grantsBeforeExternalRejection, 'rejected external-link access must not mint media URL grants');

  const materialized = await broker.invoke(descriptor, 'project.input.tokens', { action: 'materialize', token: freshInputVariant.input.token }, context);
  assert(fs.existsSync(materialized.privatePath));
  await assert.rejects(broker.invoke(descriptor, 'project.input.tokens', { action: 'materialize', token: freshInputVariant.input.token }, context), error => error.code === 'COMPONENT_HOST_TOKEN_EXPIRED', 'input grants are single-use');
  const batchVariantA = await broker.invoke(descriptor, 'project.media.variants', { photoId: 'photo-1', versionId: 'version-1', variants: ['original'] }, context);
  const batchVariantB = await broker.invoke(descriptor, 'project.media.variants', { photoId: 'photo-2', versionId: 'version-2', variants: ['original'] }, context);
  const materializedBatch = await broker.invoke(descriptor, 'project.input.tokens', { action: 'materializeBatch', tokens: [batchVariantA.input.token, batchVariantB.input.token] }, context);
  assert.equal(materializedBatch.items.length, 2, 'bounded input token batches materialize multiple return images in one Host capability call');
  assert(materializedBatch.items.every(item => fs.existsSync(item.privatePath)));

  const legacyDataRoot = path.join(dataRoot, descriptor.componentId); const legacyDatabasePath = path.join(dataRoot, 'databases', `${descriptor.componentId}.sqlite3`);
  fs.mkdirSync(legacyDataRoot, { recursive: true }); fs.mkdirSync(path.dirname(legacyDatabasePath), { recursive: true }); fs.writeFileSync(path.join(legacyDataRoot, 'legacy-private.bin'), 'legacy-private'); fs.writeFileSync(legacyDatabasePath, 'legacy-database');
  let storage = await broker.invoke(descriptor, 'component.storage', {}, context);
  for (let attempt = 0; storage.adoption?.state === 'pending' && attempt < 100; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); storage = await broker.invoke(descriptor, 'component.storage', {}, context); }
  assert(storage.dataPath.startsWith(path.join(dataRoot, 'components', descriptor.componentId)));
  assert.equal(storage.adoption?.state, 'committed'); assert.equal(storage.adoption.legacyDataRoot, legacyDataRoot); assert.equal(fs.readFileSync(path.join(storage.dataPath, 'legacy-private.bin'), 'utf8'), 'legacy-private'); assert.equal(fs.readFileSync(storage.databasePath, 'utf8'), 'legacy-database');
  const privateMediaPath = path.join(storage.dataPath, 'previews', 'private.jpg');
  fs.mkdirSync(path.dirname(privateMediaPath), { recursive: true }); fs.writeFileSync(privateMediaPath, 'private-media');
  const privateMedia = await broker.invoke(descriptor, 'component.media', { action: 'variants', relativePath: 'previews/private.jpg', variants: ['thumbnail', 'original'] }, context);
  assert(privateMedia.opaqueRef.startsWith('component-media:') && privateMedia.variants.thumbnail.derived);
  await broker.invoke(descriptor, 'component.media', { action: 'reveal', relativePath: 'previews/private.jpg' }, context);
  assert(openedPaths.includes(privateMediaPath));
  const listedProgress = await broker.invoke(descriptor, 'project.progress', { action: 'list' }, context);
  assert.equal(listedProgress.progress[0].folderPath, undefined, 'progress responses do not expose host paths');
  const createdProgress = await broker.invoke(descriptor, 'project.progress', { action: 'create', relativePath: 'progress-v2', mediaKind: 'image', versionKey: '2', parentProgressId: 'progress-original', sourceMetadata: { category: 'progress', role: 'component-output', displayName: '组件进度', componentId: 'forged-component' }, sourceProgressIds: ['progress-original'] }, context);
  assert.equal(createdProgress.progress.id, 'progress-created');
  assert.deepStrictEqual(virtualResolveCalls.find(call => call.relativePath === 'progress-v2')?.options, { externalRootMode: 'target', mustExist: false, allowMissingLeaf: true }, 'component progress creation must resolve a missing leaf before creating its directory');
  assert.deepStrictEqual(createdProgress.progress.sourceMetadata, { category: 'progress', role: 'component-output', displayName: '组件进度', parentCapability: 'structural', componentId: descriptor.componentId });
  await broker.invoke(descriptor, 'project.progress', { action: 'create', relativePath: 'progress-empty-metadata', mediaKind: 'image', versionKey: '3', parentProgressId: 'progress-original', sourceMetadata: {} }, context);
  const emptyMetadata = calls.filter(call => call.action === 'progress_register_with_graph').at(-1).payload.progress.sourceMetadata;
  await broker.invoke(descriptor, 'project.progress', { action: 'create', relativePath: 'progress-default-metadata', mediaKind: 'image', versionKey: '4', parentProgressId: 'progress-original' }, context);
  const defaultMetadata = calls.filter(call => call.action === 'progress_register_with_graph').at(-1).payload.progress.sourceMetadata;
  assert.deepStrictEqual(emptyMetadata, defaultMetadata);
  assert.deepStrictEqual(defaultMetadata, { category: 'progress', parentCapability: 'structural', componentId: descriptor.componentId });
  for (const [relativePath, sourceMetadata] of [
    ['progress-unknown-metadata', { category: 'progress', unknown: true }],
    ['progress-nested-metadata', { category: 'progress', role: { nested: true } }],
    ['progress-long-metadata', { category: 'x'.repeat(129) }],
    ['progress-control-metadata', { category: 'progress\ninvalid' }],
  ]) {
    await assert.rejects(
      broker.invoke(descriptor, 'project.progress', { action: 'create', relativePath, mediaKind: 'image', versionKey: '5', parentProgressId: 'progress-original', sourceMetadata }, context),
      /sourceMetadata/,
    );
    assert(!fs.existsSync(path.join(projectRoot, relativePath)), 'invalid metadata must be rejected before directory creation');
  }
  for (const invalidRevision of [-1, 1.25, Number.MAX_SAFE_INTEGER + 1]) {
    config = { componentSettings: { [descriptor.componentId]: {} }, componentSettingsRevisions: { [descriptor.componentId]: invalidRevision } };
    assert.equal((await broker.invoke(descriptor, 'component.settings', { action: 'get' }, context)).revision, 0, 'invalid stored revisions never enter API responses');
  }
  config = {};
  const saved = await broker.invoke(descriptor, 'component.settings', { action: 'replace', settings: { quality: 90 } }, context);
  assert.equal(saved.revision, 1); config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const orderingBroker = new ComponentCapabilityBroker(); let orderingReadCount = 0; let orderingMutateCount = 0;
  registerComponentProjectCapabilities(registrationOptions({ broker: orderingBroker, readConfig: () => { orderingReadCount += 1; return new Promise(() => undefined); }, mutateConfig: async mutator => { orderingMutateCount += 1; return mutator({ componentSettings: {}, componentSettingsRevisions: {} }); } }));
  const orderedWrite = await orderingBroker.invoke(descriptor, 'component.settings', { action: 'merge', settings: { queued: true } }, context);
  assert.equal(orderedWrite.revision, 1); assert.equal(orderingMutateCount, 1); assert.equal(orderingReadCount, 0, 'settings writes enter the mutation queue without awaiting a stale pre-read');
  assert.equal(config.componentSettings[descriptor.componentId].quality, 90);

  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'stage', maxBytes: 64 * 1024 ** 3 + 1 }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST');
  const boundedStage = await broker.invoke(descriptor, 'project.output', { action: 'stage', maxBytes: 3 }, context);
  await broker.invoke(descriptor, 'project.output', { action: 'write', stageId: boundedStage.stageId, name: 'bounded.txt', outputRelativePath: 'exports/bounded.txt', base64: Buffer.from('four').toString('base64') }, context);
  resetComponentHostCapabilityStateForTest();
  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'validate', stageId: boundedStage.stageId }, context), error => error.code === 'COMPONENT_HOST_LIMIT_EXCEEDED');
  await broker.invoke(descriptor, 'project.output', { action: 'rollback', stageId: boundedStage.stageId }, context);
  const expandedStage = await broker.invoke(descriptor, 'project.output', { action: 'stage', maxBytes: 16 * 1024 ** 3 }, context);
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(expandedStage.privatePath), 'stage.json'), 'utf8')).maxBytes, 16 * 1024 ** 3);
  await broker.invoke(descriptor, 'project.output', { action: 'rollback', stageId: expandedStage.stageId }, context);
  const stage = await broker.invoke(descriptor, 'project.output', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output', { action: 'write', stageId: stage.stageId, name: 'result.jpg', outputRelativePath: 'exports/result.jpg', base64: Buffer.from('output').toString('base64') }, context);
  assert(fs.existsSync(path.join(path.dirname(stage.privatePath), 'stage.json')), 'stage metadata is persisted outside the component-writable payload directory');
  resetComponentHostCapabilityStateForTest();
  const validated = await broker.invoke(descriptor, 'project.output', { action: 'validate', stageId: stage.stageId }, context);
  assert.equal(validated.fileCount, 1);
  const committed = await broker.invoke(descriptor, 'project.output', { action: 'commit', stageId: stage.stageId, idempotencyKey: 'export-001' }, context);
  const commitStatus = await broker.invoke(descriptor, 'project.output', { action: 'status', idempotencyKey: 'export-001' }, context);
  assert.equal(commitStatus.state, 'committed'); assert.equal(commitStatus.commitId, committed.commitId);
  assert.equal(commitStatus.outputs[0].filePath, undefined, 'status does not expose physical output paths');
  assert.deepEqual(await broker.invoke(descriptor, 'project.output', { action: 'status', idempotencyKey: 'not-submitted' }, context), { state: 'missing' });
  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'status', idempotencyKey: '../invalid' }, context), /idempotencyKey/);
  assert(fs.existsSync(path.join(projectRoot, 'exports', 'result.jpg')));
  resetComponentHostCapabilityStateForTest();
  const replay = await broker.invoke(descriptor, 'project.output', { action: 'commit', stageId: stage.stageId, idempotencyKey: 'export-001' }, context);
  assert.equal(replay.commitId, committed.commitId, 'committed journal replays after Host restart without its consumed stage');
  assert.equal((await broker.invoke(descriptor, 'project.output', { action: 'status', idempotencyKey: 'export-001' }, context)).state, 'committed', 'status reads durable receipts after Host restart');
  const statusReceiptPath = path.join(storage.dataPath, 'receipts', 'commits', committed.commitId + '.json');
  const statusReceipt = fs.readFileSync(statusReceiptPath, 'utf8');
  fs.writeFileSync(statusReceiptPath, JSON.stringify({ ...JSON.parse(statusReceipt), state: 'prepared' }));
  assert.equal((await broker.invoke(descriptor, 'project.output', { action: 'status', idempotencyKey: 'export-001' }, context)).state, 'prepared', 'a published file without a committed receipt is not yet complete');
  fs.writeFileSync(statusReceiptPath, statusReceipt);
  let fallbackCopies = 0;
  const fallbackBroker = new ComponentCapabilityBroker();
  registerComponentProjectCapabilities(registrationOptions({ broker: fallbackBroker, fs: { ...fs, promises: { ...fs.promises, link: async () => { fallbackCopies += 1; throw Object.assign(new Error('fixture filesystem does not support hard links'), { code: 'ENOTSUP' }); } } } }));
  const fallbackStage = await fallbackBroker.invoke(descriptor, 'project.output', { action: 'stage' }, context);
  await fallbackBroker.invoke(descriptor, 'project.output', { action: 'write', stageId: fallbackStage.stageId, name: 'copy.jpg', outputRelativePath: 'exports/copy-fallback.jpg', base64: Buffer.from('stream-copy-fallback').toString('base64') }, context);
  await fallbackBroker.invoke(descriptor, 'project.output', { action: 'commit', stageId: fallbackStage.stageId, idempotencyKey: 'copy-fallback' }, context);
  assert.equal(fallbackCopies, 1);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'exports', 'copy-fallback.jpg'), 'utf8'), 'stream-copy-fallback', 'stream publication fallback must complete, release its handles and preserve bytes');
  await broker.invoke(descriptor, 'dialogs', { kind: 'revealOutput', commitId: committed.commitId, artifactId: committed.outputs[0].artifactId }, context);
  await broker.invoke(descriptor, 'dialogs', { kind: 'openOutputDirectory', commitId: committed.commitId, artifactId: committed.outputs[0].artifactId }, context);
  assert.deepEqual(projectDirectoryRequests.at(-1), {
    channel: 'component-host:open-project-directory',
    value: { workspacePath: workspaceRoot, projectId: 'project-1', projectName: 'Project', projectStatus: 'active', relativePath: 'exports' },
  }, 'output directories open through a project-browser navigation request instead of the system shell');

  resetComponentHostCapabilityStateForTest();
  const created = await broker.invoke(descriptor, 'version.create', { commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, photoId: 'photo-1', parentVersionId: 'version-1', idempotencyKey: 'version-001', name: 'Fixture output' }, context);
  resetComponentHostCapabilityStateForTest();
  const createdAgain = await broker.invoke(descriptor, 'version.create', { commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, photoId: 'photo-1', parentVersionId: 'version-1', idempotencyKey: 'version-001', name: 'Fixture output' }, context);
  assert.equal(createdAgain.versionId, created.versionId);
  assert.equal(calls.filter(item => item.action === 'media_create_version').length, 1, 'generic version creation is idempotent through the real media repository/service composition');

  const scopeIdentity = `${descriptor.componentId}\0${workspaceRoot}\0project-1`;
  const scopeDigest = crypto.createHash('sha256').update(scopeIdentity).digest('hex');
  const crashVersionKey = 'version-crash';
  const crashVersionId = stableUuid(crypto, `component-version\0${scopeIdentity}\0${crashVersionKey}`);
  bundle.versions.push({ id: crashVersionId, photoId: 'photo-1', parentVersionId: 'version-1', filePath: committed.outputs[0].filePath, isCurrent: true });
  const crashVersionReceipt = path.join(dataRoot, 'components', descriptor.componentId, 'receipts', 'versions', `${crashVersionId}.json`);
  await atomicJson({ filePath: crashVersionReceipt, value: { schemaVersion: 1, kind: 'component-version', state: 'prepared', versionId: crashVersionId, idempotencyKey: crashVersionKey, componentId: descriptor.componentId, projectId: 'project-1', scopeDigest, photoId: 'photo-1', parentVersionId: 'version-1', commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, createdAt: Date.now() } });
  const createCountBeforeCrashRecovery = calls.filter(item => item.action === 'media_create_version').length;
  resetComponentHostCapabilityStateForTest();
  const recoveredVersion = await broker.invoke(descriptor, 'version.create', { commitId: committed.commitId, artifactId: committed.outputs[0].artifactId, photoId: 'photo-1', parentVersionId: 'version-1', idempotencyKey: crashVersionKey }, context);
  assert.equal(recoveredVersion.versionId, crashVersionId);
  assert.equal(calls.filter(item => item.action === 'media_create_version').length, createCountBeforeCrashRecovery, 'prepared version receipt plus stable versionId recognizes a database commit after a crash');

  const replacementStage = await broker.invoke(descriptor, 'project.output', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output', { action: 'write', stageId: replacementStage.stageId, name: 'result.jpg', outputRelativePath: 'exports/result.jpg', base64: Buffer.from('replacement').toString('base64'), replace: true, previousCommitId: committed.commitId, previousArtifactId: committed.outputs[0].artifactId, expectedDigest: committed.outputs[0].sha256 }, context);
  const replacementCommit = await broker.invoke(descriptor, 'project.output', { action: 'commit', stageId: replacementStage.stageId, idempotencyKey: 'replace-001' }, context);
  assert.equal((await broker.invoke(descriptor, 'project.output', { action: 'status', idempotencyKey: 'export-001' }, context)).state, 'changed', 'status rejects a stale cached commit after replacement');
  assert.equal(fs.readFileSync(path.join(projectRoot, 'exports', 'result.jpg'), 'utf8'), 'replacement');
  const deniedReplacementStage = await broker.invoke(descriptor, 'project.output', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output', { action: 'write', stageId: deniedReplacementStage.stageId, name: 'result.jpg', outputRelativePath: 'exports/result.jpg', base64: Buffer.from('bad-replacement').toString('base64'), replace: true, previousCommitId: replacementCommit.commitId, previousArtifactId: replacementCommit.outputs[0].artifactId, expectedDigest: '0'.repeat(64) }, context);
  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'commit', stageId: deniedReplacementStage.stageId, idempotencyKey: 'replace-denied' }, context), error => error.code === 'COMPONENT_HOST_CONFLICT');
  assert.equal(fs.readFileSync(path.join(projectRoot, 'exports', 'result.jpg'), 'utf8'), 'replacement', 'failed controlled replacement preserves the owned output');

  const recoveryStage = await broker.invoke(descriptor, 'project.output', { action: 'stage' }, context);
  const collisionStage = await broker.invoke(descriptor, 'project.output', { action: 'stage' }, context);
  const collisionTarget = path.join(projectRoot, 'exports', 'collision.jpg');
  fs.writeFileSync(collisionTarget, 'previous-user-edit');
  await broker.invoke(descriptor, 'project.output', { action: 'write', stageId: collisionStage.stageId, name: 'collision.jpg', outputRelativePath: 'exports/collision.jpg', base64: Buffer.from('new-relay-edit').toString('base64') }, context);
  const collisionRequest = { action: 'commit', stageId: collisionStage.stageId, idempotencyKey: 'relay-collision' };
  await assert.rejects(broker.invoke(descriptor, 'project.output', collisionRequest, context), error => error.code === 'COMPONENT_HOST_CONFLICT');
  const renamed = await broker.invoke(descriptor, 'project.output', { ...collisionRequest, onConflict: 'rename' }, context);
  assert.equal(renamed.outputs[0].requestedRelativePath, 'exports/collision.jpg');
  assert.notEqual(renamed.outputs[0].relativePath, 'exports/collision.jpg');
  assert.equal(fs.readFileSync(collisionTarget, 'utf8'), 'previous-user-edit');
  assert.equal(fs.readFileSync(path.join(projectRoot, renamed.outputs[0].relativePath), 'utf8'), 'new-relay-edit');
  resetComponentHostCapabilityStateForTest();
  const renamedReplay = await broker.invoke(descriptor, 'project.output', { ...collisionRequest, onConflict: 'rename' }, context);
  assert.deepEqual(renamedReplay, renamed, 'restart reuses the receipt and selected filename after the stage is gone');
  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'commit', stageId: deniedReplacementStage.stageId, idempotencyKey: 'replace-denied', onConflict: 'rename' }, context), error => error.code === 'COMPONENT_HOST_CONFLICT');
  await broker.invoke(descriptor, 'project.output', { action: 'write', stageId: recoveryStage.stageId, name: 'a.jpg', outputRelativePath: 'recovery/a.jpg', base64: Buffer.from('recovery-a').toString('base64') }, context);
  await broker.invoke(descriptor, 'project.output', { action: 'write', stageId: recoveryStage.stageId, name: 'b.jpg', outputRelativePath: 'recovery/b.jpg', base64: Buffer.from('recovery-b').toString('base64') }, context);
  const recoveryMetadata = JSON.parse(fs.readFileSync(path.join(path.dirname(recoveryStage.privatePath), 'stage.json'), 'utf8'));
  const recoveryKey = 'recovery-001'; const recoveryCommitId = stableUuid(crypto, `component-output\0${scopeIdentity}\0${recoveryKey}`);
  const recoveryOutputs = recoveryMetadata.files.map(file => { const bytes = fs.readFileSync(path.join(recoveryStage.privatePath, file.sourceName)); return { artifactId: file.artifactId, relativePath: file.outputRelativePath, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), published: false }; });
  fs.mkdirSync(path.join(projectRoot, 'recovery'), { recursive: true }); fs.copyFileSync(path.join(recoveryStage.privatePath, recoveryMetadata.files[0].sourceName), path.join(projectRoot, 'recovery', 'a.jpg')); recoveryOutputs[0].published = true;
  const recoveryReceiptPath = path.join(dataRoot, 'components', descriptor.componentId, 'receipts', 'commits', `${recoveryCommitId}.json`);
  await atomicJson({ filePath: recoveryReceiptPath, value: { schemaVersion: 1, kind: 'component-output-commit', state: 'prepared', commitId: recoveryCommitId, idempotencyKey: recoveryKey, componentId: descriptor.componentId, projectId: 'project-1', scopeDigest, stageId: recoveryStage.stageId, createdAt: Date.now(), outputs: recoveryOutputs } });
  resetComponentHostCapabilityStateForTest();
  const recoveredCommit = await broker.invoke(descriptor, 'project.output', { action: 'commit', stageId: recoveryStage.stageId, idempotencyKey: recoveryKey }, context);
  assert.equal(recoveredCommit.commitId, recoveryCommitId); assert(fs.existsSync(path.join(projectRoot, 'recovery', 'b.jpg')), 'prepared multi-file journal finishes after Host restart');

  const rollbackStage = await broker.invoke(descriptor, 'project.output', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output', { action: 'write', stageId: rollbackStage.stageId, name: 'rollback.jpg', outputRelativePath: 'recovery/rollback.jpg', base64: Buffer.from('rollback-output').toString('base64') }, context);
  const rollbackMetadata = JSON.parse(fs.readFileSync(path.join(path.dirname(rollbackStage.privatePath), 'stage.json'), 'utf8'));
  const rollbackFile = rollbackMetadata.files[0];
  const rollbackId = stableUuid(crypto, 'rollback-own-project');
  const rollbackReceipt = { schemaVersion: 1, kind: 'component-output-commit', state: 'prepared', commitId: rollbackId, idempotencyKey: 'rollback-own-project', componentId: descriptor.componentId, projectId: 'project-1', scopeDigest, stageId: rollbackStage.stageId, createdAt: Date.now(), outputs: [{ artifactId: rollbackFile.artifactId, relativePath: rollbackFile.outputRelativePath, size: 15, sha256: crypto.createHash('sha256').update('rollback-output').digest('hex'), published: false }] };
  const receiptDirectory = path.dirname(recoveryReceiptPath);
  await atomicJson({ filePath: path.join(receiptDirectory, `${rollbackId}.json`), value: rollbackReceipt });
  const foreignReceipts = [
    { ...rollbackReceipt, commitId: stableUuid(crypto, 'rollback-other-project'), projectId: 'project-2' },
    { ...rollbackReceipt, commitId: stableUuid(crypto, 'rollback-other-scope'), scopeDigest: '0'.repeat(64) },
  ];
  for (const receipt of foreignReceipts) await atomicJson({ filePath: path.join(receiptDirectory, `${receipt.commitId}.json`), value: receipt });
  const beforeForeign = foreignReceipts.map(receipt => fs.readFileSync(path.join(receiptDirectory, `${receipt.commitId}.json`), 'utf8'));
  const invalidOwnReceipt = { ...rollbackReceipt, outputs: [{ ...rollbackReceipt.outputs[0], artifactId: 'invalid' }] };
  fs.writeFileSync(path.join(receiptDirectory, `${rollbackId}.json`), JSON.stringify(invalidOwnReceipt));
  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'rollback', stageId: rollbackStage.stageId }, context), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED', 'matching malformed receipts still fail closed');
  fs.writeFileSync(path.join(receiptDirectory, `${rollbackId}.json`), JSON.stringify(rollbackReceipt));
  assert.equal((await broker.invoke(descriptor, 'project.output', { action: 'rollback', stageId: rollbackStage.stageId }, context)).rolledBack, true, 'other projects and scopes cannot block rollback of this stage');
  assert(!fs.existsSync(path.join(receiptDirectory, `${rollbackId}.json`)));
  foreignReceipts.forEach((receipt, index) => assert.equal(fs.readFileSync(path.join(receiptDirectory, `${receipt.commitId}.json`), 'utf8'), beforeForeign[index], 'foreign receipts remain unchanged'));

  const conflictStage = await broker.invoke(descriptor, 'project.output', { action: 'stage' }, context);
  await broker.invoke(descriptor, 'project.output', { action: 'write', stageId: conflictStage.stageId, name: 'conflict.jpg', outputRelativePath: 'recovery/conflict.jpg', base64: Buffer.from('host-output').toString('base64') }, context);
  const conflictMeta = JSON.parse(fs.readFileSync(path.join(path.dirname(conflictStage.privatePath), 'stage.json'), 'utf8')); const conflictFile = conflictMeta.files[0]; const conflictBytes = fs.readFileSync(path.join(conflictStage.privatePath, conflictFile.sourceName));
  const conflictKey = 'recovery-conflict'; const conflictCommitId = stableUuid(crypto, `component-output\0${scopeIdentity}\0${conflictKey}`); const conflictTarget = path.join(projectRoot, 'recovery', 'conflict.jpg'); fs.writeFileSync(conflictTarget, 'user-modified');
  await atomicJson({ filePath: path.join(dataRoot, 'components', descriptor.componentId, 'receipts', 'commits', `${conflictCommitId}.json`), value: { schemaVersion: 1, kind: 'component-output-commit', state: 'prepared', commitId: conflictCommitId, idempotencyKey: conflictKey, componentId: descriptor.componentId, projectId: 'project-1', scopeDigest, stageId: conflictStage.stageId, createdAt: Date.now(), outputs: [{ artifactId: conflictFile.artifactId, relativePath: conflictFile.outputRelativePath, size: conflictBytes.length, sha256: crypto.createHash('sha256').update(conflictBytes).digest('hex'), published: true }] } });
  resetComponentHostCapabilityStateForTest();
  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'commit', stageId: conflictStage.stageId, idempotencyKey: conflictKey }, context), error => error.code === 'COMPONENT_HOST_CONFLICT');
  assert.equal(fs.readFileSync(conflictTarget, 'utf8'), 'user-modified', 'journal recovery never deletes a user-modified output');

  const expiryBroker = new ComponentCapabilityBroker(); let expiryNow = Date.now() - STAGE_TTL_MS - 10; registerComponentProjectCapabilities(registrationOptions({ broker: expiryBroker, now: () => expiryNow }));
  const expiredStage = await expiryBroker.invoke(descriptor, 'project.output', { action: 'stage' }, context); const expiredRoot = path.dirname(expiredStage.privatePath); expiryNow += STAGE_TTL_MS + 20;
  const siblingStage = path.join(path.dirname(expiredRoot), 'do-not-delete'); fs.mkdirSync(siblingStage, { recursive: true }); resetComponentHostCapabilityStateForTest();
  await assert.rejects(expiryBroker.invoke(descriptor, 'project.output', { action: 'validate', stageId: expiredStage.stageId }, context), error => error.code === 'COMPONENT_HOST_TOKEN_EXPIRED');
  assert(!fs.existsSync(expiredRoot) && fs.existsSync(siblingStage), 'expiry removes only the exact bound stage directory');

  const failingBroker = new ComponentCapabilityBroker();
  registerComponentProjectCapabilities(registrationOptions({ broker: failingBroker, replaceJson: async options => {
    if (options.value?.kind === 'component-output-commit' && options.value?.state === 'committed') throw new Error('simulated committed receipt failure');
    return atomicJson(options);
  } }));
  failingBroker.register('component.lifecycle', () => ({  state: 'active' }));
  const failingStage = await failingBroker.invoke(descriptor, 'project.output', { action: 'stage' }, context);
  await failingBroker.invoke(descriptor, 'project.output', { action: 'write', stageId: failingStage.stageId, name: 'failure.jpg', outputRelativePath: 'receipt-failure/failure.jpg', base64: Buffer.from('failure-output').toString('base64') }, context);
  await failingBroker.invoke(descriptor, 'project.output', { action: 'write', stageId: failingStage.stageId, name: 'failure-2.jpg', outputRelativePath: 'receipt-failure/failure-2.jpg', base64: Buffer.from('failure-output-2').toString('base64') }, context);
  await assert.rejects(failingBroker.invoke(descriptor, 'project.output', { action: 'commit', stageId: failingStage.stageId, idempotencyKey: 'receipt-failure' }, context), /simulated committed receipt failure/);
  const failedOutput = path.join(projectRoot, 'receipt-failure', 'failure.jpg'); const failedCommitId = stableUuid(crypto, `component-output\0${scopeIdentity}\0receipt-failure`);
  assert(!fs.existsSync(failedOutput) && !fs.existsSync(path.join(projectRoot, 'receipt-failure', 'failure-2.jpg')) && !fs.existsSync(path.join(dataRoot, 'components', descriptor.componentId, 'receipts', 'commits', `${failedCommitId}.json`)), 'final receipt failure rolls back every output and removes the unusable journal');

  const adoptedPath = path.join(projectRoot, 'legacy', 'adopted.jpg'); fs.mkdirSync(path.dirname(adoptedPath), { recursive: true }); fs.writeFileSync(adoptedPath, 'legacy-output');
  const adopted = await broker.invoke(descriptor, 'project.output', { action: 'adopt', migrationId: 'migration-one', outputs: [{ relativePath: 'legacy/adopted.jpg' }] }, context);
  assert(adopted.commitId && adopted.outputs.length === 1);
  assert((await broker.invoke(descriptor, 'dialogs', { kind: 'openOutput', commitId: adopted.commitId, artifactId: adopted.outputs[0].artifactId }, context)).opened, 'one-time V1 adoption creates a receipt consumable by generic Host output refs');
  const importedLegacy = await broker.invoke(descriptor, 'project.output', { action: 'materializeOwned', commitId: adopted.commitId, artifactId: adopted.outputs[0].artifactId }, context);
  assert.equal(fs.readFileSync(importedLegacy.privatePath, 'utf8'), 'legacy-output', 'owned legacy project output can be safely copied into component-private storage');
  const absoluteAdopted = await broker.invoke(descriptor, 'project.output', { action: 'adopt', migrationId: 'migration-absolute', outputs: [{ sourcePath: adoptedPath }] }, context);
  assert.equal(absoluteAdopted.outputs[0].relativePath, 'legacy/adopted.jpg');
  assert.equal(absoluteAdopted.outputs[0].filePath, undefined, 'one-time absolute migration input is never echoed as a public disk path');
  const outsideLegacyPath = path.join(externalRoot, 'outside-legacy.jpg'); fs.writeFileSync(outsideLegacyPath, 'outside-legacy');
  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'adopt', migrationId: 'migration-outside', outputs: [{ sourcePath: outsideLegacyPath }] }, context), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED', 'absolute migration sources outside the bound project fail closed');
  for (const sourcePath of ['', `C:\\${'x'.repeat(4096)}`, `${adoptedPath}\0hidden`]) await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'adopt', migrationId: `migration-invalid-${sourcePath.length}`, outputs: [{ sourcePath }] }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST', 'malformed legacy absolute migration paths are rejected before filesystem resolution');
  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'adopt', migrationId: 'migration-ambiguous', outputs: [{ relativePath: 'legacy/adopted.jpg', sourcePath: adoptedPath }] }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST', 'migration sources cannot mix relative and legacy absolute paths');
  const junctionTarget = path.join(externalRoot, 'junction-target'); const junctionPath = path.join(projectRoot, 'legacy-junction'); fs.mkdirSync(junctionTarget, { recursive: true }); fs.writeFileSync(path.join(junctionTarget, 'linked.jpg'), 'linked'); fs.symlinkSync(junctionTarget, junctionPath, 'junction');
  await assert.rejects(broker.invoke(descriptor, 'project.output', { action: 'adopt', migrationId: 'migration-symlink', outputs: [{ sourcePath: path.join(junctionPath, 'linked.jpg') }] }, context), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED', 'symlinked parents cannot escape the physical bound project root');

  const started = await broker.invoke(descriptor, 'tasks', { action: 'start', operationId: 'fixture-task', title: 'Fixture' }, context);
  await broker.invoke(descriptor, 'tasks', { action: 'report', operationId: 'fixture-task', progress: 25, checkpoint: { page: 1 } }, context);
  await broker.invoke(descriptor, 'tasks', { action: 'complete', operationId: 'fixture-task', message: 'Paused fixture' }, context);
  const resumed = await broker.invoke(descriptor, 'tasks', { action: 'resume', operationId: 'fixture-task', checkpoint: { page: 1 } }, context);
  const cancelled = await broker.invoke(descriptor, 'tasks', { action: 'cancel', operationId: 'fixture-task' }, context);
  assert(started.task && resumed.task.checkpoint.page === 1 && cancelled.cancelled);
  const panelTask = await broker.invoke(descriptor, 'tasks', { action: 'start', operationId: 'fixture-panel-task', title: 'Panel fixture' }, { ...context, surface: 'component.sidePanel', sourcePageId: 'project-page-1', contributionId: 'panel' });
  assert.deepEqual({ ownerPageId: panelTask.task.metadata.presentationOwnerPageId, panelKind: panelTask.task.metadata.presentationPanelKind }, { ownerPageId: 'project-page-1', panelKind: `component:${descriptor.componentId}:panel` }, 'component panel tasks retain their owning page and contribution for task-center restoration');
  assert((await broker.invoke(descriptor, 'dialogs', { kind: 'confirm', title: 'Confirm', message: 'Continue?' }, context)).confirmed);
  const selectedDirectory = path.join(sandbox, 'dialog-directory'); const nestedDirectory = path.join(selectedDirectory, 'nested');
  fs.mkdirSync(nestedDirectory, { recursive: true }); fs.writeFileSync(path.join(selectedDirectory, 'voice.mp3'), 'audio'); fs.writeFileSync(path.join(nestedDirectory, 'clip.MP4'), 'video'); fs.writeFileSync(path.join(nestedDirectory, 'ignored.txt'), 'text');
  safeOpenDialogResult = { canceled: false, filePaths: [selectedDirectory] };
  const directoryInputs = await broker.invoke(descriptor, 'dialogs', { kind: 'openDirectory', title: 'Media folder', extensions: ['mp3', 'mp4'], recursive: true }, context);
  assert.deepEqual(directoryInputs.inputs.map(item => item.relativeName).sort(), ['nested/clip.MP4', 'voice.mp3']);
  assert(directoryInputs.inputs.every(item => item.token.startsWith('component-input:') && !JSON.stringify(item).includes(selectedDirectory)), 'directory dialog returns bounded tokens and relative display names, never a selected path');
  const directoryMaterialized = await broker.invoke(descriptor, 'project.input.tokens', { action: 'materialize', token: directoryInputs.inputs[0].token }, context);
  assert(directoryMaterialized.privatePath.startsWith(path.join(dataRoot, 'components', descriptor.componentId)), 'directory inputs materialize only inside component-private storage');
  safeOpenDialogResult = { canceled: false, filePaths: [selectedDirectory] };
  const directoryTokenInput = await broker.invoke(descriptor, 'dialogs', { kind: 'openDirectory', directoryToken: true }, context);
  assert.equal(directoryTokenInput.inputs.length, 1, 'directory-token mode preserves a selected folder as one source');
  assert.equal(directoryTokenInput.inputs[0].kind, 'directory');
  const directorySnapshot = await projectDomain.peekInput(directoryTokenInput.inputs[0].token, descriptor, context);
  assert.notEqual(directorySnapshot, selectedDirectory, 'a directory token resolves to an authorized private snapshot, not a persistent path to the original directory');
  assert(directorySnapshot.startsWith(path.join(dataRoot, 'components', descriptor.componentId)));
  assert.equal(fs.readFileSync(path.join(directorySnapshot, 'nested', 'clip.MP4'), 'utf8'), 'video', 'directory snapshot copying must finish and preserve nested content');
  const droppedInputs = await projectDomain.grantDroppedInputs([path.join(nestedDirectory, 'clip.MP4'), selectedDirectory, 'relative.mp4'], descriptor, context);
  assert.deepEqual(droppedInputs.inputs.map(item => item.kind), ['file', 'directory'], 'real dropped files and folders receive scoped tokens without accepting forged relative paths');
  assert(!JSON.stringify(droppedInputs).includes(selectedDirectory), 'dropped-file authorization never exposes absolute paths to the component page');
  safeOpenDialogResult = { canceled: false, filePaths: [selectedDirectory] }; const shallowInputs = await broker.invoke(descriptor, 'dialogs', { kind: 'openDirectory', extensions: ['mp3', 'mp4'], recursive: false }, context); assert.deepEqual(shallowInputs.inputs.map(item => item.relativeName), ['voice.mp3'], 'recursive:false never enumerates child directories');
  const escapedDirectory = path.join(sandbox, 'dialog-escape'); fs.mkdirSync(escapedDirectory); fs.writeFileSync(path.join(escapedDirectory, 'secret.mp4'), 'secret');
  try { const childLink = path.join(selectedDirectory, 'escape-link'); fs.symlinkSync(escapedDirectory, childLink, process.platform === 'win32' ? 'junction' : 'dir'); safeOpenDialogResult = { canceled: false, filePaths: [selectedDirectory] }; const linkedInputs = await broker.invoke(descriptor, 'dialogs', { kind: 'openDirectory', extensions: ['mp4'], recursive: true }, context); assert(!linkedInputs.inputs.some(item => item.relativeName.includes('secret')) && linkedInputs.truncated, 'child symlink escapes are skipped and completeness is reported conservatively'); const rootLink = path.join(sandbox, 'dialog-root-link'); fs.symlinkSync(selectedDirectory, rootLink, process.platform === 'win32' ? 'junction' : 'dir'); safeOpenDialogResult = { canceled: false, filePaths: [rootLink] }; await assert.rejects(broker.invoke(descriptor, 'dialogs', { kind: 'openDirectory', extensions: ['mp4'], recursive: true }, context), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST', 'symlinked directory roots fail closed'); } catch (error) { if (!['EPERM', 'EACCES'].includes(error?.code)) throw error; }
  const changedDirectory = path.join(sandbox, 'dialog-changed'); const changedFile = path.join(changedDirectory, 'changed.mp4'); fs.mkdirSync(changedDirectory); fs.writeFileSync(changedFile, 'authorized'); safeOpenDialogResult = { canceled: false, filePaths: [changedDirectory] }; const changedInputs = await broker.invoke(descriptor, 'dialogs', { kind: 'openDirectory', extensions: ['mp4'], recursive: true }, context); fs.writeFileSync(changedFile, 'changed-after-authorization'); await assert.rejects(broker.invoke(descriptor, 'project.input.tokens', { action: 'materialize', token: changedInputs.inputs[0].token }, context), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED', 'materialization rejects a file changed after directory authorization');
  const hugeDirectory = path.join(sandbox, 'dialog-huge'); fs.mkdirSync(hugeDirectory); for (let index = 0; index < 2000; index += 1) fs.writeFileSync(path.join(hugeDirectory, `${String(index).padStart(4, '0')}.mp4`), 'x'); safeOpenDialogResult = { canceled: false, filePaths: [hugeDirectory] }; const hugeInputs = await broker.invoke(descriptor, 'dialogs', { kind: 'openDirectory', extensions: ['mp4'], recursive: true }, context); assert(hugeInputs.truncated && hugeInputs.inputs.length < 2000, 'directory enumeration reports truncation at the global token/resource bound'); assert(!JSON.stringify(hugeInputs).includes(hugeDirectory), 'truncated results still never echo an absolute path');
  safeOpenDialogResult = { canceled: true, filePaths: [] };
  await broker.invoke(descriptor, 'component.events', { topic: 'fixture.progress.v1', event: { progress: 50 } }, context);
  assert.deepEqual(context.lastEvent, { topic: 'fixture.progress.v1', event: { progress: 50 } });
  assert.equal((await broker.invoke(descriptor, 'component.lifecycle', { action: 'describe' }, context)).state, 'active');
  const applicationSettingsContext = { ...context, surface: 'application.settings', workspacePath: '', projectId: '', projectName: '', projectStatus: '' };
  assert.equal((await broker.invoke(descriptor, 'component.settings', { action: 'get' }, applicationSettingsContext)).revision, 1, 'application settings surface may read owner settings');
  assert.equal((await broker.invoke(descriptor, 'component.lifecycle', { action: 'describe' }, applicationSettingsContext)).state, 'active', 'application settings surface may inspect declared lifecycle state');
  assert((await broker.invoke(descriptor, 'dialogs', { kind: 'confirm', title: 'Confirm' }, applicationSettingsContext)).confirmed, 'application settings surface may use confirmation dialogs');
  const installedDescriptor = { ...descriptor, componentRoot: manifestRoot };
  const openedComponentDirectory = await broker.invoke(installedDescriptor, 'dialogs', { kind: 'openComponentDirectory', relativePath: 'models' }, applicationSettingsContext);
  assert.equal(openedComponentDirectory.componentDirectory.relativePath, 'models');
  assert.equal(openedPaths.at(-1), path.join(manifestRoot, 'models'), 'application settings may open a created directory only inside its own installed component');
  const transcriptionRuntime = path.join(sandbox, 'components', 'video-transcription', 'runtime');
  fs.mkdirSync(transcriptionRuntime, { recursive: true });
  const transcriptionDescriptor = { ...descriptor, componentId: 'video-transcription', componentRoot: transcriptionRuntime };
  await broker.invoke(transcriptionDescriptor, 'dialogs', { kind: 'openComponentDirectory', relativePath: 'models' }, applicationSettingsContext);
  assert.equal(openedPaths.at(-1), path.join(path.dirname(transcriptionRuntime), 'models'), 'the transcription model button opens persistent data outside runtime');
  assert(!fs.existsSync(path.join(transcriptionRuntime, 'models')), 'opening models never recreates the replaceable legacy directory');
  await broker.invoke(transcriptionDescriptor, 'dialogs', { kind: 'openComponentDirectory', relativePath: 'logs' }, applicationSettingsContext);
  assert.equal(openedPaths.at(-1), path.join(transcriptionRuntime, 'logs'), 'only the transcription models directory is redirected');
  await assert.rejects(broker.invoke(installedDescriptor, 'dialogs', { kind: 'openComponentDirectory', relativePath: '../escape' }, applicationSettingsContext), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST', 'component-directory dialog rejects escapes');
  await assert.rejects(broker.invoke(installedDescriptor, 'dialogs', { kind: 'openComponentDirectory', relativePath: 'nested/child' }, applicationSettingsContext), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST', 'component-directory dialog cannot traverse a linked parent while creating a directory');
  const openedComponentDataDirectory = await broker.invoke(installedDescriptor, 'dialogs', { kind: 'openComponentDataDirectory', relativePath: 'advanced/packages' }, applicationSettingsContext);
  assert.equal(openedComponentDataDirectory.componentDataDirectory.relativePath, 'advanced/packages');
  assert.equal(openedPaths.at(-1), path.join(componentDataDirectoryRoot, 'advanced', 'packages'), 'application settings may open a nested directory only inside its Host-controlled component data root');
  await assert.rejects(broker.invoke(installedDescriptor, 'dialogs', { kind: 'openComponentDataDirectory', relativePath: '../escape' }, applicationSettingsContext), error => error.code === 'COMPONENT_HOST_INVALID_REQUEST', 'component-data directory dialog rejects escapes');
  await assert.rejects(broker.invoke(descriptor, 'dialogs', { kind: 'openFiles' }, applicationSettingsContext), error => error.code === 'COMPONENT_HOST_PERMISSION_DENIED', 'application settings surface cannot mint project input tokens');
  assert.throws(() => broker.invoke(descriptor, 'project.media.page', { pageSize: 10 }, applicationSettingsContext), /not available on the application.settings surface/, 'project capabilities fail closed on an application surface');
  assert.throws(() => broker.invoke(descriptor, 'component.storage', {}, applicationSettingsContext), /not available on the application.settings surface/, 'project-scoped component storage fails closed on an application surface');
  const drainBroker = new ComponentCapabilityBroker(); let finishAcceptedCapability;
  drainBroker.register('component.settings', () => new Promise(resolve => { finishAcceptedCapability = resolve; }));
  const drainDescriptor = { componentId: 'drain-fixture', service: { capabilities: ['component.settings'], permissions: ['component.settings'] } };
  const acceptedCapability = drainBroker.invoke(drainDescriptor, 'component.settings', { action: 'get' }, {});
  const barrier = drainBroker.blockComponent('drain-fixture'); let drained = false; const drain = barrier.drain().then(() => { drained = true; });
  assert.throws(() => drainBroker.invoke(drainDescriptor, 'component.settings', { action: 'get' }, {}), /quiesced/, 'new capabilities are rejected after component quiesce begins');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false, 'quiesce waits for an already accepted capability side effect');
  finishAcceptedCapability({ revision: 1, settings: {} }); await acceptedCapability; await drain; barrier.release(); assert.equal(drained, true);
  const hangingBroker = new ComponentCapabilityBroker(); let finishHanging;
  hangingBroker.register('component.settings', () => new Promise(resolve => { finishHanging = resolve; }));
  const hangingInvocation = hangingBroker.invoke(drainDescriptor, 'component.settings', { action: 'get' }, {});
  const hangingBarrier = hangingBroker.blockComponent('drain-fixture');
  await assert.rejects(hangingBarrier.drain({ timeoutMs: 10 }), error => error.code === 'COMPONENT_BUSY', 'a hung accepted capability aborts bounded drain instead of allowing destructive cleanup');
  hangingBarrier.release(); finishHanging({ revision: 1, settings: {} }); await hangingInvocation;

  const genericSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'services', 'component-project-capabilities.cjs'), 'utf8');
  const privateSchemaNames = [
    ['sample', 'component'].join('-'),
    ['edited', 'patch', 'path'].join('_'),
    ['component', 'patch', 'tasks'].join('_'),
  ];
  for (const forbidden of privateSchemaNames) assert(!genericSource.includes(forbidden), `generic host source must not contain ${forbidden}`);
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  assert(!packageJson.scripts.build.includes('sample-component') && !genericSource.includes('extensions/'), 'the main application build and Host must not require a component source package');
  // A referenced external project is a whole project, not a link inside Project.
  // The earlier resource-bound test intentionally exhausted input grants.
  resetComponentHostCapabilityStateForTest();
  const importedProjectId = 'imported-project';
  const importedBundle = { photo: { id: 'photo-imported', projectId: importedProjectId, originalName: 'outside.jpg' }, versions: [{ id: 'version-imported', photoId: 'photo-imported', filePath: externalImagePath, isCurrent: true }] };
  bundles.set('photo-imported', importedBundle);
  const importedBroker = new ComponentCapabilityBroker();
  registerComponentProjectCapabilities(registrationOptions({
    broker: importedBroker,
    getProjectPath: () => externalRoot,
    getBoundProject: () => ({ id: importedProjectId, name: 'Imported project', status: 'active' }),
    resolveProjectEntry: (_workspace, _status, _name, relative) => path.resolve(externalRoot, relative),
    versionService: { ...versionService, getMedia: async () => importedBundle },
  }));
  const importedContext = { ...context, projectId: importedProjectId, projectName: 'Imported project' };
  const importedPage = await importedBroker.invoke(descriptor, 'project.media.page', { pageSize: 200, kinds: ['image'] }, importedContext);
  assert(importedPage.items.some(item => item.relativePath === 'outside.jpg'), 'the registered root of an imported external project must be enumerated normally');
  assert(importedPage.items.every(item => !item.viaExternalLink), 'imported-project media does not use in-project external-link aliases');
  await assert.rejects(importedBroker.invoke(descriptor, 'project.media.variants', { photoId: 'photo-1', versionId: 'version-1', variants: ['original'] }, importedContext), error => error.code === 'COMPONENT_HOST_TOKEN_SCOPE', 'importing an external project does not authorize a different project');
  for (const reference of [{ photoId: 'photo-imported', versionId: 'version-imported' }, { relativePath: 'outside.jpg' }]) {
    const importedVariants = await importedBroker.invoke(descriptor, 'project.media.variants', { ...reference, variants: ['original'] }, importedContext);
    assert.equal(importedVariants.mediaRef.relativePath, 'outside.jpg');
    assert(importedVariants.input?.token, 'an imported external project grants access inside its own physical root');
  }
  assert.equal(legacyLinkEnumerationCount, 0, 'neither local nor imported projects consult the retired link registry');
  console.log('Component Host API contract and integration tests passed');
})().finally(() => { clearTimeout(testDeadline); fs.rmSync(sandbox, { recursive: true, force: true }); }).catch(error => { console.error(error); process.exitCode = 1; });
