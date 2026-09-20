const fs = require('fs');
const path = require('path');
const {
  defaultComponentDataAdoptionPolicy,
  ownsLegacyComponentDomainDatabase,
  isOwnedLegacyComponentDomainDatabase,
  authorizesLegacySettingsAdoption,
} = require('./compatibility/component-data-adoption-policy.cjs');
const { parseComponentSettingsForm } = require('./contracts/component-settings-form-contract.cjs');
const { parsePreviewDecoders } = require('./contracts/component-preview-decoder-contract.cjs');

const COMPONENT_HOST_CONTRACT_VERSION = 2;
const COMPONENT_SERVICE_PROTOCOL_VERSION = 1;
const CONTRIBUTION_TYPES = new Set(['workspace.toolbarAction', 'component.fullPage', 'application.settingsPage', 'application.settingsForm', 'component.sidePanel', 'media.contextAction', 'project.contextAction', 'project.importProvider', 'project.exportProvider', 'application.command']);
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const VERSIONED_METHOD = /^[a-z][a-z0-9.-]{0,119}\.v[1-9][0-9]*$/;
const HOST_CAPABILITIES = new Set([
  'project.media.page', 'project.media.variants', 'project.input.tokens',
  'project.output', 'version.create', 'tasks', 'dialogs',
  'component.storage', 'component.settings', 'component.events',
  'component.lifecycle', 'component.media', 'project.progress',
  'notifications',
  'project.files.page', 'project.files.search', 'project.media.metadata',
  'project.files.inputToken', 'project.files.watch', 'component.transfer',
  'project.preview',
  'component.panel',
  'project.versions.page', 'project.version.graph', 'project.media.ratings',
  'project.media.ratings.write', 'project.version.update', 'project.version.delete',
  'project.progress.manage', 'project.import', 'project.files.mutate', 'project.media.process',
  'component.secrets', 'network.fetch',
  'component.runtime.execute',
]);
const HOST_PERMISSIONS = new Set([
  'project.media.read', 'project.input.read', 'project.output.write',
  'project.version.create', 'component.storage', 'component.settings',
  'tasks', 'dialogs', 'events', 'component.lifecycle.read', 'component.lifecycle.manage',
  'component.media', 'project.progress',
  'notifications',
  'project.files.read', 'project.versions.read', 'project.media.ratings.read',
  'project.preview.read', 'project.preview.control',
  'component.panel',
  'project.media.ratings.write', 'project.version.write', 'project.version.delete',
  'project.progress.manage', 'project.import', 'project.files.write', 'project.media.process',
  'component.secrets', 'network.fetch',
  'component.runtime.execute',
]);
const CAPABILITY_PERMISSIONS = Object.freeze({
  'project.media.page': 'project.media.read',
  'project.media.variants': 'project.media.read',
  'project.input.tokens': 'project.input.read',
  'project.output': 'project.output.write',
  'version.create': 'project.version.create',
  'tasks': 'tasks',
  'dialogs': 'dialogs',
  'component.storage': 'component.storage',
  'component.settings': 'component.settings',
  'component.events': 'events',
  'component.lifecycle': 'component.lifecycle.read',
  'component.media': 'component.media',
  'project.progress': 'project.progress',
  'notifications': 'notifications',
  'project.files.page': 'project.files.read',
  'project.files.search': 'project.files.read',
  'project.files.inputToken': 'project.files.read',
  'project.preview': 'project.preview.read',
  'component.panel': 'component.panel',
  'project.files.watch': 'project.files.read',
  'component.transfer': 'project.input.read',
  'project.media.metadata': 'project.media.read',
  'project.versions.page': 'project.versions.read',
  'project.version.graph': 'project.versions.read',
  'project.media.ratings': 'project.media.ratings.read',
  'project.media.ratings.write': 'project.media.ratings.write',
  'project.version.update': 'project.version.write',
  'project.version.delete': 'project.version.delete',
  'project.progress.manage': 'project.progress.manage',
  'project.import': 'project.import',
  'project.files.mutate': 'project.files.write',
  'project.media.process': 'project.media.process',
  'component.secrets': 'component.secrets',
  'network.fetch': 'network.fetch',
  'component.runtime.execute': 'component.runtime.execute',
});
const COMPONENT_ICON_MIME_TYPES = new Map([['.png', 'image/png'], ['.svg', 'image/svg+xml']]);
const MAX_COMPONENT_ICON_BYTES = 512 * 1024;
const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const requiredText = (value, field, maxLength = 160) => {
  if (typeof value !== 'string') throw new Error(`Invalid component host ${field}`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new Error(`Invalid component host ${field}`);
  return text;
};
const requiredStringText = (value, field, maxLength = 160) => {
  if (typeof value !== 'string') throw new Error(`Invalid component host ${field}`);
  return requiredText(value, field, maxLength);
};
const requiredExactStringText = (value, field, maxLength = 160) => {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maxLength) throw new Error(`Invalid component host ${field}`);
  return value;
};
const requiredExactId = (value, field) => {
  const id = requiredExactStringText(value, field, 80);
  if (!IDENTIFIER.test(id)) throw new Error(`Invalid component host ${field}`);
  return id;
};

const requiredId = (value, field) => {
  const id = requiredText(value, field, 80);
  if (!IDENTIFIER.test(id)) throw new Error(`Invalid component host ${field}`);
  return id;
};
const requiredComponentId = (value, field) => {
  const id = requiredText(value, field, 80);
  if (!COMPONENT_ID.test(id)) throw new Error(`Invalid component host ${field}`);
  return id;
};
const rejectUnknownFields = (value, allowed, label) => {
  const unknown = Object.keys(value || {}).filter(field => !allowed.includes(field));
  if (unknown.length) throw new Error(`Unknown ${label} field: ${unknown[0]}`);
};
const normalizeBackupSourcePath = value => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean).join('/');

const resolveDevelopmentFile = ({ declaredEntry, componentRoot, overrideRoot, overrideEntry, label }) => {
  const declared = path.resolve(componentRoot, declaredEntry);
  if (!isInside(componentRoot, declared)) throw new Error(`${label} escapes component root`);
  const resolvedOverrideRoot = path.resolve(overrideRoot);
  const resolvedOverride = path.resolve(overrideEntry);
  if (!isInside(resolvedOverrideRoot, resolvedOverride)) throw new Error(`${label} development override escapes its approved root`);
  const rootStat = fs.lstatSync(resolvedOverrideRoot, { throwIfNoEntry: false });
  const entryStat = fs.lstatSync(resolvedOverride, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !entryStat?.isFile() || entryStat.isSymbolicLink()) throw new Error(`${label} development override is missing or unsafe`);
  const realRoot = fs.realpathSync(resolvedOverrideRoot); const realEntry = fs.realpathSync(resolvedOverride);
  if (!isInside(realRoot, realEntry)) throw new Error(`${label} development override escapes its approved root through a linked path`);
  return realEntry;
};
const resolvePackageFile = ({ relativeEntry, componentRoot, developmentOverride = null, label }) => {
  const declaredEntry = path.resolve(componentRoot, relativeEntry);
  if (!isInside(componentRoot, declaredEntry)) throw new Error(`${label} escapes component root`);
  if (developmentOverride) return resolveDevelopmentFile({ declaredEntry: relativeEntry, componentRoot, ...developmentOverride, label });
  const rootStat = fs.lstatSync(componentRoot, { throwIfNoEntry: false });
  const entryStat = fs.lstatSync(declaredEntry, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !entryStat?.isFile() || entryStat.isSymbolicLink()) throw new Error(`${label} is missing or unsafe: ${relativeEntry}`);
  const realRoot = fs.realpathSync(componentRoot);
  const realEntry = fs.realpathSync(declaredEntry);
  if (!isInside(realRoot, realEntry)) throw new Error(`${label} escapes component root through a linked path`);
  return realEntry;
};

const developmentOverrideFor = (developmentFiles, relativeEntry) => {
  const overrideEntry = typeof relativeEntry === 'string' ? developmentFiles?.files?.[relativeEntry.replace(/\\/g, '/')] : undefined;
  return overrideEntry ? { overrideRoot: developmentFiles.componentRoot, overrideEntry } : null;
};

const parseComponentIcon = (value, componentRoot, developmentOverride = null) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Invalid component icon declaration');
  const relativeEntry = requiredText(value, 'icon', 512).replace(/\\/g, '/');
  if (/^[a-z][a-z0-9+.-]*:/i.test(relativeEntry) || relativeEntry.startsWith('//')) throw new Error('Component icon must be a package-local file');
  const declaredEntry = path.resolve(componentRoot, relativeEntry);
  if (!isInside(componentRoot, declaredEntry)) throw new Error('Component icon escapes component root');
  const entry = developmentOverride ? resolveDevelopmentFile({ declaredEntry: relativeEntry, componentRoot, ...developmentOverride, label: 'Component icon' }) : declaredEntry;
  const mimeType = COMPONENT_ICON_MIME_TYPES.get(path.extname(entry).toLowerCase());
  if (!mimeType) throw new Error('Component icon must be SVG or PNG');
  const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_COMPONENT_ICON_BYTES) throw new Error(`Component icon is missing or unsafe: ${relativeEntry}`);
  const realRoot = fs.realpathSync(developmentOverride?.overrideRoot || componentRoot); const realEntry = fs.realpathSync(entry);
  if (!isInside(realRoot, realEntry)) throw new Error('Component icon escapes component root through a linked path');
  const bytes = fs.readFileSync(realEntry);
  if (mimeType === 'image/png') {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Component PNG icon has an invalid signature');
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 1024 || height > 1024) throw new Error('Component PNG icon dimensions are invalid');
  } else {
    const svg = bytes.toString('utf8').trim();
    if (!/^<svg[\s>]/i.test(svg)
      || /<\/?(?:script|foreignObject|iframe|object|embed|audio|video|image|use|style)\b/i.test(svg)
      || /<!DOCTYPE|<\?xml-stylesheet/i.test(svg)
      || /\son[a-z]+\s*=/i.test(svg)
      || /(?:^|[\s:])(?:href|src)\s*=/i.test(svg)) throw new Error('Component SVG icon contains active or external content');
    for (const match of svg.matchAll(/url\(\s*([^)]*)\s*\)/gi)) {
      if (!String(match[1] || '').trim().startsWith('#')) throw new Error('Component SVG icon contains an external resource');
    }
  }
  return Object.freeze({ entry: realEntry, relativeEntry, mimeType });
};

const isSettingsOnlyHost = host => Array.isArray(host?.contributions) && host.contributions.length > 0 && host.contributions.every(item => item?.type === 'application.settingsForm' && item.customPage === undefined);

const parseComponentHostManifest = (manifest, componentRoot, developmentFiles = null, adoptionPolicy = defaultComponentDataAdoptionPolicy) => {
  if (manifest?.apiVersion !== 1) throw new Error(`Unsupported component manifest apiVersion: ${manifest?.apiVersion ?? 'missing'}`);
  const obsoleteHostVersionField = ['hostApiVersion', 'minHostApiVersion', 'maxHostApiVersion', 'negotiatedHostApiVersion'].find(field => Object.hasOwn(manifest, field));
  if (obsoleteHostVersionField) throw new Error(`Obsolete component manifest Host API version field: ${obsoleteHostVersionField}`);
  const host = manifest?.componentHost;
  if (host === undefined) return null;
  if (!host || typeof host !== 'object' || Array.isArray(host)) throw new Error('Invalid componentHost manifest');
  const contractVersion = host.contractVersion;
  if (contractVersion !== COMPONENT_HOST_CONTRACT_VERSION) throw new Error(`Unsupported component host contractVersion: ${host.contractVersion}`);
  rejectUnknownFields(host, ['contractVersion', 'contributions', 'service', 'adoptionGrants', 'legacySettingsAdoptions'], 'component host');
  const decoderOnly = Array.isArray(host.service?.previewDecoders) && host.service.previewDecoders.length > 0 && Array.isArray(host.contributions) && host.contributions.length === 0;
  const settingsOnly = isSettingsOnlyHost(host);
  if (!Array.isArray(host.contributions) || !decoderOnly && !settingsOnly && host.contributions.length < 2 || host.contributions.length > 32) throw new Error('Component host contributions must be a bounded array');

  const componentId = requiredComponentId(manifest.id, 'component id');
  if (!Array.isArray(host.legacySettingsAdoptions) && host.legacySettingsAdoptions !== undefined) throw new Error('Legacy settings adoptions must be a bounded unique array');
  const legacySettingsAdoptions = (host.legacySettingsAdoptions || []).map(declaration => {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw new Error('Invalid legacy settings adoption declaration');
    rejectUnknownFields(declaration, ['topLevelKey'], 'legacy settings adoption');
    const topLevelKey = requiredExactStringText(declaration.topLevelKey, 'legacy settings top-level key', 128);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(topLevelKey)) throw new Error('Invalid legacy settings top-level key');
    if (!authorizesLegacySettingsAdoption(componentId, topLevelKey, adoptionPolicy)) throw new Error('Legacy settings adoption is not authorized by the host');
    return Object.freeze({ topLevelKey });
  });
  if (legacySettingsAdoptions.length > 8 || new Set(legacySettingsAdoptions.map(item => item.topLevelKey)).size !== legacySettingsAdoptions.length) throw new Error('Legacy settings adoptions must be a bounded unique array');
  const allowedAdoptionGrants = new Set(['component.storage.previous.v1', 'project.output.existing.v1']);
  const adoptionGrants = host.adoptionGrants === undefined ? [] : host.adoptionGrants;
  if (!Array.isArray(adoptionGrants) || adoptionGrants.length > allowedAdoptionGrants.size || new Set(adoptionGrants).size !== adoptionGrants.length || adoptionGrants.some(grant => !allowedAdoptionGrants.has(grant))) throw new Error('Invalid component host adoption grants');
  const icon = parseComponentIcon(manifest.icon, componentRoot, developmentOverrideFor(developmentFiles, manifest.icon) || developmentFiles?.icon || null);
  const seen = new Set();
  const pages = new Map();
  const actions = [];
  const settingsPages = [];
  const settingsForms = [];
  const hostContributions = [];
  for (const raw of host.contributions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid component host contribution');
    if (!CONTRIBUTION_TYPES.has(raw.type)) throw new Error(`Unknown component host contribution type: ${raw.type || 'missing'}`);
    const id = raw.type === 'application.settingsPage' ? requiredExactId(raw.id, 'application settings page id') : raw.type === 'application.settingsForm' ? requiredExactId(raw.id, 'application settings form id') : requiredId(raw.id, `${raw.type} id`);
    const key = id;
    if (seen.has(key)) throw new Error(`Duplicate component host contribution: ${key}`);
    seen.add(key);
    if (raw.type === 'component.fullPage') {
      rejectUnknownFields(raw, ['type', 'id', 'title', 'entry'], 'component fullPage contribution');
      const relativeEntry = requiredText(raw.entry, 'page entry', 512).replace(/\\/g, '/');
      const entry = resolvePackageFile({ relativeEntry, componentRoot, developmentOverride: developmentOverrideFor(developmentFiles, relativeEntry) || developmentFiles?.page, label: 'Component page entry' });
      pages.set(id, { type: raw.type, id, title: requiredText(raw.title, 'page title'), entry, relativeEntry });
    } else if (raw.type === 'workspace.toolbarAction') {
      rejectUnknownFields(raw, ['type', 'id', 'label', 'pageId'], 'component toolbarAction contribution');
      actions.push({ type: raw.type, id, label: requiredText(raw.label, 'toolbar label', 80), pageId: requiredId(raw.pageId, 'toolbar pageId') });
    } else if (raw.type === 'application.settingsPage') {
      rejectUnknownFields(raw, ['type', 'id', 'label', 'title', 'entry', 'rpcMethods'], 'application settingsPage contribution');
      const relativeEntry = requiredExactStringText(raw.entry, 'settings page entry', 512).replace(/\\/g, '/');
      const entry = resolvePackageFile({ relativeEntry, componentRoot, developmentOverride: developmentOverrideFor(developmentFiles, relativeEntry) || developmentFiles?.settingsPages?.[id], label: 'Component settings page entry' });
      if (!Array.isArray(raw.rpcMethods) || raw.rpcMethods.length < 1 || raw.rpcMethods.length > 32 || raw.rpcMethods.some(method => typeof method !== 'string')) throw new Error('Component settings page RPC methods must be a bounded versioned allowlist');
      const rpcMethods = raw.rpcMethods.map(value => requiredExactStringText(value, 'settings page RPC method', 128));
      if (new Set(rpcMethods).size !== rpcMethods.length) throw new Error('Component settings page RPC methods must not contain duplicates');
      if (rpcMethods.some(method => !VERSIONED_METHOD.test(method))) throw new Error('Component settings page RPC methods must be a bounded versioned allowlist');
      const label = requiredExactStringText(raw.label, 'settings page label', 80);
      settingsPages.push(Object.freeze({ type: raw.type, id, label, title: raw.title === undefined ? label : requiredExactStringText(raw.title, 'settings page title'), entry, relativeEntry, rpcMethods: Object.freeze(rpcMethods) }));
    } else if (raw.type === 'application.settingsForm') {
      rejectUnknownFields(raw, ['type', 'id', 'label', 'title', 'form', 'customPage'], 'application settingsForm contribution');
      const label = requiredExactStringText(raw.label, 'settings form label', 80);
      let customPage = null;
      if (raw.customPage !== undefined) {
        if (!raw.customPage || typeof raw.customPage !== 'object' || Array.isArray(raw.customPage)) throw new Error('Invalid declarative settings custom page');
        rejectUnknownFields(raw.customPage, ['title', 'entry', 'rpcMethods'], 'declarative settings custom page');
        const relativeEntry = requiredExactStringText(raw.customPage.entry, 'declarative settings custom page entry', 512).replace(/\\/g, '/');
        const entry = resolvePackageFile({ relativeEntry, componentRoot, developmentOverride: developmentOverrideFor(developmentFiles, relativeEntry) || developmentFiles?.settingsPages?.[id], label: 'Declarative settings custom page entry' });
        if (!Array.isArray(raw.customPage.rpcMethods) || raw.customPage.rpcMethods.length < 1 || raw.customPage.rpcMethods.length > 32 || raw.customPage.rpcMethods.some(method => typeof method !== 'string')) throw new Error('Declarative settings custom page RPC methods must be a bounded versioned allowlist');
        const rpcMethods = raw.customPage.rpcMethods.map(value => requiredExactStringText(value, 'declarative settings custom page RPC method', 128));
        if (new Set(rpcMethods).size !== rpcMethods.length || rpcMethods.some(method => !VERSIONED_METHOD.test(method))) throw new Error('Declarative settings custom page RPC methods must be unique versioned methods');
        customPage = Object.freeze({ title: raw.customPage.title === undefined ? label : requiredExactStringText(raw.customPage.title, 'declarative settings custom page title'), entry, relativeEntry, rpcMethods: Object.freeze(rpcMethods) });
      }
      settingsForms.push(Object.freeze({ type: raw.type, id, label, title: raw.title === undefined ? label : requiredExactStringText(raw.title, 'settings form title'), form: parseComponentSettingsForm(raw.form), customPage }));
    } else {
      rejectUnknownFields(raw, ['type', 'id', 'label', 'title', 'description', 'pageId', 'rpcMethods', 'placement'], `${raw.type} contribution`);
      const label = requiredExactStringText(raw.label, `${raw.type} label`, 80); const pageId = requiredExactId(raw.pageId, `${raw.type} pageId`);
      const description = raw.description === undefined ? '' : requiredExactStringText(raw.description, `${raw.type} description`, 240);
      const placement = raw.placement === undefined ? '' : requiredExactStringText(raw.placement, `${raw.type} placement`, 80);
      if (placement && !(['workspace.videoTools', 'workspace.imageTools', 'workspace.officeTools'].includes(placement) && ['component.sidePanel', 'project.contextAction'].includes(raw.type) || placement === 'workspace.folderPanel' && raw.type === 'component.sidePanel')) throw new Error(`Invalid ${raw.type} placement`);
      if (!Array.isArray(raw.rpcMethods) || raw.rpcMethods.length < 1 || raw.rpcMethods.length > 128) throw new Error(`${raw.type} RPC methods must be a bounded allowlist (1-128)`);
      const rpcMethods = raw.rpcMethods.map(method => requiredExactStringText(method, `${raw.type} RPC method`, 128));
      if (new Set(rpcMethods).size !== rpcMethods.length || rpcMethods.some(method => !VERSIONED_METHOD.test(method))) throw new Error(`${raw.type} RPC methods must be unique versioned methods`);
      hostContributions.push(Object.freeze({ type: raw.type, id, label, title: raw.title === undefined ? label : requiredExactStringText(raw.title, `${raw.type} title`, 160), ...(description ? { description } : {}), pageId, rpcMethods: Object.freeze(rpcMethods), ...(placement ? { placement } : {}) }));
    }
  }
  if (settingsPages.length + settingsForms.length > 16) throw new Error('Component settings contributions must be bounded');
  if (!decoderOnly && !settingsOnly && pages.size < 1 || pages.size > 16 || actions.length > 1) throw new Error('Component Host requires 1-16 full pages and at most one toolbar action');
  if (!decoderOnly && !settingsOnly && !actions.length && !hostContributions.some(contribution => contribution.type === 'component.sidePanel')) throw new Error('Component Host requires a toolbar action or side panel contribution');
  if (actions[0] && !pages.has(actions[0].pageId)) throw new Error(`Component toolbar action references an unknown page: ${actions[0].pageId}`);
  const page = actions[0] ? pages.get(actions[0].pageId) : null;
  for (const contribution of hostContributions) if (!pages.has(contribution.pageId)) throw new Error(`${contribution.type} references an unknown page: ${contribution.pageId}`);
  for (const settingsForm of settingsForms) {
    if (settingsForm.form.preferenceScope === 'videoPlayback') {
      const backends = require('./contracts/media-playback-backend-contract.cjs').parseMediaPlaybackBackendContributions(manifest);
      for (const field of settingsForm.form.groups.flatMap(group => group.fields)) {
        if (!backends.some(backend => field.id === 'targetPeakNits' ? backend.features.hdr.targetPeakControl : field.id === 'toneMapping' ? backend.features.hdr.toneMapping && field.options.every(option => backend.features.hdr.algorithms.includes(option.value)) : field.options.every(option => option.value === 'hdr-passthrough' ? backend.features.hdr.passthrough : option.value !== 'tone-map' || backend.features.hdr.toneMapping))) throw new Error('Playback preferences require a matching declared playback backend');
      }
    }
  }
  let service = null;
  if (host.service === undefined && !settingsOnly) throw new Error('Component Host V2 requires a service declaration');
  if (host.service !== undefined) {
    const raw = host.service;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid component service manifest');
    rejectUnknownFields(raw, ['protocolVersion', 'runtime', 'entrypoints', 'rpcMethods', 'capabilities', 'permissions', 'events', 'runtimeActions', 'lifecycleActions', 'projectFolders', 'networkOrigins', 'secretBindings', 'backupRestore', 'previewDecoders'], 'component service');
    if (raw.protocolVersion !== COMPONENT_SERVICE_PROTOCOL_VERSION) throw new Error(`Unsupported component service protocolVersion: ${raw.protocolVersion}`);
    if (!['node', 'executable'].includes(raw.runtime)) throw new Error('Invalid component service runtime');
    const entries = raw.entrypoints;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Missing component service entrypoints');
    const platformKey = `${process.platform}-${process.arch}`;
    const relativeEntry = requiredText(entries[platformKey] || entries[process.platform] || entries.default, 'service entry', 512).replace(/\\/g, '/');
    const entry = resolvePackageFile({ relativeEntry, componentRoot, developmentOverride: developmentOverrideFor(developmentFiles, relativeEntry), label: 'Component service entry' });
    if (!Array.isArray(raw.rpcMethods) || raw.rpcMethods.some(value => typeof value !== 'string' || value !== value.trim()) || new Set(raw.rpcMethods).size !== raw.rpcMethods.length) throw new Error('Component service RPC methods must be exact and unique');
    const rpcMethods = raw.rpcMethods.map(value => requiredText(value, 'service RPC method', 128));
    if (!rpcMethods.length || rpcMethods.length > 128 || rpcMethods.some(method => !VERSIONED_METHOD.test(method))) throw new Error('Component service RPC methods must be a bounded versioned allowlist');
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some(value => typeof value !== 'string' || value !== value.trim()) || new Set(raw.capabilities).size !== raw.capabilities.length) throw new Error('Host API capabilities must be exact and unique');
    const capabilities = raw.capabilities.map(value => requiredText(value, 'service capability', 128));
    if (capabilities.length > 32 || capabilities.some(capability => !HOST_CAPABILITIES.has(capability))) throw new Error('Component service requests an unknown host capability');
    if (!Array.isArray(raw.permissions) || raw.permissions.some(value => typeof value !== 'string' || value !== value.trim()) || new Set(raw.permissions).size !== raw.permissions.length) throw new Error('Host API permissions must be exact and unique');
    const permissions = raw.permissions.map(value => requiredText(value, 'service permission', 128));
    if (permissions.length > 32 || permissions.some(permission => !HOST_PERMISSIONS.has(permission))) throw new Error('Component service requests an unknown host permission');
    if (contractVersion === 2 && !Array.isArray(raw.permissions)) throw new Error('Component Host V2 service must declare a permissions allowlist');
    for (const capability of capabilities) {
      const permission = CAPABILITY_PERMISSIONS[capability];
      if (permission && !permissions.includes(permission)) throw new Error(`Component capability ${capability} requires permission ${permission}`);
    }
    if (capabilities.includes('project.files.inputToken') && !permissions.includes('project.input.read')) throw new Error('Component capability project.files.inputToken requires permission project.input.read');
    const networkOrigins = [];
    for (const value of raw.networkOrigins || []) { if (typeof value !== 'string' || value !== value.trim()) throw new Error('Invalid component network origin'); let parsed; try { parsed = new URL(value); } catch { throw new Error('Invalid component network origin'); } if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) throw new Error('Component network origins must be canonical HTTPS origins'); if (!networkOrigins.includes(parsed.origin)) networkOrigins.push(parsed.origin); }
    if (networkOrigins.length > 16 || raw.networkOrigins !== undefined && !Array.isArray(raw.networkOrigins)) throw new Error('Component network origins must be a bounded unique array');
    const secretBindings = {}; const dangerousSecretHeaders = /^(?:host|cookie|set-cookie|connection|upgrade|transfer-encoding|proxy-.*)$/i;
    if (raw.secretBindings !== undefined && (!raw.secretBindings || typeof raw.secretBindings !== 'object' || Array.isArray(raw.secretBindings))) throw new Error('Component secretBindings must be an object');
    for (const [bindingId, binding] of Object.entries(raw.secretBindings || {})) { const id = requiredExactId(bindingId, 'secret binding id'); if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('Invalid component secret binding'); rejectUnknownFields(binding, ['origin', 'header', 'prefix'], 'component secret binding'); const origin = requiredExactStringText(binding.origin, 'secret binding origin', 512); const header = requiredExactStringText(binding.header, 'secret binding header', 64); const prefix = binding.prefix === undefined ? '' : binding.prefix; if (typeof prefix !== 'string' || prefix.length > 128 || !networkOrigins.includes(origin) || header !== header.toLowerCase() || !/^[a-z0-9-]+$/.test(header) || dangerousSecretHeaders.test(header) || /[\r\n]/.test(prefix)) throw new Error('Invalid component secret binding policy'); secretBindings[id] = Object.freeze({ origin, header, prefix }); }
    if (Object.keys(secretBindings).length > 16) throw new Error('Component secret bindings must be bounded');
    if (capabilities.includes('network.fetch') && !networkOrigins.length) throw new Error('network.fetch requires declared networkOrigins');
    if (raw.events !== undefined && !Array.isArray(raw.events)) throw new Error('Component service events must be a bounded versioned allowlist');
    const events = [...new Set((raw.events || []).map(value => requiredText(value, 'service event', 128)))];
    if (events.length > 32 || events.some(event => !VERSIONED_METHOD.test(event))) throw new Error('Component service events must be a bounded versioned allowlist');
    if (raw.runtimeActions !== undefined && !Array.isArray(raw.runtimeActions)) throw new Error('Component runtime actions must be a bounded allowlist');
    const runtimeActions = [...new Set((raw.runtimeActions || []).map(value => requiredId(value, 'runtime action')))];
    if (runtimeActions.length > 32) throw new Error('Component runtime actions must be a bounded allowlist');
    if (raw.projectFolders !== undefined && !Array.isArray(raw.projectFolders)) throw new Error('Component project folders must be a bounded array');
    if ((raw.projectFolders || []).length > 32) throw new Error('Component project folders must be a bounded array');
    const projectFolderNames = new Set();
    const projectFolders = (raw.projectFolders || []).map(declaration => {
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw new Error('Invalid component project folder declaration');
      rejectUnknownFields(declaration, ['name', 'protectFromGenericRename', 'reserveProgressRelocationName', 'legacyAdoptionGrant'], 'component project folder');
      const name = requiredExactStringText(declaration.name, 'project folder name', 160);
      if (name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new Error('Invalid component project folder name');
      const nameKey = name.toLocaleLowerCase('zh-CN');
      if (projectFolderNames.has(nameKey)) throw new Error('Duplicate component project folder declaration');
      projectFolderNames.add(nameKey);
      if (declaration.protectFromGenericRename !== undefined && typeof declaration.protectFromGenericRename !== 'boolean') throw new Error('Invalid component project folder protection');
      if (declaration.reserveProgressRelocationName !== undefined && typeof declaration.reserveProgressRelocationName !== 'boolean') throw new Error('Invalid component project folder protection');
      const protectFromGenericRename = declaration.protectFromGenericRename === true;
      const reserveProgressRelocationName = declaration.reserveProgressRelocationName === true;
      if (!protectFromGenericRename && !reserveProgressRelocationName) throw new Error('Component project folder declaration must request a protection');
      const legacyAdoptionGrant = declaration.legacyAdoptionGrant === undefined ? null : requiredExactStringText(declaration.legacyAdoptionGrant, 'project folder legacy adoption grant', 128);
      if (legacyAdoptionGrant && !adoptionGrants.includes(legacyAdoptionGrant)) throw new Error('Component project folder legacy adoption grant is not granted');
      return Object.freeze({ name, protectFromGenericRename, reserveProgressRelocationName, legacyAdoptionGrant });
    });
    if (raw.lifecycleActions !== undefined && (!raw.lifecycleActions || typeof raw.lifecycleActions !== 'object' || Array.isArray(raw.lifecycleActions))) throw new Error('Component lifecycle actions must be a bounded mapping');
    const lifecycleActions = {};
    for (const [action, declaration] of Object.entries(raw.lifecycleActions || {})) {
      const actionId = requiredId(action, 'lifecycle action');
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw new Error(`Invalid component lifecycle action: ${actionId}`);
      const relativeActionEntry = requiredText(declaration.entry, 'lifecycle action entry', 512).replace(/\\/g, '/');
      const actionEntry = resolvePackageFile({ relativeEntry: relativeActionEntry, componentRoot, developmentOverride: developmentOverrideFor(developmentFiles, relativeActionEntry), label: 'Component lifecycle action entry' });
      const sha256 = requiredText(declaration.sha256, 'lifecycle action SHA-256', 64).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Invalid component lifecycle action SHA-256: ${actionId}`);
      lifecycleActions[actionId] = Object.freeze({ entry: actionEntry, relativeEntry: relativeActionEntry, sha256 });
    }
    if (Object.keys(lifecycleActions).length > 16) throw new Error('Component lifecycle actions must be bounded');
    let backupRestore = null;
    if (raw.backupRestore !== undefined) {
      const declaration = raw.backupRestore;
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw new Error('Invalid component backup restore declaration');
      rejectUnknownFields(declaration, ['transactionProtocolVersion', 'sourceManifestProtocolVersion', 'receiptProtocolVersion', 'workspace', 'project', 'sources'], 'component backup restore');
      for (const field of ['transactionProtocolVersion', 'sourceManifestProtocolVersion', 'receiptProtocolVersion']) {
        if (declaration[field] !== 1) throw new Error(`Unsupported component backup restore ${field}`);
      }
      const parseHook = (value, mode) => {
        if (value === undefined) return null;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid component ${mode} backup restore hook`);
        rejectUnknownFields(value, ['method'], `component ${mode} backup restore hook`);
        const method = requiredExactStringText(value.method, `${mode} backup restore method`, 128);
        if (!VERSIONED_METHOD.test(method) || !rpcMethods.includes(method)) throw new Error(`Component ${mode} backup restore method must be declared by the service`);
        return Object.freeze({ method });
      };
      if (!Array.isArray(declaration.sources) || declaration.sources.length < 1 || declaration.sources.length > 16) throw new Error('Component backup restore sources must be a bounded array');
      const sourceKeys = new Set();
      const sources = declaration.sources.map(source => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid component backup restore source');
        rejectUnknownFields(source, ['scope', 'path', 'format'], 'component backup restore source');
        const scope = requiredExactStringText(source.scope, 'backup restore source scope', 40);
        const sourcePath = requiredExactStringText(source.path, 'backup restore source path', 512);
        const format = requiredExactStringText(source.format, 'backup restore source format', 80);
        if (!['component-storage', 'domain-database'].includes(scope) || normalizeBackupSourcePath(sourcePath) !== sourcePath || sourcePath.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Invalid component backup restore source');
        if (scope === 'component-storage' && sourcePath.split('/')[0] !== componentId) throw new Error('Component backup restore storage source must be owned by the declaring component');
        if (scope === 'domain-database' && !ownsLegacyComponentDomainDatabase(componentId, sourcePath, adoptionPolicy)) throw new Error('Component backup restore domain database source is not owned by the declaring component');
        const key = `${scope}\0${sourcePath}`; if (sourceKeys.has(key)) throw new Error('Duplicate component backup restore source'); sourceKeys.add(key);
        return Object.freeze({ scope, path: sourcePath, format });
      });
      const workspace = parseHook(declaration.workspace, 'workspace'); const project = parseHook(declaration.project, 'project');
      if (!workspace && !project) throw new Error('Component backup restore must declare at least one hook');
      const hookMethods = [workspace?.method, project?.method].filter(Boolean);
      if (new Set(hookMethods).size !== hookMethods.length) throw new Error('Component backup restore hook methods must be unique');
      backupRestore = Object.freeze({
        transactionProtocolVersion: 1, sourceManifestProtocolVersion: 1, receiptProtocolVersion: 1,
        workspace, project, sources: Object.freeze(sources),
      });
    }
    const previewDecoders = parsePreviewDecoders(raw.previewDecoders, rpcMethods);
    if (previewDecoders.length && (!permissions.includes('project.input.read') || !capabilities.includes('project.input.tokens') || !capabilities.includes('component.transfer'))) throw new Error('Preview decoders require project.input.tokens, component.transfer and project.input.read');
    const hostOnlyRpcMethods = Object.freeze([backupRestore?.workspace?.method, backupRestore?.project?.method, ...previewDecoders.flatMap(item => [item.method, item.thumbnailMethod])].filter(Boolean));
    service = Object.freeze({
      protocolVersion: COMPONENT_SERVICE_PROTOCOL_VERSION,
      runtime: raw.runtime,
      entry,
      relativeEntry,
      rpcMethods: Object.freeze(rpcMethods),
      hostOnlyRpcMethods,
      previewDecoders,
      capabilities: Object.freeze(capabilities),
      permissions: Object.freeze(permissions),
      events: Object.freeze(events),
      runtimeActions: Object.freeze(runtimeActions),
      lifecycleActions: Object.freeze(lifecycleActions),
      projectFolders: Object.freeze(projectFolders),
      networkOrigins: Object.freeze(networkOrigins),
      secretBindings: Object.freeze(secretBindings),
      backupRestore,
    });
    for (const settingsPage of settingsPages) {
      const unknownMethod = settingsPage.rpcMethods.find(method => !rpcMethods.includes(method));
      if (unknownMethod) throw new Error(`Component settings page RPC method is not declared by the service: ${unknownMethod}`);
      if (settingsPage.rpcMethods.some(method => hostOnlyRpcMethods.includes(method))) throw new Error('Component settings page cannot expose a host-only RPC method');
    }
    if (settingsForms.length && (!capabilities.includes('component.settings') || !permissions.includes('component.settings'))) throw new Error('Declarative settings forms require component.settings and component.settings permission');
    for (const settingsForm of settingsForms) {
      const unknownMethod = settingsForm.customPage?.rpcMethods.find(method => !rpcMethods.includes(method));
      if (unknownMethod) throw new Error(`Declarative settings custom page RPC method is not declared by the service: ${unknownMethod}`);
      if (settingsForm.customPage?.rpcMethods.some(method => hostOnlyRpcMethods.includes(method))) throw new Error('Declarative settings custom page cannot expose a host-only RPC method');
    }
    for (const contribution of hostContributions) { const unknownMethod = contribution.rpcMethods.find(method => !rpcMethods.includes(method)); if (unknownMethod) throw new Error(`${contribution.type} RPC method is not declared by the service: ${unknownMethod}`); if (contribution.rpcMethods.some(method => hostOnlyRpcMethods.includes(method))) throw new Error(`${contribution.type} cannot expose a host-only RPC method`); }
  }
  let advancedRuntime = null;
  if (manifest.advancedRuntime !== undefined) {
    const raw = manifest.advancedRuntime;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid advanced runtime compatibility manifest');
    const apiVersion = raw.apiVersion;
    if (!Number.isInteger(apiVersion) || apiVersion < 1) throw new Error('Invalid advanced runtime API version');
    if (raw.compatibleLegacyComponentVersions !== undefined && !Array.isArray(raw.compatibleLegacyComponentVersions)) throw new Error('Invalid advanced runtime legacy compatibility list');
    const compatibleLegacyComponentVersions = [...new Set((raw.compatibleLegacyComponentVersions || []).map(value => requiredText(value, 'legacy component version', 80)))];
    if (compatibleLegacyComponentVersions.length > 16 || compatibleLegacyComponentVersions.some(version => !/^\d{2}\.\d{1,2}\.\d{1,2}\.\d+$/.test(version))) {
      throw new Error('Invalid advanced runtime legacy compatibility list');
    }
    advancedRuntime = Object.freeze({ apiVersion, compatibleLegacyComponentVersions: Object.freeze(compatibleLegacyComponentVersions) });
  }
  return Object.freeze({
    componentId,
    componentRoot: path.resolve(componentRoot),
    componentVersion: requiredText(manifest.version, 'component version', 80),
    contractVersion,
    adoptionGrants: Object.freeze([...adoptionGrants]),
    legacySettingsAdoptions: Object.freeze(legacySettingsAdoptions),
    toolbarAction: actions[0] ? Object.freeze({ ...actions[0], pageTitle: page.title }) : null,
    fullPage: page ? Object.freeze(page) : null,
    pages: Object.freeze([...pages.values()].map(value => Object.freeze(value))),
    settingsPages: Object.freeze(settingsPages),
    settingsForms: Object.freeze(settingsForms),
    contributions: Object.freeze(hostContributions),
    icon,
    service,
    advancedRuntime,
  });
};

const createComponentHostRegistry = ({ roots = [], candidateProvider = null, admitDescriptor = null, adoptionPolicy = defaultComponentDataAdoptionPolicy }) => {
  const candidates = () => {
    const values = [];
    for (const root of roots) {
      let entries = [];
      try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !IDENTIFIER.test(entry.name)) continue;
        const container = path.join(root.path, entry.name);
        const runtime = path.join(container, 'runtime');
        const componentRoot = fs.existsSync(path.join(runtime, 'component.json')) ? runtime : container;
        const manifestPath = path.join(componentRoot, 'component.json');
        if (fs.existsSync(manifestPath)) values.push({ componentRoot, manifestPath, expectedId: entry.name, source: root.source });
      }
    }
    return values;
  };
  const inspectRoot = ({ componentRoot, manifestPath = path.join(componentRoot, 'component.json'), manifest: providedManifest = null, developmentFiles = null, developmentRuntime = null, expectedId = '', source }) => {
    const manifest = providedManifest || JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (expectedId && manifest.id !== expectedId) throw new Error(`Component id does not match its directory: ${manifest.id || 'missing'}`);
    const descriptor = parseComponentHostManifest(manifest, componentRoot, developmentFiles, adoptionPolicy);
    if (descriptor && admitDescriptor && admitDescriptor(descriptor, componentRoot, source) !== true) throw new Error(`Component host admission rejected: ${descriptor.componentId}`);
    return descriptor ? { ...descriptor, componentRoot, source, ...(developmentFiles ? { development: true } : {}), ...(developmentRuntime ? { developmentRuntime } : {}) } : null;
  };
  const list = () => {
    const byId = new Map();
    for (const candidate of candidateProvider ? candidateProvider() : candidates()) {
      try {
        const descriptor = inspectRoot(candidate);
        if (descriptor && !byId.has(descriptor.componentId)) byId.set(descriptor.componentId, descriptor);
      } catch { /* malformed UI components are rejected, not partially registered */ }
    }
    return [...byId.values()];
  };
  const resolve = componentId => list().find(item => item.componentId === componentId) || null;
  return { list, resolve, inspectRoot };
};

module.exports = {
  COMPONENT_HOST_CONTRACT_VERSION,
  COMPONENT_SERVICE_PROTOCOL_VERSION,
  CONTRIBUTION_TYPES,
  HOST_CAPABILITIES,
  HOST_PERMISSIONS,
  CAPABILITY_PERMISSIONS,
  COMPONENT_ICON_MIME_TYPES,
  MAX_COMPONENT_ICON_BYTES,
  createComponentHostRegistry,
  parseComponentIcon,
  resolvePackageFile,
  parseComponentHostManifest,
  isSettingsOnlyHost,
  ownsLegacyComponentDomainDatabase,
  isOwnedLegacyComponentDomainDatabase,
};
