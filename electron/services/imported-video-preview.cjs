const createImportedVideoPreviewResolver = ({ fs, path, pathExists }) => {
  const findImportedVideoPreview = async sourcePath => {
    const sourceDir = path.dirname(sourcePath);
    const sourceFolder = path.basename(sourceDir).toLocaleLowerCase();
    if (sourceFolder === 'mov_转码'.toLocaleLowerCase()) return sourcePath;
    if (sourceFolder !== 'mov') return null;

    const previewDir = path.join(path.dirname(sourceDir), 'mov_转码');
    if (!await pathExists(previewDir)) return null;
    const sourceStem = path.parse(sourcePath).name;
    const exactPath = path.join(previewDir, `${sourceStem}.mp4`);
    try {
      if ((await fs.promises.stat(exactPath)).isFile()) return exactPath;
    } catch {}

    // Re-running import preview generation keeps the previous file and adds a
    // timestamp. Prefer the newest matching result without scanning elsewhere.
    const escapedStem = sourceStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const timestampedName = new RegExp(`^${escapedStem}_\\d+\\.mp4$`, 'i');
    try {
      const entries = await fs.promises.readdir(previewDir, { withFileTypes: true });
      const candidates = await Promise.all(entries
        .filter(entry => entry.isFile() && timestampedName.test(entry.name))
        .map(async entry => {
          const previewPath = path.join(previewDir, entry.name);
          return { path: previewPath, mtimeMs: (await fs.promises.stat(previewPath)).mtimeMs };
        }));
      return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path || null;
    } catch {
      return null;
    }
  };

  return findImportedVideoPreview;
};
module.exports = { createImportedVideoPreviewResolver };
