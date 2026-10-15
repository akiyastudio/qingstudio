const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
let processSupervisor;
const configureProcessSupervisor = value => { processSupervisor = value; };

const ARCHIVE_EXTENSIONS = ['.zip', '.7z', '.rar', '.001', '.z01', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.tbz2', '.txz'];
const MAX_FILES = 2000;
const MAX_BYTES = 64 * 1024 ** 3;
const fail = message => { throw new Error(message); };
const safeRelative = value => {
  if (typeof value !== 'string') fail('文件路径无效');
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (!normalized || normalized.length > 1024 || /[\x00-\x1f<>:"|?*]/.test(normalized)
    || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /^\.photoflow-/i.test(part))) fail('压缩包包含不安全或不支持的文件路径');
  return normalized;
};
const isArchive = name => ARCHIVE_EXTENSIONS.includes(path.extname(name).toLowerCase());
const archiveFolderName = name => safeRelative(path.posix.basename(name.replace(/\\/g, '/'))
  .replace(/\.part\d+\.rar$/i, '').replace(/\.\d{3,}$/, '')
  .replace(/(?:\.tar)?\.(zip|7z|rar|tar|gz|bz2|xz|tgz|tbz2|txz)$/i, '') || '解压文件');
const cancelled = () => Object.assign(new Error('任务已取消'), { code: 'COMPONENT_HOST_CANCELLED' });
const checkCancelled = signal => { if (signal?.aborted) throw cancelled(); };

const enginePath = () => {
  const directory = fs.existsSync(path.join(__dirname, '../../bin/archive/7z.exe')) ? path.join(__dirname, '../../bin/archive') : path.join(process.resourcesPath || '', 'archive');
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'runtime-manifest.json'), 'utf8'));
  const crypto = require('node:crypto');
  for (const file of ['7z.exe', '7z.dll']) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex');
    if (digest !== metadata.files[file]) fail('压缩引擎校验失败，请重新安装插件');
  }
  return path.join(directory, '7z.exe');
};

async function run7z(executable, args, { cwd, signal, onProgress, listing = false } = {}) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const commandArgs = [args[0], '-sccUTF-8', '-bse2', ...args.slice(1)];
    const options = { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false };
    const managed = processSupervisor?.launch({ id: `compression-${require('node:crypto').randomUUID()}`, kind: 'compression', owner: { domain: 'compression' }, command: executable, args: commandArgs, options, windowsJob: true });
    const child = managed ? managed.child : spawn(executable, commandArgs, options);
    let stdout = '', stderr = '', failure;
    const abort = () => { if (managed) void managed.stop('compression-cancelled').catch(() => undefined); else child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (listing) {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) { failure = new Error('压缩包目录过大'); abort(); }
      } else {
        stdout = (stdout + chunk).slice(-4096);
        for (const match of chunk.matchAll(/(\d{1,3})%/g)) onProgress?.(Math.min(99, Number(match[1])));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      managed?.release();
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(cancelled());
      if (failure) return reject(failure);
      if (code !== 0) {
        const passwordError = /password|encrypted/i.test(stderr + stdout);
        return reject(Object.assign(new Error(passwordError ? '压缩包需要密码或密码不正确，请输入密码后重试' : '压缩处理失败：文件可能损坏、分卷缺失或磁盘空间不足'), { code: passwordError ? 'ARCHIVE_PASSWORD_REQUIRED' : 'ARCHIVE_ENGINE_FAILED' }));
      }
      resolve(stdout);
    });
  });
}

function parseListing(text, maxBytes = MAX_BYTES) {
  const records = [];
  let current = {};
  const finish = () => { if (Object.keys(current).length) { records.push(current); current = {}; } };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) { finish(); continue; }
    const separator = line.indexOf(' = ');
    if (separator < 1) fail('压缩包目录包含不支持的文件名称');
    const key = line.slice(0, separator), value = line.slice(separator + 3);
    if (Object.hasOwn(current, key)) fail('压缩包目录字段重复');
    current[key] = value;
  }
  finish();
  if (records.length > MAX_FILES) fail(`一次最多解压 ${MAX_FILES} 个文件和目录`);
  const identities = new Map();
  let totalBytes = 0;
  const entries = records.map(record => {
    const relativePath = safeRelative(record.Path);
    if (Object.hasOwn(record, 'Symbolic Link') || Object.hasOwn(record, 'Hard Link') || record['Alternate Stream'] === '+' || /(?:^|\s)l[rwx-]{9}/.test(record.Attributes || '')) fail('不支持解压符号链接、硬链接或备用数据流');
    const directory = record.Folder === '+' || /^D/.test(record.Attributes || '');
    const size = directory ? 0 : Number(record.Size);
    if (!Number.isSafeInteger(size) || size < 0) fail('压缩包文件大小无效');
    const identity = relativePath.toLowerCase();
    if (identities.has(identity)) fail('压缩包中存在重复或大小写冲突的文件路径');
    identities.set(identity, directory);
    totalBytes += size;
    if (totalBytes > maxBytes) fail('解压后体积超过所选上限');
    return { relativePath, directory, size, ...(record.Encrypted === '+' ? { encrypted: true } : {}) };
  });
  for (const entry of entries) {
    const parts = entry.relativePath.toLowerCase().split('/');
    for (let index = 1; index < parts.length; index++) if (identities.get(parts.slice(0, index).join('/')) === false) fail('压缩包文件和目录路径冲突');
  }
  return { entries, totalBytes };
}

async function scanOutput(root, maxBytes = MAX_BYTES) {
  const files = [], directories = [], queue = [''];
  let bytes = 0;
  const canonicalRoot = await fs.promises.realpath(root);
  for (let index = 0; index < queue.length; index++) {
    for (const item of await fs.promises.readdir(path.join(root, queue[index]), { withFileTypes: true })) {
      const relativePath = safeRelative([queue[index], item.name].filter(Boolean).join('/'));
      const absolute = path.join(root, relativePath), stat = await fs.promises.lstat(absolute);
      const canonical = await fs.promises.realpath(absolute);
      const relative = path.relative(canonicalRoot, canonical);
      if (stat.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative)) fail('解压结果包含链接或越界路径');
      if (stat.isDirectory()) { queue.push(relativePath); directories.push(relativePath); }
      else if (stat.isFile()) { files.push({ relativePath, size: stat.size }); bytes += stat.size; }
      else fail('解压结果包含不支持的文件类型');
      if (files.length + directories.length > MAX_FILES || bytes > maxBytes) fail('解压结果超过文件数量或体积上限');
    }
  }
  return { files, directories, bytes };
}

async function inspect({ executable, archive, password = '', maxBytes = MAX_BYTES, signal }) {
  const listing = await run7z(executable, ['l', '-slt', '-ba', `-p${password}`, '--', archive], { signal, listing: true });
  return parseListing(listing, maxBytes);
}

async function extract({ executable, archive, destination, password = '', maxBytes = MAX_BYTES, signal, onProgress }) {
  const passwordArg = `-p${password}`; // Empty password prevents interactive prompts in a background task.
  const manifest = await inspect({ executable, archive, password, maxBytes, signal });
  await fs.promises.mkdir(destination, { recursive: true });
  const monitor = setInterval(() => { void scanOutput(destination, maxBytes).catch(error => { monitor.failure = error; monitor.abort?.(); }); }, 1500);
  const guard = new AbortController();
  const abort = () => guard.abort(); monitor.abort = abort;
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await run7z(executable, ['x', '-y', '-aoa', '-bsp1', passwordArg, `-o${destination}`, '--', archive], { signal: guard.signal, onProgress });
    checkCancelled(signal);
    const output = await scanOutput(destination, maxBytes);
    const expected = new Map(manifest.entries.filter(item => !item.directory).map(item => [item.relativePath.toLowerCase(), item.size]));
    if (output.files.length !== expected.size || output.files.some(item => expected.get(item.relativePath.toLowerCase()) !== item.size)) fail('解压结果与压缩包目录不一致');
    return output;
  } catch (error) { throw monitor.failure || error; }
  finally { clearInterval(monitor); signal?.removeEventListener('abort', abort); }
}

async function extractMember({ executable, archive, destination, entry, password = '', signal }) {
  const member = safeRelative(entry.relativePath);
  if (entry.directory || !Number.isSafeInteger(entry.size) || entry.size < 0) fail('请选择压缩包内的文件');
  await fs.promises.mkdir(destination, { recursive: true });
  const list = path.join(destination, '..', `member-${require('node:crypto').randomUUID()}.txt`);
  await fs.promises.writeFile(list, member, 'utf8');
  const guard = new AbortController(); let failure;
  const abort = () => guard.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const monitor = setInterval(() => { void scanOutput(destination, entry.size).catch(error => { failure = error; abort(); }); }, 500);
  try {
    checkCancelled(signal);
    await run7z(executable, ['x', '-y', '-aoa', '-spd', '-scsUTF-8', `-i@${list}`, `-p${password}`, `-o${destination}`, '--', archive], { signal: guard.signal });
    checkCancelled(signal);
    const output = await scanOutput(destination, entry.size);
    if (output.files.length !== 1 || output.files[0].relativePath !== member || output.files[0].size !== entry.size) fail('包内文件解压校验失败');
    return path.join(destination, member);
  } catch (error) { throw failure || error; }
  finally { clearInterval(monitor); signal?.removeEventListener('abort', abort); await fs.promises.unlink(list).catch(() => undefined); }
}

// ZIP APPNOTE 4.3.16 / 4.4.25: the archive comment follows the EOCD record.
async function writeZipComment(archive, comment) {
  const bytes = Buffer.from(comment, 'utf8');
  const handle = await fs.promises.open(archive, 'r+');
  try {
    const { size } = await handle.stat();
    const tail = Buffer.alloc(Math.min(size, 65535 + 22));
    const start = size - tail.length;
    const { bytesRead } = await handle.read(tail, 0, tail.length, start);
    if (bytesRead !== tail.length) fail('读取 ZIP 注释区域失败');
    let footer = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { footer = start + offset; break; }
    }
    if (footer < 0) fail('ZIP 目录记录无效，无法添加注释');
    const length = Buffer.alloc(2); length.writeUInt16LE(bytes.length);
    await handle.write(length, 0, 2, footer + 20);
    await handle.truncate(footer + 22);
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, footer + 22 + written);
      if (!result.bytesWritten) fail('写入 ZIP 注释失败');
      written += result.bytesWritten;
    }
  } finally { await handle.close(); }
}

async function splitArchive(archive, destination, splitMiB, signal) {
  const { size } = await fs.promises.stat(archive), volumeBytes = splitMiB * 1024 ** 2;
  for (let offset = 0, index = 1; offset < size; offset += volumeBytes, index++) {
    checkCancelled(signal);
    await pipeline(fs.createReadStream(archive, { start: offset, end: Math.min(size, offset + volumeBytes) - 1 }), fs.createWriteStream(`${destination}.${String(index).padStart(3, '0')}`, { flags: 'wx' }), { signal });
  }
}

async function compress({ executable, source, destination, format, comment = '', level = 5, password = '', splitMiB = 0, encryptNames = true, signal, onProgress }) {
  if (!['zip', '7z'].includes(format) || ![0, 1, 3, 5, 7, 9].includes(level)) fail('压缩格式或压缩等级无效');
  if (typeof comment !== 'string' || Buffer.byteLength(comment, 'utf8') > 65535 || comment.includes('\0')) fail('压缩包注释无效或超过大小上限');
  if (format !== 'zip' && comment) fail('7z 格式不支持压缩包注释');
  if (!Number.isInteger(splitMiB) || splitMiB < 0 || splitMiB > 65536 || splitMiB > 0 && splitMiB < 1) fail('分卷大小无效');
  if (typeof password !== 'string' || password.length > 256 || /[\x00-\x1f]/.test(password)) fail('密码无效');
  const names = (await fs.promises.readdir(source)).map(safeRelative);
  if (!names.length) fail('未选择需要压缩的文件');
  const listFile = path.join(path.dirname(source), 'inputs.txt');
  await fs.promises.writeFile(listFile, names.join('\n'), 'utf8');
  const args = ['a', `-t${format}`, `-mx=${level}`, '-y', '-bsp1', '-scsUTF-8'];
  if (password) args.push(`-p${password}`, format === 'zip' ? '-mem=AES256' : `-mhe=${encryptNames ? 'on' : 'off'}`);
  const splitAfterComment = format === 'zip' && comment && splitMiB > 0;
  const archive = splitAfterComment ? path.join(path.dirname(source), 'commented-archive.zip') : destination;
  if (splitMiB && !splitAfterComment) args.push(`-v${splitMiB}m`);
  args.push(archive, `@${listFile}`);
  await run7z(executable, args, { cwd: source, signal, onProgress });
  checkCancelled(signal);
  if (format === 'zip' && comment) await writeZipComment(archive, comment);
  if (splitAfterComment) await splitArchive(archive, destination, splitMiB, signal);
  const outputDirectory = path.dirname(destination), base = path.basename(destination);
  const outputs = (await fs.promises.readdir(outputDirectory)).filter(name => name === base || name.startsWith(`${base}.`) && /^\d{3,}$/.test(name.slice(base.length + 1))).sort();
  if (!outputs.length) fail('未生成压缩文件');
  // Test the complete archive, including every volume, before publishing any bytes.
  await run7z(executable, ['t', `-p${password}`, '--', path.join(outputDirectory, outputs[0])], { signal });
  return outputs;
}
module.exports = { ARCHIVE_EXTENSIONS, MAX_FILES, MAX_BYTES, safeRelative, archiveFolderName, isArchive, checkCancelled, configureProcessSupervisor, enginePath, run7z, parseListing, scanOutput, inspect, extract, extractMember, compress };
