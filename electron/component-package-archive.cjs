const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');
const { uint64, zip64Extra, directoryLocation } = require('./component-zip64.cjs');

const MAX_ENTRIES = 10_000;
const IO_CHUNK_BYTES = 1024 * 1024;
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
// No product-size ceiling: ZIP64 files are bounded by exact integer arithmetic,
// streaming verification and reserved disk space, not an arbitrary MiB limit.
const MAX_ARCHIVE_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_ENTRY_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_PACKAGE_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_COMPRESSION_RATIO = 200;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 20_000;
const MAX_ARCHIVE_PATH_BYTES = 8 * 1024 * 1024;
const COMPONENT_TREE_IDENTITY_SCHEMA_VERSION = 1;
const SNAPSHOT_TOKEN = Symbol('componentArchiveSnapshot');
const activeVolumeReservations = new Map();
const volumeReservationLocks = new Map();
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  return crc >>> 0;
});

const readExact = (fd, length, position) => {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (!count) throw new Error('ZIP 文件意外结束');
    offset += count;
  }
  return buffer;
};
const fileIdentity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameFileIdentity = (left, right) => left && right && Object.keys(left).every(key => left[key] === right[key]);
const nodeIdentity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
const sameNodeIdentity = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
const closeOwnedHandle = async handle => { if (!handle) return; try { await handle.close(); } catch (error) { if (error?.code !== 'EBADF') throw error; } };
const relativeEscapes = relative => path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
const abortError = message => Object.assign(new Error(message), { name: 'AbortError' });
const cleanupBoundaryError = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const assertOperationActive = ({ signal, deadlineAt } = {}) => {
  if (signal?.aborted) throw abortError('组件包操作已取消');
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw abortError('组件包操作超时');
};
const operationOptions = options => {
  const deadlineAt = options?.deadlineAt ?? (options?.timeoutMs ? Date.now() + options.timeoutMs : undefined);
  const controller = new AbortController();
  const cancel = () => controller.abort(options?.signal?.reason || abortError('组件包操作已取消'));
  if (options?.signal?.aborted) cancel(); else options?.signal?.addEventListener('abort', cancel, { once: true });
  const timer = deadlineAt === undefined ? null : setTimeout(() => controller.abort(abortError('组件包操作超时')), Math.max(1, deadlineAt - Date.now()));
  return { signal: controller.signal, deadlineAt, cleanup() { if (timer) clearTimeout(timer); options?.signal?.removeEventListener('abort', cancel); } };
};
const existingAncestor = targetPath => {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('无法确定组件安装目标卷');
    current = parent;
  }
  return current;
};
const volumeKeyFor = async targetPath => {
  const ancestor = existingAncestor(targetPath);
  const stat = await fs.promises.stat(ancestor);
  return `${stat.dev}:${path.parse(ancestor).root.toLowerCase()}`;
};
const withVolumeReservationLock = async (key, action) => {
  const previous = volumeReservationLocks.get(key) || Promise.resolve();
  let unlock;
  const current = new Promise(resolve => { unlock = resolve; });
  volumeReservationLocks.set(key, current);
  await previous;
  try { return await action(); }
  finally { unlock(); if (volumeReservationLocks.get(key) === current) volumeReservationLocks.delete(key); }
};
const reserveComponentInstallCapacity = async (targetPath, requiredBytes) => {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new TypeError('组件安装容量预算无效');
  const ancestor = existingAncestor(targetPath);
  if (typeof fs.promises.statfs !== 'function') throw new Error('当前运行时无法检查组件安装所需磁盘空间');
  const key = await volumeKeyFor(ancestor);
  await withVolumeReservationLock(key, async () => {
    const current = activeVolumeReservations.get(key) || 0;
    const volume = await fs.promises.statfs(ancestor, { bigint: true });
    if (volume.bavail * volume.bsize < BigInt(current + requiredBytes)) throw new Error(`组件安装空间不足或同卷容量已被其他安装预留：需要 ${requiredBytes} 字节`);
    activeVolumeReservations.set(key, current + requiredBytes);
  });
  let held = requiredBytes;
  let released = false;
  return {
    get bytes() { return held; },
    async resize(nextBytes) {
      if (released) throw new Error('组件安装容量预留已释放');
      if (!Number.isSafeInteger(nextBytes) || nextBytes < 0) throw new TypeError('组件安装容量预算无效');
      await withVolumeReservationLock(key, async () => {
        const other = (activeVolumeReservations.get(key) || held) - held;
        const latest = await fs.promises.statfs(ancestor, { bigint: true });
        if (latest.bavail * latest.bsize < BigInt(other + nextBytes)) throw new Error(`组件安装空间不足或同卷容量已被其他安装预留：需要 ${nextBytes} 字节`);
        activeVolumeReservations.set(key, other + nextBytes); held = nextBytes;
      });
    },
    async release() { if (!released) await withVolumeReservationLock(key, async () => { if (released) return; const remaining = (activeVolumeReservations.get(key) || held) - held; if (remaining > 0) activeVolumeReservations.set(key, remaining); else activeVolumeReservations.delete(key); held = 0; released = true; }); },
  };
};
const assertAvailableDiskSpace = async (targetPath, requiredBytes) => {
  let existing = path.resolve(targetPath);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('无法确定组件安装目标卷');
    existing = parent;
  }
  if (typeof fs.promises.statfs !== 'function') throw new Error('当前运行时无法检查组件安装所需磁盘空间');
  const volume = await fs.promises.statfs(existing, { bigint: true });
  const available = volume.bavail * volume.bsize;
  const required = BigInt(Math.ceil(requiredBytes)) + 64n * 1024n * 1024n;
  if (available < required) throw new Error(`组件安装空间不足：至少还需要 ${requiredBytes} 字节及安全余量`);
  return true;
};
const snapshotComponentArchive = async (sourcePath, targetPath, options = {}) => {
  const { maxArchiveBytes = MAX_ARCHIVE_BYTES } = options;
  const operation = operationOptions(options);
  assertOperationActive(operation);
  const resolvedSource = path.resolve(sourcePath);
  const sourceLstat = await fs.promises.lstat(resolvedSource);
  if (!sourceLstat.isFile() || sourceLstat.isSymbolicLink()) throw new Error('组件包必须是普通文件且不能是符号链接');
  if (!Number.isSafeInteger(sourceLstat.size) || sourceLstat.size < 22 || sourceLstat.size > maxArchiveBytes) throw new Error('组件包本体大小超过安全上限');
  await assertAvailableDiskSpace(path.dirname(targetPath), sourceLstat.size);
  const handle = await fs.promises.open(resolvedSource, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let targetHandle = null;
  try {
    const before = await handle.stat();
    const identity = fileIdentity(before);
    if (!before.isFile() || !sameFileIdentity(identity, fileIdentity(sourceLstat))) throw new Error('组件包在快照前被替换或修改');
    targetHandle = await fs.promises.open(targetPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const hash = crypto.createHash('sha256');
    const digestStream = new Transform({ transform(chunk, _encoding, callback) { try { assertOperationActive(operation); hash.update(chunk); callback(null, chunk); } catch (error) { callback(error); } } });
    await pipeline(handle.createReadStream({ autoClose: false, highWaterMark: IO_CHUNK_BYTES }), digestStream, fs.createWriteStream(null, { fd: targetHandle.fd, autoClose: false, highWaterMark: IO_CHUNK_BYTES }), operation.signal ? { signal: operation.signal } : {});
    await targetHandle.sync();
    if (!sameFileIdentity(identity, fileIdentity(await handle.stat()))) throw new Error('组件包在快照期间被修改');
    const afterPath = await fs.promises.lstat(resolvedSource);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameFileIdentity(identity, fileIdentity(afterPath))) throw new Error('组件包在快照期间被替换或修改');
    const sourceSha256 = hash.digest('hex');
    const snapshotIdentity = fileIdentity(await targetHandle.stat());
    const outputHash = crypto.createHash('sha256');
    await pipeline(targetHandle.createReadStream({ autoClose: false, highWaterMark: IO_CHUNK_BYTES, start: 0, end: snapshotIdentity.size - 1 }), new Transform({ transform(chunk, _encoding, callback) { try { assertOperationActive(operation); outputHash.update(chunk); callback(); } catch (error) { callback(error); } } }), operation.signal ? { signal: operation.signal } : {});
    if (!sameFileIdentity(snapshotIdentity, fileIdentity(await targetHandle.stat())) || outputHash.digest('hex') !== sourceSha256) throw new Error('组件包快照输出内容与源文件不一致');
    const targetPathStat = await fs.promises.lstat(targetPath);
    if (!targetPathStat.isFile() || targetPathStat.isSymbolicLink() || snapshotIdentity.size !== identity.size || !sameFileIdentity(snapshotIdentity, fileIdentity(targetPathStat))) throw new Error('组件包快照输出在写入期间被替换或截断');
    return Object.freeze({ ...identity, bytes: identity.size, sha256: sourceSha256, inspectionToken: Object.freeze({ [SNAPSHOT_TOKEN]: true, archivePath: path.resolve(targetPath), identity: snapshotIdentity }) });
  } catch (error) {
    try {
      const outputStat = targetHandle ? await targetHandle.stat() : null;
      const outputIdentity = outputStat ? fileIdentity(outputStat) : null;
      const pathStat = await fs.promises.lstat(targetPath);
      if (!outputIdentity || pathStat.isSymbolicLink() || !sameFileIdentity(outputIdentity, fileIdentity(pathStat))) throw new Error('快照输出路径已被其他对象占用');
      const recoveryHash = crypto.createHash('sha256');
      await pipeline(targetHandle.createReadStream({ autoClose: false, start: 0, ...(outputStat.size ? { end: outputStat.size - 1 } : {}) }), new Transform({ transform(chunk, _encoding, callback) { recoveryHash.update(chunk); callback(); } }));
      if (!sameFileIdentity(outputIdentity, fileIdentity(await targetHandle.stat())) || !sameFileIdentity(outputIdentity, fileIdentity(await fs.promises.lstat(targetPath)))) throw new Error('快照输出在恢复收据生成期间发生变化');
      const cleanupReceipt = { path: path.resolve(targetPath), kind: 'file', nodeIdentity: nodeIdentity(outputStat), size: outputStat.size, sha256: recoveryHash.digest('hex'), mode: outputStat.mode & 0o777 };
      error.recoveryPath = cleanupReceipt.path;
      error.cleanupPendingPaths = [cleanupReceipt.path];
      error.cleanupPendingReceipts = [cleanupReceipt];
    }
    catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') { error.recoveryPath = path.resolve(targetPath); error.message = `${error.message || String(error)}；快照恢复收据生成失败，已保留路径：${cleanupError.message || String(cleanupError)}`; } }
    throw error;
  } finally { await closeOwnedHandle(targetHandle); await closeOwnedHandle(handle); operation.cleanup(); }
};
const normalizeName = value => String(value || '').normalize('NFC').replace(/\\/g, '/');
const validArchivePath = value => {
  const normalized = normalizeName(value);
  const segments = normalized.split('/');
  return Boolean(normalized && normalized.length <= 1024 && !/[\0-\x1f:]/.test(normalized) && !normalized.startsWith('/') && !/^[a-z]:/i.test(normalized)
    && !segments.some(segment => segment === '..' || segment === '.' || segment === '' || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)));
};
const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const readSmallEntry = (fd, entry, maxBytes) => {
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes + 64 * 1024) throw new Error('component.json 过大');
  const compressed = readExact(fd, entry.compressedSize, entry.dataStart);
  const value = entry.method === 0 ? compressed : entry.method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes }) : null;
  if (!value || value.length !== entry.uncompressedSize || crc32(value) !== entry.expectedCrc) throw new Error('component.json 校验失败，安装包可能已损坏');
  return value;
};

const localDataRange = (fd, archive, entry, operation) => {
  assertOperationActive(operation);
  const local = readExact(fd, 30, entry.localOffset);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP 本地条目损坏：${entry.name}`);
  const flags = local.readUInt16LE(6);
  const method = local.readUInt16LE(8);
  const crc = local.readUInt32LE(14);
  let compressedSize = local.readUInt32LE(18);
  let uncompressedSize = local.readUInt32LE(22);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const localNameBytes = readExact(fd, nameLength, entry.localOffset + 30);
  const usesZip64Sizes = compressedSize === 0xffffffff || uncompressedSize === 0xffffffff;
  if (usesZip64Sizes) {
    if (local.readUInt16LE(4) < 45) throw new Error('ZIP64 本地版本无效');
    const values = zip64Extra(readExact(fd, extraLength, entry.localOffset + 30 + nameLength), ['uncompressedSize', 'compressedSize']);
    if (compressedSize !== 0xffffffff && compressedSize !== values.compressedSize || uncompressedSize !== 0xffffffff && uncompressedSize !== values.uncompressedSize) throw new Error('ZIP64 本地大小字段不一致');
    ({ compressedSize, uncompressedSize } = values);
  }
  const localName = normalizeName(localNameBytes.toString('utf8'));
  if (!localNameBytes.equals(entry.nameBytes) || localName !== entry.name || flags !== entry.flags || method !== entry.method) throw new Error(`ZIP 本地条目与中央目录不一致：${entry.name}`);
  if (!(flags & 8) && (crc !== entry.expectedCrc || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize)) throw new Error(`ZIP 本地条目大小或校验值与中央目录不一致：${entry.name}`);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > archive.directoryOffset) throw new Error(`ZIP 条目数据越界：${entry.name}`);
  let recordEnd = dataEnd;
  if (flags & 8) {
    const available = archive.directoryOffset - dataEnd;
    const wide = usesZip64Sizes || entry.zip64Sizes;
    const length = wide ? 20 : 12;
    const descriptor = readExact(fd, Math.min(length + 4, available), dataEnd);
    const matchesAt = base => {
      if (descriptor.length < base + length || descriptor.readUInt32LE(base) !== entry.expectedCrc) return false;
      try { return (wide ? uint64(descriptor, base + 4) : descriptor.readUInt32LE(base + 4)) === entry.compressedSize && (wide ? uint64(descriptor, base + 12) : descriptor.readUInt32LE(base + 8)) === entry.uncompressedSize; }
      catch { return false; }
    };
    const unsignedMatches = matchesAt(0);
    const signedMatches = descriptor.length >= length + 4 && descriptor.readUInt32LE(0) === 0x08074b50 && matchesAt(4);
    if (!unsignedMatches && !signedMatches) throw new Error(`ZIP data descriptor 与中央目录不一致：${entry.name}`);
    recordEnd += length + (signedMatches ? 4 : 0);
    if (recordEnd > archive.directoryOffset) throw new Error(`ZIP data descriptor 越界：${entry.name}`);
  }
  return { start: entry.localOffset, dataStart, dataEnd, recordEnd };
};

const inspectComponentArchive = (archivePath, options = {}) => {
  const operation = operationOptions(options);
  assertOperationActive(operation);
  const resolved = path.resolve(archivePath);
  const archiveStat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!archiveStat?.isFile() || archiveStat.isSymbolicLink() || !Number.isSafeInteger(archiveStat.size) || archiveStat.size < 22 || archiveStat.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件不存在、不是普通文件、过小或本体大小超过安全上限');
  const archiveIdentity = fileIdentity(archiveStat);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameFileIdentity(archiveIdentity, fileIdentity(fs.fstatSync(fd)))) throw new Error('ZIP 文件在检查前被替换或修改');
    const tailLength = Math.min(archiveStat.size, 65_557);
    const tailStart = archiveStat.size - tailLength;
    const tail = readExact(fd, tailLength, tailStart);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error('ZIP 中央目录缺失或包已损坏');
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw new Error('不支持多卷 ZIP 组件包');
    const absoluteEocd = tailStart + eocd;
    const location = directoryLocation(fd, readExact, tail, eocd, absoluteEocd, { maxEntries: MAX_ENTRIES, maxDirectoryBytes: MAX_DIRECTORY_BYTES });
    const { count, size: directorySize, offset: directoryOffset } = location;
    const archive = Object.freeze({ archivePath: resolved, size: archiveStat.size, directoryOffset });
    const directory = readExact(fd, directorySize, directoryOffset);
    const entries = [];
    const files = new Set();
    const directories = new Set();
    const declaredPaths = new Set();
    const directorySpelling = new Map();
    const budgetedPaths = new Set();
    let totalPathBytes = 0;
    const accountPath = (kind, archiveName) => {
      const key = `${kind}:${archiveName.toLowerCase()}`;
      if (budgetedPaths.has(key)) return;
      budgetedPaths.add(key);
      totalPathBytes += Buffer.byteLength(archiveName, 'utf8');
      if (budgetedPaths.size > MAX_TREE_ENTRIES || totalPathBytes > MAX_ARCHIVE_PATH_BYTES) throw new Error('安装包路径及隐式目录数量超过安全上限');
    };
    let total = 0;
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
      assertOperationActive(operation);
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 条目目录损坏');
      const flags = directory.readUInt16LE(offset + 8);
      const method = directory.readUInt16LE(offset + 10);
      const expectedCrc = directory.readUInt32LE(offset + 16);
      let compressedSize = directory.readUInt32LE(offset + 20);
      let uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const externalAttributes = directory.readUInt32LE(offset + 38);
      let localOffset = directory.readUInt32LE(offset + 42);
      let disk = directory.readUInt16LE(offset + 34);
      const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
      if (!nameLength || entryEnd > directory.length) throw new Error('ZIP 条目目录越界');
      const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength);
      const originalName = nameBytes.toString('utf8');
      const isDirectory = /[\\/]$/.test(originalName);
      const name = normalizeName(originalName);
      const pathName = name.replace(/\/$/, '');
      const folded = pathName.toLowerCase();
      if (originalName.includes('\ufffd') || !validArchivePath(pathName)) throw new Error(`安装包包含不安全路径：${originalName || '(空路径)'}`);
      if (declaredPaths.has(folded)) throw new Error(`安装包包含重复或大小写冲突路径：${name}`);
      declaredPaths.add(folded);
      if (flags & 1) throw new Error(`安装包包含加密条目：${name}`);
      if (flags & ~0x080e || method === 0 && (flags & 0x0006)) throw new Error(`安装包包含不支持的 ZIP 标志：${name}`);
      if (![0, 8].includes(method)) throw new Error(`安装包包含不支持的压缩方法：${name}`);
      const unixMode = externalAttributes >>> 16;
      const unixType = unixMode & 0xf000;
      if (unixType === 0xa000) throw new Error(`安装包包含不安全的符号链接：${name}`);
      if (unixType && unixType !== 0x8000 && unixType !== 0x4000) throw new Error(`安装包包含不安全的特殊文件：${name}`);
      if (unixType === 0x4000 && !isDirectory || unixType === 0x8000 && isDirectory) throw new Error(`ZIP 条目类型与路径不一致：${name}`);
      const zip64Sizes = compressedSize === 0xffffffff || uncompressedSize === 0xffffffff;
      const required64 = [['uncompressedSize', uncompressedSize, 0xffffffff], ['compressedSize', compressedSize, 0xffffffff], ['localOffset', localOffset, 0xffffffff], ['disk', disk, 0xffff]].filter(([, value, marker]) => value === marker).map(([key]) => key);
      if (required64.length) {
        if (directory.readUInt16LE(offset + 6) < 45) throw new Error('ZIP64 中央目录版本无效');
        const values = zip64Extra(directory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength), required64);
        uncompressedSize = values.uncompressedSize ?? uncompressedSize; compressedSize = values.compressedSize ?? compressedSize;
        localOffset = values.localOffset ?? localOffset; disk = values.disk ?? disk;
      }
      if (disk !== 0) throw new Error('不支持多卷 ZIP 条目');
      if (method === 0 && compressedSize !== uncompressedSize) throw new Error(`ZIP 存储条目大小不一致：${name}`);
      if (method === 8 && uncompressedSize > Math.max(compressedSize, 1) * MAX_COMPRESSION_RATIO) throw new Error(`ZIP 条目压缩倍率超过安全上限：${name}`);
      if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`安装包条目过大：${name}`);
      total += uncompressedSize;
      if (!Number.isSafeInteger(total) || total > MAX_PACKAGE_BYTES) throw new Error('安装包展开大小超过安全上限');
      if (isDirectory && (uncompressedSize !== 0 || compressedSize !== 0 || expectedCrc !== 0 || method !== 0 || (flags & ~0x0800))) throw new Error(`ZIP 目录条目包含数据或不支持的标志：${name}`);
      const segments = pathName.split('/');
      for (let parentIndex = 1; parentIndex < segments.length; parentIndex += 1) {
        const parentName = segments.slice(0, parentIndex).join('/');
        const parent = parentName.toLowerCase();
        if (files.has(parent)) throw new Error(`安装包包含文件/目录碰撞：${name}`);
        if (directorySpelling.has(parent) && directorySpelling.get(parent) !== parentName) throw new Error(`安装包包含目录大小写冲突：${name}`);
        directories.add(parent); directorySpelling.set(parent, parentName);
        accountPath('directory', parentName);
      }
      if (isDirectory) {
        if (files.has(folded)) throw new Error(`安装包包含文件/目录碰撞：${name}`);
        if (directorySpelling.has(folded) && directorySpelling.get(folded) !== pathName) throw new Error(`安装包包含目录大小写冲突：${name}`);
        directories.add(folded); directorySpelling.set(folded, pathName);
        accountPath('directory', pathName);
      } else {
        if (files.has(folded)) throw new Error(`安装包包含重复或大小写冲突路径：${name}`);
        if (directories.has(folded)) throw new Error(`安装包包含文件/目录碰撞：${name}`);
        files.add(folded);
        accountPath('file', pathName);
      }
      if (unixMode & 0o7000) throw new Error(`安装包条目包含不安全的特殊权限位：${name}`);
      if (!Number.isSafeInteger(localOffset + 30) || localOffset < 0 || localOffset + 30 > directoryOffset) throw new Error('ZIP 本地头位置越界');
      entries.push({ name, nameBytes: Buffer.from(nameBytes), isDirectory, flags, method, expectedCrc, compressedSize, uncompressedSize, localOffset, zip64Sizes, unixMode: unixMode & 0o777 });
      offset = entryEnd;
    }
    if (offset !== directory.length) throw new Error('ZIP 中央目录条目数量不一致');
    const ranges = entries.map(entry => ({ entry, ...localDataRange(fd, archive, entry, operation) })).sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index += 1) if (ranges[index].start < ranges[index - 1].recordEnd) throw new Error(`ZIP 条目数据区域重叠：${ranges[index].entry.name}`);
    const manifests = ranges.filter(item => /(^|\/)component\.json$/i.test(item.entry.name));
    if (manifests.length !== 1) throw new Error(manifests.length ? '安装包包含多个 component.json' : '安装包中没有 component.json');
    const entriesWithOffsets = ranges.map(item => Object.freeze({ ...item.entry, nameBytes: undefined, dataStart: item.dataStart }));
    const manifestEntry = entriesWithOffsets.find(entry => entry.name === manifests[0].entry.name);
    let manifest;
    try { manifest = JSON.parse(readSmallEntry(fd, manifestEntry, MAX_MANIFEST_BYTES).toString('utf8')); }
    catch (error) { throw new Error(`component.json 无效：${error.message || String(error)}`); }
    if (options.inspectionToken) {
      const token = options.inspectionToken;
      if (!token[SNAPSHOT_TOKEN] || token.archivePath !== resolved || !sameFileIdentity(token.identity, fileIdentity(archiveStat))) throw new Error('组件检查令牌不属于当前快照');
    }
    const after = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (!after?.isFile() || after.isSymbolicLink() || !sameFileIdentity(archiveIdentity, fileIdentity(after)) || !sameFileIdentity(archiveIdentity, fileIdentity(fs.fstatSync(fd)))) throw new Error('ZIP 文件在检查期间被替换或修改');
    return Object.freeze({ archive, entries: entriesWithOffsets, manifest, manifestEntry: manifestEntry.name, totalUncompressedBytes: total, inspectionToken: options.inspectionToken || null });
  } finally { fs.closeSync(fd); operation.cleanup(); }
};

const assertSafeExtractionParents = async (targetRoot, target) => {
  const canonicalRoot = await fs.promises.realpath(targetRoot);
  const rootStat = await fs.promises.lstat(targetRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('ZIP 提取根目录不是安全的普通目录');
  const relativeParent = path.relative(targetRoot, path.dirname(target));
  if (relativeEscapes(relativeParent)) throw new Error('ZIP 条目目标路径越界');
  let current = targetRoot;
  const identities = [{ path: targetRoot, identity: nodeIdentity(rootStat), canonical: canonicalRoot }];
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = await fs.promises.lstat(current).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) {
      await fs.promises.mkdir(current, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      stat = await fs.promises.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`ZIP 条目父路径包含链接或非目录项：${current}`);
    const canonical = await fs.promises.realpath(current);
    const realRelative = path.relative(canonicalRoot, canonical);
    if (relativeEscapes(realRelative)) throw new Error('ZIP 条目父路径真实位置越界');
    identities.push({ path: current, identity: nodeIdentity(stat), canonical });
  }
  return identities;
};
const verifySafeExtractionParents = async identities => {
  for (const expected of identities) {
    const stat = await fs.promises.lstat(expected.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameNodeIdentity(expected.identity, nodeIdentity(stat)) || await fs.promises.realpath(expected.path) !== expected.canonical) throw new Error('ZIP 条目父路径在提取期间被替换');
  }
};
const extractEntry = async (archiveHandle, inspection, entry, target, actualBudget, operation) => {
  assertOperationActive(operation);
  if (entry.isDirectory) { await assertSafeExtractionParents(inspection.targetRoot, path.join(target, '.directory')); return null; }
  const parentIdentities = await assertSafeExtractionParents(inspection.targetRoot, target);
  const source = entry.compressedSize ? fs.createReadStream(null, { fd: archiveHandle.fd, autoClose: false, highWaterMark: IO_CHUNK_BYTES, start: entry.dataStart, end: entry.dataStart + entry.compressedSize - 1 }) : Readable.from([]);
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  let crc = 0xffffffff;
  const inspect = new Transform({ transform(chunk, _encoding, callback) {
    try { assertOperationActive(operation); } catch (error) { callback(error); return; }
    bytes += chunk.length;
    actualBudget.bytes += chunk.length;
    if (bytes > entry.uncompressedSize || bytes > MAX_ENTRY_BYTES || actualBudget.bytes > MAX_PACKAGE_BYTES) { callback(new Error(`ZIP 条目实际展开大小超过声明或安全上限：${entry.name}`)); return; }
    digest.update(chunk);
    if (typeof zlib.crc32 === 'function') crc = (zlib.crc32(chunk, (crc ^ 0xffffffff) >>> 0) ^ 0xffffffff) >>> 0;
    else for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    callback(null, chunk);
  } });
  const streams = [source];
  if (entry.method === 8) streams.push(zlib.createInflateRaw());
  const outputHandle = await fs.promises.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    streams.push(inspect, fs.createWriteStream(null, { fd: outputHandle.fd, autoClose: false }));
    await pipeline(streams, operation.signal ? { signal: operation.signal } : {});
    if (bytes !== entry.uncompressedSize) throw new Error(`ZIP 条目展开大小不匹配：${entry.name}`);
    if (((crc ^ 0xffffffff) >>> 0) !== entry.expectedCrc) throw new Error(`ZIP 条目 CRC-32 校验失败：${entry.name}`);
    if (process.platform !== 'win32') await outputHandle.chmod(entry.unixMode & 0o111 ? 0o755 : 0o644);
    await outputHandle.sync();
    const outputStat = await outputHandle.stat();
    const pathStat = await fs.promises.lstat(target);
    await verifySafeExtractionParents(parentIdentities);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || !sameFileIdentity(fileIdentity(outputStat), fileIdentity(pathStat))) throw new Error(`ZIP 条目输出路径在提取期间被替换：${entry.name}`);
    return { path: entry.name, kind: 'file', size: outputStat.size, sha256: digest.digest('hex'), node: nodeIdentity(outputStat), mode: outputStat.mode & 0o777 };
  } finally { await closeOwnedHandle(outputHandle); }
};

const extractComponentArchive = async (inspection, targetRoot, options = {}) => {
  const operation = operationOptions(options);
  assertOperationActive(operation);
  const currentStat = fs.lstatSync(inspection.archive.archivePath, { throwIfNoEntry: false });
  if (!currentStat?.isFile() || currentStat.isSymbolicLink() || currentStat.size !== inspection.archive.size) throw new Error('组件快照在检查后发生变化');
  if (inspection.inspectionToken && (!inspection.inspectionToken[SNAPSHOT_TOKEN] || !sameFileIdentity(inspection.inspectionToken.identity, fileIdentity(currentStat)))) throw new Error('组件检查令牌与快照不匹配');
  await assertAvailableDiskSpace(path.dirname(targetRoot), inspection.totalUncompressedBytes);
  await fs.promises.mkdir(targetRoot, { recursive: false });
  const rootIdentity = nodeIdentity(await fs.promises.lstat(targetRoot));
  const archiveHandle = await fs.promises.open(inspection.archive.archivePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (inspection.inspectionToken && !sameFileIdentity(inspection.inspectionToken.identity, fileIdentity(await archiveHandle.stat()))) throw new Error('组件快照在提取前被替换');
    const extractionInspection = { ...inspection, targetRoot };
    const actualBudget = { bytes: 0 };
    const outputReceipts = [];
    // Bounded parallelism overlaps file creation and durable writes. Drain every
    // worker before cleanup so no writer can recreate files after a failure.
    let nextEntry = 0;
    let failure = null;
    await Promise.all(Array.from({ length: Math.min(4, inspection.entries.length) }, async () => {
      while (!failure && nextEntry < inspection.entries.length) {
        const entry = inspection.entries[nextEntry++];
        try {
          const target = path.join(targetRoot, ...entry.name.replace(/\/$/, '').split('/'));
          const outputReceipt = await extractEntry(archiveHandle, extractionInspection, entry, target, actualBudget, operation);
          if (outputReceipt) outputReceipts.push(outputReceipt);
        } catch (error) { failure ||= error; }
      }
    }));
    if (failure) throw failure;
    if (inspection.inspectionToken && !sameFileIdentity(inspection.inspectionToken.identity, fileIdentity(await archiveHandle.stat()))) throw new Error('组件快照在提取期间发生变化');
    const manifestPath = path.join(targetRoot, ...inspection.manifestEntry.split('/'));
    const manifestStat = await fs.promises.stat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) throw new Error('component.json 过大或类型无效');
    let manifest;
    try { manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')); }
    catch (error) { throw new Error(`component.json 无效：${error.message || String(error)}`); }
    if (JSON.stringify(manifest) !== JSON.stringify(inspection.manifest)) throw new Error('component.json 在检查与展开之间不一致');
    const treeIdentity = await captureComponentTreeIdentity(targetRoot, operation);
    const treeFiles = new Map(treeIdentity.filter(entry => entry.kind === 'file').map(entry => [entry.path, entry]));
    if (treeFiles.size !== outputReceipts.length || outputReceipts.some(receipt => !compareComponentTreeIdentity([treeFiles.get(receipt.path)], [receipt], { includeNode: true }))) throw new Error('组件展开树与输出句柄收据不一致或包含额外文件');
    return { manifest, manifestEntry: inspection.manifestEntry, manifestPath, treeIdentity };
  } catch (error) {
    const currentRoot = await fs.promises.lstat(targetRoot).catch(() => null);
    if (currentRoot && sameNodeIdentity(rootIdentity, nodeIdentity(currentRoot)) && currentRoot.isDirectory() && !currentRoot.isSymbolicLink()) {
      const cleanupReceipt = { path: path.resolve(targetRoot), kind: 'directory', nodeIdentity: rootIdentity, treeIdentity: await captureComponentTreeIdentity(targetRoot) };
      // The host persists ownership before admitting cleanup, including retries.
      error.recoveryPath = cleanupReceipt.path;
      error.cleanupPendingPaths = [cleanupReceipt.path];
      error.cleanupPendingReceipts = [cleanupReceipt];
    }
    throw error;
  } finally { await archiveHandle.close(); operation.cleanup(); }
};

const fileDigest = async (filePath, expectedIdentity, operation = {}) => {
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameFileIdentity(expectedIdentity, fileIdentity(await handle.stat()))) throw new Error('组件文件在哈希前被替换');
    await pipeline(handle.createReadStream({ autoClose: false, highWaterMark: IO_CHUNK_BYTES }), new Transform({ transform(chunk, _encoding, callback) { try { assertOperationActive(operation); hash.update(chunk); callback(); } catch (error) { callback(error); } } }), operation.signal ? { signal: operation.signal } : {});
    if (!sameFileIdentity(expectedIdentity, fileIdentity(await handle.stat()))) throw new Error('组件文件在哈希期间发生变化');
    return hash.digest('hex');
  } finally { await handle.close(); }
};
const captureComponentTreeIdentity = async (root, options = {}) => {
  // Windows alternate data streams are not enumerable through Node's readdir.
  // This receipt covers named filesystem nodes and their primary data streams;
  // extraction prevents ADS creation by rejecting ':' and writes only inside a
  // newly owned, no-follow tree. It must not be described as an ADS inventory.
  const operation = operationOptions(options);
  const maxEntries = options.maxEntries ?? MAX_TREE_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_PACKAGE_BYTES;
  assertOperationActive(operation);
  try {
  const resolvedRoot = path.resolve(root);
  const rootStat = await fs.promises.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('组件暂存根目录类型无效');
  const canonicalRoot = await fs.promises.realpath(resolvedRoot);
  const identity = [];
  const pending = [''];
  let totalBytes = 0;
  let totalEntries = 0;
  while (pending.length) {
    assertOperationActive(operation);
    const relativeDirectory = pending.pop();
    const directory = path.join(resolvedRoot, ...relativeDirectory.split('/').filter(Boolean));
    const directoryBefore = await fs.promises.lstat(directory);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) throw new Error(`组件目录层级被替换：${relativeDirectory || '.'}`);
    const canonicalDirectory = await fs.promises.realpath(directory);
    const directoryRelative = path.relative(canonicalRoot, canonicalDirectory);
    if (relativeEscapes(directoryRelative)) throw new Error('组件目录真实路径越界');
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      assertOperationActive(operation);
      const relative = normalizeName(path.posix.join(relativeDirectory, entry.name));
      if (!validArchivePath(relative)) throw new Error(`组件目录包含不安全路径或 Windows ADS：${relative}`);
      const absolute = path.join(directory, entry.name);
      const before = await fs.promises.lstat(absolute);
      if (before.isSymbolicLink()) throw new Error(`组件目录包含符号链接：${relative}`);
      totalEntries += 1;
      if (totalEntries > maxEntries) throw new Error('组件目录条目数量超过安全上限');
      const canonicalEntry = await fs.promises.realpath(absolute);
      const realRelative = path.relative(canonicalRoot, canonicalEntry);
      if (relativeEscapes(realRelative)) throw new Error(`组件目录包含 reparse point 或真实路径越界：${relative}`);
      if (before.isDirectory()) { identity.push({ path: relative, kind: 'directory', node: nodeIdentity(before), mode: before.mode & 0o777 }); pending.push(relative); continue; }
      if (!before.isFile()) throw new Error(`组件目录包含特殊文件：${relative}`);
      totalBytes += before.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) throw new Error('组件目录字节数超过安全上限');
      const beforeIdentity = fileIdentity(before);
      const sha256 = await fileDigest(absolute, beforeIdentity, operation);
      const after = await fs.promises.lstat(absolute);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`组件文件在校验期间发生变化：${relative}`);
      identity.push({ path: relative, kind: 'file', size: after.size, sha256, node: nodeIdentity(after), mode: after.mode & 0o777 });
    }
    const directoryAfter = await fs.promises.lstat(directory);
    if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink() || !sameNodeIdentity(nodeIdentity(directoryBefore), nodeIdentity(directoryAfter))) throw new Error(`组件目录层级在遍历期间被替换：${relativeDirectory || '.'}`);
  }
  identity.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const folded = new Set();
  for (const entry of identity) { const key = entry.path.toLowerCase(); if (folded.has(key)) throw new Error(`组件目录包含重复或大小写冲突路径：${entry.path}`); folded.add(key); }
  return identity;
  } finally { operation.cleanup(); }
};
const validateComponentTreeIdentityReceipt = receipt => {
  if (!receipt || receipt.schemaVersion !== COMPONENT_TREE_IDENTITY_SCHEMA_VERSION || !Array.isArray(receipt.entries) || receipt.entries.length > MAX_TREE_ENTRIES) throw new Error('组件目录身份收据版本或结构无效');
  const seen = new Set();
  for (const entry of receipt.entries) {
    if (!entry || typeof entry !== 'object' || !validArchivePath(entry.path) || !['file', 'directory'].includes(entry.kind) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('组件目录身份收据条目无效');
    const expectedKeys = entry.kind === 'file' ? ['kind', 'mode', 'node', 'path', 'sha256', 'size'] : ['kind', 'mode', 'node', 'path'];
    if (Object.keys(entry).sort().join('\0') !== expectedKeys.join('\0') || Object.keys(entry.node || {}).sort().join('\0') !== 'birthtimeMs\0dev\0ino') throw new Error('组件目录身份收据包含未知字段');
    if (!entry.node || !['dev', 'ino', 'birthtimeMs'].every(key => typeof entry.node[key] === 'number' && Number.isFinite(entry.node[key]))) throw new Error('组件目录身份收据节点身份无效');
    if (entry.kind === 'file' && (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))) throw new Error('组件目录身份收据文件字段无效');
    if (entry.kind === 'directory' && (entry.size !== undefined || entry.sha256 !== undefined)) throw new Error('组件目录身份收据目录字段无效');
    if (seen.has(entry.path.toLowerCase())) throw new Error('组件目录身份收据包含重复路径');
    seen.add(entry.path.toLowerCase());
  }
  return receipt;
};
const compareComponentTreeIdentity = (actual, expected, { includeNode = false } = {}) => {
  const portable = entries => entries.map(entry => includeNode ? entry : (({ node: _node, ...value }) => value)(entry));
  return JSON.stringify(portable(actual)) === JSON.stringify(portable(expected));
};
const componentTreeIdentityReceipt = entries => validateComponentTreeIdentityReceipt({ schemaVersion: COMPONENT_TREE_IDENTITY_SCHEMA_VERSION, entries });
const componentSubtreeIdentity = (entries, manifestEntry) => {
  const manifestDirectory = path.posix.dirname(normalizeName(manifestEntry));
  if (manifestDirectory === '.') return entries.map(entry => ({ ...entry }));
  const prefix = `${manifestDirectory}/`;
  const subtree = entries.filter(entry => entry.path.startsWith(prefix)).map(entry => ({ ...entry, path: entry.path.slice(prefix.length) }));
  if (!subtree.length || !subtree.some(entry => entry.path === 'component.json' && entry.kind === 'file')) throw new Error('组件清单子树身份收据无效');
  return subtree;
};
const captureVerifiedComponentTreeIdentity = async (root, expected, options = {}) => {
  let actual;
  try { actual = await captureComponentTreeIdentity(root, options); }
  catch (error) { throw new Error(`组件文件在确认或复制期间发生变化：${error.message || String(error)}`); }
  if (!compareComponentTreeIdentity(actual, expected, { includeNode: options.includeNode === true })) throw new Error('组件文件在确认或复制期间发生变化');
  return actual;
};
const verifyComponentTreeIdentity = async (root, expected, options = {}) => {
  await captureVerifiedComponentTreeIdentity(root, expected, options);
  return true;
};
// Cleanup uses the original receipt. A durable caller may retry a remaining
// subset after a crash; no cleanup sidecars or secondary proof are needed.
const validateComponentCleanupReceipt = (receipt, { disposable = false } = {}) => {
  if (!receipt || !['file', 'directory'].includes(receipt.kind) || typeof receipt.path !== 'string'
    || !path.isAbsolute(receipt.path) || path.resolve(receipt.path) !== receipt.path || receipt.path.includes('\0')
    || !receipt.nodeIdentity || !['dev', 'ino', 'birthtimeMs'].every(key => Number.isFinite(receipt.nodeIdentity[key]))) throw new Error('组件清理缺少有效身份收据');
  if (receipt.kind === 'directory') { if (!disposable) componentTreeIdentityReceipt(receipt.treeIdentity); }
  else if (!Number.isSafeInteger(receipt.size) || receipt.size < 0 || !/^[a-f0-9]{64}$/.test(receipt.sha256 || '') || !Number.isInteger(receipt.mode) || receipt.mode < 0 || receipt.mode > 0o777) throw new Error('组件清理文件收据无效');
  return receipt;
};
const assertComponentCleanupPath = async (root, target) => {
  if (!root || !path.isAbsolute(root)) throw new Error('组件清理缺少受管根目录');
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relativeEscapes(relative) || relative.split(path.sep).some(part => part.includes(':'))) throw new Error('组件清理路径越过受管根目录');
  // Check existing parents, including junctions. Never follow links while deleting.
  const parents = [];
  for (let current = path.dirname(target); ; current = path.dirname(current)) {
    parents.unshift(current);
    if (current === path.parse(current).root) break;
  }
  for (const parent of parents) {
    const stat = await fs.promises.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('组件清理父目录包含链接或不是目录');
  }
  const [canonicalRoot, canonicalParent] = await Promise.all([fs.promises.realpath(resolvedRoot), fs.promises.realpath(path.dirname(target))]);
  if (relativeEscapes(path.relative(canonicalRoot, canonicalParent))) throw new Error('组件清理真实路径越界');
};
const cleanupOwnedComponentPath = async (receipt, { root, allowMissing = false, allowPartial = false, disposable = false, beforeDelete = async () => undefined, fault = async () => undefined } = {}) => {
  validateComponentCleanupReceipt(receipt, { disposable });
  await assertComponentCleanupPath(root, receipt.path);
  const readStat = target => fs.promises.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const checkNode = (stat, expected, kind) => {
    if (!stat || stat.isSymbolicLink() || !(kind === 'directory' ? stat.isDirectory() : stat.isFile()) || !sameNodeIdentity(nodeIdentity(stat), expected)) throw new Error('组件清理目标身份发生变化');
  };
  try {
    const linked = await readStat(receipt.path);
    if (!linked) {
      if (!allowMissing) throw new Error('组件清理目标缺失，尚未记录开始清理');
      return { cleaned: true, alreadyMissing: true };
    }
    checkNode(linked, receipt.nodeIdentity, receipt.kind);
    let remaining = [];
    if (receipt.kind === 'file') {
      if (linked.size !== receipt.size || (linked.mode & 0o777) !== receipt.mode || await fileDigest(receipt.path, fileIdentity(linked)) !== receipt.sha256) throw new Error('组件清理文件内容与收据不一致');
    } else {
      remaining = await captureComponentTreeIdentity(receipt.path);
      if (!disposable) {
        const expected = new Map(receipt.treeIdentity.map(entry => [entry.path, entry]));
        if ((!allowPartial && remaining.length !== expected.size) || remaining.some(entry => !compareComponentTreeIdentity([entry], [expected.get(entry.path)], { includeNode: true }))) throw new Error('组件清理剩余文件不属于原始收据');
      }
    }
    await beforeDelete();
    await fault('cleanup:before-delete', receipt);
    // Root ownership stays checked even for an empty directory.
    checkNode(await readStat(receipt.path), receipt.nodeIdentity, receipt.kind);
    if (receipt.kind === 'file') await fs.promises.unlink(receipt.path);
    else {
      for (const entry of remaining.filter(item => item.kind === 'file')) {
        const target = path.join(receipt.path, ...entry.path.split('/'));
        await assertComponentCleanupPath(root, target);
        const stat = await readStat(target);
        checkNode(stat, entry.node, 'file');
        if (stat.size !== entry.size || !disposable && await fileDigest(target, fileIdentity(stat)) !== entry.sha256) throw new Error('组件清理文件内容发生变化');
        await fs.promises.unlink(target);
        await fault('cleanup:file-deleted', { ...receipt, deletedPath: target });
      }
      for (const entry of remaining.filter(item => item.kind === 'directory').sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
        const target = path.join(receipt.path, ...entry.path.split('/'));
        await assertComponentCleanupPath(root, target);
        checkNode(await readStat(target), entry.node, 'directory');
        await fs.promises.rmdir(target);
        await fault('cleanup:directory-deleted', { ...receipt, deletedPath: target });
      }
      checkNode(await readStat(receipt.path), receipt.nodeIdentity, 'directory');
      await fs.promises.rmdir(receipt.path);
    }
    await fault('cleanup:after-delete', receipt);
    return { cleaned: true };
  } catch (error) {
    error.recoveryPath = receipt.path;
    error.cleanupPendingPaths = [receipt.path];
    error.cleanupPendingReceipts = [receipt];
    throw error;
  }
};

module.exports = {
  MAX_ENTRIES,
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_MANIFEST_BYTES,
  COMPONENT_TREE_IDENTITY_SCHEMA_VERSION,
  assertAvailableDiskSpace,
  captureComponentTreeIdentity,
  captureVerifiedComponentTreeIdentity,
  compareComponentTreeIdentity,
  cleanupOwnedComponentPath,
  validateComponentCleanupReceipt,
  componentTreeIdentityReceipt,
  componentSubtreeIdentity,
  extractComponentArchive,
  inspectComponentArchive,
  reserveComponentInstallCapacity,
  snapshotComponentArchive,
  validateComponentTreeIdentityReceipt,
  verifyComponentTreeIdentity,
};
