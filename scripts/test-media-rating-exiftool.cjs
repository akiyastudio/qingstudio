const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exiftool } = require('exiftool-vendored');
const { createMediaRatingService } = require('../electron/services/media-rating-service.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-rating-exiftool-'));
  const services = [];
  let extractions = 0;
  const createService = () => {
    const service = createMediaRatingService({
      fs, path, exiftool: { readRaw: (...args) => { extractions += 1; return exiftool.readRaw(...args); } },
      imageExtensions: new Set(['.png']), rawExtensions: new Set(), writeLog: () => undefined,
      ratingCachePath: path.join(root, 'rating-cache.json'),
    });
    services.push(service);
    return service;
  };
  try {
    // Generated 1x1 image fixtures only; never read the user's image library.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aip0AAAAASUVORK5CYII=', 'base64');
    const files = Array.from({ length: 48 }, (_, index) => {
      const file = path.join(root, `${index}.png`);
      fs.writeFileSync(file, png);
      return file;
    });
    await exiftool.write(files[0], { 'XMP:Rating': 4 }, { writeArgs: ['-overwrite_original'] });
    const cold = createService();
    const coldStart = performance.now();
    const coldRatings = await Promise.all(files.map(file => cold.read(file)));
    const coldMs = Math.round(performance.now() - coldStart);
    assert.deepEqual(coldRatings, [4, ...Array(47).fill(0)]);
    assert.equal(extractions, 48);
    await cold.flushRatingCache();
    const restarted = createService();
    const warmStart = performance.now();
    assert.deepEqual(await Promise.all(files.map(file => restarted.read(file))), coldRatings);
    const warmMs = Math.round(performance.now() - warmStart);
    assert.equal(extractions, 48, 'real ExifTool must not run for unchanged images after restart');
    await exiftool.write(files[0], { 'XMP:Rating': 2 }, { writeArgs: ['-overwrite_original'] });
    assert.equal(await restarted.read(files[0]), 2, 'an external metadata edit replaces the persisted rating');
    assert.equal(extractions, 49);
    console.log(`real ExifTool rating tests passed: 48 generated images, cold ${coldMs}ms, warm after restart ${warmMs}ms, external edit detected`);
  } finally {
    await Promise.all(services.map(service => service.flushRatingCache()));
    await exiftool.end();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
