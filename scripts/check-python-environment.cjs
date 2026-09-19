const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { root, venvPython } = require('./setup-python.cjs');

if (!fs.existsSync(venvPython)) {
  console.error('Python virtual environment is missing. Run: npm run setup:python');
  process.exit(1);
}

const result = spawnSync(venvPython, [path.join('scripts', 'verify-python-environment.py')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PYTHONUTF8: '1' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
