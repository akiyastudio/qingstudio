const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const physicalPathKey = filePath => {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
};

const statNanoseconds = (stat, field, millisecondsField) => {
  const value = stat?.[field];
  if (typeof value === 'bigint') return value.toString();
  const milliseconds = Number(stat?.[millisecondsField]);
  return Number.isFinite(milliseconds) ? String(Math.trunc(milliseconds * 1e6)) : '';
};

const identityFromStat = (filePath, stat) => {
  const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink?.() ? 'symlink' : 'other';
  const mtimeNs = statNanoseconds(stat, 'mtimeNs', 'mtimeMs');
  const ctimeNs = statNanoseconds(stat, 'ctimeNs', 'ctimeMs');
  return {
    path: path.resolve(filePath),
    device: stat.dev === undefined || stat.dev === null ? '0' : String(stat.dev),
    inode: stat.ino === undefined || stat.ino === null ? '0' : String(stat.ino),
    kind,
    size: String(stat.size),
    mtimeNs,
    ctimeNs,
    modifiedNs: mtimeNs,
    changedNs: ctimeNs,
    directory: kind === 'directory',
  };
};

const digestFile = async filePath => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

const capturePathIdentity = async (filePath, options = {}) => {
  const stat = await fs.promises.lstat(filePath, { bigint: true });
  const identity = identityFromStat(filePath, stat);
  if (options.digest === true && identity.kind === 'file') identity.sha256 = await digestFile(filePath);
  return identity;
};

const hasDestructiveIdentity = expected => Boolean(expected
  && typeof expected.kind === 'string'
  && typeof expected.size === 'string'
  && typeof expected.mtimeNs === 'string'
  && typeof expected.ctimeNs === 'string');

const isLegacyIdentity = expected => Boolean(expected && !hasDestructiveIdentity(expected));

const identitiesMatch = (current, expected, options = {}) => {
  if (!expected) return false;
  if (options.destructive === true && !hasDestructiveIdentity(expected)) return false;
  const expectedKind = expected.kind || (expected.directory === true ? 'directory' : 'file');
  const stableNativeIdentity = expected.device !== '0' && expected.inode !== '0' && current.device !== '0' && current.inode !== '0';
  if (stableNativeIdentity && (current.device !== expected.device || current.inode !== expected.inode)) return false;
  if (current.kind !== expectedKind || current.size !== String(expected.size)) return false;
  const expectedMtimeNs = expected.mtimeNs ?? expected.modifiedNs;
  const expectedCtimeNs = expected.ctimeNs ?? expected.changedNs;
  if (expectedMtimeNs !== undefined && current.mtimeNs !== String(expectedMtimeNs)) return false;
  if (expectedCtimeNs !== undefined && current.ctimeNs !== String(expectedCtimeNs)) return false;
  return !expected.sha256 || current.sha256 === expected.sha256;
};

const samePathIdentity = async (filePath, expected, options = {}) => {
  if (!expected || options.destructive === true && !hasDestructiveIdentity(expected)) return false;
  try {
    const current = await capturePathIdentity(filePath, { digest: Boolean(expected.sha256) });
    return identitiesMatch(current, expected, options);
  } catch { return false; }
};

const addUndoIdentities = async operation => {
  const candidates = operation.kind === 'remove-created'
    ? operation.paths || []
    : operation.kind === 'project' || operation.kind === 'folder'
      ? [operation.destination]
      : ['files', 'move', 'external-move', 'paste-replace'].includes(operation.kind)
        ? (operation.moves || []).map(move => move.destination)
        : operation.kind === 'broll-import'
          ? [...(operation.createdPaths || []), ...(operation.moves || []).map(move => move.destination)]
          : [];
  const identities = { ...(operation.identities || {}) };
  const capturedPaths = new Set(Object.keys(identities).map(physicalPathKey));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const key = physicalPathKey(resolved);
    if (capturedPaths.has(key)) continue;
    try { identities[resolved] = await capturePathIdentity(resolved); capturedPaths.add(key); }
    catch { /* the undo handler will reject missing targets */ }
  }
  return { ...operation, identities };
};

const assertUndoIdentity = async (operation, filePath) => {
  const resolved = path.resolve(filePath);
  const expected = operation.identities?.[resolved] || operation.identities?.[physicalPathKey(resolved)]
    || Object.entries(operation.identities || {}).find(([candidate]) => physicalPathKey(candidate) === physicalPathKey(resolved))?.[1];
  if (isLegacyIdentity(expected)) {
    const error = new Error(`“${path.basename(resolved)}”的旧版撤销身份缺少安全删除所需字段，无法破坏性撤销`);
    error.code = 'LEGACY_UNDO_UNSAFE';
    throw error;
  }
  if (!await samePathIdentity(resolved, expected, { destructive: true })) {
    const error = new Error(`“${path.basename(resolved)}”已被替换或修改，无法安全撤销`);
    error.code = 'UNDO_IDENTITY_MISMATCH';
    throw error;
  }
};

module.exports = {
  physicalPathKey,
  identityFromStat,
  capturePathIdentity,
  samePathIdentity,
  identitiesMatch,
  isLegacyIdentity,
  addUndoIdentities,
  assertUndoIdentity,
};
