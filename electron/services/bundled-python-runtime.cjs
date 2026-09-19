const fs = require('fs');
const path = require('path');
const { normalizeBundledPythonTool } = require('../security-policy.cjs');
const { createDevelopmentPythonResolver } = require('./python-environment-service.cjs');
const { findPythonJsonFailureMessage } = require('./python-json-protocol.cjs');
const { createJsonCommandRunner } = require('./json-command-runner.cjs');
const { renameNeedsFrameRuntime } = require('./rename-runtime-model.cjs');
const { resolveLegacyComponentRuntimeTool, resolveLegacyRuntimeRunConfig, resolveLegacyRuntimeBridgeConfig } = require('../compatibility/legacy-component-runtime-tools.cjs');

const MERGED_PYTHON_TOOLS = new Set(['classify', 'png_to_jpg', 'catch', 'raw_decoder', 'rename', 'thumbnail_db', 'thumbnail_image', 'workspace_db', 'operations_db', 'backup_db']);
const INSPIRATION_PYTHON_TOOLS = new Set(['research', 'office_media_extract', 'screenshot_main_image']);

const createBundledPythonRuntime = ({
  app,
  projectRoot,
  processSupervisor,
  getPluginService,
  getDevelopmentPython = createDevelopmentPythonResolver({ projectRoot }),
  platform = process.platform,
  resourcesPath = process.resourcesPath,
}) => {
  let supervisedJobSequence = 0;

  const getRunConfig = (scriptName, args) => {
    const normalizedScriptName = normalizeBundledPythonTool(scriptName);
    const baseName = normalizedScriptName.slice(0, -3);
    const legacyComponentRuntime = resolveLegacyComponentRuntimeTool(baseName);
    if (!MERGED_PYTHON_TOOLS.has(baseName) && !INSPIRATION_PYTHON_TOOLS.has(baseName) && !legacyComponentRuntime) {
      throw new Error(`Unknown bundled Python tool: ${normalizedScriptName}`);
    }
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || /\0/.test(value))) {
      throw new TypeError('Invalid bundled Python tool arguments');
    }

    const pluginService = getPluginService();
    if (legacyComponentRuntime) {
      if (!pluginService) {
        const error = new Error('视频处理插件服务尚未初始化');
        error.code = 'PLUGIN_MISSING';
        throw error;
      }
      return resolveLegacyRuntimeRunConfig(pluginService, legacyComponentRuntime, args);
    }
    if (baseName === 'rename' && renameNeedsFrameRuntime(args, { fs, path }) && pluginService) {
      try {
        const videoRuntime = resolveLegacyRuntimeBridgeConfig(pluginService, resolveLegacyComponentRuntimeTool('ffmpeg_transcode'));
        args = [...args, '--video_tools_command', videoRuntime.command, ...videoRuntime.args.map(value => `--video_tools_arg=${value}`)];
      } catch (error) {
        if (error?.code !== 'PLUGIN_MISSING') throw error;
      }
    }

    if (app.isPackaged) {
      const exeSuffix = platform === 'win32' ? '.exe' : '';
      if (MERGED_PYTHON_TOOLS.has(baseName)) {
        return {
          command: path.join(resourcesPath, 'python', 'PhotoFlowImportWorker', `PhotoFlowImportWorker${exeSuffix}`),
          args: [baseName, ...args],
        };
      }
      if (INSPIRATION_PYTHON_TOOLS.has(baseName)) {
        return {
          command: path.join(resourcesPath, 'python', 'inspiration-tools', `inspiration-tools${exeSuffix}`),
          args: [baseName, ...args],
        };
      }
      throw new Error(`Bundled Python tool is missing a packaged runtime group: ${normalizedScriptName}`);
    }

    return {
      command: getDevelopmentPython(),
      args: ['-u', path.join(projectRoot, 'python', `${baseName}.py`), ...args],
    };
  };

  const spawnSupervisedJob = ({ prefix, command, args, supervision = null }) => processSupervisor.launch({
    id: `${prefix}:${++supervisedJobSequence}`,
    kind: 'python-job',
    ...(supervision?.componentId ? { owner: { componentId: supervision.componentId }, lifecycleLease: supervision.lifecycleLease, windowsJob: true } : {}),
    command,
    args,
    options: { stdio: ['ignore', 'pipe', 'pipe'] },
    ...(supervision?.componentId ? { owner: { componentId: supervision.componentId }, windowsJob: true } : {}),
    ephemeral: true,
  }).child;

  const runJsonCommandInternal = createJsonCommandRunner({
    spawnJob: run => spawnSupervisedJob({ prefix: 'python:json-job', command: run.command, args: run.args, supervision: run.supervision }),
  });
  const runJsonCommand = (run, label, timeoutMs, onMessage, signal, deadlineAt, supervision) => runJsonCommandInternal(
    run, label, timeoutMs, onMessage, signal, deadlineAt, supervision,
  );

  const runPythonJsonAction = (scriptName, args, timeoutMs = 20 * 60 * 1000, onMessage, signal, deadlineAt) =>
    runJsonCommand(getRunConfig(scriptName, args), scriptName, timeoutMs, onMessage, signal, deadlineAt);

  const runPythonEventAction = (scriptName, args, timeoutMs = 20 * 60 * 1000, signal, onEvent) => new Promise((resolve, reject) => {
    const run = getRunConfig(scriptName, args);
    const child = spawnSupervisedJob({ prefix: 'python:event-job', command: run.command, args: run.args });
    let stdout = '';
    let stderr = '';
    let eventBuffer = '';
    const events = [];
    let finished = false;
    let abortListener = null;
    const settle = callback => value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      callback(value);
    };
    const succeed = settle(resolve);
    const fail = settle(reject);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      stdout = (stdout + data).slice(-16 * 1024 * 1024);
      const lines = (eventBuffer + data).split(/\r?\n/);
      eventBuffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          events.push(event);
          onEvent?.(event);
        } catch { /* keep non-protocol output in stdout for final diagnostics */ }
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
    child.on('error', fail);
    child.on('close', code => {
      if (eventBuffer.trim()) {
        try { const event = JSON.parse(eventBuffer); events.push(event); onEvent?.(event); } catch { /* ignore trailing non-protocol output */ }
      }
      const protocolFailure = findPythonJsonFailureMessage(events);
      if (code !== 0) return fail(new Error(protocolFailure || stderr.trim() || `${scriptName} 处理失败（代码 ${code}）`));
      if (protocolFailure) return fail(new Error(protocolFailure));
      succeed(events);
    });
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      fail(new Error(`${scriptName} 处理超时`));
    }, timeoutMs);
    if (signal) {
      abortListener = () => {
        if (!child.killed) child.kill();
        const error = new Error('任务已取消');
        error.code = 'TASK_CANCELLED';
        fail(error);
      };
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    }
  });

  return { getRunConfig, runJsonCommand, runPythonEventAction, runPythonJsonAction };
};

module.exports = { createBundledPythonRuntime };
