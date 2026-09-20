const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/player-runtime/v1');
async function buildHostPlayer() {
  fs.mkdirSync(output, { recursive: true });
  const publish = (name, bytes) => { const file = path.join(output, name), temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, file); };
  const bundle = await require('esbuild').build({ write: false, entryPoints: [path.join(root, 'src/platform/video-playback/host-player.tsx')], bundle: true, format: 'iife', globalName: 'PhotoFlowPlayback', platform: 'browser', target: 'chrome120', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'inline' });
  publish('player.js', bundle.outputFiles[0].contents);
  const timeline = await require('esbuild').build({write:false,stdin:{contents: "globalThis.noUiSlider = require('nouislider'); module.exports = require('../src/platform/video-playback/frame-timeline.cjs');",resolveDir:__dirname},bundle:true,format:'iife',globalName:'PhotoFlowTimeline',platform:'browser',target:'chrome120'});
  publish('timeline.js',timeline.outputFiles[0].contents);
  publish('timeline.css',fs.readFileSync(require.resolve('nouislider/dist/nouislider.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'src/platform/video-playback/editor-timeline.css'),'utf8'));

  const styles = await require('postcss')([require('tailwindcss')({ content: [path.join(root, 'src/components/AdvancedVideoPlayer.tsx'), path.join(root, 'src/platform/video-playback/host-player.tsx')], important: '.photoflow-player', corePlugins: { preflight: false }, theme: { extend: { colors: { slate: { 850: '#151f32' } } } } })]).process('@tailwind utilities;', { from: undefined });
  publish('player.css', '.photoflow-player{position:relative;min-height:0;height:100%;color:white}.photoflow-player *{box-sizing:border-box}.photoflow-player svg{display:block}.photoflow-player button{font:inherit;cursor:pointer;border:0;background:transparent;color:inherit}.photoflow-player button:disabled{cursor:default}.photoflow-player:fullscreen{width:100%;height:100%;background:#000000}\n' + styles.css);
  publish('LICENSES.txt', ['react', 'react-dom', 'scheduler', 'lucide-react', 'nouislider'].map(name => name + '\n' + fs.readFileSync(path.join(root, 'node_modules', name, name==='nouislider'?'LICENSE.md':'LICENSE'), 'utf8')).join('\n\n'));
}
module.exports = { buildHostPlayer, output };
if (require.main === module) buildHostPlayer().catch(error => { console.error(error); process.exitCode = 1; });
