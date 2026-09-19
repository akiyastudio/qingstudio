const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INTEGRITY_SCHEMA_VERSION = 1;
const EXCLUDED_MUTABLE_FILES = new Set(['component-integrity.json']);

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const normalizeRelativeFile = value => String(value || '').replace(/\\/g, '/');
const integrityFileKey = value => process.platform === 'win32'
  ? normalizeRelativeFile(value).toLowerCase()
  : normalizeRelativeFile(value);

const sha256File = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const sha256FileAsync = filePath => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  input.on('error', reject);
  input.on('data', chunk => hash.update(chunk));
  input.on('end', () => resolve(hash.digest('hex')));
});

const listIntegrityFiles = root => {
  const resolvedRoot = path.resolve(root);
  const files = [];
  const caseFolded = new Set();
  const pending = [resolvedRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelativeFile(path.relative(resolvedRoot, absolute));
      if (entry.isSymbolicLink()) throw new Error(`组件包含不允许的符号链接：${relative}`);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`组件包含不支持的文件类型：${relative}`);
      const folded = relative.toLowerCase();
      if (caseFolded.has(folded)) throw new Error(`组件包含大小写冲突路径：${relative}`);
      caseFolded.add(folded);
      if (!EXCLUDED_MUTABLE_FILES.has(relative)) files.push(relative);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
};

const createComponentIntegrityManifest = (root, componentId, version) => ({
  schemaVersion: INTEGRITY_SCHEMA_VERSION,
  componentId: String(componentId),
  version: String(version),
  files: listIntegrityFiles(root).map(file => {
    const absolute = path.resolve(root, file);
    const stat = fs.statSync(absolute);
    return { file, sizeBytes: stat.size, sha256: sha256File(absolute) };
  }),
});

const canonicalManifest = manifest => JSON.stringify({
  schemaVersion: Number(manifest?.schemaVersion),
  componentId: String(manifest?.componentId || ''),
  version: String(manifest?.version || ''),
  files: Array.isArray(manifest?.files) ? manifest.files.map(entry => ({
    file: normalizeRelativeFile(entry?.file),
    sizeBytes: Number(entry?.sizeBytes),
    sha256: String(entry?.sha256 || '').toLowerCase(),
  })).sort((left, right) => left.file.localeCompare(right.file, 'en')) : [],
});

const validateComponentIntegrity = (root, expectedManifest, { requireLocalManifest = true } = {}) => {
  const resolvedRoot = path.resolve(root);
  const expected = JSON.parse(canonicalManifest(expectedManifest));
  if (expected.schemaVersion !== INTEGRITY_SCHEMA_VERSION || !expected.componentId || !expected.version || !expected.files.length) {
    throw new Error('组件可信完整性清单无效');
  }
  if (requireLocalManifest) {
    const localPath = path.join(resolvedRoot, 'component-integrity.json');
    if (!fs.existsSync(localPath)) throw new Error('组件缺少完整性清单');
    const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    if (canonicalManifest(local) !== canonicalManifest(expected)) throw new Error('组件完整性清单与应用内置版本不一致');
  }

  const declared = new Set();
  for (const entry of expected.files) {
    if (!entry.file || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      throw new Error(`组件完整性条目无效：${entry.file || '未命名文件'}`);
    }
    const key = integrityFileKey(entry.file);
    if (declared.has(key)) throw new Error(`组件完整性清单包含重复或大小写冲突路径：${entry.file}`);
    const absolute = path.resolve(resolvedRoot, entry.file);
    if (!isInside(resolvedRoot, absolute)) throw new Error(`组件完整性路径越界：${entry.file}`);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`组件文件不存在或类型不安全：${entry.file}`);
    if (stat.size !== entry.sizeBytes) throw new Error(`组件文件大小不匹配：${entry.file}`);
    if (sha256File(absolute).toLowerCase() !== entry.sha256) throw new Error(`组件文件 SHA-256 不匹配：${entry.file}`);
    declared.add(key);
  }
  for (const file of listIntegrityFiles(resolvedRoot)) {
    if (!declared.has(integrityFileKey(file))) throw new Error(`组件包含未声明的可执行文件：${file}`);
  }
  return true;
};

const validateComponentIntegrityAsync = async (root, expectedManifest, { requireLocalManifest = true } = {}) => {
  const resolvedRoot = path.resolve(root);
  const expected = JSON.parse(canonicalManifest(expectedManifest));
  if (expected.schemaVersion !== INTEGRITY_SCHEMA_VERSION || !expected.componentId || !expected.version || !expected.files.length) {
    throw new Error('组件可信完整性清单无效');
  }
  if (requireLocalManifest) {
    const localPath = path.join(resolvedRoot, 'component-integrity.json');
    const localText = await fs.promises.readFile(localPath, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') throw new Error('组件缺少完整性清单');
      throw error;
    });
    const local = JSON.parse(localText);
    if (canonicalManifest(local) !== canonicalManifest(expected)) throw new Error('组件完整性清单与应用内置版本不一致');
  }

  const declared = new Set();
  for (const entry of expected.files) {
    if (!entry.file || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      throw new Error(`组件完整性条目无效：${entry.file || '未命名文件'}`);
    }
    const key = integrityFileKey(entry.file);
    if (declared.has(key)) throw new Error(`组件完整性清单包含重复或大小写冲突路径：${entry.file}`);
    const absolute = path.resolve(resolvedRoot, entry.file);
    if (!isInside(resolvedRoot, absolute)) throw new Error(`组件完整性路径越界：${entry.file}`);
    const stat = await fs.promises.lstat(absolute).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`组件文件不存在或类型不安全：${entry.file}`);
    if (stat.size !== entry.sizeBytes) throw new Error(`组件文件大小不匹配：${entry.file}`);
    if ((await sha256FileAsync(absolute)).toLowerCase() !== entry.sha256) throw new Error(`组件文件 SHA-256 不匹配：${entry.file}`);
    declared.add(key);
  }
  for (const file of listIntegrityFiles(resolvedRoot)) {
    if (!declared.has(integrityFileKey(file))) throw new Error(`组件包包含未声明的可执行文件：${file}`);
  }
  return true;
};

const readPinnedComponentIntegrity = (projectRoot, fileName) => {
  const manifestPath = path.join(projectRoot, 'electron', 'plugins', fileName);
  if (!fs.existsSync(manifestPath)) throw new Error(`应用缺少组件可信完整性清单：${fileName}`);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
};

module.exports = {
  createComponentIntegrityManifest,
  listIntegrityFiles,
  readPinnedComponentIntegrity,
  sha256File,
  sha256FileAsync,
  validateComponentIntegrity,
  validateComponentIntegrityAsync,
};
