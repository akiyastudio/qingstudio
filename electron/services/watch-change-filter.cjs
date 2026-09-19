const fs = require('fs');
const path = require('path');

const MEDIA_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif', '.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.mpeg', '.mpg', '.mts', '.m2ts', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']);

const snapshotStat = (stat, changedName) => ({
  kind: stat.isDirectory() ? 'directory' : 'file',
  extension: path.extname(changedName).toLocaleLowerCase(),
  size: stat.isFile() ? Number(stat.size) || 0 : undefined,
  mtimeMs: Number(stat.mtimeMs) || 0,
  ctimeMs: Number(stat.ctimeMs) || 0,
});

// A read can produce watcher notifications without changing any persistent
// file identity. Compare against the snapshot taken before the notification;
// file age is deliberately irrelevant because applications may preserve mtime.
const isNonContentMetadataChange = (root, changedName, detail, fileSystem = fs) => {
  const eventType = entryEventType(detail);
  if (eventType !== 'change') return false;
  const previous = typeof detail === 'object' && detail ? detail.previous : null;
  if (!previous) return false;
  try {
    const stat = fileSystem.statSync(path.resolve(root, changedName));
    const observed = snapshotStat(stat, changedName);
    if (previous.kind !== observed.kind) return false;
    if (observed.kind === 'directory') return true;
    return previous.size === observed.size
      && previous.mtimeMs === observed.mtimeMs
      && previous.ctimeMs === observed.ctimeMs;
  } catch {
    // A path that disappeared between notification and flush may represent a
    // real deletion. Keep it so reconciliation can repair the index.
    return false;
  }
};

const entryEventType = detail => typeof detail === 'string' ? detail : detail?.eventType === 'rename' ? 'rename' : 'change';

const recordActionableWatchEntry = (changes, knownEntries, root, changedName, eventType, fileSystem = fs) => {
  const previous = knownEntries.get(changedName);
  const existing = changes.get(changedName);
  let observed = null;
  try {
    const stat = fileSystem.statSync(path.resolve(root, changedName));
    observed = snapshotStat(stat, changedName);
    knownEntries.set(changedName, observed);
  } catch { /* deletion/offline: retain the last observed shape */ }
  changes.set(changedName, {
    eventType: existing?.eventType === 'rename' || eventType === 'rename' ? 'rename' : 'change',
    previous: existing?.previous || previous,
    previousKind: existing?.previousKind || previous?.kind || observed?.kind,
    previousExtension: existing?.previousExtension || previous?.extension || observed?.extension || path.extname(changedName).toLocaleLowerCase(),
  });
};

const forgetMissingWatchChanges = (knownEntries, root, changes) => {
  for (const change of changes || []) if (change.kind === 'missing') knownEntries.delete(path.relative(root, change.path));
};

const filterActionableWatchEntries = (root, changedEntries, fileSystem = fs) => (changedEntries || [])
  .filter(([changedName, detail]) => !isNonContentMetadataChange(root, changedName, detail, fileSystem));

const describeActionableWatchChanges = (root, changedEntries, fileSystem = fs) => (
  filterActionableWatchEntries(root, changedEntries, fileSystem).map(([changedName, detail]) => {
    const absolutePath = path.resolve(root, changedName);
    const eventType = entryEventType(detail);
    const history = typeof detail === 'object' && detail ? {
      previousKind: detail.previousKind,
      previousExtension: detail.previousExtension,
      knownMedia: detail.knownMedia === true,
    } : {};
    try {
      const stat = fileSystem.statSync(absolutePath);
      return {
        path: absolutePath, eventType, kind: stat.isDirectory() ? 'directory' : 'file',
        observedMtimeMs: Number(stat.mtimeMs) || 0, observedSize: stat.isFile() ? Number(stat.size) || 0 : undefined,
        ...history,
      };
    } catch {
      return { path: absolutePath, eventType, kind: 'missing', ...history };
    }
  })
);

const isMediaRelevantChange = change => {
  const currentExtension = path.extname(String(change?.path || '')).toLocaleLowerCase();
  const previousExtension = String(change?.previousExtension || '').toLocaleLowerCase();
  if (change?.kind === 'directory') return true;
  if (change?.kind === 'file') return MEDIA_EXTENSIONS.has(currentExtension);
  if (change?.kind !== 'missing') return false;
  if (!change.previousKind && change.knownMedia !== true) return true;
  return change.previousKind === 'directory' || change.knownMedia === true
    || MEDIA_EXTENSIONS.has(currentExtension) || MEDIA_EXTENSIONS.has(previousExtension);
};

module.exports = { describeActionableWatchChanges, filterActionableWatchEntries, forgetMissingWatchChanges, isMediaRelevantChange, isNonContentMetadataChange, recordActionableWatchEntry, MEDIA_EXTENSIONS };
