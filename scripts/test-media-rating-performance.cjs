const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaRatingService } = require('../electron/services/media-rating-service.cjs');
const { createMediaRatingCache } = require('../electron/services/media-rating-cache.cjs');

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-rating-performance-'));
  const services = [];
  const service = (readRaw, extra = {}) => {
    const instance = createMediaRatingService({
      fs, path, exiftool: { readRaw }, imageExtensions: new Set(['.jpg']), rawExtensions: new Set(),
      writeLog: () => undefined, ...extra,
    });
    services.push(instance);
    return instance;
  };
  try {
    const file = path.join(root, 'photo.jpg');
    const cachePath = path.join(root, 'cache.json');
    fs.writeFileSync(file, 'photo');
    let calls = 0;
    const gate = deferred();
    const deduplicated = service(async () => { calls += 1; await gate.promise; return { 'XMP:Rating': 5 }; }, { ratingCachePath: cachePath });
    const concurrent = Array.from({ length: 24 }, () => deduplicated.read(file));
    gate.resolve();
    assert.deepEqual(await Promise.all(concurrent), Array(24).fill(5));
    assert.equal(calls, 1, 'overlapping filter and thumbnail requests share one extraction');
    await deduplicated.flushRatingCache();
    const restarted = service(async () => { calls += 1; return { 'XMP:Rating': 2 }; }, { ratingCachePath: cachePath });
    assert.equal(await restarted.read(file), 5);
    assert.equal(calls, 1, 'a restart reuses the validated index without metadata extraction');
    fs.appendFileSync(file, ' edited externally');
    assert.equal(await restarted.read(file), 2);
    assert.equal(calls, 2, 'external edits invalidate the persisted rating');

    const manyFiles = Array.from({ length: 450 }, (_, index) => {
      const name = path.join(root, `${index}.jpg`);
      fs.writeFileSync(name, 'photo');
      return name;
    });
    let running = 0;
    let peak = 0;
    let extracts = 0;
    const bounded = service(async () => {
      extracts += 1;
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setImmediate(resolve));
      running -= 1;
      return { 'XMP:Rating': 0 };
    }, { ratingCachePath: path.join(root, 'large-cache.json') });
    assert.deepEqual(await Promise.all(manyFiles.map(filePath => bounded.read(filePath))), Array(450).fill(0));
    assert.equal(peak, 6, 'all callers share a bounded extraction pool');
    await Promise.all(manyFiles.map(filePath => bounded.read(filePath)));
    assert.equal(extracts, 450, 'a folder larger than 400 files retains both zero and positive ratings');
    await bounded.flushRatingCache();
    const warm = service(async () => { throw new Error('warm reads must not extract metadata'); }, { ratingCachePath: path.join(root, 'large-cache.json') });
    await Promise.all(manyFiles.map(filePath => warm.read(filePath)));

    let attempts = 0;
    const retry = service(async () => {
      if (++attempts === 1) throw new Error('temporary failure');
      return { 'XMP:Rating': 4 };
    });
    await assert.rejects(retry.read(file), /temporary failure/);
    assert.equal(await retry.read(file), 4, 'failed reads remain retryable');

    const started = deferred();
    const finish = deferred();
    let raceReads = 0;
    const race = service(async () => {
      if (++raceReads === 1) { started.resolve(); await finish.promise; return { 'XMP:Rating': 1 }; }
      return { 'XMP:Rating': 5 };
    });
    const oldRead = race.read(file);
    await started.promise;
    race.invalidate(file);
    assert.equal(await race.read(file), 5);
    finish.resolve();
    await oldRead;
    assert.equal(await race.read(file), 5, 'an invalidated in-flight read cannot overwrite a newer rating');

    const changing = service(async () => { fs.appendFileSync(file, '!'); return { 'XMP:Rating': 3 }; }, { ratingCachePath: path.join(root, 'changed-cache.json') });
    await changing.read(file);
    await changing.flushRatingCache();
    assert.equal(fs.existsSync(path.join(root, 'changed-cache.json')), false, 'reads spanning a file edit are not persisted');

    const badCache = path.join(root, 'bad-cache.json');
    fs.writeFileSync(badCache, 'interrupted json');
    const recovered = service(async () => ({ Rating: 3 }), { ratingCachePath: badCache });
    assert.equal(await recovered.read(file), 3, 'a corrupt disposable cache never prevents a fresh scan');

    const tinyCache = createMediaRatingCache({ fs, path, cachePath: path.join(root, 'tiny.json'), maxEntries: 2 });
    await tinyCache.ready;
    tinyCache.set('a', '1', 1); tinyCache.set('b', '1', 2);
    assert.equal(tinyCache.get('a', '1'), 1);
    tinyCache.set('c', '1', 3);
    assert.equal(tinyCache.get('b', '1'), undefined, 'the least recently used entry is evicted');
    assert.equal(tinyCache.get('a', 'different revision'), undefined);
    await tinyCache.flush();
    const reloaded = createMediaRatingCache({ fs, path, cachePath: path.join(root, 'tiny.json'), maxEntries: 2 });
    reloaded.delete('a'); // An invalidation may arrive before asynchronous loading finishes.
    await reloaded.ready;
    assert.equal(reloaded.get('a', '1'), undefined);
    await reloaded.flush();
    console.log('media rating performance tests passed: 24 overlapping reads -> 1 extraction; 450 restart reads -> 0 extractions; concurrency <= 6');
  } finally {
    await Promise.all(services.map(item => item.flushRatingCache()));
    fs.rmSync(root, { recursive: true, force: true });
  }
};
run().catch(error => { console.error(error); process.exitCode = 1; });
