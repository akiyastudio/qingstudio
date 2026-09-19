const { applicationWindowFor } = require('../services/application-windows.cjs');
const { createVideoPlaybackProcessService } = require('../services/video-playback-process-service.cjs');
const { createVideoPlaybackBroker } = require('../services/video-playback-broker.cjs');
const { createNativeVideoSurfaceService } = require('../services/native-video-surface-service.cjs');
const { createMediaInputSessionService } = require('../services/media-input-session-service.cjs');
const { createVideoDisplayOutputService } = require('../services/video-display-output-service.cjs');
const { createPlaybackCaptureService } = require('../services/playback-capture-service.cjs');
const { createPlaybackSubtitleInputService } = require('../services/playback-subtitle-input-service.cjs');
const { playbackError } = require('../contracts/playback-errors.cjs');

const MAX_CAPTURE_BYTES = 100 * 1024 * 1024;
const validPngBytes = buffer => buffer.length >= 20
  && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  && buffer.subarray(buffer.length - 12).toString('hex') === '0000000049454e44ae426082';

const registerVideoPlaybackIpc = ({ BrowserWindow, app, crypto, dialog, fs, ipcMain, mediaService, path, pluginService, processSupervisor, screen, spawn, writeLog, VIDEO_EXTENSIONS: authoritativeVideoExtensions = null }) => {
  const playbackBroker = createVideoPlaybackBroker({ pluginService, path });
  const nativeSurfaceService = createNativeVideoSurfaceService({ app, path, processSupervisor, spawn, writeLog });
  const mediaInputSessionService = createMediaInputSessionService({ crypto, fs, path, authorizeProjectMedia: value => mediaService.authorizeInput(value) });
  const displayOutputService = createVideoDisplayOutputService({ screen });
  const captureService = createPlaybackCaptureService({ crypto, fs, path, authorizeProjectMedia: value => mediaService.authorizeInput(value) });
  const subtitleInputService = createPlaybackSubtitleInputService({ fs, path, authorizeProjectMedia: value => mediaService.authorizeInput(value) });
  const service = createVideoPlaybackProcessService({ BrowserWindow, captureService, crypto, displayOutputService, mediaInputSessionService, nativeSurfaceService, path, playbackBroker, processSupervisor, spawn, subtitleInputService, writeLog });
  ipcMain.handle('video-display-capabilities', event => {
    try { return { success: true, display: displayOutputService.describe(applicationWindowFor(event.sender, BrowserWindow)) }; }
    catch (error) { return { success: false, display: { displayId: '', scaleFactor: 1, colorSpace: '', hdrAvailable: false, reason: error.message || String(error), bounds: null }, error: error.message || String(error) }; }
  });
  const screenshotTarget = sourcePath => {
    const now = new Date();
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
    const parsed = path.parse(sourcePath);
    const id = crypto.randomUUID();
    return {
      finalPath: path.join(parsed.dir, `${parsed.name}_截图_${stamp}_${id.slice(0, 8)}.png`),
      temporaryPath: path.join(parsed.dir, `.${parsed.name}.${id}.photoflow-chromium-screenshot.png`),
    };
  };
  ipcMain.handle('video-playback-source', async (_event, filePath) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      return { success: true, mediaUrl: mediaService.toUrl(sourcePath, true) };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('video-playback-backends', async (_event, filePath, browserProbe) => {
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      return { success: true, backends: await playbackBroker.listDescriptors(sourcePath, browserProbe) };
    } catch (error) { return { success: false, backends: [], error: error.message || String(error) }; }
  });
  ipcMain.handle('video-player-publish-frame', async (_event, filePath, bytes) => {
    let temporaryPath = '';
    try {
      const sourcePath = await mediaService.authorizeInput(filePath);
      const sourceStat = await fs.promises.stat(sourcePath);
      if (!sourceStat.isFile() || authoritativeVideoExtensions instanceof Set && !authoritativeVideoExtensions.has(path.extname(sourcePath).toLowerCase())) throw new Error('视频源文件当前不可用');
      const declaredLength = Number(bytes?.byteLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 20 || declaredLength > MAX_CAPTURE_BYTES || !ArrayBuffer.isView(bytes) && !Buffer.isBuffer(bytes)) throw new Error('视频截图数据无效');
      const buffer = Buffer.from(bytes || []);
      if (buffer.length !== declaredLength || !validPngBytes(buffer)) throw new Error('视频截图数据无效');
      const target = screenshotTarget(sourcePath);
      temporaryPath = target.temporaryPath;
      await fs.promises.writeFile(temporaryPath, buffer, { flag: 'wx' });
      await fs.promises.rename(temporaryPath, target.finalPath);
      temporaryPath = '';
      return { success: true, path: target.finalPath };
    } catch (error) {
      if (temporaryPath) await fs.promises.unlink(temporaryPath).catch(() => undefined);
      return { success: false, error: error.message || String(error) };
    }
  });
  // Legacy IPC aliases remain for renderer compatibility; current UI uses video-player-* only.
  ipcMain.handle('advanced-video-start', async (event, filePath, arrowKeyAction, playerId, requestId) => {
    try { return { success: true, ...(await service.start(event, filePath, arrowKeyAction, playerId, requestId)) }; }
    catch (error) {
      writeLog('warn', 'Advanced video decoder start failed', { error: error.message || String(error) });
      return { success: false, error: error.message || String(error) };
    }
  });
  ipcMain.handle('video-player-start', async (event, filePath, settings, playerId, requestId, backendId) => {
    try { return { success: true, ...(await service.start(event, filePath, settings, playerId, requestId, backendId)) }; }
    catch (error) {
      writeLog('warn', 'Video player start failed', { error: error.message || String(error) });
      const normalized = playbackError(error, 'BACKEND_UNAVAILABLE'); return { success: false, error: normalized.message, errorCode: normalized.code, recoverable: normalized.recoverable, suggestedFallback: normalized.suggestedFallback };
    }
  });
  ipcMain.on('advanced-video-bounds', (event, sessionId, bounds) => service.setBounds(event, sessionId, bounds));
  ipcMain.on('advanced-video-control', (event, sessionId, request) => service.control(event, sessionId, request));
  ipcMain.on('video-player-control', (event, sessionId, request) => service.control(event, sessionId, request));
  ipcMain.on('video-player-bounds', (event, sessionId, bounds) => service.setBounds(event, sessionId, bounds));
  ipcMain.handle('video-player-subtitle-choose', async (event, sessionId) => {
    try {
      if (!service.ownsSession(sessionId, event.sender.id)) return { success: false, error: '视频播放会话不存在' };
      const owner = applicationWindowFor(event.sender, BrowserWindow);
      const result = await dialog.showOpenDialog(owner, { title: '添加本地字幕', properties: ['openFile'], filters: [{ name: '字幕文件', extensions: ['srt', 'ass', 'ssa', 'vtt'] }] });
      if (result.canceled || !result.filePaths[0]) return { success: true, cancelled: true };
      // The path crosses the Electron boundary only after the trusted native dialog returns it.
      service.addSubtitle(event, sessionId, result.filePaths[0]);
      return { success: true, path: result.filePaths[0] };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('video-subtitle-choose-file', async event => {
    try {
      const owner = applicationWindowFor(event.sender, BrowserWindow);
      const result = await dialog.showOpenDialog(owner, { title: '添加本地字幕', properties: ['openFile'], filters: [{ name: '字幕文件', extensions: ['vtt', 'srt', 'ass', 'ssa'] }] });
      if (result.canceled || !result.filePaths[0]) return { success: true, cancelled: true };
      const subtitlePath = path.resolve(result.filePaths[0]); const format = path.extname(subtitlePath).slice(1).toLowerCase();
      if (!['vtt', 'srt', 'ass', 'ssa'].includes(format) || !fs.existsSync(subtitlePath)) throw new Error('字幕文件不存在或格式不受支持');
      return { success: true, format, name: path.basename(subtitlePath), mediaUrl: format === 'vtt' ? mediaService.toUrl(subtitlePath, true) : undefined };
    } catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('video-player-subtitle-add', async (event, sessionId, filePath) => {
    try { service.addSubtitle(event, sessionId, await mediaService.authorizeInput(filePath)); return { success: true }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('advanced-video-screenshot', async (event, sessionId) => {
    try { return { success: true, ...(await service.screenshot(event, sessionId)) }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('video-player-screenshot', async (event, sessionId, mode) => {
    try { return { success: true, ...(await service.screenshot(event, sessionId, mode)) }; }
    catch (error) { return { success: false, error: error.message || String(error) }; }
  });
  ipcMain.handle('video-player-stop', (event, sessionId) => ({ success: service.stop(sessionId, event.sender.id) }));
  ipcMain.handle('advanced-video-stop', (event, sessionId) => ({ success: service.stop(sessionId, event.sender.id) }));
  service.describeBackends = (sourcePath,browserProbe) => playbackBroker.listDescriptors(sourcePath,browserProbe);
  return service;
};

module.exports = { registerVideoPlaybackIpc };
