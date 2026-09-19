const VALID_KEY = /^[a-f0-9]{24,64}$/;

const createWorkspaceStorageKeyService = ({ fs, path, crypto, databaseDir, writeLog = () => undefined }) => {
  const keys = new Map();
  const resolveRoot = root => path.resolve(root);
  const markerFor = root => path.join(resolveRoot(root), '.photoflow-workspace-id');
  const readMarker = root => {
    try {
      const value = fs.readFileSync(markerFor(root), 'utf8').trim().toLowerCase();
      if (VALID_KEY.test(value)) return value;
      const error = new Error('工作区 identity marker 内容无效');
      error.code = 'WORKSPACE_STORAGE_KEY_INVALID';
      throw error;
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  };
  const legacyKey = root => crypto.createHash('sha256').update(process.platform === 'win32' ? resolveRoot(root).toLocaleLowerCase() : resolveRoot(root)).digest('hex').slice(0, 24);
  const hasStorage = key => fs.existsSync(path.join(databaseDir, `${key}.sqlite3`)) || fs.existsSync(path.join(databaseDir, key));
  const get = root => {
    const resolved = resolveRoot(root); const cached = keys.get(resolved); if (cached) return cached;
    let key = readMarker(resolved);
    if (!key) {
      const legacy = legacyKey(resolved); key = hasStorage(legacy) ? legacy : crypto.randomUUID().replaceAll('-', '');
      try { fs.writeFileSync(markerFor(resolved), `${key}\n`, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) {
        if (error?.code !== 'EEXIST') {
          writeLog('error', 'Unable to persist stable workspace identity', { root: resolved, error: error.message || String(error) });
          throw error;
        }
        key = readMarker(resolved);
      }
    }
    keys.set(resolved, key); return key;
  };
  const getDataRootForKey = key => {
    const normalized = String(key || '').trim().toLowerCase(); if (!VALID_KEY.test(normalized)) throw new Error('Invalid workspace storage key');
    return path.join(databaseDir, normalized);
  };
  const bindForRestore = async (root, key) => {
    const resolved = resolveRoot(root); const normalized = String(key || '').trim().toLowerCase(); if (!VALID_KEY.test(normalized)) throw new Error('Invalid restore workspace storage key');
    const marker = markerFor(resolved); const markerName = path.basename(marker);
    const orphans = (await fs.promises.readdir(resolved).catch(() => [])).filter(name => name.startsWith(`${markerName}.`) && (name.endsWith('.next') || name.endsWith('.previous')));
    const formal = readMarker(resolved);
    if (!formal && orphans.length) {
      const candidates = [];
      for (const name of orphans) {
        const filePath = path.join(resolved, name); const value = await fs.promises.readFile(filePath, 'utf8').then(text => text.trim().toLowerCase(), () => '');
        if (VALID_KEY.test(value)) candidates.push({ filePath, value, next: name.endsWith('.next') });
      }
      const selected = candidates.find(item => item.next && item.value === normalized) || candidates.find(item => item.value === normalized);
      if (!selected) { const error = new Error('工作区 identity 绑定恢复文件冲突'); error.code = 'WORKSPACE_STORAGE_KEY_CONFLICT'; throw error; }
      await fs.promises.rename(selected.filePath, marker);
    }
    for (const name of orphans) await fs.promises.rm(path.join(resolved, name), { force: true });
    const current = readMarker(resolved) || keys.get(resolved) || '';
    if (current && current !== normalized && hasStorage(current)) { const error = new Error('恢复目标已绑定到包含数据的其他工作区 identity'); error.code = 'WORKSPACE_STORAGE_KEY_CONFLICT'; throw error; }
    await fs.promises.mkdir(resolved, { recursive: true });
    const temporary = `${marker}.${crypto.randomUUID()}.next`; const previous = `${marker}.${crypto.randomUUID()}.previous`;
    await fs.promises.writeFile(temporary, `${normalized}\n`, { encoding: 'utf8', flag: 'wx' });
    const temporaryHandle = await fs.promises.open(temporary, 'r+'); try { await temporaryHandle.sync().catch(error => { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error; }); } finally { await temporaryHandle.close(); }
    try {
      if (await fs.promises.lstat(marker).catch(() => null)) await fs.promises.rename(marker, previous);
      await fs.promises.rename(temporary, marker); await fs.promises.rm(previous, { force: true });
    } catch (error) {
      if (!await fs.promises.lstat(marker).catch(() => null) && await fs.promises.lstat(previous).catch(() => null)) await fs.promises.rename(previous, marker);
      throw error;
    } finally { await fs.promises.rm(temporary, { force: true }); }
    const directoryHandle = await fs.promises.open(resolved, 'r').catch(() => null);
    try { await directoryHandle?.sync().catch(error => { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error; }); } finally { await directoryHandle?.close(); }
    keys.set(resolved, normalized); return normalized;
  };
  return Object.freeze({ get, getDataRootForKey, bindForRestore, markerFor });
};

module.exports = { createWorkspaceStorageKeyService };
