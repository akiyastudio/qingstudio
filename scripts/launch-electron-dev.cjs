const { spawn } = require('child_process');
const path = require('path');
const waitOn = require('wait-on');
const { normalizeDevelopmentRendererUrl } = require('../electron/security-policy.cjs');
const { prepareDevelopmentPython } = require('./prepare-development-python.cjs');

const developmentRendererUrl = normalizeDevelopmentRendererUrl(process.env.PHOTOFLOW_DEV_SERVER_URL);

Promise.resolve().then(() => {
  prepareDevelopmentPython();
  return waitOn({ resources: [developmentRendererUrl], timeout: 120_000 });
}).then(() => {
  const child = spawn(require('electron'), ['.'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'development', PHOTOFLOW_DEV_SERVER_URL: developmentRendererUrl },
    stdio: 'inherit', windowsHide: true,
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('exit', code => { process.exitCode = code ?? 1; });
}).catch(error => { console.error(error.message || error); process.exitCode = 1; });
