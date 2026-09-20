const { getPreviewRuntime, safeRelative } = require('./component-preview-service.cjs');
const { exact } = require('./component-file-resources.cjs');
const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
const active = new Set();
const listPreviewDecoders = manager => manager.registry.list().flatMap(descriptor => (descriptor.service?.previewDecoders || []).map(decoder => ({ componentId: descriptor.componentId, id: decoder.id, label: decoder.label, extensions: decoder.extensions, priority: decoder.priority, thumbnails: Boolean(decoder.thumbnailMethod), version: descriptor.componentVersion }))).sort((a, b) => b.priority - a.priority || a.componentId.localeCompare(b.componentId) || a.id.localeCompare(b.id));
const decodePreview = async (manager, request, nativeImage = require('electron').nativeImage, owner = manager.mainWindow.webContents) => {
  exact(request, ['componentId', 'decoderId', 'relativePath', 'pageIndex', 'maxEdge', 'context', 'requestId', 'purpose'], ['componentId', 'decoderId', 'relativePath', 'pageIndex', 'maxEdge', 'context']);
  if (request.purpose !== undefined && request.purpose !== 'thumbnail') throw hostError(CODES.INVALID_REQUEST, 'Invalid preview purpose');
  if (!safeRelative(request.relativePath) || !Number.isInteger(request.pageIndex) || request.pageIndex < 0 || request.pageIndex > 9999 || !Number.isInteger(request.maxEdge) || request.maxEdge < 64 || request.maxEdge > 4096) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview decode request');
  const descriptor = manager.registry.resolve(request.componentId);
  const decoder = descriptor?.service?.previewDecoders?.find(item => item.id === request.decoderId);
  if (!decoder) throw hostError(CODES.NOT_FOUND, 'Preview decoder is unavailable');
  if (request.purpose === 'thumbnail' && !decoder.thumbnailMethod) throw hostError(CODES.NOT_FOUND, 'Thumbnail decoder is unavailable');
  const { dependencies: { path, fs, crypto }, projectDomain, fileResources, videoPreviews } = getPreviewRuntime();
  if (!decoder.extensions.some(extension => extension === '*' || path.basename(request.relativePath).toLowerCase().endsWith(extension))) throw hostError(CODES.INVALID_REQUEST, 'Decoder does not support this extension');
  const context = { ...manager.resolveOpenContext(request.context), surface: 'project', componentId: descriptor.componentId, componentVersion: descriptor.componentVersion, previewOwnerId: owner.id };
  const key = request.purpose === 'thumbnail' ? `thumbnail:${descriptor.componentId}` : `${owner.id}:${context.sourcePageId}`;
  if (active.has(key) || active.size >= 8) throw hostError(CODES.CONFLICT, 'A preview decode is already running');
  const operation = request.requestId && videoPreviews?.begin(owner, request.requestId, descriptor.componentId, context);
  active.add(key);
  let inputReservation; let outputReservation;
  let outputToken;
  let posterToken;
  try {
    const scope = await fileResources.bound(context, descriptor);
    videoPreviews?.check(operation);
    const source = await fileResources.resolveFile(scope, request.relativePath);
    const token = projectDomain.grantVerifiedFile(source.filePath, descriptor, context, scope.canonicalRoot, undefined, { dev: String(source.stat.dev), ino: String(source.stat.ino), size: source.stat.size, mtimeMs: source.stat.mtimeMs });
    // The provider receives a one-time input token, never a host project path.
    inputReservation = token.token;
    const result = await manager.serviceManager.invoke(descriptor.componentId, request.purpose === 'thumbnail' ? decoder.thumbnailMethod : decoder.method, { input: token, name: path.basename(request.relativePath), extension: path.extname(request.relativePath).toLowerCase(), pageIndex: request.pageIndex, maxEdge: request.maxEdge }, context);
    if (typeof result?.inputToken === 'string') outputToken = result.inputToken;
    if (typeof result?.posterInputToken === 'string') posterToken = result.posterInputToken;
    videoPreviews?.check(operation);
    exact(result, ['inputToken', 'mimeType', 'pageIndex', 'pageCount', 'posterInputToken', 'presentation'], ['inputToken', 'mimeType', 'pageIndex', 'pageCount']);
    const isVideo = ['video/mp4', 'video/quicktime'].includes(result.mimeType);
    if (request.purpose === 'thumbnail' && isVideo || result.presentation !== undefined && (result.presentation !== 'live-photo' || !isVideo) || result.posterInputToken !== undefined && (!isVideo || typeof result.posterInputToken !== 'string')) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview presentation');
    if ((!isVideo && result.mimeType !== 'image/png') || typeof result.inputToken !== 'string' || result.pageIndex !== request.pageIndex || !Number.isInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 10000 || result.pageIndex >= result.pageCount || isVideo && (result.pageIndex !== 0 || result.pageCount !== 1 || !operation)) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview decoder result');
    outputReservation = `preview:${crypto.randomUUID()}`;
    const [output] = await projectDomain.reserveInputs([result.inputToken], descriptor, context, outputReservation);
    if (isVideo) {
      await require('./component-preview-video-service.cjs').validatePreviewVideo(fs, output.filePath);
      let poster;
      if (result.posterInputToken) {
        const reservation = `poster:${crypto.randomUUID()}`;
        try {
          const [snapshot] = await projectDomain.reserveInputs([result.posterInputToken], descriptor, context, reservation);
          poster = await readPreviewBitmap(fs, snapshot.filePath, request.maxEdge, nativeImage);
        } finally { await projectDomain.commitReservation(reservation); await projectDomain.discardInput?.(result.posterInputToken, descriptor, context); }
      }
      const previewId = videoPreviews.adopt({ operation, descriptor, manager, filePath: output.filePath, reservation: outputReservation, mimeType: result.mimeType });
      outputReservation = null; outputToken = null; // The preview lease owns the snapshot until release.
      return { kind: 'video', previewId, mimeType: result.mimeType, pageIndex: 0, pageCount: 1, ...(poster ? { poster: poster.dataUrl } : {}), ...(result.presentation ? { presentation: result.presentation } : {}) };
    }
    const stat = await fs.promises.stat(output.filePath);
    if (!stat.isFile() || stat.size < 24 || stat.size > 32 * 1024 * 1024) throw hostError(CODES.LIMIT_EXCEEDED, 'Preview bitmap is too large');
    const bytes = await fs.promises.readFile(output.filePath);
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) > request.maxEdge || bytes.readUInt32BE(20) > request.maxEdge) throw hostError(CODES.INVALID_REQUEST, 'Preview must be a bounded PNG bitmap');
    const image = nativeImage.createFromBuffer(bytes); const size = image.getSize();
    if (image.isEmpty() || !size.width || !size.height || size.width > request.maxEdge || size.height > request.maxEdge) throw hostError(CODES.INVALID_REQUEST, 'Preview bitmap could not be decoded');
    // Host re-encodes the bitmap; no provider HTML, scripts, URLs or paths reach the page.
    const png = image.toPNG();
    if (png.length > 32 * 1024 * 1024) throw hostError(CODES.LIMIT_EXCEEDED, 'Preview bitmap is too large');
    return { pageIndex: result.pageIndex, pageCount: result.pageCount, width: size.width, height: size.height, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  } finally {
    videoPreviews?.finish(operation);
    active.delete(key);
    if (outputReservation) await projectDomain.commitReservation(outputReservation);
    if (outputToken) await projectDomain.discardInput?.(outputToken, descriptor, context);
    if (posterToken) await projectDomain.discardInput?.(posterToken, descriptor, context);
    if (inputReservation) await projectDomain.discardInput?.(inputReservation, descriptor, context);
  }
};
async function readPreviewBitmap(fs, filePath, maxEdge, nativeImage) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size < 24 || stat.size > 32 * 1024 * 1024) throw hostError(CODES.LIMIT_EXCEEDED, 'Preview image is too large');
  const bytes = await fs.promises.readFile(filePath);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) > maxEdge || bytes.readUInt32BE(20) > maxEdge) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview PNG');
  const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
  if (image.isEmpty() || !size.width || !size.height || size.width > maxEdge || size.height > maxEdge) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview image');
  const png = image.toPNG();
  if (png.length > 32 * 1024 * 1024) throw hostError(CODES.LIMIT_EXCEEDED, 'Preview image is too large');
  return { width: size.width, height: size.height, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
}
module.exports = { listPreviewDecoders, decodePreview, readPreviewBitmap };
