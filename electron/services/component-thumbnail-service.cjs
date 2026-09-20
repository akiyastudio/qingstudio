const { getPreviewRuntime } = require('./component-preview-service.cjs');
const { decodePreview } = require('./component-preview-decoder-service.cjs');
const { exact } = require('./component-file-resources.cjs');
const { hostError, COMPONENT_HOST_ERROR_CODES: CODES } = require('../contracts/component-host-errors.cjs');
const cache = new Map(), pending = new Map(); let bytes = 0;
// Bounded process-local cache. Every lookup still revalidates source and scope.
async function componentThumbnail(manager, request, owner, nativeImage) {
  exact(request, ['componentId', 'decoderId', 'relativePath', 'maxEdge', 'context', 'requestId'], ['componentId', 'decoderId', 'relativePath', 'maxEdge', 'context', 'requestId']);
  if (!Number.isInteger(request.maxEdge) || request.maxEdge < 64 || request.maxEdge > 640) throw hostError(CODES.INVALID_REQUEST, 'Invalid thumbnail size');
  const runtime = getPreviewRuntime(), descriptor = manager.registry.resolve(request.componentId);
  if (!descriptor?.service?.previewDecoders?.some(item => item.id === request.decoderId && item.thumbnailMethod)) throw hostError(CODES.NOT_FOUND, 'Thumbnail provider unavailable');
  const context = { ...manager.resolveOpenContext(request.context), surface: 'project' };
  const scope = await runtime.fileResources.bound(context, descriptor);
  const source = await runtime.fileResources.resolveFile(scope, request.relativePath);
  const stat = source.stat;
  const key = JSON.stringify([owner.id, context.workspacePath, context.projectId, context.contentKind, context.scopeRelativePath, request.componentId, descriptor.componentVersion, request.decoderId, request.relativePath, stat.dev.toString(), stat.ino.toString(), stat.size, stat.mtimeMs, stat.ctimeMs, request.maxEdge]);
  const found = cache.get(key);
  if (found) { cache.delete(key); cache.set(key, found); return found; }
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= 2) throw hostError(CODES.CONFLICT, 'Thumbnail queue is busy');
  const operation = decodePreview(manager, { ...request, purpose: 'thumbnail', pageIndex: 0 }, nativeImage, owner).then(async value => {
    const latest = await runtime.fileResources.resolveFile(scope, request.relativePath);
    if (latest.stat.size !== stat.size || latest.stat.mtimeMs !== stat.mtimeMs || latest.stat.ctimeMs !== stat.ctimeMs || latest.stat.ino !== stat.ino || manager.registry.resolve(request.componentId)?.componentVersion !== descriptor.componentVersion) throw hostError(CODES.CONFLICT, 'Thumbnail source changed');
    cache.set(key, value); bytes += value.dataUrl.length * 2;
    while (cache.size > 256 || bytes > 64 * 1024 * 1024) { const oldest = cache.keys().next().value; bytes -= cache.get(oldest).dataUrl.length * 2; cache.delete(oldest); }
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, operation); return operation;
}
module.exports = { componentThumbnail };
