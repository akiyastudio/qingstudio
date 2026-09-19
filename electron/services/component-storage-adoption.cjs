/** Safe, source-preserving adoption for a previously owned component storage generation. */
const MAX_STORAGE_FILES=50_000,MAX_STORAGE_BYTES=64*1024*1024*1024,MAX_STORAGE_DEPTH=64,MAX_RECEIPT_BYTES=8*1024*1024;
const digest = async (fs, crypto, filePath) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};
const copyTreeVerified = async ({ fs, path, crypto, source, destination, overwrite = false, metrics = { fileCount: 0, byteCount: 0 }, root = source, exclude = new Set(), depth=0 }) => {
  if(depth>MAX_STORAGE_DEPTH)throw new Error('Legacy component storage exceeds the maximum directory depth');
  const relative = path.relative(root, source).replace(/\\/g, '/');
  if (relative && exclude.has(relative)) return metrics;
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('Legacy component storage contains a symbolic link');
  if (stat.isDirectory()) {
    await fs.promises.mkdir(destination, { recursive: true });
    const handle=await fs.promises.opendir(source);for await(const entry of handle)await copyTreeVerified({ fs, path, crypto, source: path.join(source, entry.name), destination: path.join(destination, entry.name), overwrite, metrics, root, exclude,depth:depth+1 });
    return metrics;
  }
  if (!stat.isFile()) throw new Error('Legacy component storage contains an unsupported entry');
  if(metrics.fileCount+1>MAX_STORAGE_FILES||metrics.byteCount+stat.size>MAX_STORAGE_BYTES)throw new Error('Legacy component storage exceeds adoption limits');
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination, overwrite ? 0 : fs.constants.COPYFILE_EXCL);
  const sourceDigest=await digest(fs,crypto,source),destinationDigest=await digest(fs,crypto,destination);if(sourceDigest!==destinationDigest) throw new Error('Legacy component storage copy verification failed');
  metrics.fileCount += 1;
  metrics.byteCount += stat.size;
  (metrics.digests||=new Map()).set(path.resolve(destination),{size:stat.size,sha256:destinationDigest});
  return metrics;
};
const readReceipt = async (fs, filePath) => { try {const stat=await fs.promises.lstat(filePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_RECEIPT_BYTES)throw new Error('Invalid component storage receipt size'); const value = JSON.parse(await fs.promises.readFile(filePath, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid component storage receipt'); return value; } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } };
const exactKeys = (value, required) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...required].sort().join('\0');
const validReceipt = (value, componentId, state = 'committed') => {
  const common = value?.schemaVersion === 1 && value.kind === 'component-storage-adoption' && value.state === state && value.componentId === componentId;
  if (!common) return false;
  if (state === 'prepared') return exactKeys(value, ['schemaVersion','kind','state','componentId','pending','previous','componentRoot','preparedAt'])
    && [value.pending,value.previous,value.componentRoot].every(item => typeof item === 'string' && item.length > 0) && Number.isFinite(value.preparedAt);
  return exactKeys(value, ['schemaVersion','kind','state','componentId','adoptedDataRoot','adoptedDatabase','legacyDataRoot','legacyDatabasePath','databaseSha256','copiedFileCount','copiedByteCount','contentManifest','contentDigest','adoptedAt'])
    && typeof value.adoptedDataRoot==='boolean'&&typeof value.adoptedDatabase==='boolean'&&typeof value.legacyDataRoot==='string'&&typeof value.legacyDatabasePath==='string'&&Number.isSafeInteger(value.copiedFileCount)&&value.copiedFileCount>=0&&Number.isSafeInteger(value.copiedByteCount)&&value.copiedByteCount>=0
    && (!value.adoptedDatabase&&value.databaseSha256===''||value.adoptedDatabase&&/^[a-f0-9]{64}$/.test(value.databaseSha256))&&Array.isArray(value.contentManifest)&&value.contentManifest.length<=MAX_STORAGE_FILES && value.contentManifest.every(item => exactKeys(item, ['path','size','sha256']) && typeof item.path === 'string'&&item.path.length<=4096&&!item.path.split('/').some(part=>!part||part==='.'||part==='..') && Number.isSafeInteger(item.size) && item.size >= 0 && /^[a-f0-9]{64}$/.test(item.sha256))
    && value.contentManifest.reduce((sum,item)=>sum+item.size,0)<=MAX_STORAGE_BYTES&&/^[a-f0-9]{64}$/.test(String(value.contentDigest || '')) && Number.isFinite(value.adoptedAt);
};
const lstatOptional = async (fs, filePath) => { try { return await fs.promises.lstat(filePath); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } };
const buildManifest = async ({ fs, path, crypto, root, knownDigests = null }) => {
  const files = []; const pending = [{directory:root,depth:0}];let byteCount=0;
  while (pending.length) {
    const {directory,depth}=pending.pop();if(depth>MAX_STORAGE_DEPTH)throw new Error('Component storage manifest exceeds the maximum directory depth');const entries=await fs.promises.opendir(directory);
    for await (const entry of entries) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (relative === 'receipts/migrations/legacy-storage-v1.json') continue;
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Component storage manifest contains a symbolic link');
      if (stat.isDirectory()) pending.push({directory:absolute,depth:depth+1}); else if (stat.isFile()) {byteCount+=stat.size;if(files.length>=MAX_STORAGE_FILES||byteCount>MAX_STORAGE_BYTES)throw new Error('Component storage manifest exceeds adoption limits');const known=knownDigests?.get(path.resolve(absolute));files.push({ path: relative, size: stat.size, sha256: known?.size===stat.size?known.sha256:await digest(fs, crypto, absolute) });} else throw new Error('Component storage manifest contains an unsupported entry');
    }
  }
  files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const contentDigest = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
  if(Buffer.byteLength(JSON.stringify(files))>MAX_RECEIPT_BYTES/2)throw new Error('Component storage manifest is too large');
  return { contentManifest: files, contentDigest };
};
const verifyReceiptTree = async ({ fs, path, crypto, root, receipt, componentId }) => {
  if (!validReceipt(receipt, componentId)) return false;
  const manifest = await buildManifest({ fs, path, crypto, root });
  return manifest.contentDigest === receipt.contentDigest && JSON.stringify(manifest.contentManifest) === JSON.stringify(receipt.contentManifest);
};
const transactionPaths = (path, componentRoot, componentId) => {
  const parent = path.dirname(componentRoot);
  return {
    journal: path.join(parent, `.${componentId}.legacy-v1-adoption.json`),
    pending: path.join(parent, `.${componentId}.legacy-v1-adoption.pending`),
    previous: path.join(parent, `.${componentId}.legacy-v1-adoption.previous`),
  };
};
const writeJournal = async ({ fs, path, crypto, journal, value }) => {
  const temporary = `${journal}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.promises.rename(temporary, journal);
};
const restorePreviousAfterFailedCommit = async ({ fs, componentRoot, previous, journal, error }) => {
  const failures=[]; const failed=`${componentRoot}.failed-adoption-${Date.now()}`;
  try { if(fs.existsSync(componentRoot))await fs.promises.rename(componentRoot,failed); } catch(failure){failures.push(failure);}
  let restored=false;
  if(!failures.length&&fs.existsSync(previous)){try{await fs.promises.rename(previous,componentRoot);restored=true;}catch(failure){failures.push(failure);}}
  if(restored)await fs.promises.rm(journal,{force:true}).catch(failure=>failures.push(failure));
  if(failures.length)throw new AggregateError([error,...failures],'Component storage recovery failed; retained generations were preserved');
  throw error;
};
const recoverLegacyStorageV1 = async ({ fs, path, crypto, componentRoot, descriptor }) => {
  const transaction = transactionPaths(path, componentRoot, descriptor.componentId);
  const parent = path.dirname(transaction.journal);
  const journalTemporaryPrefix = `${path.basename(transaction.journal)}.`;
  let parentEntries; try { parentEntries=await fs.promises.readdir(parent); } catch(error) { if(error?.code==='ENOENT') parentEntries=[]; else throw error; }
  for (const entry of parentEntries) {
    if (!entry.startsWith(journalTemporaryPrefix) || !entry.endsWith('.tmp')) continue;
    await fs.promises.rm(path.join(parent, entry), { force: true });
  }
  const journal = await readReceipt(fs, transaction.journal);
  const visibleReceipt = await readReceipt(fs, path.join(componentRoot, 'receipts', 'migrations', 'legacy-storage-v1.json'));
  if (visibleReceipt && !validReceipt(visibleReceipt, descriptor.componentId)) throw new Error('Visible component storage adoption receipt is invalid');
  if (validReceipt(visibleReceipt, descriptor.componentId)) {
    if (journal) {
      if (!validReceipt(journal, descriptor.componentId, 'prepared') || !await verifyReceiptTree({ fs, path, crypto, root: componentRoot, receipt: visibleReceipt, componentId: descriptor.componentId })) throw new Error('Committed component storage adoption cannot be verified for recovery');
      await fs.promises.rm(transaction.pending, { recursive: true, force: true });
      await fs.promises.rm(transaction.previous, { recursive: true, force: true });
      await fs.promises.rm(transaction.journal, { force: true });
    }
    return visibleReceipt;
  }
  if (!journal) {
    if (!fs.existsSync(componentRoot) && fs.existsSync(transaction.previous)) await fs.promises.rename(transaction.previous, componentRoot);
    if (!fs.existsSync(componentRoot) && fs.existsSync(transaction.pending)) {
      const pendingStat = await fs.promises.lstat(transaction.pending);
      const pendingReceipt = pendingStat.isDirectory() && !pendingStat.isSymbolicLink()
        ? await readReceipt(fs, path.join(transaction.pending, 'receipts', 'migrations', 'legacy-storage-v1.json')) : null;
      if (validReceipt(pendingReceipt, descriptor.componentId) && await verifyReceiptTree({ fs, path, crypto, root: transaction.pending, receipt: pendingReceipt, componentId: descriptor.componentId })) {
        await fs.promises.rename(transaction.pending, componentRoot);
        return pendingReceipt;
      }
    }
    if (fs.existsSync(transaction.pending)) await fs.promises.rename(transaction.pending, `${transaction.pending}.orphan-${Date.now()}`);
    return null;
  }
  if (!validReceipt(journal, descriptor.componentId, 'prepared') || path.resolve(journal.pending) !== path.resolve(transaction.pending) || path.resolve(journal.previous) !== path.resolve(transaction.previous) || path.resolve(journal.componentRoot) !== path.resolve(componentRoot)) throw new Error('Legacy component storage adoption journal has an invalid identity');
  if (fs.existsSync(componentRoot) && fs.existsSync(transaction.pending) && !fs.existsSync(transaction.previous)) {
    let pendingReceipt=null,pendingValid=false;try{pendingReceipt=await readReceipt(fs,path.join(transaction.pending,'receipts','migrations','legacy-storage-v1.json'));pendingValid=validReceipt(pendingReceipt,descriptor.componentId)&&await verifyReceiptTree({fs,path,crypto,root:transaction.pending,receipt:pendingReceipt,componentId:descriptor.componentId});}catch{/* invalid pending is isolated below */}if(!pendingValid){await fs.promises.rename(transaction.pending,`${transaction.pending}.invalid-${Date.now()}`);await fs.promises.rm(transaction.journal,{force:true});return null;}
    await fs.promises.rename(componentRoot, transaction.previous);
    try {
      await fs.promises.rename(transaction.pending, componentRoot);
      const committed = await readReceipt(fs, path.join(componentRoot, 'receipts', 'migrations', 'legacy-storage-v1.json'));
      if (!await verifyReceiptTree({ fs, path, crypto, root: componentRoot, receipt: committed, componentId: descriptor.componentId })) throw new Error('Recovered component storage package failed verification');
      await fs.promises.rm(transaction.previous, { recursive: true, force: true });
      await fs.promises.rm(transaction.journal, { force: true });
      return committed;
    } catch(error){return restorePreviousAfterFailedCommit({fs,componentRoot,previous:transaction.previous,journal:transaction.journal,error});}
  }
  if (!fs.existsSync(componentRoot) && fs.existsSync(transaction.pending)) {
    const pendingStat = await fs.promises.lstat(transaction.pending);
    let pendingReceipt=null,pendingValid=false;try{pendingReceipt=pendingStat.isDirectory()&&!pendingStat.isSymbolicLink()?await readReceipt(fs,path.join(transaction.pending,'receipts','migrations','legacy-storage-v1.json')):null;pendingValid=validReceipt(pendingReceipt,descriptor.componentId)&&await verifyReceiptTree({fs,path,crypto,root:transaction.pending,receipt:pendingReceipt,componentId:descriptor.componentId});}catch{/* invalid pending is isolated below */}
    if (!pendingValid) {
      const invalid=`${transaction.pending}.invalid-${Date.now()}`;await fs.promises.rename(transaction.pending,invalid);if(fs.existsSync(transaction.previous)){try{await fs.promises.rename(transaction.previous,componentRoot);await fs.promises.rm(transaction.journal,{force:true});}catch(error){throw new AggregateError([error],`Invalid pending storage was retained at ${invalid}`);}}throw new Error(`Pending component storage adoption package is invalid and was retained at ${invalid}`);
    }
    try {
      await fs.promises.rename(transaction.pending, componentRoot);
      const committed = await readReceipt(fs, path.join(componentRoot, 'receipts', 'migrations', 'legacy-storage-v1.json'));
      if (!validReceipt(committed, descriptor.componentId) || !await verifyReceiptTree({ fs, path, crypto, root: componentRoot, receipt: committed, componentId: descriptor.componentId })) throw new Error('Recovered component storage package has no valid committed receipt');
      await fs.promises.rm(transaction.previous, { recursive: true, force: true });
      await fs.promises.rm(transaction.journal, { force: true });
      return committed;
    } catch(error){return restorePreviousAfterFailedCommit({fs,componentRoot,previous:transaction.previous,journal:transaction.journal,error});}
  }
  if (!fs.existsSync(componentRoot) && fs.existsSync(transaction.previous)) {
    await fs.promises.rename(transaction.previous, componentRoot);
    await fs.promises.rm(transaction.journal, { force: true });
    return null;
  }
  throw new Error('Component storage adoption recovery found conflicting retained generations');
};
const adoptLegacyStorageV1 = async ({ fs, path, crypto, dataRoot, componentRoot, descriptor, faultInjector = () => undefined }) => {
  const receiptRelative = path.join('receipts', 'migrations', 'legacy-storage-v1.json');
  const recovered = await recoverLegacyStorageV1({ fs, path, crypto, componentRoot, descriptor });
  if (recovered) return recovered;
  const existing = await readReceipt(fs, path.join(componentRoot, receiptRelative));
  if (validReceipt(existing, descriptor.componentId)) return existing;
  if (existing) throw new Error('Existing component storage adoption receipt is invalid');
  const legacyDataRoot = path.join(dataRoot, descriptor.componentId);
  const legacyDatabasePath = path.join(dataRoot, 'databases', `${descriptor.componentId}.sqlite3`);
  const legacyData = await lstatOptional(fs, legacyDataRoot);
  const legacyDatabase = await lstatOptional(fs, legacyDatabasePath);
  if (!legacyData && !legacyDatabase) return null;
  if ((legacyData && (!legacyData.isDirectory() || legacyData.isSymbolicLink())) || (legacyDatabase && (!legacyDatabase.isFile() || legacyDatabase.isSymbolicLink()))) throw new Error('Legacy component storage source is unsafe');
  const parent = path.dirname(componentRoot);
  const transaction = transactionPaths(path, componentRoot, descriptor.componentId);
  const { pending, previous } = transaction;
  let movedPrevious = false;
  await fs.promises.mkdir(parent, { recursive: true });
  try {
    const copied = { fileCount: 0, byteCount: 0, digests:new Map() };
    if (legacyData) await copyTreeVerified({ fs, path, crypto, source: legacyDataRoot, destination: pending, metrics: copied, exclude: new Set(['receipts/migrations/legacy-storage-v1.json']) });
    else await fs.promises.mkdir(pending, { recursive: true });
    if (legacyDatabase) {
      const destination = path.join(pending, 'storage.sqlite3');
      await copyTreeVerified({ fs, path, crypto, source: legacyDatabasePath, destination, metrics: copied });
      for (const suffix of ['-wal', '-shm']) {
        const source = `${legacyDatabasePath}${suffix}`;
        if (await lstatOptional(fs, source)) await copyTreeVerified({ fs, path, crypto, source, destination: `${destination}${suffix}`, metrics: copied });
      }
    }
    if (fs.existsSync(componentRoot)) await copyTreeVerified({ fs, path, crypto, source: componentRoot, destination: pending, overwrite: true, metrics: copied, exclude: new Set(['receipts/migrations/legacy-storage-v1.json']) });
    const manifest = await buildManifest({ fs, path, crypto, root: pending,knownDigests:copied.digests });
    const receipt = { schemaVersion: 1, kind: 'component-storage-adoption', state: 'committed', componentId: descriptor.componentId, adoptedDataRoot: Boolean(legacyData), adoptedDatabase: Boolean(legacyDatabase), legacyDataRoot: legacyData ? legacyDataRoot : '', legacyDatabasePath: legacyDatabase ? legacyDatabasePath : '', databaseSha256: legacyDatabase ? copied.digests.get(path.resolve(pending,'storage.sqlite3'))?.sha256||'' : '', copiedFileCount: copied.fileCount, copiedByteCount: copied.byteCount, ...manifest, adoptedAt: Date.now() };
    const receiptPath = path.join(pending, receiptRelative);
    await fs.promises.mkdir(path.dirname(receiptPath), { recursive: true });
    const receiptPending = `${receiptPath}.${crypto.randomUUID()}.tmp`;
    const receiptText=`${JSON.stringify(receipt,null,2)}\n`;if(Buffer.byteLength(receiptText)>MAX_RECEIPT_BYTES)throw new Error('Component storage adoption receipt is too large');await fs.promises.writeFile(receiptPending, receiptText, { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(receiptPending, receiptPath);
    await faultInjector('before-journal');
    await writeJournal({ fs, path, crypto, journal: transaction.journal, value: { schemaVersion: 1, kind: 'component-storage-adoption', state: 'prepared', componentId: descriptor.componentId, pending, previous, componentRoot, preparedAt: Date.now() } });
    await faultInjector('after-prepared');
    if (fs.existsSync(componentRoot)) { await fs.promises.rename(componentRoot, previous); movedPrevious = true; }
    await faultInjector('after-previous-rename');
    await fs.promises.rename(pending, componentRoot);
    await faultInjector('after-commit-rename');
    const committed = await readReceipt(fs, path.join(componentRoot, receiptRelative));
    if (!await verifyReceiptTree({ fs, path, crypto, root: componentRoot, receipt: committed, componentId: descriptor.componentId })) throw new Error('Committed component storage adoption failed manifest verification');
    if (movedPrevious) await fs.promises.rm(previous, { recursive: true, force: true });
    await fs.promises.rm(transaction.journal, { force: true });
    return receipt;
  } catch (error) {
    if (error?.code === 'SIMULATED_PROCESS_CRASH') throw error;
    await fs.promises.rm(pending, { recursive: true, force: true }).catch(() => undefined);
    let recoveryError=null;
    if (movedPrevious) {
      try {
        if (fs.existsSync(componentRoot)) await fs.promises.rename(componentRoot, `${componentRoot}.failed-adoption-${Date.now()}`);
        await fs.promises.rename(previous, componentRoot);
      } catch (failure) { recoveryError=failure; }
    }
    if (!recoveryError) await fs.promises.rm(transaction.journal, { force: true }).catch(() => undefined);
    if (recoveryError) throw new AggregateError([error,recoveryError], 'Component storage adoption failed and the previous generation was preserved');
    throw error;
  }
};
module.exports = { adoptLegacyStorageV1, copyTreeVerified, recoverLegacyStorageV1, transactionPaths };
