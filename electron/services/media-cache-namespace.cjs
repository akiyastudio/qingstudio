const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const loadOrCreateInstallationId = ({ fs, path, crypto, userDataPath }) => {
  const identityPath = path.join(userDataPath, 'installation-id');
  const read = () => {
    const value = String(fs.readFileSync(identityPath, 'utf8') || '').trim();
    if (!INSTALLATION_ID_PATTERN.test(value)) throw new Error('安装实例 ID 文件无效');
    return value.toLocaleLowerCase();
  };
  try { return read(); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(userDataPath, { recursive: true });
  const created = crypto.randomUUID().toLocaleLowerCase();
  try {
    fs.writeFileSync(identityPath, `${created}\n`, { encoding: 'utf8', flag: 'wx' });
    return created;
  } catch (error) {
    if (error?.code === 'EEXIST') return read();
    throw error;
  }
};

const resolveMediaCacheNamespace = ({ path, userDataPath, installationId, configuredDirectory }) => {
  const selectedRoot = String(configuredDirectory || '').trim();
  if (!selectedRoot) return path.resolve(userDataPath, 'media-cache');
  if (!INSTALLATION_ID_PATTERN.test(String(installationId || ''))) throw new Error('缺少有效的安装实例 ID');
  return path.resolve(selectedRoot, '.photoflow-cache', installationId.toLocaleLowerCase());
};

module.exports = { INSTALLATION_ID_PATTERN, loadOrCreateInstallationId, resolveMediaCacheNamespace };
