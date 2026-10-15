const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('../electron/services/compressed-files/engine.cjs');

async function run() {
  for (const bad of ['../escape', '/absolute', 'C:/escape', 'file:stream', 'CON.txt', 'path/trailing.', 'path\nname', '.photoflow-cache/file', 'x/./y']) assert.throws(() => engine.safeRelative(bad));
  assert.equal(engine.safeRelative('中文/照片.jpg'), '中文/照片.jpg');
  const listing = (name, size = 4, extra = '') => `Path = ${name}\nSize = ${size}\nFolder = -\n${extra}\n`;
  assert.throws(() => engine.parseListing(listing('../escape')));
  assert.throws(() => engine.parseListing(listing('same') + listing('SAME')));
  assert.throws(() => engine.parseListing(listing('link', 4, 'Symbolic Link = ../outside')));
  assert.throws(() => engine.parseListing(listing('large', 99), 10));
  assert.throws(() => engine.parseListing(listing('root') + listing('root/child')));
  const executable = engine.enginePath();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-archive-engine-'));
  try {
    const source = path.join(root, 'inputs');
    fs.mkdirSync(path.join(source, '中文目录', '空目录'), { recursive: true });
    fs.writeFileSync(path.join(source, '中文目录', 'hello.txt'), 'Hello 中文\n'.repeat(1000));
    fs.writeFileSync(path.join(source, 'random.bin'), crypto.randomBytes(3 * 1024 * 1024));
    for (const format of ['zip', '7z']) {
      const archive = path.join(root, `test.${format}`);
      const comment = format === 'zip' ? '测试注释\n第二行：中文与 emoji 📷' : '';
      await engine.compress({ executable, source, destination: archive, format, comment, password: 'test-only-password', splitMiB: 1 });
      const volumes = fs.readdirSync(root).filter(name => name.startsWith(`test.${format}.`));
      assert(volumes.length >= 3, 'incompressible data produces multiple volumes');
      if (format === 'zip') {
        const bytes = Buffer.concat(volumes.sort().map(name => fs.readFileSync(path.join(root, name))));
        const commentBytes = Buffer.byteLength(comment, 'utf8'), footer = bytes.length - commentBytes - 22;
        assert.equal(bytes.readUInt32LE(footer), 0x06054b50);
        assert.equal(bytes.readUInt16LE(footer + 20), commentBytes);
        assert.equal(bytes.subarray(footer + 22).toString('utf8'), comment, 'native ZIP comments survive encryption and volume splitting');
        assert(volumes.every(name => fs.statSync(path.join(root, name)).size <= 1024 ** 2), 'comments cannot overflow the requested volume size');
      }
      const destination = path.join(root, `extract-${format}`);
      await assert.rejects(engine.extract({ executable, archive: `${archive}.001`, destination: path.join(root, `bad-${format}`), password: 'wrong' }));
      const result = await engine.extract({ executable, archive: `${archive}.001`, destination, password: 'test-only-password' });
      assert.equal(result.files.length, 2);
      assert(fs.existsSync(path.join(destination, '中文目录', '空目录')));
      assert.deepEqual(fs.readFileSync(path.join(source, 'random.bin')), fs.readFileSync(path.join(destination, 'random.bin')));
      assert.equal(fs.readFileSync(path.join(source, '中文目录', 'hello.txt'), 'utf8'), fs.readFileSync(path.join(destination, '中文目录', 'hello.txt'), 'utf8'));
    }
    const plainZip = path.join(root, 'plain.zip');
    await engine.compress({ executable, source, destination: plainZip, format: 'zip', comment: '普通注释' });
    assert(fs.readFileSync(plainZip).subarray(-Buffer.byteLength('普通注释')).equals(Buffer.from('普通注释')));
    await engine.run7z(executable, ['t', '--', plainZip]);
    await assert.rejects(engine.compress({ executable, source, destination: path.join(root, 'invalid.7z'), format: '7z', comment: 'unsupported' }), /不支持压缩包注释/);
    await assert.rejects(engine.compress({ executable, source, destination: path.join(root, 'too-long.zip'), format: 'zip', comment: '中'.repeat(22000) }), /大小上限/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(engine.run7z(executable, ['i'], { signal: abort.signal }), error => error.code === 'COMPONENT_HOST_CANCELLED');
    // Refuse an actual malicious ZIP before extraction starts.
    const { writeZip } = require('./test-helpers/zip-fixture.cjs');
    const malicious = path.join(root, 'malicious.zip');
    writeZip(malicious, [['../escape.txt', 'escape']]);
    await assert.rejects(engine.extract({ executable, archive: malicious, destination: path.join(root, 'malicious-output') }));
    assert(!fs.existsSync(path.join(root, 'escape.txt')));
    console.log('Archive engine round-trip, encryption, volumes, Unicode, empty folders and safety tests passed.');
  } finally {
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('photoflow-archive-engine-')) fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
