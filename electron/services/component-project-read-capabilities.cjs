const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');

const MAX_PAGE_SIZE = 200;
const MAX_SEARCH_RESULTS = 500;
const MAX_SCAN_ENTRIES = 5000;
const MAX_VERSION_ITEMS = 5000;
const MAX_PROGRESS_SCAN = 5000;
const MAX_PROGRESS_ITEMS = 1000;
const MAX_PROGRESS_EDGES = 2000;
const CURSOR_TTL_MS = 5 * 60 * 1000;
const cursors = new Map();
const MEDIA_KINDS = new Set(['image', 'raw', 'video']);
const SIDECAR_EXTENSIONS = new Set(['.xmp', '.aae', '.dop', '.pp3', '.cos', '.on1', '.json']);
const CURSOR_ID = /^[a-f0-9-]{36}$/i;

const normalizeRelative = value => String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const assertRelative = (path, value, { optional = false, label = 'relativePath' } = {}) => {
  const relative = normalizeRelative(value);
  if (optional && !relative) return '';
  if (!relative || relative.length > 1024 || path.isAbsolute(relative) || /^[a-z]:/i.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw hostError(CODES.INVALID_REQUEST, `Invalid ${label}`);
  return relative;
};
const insideOrEqual = (path, root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const text = (value, max, label) => {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) throw hostError(CODES.INVALID_REQUEST, `Invalid ${label}`);
  return value;
};
const finiteTime = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const boundedString = (value, max) => String(value ?? '').slice(0, max);
const assertObjectFields = (value, allowed, required = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw hostError(CODES.INVALID_REQUEST, 'Capability payload must be an object');
  const unknown = Object.keys(value).find(field => !allowed.includes(field));
  if (unknown || required.some(field => !Object.prototype.hasOwnProperty.call(value, field))) throw hostError(CODES.INVALID_REQUEST, 'Capability payload has missing or unknown fields');
};
const pageSizeFor = payload => {
  if (payload.pageSize === undefined) return 100;
  if (!Number.isInteger(payload.pageSize) || payload.pageSize < 1 || payload.pageSize > MAX_PAGE_SIZE) throw hostError(CODES.INVALID_REQUEST, 'pageSize must be an integer from 1 to 200');
  return payload.pageSize;
};
const cursorIdFor = payload => {
  if (payload.cursor === undefined || payload.cursor === null) return '';
  if (typeof payload.cursor !== 'string' || payload.cursor.length > 80 || !CURSOR_ID.test(payload.cursor)) throw hostError(CODES.INVALID_REQUEST, 'Invalid cursor');
  return payload.cursor;
};
const publicVersion = version => ({
  id: boundedString(version.id, 128), photoId: boundedString(version.photoId, 128), parentVersionId: version.parentVersionId ? boundedString(version.parentVersionId, 128) : null,
  versionNumber: Math.max(0, Math.trunc(Number(version.versionNumber) || 0)), name: boundedString(version.versionName, 160), type: boundedString(version.versionType, 80),
  status: boundedString(version.status, 80), note: boundedString(version.note, 2000), isCurrent: version.isCurrent === true, isFinal: version.isFinal === true,
  fileMissing: version.fileMissing === true, contentChanged: version.contentChanged === true,
  createdAt: finiteTime(version.createdAt), updatedAt: finiteTime(version.updatedAt),
});
const publicProgress = progress => ({
  id: boundedString(progress.id, 128), nodeRole: boundedString(progress.nodeRole, 40), mediaKind: boundedString(progress.mediaKind, 40),
  versionKey: boundedString(progress.versionKey, 128), displayName: boundedString(progress.displayName || progress.versionName, 160),
  parentProgressId: progress.parentProgressId ? boundedString(progress.parentProgressId, 128) : null,
  relationKind: progress.relationKind ? boundedString(progress.relationKind, 40) : null, trackingEnabled: progress.trackingEnabled === true,
  missing: progress.folderMissing === true || progress.missing === true || progress.fileMissing === true, createdAt: finiteTime(progress.createdAt), updatedAt: finiteTime(progress.updatedAt),
});

const registerComponentProjectReadCapabilities = ({
  broker, ensureWorkspace, getProjectPath, getBoundProject, path, fs, crypto, versionService, mediaRatingService, exiftool, resolveComponentContentBinding = null,
  IMAGE_EXTENSIONS, RAW_EXTENSIONS = new Set(), VIDEO_EXTENSIONS = new Set(),
}) => {
  const kindFor = filePath => {
    const extension = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) ? 'image' : RAW_EXTENSIONS.has(extension) ? 'raw' : VIDEO_EXTENSIONS.has(extension) ? 'video' : 'file';
  };
  const bound = async (context, descriptor) => {
    if (!context || !['project', 'component.sidePanel', 'media.contextAction', 'project.contextAction', 'project.importProvider', 'project.exportProvider'].includes(context.surface)) throw hostError(CODES.PERMISSION_DENIED, 'Capability requires a bound project surface');
    const binding = resolveComponentContentBinding?.(context);
    if (context.contentKind === 'inspiration' && !binding) throw hostError(CODES.NOT_FOUND, 'Inspiration content binding is unavailable');
    const workspaceRoot = binding?.workspaceRoot || ensureWorkspace(context.workspacePath);
    const project = binding?.project || getBoundProject?.(workspaceRoot, context.projectName);
    if (!project || String(project.id || '') !== String(context.projectId || '')) throw hostError(CODES.NOT_FOUND, 'Bound project is unavailable');
    const projectRoot = binding?.projectRoot || path.resolve(getProjectPath(workspaceRoot, project.status || context.projectStatus, project.name || context.projectName));
    const scopeRelativePath = assertRelative(path, context.scopeRelativePath, { optional: true, label: 'scopeRelativePath' });
    const scopeRoot = path.resolve(projectRoot, scopeRelativePath);
    if (!insideOrEqual(path, projectRoot, scopeRoot)) throw hostError(CODES.PERMISSION_DENIED, 'Component scope escapes the bound project');
    const projectStat = await fs.promises.lstat(projectRoot).catch(() => null); const scopeStat = await fs.promises.lstat(scopeRoot).catch(() => null);
    if (!projectStat?.isDirectory() || projectStat.isSymbolicLink() || !scopeStat?.isDirectory() || scopeStat.isSymbolicLink()) throw hostError(CODES.PERMISSION_DENIED, 'Project scope is not a safe physical directory');
    const canonicalProjectRoot = await fs.promises.realpath(projectRoot).catch(() => null); const canonicalScopeRoot = await fs.promises.realpath(scopeRoot).catch(() => null);
    if (!canonicalProjectRoot || !canonicalScopeRoot || !insideOrEqual(path, canonicalProjectRoot, canonicalScopeRoot)) throw hostError(CODES.PERMISSION_DENIED, 'Project scope escapes its physical project boundary');
    const key = `${descriptor.componentId}\0${workspaceRoot}\0${context.projectId}\0${scopeRelativePath}`;
    return { workspaceRoot, project, projectRoot, scopeRoot, canonicalProjectRoot, canonicalScopeRoot, scopeRelativePath, contentKind: binding?.contentKind || 'project', key };
  };
  const resolveFile = async (scope, relativePath, { mediaOnly = false } = {}) => {
    const relative = assertRelative(path, relativePath);
    const candidate = path.resolve(scope.projectRoot, relative);
    if (!insideOrEqual(path, scope.scopeRoot, candidate)) throw hostError(CODES.PERMISSION_DENIED, 'Path is outside the bound component scope');
    const stat = await fs.promises.lstat(candidate).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw hostError(CODES.NOT_FOUND, 'Project file was not found');
    const realCandidate = await fs.promises.realpath(candidate).catch(() => null);
    if (!realCandidate || !insideOrEqual(path, scope.canonicalScopeRoot, realCandidate)) throw hostError(CODES.PERMISSION_DENIED, 'Project file escapes through a linked path');
    const kind = kindFor(candidate);
    if (mediaOnly && !MEDIA_KINDS.has(kind)) throw hostError(CODES.INVALID_REQUEST, 'Media capability requires an image, raw, or video file');
    return { relativePath: relative, filePath: candidate, stat, kind };
  };
  const prune = () => { const now = Date.now(); for (const [id, cursor] of cursors) if (cursor.expiresAt <= now) cursors.delete(id); };
  const issueCursor = (scope, kind, items, offset, state) => {
    if (offset >= items.length) return null;
    prune();
    const id = crypto.randomUUID();
    cursors.set(id, { scope: scope.key, kind, items, offset, ...state, expiresAt: Date.now() + CURSOR_TTL_MS });
    return id;
  };
  const pageCursor = (payload, scope, kind) => {
    prune();
    const id = cursorIdFor(payload);
    const cursor = id ? cursors.get(id) : null;
    if (id && (!cursor || cursor.scope !== scope.key || cursor.kind !== kind)) throw hostError(CODES.TOKEN_EXPIRED, 'Cursor is missing, expired, or belongs to another component scope');
    return cursor;
  };
  const walk = async (scope, visitor) => {
    const pending = [{ directory: scope.scopeRoot, relative: scope.scopeRelativePath }];
    let inspected = 0; let truncated = false;
    while (pending.length) {
      const current = pending.shift();
      const currentStat = await fs.promises.lstat(current.directory).catch(() => null); const canonicalCurrent = await fs.promises.realpath(current.directory).catch(() => null);
      if (!currentStat?.isDirectory() || currentStat.isSymbolicLink() || !canonicalCurrent || !insideOrEqual(path, scope.canonicalScopeRoot, canonicalCurrent)) throw hostError(CODES.PERMISSION_DENIED, 'Project directory escapes through a linked path');
      const entries = await fs.promises.readdir(current.directory, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }));
      for (const entry of entries) {
        if (++inspected > MAX_SCAN_ENTRIES) { truncated = true; pending.length = 0; break; }
        if (entry.isSymbolicLink()) throw hostError(CODES.PERMISSION_DENIED, 'Linked project entries are not available to components');
        if (entry.name.startsWith('.photoflow-')) continue;
        const filePath = path.join(current.directory, entry.name);
        const relativePath = [current.relative, entry.name].filter(Boolean).join('/');
        if (entry.isDirectory()) pending.push({ directory: filePath, relative: relativePath });
        if (entry.isDirectory() || entry.isFile()) await visitor({ entry, filePath, relativePath });
      }
    }
    return { inspected, truncated };
  };
  const fileSnapshot = async (scope, query = '') => {
    const items = []; const needle = query.toLocaleLowerCase();
    const scan = await walk(scope, async candidate => {
      if (items.length >= MAX_SEARCH_RESULTS && query) return;
      if (needle && !candidate.relativePath.toLocaleLowerCase().includes(needle)) return;
      if (candidate.entry.isDirectory()) { items.push({ relativePath: candidate.relativePath, name: candidate.entry.name, kind: 'directory' }); return; }
      const mediaKind = kindFor(candidate.filePath); if (MEDIA_KINDS.has(mediaKind)) return;
      const stat = await fs.promises.stat(candidate.filePath).catch(() => null); if (!stat?.isFile()) return;
      const extension = path.extname(candidate.entry.name).toLowerCase();
      items.push({ relativePath: candidate.relativePath, name: candidate.entry.name, kind: SIDECAR_EXTENSIONS.has(extension) ? 'sidecar' : 'file', extension, size: stat.size, updatedAt: stat.mtimeMs });
    });
    items.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en', { numeric: true, sensitivity: 'base' }));
    return { items: query ? items.slice(0, MAX_SEARCH_RESULTS) : items, truncated: Boolean(scan.truncated || query && items.length >= MAX_SEARCH_RESULTS) };
  };

  const filePage = async (payload, context, descriptor, search) => {
    assertObjectFields(payload, search ? ['query', 'pageSize', 'cursor'] : ['pageSize', 'cursor'], search ? ['query'] : []);
    const scope = await bound(context, descriptor); const pageSize = pageSizeFor(payload);
    let cursor = pageCursor(payload, scope, search ? 'files-search' : 'files-page');
    let truncated = false;
    if (!cursor) {
      const query = search ? text(payload.query, 160, 'search query') : '';
      const snapshot = await fileSnapshot(scope, query); truncated = snapshot.truncated;
      cursor = { items: snapshot.items, offset: 0, truncated, query, pageSize };
    } else if (cursor.pageSize !== pageSize || search && cursor.query !== payload.query) {
      throw hostError(CODES.INVALID_REQUEST, 'Continuation payload does not match the original request');
    }
    truncated = cursor.truncated;
    const items = cursor.items.slice(cursor.offset, cursor.offset + pageSize); const nextOffset = cursor.offset + items.length;
    if (payload.cursor) { cursor.offset = nextOffset; cursor.expiresAt = Date.now() + CURSOR_TTL_MS; if (nextOffset >= cursor.items.length) cursors.delete(String(payload.cursor)); }
    const nextCursor = payload.cursor ? (nextOffset < cursor.items.length ? String(payload.cursor) : null) : issueCursor(scope, search ? 'files-search' : 'files-page', cursor.items, nextOffset, { truncated, query: cursor.query, pageSize });
    return { items, page: { cursor: nextCursor, hasMore: Boolean(nextCursor), pageSize, truncated } };
  };
  broker.register('project.files.page', (payload, context, descriptor) => filePage(payload, context, descriptor, false));
  broker.register('project.files.search', (payload, context, descriptor) => filePage(payload, context, descriptor, true));

  broker.register('project.media.metadata', async (payload, context, descriptor) => {
    assertObjectFields(payload, ['relativePath'], ['relativePath']);
    const scope = await bound(context, descriptor); const media = await resolveFile(scope, payload.relativePath, { mediaOnly: true });
    const args = ['-G1', '-n', '-ImageWidth', '-ImageHeight', '-ColorSpace', '-ColorProfileDescription', '-Make', '-Model', '-LensModel', '-LensID', '-FNumber', '-ExposureTime', '-ISO', '-FocalLength', '-DateTimeOriginal', '-Duration', '-VideoFrameRate', '-VideoCodec', '-CompressorName', '-AudioCodec', '-Rotation', '-api', 'largefilesupport=1'];
    let tags;
    try { tags = await exiftool.readRaw(media.filePath, args); }
    catch { throw hostError(CODES.INTERNAL, 'Media metadata could not be read'); }
    const metadataValue = value => typeof value === 'string' ? value.slice(0, 512) : typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' ? value : null;
    const pick = (...names) => {
      for (const [key, value] of Object.entries(tags || {})) if (names.some(name => key.toLocaleLowerCase().endsWith(`:${name.toLocaleLowerCase()}`) || key.toLocaleLowerCase() === name.toLocaleLowerCase())) return metadataValue(value);
      return null;
    };
    const number = (...names) => {
      const raw = pick(...names);
      if (raw === null || typeof raw === 'boolean' || typeof raw === 'string' && !raw.trim()) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    return { mediaRef: { relativePath: media.relativePath }, kind: media.kind, size: media.stat.size, updatedAt: media.stat.mtimeMs,
      dimensions: { width: number('ImageWidth'), height: number('ImageHeight') }, colorSpace: pick('ColorSpace', 'ColorProfileDescription'),
      camera: { make: pick('Make'), model: pick('Model'), lens: pick('LensModel', 'LensID') },
      capture: { aperture: number('FNumber'), exposureTime: pick('ExposureTime'), iso: number('ISO'), focalLength: number('FocalLength'), takenAt: pick('DateTimeOriginal') },
      video: media.kind === 'video' ? { codec: pick('VideoCodec', 'CompressorName'), audioCodec: pick('AudioCodec'), durationSeconds: number('Duration'), frameRate: number('VideoFrameRate'), rotation: number('Rotation') } : null };
  });

  const versionSnapshot = async scope => {
    const result = await versionService.snapshotProjectVersions(scope.workspaceRoot, { projectName: scope.project.name, projectPath: scope.projectRoot, scopePath: scope.scopeRoot, limit: MAX_VERSION_ITEMS });
    const items = (result.versions || []).slice(0, MAX_VERSION_ITEMS).map(publicVersion);
    items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return { items, truncated: result.truncated === true };
  };
  broker.register('project.versions.page', async (payload, context, descriptor) => {
    assertObjectFields(payload, ['pageSize', 'cursor']);
    const scope = await bound(context, descriptor); const pageSize = pageSizeFor(payload);
    if (scope.contentKind === 'inspiration') throw hostError(CODES.PERMISSION_DENIED, 'Project versions are unavailable in the inspiration library');
    let cursor = pageCursor(payload, scope, 'versions-page'); let truncated = false;
    if (!cursor) { const snapshot = await versionSnapshot(scope); cursor = { items: snapshot.items, offset: 0, truncated: snapshot.truncated, pageSize }; truncated = snapshot.truncated; }
    else if (cursor.pageSize !== pageSize) throw hostError(CODES.INVALID_REQUEST, 'Continuation payload does not match the original request');
    truncated = cursor.truncated;
    const items = cursor.items.slice(cursor.offset, cursor.offset + pageSize); const nextOffset = cursor.offset + items.length;
    if (payload.cursor) { cursor.offset = nextOffset; cursor.expiresAt = Date.now() + CURSOR_TTL_MS; if (nextOffset >= cursor.items.length) cursors.delete(String(payload.cursor)); }
    const nextCursor = payload.cursor ? (nextOffset < cursor.items.length ? String(payload.cursor) : null) : issueCursor(scope, 'versions-page', cursor.items, nextOffset, { truncated, pageSize });
    return { items, page: { cursor: nextCursor, hasMore: Boolean(nextCursor), pageSize, truncated } };
  });
  broker.register('project.version.graph', async (payload, context, descriptor) => {
    assertObjectFields(payload, ['includeMissing']); if (payload.includeMissing !== undefined && typeof payload.includeMissing !== 'boolean') throw hostError(CODES.INVALID_REQUEST, 'includeMissing must be boolean');
    const scope = await bound(context, descriptor);
    if (scope.contentKind === 'inspiration') throw hostError(CODES.PERMISSION_DENIED, 'Project version graph is unavailable in the inspiration library');
    const versions = await versionSnapshot(scope);
    const listed = await versionService.snapshotProgress(scope.workspaceRoot, scope.project.name, payload.includeMissing === true);
    const allProgress = Array.isArray(listed.progressFolders) ? listed.progressFolders : [];
    const scannedProgress = allProgress.slice(0, MAX_PROGRESS_SCAN); const visibleProgress = [];
    const safeMissingAncestor = async candidate => {
      let ancestor = candidate;
      while (insideOrEqual(path, scope.scopeRoot, ancestor)) {
        const stat = await fs.promises.lstat(ancestor).catch(() => null);
        if (stat) {
          if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
          const canonical = await fs.promises.realpath(ancestor).catch(() => null);
          return Boolean(canonical && insideOrEqual(path, scope.canonicalScopeRoot, canonical));
        }
        if (path.resolve(ancestor) === path.resolve(scope.scopeRoot)) break;
        const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
      }
      return false;
    };
    for (const progressEntry of scannedProgress) {
      const progress = progressEntry;
      if (!progress || progress.externalLinkRelativePath) continue;
      if (typeof progress.folderPath !== 'string' || !path.isAbsolute(progress.folderPath)) continue;
      const candidate = path.resolve(progress.folderPath); if (!insideOrEqual(path, scope.scopeRoot, candidate)) continue;
      const declaredMissing = progress.folderMissing === true;
      if (declaredMissing && payload.includeMissing !== true) continue;
      const stat = await fs.promises.lstat(candidate).catch(() => null); const canonical = await fs.promises.realpath(candidate).catch(() => null);
      const existingSafe = stat?.isDirectory() && !stat.isSymbolicLink() && canonical && insideOrEqual(path, scope.canonicalScopeRoot, canonical);
      if (!existingSafe && !(declaredMissing && payload.includeMissing === true && await safeMissingAncestor(candidate))) continue;
      visibleProgress.push(publicProgress(progress));
    }
    const progressOverflow = visibleProgress.length > MAX_PROGRESS_ITEMS; const progress = visibleProgress.slice(0, MAX_PROGRESS_ITEMS);
    const nodeIds = new Set(progress.map(item => item.id));
    const visibleEdgeRows = (listed.graphEdges || listed.edges || []).filter(edge => nodeIds.has(String(edge.sourceProgressId || edge.sourceId || '')) && nodeIds.has(String(edge.targetProgressId || edge.targetId || '')));
    const edgeOverflow = visibleEdgeRows.length > MAX_PROGRESS_EDGES; const progressEdges = visibleEdgeRows.slice(0, MAX_PROGRESS_EDGES).map(edge => ({
      sourceId: boundedString(edge.sourceProgressId || edge.sourceId, 128), targetId: boundedString(edge.targetProgressId || edge.targetId, 128), kind: boundedString(edge.kind || edge.relationKind || 'source', 40),
    }));
    const versionIds = new Set(versions.items.map(item => item.id));
    const versionEdges = versions.items.filter(item => item.parentVersionId && versionIds.has(item.parentVersionId)).map(item => ({ sourceId: item.parentVersionId, targetId: item.id, kind: 'parent' }));
    return { progress, versions: versions.items, edges: [...progressEdges, ...versionEdges], truncated: versions.truncated || allProgress.length > MAX_PROGRESS_SCAN || progressOverflow || edgeOverflow };
  });

  broker.register('project.media.ratings', async (payload, context, descriptor) => {
    assertObjectFields(payload, ['mediaRefs'], ['mediaRefs']);
    const scope = await bound(context, descriptor);
    if (!Array.isArray(payload.mediaRefs) || !payload.mediaRefs.length || payload.mediaRefs.length > 100) throw hostError(CODES.INVALID_REQUEST, 'mediaRefs must contain 1 to 100 items');
    const seen = new Set();
    const items = [];
    for (const ref of payload.mediaRefs) {
      assertObjectFields(ref, ['relativePath'], ['relativePath']); const relative = assertRelative(path, ref.relativePath);
      if (seen.has(relative)) throw hostError(CODES.INVALID_REQUEST, 'mediaRefs must not contain duplicates'); seen.add(relative);
      const media = await resolveFile(scope, ref?.relativePath, { mediaOnly: true });
      let rating = null;
      if (media.kind !== 'video') {
        try { rating = await mediaRatingService.read(media.filePath, media.stat.mtimeMs); }
        catch { throw hostError(CODES.INTERNAL, 'Media rating could not be read'); }
      }
      items.push({ mediaRef: { relativePath: media.relativePath }, revision: media.stat.mtimeMs, rating, labels: null, selectionState: null });
    }
    return { supported: { rating: true, labels: false, selectionState: false }, items };
  });
};

const resetComponentProjectReadCapabilityStateForTest = () => cursors.clear();

module.exports = { MAX_PAGE_SIZE, MAX_SCAN_ENTRIES, MAX_PROGRESS_SCAN, MAX_PROGRESS_ITEMS, registerComponentProjectReadCapabilities, resetComponentProjectReadCapabilityStateForTest };
