const transfer = require('./file-transfer-service.cjs');
const identity = require('./file-identity-service.cjs');
const path = require('path');
const crypto = require('crypto');

let journalWriteSequence = 0;
const JOURNAL_PROTOCOL = 'photoflow-trash-journal-replace-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8a-f][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const readJsonCandidate = async (fs, filePath) => {
  try {
    const value = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return { filePath, value };
  } catch { return null; }
};

const writeMeta = value => value?._journalWrite;
const journalRequestKey = value => crypto.createHash('sha256').update(JSON.stringify({ schemaVersion: value?.schemaVersion, kind: value?.kind, operationId: value?.operationId, targets: value?.targets })).digest('hex');
const journalResultKey = value => value?.state === 'applied' ? crypto.createHash('sha256').update(JSON.stringify(value?.result)).digest('hex') : '';
const validWriteMeta = value => { const meta = writeMeta(value); return meta?.protocol === JOURNAL_PROTOCOL && UUID.test(String(meta.operationId || '')) && meta.requestKey === journalRequestKey(value) && meta.resultKey === journalResultKey(value) && Number.isSafeInteger(meta.generation) && meta.generation > 0 && meta.state === value.state; };
const sameWriteOwner = (left, right) => validWriteMeta(left) && validWriteMeta(right) && left._journalWrite.operationId === right._journalWrite.operationId && left._journalWrite.requestKey === right._journalWrite.requestKey;
const legalSuccessor = (base, candidate) => sameWriteOwner(base, candidate) && candidate._journalWrite.generation === base._journalWrite.generation + 1 && ({ prepared: 'executing', executing: 'applied', applied: null }[base.state] === candidate.state || base.state === candidate.state);

const syncFile = async (fs, filePath) => {
  const handle = await fs.promises.open(filePath, 'r+');
  try { await handle.sync(); } finally { await handle.close().catch(() => undefined); }
};

const syncParentDirectory = async (fs, directory) => {
  const handle = await fs.promises.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close().catch(() => undefined); }
};

const publishJournalNoClobber = (source, target, nativePublicationService) => transfer.publishPathNoClobber(source, target, { nativePublicationService });

const syncPublishedJournal = async (fs, journalPath) => {
  await syncFile(fs, journalPath);
  if (process.platform !== 'win32') await syncParentDirectory(fs, path.dirname(journalPath));
};

const promoteCandidate = async (fs, journalPath, candidate, canonical, nativePublicationService) => {
  if (candidate.filePath === journalPath) return;
  let recoveryBackup = '';
  if (canonical) {
    recoveryBackup = `${journalPath}.backup-recovery-${crypto.randomUUID()}`;
    await publishJournalNoClobber(journalPath, recoveryBackup, nativePublicationService);
  }
  try { await publishJournalNoClobber(candidate.filePath, journalPath, nativePublicationService); }
  catch (error) { if (recoveryBackup && !fs.existsSync(journalPath)) await publishJournalNoClobber(recoveryBackup, journalPath, nativePublicationService).catch(() => undefined); throw error; }
  await syncPublishedJournal(fs, journalPath);
  if (recoveryBackup) await fs.promises.rm(recoveryBackup, { force: true }).catch(() => undefined);
};

const recoverJournalFile = async (fs, journalPath, nativePublicationService) => {
  const directory = path.dirname(journalPath); const basename = path.basename(journalPath);
  const names = await fs.promises.readdir(directory).catch(() => []);
  const temporaryNames = names.filter(name => name.startsWith(`${basename}.tmp-`));
  const backupNames = names.filter(name => name.startsWith(`${basename}.backup-`));
  const temporaryCandidates = (await Promise.all(temporaryNames.map(name => readJsonCandidate(fs, path.join(directory, name))))).filter(Boolean);
  const backupCandidates = (await Promise.all(backupNames.map(name => readJsonCandidate(fs, path.join(directory, name))))).filter(Boolean);
  const canonical = await readJsonCandidate(fs, journalPath);
  let base = canonical;
  if (!base) base = backupCandidates.filter(candidate => validWriteMeta(candidate.value)).sort((left, right) => right.value._journalWrite.generation - left.value._journalWrite.generation)[0] || (backupCandidates.length === 1 ? backupCandidates[0] : null);
  let winner = canonical;
  if (base) winner = temporaryCandidates.filter(candidate => legalSuccessor(base.value, candidate.value)).sort((left, right) => right.value._journalWrite.generation - left.value._journalWrite.generation)[0] || base;
  else winner = temporaryCandidates.filter(candidate => validWriteMeta(candidate.value) && candidate.value._journalWrite.generation === 1).sort((left, right) => right.value._journalWrite.generation - left.value._journalWrite.generation)[0] || null;
  if (winner) await promoteCandidate(fs, journalPath, winner, canonical, nativePublicationService);
  return winner?.value || null;
};

const writeJournal = async (fs, journalPath, value, faultInjector = () => undefined, nativePublicationService = null) => {
  await fs.promises.mkdir(path.dirname(journalPath), { recursive: true });
  const previous = await recoverJournalFile(fs, journalPath, nativePublicationService);
  if (!UUID.test(String(value.operationId || ''))) throw new Error('file_operation_trash_journal_operation_invalid');
  const previousMeta = validWriteMeta(previous) && previous.operationId === value.operationId ? previous._journalWrite : null;
  value._journalWrite = { protocol: JOURNAL_PROTOCOL, operationId: value.operationId, requestKey: journalRequestKey(value), resultKey: journalResultKey(value), generation: Number(previousMeta?.generation || 0) + 1, state: value.state };
  const writeId = `${process.pid}-${Date.now()}-${journalWriteSequence += 1}`;
  const temporary = `${journalPath}.tmp-${writeId}`;
  const backup = `${journalPath}.backup-${writeId}`; let backedUp = false; let preserveRecovery = false;
  const temporaryHandle = await fs.promises.open(temporary, 'wx');
  try { await temporaryHandle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await temporaryHandle.sync(); }
  finally { await temporaryHandle.close().catch(() => undefined); }
  try {
    await faultInjector('after-temp-before-backup', { journalPath, temporary });
    if (fs.existsSync(journalPath)) { await publishJournalNoClobber(journalPath, backup, nativePublicationService); backedUp = true; if (process.platform !== 'win32') await syncParentDirectory(fs, path.dirname(journalPath)); }
    await faultInjector('after-backup-before-replace', { journalPath, temporary, backup });
    await publishJournalNoClobber(temporary, journalPath, nativePublicationService);
    await syncPublishedJournal(fs, journalPath);
    await faultInjector('after-replace-before-cleanup', { journalPath, backup });
    if (backedUp) { await fs.promises.rm(backup, { force: true }); if (process.platform !== 'win32') await syncParentDirectory(fs, path.dirname(journalPath)); }
  }
  catch (error) { preserveRecovery = error?.simulateCrash === true || error?.code === transfer.PUBLISH_PARTIAL_CODE || error?.code === 'FILE_PUBLICATION_SERVICE_MISSING' || error?.outcomeUnknown === true || error?.recoveryRequired === true; if (preserveRecovery) { error.recoveryRequired = true; error.recoveryPath ||= fs.existsSync(temporary) ? temporary : fs.existsSync(backup) ? backup : undefined; } if (!preserveRecovery && backedUp && !fs.existsSync(journalPath)) await publishJournalNoClobber(backup, journalPath, nativePublicationService).catch(() => undefined); throw error; }
  finally { if (!preserveRecovery) { await fs.promises.rm(temporary, { force: true }).catch(() => undefined); await fs.promises.rm(backup, { force: true }).catch(() => undefined); } }
};

const createFileSystemService = ({ recycleBinService, fs = require('fs'), journalFaultInjector = () => undefined, nativePublicationService = null, shortcutAdapter = null }) => ({
  ...transfer,
  ...identity,
  copy: (source, destination, options) => transfer.copyFileAtomic(source, destination, options),
  move: (source, destination, options) => transfer.movePathAtomic(source, destination, options),
  createDirectory: targetPath => fs.promises.mkdir(targetPath),
  ensureDirectory: targetPath => fs.promises.mkdir(targetPath, { recursive: true }),
  createWindowsShortcut: (shortcutPath, details) => {
    if (shortcutAdapter?.platform !== 'win32') throw new Error('文件夹快捷方式目前仅支持 Windows');
    return shortcutAdapter.writeShortcutLink(shortcutPath, details);
  },
  rollbackCreated: async targetPaths => {
    for (const targetPath of [...targetPaths].reverse()) await fs.promises.rm(targetPath, { force: true }).catch(() => undefined);
  },
  removeEmptyDirectory: targetPath => fs.promises.rmdir(targetPath),
  removeCreated: (targetPath, options = {}) => fs.promises.rm(targetPath, { recursive: options.directory === true, force: false }),
  trash: targetPath => recycleBinService.trash(targetPath),
  trashMany: targetPaths => recycleBinService.trashMany(targetPaths),
  trashManyJournaled: async ({ targetPaths, journalPath }) => {
    const canonicalExisted = fs.existsSync(journalPath); const journalBasename = path.basename(journalPath); const recoveryArtifacts = (await fs.promises.readdir(path.dirname(journalPath)).catch(() => [])).filter(name => name.startsWith(`${journalBasename}.tmp-`) || name.startsWith(`${journalBasename}.backup-`) || name.startsWith(`${journalBasename}.recovery-`));
    let journal = await recoverJournalFile(fs, journalPath, nativePublicationService);
    if (!journal && (canonicalExisted || recoveryArtifacts.length)) throw new Error('file_operation_trash_journal_corrupt_or_ambiguous');
    const normalizedTargets = targetPaths.map(target => path.resolve(target));
    const targetKeys = normalizedTargets.map(identity.physicalPathKey);
    if (new Set(targetKeys).size !== targetPaths.length) throw new Error('file_operation_trash_request_not_unique');
    const validResultItem = item => {
      if (!item || typeof item !== 'object' || typeof item.success !== 'boolean') return false;
      if (item.success) return typeof item.recyclePidl === 'string' && typeof item.preciseRestore === 'boolean' && (item.permanent === undefined || typeof item.permanent === 'boolean');
      return true;
    };
    const validResult = result => result && typeof result === 'object' && typeof result.success === 'boolean' && Array.isArray(result.items) && result.items.length === normalizedTargets.length && result.items.every(validResultItem);
    const sameJournalTargets = journal && Array.isArray(journal.targets) && journal.targets.length === targetKeys.length && journal.targets.every((target, index) => identity.physicalPathKey(target) === targetKeys[index]);
    if (journal && (journal.schemaVersion !== 1 || journal.kind !== 'file-operations-trash-v1' || !['prepared', 'executing', 'applied'].includes(journal.state) || !sameJournalTargets)) throw new Error('file_operation_trash_journal_conflict');
    if (journal?.state === 'applied' && !journal.operationId && !journal._journalWrite) {
      const allowed = new Set(['schemaVersion', 'kind', 'state', 'targets', 'createdAt', 'executingAt', 'appliedAt', 'result']); const directory = path.dirname(journalPath); const basename = path.basename(journalPath); const siblings = await fs.promises.readdir(directory).catch(() => []);
      if (Object.keys(journal).some(key => !allowed.has(key)) || siblings.some(name => name.startsWith(`${basename}.tmp-`) || name.startsWith(`${basename}.backup-`) || name.startsWith(`${basename}.recovery-`)) || !validResult(journal.result)) throw new Error('file_operation_trash_legacy_applied_ambiguous');
      const unknown = { success: false, outcomeUnknown: true, code: 'TRASH_OUTCOME_UNKNOWN', manualRecovery: true, undoAvailable: false, items: [] };
      if (normalizedTargets.some(target => fs.existsSync(target)) || journal.result.success !== true || journal.result.items.some((item, index) => item.success !== true || identity.physicalPathKey(String(item.originalPath || '')) !== targetKeys[index] || (item.preciseRestore === true ? !item.recyclePidl || item.permanent === true : Boolean(item.recyclePidl)))) return unknown;
      for (const item of journal.result.items) if (item.preciseRestore === true) {
        if (!item.recyclePidl) return unknown;
        const probed = await recycleBinService.probe(item.recyclePidl).catch(() => null);
        if (!probed || probed.success !== true || probed.exists !== true || probed.pidl !== undefined && String(probed.pidl) !== item.recyclePidl) return unknown;
      }
      journal.result.undoAvailable = journal.result.items.every(item => item.preciseRestore === true && item.permanent !== true && Boolean(item.recyclePidl)); journal.operationId = crypto.randomUUID(); await writeJournal(fs, journalPath, journal, journalFaultInjector, nativePublicationService); return journal.result;
    }
    if (journal && (!UUID.test(String(journal.operationId || '')) || Boolean(journal._journalWrite) !== validWriteMeta(journal))) throw new Error('file_operation_trash_journal_protocol_invalid');
    if (journal?.state === 'applied') { if (!validWriteMeta(journal) || journal._journalWrite.operationId !== journal.operationId || !validResult(journal.result)) throw new Error('file_operation_trash_journal_applied_invalid'); return journal.result; }
    if (!journal) { journal = { schemaVersion: 1, kind: 'file-operations-trash-v1', operationId: crypto.randomUUID(), state: 'prepared', targets: normalizedTargets, createdAt: Date.now() }; await writeJournal(fs, journalPath, journal, journalFaultInjector, nativePublicationService); }
    if (journal.state === 'executing') return { success: false, outcomeUnknown: true, code: 'TRASH_OUTCOME_UNKNOWN', items: [] };
    journal.state = 'executing'; journal.executingAt = Date.now(); await writeJournal(fs, journalPath, journal, journalFaultInjector, nativePublicationService);
    const result = await recycleBinService.trashMany(normalizedTargets);
    journal.state = 'applied'; journal.appliedAt = Date.now(); journal.result = result;
    await writeJournal(fs, journalPath, journal, journalFaultInjector, nativePublicationService);
    return result;
  },
  restore: item => recycleBinService.restore(item),
  probeRecycleItem: item => recycleBinService.probe(item),
});

module.exports = { createFileSystemService };
