const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qingstudio-smoke-'));
const child = spawn(require('electron'), ['--disable-gpu', root], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PHOTOFLOW_SMOKE_TEST: '1', PHOTOFLOW_USER_DATA_DIR: path.join(fixture, 'user'), PHOTOFLOW_SMOKE_SESSION_DATA_DIR: path.join(fixture, 'session'), PYTHONDONTWRITEBYTECODE: '1' },
});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
const timer = setTimeout(() => { child.kill(); console.error('Smoke timed out. Fixture retained: ' + fixture); process.exitCode = 1; }, 90000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timer);
  if (code !== 0 || !output.includes('QINGSTUDIO_SMOKE_RESULT=')) { console.error(output); process.exitCode = 1; }
  else {
    const match = output.match(/QINGSTUDIO_SMOKE_RESULT=(\{[^\r\n]+\})/);
    try { const evidence = JSON.parse(match?.[1] || 'null'); if (!evidence || !['renderer','preload','noCommercialGate','tasks','biometricDisabled'].every(key => evidence[key] === true)) throw new Error('Invalid smoke evidence'); console.log(JSON.stringify(evidence)); }
    catch (error) { console.error(error); process.exitCode = 1; }
  }
  console.log('Synthetic test fixture retained: ' + fixture);
});
