const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');

const TTL = 5 * 60 * 1000;
const MAX_SCAN = 20000;
const exact = (value, fields, required = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw hostError(CODES.INVALID_REQUEST, 'Invalid file resource request');
};
const relative = value => {
  if (typeof value !== 'string' || !value || value.length > 1024 || value !== value.trim() || /[\\:\x00]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.photoflow-'))) throw hostError(CODES.INVALID_REQUEST, 'Expected a project-relative file path');
  return value;
};
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs });
const fingerprint = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

const registerComponentFileResources = ({ broker, projectDomain, ensureWorkspace, getBoundProject, getProjectPath, resolveComponentContentBinding, fs, path, crypto, versionService, now = Date.now }) => {
  const subscriptions = new Map();
  const inside = (root, file) => { const value = path.relative(root, file); return !value || value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value); };
  const bound = async (context, descriptor) => {
    if (!['project', 'component.sidePanel', 'media.contextAction', 'project.contextAction', 'project.importProvider', 'project.exportProvider'].includes(context?.surface)) throw hostError(CODES.PERMISSION_DENIED, 'A project surface is required');
    const binding = resolveComponentContentBinding?.(context);
    if (context.contentKind === 'inspiration' && !binding) throw hostError(CODES.NOT_FOUND, 'Content binding is unavailable');
    const workspace = binding?.workspaceRoot || ensureWorkspace(context.workspacePath);
    const project = binding?.project || getBoundProject?.(workspace, context.projectName);
    if (!project || String(project.id) !== String(context.projectId)) throw hostError(CODES.NOT_FOUND, 'Project is unavailable');
    const root = path.resolve(binding?.projectRoot || getProjectPath(workspace, project.status || context.projectStatus, project.name));
    const scopePath = context.scopeRelativePath ? relative(context.scopeRelativePath.replace(/\\/g, '/')) : '';
    const scopeRoot = path.resolve(root, scopePath);
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw hostError(CODES.PERMISSION_DENIED, 'Unsafe project root');
    const canonicalRoot = await fs.promises.realpath(root);
    const scope = { root, scopeRoot, canonicalRoot, workspace, project, contentKind: binding?.contentKind || 'project', key: `${descriptor.componentId}\0${workspace}\0${project.id}\0${scopePath}\0${context.sourcePageId || ''}`, componentId: descriptor.componentId };
    if (scopePath) await safe(scope, scopePath, true);
    return scope;
  };
  const safe = async (scope, name, directory = false) => {
    relative(name);
    const candidate = path.resolve(scope.root, name);
    if (!inside(scope.scopeRoot, candidate)) throw hostError(CODES.PERMISSION_DENIED, 'File is outside component scope');
    let current = scope.root;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      const stat = await fs.promises.lstat(current).catch(error => { if (error.code === 'ENOENT') throw hostError(CODES.NOT_FOUND, 'Project file is missing'); throw error; });
      if (stat.isSymbolicLink()) throw hostError(CODES.PERMISSION_DENIED, 'Linked paths are not allowed');
    }
    const canonical = await fs.promises.realpath(candidate);
    const stat = await fs.promises.lstat(candidate);
    if (!inside(scope.canonicalRoot, canonical) || !(directory ? stat.isDirectory() : stat.isFile())) throw hostError(CODES.PERMISSION_DENIED, 'Unsafe project file');
    return { filePath: canonical, stat };
  };
  const digestFile = async (filePath, expectedStat) => {
    const hash = crypto.createHash('sha256');
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || fingerprint(opened) !== fingerprint(expectedStat)) throw hostError(CODES.CONFLICT, 'Project file changed before reading');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (fingerprint(await handle.stat()) !== fingerprint(expectedStat)) throw hostError(CODES.CONFLICT, 'Project file changed while reading');
      return hash.digest('hex');
    } finally { await handle.close(); }
  };
  broker.register('project.files.inputToken', async (payload, context, descriptor) => {
    exact(payload, ['relativePath', 'expectedDigest'], ['relativePath']);
    if (payload.expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(payload.expectedDigest)) throw hostError(CODES.INVALID_REQUEST, 'Invalid expectedDigest');
    const scope = await bound(context, descriptor);
    const before = await safe(scope, payload.relativePath);
    const sha256 = await digestFile(before.filePath, before.stat);
    const after = await safe(scope, payload.relativePath);
    if (fingerprint(before.stat) !== fingerprint(after.stat) || payload.expectedDigest && payload.expectedDigest !== sha256) throw hostError(CODES.CONFLICT, 'Project file changed');
    const input = projectDomain.grantVerifiedFile(after.filePath, descriptor, context, scope.canonicalRoot, sha256, identity(after.stat));
    return { input, relativePath: payload.relativePath, name: path.basename(payload.relativePath), byteLength: after.stat.size, sha256, fileId: crypto.createHash('sha256').update(`${scope.key}\0${after.stat.dev}:${after.stat.ino}`).digest('hex') };
  });
  const snapshot = async scope => {
    const files = new Map(); const pending = [scope.scopeRoot]; let count = 0; let truncated = false;
    while (pending.length && !truncated) {
      const directory = pending.pop();
      const directoryName = path.relative(scope.root, directory).replace(/\\/g, '/');
      if (directoryName) await safe(scope, directoryName, true);
      const entries = await fs.promises.opendir(directory);
      for await (const entry of entries) {
        if (++count > MAX_SCAN) { truncated = true; break; }
        if (entry.name.startsWith('.photoflow-') || entry.isSymbolicLink()) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile()) {
          const name = path.relative(scope.root, target).replace(/\\/g, '/');
          try { const item = await safe(scope, name); files.set(name, { relativePath: name, fileId: crypto.createHash('sha256').update(`${scope.key}\0${item.stat.dev}:${item.stat.ino}`).digest('hex'), revision: fingerprint(item.stat), versionId: null }); }
          catch (error) { if (error.code !== CODES.NOT_FOUND) throw error; truncated = true; }
        }
      }
    }
    return { files, truncated };
  };
  const dispose = id => { const item = subscriptions.get(id); if (item) { clearTimeout(item.timer); subscriptions.delete(id); } };
  const touch = item => { clearTimeout(item.timer); item.expiresAt = now() + TTL; item.timer = setTimeout(() => dispose(item.subscriptionId), TTL); item.timer.unref?.(); };
  broker.register('project.files.watch', async (payload, context, descriptor) => {
    const scope = await bound(context, descriptor);
    for (const [id, item] of subscriptions) if (item.expiresAt <= now()) dispose(id);
    if (payload.action === 'subscribe') {
      exact(payload, ['action', 'relativePaths', 'includeVersions'], ['relativePaths']);
      if (!Array.isArray(payload.relativePaths) || !payload.relativePaths.length || payload.relativePaths.length > 256 || new Set(payload.relativePaths).size !== payload.relativePaths.length || payload.includeVersions !== undefined && typeof payload.includeVersions !== 'boolean') throw hostError(CODES.INVALID_REQUEST, 'Subscribe to 1-256 unique files');
      if (payload.includeVersions && (!descriptor.service.permissions.includes('project.versions.read') || scope.contentKind !== 'project')) throw hostError(CODES.PERMISSION_DENIED, 'Version tracking requires project.versions.read in a project');
      if (subscriptions.size >= 256 || [...subscriptions.values()].filter(item => item.componentId === descriptor.componentId).length >= 16) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many file subscriptions');
      const files = [];
      for (const name of payload.relativePaths) { const item = await safe(scope, name); files.push({ relativePath: name, fileId: crypto.createHash('sha256').update(`${scope.key}\0${item.stat.dev}:${item.stat.ino}`).digest('hex'), revision: fingerprint(item.stat), versionId: null }); }
      const item = { subscriptionId: crypto.randomUUID(), componentId: descriptor.componentId, key: scope.key, files, cursor: 0, lastPoll: now(), includeVersions: payload.includeVersions === true };
      if (item.includeVersions) item.needsRescan = await addVersions(scope, files);
      // Recheck after asynchronous reads: other subscribe calls may have completed.
      if (subscriptions.size >= 256 || [...subscriptions.values()].filter(value => value.componentId === descriptor.componentId).length >= 16) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many file subscriptions');
      subscriptions.set(item.subscriptionId, item); touch(item);
      return { subscriptionId: item.subscriptionId, cursor: 0, expiresAt: item.expiresAt, files };
    }
    exact(payload, ['action', 'subscriptionId', ...(payload.action === 'poll' ? ['cursor'] : [])], ['action', 'subscriptionId', ...(payload.action === 'poll' ? ['cursor'] : [])]);
    if (!['poll', 'unsubscribe'].includes(payload.action) || typeof payload.subscriptionId !== 'string') throw hostError(CODES.INVALID_REQUEST, 'Invalid subscription action');
    const item = subscriptions.get(payload.subscriptionId);
    if (!item || item.key !== scope.key) throw hostError(CODES.TOKEN_EXPIRED, 'Subscription expired or belongs to another scope');
    if (payload.action === 'unsubscribe') { dispose(item.subscriptionId); return { unsubscribed: true }; }
    if (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0) throw hostError(CODES.INVALID_REQUEST, 'Invalid subscription cursor');
    if (item.busy) throw hostError(CODES.CONFLICT, 'A poll is already active');
    item.busy = true;
    try {
      const scan = await snapshot(scope); const events = []; const next = [];
      let rescanRequired = scan.truncated || item.needsRescan === true || payload.cursor !== item.cursor || now() - item.lastPoll > 30000;
      const byId = new Map(); for (const file of scan.files.values()) { if (byId.has(file.fileId)) byId.set(file.fileId, null); else byId.set(file.fileId, file); }
      for (const previous of item.files) {
        const current = scan.files.get(previous.relativePath) || byId.get(previous.fileId);
        if (current) next.push({ ...current });
        else next.push(scan.truncated ? { ...previous } : { ...previous, missing: true });
      }
      if (item.includeVersions) rescanRequired = await addVersions(scope, next) || rescanRequired;
      next.forEach((current, index) => {
        const previous = item.files[index];
        const emit = type => events.push({ ...current, subscriptionId: item.subscriptionId, sequence: ++item.cursor, type, previousRelativePath: previous.relativePath });
        if (current.missing) { if (!previous.missing) emit('deleted'); }
        else { if (current.relativePath !== previous.relativePath) emit('renamed'); if (previous.missing || current.revision !== previous.revision) emit('modified'); if (current.versionId !== previous.versionId) emit('versionChanged'); }
      });
      item.files = next; item.needsRescan = false; item.lastPoll = now(); touch(item);
      return { subscriptionId: item.subscriptionId, cursor: item.cursor, events, files: next, rescanRequired, expiresAt: item.expiresAt };
    } finally { item.busy = false; }
  });
  const addVersions = async (scope, files) => {
    const result = await versionService.snapshotProjectVersions(scope.workspace, { projectName: scope.project.name, projectPath: scope.root, scopePath: scope.scopeRoot, limit: MAX_SCAN });
    const versions = result.versions || [];
    for (const file of files) {
      const own = versions.find(version => version.filePath && path.resolve(version.filePath) === path.resolve(scope.root, file.relativePath));
      const current = own && versions.find(version => version.photoId === own.photoId && version.isCurrent);
      file.versionId = current ? String(current.id) : null;
    }
    return result.truncated === true;
  };
  return { bound, resolveFile: safe, clearComponent: componentId => { for (const [id, item] of subscriptions) if (item.componentId === componentId) dispose(id); } };
};
module.exports = { registerComponentFileResources, exact, identity };
