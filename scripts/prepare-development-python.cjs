const path = require('node:path');
const { createDevelopmentPythonResolver } = require('../electron/services/python-environment-service.cjs');
const { ensurePythonEnvironment } = require('./setup-python.cjs');

const prepareDevelopmentPython = ({
  resolvePython = createDevelopmentPythonResolver({ projectRoot: path.resolve(__dirname, '..') }),
  setupPython = ensurePythonEnvironment,
  log = console.log,
} = {}) => {
  try { return resolvePython(); }
  catch (error) {
    log(`开发版 Python 环境需要修复，正在安装项目声明的依赖。\n${error.message || String(error)}`);
    setupPython();
    return resolvePython();
  }
};

if (require.main === module) {
  try { prepareDevelopmentPython(); }
  catch (error) { console.error(error.message || String(error)); process.exitCode = 1; }
}

module.exports = { prepareDevelopmentPython };
