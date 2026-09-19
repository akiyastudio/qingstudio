const cleanupRetiredCaptureTimeCache = async ({ app, fs, path, onError = () => undefined }) => {
  const cachePath = path.join(app.getPath('userData'), 'capture-time-cache.sqlite3');
  const targets = [cachePath, `${cachePath}-wal`, `${cachePath}-shm`, `${cachePath}-journal`];
  let deletedCount = 0;
  for (const target of targets) {
    try {
      await fs.promises.unlink(target);
      deletedCount += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') try { onError('Failed to remove retired capture-time cache:', target, error); } catch { /* isolate logger failures */ }
    }
  }
  return deletedCount;
};

module.exports = { cleanupRetiredCaptureTimeCache };
