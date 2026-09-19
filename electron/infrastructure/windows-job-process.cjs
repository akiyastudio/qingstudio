const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const PROTOCOL_VERSION = 1;
const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5000;

const frame = value => {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 1 || payload.length > MAX_CONTROL_FRAME_BYTES) throw Object.assign(new Error('Job launcher control frame is too large'), { code: 'JOB_CONTROL_FRAME_TOO_LARGE' });
  const header = Buffer.allocUnsafe(4); header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]);
};

const helperPaths = ({ resourcesPath = process.resourcesPath, baseDirectory = path.join(__dirname, '..'), packaged = false } = {}) => packaged
  ? { executable: path.join(resourcesPath, 'job-object-launcher.exe'), identity: path.join(baseDirectory, 'generated', 'job-object-launcher-identity.json') }
  : { executable: path.join(baseDirectory, 'bin', 'job-object-launcher.exe'), identity: path.join(baseDirectory, 'generated', 'job-object-launcher-identity.json') };

const sha256File = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const verifyJobLauncherIdentity = options => {
  const locations = helperPaths(options);
  if (!fs.statSync(locations.executable).isFile()) throw new Error(`Windows Job launcher is missing: ${locations.executable}`);
  const identity = JSON.parse(fs.readFileSync(locations.identity, 'utf8'));
  const identityFile = options?.packaged ? identity?.packagedFile : identity?.developmentFile;
  if (identity?.schemaVersion !== 2 || identityFile !== path.basename(locations.executable) || !/^[a-f0-9]{64}$/.test(identity.sha256)) throw new Error('Windows Job launcher build identity is invalid');
  const actual = sha256File(locations.executable);
  if (actual !== identity.sha256) throw Object.assign(new Error('Windows Job launcher failed its packaged build identity check'), { code: 'JOB_LAUNCHER_IDENTITY_MISMATCH' });
  return locations.executable;
};

class WindowsJobProcess extends EventEmitter {
  constructor(helper, control, readyPromise) {
    super();
    this.helper = helper;
    this.pid = helper.pid;
    this.targetPid = null;
    this.stdin = helper.stdin;
    this.stdout = helper.stdout;
    this.stderr = helper.stderr;
    this.stdio = helper.stdio;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.connected = false;
    this.__photoFlowJobManaged = true;
    this.__photoFlowTreeExitConfirmed = false;
    this.__photoFlowTreeTerminationUnconfirmed = false;
    this.control = control;
    this.ready = readyPromise;
    this.treeExit = new Promise((resolve, reject) => { this._resolveTreeExit = resolve; this._rejectTreeExit = reject; });
    this.terminalVerdict = new Promise(resolve => { this._resolveTerminalVerdict = resolve; });
    this.terminationPromise = null;
    // Consumers commonly attach only process error listeners. Keep a rejection
    // observable without creating an unhandled rejection for natural exits.
    void this.ready.catch(() => undefined); void this.treeExit.catch(() => undefined);
  }

  kill() { void this.terminateJob(Date.now() + 2000).catch(() => undefined); return !this.killed; }

  terminateJob(deadlineAt) {
    if (this.__photoFlowTreeExitConfirmed) return Promise.resolve({ exited: true, activeProcessCount: 0, forced: true });
    if (this.terminationPromise) return this.terminationPromise;
    const operation = this._terminateJobOnce(deadlineAt);
    const tracked = operation.finally(() => { if (this.terminationPromise === tracked) this.terminationPromise = null; });
    this.terminationPromise = tracked;
    return tracked;
  }

  async _terminateJobOnce(deadlineAt) {
    const remaining = Math.max(1, Number(deadlineAt) - Date.now());
    if (!this.control || this.control.destroyed) {
      this.__photoFlowTreeTerminationUnconfirmed = true;
      throw Object.assign(new Error('Windows Job control pipe is unavailable'), { code: 'PROCESS_TREE_TERMINATION_UNCONFIRMED', pid: this.pid });
    }
    this.killed = true;
    await new Promise((resolve, reject) => this.control.write(frame({ type: 'terminate', deadlineMs: Math.min(300000, remaining) }), error => error ? reject(error) : resolve()));
    let timer;
    try {
      const result = await Promise.race([
        this.treeExit,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Windows Job did not report ActiveProcesses=0 before the deadline'), { code: 'PROCESS_TREE_TERMINATION_UNCONFIRMED', pid: this.pid })), remaining); timer.unref?.(); }),
      ]);
      return { exited: true, activeProcessCount: 0, forced: true, ...result };
    } catch (error) { this.__photoFlowTreeTerminationUnconfirmed = true; throw error; }
    finally { clearTimeout(timer); }
  }
}

const connectControlPipe = (pipePath, deadlineAt, terminalError = () => null) => new Promise((resolve, reject) => {
  let settled = false; let retryTimer = null; let socket = null;
  const deadlineTimer = setTimeout(() => { socket?.destroy(); finish(Object.assign(new Error('Timed out connecting to Windows Job launcher control pipe'), { code: 'JOB_CONTROL_CONNECT_TIMEOUT' })); }, Math.max(1, deadlineAt - Date.now())); deadlineTimer.unref?.();
  const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(retryTimer); clearTimeout(deadlineTimer); if (error) reject(error); else resolve(value); };
  const attempt = () => {
    const terminal = terminalError(); if (terminal) return finish(terminal);
    if (Date.now() >= deadlineAt) return finish(Object.assign(new Error('Timed out connecting to Windows Job launcher control pipe'), { code: 'JOB_CONTROL_CONNECT_TIMEOUT' }));
    socket = net.createConnection(pipePath);
    socket.once('connect', () => finish(null, socket));
    socket.once('error', error => { socket.destroy(); if (['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) retryTimer = setTimeout(attempt, 15); else finish(error); });
  };
  attempt();
});

const launchWindowsJobProcess = (command, args = [], options = {}, {
  spawnImpl = spawn, connectControlPipeImpl = connectControlPipe, packaged = false, resourcesPath = process.resourcesPath, baseDirectory = path.join(__dirname, '..'), connectTimeoutMs = CONNECT_TIMEOUT_MS,
} = {}) => {
  if (typeof command !== 'string' || !path.win32.isAbsolute(command) || command.includes('\0')) throw new TypeError('Windows Job target command must be an absolute executable path resolved by the trusted host');
  const executable = verifyJobLauncherIdentity({ packaged, resourcesPath, baseDirectory });
  const pipeName = `photoflow-job-${process.pid}-${crypto.randomUUID()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const helperEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  helperEnvironment.PHOTOFLOW_JOB_PIPE = pipeName;
  const requestedStdio = options.stdio || ['pipe', 'pipe', 'pipe'];
  if (!Array.isArray(requestedStdio) || requestedStdio.length < 3 || requestedStdio.slice(0, 3).some(value => !['pipe', 'ignore'].includes(value))) throw new TypeError('Windows Job launcher supports only pipe/ignore stdio');
  // All helper streams are pipes internally; ignored target streams are simply
  // left unread by callers, preserving the ChildProcess-facing shape.
  const parentStartTicks = Math.round((Date.now() - process.uptime() * 1000) * 10000 + 621355968000000000);
  const helper = spawnImpl(executable, ['--protocol-v1', '--parent-pid', String(process.pid), '--parent-start-ticks', String(parentStartTicks)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: helperEnvironment });
  let helperKillRequested = false;
  const killHelperOnce = () => { if (helperKillRequested) return false; helperKillRequested = true; try { return helper.kill(); } catch { return false; } };
  let readyResolve; let readyReject;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void readyPromise.catch(() => undefined);
  let resolveHelperClosed; const helperClosed = new Promise(resolve => { resolveHelperClosed = resolve; });
  let resolveUnlaunchedTreeExit;
  const unlaunchedTreeExit = new Promise(resolve => { resolveUnlaunchedTreeExit = resolve; });
  const waitForHelperCloseAfterKill = () => new Promise(resolve => { const timer = setTimeout(() => resolve(false), 1000); timer.unref?.(); helperClosed.then(() => { clearTimeout(timer); resolve(true); }); });
  let managed = null; let proxy = null; let protocolFailure = null; let helperTerminalError = null; let helperSpawnFailed = false; let launchCancelled = false; let launchFrameWritten = false;
  const setup = (async () => {
    const control = await connectControlPipeImpl(pipePath, Date.now() + connectTimeoutMs, () => helperTerminalError);
    if (launchCancelled) { control.destroy(); throw Object.assign(new Error('Windows Job launch was cancelled before configuration'), { code: 'JOB_LAUNCH_CANCELLED' }); }
    managed = new WindowsJobProcess(helper, control, readyPromise);
    let incoming = Buffer.alloc(0); let expected = null;
    const fail = error => {
      // A verified zero-process terminal frame is authoritative. A subsequent
      // peer-close error is transport cleanup, not a new process failure.
      if (managed.__photoFlowTreeExitConfirmed && ['EPIPE', 'ECONNRESET'].includes(error?.code)) return;
      if (protocolFailure) return;
      protocolFailure = error;
      if (error.treeConfirmed === true && error.activeProcessCount === 0) {
        if (!managed.targetPid) readyReject(error);
        managed.__photoFlowTreeExitConfirmed = true; managed.__photoFlowTreeTerminationUnconfirmed = false;
        managed._resolveTreeExit({ activeProcessCount: 0, launchFailed: !managed.targetPid, error });
      } else if (!managed.targetPid) {
        readyReject(error); managed.__photoFlowTreeTerminationUnconfirmed = true; managed._rejectTreeExit(error);
      } else if (!managed.__photoFlowTreeExitConfirmed) managed.__photoFlowTreeTerminationUnconfirmed = true;
      queueMicrotask(() => { if (proxy?.listenerCount('error')) proxy.emit('error', error); });
    };
    control.on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      while (true) {
        if (expected === null) {
          if (incoming.length < 4) return;
          expected = incoming.readUInt32LE(0); incoming = incoming.subarray(4);
          if (expected < 1 || expected > MAX_CONTROL_FRAME_BYTES) { control.destroy(); fail(Object.assign(new Error('Invalid Windows Job control frame length'), { code: 'JOB_CONTROL_PROTOCOL_ERROR' })); return; }
        }
        if (incoming.length < expected) return;
        const payload = incoming.subarray(0, expected); incoming = incoming.subarray(expected); expected = null;
        let value; try { value = JSON.parse(payload.toString('utf8')); } catch { control.destroy(); fail(Object.assign(new Error('Invalid Windows Job control JSON'), { code: 'JOB_CONTROL_PROTOCOL_ERROR' })); return; }
        if (value?.type === 'ready' && value.protocolVersion === PROTOCOL_VERSION && Number.isSafeInteger(value.targetPid) && value.targetPid > 0 && !managed.targetPid) {
          managed.targetPid = value.targetPid; readyResolve({ targetPid: value.targetPid }); managed.emit('target-spawn', value.targetPid); continue;
        }
        if (value?.type === 'tree-exit' && value.protocolVersion === PROTOCOL_VERSION && value.targetPid === managed.targetPid && value.activeProcessCount === 0) {
          managed.__photoFlowTreeExitConfirmed = true; managed.__photoFlowTreeTerminationUnconfirmed = false; managed._resolveTreeExit(value); continue;
        }
        if (value?.type === 'terminating' && value.protocolVersion === PROTOCOL_VERSION) continue;
        if (value?.type === 'error' && value.protocolVersion === PROTOCOL_VERSION) {
          const error = Object.assign(new Error(String(value.message || 'Windows Job launcher failed')), { code: 'JOB_LAUNCH_FAILED', win32Code: Number(value.win32Code) || 0, stage: String(value.stage || ''), treeConfirmed: value.treeConfirmed === true, activeProcessCount: Number(value.activeProcessCount) }); fail(error); continue;
        }
        control.destroy(); fail(Object.assign(new Error('Unexpected Windows Job control frame'), { code: 'JOB_CONTROL_PROTOCOL_ERROR' })); return;
      }
    });
    control.on('error', fail);
    control.on('close', () => {
      if (!managed.__photoFlowTreeExitConfirmed) {
        managed.__photoFlowTreeTerminationUnconfirmed = Boolean(managed.targetPid);
        managed._rejectTreeExit(Object.assign(new Error('Windows Job control pipe closed without ActiveProcesses=0 proof'), { code: 'PROCESS_TREE_TERMINATION_UNCONFIRMED', pid: managed.pid }));
      }
      managed._resolveTerminalVerdict({ confirmed: managed.__photoFlowTreeExitConfirmed, targetPid: managed.targetPid });
    });
    if (launchCancelled) { control.destroy(); throw Object.assign(new Error('Windows Job launch was cancelled before configuration'), { code: 'JOB_LAUNCH_CANCELLED' }); }
    launchFrameWritten = true;
    try {
      control.write(frame({ protocolVersion: PROTOCOL_VERSION, command, args, cwd: options.cwd || '', env: options.env || process.env, windowsHide: options.windowsHide !== false, stdio: requestedStdio.slice(0, 3), pollOnlyForTest: options.__jobPollOnlyForTest === true }), error => { if (error) fail(error); });
    } catch (error) { fail(error); throw error; }
    return managed;
  })().catch(error => { killHelperOnce(); readyReject(error); throw error; });

  // A stable proxy exists synchronously, while named-pipe setup completes in
  // the background before any target bytes can be produced.
  proxy = new EventEmitter();
  proxy.pid = helper.pid; proxy.targetPid = null; proxy.stdin = requestedStdio[0] === 'pipe' ? helper.stdin : null; proxy.stdout = requestedStdio[1] === 'pipe' ? helper.stdout : null; proxy.stderr = requestedStdio[2] === 'pipe' ? helper.stderr : null; proxy.stdio = [proxy.stdin, proxy.stdout, proxy.stderr]; proxy.spawnargs = helper.spawnargs;
  proxy.killed = false; proxy.exitCode = null; proxy.signalCode = null; proxy.__photoFlowJobManaged = true; proxy.__photoFlowTreeExitConfirmed = false; proxy.__photoFlowTreeTerminationUnconfirmed = false;
  proxy.ready = readyPromise.then(result => { proxy.targetPid = managed.targetPid; return result; });
  proxy.treeExit = Promise.race([setup.then(value => value.treeExit), unlaunchedTreeExit]).then(result => { proxy.__photoFlowTreeExitConfirmed = true; return result; });
  void proxy.ready.catch(() => undefined); void proxy.treeExit.catch(() => undefined);
  proxy.kill = () => { void proxy.terminateJob(Date.now() + 2000).catch(() => undefined); return !proxy.killed; };
  proxy.terminateJob = async deadlineAt => { launchCancelled = true; if (helperSpawnFailed || !launchFrameWritten) { killHelperOnce(); proxy.killed = true; proxy.__photoFlowTreeExitConfirmed = true; return { exited: true, activeProcessCount: 0, launchFailed: helperSpawnFailed, setupCancelled: !launchFrameWritten }; } const remaining = Math.max(1, Number(deadlineAt) - Date.now()); let setupTimer; let value; try { value = await Promise.race([setup, new Promise((_, reject) => { setupTimer = setTimeout(() => reject(Object.assign(new Error('Windows Job setup did not complete before the stop deadline'), { code: 'PROCESS_TREE_TERMINATION_UNCONFIRMED', pid: proxy.pid })), remaining); setupTimer.unref?.(); })]); } catch (error) { managed?.control?.destroy(); killHelperOnce(); proxy.killed = true; proxy.__photoFlowTreeTerminationUnconfirmed = true; await waitForHelperCloseAfterKill(); throw error; } finally { clearTimeout(setupTimer); } proxy.killed = true; try { const result = await value.terminateJob(deadlineAt); proxy.__photoFlowTreeExitConfirmed = true; return result; } catch (error) { value.control?.destroy(); killHelperOnce(); proxy.__photoFlowTreeTerminationUnconfirmed = true; await waitForHelperCloseAfterKill(); throw error; } };
  proxy._disconnectControlForTest = async () => { const value = await setup; value.control.destroy(); };
  proxy._writeControlForTest = async value => { const launched = await setup; launched.control.write(frame(value)); };
  helper.on('error', error => { helperTerminalError = error; helperSpawnFailed = !managed?.targetPid; if (helperSpawnFailed) proxy.__photoFlowTreeExitConfirmed = true; readyReject(error); proxy.emit('error', error); });
  let helperExit = null; let helperClose = null; let terminalPublished = false;
  const publishTerminal = async () => {
    if (!helperExit || helperExit.published) return;
    helperExit.published = true;
    if (!launchFrameWritten) {
      // The helper really exited before receiving any target configuration.
      // Waiting for the still-pending pipe connection here hides its exit/close
      // events until after database cancellation's stop deadline.
      launchCancelled = true;
      proxy.__photoFlowTreeExitConfirmed = true;
      proxy.__photoFlowTreeTerminationUnconfirmed = false;
      resolveUnlaunchedTreeExit({ exited: true, activeProcessCount: 0, setupCancelled: true });
    } else {
      try { const value = await setup; await value.terminalVerdict; proxy.targetPid = value.targetPid; proxy.__photoFlowTreeExitConfirmed = value.__photoFlowTreeExitConfirmed; proxy.__photoFlowTreeTerminationUnconfirmed = value.__photoFlowTreeTerminationUnconfirmed; } catch { proxy.__photoFlowTreeTerminationUnconfirmed = Boolean(proxy.targetPid); }
    }
    if (!proxy.targetPid) readyReject(Object.assign(new Error(`Windows Job launcher exited before ready (${helperExit.code ?? helperExit.signal ?? 'unknown'})`), { code: 'JOB_LAUNCHER_EARLY_EXIT' }));
    proxy.exitCode = helperExit.code; proxy.signalCode = helperExit.signal; proxy.emit('exit', helperExit.code, helperExit.signal);
    terminalPublished = true;
    if (helperClose) { proxy.__photoFlowCloseObserved = true; proxy.emit('close', helperClose.code, helperClose.signal); }
  };
  helper.on('exit', (code, signal) => { helperExit = { code, signal, published: false }; void publishTerminal(); });
  helper.on('close', (code, signal) => { resolveHelperClosed(); helperTerminalError ||= Object.assign(new Error(`Windows Job launcher closed before control setup (${code ?? signal ?? 'unknown'})`), { code: 'JOB_LAUNCHER_EARLY_CLOSE' }); helperClose = { code, signal }; if (!helperExit) helperExit = { code, signal, published: false }; if (terminalPublished) { proxy.__photoFlowCloseObserved = true; proxy.emit('close', code, signal); } else void publishTerminal(); });
  return proxy;
};

module.exports = { CONNECT_TIMEOUT_MS, MAX_CONTROL_FRAME_BYTES, WindowsJobProcess, connectControlPipe, frame, helperPaths, launchWindowsJobProcess, verifyJobLauncherIdentity };
