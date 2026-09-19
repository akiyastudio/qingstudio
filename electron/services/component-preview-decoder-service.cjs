const { getPreviewRuntime, safeRelative } = require('./component-preview-service.cjs');
const { exact } = require('./component-file-resources.cjs');
const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
const active = new Set();
const listPreviewDecoders = manager => manager.registry.list().flatMap(descriptor => (descriptor.service?.previewDecoders || []).map(decoder => ({ componentId: descriptor.componentId, id: decoder.id, label: decoder.label, extensions: decoder.extensions, priority: decoder.priority }))).sort((a, b) => b.priority - a.priority || a.componentId.localeCompare(b.componentId) || a.id.localeCompare(b.id));
const decodePreview = async (manager, request, nativeImage = require('electron').nativeImage) => {
  exact(request, ['componentId', 'decoderId', 'relativePath', 'pageIndex', 'maxEdge', 'context'], ['componentId', 'decoderId', 'relativePath', 'pageIndex', 'maxEdge', 'context']);
  if (!safeRelative(request.relativePath) || !Number.isInteger(request.pageIndex) || request.pageIndex < 0 || request.pageIndex > 9999 || !Number.isInteger(request.maxEdge) || request.maxEdge < 64 || request.maxEdge > 4096) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview decode request');
  const descriptor = manager.registry.resolve(request.componentId);
  const decoder = descriptor?.service?.previewDecoders?.find(item => item.id === request.decoderId);
  if (!decoder) throw hostError(CODES.NOT_FOUND, 'Preview decoder is unavailable');
  const { dependencies: { path, fs, crypto }, projectDomain, fileResources } = getPreviewRuntime();
  if (!decoder.extensions.some(extension => extension === '*' || path.basename(request.relativePath).toLowerCase().endsWith(extension))) throw hostError(CODES.INVALID_REQUEST, 'Decoder does not support this extension');
  const context = { ...manager.resolveOpenContext(request.context), surface: 'project', componentId: descriptor.componentId, componentVersion: descriptor.componentVersion, previewOwnerId: manager.mainWindow.webContents.id };
  const scope = await fileResources.bound(context, descriptor);
  const key = `${manager.mainWindow.webContents.id}:${context.sourcePageId}`;
  if (active.has(key) || active.size >= 8) throw hostError(CODES.CONFLICT, 'A preview decode is already running');
  active.add(key);
  let inputReservation; let outputReservation;
  let outputToken;
  try {
    const source = await fileResources.resolveFile(scope, request.relativePath);
    const token = projectDomain.grantVerifiedFile(source.filePath, descriptor, context, scope.canonicalRoot, undefined, { dev: String(source.stat.dev), ino: String(source.stat.ino), size: source.stat.size, mtimeMs: source.stat.mtimeMs });
    // The provider receives a one-time input token, never a host project path.
    inputReservation = token.token;
    const result = await manager.serviceManager.invoke(descriptor.componentId, decoder.method, { input: token, name: path.basename(request.relativePath), extension: path.extname(request.relativePath).toLowerCase(), pageIndex: request.pageIndex, maxEdge: request.maxEdge }, context);
    if (typeof result?.inputToken === 'string') outputToken = result.inputToken;
    exact(result, ['inputToken', 'mimeType', 'pageIndex', 'pageCount'], ['inputToken', 'mimeType', 'pageIndex', 'pageCount']);
    if (result.mimeType !== 'image/png' || typeof result.inputToken !== 'string' || result.pageIndex !== request.pageIndex || !Number.isInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 10000 || result.pageIndex >= result.pageCount) throw hostError(CODES.INVALID_REQUEST, 'Invalid preview decoder result');
    outputReservation = `preview:${crypto.randomUUID()}`;
    const [output] = await projectDomain.reserveInputs([result.inputToken], descriptor, context, outputReservation);
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
    active.delete(key);
    if (outputReservation) await projectDomain.commitReservation(outputReservation);
    if (outputToken) await projectDomain.discardInput?.(outputToken, descriptor, context);
    if (inputReservation) await projectDomain.discardInput?.(inputReservation, descriptor, context);
  }
};
module.exports = { listPreviewDecoders, decodePreview };
