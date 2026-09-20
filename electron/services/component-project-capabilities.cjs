const { localizeDialogOptions } = require("./localization.cjs");
const { t: translateNative } = require("./localization.cjs");
const { sendToRequestingRenderer } = require('./application-windows.cjs');
const { requestAppConfirmation } = require('./app-dialog-confirmation.cjs');
const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
const { adoptLegacyStorageV1 } = require('./component-storage-adoption.cjs');
const { nextComponentRevision, normalizeComponentRevision } = require('./config-mutation-service.cjs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const MAX_MEDIA_PAGE_SIZE = 200;
const MAX_INPUT_TOKENS = 2000;
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_INLINE_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_STAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_INPUT_ENTRIES = 20_000;
const MAX_INPUT_DEPTH = 64;
const INPUT_TOKEN_TTL_MS = 10 * 60 * 1000;
const INPUT_RESERVATION_TTL_MS = 30 * 60 * 1000;
const CURSOR_TTL_MS = 5 * 60 * 1000;
const STAGE_TTL_MS = 24 * 60 * 60 * 1000;
const STAGE_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const SAFE_STAGE_ID = /^[a-f0-9-]{16,80}$/i;
const EVENT_TOPIC = /^[a-z][a-z0-9.-]{0,119}\.v[1-9][0-9]*$/;

const inputGrants = new Map();
const listSessions = new Map();
const outputStages = new Map();
const componentTaskHandles = new Map();
const committedOutputs = new Map();
const createdVersions = new Map();
const commitOperations = new Map();
const outputTargetOperations = new Map();
const versionOperations = new Map();
const storageAdoptions = new Map();
const componentInputRoots = new Map();
const inputRootInitialization = new Map();
const discardInputGrant = async (fs, grant, { waitForMaterialize = true } = {}) => {
  clearTimeout(grant?.cleanupTimer); if (grant) grant.cleanupTimer = null;
  if(waitForMaterialize&&grant?.materializePromise)await grant.materializePromise.catch(()=>undefined);
  if (!grant?.snapshotRoot || grant.snapshotCleanup) return grant?.snapshotCleanup || Promise.resolve();
  const snapshotRoot = grant.snapshotRoot;const snapshotPath=grant.snapshotPath;
  grant.snapshotRoot = ''; grant.snapshotPath = '';
  grant.snapshotCleanup = fs.promises.rm(snapshotRoot, { recursive: true, force: true }).catch(error=>{grant.snapshotRoot=snapshotRoot;grant.snapshotPath=snapshotPath;throw error;}).finally(() => { grant.snapshotCleanup = null; });
  return grant.snapshotCleanup;
};

const insideOrEqual = (path, root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const inside = (path, root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const normalizeRelativePath = value => String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '');
const assertRelativePath = (path, value, field = 'relativePath') => {
  const normalized = normalizeRelativePath(value);
  if (!normalized || normalized.length > 1024 || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw hostError(CODES.INVALID_REQUEST, `Invalid ${field}`);
  }
  if (path.isAbsolute(normalized)) throw hostError(CODES.INVALID_REQUEST, `Invalid ${field}`);
  return normalized;
};
const scopeKey = (descriptor, context) => `${descriptor.componentId}\0${context.workspacePath}\0${context.projectId}`;
const boundedObject = (value, maxBytes, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw hostError(CODES.INVALID_REQUEST, `${label} must be an object`);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maxBytes) throw hostError(CODES.LIMIT_EXCEEDED, `${label} is too large`);
  return JSON.parse(serialized);
};
const pruneExpiringMaps = (fs, now) => {
  for (const [key, value] of inputGrants) {
    if (value.reservedBy && value.reservationExpiresAt > now) continue;
    if (value.reservedBy) { delete value.reservedBy; delete value.reservationExpiresAt; value.expiresAt = value.originalExpiresAt ?? value.expiresAt; delete value.originalExpiresAt; }
    if (value.expiresAt <= now) { inputGrants.delete(key); void discardInputGrant(fs, value).catch(() => undefined); }
  }
  for (const [key, value] of listSessions) if (value.expiresAt <= now) listSessions.delete(key);
};
const replaceJsonAtomic = async ({ fs, crypto, filePath, value }) => {
  await fs.promises.mkdir(require('path').dirname(filePath), { recursive: true });
  const token = crypto.randomUUID();
  const pending = `${filePath}.${token}.tmp`;
  const backup = `${filePath}.${token}.backup`;
  let backedUp = false;
  await fs.promises.writeFile(pending, JSON.stringify(value, null, 2), 'utf8');
  try {
    if (fs.existsSync(filePath)) { await fs.promises.rename(filePath, backup); backedUp = true; }
    await fs.promises.rename(pending, filePath);
    if (backedUp) { await fs.promises.rm(backup, { force: true }); backedUp = false; }
  } catch (error) {
    await fs.promises.rm(pending, { force: true }).catch(() => undefined);
    if (backedUp && !fs.existsSync(filePath)) {
      try { await fs.promises.rename(backup, filePath); backedUp = false; }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], `Receipt update failed and backup was preserved at ${backup}`); }
    }
    throw error;
  }
};
const readJson = async (fs, filePath) => {
  try { return JSON.parse(await fs.promises.readFile(filePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
};
const stableUuid = (crypto, value) => {
  const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const sha256File = (fs, crypto, filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  input.on('error', reject);
  input.on('data', chunk => hash.update(chunk));
  input.on('end', () => resolve(hash.digest('hex')));
});
const adoptExistingOutput = async ({ fs, path, crypto, componentRoot, componentId, projectId, scopeDigest: digest, projectRoot, migrationId, outputs }) => {
  if (!ID.test(String(migrationId || '')) || !Array.isArray(outputs) || !outputs.length || outputs.length > 2000) throw hostError(CODES.INVALID_REQUEST, 'Invalid output adoption request');
  const commitId = stableUuid(crypto, `component-output-adoption\0${componentId}\0${projectId}\0${migrationId}`);
  const receiptPath = path.join(componentRoot, 'receipts', 'commits', `${commitId}.json`);
  if (fs.existsSync(receiptPath)) return JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
  const adopted = [];
  const canonicalProjectRoot = await fs.promises.realpath(projectRoot).catch(() => null);
  if (!canonicalProjectRoot) throw hostError(CODES.NOT_FOUND, 'Bound project root is unavailable');
  for (const item of outputs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw hostError(CODES.INVALID_REQUEST, 'Invalid output adoption source');
    const hasSourcePath = Object.prototype.hasOwnProperty.call(item, 'sourcePath');
    const hasRelativePath = Object.prototype.hasOwnProperty.call(item, 'relativePath');
    if (hasSourcePath === hasRelativePath) throw hostError(CODES.INVALID_REQUEST, 'Output adoption must identify exactly one source');
    const sourcePath = typeof item.sourcePath === 'string' ? item.sourcePath : '';
    if (hasSourcePath && (!sourcePath || sourcePath.length > 4096 || sourcePath.includes('\0'))) throw hostError(CODES.INVALID_REQUEST, 'Invalid output adoption source');
    const requestedPath = hasSourcePath ? sourcePath : path.resolve(projectRoot, assertRelativePath(path, item.relativePath, 'existing output relativePath'));
    if (hasSourcePath && !path.isAbsolute(requestedPath)) throw hostError(CODES.INVALID_REQUEST, 'Output adoption source must be absolute');
    const filePath = path.resolve(requestedPath);
    if (!inside(path, projectRoot, filePath)) throw hostError(CODES.PERMISSION_DENIED, 'Legacy adopted output escapes project');
    const stat = await fs.promises.lstat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw hostError(CODES.NOT_FOUND, 'Legacy adopted output is missing or unsafe');
    const canonicalFilePath = await fs.promises.realpath(filePath).catch(() => null);
    if (!canonicalFilePath || !inside(path, canonicalProjectRoot, canonicalFilePath)) throw hostError(CODES.PERMISSION_DENIED, 'Legacy adopted output escapes the physical project boundary');
    const relativePath = assertRelativePath(path, path.relative(projectRoot, filePath), 'existing output relativePath');
    adopted.push({ artifactId: String(item.artifactId || stableUuid(crypto, `${commitId}\0${relativePath}`)), relativePath, size: stat.size, sha256: await sha256File(fs, crypto, filePath), published: true });
  }
  const receipt = { schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-output-commit', state: 'committed', commitId, idempotencyKey: `legacy-${migrationId}`.slice(0, 80), componentId, projectId: String(projectId), scopeDigest: digest, stageId: stableUuid(crypto, `${commitId}\0adopted-stage`), createdAt: Date.now(), committedAt: Date.now(), outputs: adopted };
  await replaceJsonAtomic({ fs, crypto, filePath: receiptPath, value: receipt });
  return receipt;
};
const resetComponentHostCapabilityStateForTest = () => {
  inputGrants.clear(); listSessions.clear(); outputStages.clear(); componentTaskHandles.clear(); committedOutputs.clear(); createdVersions.clear(); commitOperations.clear(); outputTargetOperations.clear(); versionOperations.clear(); storageAdoptions.clear(); componentInputRoots.clear(); inputRootInitialization.clear();
};

const registerComponentProjectCapabilities = ({
  broker, ensureWorkspace, getWorkspaceDataRoot, resolveProjectEntry, versionService,
  IMAGE_EXTENSIONS, VIDEO_EXTENSIONS = new Set(), RAW_EXTENSIONS = new Set(),
  path, fs, crypto, getConfigPath, readSavedConfig, getProjectPath, dialog, mainWindow, shell, requestConfirmation = presentation => requestAppConfirmation(mainWindow?.webContents, presentation),
  getComponentDataRoot = null,
  mediaService, backgroundTasks, ensureTrackedVersionThumbnail, getBoundProject = null, projectVirtualPaths = null, resolveComponentContentBinding = null,
  replaceJson = replaceJsonAtomic, readConfig = null, mutateConfig = null, now = Date.now, adoptionInteractiveBudgetMs = 25, adoptionFaultInjector = () => undefined,
}) => {
  const bound = (context, descriptor) => {
    const binding = resolveComponentContentBinding?.(context);
    if (context?.contentKind === 'inspiration' && !binding) throw hostError(CODES.NOT_FOUND, 'Inspiration content binding is unavailable');
    const workspaceRoot = binding?.workspaceRoot || ensureWorkspace(context.workspacePath);
    const project = binding?.project || getBoundProject?.(workspaceRoot, context.projectName);
    if (!project || String(project.id || '') !== String(context.projectId || '')) throw hostError(CODES.NOT_FOUND, 'Bound project is unavailable');
    const projectRoot = binding?.projectRoot || path.resolve(getProjectPath(workspaceRoot, project.status || context.projectStatus, project.name || context.projectName));
    const componentRoot = path.join(getWorkspaceDataRoot(workspaceRoot), 'components', descriptor.componentId);
    return { workspaceRoot, project, projectRoot, componentRoot, contentKind: binding?.contentKind || 'project', key: scopeKey(descriptor, context) };
  };
  const kindFor = filePath => {
    const extension = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) ? 'image' : RAW_EXTENSIONS.has(extension) ? 'raw' : VIDEO_EXTENSIONS.has(extension) ? 'video' : 'file';
  };
  const managedBoundary = (scope, filePath, relativeHint = '') => {
    const candidate = path.resolve(filePath);
    if (insideOrEqual(path, scope.projectRoot, candidate)) return { relativePath: normalizeRelativePath(relativeHint || path.relative(scope.projectRoot, candidate)), viaExternalLink: false };
    throw hostError(CODES.PERMISSION_DENIED, 'Media is outside the project content boundary');
  };
  const resolveSafeMedia = async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    if (scope.contentKind === 'inspiration') {
      if (payload.photoId) throw hostError(CODES.INVALID_REQUEST, 'Inspiration media must be addressed by relativePath');
      const relativePath = assertRelativePath(path, payload.relativePath, 'media relativePath');
      const filePath = path.resolve(scope.projectRoot, relativePath);
      if (!inside(path, scope.projectRoot, filePath)) throw hostError(CODES.PERMISSION_DENIED, 'Media escapes the inspiration library');
      const stat = await fs.promises.lstat(filePath).catch(() => null);
      const canonicalRoot = await fs.promises.realpath(scope.projectRoot).catch(() => null);
      const canonicalFile = await fs.promises.realpath(filePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || !canonicalRoot || !canonicalFile || !inside(path, canonicalRoot, canonicalFile)) throw hostError(CODES.NOT_FOUND, 'Inspiration media is missing or unsafe');
      return { ...scope, bundle: null, version: null, filePath, relativePath, viaExternalLink: false };
    }
    if (payload.photoId) {
      const bundle = await versionService.getPhoto(scope.workspaceRoot, String(payload.photoId));
      if (String(bundle?.photo?.projectId || '') !== String(scope.project.id)) throw hostError(CODES.TOKEN_SCOPE, 'Media is outside the bound project');
      const versions = bundle.versions || [];
      const version = payload.versionId
        ? versions.find(item => String(item.id) === String(payload.versionId))
        : versions.find(item => item.isCurrent) || versions.at(-1);
      if (!version) throw hostError(CODES.NOT_FOUND, 'Media version was not found');
      const filePath = path.resolve(String(version.filePath || ''));
      const boundary = managedBoundary(scope, filePath);
      return { ...scope, bundle, version, filePath, ...boundary };
    }
    const relativePath = assertRelativePath(path, payload.relativePath, 'media relativePath');
    const filePath = path.resolve(resolveProjectEntry(context.workspacePath, context.projectStatus, context.projectName, relativePath));
    const boundary = managedBoundary(scope, filePath, relativePath);
    const bundle = await versionService.getMedia(scope.workspaceRoot, { projectName: context.projectName, filePath });
    if (String(bundle?.photo?.projectId || '') !== String(scope.project.id)) throw hostError(CODES.TOKEN_SCOPE, 'Media is outside the bound project');
    const version = (bundle.versions || []).find(item => path.resolve(String(item.filePath || '')) === filePath)
      || (bundle.versions || []).find(item => item.isCurrent) || (bundle.versions || []).at(-1);
    return { ...scope, bundle, version, filePath, ...boundary };
  };
  const grantInput = (filePath, descriptor, context, boundary = null) => {
    pruneExpiringMaps(fs, Date.now());
    if (inputGrants.size >= MAX_INPUT_TOKENS) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many active component input grants');
    const token = `component-input:${crypto.randomUUID()}`;
    const expiresAt = Date.now() + INPUT_TOKEN_TTL_MS;
    const stat = fs.lstatSync(filePath);
    const grant = { filePath, scope: scopeKey(descriptor, context), expiresAt, ttlRemainingMs: INPUT_TOKEN_TTL_MS, usesRemaining: 1, boundary, snapshotPath: '', snapshotRoot: '', cleanupTimer: null, materializePromise:null, activeLeases:0, consumeClaimed:false,
      identity: { dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs } };
    grant.cleanupTimer = setTimeout(() => { if (inputGrants.get(token) === grant && !grant.reservedBy) { inputGrants.delete(token); void discardInputGrant(fs, grant).catch(() => undefined); } }, INPUT_TOKEN_TTL_MS);
    grant.cleanupTimer.unref?.(); inputGrants.set(token, grant);
    return { token, expiresAt };
  };
  const samePhysicalPath = (left, right) => process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
  const armGrantTimer=(token,grant,delay)=>{clearTimeout(grant.cleanupTimer);grant.ttlRemainingMs=Math.max(1,delay);grant.expiresAt=Date.now()+grant.ttlRemainingMs;grant.cleanupTimer=setTimeout(()=>{if(inputGrants.get(token)===grant&&!grant.reservedBy&&!grant.materializePromise){inputGrants.delete(token);void discardInputGrant(fs,grant).catch(()=>undefined);}},grant.ttlRemainingMs);grant.cleanupTimer.unref?.();};
  const openVerifiedInputGrant = async (grant, token) => {
    let handle;
    try {
      const before = await fs.promises.lstat(grant.filePath);
      if (before.isSymbolicLink() || !before.isFile() && !before.isDirectory()) throw new Error('unsafe input type');
      const realPath = await fs.promises.realpath(grant.filePath);
      if (!samePhysicalPath(realPath, grant.filePath) || grant.boundary && !insideOrEqual(path, grant.boundary, realPath)) throw new Error('input escaped its boundary');
      if (before.isDirectory()) {
        if (String(before.dev) !== grant.identity.dev || String(before.ino) !== grant.identity.ino) throw new Error('directory identity changed');
        return { grant, handle: null, stat: before, realPath };
      }
      handle = await fs.promises.open(grant.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || String(opened.dev) !== grant.identity.dev || String(opened.ino) !== grant.identity.ino || opened.size !== grant.identity.size || opened.mtimeMs !== grant.identity.mtimeMs) throw new Error('input identity changed');
      return { grant, handle, stat: opened, realPath };
    } catch {
      await handle?.close().catch(() => undefined);
      const key=String(token||''); if(inputGrants.get(key)===grant)inputGrants.delete(key); await discardInputGrant(fs,grant,{waitForMaterialize:false}).catch(()=>undefined);
      throw hostError(grant.expectedDigest ? CODES.CONFLICT : CODES.PERMISSION_DENIED, 'Component input changed after authorization');
    }
  };
  const copyDirectorySnapshot = async (sourceRoot, destinationRoot, grant) => {
    const rootIdentity = await fs.promises.lstat(sourceRoot);
    const pending = [{ source: sourceRoot, destination: destinationRoot, depth: 0 }];
    let entries = 0; let bytes = 0;
    while (pending.length) {
      const current = pending.pop();
      if (current.depth > MAX_INPUT_DEPTH) throw hostError(CODES.LIMIT_EXCEEDED, 'Component directory input snapshot is too deep');
      const sourceStat = await fs.promises.lstat(current.source);
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw hostError(CODES.PERMISSION_DENIED, 'Component directory input contains an unsafe directory');
      const canonical = await fs.promises.realpath(current.source);
      if (!insideOrEqual(path, sourceRoot, canonical)) throw hostError(CODES.PERMISSION_DENIED, 'Component directory input escapes through a link');
      await fs.promises.mkdir(current.destination, { recursive: false });
      const directory = await fs.promises.opendir(current.source);
      for await (const entry of directory) {
        entries += 1;
        if (entries > MAX_INPUT_ENTRIES) throw hostError(CODES.LIMIT_EXCEEDED, 'Component directory input snapshot has too many entries');
        const source = path.join(current.source, entry.name); const destination = path.join(current.destination, entry.name);
        const before = await fs.promises.lstat(source);
        if (before.isSymbolicLink()) throw hostError(CODES.PERMISSION_DENIED, 'Component directory input contains a symbolic link');
        if (before.isDirectory()) { pending.push({ source, destination, depth: current.depth + 1 }); continue; }
        if (!before.isFile()) throw hostError(CODES.PERMISSION_DENIED, 'Component directory input contains an unsupported file type');
        let sourceHandle; let destinationHandle; let sourceStream; let destinationStream;
        try {
          sourceHandle = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          const opened = await sourceHandle.stat();
          if (!opened.isFile() || String(opened.dev) !== String(before.dev) || String(opened.ino) !== String(before.ino) || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw hostError(CODES.PERMISSION_DENIED, 'Component directory input changed while snapshotting');
          destinationHandle = await fs.promises.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
          const limiter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > MAX_STAGE_BYTES ? hostError(CODES.LIMIT_EXCEEDED, 'Component directory input snapshot is too large') : null, chunk); } });
          sourceStream = sourceHandle.createReadStream({ autoClose: false });
          destinationStream = destinationHandle.createWriteStream({ autoClose: false });
          await pipeline(sourceStream, limiter, destinationStream);
          const after = await sourceHandle.stat(); const copied = await destinationHandle.stat();
          if (String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || copied.size !== before.size) throw hostError(CODES.PERMISSION_DENIED, 'Component directory input changed while snapshotting');
        } finally { sourceStream?.destroy(); destinationStream?.destroy(); await sourceHandle?.close().catch(() => undefined); await destinationHandle?.close().catch(() => undefined); }
      }
    }
    const afterRoot = await fs.promises.lstat(sourceRoot);
    if (String(afterRoot.dev) !== String(rootIdentity.dev) || String(afterRoot.ino) !== String(rootIdentity.ino) || String(afterRoot.dev) !== grant.identity.dev || String(afterRoot.ino) !== grant.identity.ino) throw hostError(CODES.PERMISSION_DENIED, 'Component directory input changed while snapshotting');
  };
  const buildVerifiedGrantSnapshot = async (grant, token, descriptor, context) => {
    if (grant.snapshotPath) {
      const cached = await fs.promises.lstat(grant.snapshotPath).catch(() => null);
      if (cached && !cached.isSymbolicLink() && (cached.isFile() || cached.isDirectory())) return grant.snapshotPath;
      await discardInputGrant(fs, grant,{waitForMaterialize:false}).catch(() => undefined);
    }
    const opened = await openVerifiedInputGrant(grant, token);
    const scope = bound(context, descriptor);
    const inputRoot=path.join(scope.componentRoot,'inputs');const rootKey=path.resolve(inputRoot);let initialization=inputRootInitialization.get(rootKey);if(!initialization){initialization=fs.promises.rm(inputRoot,{recursive:true,force:true}).catch(error=>{inputRootInitialization.delete(rootKey);throw error;});inputRootInitialization.set(rootKey,initialization);}await initialization;let roots=componentInputRoots.get(descriptor.componentId);if(!roots){roots=new Set();componentInputRoots.set(descriptor.componentId,roots);}roots.add(inputRoot);
    const directory = path.join(inputRoot, crypto.randomUUID());
    const destination = path.join(directory, path.basename(opened.realPath));
    grant.snapshotRoot = directory; grant.snapshotPath = ''; grant.snapshotOwner = grant.reservedBy || String(token);
    await fs.promises.mkdir(path.dirname(directory), { recursive: true });
    await fs.promises.mkdir(directory, { recursive: false });
    let sourceStream;
    try {
      if (opened.handle) {
        sourceStream = opened.handle.createReadStream({ autoClose: false });
        await pipeline(sourceStream, fs.createWriteStream(destination, { flags: 'wx' }));
        const after = await opened.handle.stat();
        if (grant.expectedDigest && await sha256File(fs, crypto, destination) !== grant.expectedDigest) throw hostError(CODES.CONFLICT, 'Component input content changed after authorization');
        if (String(after.dev) !== grant.identity.dev || String(after.ino) !== grant.identity.ino || after.size !== grant.identity.size || after.mtimeMs !== grant.identity.mtimeMs) throw hostError(grant.expectedDigest ? CODES.CONFLICT : CODES.PERMISSION_DENIED, 'Component input changed while snapshotting');
      } else {
        await copyDirectorySnapshot(opened.realPath, destination, grant);
      }
    } catch (error) { await discardInputGrant(fs, grant,{waitForMaterialize:false}).catch(() => undefined); throw error; }
    finally { sourceStream?.destroy(); await opened.handle?.close().catch(() => undefined); }
    grant.snapshotPath = destination;
    return destination;
  };
  const materializeVerifiedGrant=async(grant,token,descriptor,context)=>{
    if(grant.materializePromise)return grant.materializePromise;
    const remaining=Math.max(1,grant.expiresAt-Date.now());clearTimeout(grant.cleanupTimer);grant.cleanupTimer=null;grant.activeLeases=(grant.activeLeases||0)+1;
    const operation=buildVerifiedGrantSnapshot(grant,token,descriptor,context);grant.materializePromise=operation;
    try{return await operation;}finally{grant.activeLeases=Math.max(0,(grant.activeLeases||1)-1);if(grant.materializePromise===operation)grant.materializePromise=null;if(inputGrants.get(String(token))===grant&&!grant.reservedBy)armGrantTimer(String(token),grant,remaining);}
  };
  const snapshotInputGrant = async (token, descriptor, context, consume = true) => {
    pruneExpiringMaps(fs, Date.now());
    const grant = inputGrants.get(String(token || ''));
    if (!grant) throw hostError(CODES.TOKEN_EXPIRED, 'Component input token is missing or expired');
    if (grant.consumed || consume&&grant.consumeClaimed) throw hostError(CODES.TOKEN_EXPIRED, 'Component input token was already consumed');
    if (grant.scope !== scopeKey(descriptor, context)) throw hostError(CODES.TOKEN_SCOPE, 'Component input token belongs to another component or project');
    if (grant.componentScope !== undefined && grant.componentScope !== normalizeRelativePath(context.scopeRelativePath)) throw hostError(CODES.TOKEN_SCOPE, 'Component input token belongs to another scope');
    if (grant.reservedBy) throw hostError(CODES.CONFLICT, 'Component input token is reserved by another operation');
    if(consume)grant.consumeClaimed=true;
    try{const destination = await materializeVerifiedGrant(grant, token, descriptor, context);if (consume && --grant.usesRemaining <= 0) grant.consumed = true;return destination;}catch(error){if(consume)grant.consumeClaimed=false;throw error;}
  };
  const consumeInput = (token, descriptor, context, consume = true) => snapshotInputGrant(token, descriptor, context, consume);

  broker.register('project.media.page', async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    pruneExpiringMaps(fs, Date.now());
    const pageSize = Math.min(MAX_MEDIA_PAGE_SIZE, Math.max(1, Number(payload.pageSize) || 100));
    const requestedKinds = Array.isArray(payload.kinds) ? new Set(payload.kinds.map(String)) : new Set(['image', 'raw', 'video']);
    let session = payload.cursor ? listSessions.get(String(payload.cursor)) : null;
    if (payload.cursor && (!session || session.scope !== scope.key)) throw hostError(CODES.TOKEN_EXPIRED, 'Media page cursor is missing or expired');
    if (!session) {
      const cursor = crypto.randomUUID();
      const pending = [{ directory: scope.projectRoot, relative: '', viaExternalLink: false }];
      const externalFiles = [];

      session = { cursor, scope: scope.key, root: scope.projectRoot, pending, externalFiles, expiresAt: Date.now() + CURSOR_TTL_MS };
      listSessions.set(cursor, session);
    }
    const items = [];
    let inspected = 0;
    while (session.externalFiles?.length && items.length < pageSize) {
      const external = session.externalFiles.shift();
      const stat = await fs.promises.lstat(external.filePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const kind = kindFor(external.filePath);
      if (!requestedKinds.has(kind)) continue;
      items.push({ mediaRef: { relativePath: external.relativePath }, relativePath: external.relativePath, name: path.basename(external.filePath), kind, extension: path.extname(external.filePath).toLowerCase(), size: stat.size, updatedAt: stat.mtimeMs, viaExternalLink: true });
    }
    while (session.pending.length && items.length < pageSize && inspected < 1000) {
      const current = session.pending.shift();
      const children = await fs.promises.readdir(current.directory, { withFileTypes: true }).catch(() => []);
      children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      let childIndex = Math.max(0, Number(current.offset) || 0);
      for (; childIndex < children.length; childIndex += 1) {
        const child = children[childIndex];
        if (inspected++ >= 1000) break;
        if (child.isSymbolicLink() || child.name.startsWith('.photoflow-')) continue;
        const candidate = path.join(current.directory, child.name);
        const relativePath = [current.relative, child.name].filter(Boolean).join('/');
        if (child.isDirectory()) { session.pending.push({ directory: candidate, relative: relativePath, viaExternalLink: current.viaExternalLink }); continue; }
        if (!child.isFile()) continue;
        const kind = kindFor(candidate);
        if (!requestedKinds.has(kind)) continue;
        const stat = await fs.promises.stat(candidate);
        items.push({ mediaRef: { relativePath }, relativePath, name: child.name, kind, extension: path.extname(child.name).toLowerCase(), size: stat.size, updatedAt: stat.mtimeMs, ...(current.viaExternalLink ? { viaExternalLink: true } : {}) });
        if (items.length >= pageSize) { childIndex += 1; break; }
      }
      if (childIndex < children.length) session.pending.unshift({ ...current, offset: childIndex });
    }
    const hasMore = session.pending.length > 0 || Boolean(session.externalFiles?.length);
    session.expiresAt = Date.now() + CURSOR_TTL_MS;
    if (!hasMore) listSessions.delete(session.cursor);
    return { items, page: { hasMore, cursor: hasMore ? session.cursor : null, pageSize } };
  });

  broker.register('project.media.variants', async (payload, context, descriptor) => {
    const media = await resolveSafeMedia(payload, context, descriptor);
    const stat = await fs.promises.lstat(media.filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw hostError(CODES.NOT_FOUND, 'Media file is missing or unsafe');
    const requested = new Set(Array.isArray(payload.variants) ? payload.variants : ['thumbnail', 'preview']);
    if ([...requested].some(value => !['thumbnail', 'preview', 'original'].includes(value))) throw hostError(CODES.INVALID_REQUEST, 'Unknown media variant');
    let originalUrl = '';
    if (requested.size) { mediaService.grantPath(media.filePath); originalUrl = mediaService.toUrl(media.filePath, true); }
    const result = {};
    const requestVariant = async (name, requestedSize) => {
      const generated = await mediaService.requestThumbnail({ filePath: media.filePath, kind: kindFor(media.filePath), cacheConfig: (readSavedConfig() || {}).mediaCache || {}, requestedSize, priority: 0, queueOrder: 0, awaitReady: true });
      const url = generated?.previewUrl || generated?.mediaUrl;
      if (!url || url === originalUrl) throw hostError(CODES.VARIANT_UNAVAILABLE, `${name} variant could not be generated`);
      result[name] = { url, maxEdge: requestedSize, derived: true };
    };
    if (requested.has('thumbnail')) await requestVariant('thumbnail', 320);
    if (requested.has('preview')) await requestVariant('preview', 1600);
    if (requested.has('original')) result.original = { url: originalUrl, byteLength: stat.size, derived: false, sourceRevision: crypto.createHash('sha256').update(JSON.stringify([String(stat.dev), String(stat.ino), stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex') };
    for (const variant of Object.values(result)) context.grantMediaUrl?.(variant.url);
    const input = requested.has('original') ? grantInput(media.filePath, descriptor, context) : null;
    return {

      mediaRef: { photoId: media.bundle?.photo?.id, versionId: media.version?.id, relativePath: media.relativePath },
      metadata: {
        photoId: String(media.bundle?.photo?.id || ''), versionId: String(media.version?.id || ''),
        currentVersionId: String(media.bundle?.photo?.currentVersionId || (media.bundle?.versions || []).find(item => item.isCurrent)?.id || media.version?.id || ''),
        displayName: String(media.bundle?.photo?.displayName || media.bundle?.photo?.originalName || path.basename(media.filePath)),
        originalName: String(media.bundle?.photo?.originalName || path.basename(media.filePath)), relativePath: media.relativePath,
        isCurrent: Boolean(media.version?.isCurrent), fileMissing: Boolean(media.version?.fileMissing),
      },
      variants: result, ...(input ? { input } : {}),
    };
  });

  broker.register('project.input.tokens', async (payload, context, descriptor) => {
    const materialize = async token => {
      const source = await consumeInput(token, descriptor, context);
      const stat = await fs.promises.stat(source);
      const grant = inputGrants.get(String(token || ''));
      return { inputId: path.basename(path.dirname(source)), privatePath: source, byteLength: stat.size, expiresAt: grant?.expiresAt || Date.now() + INPUT_TOKEN_TTL_MS };
    };
    if (payload.action === 'materialize') return materialize(payload.token);
    if (payload.action === 'materializeBatch') {
      const tokens = Array.isArray(payload.tokens) ? payload.tokens.map(String) : [];
      if (!tokens.length || tokens.length > 256 || new Set(tokens).size !== tokens.length) throw hostError(CODES.INVALID_REQUEST, 'Input token batch must contain 1-256 unique tokens');
      const items = [];
      try { for (const token of tokens) items.push(await materialize(token)); }
      catch (error) { for (const item of items) await fs.promises.rm(path.dirname(item.privatePath), { recursive: true, force: true }).catch(() => undefined); throw error; }
      return { items };
    }
    throw hostError(CODES.INVALID_REQUEST, 'Unknown input token action');
  });

  broker.register('component.storage', async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    let adoption = null;
    if (descriptor.adoptionGrants?.includes('component.storage.previous.v1')) {
      const key = `${descriptor.componentId}\0${scope.workspaceRoot}`;
      let record = storageAdoptions.get(key);
      if (!record) {
        record = { state: 'pending', receipt: null, error: null, startedAt: now(), promise: null };
        record.promise = adoptLegacyStorageV1({ fs, path, crypto, dataRoot: getWorkspaceDataRoot(scope.workspaceRoot), componentRoot: scope.componentRoot, descriptor, faultInjector: adoptionFaultInjector })
          .then(receipt => { record.state = 'committed'; record.receipt = receipt; })
          .catch(error => { record.state = 'failed'; record.error = error; });
        storageAdoptions.set(key, record);
      }
      if (record.state === 'pending' && adoptionInteractiveBudgetMs > 0) await Promise.race([record.promise, new Promise(resolve => setTimeout(resolve, adoptionInteractiveBudgetMs))]);
      if (record.state === 'failed') { storageAdoptions.delete(key); throw record.error; }
      if (record.state === 'pending') return { projectId: String(scope.project.id), ownership: 'component-private', adoption: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'pending', componentId: descriptor.componentId, startedAt: record.startedAt } };
      adoption = record.receipt;
    }
    await fs.promises.mkdir(scope.componentRoot, { recursive: true });
    return { dataPath: scope.componentRoot, databasePath: path.join(scope.componentRoot, 'storage.sqlite3'), projectId: String(scope.project.id), ownership: 'component-private', ...(adoption ? { adoption: { schemaVersion: adoption.schemaVersion, kind: adoption.kind, state: adoption.state, componentId: adoption.componentId, adoptedDataRoot: adoption.adoptedDataRoot === true, adoptedDatabase: adoption.adoptedDatabase === true, legacyDataRoot: adoption.legacyDataRoot || '', legacyDatabasePath: adoption.legacyDatabasePath || '', databaseSha256: adoption.databaseSha256 || '', copiedFileCount: Number(adoption.copiedFileCount) || 0, copiedByteCount: Number(adoption.copiedByteCount) || 0 } } : {}) };
  });

  broker.register('component.settings', async (payload, _context, descriptor) => {
    const componentId = String(descriptor.componentId || '');
    if (payload.action === 'get') {
      const config = readConfig ? await readConfig() : readSavedConfig() || {};
      return { revision: normalizeComponentRevision(config.componentSettingsRevisions?.[componentId]), settings: boundedObject(config.componentSettings?.[componentId] || {}, MAX_SETTINGS_BYTES, 'Stored component settings') };
    }
    if (!['replace', 'merge'].includes(payload.action)) throw hostError(CODES.INVALID_REQUEST, 'Unknown component settings action');
    if (typeof mutateConfig !== 'function') throw new Error('Component settings require the shared config mutation service');
    const request = boundedObject(payload.settings || {}, MAX_SETTINGS_BYTES, 'Component settings');
    let result;
    const update = latest => {
      const latestSettings = boundedObject(latest.componentSettings?.[componentId] || {}, MAX_SETTINGS_BYTES, 'Stored component settings');
      const settings = payload.action === 'merge' ? { ...latestSettings, ...request } : request;
      boundedObject(settings, MAX_SETTINGS_BYTES, 'Component settings');
      const revision = nextComponentRevision(latest.componentSettingsRevisions?.[componentId]);
      result = { revision, settings };
      return { ...latest, componentSettings: { ...(latest.componentSettings || {}), [componentId]: settings }, componentSettingsRevisions: { ...(latest.componentSettingsRevisions || {}), [componentId]: revision } };
    };
    await mutateConfig(update);
    return result;
  });

  const scopeDigest = scope => crypto.createHash('sha256').update(scope.key).digest('hex');
  const stageRootFor = (scope, stageId) => path.join(scope.componentRoot, 'staging', stageId);
  const stageMetadataPath = stage => path.join(stage.root, 'stage.json');
  const persistStage = stage => replaceJson({ fs, crypto, filePath: stageMetadataPath(stage), value: {
    schemaVersion: STAGE_SCHEMA_VERSION, id: stage.id, componentId: stage.componentId, projectId: stage.projectId,
    scopeDigest: stage.scopeDigest, createdAt: stage.createdAt, expiresAt: stage.expiresAt,
    files: stage.files.map(file => ({ artifactId: file.artifactId, sourceName: file.sourceName, outputRelativePath: file.outputRelativePath, ...(file.replacement ? { replacement: file.replacement } : {}) })),
  } });
  const cleanupStage = async stage => {
    outputStages.delete(stage.id);
    if (SAFE_STAGE_ID.test(stage.id) && path.resolve(stage.root) === path.resolve(stageRootFor({ componentRoot: stage.componentRoot }, stage.id))) {
      await fs.promises.rm(stage.root, { recursive: true, force: true });
    }
  };
  const resolveStage = async (payload, scope, descriptor) => {
    const id = String(payload.stageId || '');
    if (!SAFE_STAGE_ID.test(id)) throw hostError(CODES.INVALID_REQUEST, 'Invalid output stage id');
    let stage = outputStages.get(id);
    if (!stage) {
      const root = stageRootFor(scope, id);
      const metadata = await readJson(fs, path.join(root, 'stage.json'));
      if (!metadata) throw hostError(CODES.NOT_FOUND, 'Output stage was not found');
      const files = Array.isArray(metadata.files) && metadata.files.length <= 2000 ? metadata.files.map(file => ({
        artifactId: String(file.artifactId || ''), sourceName: assertRelativePath(path, file.sourceName, 'staged sourceName'), outputRelativePath: assertRelativePath(path, file.outputRelativePath, 'output relativePath'),
        ...(file.replacement ? { replacement: { previousCommitId: String(file.replacement.previousCommitId || ''), previousArtifactId: String(file.replacement.previousArtifactId || ''), expectedDigest: String(file.replacement.expectedDigest || '') } } : {}),
      })) : null;
      if (metadata.schemaVersion !== STAGE_SCHEMA_VERSION || metadata.id !== id || metadata.componentId !== descriptor.componentId
        || metadata.projectId !== String(scope.project.id) || metadata.scopeDigest !== scopeDigest(scope) || !files
        || !Number.isSafeInteger(metadata.createdAt) || !Number.isSafeInteger(metadata.expiresAt)
        || Number.parseInt(id.split('-')[0], 16) !== metadata.createdAt || metadata.expiresAt !== metadata.createdAt + STAGE_TTL_MS) throw hostError(CODES.PERMISSION_DENIED, 'Output stage metadata is invalid or belongs to another scope');
      stage = { id, scope: scope.key, scopeDigest: metadata.scopeDigest, root, payloadRoot: path.join(root, 'payload'), projectRoot: scope.projectRoot, componentRoot: scope.componentRoot, componentId: descriptor.componentId, projectId: String(scope.project.id), createdAt: metadata.createdAt, expiresAt: metadata.expiresAt, files };
      outputStages.set(id, stage);
    }
    if (stage.scope !== scope.key || stage.scopeDigest !== scopeDigest(scope)) throw hostError(CODES.TOKEN_SCOPE, 'Output stage belongs to another component or project');
    if (now() >= stage.expiresAt) { await cleanupStage(stage); throw hostError(CODES.TOKEN_EXPIRED, 'Output stage expired after 24 hours'); }
    return stage;
  };
  const inspectStage = async stage => {
    if (!stage.files.length) throw hostError(CODES.INVALID_REQUEST, 'Output stage is empty');
    const realPayloadRoot = await fs.promises.realpath(stage.payloadRoot);
    let totalBytes = 0;
    const files = [];
    const targets = new Set();
    for (const file of stage.files) {
      if (!/^[a-f0-9-]{16,80}$/i.test(file.artifactId)) throw hostError(CODES.INVALID_REQUEST, 'Output stage contains an invalid artifact id');
      if (targets.has(file.outputRelativePath.toLocaleLowerCase())) throw hostError(CODES.CONFLICT, `Duplicate output target: ${file.outputRelativePath}`);
      targets.add(file.outputRelativePath.toLocaleLowerCase());
      const stagePath = path.resolve(stage.payloadRoot, file.sourceName);
      const stat = await fs.promises.lstat(stagePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || !inside(path, stage.payloadRoot, stagePath)) throw hostError(CODES.PERMISSION_DENIED, 'Output stage contains an unsafe file');
      const realFile = await fs.promises.realpath(stagePath);
      if (!inside(path, realPayloadRoot, realFile)) throw hostError(CODES.PERMISSION_DENIED, 'Output stage escapes through a linked directory');
      totalBytes += stat.size;
      if (totalBytes > MAX_STAGE_BYTES) throw hostError(CODES.LIMIT_EXCEEDED, 'Output stage is too large');
      files.push({ ...file, stagePath, size: stat.size, sha256: await sha256File(fs, crypto, stagePath) });
    }
    return { fileCount: files.length, totalBytes, files };
  };
  const commitReceiptPath = (scope, commitId) => path.join(scope.componentRoot, 'receipts', 'commits', `${commitId}.json`);
  const versionReceiptPath = (scope, versionId) => path.join(scope.componentRoot, 'receipts', 'versions', `${versionId}.json`);
  const safeDestination = async (scope, relativePath, createParent = false) => {
    const normalized = assertRelativePath(path, relativePath, 'output relativePath');
    const destination = path.resolve(scope.projectRoot, normalized);
    if (!inside(path, scope.projectRoot, destination)) throw hostError(CODES.PERMISSION_DENIED, 'Output target escapes the project');
    const parent = path.dirname(destination);
    const canonicalProjectRoot = await fs.promises.realpath(scope.projectRoot).catch(() => null);
    if (!canonicalProjectRoot) throw hostError(CODES.NOT_FOUND, 'Bound project root is unavailable');
    const projectRootStat=await fs.promises.lstat(scope.projectRoot);if(!projectRootStat.isDirectory()||projectRootStat.isSymbolicLink())throw hostError(CODES.PERMISSION_DENIED,'Bound project root is linked or unsafe');
    let checked=path.resolve(scope.projectRoot);for(const segment of path.relative(scope.projectRoot,parent).split(path.sep).filter(Boolean)){checked=path.join(checked,segment);const checkedStat=await fs.promises.lstat(checked).catch(error=>error?.code==='ENOENT'?null:Promise.reject(error));if(!checkedStat)break;if(!checkedStat.isDirectory()||checkedStat.isSymbolicLink())throw hostError(CODES.PERMISSION_DENIED,'Output target ancestor contains a link or unsafe entry');const checkedReal=await fs.promises.realpath(checked);if(!insideOrEqual(path,canonicalProjectRoot,checkedReal))throw hostError(CODES.PERMISSION_DENIED,'Output target ancestor escapes the project');}
    let ancestor = parent; let ancestorStat = await fs.promises.lstat(ancestor).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    while (!ancestorStat && ancestor !== scope.projectRoot) { const next = path.dirname(ancestor); if (next === ancestor || !insideOrEqual(path, scope.projectRoot, next)) throw hostError(CODES.PERMISSION_DENIED, 'Output target has no safe project ancestor'); ancestor = next; ancestorStat = await fs.promises.lstat(ancestor).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error)); }
    if (!ancestorStat?.isDirectory() || ancestorStat.isSymbolicLink()) throw hostError(CODES.PERMISSION_DENIED, 'Output target ancestor is unsafe');
    const canonicalAncestor = await fs.promises.realpath(ancestor).catch(() => null);
    if (!canonicalAncestor || !insideOrEqual(path, canonicalProjectRoot, canonicalAncestor)) throw hostError(CODES.PERMISSION_DENIED, 'Output target escapes through a linked directory');
    if (createParent && ancestor !== parent) {
      const missing = []; let cursor = parent;
      while (cursor !== ancestor) { missing.push(cursor); cursor = path.dirname(cursor); }
      for (const directory of missing.reverse()) {
        try { await fs.promises.mkdir(directory, { recursive: false }); }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
        const createdStat = await fs.promises.lstat(directory);
        const createdReal = await fs.promises.realpath(directory);
        if (!createdStat.isDirectory() || createdStat.isSymbolicLink() || !insideOrEqual(path, canonicalProjectRoot, createdReal)) throw hostError(CODES.PERMISSION_DENIED, 'Output target parent is unsafe');
      }
    }
    const existingParent = await fs.promises.realpath(parent).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (existingParent && !insideOrEqual(path, canonicalProjectRoot, existingParent)) throw hostError(CODES.PERMISSION_DENIED, 'Output target escapes through a linked directory');
    return destination;
  };
  const outputMatches = async (scope, output) => {
    const destination = await safeDestination(scope, output.relativePath, false);
    const stat = await fs.promises.lstat(destination).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== output.size) return false;
    return (await sha256File(fs, crypto, destination)) === output.sha256;
  };
  const fileMatchesDigest = async (filePath, size, digest) => {
    const stat = await fs.promises.lstat(filePath).catch(() => null);
    return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.size === size && await sha256File(fs, crypto, filePath) === digest);
  };
  const validateCommitReceipt = (receipt, scope, commitId, idempotencyKey = null) => {
    const validOutputs = Array.isArray(receipt?.outputs) && receipt.outputs.length > 0 && receipt.outputs.length <= 2000
      && receipt.outputs.every(item => /^[a-f0-9-]{16,80}$/i.test(String(item.artifactId || '')) && /^[a-f0-9]{64}$/.test(String(item.sha256 || '')) && Number.isSafeInteger(item.size) && item.size >= 0
        && (!item.replacement || (SAFE_STAGE_ID.test(String(item.replacement.previousCommitId || '')) && SAFE_STAGE_ID.test(String(item.replacement.previousArtifactId || '')) && /^[a-f0-9]{64}$/.test(String(item.replacement.expectedDigest || '')) && Number.isSafeInteger(item.replacement.expectedSize) && item.replacement.expectedSize >= 0)));
    if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION || receipt?.kind !== 'component-output-commit' || receipt?.commitId !== commitId
      || !['prepared', 'committed'].includes(receipt?.state) || receipt?.componentId !== scope.componentId || receipt?.projectId !== String(scope.project.id)
      || receipt?.scopeDigest !== scopeDigest(scope) || !ID.test(String(receipt?.idempotencyKey || '')) || !SAFE_STAGE_ID.test(String(receipt?.stageId || '')) || !Number.isSafeInteger(receipt?.createdAt)
      || (idempotencyKey !== null && receipt?.idempotencyKey !== idempotencyKey) || !validOutputs || (receipt?.state === 'committed' && receipt.outputs.some(item => item.published !== true))) {
      throw hostError(CODES.PERMISSION_DENIED, 'Component output receipt is invalid or belongs to another scope');
    }
    receipt.outputs = receipt.outputs.map(item => ({
      artifactId: String(item.artifactId), relativePath: assertRelativePath(path, item.relativePath, 'receipt output relativePath'), size: item.size, sha256: item.sha256, published: item.published === true,
      ...(item.requestedRelativePath ? { requestedRelativePath: assertRelativePath(path, item.requestedRelativePath, 'requested output relativePath') } : {}),
      ...(item.replacement ? { replacement: { previousCommitId: String(item.replacement.previousCommitId || ''), previousArtifactId: String(item.replacement.previousArtifactId || ''), expectedDigest: String(item.replacement.expectedDigest || ''), expectedSize: Number(item.replacement.expectedSize), backupName: item.replacement.backupName ? assertRelativePath(path, item.replacement.backupName, 'replacement backup') : '' } } : {}),
    }));
    return receipt;
  };
  const commitResponse = (scope, receipt, { includePhysicalPath = true } = {}) => ({ commitId: receipt.commitId, idempotencyKey: receipt.idempotencyKey, outputs: receipt.outputs.map(item => ({ artifactId: item.artifactId, relativePath: item.relativePath, ...(item.requestedRelativePath ? { requestedRelativePath: item.requestedRelativePath } : {}), ...(includePhysicalPath ? { filePath: path.resolve(scope.projectRoot, item.relativePath) } : {}), byteLength: item.size, sha256: item.sha256 })) });
  const loadCommitReceipt = async (scope, commitId, idempotencyKey = null) => {
    if (!SAFE_STAGE_ID.test(commitId)) throw hostError(CODES.INVALID_REQUEST, 'Invalid commit id');
    const receipt = await readJson(fs, commitReceiptPath(scope, commitId));
    return receipt ? validateCommitReceipt(receipt, scope, commitId, idempotencyKey) : null;
  };
  const rollbackReceiptOutputs = async (scope, receipt, assertTarget = async()=>undefined) => {
    const preserved = [];
    for (const output of receipt.outputs) {
      if (!output.published) continue;
      const destination = await safeDestination(scope, output.relativePath, false);
      if (await outputMatches(scope, output)) {
        if (output.replacement?.backupName) {
          const stage = { payloadRoot: path.join(stageRootFor(scope, receipt.stageId), 'payload') };
          const backup = path.resolve(stage.payloadRoot, output.replacement.backupName);
          if (inside(path, stage.payloadRoot, backup) && await fileMatchesDigest(backup, output.replacement.expectedSize, output.replacement.expectedDigest)) {
            const pending = `${destination}.${crypto.randomUUID()}.photoflow-rollback`;
            try { await assertTarget(output.relativePath);await fs.promises.copyFile(backup, pending, fs.constants.COPYFILE_EXCL);await assertTarget(output.relativePath);await fs.promises.rename(pending, destination); }
            finally { await assertTarget(output.relativePath).then(()=>fs.promises.rm(pending,{force:true}),()=>undefined).catch(()=>undefined); }
          } else preserved.push(output.relativePath);
        } else {await assertTarget(output.relativePath);await fs.promises.rm(destination, { force: true });}
      }
      else if (fs.existsSync(destination)) preserved.push(output.relativePath);
      output.published = false;
    }
    return preserved;
  };
  const rollbackPreparedReceiptsForStage = async (scope, stageId) => {
    const directory = path.join(scope.componentRoot, 'receipts', 'commits');
    const entries = (await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => [])).filter(item => item.isFile() && /^[a-f0-9-]{36}\.json$/i.test(item.name)).slice(0, 2000);
    for (const entry of entries) {
      const commitId = entry.name.slice(0, -5);
      const receipt = await loadCommitReceipt(scope, commitId);
      if (!receipt || receipt.state !== 'prepared' || receipt.stageId !== stageId) continue;
      const targets=await acquireOutputTargets(scope,receipt.outputs);let preserved;try{preserved=await rollbackReceiptOutputs(scope,receipt,relativePath=>targets.assert(relativePath));}finally{targets.release();}
      if (preserved.length) throw hostError(CODES.CONFLICT, `Prepared output changed and was preserved: ${preserved.join(', ')}`);
      await fs.promises.rm(commitReceiptPath(scope, commitId), { force: true });
    }
  };
  const commitStage = async (payload, scope, descriptor) => {
    if (payload.onConflict !== undefined && !['error', 'rename'].includes(payload.onConflict)) throw hostError(CODES.INVALID_REQUEST, 'Invalid output conflict policy');
    const idempotencyKey = String(payload.idempotencyKey || '');
    if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
    const commitId = stableUuid(crypto, `component-output\0${scope.key}\0${idempotencyKey}`);
    const cacheKey = `${scope.key}\0${idempotencyKey}`;
    if (committedOutputs.has(cacheKey)) return committedOutputs.get(cacheKey);
    let receipt = await loadCommitReceipt(scope, commitId, idempotencyKey);
    if (receipt?.state === 'committed') {
      for (const output of receipt.outputs) if (!await outputMatches(scope, output)) throw hostError(CODES.CONFLICT, `Committed output changed: ${output.relativePath}`);
      const restored = commitResponse(scope, receipt);
      committedOutputs.set(cacheKey, restored); committedOutputs.set(commitId, { ...restored, scope: scope.key });
      if (SAFE_STAGE_ID.test(String(receipt.stageId || ''))) { outputStages.delete(receipt.stageId); await fs.promises.rm(stageRootFor(scope, receipt.stageId), { recursive: true, force: true }).catch(() => undefined); }
      return restored;
    }
    const stage = await resolveStage(payload, scope, descriptor);
    if (receipt && receipt.stageId !== stage.id) throw hostError(CODES.CONFLICT, 'Idempotency key is already bound to another output stage');
    if (!receipt) {
      const inspected = await inspectStage(stage);
      const outputs = [];
      const reservedPaths = new Set(inspected.files.map(file => file.outputRelativePath.toLowerCase()));
      for (const file of inspected.files) {
        const output = { artifactId: file.artifactId, relativePath: file.outputRelativePath, size: file.size, sha256: file.sha256, published: false };
        const destinationExists = fs.existsSync(await safeDestination(scope, output.relativePath, false));
        if (file.replacement) {
          const previous = await loadCommitReceipt(scope, file.replacement.previousCommitId);
          const previousOutput = previous?.state === 'committed' ? previous.outputs.find(item => item.artifactId === file.replacement.previousArtifactId) : null;
          if (!previousOutput || previousOutput.relativePath !== output.relativePath || previousOutput.sha256 !== file.replacement.expectedDigest || !destinationExists || !await outputMatches(scope, previousOutput)) throw hostError(CODES.CONFLICT, `Controlled replacement ownership or digest mismatch: ${output.relativePath}`);
          output.replacement = { ...file.replacement, expectedSize: previousOutput.size, backupName: '' };
        } else if (destinationExists) {
          if (payload.onConflict !== 'rename') throw hostError(CODES.CONFLICT, `Output already exists: ${output.relativePath}`);
          const requested = output.relativePath;
          const parsed = path.posix.parse(requested);
          let selected = '';
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const name = `${parsed.name.slice(0, 160)}_副本-${commitId.slice(0, 12)}${attempt ? `-${attempt}` : ''}${parsed.ext}`;
            const candidate = path.posix.join(parsed.dir, name);
            if (!reservedPaths.has(candidate.toLowerCase()) && !fs.existsSync(await safeDestination(scope, candidate, false))) { selected = candidate; break; }
          }
          if (!selected) throw hostError(CODES.CONFLICT, `No available output name: ${requested}`);
          output.requestedRelativePath = requested;
          output.relativePath = selected;
          reservedPaths.add(selected.toLowerCase());
        }
        outputs.push(output);
      }
      receipt = { schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-output-commit', state: 'prepared', commitId, idempotencyKey, componentId: descriptor.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), stageId: stage.id, createdAt: Date.now(), outputs };
      await replaceJson({ fs, crypto, filePath: commitReceiptPath(scope, commitId), value: receipt });
    }
    const inspected = await inspectStage(stage);
    const stagedByArtifact = new Map(inspected.files.map(file => [file.artifactId, file]));
    for (const output of receipt.outputs) {
      const staged = stagedByArtifact.get(output.artifactId);
      if (!staged || staged.size !== output.size || staged.sha256 !== output.sha256 || staged.outputRelativePath !== (output.requestedRelativePath || output.relativePath)
        || JSON.stringify(staged.replacement || null) !== JSON.stringify(output.replacement ? { previousCommitId: output.replacement.previousCommitId, previousArtifactId: output.replacement.previousArtifactId, expectedDigest: output.replacement.expectedDigest } : null)) throw hostError(CODES.CONFLICT, `Staged artifact changed: ${output.relativePath}`);
    }
    const receiptPath = commitReceiptPath(scope, commitId);
    const releaseTargets = await acquireOutputTargets(scope, receipt.outputs);
    try {
      for (const output of receipt.outputs) {
        await releaseTargets.assert(output.relativePath);
        const destination = await safeDestination(scope, output.relativePath, true);
        if (fs.existsSync(destination)) {
          if (!await outputMatches(scope, output)) {
            if (!output.replacement || !await fileMatchesDigest(destination, output.replacement.expectedSize, output.replacement.expectedDigest)) throw hostError(CODES.CONFLICT, `Output conflicts with prepared journal: ${output.relativePath}`);
            if (!output.replacement.backupName) {
              output.replacement.backupName = `.replacement-backups/${output.artifactId}.backup`;
              const backup = path.resolve(stage.payloadRoot, output.replacement.backupName);
              await fs.promises.mkdir(path.dirname(backup), { recursive: true });
              await releaseTargets.assert(output.relativePath);await fs.promises.copyFile(destination, backup, fs.constants.COPYFILE_EXCL);
              await replaceJson({ fs, crypto, filePath: receiptPath, value: receipt });
            }
            const backup = path.resolve(stage.payloadRoot, output.replacement.backupName);
            if (!inside(path, stage.payloadRoot, backup) || !await fileMatchesDigest(backup, output.replacement.expectedSize, output.replacement.expectedDigest)) throw hostError(CODES.CONFLICT, `Replacement backup is missing or changed: ${output.relativePath}`);
            const pending = `${destination}.${crypto.randomUUID()}.photoflow-pending`;
            try { await releaseTargets.assert(output.relativePath);await fs.promises.copyFile(stagedByArtifact.get(output.artifactId).stagePath, pending, fs.constants.COPYFILE_EXCL); if (!await fileMatchesDigest(pending, output.size, output.sha256)) throw hostError(CODES.CONFLICT, `Staged artifact changed while publishing: ${output.relativePath}`); if (!await fileMatchesDigest(destination, output.replacement.expectedSize, output.replacement.expectedDigest)) throw hostError(CODES.CONFLICT, `Replacement target changed while publishing: ${output.relativePath}`);await releaseTargets.assert(output.relativePath); await fs.promises.rename(pending, destination); }
            finally { await releaseTargets.assert(output.relativePath).then(()=>fs.promises.rm(pending,{force:true}),()=>undefined).catch(()=>undefined); }
          }
        } else {
          if (output.replacement) {
            const backup = output.replacement.backupName ? path.resolve(stage.payloadRoot, output.replacement.backupName) : '';
            if (!backup || !inside(path, stage.payloadRoot, backup) || !await fileMatchesDigest(backup, output.replacement.expectedSize, output.replacement.expectedDigest)) throw hostError(CODES.CONFLICT, `Replacement target and backup are unavailable: ${output.relativePath}`);
          }
          const pending = `${destination}.${crypto.randomUUID()}.photoflow-pending`;
          try { await releaseTargets.assert(output.relativePath);await fs.promises.copyFile(stagedByArtifact.get(output.artifactId).stagePath, pending, fs.constants.COPYFILE_EXCL); if (!await fileMatchesDigest(pending, output.size, output.sha256)) throw hostError(CODES.CONFLICT, `Staged artifact changed while publishing: ${output.relativePath}`); await publishNoReplace(pending, destination,()=>releaseTargets.assert(output.relativePath)); }
          finally { await releaseTargets.assert(output.relativePath).then(()=>fs.promises.rm(pending,{force:true}),()=>undefined).catch(()=>undefined); }
        }
        output.published = true;
        await replaceJson({ fs, crypto, filePath: receiptPath, value: receipt });
      }
      receipt.state = 'committed'; receipt.committedAt = Date.now();
      await replaceJson({ fs, crypto, filePath: receiptPath, value: receipt });
    } catch (error) {
      const preserved = await rollbackReceiptOutputs(scope, receipt,relativePath=>releaseTargets.assert(relativePath));
      committedOutputs.delete(cacheKey); committedOutputs.delete(commitId);
      await fs.promises.rm(receiptPath, { force: true }).catch(() => undefined);
      if (preserved.length) throw hostError(CODES.CONFLICT, `Output changed during rollback and was preserved: ${preserved.join(', ')}`);
      throw error;
    } finally { releaseTargets.release(); }
    const response = commitResponse(scope, receipt);
    committedOutputs.set(cacheKey, response); committedOutputs.set(commitId, { ...response, scope: scope.key });
    await cleanupStage(stage).catch(() => undefined);
    return response;
  };
  const withOperation = (operations, key, factory) => {
    const current = operations.get(key);
    if (current) return current;
    const operation = Promise.resolve().then(factory).finally(() => { if (operations.get(key) === operation) operations.delete(key); });
    operations.set(key, operation);
    return operation;
  };
  const acquireOutputTargets = async (scope, outputs) => {
    const identities = [];
    for (const output of outputs) {
      const destination = await safeDestination(scope, output.relativePath, true);
      const parent = path.dirname(destination); const realParent = await fs.promises.realpath(parent); const stat = await fs.promises.lstat(parent);
      const canonicalParent = process.platform === 'win32' ? path.resolve(realParent).toLowerCase() : path.resolve(realParent);
      identities.push({ key: `${canonicalParent}\0${process.platform === 'win32' ? path.basename(destination).toLowerCase() : path.basename(destination)}`, parent, realParent, dev: String(stat.dev), ino: String(stat.ino) });
    }
    const byKey = new Map(identities.map(identity => [identity.key, identity]));
    const keys = [...byKey.keys()].sort();
    const leases = [];
    const releaseLease = lease => { lease.release(); void lease.tail.finally(() => { if (outputTargetOperations.get(lease.key) === lease.tail) outputTargetOperations.delete(lease.key); }); };
    const assertLease=async lease=>{const stat=await fs.promises.lstat(lease.identity.parent);const real=await fs.promises.realpath(lease.identity.parent);if(!stat.isDirectory()||stat.isSymbolicLink()||String(stat.dev)!==lease.identity.dev||String(stat.ino)!==lease.identity.ino||!samePhysicalPath(real,lease.identity.realParent))throw hostError(CODES.PERMISSION_DENIED,'Output target parent changed while the publication lock was held');};
    try {
      for (const key of keys) {
        const previous = outputTargetOperations.get(key) || Promise.resolve();
        let release; const current = new Promise(resolve => { release = resolve; });
        const tail = previous.catch(() => undefined).then(() => current);
        outputTargetOperations.set(key, tail);
        const lease={key,tail,release,identity:byKey.get(key)};leases.push(lease);
        await previous.catch(() => undefined);
        await assertLease(lease);
      }
    } catch (error) { for (const lease of leases.reverse()) releaseLease(lease); throw error; }
    const leaseByKey=new Map(leases.map(lease=>[lease.key,lease]));return{release:()=>{for(const lease of leases.reverse())releaseLease(lease);},assert:async relativePath=>{const destination=await safeDestination(scope,relativePath,false);const realParent=await fs.promises.realpath(path.dirname(destination));const key=`${process.platform==='win32'?path.resolve(realParent).toLowerCase():path.resolve(realParent)}\0${process.platform==='win32'?path.basename(destination).toLowerCase():path.basename(destination)}`;const lease=leaseByKey.get(key);if(!lease)throw hostError(CODES.PERMISSION_DENIED,'Output target lock identity changed');await assertLease(lease);}};
  };
  const publishNoReplace = async (pending, destination, assertTarget) => {
    try { await assertTarget();await fs.promises.link(pending, destination); }
    catch (error) {
      if (error?.code === 'EEXIST') throw hostError(CODES.CONFLICT, `Output already exists: ${path.basename(destination)}`);
      if (!['EXDEV', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
      let source; let target; let sourceStream; let targetStream; let targetCreated=false;
      try { source = await fs.promises.open(pending, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const before=await source.stat();if(!before.isFile())throw hostError(CODES.PERMISSION_DENIED,'Pending output is unsafe');await assertTarget(); target = await fs.promises.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);targetCreated=true; sourceStream=source.createReadStream({ autoClose: false });targetStream=target.createWriteStream({ autoClose: false });await pipeline(sourceStream, targetStream);const after=await source.stat(),published=await target.stat();if(String(after.dev)!==String(before.dev)||String(after.ino)!==String(before.ino)||after.size!==before.size||after.mtimeMs!==before.mtimeMs||published.size!==before.size)throw hostError(CODES.CONFLICT,'Pending output changed while publishing'); }
      catch (copyError) { if (copyError?.code === 'EEXIST') throw hostError(CODES.CONFLICT, `Output already exists: ${path.basename(destination)}`); if(targetCreated)await fs.promises.rm(destination, { force: true }).catch(() => undefined); throw copyError; }
      finally { sourceStream?.destroy();targetStream?.destroy();await source?.close().catch(() => undefined); await target?.close().catch(() => undefined); }
    }
    await fs.promises.rm(pending, { force: true });
  };
  broker.register('project.output', async (payload, context, descriptor) => {
    const scope = { ...bound(context, descriptor), componentId: descriptor.componentId };
    if (payload.action === 'adopt') {
      if (!descriptor.adoptionGrants?.includes('project.output.existing.v1')) throw hostError(CODES.PERMISSION_DENIED, 'Output adoption is not granted to this component');
      const receipt = await adoptExistingOutput({ fs, path, crypto, componentRoot: scope.componentRoot, componentId: descriptor.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), projectRoot: scope.projectRoot, migrationId: payload.migrationId, outputs: payload.outputs });
      const response = commitResponse(scope, receipt, { includePhysicalPath: false });
      committedOutputs.set(receipt.commitId, { ...response, scope: scope.key });
      return response;
    }
    if (payload.action === 'delete') {
      const previousCommitId = String(payload.previousCommitId || ''); const previousArtifactId = String(payload.previousArtifactId || '');
      const expectedDigest = String(payload.expectedDigest || '').toLowerCase(); const idempotencyKey = String(payload.idempotencyKey || '');
      if (!SAFE_STAGE_ID.test(previousCommitId) || !SAFE_STAGE_ID.test(previousArtifactId) || !/^[a-f0-9]{64}$/.test(expectedDigest) || !ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'Controlled deletion requires ownership, digest, and idempotency key');
      const deletionId = stableUuid(crypto, `component-output-delete\0${scope.key}\0${idempotencyKey}`);
      const deletionReceiptPath = path.join(scope.componentRoot, 'receipts', 'deletions', `${deletionId}.json`);
      const existingDeletion = await readJson(fs, deletionReceiptPath);
      if (existingDeletion?.state === 'committed') return { deletionId, deleted: true, relativePath: existingDeletion.relativePath };
      const receipt = await loadCommitReceipt(scope, previousCommitId);
      const output = receipt?.outputs?.find(item => item.artifactId === previousArtifactId);
      if (!output || output.sha256 !== expectedDigest) throw hostError(CODES.TOKEN_SCOPE, 'Controlled deletion ownership does not match');
      const destination = await safeDestination(scope, output.relativePath, false);
      const releaseTarget = await acquireOutputTargets(scope, [output]);
      try {
        if (!await fileMatchesDigest(destination, output.size, expectedDigest)) throw hostError(CODES.CONFLICT, 'Controlled deletion target changed');
        const trashRoot = path.join(scope.componentRoot, 'staging', 'deletions'); await fs.promises.mkdir(trashRoot, { recursive: true });
        const backup = path.join(trashRoot, deletionId);await releaseTarget.assert(output.relativePath); await fs.promises.rename(destination, backup);
        try { await replaceJson({ fs, crypto, filePath: deletionReceiptPath, value: { schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-output-deletion', state: 'committed', deletionId, idempotencyKey, componentId: descriptor.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), previousCommitId, previousArtifactId, relativePath: output.relativePath, sha256: expectedDigest, deletedAt: Date.now() } }); await fs.promises.rm(backup, { force: true }); }
        catch (error) { if (!fs.existsSync(destination)) {await releaseTarget.assert(output.relativePath);await fs.promises.rename(backup, destination).catch(() => undefined);} throw error; }
      } finally { releaseTarget.release(); }
      return { deletionId, deleted: true, relativePath: output.relativePath };
    }
    if (payload.action === 'materializeOwned') {
      const commitId = String(payload.commitId || ''); const artifactId = String(payload.artifactId || '');
      const receipt = await loadCommitReceipt(scope, commitId); const output = receipt?.outputs?.find(item => item.artifactId === artifactId);
      if (!output || receipt.state !== 'committed') throw hostError(CODES.TOKEN_SCOPE, 'Owned output artifact was not found');
      if (!await outputMatches(scope, output)) throw hostError(CODES.CONFLICT, 'Owned output changed before private materialization');
      const importId = stableUuid(crypto, `component-output-import\0${scope.key}\0${commitId}\0${artifactId}`);
      const directory = path.join(scope.componentRoot, 'imported-outputs', importId); const privatePath = path.join(directory, path.basename(output.relativePath));
      const source = path.resolve(scope.projectRoot, output.relativePath); await fs.promises.mkdir(directory, { recursive: true });
      if (!await fileMatchesDigest(privatePath, output.size, output.sha256)) {
        const pending = `${privatePath}.${crypto.randomUUID()}.tmp`; let sourceHandle; let targetHandle; let sourceStream; let targetStream;
        try {
          sourceHandle = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          const before = await sourceHandle.stat();
          if (!before.isFile() || before.size !== output.size) throw hostError(CODES.CONFLICT, 'Owned output changed before private materialization');
          targetHandle = await fs.promises.open(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
          sourceStream = sourceHandle.createReadStream({ autoClose: false });
          targetStream = targetHandle.createWriteStream({ autoClose: false });
          await pipeline(sourceStream, targetStream);
          const after = await sourceHandle.stat();
          if (String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || !await fileMatchesDigest(pending, output.size, output.sha256)) throw hostError(CODES.CONFLICT, 'Owned output digest changed during private materialization');
          await fs.promises.rm(privatePath, { force: true }); await fs.promises.rename(pending, privatePath);
        } finally {
          // autoClose:false keeps descriptors available for the identity checks,
          // but streams still hold FileHandle references after pipeline finishes.
          // Release those references before awaiting close() (Node 24 otherwise
          // waits indefinitely, including after an error during validation).
          sourceStream?.destroy(); targetStream?.destroy();
          await sourceHandle?.close().catch(() => undefined); await targetHandle?.close().catch(() => undefined);
          await fs.promises.rm(pending, { force: true }).catch(() => undefined);
        }
      }
      return { importId, privatePath, byteLength: output.size, sha256: output.sha256, outputRef: { commitId, artifactId } };
    }
    if (payload.action === 'stage') {
      const createdAt = now(); const stageId = `${createdAt.toString(16)}-${crypto.randomUUID()}`;
      const root = stageRootFor(scope, stageId); const payloadRoot = path.join(root, 'payload');
      await fs.promises.mkdir(payloadRoot, { recursive: true });
      const stage = { id: stageId, scope: scope.key, scopeDigest: scopeDigest(scope), root, payloadRoot, projectRoot: scope.projectRoot, componentRoot: scope.componentRoot, componentId: descriptor.componentId, projectId: String(scope.project.id), createdAt, expiresAt: createdAt + STAGE_TTL_MS, files: [] };
      await persistStage(stage); outputStages.set(stageId, stage);
      return { stageId, privatePath: payloadRoot, expiresAt: stage.expiresAt };
    }
    if (payload.action === 'commit') {
      const idempotencyKey = String(payload.idempotencyKey || '');
      if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
      return withOperation(commitOperations, `${scope.key}\0${idempotencyKey}`, () => commitStage(payload, scope, descriptor));
    }
    const stageId = String(payload.stageId || '');
    if (payload.action === 'rollback' && SAFE_STAGE_ID.test(stageId) && !outputStages.has(stageId) && !fs.existsSync(stageRootFor(scope, stageId))) return { stageId, rolledBack: true };
    const stage = await resolveStage(payload, scope, descriptor);
    if (payload.action === 'write') {
      if (stage.files.length >= 2000) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many staged output files');
      const name = assertRelativePath(path, payload.name, 'output name');
      if (name.includes('/')) throw hostError(CODES.INVALID_REQUEST, 'Output name must be a file name');
      const outputRelativePath = assertRelativePath(path, payload.outputRelativePath, 'output relativePath');
      let sourceName = `${crypto.randomUUID()}-${name}`;
      let stagePath = path.join(stage.payloadRoot, sourceName);
      let hostCreated = false;
      if (payload.sourceName) { sourceName = assertRelativePath(path, payload.sourceName, 'staged sourceName'); stagePath = path.resolve(stage.payloadRoot, sourceName); }
      else if (payload.inputToken) {
        const token = String(payload.inputToken); const snapshot = await consumeInput(token, descriptor, context);
        try { await fs.promises.copyFile(snapshot, stagePath, fs.constants.COPYFILE_EXCL); hostCreated = true; }
        finally { const grant = inputGrants.get(token); if (grant?.consumed) { inputGrants.delete(token); await discardInputGrant(fs, grant).catch(() => undefined); } }
      }
      else {
        const bytes = Buffer.from(String(payload.base64 || ''), 'base64');
        if (!bytes.length || bytes.length > MAX_INLINE_WRITE_BYTES) throw hostError(CODES.LIMIT_EXCEEDED, 'Inline output must be between 1 byte and 8 MiB');
        await fs.promises.writeFile(stagePath, bytes, { flag: 'wx' }); hostCreated = true;
      }
      const stagedStat = await fs.promises.lstat(stagePath).catch(() => null);
      if (!stagedStat?.isFile() || stagedStat.isSymbolicLink() || !inside(path, stage.payloadRoot, stagePath)) throw hostError(CODES.INVALID_REQUEST, 'Staged output source is missing or unsafe');
      if (!inside(path, await fs.promises.realpath(stage.payloadRoot), await fs.promises.realpath(stagePath))) throw hostError(CODES.PERMISSION_DENIED, 'Staged output source escapes through a linked directory');
      const replacement = payload.replace === true ? { previousCommitId: String(payload.previousCommitId || ''), previousArtifactId: String(payload.previousArtifactId || ''), expectedDigest: String(payload.expectedDigest || '').toLowerCase() } : null;
      if (replacement && (!SAFE_STAGE_ID.test(replacement.previousCommitId) || !SAFE_STAGE_ID.test(replacement.previousArtifactId) || !/^[a-f0-9]{64}$/.test(replacement.expectedDigest))) throw hostError(CODES.INVALID_REQUEST, 'Controlled replacement requires previousCommitId, previousArtifactId, and expectedDigest');
      const file = { artifactId: crypto.randomUUID(), sourceName, outputRelativePath, ...(replacement ? { replacement } : {}) };
      stage.files.push(file);
      try { await persistStage(stage); }
      catch (error) { stage.files.pop(); if (hostCreated) await fs.promises.rm(stagePath, { force: true }).catch(() => undefined); throw error; }
      return { stageId: stage.id, artifactId: file.artifactId, byteLength: stagedStat.size };
    }
    if (payload.action === 'validate') { const inspected = await inspectStage(stage); return { stageId: stage.id, valid: true, fileCount: inspected.fileCount, totalBytes: inspected.totalBytes }; }
    if (payload.action === 'rollback') { await rollbackPreparedReceiptsForStage(scope, stage.id); await cleanupStage(stage); return { stageId: stage.id, rolledBack: true }; }
    throw hostError(CODES.INVALID_REQUEST, 'Unknown output action');
  });

  const createVersion = async (payload, scope) => {
    const commitId = String(payload.commitId || '');
    const receipt = await loadCommitReceipt(scope, commitId);
    if (!receipt || receipt.state !== 'committed') throw hostError(CODES.TOKEN_SCOPE, 'Committed output does not belong to this component project');
    const artifact = receipt.outputs.find(item => item.artifactId === String(payload.artifactId || ''));
    if (!artifact) throw hostError(CODES.NOT_FOUND, 'Committed output artifact was not found');
    if (!await outputMatches(scope, artifact)) throw hostError(CODES.CONFLICT, 'Committed output changed before version creation');
    const idempotencyKey = String(payload.idempotencyKey || '');
    if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
    const versionId = stableUuid(crypto, `component-version\0${scope.key}\0${idempotencyKey}`);
    const versionKey = `${scope.key}\0${idempotencyKey}`;
    if (createdVersions.has(versionKey)) return createdVersions.get(versionKey);
    const receiptPath = versionReceiptPath(scope, versionId);
    let versionReceipt = await readJson(fs, receiptPath);
    if (versionReceipt && (versionReceipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || versionReceipt.kind !== 'component-version' || versionReceipt.versionId !== versionId
      || versionReceipt.componentId !== scope.componentId || versionReceipt.projectId !== String(scope.project.id) || versionReceipt.scopeDigest !== scopeDigest(scope)
      || versionReceipt.idempotencyKey !== idempotencyKey || versionReceipt.photoId !== String(payload.photoId) || versionReceipt.parentVersionId !== String(payload.parentVersionId)
      || versionReceipt.commitId !== commitId || versionReceipt.artifactId !== artifact.artifactId)) throw hostError(CODES.PERMISSION_DENIED, 'Component version receipt is invalid or belongs to another scope');
    let bundle = await versionService.getPhoto(scope.workspaceRoot, String(payload.photoId || ''));
    if (String(bundle?.photo?.projectId || '') !== String(scope.project.id)) throw hostError(CODES.TOKEN_SCOPE, 'Version photo is outside the bound project');
    if (!(bundle.versions || []).some(item => String(item.id) === String(payload.parentVersionId || ''))) throw hostError(CODES.NOT_FOUND, 'Parent version was not found');
    const existing = (bundle.versions || []).find(item => String(item.id) === versionId);
    if (existing) {
      const expectedFilePath = path.resolve(scope.projectRoot, artifact.relativePath);
      if (String(existing.parentVersionId || '') !== String(payload.parentVersionId) || path.resolve(String(existing.filePath || '')) !== expectedFilePath) throw hostError(CODES.CONFLICT, 'Stable component version id is already bound to different content');
      const response = { versionId, result: { success: true, ...bundle } };
      createdVersions.set(versionKey, response);
      if (!versionReceipt || versionReceipt.state !== 'committed') await replaceJson({ fs, crypto, filePath: receiptPath, value: { ...(versionReceipt || {}), schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-version', state: 'committed', versionId, idempotencyKey, componentId: scope.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), photoId: String(payload.photoId), parentVersionId: String(payload.parentVersionId), commitId, artifactId: artifact.artifactId, committedAt: Date.now() } }).catch(() => undefined);
      return response;
    }
    if (!versionReceipt) {
      versionReceipt = { schemaVersion: RECEIPT_SCHEMA_VERSION, kind: 'component-version', state: 'prepared', versionId, idempotencyKey, componentId: scope.componentId, projectId: String(scope.project.id), scopeDigest: scopeDigest(scope), photoId: String(payload.photoId), parentVersionId: String(payload.parentVersionId), commitId, artifactId: artifact.artifactId, createdAt: Date.now() };
      await replaceJson({ fs, crypto, filePath: receiptPath, value: versionReceipt });
    }
    const filePath = path.resolve(scope.projectRoot, artifact.relativePath);
    const result = await versionService.createVersion(scope.workspaceRoot, { photoId: String(payload.photoId), parentVersionId: String(payload.parentVersionId), versionId, filePath, versionName: String(payload.name || '组件输出').slice(0, 120), versionType: String(payload.type || 'component').slice(0, 40), note: String(payload.note || '').slice(0, 2000), isFinal: payload.isFinal === true, status: String(payload.status || 'draft').slice(0, 40) });
    const response = { versionId, result };
    versionReceipt.state = 'committed'; versionReceipt.committedAt = Date.now();
    try { await replaceJson({ fs, crypto, filePath: receiptPath, value: versionReceipt }); }
    catch (error) { createdVersions.delete(versionKey); throw error; }
    createdVersions.set(versionKey, response);
    void ensureTrackedVersionThumbnail?.({ workspaceRoot: scope.workspaceRoot, photoId: payload.photoId, versionId, filePath });
    return response;
  };
  broker.register('version.create', async (payload, context, descriptor) => {
    const scope = { ...bound(context, descriptor), componentId: descriptor.componentId };
    if (scope.contentKind === 'inspiration') throw hostError(CODES.PERMISSION_DENIED, 'Version creation is unavailable in the inspiration library');
    const idempotencyKey = String(payload.idempotencyKey || '');
    if (!ID.test(idempotencyKey)) throw hostError(CODES.INVALID_REQUEST, 'A stable idempotencyKey is required');
    return withOperation(versionOperations, `${scope.key}\0${idempotencyKey}`, () => createVersion(payload, scope));
  });

  broker.register('component.media', async (payload, context, descriptor) => {
    const scope = { ...bound(context, descriptor), componentId: descriptor.componentId };
    const relativePath = assertRelativePath(path, payload.relativePath, 'component media relativePath');
    const filePath = path.resolve(scope.componentRoot, relativePath);
    if (!inside(path, scope.componentRoot, filePath)) throw hostError(CODES.PERMISSION_DENIED, 'Component media escapes private storage');
    const stat = await fs.promises.lstat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || !inside(path, await fs.promises.realpath(scope.componentRoot), await fs.promises.realpath(filePath))) throw hostError(CODES.NOT_FOUND, 'Component private media is missing or unsafe');
    const opaqueRef = `component-media:${stableUuid(crypto, `${scope.key}\0${relativePath}`)}`;
    if (['open', 'reveal'].includes(payload.action)) {
      const error = payload.action === 'reveal' && typeof shell.showItemInFolder === 'function' ? (shell.showItemInFolder(filePath), '') : await shell.openPath(payload.action === 'reveal' ? path.dirname(filePath) : filePath);
      if (error) throw hostError(CODES.INTERNAL, String(error));
      return { opaqueRef, action: payload.action, opened: true };
    }
    if (payload.action !== 'variants') throw hostError(CODES.INVALID_REQUEST, 'Unknown component media action');
    mediaService.grantPath(filePath);
    const originalUrl = mediaService.toUrl(filePath, true);
    const requested = new Set(Array.isArray(payload.variants) ? payload.variants : ['thumbnail', 'preview']);
    if ([...requested].some(value => !['thumbnail', 'preview', 'original'].includes(value))) throw hostError(CODES.INVALID_REQUEST, 'Unknown component media variant');
    const variants = {};
    for (const [name, requestedSize] of [['thumbnail', 320], ['preview', 1600]]) if (requested.has(name)) {
      const generated = await mediaService.requestThumbnail({ filePath, kind: kindFor(filePath), cacheConfig: (readSavedConfig() || {}).mediaCache || {}, requestedSize, priority: 0, queueOrder: 0, awaitReady: true });
      const url = generated?.previewUrl || generated?.mediaUrl;
      if (!url || url === originalUrl) throw hostError(CODES.VARIANT_UNAVAILABLE, `${name} variant could not be generated`);
      variants[name] = { url, maxEdge: requestedSize, derived: true };
    }
    if (requested.has('original')) variants.original = { url: originalUrl, byteLength: stat.size, derived: false };
    for (const variant of Object.values(variants)) context.grantMediaUrl?.(variant.url);
    return { opaqueRef, variants };
  });

  const stripProgressPaths = value => Object.fromEntries(Object.entries(value || {}).filter(([field]) => !/(?:path|url)$/i.test(field)));
  const publicProgress = (scope, value) => {
    const result = stripProgressPaths(value);
    const folderPath = path.resolve(String(value?.folderPath || ''));
    if (folderPath && insideOrEqual(path, scope.projectRoot, folderPath)) result.contentRef = { relativeDirectory: normalizeRelativePath(path.relative(scope.projectRoot, folderPath)) };
    return result;
  };
  const progressSourceMetadata = (value, componentId) => {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw hostError(CODES.INVALID_REQUEST, 'Progress sourceMetadata must be an object');
    const supplied = value || {};
    const allowed = new Set(['category', 'role', 'displayName', 'componentId', 'parentCapability']);
    if (Object.keys(supplied).some(key => !allowed.has(key))) throw hostError(CODES.INVALID_REQUEST, 'Progress sourceMetadata has an unknown field');
    const normalized = { category: 'progress', parentCapability: 'structural' };
    for (const key of ['category', 'role', 'displayName']) if (supplied[key] !== undefined) {
      if (typeof supplied[key] !== 'string' || !supplied[key].trim() || supplied[key].length > 128 || /[\x00-\x1f\x7f]/.test(supplied[key])) throw hostError(CODES.INVALID_REQUEST, `Invalid progress sourceMetadata ${key}`);
      normalized[key] = supplied[key].trim();
    }
    if (supplied.parentCapability !== undefined) {
      if (!['structural', 'workflow-input', 'none'].includes(supplied.parentCapability)) throw hostError(CODES.INVALID_REQUEST, 'Invalid progress sourceMetadata parentCapability');
      normalized.parentCapability = supplied.parentCapability;
    }
    return { ...normalized, componentId };
  };
  broker.register('project.progress', async (payload, context, descriptor) => {
    const scope = bound(context, descriptor);
    if (scope.contentKind === 'inspiration') throw hostError(CODES.PERMISSION_DENIED, 'Project progress is unavailable in the inspiration library');
    if (payload.action === 'list') {
      const listed = await versionService.listProgress(scope.workspaceRoot, context.projectName, payload.includeMissing === true);
      return { progress: (listed.progressFolders || []).map(item => publicProgress(scope, item)), edges: (listed.edges || listed.graphEdges || []).map(stripProgressPaths) };
    }
    if (payload.action === 'relate') {
      const result = await versionService.updateProgressRelation(scope.workspaceRoot, { childProgressId: String(payload.childProgressId || ''), parentProgressId: String(payload.parentProgressId || ''), expectedUpdatedAt: payload.expectedUpdatedAt });
      return { result };
    }
    if (payload.action !== 'create') throw hostError(CODES.INVALID_REQUEST, 'Unknown project progress action');
    const mediaKind = String(payload.mediaKind || '');
    if (!['image', 'video'].includes(mediaKind)) throw hostError(CODES.INVALID_REQUEST, 'Progress mediaKind must be image or video');
    const versionKey = String(payload.versionKey || '').trim(); const parentProgressId = String(payload.parentProgressId || '').trim();
    if (!versionKey || versionKey.length > 128 || !parentProgressId) throw hostError(CODES.INVALID_REQUEST, 'Progress versionKey and parentProgressId are required');
    const sourceMetadata = progressSourceMetadata(payload.sourceMetadata, descriptor.componentId);
    const relativePath = assertRelativePath(path, payload.relativePath, 'progress relativePath');
    const resolution = projectVirtualPaths?.resolve ? projectVirtualPaths.resolve(scope.projectRoot, relativePath, { externalRootMode: 'target', mustExist: false, allowMissingLeaf: true }) : { physicalPath: path.resolve(scope.projectRoot, relativePath), viaExternalLink: false };
    const folderPath = path.resolve(resolution.physicalPath);
    if (!resolution.viaExternalLink && !inside(path, scope.projectRoot, folderPath)) throw hostError(CODES.PERMISSION_DENIED, 'Progress folder escapes the project');
    if (resolution.viaExternalLink && resolution.externalTargetKind === 'file') throw hostError(CODES.INVALID_REQUEST, 'Progress requires a folder boundary');
    const existing = await fs.promises.lstat(folderPath).catch(() => null);
    let createdDirectory = false;
    if (!existing) { await fs.promises.mkdir(folderPath, { recursive: false }); createdDirectory = true; }
    else if (!existing.isDirectory() || existing.isSymbolicLink()) throw hostError(CODES.INVALID_REQUEST, 'Progress target is not a safe folder');
    let registered;
    try {
      registered = await versionService.registerProgressWithGraph(scope.workspaceRoot, {
        projectName: context.projectName,
        progress: { mediaKind, versionKey, parentProgressId, displayName: String(payload.displayName || path.basename(folderPath)).slice(0, 160), folderPath, externalLinkRelativePath: resolution.viaExternalLink ? relativePath : undefined, sourceMetadata, relationKind: 'main', trackingEnabled: payload.trackingEnabled === true },
        workflowInputProgressIds: Array.isArray(payload.sourceProgressIds) ? [...new Set(payload.sourceProgressIds.map(String).filter(Boolean))].slice(0, 2000) : [],
      });
    } catch (error) { if (createdDirectory) await fs.promises.rmdir(folderPath).catch(() => undefined); throw error; }
    if (!registered?.success || !registered.progressFolder?.id) throw hostError(CODES.INTERNAL, registered?.error || 'Progress registration failed');
    return { progress: publicProgress(scope, registered.progressFolder), edges: (registered.edges || []).map(stripProgressPaths) };
  });

  broker.register('tasks', async (payload, context, descriptor) => {
    const operationId = String(payload.operationId || '');
    if (!ID.test(operationId)) throw hostError(CODES.INVALID_REQUEST, 'Invalid component task operationId');
    const key = `${scopeKey(descriptor, context)}\0${operationId}`;
    let handle = componentTaskHandles.get(key);
    if (['start', 'resume'].includes(payload.action)) {
      if (!handle || handle.isFinished()) {
        handle = backgroundTasks.create({
          id: `component:${descriptor.componentId}:${context.projectId}:${operationId}`,
          type: 'component-operation', title: String(payload.title || '组件任务').slice(0, 120), message: String(payload.message || '').slice(0, 500),
          cancellable: true, resumable: true, resumePolicy: 'checkpoint', checkpoint: payload.checkpoint,
          metadata: {
            componentId: descriptor.componentId, projectId: context.projectId, operationId,
            ...(context.surface === 'component.sidePanel' && context.sourcePageId && context.contributionId ? {
              presentationOwnerPageId: String(context.sourcePageId),
              presentationPanelKind: `component:${descriptor.componentId}:${context.contributionId}`,
            } : {}),
          },
        });
        await handle.waitForStart(); componentTaskHandles.set(key, handle);
      }
    } else if (payload.action === 'report') {
      if (!handle) throw hostError(CODES.NOT_FOUND, 'Component task was not found');
      handle.context.report(Math.max(0, Math.min(100, Number(payload.progress) || 0)), String(payload.message || '').slice(0, 500), { phase: String(payload.phase || '').slice(0, 80) });
      if (payload.checkpoint !== undefined) handle.context.saveCheckpoint(boundedObject(payload.checkpoint, MAX_SETTINGS_BYTES, 'Task checkpoint'), payload.progress, payload.message, { phase: payload.phase });
    } else if (payload.action === 'complete') handle?.complete(String(payload.message || 'Completed').slice(0, 500));
    else if (payload.action === 'fail') handle?.fail(hostError(CODES.INTERNAL, String(payload.error || 'Component task failed').slice(0, 1000)));
    else if (payload.action === 'cancel') { if (handle && !handle.isFinished()) backgroundTasks.cancel(handle.task.id); }
    else if (payload.action !== 'status') throw hostError(CODES.INVALID_REQUEST, 'Unknown component task action');
    const task = handle ? backgroundTasks.get(handle.task.id) || handle.snapshot() : null;
    return { task, cancelled: Boolean(handle?.context.signal.aborted), checkpoint: task?.checkpoint };
  });

  broker.register('dialogs', async (payload, context, descriptor) => {
    if (context?.surface === 'application.settings' && !['confirm', 'openComponentDirectory', 'openComponentDataDirectory'].includes(payload.kind)) throw hostError(CODES.PERMISSION_DENIED, 'Only confirmation and component-directory dialogs are available on the application settings surface');
    if (payload.kind === 'openComponentDataDirectory') {
      if (typeof getComponentDataRoot !== 'function') throw hostError(CODES.NOT_FOUND, 'Component data directory is unavailable');
      const relativePath = assertRelativePath(path, payload.relativePath, 'relativePath');
      const dataRoot = path.resolve(String(getComponentDataRoot(descriptor.componentId) || ''));
      await fs.promises.mkdir(dataRoot, { recursive: true });
      const rootStat = await fs.promises.lstat(dataRoot).catch(() => null);
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw hostError(CODES.NOT_FOUND, 'Component data directory is unavailable');
      let target = dataRoot;
      for (const part of relativePath.split('/')) {
        target = path.resolve(target, part);
        if (!inside(path, dataRoot, target)) throw hostError(CODES.INVALID_REQUEST, 'Component data directory path escapes its component');
        const existing = await fs.promises.lstat(target).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (!existing) await fs.promises.mkdir(target);
        const stat = existing || await fs.promises.lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw hostError(CODES.PERMISSION_DENIED, 'Component data directory path is unsafe');
      }
      const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(dataRoot), fs.promises.realpath(target)]);
      if (!inside(path, realRoot, realTarget)) throw hostError(CODES.PERMISSION_DENIED, 'Component data directory path is unsafe');
      const error = await shell.openPath(realTarget);
      if (error) throw hostError(CODES.INTERNAL, String(error));
      return { opened: true, componentDataDirectory: { relativePath } };
    }
    if (payload.kind === 'openComponentDirectory') {
      const relativePath = assertRelativePath(path, payload.relativePath, 'relativePath');
      if (relativePath.includes('/')) throw hostError(CODES.INVALID_REQUEST, 'Component directory must be a direct child');
      const componentRoot = path.resolve(String(descriptor.componentRoot || ''));
      const rootStat = await fs.promises.lstat(componentRoot).catch(() => null);
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw hostError(CODES.NOT_FOUND, 'Component directory is unavailable');
      const target = path.resolve(componentRoot, relativePath);
      if (!inside(path, componentRoot, target)) throw hostError(CODES.INVALID_REQUEST, 'Component directory path escapes its component');
      await fs.promises.mkdir(target, { recursive: true });
      const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(componentRoot), fs.promises.realpath(target)]);
      if (!inside(path, realRoot, realTarget)) throw hostError(CODES.PERMISSION_DENIED, 'Component directory path is unsafe');
      const error = await shell.openPath(realTarget);
      if (error) throw hostError(CODES.INTERNAL, String(error));
      return { opened: true, componentDirectory: { relativePath } };
    }
    if (['openOutput', 'revealOutput', 'openOutputDirectory'].includes(payload.kind)) {
      const scope = { ...bound(context, descriptor), componentId: descriptor.componentId };
      const receipt = await loadCommitReceipt(scope, String(payload.commitId || ''));
      if (!receipt || receipt.state !== 'committed') throw hostError(CODES.NOT_FOUND, 'Committed output reference was not found');
      const output = receipt.outputs.find(item => item.artifactId === String(payload.artifactId || ''));
      if (!output || !await outputMatches(scope, output)) throw hostError(CODES.CONFLICT, 'Committed output is missing or changed');
      const filePath = path.resolve(scope.projectRoot, output.relativePath);
      if (payload.kind === 'openOutputDirectory') {
        if (!mainWindow?.webContents || mainWindow.isDestroyed?.() || mainWindow.webContents.isDestroyed?.()) throw hostError(CODES.INTERNAL, 'Project browser is unavailable');
        const relativeDirectory = normalizeRelativePath(path.dirname(output.relativePath));
        sendToRequestingRenderer(mainWindow, 'component-host:open-project-directory', {
          workspacePath: scope.workspaceRoot,
          projectId: String(scope.project.id),
          projectName: String(scope.project.name || context.projectName),
          projectStatus: String(scope.project.status || context.projectStatus),
          relativePath: relativeDirectory === '.' ? '' : relativeDirectory,
        });
        return { opened: true, outputRef: { commitId: receipt.commitId, artifactId: output.artifactId } };
      }
      let error = '';
      if (payload.kind === 'revealOutput' && typeof shell.showItemInFolder === 'function') shell.showItemInFolder(filePath);
      else error = await shell.openPath(payload.kind === 'revealOutput' ? path.dirname(filePath) : filePath);
      if (error) throw hostError(CODES.INTERNAL, String(error));
      return { opened: true, outputRef: { commitId: receipt.commitId, artifactId: output.artifactId } };
    }
    if (payload.kind === 'confirm') {
      const confirmed = await requestConfirmation({ title: String(payload.title || '组件确认').slice(0, 120), message: String(payload.message || '').slice(0, 1000), confirmLabel: '继续', cancelDefault: true });
      return { confirmed: confirmed === true };
    }
    if (!['openFiles', 'openDirectory'].includes(payload.kind)) throw hostError(CODES.INVALID_REQUEST, 'Unknown safe dialog kind');
    const extensions = [...new Set((payload.extensions || []).map(value => String(value).replace(/^\./, '').toLowerCase()).filter(value => /^[a-z0-9]{1,12}$/.test(value)))].slice(0, 64);
    const selectingDirectory = payload.kind === 'openDirectory';
    const choice = await dialog.showOpenDialog(mainWindow, localizeDialogOptions({
      title: String(payload.title || (selectingDirectory ? translateNative("native.af1af22e7558") : translateNative("native.81309f7e827a"))).slice(0, 120),
      properties: selectingDirectory ? ['openDirectory'] : ['openFile', ...(payload.multiple === false ? [] : ['multiSelections'])],
      ...(!selectingDirectory && extensions.length ? { filters: [{ name: translateNative("native.393fbf1996b1"), extensions }] } : {}),
    }));
    if (choice.canceled) return { cancelled: true, inputs: [] };
    pruneExpiringMaps(fs, Date.now());
    const availableTokens = Math.max(0, MAX_INPUT_TOKENS - inputGrants.size);
    if (!availableTokens) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many active component input grants');
    const inputs = [];
    const selectedFiles = [];
    let truncated = false;
    if (selectingDirectory) {
      const selectedRoot = String(choice.filePaths[0] || '');
      if (!path.isAbsolute(selectedRoot)) throw hostError(CODES.INVALID_REQUEST, 'Selected input directory is invalid');
      const root = path.resolve(selectedRoot);
      const rootStat = await fs.promises.lstat(root).catch(() => null);
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw hostError(CODES.INVALID_REQUEST, 'Selected input directory is unsafe');
      const realRoot = await fs.promises.realpath(root);
      const rootIdentity = { dev: String(rootStat.dev), ino: String(rootStat.ino) };
      if (payload.directoryToken === true) {
        const grant = grantInput(realRoot, descriptor, context, realRoot);
        return { cancelled: false, inputs: [{ name: path.basename(realRoot), relativeName: path.basename(realRoot), kind: 'directory', ...grant }], truncated: false };
      }
      const pending = [realRoot];
      let inspected = 0;
      while (pending.length && selectedFiles.length < availableTokens && inspected < 20_000) {
        const directory = pending.shift();
        const directoryStat = await fs.promises.lstat(directory).catch(() => null);
        const realDirectory = await fs.promises.realpath(directory).catch(() => '');
        if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink() || !realDirectory || !insideOrEqual(path, realRoot, realDirectory)) { truncated = true; continue; }
        let handle;
        try { handle = await fs.promises.opendir(realDirectory); }
        catch (error) { if (path.resolve(directory) === path.resolve(realRoot)) throw hostError(CODES.PERMISSION_DENIED, 'Selected input directory became unavailable'); truncated = true; continue; }
        for await (const child of handle) {
          inspected += 1;
          if (inspected > 20_000) break;
          if (selectedFiles.length >= availableTokens) break;
          if (child.isSymbolicLink()) { truncated = true; continue; }
          const candidate = path.join(realDirectory, child.name);
          if (child.isDirectory()) { if (payload.recursive !== false) pending.push(candidate); continue; }
          if (!child.isFile() || extensions.length && !extensions.includes(path.extname(child.name).slice(1).toLowerCase())) continue;
          const realCandidate = await fs.promises.realpath(candidate).catch(() => '');
          if (!realCandidate || !inside(path, realRoot, realCandidate)) { truncated = true; continue; }
          selectedFiles.push({ filePath: realCandidate, relativeName: normalizeRelativePath(path.relative(realRoot, realCandidate)), boundary: realRoot });
        }
      }
      const finalRootStat = await fs.promises.lstat(root).catch(() => null);
      const finalRoot = await fs.promises.realpath(root).catch(() => '');
      if (!finalRootStat?.isDirectory() || finalRootStat.isSymbolicLink() || path.resolve(finalRoot) !== path.resolve(realRoot)
        || String(finalRootStat.dev) !== rootIdentity.dev || String(finalRootStat.ino) !== rootIdentity.ino) throw hostError(CODES.PERMISSION_DENIED, 'Selected input directory changed during enumeration');
      truncated ||= pending.length > 0 || selectedFiles.length >= availableTokens || inspected >= 20_000;
    } else {
      truncated ||= choice.filePaths.length > availableTokens;
      selectedFiles.push(...choice.filePaths.slice(0, availableTokens).map(filePath => ({ filePath: path.resolve(filePath), relativeName: path.basename(filePath), boundary: null })));
    }
    const minted = [];
    try {
      for (const selected of selectedFiles) {
        const filePath = path.resolve(selected.filePath);
        const stat = await fs.promises.lstat(filePath).catch(() => null);
        const realFile = await fs.promises.realpath(filePath).catch(() => '');
        if (!stat?.isFile() || stat.isSymbolicLink() || !realFile || path.resolve(realFile) !== filePath || selected.boundary && !inside(path, selected.boundary, realFile)) { truncated = true; continue; }
        if (extensions.length && !extensions.includes(path.extname(filePath).slice(1).toLowerCase())) continue;
        const grant = grantInput(filePath, descriptor, context, selected.boundary); minted.push(grant.token);
        inputs.push({ name: path.basename(filePath), relativeName: selected.relativeName, kind: 'file', ...grant });
      }
    } catch (error) { for (const token of minted) {const grant=inputGrants.get(token);inputGrants.delete(token);if(grant)await discardInputGrant(fs,grant).catch(()=>undefined);} throw error; }
    return { cancelled: false, inputs, ...(selectingDirectory ? { truncated } : {}) };
  });

  broker.register('component.events', async (payload, context, descriptor) => {
    const topic = String(payload.topic || '');
    if (!EVENT_TOPIC.test(topic) || !descriptor.service?.events?.includes(topic)) throw hostError(CODES.PERMISSION_DENIED, 'Component event topic is not declared');
    const event = boundedObject(payload.event || {}, MAX_SETTINGS_BYTES, 'Component event');
    context.emitComponentEvent?.(topic, event);
    return { emitted: true };
  });
  return {
    discardInput: async (token, descriptor, context) => { const grant = inputGrants.get(token); if (grant?.scope === scopeKey(descriptor, context) && !grant.reservedBy) { inputGrants.delete(token); await discardInputGrant(fs, grant); } },
    grantVerifiedFile: (filePath, descriptor, context, boundary, expectedDigest, identity) => {
      const input = grantInput(filePath, descriptor, context, boundary);
      const grant = inputGrants.get(input.token);
      grant.expectedDigest = expectedDigest;
      grant.componentScope = normalizeRelativePath(context.scopeRelativePath);
      if (identity) grant.identity = identity;
      return input;
    },
    grantDroppedInputs: async (filePaths, descriptor, context) => {
      const uniquePaths = [...new Set((Array.isArray(filePaths) ? filePaths : []).map(value => String(value || '')).filter(Boolean))].slice(0, 120);
      const inputs = [];
      const minted = [];
      try {
        for (const rawPath of uniquePaths) {
          if (!path.isAbsolute(rawPath)) continue;
          const candidate = path.resolve(rawPath);
          const stat = await fs.promises.lstat(candidate).catch(() => null);
          const canonical = await fs.promises.realpath(candidate).catch(() => '');
          if (!stat || stat.isSymbolicLink() || !canonical || path.resolve(canonical) !== candidate || !stat.isFile() && !stat.isDirectory()) continue;
          const grant = grantInput(candidate, descriptor, context, stat.isDirectory() ? candidate : null);
          minted.push(grant.token);
          inputs.push({ name: path.basename(candidate), relativeName: path.basename(candidate), kind: stat.isDirectory() ? 'directory' : 'file', ...grant });
        }
      } catch (error) {
        for (const token of minted) {const grant=inputGrants.get(token);inputGrants.delete(token);if(grant)await discardInputGrant(fs,grant).catch(()=>undefined);}
        throw error;
      }
      return { inputs };
    },
    consumeInput: (token, descriptor, context) => consumeInput(token, descriptor, context, true),
    peekInput: (token, descriptor, context) => consumeInput(token, descriptor, context, false),
    reserveInputs: async (tokens, descriptor, context, reservationId) => {
      pruneExpiringMaps(fs, Date.now()); const values = [...new Set(tokens.map(String))];
      if (values.length !== tokens.length) throw hostError(CODES.INVALID_REQUEST, 'Input tokens must be unique');
      const grants = values.map(token => {
        const grant = inputGrants.get(token);
        if (!grant || grant.consumed || grant.consumeClaimed) throw hostError(CODES.TOKEN_EXPIRED, 'Component input token is missing, expired, consumed, or already claimed');
        if (grant.scope !== scopeKey(descriptor, context)) throw hostError(CODES.TOKEN_SCOPE, 'Component input token belongs to another component or project');
        if (grant.componentScope !== undefined && grant.componentScope !== normalizeRelativePath(context.scopeRelativePath)) throw hostError(CODES.TOKEN_SCOPE, 'Component input token belongs to another scope');
        if (grant.reservedBy && grant.reservedBy !== reservationId) throw hostError(CODES.CONFLICT, 'Component input token is reserved by another operation');
        return { token, grant };
      });
      grants.forEach(({ grant }) => { grant.ttlRemainingMs=Math.max(1,grant.expiresAt-Date.now());clearTimeout(grant.cleanupTimer); grant.cleanupTimer=null; grant.originalExpiresAt ??= grant.expiresAt; grant.reservedBy = reservationId; grant.snapshotOwner = reservationId; grant.reservationExpiresAt = Number.POSITIVE_INFINITY; });
      try {
        const snapshots = [];
        for (const { token, grant } of grants) {
          snapshots.push({ token, filePath: await materializeVerifiedGrant(grant, token, descriptor, context) });
        }
        return snapshots;
      } catch (error) { for (const {token,grant} of grants) {delete grant.originalExpiresAt;delete grant.reservedBy;delete grant.reservationExpiresAt;grant.snapshotOwner=token;armGrantTimer(token,grant,grant.ttlRemainingMs||INPUT_TOKEN_TTL_MS);} throw error; }
    },
    commitReservation: async reservationId => { const cleanups=[];for (const [token, grant] of inputGrants) if (grant.reservedBy === reservationId) { inputGrants.delete(token);cleanups.push({token,grant,promise:discardInputGrant(fs,grant)}); }const results=await Promise.allSettled(cleanups.map(item=>item.promise));let pending=0;results.forEach((result,index)=>{if(result.status==='rejected'){pending+=1;const item=cleanups[index];const retry=setTimeout(()=>{void discardInputGrant(fs,item.grant).catch(()=>undefined);},1000);retry.unref?.();}});return{consumed:cleanups.length,cleanupPending:pending}; },
    releaseReservation: reservationId => { for (const [token, grant] of inputGrants) if (grant.reservedBy === reservationId) { delete grant.originalExpiresAt; delete grant.reservedBy; delete grant.reservationExpiresAt; grant.snapshotOwner = token; armGrantTimer(token,grant,grant.ttlRemainingMs||INPUT_TOKEN_TTL_MS); } },
    clearComponent: async (componentId, { preserveReservedInputs = false } = {}) => {
      const prefix = `${String(componentId || '')}\0`;
      let retainedInputs = false;
      const cleanups=[];for (const [token, grant] of inputGrants) if (String(grant.scope || '').startsWith(prefix)) {
        if (preserveReservedInputs && grant.reservedBy) { retainedInputs = true; continue; }
        inputGrants.delete(token); cleanups.push(discardInputGrant(fs, grant));
      }
      // Finish child snapshot cleanup before removing the shared parent. On Windows,
      // concurrent recursive removals of the same tree can fail with EPERM.
      const results = await Promise.allSettled(cleanups);
      if (!retainedInputs) {
        for(const root of componentInputRoots.get(String(componentId||''))||[]){inputRootInitialization.delete(path.resolve(root));results.push(...await Promise.allSettled([fs.promises.rm(root,{recursive:true,force:true})]));}componentInputRoots.delete(String(componentId||''));
      }
      const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,`Unable to clear component input snapshots for ${componentId}`);
    },
  };
};

module.exports = {
  CURSOR_TTL_MS,
  INPUT_TOKEN_TTL_MS,
  MAX_INLINE_WRITE_BYTES,
  MAX_MEDIA_PAGE_SIZE,
  MAX_SETTINGS_BYTES,
  MAX_STAGE_BYTES,
  RECEIPT_SCHEMA_VERSION,
  STAGE_SCHEMA_VERSION,
  STAGE_TTL_MS,
  assertRelativePath,
  normalizeRelativePath,
  adoptExistingOutput,
  registerComponentProjectCapabilities,
  resetComponentHostCapabilityStateForTest,
  stableUuid,
};
