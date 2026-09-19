const NOTIFICATION_CAPABILITY = 'notifications';
const NOTIFICATION_PERMISSION = 'notifications';
const NOTIFICATION_TONES = new Set(['info', 'success', 'warning', 'error']);
const MESSAGE_MAX_LENGTH = 360;
const DEDUPE_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const BURST_WINDOW_MS = 1000;
const BURST_LIMIT = 3;
const RATE_WINDOW_MS = 10000;
const RATE_LIMIT = 8;
const ERROR_BURST_LIMIT = 2;
const ERROR_RATE_LIMIT = 4;
const CONTENT_DEDUPE_WINDOW_MS = 1200;
const BUFFER_LIMIT = 32;
const BUFFER_TTL_MS = 15000;

const failure = (code, message, retryable = false) => Object.freeze({ accepted: false, error: Object.freeze({ code, message, retryable }) });

const normalizeNotificationPayload = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('NOTIFICATION_INVALID_PAYLOAD', 'Notification payload must be an object');
  const unknown = Object.keys(value).find(key => !['tone', 'message', 'dedupeKey'].includes(key));
  if (unknown) return failure('NOTIFICATION_INVALID_PAYLOAD', `Unknown notification field: ${unknown}`);
  if (!NOTIFICATION_TONES.has(value.tone)) return failure('NOTIFICATION_INVALID_TONE', 'Notification tone is invalid');
  if (typeof value.message !== 'string') return failure('NOTIFICATION_INVALID_MESSAGE', 'Notification message must be text');
  if (value.message.length > MESSAGE_MAX_LENGTH) return failure('NOTIFICATION_INVALID_MESSAGE', `Notification message must contain 1-${MESSAGE_MAX_LENGTH} characters`);
  const message = value.message.trim();
  if (!message || message.length > MESSAGE_MAX_LENGTH) return failure('NOTIFICATION_INVALID_MESSAGE', `Notification message must contain 1-${MESSAGE_MAX_LENGTH} characters`);
  let dedupeKey;
  if (value.dedupeKey !== undefined) {
    if (typeof value.dedupeKey !== 'string' || !DEDUPE_KEY.test(value.dedupeKey)) return failure('NOTIFICATION_INVALID_DEDUPE_KEY', 'Notification dedupeKey is invalid');
    dedupeKey = value.dedupeKey;
  }
  return Object.freeze({ tone: value.tone, message, ...(dedupeKey ? { dedupeKey } : {}) });
};

const { currentApplicationHost, applicationHostFor } = require('./application-windows.cjs');

class ComponentNotificationService {
  get mainWindow() { return currentApplicationHost() || this.defaultWindow; }
  set mainWindow(window) { this.defaultWindow = window; }
  get hostState() {
    const host = this.mainWindow;
    if (!host) return this.unboundState ||= { rendererReady: false, rendererSession: { token: '', revision: -1 }, retiredRendererTokens: new Set(), buffer: [] };
    if (!host.notificationState) host.notificationState = { rendererReady: false, rendererSession: { token: '', revision: -1 }, retiredRendererTokens: new Set(), buffer: [] };
    if (!host.closed) this.hosts?.add(host);
    return host.notificationState;
  }
  get rendererReady() { return this.hostState.rendererReady; }
  set rendererReady(value) { this.hostState.rendererReady = value; }
  get rendererSession() { return this.hostState.rendererSession; }
  set rendererSession(value) { this.hostState.rendererSession = value; }
  get retiredRendererTokens() { return this.hostState.retiredRendererTokens; }
  set retiredRendererTokens(value) { this.hostState.retiredRendererTokens = value; }
  get buffer() { return this.hostState.buffer; }
  set buffer(value) { this.hostState.buffer = value; }
  constructor({ mainWindow, now = Date.now }) {
    this.hosts = new Set();
    this.mainWindow = applicationHostFor(mainWindow?.webContents) || mainWindow; this.rendererWebContents = mainWindow?.webContents; this.now = now; this.stateByComponent = new Map(); this.sequence = 0; this.rendererReady = false; this.rendererSession = { token: '', revision: -1 }; this.retiredRendererTokens = new Set(); this.buffer = [];
    this.handleRendererReload = () => { this.rendererReady = false; if (this.rendererSession.token) this.retiredRendererTokens.add(this.rendererSession.token); while (this.retiredRendererTokens.size > 8) this.retiredRendererTokens.delete(this.retiredRendererTokens.values().next().value); this.rendererSession = { token: '', revision: -1 }; };
    this.rendererWebContents?.on?.('did-start-loading', this.handleRendererReload);
    this.rendererWebContents?.on?.('render-process-gone', this.handleRendererReload);
  }

  deliver(event) {
    const target = this.mainWindow;
    if (!target || target.isDestroyed?.() || !target.webContents || target.webContents.isDestroyed?.()) return false;
    try { target.webContents.send('component-host:notification', event); return true; } catch { return false; }
  }

  setRendererReady(update) {
    const token = String(update?.rendererToken || ''); const revision = Number(update?.revision);
    if (!token || token.length > 200 || !Number.isSafeInteger(revision) || revision < 0 || typeof update?.ready !== 'boolean') throw new Error('Invalid notification renderer readiness');
    if (token !== this.rendererSession.token) {
      if (this.retiredRendererTokens.has(token)) return { ready: this.rendererReady, flushed: 0, stale: true };
      if (this.rendererSession.token) this.retiredRendererTokens.add(this.rendererSession.token);
      while (this.retiredRendererTokens.size > 8) this.retiredRendererTokens.delete(this.retiredRendererTokens.values().next().value);
      this.rendererSession = { token, revision: -1 };
    }
    if (revision <= this.rendererSession.revision) return { ready: this.rendererReady, flushed: 0, stale: true };
    this.rendererSession = { token, revision };
    this.rendererReady = update.ready;
    if (!this.rendererReady) return { ready: false, flushed: 0 };
    const now = this.now();
    const pending = this.buffer.filter(item => now - item.queuedAt <= BUFFER_TTL_MS);
    this.buffer = [];
    let flushed = 0;
    for (let index = 0; index < pending.length; index += 1) {
      if (!this.deliver(pending[index].event)) { this.buffer = pending.slice(index); break; }
      flushed += 1;
    }
    return { ready: true, flushed };
  }

  publish(descriptor, payload, context = {}) {
    if (!descriptor?.service?.capabilities?.includes(NOTIFICATION_CAPABILITY)) return failure('NOTIFICATION_CAPABILITY_NOT_GRANTED', 'Notification capability is not granted');
    if (!descriptor?.service?.permissions?.includes(NOTIFICATION_PERMISSION)) return failure('NOTIFICATION_PERMISSION_DENIED', 'Notification permission is not granted');
    if (!['project', 'application.settings', 'component.sidePanel', 'media.contextAction', 'project.contextAction', 'project.importProvider', 'project.exportProvider', 'application.command'].includes(context.surface)) return failure('NOTIFICATION_CONTEXT_INVALID', 'Notification surface is not bound');
    const normalized = normalizeNotificationPayload(payload);
    if (normalized.accepted === false) return normalized;
    const componentId = String(descriptor.componentId || '');
    if (!componentId) return failure('NOTIFICATION_CONTEXT_INVALID', 'Notification owner is not bound');
    const target = this.mainWindow;
    if (!target || target.isDestroyed?.() || !target.webContents || target.webContents.isDestroyed?.()) return failure('NOTIFICATION_HOST_UNAVAILABLE', 'Main notification host is unavailable', true);
    const now = this.now();
    if (!this.rendererReady && this.buffer.length) this.buffer = this.buffer.filter(item => now - item.queuedAt <= BUFFER_TTL_MS);
    const state = this.stateByComponent.get(componentId) || { normalTimestamps: [], errorTimestamps: [], recent: new Map() };
    state.normalTimestamps = state.normalTimestamps.filter(timestamp => now - timestamp < RATE_WINDOW_MS);
    state.errorTimestamps = state.errorTimestamps.filter(timestamp => now - timestamp < RATE_WINDOW_MS);
    for (const [key, timestamp] of state.recent) if (now - timestamp >= CONTENT_DEDUPE_WINDOW_MS) state.recent.delete(key);
    const timestamps = normalized.tone === 'error' ? state.errorTimestamps : state.normalTimestamps;
    const burstLimit = normalized.tone === 'error' ? ERROR_BURST_LIMIT : BURST_LIMIT;
    const rateLimit = normalized.tone === 'error' ? ERROR_RATE_LIMIT : RATE_LIMIT;
    const burstCount = timestamps.filter(timestamp => now - timestamp < BURST_WINDOW_MS).length;
    if (burstCount >= burstLimit || timestamps.length >= rateLimit) { this.stateByComponent.set(componentId, state); return failure('NOTIFICATION_RATE_LIMITED', 'Notification rate limit exceeded', true); }
    // dedupeKey identifies a renderer card, while this fingerprint identifies
    // only an identical repeat of its current content. A tone/message change
    // must be delivered so the renderer can replace a persistent card.
    const dedupePrefix = normalized.dedupeKey ? `key:${normalized.dedupeKey}:` : '';
    const contentKey = dedupePrefix ? `${dedupePrefix}${normalized.tone}:${normalized.message}` : `content:${normalized.tone}:${normalized.message}`;
    if (state.recent.has(contentKey)) { this.stateByComponent.set(componentId, state); return Object.freeze({ accepted: false, deduplicated: true, code: 'NOTIFICATION_DEDUPLICATED' }); }
    timestamps.push(now);
    const replacedRecent = [];
    if (dedupePrefix) for (const [key, timestamp] of state.recent) if (key.startsWith(dedupePrefix)) { replacedRecent.push([key, timestamp]); state.recent.delete(key); }
    state.recent.set(contentKey, now); this.stateByComponent.set(componentId, state);
    const rollbackContentFingerprint = () => {
      state.recent.delete(contentKey);
      for (const [key, timestamp] of replacedRecent) state.recent.set(key, timestamp);
    };
    const id = `${componentId}:${++this.sequence}`;
    const event = Object.freeze({ type: 'notification', id, componentId, surface: context.surface, notification: normalized });
    if (this.rendererReady) {
      if (!this.deliver(event)) { timestamps.pop(); rollbackContentFingerprint(); return failure('NOTIFICATION_HOST_UNAVAILABLE', 'Main notification host is unavailable', true); }
    } else {
      if (this.buffer.length >= BUFFER_LIMIT) { timestamps.pop(); rollbackContentFingerprint(); return failure('NOTIFICATION_BUFFER_FULL', 'Notification renderer buffer is full', true); }
      this.buffer.push({ event, queuedAt: now });
    }
    return Object.freeze({ accepted: true, id });
  }

  forgetHost(host) { if (host.notificationState) { host.notificationState.buffer = []; host.notificationState.rendererReady = false; } this.hosts.delete(host); }

  clearComponent(componentId) {
    const id = String(componentId || '');
    const removed = this.stateByComponent.delete(id);
    this.buffer = this.buffer.filter(item => item.event.componentId !== id);
    for (const host of this.hosts) {
      if (host.isDestroyed?.()) { this.hosts.delete(host); continue; }
      if (host === this.mainWindow || !host.notificationState) continue;
      host.notificationState.buffer = host.notificationState.buffer.filter(item => item.event.componentId !== id);
      if (id && host.notificationState.rendererReady && !host.webContents.isDestroyed?.()) host.webContents.send('component-host:notification', { type: 'purge', componentId: id });
    }
    if (id && this.rendererReady) this.deliver(Object.freeze({ type: 'purge', componentId: id }));
    return removed;
  }
  destroy() { this.rendererWebContents?.removeListener?.('did-start-loading', this.handleRendererReload); this.rendererWebContents?.removeListener?.('render-process-gone', this.handleRendererReload); this.stateByComponent.clear(); this.buffer = []; this.rendererReady = false; this.rendererSession = { token: '', revision: -1 }; this.retiredRendererTokens.clear(); }
}

module.exports = { BUFFER_LIMIT, BUFFER_TTL_MS, BURST_LIMIT, BURST_WINDOW_MS, CONTENT_DEDUPE_WINDOW_MS, DEDUPE_KEY, ERROR_BURST_LIMIT, ERROR_RATE_LIMIT, MESSAGE_MAX_LENGTH, NOTIFICATION_CAPABILITY, NOTIFICATION_PERMISSION, RATE_LIMIT, RATE_WINDOW_MS, ComponentNotificationService, failure, normalizeNotificationPayload };
