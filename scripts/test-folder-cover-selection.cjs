const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function run() {
  const { loadFolderCoverSelection } = await import(pathToFileURL(path.resolve(__dirname, '../src/features/workspace/folder-cover-selection-model.ts')).href);
  const entry = (relativePath, kind = 'folder') => ({ path: `C:/fixture/${relativePath}`, relativePath, name: relativePath.split('/').pop(), kind, updatedAt: 1 });
  const root = entry('root');
  const photo = relativePath => entry(relativePath, 'image');
  const a = entry('root/A'), b = entry('root/B'), c = entry('root/C'), d = entry('root/D'), e = entry('root/E');
  const a1 = photo('root/A/1.jpg'), a2 = photo('root/A/2.jpg'), a3 = photo('root/A/3.jpg');
  const b1 = photo('root/B/1.jpg'), b2 = photo('root/B/2.jpg');
  const c1 = entry('root/C/1.dng', 'raw'), d1 = photo('root/D/1.jpg');
  const load = async (tree, options = {}) => {
    const reads = [];
    const result = await loadFolderCoverSelection(root, async directory => {
      reads.push(directory.relativePath);
      const value = tree[directory.relativePath];
      if (value instanceof Error) throw value;
      return { entries: value || [], authoritative: !options.unavailable?.includes(directory.relativePath) };
    }, options.isActive, options.pendingRename);
    return { result, reads };
  };
  let { result, reads } = await load({ root: [a, b, c, d, e], 'root/A': [a1, a2, a3], 'root/B': [b1, b2], 'root/C': [c1], 'root/D': [d1] });
  assert.deepEqual(result.entries, [a1, b1, c1, d1], 'four different child folders each contribute their first photo');
  assert.equal(result.collage, true);
  assert.deepEqual(reads, ['root', 'root/A', 'root/B', 'root/C', 'root/D'], 'stop browsing once all four slots are filled');
  ({ result } = await load({ root: [a, b], 'root/A': [a1, a2, a3], 'root/B': [b1, b2] }));
  assert.deepEqual(result.entries, [a1, b1, a2, b2], 'additional rounds fill the cover evenly without repeating images');
  ({ result } = await load({ root: [a], 'root/A': [a1, a2, a3] }));
  assert.deepEqual(result.entries, [a1, a2, a3], 'fewer than four available images leave slots empty');
  const direct = photo('root/direct.jpg');
  ({ result, reads } = await load({ root: [a, direct], 'root/A': [a1] }));
  assert.deepEqual(result.entries, [direct]);
  assert.equal(result.collage, false, 'direct images retain the original single cover');
  assert.deepEqual(reads, ['root'], 'direct photos avoid descendant reads');
  const nested = entry('root/A/nested');
  const nestedPhoto = photo('root/A/nested/1.jpg');
  ({ result } = await load({ root: [a, b], 'root/A': [nested], 'root/A/nested': [nestedPhoto, a], 'root/B': [b1] }));
  assert.deepEqual(result.entries, [nestedPhoto, b1], 'deeper folders work and repeated directory identities cannot loop');
  ({ result } = await load({ root: [a, b], 'root/A': new Error('offline'), 'root/B': [b1] }));
  assert.deepEqual(result.entries, [b1], 'an inaccessible branch does not prevent other folders contributing');
  assert.equal(result.authoritative, false);
  ({ result } = await load({ root: [a], 'root/A': [] }));
  assert.deepEqual(result.entries, [], 'empty trees keep the plain folder');
  const video = entry('root/clip.mp4', 'video');
  ({ result } = await load({ root: [video, a], 'root/A': [a1] }));
  assert.deepEqual(result.entries, [a1], 'descendant photos take priority when the root has no photos');
  ({ result } = await load({ root: [video, a], 'root/A': [] }));
  assert.deepEqual(result.entries, [video], 'existing non-photo covers remain when there are no photos anywhere');
  ({ result, reads } = await load({ root: [a], 'root/A': [a1] }, { pendingRename: true }));
  assert.deepEqual(reads, ['root'], 'pending directory renames never browse predicted child paths');
  assert.equal(result.authoritative, false, 'the mounted collage survives a pending rename');
  ({ result, reads } = await load({ root: [a], 'root/A': [a1] }, { unavailable: ['root'] }));
  assert.equal(result.authoritative, false);
  assert.deepEqual(reads, ['root']);
  let active = true;
  result = await loadFolderCoverSelection(root, async directory => {
    if (directory === root) return { entries: [a, b], authoritative: true };
    active = false;
    return { entries: [a1], authoritative: true };
  }, () => active);
  assert.deepEqual(result.entries, [], 'unmounted covers stop scanning and discard late branch replies');
  console.log('Folder cover selection tests passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
