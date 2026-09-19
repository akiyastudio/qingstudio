// Bounded ZIP64 metadata decoding. File data remains in the streaming parser.
const uint64 = (buffer, offset, label = 'ZIP64') => {
  if (offset < 0 || offset + 8 > buffer.length) throw new Error(`${label} 字段越界`);
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} 超过安全整数范围`);
  return Number(value);
};
const zip64Extra = (buffer, fields) => {
  let found = null;
  for (let offset = 0; offset < buffer.length;) {
    if (offset + 4 > buffer.length) throw new Error('ZIP 扩展字段头越界');
    const id = buffer.readUInt16LE(offset); const size = buffer.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > buffer.length) throw new Error('ZIP 扩展字段越界');
    if (id === 1) {
      if (found) throw new Error('ZIP64 扩展字段重复');
      found = buffer.subarray(offset, offset + size);
    }
    offset += size;
  }
  if (!fields.length) return {};
  const expectedBytes = fields.reduce((sum, field) => sum + (field === 'disk' ? 4 : 8), 0);
  if (!found || found.length !== expectedBytes) throw new Error('ZIP64 扩展字段缺失或长度无效');
  let offset = 0; const values = {};
  for (const field of fields) { values[field] = field === 'disk' ? found.readUInt32LE(offset) : uint64(found, offset); offset += field === 'disk' ? 4 : 8; }
  return values;
};
const directoryLocation = (fd, readExact, tail, eocd, absoluteEocd, limits) => {
  const classic = { count: tail.readUInt16LE(eocd + 10), size: tail.readUInt32LE(eocd + 12), offset: tail.readUInt32LE(eocd + 16) };
  const classicDiskCount = tail.readUInt16LE(eocd + 8);
  const required = classicDiskCount === 0xffff || classic.count === 0xffff || classic.size === 0xffffffff || classic.offset === 0xffffffff;
  const locator = absoluteEocd >= 20 ? readExact(fd, 20, absoluteEocd - 20) : null;
  let result = { ...classic, end: absoluteEocd };
  if (locator?.readUInt32LE(0) === 0x07064b50) {
    if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw new Error('不支持多卷 ZIP64');
    const recordOffset = uint64(locator, 8);
    if (!Number.isSafeInteger(recordOffset + 56) || recordOffset + 56 !== absoluteEocd - 20) throw new Error('ZIP64 结束记录位置或长度无效');
    const record = readExact(fd, 56, recordOffset);
    if (record.readUInt32LE(0) !== 0x06064b50 || uint64(record, 4) !== 44 || record.readUInt16LE(14) < 45) throw new Error('ZIP64 结束记录无效');
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0 || uint64(record, 24) !== uint64(record, 32)) throw new Error('不支持多卷 ZIP64');
    result = { count: uint64(record, 32), size: uint64(record, 40), offset: uint64(record, 48), end: recordOffset };
    for (const [key, marker] of [['count', 0xffff], ['size', 0xffffffff], ['offset', 0xffffffff]]) if (classic[key] !== marker && classic[key] !== result[key]) throw new Error('ZIP32 与 ZIP64 结束记录不一致');
  } else if (required) throw new Error('ZIP64 定位记录缺失');
  if (classicDiskCount !== 0xffff && classicDiskCount !== result.count) throw new Error('不支持多卷 ZIP 条目数量');
  if (!result.count || result.count > limits.maxEntries || result.size > limits.maxDirectoryBytes || !Number.isSafeInteger(result.offset + result.size) || result.offset + result.size !== result.end) throw new Error('ZIP 中央目录越界或包已损坏');
  return result;
};
const componentInstallTimeoutMs = (archiveBytes, expandedBytes = 0) => Math.min(4 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, Math.ceil((archiveBytes / 1048576 * 3 + expandedBytes / 1048576 * 8) / 10) * 1000));
module.exports = { uint64, zip64Extra, directoryLocation, componentInstallTimeoutMs };
