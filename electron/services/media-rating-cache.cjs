// Disposable metadata index. File identity is checked by the rating service on
// every lookup; this cache is never the authority for a pending rating write.
const createMediaRatingCache = ({ fs, path, cachePath = '', maxEntries = 20000, writeLog = () => undefined }) => {
  const entries = new Map();
  const touched = new Set();
  let loaded = !cachePath;
  let dirty = false;
  let timer;
  let saving = Promise.resolve();
  let sequence = 0;
  const ready = (async () => {
    if (!cachePath) return;
    try {
      const stat = await fs.promises.stat(cachePath);
      if (stat.size > 16 * 1024 * 1024) throw new Error('Media rating cache exceeds size limit');
      const document = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
      if (document.version !== 1 || !Array.isArray(document.entries)) throw new Error('Invalid media rating cache');
      for (const item of document.entries.slice(-maxEntries)) {
        if (typeof item?.key !== 'string' || typeof item.signature !== 'string'
          || !Number.isInteger(item.rating) || item.rating < 0 || item.rating > 5 || touched.has(item.key)) continue;
        entries.set(item.key, { signature: item.signature, rating: item.rating });
      }
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    } catch (error) {
      if (error.code !== 'ENOENT') writeLog('warn', 'Unable to load disposable media rating cache', { error: error.message });
    } finally {
      loaded = true;
      touched.clear();
    }
  })();
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    saving = saving.catch(() => undefined).then(async () => {
      await ready;
      if (!cachePath || !dirty) return;
      const snapshot = JSON.stringify({ version: 1, entries: [...entries].map(([key, value]) => ({ key, ...value })) });
      const temporary = `${cachePath}.tmp-${process.pid}-${++sequence}`;
      dirty = false;
      try {
        await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.promises.writeFile(temporary, snapshot, { flag: 'wx', mode: 0o600 });
        await fs.promises.rename(temporary, cachePath);
      } catch (error) {
        dirty = true;
        throw error;
      } finally {
        await fs.promises.unlink(temporary).catch(() => undefined);
      }
    });
    return saving;
  };
  const changed = key => {
    if (!loaded) touched.add(key);
    dirty = true;
    if (!cachePath || timer) return;
    timer = setTimeout(() => {
      void flush().catch(error => writeLog('warn', 'Unable to save disposable media rating cache', { error: error.message }));
    }, 1000);
    timer.unref?.();
  };
  return {
    ready,
    get: (key, signature) => {
      const entry = entries.get(key);
      if (!entry || entry.signature !== signature) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.rating;
    },
    set: (key, signature, rating) => {
      entries.delete(key);
      entries.set(key, { signature, rating });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      changed(key);
    },
    delete: key => {
      entries.delete(key);
      changed(key);
    },
    flush,
  };
};

module.exports = { createMediaRatingCache };
