const { sendToApplicationRenderers } = require('./application-windows.cjs');
const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
const { registerRuntimeFolderArtifacts } = require('./component-runtime-artifacts.cjs');

const { createRuntimeInputGrants } = require('./component-runtime-input-grants.cjs');

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const insideOrEqual = (path, root, candidate) => { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return !relative || !relative.startsWith('..') && !path.isAbsolute(relative); };
const stableUuid = (crypto, value) => { const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16); bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128; const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`; };
const strings = (value, { maximum = 256, length = 4096 } = {}) => {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string' || item.length > length || /\0/.test(item))) throw hostError(CODES.INVALID_REQUEST, 'Invalid component runtime string array');
  return value;
};
const fields=(value,allowed,required=[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.prototype.hasOwnProperty.call(value,key)))throw hostError(CODES.INVALID_REQUEST,'Component runtime payload has missing or unknown fields');return value;};
const boundedText=(value,label,maximum=128)=>{if(typeof value!=='string'||!value||value.length>maximum||/\0/.test(value))throw hostError(CODES.INVALID_REQUEST,`Invalid ${label}`);return value;};
const taskSnapshot = task => task ? { id: String(task.id), state: String(task.state), progress: Number(task.progress) || 0, message: String(task.message || ''), checkpoint: task.checkpoint || null } : null;

const createComponentRuntimeExecutionService = ({ broker, ensureWorkspace, getProjectPath, getWorkspaceDataRoot, getBoundProject, path, fs, crypto, inputTokens, pluginService, backgroundTasks, versionService, mainWindow, mediaService, getVideoPlaybackService, extractVideoTimelineFrames, resolveComponentContentBinding = null }) => {
  const playback=require('./component-playback-bridge.cjs').createComponentPlaybackBridge({getVideoPlaybackService,mediaService,extractVideoTimelineFrames});
  const active = new Map();
  const retainedInputs = createRuntimeInputGrants({fs,path,crypto});
  const bound = async (context, descriptor) => {
    if (!context || !['project', 'component.sidePanel', 'media.contextAction', 'project.contextAction', 'project.importProvider', 'project.exportProvider'].includes(context.surface)) throw hostError(CODES.PERMISSION_DENIED, 'Runtime execution requires a bound project surface');
    const binding = resolveComponentContentBinding?.(context);
    if (context.contentKind === 'inspiration' && !binding) throw hostError(CODES.NOT_FOUND, 'Inspiration content binding is unavailable');
    const workspaceRoot = binding?.workspaceRoot || ensureWorkspace(context.workspacePath); const project = binding?.project || getBoundProject?.(workspaceRoot, context.projectName);
    if (!project || String(project.id || '') !== String(context.projectId || '')) throw hostError(CODES.NOT_FOUND, 'Bound project is unavailable');
    const projectRoot = binding?.projectRoot || path.resolve(getProjectPath(workspaceRoot, project.status || context.projectStatus, project.name || context.projectName));
    const suppliedScope = String(context.scopeRelativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (suppliedScope && (path.isAbsolute(suppliedScope) || suppliedScope.split('/').some(part => !part || part === '.' || part === '..'))) throw hostError(CODES.INVALID_REQUEST, 'Invalid runtime scope');
    const scopeRoot = path.resolve(projectRoot, suppliedScope); const canonicalProject = await fs.promises.realpath(projectRoot).catch(() => null); const canonicalScope = await fs.promises.realpath(scopeRoot).catch(() => null);
    if (!canonicalProject || !canonicalScope || !insideOrEqual(path, canonicalProject, canonicalScope)) throw hostError(CODES.PERMISSION_DENIED, 'Runtime scope is unsafe');
    return { workspaceRoot, project, projectRoot, scopeRoot, canonicalScope, canonicalProject, componentRoot: path.join(getWorkspaceDataRoot(workspaceRoot), 'components', descriptor.componentId), key: `${descriptor.componentId}\0${workspaceRoot}\0${project.id}\0${suppliedScope}` };
  };
  const resolveInputs = async (payload, context, descriptor, scope, reservedTokenFiles = null) => {
    const relativePaths = strings(payload.relativePaths || [], { maximum: 120, length: 1024 }); const tokenValues = strings(payload.inputTokens || [], { maximum: 120, length: 256 });
    const grantIds = strings(payload.inputGrants || [], { maximum: 120, length: 80 });
    if (relativePaths.length + tokenValues.length + grantIds.length > 120) throw hostError(CODES.INVALID_REQUEST, 'Too many component runtime inputs');
    const extensions = new Set(strings(payload.input?.extensions || [], { maximum: 64, length: 32 }).map(value => value.toLowerCase())); const values = [];
    const validate = async (candidate, relativePath = '') => { const stat = await fs.promises.lstat(candidate).catch(() => null); const canonical = await fs.promises.realpath(candidate).catch(() => null); if (!stat || stat.isSymbolicLink() || !canonical || relativePath && !insideOrEqual(path, scope.canonicalScope, canonical) || !stat.isDirectory() && (!stat.isFile() || extensions.size && !extensions.has(path.extname(candidate).toLowerCase()))) throw hostError(CODES.INVALID_REQUEST, 'Runtime input is missing, unsafe, or unsupported'); values.push({ filePath: candidate, relativePath, directory: stat.isDirectory() }); };
    for (const value of [...new Set(relativePaths)]) { const normalized = String(value).replace(/\\/g, '/'); if (!normalized || path.isAbsolute(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw hostError(CODES.INVALID_REQUEST, 'Invalid runtime input path'); const candidate = path.resolve(scope.projectRoot, normalized); if (!insideOrEqual(path, scope.scopeRoot, candidate)) throw hostError(CODES.PERMISSION_DENIED, 'Runtime input is outside the bound scope'); await validate(candidate, normalized); }
    for (const token of [...new Set(tokenValues)]) await validate(reservedTokenFiles?.get(token) || await inputTokens.peekInput(token, descriptor, context));
    for (const grant of [...new Set(grantIds)]) await validate(await retainedInputs.resolve(scope, grant));
    return values;
  };
  const previewRoot=scope=>path.join(scope.componentRoot,'runtime-previews',crypto.createHash('sha256').update(scope.key).digest('hex'));
  const operationIdFor = (scope, descriptor, payload) => stableUuid(crypto, `component-runtime-v1\0${descriptor.componentId}\0${scope.key}\0${String(payload.runtimeCapability || '')}\0${String(payload.operationKey || '')}\0${String(payload.idempotencyKey || '')}`);
  const invoke = async (payload, context, descriptor) => {
    fields(payload,['action','runtimeCapability','arguments','relativePaths','inputTokens','inputGrants','output','input','operationKey','idempotencyKey','eventName','timeoutMs','task','control','projectArtifacts','playback'],['action']);const action = String(payload?.action || ''); const scope = await bound(context, descriptor);
    if (!descriptor.service?.capabilities?.includes('component.runtime.execute')) throw hostError(CODES.PERMISSION_DENIED, 'Component runtime execution is not granted');
    if(action==='playback'){
      fields(payload,['action','relativePaths','inputGrants','input','playback'],['action','playback']);
      const needsSource=['source','backends','start','frames'].includes(payload.playback?.action);
      let sourcePayload=payload;
      if(payload.playback.outputPath!==undefined){
        const outputPath=String(payload.playback.outputPath);
        if(!path.isAbsolute(outputPath)||!insideOrEqual(path,scope.projectRoot,outputPath))throw hostError(CODES.PERMISSION_DENIED,'Preview output is outside the project');
        sourcePayload={...payload,relativePaths:[path.relative(scope.projectRoot,outputPath).replace(/\\/g,'/')],inputGrants:[]};
      }
      let playbackScope=payload.playback.outputPath!==undefined?{...scope,scopeRoot:scope.projectRoot,canonicalScope:scope.canonicalProject}:scope;
      if(payload.playback.privateOutputPath!==undefined){
        const root=previewRoot(scope),candidate=String(payload.playback.privateOutputPath);
        if(!path.isAbsolute(candidate)||!insideOrEqual(path,root,candidate))throw hostError(CODES.PERMISSION_DENIED,'Preview cache belongs to another scope');
        for(const directory of [path.dirname(root),root]){const stat=await fs.promises.lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw hostError(CODES.PERMISSION_DENIED,'Unsafe preview cache');}
        const canonical=await fs.promises.realpath(root);playbackScope={...scope,projectRoot:root,scopeRoot:root,canonicalScope:canonical};
        sourcePayload={relativePaths:[path.relative(root,candidate).replace(/\\/g,'/')],inputGrants:[]};
      }
      const inputs=needsSource?await resolveInputs({...sourcePayload,input:{extensions:['.mp4','.mov','.mkv','.webm','.m4v','.avi','.mxf','.mts','.m2ts','.ts','.mpeg','.mpg','.wav','.mp3','.flac','.m4a','.aiff']}},context,descriptor,playbackScope):[];
      if(needsSource&&inputs.length!==1)throw hostError(CODES.INVALID_REQUEST,'Playback requires one authorized source');
      return playback({request:payload.playback,source:inputs[0],context,scopeKey:scope.key});
    }
    if (action === 'inputs.retain') {
      fields(payload,['action','inputTokens','input'],['action','inputTokens','input']);
      const tokens=[...new Set(strings(payload.inputTokens,{maximum:120,length:256}))];
      const reservation='retain:'+crypto.randomUUID();
      const inputs=await inputTokens.reserveInputs(tokens,descriptor,context,reservation);
      try {const validated=await resolveInputs(payload,context,descriptor,scope,new Map(inputs.map(x=>[x.token,x.filePath])));const grants=await retainedInputs.retain(scope,validated);await inputTokens.commitReservation(reservation);return {grants};}
      catch(error){await inputTokens.releaseReservation(reservation);throw error;}
    }
    if (action === 'inputs.revoke') {fields(payload,['action','inputGrants'],['action','inputGrants']);return retainedInputs.revoke(scope,strings(payload.inputGrants,{maximum:120,length:80}));}
    if (action === 'status' || action === 'cancel' || action === 'pause' || action === 'resume') {
      fields(payload,['action','runtimeCapability','operationKey','idempotencyKey'],['action','runtimeCapability','operationKey','idempotencyKey']);
      if (!ID.test(String(payload.operationKey || '')) || !ID.test(String(payload.idempotencyKey || '')) || typeof payload.runtimeCapability !== 'string') throw hostError(CODES.INVALID_REQUEST, 'Invalid runtime operation identity');
      const operationId = operationIdFor(scope, descriptor, payload); const task = backgroundTasks?.get?.(operationId);
      if (task && (task.metadata?.componentId !== descriptor.componentId || String(task.metadata?.projectId) !== String(context.projectId))) throw hostError(CODES.TOKEN_SCOPE, 'Runtime task belongs to another scope');
      if (action === 'cancel' && task && !TERMINAL.has(task.state)) backgroundTasks.cancel(operationId);
      if (action === 'pause' && task && !TERMINAL.has(task.state)) backgroundTasks.pause?.(operationId);
      if (action === 'resume' && task && !TERMINAL.has(task.state)) backgroundTasks.continuePaused?.(operationId);
      return { operationId, cancelled: action === 'cancel' && Boolean(task), task: taskSnapshot(backgroundTasks?.get?.(operationId) || task) };
    }
    if (action === 'inputs.preview') {
      fields(payload,['action','relativePaths','inputTokens','inputGrants','output','input'],['action','input']);fields(payload.input,['extensions','prefixArgumentCount','directoryArgument']);
      const previewTokens=[...new Set(strings(payload.inputTokens||[],{maximum:120,length:256}))];const previewReservation=`preview:${crypto.randomUUID()}`;const previewReserved=previewTokens.length?await inputTokens.reserveInputs(previewTokens,descriptor,context,previewReservation):[];
      try{const inputs = await resolveInputs(payload, context, descriptor, scope,new Map(previewReserved.map(item=>[item.token,item.filePath]))); const sourcePreviews = [];
      for (let sourceIndex=0; sourceIndex<inputs.length; sourceIndex+=1) { const source=inputs[sourceIndex]; if(!source.directory){sourcePreviews.push({sourceIndex,count:1,files:[path.basename(source.filePath)],truncated:false});continue;} const pending=[source.filePath],files=[];let count=0,inspected=0,truncated=false;while(pending.length&&inspected<20000){const directory=pending.shift();let handle;try{handle=await fs.promises.opendir(directory);}catch{truncated=true;continue;}for await(const child of handle){inspected+=1;if(inspected>20000){truncated=true;break;}if(child.isSymbolicLink()){truncated=true;continue;}const candidate=path.join(directory,child.name);if(child.isDirectory()){pending.push(candidate);continue;}if(!child.isFile())continue;const extensions=new Set((payload.input.extensions||[]).map(value=>String(value).toLowerCase()));if(extensions.size&&!extensions.has(path.extname(child.name).toLowerCase()))continue;count+=1;if(files.length<2000)files.push(path.relative(source.filePath,candidate).replace(/\\/g,'/'));else truncated=true;}}if(pending.length)truncated=true;sourcePreviews.push({sourceIndex,count,files,truncated});}
      return { sourcePreviews };}finally{if(previewTokens.length)await inputTokens.releaseReservation(previewReservation);}
    }
    if (action !== 'execute') throw hostError(CODES.INVALID_REQUEST, 'Unknown component runtime action');
    fields(payload,['action','runtimeCapability','arguments','relativePaths','inputTokens','inputGrants','output','input','operationKey','idempotencyKey','eventName','timeoutMs','task','control','projectArtifacts'],['action','runtimeCapability','arguments']);if(payload.input!==undefined)fields(payload.input,['extensions','prefixArgumentCount','directoryArgument']);if(payload.task!==undefined)fields(payload.task,['background','title','runningMessage','completeMessage','concurrencyGroup','concurrencyLimit','concurrencyWriteLimit']);if(payload.control!==undefined)fields(payload.control,['cancelArgument','pauseArgument']);
    if (payload.projectArtifacts !== undefined) {
      fields(payload.projectArtifacts, ['mode', 'mediaKind'], ['mode', 'mediaKind']);
      if (!['preview', 'transcode'].includes(payload.projectArtifacts.mode) || !['image', 'video'].includes(payload.projectArtifacts.mediaKind) || payload.projectArtifacts.mode === 'transcode' && payload.projectArtifacts.mediaKind !== 'video') throw hostError(CODES.INVALID_REQUEST, 'Invalid generated artifact policy');
      if (context.contentKind === 'inspiration' || !descriptor.service?.capabilities?.includes('project.progress') || !descriptor.service?.permissions?.includes('project.progress')) throw hostError(CODES.PERMISSION_DENIED, 'Generated project artifacts require project progress permission');
    }
    const runtimeCapability = boundedText(payload.runtimeCapability,'runtime capability');const eventName=payload.eventName===undefined?'':boundedText(payload.eventName,'runtime event');if(eventName&&!descriptor.service?.events?.includes(eventName))throw hostError(CODES.PERMISSION_DENIED,'Runtime event is not declared by the component');
    const args = strings(payload.arguments || []); const prefixCount = Number(payload.input?.prefixArgumentCount || 0); if (!Number.isInteger(prefixCount) || prefixCount < 0 || prefixCount > args.length) throw hostError(CODES.INVALID_REQUEST, 'Invalid runtime input argument layout');
    if(payload.timeoutMs===0&&payload.task?.background!==true)throw hostError(CODES.INVALID_REQUEST,'Unlimited runtime requires a cancellable background task');
    if(payload.timeoutMs===0&&!payload.control?.cancelArgument)throw hostError(CODES.INVALID_REQUEST,'Unlimited runtime requires cancellation');
    const outputArgs=[];
    if(payload.output?.private===true){
      fields(payload.output,['private','argument'],['private','argument']);
      const argument=boundedText(payload.output.argument,'preview output argument');if(!/^--[a-z][a-z0-9-]*$/.test(argument)||args.includes(argument))throw hostError(CODES.INVALID_REQUEST,'Invalid preview output argument');
      const root=previewRoot(scope),target=path.join(root,crypto.randomUUID());
      for(const directory of [path.dirname(root),root]){const stat=await fs.promises.lstat(directory).catch(()=>null);if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))throw hostError(CODES.PERMISSION_DENIED,'Unsafe preview cache');}
      await fs.promises.mkdir(target,{recursive:true});
      if(!insideOrEqual(path,await fs.promises.realpath(scope.componentRoot),await fs.promises.realpath(target)))throw hostError(CODES.PERMISSION_DENIED,'Preview cache crosses a link');
      outputArgs.push(argument,target);
    }else if(payload.output!==undefined){
      fields(payload.output,['relativeDirectory','argument'],['relativeDirectory','argument']);
      const relative=String(payload.output.relativeDirectory||'').replace(/\\/g,'/');
      if(!relative||path.isAbsolute(relative)||relative!=='.'&&relative.split('/').some(part=>!part||part==='.'||part==='..'||/[<>:"|?*\x00-\x1f]/.test(part)))throw hostError(CODES.INVALID_REQUEST,'Output directory must be project-relative');
      const target=path.resolve(scope.projectRoot,relative);
      if(!insideOrEqual(path,scope.projectRoot,target))throw hostError(CODES.PERMISSION_DENIED,'Output directory is outside the project');
      let existing=target;while(!await fs.promises.lstat(existing).catch(()=>null)){const parent=path.dirname(existing);if(parent===existing)throw hostError(CODES.INVALID_REQUEST,'Output ancestor is missing');existing=parent;}
      const canonical=await fs.promises.realpath(existing);if(!insideOrEqual(path,scope.canonicalProject,canonical))throw hostError(CODES.PERMISSION_DENIED,'Output directory crosses a link outside the project');
      await fs.promises.mkdir(target,{recursive:true});
      if(!insideOrEqual(path,scope.canonicalProject,await fs.promises.realpath(target)))throw hostError(CODES.PERMISSION_DENIED,'Output directory changed');
      const argument=boundedText(payload.output.argument,'output argument');if(!/^--[a-z][a-z0-9-]*$/.test(argument)||args.includes(argument))throw hostError(CODES.INVALID_REQUEST,'Invalid output argument');
      outputArgs.push(argument,target);
    }
    const operationKey = String(payload.operationKey || ''); const key = String(payload.idempotencyKey || ''); const background = payload.task?.background === true;
    if (background && (!ID.test(operationKey) || !ID.test(key))) throw hostError(CODES.INVALID_REQUEST, 'Background runtime execution requires stable operation keys');
    const operationId = background ? operationIdFor(scope, descriptor, payload) : crypto.randomUUID(); const existing = backgroundTasks?.get?.(operationId); if (existing && !['failed','cancelled'].includes(existing.state)) return { operationId,task:taskSnapshot(existing) };
    const runtimeTokens=[...new Set(strings(payload.inputTokens||[],{maximum:120,length:256}))];const reservationId=`runtime:${operationId}`;const reserved=runtimeTokens.length?await inputTokens.reserveInputs(runtimeTokens,descriptor,context,reservationId):[];const reservedTokenFiles=new Map(reserved.map(item=>[item.token,item.filePath]));
    let runtimeSucceeded=false;let runtimeStageRoot='';let terminalEvent='';try {
    const inputs = await resolveInputs(payload, context, descriptor, scope, reservedTokenFiles);
    const stageRoot=path.join(scope.componentRoot,'stages','runtime-v1',operationId),cancelFile=path.join(stageRoot,'cancel'),pauseFile=path.join(stageRoot,'pause');runtimeStageRoot=stageRoot;await fs.promises.mkdir(stageRoot,{recursive:true});
    const directoryArgument=payload.input?.directoryArgument===undefined?'':boundedText(payload.input.directoryArgument,'directory argument'); const control=payload.control&&typeof payload.control==='object'?payload.control:{}; const controlArgs=[]; if(control.cancelArgument)controlArgs.push(boundedText(control.cancelArgument,'cancel argument'),cancelFile); if(control.pauseArgument)controlArgs.push(boundedText(control.pauseArgument,'pause argument'),pauseFile);
    const invocationArgs=[...args.slice(0,prefixCount),...inputs.map(item=>item.filePath),...args.slice(prefixCount),...(directoryArgument?inputs.filter(item=>item.directory).flatMap(item=>[directoryArgument,item.filePath]):[]),...controlArgs,...outputArgs];
    const emit = (eventType, progress, message, runtimeEvent) => {
      if (['complete', 'cancelled', 'failed'].includes(eventType)) terminalEvent = eventType;
      if (eventName) context.emitComponentEvent?.(eventName, { operationId, operationKey, eventType, progress, message, runtimeEvent });
    };
    const execute = async task => {
      task?.setPausable?.(Boolean(control.pauseArgument));
      const cancel = () => void fs.promises.writeFile(cancelFile, 'cancel', 'utf8').catch(() => undefined);
      task?.signal?.addEventListener('abort', cancel, { once: true });
      active.set(operationId, { componentId: descriptor.componentId, cancelFile, pauseFile });
      let finished = false;
      let pauseRequested = false;
      let controlUpdates = Promise.resolve();
      const unsubscribe = control.pauseArgument && task ? backgroundTasks.subscribe?.(delta => {
        const snapshot = delta.upserts?.find(item => item.id === task.id);
        if (!snapshot || finished) return;
        const paused = ['pausing', 'paused'].includes(snapshot.state);
        if (pauseRequested === paused) return;
        pauseRequested = paused;
        controlUpdates = controlUpdates.then(async () => {
          if (finished) return;
          if (paused) {
            await fs.promises.writeFile(pauseFile, 'pause', 'utf8');
            void task.waitIfPaused?.().catch(() => undefined);
          } else await fs.promises.rm(pauseFile, { force: true });
          emit(paused ? 'paused' : 'running', snapshot.progress, paused ? '已暂停' : '正在继续任务');
        }).catch(error => {
          task.report(snapshot.progress, '无法同步任务控制：' + error.message);
        });
      }) : null;
      try {
        const final = await pluginService.runJsonForComponentCapability(
          descriptor.componentId, runtimeCapability, invocationArgs,
          payload.timeoutMs === 0 ? 0 : Math.max(1000, Math.min(4 * 60 * 60 * 1000, Number(payload.timeoutMs) || 20 * 60 * 1000)),
          message => {
            if (!['progress', 'status', 'log'].includes(String(message?.type || ''))) return;
            const progress = Math.max(0, Math.min(99, Number(message?.progress) || 0));
            const text = String(message?.message || payload.task?.runningMessage || 'Component runtime is running').slice(0, 500);
            task?.report?.(progress, text, { operationKey });
            emit(String(message.type), progress, text, message);
          }, task?.signal, undefined, context,
        );
        task?.throwIfCancelled?.();
        if (payload.projectArtifacts) {
          task?.report?.(99, '正在登记生成结果的版本关系');
          try {
            final.projectArtifacts = await registerRuntimeFolderArtifacts({ result: final, policy: payload.projectArtifacts, inputs, scope, context, versionService, fs, path });
          } catch (error) {
            throw hostError(CODES.INTERNAL, `文件已生成，但版本关系登记失败：${error.message || String(error)}`);
          }
          if (final.projectArtifacts.linked.length && mainWindow && !mainWindow.isDestroyed()) {
            sendToApplicationRenderers(mainWindow, 'workspace-files-changed', { root: scope.workspaceRoot, fileName: path.relative(scope.workspaceRoot, scope.projectRoot).replace(/\\/g, '/'), eventType: 'rename' });
          }
        }
        const message = String(payload.task?.completeMessage || 'Component runtime complete').slice(0, 500);
        task?.report?.(100, message, { operationKey });
        return { operationId, result: final };
      } catch (error) {
        emit(task?.signal?.aborted ? 'cancelled' : 'failed', backgroundTasks?.get?.(operationId)?.progress || 0, error.message || String(error));
        throw error;
      } finally {
        finished = true;
        unsubscribe?.();
        await controlUpdates;
        task?.signal?.removeEventListener('abort', cancel);
        active.delete(operationId);
      }
    };
    if (!background) { const result = await execute(null); runtimeSucceeded = true; emit('complete', 100, String(payload.task?.completeMessage || 'Component runtime complete').slice(0, 500), result.result); return result; }
    if (!backgroundTasks?.run) throw hostError(CODES.INTERNAL, 'Background task service is unavailable');
    const presentation = context.surface === 'component.sidePanel' && context.sourcePageId && context.contributionId ? {
      presentationOwnerPageId: String(context.sourcePageId),
      presentationPanelKind: 'component:' + descriptor.componentId + ':' + context.contributionId,
    } : {};
    const execution = await backgroundTasks.run({
      id: operationId, type: 'component-runtime', title: String(payload.task?.title || 'Component runtime operation').slice(0, 160),
      message: String(payload.task?.runningMessage || '').slice(0, 500),
      cancellable: Boolean(control.cancelArgument), resumePolicy: 'safe-restart',
      concurrencyGroup: String(payload.task?.concurrencyGroup || 'component-runtime').slice(0, 80),
      concurrencyLimit: Math.max(1, Math.min(8, Number(payload.task?.concurrencyLimit) || 1)),
      concurrencyWriteLimit: Math.max(1, Math.min(8, Number(payload.task?.concurrencyWriteLimit) || 1)),
      metadata: { componentId: descriptor.componentId, projectId: String(context.projectId), operationKey, ...presentation },
    }, execute);
    if (execution.cancelled || execution.task?.state === 'cancelled') {
      if (terminalEvent !== 'cancelled') emit('cancelled', execution.task?.progress || 0, '任务已取消');
      throw Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELLED' });
    }
    emit('complete', 100, String(payload.task?.completeMessage || 'Component runtime complete').slice(0, 500), execution.result?.result);
    runtimeSucceeded = true;
    return execution.result ? { ...execution.result, task: taskSnapshot(execution.task) } : execution;
    } finally { if(runtimeStageRoot)await fs.promises.rm(runtimeStageRoot,{recursive:true,force:true}).catch(()=>undefined);if(runtimeTokens.length){if(runtimeSucceeded)await inputTokens.commitReservation(reservationId);else await inputTokens.releaseReservation(reservationId);} }
  };
  broker.register('component.runtime.execute', invoke);
  return { invoke, setPlaybackPaused:playback.setPaused,updatePlaybackBounds:playback.updateBounds,refreshPlaybackBounds:playback.refreshBounds, clearComponent: componentId => {
    for (const task of backgroundTasks?.list?.() || []) if (task.type === 'component-runtime' && task.metadata?.componentId === componentId && !TERMINAL.has(task.state)) backgroundTasks.cancel(task.id);
    for (const [operationId,item] of active) if(item.componentId===componentId){backgroundTasks?.cancel?.(operationId);if(item.cancelFile)void fs.promises.writeFile(item.cancelFile,'cancel','utf8').catch(()=>undefined);}
  } };
};

module.exports = { createComponentRuntimeExecutionService };
