const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PYTHON_VALIDATION_TIMEOUT_MS = 15000;
const PYTHON_VALIDATION_OUTPUT_LIMIT = 1024 * 1024;

const developmentPythonPath = projectRoot => path.join(
  projectRoot,
  '.venv',
  ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']),
);

const createDevelopmentAlgorithmRuntimes = ({ projectRoot, definitions }) => Object.fromEntries(Object.values(definitions)
  .filter(definition => Array.isArray(definition.developmentAlgorithmEntry))
  .map(definition => [definition.id, {
    command: developmentPythonPath(projectRoot),
    argsPrefix: [path.join(projectRoot, ...definition.developmentAlgorithmEntry)],
  }]));

const createDevelopmentPythonResolver = ({ projectRoot, spawnSyncImpl = spawnSync }) => {
  let validatedFingerprint = '';
  const sentinelFingerprint = candidates => candidates.map(candidate => {
    if (!fs.existsSync(candidate)) return `${path.relative(projectRoot, candidate)}:absent`;
    const stat = fs.statSync(candidate);
    return `${path.relative(projectRoot, candidate)}:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const validate = (venvPython, verifier, cleanEnvironment) => {
    const result = spawnSyncImpl(venvPython, [verifier, '--quick'], {
      cwd: projectRoot, env: cleanEnvironment, windowsHide: true, encoding: 'utf8',
      timeout: PYTHON_VALIDATION_TIMEOUT_MS, maxBuffer: PYTHON_VALIDATION_OUTPUT_LIMIT,
    });
    if (result?.error?.code === 'ETIMEDOUT') throw new Error('Python 环境校验超时');
    if (result?.error) throw result.error;
    if (result?.status !== 0) {
      const detail = `${result?.stdout || ''}${result?.stderr || ''}`.slice(0, PYTHON_VALIDATION_OUTPUT_LIMIT).trim();
      throw new Error(`Python 环境不完整；请运行 npm run setup:python${detail ? `\n${detail}` : ''}`);
    }
  };
  return () => {
    const venvRoot = path.join(projectRoot, '.venv');
    const venvPython = developmentPythonPath(projectRoot);
    const venvConfig = path.join(venvRoot, 'pyvenv.cfg');
    const venvLibrary = path.join(venvRoot, process.platform === 'win32' ? 'Lib' : 'lib');
    if (!fs.existsSync(venvPython) || !fs.existsSync(venvConfig) || !fs.existsSync(venvLibrary)) {
      validatedFingerprint = '';
      throw new Error('Python 虚拟环境不完整；请运行 npm run setup:python 后重试');
    }
    const verifier = path.join(projectRoot, 'scripts', 'verify-python-environment.py');
    const fingerprintInputs = [venvPython, venvConfig, venvLibrary, verifier,
      ...['requirements.txt', 'package-lock.json'].map(name => path.join(projectRoot, name)).filter(fs.existsSync)];
    const fingerprint = sentinelFingerprint(fingerprintInputs);
    if (validatedFingerprint !== fingerprint) {
      const cleanEnvironment = { ...process.env, PYTHONUTF8: '1' };
      for (const name of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'VIRTUAL_ENV', '__PYVENV_LAUNCHER__']) delete cleanEnvironment[name];
      validate(venvPython, verifier, cleanEnvironment);
      validatedFingerprint = fingerprint;
    }
    return venvPython;
  };
};

module.exports = { createDevelopmentAlgorithmRuntimes, createDevelopmentPythonResolver, developmentPythonPath };
