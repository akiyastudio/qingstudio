const { contextBridge, ipcRenderer, webUtils } = require('electron');

const notificationFailure = (code, message) => Object.freeze({ accepted: false, error: Object.freeze({ code, message, retryable: false }) });
const normalizeNotification = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return notificationFailure('NOTIFICATION_INVALID_PAYLOAD', 'Notification payload must be an object');
  const unknown = Object.keys(value).find(key => !['tone', 'message', 'dedupeKey'].includes(key));
  if (unknown) return notificationFailure('NOTIFICATION_INVALID_PAYLOAD', `Unknown notification field: ${unknown}`);
  if (!['info', 'success', 'warning', 'error'].includes(value.tone)) return notificationFailure('NOTIFICATION_INVALID_TONE', 'Notification tone is invalid');
  if (typeof value.message !== 'string' || value.message.length > 360 || !value.message.trim()) return notificationFailure('NOTIFICATION_INVALID_MESSAGE', 'Notification message must contain 1-360 characters');
  if (value.dedupeKey !== undefined && (typeof value.dedupeKey !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(value.dedupeKey))) return notificationFailure('NOTIFICATION_INVALID_DEDUPE_KEY', 'Notification dedupeKey is invalid');
  return Object.freeze({ tone: value.tone, message: value.message.trim(), ...(value.dedupeKey ? { dedupeKey: value.dedupeKey } : {}) });
};
const notify = payload => { const normalized = normalizeNotification(payload); return normalized.accepted === false ? Promise.resolve(normalized) : ipcRenderer.invoke('component-sdk:notify', normalized); };
let contentSizeFrame = 0;
let lastContentSize = '';
const reportContentSize = () => {
  contentSizeFrame = 0;
  const body = document.body;
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const computed = getComputedStyle(body);
  const marginX = (Number.parseFloat(computed.marginLeft) || 0) + (Number.parseFloat(computed.marginRight) || 0);
  const marginY = (Number.parseFloat(computed.marginTop) || 0) + (Number.parseFloat(computed.marginBottom) || 0);
  const size = { width: Math.ceil(rect.width + marginX), height: Math.ceil(rect.height + marginY) };
  if (size.width < 1 || size.height < 1 || size.width > 20000 || size.height > 20000) return;
  const identity = `${size.width}:${size.height}`;
  if (identity === lastContentSize) return;
  lastContentSize = identity;
  void ipcRenderer.invoke('component-sdk:content-size', size).catch(() => undefined);
};
const scheduleContentSize = () => { if (!contentSizeFrame) contentSizeFrame = requestAnimationFrame(reportContentSize); };
window.addEventListener('DOMContentLoaded', () => {
  const observer = new ResizeObserver(scheduleContentSize);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  const mutations = new MutationObserver(scheduleContentSize);
  if (document.body) mutations.observe(document.body, { attributes: true, childList: true, subtree: true });
  scheduleContentSize();
}, { once: true });

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') throw new TypeError('Component lifecycle callback must be a function');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
let playbackBoundsSequence=0;
const previewListeners = new Set();
let previewSubscription = null;
let previewSnapshot = null;
ipcRenderer.on('component-sdk:preview-changed', (_event, value) => {
  if (previewSnapshot && value.revision < previewSnapshot.revision) return;
  previewSnapshot = value; for (const callback of previewListeners) callback(value);
});
ipcRenderer.on('component-sdk:context-changed', () => {
  if (previewListeners.size) void ipcRenderer.invoke('component-sdk:preview', { action: 'subscribe' }).then(value => { previewSnapshot = value; for (const callback of previewListeners) callback(value); }).catch(() => undefined);
});

contextBridge.exposeInMainWorld('photoFlowComponent', Object.freeze({
  // Bridge ABI version; this is independent from the unversioned Host API.
  contractVersion: 1,
  setPlaybackPaused: (sessionId,paused) => {if(typeof sessionId!=='string'||!sessionId||sessionId.length>128||typeof paused!=='boolean')throw new TypeError('Invalid playback pause state');return ipcRenderer.invoke('component-sdk:playback-paused',{sessionId,paused}).then(()=>undefined);},
  setPlaybackBounds: (sessionId,bounds) => {if(typeof sessionId!=='string'||sessionId.length>128||!bounds||['x','y','width','height'].some(key=>!Number.isFinite(bounds[key]))||typeof bounds.visible!=='boolean')throw new TypeError('Invalid playback layout');const holes={};for(const key of ['overlayHole','controlsOverlayHole','cornerOverlayHole']){const hole=bounds[key];if(!hole)continue;if(['x','y','width','height'].some(k=>!Number.isFinite(hole[k])))throw new TypeError('Invalid playback overlay');holes[key]={x:hole.x,y:hole.y,width:hole.width,height:hole.height,...(Number.isFinite(hole.radius)?{radius:hole.radius}:{})};}ipcRenderer.send('component-sdk:playback-bounds',{sessionId,bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height,visible:bounds.visible,...holes},sequence:++playbackBoundsSequence});},
  onPlaybackState: callback => subscribe('video-player-state', callback),
  getContext: () => ipcRenderer.invoke('component-sdk:get-context'),
  setPanelInfo: info => ipcRenderer.invoke('component-sdk:panel-info', { action: 'update', ...info }),
  getPreview: () => ipcRenderer.invoke('component-sdk:preview', { action: 'get' }),
  seekPreview: (sessionId, time) => ipcRenderer.invoke('component-sdk:preview', { action: 'seek', sessionId, time }),
  onPreviewChange: async callback => {
    if (typeof callback !== 'function') throw new TypeError('Preview callback must be a function');
    const listener = value => callback(value); previewListeners.add(listener);
    if (!previewSubscription) previewSubscription = ipcRenderer.invoke('component-sdk:preview', { action: 'subscribe' });
    try { const initial = await previewSubscription; const latest = previewSnapshot && previewSnapshot.revision > initial.revision ? previewSnapshot : initial; listener(latest); }
    catch (error) { previewListeners.delete(listener); if (!previewListeners.size) previewSubscription = null; throw error; }
    return () => { previewListeners.delete(listener); if (!previewListeners.size) { previewSubscription = null; previewSnapshot = null; void ipcRenderer.invoke('component-sdk:preview', { action: 'unsubscribe' }).catch(() => undefined); } };
  },
  authorizeFiles: files => {
    const filePaths = Array.from(files || []).slice(0, 120).map(file => {
      try { return webUtils.getPathForFile(file); } catch { return ''; }
    }).filter(Boolean);
    return ipcRenderer.invoke('component-sdk:authorize-files', filePaths);
  },
  notify,
  dialog: payload => ipcRenderer.invoke('component-sdk:dialog', payload),
  rpc: (method, payload) => ipcRenderer.invoke('component-sdk:rpc', String(method || ''), payload),
  onEvent: (topic, callback) => {
    const normalizedTopic = String(topic || '');
    if (typeof callback !== 'function') throw new TypeError('Component event callback must be a function');
    if (!/^[a-z][a-z0-9.-]{0,119}\.v[1-9][0-9]*$/.test(normalizedTopic)) throw new Error(`Invalid component event topic: ${normalizedTopic}`);
    const listener = (_event, value) => { if (value?.topic === normalizedTopic) callback(value.payload); };
    ipcRenderer.on('component-sdk:event', listener);
    return () => ipcRenderer.removeListener('component-sdk:event', listener);
  },
  onActivate: callback => subscribe('component-sdk:activate', callback),
  onDeactivate: callback => subscribe('component-sdk:deactivate', callback),
  onThemeChange: callback => subscribe('component-sdk:theme-changed', callback),
  onLocaleChange: callback => subscribe('component-sdk:locale-changed', callback),
  onContextChange: callback => subscribe('component-sdk:context-changed', callback),
}));
