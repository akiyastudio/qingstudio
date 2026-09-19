const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const verifiedHandleTickets = new Map();
const VERIFIED_HANDLE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const verifiedHandleKey = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
const createDescriptorHandle = descriptor => {
  let closed = false;
  return {
    stat: () => new Promise((resolve, reject) => fs.fstat(descriptor, (error, stat) => error ? reject(error) : resolve(stat))),
    read: (buffer, offset, length, position) => new Promise((resolve, reject) => fs.read(descriptor, buffer, offset, length, position, (error, bytesRead) => error ? reject(error) : resolve({ bytesRead, buffer }))),
    close: () => new Promise(resolve => {
      if (closed) { resolve(); return; }
      closed = true;
      fs.close(descriptor, () => resolve());
    }),
  };
};
const registerVerifiedHandle = (token, filePath, identity, handle) => {
  const previous = verifiedHandleTickets.get(token);
  if (previous) {
    clearTimeout(previous.timer);
    void previous.handle.close();
  }
  const ticket = { expectedPath: verifiedHandleKey(filePath), identity, handle, timer: null };
  ticket.timer = setTimeout(() => {
    if (verifiedHandleTickets.get(token) === ticket) verifiedHandleTickets.delete(token);
    void handle.close();
  }, 5000);
  ticket.timer.unref?.();
  verifiedHandleTickets.set(token, ticket);
};
const detachVerifiedHandleTicket = (token, filePath) => {
  if (typeof token !== 'string' || !VERIFIED_HANDLE_TOKEN_PATTERN.test(token)) return null;
  const ticket = verifiedHandleTickets.get(token);
  if (!ticket) return null;
  verifiedHandleTickets.delete(token);
  clearTimeout(ticket.timer);
  if (filePath !== undefined) {
    let matchesExpectedPath = false;
    try {
      matchesExpectedPath = typeof filePath === 'string' && Boolean(filePath) && ticket.expectedPath === verifiedHandleKey(filePath);
    } catch { /* invalid paths consume and close the bearer ticket */ }
    if (!matchesExpectedPath) {
      void ticket.handle.close();
      return null;
    }
  }
  return ticket;
};
const takeVerifiedMediaHandle = (token, filePath) => {
  const ticket = detachVerifiedHandleTicket(token, filePath);
  return ticket?.handle || null;
};
const discardVerifiedMediaHandle = async (token, filePath) => {
  const ticket = detachVerifiedHandleTicket(token, filePath);
  if (!ticket) return false;
  await ticket.handle.close().catch(() => undefined);
  return true;
};

const createMediaAccessService = ({ getWorkspaceRoots, getAdditionalRoots = () => [] }) => {
  const grants = new Map();
  const rootGrants = new Map();
  const TOKEN_TTL_MS = 60 * 60 * 1000;
  const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);

  const isInside = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  const requirePath = value => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('媒体路径不能为空');
    return value;
  };
  const realExistingPath = async value => fs.promises.realpath(path.resolve(requirePath(value)));
  const captureGrant = value => {
    const canonicalPath = fs.realpathSync(path.resolve(requirePath(value)));
    const stat = fs.statSync(canonicalPath, { bigint: true });
    return { path: canonicalPath, identity: { device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(), modifiedNs: stat.mtimeNs.toString(), directory: stat.isDirectory() }, expiresAt: Date.now() + TOKEN_TTL_MS };
  };
  const verifyGrant = grant => {
    try {
      const canonicalPath = fs.realpathSync(grant.path);
      const stat = fs.statSync(canonicalPath, { bigint: true });
      const identity = grant.identity;
      const sameIdentity = identity.device !== '0' && identity.inode !== '0' && stat.dev !== 0n && stat.ino !== 0n
        ? identity.device === stat.dev.toString() && identity.inode === stat.ino.toString() && identity.directory === stat.isDirectory()
        : identity.size === stat.size.toString() && identity.modifiedNs === stat.mtimeNs.toString() && identity.directory === stat.isDirectory();
      return pathKey(canonicalPath) === pathKey(grant.path) && sameIdentity ? canonicalPath : null;
    } catch { return null; }
  };
  const openVerifiedGrant = grant => {
    let descriptor;
    try {
      descriptor = fs.openSync(grant.path, 'r');
      const stat = fs.fstatSync(descriptor, { bigint: true });
      const identity = grant.identity;
      const sameIdentity = identity.device !== '0' && identity.inode !== '0' && stat.dev !== 0n && stat.ino !== 0n
        ? identity.device === stat.dev.toString() && identity.inode === stat.ino.toString() && identity.directory === stat.isDirectory()
        : identity.size === stat.size.toString() && identity.modifiedNs === stat.mtimeNs.toString() && identity.directory === stat.isDirectory();
      if (!sameIdentity) return null;
      const handle = createDescriptorHandle(descriptor);
      descriptor = undefined;
      return handle;
    } catch { return null; }
    finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {} }
  };

  const authorizeInput = async value => {
    if (typeof value === 'string' && value.startsWith('media-token:')) {
      const token = value.slice('media-token:'.length);
      const grant = grants.get(token);
      if (!grant || grant.expiresAt < Date.now()) {
        grants.delete(token);
        throw new Error('媒体访问授权已失效');
      }
      const verified = verifyGrant(grant);
      if (!verified) {
        grants.delete(token);
        throw new Error('媒体访问授权目标已发生变化');
      }
      grant.expiresAt = Date.now() + TOKEN_TTL_MS;
      return verified;
    }
    const candidate = await realExistingPath(value);
    const now = Date.now();
    for (const [root, expiresAt] of rootGrants) if (expiresAt < now) rootGrants.delete(root);
    const roots = [...getWorkspaceRoots(), ...getAdditionalRoots(), ...rootGrants.keys()].filter(Boolean);
    for (const rootValue of roots) {
      try {
        const root = await fs.promises.realpath(path.resolve(rootValue));
        if (isInside(root, candidate)) return candidate;
      } catch { /* unavailable roots do not grant access */ }
    }
    throw new Error('媒体文件不在已授权的工作区或缓存目录中');
  };

  const authorizeWorkspaceInput = async (workspaceRoot, value) => {
    const candidate = await authorizeInput(value);
    const canonicalWorkspace = await realExistingPath(workspaceRoot);
    if (isInside(canonicalWorkspace, candidate)) return candidate;
    for (const rootValue of getWorkspaceRoots().filter(Boolean)) {
      try {
        const otherWorkspace = await realExistingPath(rootValue);
        if (pathKey(otherWorkspace) !== pathKey(canonicalWorkspace) && isInside(otherWorkspace, candidate)) {
          throw new Error('媒体文件属于其他工作区');
        }
      } catch (error) {
        if (error?.message === '媒体文件属于其他工作区') throw error;
      }
    }
    // authorizeInput already proved this is an explicitly granted external
    // path. Workspace catalog provenance is unavailable at this layer, so do
    // not reject a legitimate managed external link merely for being outside.
    return candidate;
  };

  const grantRoot = value => {
    const root = fs.realpathSync(path.resolve(requirePath(value)));
    rootGrants.set(root, Date.now() + TOKEN_TTL_MS);
    while (rootGrants.size > 64) rootGrants.delete(rootGrants.keys().next().value);
    return root;
  };

  const grantPath = value => {
    const grant = captureGrant(value);
    const token = crypto.randomBytes(24).toString('base64url');
    grants.set(token, grant);
    if (grants.size > 5000) {
      const now = Date.now();
      for (const [key, grant] of grants) if (grant.expiresAt < now) grants.delete(key);
      while (grants.size > 5000) grants.delete(grants.keys().next().value);
    }
    return token;
  };

  const resolveToken = token => {
    const grant = grants.get(token);
    if (!grant || grant.expiresAt < Date.now()) {
      grants.delete(token);
      void discardVerifiedMediaHandle(token);
      return null;
    }
    const handle = openVerifiedGrant(grant);
    if (!handle) {
      grants.delete(token);
      void discardVerifiedMediaHandle(token);
      return null;
    }
    grant.expiresAt = Date.now() + TOKEN_TTL_MS;
    registerVerifiedHandle(token, grant.path, grant.identity, handle);
    return grant.path;
  };

  return { authorizeInput, authorizeWorkspaceInput, grantRoot, grantPath, resolveToken };
};

module.exports = { createMediaAccessService, discardVerifiedMediaHandle, takeVerifiedMediaHandle };
