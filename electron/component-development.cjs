const fs = require('fs');
const path = require('path');

const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_METADATA_BYTES = 1024 * 1024;
const ALLOWED_DEVELOPMENT_FIELDS = new Set(['prepare', 'runtime', 'files']);
const ALLOWED_RUNTIME_FIELDS = new Set(['command', 'entry', 'argsPrefix']);
const TEST_SUITE = /^[a-z][a-z0-9-]*$/;

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const relativeFile = (value, label) => {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0')) throw new Error(`Invalid ${label}`);
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => !part || part === '..')) throw new Error(`${label} must be a component-local relative file`);
  return normalized;
};
const safeFile = (root, relative, label) => {
  const candidate = path.resolve(root, relativeFile(relative, label));
  if (!isInside(root, candidate)) throw new Error(`${label} escapes the component root`);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is missing or unsafe: ${relative}`);
  const realRoot = fs.realpathSync(root); const realCandidate = fs.realpathSync(candidate);
  if (!isInside(realRoot, realCandidate)) throw new Error(`${label} escapes the component root through a linked path`);
  return realCandidate;
};
const safeDirectory = value => {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || value.startsWith('\\\\')) return null;
  const resolved = path.resolve(value); const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
  const real = fs.realpathSync(resolved);
  return real === resolved || process.platform === 'win32' && real.toLowerCase() === resolved.toLowerCase() ? real : null;
};

const developmentRoots = ({ projectRoot, environment = process.env }) => {
  const explicit = String(environment.PHOTOFLOW_COMPONENT_DEV_ROOTS || '').split(path.delimiter).map(value => value.trim()).filter(Boolean);
  const defaultsEnabled = !['0', 'false', 'off'].includes(String(environment.PHOTOFLOW_COMPONENT_DEV_DEFAULTS || '').trim().toLowerCase());
  const candidates = [...explicit, ...(defaultsEnabled ? [path.join(projectRoot, 'extensions')] : [])];
  const seen = new Set(); const roots = [];
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : '';
    const safe = absolute && safeDirectory(absolute);
    if (!safe) continue;
    const key = process.platform === 'win32' ? safe.toLowerCase() : safe;
    if (!seen.has(key)) { seen.add(key); roots.push(safe); }
  }
  return roots;
};

const componentDirectories = root => {
  const values = [];
  if (fs.existsSync(path.join(root, 'package.json'))) values.push(root);
  let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return values; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink?.() || entry.name.startsWith('.')) continue;
    const directory = path.join(root, entry.name); const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat?.isDirectory() && !stat.isSymbolicLink() && fs.existsSync(path.join(directory, 'package.json'))) values.push(directory);
  }
  return values;
};

const fileMetadataToken = filePath => {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  return stat?.isFile() ? `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : 'missing';
};

// Discovery is called by several independent renderer catalog requests.  A
// cheap metadata token lets the registry reuse the fully validated result
// while still noticing package/manifest edits and added or removed components.
const developmentComponentMetadataToken = options => {
  const values = [];
  for (const root of developmentRoots(options)) {
    values.push(`root:${root}`);
    for (const componentRoot of componentDirectories(root)) {
      const packagePath = path.join(componentRoot, 'package.json');
      values.push(`package:${componentRoot}:${fileMetadataToken(packagePath)}`);
      try {
        const packageManifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        const component = packageManifest?.photoflowComponent;
        const manifestRelative = component?.manifest;
        if (typeof manifestRelative === 'string' && manifestRelative) {
          const manifestPath = path.resolve(componentRoot, manifestRelative);
          values.push(`manifest:${manifestPath}:${isInside(componentRoot, manifestPath) ? fileMetadataToken(manifestPath) : 'unsafe'}`);
        }
        const development = component?.development;
        const runtimeCommands = typeof development?.runtime?.command === 'string' ? [development.runtime.command] : Object.values(development?.runtime?.command || {});
        const developmentFiles = [...Object.values(development?.files || {}), ...runtimeCommands, development?.runtime?.entry].filter(value => typeof value === 'string' && value);
        for (const relative of developmentFiles) {
          const candidate = path.resolve(componentRoot, relative);
          values.push(`file:${relative}:${isInside(componentRoot, candidate) ? fileMetadataToken(candidate) : 'unsafe'}`);
        }
      } catch {
        values.push('package-invalid');
      }
    }
  }
  return values.join('|');
};

const declaredDevelopmentFiles = manifest => new Set([
  manifest.icon,
  ...Object.values(manifest.entrypoints || {}),
  ...(manifest.requiredFiles || []),
  ...(manifest.componentHost?.contributions || []).map(item => item?.entry),
  ...(manifest.componentHost?.contributions || []).map(item => item?.customPage?.entry),
  ...Object.values(manifest.componentHost?.service?.entrypoints || {}),
  ...Object.values(manifest.componentHost?.service?.lifecycleActions || {}).map(item => item?.entry),
].filter(Boolean).map(value => relativeFile(value, 'manifest file declaration')));

const inspectDevelopmentComponent = (componentRoot, { platform = process.platform, arch = process.arch } = {}) => {
  const packagePath = safeFile(componentRoot, 'package.json', 'component package metadata');
  if (fs.statSync(packagePath).size > MAX_METADATA_BYTES) throw new Error('Component package metadata is too large');
  const packageManifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const component = packageManifest.photoflowComponent;
  if (!component || typeof component !== 'object' || Array.isArray(component)) return null;
  const unknownComponent = Object.keys(component).filter(field => !['manifest', 'development', 'tests'].includes(field));
  if (unknownComponent.length) throw new Error(`Unknown photoflowComponent field: ${unknownComponent[0]}`);
  if (component.tests !== undefined) {
    if (!component.tests || typeof component.tests !== 'object' || Array.isArray(component.tests)) throw new Error('Component tests must be a suite mapping');
    for (const [suite, files] of Object.entries(component.tests)) {
      if (!TEST_SUITE.test(suite) || !Array.isArray(files) || files.length > 16 || new Set(files).size !== files.length || files.some(file => typeof file !== 'string' || file.length > 256 || !/\.(?:cjs|mjs)$/.test(file))) throw new Error(`Invalid declared component test suite: ${suite}`);
      for (const file of files) relativeFile(file, `component test ${suite}`);
    }
  }
  const development = component.development;
  if (!development || typeof development !== 'object' || Array.isArray(development)) return null;
  const unknownDevelopment = Object.keys(development).filter(field => !ALLOWED_DEVELOPMENT_FIELDS.has(field));
  if (unknownDevelopment.length) throw new Error(`Unknown component development field: ${unknownDevelopment[0]}`);
  const manifestRelative = relativeFile(component.manifest, 'component manifest');
  const manifestPath = safeFile(componentRoot, manifestRelative, 'component development manifest');
  if (fs.statSync(manifestPath).size > MAX_METADATA_BYTES) throw new Error('Component development manifest is too large');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.id !== 'string' || !COMPONENT_ID.test(manifest.id)) throw new Error('Invalid development component id');
  const files = development.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Component development files must be an explicit mapping');
  const declared = declaredDevelopmentFiles(manifest); const resolvedFiles = {};
  for (const [packagedName, developmentName] of Object.entries(files)) {
    const normalized = relativeFile(packagedName, 'component development file key');
    if (!declared.has(normalized)) throw new Error(`Development mapping targets an undeclared component file: ${normalized}`);
    resolvedFiles[normalized] = safeFile(componentRoot, developmentName, `development file ${normalized}`);
  }
  const runtime = development.runtime;
  if (development.prepare !== undefined && (typeof development.prepare !== 'string' || !/^[a-z0-9:._-]{1,80}$/i.test(development.prepare) || !packageManifest.scripts?.[development.prepare])) throw new Error('Component development prepare must name a package script');
  // Node services already run with the host's Node runtime. They need no separate
  // algorithm executable or copied Node installation in their source directory.
  if (runtime === undefined && manifest.componentHost?.service?.runtime === 'node') {
    return Object.freeze({ componentRoot, packagePath, packageManifest, manifestPath, manifest, id: manifest.id, files: Object.freeze(resolvedFiles), command: '', argsPrefix: Object.freeze([]), prepare: development.prepare || '' });
  }
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('Component development runtime is required');
  const unknownRuntime = Object.keys(runtime).filter(field => !ALLOWED_RUNTIME_FIELDS.has(field));
  if (unknownRuntime.length) throw new Error(`Unknown component development runtime field: ${unknownRuntime[0]}`);
  const commandDeclaration = runtime.command;
  const commandRelative = typeof commandDeclaration === 'string' ? commandDeclaration : commandDeclaration?.[`${platform}-${arch}`] || commandDeclaration?.[platform] || commandDeclaration?.default;
  const command = safeFile(componentRoot, commandRelative, 'component development runtime command');
  if (/\.(?:cmd|bat)$/i.test(command)) throw new Error('Component development runtime command must be a directly spawnable executable, not a batch wrapper');
  const entry = runtime.entry === undefined ? '' : safeFile(componentRoot, runtime.entry, 'component development runtime entry');
  const argsPrefix = runtime.argsPrefix === undefined ? [] : runtime.argsPrefix;
  if (!Array.isArray(argsPrefix) || argsPrefix.length > 16 || argsPrefix.some(value => typeof value !== 'string' || !value.startsWith('-') || value.length > 128)) throw new Error('Component development runtime argsPrefix must contain bounded option flags');
  return Object.freeze({ componentRoot, packagePath, packageManifest, manifestPath, manifest, id: manifest.id, files: Object.freeze(resolvedFiles), command, argsPrefix: Object.freeze([...argsPrefix, ...(entry ? [entry] : [])]), prepare: development.prepare || '' });
};

const developmentManifestForError = componentRoot => {
  try {
    const packagePath = safeFile(componentRoot, 'package.json', 'component package metadata');
    const packageManifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const component = packageManifest.photoflowComponent;
    if (!component || typeof component !== 'object' || Array.isArray(component)) return null;
    const manifestPath = safeFile(componentRoot, relativeFile(component.manifest, 'component manifest'), 'component development manifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
  } catch {
    return null;
  }
};

const discoverDevelopmentComponents = options => {
  const results = [];
  for (const root of developmentRoots(options)) for (const componentRoot of componentDirectories(root)) {
    try {
      const component = inspectDevelopmentComponent(componentRoot, options);
      if (component) results.push({ ...component, developmentRoot: root });
    } catch (error) {
      const manifest = developmentManifestForError(componentRoot);
      results.push({ componentRoot, developmentRoot: root, id: String(manifest?.id || path.basename(componentRoot)), ...(manifest ? { manifest } : {}), error: error.message || String(error) });
    }
  }
  return results;
};

module.exports = { developmentRoots, developmentComponentMetadataToken, discoverDevelopmentComponents, inspectDevelopmentComponent, relativeFile, safeFile };
