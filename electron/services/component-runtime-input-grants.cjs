'use strict';
const { COMPONENT_HOST_ERROR_CODES: CODES, hostError } = require('../contracts/component-host-errors.cjs');
// Persistent references remain private and bound to component/workspace/project/scope.
// Each use revalidates canonical identity; replacing a path never inherits consent.
const createRuntimeInputGrants = ({fs,path,crypto}) => {
  const rootFor=scope=>path.join(scope.componentRoot,'runtime-input-grants',crypto.createHash('sha256').update(scope.key).digest('hex'));
  const fileFor=(scope,id)=>{if(typeof id!=='string'||!/^grant-[a-f0-9-]{36}$/.test(id))throw hostError(CODES.INVALID_REQUEST,'Invalid retained input grant');return path.join(rootFor(scope),id+'.json');};
  const inspect=async filePath=>{const stat=await fs.promises.lstat(filePath);if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw hostError(CODES.PERMISSION_DENIED,'Retained input must be a regular file or directory');return {canonical:await fs.promises.realpath(filePath),dev:String(stat.dev),ino:String(stat.ino),directory:stat.isDirectory()};};
  return {
    retain:async(scope,inputs)=>{
      await fs.promises.mkdir(rootFor(scope),{recursive:true});const grants=[];
      try{for(const input of inputs){const identity=await inspect(input.filePath);const id='grant-'+crypto.randomUUID();await fs.promises.writeFile(fileFor(scope,id),JSON.stringify({schemaVersion:1,id,scope:scope.key,filePath:input.filePath,identity}),{flag:'wx'});grants.push({id,name:path.basename(input.filePath),kind:identity.directory?'directory':'file'});}return grants;}
      catch(error){await Promise.all(grants.map(g=>fs.promises.unlink(fileFor(scope,g.id)).catch(()=>{})));throw error;}
    },
    resolve:async(scope,id)=>{
      let value;try{value=JSON.parse(await fs.promises.readFile(fileFor(scope,id),'utf8'));}catch(error){if(error.code==='ENOENT')throw hostError(CODES.TOKEN_EXPIRED,'Retained input grant was removed; select the source again');throw error;}
      if(value.schemaVersion!==1||value.scope!==scope.key||value.id!==id)throw hostError(CODES.TOKEN_SCOPE,'Retained input belongs to another scope');
      let current;try{current=await inspect(value.filePath);}catch{throw hostError(CODES.NOT_FOUND,'Retained input is unavailable; reconnect the source or select it again');}
      if(JSON.stringify(current)!==JSON.stringify(value.identity))throw hostError(CODES.PERMISSION_DENIED,'Retained input identity changed; select the source again');
      return value.filePath;
    },
    revoke:async(scope,ids)=>{for(const id of ids)await fs.promises.unlink(fileFor(scope,id)).catch(error=>{if(error.code!=='ENOENT')throw error;});return {revoked:true};},
  };
};
module.exports={createRuntimeInputGrants};
