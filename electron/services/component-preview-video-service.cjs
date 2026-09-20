const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
const { exact } = require('./component-file-resources.cjs');

// This accepts media containers, not arbitrary plugin URLs or project paths.
async function validatePreviewVideo(fs, filePath) {
  const file = await fs.promises.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 24 || stat.size > 256 * 1024 * 1024) throw hostError(CODES.LIMIT_EXCEEDED, 'Preview video exceeds the size limit');
    let offset = 0, boxes = 0, movie = false, data = false;
    const header = Buffer.alloc(16);
    while (offset < stat.size && boxes++ < 4096) {
      const { bytesRead } = await file.read(header, 0, Math.min(16, stat.size - offset), offset);
      if (bytesRead < 8) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview video container');
      let size = header.readUInt32BE(0); const type = header.toString('ascii', 4, 8);
      if (size === 1) {
        if (bytesRead < 16 || header.readBigUInt64BE(8) > BigInt(stat.size)) throw hostError(CODES.INVALID_REQUEST, 'Invalid video box size');
        size = Number(header.readBigUInt64BE(8));
        if (size < 16) throw hostError(CODES.INVALID_REQUEST, 'Invalid video box size');
      } else if (!size) size = stat.size - offset;
      if (size < 8 || offset + size > stat.size) throw hostError(CODES.INVALID_REQUEST, 'Invalid video box size');
      movie ||= type === 'moov'; data ||= type === 'mdat'; offset += size;
    }
    if (offset !== stat.size || !movie || !data) throw hostError(CODES.INVALID_REQUEST, 'Preview must contain a MOV or MP4 movie');
  } finally { await file.close(); }
}

function createPreviewVideoService({ dependencies, projectDomain }) {
  const { crypto, mediaService, getVideoPlaybackService } = dependencies;
  const leases = new Map(); const pending = new Map(); const owners = new Set();
  const requestKey = (owner, id) => `${owner.id}:${id}`;
  const requestId = id => { if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id)) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview request identity'); };
  const track = owner => {
    if (owners.has(owner.id)) return;
    owners.add(owner.id);
    owner.once('destroyed', () => { owners.delete(owner.id); void clear(item => item.owner.id === owner.id).catch(() => undefined); });
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) void clear(item => item.owner.id === owner.id).catch(() => undefined); });
  };
  const release = async item => {
    if (!item) return;
    if (item.releasing) return item.releasing;
    item.closed = true; clearTimeout(item.timer);
    item.releasing = (async () => {
      // Revoke new reads, then drain in-flight starts before deleting the snapshot.
      for (const token of item.tokens) await mediaService.revokeToken(token);
      await Promise.allSettled([...item.starts]);
      for (const id of item.sessions) await getVideoPlaybackService()?.stop(id, item.owner.id);
      if (item.exits.size) {
        let timer;
        try { await Promise.race([Promise.all([...item.exits]), new Promise((_, reject) => { timer = setTimeout(() => reject(hostError(CODES.TIMEOUT, 'Preview player has not exited')), 5000); })]); }
        finally { clearTimeout(timer); }
      }
      await projectDomain.commitReservation(item.reservation);
      leases.delete(item.id);
      if (!item.owner.isDestroyed()) item.owner.send('component-preview:released', { previewId: item.id });
    })();
    try { await item.releasing; }
    catch (error) { item.releasing = null; item.timer = setTimeout(() => { void release(item).catch(() => undefined); }, 1000); item.timer.unref?.(); throw error; }
  };
  const touch = item => { clearTimeout(item.timer); item.timer = setTimeout(() => { void release(item).catch(() => undefined); }, 120000); item.timer.unref?.(); };
  const clear = async predicate => {
    for (const item of pending.values()) if (predicate(item)) item.cancelled = true;
    await Promise.all([...leases.values()].filter(predicate).map(release));
  };
  const begin = (owner, id, componentId, context) => {
    requestId(id); track(owner);
    const key = requestKey(owner, id);
    if (pending.has(key)) throw hostError(CODES.CONFLICT, 'Preview request already exists');
    const item = { owner, requestId: id, componentId, context, cancelled: false };
    pending.set(key, item); return item;
  };
  const check = operation => { if (operation && (operation.cancelled || operation.owner.isDestroyed())) throw hostError(CODES.CANCELLED, 'Preview was closed'); };
  const adopt = ({ operation, descriptor, manager, filePath, reservation, mimeType }) => {
    check(operation);
    if (!operation || leases.size >= 64) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many dynamic previews');
    const item = { ...operation, id: crypto.randomUUID(), descriptor, manager, filePath, reservation, mimeType, tokens: new Set(), sessions: new Set(), starts: new Set(), exits: new Set(), closed: false };
    leases.set(item.id, item); touch(item); return item.id;
  };
  const cancel = async (owner, id) => { requestId(id); const item = pending.get(requestKey(owner, id)); if (item) item.cancelled = true; await clear(value => value.owner.id === owner.id && value.requestId === id); };
  const invoke = async (owner, payload) => {
    exact(payload, ['previewId', 'action', 'browserProbe', 'settings', 'playerId', 'requestId', 'backendId'], ['previewId', 'action']);
    const item = leases.get(payload.previewId);
    if (!item || item.owner.id !== owner.id || item.closed) throw hostError(CODES.TOKEN_SCOPE, 'Dynamic preview is unavailable or belongs to another window');
    if (payload.action === 'release') { await release(item); return { success: true }; }
    if (!['source', 'backends', 'start', 'keepalive'].includes(payload.action)) throw hostError(CODES.INVALID_REQUEST, 'Unknown dynamic preview action');
    const descriptor = item.manager.registry.resolve(item.componentId);
    if (!descriptor || descriptor.componentVersion !== item.descriptor.componentVersion) { await release(item); throw hostError(CODES.NOT_FOUND, 'Preview component is unavailable'); }
    item.manager.resolveOpenContext(item.context); touch(item);
    if (payload.action === 'keepalive') return { success: true };
    const service = getVideoPlaybackService();
    if (service.sessions) for (const id of item.sessions) if (!service.sessions.has(id)) item.sessions.delete(id);
    if (payload.action === 'backends') return { success: true, backends: await service.describeBackends(item.filePath, ['probably', 'maybe'].includes(payload.browserProbe) ? payload.browserProbe : 'unknown') };
    if (payload.action === 'source' && item.sourceToken) return { success: true, mediaUrl: `photoflow-media://file/${item.sourceToken}` };
    if (payload.action === 'start' && (item.starts.size || item.sessions.size >= 8)) throw hostError(CODES.CONFLICT, 'Too many playback starts for this preview');
    const token = payload.action === 'start' && item.nativeToken || mediaService.grantPath(item.filePath); item.tokens.add(token);
    if (payload.action === 'start') item.nativeToken = token;
    if (payload.action === 'source') { item.sourceToken = token; return { success: true, mediaUrl: `photoflow-media://file/${token}` }; }
    const start = (async () => {
      const result = await service.start({ sender: owner }, `media-token:${token}`, payload.settings, payload.playerId, payload.requestId, payload.backendId);
      const child = service.sessions?.get(result.sessionId)?.child;
      if (child && child.exitCode == null && child.signalCode == null) {
        const exit = new Promise(resolve => { child.once('exit', resolve); child.once('close', resolve); });
        item.exits.add(exit); void exit.then(() => item.exits.delete(exit));
      }
      if (item.closed) { await service.stop(result.sessionId, owner.id); throw hostError(CODES.CANCELLED, 'Preview was closed'); }
      item.sessions.add(result.sessionId); return { success: true, ...result };
    })();
    item.starts.add(start);
    try { return await start; } finally { item.starts.delete(start); }
  };
  return { begin, check, adopt, cancel, invoke, finish: operation => { if (operation) pending.delete(requestKey(operation.owner, operation.requestId)); }, clearComponent: id => clear(item => item.componentId === id), clearProject: (owner, workspace, projectId) => clear(item => item.owner.id === owner.id && item.context.workspacePath === workspace && item.context.projectId === projectId) };
}
module.exports = { createPreviewVideoService, validatePreviewVideo };
