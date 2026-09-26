const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mapBounded } = require('./file-operation-batches.cjs');
const { copyConcurrencyTuner } = require('./copy-concurrency-tuner.cjs');
const { pipeline } = require('stream/promises');
const { createFilePublicationService } = require('./file-publication-service.cjs');
const {
  physicalPathKey,
  identityFromStat,
  capturePathIdentity,
  samePathIdentity,
  identitiesMatch,
} = require('./file-identity-service.cjs');

const CANCELLED_CODE = 'EOPCANCELLED';
const SOURCE_CLEANUP_INCOMPLETE_CODE = 'ESOURCECLEANUP';
const PUBLISH_PARTIAL_CODE = 'EPUBLISHPARTIAL';
const DEFAULT_SMALL_FILE_THRESHOLD = 2 * 1024 * 1024;
const DEFAULT_SMALL_FILE_CONCURRENCY = 8;
const LINK_COPY_FALLBACK_ERRORS = new Set(['EXDEV']);
const MAX_BATCH_MANIFEST_BYTES = 480 * 1024;
const CLEANUP_TREE_BATCH_SIZE = 128;
const CLEANUP_OWNERSHIP_TTL_MS = 6 * 60 * 60 * 1000;
const IMPLICIT_CLEANUP_OWNERSHIP_TTL_MS = 250;
const MAX_CLEANUP_OWNERSHIP_OPERATIONS = 2048;
let configuredNativePublicationService = null;
// The primary key is always the operation token. Paths exist only inside an
// operation snapshot, so overlapping operations can never overwrite owners.
const cleanupOwnershipLedger = new Map();
const cleanupOwnershipPathIndex = new Map();
const cleanupOwnershipQueue = [];
const configureNativePublicationService = service => { configuredNativePublicationService = service || null; };
const bundledNativePublicationService = createFilePublicationService({ app: { isPackaged: false }, projectRoot: path.resolve(__dirname, '..', '..') });
const takeBoundedBatch = (items, start, maxItems, measure) => {
  const batch = []; let bytes = 0;
  while (start + batch.length < items.length && batch.length < maxItems) {
    const item = items[start + batch.length]; const next = measure(item) + 32;
    if (batch.length && bytes + next > MAX_BATCH_MANIFEST_BYTES) break;
    batch.push(item); bytes += next;
  }
  return batch;
};
const forEachDirectoryLayer = async (directories, visit) => {
  const layers = new Map();
  for (const entry of directories) {
    const depth = path.resolve(entry.destination).split(path.sep).length;
    if (!layers.has(depth)) layers.set(depth, []);
    layers.get(depth).push(entry);
  }
  // Parents must exist before children; independent siblings can be created
  // concurrently. mapBounded drains all callbacks before exposing a failure.
  for (const depth of [...layers.keys()].sort((a, b) => a - b)) await mapBounded(layers.get(depth), 8, visit);
};

const attachTransferContext = (error, stage, source, destination) => {
  if (!error || typeof error !== 'object') return error;
  if (!error.transferStage) error.transferStage = stage;
  if (!error.sourcePath && source) error.sourcePath = source;
  if (!error.destinationPath && destination) error.destinationPath = destination;
  return error;
};

const syncTemporaryFile = async (temporary, source, destination) => {
  // FlushFileBuffers on Windows requires a handle opened with write access.
  // Opening with `r` works on Unix but returns EPERM on Windows.
  const temporaryHandle = await fs.promises.open(temporary, 'r+').catch(error => {
    throw attachTransferContext(error, 'sync-temporary', source, destination);
  });
  try {
    await temporaryHandle.sync().catch(error => {
      throw attachTransferContext(error, 'sync-temporary', source, destination);
    });
  } finally {
    await temporaryHandle.close().catch(() => undefined);
  }
};

const cancelledError = () => Object.assign(new Error('文件操作已取消'), { code: CANCELLED_CODE });

const throwIfCancelled = isCancelled => {
  if (isCancelled?.()) throw cancelledError();
};

const isInside = (root, candidate, allowRoot = false) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return (allowRoot && relative === '') || (relative !== '' && !outside);
};

const assertInside = (root, candidate, label = '路径', allowRoot = false) => {
  const resolved = path.resolve(candidate);
  if (!isInside(root, resolved, allowRoot)) throw new Error(`${label}超出允许的目录`);
  return resolved;
};

const assertExistingInside = (root, candidate, label = '路径', allowRoot = false) => {
  const resolvedRoot = fs.realpathSync.native(path.resolve(root));
  const resolvedCandidate = fs.realpathSync.native(path.resolve(candidate));
  if (!isInside(resolvedRoot, resolvedCandidate, allowRoot)) throw new Error(`${label}通过符号链接超出允许的目录`);
  return resolvedCandidate;
};

const assertRegularFile = async filePath => {
  const resolved = path.resolve(filePath);
  const stat = await fs.promises.lstat(resolved);
  if (!stat.isFile()) throw new Error(`不是可导入的普通文件：${path.basename(resolved)}`);
  return { path: resolved, stat };
};

const uniqueDestination = (directory, fileName, reserved = new Set(), isDirectory = false) => {
  const parsed = path.parse(fileName);
  let index = 1;
  let destination = path.join(directory, parsed.base);
  const key = value => process.platform === 'win32' ? value.toLocaleLowerCase() : value;
  while (fs.existsSync(destination) || reserved.has(key(destination))) {
    destination = path.join(directory, isDirectory ? `${parsed.base} (${index++})` : `${parsed.name} (${index++})${parsed.ext}`);
  }
  reserved.add(key(destination));
  return destination;
};

// A directory snapshot avoids one synchronous filesystem probe per candidate
// (and quadratic probing when many sources share a basename). Publication still
// checks for late occupants; this cache is only a name-allocation hint.
const createDestinationAllocator = async directory => {
  const key = name => process.platform === 'win32' ? name.toLocaleLowerCase() : name;
  const occupied = new Set((await fs.promises.readdir(directory)).map(key));
  const nextIndexes = new Map();
  return (fileName, isDirectory = false) => {
    const parsed = path.parse(fileName);
    const cursorKey = `${isDirectory ? 'd' : 'f'}:${key(fileName)}`;
    let index = nextIndexes.get(cursorKey) || 1;
    let candidate = parsed.base;
    while (occupied.has(key(candidate))) candidate = isDirectory ? `${parsed.base} (${index++})` : `${parsed.name} (${index++})${parsed.ext}`;
    occupied.add(key(candidate));
    nextIndexes.set(cursorKey, index);
    return path.join(directory, candidate);
  };
};

const assertDiskSpace = async (directory, requiredBytes) => {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0 || typeof fs.promises.statfs !== 'function') return;
  try {
    const stat = await fs.promises.statfs(directory);
    const available = Number(stat.bavail) * Number(stat.bsize);
    const reserve = Math.max(256 * 1024 * 1024, Math.ceil(requiredBytes * 0.02));
    if (Number.isFinite(available) && available < requiredBytes + reserve) {
      const neededGb = ((requiredBytes + reserve - available) / 1024 ** 3).toFixed(1);
      throw new Error(`目标磁盘空间不足，至少还需要约 ${neededGb} GB`);
    }
  } catch (error) {
    if (/目标磁盘空间不足/.test(error?.message || '')) throw error;
    // Some network filesystems do not implement statfs. The atomic copy still
    // protects the final destination from partial output in that case.
  }
};

const publishedIdentityFromStat = identityFromStat;

const capturePublishedIdentity = async filePath => publishedIdentityFromStat(filePath, await fs.promises.lstat(filePath, { bigint: true }));
const fileDigest = async filePath => {
  const hash = crypto.createHash('sha256');
  const reader = fs.createReadStream(filePath);
  for await (const chunk of reader) hash.update(chunk);
  return hash.digest('hex');
};
const existingRecoveryPaths = candidates => [...new Set((candidates || []).filter(candidate => typeof candidate === 'string' && fs.existsSync(candidate)).map(candidate => path.resolve(candidate)))];
const samePhysicalIdentity = (left, right) => left && right && left.device === right.device && left.inode === right.inode && left.size === right.size && left.modifiedNs === right.modifiedNs && left.directory === right.directory;
const verifyNativeOwnedPath = async (nativeService, candidate, expectedIdentity) => {
  if (!candidate || !expectedIdentity || typeof nativeService?.inspectPath !== 'function' || !fs.existsSync(candidate)) return null;
  try { const before = await capturePublishedIdentity(candidate); const native = await nativeService.inspectPath(candidate); const after = await capturePublishedIdentity(candidate); return native?.success !== false && native?.identity === expectedIdentity && samePhysicalIdentity(before, after) ? { path: path.resolve(candidate), physicalIdentity: after, nativeIdentity: native.identity } : null; }
  catch { return null; }
};

const sourceChangedError = source => Object.assign(new Error(`文件在复制期间发生变化：${path.basename(source)}`), {
  code: 'SOURCE_CHANGED_DURING_COPY',
  sourcePath: source,
  transferStage: 'verify-source',
});

const verifyStableCopiedFile = async (source, temporary, expectedIdentity, copiedSha256 = '') => {
  const beforeDigest = await capturePathIdentity(source);
  if (!identitiesMatch(beforeDigest, expectedIdentity)) throw sourceChangedError(source);
  const [sourceSha256, temporarySha256] = await Promise.all([fileDigest(source), copiedSha256 || fileDigest(temporary)]);
  const afterDigest = await capturePathIdentity(source);
  if (!identitiesMatch(afterDigest, expectedIdentity) || sourceSha256 !== temporarySha256) throw sourceChangedError(source);
  return temporarySha256;
};

const releaseCleanupOwnership = ownershipToken => {
  const token = String(ownershipToken || '');
  const snapshot = cleanupOwnershipLedger.get(token);
  if (snapshot) for (const key of snapshot.paths.keys()) {
    const owners = cleanupOwnershipPathIndex.get(key); owners?.delete(token);
    if (!owners?.size) cleanupOwnershipPathIndex.delete(key);
  }
  cleanupOwnershipLedger.delete(token);
  return snapshot?.paths.size || 0;
};

const pruneCleanupOwnership = () => {
  const cutoff = Date.now() - CLEANUP_OWNERSHIP_TTL_MS;
  let inspected = 0;
  while (cleanupOwnershipQueue.length && inspected < 32) {
    const oldest = cleanupOwnershipQueue[0]; const snapshot = cleanupOwnershipLedger.get(oldest.token);
    if (!snapshot || snapshot.createdAt !== oldest.createdAt) { cleanupOwnershipQueue.shift(); inspected += 1; continue; }
    if (snapshot.createdAt >= cutoff && cleanupOwnershipLedger.size < MAX_CLEANUP_OWNERSHIP_OPERATIONS) break;
    cleanupOwnershipQueue.shift(); releaseCleanupOwnership(oldest.token); inspected += 1;
  }
  while (cleanupOwnershipLedger.size >= MAX_CLEANUP_OWNERSHIP_OPERATIONS && cleanupOwnershipQueue.length) releaseCleanupOwnership(cleanupOwnershipQueue.shift().token);
};

const ownershipTokenForOptions = options => options?.ownershipToken ? String(options.ownershipToken) : `implicit-${crypto.randomUUID()}`;
const finalizeImplicitOwnership = ownershipToken => {
  const token = String(ownershipToken || '');
  if (!token.startsWith('implicit-') || !cleanupOwnershipLedger.has(token)) return;
  const timer = setTimeout(() => releaseCleanupOwnership(token), IMPLICIT_CLEANUP_OWNERSHIP_TTL_MS);
  timer.unref?.();
};

const currentOwnershipMatchesSync = item => {
  try {
    const current = identityFromStat(item.path, fs.lstatSync(item.path, { bigint: true }));
    if (item.identity.kind === 'directory') return directoryOwnershipMatches(current, item.identity);
    if (item.identity.sha256 && current.kind === 'file') current.sha256 = crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex');
    if (!identitiesMatch(current, item.identity, { destructive: true })) return false;
    return true;
  } catch { return false; }
};

const rememberCleanupOwnership = (target, publishedIdentity, ownershipToken) => {
  if (!publishedIdentity) return;
  pruneCleanupOwnership();
  const token = String(ownershipToken || crypto.randomUUID());
  const key = physicalPathKey(target);
  for (const existingToken of [...(cleanupOwnershipPathIndex.get(key) || [])]) {
    const snapshot = cleanupOwnershipLedger.get(existingToken);
    if (!snapshot) continue;
    const existing = snapshot.paths.get(key);
    if (existing && !currentOwnershipMatchesSync(existing)) {
      snapshot.paths.delete(key);
      if (!snapshot.paths.size) releaseCleanupOwnership(existingToken);
    }
  }
  if (!cleanupOwnershipLedger.has(token)) {
    const createdAt = Date.now(); cleanupOwnershipLedger.set(token, { createdAt, paths: new Map() }); cleanupOwnershipQueue.push({ token, createdAt });
  }
  cleanupOwnershipLedger.get(token).paths.set(key, { path: path.resolve(target), identity: publishedIdentity, ownershipToken: token });
  if (!cleanupOwnershipPathIndex.has(key)) cleanupOwnershipPathIndex.set(key, new Set());
  cleanupOwnershipPathIndex.get(key).add(token);
  return token;
};

const rebaseCleanupOwnership = async (ownershipToken, fromRoot, toRoot, options = {}) => {
  const token = String(ownershipToken || '');
  const snapshot = cleanupOwnershipLedger.get(token);
  const sourceRoot = path.resolve(fromRoot);
  const targetRoot = path.resolve(toRoot);
  if (!snapshot?.paths.size || physicalPathKey(sourceRoot) === physicalPathKey(targetRoot)) return { success: false, code: 'CLEANUP_REBASE_INVALID' };
  const sourceRootItem = snapshot.paths.get(physicalPathKey(sourceRoot));
  if (!sourceRootItem || sourceRootItem.identity?.kind !== 'directory') return { success: false, code: 'CLEANUP_REBASE_ROOT_UNOWNED', path: sourceRoot };
  if (options.publishedRootIdentity && !directoryOwnershipMatches(options.publishedRootIdentity, sourceRootItem.identity)) return { success: false, code: 'CLEANUP_REBASE_ROOT_IDENTITY_CONFLICT', path: targetRoot };
  const rebased = [];
  for (const item of snapshot.paths.values()) {
    const relative = path.relative(sourceRoot, item.path);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { success: false, code: 'CLEANUP_REBASE_OUTSIDE_ROOT', path: item.path };
    const mappedPath = path.resolve(targetRoot, relative);
    const mappedRelative = path.relative(targetRoot, mappedPath);
    if (mappedRelative === '..' || mappedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(mappedRelative)) return { success: false, code: 'CLEANUP_REBASE_OUTSIDE_ROOT', path: mappedPath };
    const current = await capturePathIdentity(mappedPath, { digest: item.identity.kind === 'file' && Boolean(item.identity.sha256) }).catch(() => null);
    const matches = item.identity.kind === 'directory'
      ? directoryOwnershipMatches(current, item.identity)
      : identitiesMatch(current, item.identity, { destructive: true });
    if (!matches) return { success: false, code: 'CLEANUP_REBASE_OWNERSHIP_CONFLICT', path: mappedPath };
    const mappedIdentity = relative === '' && options.publishedRootIdentity
      ? { ...item.identity, ...options.publishedRootIdentity, path: mappedPath }
      : { ...item.identity, path: mappedPath };
    rebased.push({ key: physicalPathKey(mappedPath), item: { path: mappedPath, identity: mappedIdentity, ownershipToken: token } });
    await options.afterItemVerified?.({ source: item.path, target: mappedPath, identity: item.identity });
  }
  if (new Set(rebased.map(entry => entry.key)).size !== rebased.length) return { success: false, code: 'CLEANUP_REBASE_COLLISION' };
  if (cleanupOwnershipLedger.get(token) !== snapshot) return { success: false, code: 'CLEANUP_REBASE_STALE' };
  for (const entry of rebased) for (const existingToken of [...(cleanupOwnershipPathIndex.get(entry.key) || [])]) {
    if (existingToken === token) continue;
    const existingSnapshot = cleanupOwnershipLedger.get(existingToken);
    const existing = existingSnapshot?.paths.get(entry.key);
    if (existing && currentOwnershipMatchesSync(existing)) continue;
    existingSnapshot?.paths.delete(entry.key);
    const owners = cleanupOwnershipPathIndex.get(entry.key); owners?.delete(existingToken); if (!owners?.size) cleanupOwnershipPathIndex.delete(entry.key);
    if (existingSnapshot && !existingSnapshot.paths.size) cleanupOwnershipLedger.delete(existingToken);
  }
  if (cleanupOwnershipLedger.get(token) !== snapshot) return { success: false, code: 'CLEANUP_REBASE_STALE' };
  for (const key of snapshot.paths.keys()) {
    const owners = cleanupOwnershipPathIndex.get(key); owners?.delete(token); if (!owners?.size) cleanupOwnershipPathIndex.delete(key);
  }
  snapshot.paths = new Map(rebased.map(entry => [entry.key, entry.item]));
  for (const entry of rebased) {
    if (!cleanupOwnershipPathIndex.has(entry.key)) cleanupOwnershipPathIndex.set(entry.key, new Set());
    cleanupOwnershipPathIndex.get(entry.key).add(token);
  }
  return { success: true, ownershipToken: token, paths: rebased.map(entry => entry.item) };
};

const forgetCleanupOwnership = (target, ownershipToken) => {
  const token = String(ownershipToken || ''); const snapshot = cleanupOwnershipLedger.get(token);
  snapshot?.paths.delete(physicalPathKey(target));
  const owners = cleanupOwnershipPathIndex.get(physicalPathKey(target)); owners?.delete(token); if (!owners?.size) cleanupOwnershipPathIndex.delete(physicalPathKey(target));
  if (!snapshot?.paths.size) cleanupOwnershipLedger.delete(token);
};

const getCleanupOwnershipStats = () => ({ operations: cleanupOwnershipLedger.size, paths: [...cleanupOwnershipLedger.values()].reduce((sum, snapshot) => sum + snapshot.paths.size, 0) });
const refreshRestoredCleanupOwnership = async (ownershipToken, target, publishedIdentity) => {
  const owned = cleanupOwnershipLedger.get(String(ownershipToken))?.paths.get(physicalPathKey(target));
  if (!owned || !publishedIdentity) return false;
  const current = await capturePathIdentity(target, { digest: Boolean(owned.identity.sha256) }).catch(() => null);
  if (!current || !identitiesMatch(current, publishedIdentity)) return false;
  // A proven rename changes ctime. Retain every other ownership constraint,
  // including content digest, before accepting that one expected change.
  const expected = { ...owned.identity, ctimeNs: current.ctimeNs, changedNs: current.changedNs };
  if (current.kind === 'directory' ? !directoryOwnershipMatches(current, owned.identity) : !identitiesMatch(current, expected, { destructive: true })) return false;
  rememberCleanupOwnership(target, { ...current, ...(owned.identity.nativeIdentity ? { nativeIdentity: owned.identity.nativeIdentity } : {}) }, ownershipToken);
  return true;
};
const ownershipSnapshotForToken = ownershipToken => [...(cleanupOwnershipLedger.get(String(ownershipToken || ''))?.paths.values() || [])].map(item => ({ path: item.path, identity: item.identity, ownershipToken: item.ownershipToken }));
const mergedCurrentOwnershipSnapshot = (error, ownershipToken) => {
  const token = String(ownershipToken || error?.ownershipToken || '');
  const candidates = [...(Array.isArray(error?.ownershipSnapshot) ? error.ownershipSnapshot : []), ...ownershipSnapshotForToken(token)];
  if (error?.publishedIdentity && error?.destinationPath) candidates.push({ path: error.destinationPath, identity: error.publishedIdentity, ownershipToken: error.ownershipToken || token });
  const byPath = new Map();
  for (const candidate of candidates) {
    if (!candidate?.path || !candidate?.identity || String(candidate.ownershipToken || token) !== token) continue;
    const item = { path: path.resolve(candidate.path), identity: candidate.identity, ownershipToken: token };
    if (currentOwnershipMatchesSync(item)) byPath.set(physicalPathKey(item.path), item);
  }
  return [...byPath.values()];
};
const attachOwnershipToError = (error, ownershipToken) => {
  if (!error || typeof error !== 'object') return error;
  error.ownershipToken ||= ownershipToken;
  error.ownershipSnapshot = mergedCurrentOwnershipSnapshot(error, ownershipToken);
  finalizeImplicitOwnership(ownershipToken);
  return error;
};

const partialPublishError = ({ source, target, identity, cleanupError, rollbackError, strategy, verifiedRecoveryPaths = null, verifiedSourceRetained = null, uncertainPaths = [] }) => {
  const targetVerified = Boolean(identity);
  const error = new Error(targetVerified
    ? `内容已发布到“${path.basename(target)}”，但源文件清理失败且无法安全回滚；已保留可恢复副本`
    : `“${path.basename(target)}”的发布结果待确认，源文件清理也未能安全完成；已保留可恢复副本`);
  error.code = PUBLISH_PARTIAL_CODE;
  error.transferStage = 'cleanup-published-source';
  error.sourcePath = source;
  error.destinationPath = target;
  if (targetVerified) error.publishedIdentity = identity;
  error.publishStrategy = strategy;
  if (targetVerified) { error.published = true; error.publishedConfirmed = true; error.publicationState = 'published'; }
  else { error.publishedConfirmed = false; error.publicationState = 'unknown'; error.outcomeUnknown = true; }
  const payloadDeleted = cleanupError?.deleted === true;
  const recoveryPaths = payloadDeleted ? [] : verifiedRecoveryPaths === null ? existingRecoveryPaths([cleanupError?.recoveryPath, source]) : existingRecoveryPaths(verifiedRecoveryPaths);
  error.recoveryRequired = recoveryPaths.length > 0;
  if (recoveryPaths.length) error.recoveryPath = recoveryPaths[0];
  error.recoveryPaths = recoveryPaths;
  error.sourceRetained = payloadDeleted ? false : verifiedSourceRetained === null ? fs.existsSync(source) : verifiedSourceRetained === true;
  error.uncertainPaths = existingRecoveryPaths(uncertainPaths);
  if (payloadDeleted) { error.deleted = true; error.cleanupWarning = true; error.outcomeUnknown = cleanupError?.outcomeUnknown !== false; }
  if (cleanupError?.phase) error.cleanupPhase = cleanupError.phase;
  error.cleanupError = cleanupError?.message || String(cleanupError);
  error.cleanupCode = cleanupError?.code;
  error.cause = cleanupError;
  error.rollbackError = rollbackError?.message || String(rollbackError || '');
  return error;
};
const stagingRecoveryError = ({ source, destination, staging, cause, strategy }) => {
  const error = new Error(`目标“${path.basename(destination)}”尚未发布；跨卷暂存副本已保留，可安全恢复或重试`);
  error.code = PUBLISH_PARTIAL_CODE;
  error.transferStage = 'recovery-staging';
  error.sourcePath = source;
  error.destinationPath = destination;
  error.published = false;
  error.publishStrategy = strategy;
  error.recoveryRequired = true;
  error.recoveryPath = cause?.recoveryPath || staging;
  error.sourceRetained = fs.existsSync(source);
  error.cleanupError = cause?.message || String(cause);
  error.cleanupCode = cause?.code;
  error.cause = cause;
  return error;
};
const publicationServiceMissingError = source => Object.assign(new Error('平台原子文件发布服务不可用，未发布任何目标，源内容已保留'), { code: 'FILE_PUBLICATION_SERVICE_MISSING', sourcePath: source, sourceRetained: true, published: false, recoveryRequired: false });

// A cut can publish every target and still fail to remove the source, most often
// because another program holds the original open. The operator-facing message
// has to answer three questions the raw native text does not: did my file arrive,
// why is there still a copy at the old location, and what am I supposed to do
// about it. "已安全移动 0/4 个文件" answers none of them and reads like nothing
// happened, even though the targets are already published.
//
// Which phase failed decides what may be claimed, and the claims are built from
// named file lists rather than totals:
//
//  - `cleanupFiles`  arrived, target verified, original still there — the only
//    files the operator may be told to delete, always named by full path so
//    "这个文件" can never be ambiguous;
//  - `unverifiedFiles` may or may not have arrived — never counted as arrivals
//    and never offered for deletion;
//  - everything else published has had its original deleted, so it must never be
//    described as still present.
//
// A failed target validation or a failure before publication leaves a state that
// has to be checked by hand, so nothing is counted and nothing is deleted.
const SOURCE_CLEANUP_STAGE = 'source-cleanup';
const asTrimmedList = value => (Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean);
const joinNames = names => names.join('、');
const sourceCleanupFailureMessage = ({ entryName = '', entryPath = '', filesMoved = 0, publishedCount = 0, retainedCount = 0, unverifiedCount = 0, unverifiedName = '', cleanupFiles = null, unverifiedFiles = null, affectedFiles = null, totalFiles = 0, stage = '', cause = null, recoveryRequired = false } = {}) => {
  const deleted = Math.max(0, Number(filesMoved) || 0);
  const published = Math.max(deleted, Number(publishedCount) || 0);
  const total = Math.max(0, Number(totalFiles) || 0);
  const name = String(entryName || '').trim();
  const location = String(entryPath || '').trim();
  const causeText = String(cause || '').trim();
  const cleanupNames = asTrimmedList(cleanupFiles);
  const unverifiedNames = asTrimmedList(unverifiedFiles);
  const affectedNames = asTrimmedList(affectedFiles);
  const retained = cleanupFiles ? cleanupNames.length : Math.max(0, Number(retainedCount) || 0);
  const unverified = unverifiedFiles ? unverifiedNames.length : Math.max(0, Number(unverifiedCount) || 0);
  const unverifiedLabel = unverifiedFiles
    ? (unverifiedNames.length > 1 ? `${unverifiedNames.length} 个` : '')
    : String(unverifiedName || '').trim();
  const arrived = published > 0;
  const cleanupFailed = String(stage || '') === SOURCE_CLEANUP_STAGE;
  if (!cleanupFailed) {
    // The batch result cannot say which files arrived, so no count is reported —
    // only the files whose state is in doubt are named, so the operator knows
    // what to check.
    const pending = total > 0 ? `${total}` : '';
    const lines = [`${pending ? `${pending} 个文件` : '文件'}的复制状态待核实，暂时不要删除原文件。`];
    const inDoubt = affectedNames.length ? affectedNames : [location ? `${name}（${location}）` : name].filter(Boolean);
    if (inDoubt.length) lines.push(`未能确认的文件：${joinNames(inDoubt)}。`);
    if (causeText) lines.push(`系统提示：${causeText}`);
    lines.push('请先在项目里核对哪些文件已经到位，确认后再自行处理原文件。');
    return lines.join('');
  }
  const lines = [];
  if (arrived) {
    // Only files whose original is gone may be called moved, and only files
    // whose original is still there may be called leftovers. Zero-count groups
    // are left out so the sentence never reads "0 个已完整移动".
    if (total > 0 && deleted === total) lines.push(`${total} 个文件已全部移动到项目。`);
    else if (unverified > 0) {
      const groups = [];
      if (deleted > 0) groups.push(`${deleted} 个已完整移动`);
      if (retained > 0) groups.push(`${retained} 个已复制到项目`);
      groups.push(`${unverified} 个复制状态待核实`);
      lines.push(`${total} 个文件有 ${groups.join('、')}。`);
    } else if (published === total) lines.push(`${total} 个文件已复制到项目${deleted > 0 ? `（其中 ${deleted} 个原文件已删除）` : ''}。`);
    else lines.push(`${published}/${total} 个文件已复制到项目${deleted > 0 ? `（其中 ${deleted} 个原文件已删除）` : ''}，其余未能复制。`);
  } else {
    lines.push('文件未能复制到项目，原文件没有改动。');
  }
  if (unverified > 0) {
    const label = unverifiedNames.length ? joinNames(unverifiedNames) : (unverifiedLabel || `${unverified} 个`);
    lines.push(`复制状态待核实：${label}；请不要删除它们的原文件，先在项目里核对。`);
  }
  if (causeText) {
    // Nothing arrived, so there is no leftover to explain: report the system
    // reason without implying the original was touched.
    lines.push(arrived ? `系统提示：${causeText}` : `系统提示：${name ? `${name}${location ? `（${location}）` : ''}：` : ''}${causeText}`);
  }
  // A retained recovery copy already supersedes manual cleanup advice, and only
  // the confirmed originals may be named: an unverified one may never have
  // arrived, so deleting it would destroy the only copy.
  if (!recoveryRequired && retained > 0) {
    if (!cleanupNames.length && name) cleanupNames.push(location ? `${name}（${location}）` : name);
    lines.push(cleanupNames.length
      ? `可直接清理的原文件（${retained} 个）：${joinNames(cleanupNames)}。`
      : `可直接清理的原文件（${retained} 个），通常是它们正被其他程序打开或占用。`);
  }
  return lines.join('');
};

const normalizeNativePublicationError = async (error, source, target, strategy = 'native-move-no-replace', nativeService = null, reconciliationHook = null, ownershipToken = '') => {
  if (!error?.published && !error?.outcomeUnknown) return error;
  const resolvedTarget = path.resolve(target);
  const reportedPath = error.publishedPath ? path.resolve(error.publishedPath) : resolvedTarget;
  const sourceMissing = !await fs.promises.lstat(source).catch(() => null);
  const targetExists = Boolean(await fs.promises.lstat(resolvedTarget).catch(() => null));
  let publishedIdentity;
  if (error.published === true && error.outcomeUnknown !== true && sourceMissing && targetExists && reportedPath === resolvedTarget && error.identity && nativeService && typeof nativeService.inspectPath === 'function') {
    const firstNative = await nativeService.inspectPath(resolvedTarget).catch(() => null);
    await reconciliationHook?.({ stage: 'after-first-native-inspect', target: resolvedTarget, expectedNativeIdentity: error.identity });
    const firstPhysical = await capturePublishedIdentity(resolvedTarget).catch(() => null);
    const secondNative = await nativeService.inspectPath(resolvedTarget).catch(() => null);
    const secondPhysical = await capturePublishedIdentity(resolvedTarget).catch(() => null);
    const thirdNative = await nativeService.inspectPath(resolvedTarget).catch(() => null);
    const nativeConsistent = [firstNative, secondNative, thirdNative].every(item => item?.success !== false && item?.identity === error.identity);
    const physicalConsistent = firstPhysical && secondPhysical && identitiesMatch(firstPhysical, secondPhysical, { destructive: true });
    if (nativeConsistent && physicalConsistent) publishedIdentity = { ...secondPhysical, nativeIdentity: error.identity };
  }
  const strictlyPublished = Boolean(publishedIdentity);
  return Object.assign(new Error(error.message || `“${path.basename(resolvedTarget)}”的原子发布结果需要恢复确认`), {
    code: PUBLISH_PARTIAL_CODE,
    transferStage: 'commit-target-outcome',
    sourcePath: path.resolve(source),
    destinationPath: resolvedTarget,
    published: strictlyPublished,
    outcomeUnknown: error.outcomeUnknown === true || !strictlyPublished,
    publishedIdentity,
    ownershipToken: ownershipToken || undefined,
    ownershipSnapshot: strictlyPublished ? [{ path: resolvedTarget, identity: publishedIdentity, ownershipToken: ownershipToken || undefined }] : [],
    uncertainPaths: strictlyPublished ? undefined : [path.resolve(source), resolvedTarget],
    publishStrategy: strategy,
    recoveryRequired: true,
    recoveryPath: error.recoveryPath || (strictlyPublished ? resolvedTarget : path.resolve(source)),
    sourceRetained: fs.existsSync(source),
    nativeCode: error.code,
    cause: error,
  });
};

const publishPathNoClobber = async (source, destination, options = {}) => {
  const resolvedSource = path.resolve(source);
  const target = path.resolve(destination);
  const sourceStat = await fs.promises.lstat(resolvedSource);
  const existing = await fs.promises.lstat(target).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) throw Object.assign(new Error(`目标已存在：${path.basename(target)}`), { code: 'EEXIST' });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  if (!sourceStat.isFile() && !sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) throw new Error(`不支持发布此文件类型：${path.basename(resolvedSource)}`);
  // Symlinks and Windows junctions are always moved as link objects by the
  // native no-replace helper. Never stat or copy their targets here.
  if (sourceStat.isSymbolicLink()) await fs.promises.readlink(resolvedSource);
  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  if (!nativeService?.nativeAvailable?.()) {
    throw publicationServiceMissingError(resolvedSource);
  }
  let result;
  try { result = await nativeService.moveNoReplace(resolvedSource, target); }
  catch (error) { throw await normalizeNativePublicationError(error, resolvedSource, target, 'native-move-no-replace', nativeService, options.nativeReconcileHook, options.ownershipToken); }
  if (result?.outcomeUnknown || result?.success === false && result?.published) throw await normalizeNativePublicationError(result, resolvedSource, target, 'native-move-no-replace', nativeService, options.nativeReconcileHook, options.ownershipToken);
  return { strategy: result.strategy || 'win32-move-no-replace', identity: await capturePublishedIdentity(target), nativeIdentity: result.identity, sourceRemoved: true, recoveryRequired: false };
};

const commitTemporaryFile = async (temporary, target, options = {}) => {
  return publishPathNoClobber(temporary, target, options);
};

const copyFileAtomic = async (source, destination, options = {}) => {
  const { onProgress = () => undefined, isCancelled = () => false, waitIfPaused = async () => undefined, durable = false } = options;
  const ownershipToken = ownershipTokenForOptions(options);
  const sourceInfo = await assertRegularFile(source).catch(error => { throw attachTransferContext(error, 'inspect-source', source, destination); });
  const target = path.resolve(destination);
  const targetDirectory = path.dirname(target);
  await fs.promises.mkdir(targetDirectory, { recursive: true }).catch(error => { throw attachTransferContext(error, 'prepare-target', sourceInfo.path, target); });
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  if (!options.resumeState) await assertDiskSpace(targetDirectory, sourceInfo.stat.size);
  const sourceIdentity = await capturePathIdentity(sourceInfo.path);

  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  if (process.platform === 'win32' && sourceInfo.stat.size > DEFAULT_SMALL_FILE_THRESHOLD && options.nativeSinglePass !== false
      && nativeService?.nativeAvailable?.() && typeof nativeService.copyFilesBatch === 'function') {
    const snapshot = nativeWindowsFileSnapshot(sourceIdentity);
    if (snapshot) {
      await waitIfPaused();
      throwIfCancelled(isCancelled);
      let resumeState = options.resumeState || null;
      if (resumeState) {
        if (path.resolve(path.dirname(resumeState.path)) !== targetDirectory || !path.basename(resumeState.path).startsWith(`.${path.basename(target)}.`) || !resumeState.path.endsWith('.photoflow-resumable') || !identitiesMatch(sourceIdentity, resumeState.sourceIdentity)) throw Object.assign(sourceChangedError(source), { recoveryRequired: true, recoveryPaths: existingRecoveryPaths([resumeState.path]) });
        const partial = await capturePathIdentity(resumeState.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!partial) resumeState = null;
        else {
          if (partial.kind !== 'file' || nativeWindowsFileSnapshot(partial)?.identity !== resumeState.nativeIdentity || Number(partial.size) > sourceInfo.stat.size) throw Object.assign(new Error('续传暂存文件身份或长度不符'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
          await assertDiskSpace(targetDirectory, sourceInfo.stat.size - Number(partial.size));
        }
      }
      if (!resumeState && typeof options.onPartialState === 'function' && sourceInfo.stat.size >= 32 * 1024 * 1024) {
        const partialPath = path.join(targetDirectory, `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-resumable`);
        const handle = await fs.promises.open(partialPath, 'wx'); await handle.close();
        const partial = await capturePathIdentity(partialPath);
        rememberCleanupOwnership(partialPath, { ...partial, sha256: crypto.createHash('sha256').digest('hex') }, ownershipToken);
        resumeState = { path: partialPath, nativeIdentity: nativeWindowsFileSnapshot(partial).identity, sourceIdentity };
        if (await options.onPartialState(resumeState) === false) {
          await nativeService.compareDeleteFile({ target: partialPath, sha256: crypto.createHash('sha256').digest('hex'), size: 0, identity: resumeState.nativeIdentity });
          forgetCleanupOwnership(partialPath, ownershipToken);
          resumeState = null;
          await options.onPartialState(null);
        }
      }
      let result;
      let failure;
      try {
        [result] = await nativeService.copyFilesBatch([{ source: sourceInfo.path, target, ...snapshot }], {
          durable, isCancelled, waitIfPaused, onProgress, resumeState,
        });
      } catch (error) { failure = error; result = error.completed?.find(item => item.index === 0); }
      if (result) {
        const identity = await capturePublishedIdentity(target).catch(() => null);
        if (!identity || nativeWindowsFileSnapshot(identity)?.identity !== result.identity || identity.size !== sourceIdentity.size) {
          throw Object.assign(new Error('原生复制完成后目标身份无法确认'), { code: 'PUBLISH_OWNERSHIP_CONFLICT', sourceRetained: true, outcomeUnknown: true, recoveryRequired: true, recoveryPaths: existingRecoveryPaths([sourceInfo.path, target]) });
        }
        const publishedIdentity = { ...identity, sha256: result.sha256, nativeIdentity: result.identity };
        rememberCleanupOwnership(target, publishedIdentity, ownershipToken);
        if (failure) throw attachOwnershipToError(failure, ownershipToken);
        try {
          onProgress({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
          throwIfCancelled(isCancelled);
        } catch (error) {
          // Very short copies can commit before the cancellation poll reaches
          // the worker. Remove only our proven destination; retain the source.
          const cleanup = await quarantineOwnedPath({ path: target, identity: publishedIdentity, ownershipToken }, { nativePublicationService: nativeService });
          if (cleanup.success) forgetCleanupOwnership(target, ownershipToken);
          else Object.assign(error, { recoveryRequired: true, recoveryPaths: existingRecoveryPaths([target, cleanup.recoveryPath]) });
          throw attachOwnershipToError(error, ownershipToken);
        }
        finalizeImplicitOwnership(ownershipToken);
        if (resumeState) { forgetCleanupOwnership(resumeState.path, ownershipToken); await options.onPartialState?.(null); }
        return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, resumedBytes: result.resumedBytes || 0, copied: true, commitStrategy: 'win32-native-single-pass-copy', publishedIdentity, nativePublishedIdentity: result.identity, ownershipToken, ownershipSnapshot: [{ path: target, identity: publishedIdentity, ownershipToken }] };
      }
      if (resumeState && !failure?.outcomeUnknown && failure?.code !== 'PUBLISH_OWNERSHIP_CONFLICT') {
        const partial = await capturePathIdentity(resumeState.path, { digest: true }).catch(() => null);
        if (partial && nativeWindowsFileSnapshot(partial)?.identity === resumeState.nativeIdentity) rememberCleanupOwnership(resumeState.path, partial, ownershipToken);
      }
      if (resumeState && failure && (failure.outcomeUnknown || failure.code === 'PUBLISH_OWNERSHIP_CONFLICT')) Object.assign(failure, { recoveryRequired: true, recoveryPaths: existingRecoveryPaths([resumeState.path]) });
      if (failure?.published || failure?.outcomeUnknown) Object.assign(failure, { sourceRetained: true, recoveryRequired: true, recoveryPaths: existingRecoveryPaths([sourceInfo.path, target]) });
      throw attachTransferContext(failure || new Error('原生复制未返回提交凭据'), 'copy-data', sourceInfo.path, target);
    }
  }

  await assertDiskSpace(targetDirectory, sourceInfo.stat.size);
  const temporary = path.join(targetDirectory, `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-part`);
  let copied = 0;
  const copiedHash = crypto.createHash('sha256');
  const reader = fs.createReadStream(sourceInfo.path, { highWaterMark: 4 * 1024 * 1024 });
  // Do not copy a Windows read-only bit onto the temporary file before the
  // atomic rename. A read-only temporary can make the final rename fail with
  // EPERM even though both source and destination are otherwise accessible.
  const writer = fs.createWriteStream(temporary, { flags: 'wx' });
  const checkCancelled = () => {
    if (!isCancelled()) return;
    const error = cancelledError();
    reader.destroy(error);
    writer.destroy(error);
  };
  const observeChunk = chunk => {
    reader.pause();
    copied += chunk.length;
    copiedHash.update(chunk);
    onProgress({ bytesCopied: copied, totalBytes: sourceInfo.stat.size });
    checkCancelled();
    void Promise.resolve(waitIfPaused()).then(() => {
      checkCancelled();
      if (!reader.destroyed) reader.resume();
    }, error => {
      reader.destroy(error);
      writer.destroy(error);
    });
  };

  try {
    checkCancelled();
    await waitIfPaused();
    reader.on('data', observeChunk);
    await pipeline(reader, writer).catch(error => { throw attachTransferContext(error, 'copy-data', sourceInfo.path, target); });
    checkCancelled();
    const written = await fs.promises.stat(temporary);
    if (written.size !== sourceInfo.stat.size) throw new Error(`文件复制不完整：${path.basename(sourceInfo.path)}`);
    const copiedSha256 = await verifyStableCopiedFile(sourceInfo.path, temporary, sourceIdentity, copiedHash.digest('hex'));
    await fs.promises.utimes(temporary, sourceInfo.stat.atime, sourceInfo.stat.mtime).catch(() => undefined);
    if (durable) await syncTemporaryFile(temporary, sourceInfo.path, target);
    checkCancelled();
    if (!await samePathIdentity(sourceInfo.path, sourceIdentity)) throw sourceChangedError(sourceInfo.path);
    const commit = await commitTemporaryFile(temporary, target, options).catch(error => { throw attachTransferContext(error, 'commit-target', sourceInfo.path, target); });
    await fs.promises.chmod(target, sourceInfo.stat.mode).catch(() => undefined);
    const publishedIdentity = { ...await capturePublishedIdentity(target), sha256: copiedSha256, ...(commit.nativeIdentity ? { nativeIdentity: commit.nativeIdentity } : {}) };
    rememberCleanupOwnership(target, publishedIdentity, ownershipToken);
    if (!await samePathIdentity(sourceInfo.path, sourceIdentity)) {
      const cleanup = await quarantineOwnedPath({ path: target, identity: publishedIdentity, ownershipToken });
      if (cleanup.success) forgetCleanupOwnership(target, ownershipToken);
      throw Object.assign(sourceChangedError(sourceInfo.path), cleanup.recoveryPath ? { recoveryRequired: true, recoveryPath: cleanup.recoveryPath } : {});
    }
    onProgress({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
    finalizeImplicitOwnership(ownershipToken);
    return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: true, commitStrategy: commit.strategy, publishedIdentity, nativePublishedIdentity: commit.nativeIdentity, ownershipToken, ownershipSnapshot: [{ path: target, identity: publishedIdentity, ownershipToken }] };
  } catch (error) {
    reader.destroy();
    writer.destroy();
    if (error?.code !== PUBLISH_PARTIAL_CODE) await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const collectCopyPlan = async (source, destination, plan, options = {}) => {
  const { isCancelled = () => false, onDiscovered = () => undefined } = options;
  const metadataConcurrency = Math.max(1, Math.min(32, Math.floor(Number(options.metadataConcurrency) || 8)));
  const planIdentity = (filePath, stat) => identityFromStat(filePath, stat);
  const planFileMetadata = stat => ({
    size: Number(stat.size),
    mode: Number(stat.mode),
    atime: new Date(Number((stat.atimeNs + 500000n) / 1000000n)),
    mtime: new Date(Number((stat.mtimeNs + 500000n) / 1000000n)),
  });
  const visitDirectory = async (directorySource, directoryDestination, directoryEntry) => {
    throwIfCancelled(isCancelled);
    const entries = await fs.promises.readdir(directorySource, { withFileTypes: true }).catch(error => { throw attachTransferContext(error, 'inspect-source', directorySource, directoryDestination); });
    directoryEntry.children = entries.map(entry => entry.name).sort((left, right) => left.localeCompare(right));
    // Bound outstanding metadata reads while retaining depth-first plan order:
    // directory creation and source-cleanup snapshots rely on that ordering.
    for (let offset = 0; offset < entries.length; offset += metadataConcurrency) {
      throwIfCancelled(isCancelled);
      const batch = entries.slice(offset, offset + metadataConcurrency);
      const stats = await Promise.all(batch.map(entry => {
        if (!entry.isDirectory() && !entry.isFile()) throw new Error(`不支持复制此文件类型：${entry.name}`);
        // Do not prefetch a directory identity across a sibling traversal.
        // Validate it immediately before descending, as in the serial walker.
        if (entry.isDirectory()) return null;
        const entrySource = path.join(directorySource, entry.name);
        return fs.promises.lstat(entrySource, { bigint: true }).catch(error => {
          throw attachTransferContext(error, 'inspect-source', entrySource, path.join(directoryDestination, entry.name));
        });
      }));
      for (const [index, entry] of batch.entries()) {
        throwIfCancelled(isCancelled);
        const entrySource = path.join(directorySource, entry.name);
        const entryDestination = path.join(directoryDestination, entry.name);
        const stat = stats[index] || await fs.promises.lstat(entrySource, { bigint: true }).catch(error => {
          throw attachTransferContext(error, 'inspect-source', entrySource, entryDestination);
        });
        if (stat.isSymbolicLink() || stat.isDirectory() !== entry.isDirectory() || stat.isFile() !== entry.isFile()) throw sourceChangedError(entrySource);
        if (entry.isDirectory()) {
          const childDirectory = { kind: 'directory', source: entrySource, destination: entryDestination, size: 0, sourceIdentity: planIdentity(entrySource, stat), children: [] };
          plan.push(childDirectory);
          await onDiscovered(childDirectory, plan.length);
          await visitDirectory(entrySource, entryDestination, childDirectory);
          continue;
        }
        if (!entry.isFile()) throw new Error(`不支持复制此文件类型：${entry.name}`);
        plan.push({ kind: 'file', source: entrySource, destination: entryDestination, ...planFileMetadata(stat), sourceIdentity: planIdentity(entrySource, stat) });
        await onDiscovered(plan[plan.length - 1], plan.length);
      }
    }
  };

  throwIfCancelled(isCancelled);
  const stat = await fs.promises.lstat(source, { bigint: true }).catch(error => { throw attachTransferContext(error, 'inspect-source', source, destination); });
  if (stat.isDirectory()) {
    const rootDirectory = { kind: 'directory', source, destination, size: 0, sourceIdentity: planIdentity(source, stat), children: [] };
    plan.push(rootDirectory);
    await onDiscovered(rootDirectory, plan.length);
    await visitDirectory(source, destination, rootDirectory);
    return plan;
  }
  if (!stat.isFile()) throw new Error(`不支持复制此文件类型：${path.basename(source)}`);
  plan.push({ kind: 'file', source, destination, ...planFileMetadata(stat), sourceIdentity: planIdentity(source, stat) });
  await onDiscovered(plan[plan.length - 1], plan.length);
  return plan;
};

const assertCopyPlanSourcesUnchanged = async (plan, options = {}) => {
  const verifyDigests = options.verifyDigests !== false;
  for (const entry of plan) {
    let stat;
    try { stat = await fs.promises.lstat(entry.source, { bigint: true }); }
    catch { throw new Error(`剪切源已不存在：${path.basename(entry.source)}`); }
    const expected = verifyDigests ? entry.sourceIdentity : { ...entry.sourceIdentity, sha256: undefined };
    const current = identityFromStat(entry.source, stat);
    if (verifyDigests && expected?.sha256 && current.kind === 'file') current.sha256 = await fileDigest(entry.source);
    if (!identitiesMatch(current, expected)) throw new Error(`剪切源在复制期间发生变化：${path.basename(entry.source)}`);
    if (entry.kind === 'file') {
      if (!stat.isFile()) throw new Error(`剪切源在复制期间发生变化：${path.basename(entry.source)}`);
      continue;
    }
    if (!stat.isDirectory()) throw new Error(`剪切源类型发生变化：${path.basename(entry.source)}`);
    const children = (await fs.promises.readdir(entry.source)).sort((left, right) => left.localeCompare(right));
    if (children.length !== entry.children.length || children.some((name, index) => name !== entry.children[index])) throw new Error(`剪切源文件夹在复制期间发生变化：${path.basename(entry.source)}`);
  }
};

const removeCopiedSourcesIndividually = async (plan, options = {}) => {
  await assertCopyPlanSourcesUnchanged(plan);
  const files = plan.filter(entry => entry.kind === 'file');
  const directories = plan.filter(entry => entry.kind === 'directory').sort((left, right) => right.source.length - left.source.length);
  const outcomes = [];
  for (const entry of files) {
    await assertCopyPlanSourcesUnchanged([entry]);
    const identity = { ...entry.sourceIdentity, kind: 'file' };
    if (!identity.sha256) identity.sha256 = await fileDigest(entry.source);
    const outcome = await quarantineOwnedPath({ path: entry.source, identity, ownershipToken: String(options.ownershipToken || crypto.randomUUID()) }, options);
    outcomes.push(outcome);
    if (!outcome.success) throw Object.assign(new Error(`剪切源无法安全清理：${path.basename(entry.source)}`), outcome);
  }
  for (const entry of directories) {
    const current = await capturePathIdentity(entry.source).catch(() => null);
    if (!current || current.kind !== 'directory' || current.device === '0' || current.inode === '0'
      || current.device !== entry.sourceIdentity.device || current.inode !== entry.sourceIdentity.inode) throw new Error(`剪切源文件夹已被替换：${path.basename(entry.source)}`);
    const children = await fs.promises.readdir(entry.source);
    if (children.length) throw new Error(`剪切源文件夹出现了未复制的新内容：${path.basename(entry.source)}`);
    const outcome = await quarantineOwnedPath({ path: entry.source, identity: { ...entry.sourceIdentity, kind: 'directory' }, ownershipToken: String(options.ownershipToken || crypto.randomUUID()) }, options);
    outcomes.push(outcome);
    if (!outcome.success) throw Object.assign(new Error(`剪切源文件夹无法安全清理：${path.basename(entry.source)}`), outcome);
  }
  const warnings = outcomes.filter(outcome => outcome.cleanupWarning || outcome.outcomeUnknown);
  return {
    success: true,
    outcomes,
    recoveryPaths: [],
    cleanupWarning: warnings.map(outcome => outcome.cleanupWarning).filter(Boolean).join('；') || undefined,
    outcomeUnknown: warnings.some(outcome => outcome.outcomeUnknown === true) || undefined,
    phase: warnings.find(outcome => outcome.phase)?.phase,
  };
};

const cleanupAncestorPaths = candidate => {
  const resolved = path.resolve(candidate);
  const root = path.parse(resolved).root;
  const paths = [root];
  let current = root;
  for (const segment of path.relative(root, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  return paths;
};

const WINDOWS_FILETIME_EPOCH = 116444736000000000n;
const nativeWindowsFileSnapshot = identity => {
  try {
    const device = BigInt(identity?.device || '0'); const inode = BigInt(identity?.inode || '0');
    const mtimeNs = BigInt(identity?.mtimeNs || ''); const ctimeNs = BigInt(identity?.ctimeNs || '');
    if (device <= 0n || inode <= 0n || identity?.kind !== 'file') return null;
    const hex = value => (value & 0xffffffffn).toString(16).padStart(8, '0');
    return {
      identity: `${hex(device)}:${hex(inode >> 32n)}:${hex(inode)}`,
      size: String(identity.size),
      lastWriteTime: String(mtimeNs / 100n + WINDOWS_FILETIME_EPOCH),
      changeTime: String(ctimeNs / 100n + WINDOWS_FILETIME_EPOCH),
    };
  } catch { return null; }
};

const inspectCleanupPaths = async (paths, nativeService) => {
  const unique = [...new Map(paths.map(candidate => [physicalPathKey(candidate), path.resolve(candidate)])).values()];
  const states = new Map();
  for (let offset = 0; offset < unique.length;) {
    const batch = takeBoundedBatch(unique, offset, 512, candidate => Math.ceil(Buffer.byteLength(candidate) / 3) * 4 + 32);
    const inspected = await nativeService.inspectPathsBatch(batch);
    if (!Array.isArray(inspected) || inspected.length !== batch.length) throw Object.assign(new Error('批量源文件身份检查返回了不完整结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    for (let index = 0; index < batch.length; index += 1) {
      const state = inspected[index];
      if (state?.success === false || typeof state?.identity !== 'string' || !state.identity) throw Object.assign(new Error(`无法确认剪切源身份：${path.basename(batch[index])}`), { code: state?.code || 'PUBLISH_OWNERSHIP_CONFLICT' });
      states.set(physicalPathKey(batch[index]), state);
    }
    offset += batch.length;
  }
  return states;
};

// Keep cancellation boundaries small while avoiding one IPC round trip per file.
// The native publisher verifies each source identity and never replaces a target.
const movePathsSameVolumeBatched = async (items, options = {}) => {
  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  const moved = [];
  const accept = async (item, identity) => {
    const result = { ...item, publishedIdentity: identity };
    moved.push(result);
    await options.onMoved?.(result, moved.length);
  };
  for (let offset = 0; offset < items.length;) {
    throwIfCancelled(options.isCancelled);
    await options.waitIfPaused?.();
    const batch = takeBoundedBatch(items, offset, 256, item => Buffer.byteLength(item.source) * 2 + Buffer.byteLength(item.destination) * 2 + 160);
    const snapshots = await mapBounded(batch, 8, item => capturePathIdentity(item.source));
    const nativeSnapshots = snapshots.map(nativeWindowsFileSnapshot);
    if (process.platform !== 'win32' || !nativeService?.nativeAvailable?.() || typeof nativeService.moveNoReplaceBatch !== 'function' || nativeSnapshots.some(value => !value)) {
      for (const item of batch) {
        throwIfCancelled(options.isCancelled);
        await options.waitIfPaused?.();
        const result = await publishPathNoClobber(item.source, item.destination, options);
        await accept(item, result.identity);
      }
    } else {
      for (const directory of new Set(batch.map(item => path.dirname(item.destination)))) await fs.promises.mkdir(directory, { recursive: true });
      let failure;
      let completed = [];
      try {
        completed = await nativeService.moveNoReplaceBatch(batch.map((item, index) => ({ source: item.source, target: item.destination, identity: nativeSnapshots[index].identity })));
      } catch (error) { failure = error; completed = error.completed || []; }
      const confirmed = new Set(completed.map(item => item.index));
      // Reconcile all items, including a batch whose response was lost. Only
      // identities proven at the destination enter the caller's rollback list.
      const targets = await mapBounded(batch, 8, item => capturePathIdentity(item.destination).catch(() => null));
      const uncertain = [];
      for (let index = 0; index < batch.length; index += 1) {
        const identity = targets[index];
        if (identity && nativeWindowsFileSnapshot(identity)?.identity === nativeSnapshots[index].identity) {
          const sourceStillOwned = !confirmed.has(index) && nativeWindowsFileSnapshot(await capturePathIdentity(batch[index].source).catch(() => null))?.identity === nativeSnapshots[index].identity;
          // A pre-existing hard link can have the same native identity even
          // when rename failed with EEXIST. It is not a moved destination.
          if (!sourceStillOwned) await accept(batch[index], identity);
        } else if (!failure || failure.outcomeUnknown || failure.code === 'FILE_PUBLICATION_PROTOCOL_ERROR') {
          const source = await capturePathIdentity(batch[index].source).catch(() => null);
          if (nativeWindowsFileSnapshot(source)?.identity !== nativeSnapshots[index].identity) uncertain.push(batch[index].source, batch[index].destination);
          failure ||= Object.assign(new Error('批量移动目标身份无法确认'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
        }
      }
      if (failure) {
        if (uncertain.length) Object.assign(failure, { outcomeUnknown: true, recoveryRequired: true, recoveryPaths: existingRecoveryPaths(uncertain), uncertainPaths: uncertain });
        throw failure;
      }
    }
    offset += batch.length;
    await new Promise(resolve => setImmediate(resolve));
  }
  return moved;
};

const removeCopiedSourcesBatched = async (plan, options, nativeService) => {
  // The copy path already records a verified SHA-256 on every source identity.
  // This metadata-only pass detects replaced paths and new directory entries;
  // the native delete below performs the one authoritative digest read while
  // holding an identity-bound delete handle.
  await assertCopyPlanSourcesUnchanged(plan, { verifyDigests: false });
  const files = plan.filter(entry => entry.kind === 'file');
  const directories = plan.filter(entry => entry.kind === 'directory').sort((left, right) => right.source.length - left.source.length);
  for (const entry of files) {
    if (entry.sourceIdentity.sha256) continue;
    const before = await capturePathIdentity(entry.source);
    const sha256 = await fileDigest(entry.source);
    const after = await capturePathIdentity(entry.source);
    if (!identitiesMatch(before, entry.sourceIdentity) || !identitiesMatch(after, entry.sourceIdentity)) throw sourceChangedError(entry.source);
    entry.sourceIdentity.sha256 = sha256;
  }

  const inspectionPaths = [];
  for (const entry of plan) inspectionPaths.push(entry.source, ...cleanupAncestorPaths(entry.source));
  const nativeStates = await inspectCleanupPaths(inspectionPaths, nativeService);
  await assertCopyPlanSourcesUnchanged(plan, { verifyDigests: false });
  for (const entry of plan) {
    const state = nativeStates.get(physicalPathKey(entry.source));
    if (!state || Boolean(state.directory) !== (entry.kind === 'directory')) throw Object.assign(new Error(`剪切源类型发生变化：${path.basename(entry.source)}`), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
    entry.sourceIdentity.nativeIdentity = state.identity;
  }

  const parentChainFor = candidate => cleanupAncestorPaths(candidate).map(directory => {
    const state = nativeStates.get(physicalPathKey(directory));
    if (!state || state.directory !== true) throw Object.assign(new Error(`剪切源父目录身份不可用：${path.basename(directory)}`), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
    return { path: directory, identity: state.identity };
  });
  const outcomes = [];
  let processed = 0;
  const total = plan.length;
  const appendResults = (batch, results) => {
    if (!Array.isArray(results) || results.length !== batch.length) throw Object.assign(new Error('批量源文件清理返回了不完整结果'), { code: 'FILE_PUBLICATION_PROTOCOL_ERROR' });
    let failure;
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index];
      const result = results[index] || {};
      const outcome = { success: result.success === true || result.deleted === true, deleted: result.deleted === true, path: entry.source, code: result.code, error: result.error, cleanupWarning: result.cleanupWarning, outcomeUnknown: result.outcomeUnknown, phase: result.phase };
      outcomes.push(outcome);
      if (!outcome.success && !failure) failure = outcome;
    }
    processed += batch.length;
    options.onCleanupProgress?.({ processed, total, filesDeleted: Math.min(processed, files.length), totalFiles: files.length, currentName: path.basename(batch.at(-1).source) });
    if (failure) throw Object.assign(new Error(`剪切源无法安全清理：${path.basename(failure.path)}`), failure);
  };
  const runBatches = async (entries, invoke, measure) => {
    const byRoot = new Map();
    for (const entry of entries) {
      const root = path.parse(path.resolve(entry.source)).root;
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(entry);
    }
    for (const [rootPath, rooted] of byRoot) for (let offset = 0; offset < rooted.length;) {
      const batch = takeBoundedBatch(rooted, offset, CLEANUP_TREE_BATCH_SIZE, entry => measure(entry, parentChainFor(entry.source)));
      appendResults(batch, await invoke(rootPath, batch));
      await yieldCleanupTurn(options);
      offset += batch.length;
    }
  };

  await runBatches(files, (rootPath, batch) => nativeService.compareDeleteFilesBatch(batch.map(entry => ({
    path: entry.source,
    rootPath,
    parentChain: parentChainFor(entry.source),
    sha256: entry.sourceIdentity.sha256,
    size: entry.sourceIdentity.size,
    identity: entry.sourceIdentity.nativeIdentity,
  }))), (entry, chain) => Math.ceil(Buffer.byteLength(entry.source) / 3) * 4 + Math.ceil(Buffer.byteLength(entry.sourceIdentity.nativeIdentity) / 3) * 4 + chain.reduce((sum, directory) => sum + Math.ceil(Buffer.byteLength(directory.path) / 3) * 4 + Math.ceil(Buffer.byteLength(directory.identity) / 3) * 4, 0) + 96);

  const directoryLayers = new Map();
  for (const entry of directories) {
    const depth = path.resolve(entry.source).split(path.sep).length;
    if (!directoryLayers.has(depth)) directoryLayers.set(depth, []);
    directoryLayers.get(depth).push(entry);
  }
  for (const depth of [...directoryLayers.keys()].sort((left, right) => right - left)) {
    await runBatches(directoryLayers.get(depth), (rootPath, batch) => nativeService.deleteDirectoriesBatch(batch.map(entry => ({
      path: entry.source,
      rootPath,
      parentChain: parentChainFor(entry.source),
      identity: entry.sourceIdentity.nativeIdentity,
    }))), (entry, chain) => Math.ceil(Buffer.byteLength(entry.source) / 3) * 4 + Math.ceil(Buffer.byteLength(entry.sourceIdentity.nativeIdentity) / 3) * 4 + chain.reduce((sum, directory) => sum + Buffer.byteLength(directory.path) + Buffer.byteLength(directory.identity), 0) + 64);
  }
  const warnings = outcomes.filter(outcome => outcome.cleanupWarning || outcome.outcomeUnknown);
  return {
    success: true,
    outcomes,
    recoveryPaths: [],
    cleanupWarning: warnings.map(outcome => outcome.cleanupWarning === true ? '原生删除已完成，但持久化确认失败' : outcome.cleanupWarning).filter(Boolean).join('；') || undefined,
    outcomeUnknown: warnings.some(outcome => outcome.outcomeUnknown === true) || undefined,
    phase: warnings.find(outcome => outcome.phase)?.phase,
  };
};

const removeCopiedSources = async (plan, options = {}) => {
  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  const canBatch = nativeService?.nativeAvailable?.()
    && typeof nativeService.inspectPathsBatch === 'function'
    && typeof nativeService.compareDeleteFilesBatch === 'function'
    && typeof nativeService.deleteDirectoriesBatch === 'function';
  return canBatch
    ? removeCopiedSourcesBatched(plan, options, nativeService)
    : removeCopiedSourcesIndividually(plan, options);
};

const canUseNativeFastCut = () => {
  const nativeService = configuredNativePublicationService || bundledNativePublicationService;
  return process.platform === 'win32' && nativeService?.nativeAvailable?.()
    && typeof nativeService.inspectPathsBatch === 'function'
    && typeof nativeService.copyCutFilesBatch === 'function'
    && typeof nativeService.deleteDirectoriesBatch === 'function';
};

const movePlannedFilesFast = async (plan, options = {}) => {
  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  if (process.platform !== 'win32' || !nativeService?.nativeAvailable?.() || typeof nativeService.copyCutFilesBatch !== 'function') throw Object.assign(new Error('单遍原生跨盘剪切不可用'), { code: 'ENOTSUP' });
  const ownershipToken = ownershipTokenForOptions(options);
  await assertCopyPlanSourcesUnchanged(plan, { verifyDigests: false });
  // A native batch containing any large file runs serially. Isolate large files
  // so they cannot disable parallel copying for their small-file neighbours.
  const allFiles = plan.filter(entry => entry.kind === 'file');
  const smallFiles = allFiles.filter(entry => entry.size <= DEFAULT_SMALL_FILE_THRESHOLD);
  const files = [...smallFiles, ...allFiles.filter(entry => entry.size > DEFAULT_SMALL_FILE_THRESHOLD)];
  const totalFileBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  const directories = plan.filter(entry => entry.kind === 'directory');
  const inspectionPaths = [];
  for (const entry of plan) inspectionPaths.push(...(entry.kind === 'directory' ? [entry.source] : []), ...cleanupAncestorPaths(entry.source));
  const nativeStates = await inspectCleanupPaths(inspectionPaths, nativeService);
  await assertCopyPlanSourcesUnchanged(plan, { verifyDigests: false });
  for (const entry of plan) {
    const state = entry.kind === 'file' ? nativeWindowsFileSnapshot(entry.sourceIdentity) : nativeStates.get(physicalPathKey(entry.source));
    if (!state || entry.kind === 'directory' && state.directory !== true) throw Object.assign(new Error(`剪切源类型发生变化：${path.basename(entry.source)}`), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
    entry.sourceIdentity.nativeIdentity = state.identity;
    if (entry.kind === 'file') entry.nativeSnapshot = state;
  }
  for (const entry of plan) if (fs.existsSync(entry.destination)) throw Object.assign(new Error(`目标文件已存在：${path.basename(entry.destination)}`), { code: 'EEXIST' });
  await forEachDirectoryLayer(directories, async entry => {
    throwIfCancelled(options.isCancelled);
    await options.waitIfPaused?.();
    await fs.promises.mkdir(entry.destination, { recursive: false }).catch(error => { throw attachTransferContext(error, 'prepare-target', entry.source, entry.destination); });
    rememberCleanupOwnership(entry.destination, await capturePathIdentity(entry.destination), ownershipToken);
    options.onCreated?.(entry.destination);
  });

  let filesMoved = 0;
  let bytesMoved = 0;
  const destinationDevice = files.length ? String((await fs.promises.stat(path.dirname(files[0].destination))).dev) : '';
  const acceptCompleted = async (batch, results) => {
    for (const result of results) {
      const entry = batch[result.index];
      const publishedIdentity = { ...await capturePublishedIdentity(entry.destination), sha256: result.sha256, nativeIdentity: result.identity };
      rememberCleanupOwnership(entry.destination, publishedIdentity, ownershipToken);
      entry.sourceIdentity.sha256 = result.sha256;
      filesMoved += 1; bytesMoved += Number(entry.size);
      options.onCreated?.(entry.destination);
      options.onProgress?.({ entry, bytesDelta: Number(entry.size), fileCompleted: true, filesMoved, totalFiles: files.length });
    }
  };
  try {
    for (let offset = 0; offset < files.length;) {
      throwIfCancelled(options.isCancelled);
      await options.waitIfPaused?.();
      const batch = takeBoundedBatch(files, offset, offset < smallFiles.length ? Math.min(2048, smallFiles.length - offset) : 1, entry => Math.ceil(Buffer.byteLength(entry.source) / 3) * 4 + Math.ceil(Buffer.byteLength(entry.destination) / 3) * 4 + 160);
      try {
        const committedBytes = bytesMoved;
        const tuningKey = `cut:${[...new Set(batch.map(entry => entry.sourceIdentity.device))].sort().join(',')}:${destinationDevice}:${Math.floor(Math.log2(Math.max(1, batch.reduce((sum, entry) => sum + entry.size, 0) / batch.length)))}`;
        const parallelism = copyConcurrencyTuner.choose(tuningKey, batch.length);
        const batchStarted = performance.now();
        const results = await nativeService.copyCutFilesBatch(batch.map(entry => ({ source: entry.source, target: entry.destination, identity: entry.sourceIdentity.nativeIdentity, ...entry.nativeSnapshot })), {
          parallelism,
          isCancelled: options.isCancelled,
          waitIfPaused: options.waitIfPaused,
          onProgress: progress => options.onTransferProgress?.({ bytesCopied: committedBytes + progress.bytesCopied, totalBytes: totalFileBytes }),
        });
        copyConcurrencyTuner.observe(tuningKey, parallelism, batch.length, performance.now() - batchStarted);
        await acceptCompleted(batch, results);
      } catch (error) {
        const accepted = Array.isArray(error.completed) ? error.completed : [];
        if (accepted.length) await acceptCompleted(batch, accepted);
        // The failing entry is not always the batch head: a later file can be the
        // one whose original is locked. Prefer the item the native layer named so
        // the message points at the file the user actually has to clean up.
        const named = String(error?.sourcePath || '');
        const reported = batch.find(entry => named && physicalPathKey(entry.source) === physicalPathKey(named))
          || batch[error?.failedIndex ?? 0]
          || batch[0]
          || {};
        // The native layer publishes the target and only then removes the
        // original, and it names the phase that failed. Only a confirmed
        // `source-cleanup` failure proves the target was published *and*
        // verified, so only then can that original be called a redundant
        // leftover, counted, and offered for removal. A failed target validation
        // leaves a published but unconfirmed target, and a failure before
        // publication leaves nothing: neither may be counted as an arrival.
        //
        // The parallel copy can return several failures in one batch, so every
        // entry is classified on its own stage and the counts are summed. A
        // single fixed "+1" would under-report a batch where two targets were
        // both published and both originals kept, which the native layer allows
        // when two workers are running at once.
        //
        // In a cut the adapter reports a successful item only once its original
        // is deleted, so `accepted` (already folded into `filesMoved` here)
        // leaves nothing behind. Every other entry of the batch either failed or
        // was never reached because the halt stopped it, and an entry the native
        // layer never touched definitely did not arrive.
        const failures = Array.isArray(error?.failures) && error.failures.length
          ? error.failures
          : [{ index: error?.failedIndex ?? 0, stage: error?.stage, published: error?.published }];
        const classify = failure => {
          if (failure?.stage === SOURCE_CLEANUP_STAGE) return 'retained';
          if (failure?.published === true) return 'unverified';
          return failure?.stage === 'pre-publication' ? 'absent' : 'unverified';
        };
        const entryFor = failure => batch[failure?.index]
          || batch.find(entry => failure?.sourcePath && physicalPathKey(entry.source) === physicalPathKey(failure.sourcePath))
          || null;
        const retained = failures.filter(failure => classify(failure) === 'retained').map(entryFor).filter(Boolean);
        const unverified = failures.filter(failure => classify(failure) === 'unverified').map(entryFor).filter(Boolean);
        // The tip is built from named lists so the operator can act on it without
        // guessing: `cleanupFiles` is exactly what may be deleted, and every other
        // published entry has already had its original removed.
        error.message = sourceCleanupFailureMessage({
          entryName: reported.source ? path.basename(reported.source) : '',
          entryPath: reported.source || named,
          filesMoved,
          publishedCount: filesMoved + retained.length,
          cleanupFiles: retained.map(entry => entry.source),
          unverifiedFiles: unverified.map(entry => entry.source),
          affectedFiles: failures.map(entryFor).filter(Boolean).map(entry => entry.source),
          totalFiles: files.length,
          stage: error?.stage,
          cause: error?.nativeError || error?.cause?.message || '',
          recoveryRequired: error?.recoveryRequired === true,
        });
        error.sourcePath ||= reported.source || '';
        error.destinationPath ||= reported.destination || '';
        throw error;
      }
      offset += batch.length;
      await yieldCleanupTurn(options);
    }

    const parentChainFor = candidate => cleanupAncestorPaths(candidate).map(directory => {
      const state = nativeStates.get(physicalPathKey(directory));
      if (!state || state.directory !== true) throw Object.assign(new Error(`剪切源父目录身份不可用：${path.basename(directory)}`), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
      return { path: directory, identity: state.identity };
    });
    const directoryLayers = new Map();
    for (const entry of directories) {
      const depth = path.resolve(entry.source).split(path.sep).length;
      if (!directoryLayers.has(depth)) directoryLayers.set(depth, []);
      directoryLayers.get(depth).push(entry);
    }
    let directoriesRemoved = 0;
    for (const depth of [...directoryLayers.keys()].sort((left, right) => right - left)) {
      const layer = directoryLayers.get(depth);
      const byRoot = new Map();
      for (const entry of layer) { const root = path.parse(path.resolve(entry.source)).root; if (!byRoot.has(root)) byRoot.set(root, []); byRoot.get(root).push(entry); }
      for (const [rootPath, rooted] of byRoot) for (let offset = 0; offset < rooted.length;) {
        const batch = takeBoundedBatch(rooted, offset, CLEANUP_TREE_BATCH_SIZE, entry => Buffer.byteLength(entry.source) + parentChainFor(entry.source).reduce((sum, directory) => sum + Buffer.byteLength(directory.path) + Buffer.byteLength(directory.identity), 0) + 96);
        const results = await nativeService.deleteDirectoriesBatch(batch.map(entry => ({ path: entry.source, rootPath, parentChain: parentChainFor(entry.source), identity: entry.sourceIdentity.nativeIdentity })));
        const failedIndex = results.findIndex(result => result?.success !== true && result?.deleted !== true);
        directoriesRemoved += results.filter(result => result?.success === true || result?.deleted === true).length;
        options.onCleanupProgress?.({ processed: filesMoved + directoriesRemoved, total: plan.length, filesDeleted: filesMoved, totalFiles: files.length });
        if (failedIndex >= 0) throw Object.assign(new Error(`剪切源文件夹无法安全清理：${path.basename(batch[failedIndex].source)}`), results[failedIndex]);
        offset += batch.length;
      }
    }
    releaseCleanupOwnership(ownershipToken);
    return { success: true, filesMoved, bytesMoved, directoriesRemoved, strategy: 'win32-native-single-pass-cut' };
  } catch (error) {
    throw attachOwnershipToError(error, ownershipToken);
  }
};

const stageSmallFileAtomic = async (entry, options = {}) => {
  const { isCancelled = () => false, durable = false } = options;
  const target = path.resolve(entry.destination);
  const targetDirectory = path.dirname(target);
  await fs.promises.mkdir(targetDirectory, { recursive: true }).catch(error => { throw attachTransferContext(error, 'prepare-target', entry.source, target); });
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  throwIfCancelled(isCancelled);

  const temporary = path.join(targetDirectory, `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-part`);
  try {
    const sourceIdentity = entry.sourceIdentity || await capturePathIdentity(entry.source);
    if (!await samePathIdentity(entry.source, sourceIdentity)) throw sourceChangedError(entry.source);
    await fs.promises.copyFile(entry.source, temporary, fs.constants.COPYFILE_EXCL).catch(error => { throw attachTransferContext(error, 'copy-data', entry.source, target); });
    throwIfCancelled(isCancelled);
    const written = await fs.promises.stat(temporary);
    if (written.size !== entry.size) throw new Error(`文件复制不完整：${path.basename(entry.source)}`);
    const sha256 = await verifyStableCopiedFile(entry.source, temporary, sourceIdentity);
    sourceIdentity.sha256 = sha256;
    const originalMode = Number.isInteger(entry.mode) ? entry.mode : written.mode;
    // copyFile preserves the Windows read-only attribute. Keep the staging
    // file writable for durable sync and atomic commit, then restore the
    // source mode on the published target below.
    await fs.promises.chmod(temporary, originalMode | 0o200).catch(error => {
      throw attachTransferContext(error, 'sync-temporary', entry.source, target);
    });
    await fs.promises.utimes(temporary, entry.atime, entry.mtime).catch(() => undefined);
    if (durable) await syncTemporaryFile(temporary, entry.source, target);
    throwIfCancelled(isCancelled);
    return { entry, temporary, target, originalMode, sourceIdentity, sha256 };
  } catch (error) {
    if (error?.code !== PUBLISH_PARTIAL_CODE) await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const copySmallFileAtomic = async (entry, options = {}) => {
  const ownershipToken = ownershipTokenForOptions(options);
  const staged = await stageSmallFileAtomic(entry, options);
  try {
    const commit = await commitTemporaryFile(staged.temporary, staged.target, options).catch(error => { throw attachTransferContext(error, 'commit-target', entry.source, staged.target); });
    await fs.promises.chmod(staged.target, staged.originalMode).catch(() => undefined);
    const publishedIdentity = { ...await capturePublishedIdentity(staged.target), sha256: staged.sha256, ...(commit.nativeIdentity ? { nativeIdentity: commit.nativeIdentity } : {}) };
    rememberCleanupOwnership(staged.target, publishedIdentity, ownershipToken);
    if (!await samePathIdentity(entry.source, staged.sourceIdentity)) {
      const cleanup = await quarantineOwnedPath({ path: staged.target, identity: publishedIdentity, ownershipToken });
      if (cleanup.success) forgetCleanupOwnership(staged.target, ownershipToken);
      throw Object.assign(sourceChangedError(entry.source), cleanup.recoveryPath ? { recoveryRequired: true, recoveryPath: cleanup.recoveryPath } : {});
    }
    finalizeImplicitOwnership(ownershipToken);
    return { source: entry.source, destination: staged.target, bytes: entry.size, copied: true, commitStrategy: commit.strategy, publishedIdentity, ownershipToken, ownershipSnapshot: [{ path: staged.target, identity: publishedIdentity, ownershipToken }] };
  } catch (error) {
    if (error?.code !== PUBLISH_PARTIAL_CODE) await fs.promises.rm(staged.temporary, { force: true }).catch(() => undefined);
    throw attachOwnershipToError(error, ownershipToken);
  }
};

const copyPlannedFiles = async (plan, options = {}) => {
  const ownershipToken = ownershipTokenForOptions(options);
  const {
    destinationRoot,
    diskSpaceChecked = false,
    durable = false,
    smallFileThreshold = DEFAULT_SMALL_FILE_THRESHOLD,
    smallFileConcurrency = DEFAULT_SMALL_FILE_CONCURRENCY,
    isCancelled = () => false,
    onCreated = () => undefined,
    onFileStart = () => undefined,
    onProgress = () => undefined,
    waitIfPaused = async () => undefined,
    isEntryComplete = async () => false,
    onEntryComplete = async () => undefined,
    copyLargeFileAtomic = copyFileAtomic,
  } = options;
  const directories = plan.filter(entry => entry.kind === 'directory');
  const files = plan.filter(entry => entry.kind === 'file');
  const smallFiles = files.filter(entry => entry.size <= smallFileThreshold);
  const largeFiles = files.filter(entry => entry.size > smallFileThreshold);
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  const rememberCompletedEntry = async entry => {
    const completedIdentity = options.completedIdentity?.(entry);
    const identity = await capturePathIdentity(entry.destination, { digest: entry.kind === 'file' && !completedIdentity });
    if (completedIdentity) {
      if (!identitiesMatch(identity, { ...completedIdentity, sha256: undefined })) throw Object.assign(new Error('预复制目标在完成前发生变化'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
      identity.sha256 = completedIdentity.sha256;
    }
    rememberCleanupOwnership(entry.destination, identity, ownershipToken);
  };
  if (destinationRoot && !diskSpaceChecked) await assertDiskSpace(destinationRoot, totalBytes);
  if (destinationRoot) {
    const plannedKeys = new Set(plan.map(entry => physicalPathKey(entry.destination)));
    const claimedParents = new Set();
    for (const entry of plan) {
      let parent = path.dirname(entry.destination);
      while (isInside(destinationRoot, parent) && !plannedKeys.has(physicalPathKey(parent))) {
        const key = physicalPathKey(parent);
        if (!claimedParents.has(key) && fs.existsSync(parent)) {
          rememberCleanupOwnership(parent, await capturePathIdentity(parent), ownershipToken);
          claimedParents.add(key);
        }
        parent = path.dirname(parent);
      }
    }
  }

  await forEachDirectoryLayer(directories, async entry => {
    throwIfCancelled(isCancelled);
    await waitIfPaused();
    if (await isEntryComplete(entry)) { await rememberCompletedEntry(entry); return; }
    await fs.promises.mkdir(entry.destination, { recursive: false }).catch(error => { throw attachTransferContext(error, 'prepare-target', entry.source, entry.destination); });
    rememberCleanupOwnership(entry.destination, await capturePathIdentity(entry.destination), ownershipToken);
    onCreated(entry.destination);
    await onEntryComplete(entry, { copied: true, bytes: 0 });
  });

  const control = { error: null };
  let activeSmallCopies = 0;
  let peakSmallConcurrency = 0;
  let fallbackCommits = 0;
  let smallFilesCopied = 0;
  let largeFilesCopied = 0;
  let resumedFiles = 0;
  const shouldCancel = () => Boolean(control.error) || isCancelled();
  const rememberError = error => {
    if (!control.error) { control.error = error; return; }
    if (error?.recoveryRequired) control.error.recoveryRequired = true;
    if (Array.isArray(error?.recoveryPaths)) control.error.recoveryPaths = [...new Set([...(control.error.recoveryPaths || []), ...error.recoveryPaths])];
    if (Array.isArray(error?.unknownIndexes)) control.error.unknownIndexes = [...new Set([...(control.error.unknownIndexes || []), ...error.unknownIndexes])];
  };
  const runPool = async (entries, concurrency, copyEntry) => {
    let nextIndex = 0;
    const worker = async () => {
      while (!control.error) {
        try { throwIfCancelled(isCancelled); } catch (error) { rememberError(error); return; }
        try { await waitIfPaused(); } catch (error) { rememberError(error); return; }
        const index = nextIndex++;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          if (await isEntryComplete(entry)) {
            await rememberCompletedEntry(entry);
            resumedFiles += 1;
            onProgress({ entry, bytesDelta: entry.size, fileCompleted: true, resumed: true });
            continue;
          }
          onFileStart(entry);
          const result = await copyEntry(entry);
          if (result?.commitStrategy === 'copy-fallback') fallbackCommits += 1;
          if (entry.size <= smallFileThreshold) smallFilesCopied += 1;
          else largeFilesCopied += 1;
          onCreated(entry.destination);
          onProgress({ entry, bytesDelta: result?.progressReported ? 0 : entry.size, fileCompleted: true });
          await onEntryComplete(entry, result);
        } catch (error) {
          rememberError(error);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), entries.length) }, worker));
  };

  const smallPool = (async () => {
    const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
    if (process.platform === 'win32' && typeof nativeService?.copyFilesBatch === 'function') {
      const pending = [];
      for (const entry of smallFiles) {
        try { throwIfCancelled(isCancelled); await waitIfPaused(); } catch (error) { rememberError(error); break; }
        if (await isEntryComplete(entry)) {
          await rememberCompletedEntry(entry); resumedFiles += 1; onProgress({ entry, bytesDelta: entry.size, fileCompleted: true, resumed: true });
        } else { onFileStart(entry); pending.push(entry); }
      }
      if (!pending.length || control.error) return;
      const destinationDevice = String((await fs.promises.stat(path.dirname(pending[0].destination))).dev);
      const snapshots = new Map();
      try {
        for (let offset = 0; offset < pending.length;) {
          const batch = takeBoundedBatch(pending, offset, 2048, entry => Math.ceil(Buffer.byteLength(entry.source) / 3) * 4 + 32);
          for (let index = 0; index < batch.length; index += 1) {
            const entry = batch[index];
            entry.sourceIdentity ||= await capturePathIdentity(entry.source);
            const state = nativeWindowsFileSnapshot(entry.sourceIdentity);
            if (!state) throw sourceChangedError(entry.source);
            snapshots.set(entry, state);
          }
          offset += batch.length;
        }
        peakSmallConcurrency = pending.length ? 1 : 0;
        for (let offset = 0; offset < pending.length && !control.error;) {
          throwIfCancelled(isCancelled); await waitIfPaused();
          const batch = takeBoundedBatch(pending, offset, 2048, entry => Math.ceil(Buffer.byteLength(entry.source) / 3) * 4 + Math.ceil(Buffer.byteLength(entry.destination) / 3) * 4 + 160);
          let completed;
          let copyError;
          let reportedBytes = 0;
          let completedBytes = 0;
          const batchBytes = batch.reduce((sum, entry) => sum + entry.size, 0);
          const tuningKey = `${[...new Set(batch.map(entry => entry.sourceIdentity.device))].sort().join(',')}:${destinationDevice}:${Math.floor(Math.log2(Math.max(1, batchBytes / batch.length)))}`;
          const parallelism = Object.hasOwn(options, 'smallFileConcurrency') ? smallFileConcurrency : copyConcurrencyTuner.choose(tuningKey, batch.length);
          const batchStarted = performance.now();
          const reportBytes = value => {
            const next = Math.max(reportedBytes, Math.min(batchBytes, Number(value) || 0));
            const bytesDelta = next - reportedBytes;
            reportedBytes = next;
            if (bytesDelta) onProgress({ entry: batch[0], bytesDelta, fileCompleted: false });
          };
          try { completed = await nativeService.copyFilesBatch(batch.map(entry => ({ source: entry.source, target: entry.destination, ...snapshots.get(entry) })), {
            durable, parallelism, isCancelled: shouldCancel, waitIfPaused, onProgress: progress => reportBytes(progress.bytesCopied),
          }); }
          catch (error) { completed = Array.isArray(error.completed) ? error.completed : []; copyError = error; }
          if (!copyError) copyConcurrencyTuner.observe(tuningKey, parallelism, batch.length, performance.now() - batchStarted);
          for (const result of completed) {
            const entry = batch[result.index];
            const publishedIdentity = { ...await capturePublishedIdentity(entry.destination), sha256: result.sha256, nativeIdentity: result.identity };
            rememberCleanupOwnership(entry.destination, publishedIdentity, ownershipToken); entry.sourceIdentity.sha256 = result.sha256;
            completedBytes += entry.size;
            reportBytes(completedBytes);
            onCreated(entry.destination); smallFilesCopied += 1; onProgress({ entry, bytesDelta: 0, fileCompleted: true });
            try { await onEntryComplete(entry, { source: entry.source, destination: entry.destination, bytes: entry.size, copied: true, commitStrategy: 'win32-native-single-pass-copy', publishedIdentity }); }
            catch (error) { rememberError(error); break; }
          }
          if (copyError && !control.error) rememberError(attachTransferContext(copyError, 'copy-data', copyError.sourcePath, copyError.destinationPath));
          offset += batch.length;
          await yieldCleanupTurn(options);
        }
      } catch (error) { rememberError(error); }
      return;
    }
    if (typeof nativeService?.moveNoReplaceBatch !== 'function') {
      await runPool(smallFiles, smallFileConcurrency, async entry => {
        activeSmallCopies += 1;
        peakSmallConcurrency = Math.max(peakSmallConcurrency, activeSmallCopies);
        try {
          await waitIfPaused();
          return await copySmallFileAtomic(entry, { durable, isCancelled: shouldCancel, nativePublicationService: nativeService, ownershipToken });
        } finally {
          activeSmallCopies -= 1;
        }
      });
      return;
    }

    const prepared = [];
    let nextIndex = 0;
    const prepareWorker = async () => {
      while (!control.error) {
        try { throwIfCancelled(isCancelled); await waitIfPaused(); } catch (error) { rememberError(error); return; }
        const index = nextIndex++;
        if (index >= smallFiles.length) return;
        const entry = smallFiles[index];
        try {
          if (await isEntryComplete(entry)) {
            await rememberCompletedEntry(entry);
            resumedFiles += 1;
            onProgress({ entry, bytesDelta: entry.size, fileCompleted: true, resumed: true });
            continue;
          }
          onFileStart(entry);
          activeSmallCopies += 1;
          peakSmallConcurrency = Math.max(peakSmallConcurrency, activeSmallCopies);
          try {
            const staged = await stageSmallFileAtomic(entry, { durable, isCancelled: shouldCancel });
            prepared.push({ ...staged, planIndex: index });
          } finally {
            activeSmallCopies -= 1;
          }
        } catch (error) {
          rememberError(error);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, smallFileConcurrency), smallFiles.length) }, prepareWorker));
    prepared.sort((left, right) => left.planIndex - right.planIndex);
    if (control.error || isCancelled()) {
      if (!control.error) rememberError(cancelledError());
    }
    if (!prepared.length) return;

    for (const item of prepared) if (!await samePathIdentity(item.entry.source, item.sourceIdentity)) {
      rememberError(sourceChangedError(item.entry.source));
      break;
    }

    const batchSize = 2048;
    const preservedUnknown = new Set();
    try {
      for (let offset = 0; offset < prepared.length;) {
        const inspectionChunk = takeBoundedBatch(prepared, offset, batchSize, item => Math.ceil(Buffer.byteLength(item.temporary) / 3) * 4);
        const inspections = await nativeService.inspectPathsBatch(inspectionChunk.map(item => item.temporary));
        for (let index = 0; index < inspectionChunk.length; index += 1) {
          if (!inspections[index]?.success || typeof inspections[index].identity !== 'string') throw Object.assign(new Error('无法预捕获批量发布源身份'), { code: 'PUBLISH_OWNERSHIP_CONFLICT', recoveryPaths: inspectionChunk.map(item => item.temporary), recoveryRequired: true });
          inspectionChunk[index].nativeIdentity = inspections[index].identity;
        }
        offset += inspectionChunk.length;
      }
    } catch (error) {
      error.recoveryRequired = true;
      error.recoveryPaths = prepared.filter(item => !item.nativeIdentity).map(item => item.temporary);
      rememberError(error);
    }
    for (let offset = 0; offset < prepared.length && !control.error;) {
      try { throwIfCancelled(isCancelled); await waitIfPaused(); } catch (error) { rememberError(error); break; }
      const chunk = takeBoundedBatch(prepared, offset, batchSize, item => Math.ceil(Buffer.byteLength(item.temporary) / 3) * 4 + Math.ceil(Buffer.byteLength(item.target) / 3) * 4 + Math.ceil(Buffer.byteLength(item.nativeIdentity) / 3) * 4);
      let completed = [];
      let publicationError = null;
      try {
        completed = await nativeService.moveNoReplaceBatch(chunk.map(item => ({ source: item.temporary, target: item.target, identity: item.nativeIdentity })));
      } catch (error) {
        completed = Array.isArray(error.completed) ? error.completed : [];
        publicationError = error;
        try {
          const observed = await nativeService.inspectPathsBatch([...chunk.map(item => item.temporary), ...chunk.map(item => item.target)]);
          const reconciled = [];
          const unknown = [];
          for (let index = 0; index < chunk.length; index += 1) {
            const sourceState = observed[index]; const targetState = observed[chunk.length + index]; const identity = chunk[index].nativeIdentity;
            if (!sourceState.success && targetState.success && targetState.identity === identity) reconciled.push({ index, identity, strategy: 'native-batch-reconciled' });
            else if (!(sourceState.success && sourceState.identity === identity && !targetState.success)) unknown.push(index);
          }
          completed = reconciled;
          if (unknown.length) {
            publicationError.unknownIndexes = unknown.map(index => offset + index);
            for (const index of unknown) preservedUnknown.add(chunk[index].temporary);
            publicationError.recoveryRequired = true;
            publicationError.recoveryPaths = unknown.map(index => chunk[index].temporary).filter(candidate => fs.existsSync(candidate));
          }
        } catch (reconcileError) {
          publicationError.reconciliationError = reconcileError;
        }
      }
      const completedIndexes = new Set(completed.map(item => item.index));
      const published = chunk.filter((_, index) => completedIndexes.has(index));

      // Establish ownership of every target in this chunk before a callback
      // can cancel or fail, so callers can roll back the exact committed set.
      const owned = [];
      for (const item of published) {
        await fs.promises.chmod(item.target, item.originalMode).catch(() => undefined);
        const localIndex = chunk.indexOf(item); const nativeResult = completed.find(result => result.index === localIndex);
        const targetStat = await fs.promises.stat(item.target, { bigint: true });
        const publishedIdentity = { ...publishedIdentityFromStat(item.target, targetStat), nativeIdentity: nativeResult.identity, sha256: item.sha256 };
        rememberCleanupOwnership(item.target, publishedIdentity, ownershipToken);
        if (!await samePathIdentity(item.entry.source, item.sourceIdentity)) {
          const cleanup = await quarantineOwnedPath({ path: item.target, identity: publishedIdentity, ownershipToken });
          if (cleanup.success) forgetCleanupOwnership(item.target, ownershipToken);
          rememberError(Object.assign(sourceChangedError(item.entry.source), cleanup.recoveryPath ? { recoveryRequired: true, recoveryPath: cleanup.recoveryPath } : {}));
          continue;
        }
        owned.push({ item, publishedIdentity, strategy: nativeResult.strategy || 'native-batch-move-no-replace' });
        onCreated(item.target);
      }
      for (const { item, publishedIdentity, strategy } of owned) {
        smallFilesCopied += 1;
        onProgress({ entry: item.entry, bytesDelta: item.entry.size, fileCompleted: true });
        try { await onEntryComplete(item.entry, { source: item.entry.source, destination: item.target, bytes: item.entry.size, copied: true, commitStrategy: strategy, publishedIdentity }); }
        catch (error) { rememberError(error); break; }
      }
      if (publicationError && !control.error) {
        const failed = chunk[publicationError.failedIndex];
        const normalized = failed ? await normalizeNativePublicationError(publicationError, failed.entry.source, failed.target, 'native-batch-move-no-replace', nativeService, options.nativeReconcileHook, ownershipToken) : publicationError;
        rememberError(attachTransferContext(normalized, 'commit-target', failed?.entry.source, failed?.target));
      }
      offset += chunk.length;
    }
    if (isCancelled() && !control.error) rememberError(cancelledError());
    const unprocessed = prepared.filter(item => !preservedUnknown.has(item.temporary) && item.nativeIdentity && fs.existsSync(item.temporary));
    if (control.error || isCancelled()) {
      for (let offset = 0; offset < unprocessed.length;) {
        const cleanupChunk = takeBoundedBatch(unprocessed, offset, batchSize, item => Math.ceil(Buffer.byteLength(item.temporary) / 3) * 4 + Math.ceil(Buffer.byteLength(item.nativeIdentity) / 3) * 4);
        try {
          const results = await nativeService.deletePathsBatch(cleanupChunk.map(item => ({ path: item.temporary, identity: item.nativeIdentity })));
          const retained = existingRecoveryPaths(results.flatMap((result, index) => result.success || result.deleted === true ? [] : [result.recoveryPath, cleanupChunk[index].temporary]));
          const warnings = results.filter(result => result.deleted === true && (result.cleanupWarning === true || result.outcomeUnknown === true));
          if (warnings.length && control.error) { control.error.cleanupWarning = true; control.error.outcomeUnknown = true; control.error.deletedCleanupCount = Number(control.error.deletedCleanupCount || 0) + warnings.length; control.error.cleanupPhase = warnings.find(item => item.phase)?.phase || control.error.cleanupPhase; }
          if (retained.length && control.error) { control.error.recoveryRequired = true; control.error.recoveryPaths = [...new Set([...(control.error.recoveryPaths || []), ...retained])]; }
        } catch (cleanupError) {
          if (control.error) { const retained = cleanupError?.deleted === true ? [] : existingRecoveryPaths([cleanupError?.recoveryPath, ...cleanupChunk.map(item => item.temporary)]); if (retained.length) { control.error.recoveryRequired = true; control.error.recoveryPaths = [...new Set([...(control.error.recoveryPaths || []), ...retained])]; } if (cleanupError?.deleted === true) { control.error.cleanupWarning = true; control.error.outcomeUnknown = cleanupError.outcomeUnknown !== false; control.error.cleanupPhase = cleanupError.phase || control.error.cleanupPhase; } control.error.cleanupError = cleanupError; }
        }
        offset += cleanupChunk.length;
      }
    }
  })();
  const largePool = runPool(largeFiles, 1, async entry => {
    let reportedBytes = 0;
    const result = await copyLargeFileAtomic(entry.source, entry.destination, {
      durable,
      resumeState: options.getPartialState?.(entry),
      ...(options.onPartialState ? { onPartialState: state => options.onPartialState(entry, state) } : {}),
      isCancelled: shouldCancel,
      waitIfPaused,
      onProgress: progress => {
        const bytesDelta = Math.max(0, progress.bytesCopied - reportedBytes);
        reportedBytes = progress.bytesCopied;
        if (bytesDelta) onProgress({ entry, bytesDelta, fileCompleted: false });
      },
      ownershipToken,
    });
    if (result?.publishedIdentity?.sha256) entry.sourceIdentity.sha256 = result.publishedIdentity.sha256;
    return { progressReported: true, commitStrategy: result.commitStrategy };
  });

  await Promise.all([smallPool, largePool]);
  if (control.error) throw attachOwnershipToError(control.error, ownershipToken);
  throwIfCancelled(isCancelled);
  finalizeImplicitOwnership(ownershipToken);
  return {
    smallFilesCopied,
    largeFilesCopied,
    resumedFiles,
    peakSmallConcurrency,
    fallbackCommits,
    ownershipToken,
    ownershipSnapshot: ownershipSnapshotForToken(ownershipToken),
  };
};

const directoryOwnershipMatches = (current, expected) => Boolean(current && expected && current.kind === 'directory'
  && current.device !== '0' && current.inode !== '0' && current.device === expected.device && current.inode === expected.inode);

const quarantinedFileMatches = async (quarantine, expected) => {
  const current = await capturePathIdentity(quarantine, { digest: Boolean(expected.sha256) }).catch(() => null);
  return Boolean(current && current.kind === 'file' && current.device === expected.device && current.inode === expected.inode
    && current.size === expected.size && current.mtimeNs === expected.mtimeNs && (!expected.sha256 || current.sha256 === expected.sha256));
};

const pathExistsObject = async candidate => Boolean(await fs.promises.lstat(candidate).catch(() => null));

const restoreQuarantine = async (quarantine, original, options = {}) => {
  if (!await pathExistsObject(quarantine) || await pathExistsObject(original)) return false;
  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  try {
    if (nativeService?.nativeAvailable?.()) await publishPathNoClobber(quarantine, original, { ...options, nativePublicationService: nativeService });
    else await fs.promises.rename(quarantine, original);
    return true;
  }
  catch { return false; }
};

const removePrivateQuarantineRoot = async (privateRoot, privateIdentity) => {
  if (!await pathExistsObject(privateRoot)) return true;
  if ((await fs.promises.readdir(privateRoot).catch(() => ['unknown'])).length) return false;
  const current = await capturePathIdentity(privateRoot).catch(() => null);
  if (!directoryOwnershipMatches(current, privateIdentity)) return false;
  const final = await capturePathIdentity(privateRoot).catch(() => null);
  if (!directoryOwnershipMatches(final, privateIdentity) || (await fs.promises.readdir(privateRoot).catch(() => ['unknown'])).length) return false;
  await fs.promises.rmdir(privateRoot);
  return true;
};

const nativeDeleteQuarantine = async (quarantine, item, publication, nativeService) => {
  let nativeIdentity = publication.nativeIdentity;
  if (!nativeIdentity && typeof nativeService.inspectPath === 'function') nativeIdentity = (await nativeService.inspectPath(quarantine)).identity;
  if (!nativeIdentity) throw Object.assign(new Error('quarantine native identity unavailable'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
  if (item.identity.kind === 'directory') {
    if (typeof nativeService.deleteEmptyDirectory !== 'function') throw Object.assign(new Error('native empty-directory delete unavailable'), { code: 'FILE_PUBLICATION_SERVICE_MISSING' });
    return nativeService.deleteEmptyDirectory({ source: quarantine, identity: nativeIdentity });
  }
  const sha256 = item.identity.sha256 || await fileDigest(quarantine);
  if (typeof nativeService.compareDeleteFile === 'function') return nativeService.compareDeleteFile({ target: quarantine, sha256, size: Number(item.identity.size), identity: nativeIdentity });
  if (typeof nativeService.deletePathsBatch === 'function') {
    const [result] = await nativeService.deletePathsBatch([{ path: quarantine, identity: nativeIdentity }]);
    if (!result?.success) throw Object.assign(new Error(result?.error || 'native quarantine delete failed'), result || {}, { code: result?.code || 'PUBLISH_OWNERSHIP_CONFLICT' });
    return result;
  }
  throw Object.assign(new Error('native identity-bound delete unavailable'), { code: 'FILE_PUBLICATION_SERVICE_MISSING' });
};

const quarantineOwnedPath = async (item, options = {}) => {
  const current = await capturePathIdentity(item.path, { digest: item.identity.kind === 'file' && Boolean(item.identity.sha256) }).catch(() => null);
  const initiallyOwned = item.identity.kind === 'directory'
    ? directoryOwnershipMatches(current, item.identity)
    : identitiesMatch(current, item.identity, { destructive: true });
  if (!initiallyOwned) return { success: false, path: item.path, code: 'CLEANUP_OWNERSHIP_CONFLICT' };
  await options.beforeQuarantineMove?.(item);
  const privateRoot = path.join(path.dirname(item.path), `.photoflow-cleanup-${crypto.randomUUID()}`);
  try { await fs.promises.mkdir(privateRoot, { recursive: false, mode: 0o700 }); await fs.promises.chmod(privateRoot, 0o700).catch(() => undefined); }
  catch (error) { return { success: false, path: item.path, code: error?.code || 'CLEANUP_QUARANTINE_FAILED' }; }
  const privateIdentity = await capturePathIdentity(privateRoot);
  const quarantine = path.join(privateRoot, `item-${crypto.randomUUID()}`);
  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  let publication;
  try {
    if (nativeService?.nativeAvailable?.()) publication = await publishPathNoClobber(item.path, quarantine, { ...options, nativePublicationService: nativeService });
    else {
      if (await pathExistsObject(quarantine)) throw Object.assign(new Error('private quarantine collision'), { code: 'EEXIST' });
      await fs.promises.rename(item.path, quarantine);
      publication = { strategy: 'private-0700-portable-rename', identity: await capturePublishedIdentity(quarantine) };
    }
  }
  catch (error) {
    await removePrivateQuarantineRoot(privateRoot, privateIdentity).catch(() => undefined);
    return { success: false, path: item.path, code: error?.code || 'CLEANUP_QUARANTINE_FAILED', recoveryPath: error?.recoveryPath || (await pathExistsObject(privateRoot) ? privateRoot : undefined) };
  }
  await options.afterQuarantineMove?.({ ...item, quarantine });
  const valid = item.identity.kind === 'directory'
    ? directoryOwnershipMatches(await capturePathIdentity(quarantine).catch(() => null), item.identity) && (await fs.promises.readdir(quarantine).catch(() => ['unknown'])).length === 0
    : await quarantinedFileMatches(quarantine, item.identity);
  if (!valid) {
    const restored = await restoreQuarantine(quarantine, item.path, options);
    if (restored) await removePrivateQuarantineRoot(privateRoot, privateIdentity).catch(() => undefined);
    return { success: false, path: item.path, code: 'CLEANUP_OWNERSHIP_CONFLICT', recoveryPath: restored ? undefined : privateRoot };
  }
  try {
    if (nativeService?.nativeAvailable?.()) await nativeDeleteQuarantine(quarantine, item, publication, nativeService);
    else {
      await options.beforePortableDelete?.({ ...item, quarantine });
      const portableValid = item.identity.kind === 'directory'
        ? directoryOwnershipMatches(await capturePathIdentity(quarantine).catch(() => null), item.identity) && (await fs.promises.readdir(quarantine).catch(() => ['unknown'])).length === 0
        : await quarantinedFileMatches(quarantine, item.identity);
      if (!portableValid) return { success: false, path: item.path, code: 'CLEANUP_OWNERSHIP_CONFLICT', recoveryPath: privateRoot };
      if (item.identity.kind === 'directory') await fs.promises.rmdir(quarantine);
      else await fs.promises.unlink(quarantine);
    }
    const rootRemoved = await removePrivateQuarantineRoot(privateRoot, privateIdentity).catch(() => false);
    return { success: true, path: item.path, quarantined: true, ...(!rootRemoved ? { cleanupWarning: '隔离目录清理未完成' } : {}) };
  } catch (error) {
    if (error?.deleted === true) {
      const rootRemoved = await removePrivateQuarantineRoot(privateRoot, privateIdentity).catch(() => false);
      const cleanupWarning = [error.cleanupWarning === true ? '原生删除已完成，但持久化确认失败' : error.cleanupWarning, !rootRemoved ? '隔离目录清理未完成' : ''].filter(Boolean).join('；') || undefined;
      return {
        success: true,
        path: item.path,
        quarantined: true,
        deleted: true,
        cleanupWarning,
        outcomeUnknown: error.outcomeUnknown,
        phase: error.phase,
        originalMissing: error.originalMissing,
        recoveryPaths: [],
      };
    }
    return { success: false, path: item.path, code: error?.code || 'CLEANUP_DELETE_FAILED', recoveryPath: error?.recoveryPath || privateRoot };
  }
};

const yieldCleanupTurn = options => options.yieldTreeCleanup?.() || new Promise(resolve => setImmediate(resolve));

const buildOwnedTreeManifest = async (originalRoot, expectedItems, options = {}) => {
  const expected = new Map();
  for (let offset = 0; offset < expectedItems.length; offset += CLEANUP_TREE_BATCH_SIZE) {
    const batch = expectedItems.slice(offset, offset + CLEANUP_TREE_BATCH_SIZE);
    for (const item of batch) {
      const relative = path.relative(originalRoot, item.path);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { success: false, code: 'CLEANUP_TREE_MAPPING_CONFLICT' };
      if (expected.has(relative)) return { success: false, code: 'CLEANUP_TREE_MAPPING_COLLISION', path: item.path };
      expected.set(relative, item);
    }
    await options.onTreeManifestBatch?.({ batchSize: batch.length, processed: Math.min(offset + batch.length, expectedItems.length), total: expectedItems.length });
    await yieldCleanupTurn(options);
  }
  const manifest = [...expected.entries()];
  for (let offset = 0; offset < manifest.length; offset += CLEANUP_TREE_BATCH_SIZE) {
    const batch = manifest.slice(offset, offset + CLEANUP_TREE_BATCH_SIZE);
    for (const [relative] of batch) if (relative) {
      for (let parent = path.dirname(relative); parent && parent !== '.'; parent = path.dirname(parent)) {
        const parentItem = expected.get(parent);
        if (!parentItem || parentItem.identity?.kind !== 'directory') return { success: false, code: 'CLEANUP_TREE_PARENT_UNOWNED', path: path.join(originalRoot, parent) };
      }
    }
    await yieldCleanupTurn(options);
  }
  return { success: true, expected, manifest };
};

const inspectOwnedTree = async (treeRoot, originalRoot, expectedItems, nativeService, options = {}) => {
  const built = await buildOwnedTreeManifest(originalRoot, expectedItems, options);
  if (!built.success) return built;
  const { expected } = built;
  const seen = new Set();
  const deletionEntries = [];
  const pending = [{ candidate: treeRoot, relative: '' }];
  let processed = 0;
  while (pending.length) {
    const batch = pending.splice(0, CLEANUP_TREE_BATCH_SIZE);
    const inspected = await Promise.all(batch.map(async entry => {
      const item = expected.get(entry.relative);
      if (!item) return { ...entry, failure: { success: false, code: 'CLEANUP_TREE_EXTRA_CONTENT', path: entry.candidate } };
      const current = await capturePathIdentity(entry.candidate).catch(() => null);
      const comparableExpected = item.identity.kind === 'file' ? { ...item.identity, sha256: undefined } : item.identity;
      const matches = item.identity.kind === 'directory'
        ? directoryOwnershipMatches(current, item.identity)
        : identitiesMatch(current, comparableExpected, { destructive: true });
      if (!matches) return { ...entry, failure: { success: false, code: 'CLEANUP_TREE_IDENTITY_CONFLICT', path: entry.candidate } };
      const children = current.kind === 'directory' ? await fs.promises.readdir(entry.candidate).catch(() => null) : [];
      if (children === null) return { ...entry, failure: { success: false, code: 'CLEANUP_TREE_READ_FAILED', path: entry.candidate } };
      return { ...entry, item, current, children };
    }));
    const failure = inspected.find(entry => entry.failure)?.failure;
    if (failure) return failure;
    const nativeStates = await nativeService.inspectPathsBatch(inspected.map(entry => entry.candidate)).catch(() => null);
    if (!nativeStates || nativeStates.length !== inspected.length) return { success: false, code: 'CLEANUP_TREE_NATIVE_INSPECTION_FAILED' };
    for (let index = 0; index < inspected.length; index += 1) {
      const entry = inspected[index]; const nativeState = nativeStates[index];
      if (nativeState?.success === false || typeof nativeState?.identity !== 'string' || !nativeState.identity) return { success: false, code: 'CLEANUP_TREE_NATIVE_IDENTITY_MISSING', path: entry.candidate };
      if (entry.item.identity.nativeIdentity && entry.item.identity.nativeIdentity !== nativeState.identity) return { success: false, code: 'CLEANUP_TREE_NATIVE_IDENTITY_CONFLICT', path: entry.candidate };
      seen.add(entry.relative);
      deletionEntries.push({ ...entry, nativeIdentity: nativeState.identity });
      for (const name of entry.children) pending.push({ candidate: path.join(entry.candidate, name), relative: entry.relative ? path.join(entry.relative, name) : name });
    }
    processed += inspected.length;
    await options.onTreePreflightBatch?.({ batchSize: inspected.length, processed, totalExpected: expected.size });
    await yieldCleanupTurn(options);
  }
  if (seen.size !== expected.size) return { success: false, code: 'CLEANUP_TREE_LEDGER_MISMATCH' };
  return { success: true, deletionEntries };
};

const inspectCleanupAnchorChain = async (candidate, nativeService) => {
  const target = path.resolve(candidate); const anchorRoot = path.parse(target).root; const paths = [anchorRoot]; let current = anchorRoot;
  for (const segment of path.relative(anchorRoot, target).split(path.sep).filter(Boolean)) { current = path.join(current, segment); paths.push(current); }
  const states = await nativeService.inspectPathsBatch(paths).catch(() => null);
  if (!states || states.length !== paths.length) return { success: false, code: 'CLEANUP_TREE_ANCHOR_INSPECTION_FAILED' };
  if (states.some(state => state?.success === false || state?.directory !== true || typeof state?.identity !== 'string' || !state.identity)) return { success: false, code: 'CLEANUP_TREE_ANCHOR_INSPECTION_FAILED' };
  const chain = paths.map((directory, index) => ({ path: directory, identity: states[index].identity }));
  return { success: true, anchorRoot, chain };
};

const deleteOwnedTreeEntries = async (entries, nativeService, rootEntry, privateRoot, options = {}) => {
  const outcomes = [];
  let processed = 0;
  let deletedCount = 0;
  let failedCount = 0;
  let deletedCleanupCount = 0;
  let cleanupOutcomeCount = 0;
  let cleanupOutcomeUnknown = false;
  let partialUnknown = false;
  const appendResults = (batch, results) => {
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index]; const result = results[index] || {};
      const outcome = { success: result.success === true || result.deleted === true, deleted: result.deleted === true, path: entry.candidate, relativePath: entry.relative, code: result.code, error: result.error, cleanupWarning: result.cleanupWarning, outcomeUnknown: result.outcomeUnknown, recoveryPath: result.recoveryPath, phase: result.phase };
      if (outcome.deleted) deletedCount += 1;
      if (!outcome.success) failedCount += 1;
      if (outcome.outcomeUnknown) cleanupOutcomeUnknown = true;
      if (outcome.deleted && (outcome.cleanupWarning || outcome.outcomeUnknown)) deletedCleanupCount += 1;
      if (!outcome.success || outcome.cleanupWarning || outcome.outcomeUnknown || outcome.recoveryPath) { cleanupOutcomeCount += 1; if (outcomes.length < 64) outcomes.push(outcome); }
    }
    processed += batch.length;
  };
  const runBatches = async (items, invokeBatch, measure) => {
    for (let offset = 0; offset < items.length;) {
      const batch = takeBoundedBatch(items, offset, CLEANUP_TREE_BATCH_SIZE, measure);
      let results;
      try { results = await invokeBatch(batch); }
      catch (error) {
        partialUnknown = true;
        results = batch.map(() => ({ success: false, deleted: error?.deleted === true, code: error?.code || 'CLEANUP_BATCH_FAILED', cleanupWarning: error?.cleanupWarning || '批量清理结果不确定', outcomeUnknown: true, recoveryPath: error?.recoveryPath, phase: error?.phase }));
        appendResults(batch, results); return false;
      }
      appendResults(batch, results);
      await options.onTreeDeleteBatch?.({ batchSize: batch.length, processed, total: entries.length, outcomes });
      await yieldCleanupTurn(options);
      offset += batch.length;
    }
    return true;
  };
  const files = entries.filter(entry => entry.item.identity.kind === 'file');
  const directoriesByPath = new Map(entries.filter(entry => entry.item.identity.kind === 'directory').map(entry => [physicalPathKey(entry.candidate), entry]));
  const treeParentChainFor = entry => {
    const chain = [];
    for (let current = path.dirname(entry.candidate);;) {
      const directory = directoriesByPath.get(physicalPathKey(current));
      if (!directory) return [];
      chain.push({ path: directory.candidate, identity: directory.item.identity.nativeIdentity || directory.nativeIdentity });
      if (directory === rootEntry) return chain.reverse();
      const parent = path.dirname(current); if (parent === current) return [];
      current = parent;
    }
  };
  const anchorRoot = options.cleanupAnchorRoot || rootEntry.candidate;
  const anchorChain = Array.isArray(options.cleanupAnchorChain) ? options.cleanupAnchorChain : [{ path: rootEntry.candidate, identity: rootEntry.item.identity.nativeIdentity || rootEntry.nativeIdentity }];
  const parentChainFor = entry => {
    const treeChain = treeParentChainFor(entry);
    if (!treeChain.length) return [];
    return [...anchorChain.slice(0, -1), ...treeChain];
  };
  if (files.some(entry => !entry.item.identity.sha256)) { const missing = files.filter(entry => !entry.item.identity.sha256); return { success: false, outcomes: missing.slice(0, 64).map(entry => ({ success: false, deleted: false, path: entry.candidate, relativePath: entry.relative, code: 'CLEANUP_FILE_IDENTITY_MISSING' })), cleanupOutcomeCount: missing.length, cleanupOutcomesTruncated: missing.length > 64, deletedCount: 0, deletedCleanupCount: 0 }; }
  if (files.some(entry => !parentChainFor(entry).length)) return { success: false, outcomes: [{ success: false, deleted: false, code: 'CLEANUP_TREE_PARENT_UNOWNED' }], cleanupOutcomeCount: 1, deletedCount: 0, deletedCleanupCount: 0 };
  const filesCompleted = await runBatches(files, batch => nativeService.compareDeleteFilesBatch(batch.map(entry => ({ path: entry.candidate, rootPath: anchorRoot, parentChain: parentChainFor(entry), sha256: entry.item.identity.sha256, size: entry.item.identity.size, identity: entry.item.identity.nativeIdentity || entry.nativeIdentity }))), entry => Math.ceil(Buffer.byteLength(entry.candidate) / 3) * 4 + Math.ceil(Buffer.byteLength(entry.item.identity.nativeIdentity || entry.nativeIdentity) / 3) * 4 + parentChainFor(entry).reduce((sum, directory) => sum + Math.ceil(Buffer.byteLength(directory.path) / 3) * 4 + Math.ceil(Buffer.byteLength(directory.identity) / 3) * 4, 0) + 96);
  if (filesCompleted) {
    const directoryLayers = new Map();
    for (const entry of entries.filter(candidate => candidate.item.identity.kind === 'directory')) {
      const depth = entry.relative ? entry.relative.split(path.sep).length : 0;
      if (!directoryLayers.has(depth)) directoryLayers.set(depth, []);
      directoryLayers.get(depth).push(entry);
    }
    for (const depth of [...directoryLayers.keys()].sort((left, right) => right - left)) {
      const layer = directoryLayers.get(depth);
      if (layer.includes(rootEntry)) await options.beforeQuarantinedRootDelete?.({ quarantine: rootEntry.candidate, privateRoot, entries, outcomes });
      const completed = await runBatches(layer, batch => nativeService.deleteDirectoriesBatch(batch.map(entry => ({ path: entry.candidate, rootPath: anchorRoot, parentChain: entry === rootEntry ? anchorChain.slice(0, -1) : parentChainFor(entry), identity: entry.item.identity.nativeIdentity || entry.nativeIdentity }))), entry => Math.ceil(Buffer.byteLength(entry.candidate) / 3) * 4 + Math.ceil(Buffer.byteLength(entry.item.identity.nativeIdentity || entry.nativeIdentity) / 3) * 4 + (entry === rootEntry ? anchorChain : parentChainFor(entry)).reduce((sum, directory) => sum + Buffer.byteLength(directory.path) + Buffer.byteLength(directory.identity), 0));
      if (!completed) break;
      await yieldCleanupTurn(options);
    }
  }
  return { success: failedCount === 0, outcomes, cleanupOutcomeCount, cleanupOutcomesTruncated: cleanupOutcomeCount > outcomes.length, deletedCount, deletedCleanupCount, cleanupWarning: deletedCleanupCount ? `${deletedCleanupCount}项已删除但持久化确认不确定` : cleanupOutcomeUnknown ? '批量清理结果不确定' : undefined, outcomeUnknown: cleanupOutcomeUnknown, partialUnknown, recoveryPaths: outcomes.map(outcome => outcome.recoveryPath).filter(Boolean) };
};

const quarantineOwnedTreeRoot = async (rootItem, treeItems, options = {}) => {
  const originalRoot = path.resolve(rootItem.path);
  const currentRoot = await capturePathIdentity(originalRoot).catch(() => null);
  if (!directoryOwnershipMatches(currentRoot, rootItem.identity)) return { success: false, path: originalRoot, code: 'CLEANUP_ROOT_OWNERSHIP_CONFLICT' };
  await options.beforeRootQuarantineMove?.({ ...rootItem, treeItems });
  const privateRoot = path.join(path.dirname(originalRoot), `.photoflow-cleanup-tree-${crypto.randomUUID()}`);
  try { await fs.promises.mkdir(privateRoot, { recursive: false, mode: 0o700 }); await fs.promises.chmod(privateRoot, 0o700).catch(() => undefined); }
  catch (error) { return { success: false, path: originalRoot, code: error?.code || 'CLEANUP_QUARANTINE_FAILED' }; }
  const privateIdentity = await capturePathIdentity(privateRoot);
  const quarantine = path.join(privateRoot, `tree-${crypto.randomUUID()}`);
  try {
    const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
    if (!nativeService?.nativeAvailable?.() || typeof nativeService.inspectPath !== 'function') throw publicationServiceMissingError(originalRoot);
    const inspected = await nativeService.inspectPath(originalRoot);
    if (inspected?.success === false || typeof inspected?.identity !== 'string' || !inspected.identity) throw Object.assign(new Error('publication root native identity unavailable'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
    const boundRoot = await verifyNativeOwnedPath(nativeService, originalRoot, inspected.identity);
    if (!boundRoot || !directoryOwnershipMatches(boundRoot.physicalIdentity, rootItem.identity)) throw Object.assign(new Error('publication root identity changed before quarantine'), { code: 'PUBLISH_OWNERSHIP_CONFLICT' });
    await publishPathNoClobber(originalRoot, quarantine, { ...options, nativePublicationService: nativeService });
  } catch (error) {
    const quarantineExists = await pathExistsObject(quarantine);
    if (!quarantineExists && !error?.outcomeUnknown) await removePrivateQuarantineRoot(privateRoot, privateIdentity).catch(() => undefined);
    return { success: false, path: originalRoot, code: error?.code || 'CLEANUP_QUARANTINE_FAILED', outcomeUnknown: Boolean(error?.outcomeUnknown), recoveryPath: quarantineExists || error?.outcomeUnknown ? privateRoot : undefined };
  }
  await options.afterRootQuarantineMove?.({ ...rootItem, quarantine, privateRoot, treeItems });
  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  if (typeof nativeService?.inspectPathsBatch !== 'function' || typeof nativeService?.compareDeleteFilesBatch !== 'function' || typeof nativeService?.deleteDirectoriesBatch !== 'function') {
    const restored = await restoreQuarantine(quarantine, originalRoot, options);
    if (restored) await removePrivateQuarantineRoot(privateRoot, privateIdentity).catch(() => undefined);
    return { success: false, path: originalRoot, code: 'FILE_PUBLICATION_SERVICE_MISSING', recoveryPath: restored ? undefined : privateRoot };
  }
  let proof = await inspectOwnedTree(quarantine, originalRoot, treeItems, nativeService, options);
  if (!proof.success) {
    const restored = await restoreQuarantine(quarantine, originalRoot, options);
    if (restored) await removePrivateQuarantineRoot(privateRoot, privateIdentity).catch(() => undefined);
    return { success: false, path: originalRoot, code: proof.code, conflictPath: proof.path, recoveryPath: restored ? undefined : privateRoot };
  }
  await options.beforeQuarantinedTreeDelete?.({ ...rootItem, quarantine, privateRoot, treeItems, proof });
  proof = await inspectOwnedTree(quarantine, originalRoot, treeItems, nativeService, options);
  if (!proof.success) {
    const restored = await restoreQuarantine(quarantine, originalRoot, options);
    if (restored) await removePrivateQuarantineRoot(privateRoot, privateIdentity).catch(() => undefined);
    return { success: false, path: originalRoot, code: proof.code, conflictPath: proof.path, recoveryPath: restored ? undefined : privateRoot };
  }
  const rootEntry = proof.deletionEntries.find(entry => entry.relative === '');
  const anchor = await inspectCleanupAnchorChain(quarantine, nativeService);
  if (!anchor.success) return { success: false, path: originalRoot, code: anchor.code, recoveryPath: privateRoot };
  const deletion = await deleteOwnedTreeEntries(proof.deletionEntries, nativeService, rootEntry, privateRoot, { ...options, cleanupAnchorRoot: anchor.anchorRoot, cleanupAnchorChain: anchor.chain });
  const quarantineRetained = await pathExistsObject(quarantine);
  const deletionFields = { partial: !deletion.success && (deletion.deletedCount > 0 || deletion.partialUnknown), partialUnknown: deletion.partialUnknown, deletedCount: deletion.deletedCount, deletedCleanupCount: deletion.deletedCleanupCount, cleanupWarning: deletion.cleanupWarning, outcomeUnknown: deletion.outcomeUnknown, cleanupOutcomes: deletion.outcomes, cleanupOutcomeCount: deletion.cleanupOutcomeCount, cleanupOutcomesTruncated: deletion.cleanupOutcomesTruncated, ...(deletion.partialUnknown ? { recoveryPartial: true, recoveryDescription: 'recoveryPath 仅表示仍可见的清理残留，不代表完整原树' } : {}) };
  if (!deletion.success || quarantineRetained) return { success: false, path: originalRoot, code: 'CLEANUP_TREE_PARTIAL', recoveryPath: privateRoot, recoveryPaths: [...new Set([privateRoot, ...(deletion.recoveryPaths || [])])], ...deletionFields };
  const rootRemoved = await removePrivateQuarantineRoot(privateRoot, privateIdentity).catch(() => false);
  if (!rootRemoved) return { success: false, path: originalRoot, code: 'CLEANUP_PRIVATE_ROOT_RETAINED', recoveryPath: privateRoot, recoveryPaths: [privateRoot], ...deletionFields };
  return { success: true, path: originalRoot, quarantined: true, ...deletionFields };
};

const removeCreatedPasteTargets = async (targets, options = {}) => {
  const requestedToken = String(options.ownershipToken || '');
  const requestedRoots = targets.map(target => ({ path: path.resolve(typeof target === 'string' ? target : target.path), ownershipToken: String(typeof target === 'object' ? target.ownershipToken || requestedToken : requestedToken), identity: typeof target === 'object' ? target.identity : undefined }));
  const roots = requestedRoots.filter((candidate, index) => !requestedRoots.some((other, otherIndex) => otherIndex !== index
    && (isInside(other.path, candidate.path) || physicalPathKey(other.path) === physicalPathKey(candidate.path) && otherIndex < index)));
  const outcomes = [];
  const terminalTokens = new Set();
  for (const root of roots) {
    const matchesByPath = new Map();
    for (const snapshot of cleanupOwnershipLedger.values()) for (const item of snapshot.paths.values()) {
      if (physicalPathKey(root.path) !== physicalPathKey(item.path) && !isInside(root.path, item.path)) continue;
      const key = physicalPathKey(item.path);
      if (!matchesByPath.has(key)) matchesByPath.set(key, []);
      matchesByPath.get(key).push(item);
    }
    let token = root.ownershipToken;
    if (!token) {
      const tokens = new Set([...matchesByPath.values()].flat().map(item => item.ownershipToken));
      if (tokens.size !== 1) { outcomes.push({ success: false, path: root.path, code: tokens.size ? 'CLEANUP_OWNER_AMBIGUOUS' : 'CLEANUP_UNOWNED_PATH' }); continue; }
      token = [...tokens][0];
    }
    terminalTokens.add(token);
    const selected = [];
    let conflict = null;
    for (const matches of matchesByPath.values()) {
      const item = matches.find(candidate => candidate.ownershipToken === token);
      if (!item) { conflict = { success: false, path: matches[0].path, code: 'CLEANUP_OWNER_NOT_FOUND' }; break; }
      if (matches.length !== 1) { conflict = { success: false, path: item.path, code: 'CLEANUP_SHARED_OWNER' }; break; }
      selected.push(item);
    }
    let rootItem = selected.find(item => physicalPathKey(item.path) === physicalPathKey(root.path));
    if (!rootItem && root.identity) rootItem = { path: root.path, identity: root.identity, ownershipToken: token || `snapshot-${crypto.randomUUID()}` };
    if (!rootItem) conflict ||= { success: false, path: root.path, code: matchesByPath.size ? 'CLEANUP_OWNER_NOT_FOUND' : 'CLEANUP_UNOWNED_PATH' };
    if (conflict) { outcomes.push(conflict); continue; }
    let outcome;
    if (rootItem.identity.kind === 'directory' && selected.some(item => physicalPathKey(item.path) === physicalPathKey(root.path))) {
      outcome = await quarantineOwnedTreeRoot(rootItem, selected, options);
      if (outcome.success) for (const item of selected) forgetCleanupOwnership(item.path, token);
    } else {
      outcome = await quarantineOwnedPath(rootItem, options);
      if (outcome.success) forgetCleanupOwnership(rootItem.path, token);
    }
    outcomes.push(outcome);
  }
  const recoveryPaths = [...new Set(outcomes.flatMap(item => [...(item.recoveryPaths || []), item.recoveryPath]).filter(Boolean))];
  if (requestedToken) terminalTokens.add(requestedToken);
  for (const token of terminalTokens) releaseCleanupOwnership(token);
  const deletedCleanupCount = outcomes.reduce((sum, item) => sum + Number(item.deletedCleanupCount || 0), 0);
  const cleanupOutcomeCount = outcomes.reduce((sum, item) => sum + Number(item.cleanupOutcomeCount || 0), 0);
  return { success: outcomes.every(item => item.success), outcomes: outcomes.slice(0, 64), recoveryPaths, cleanupWarning: deletedCleanupCount ? `${deletedCleanupCount}项已删除但持久化确认不确定` : undefined, outcomeUnknown: outcomes.some(item => item.outcomeUnknown), deletedCleanupCount, cleanupOutcomeCount, cleanupOutcomesTruncated: outcomes.length > 64 || outcomes.some(item => item.cleanupOutcomesTruncated), ownershipToken: requestedToken || undefined };
};

const removeOwnedPathIdentityBound = async (candidate, identity, options = {}) => {
  const resolved = path.resolve(candidate);
  if (!identity) return { success: false, path: resolved, code: 'CLEANUP_IDENTITY_MISSING' };
  return quarantineOwnedPath({ path: resolved, identity, ownershipToken: String(options.ownershipToken || '') }, options);
};

const moveFileAtomic = async (source, destination, options = {}) => {
  const ownershipToken = ownershipTokenForOptions(options);
  const sourceInfo = await assertRegularFile(source);
  const target = path.resolve(destination);
  if (options.isCancelled?.()) throw cancelledError();
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标文件已存在：${path.basename(target)}`), { code: 'EEXIST' });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    const publish = await publishPathNoClobber(sourceInfo.path, target, options);
    const publishedIdentity = { ...publish.identity, sha256: await fileDigest(target), ...(publish.nativeIdentity ? { nativeIdentity: publish.nativeIdentity } : {}) };
    rememberCleanupOwnership(target, publishedIdentity, ownershipToken);
    options.onProgress?.({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
    finalizeImplicitOwnership(ownershipToken);
    return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: false, commitStrategy: publish.strategy, publishedIdentity, ownershipToken, ownershipSnapshot: [{ path: target, identity: publishedIdentity, ownershipToken }] };
  } catch (error) {
    if (!LINK_COPY_FALLBACK_ERRORS.has(error?.code)) throw error;
  }

  const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
  if (!nativeService?.nativeAvailable?.()) {
    throw publicationServiceMissingError(sourceInfo.path);
  }
  const sourceIdentity = (await nativeService.inspectPath(sourceInfo.path)).identity;
  const staged = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-cross-volume`);
  try {
    const stagedCopy = await copyFileAtomic(sourceInfo.path, staged, { ...options, isCancelled: options.isCancelled, ownershipToken });
    const [stagedStat, sha256] = await Promise.all([fs.promises.stat(staged), fileDigest(staged)]);
    if (options.isCancelled?.()) {
      try { await nativeService.compareDeleteFile({ target: staged, sha256, size: stagedStat.size, identity: stagedCopy.nativePublishedIdentity }); }
      catch (error) { if (error?.deleted !== true) throw error; }
      throw cancelledError();
    }
    const committed = await nativeService.commitCrossVolumeFile({ source: sourceInfo.path, staged, target, sha256, size: stagedStat.size, sourceIdentity });
    releaseCleanupOwnership(ownershipToken);
    const publishedIdentity = { ...await capturePublishedIdentity(target), sha256 };
    rememberCleanupOwnership(target, publishedIdentity, ownershipToken);
    options.onProgress?.({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
    finalizeImplicitOwnership(ownershipToken);
    return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: true, commitStrategy: committed.strategy, publishedIdentity, ownershipToken, ownershipSnapshot: [{ path: target, identity: publishedIdentity, ownershipToken }] };
  } catch (error) {
    if (error?.code === CANCELLED_CODE || error?.code === 'EEXIST') throw attachOwnershipToError(error, ownershipToken);
    const targetExists = fs.existsSync(target);
    const stagedExists = fs.existsSync(staged);
    if (error?.deleted === true) { delete error.recoveryPath; error.recoveryRequired = false; error.sourceRetained = false; error.cleanupWarning = true; error.outcomeUnknown = error.outcomeUnknown !== false; }
    else if (stagedExists) error.recoveryPath = staged;
    if (targetExists && error?.deleted === true) {
      const verifiedTarget = await verifyNativeOwnedPath(nativeService, target, error.identity);
      if (verifiedTarget) {
        const publishedIdentity = { ...verifiedTarget.physicalIdentity, nativeIdentity: verifiedTarget.nativeIdentity };
        rememberCleanupOwnership(target, publishedIdentity, ownershipToken);
        options.onProgress?.({ bytesCopied: sourceInfo.stat.size, totalBytes: sourceInfo.stat.size });
        finalizeImplicitOwnership(ownershipToken);
        return { source: sourceInfo.path, destination: target, bytes: sourceInfo.stat.size, copied: true, commitStrategy: 'cross-volume-commit-cleanup-warning', publishedIdentity, sourceRetained: false, deleted: true, cleanupWarning: true, cleanupPhase: error.phase, outcomeUnknown: error.outcomeUnknown, ownershipToken, ownershipSnapshot: [{ path: target, identity: publishedIdentity, ownershipToken }] };
      }
      delete error.published; delete error.publishedIdentity; error.publishedConfirmed = false; error.publicationState = 'unknown'; error.uncertainPaths = existingRecoveryPaths([target]); error.recoveryPaths = []; error.recoveryRequired = false;
      throw attachOwnershipToError(error, ownershipToken);
    }
    if (targetExists) {
      const [verifiedRecovery, verifiedSource, verifiedTarget] = await Promise.all([verifyNativeOwnedPath(nativeService, error?.recoveryPath, sourceIdentity), verifyNativeOwnedPath(nativeService, sourceInfo.path, sourceIdentity), verifyNativeOwnedPath(nativeService, target, error?.identity)]);
      const uncertainPaths = [error?.recoveryPath && !verifiedRecovery ? error.recoveryPath : null, fs.existsSync(sourceInfo.path) && !verifiedSource ? sourceInfo.path : null, error?.identity && !verifiedTarget ? target : null];
      throw attachOwnershipToError(partialPublishError({ source: sourceInfo.path, target, identity: verifiedTarget ? { ...verifiedTarget.physicalIdentity, nativeIdentity: verifiedTarget.nativeIdentity } : undefined, cleanupError: error, strategy: 'win32-cross-volume-locked-commit', verifiedRecoveryPaths: [verifiedRecovery?.path, verifiedSource?.path].filter(Boolean), verifiedSourceRetained: Boolean(verifiedSource), uncertainPaths }), ownershipToken);
    }
    if (stagedExists) throw attachOwnershipToError(stagingRecoveryError({ source: sourceInfo.path, destination: target, staging: staged, cause: error, strategy: 'cross-volume-staging-recovery' }), ownershipToken);
    throw attachOwnershipToError(error, ownershipToken);
  }
};

const movePathAtomic = async (source, destination, options = {}) => {
  const ownershipToken = ownershipTokenForOptions(options);
  const resolvedSource = path.resolve(source);
  const target = path.resolve(destination);
  const sourceStat = await fs.promises.lstat(resolvedSource);
  if (sourceStat.isSymbolicLink()) {
    const publish = await publishPathNoClobber(resolvedSource, target, options);
    const publishedIdentity = { ...publish.identity, ...(publish.nativeIdentity ? { nativeIdentity: publish.nativeIdentity } : {}) };
    rememberCleanupOwnership(target, publishedIdentity, ownershipToken);
    finalizeImplicitOwnership(ownershipToken);
    return { source: resolvedSource, destination: target, copied: false, commitStrategy: publish.strategy, publishedIdentity, nativePublishedIdentity: publish.nativeIdentity, ownershipToken, ownershipSnapshot: [{ path: target, identity: publishedIdentity, ownershipToken }] };
  }
  if (sourceStat.isFile()) return moveFileAtomic(resolvedSource, target, { ...options, ownershipToken });
  if (!sourceStat.isDirectory()) throw new Error(`不是可移动的文件或文件夹：${path.basename(resolvedSource)}`);
  if (fs.existsSync(target)) throw Object.assign(new Error(`目标已存在：${path.basename(target)}`), { code: 'EEXIST' });

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    const publish = await publishPathNoClobber(resolvedSource, target, options);
    rememberCleanupOwnership(target, publish.identity, ownershipToken);
    finalizeImplicitOwnership(ownershipToken);
    return { source: resolvedSource, destination: target, copied: false, publishedIdentity: publish.identity, ownershipToken, ownershipSnapshot: [{ path: target, identity: publish.identity, ownershipToken }] };
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }

  // Cross-volume directories use the same planned atomic-copy pipeline as cut/paste.
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.photoflow-part`);
  const plan = [];
  let targetCommitted = false;
  let cleanupWarning = false;
  let cleanupOutcomeUnknown = false;
  let cleanupPhase;
  try {
    await collectCopyPlan(resolvedSource, temporary, plan, {
      isCancelled: options.isCancelled,
      onDiscovered: options.onDiscovered,
    });
    const nativeService = options.nativePublicationService || configuredNativePublicationService || bundledNativePublicationService;
    if (nativeService?.nativeAvailable?.()) {
      for (const entry of plan) entry.nativeSourceIdentity = (await nativeService.inspectPath(entry.source)).identity;
    }
    const totalBytes = plan.reduce((sum, entry) => sum + entry.size, 0);
    await assertDiskSpace(path.dirname(target), totalBytes);
    await copyPlannedFiles(plan, {
      destinationRoot: path.dirname(target),
      diskSpaceChecked: true,
      durable: true,
      isCancelled: options.isCancelled,
      onFileStart: options.onFileStart,
      onProgress: options.onProgress,
      ownershipToken,
    });
    throwIfCancelled(options.isCancelled || (() => false));
    await assertCopyPlanSourcesUnchanged(plan);
    await publishPathNoClobber(temporary, target, options.publishTemporaryOptions || {});
    targetCommitted = true;
    throwIfCancelled(options.isCancelled || (() => false));
    if (nativeService?.nativeAvailable?.()) {
      const completedSources = [];
      try {
        for (const entry of plan.filter(item => item.kind === 'file')) {
          throwIfCancelled(options.isCancelled || (() => false));
          const relative = path.relative(temporary, entry.destination);
          const targetFile = path.join(target, relative);
          const sha256 = await fileDigest(targetFile);
          try { await nativeService.commitTreeFile({ source: entry.source, target: targetFile, sha256, size: entry.size, identity: entry.nativeSourceIdentity }); }
          catch (error) { if (error?.deleted !== true) throw error; cleanupWarning = true; cleanupOutcomeUnknown = error.outcomeUnknown !== false; cleanupPhase = error.phase || cleanupPhase; }
          completedSources.push(entry.source);
        }
        for (const entry of plan.filter(item => item.kind === 'directory').sort((left, right) => right.source.length - left.source.length)) {
          throwIfCancelled(options.isCancelled || (() => false));
          try { await nativeService.deleteEmptyDirectory({ source: entry.source, identity: entry.nativeSourceIdentity }); }
          catch (error) { if (error?.deleted !== true) throw error; cleanupWarning = true; cleanupOutcomeUnknown = error.outcomeUnknown !== false; cleanupPhase = error.phase || cleanupPhase; }
          completedSources.push(entry.source);
        }
      } catch (cleanupError) {
        const partial = partialPublishError({ source: resolvedSource, target, identity: await capturePublishedIdentity(target), cleanupError, strategy: 'win32-cross-volume-directory-locked-commit' });
        partial.completedSourcePaths = completedSources;
        partial.remainingSourcePaths = plan.map(entry => entry.source).filter(candidate => fs.existsSync(candidate));
        throw partial;
      }
    } else throw publicationServiceMissingError(resolvedSource);
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (error?.code === PUBLISH_PARTIAL_CODE) throw error;
    if (targetCommitted) {
      const cleanupError = new Error(`目标目录已完整保存，但源清理未完成，可能存在重复内容：${error?.message || '未知错误'}`);
      cleanupError.code = SOURCE_CLEANUP_INCOMPLETE_CODE;
      cleanupError.cause = error;
      cleanupError.transferStage = 'cleanup-source';
      cleanupError.sourcePath = resolvedSource;
      cleanupError.destinationPath = target;
      throw cleanupError;
    }
    error.ownershipToken = ownershipToken;
    throw attachOwnershipToError(error, ownershipToken);
  }
  releaseCleanupOwnership(ownershipToken);
  const publishedIdentity = await capturePublishedIdentity(target);
  rememberCleanupOwnership(target, publishedIdentity, ownershipToken);
  finalizeImplicitOwnership(ownershipToken);
  return {
    source: resolvedSource,
    destination: target,
    copied: true,
    cleanupWarning,
    cleanupPhase,
    outcomeUnknown: cleanupOutcomeUnknown,
    publishedIdentity,
    ownershipToken,
    ownershipSnapshot: [{ path: target, identity: publishedIdentity, ownershipToken }],
  };
};

module.exports = {
  CANCELLED_CODE,
  PUBLISH_PARTIAL_CODE,
  SOURCE_CLEANUP_INCOMPLETE_CODE,
  sourceCleanupFailureMessage,
  DEFAULT_SMALL_FILE_CONCURRENCY,
  DEFAULT_SMALL_FILE_THRESHOLD,
  assertDiskSpace,
  assertCopyPlanSourcesUnchanged,
  assertExistingInside,
  assertInside,
  assertRegularFile,
  buildOwnedTreeManifest,
  canUseNativeFastCut,
  collectCopyPlan,
  commitTemporaryFile,
  configureNativePublicationService,
  copyFileAtomic,
  copyPlannedFiles,
  copySmallFileAtomic,
  createDestinationAllocator,
  deleteOwnedTreeEntries,
  isInside,
  moveFileAtomic,
  movePlannedFilesFast,
  movePathAtomic,
  movePathsSameVolumeBatched,
  publishPathNoClobber,
  rebaseCleanupOwnership,
  releaseCleanupOwnership,
  refreshRestoredCleanupOwnership,
  getCleanupOwnershipStats,
  removeCopiedSources,
  removeCreatedPasteTargets,
  removeOwnedPathIdentityBound,
  throwIfCancelled,
  uniqueDestination,
};
