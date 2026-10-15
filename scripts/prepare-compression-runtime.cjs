const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const lock = require('../electron/services/compressed-files/runtime.lock.json');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function prepareRuntime() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Archive tools currently targets Windows x64.');
  const cache = path.join(repo, '.cache', 'archive-tools');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, path.basename(lock.url));
  if (!fs.existsSync(archive) || digest(archive) !== lock.sha256) {
    const response = await fetch(lock.url);
    if (!response.ok) throw new Error(`7-Zip download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== lock.sha256) throw new Error('7-Zip upstream SHA-256 mismatch');
    fs.writeFileSync(archive, bytes, { flag: 'w' });
  }
  const runtime = path.join(repo, 'electron', 'bin', 'archive');
  fs.mkdirSync(runtime, { recursive: true });
  const extractor = require('7zip-bin').path7za;
  const result = spawnSync(extractor, ['x', archive, `-o${runtime}`, '-y', '7z.exe', '7z.dll', 'License.txt', 'readme.txt'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Unable to extract the verified 7-Zip engine');
  for (const name of ['7z.exe', '7z.dll', 'License.txt']) if (!fs.statSync(path.join(runtime, name)).isFile()) throw new Error(`Missing engine file: ${name}`);
  fs.writeFileSync(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({ ...lock, files: Object.fromEntries(['7z.exe', '7z.dll', 'License.txt'].map(name => [name, digest(path.join(runtime, name))])) }, null, 2));
  console.log(`Verified 7-Zip ${lock.version} runtime ready.`);
  return runtime;
}
if (require.main === module) prepareRuntime().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareRuntime };
