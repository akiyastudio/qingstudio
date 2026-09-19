const HANDLE = /^[1-9][0-9]{0,19}$/;
const MAX_HANDSHAKE_BYTES = 16 * 1024;

const nativeHandleValue = window => {
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) throw new Error('无法读取照片流窗口句柄');
  return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
};

const createNativeVideoSurfaceService = ({ app, path, processSupervisor = null, spawn, writeLog, startupTimeoutMs = 5000 }) => {
  const command = app.isPackaged
    ? path.join(process.resourcesPath, 'video-surface-host.exe')
    : path.join(__dirname, '..', 'bin', 'video-surface-host.exe');
  const attach = async ({ ownerWindow, componentProcess, surfaceHandle, sessionId, onLost = () => undefined }) => {
    const childHandle = String(surfaceHandle || ''); const expectedPid = Number(componentProcess?.pid);
    if (!HANDLE.test(childHandle) || !Number.isSafeInteger(expectedPid) || expectedPid <= 0 || !ownerWindow || ownerWindow.isDestroyed()) throw new Error('原生视频表面声明无效');
    const args = ['--parent-hwnd', nativeHandleValue(ownerWindow), '--child-hwnd', childHandle, '--expected-pid', String(expectedPid), '--session-id', sessionId];
    const managed = processSupervisor?.launch({ id: `video-surface:${sessionId}`, kind: 'native-helper', command, args, options: { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, health: { startupTimeoutMs }, ephemeral: true });
    const child = managed?.child || spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let closed = false; let closeRequested = false; let stderr = ''; let handshakeReject = null;
    const reportFailure = (message, error) => { try { writeLog('warn', message, { sessionId, error: error.message || String(error) }); } catch { /* logging must not escape cleanup */ } };
    const stopHost = reason => {
      try {
        const result = managed ? managed.stop(reason) : !child.killed && child.kill();
        void Promise.resolve(result).catch(error => reportFailure('Unable to stop native video surface host', error));
      } catch (error) { reportFailure('Unable to stop native video surface host', error); }
    };
    const handleLifecycleError = error => {
      if (handshakeReject) { handshakeReject(error); return; }
      if (closed) return;
      closed = true;
      reportFailure('Native video surface host stream failed', error);
      try { onLost(error); } catch { /* consumer failure must not escape stream cleanup */ }
      stopHost('video-surface-stream-error');
    };
    child.on('error', handleLifecycleError);
    child.stdin.on('error', handleLifecycleError);
    child.stdout.on('error', handleLifecycleError);
    child.on('exit', code => {
      const error = new Error(stderr.trim() || `原生视频表面丢失（${code ?? '未知'}）`);
      if (handshakeReject) { handshakeReject(error); return; }
      if (closed) return;
      closed = true;
      try { onLost(error); } catch { /* consumer failure must not escape exit cleanup */ }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    await new Promise((resolve, reject) => {
      let settled = false; let buffered = Buffer.alloc(0);
      const cleanup = () => { clearTimeout(timer); child.stdout.removeListener('data', onData); };
      const succeed = () => { if (settled) return; settled = true; handshakeReject = null; cleanup(); resolve(); };
      const fail = error => { if (settled) return; settled = true; closed = true; handshakeReject = null; cleanup(); reject(error); };
      const onData = chunk => {
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const nextNewline = next.indexOf(0x0a);
        const frameBytes = buffered.length + (nextNewline < 0 ? next.length : nextNewline);
        if (frameBytes > MAX_HANDSHAKE_BYTES + 1) { fail(new Error('原生视频表面宿主握手帧过大')); return; }
        buffered = Buffer.concat([buffered, nextNewline < 0 ? next : next.subarray(0, nextNewline + 1)]);
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          if (buffered.length === MAX_HANDSHAKE_BYTES + 1 && buffered[buffered.length - 1] !== 0x0d) fail(new Error('原生视频表面宿主握手帧过大'));
          return;
        }
        const jsonBytes = newline > 0 && buffered[newline - 1] === 0x0d ? newline - 1 : newline;
        if (jsonBytes > MAX_HANDSHAKE_BYTES) { fail(new Error('原生视频表面宿主握手帧过大')); return; }
        const line = buffered.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        try {
          const value = JSON.parse(line);
          if (value.type !== 'ready' || value.sessionId !== sessionId) throw new Error('原生视频表面宿主握手无效');
          managed?.markHealthy({ protocol: 'native-video-surface-v1' }); succeed();
        } catch (error) { fail(error); }
      };
      const timer = setTimeout(() => fail(new Error('原生视频表面附着超时')), startupTimeoutMs); timer.unref?.();
      handshakeReject = fail;
      child.stdout.on('data', onData);
    }).catch(error => { stopHost('video-surface-handshake-failed'); throw error; });
    const parentRequests = new Map();
    let parentSequence = 0;
    let responseBuffer = '';
    const failParentRequests = error => {
      for (const request of parentRequests.values()) { clearTimeout(request.timer); request.reject(error); }
      parentRequests.clear();
    };
    child.on('exit', () => failParentRequests(new Error('原生视频表面宿主已退出')));
    child.on('error', failParentRequests);
    child.stdout.on('data', chunk => {
      responseBuffer += chunk.toString('utf8');
      if (Buffer.byteLength(responseBuffer) > MAX_HANDSHAKE_BYTES) { responseBuffer = ''; failParentRequests(new Error('原生视频表面响应过大')); return; }
      let newline;
      while ((newline = responseBuffer.indexOf('\n')) >= 0) {
        const line = responseBuffer.slice(0, newline); responseBuffer = responseBuffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          const request = parentRequests.get(response.requestId);
          if (!request || response.type !== 'parent-changed' || response.sessionId !== sessionId) continue;
          parentRequests.delete(response.requestId); clearTimeout(request.timer);
          if (response.success === true) request.resolve(); else request.reject(new Error('视频画面未能移动到目标窗口'));
        } catch { failParentRequests(new Error('原生视频表面响应无效')); }
      }
    });
    const reparent = nextWindow => new Promise((resolve, reject) => {
      if (closed || !child.stdin.writable || !nextWindow || nextWindow.isDestroyed()) { reject(new Error('视频目标窗口已关闭')); return; }
      const requestId = `${sessionId}:${++parentSequence}`;
      const timer = setTimeout(() => { parentRequests.delete(requestId); reject(new Error('视频画面换窗超时')); }, startupTimeoutMs);
      parentRequests.set(requestId, { resolve, reject, timer });
      try { child.stdin.write(`${JSON.stringify({ command: 'parent', parentHandle: nativeHandleValue(nextWindow), requestId })}\n`); }
      catch (error) { clearTimeout(timer); parentRequests.delete(requestId); reject(error); }
    });
    const setBounds = bounds => {
      if (closed || !child.stdin.writable) return false;
      try { child.stdin.write(`${JSON.stringify({ command: 'bounds', ...bounds })}\n`, error => { if (error) handleLifecycleError(error); }); return true; }
      catch (error) { writeLog('warn', 'Unable to position native video surface', { sessionId, error: error.message || String(error) }); return false; }
    };
    const close = () => {
      if (closeRequested) return; closeRequested = true; closed = true;
      failParentRequests(new Error('视频画面已关闭'));
      try { child.stdin.end(`${JSON.stringify({ command: 'close' })}\n`); } catch { /* already exited */ }
      const timer = setTimeout(() => {
        stopHost('video-surface-close');
      }, 1000); timer.unref?.();
    };
    return { setBounds, reparent, close, child, sessionId, expectedPid, surfaceHandle: childHandle };
  };
  return { attach };
};

module.exports = { createNativeVideoSurfaceService, nativeHandleValue };
