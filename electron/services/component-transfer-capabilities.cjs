const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
const { exact } = require('./component-file-resources.cjs');
const CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const TTL = 10 * 60 * 1000;

// The service protocol remains bounded JSON. Transfer handles provide backpressure,
// bounded memory and replayable offsets without granting renderer filesystem paths.
const registerComponentTransferCapabilities = ({ broker, projectDomain, fileResources, fs, path, crypto, getWorkspaceDataRoot, now = Date.now }) => {
  const transfers = new Map();
  const close = async item => {
    clearTimeout(item.timer);
    await item.handle?.close(); item.handle = null;
    if (item.reservationId) { await projectDomain.commitReservation(item.reservationId); item.reservationId = null; }
    if (item.directory) await fs.promises.rm(item.directory, { recursive: true, force: true });
    transfers.delete(item.transferId);
  };
  const touch = item => {
    clearTimeout(item.timer); item.expiresAt = now() + TTL;
    item.timer = setTimeout(() => { if (item.busy) touch(item); else void close(item).catch(() => touch(item)); }, TTL); item.timer.unref?.();
  };
  broker.register('component.transfer', async (payload, context, descriptor) => {
    const scope = await fileResources.bound(context, descriptor);
    if (payload.action === 'create' || payload.action === 'openInput') {
      exact(payload, payload.action === 'create' ? ['action', 'name', 'byteLength'] : ['action', 'token'], payload.action === 'create' ? ['name', 'byteLength'] : ['token']);
      if (transfers.size >= 64 || [...transfers.values()].filter(item => item.componentId === descriptor.componentId).length >= 8) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many transfers');
      const item = { transferId: crypto.randomUUID(), componentId: descriptor.componentId, key: scope.key, mode: payload.action === 'create' ? 'write' : 'read', offset: 0, busy: true };
      transfers.set(item.transferId, item);
      try {
        if (item.mode === 'write') {
          if (typeof payload.name !== 'string' || !/^[^\\/:*?"<>|\x00-\x1f]{1,160}$/.test(payload.name) || payload.name === '.' || payload.name === '..' || /[. ]$/.test(payload.name) || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 0 || payload.byteLength > MAX_BYTES) throw hostError(CODES.INVALID_REQUEST, 'Invalid transfer name or size');
          if ([...transfers.values()].filter(value => value.componentId === descriptor.componentId && value.mode === 'write').reduce((sum, value) => sum + (value.byteLength || 0), payload.byteLength) > MAX_BYTES) throw hostError(CODES.LIMIT_EXCEEDED, 'Transfer storage budget exceeded');
          item.byteLength = payload.byteLength;
          item.directory = path.join(getWorkspaceDataRoot(scope.workspace), 'components', descriptor.componentId, 'transfers', item.transferId);
          await fs.promises.mkdir(item.directory, { recursive: true });
          item.filePath = path.join(item.directory, payload.name);
          item.handle = await fs.promises.open(item.filePath, 'wx+');
        } else {
          item.reservationId = `transfer:${item.transferId}`;
          const [snapshot] = await projectDomain.reserveInputs([payload.token], descriptor, context, item.reservationId);
          item.filePath = snapshot.filePath;
          item.handle = await fs.promises.open(item.filePath, 'r');
          const stat = await item.handle.stat();
          if (!stat.isFile()) throw hostError(CODES.INVALID_REQUEST, 'Transfer input must be a file');
          item.byteLength = stat.size;
        }
        touch(item);
        return { transferId: item.transferId, byteLength: item.byteLength, chunkBytes: CHUNK_BYTES, expiresAt: item.expiresAt };
      } catch (error) { await close(item); throw error; } finally { item.busy = false; }
    }
    const fields = { read: ['offset', 'byteLength'], write: ['offset', 'base64'], finish: ['expectedDigest'], close: [] }[payload.action];
    if (!fields) throw hostError(CODES.INVALID_REQUEST, 'Unknown transfer action');
    exact(payload, ['action', 'transferId', ...fields], ['transferId', ...fields]);
    const item = transfers.get(payload.transferId);
    if (!item || item.key !== scope.key || item.expiresAt <= now()) throw hostError(CODES.TOKEN_EXPIRED, 'Transfer expired or belongs to another scope');
    if (item.busy) throw hostError(CODES.CONFLICT, 'Transfer already has an active operation');
    item.busy = true;
    try {
      if (payload.action === 'close') { await close(item); return { closed: true }; }
      touch(item);
      if (payload.action === 'read') {
        if (item.mode !== 'read' || !Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > item.byteLength || !Number.isInteger(payload.byteLength) || payload.byteLength < 1 || payload.byteLength > CHUNK_BYTES) throw hostError(CODES.INVALID_REQUEST, 'Invalid transfer range');
        const buffer = Buffer.alloc(Math.min(payload.byteLength, item.byteLength - payload.offset));
        const { bytesRead } = await item.handle.read(buffer, 0, buffer.length, payload.offset);
        if (bytesRead !== buffer.length) throw hostError(CODES.CONFLICT, 'Transfer input was truncated');
        return { offset: payload.offset, nextOffset: payload.offset + bytesRead, base64: buffer.subarray(0, bytesRead).toString('base64'), eof: payload.offset + bytesRead === item.byteLength };
      }
      if (item.mode !== 'write') throw hostError(CODES.INVALID_REQUEST, 'Transfer is read-only');
      if (payload.action === 'write') {
        if (item.result) throw hostError(CODES.CONFLICT, 'Transfer is already finished');
        if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || typeof payload.base64 !== 'string' || payload.base64.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw hostError(CODES.INVALID_REQUEST, 'Invalid transfer chunk');
        const bytes = Buffer.from(payload.base64, 'base64');
        if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString('base64') !== payload.base64 || payload.offset + bytes.length > item.byteLength) throw hostError(CODES.INVALID_REQUEST, 'Invalid transfer chunk');
        if (payload.offset < item.offset) {
          const old = Buffer.alloc(bytes.length); const read = await item.handle.read(old, 0, old.length, payload.offset);
          if (payload.offset + bytes.length > item.offset || read.bytesRead !== bytes.length || !old.equals(bytes)) throw hostError(CODES.CONFLICT, 'Replayed chunk differs');
        } else {
          if (payload.offset !== item.offset) throw hostError(CODES.CONFLICT, 'Transfer chunks must be sequential');
          let written = 0;
          while (written < bytes.length) { const result = await item.handle.write(bytes, written, bytes.length - written, item.offset + written); if (!result.bytesWritten) throw hostError(CODES.INTERNAL, 'Transfer write made no progress'); written += result.bytesWritten; }
          item.offset += written;
        }
        return { nextOffset: item.offset };
      }
      if (typeof payload.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(payload.expectedDigest)) throw hostError(CODES.INVALID_REQUEST, 'A SHA-256 digest is required');
      if (item.result) { if (item.result.sha256 !== payload.expectedDigest) throw hostError(CODES.CONFLICT, 'Transfer digest differs'); return item.result; }
      if (item.offset !== item.byteLength) throw hostError(CODES.CONFLICT, 'Transfer is incomplete');
      await item.handle.sync();
      const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(item.filePath)) hash.update(chunk);
      const sha256 = hash.digest('hex');
      if (sha256 !== payload.expectedDigest) throw hostError(CODES.CONFLICT, 'Transfer digest differs');
      const input = projectDomain.grantVerifiedFile(item.filePath, descriptor, context, item.directory, sha256);
      // Snapshot before close so the returned one-time token survives transfer cleanup.
      await projectDomain.peekInput(input.token, descriptor, context);
      item.result = { input, byteLength: item.byteLength, sha256 };
      return item.result;
    } finally { item.busy = false; }
  });
  return { clearComponent: async componentId => { for (const item of transfers.values()) if (item.componentId === componentId) await close(item); } };
};
module.exports = { registerComponentTransferCapabilities, CHUNK_BYTES, MAX_BYTES };
