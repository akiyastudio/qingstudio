'use strict';
// Sources have already passed the runtime input boundary. Renderer paths never
// reach the shared player service directly, and sessions remain sender-owned.
const createComponentPlaybackBridge = ({getVideoPlaybackService,mediaService,extractVideoTimelineFrames}) => {
  const owners=new Map(),trackedSenders=new Set();
  const contextKey=context=>JSON.stringify([context.componentId||'',context.workspacePath||'',context.projectId||'',context.scopeRelativePath||'',context.contentKind||'']);
  const actions=new Set(['source','backends','start','control','bounds','stop','frames']);
  const setPaused=(sessionId,paused,context)=>{
    const sender=context.eventSender,owner=owners.get(sessionId),service=getVideoPlaybackService?.();
    if(!sender||sender.isDestroyed()||!service||!owner||owner.senderId!==sender.id||owner.contextKey!==contextKey(context))throw new Error('Playback session belongs to another page or project');
    if(typeof paused!=='boolean')throw new Error('Invalid playback pause state');
    // The session already owns an authorized source. Transport controls need
    // no service RPC or repeated filesystem resolution.
    service.control({sender},sessionId,{action:paused?'pause':'play'});
    return {success:true};
  };
  const updateBounds=(sessionId,bounds,context,sequence)=>{
    const sender=context.eventSender,owner=owners.get(sessionId),service=getVideoPlaybackService?.();
    if(!sender||sender.isDestroyed()||!service||!owner||owner.senderId!==sender.id||owner.contextKey!==contextKey(context))throw new Error('Playback session belongs to another page or project');
    const rect=context.playbackViewport?.();
    if(!rect||!bounds||['x','y','width','height'].some(k=>!Number.isFinite(bounds[k])))throw new Error('Invalid playback bounds');
    if(sequence!==undefined){if(!Number.isSafeInteger(sequence)||sequence<0)throw new Error('Invalid playback bounds sequence');if(sequence<=(owner.boundsSequence??-1))return {success:true};owner.boundsSequence=sequence;}
    owner.latest={bounds,context};
    const zoom=rect.zoom||1,scale=rect.scale||1;
    const x=Math.max(0,Math.min(rect.width,bounds.x*zoom)),y=Math.max(0,Math.min(rect.height,bounds.y*zoom));
    const viewportDip={x:rect.x+x,y:rect.y+y,width:Math.max(0,Math.min(bounds.width*zoom,rect.width-x)),height:Math.max(0,Math.min(bounds.height*zoom,rect.height-y))};
    const ownerWindow=context.playbackOwner?.();
    if(ownerWindow&&owner.ownerWindow!==ownerWindow){
      if(!owner.moving){owner.moving=Promise.resolve(service.moveHost(sender,ownerWindow)).then(()=>{owner.ownerWindow=ownerWindow;owner.moving=null;if(owners.get(sessionId)===owner&&owner.latest)updateBounds(sessionId,owner.latest.bounds,owner.latest.context);}).catch(()=>{owner.moving=null;service.setBounds({sender},sessionId,{x:0,y:0,width:0,height:0,visible:false});});}
      return {success:true};
    }
    // Clamp the native surface to its own component WebContentsView.
    service.setBounds({sender},sessionId,{x:Math.round(viewportDip.x*scale),y:Math.round(viewportDip.y*scale),width:Math.round(viewportDip.width*scale),height:Math.round(viewportDip.height*scale),viewportDip,visible:rect.visible&&bounds.visible===true});
    return {success:true};
  };
  const refreshBounds=context=>{for(const [sessionId,owner]of owners){if(owner.senderId!==context.eventSender?.id)continue;try{if(owner.contextKey!==contextKey(context))getVideoPlaybackService?.()?.setBounds({sender:context.eventSender},sessionId,{x:0,y:0,width:0,height:0,visible:false});else if(owner.latest)updateBounds(sessionId,owner.latest.bounds,context);}catch{}}};
  const invoke=async ({request,source,context,scopeKey})=>{
    if(!request||!actions.has(request.action))throw new Error('Unknown component playback action');
    const sender=context.eventSender;if(!sender||sender.isDestroyed())throw new Error('Playback page is closed');
    const service=getVideoPlaybackService?.();if(!service)throw new Error('Host player is unavailable');
    const event={sender};
    if(['source','backends','start','frames'].includes(request.action)){
      if(!source||source.directory)throw new Error('Select one media file for playback');
      const inputToken=request.action==='start'?mediaService.grantPath(source.filePath):null;
      if(request.action==='source'){const mediaUrl=mediaService.toUrl(source.filePath,true);context.grantMediaUrl?.(mediaUrl);return {success:true,mediaUrl};}
      if(request.action==='backends')return {success:true,backends:await service.describeBackends(source.filePath,['probably','maybe'].includes(request.browserProbe)?request.browserProbe:'unknown')};
      if(request.action==='frames'){
        if(!Array.isArray(request.times)||request.times.length>2||request.times.some(t=>!Number.isFinite(t)||t<0))throw new Error('Invalid frame times');
        return {frames:await extractVideoTimelineFrames(source.filePath,request.times)};
      }
      const ownerWindow=context.playbackOwner?.();
      const result=await service.start(event,'media-token:'+inputToken,{...request.settings,muted:true},request.playerId,request.requestId,request.backendId,ownerWindow);
      owners.set(result.sessionId,{senderId:sender.id,scopeKey,ownerWindow,contextKey:contextKey(context)});
      if(!trackedSenders.has(sender.id)){trackedSenders.add(sender.id);sender.once('destroyed',()=>{trackedSenders.delete(sender.id);for(const [id,entry]of owners)if(entry.senderId===sender.id)owners.delete(id);});}
      return {success:true,...result};
    }
    const owner=owners.get(request.sessionId);
    if(!owner||owner.senderId!==sender.id||request.action!=='stop'&&owner.scopeKey!==scopeKey)throw new Error('Playback session belongs to another page or project');
    if(request.action==='stop'){owners.delete(request.sessionId);return {success:service.stop(request.sessionId,sender.id)};}
    if(request.action==='control'){
      if(!['play','pause','seek','frame-step','frame-back-step','volume','mute','speed','transform','hdr-mode','tone-mapping','statistics-level','subtitle-select','subtitle-visible','subtitle-delay','subtitle-style','audio-select'].includes(request.control?.action))throw new Error('Unsupported playback control');
      service.control(event,request.sessionId,request.control);return {success:true};
    }
    return updateBounds(request.sessionId,request.bounds,context);
  };
  invoke.updateBounds=updateBounds;invoke.refreshBounds=refreshBounds;invoke.setPaused=setPaused;
  return invoke;
};
module.exports={createComponentPlaybackBridge};
