const TONES = new Set(['info', 'success', 'warning', 'error']);
const DEDUPE_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

const normalizeComponentNotificationRendererEvent = value => {
  if (!value || typeof value !== 'object' || typeof value.componentId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value.componentId)) return null;
  if (value.type === 'purge') return Object.keys(value).every(key => ['type', 'componentId'].includes(key)) ? Object.freeze({ type: 'purge', componentId: value.componentId }) : null;
  if (value.type !== 'notification' || typeof value.id !== 'string' || !['project', 'application.settings', 'component.sidePanel', 'media.contextAction', 'project.contextAction', 'project.importProvider', 'project.exportProvider', 'application.command'].includes(value.surface)) return null;
  if (!Object.keys(value).every(key => ['type', 'id', 'componentId', 'surface', 'notification'].includes(key))) return null;
  const notification = value.notification;
  if (!notification || Object.keys(notification).some(key => !['tone', 'message', 'dedupeKey'].includes(key)) || !TONES.has(notification.tone) || typeof notification.message !== 'string' || notification.message !== notification.message.trim() || notification.message.length < 1 || notification.message.length > 360 || (notification.dedupeKey !== undefined && (typeof notification.dedupeKey !== 'string' || !DEDUPE_KEY.test(notification.dedupeKey)))) return null;
  return Object.freeze({ type: 'notification', id: value.id, componentId: value.componentId, surface: value.surface, notification: Object.freeze({ tone: notification.tone, message: notification.message, ...(notification.dedupeKey ? { dedupeKey: notification.dedupeKey } : {}) }) });
};

const subscribeComponentNotification = (ipcRenderer, callback) => {
  if (typeof callback !== 'function') throw new TypeError('Component notification callback must be a function');
  const listener = (_event, value) => { const normalized = normalizeComponentNotificationRendererEvent(value); if (normalized) callback(normalized); };
  ipcRenderer.on('component-host:notification', listener);
  return () => ipcRenderer.removeListener('component-host:notification', listener);
};

module.exports = { normalizeComponentNotificationRendererEvent, subscribeComponentNotification };
