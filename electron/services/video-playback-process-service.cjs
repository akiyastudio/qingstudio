const { applicationWindowFor, applicationHostFor } = require('./application-windows.cjs');
const { createMediaPlaybackProcessAdapter } = require('./media-playback-process-adapter.cjs');
const { cleanPlaybackDiagnostics } = require('../contracts/playback-diagnostics.cjs');
const { MAX_FRAME_BYTES } = require('../contracts/media-playback-backend-v1.cjs');

const START_TIMEOUT_MS = 8000;
const SCREENSHOT_TIMEOUT_MS = 30_000;
const SCREENSHOT_PROBE_MS = 40;
const CLIENT_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,96}$/;
const DEFAULT_SUBTITLE_FONT_SIZE = 55;
const normalizeSubtitleFontSize = value => {
  const migrated = value === 'large' ? 74 : value === 'default' ? DEFAULT_SUBTITLE_FONT_SIZE : Number(value);
  return Number.isFinite(migrated) ? Math.max(16, Math.min(120, Math.round(migrated))) : DEFAULT_SUBTITLE_FONT_SIZE;
};

const createVideoPlaybackProcessService = ({
  BrowserWindow, captureService, crypto, displayOutputService = null, mediaInputSessionService, nativeSurfaceService, path, playbackBroker, processSupervisor = null, spawn, writeLog,
  startupTimeoutMs = START_TIMEOUT_MS, screenshotTimeoutMs = SCREENSHOT_TIMEOUT_MS, screenshotProbeMs = SCREENSHOT_PROBE_MS, subtitleInputService = null,
}) => {
  const sessions = new Map();
  const sessionsByPlayer = new Map();
  const launches = new Map();

  const playerKey = (senderId, playerId) => `${senderId}:${playerId}`;
  const rejectPendingScreenshot = (session, requestId, pending, error, allowPublishing = false) => {
    if (session.pendingScreenshots.get(requestId) !== pending) return;
    if (pending.phase === 'publishing' && !allowPublishing) return;
    session.pendingScreenshots.delete(requestId);
    clearTimeout(pending.timer);
    pending.phase = 'settled';
    pending.cancelled = true;
    void Promise.resolve().then(() => captureService.abort(pending.stageId)).catch(() => undefined).then(() => pending.reject(error));
  };
  const captureOwner = session => ({ sessionId: session.id, componentId: session.componentId, processId: session.targetPid });
  const publishScreenshot = async (session, pending) => {
    if (pending.cancelled || pending.phase !== 'waiting') throw new Error('视频截图发布已取消');
    pending.phase = 'publishing'; clearTimeout(pending.timer);
    const result = await captureService.commit(pending.stageId, captureOwner(session), { deadlineAt: pending.deadlineAt, probeMs: screenshotProbeMs });
    return result.path;
  };
  const removeSession = session => {
    sessions.delete(session.id);
    const key = playerKey(session.sender.id, session.playerId);
    if (sessionsByPlayer.get(key) === session.id) sessionsByPlayer.delete(key);
    if (launches.get(key) === session.requestId) launches.delete(key);
  };

  const emit = (session, value) => {
    if (!session.sender.isDestroyed()) {
      const payload = { ...value, sessionId: session.id, playerId: session.playerId, requestId: session.requestId };
      try { session.sender.send('video-player-state', payload); }
      catch (error) { writeLog('warn', 'Unable to emit video player state', { sessionId: session.id, error: error.message || String(error) }); }
      // Legacy boundary: older installed renderers listen on this channel.
      try { session.sender.send('advanced-video-state', payload); }
      catch (error) { writeLog('warn', 'Unable to emit legacy video player state', { sessionId: session.id, error: error.message || String(error) }); }
    }
  };

  const sendCommand = (session, value) => {
    if (!session || session.stopped || !session.child.stdin.writable) return false;
    try {
      const { command, ...payload } = value;
      session.processAdapter.sendLegacy(command, payload);
      return true;
    } catch (error) {
      writeLog('warn', 'Unable to control advanced video decoder', { sessionId: session.id, error: error.message || String(error) });
      return false;
    }
  };

  const finalizeSession = (session, { emitStopped = false, readyError = null } = {}) => {
    if (!session || session.terminal) return false;
    const terminalError = readyError || new Error('视频播放启动已取消');
    session.terminal = true;
    session.terminalError = terminalError;
    session.stopped = true;
    if (session.startupTimer) {
      clearTimeout(session.startupTimer);
      session.startupTimer = null;
    }
    if (session.onSenderDestroyed) {
      session.sender.removeListener('destroyed', session.onSenderDestroyed);
      session.onSenderDestroyed = null;
    }
    removeSession(session);
    if (emitStopped) emit(session, { type: 'stopped' });
    try { session.processAdapter?.close(); } catch { /* already closed */ }
    try { session.surfaceController?.close(); } catch { /* already closed */ }
    session.surfaceController = null;
    try { mediaInputSessionService.revoke(session.id); } catch { /* authorization cleanup is best effort */ }
    if (session.rejectReady) {
      session.rejectReady(terminalError);
      session.rejectReady = null;
    }
    for (const pending of session.pendingScreenshots.values()) {
      try { rejectPendingScreenshot(session, pending.requestId, pending, new Error('视频播放已经停止')); } catch { /* continue finalizing remaining captures */ }
    }
    return true;
  };

  const stop = (sessionId, senderId) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || senderId !== undefined && session.sender.id !== senderId) return false;
    if (!finalizeSession(session, { emitStopped: true })) return false;
    try { session.child.stdin.end(); } catch { /* process already exited */ }
    const reportStopFailure = error => { try { writeLog('warn', 'Unable to stop advanced video decoder', { sessionId: session.id, error: error.message || String(error) }); } catch { /* logging must not escape cleanup */ } };
    const timer = setTimeout(() => {
      try {
        const result = session.managedProcess ? session.managedProcess.stop('advanced-video-stop') : !session.child.killed && session.child.kill();
        void Promise.resolve(result).catch(reportStopFailure);
      } catch (error) { reportStopFailure(error); }
    }, 1200);
    timer.unref?.();
    return true;
  };

  const stopForPlayer = (senderId, playerId) => {
    const id = sessionsByPlayer.get(playerKey(senderId, playerId));
    if (id) stop(id, senderId);
  };

  const start = async (event, filePath, requestedSettings = {}, playerId, requestId, requestedBackendId = '', trustedOwnerWindow = null) => {
    const settings = typeof requestedSettings === 'string'
      ? { arrowKeyAction: requestedSettings }
      : requestedSettings && typeof requestedSettings === 'object' ? requestedSettings : {};
    const sender = event.sender;
    const normalizedPlayerId = String(playerId || '');
    const normalizedRequestId = String(requestId || '');
    if (!CLIENT_TOKEN_PATTERN.test(normalizedPlayerId) || !CLIENT_TOKEN_PATTERN.test(normalizedRequestId)) throw new Error('视频播放器请求标识无效');
    const key = playerKey(sender.id, normalizedPlayerId);
    launches.set(key, normalizedRequestId);
    stopForPlayer(sender.id, normalizedPlayerId);
    let session = null;
    let inputSessionId = '';
    let launchedChild = null;
    let launchedManaged = null;
    let launchAborted = false;
    let onSenderDestroyed = null;
    const assertCurrentLaunch = () => {
      if (session?.terminal) throw session.terminalError || new Error('视频播放已经终止');
      if (launches.get(key) !== normalizedRequestId) throw new Error('视频播放器请求已被替换');
      if (launchAborted || sender.isDestroyed?.()) throw new Error('照片流窗口已经关闭');
    };

    try {
      const ownerWindow = trustedOwnerWindow || applicationWindowFor(sender, BrowserWindow);
      if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error('照片流窗口已经关闭');
      const backendId = String(requestedBackendId || playbackBroker.defaultBackendId());
      if (!backendId) throw new Error('没有可用的高级视频播放后端');
      const backendOwner = playbackBroker.ownerForBackend?.(backendId) || { componentId: 'playback-backend' };
      const id = crypto.randomUUID();
      inputSessionId = id;
      onSenderDestroyed = () => {
        launchAborted = true;
        if (session) stop(id, sender.id);
        else {
          if (launches.get(key) === normalizedRequestId) launches.delete(key);
          mediaInputSessionService.revoke(id);
          if (launchedManaged) void launchedManaged.stop('playback-launch-aborted').catch(()=>undefined); else if (launchedChild && !launchedChild.killed) { try { launchedChild.kill(); } catch { /* launch already exited */ } }
        }
      };
      sender.once('destroyed', onSenderDestroyed);
      await mediaInputSessionService.prepare({ filePath, componentId: backendOwner.componentId, backendId, sessionId: id });
      assertCurrentLaunch();
      const runConfig = await playbackBroker.resolveRunConfigAsync(backendId, ['--session-id', id]);
      assertCurrentLaunch();
      const managedProcess = processSupervisor?.launch({
        id: `component:advanced-video:${id}`,
        kind: 'media-playback-backend',
        protocol: 'media-playback-backend-v1',
        owner: { componentId: backendOwner.componentId, playbackSessionId: id, backendId },
        command: runConfig.command,
        args: runConfig.args,
        windowsJob: true,
        options: { cwd: path.dirname(runConfig.command), stdio: ['pipe', 'pipe', 'pipe'] },
        health: { startupTimeoutMs },
        onExitCleanup: ({ child: exitedChild }) => {
          mediaInputSessionService.revokePlaybackSession?.(id);
          captureService.abortSession?.(id);
          const exitedTargetPid = exitedChild?.targetPid || exitedChild?.pid;
          if (exitedTargetPid) { mediaInputSessionService.revokeProcess?.(exitedTargetPid); captureService.abortProcess?.(exitedTargetPid); }
        },
        ephemeral: true,
      });
      const child = managedProcess?.child || spawn(runConfig.command, runConfig.args, {
        cwd: path.dirname(runConfig.command), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      launchedChild = child;
      launchedManaged = managedProcess;
      if (child.ready && typeof child.ready.then === 'function') await child.ready;
      assertCurrentLaunch();
      const targetPid = Number(child.targetPid || child.pid);
      if (!Number.isSafeInteger(targetPid) || targetPid <= 0) throw new Error('视频播放后端未提供有效的目标进程标识');
      session = {
        id,
        sender,
        child,
        targetPid,
        managedProcess,
        playerId: normalizedPlayerId,
        requestId: normalizedRequestId,
        filePath: '',
        stopped: false,
        terminal: false,
        terminalError: null,
        startupTimer: null,
        ready: false,
        lastError: '',
        pendingScreenshots: new Map(),
        onSenderDestroyed,
        rejectReady: null,
        processAdapter: null,
        ownerWindow,
        hostVisible: applicationHostFor(sender)?.visible !== false,
        componentId: backendOwner.componentId,
        backendId,
        processId: 0,
        inputToken: '',
        pendingAuthorizedSubtitles: [],
        mediaLoaded: false,
        surfaceAttachPromise: null,
        surfaceAttachError: null,
        surfaceController: null,
        lastDisplayKey: '',
      };
      session.processAdapter = createMediaPlaybackProcessAdapter({
        sessionId: id,
        writeLine: line => session.child.stdin.write(`${line}\n`),
      });
      sessions.set(id, session);
      sessionsByPlayer.set(key, id);

      let buffered = Buffer.alloc(0);
      let settleReady;
      let rejectReady;
      const readyPromise = new Promise((resolve, reject) => {
        settleReady = resolve;
        rejectReady = reject;
        session.rejectReady = reject;
      });
      // Observe early startup failures immediately. Awaiting the original
      // promise later still propagates the same rejection.
      void readyPromise.catch(() => undefined);
      const startupTimer = setTimeout(() => { session.startupTimer = null; const error = new Error('视频播放器启动超时，请在组件管理中修复或重新安装视频播放器运行时'); error.code = 'STARTUP_TIMEOUT'; rejectReady(error); }, startupTimeoutMs);
      session.startupTimer = startupTimer;
      startupTimer.unref?.();

      const consumeLine = line => {
        if (session.stopped || !line.trim()) return;
        let received;
        try { received = session.processAdapter.receiveLine(line); }
        catch {
          writeLog('warn', 'Advanced video decoder emitted an invalid v1 frame', { line: line.slice(0, 500) });
          return;
        }
        const value = { ...received.payload, type: received.type };
        if (value.type === 'file-loaded') {
          session.mediaLoaded = true;
          for (const subtitlePath of session.pendingAuthorizedSubtitles) sendCommand(session, { command: 'subtitle-add', path: subtitlePath });
          session.pendingAuthorizedSubtitles = [];
        }
        if (value.type === 'diagnostic') {
          try { emit(session, { type: 'diagnostic', diagnostic: cleanPlaybackDiagnostics(value.diagnostic) }); }
          catch (error) { writeLog('warn', 'Playback backend emitted invalid diagnostics', { sessionId: session.id, error: error.message || String(error) }); }
          return;
        }
        if (value.type === 'surface-created') {
          if (session.surfaceAttachPromise) return;
          session.surfaceAttachPromise = nativeSurfaceService.attach({ ownerWindow: session.ownerWindow, componentProcess: { pid: session.targetPid }, surfaceHandle: value.surfaceHandle, sessionId: session.id, onLost: error => { if (!session.stopped) emit(session, { type: 'fatal', errorCode: 'SURFACE_LOST', error: error.message }); } })
            .then(controller => {
              if (session.stopped) { controller.close(); return controller; }
              session.surfaceController = controller; return controller;
            }, error => { session.surfaceAttachError = error; rejectReady(error); return null; });
          return;
        }
        if (value.type === 'screenshot-result') {
          const screenshotRequestId = String(value.requestId || '');
          const pending = session.pendingScreenshots.get(screenshotRequestId);
          if (!pending) return;
          if (pending.componentCompleted) return;
          if (!value.success) {
            rejectPendingScreenshot(session, screenshotRequestId, pending, new Error(String(value.error || '无法保存当前视频帧')));
            return;
          }
          pending.componentCompleted = true;
          void publishScreenshot(session, pending).then(finalPath => {
            if (session.pendingScreenshots.get(screenshotRequestId) !== pending) return;
            session.pendingScreenshots.delete(screenshotRequestId);
            clearTimeout(pending.timer);
            pending.phase = 'settled';
            pending.resolve({ path: finalPath });
          }, error => rejectPendingScreenshot(session, screenshotRequestId, pending, error, true));
          return;
        }
        if (value.type === 'ready') {
          if (!session.surfaceAttachPromise) { rejectReady(new Error('视频后端未声明原生渲染表面')); return; }
          void session.surfaceAttachPromise.then(controller => {
            if (!controller || session.stopped || session.surfaceAttachError) return;
            session.ready = true;
            session.managedProcess?.markHealthy({ protocol: 'media-playback-backend-v1' });
            session.rejectReady = null;
            clearTimeout(startupTimer);
            session.startupTimer = null;
            settleReady();
          }, rejectReady);
        } else if (value.type === 'fatal') {
          session.lastError = String(value.error || '视频播放器启动失败');
          clearTimeout(startupTimer);
          session.startupTimer = null;
          rejectReady(new Error(session.lastError));
        }
        emit(session, value);
      };
      const failProtocol = () => {
        const error = new Error('视频播放后端输出帧超过 256 KiB');
        session.lastError = error.message;
        rejectReady(error);
        if (!session.stopped) emit(session, { type: 'fatal', errorCode: 'BACKEND_CRASHED', error: error.message });
        try { const result = session.managedProcess ? session.managedProcess.stop('advanced-video-invalid-protocol') : child.kill(); void Promise.resolve(result).catch(() => undefined); } catch { /* process already exited */ }
      };
      child.stdout.on('data', chunk => {
        let incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        while (incoming.length) {
          const newline = incoming.indexOf(0x0a);
          const segmentLength = newline < 0 ? incoming.length : newline;
          if (buffered.length + segmentLength > MAX_FRAME_BYTES + 1) { buffered = Buffer.alloc(0); failProtocol(); return; }
          buffered = Buffer.concat([buffered, incoming.subarray(0, segmentLength)]);
          if (newline < 0) {
            if (buffered.length === MAX_FRAME_BYTES + 1 && buffered[buffered.length - 1] !== 0x0d) { buffered = Buffer.alloc(0); failProtocol(); }
            return;
          }
          if (buffered.length > MAX_FRAME_BYTES && buffered[buffered.length - 1] !== 0x0d) { buffered = Buffer.alloc(0); failProtocol(); return; }
          const line = buffered.toString('utf8').replace(/\r$/, '');
          buffered = Buffer.alloc(0);
          incoming = incoming.subarray(newline + 1);
          consumeLine(line);
        }
      });
      child.stdout.on('error', error => { session.lastError = error.message || String(error); rejectReady(error); });
      child.stdin.on('error', error => { if (!session.stopped) writeLog('warn', 'Playback backend stdin failed', { sessionId: id, error: error.message || String(error) }); });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
      child.once('error', error => {
        session.lastError = error.message || String(error);
        clearTimeout(startupTimer);
        session.startupTimer = null;
        rejectReady(error);
        if (!session.stopped) emit(session, { type: 'fatal', errorCode: 'BACKEND_CRASHED', error: session.lastError });
      });
      child.once('exit', code => {
        clearTimeout(startupTimer);
        session.startupTimer = null;
        const wasReady = session.ready; const wasStopped = session.stopped;
        const exitMessage = session.lastError || stderr.trim() || `视频播放器退出（${code ?? '未知'}），请修复或重新安装视频播放器运行时`;
        finalizeSession(session, { readyError: new Error(exitMessage) });
        if (wasReady && !wasStopped) emit(session, { type: 'fatal', errorCode: 'BACKEND_CRASHED', error: session.lastError || stderr.trim() || '视频播放器意外退出，请重新打开视频；若持续失败请修复视频播放器运行时' });
        writeLog(code === 0 || wasStopped ? 'info' : 'warn', 'Advanced video decoder exited', { sessionId: id, code, error: stderr.trim() });
      });

      const inputGrant = mediaInputSessionService.bindProcess({ componentId: backendOwner.componentId, backendId, sessionId: id, processId: targetPid });
      session.inputToken = inputGrant.token;
      const inputOwner = { componentId: backendOwner.componentId, backendId, sessionId: id, processId: targetPid };
      session.processId = targetPid;
      const authorizedPathPromise = Promise.resolve(mediaInputSessionService.resolve(inputGrant.token, inputOwner));
      const authorizedPath = await authorizedPathPromise;
      session.filePath = authorizedPath;
      assertCurrentLaunch();
      await readyPromise;
      assertCurrentLaunch();
      if (!sendCommand(session, { command: 'open', path: authorizedPath })) throw new Error('无法向视频播放器发送文件');
      sendCommand(session, { command: 'subtitle-style', fontSize: normalizeSubtitleFontSize(settings.subtitleSize), style: settings.subtitleStyle === 'high-contrast' ? 'high-contrast' : 'standard' });
      if (settings.muted === true) sendCommand(session, { command: 'mute', value: true });
      if (!sendCommand(session, { command: 'play' })) throw new Error('无法启动视频播放器');
      // A slow/unavailable sidecar directory must not delay the first frame.
      // Only attach authorized subtitles to the still-current, loaded session.
      if (subtitleInputService) void Promise.resolve().then(() => subtitleInputService.discover(authorizedPath)).then(subtitles => {
        if (session.stopped) return;
        if (session.mediaLoaded) {
          for (const subtitlePath of subtitles) sendCommand(session, { command: 'subtitle-add', path: subtitlePath });
        } else session.pendingAuthorizedSubtitles = subtitles;
      }).catch(error => writeLog('warn', 'Unable to discover video sidecar subtitles', { sessionId: id, error: error.message || String(error) }));
      writeLog('info', 'Advanced video decoder started', { sessionId: id, filePath: authorizedPath });
      return { sessionId: id, playerId: normalizedPlayerId, requestId: normalizedRequestId };
    } catch (error) {
      if (session) stop(session.id, sender.id);
      else {
        if (onSenderDestroyed) sender.removeListener('destroyed', onSenderDestroyed);
        if (inputSessionId) mediaInputSessionService.revoke(inputSessionId);
        if (launchedManaged) await launchedManaged.stop('playback-launch-failed').catch(()=>undefined); else if (launchedChild && !launchedChild.killed) { try { launchedChild.kill(); } catch { /* launch already exited */ } }
        if (launches.get(key) === normalizedRequestId) launches.delete(key);
      }
      throw error;
    }
  };

  const setBounds = (event, sessionId, bounds = {}) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.sender.id !== event.sender.id) return;
    session.lastRequestedBounds = bounds;
    const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
    const width = Math.max(0, Math.min(32768, number(bounds.width)));
    const height = Math.max(0, Math.min(32768, number(bounds.height)));
    const requestedHole = bounds.overlayHole && typeof bounds.overlayHole === 'object' ? bounds.overlayHole : {};
    const holeX = Math.max(0, Math.min(width, number(requestedHole.x)));
    const holeY = Math.max(0, Math.min(height, number(requestedHole.y)));
    const holeWidth = Math.max(0, Math.min(width - holeX, number(requestedHole.width)));
    const holeHeight = Math.max(0, Math.min(height - holeY, number(requestedHole.height)));
    const holeRadius = Math.max(0, Math.min(Math.min(holeWidth, holeHeight) / 2, number(requestedHole.radius)));
    const requestedControlsHole = bounds.controlsOverlayHole && typeof bounds.controlsOverlayHole === 'object' ? bounds.controlsOverlayHole : {};
    const controlsHoleX = Math.max(0, Math.min(width, number(requestedControlsHole.x)));
    const controlsHoleY = Math.max(0, Math.min(height, number(requestedControlsHole.y)));
    const controlsHoleWidth = Math.max(0, Math.min(width - controlsHoleX, number(requestedControlsHole.width)));
    const controlsHoleHeight = Math.max(0, Math.min(height - controlsHoleY, number(requestedControlsHole.height)));
    const requestedCornerHole = bounds.cornerOverlayHole && typeof bounds.cornerOverlayHole === 'object' ? bounds.cornerOverlayHole : {};
    const cornerHoleX = Math.max(0, Math.min(width, number(requestedCornerHole.x)));
    const cornerHoleY = Math.max(0, Math.min(height, number(requestedCornerHole.y)));
    const cornerHoleWidth = Math.max(0, Math.min(width - cornerHoleX, number(requestedCornerHole.width)));
    const cornerHoleHeight = Math.max(0, Math.min(height - cornerHoleY, number(requestedCornerHole.height)));
    session.surfaceController?.setBounds({
      x: Math.max(-32768, Math.min(32768, number(bounds.x))),
      y: Math.max(-32768, Math.min(32768, number(bounds.y))),
      width,
      height,
      visible: session.hostVisible !== false && Boolean(bounds.visible) && width > 1 && height > 1,
      holeX,
      holeY,
      holeWidth,
      holeHeight,
      holeRadius,
      controlsHoleX,
      controlsHoleY,
      controlsHoleWidth,
      controlsHoleHeight,
      cornerHoleX,
      cornerHoleY,
      cornerHoleWidth,
      cornerHoleHeight,
    });
    if (displayOutputService) {
      const viewport = bounds.viewportDip && typeof bounds.viewportDip === 'object' ? bounds.viewportDip : null;
      const output = displayOutputService.describe(session.ownerWindow, { x: number(bounds.x), y: number(bounds.y), width, height }, viewport);
      const displayKey = `${output.displayId}:${output.scaleFactor}:${output.colorSpace}:${output.hdrAvailable}`;
      if (displayKey !== session.lastDisplayKey) {
        session.lastDisplayKey = displayKey;
        sendCommand(session, { command: 'display-output', output });
        emit(session, { type: 'display-output', display: output });
      }
    }
  };

  const control = (event, sessionId, request = {}) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.sender.id !== event.sender.id) return;
    // Fullscreen belongs to the host's surface controller, not the decoder's
    // embedded libmpv window options or a second renderer/player session.
    if (request.action === 'fullscreen') {
      if (request.value !== undefined && typeof request.value !== 'boolean') return;
      if (request.value !== false && (session.hostVisible === false || !session.lastRequestedBounds?.visible)) return;
      session.surfaceController?.setFullscreen(request.value);
      return;
    }
    const allowed = new Set(['play', 'pause', 'seek', 'frame-step', 'frame-back-step', 'volume', 'mute', 'speed', 'stop', 'subtitle-select', 'subtitle-visible', 'subtitle-delay', 'subtitle-style', 'audio-select', 'transform', 'hdr-mode', 'tone-mapping', 'statistics-level']);
    const command = String(request.action || '');
    if (!allowed.has(command)) return;
    sendCommand(session, {
      command,
      value: request.value,
      fontSize: command === 'subtitle-style' ? normalizeSubtitleFontSize(request.fontSize ?? request.size) : undefined,
      style: request.style,
      transform: command === 'transform' ? request.transform : undefined,
      hdrMode: command === 'hdr-mode' ? request.hdrMode : undefined,
      toneMapping: command === 'tone-mapping' ? request.toneMapping : undefined,
      targetPeakNits: command === 'tone-mapping' ? request.targetPeakNits : undefined,
      statisticsLevel: command === 'statistics-level' ? request.statisticsLevel : undefined,
    });
  };

  const ownsSession = (sessionId, senderId) => {
    const session = sessions.get(String(sessionId || ''));
    return Boolean(session && !session.stopped && session.sender.id === senderId);
  };

  const addSubtitle = (event, sessionId, filePath) => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.stopped || session.sender.id !== event.sender.id) throw new Error('视频播放会话不存在');
    if (!['.srt', '.ass', '.ssa', '.vtt'].includes(path.extname(filePath).toLowerCase())) throw new Error('仅支持 SRT、ASS、SSA 和 VTT 字幕');
    if (!sendCommand(session, { command: 'subtitle-add', path: filePath })) throw new Error('无法向视频播放器添加字幕');
  };

  const screenshot = async (event, sessionId, requestedMode = 'displayedFrame') => {
    const session = sessions.get(String(sessionId || ''));
    if (!session || session.sender.id !== event.sender.id || session.stopped) throw new Error('视频播放会话不存在');
    const requestId = crypto.randomUUID();
    const stage = await captureService.create({ ...captureOwner(session), sourcePath: session.filePath });
    const resolvedStage = captureService.resolve(stage.stageId, captureOwner(session));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = session.pendingScreenshots.get(requestId);
        if (pending) rejectPendingScreenshot(session, requestId, pending, new Error('保存当前视频帧超时'));
      }, screenshotTimeoutMs);
      timer.unref?.();
      const pending = {
        requestId, stageId: stage.stageId, resolve, reject, timer,
        deadlineAt: Date.now() + screenshotTimeoutMs, componentCompleted: false,
        cancelled: false, phase: 'waiting',
      };
      session.pendingScreenshots.set(requestId, pending);
      const captureMode = requestedMode === 'sourceFrame' ? 'sourceFrame' : 'displayedFrame';
      if (!sendCommand(session, { command: 'screenshot', requestId, stageId: stage.stageId, path: resolvedStage.stagePath, captureMode })) {
        rejectPendingScreenshot(session, requestId, pending, new Error('无法向视频解码组件发送截图命令'));
      }
    });
  };

  const moveHost = async (sender, ownerWindow) => {
    for (const session of sessions.values()) {
      if (session.sender.id !== sender.id || session.stopped) continue;
      if (session.surfaceAttachPromise) await session.surfaceAttachPromise;
      if (session.surfaceController) await session.surfaceController.reparent(ownerWindow);
      session.ownerWindow = ownerWindow;
      session.lastDisplayKey = '';
      if (session.lastRequestedBounds) setBounds({ sender }, session.id, session.lastRequestedBounds);
    }
  };
  const setHostVisible = (sender, visible) => {
    for (const session of sessions.values()) if (session.sender.id === sender.id && !session.stopped) {
      session.hostVisible = visible;
      if (session.lastRequestedBounds) setBounds({ sender }, session.id, session.lastRequestedBounds);
    }
  };

  const dispose = () => {
    for (const session of [...sessions.values()]) stop(session.id);
  };

  return { start, setBounds, control, addSubtitle, ownsSession, screenshot, stop, dispose, moveHost, setHostVisible, sessions, sessionsByPlayer, launches };
};

module.exports = { createVideoPlaybackProcessService };
