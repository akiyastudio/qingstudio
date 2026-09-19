const fs = require('fs');
const path = require('path');
const { discardVerifiedMediaHandle, takeVerifiedMediaHandle } = require('./media-access-service.cjs');

const CONTENT_TYPES = new Map([
  ['.avi', 'video/x-msvideo'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.hif', 'image/heif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.m4v', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
]);

const parseByteRange = (rangeHeader, fileSize) => {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2]) || fileSize <= 0) return undefined;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    return { start: Math.max(0, fileSize - suffixLength), end: fileSize - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= fileSize || requestedEnd < start) return undefined;
  return { start, end: Math.min(requestedEnd, fileSize - 1) };
};

// Read at most one bounded chunk for each consumer pull. Keeping the same open
// handle for fstat and reads both enforces backpressure and prevents a path
// replacement between stat and open from changing the response contents.
const createFileWebStream = (handle, { start = 0, end }) => {
  let position = start;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };
  return new ReadableStream({
    async pull(controller) {
      if (closed) return;
      const remaining = end - position + 1;
      if (remaining <= 0) {
        await close();
        controller.close();
        return;
      }
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) {
          await close();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
        if (position > end) {
          await close();
          controller.close();
        }
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    cancel: close,
  });
};

const inspectMediaRequestTarget = request => {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'photoflow-media:') return { mode: 'path', token: null };
    const candidateToken = /^\/([A-Za-z0-9_-]{32})(?:\/|$)/.exec(url.pathname)?.[1] || null;
    const exactToken = /^\/([A-Za-z0-9_-]{32})$/.exec(url.pathname)?.[1] || null;
    const valid = url.hostname === 'file'
      && !url.username
      && !url.password
      && !url.port
      && !url.hash
      && Boolean(exactToken);
    return valid
      ? { mode: 'verified', token: exactToken }
      : { mode: 'invalid', token: candidateToken };
  } catch { return { mode: 'invalid', token: null }; }
};

const createMediaFileResponse = async (filePath, request) => {
  const target = inspectMediaRequestTarget(request);
  if (target.mode === 'invalid') {
    if (target.token) await discardVerifiedMediaHandle(target.token, filePath);
    return new Response('Not found', { status: 404 });
  }
  const verifiedHandle = target.mode === 'verified' ? takeVerifiedMediaHandle(target.token, filePath) : null;
  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    try { return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }); }
    finally { await verifiedHandle?.close().catch(() => undefined); }
  }

  const handle = verifiedHandle || (target.mode === 'path' ? await fs.promises.open(filePath, 'r').catch(() => null) : null);
  if (!handle) return new Response('Not found', { status: 404 });
  let streamOwnsHandle = false;
  try {
    const stat = await handle.stat().catch(() => null);
    if (!stat?.isFile()) return new Response('Not found', { status: 404 });

    const rangeHeader = request.headers.get('range');
    const range = parseByteRange(rangeHeader, stat.size);
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'private, max-age=3600',
      'Content-Type': CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
    };

    if (rangeHeader && !range) {
      return new Response(null, { status: 416, headers: { ...commonHeaders, 'Content-Range': `bytes */${stat.size}` } });
    }

    if (range) {
      const contentLength = range.end - range.start + 1;
      const body = method === 'HEAD' ? null : createFileWebStream(handle, range);
      const response = new Response(body, {
        status: 206,
        headers: {
          ...commonHeaders,
          'Content-Length': String(contentLength),
          'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        },
      });
      streamOwnsHandle = Boolean(body);
      return response;
    }

    const body = method === 'HEAD' || stat.size === 0 ? null : createFileWebStream(handle, { end: stat.size - 1 });
    const response = new Response(body, { status: 200, headers: { ...commonHeaders, 'Content-Length': String(stat.size) } });
    streamOwnsHandle = Boolean(body);
    return response;
  } finally {
    if (!streamOwnsHandle) await handle.close().catch(() => undefined);
  }
};

module.exports = { createMediaFileResponse, parseByteRange };
