const path = require('node:path');
const fs = require('node:fs/promises');
const assetRoot = path.resolve(__dirname, '../../artifacts/player-runtime/v1');
const assets = new Map([
  ['photoflow-player://runtime/v1/timeline.js', ['timeline.js', 'text/javascript; charset=utf-8']],
  ['photoflow-player://runtime/v1/timeline.css', ['timeline.css', 'text/css; charset=utf-8']],
  ['photoflow-player://runtime/v1/player.js', ['player.js', 'text/javascript; charset=utf-8']],
  ['photoflow-player://runtime/v1/player.css', ['player.css', 'text/css; charset=utf-8']],
]);
const isHostPlayerAsset = url => assets.has(String(url));
async function serveHostPlayerAsset(request) {
  const asset = assets.get(request.url);
  if (!asset || request.method && request.method !== 'GET') return new Response('Not found', { status: 404 });
  try {
    return new Response(await fs.readFile(path.join(assetRoot, asset[0])), { headers: { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' } });
  } catch { return new Response('Host player unavailable', { status: 503 }); }
}
module.exports = { isHostPlayerAsset, serveHostPlayerAsset };
