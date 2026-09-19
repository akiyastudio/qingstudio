const registerComponentIconProtocol = ({ protocol, registry, fs, writeLog = () => undefined }) => {
  protocol.handle('photoflow-component', async request => {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.hostname !== 'icon') return new Response('Not found', { status: 404 });
      const componentId = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const descriptor = registry.resolve(componentId);
      if (!descriptor?.icon) return new Response('Not found', { status: 404 });
      const bytes = await fs.promises.readFile(descriptor.icon.entry);
      return new Response(bytes, { status: 200, headers: {
        'Cache-Control': 'private, max-age=3600',
        'Content-Type': descriptor.icon.mimeType,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch (error) {
      writeLog('warn', 'Component icon protocol request failed', { url: request.url, error: error.message || String(error) });
      return new Response('Bad request', { status: 400 });
    }
  });
};

module.exports = { registerComponentIconProtocol };
