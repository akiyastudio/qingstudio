const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
const { exact } = require('./component-file-resources.cjs');
const normalize = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const keyFor = (context, ownerId) => JSON.stringify([ownerId, normalize(context.workspacePath), context.projectId, context.contentKind || 'project', context.sourcePageId]);
const safeRelative = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\:\0]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.photoflow-'));
const inScope = (name, scope) => !scope || normalize(name) === normalize(scope) || normalize(name).startsWith(`${normalize(scope)}/`);

const createComponentPreviewService = ({ fileResources, uuid = () => require('node:crypto').randomUUID() }) => {
  const pages = new Map(); const subscriptions = new Map(); const commands = new Map();
  const visible = (item, context) => item?.video && inScope(item.video.relativePath, context.scopeRelativePath) ? { revision: item.revision, video: item.video } : { revision: item?.revision || 0, video: null };
  const notify = key => {
    for (const [id, subscription] of subscriptions) {
      if (subscription.sender.isDestroyed()) { subscriptions.delete(id); continue; }
      if (subscription.key === key) subscription.sender.send('component-sdk:preview-changed', visible(pages.get(key), subscription.context));
    }
  };
  const publish = (owner, context, payload) => {
    exact(payload, ['sequence', 'video', 'closed'], ['sequence', 'video']);
    if (payload.closed !== undefined && (payload.closed !== true || payload.video !== null)) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview close');
    if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1 || !context.sourcePageId) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview publication');
    if (payload.video !== null) {
      exact(payload.video, ['sessionId', 'relativePath', 'time', 'duration', 'paused', 'canSeek'], ['sessionId', 'relativePath', 'time', 'duration', 'paused', 'canSeek']);
      if (typeof payload.video.sessionId !== 'string' || !/^[a-z0-9-]{16,80}$/i.test(payload.video.sessionId) || !safeRelative(payload.video.relativePath) || !['time', 'duration'].every(field => Number.isFinite(payload.video[field]) && payload.video[field] >= 0) || typeof payload.video.paused !== 'boolean' || typeof payload.video.canSeek !== 'boolean') throw hostError(CODES.INVALID_REQUEST, 'Invalid preview video');
    }
    const key = keyFor(context, owner.id); const previous = pages.get(key);
    if (previous && payload.sequence <= previous.revision) return { accepted: false };
    if (!previous && pages.size >= 256) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many preview pages');
    pages.set(key, { owner, revision: payload.sequence, video: payload.video && { ...payload.video } }); notify(key);
    if (payload.closed) pages.delete(key);
    return { accepted: true };
  };
  const invoke = async (payload, context, descriptor) => {
    await fileResources.bound(context, descriptor);
    if (!context.sourcePageId || !context.previewOwnerId) throw hostError(CODES.PERMISSION_DENIED, 'Preview requires an originating file page');
    const key = keyFor(context, context.previewOwnerId); const item = pages.get(key);
    if (['get', 'subscribe', 'unsubscribe'].includes(payload.action)) {
      exact(payload, ['action'], ['action']);
      if (payload.action !== 'get') {
        const sender = context.eventSender;
        if (!sender || sender.isDestroyed()) throw hostError(CODES.PERMISSION_DENIED, 'Preview subscription requires a live component view');
        if (payload.action === 'unsubscribe') subscriptions.delete(sender.id);
        else {
          if (!subscriptions.has(sender.id) && subscriptions.size >= 256) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many preview subscriptions');
          if (!subscriptions.has(sender.id)) sender.once?.('destroyed', () => subscriptions.delete(sender.id));
          subscriptions.set(sender.id, { sender, key, context, componentId: descriptor.componentId });
        }
      }
      return visible(item, context);
    }
    exact(payload, ['action', 'sessionId', 'time'], ['action', 'sessionId', 'time']);
    if (payload.action !== 'seek' || !Number.isFinite(payload.time) || payload.time < 0) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview seek');
    if (!descriptor.service.permissions.includes('project.preview.control')) throw hostError(CODES.PERMISSION_DENIED, 'Preview seek requires project.preview.control');
    const video = visible(item, context).video;
    if (!video || video.sessionId !== payload.sessionId) throw hostError(CODES.CONFLICT, 'The preview video has changed');
    if (!video.canSeek || payload.time > video.duration || item.owner.isDestroyed()) throw hostError(CODES.CONFLICT, 'The preview is not seekable');
    if (commands.size >= 64) throw hostError(CODES.LIMIT_EXCEEDED, 'Too many pending seeks');
    return new Promise((resolve, reject) => {
      const requestId = uuid();
      const timer = setTimeout(() => { commands.delete(requestId); reject(hostError(CODES.TIMEOUT, 'Preview seek was not acknowledged')); }, 3000); timer.unref?.();
      commands.set(requestId, { ownerId: item.owner.id, key, sessionId: video.sessionId, timer, resolve, reject });
      try { item.owner.send('component-preview:seek', { requestId, sourcePageId: context.sourcePageId, sessionId: video.sessionId, time: payload.time }); }
      catch { clearTimeout(timer); commands.delete(requestId); reject(hostError(CODES.NOT_FOUND, 'Preview owner closed')); }
    });
  };
  const acknowledge = (owner, payload) => {
    exact(payload, ['requestId', 'accepted'], ['requestId', 'accepted']);
    const command = commands.get(payload.requestId);
    if (!command || command.ownerId !== owner.id || typeof payload.accepted !== 'boolean') return;
    clearTimeout(command.timer); commands.delete(payload.requestId);
    if (payload.accepted && pages.get(command.key)?.video?.sessionId === command.sessionId) command.resolve({ accepted: true });
    else command.reject(hostError(CODES.CONFLICT, 'Preview changed before seek'));
  };
  const clearOwner = ownerId => { for (const [key, item] of pages) if (item.owner.id === ownerId) { pages.delete(key); notify(key); } for (const [id, command] of commands) if (command.ownerId === ownerId) { clearTimeout(command.timer); commands.delete(id); command.reject(hostError(CODES.NOT_FOUND, 'Preview closed')); } };
  return { invoke, publish, acknowledge, clearOwner, clearComponent: componentId => { for (const [id, item] of subscriptions) if (item.componentId === componentId) subscriptions.delete(id); } };
};
let runtime = null;
module.exports = { createComponentPreviewService, safeRelative, setPreviewRuntime: value => { runtime = value; }, getPreviewRuntime: () => { if (!runtime) throw new Error('Preview runtime is unavailable'); return runtime; } };
