const { MAX_CHANGED_PATHS } = require('../../contracts/media-sync-limits.cjs');

const scheduleSdImportedMediaUnsafe = ({
  root,
  projects,
  importedPathsByProject,
  imageExtensions,
  rawExtensions,
  videoExtensions,
  fs,
  path,
  scheduleMediaTrackingScan,
}) => {
  const pathsByProject = new Map(Object.entries(
    importedPathsByProject && typeof importedPathsByProject === 'object' ? importedPathsByProject : {},
  ).map(([name, paths]) => [String(name).toLocaleLowerCase(), Array.isArray(paths) ? paths : []]));
  const mediaExtensions = new Set([...imageExtensions, ...rawExtensions, ...videoExtensions]
    .map(extension => String(extension).toLocaleLowerCase()));
  const tasks = [];
  for (const project of projects) {
    const candidates = [...new Set((pathsByProject.get(project.name.toLocaleLowerCase()) || [])
      .map(value => path.resolve(String(value || ''))))];
    if (candidates.length === 0 || candidates.length > MAX_CHANGED_PATHS) {
      try { scheduleMediaTrackingScan(root, project.name, [], true); } catch { /* caller intentionally ignores scan scheduling failures */ }
      continue;
    }
    tasks.push((async () => {
      let importedPaths = [];
      const realProject = await fs.promises.realpath(project.path);
      for (const candidate of candidates) {
        const lexicalRelative = path.relative(project.path, candidate);
        if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) continue;
        const stat = await fs.promises.lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        const realCandidate = await fs.promises.realpath(candidate);
        const realRelative = path.relative(realProject, realCandidate);
        if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) continue;
        if (mediaExtensions.has(path.extname(realCandidate).toLocaleLowerCase())) importedPaths.push(realCandidate);
      }
      importedPaths = [...new Set(importedPaths)];
      const useFullScan = importedPaths.length === 0;
      scheduleMediaTrackingScan(root, project.name, useFullScan ? [] : importedPaths.map(importedPath => ({
        path: importedPath, eventType: 'rename', kind: 'file',
      })), useFullScan);
    })().catch(() => {
      try { scheduleMediaTrackingScan(root, project.name, [], true); } catch { /* caller intentionally ignores scan scheduling failures */ }
    }));
  }
  return Promise.allSettled(tasks);
};

const scheduleSdImportedMedia = options => {
  try { return scheduleSdImportedMediaUnsafe(options); }
  catch { return Promise.resolve([]); }
};

module.exports = { scheduleSdImportedMedia };
