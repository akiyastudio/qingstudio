const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const { loadProjectFilterRatings, PROJECT_RATING_CACHE_LIMIT } = await import(pathToFileURL(path.resolve(__dirname, '../src/features/workspace/project-rating-filter-model.ts')).href);
  const entries = Array.from({ length: 450 }, (_, index) => ({ path: `photo-${index}.jpg`, updatedAt: 1 }));
  const cache = new Map();
  const progress = [];
  let reads = 0;
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  let firstReady;
  const firstProgress = new Promise(resolve => { firstReady = resolve; });
  const options = {
    entries,
    getCachedRating: entry => cache.get(entry.path),
    cacheRating: (entry, rating) => cache.set(entry.path, rating),
    isCurrent: () => true,
    onProgress: (ratings, checked) => {
      progress.push({ ratings, checked });
      if (checked > 0) firstReady();
    },
    readBatch: async batch => {
      reads += 1;
      assert(batch.length <= 8);
      if (batch[0].path === 'photo-0.jpg') await slow;
      return { results: batch.map(entry => ({ path: entry.path, success: true, rating: 5 })) };
    },
  };
  const loading = loadProjectFilterRatings(options);
  await firstProgress;
  assert(progress.at(-1).checked > 0, 'fast batches publish even while the first batch is blocked');
  assert(!('photo-0.jpg' in progress.at(-1).ratings), 'the slow batch is still pending');
  releaseSlow();
  await loading;
  assert.equal(progress.at(-1).checked, 450);
  assert.equal(Object.keys(progress.at(-1).ratings).length, 450);
  assert(PROJECT_RATING_CACHE_LIMIT >= 450);
  const coldReads = reads;
  await loadProjectFilterRatings(options);
  assert.equal(reads, coldReads, 'repeated filtering of a >400 file folder is entirely cached');

  let current = true;
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  let requests = 0;
  let updates = 0;
  const cancelled = loadProjectFilterRatings({
    ...options, getCachedRating: () => undefined, onProgress: () => { updates += 1; },
    isCurrent: () => current,
    readBatch: async batch => { requests += 1; await blocked; return { results: batch.map(entry => ({ ...entry, success: true, rating: 1 })) }; },
  });
  current = false;
  finish();
  await cancelled;
  assert.equal(requests, 2, 'a cancelled filter admits no more batches');
  assert.equal(updates, 1, 'late results never update a different folder/filter');

  cache.clear();
  let failures = 0;
  await loadProjectFilterRatings({
    ...options, entries: entries.slice(0, 2),
    readBatch: async batch => {
      failures += 1;
      cache.set(batch[1].path, 4); // A user edit races the old read result.
      return { results: [{ path: batch[0].path, success: false, rating: 0 }, { path: batch[1].path, success: true, rating: 1 }] };
    },
  });
  assert.equal(cache.has(entries[0].path), false, 'read errors are never cached as unliked');
  assert.equal(progress.at(-1).ratings[entries[1].path], 4, 'a newer user rating beats the stale read');
  await loadProjectFilterRatings({ ...options, entries: entries.slice(0, 1), readBatch: async batch => {
    failures += 1;
    return { results: batch.map(entry => ({ path: entry.path, success: true, rating: 0 })) };
  } });
  assert.equal(failures, 2, 'failed files are retried on the next filter');
  assert.equal(cache.get(entries[0].path), 0, 'a confirmed zero rating is reusable');

  cache.clear();
  cache.set(entries[0].path, 1);
  await loadProjectFilterRatings({
    ...options, entries: entries.slice(0, 10),
    readBatch: async batch => {
      cache.set(entries[0].path, 5);
      return { results: batch.map(entry => ({ path: entry.path, success: true, rating: 0 })) };
    },
  });
  assert.equal(progress.at(-1).ratings[entries[0].path], 5, 'later snapshots preserve user edits to an already-cached file');
  await loadProjectFilterRatings({ ...options, entries: [{ ...entries[0], rating: 4 }], getCachedRating: () => 0 });
  assert.equal(progress.at(-1).ratings[entries[0].path], 4, 'an authoritative entry rating takes precedence over an older preview cache');
  console.log('project rating filter tests passed: incremental results, warm large folders, cancellation and mutation races');
})().catch(error => { console.error(error); process.exitCode = 1; });
