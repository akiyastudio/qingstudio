const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, protocol } = require('electron');
const { serveHostPlayerAsset } = require('../electron/services/host-player-assets.cjs');
const cache = path.resolve(__dirname, '../.cache/host-player-test');
fs.mkdirSync(cache, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(cache, 'profile-')));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'photoflow-player', privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true } }]);
const server = http.createServer((_request, response) => response.end('<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="photoflow-player://runtime/v1/player.css"></head><body><div id="first" style="width:650px;height:400px"></div><div id="second" style="width:650px;height:400px"></div><script src="photoflow-player://runtime/v1/player.js"></script></body></html>'));
let window;
const evaluate = code => window.webContents.executeJavaScript(code, true);
const until = async expression => { const end = Date.now() + 10000; while (Date.now() < end) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw Error('Timed out: ' + expression); };
(async () => {
  await app.whenReady(); protocol.handle('photoflow-player', serveHostPlayerAsset);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const descriptor = (await require('../electron/services/video-playback-broker.cjs').createVideoPlaybackBroker({ pluginService: { listInstalled: () => [] }, path }).listDescriptors('fixture.mp4', 'probably'))[0];
  await evaluate(`window.descriptor=${JSON.stringify(descriptor)};`);
  await evaluate(`(() => {
    const f=window.fixture={errors:[],commands:[],stops:[],bounds:[],players:[],listeners:[new Set(),new Set()],states:[],delay:0};
    addEventListener('error',e=>f.errors.push(e.message));addEventListener('unhandledrejection',e=>f.errors.push(String(e.reason)));
    try { PhotoFlowPlayback.mount(document.querySelector('#first'),{apiVersion:2}); } catch(e) { f.versionError=e.message; }
    for(let index=0;index<2;index++){
      const emit=patch=>{f.states[index]={...f.states[index],...patch};const state={...f.states[index]};for(const listener of f.listeners[index])listener(state);};
      const api={
        getVideoPlaybackBackends:async()=>({success:true,backends:[{...descriptor,backendId:'fixture.native',transport:'native'}]}),
        startVideoPlayer:async(_,settings,playerId,requestId)=>{f.states[index]={sessionId:'session-'+index,playerId,requestId,type:'file-loaded',time:0,duration:60,paused:true,buffering:false,volume:100,muted:false,speed:1,width:640,height:360};setTimeout(()=>emit({}),10);return {success:true,sessionId:'session-'+index};},
        onVideoPlayerState:fn=>{f.listeners[index].add(fn);return()=>f.listeners[index].delete(fn);},
        controlVideoPlayer:(id,request)=>{f.commands.push({index,id,...request});if(['play','pause'].includes(request.action)){const paused=request.action==='pause';setTimeout(()=>emit({type:'state',paused}),f.delay);}else if(request.action==='seek')emit({type:'state',time:request.value});},
        stopVideoPlayer:async id=>{f.stops.push({index,id});return {success:true};},
        setVideoPlayerBounds:(id,value)=>f.bounds.push({index,id,...value}),
        setHostSurfaceSuspended:async()=>{},getVideoDisplayCapabilities:async()=>({success:true,display:{hdrAvailable:false,reason:'test'}})
      };
      f.players.push(PhotoFlowPlayback.mount(document.querySelector(index?'#second':'#first'),{apiVersion:1,filePath:'fixture-'+index,electronApi:api,onState:()=>{},onError:message=>f.errors.push(message)}));
    }
  })()`);
  await until("[...document.querySelectorAll('[data-player-play]')].length===2 && [...document.querySelectorAll('[data-player-play]')].every(b=>!b.disabled)");
  assert.equal(await evaluate('window.electronAPI === undefined'), true, 'mount must not install global capabilities');
  assert.match(await evaluate('fixture.versionError'), /版本不兼容/);
  await evaluate("fixture.delay=500;document.querySelector('#first [data-player-play]').click()");
  await until("document.querySelector('#first [data-player-play]').getAttribute('aria-label')==='暂停'");
  await evaluate("document.querySelector('#first [data-player-play]').click()");
  await until("document.querySelector('#first [data-player-play]').getAttribute('aria-label')==='播放'");
  await evaluate("document.querySelector('#second [data-player-play]').click()");
  await until("document.querySelector('#second [data-player-play]').getAttribute('aria-label')==='暂停'");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(await evaluate("document.querySelector('#first [data-player-play]').getAttribute('aria-label')"), '播放', 'late state must not undo the newest pause');
  assert.deepEqual(await evaluate("fixture.commands.filter(c=>['play','pause'].includes(c.action)).map(c=>[c.index,c.id,c.action])"), [[0,'session-0','play'],[0,'session-0','pause'],[1,'session-1','play']]);
  await evaluate("document.querySelector('#second [data-player-step=\"1\"]').click()");
  assert.equal(await evaluate("fixture.commands.some(c=>c.index===1&&c.action==='frame-step')"),true);
  await evaluate("document.querySelector('#first').style.display='none';document.querySelector('#second [role=button]').focus();document.querySelector('#second [role=button]').dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));");
  assert.equal(await evaluate("fixture.commands.filter(c=>['play','pause'].includes(c.action)).at(-1).index"),1,'focused visible player receives the shortcut');
  await until('fixture.states[1].paused===true');
  await evaluate("fixture.players[1].control({action:'play'})");
  await until('fixture.states[1].paused===false');
  await evaluate("document.querySelector('#second [data-player-play]').click();fixture.pauseDone=false;void fixture.players[1].pauseAtFrame().then(()=>{fixture.pauseDone=true;});");
  assert.equal(await evaluate('fixture.pauseDone'),false,'pause-and-mark must wait for acknowledgement despite the optimistic pause button');
  await until('fixture.pauseDone===true');
  await evaluate('fixture.players[0].close();fixture.players[0].close();fixture.players[1].close()');
  await until('fixture.stops.length===2');
  assert.deepEqual(await evaluate('fixture.listeners.map(s=>s.size)'),[0,0]);
  assert.deepEqual(await evaluate('fixture.errors'),[]);
  assert.equal(await evaluate("document.querySelectorAll('[data-video-player]').length"),0);
  console.log('Host player v1: real protocol assets, incompatible version, independent native sessions, delayed controls, frame stepping, focus and idempotent disposal passed.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{window?.destroy();server.close();app.exit(process.exitCode||0);});
