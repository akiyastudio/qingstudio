const fs = require('node:fs');
const zlib = require('node:zlib');

const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const writeZip = (target, entries) => {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, raw, options = {}] of entries) {
    const nameBuffer = Buffer.from(name);
    const localNameBuffer = Buffer.from(options.localName ?? name);
    const data = Buffer.from(raw);
    const method = options.method === 8 ? 8 : 0;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    const flags = options.dataDescriptor ? 8 : (options.flags || 0);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(options.localMethod ?? method, 8);
    if (!options.dataDescriptor) {
      header.writeUInt32LE(options.localCrc ?? checksum, 14);
      header.writeUInt32LE(options.declaredCompressedSize ?? compressed.length, 18);
      header.writeUInt32LE(options.declaredSize ?? data.length, 22);
    }
    header.writeUInt16LE(localNameBuffer.length, 26);
    const descriptor = options.dataDescriptor ? Buffer.alloc(options.descriptorSignature === false ? 12 : 16) : Buffer.alloc(0);
    if (options.dataDescriptor) {
      let descriptorOffset = 0;
      if (options.descriptorSignature !== false) { descriptor.writeUInt32LE(0x08074b50); descriptorOffset = 4; }
      descriptor.writeUInt32LE(options.descriptorCrc ?? checksum, descriptorOffset);
      descriptor.writeUInt32LE(options.declaredCompressedSize ?? compressed.length, descriptorOffset + 4);
      descriptor.writeUInt32LE(options.declaredSize ?? data.length, descriptorOffset + 8);
    }
    local.push(header, localNameBuffer, compressed, descriptor);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(options.expectedCrc ?? checksum, 16);
    record.writeUInt32LE(options.declaredCompressedSize ?? compressed.length, 20);
    record.writeUInt32LE(options.declaredSize ?? data.length, 24);
    record.writeUInt16LE(nameBuffer.length, 28);
    record.writeUInt32LE(options.externalAttributes ?? 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuffer);
    offset += header.length + localNameBuffer.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(target, Buffer.concat([...local, directory, end]));
};

module.exports = { writeZip };
