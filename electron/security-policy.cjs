const path = require('path');
const { applicationHostFor, withApplicationHost } = require('./services/application-windows.cjs');
const { fileURLToPath } = require('url');

const RENDERER_PYTHON_TOOLS = new Set([
  'catch.py',
  'classify.py',
  'cut_video.py',
  'ffmpeg_transcode.py',
  'png_to_jpg.py',
  'research.py',
]);

const DEFAULT_EXTERNAL_HTTPS_HOSTS = new Set([
  'chromium.googlesource.com',
  'dev.perl.org',
  'developer.nvidia.com',
  'dl.fbaipublicfiles.com',
  'docs.nvidia.com',
  'docs.python.org',
  'download.openmmlab.com',
  'drive.google.com',
  'exiftool.org',
  'ffmpeg.org',
  'github.com',
  'huggingface.co',
  'pan.quark.cn',
  'pyinstaller.org',
  'qingstudio.cn',
  'ubuntu.com',
  'www.gnu.org',
]);

const normalizeBundledPythonTool = scriptName => {
  if (typeof scriptName !== 'string') throw new TypeError('Python tool name must be a string');
  const trimmed = scriptName.trim();
  const normalized = trimmed.toLowerCase().endsWith('.py') ? trimmed : `${trimmed}.py`;
  if (!/^[a-z0-9_]+\.py$/i.test(normalized)) throw new Error('Invalid Python tool name');
  return normalized;
};

const normalizeDevelopmentRendererUrl = value => {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('PHOTOFLOW_DEV_SERVER_URL must be a valid URL'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== 'localhost' || !/^\d+$/.test(parsed.port) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('PHOTOFLOW_DEV_SERVER_URL must be an http://localhost:<port>/ origin');
  }
  return parsed.origin;
};

const validateRendererPythonInvocation = (scriptName, args, requestId) => {
  const normalizedScriptName = normalizeBundledPythonTool(scriptName);
  if (!RENDERER_PYTHON_TOOLS.has(normalizedScriptName)) throw new Error('Python tool is not available to the renderer');
  if (!Array.isArray(args) || args.length > 256) throw new TypeError('Invalid Python tool arguments');
  const normalizedArgs = args.map(value => {
    if (typeof value !== 'string' || value.length > 32768 || /[\0\r\n]/.test(value)) {
      throw new TypeError('Invalid Python tool argument');
    }
    return value;
  });
  const normalizedRequestId = String(requestId || '');
  if (normalizedRequestId && !/^[a-z0-9-]{8,80}$/i.test(normalizedRequestId)) throw new Error('Invalid Python request identifier');
  return { scriptName: normalizedScriptName, args: normalizedArgs, requestId: normalizedRequestId };
};

const isTrustedRendererUrl = (value, { development = false, developmentRendererUrl = '', rendererFile = '' } = {}) => {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    if (development) {
      const trusted = new URL(developmentRendererUrl);
      return parsed.protocol === 'http:' && parsed.hostname === 'localhost' && parsed.origin === trusted.origin;
    }
    if (parsed.protocol !== 'file:' || !rendererFile) return false;
    return path.resolve(fileURLToPath(parsed)) === path.resolve(rendererFile);
  } catch {
    return false;
  }
};

const normalizeExternalUrl = (value, { allowedHttpsHosts = DEFAULT_EXTERNAL_HTTPS_HOSTS } = {}) => {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'mailto:') {
      if (parsed.pathname.toLowerCase() !== 'akiyastudio@qq.com' || parsed.search || parsed.hash) return null;
      return parsed.toString();
    }
    if (parsed.protocol !== 'https:' || !allowedHttpsHosts.has(parsed.hostname.toLowerCase())) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const createSecureIpcMain = ({ ipcMain, isTrustedEvent, onRejected = () => undefined }) => ({
  handle(channel, listener) {
    return ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedEvent(event)) {
        onRejected(channel, event);
        throw new Error('Unauthorized IPC sender');
      }
      return withApplicationHost(applicationHostFor(event.sender), () => listener(event, ...args));
    });
  },
  on(channel, listener) {
    return ipcMain.on(channel, (event, ...args) => {
      if (!isTrustedEvent(event)) {
        onRejected(channel, event);
        return;
      }
      return withApplicationHost(applicationHostFor(event.sender), () => listener(event, ...args));
    });
  },
  once(channel, listener) {
    return ipcMain.once(channel, (event, ...args) => {
      if (!isTrustedEvent(event)) {
        onRejected(channel, event);
        return;
      }
      return withApplicationHost(applicationHostFor(event.sender), () => listener(event, ...args));
    });
  },
  removeHandler(channel) {
    return ipcMain.removeHandler(channel);
  },
});

const createElectronSecurity = ({ electronIpcMain, getMainWindow, isDevelopment, developmentRendererUrl = '', rendererFile, shell, writeLog }) => {
  const trustedRenderer = value => isTrustedRendererUrl(value, { development: isDevelopment(), developmentRendererUrl, rendererFile });
  const isTrustedEvent = event => {
    const mainWindow = getMainWindow();
    const sender = event?.sender;
    if (!mainWindow || mainWindow.isDestroyed() || !sender || sender.isDestroyed()) return false;
    const registered = applicationHostFor(sender);
    return (registered ? registered.webContents === sender : sender.id === mainWindow.webContents.id)
      && (!sender.mainFrame || event.senderFrame === sender.mainFrame)
      && trustedRenderer(event.senderFrame?.url || sender.getURL());
  };
  const openAllowedExternalUrl = async value => {
    const safeUrl = normalizeExternalUrl(value);
    if (!safeUrl) throw new Error('External URL is not allowed');
    await shell.openExternal(safeUrl);
  };
  const ipcMain = createSecureIpcMain({
    ipcMain: electronIpcMain,
    isTrustedEvent,
    onRejected: (channel, event) => writeLog('warn', 'Rejected untrusted IPC sender', {
      channel,
      senderUrl: event?.senderFrame?.url || event?.sender?.getURL?.() || '',
    }),
  });
  const configureWindowSecurity = browserWindow => {
    browserWindow.webContents.setWindowOpenHandler(({ url }) => {
      void openAllowedExternalUrl(url).catch(error => writeLog('warn', 'Blocked external window request', { url, error: error.message }));
      return { action: 'deny' };
    });
    browserWindow.webContents.on('will-navigate', (event, url) => {
      if (trustedRenderer(url)) return;
      event.preventDefault();
      writeLog('warn', 'Blocked renderer navigation', { url });
    });
    browserWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    browserWindow.webContents.session.setPermissionCheckHandler(() => false);
    browserWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  };
  return { configureWindowSecurity, ipcMain, openAllowedExternalUrl };
};

module.exports = {
  DEFAULT_EXTERNAL_HTTPS_HOSTS,
  RENDERER_PYTHON_TOOLS,
  createElectronSecurity,
  createSecureIpcMain,
  isTrustedRendererUrl,
  normalizeBundledPythonTool,
  normalizeDevelopmentRendererUrl,
  normalizeExternalUrl,
  validateRendererPythonInvocation,
};
