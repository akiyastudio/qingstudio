const TOKEN = /^[a-zA-Z0-9_-]{16,160}$/;
const SESSION = /^[a-zA-Z0-9_-]{8,96}$/;

const createMediaInputSessionService = ({ crypto, fs, path, authorizeProjectMedia, clock = Date.now, ttlMs = 60_000, pendingTtlMs = ttlMs, maxPending = 128, maxGrants = 256 }) => {
  const grants = new Map(); const pending = new Map();
  const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const sweep = () => {
    const now = clock();
    for (const [token, grant] of grants) if (grant.expiresAt <= now) grants.delete(token);
    for (const [id, value] of pending) if (value.expiresAt <= now) pending.delete(id);
  };
  const prepare = async ({ filePath, componentId, backendId, sessionId }) => {
    sweep();
    if (!SESSION.test(String(sessionId || '')) || !String(componentId || '') || !String(backendId || '') || pending.has(sessionId)) throw new Error('媒体输入会话准备无效');
    if (pending.size >= maxPending) throw new Error('媒体输入会话准备容量已满');
    const authorizedPath = path.resolve(await authorizeProjectMedia(filePath)); const stat = await fs.promises.stat(authorizedPath);
    if (!stat.isFile()) throw new Error('playback input must be one project media file');
    sweep();
    if (pending.has(sessionId) || pending.size >= maxPending) throw new Error('媒体输入会话准备容量已满或重复');
    const preparedAt = clock();
    const value = { sessionId, componentId: String(componentId), backendId: String(backendId), authorizedPath, identity: identity(stat), size: stat.size, preparedAt, expiresAt: preparedAt + pendingTtlMs };
    pending.set(sessionId, value); return Object.freeze({ sessionId, byteLength: stat.size });
  };
  const bindProcess = ({ sessionId, componentId, backendId, processId }) => {
    sweep();
    const value = pending.get(String(sessionId || '')); const pid = Number(processId);
    if (!value || value.componentId !== String(componentId) || value.backendId !== String(backendId) || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('媒体输入会话进程绑定无效');
    if (grants.size >= maxGrants) throw new Error('媒体输入授权容量已满');
    pending.delete(sessionId); const token = crypto.randomBytes(32).toString('base64url');
    const grant = { ...value, token, processId: pid, expiresAt: clock() + ttlMs }; grants.set(token, grant);
    return Object.freeze({ token, expiresAt: grant.expiresAt, byteLength: grant.size, access: 'random-read' });
  };
  const create = async request => { await prepare(request); return bindProcess(request); };
  const assertOwner = (grant, owner) => {
    if (!grant || grant.expiresAt <= clock()) throw new Error('playback input authorization expired or revoked');
    if (grant.componentId !== String(owner.componentId) || grant.backendId !== String(owner.backendId) || grant.processId !== Number(owner.processId) || grant.sessionId !== String(owner.sessionId)) throw new Error('playback input authorization owner mismatch');
  };
  const resolve = async (token, owner) => {
    sweep();
    if (!TOKEN.test(String(token || ''))) throw new Error('invalid playback input authorization');
    const grant = grants.get(token); assertOwner(grant, owner); const stat = await fs.promises.stat(grant.authorizedPath).catch(() => null);
    if (!stat?.isFile() || identity(stat) !== grant.identity) { grants.delete(token); throw new Error('authorized playback media changed'); }
    return grant.authorizedPath;
  };
  const open = async (token, owner) => fs.promises.open(await resolve(token, owner), 'r');
  const renew = (token, owner) => { sweep(); const grant = grants.get(String(token || '')); assertOwner(grant, owner); grant.expiresAt = clock() + ttlMs; return Object.freeze({ token, expiresAt: grant.expiresAt }); };
  const revoke = tokenOrSession => { sweep(); const key = String(tokenOrSession || ''); let removed = grants.delete(key); removed = pending.delete(key) || removed; for (const [token, grant] of grants) if (grant.sessionId === key) { grants.delete(token); removed = true; } return removed; };
  const revokeWhere = predicate => { sweep(); let count = 0; for (const [token, grant] of grants) if (predicate(grant)) { grants.delete(token); count += 1; } for (const [id, value] of pending) if (predicate({ ...value, processId: 0 })) { pending.delete(id); count += 1; } return count; };
  const revokePlaybackSession = id => revokeWhere(grant => grant.sessionId === String(id));
  const revokeProcess = id => revokeWhere(grant => grant.processId === Number(id));
  const revokeComponent = id => revokeWhere(grant => grant.componentId === String(id));
  return { create, prepare, bindProcess, resolve, open, renew, revoke, revokePlaybackSession, revokeProcess, revokeComponent, sweep, get size() { sweep(); return grants.size + pending.size; } };
};
module.exports = { createMediaInputSessionService };
