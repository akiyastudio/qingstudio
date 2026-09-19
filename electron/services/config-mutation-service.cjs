const path = require('path');
const { defaultComponentDataAdoptionPolicy, authorizesLegacySettingsAdoption } = require('../compatibility/component-data-adoption-policy.cjs');

const normalizeComponentRevision = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const nextComponentRevision = value => {
  const revision = normalizeComponentRevision(value);
  if (revision >= Number.MAX_SAFE_INTEGER) throw new RangeError('Component settings revision is exhausted');
  return revision + 1;
};

const objectValue = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const normalizeLegacySettingsAdoptions = (descriptors, adoptionPolicy = defaultComponentDataAdoptionPolicy) => {
  const declarations = (Array.isArray(descriptors) ? descriptors : []).flatMap(descriptor =>
  (Array.isArray(descriptor?.legacySettingsAdoptions) ? descriptor.legacySettingsAdoptions : []).map(declaration => ({
    componentId: String(descriptor.componentId || ''),
    topLevelKey: String(declaration?.topLevelKey || ''),
  }))
  ).filter(declaration => declaration.componentId && declaration.topLevelKey);
  const claimedKeys = new Set();
  const claimingComponents = new Set();
  for (const declaration of declarations) {
    if (!authorizesLegacySettingsAdoption(declaration.componentId, declaration.topLevelKey, adoptionPolicy)) throw new Error(`Unauthorized legacy settings adoption: ${declaration.topLevelKey}`);
    if (claimingComponents.has(declaration.componentId)) throw new Error(`Component declares more than one legacy settings adoption: ${declaration.componentId}`);
    if (claimedKeys.has(declaration.topLevelKey)) throw new Error(`Legacy settings key is claimed more than once: ${declaration.topLevelKey}`);
    claimingComponents.add(declaration.componentId);
    claimedKeys.add(declaration.topLevelKey);
  }
  return declarations;
};
const adoptLegacyComponentSettings = (config, descriptors, adoptionPolicy = defaultComponentDataAdoptionPolicy) => {
  const source = objectValue(config);
  const settings = objectValue(source.componentSettings);
  const revisions = objectValue(source.componentSettingsRevisions);
  let componentSettings = settings;
  let componentSettingsRevisions = revisions;
  let changed = false;
  for (const declaration of normalizeLegacySettingsAdoptions(descriptors, adoptionPolicy)) {
    if (!Object.prototype.hasOwnProperty.call(source, declaration.topLevelKey)) continue;
    const legacyValue = source[declaration.topLevelKey];
    if (!legacyValue || typeof legacyValue !== 'object' || Array.isArray(legacyValue) || ![Object.prototype, null].includes(Object.getPrototypeOf(legacyValue))) continue;
    // A namespace always wins. A revision without a namespace is an explicit tombstone.
    if (Object.prototype.hasOwnProperty.call(settings, declaration.componentId) || normalizeComponentRevision(revisions[declaration.componentId]) > 0) continue;
    if (!changed) { componentSettings = { ...settings }; componentSettingsRevisions = { ...revisions }; changed = true; }
    componentSettings[declaration.componentId] = structuredClone(legacyValue);
    componentSettingsRevisions[declaration.componentId] = nextComponentRevision(revisions[declaration.componentId]);
  }
  return changed ? { ...source, componentSettings, componentSettingsRevisions } : source;
};
const inspectConfigSnapshot = (fs, filePath) => {
  if (!fs.existsSync(filePath)) return { exists: false, valid: false };
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Config snapshot must contain a JSON object');
    return { exists: true, valid: true, value };
  } catch (error) {
    return { exists: true, valid: false, error };
  }
};
const corruptConfigError = (filePath, primary, recovery) => {
  const error = new Error(`Configuration is corrupt and no valid recovery snapshot is available: ${filePath}`);
  error.code = 'CONFIG_CORRUPT';
  error.primaryError = primary.error;
  error.recoveryError = recovery.error;
  return error;
};
const readConfigFileWithRecovery = (fs, filePath) => {
  const primaryPath = String(filePath);
  const primary = inspectConfigSnapshot(fs, primaryPath);
  if (primary.valid) return primary.value;
  const recovery = inspectConfigSnapshot(fs, `${primaryPath}.recovery`);
  if (recovery.valid) return recovery.value;
  if (!primary.exists && !recovery.exists) return {};
  throw corruptConfigError(primaryPath, primary, recovery);
};
const configSnapshotExists = (fs, filePath) => fs.existsSync(String(filePath)) || fs.existsSync(`${String(filePath)}.recovery`);

const mergeRendererConfigWithOpaqueSettings = (normalizedConfig, current) => {
  const requestedSettings = objectValue(normalizedConfig.componentSettings);
  const currentSettings = objectValue(current.componentSettings);
  const requestedRevisions = objectValue(normalizedConfig.componentSettingsRevisions);
  const currentRevisions = objectValue(current.componentSettingsRevisions);
  const componentSettings = {};
  const componentSettingsRevisions = {};
  const ids = new Set([...Object.keys(currentSettings), ...Object.keys(requestedSettings), ...Object.keys(currentRevisions), ...Object.keys(requestedRevisions)]);
  for (const id of ids) {
    const currentRevision = normalizeComponentRevision(currentRevisions[id]);
    const requestedRevision = normalizeComponentRevision(requestedRevisions[id]);
    const rendererIsCurrent = currentRevision === requestedRevision;
    const sourceSettings = rendererIsCurrent ? requestedSettings : currentSettings;
    if (Object.prototype.hasOwnProperty.call(sourceSettings, id)) componentSettings[id] = sourceSettings[id];
    const revision = rendererIsCurrent ? requestedRevision : currentRevision;
    if (revision > 0) componentSettingsRevisions[id] = revision;
  }
  return { ...normalizedConfig, componentSettings, componentSettingsRevisions };
};

const mergeRestoredConfig = (current, restored, destination, legacySettingsAdoptions = [], adoptionPolicy = defaultComponentDataAdoptionPolicy) => {
  const currentSettings = objectValue(current.componentSettings);
  const restoredSettings = objectValue(restored.componentSettings);
  const currentRevisions = objectValue(current.componentSettingsRevisions);
  const restoredRevisions = objectValue(restored.componentSettingsRevisions);
  const componentSettings = { ...currentSettings };
  const componentSettingsRevisions = {};
  const ids = new Set([...Object.keys(currentSettings), ...Object.keys(restoredSettings), ...Object.keys(currentRevisions), ...Object.keys(restoredRevisions)]);
  for (const id of ids) {
    const restoredOwnsValue = Object.prototype.hasOwnProperty.call(restoredSettings, id);
    const restoredHasTombstone = !restoredOwnsValue && Object.prototype.hasOwnProperty.call(restoredRevisions, id) && normalizeComponentRevision(restoredRevisions[id]) > 0;
    if (restoredOwnsValue) componentSettings[id] = restoredSettings[id];
    else if (restoredHasTombstone) delete componentSettings[id];
    const currentRevision = normalizeComponentRevision(currentRevisions[id]);
    const restoredRevision = normalizeComponentRevision(restoredRevisions[id]);
    const revision = restoredOwnsValue || restoredHasTombstone ? nextComponentRevision(Math.max(currentRevision, restoredRevision)) : Math.max(currentRevision, restoredRevision);
    if (revision > 0) componentSettingsRevisions[id] = revision;
  }
  const requestedWorkspacePath = String(destination || '').trim();
  const workspacePath = requestedWorkspacePath ? path.resolve(requestedWorkspacePath) : '';
  return adoptLegacyComponentSettings({
    ...current,
    ...restored,
    telemetry: current?.telemetry || restored.telemetry,
    workspacePath,
    workspacePaths: workspacePath ? [workspacePath] : [],
    backup: current?.backup || restored.backup,
    componentSettings,
    componentSettingsRevisions,
  }, legacySettingsAdoptions, adoptionPolicy);
};

const createConfigMutationService = ({ fs, crypto, getConfigPath, readSavedConfig, legacySettingsAdoptions = [], legacySettingsAdoptionsProvider = null, adoptionPolicy = defaultComponentDataAdoptionPolicy, faultInjector = () => undefined }) => {
  const currentLegacySettingsAdoptions = () => typeof legacySettingsAdoptionsProvider === 'function' ? legacySettingsAdoptionsProvider() : legacySettingsAdoptions;
  const recoveryPath = () => `${getConfigPath()}.recovery`;
  const recover = async () => {
    const filePath = getConfigPath();
    const recovery = recoveryPath();
    const primarySnapshot = inspectConfigSnapshot(fs, filePath);
    const recoverySnapshot = inspectConfigSnapshot(fs, recovery);
    if (primarySnapshot.valid) {
      if (recoverySnapshot.exists) await fs.promises.rm(recovery, { force: true }).catch(() => undefined);
      return;
    }
    if (recoverySnapshot.valid) {
      if (!primarySnapshot.exists) { await fs.promises.rename(recovery, filePath); return; }
      const corruptPrimary = `${filePath}.${crypto.randomUUID()}.corrupt`;
      await fs.promises.rename(filePath, corruptPrimary);
      try {
        await fs.promises.rename(recovery, filePath);
      } catch (error) {
        if (!fs.existsSync(filePath) && fs.existsSync(corruptPrimary)) await fs.promises.rename(corruptPrimary, filePath).catch(() => undefined);
        throw error;
      }
      await fs.promises.rm(corruptPrimary, { force: true }).catch(() => undefined);
      return;
    }
    if (primarySnapshot.exists || recoverySnapshot.exists) throw corruptConfigError(filePath, primarySnapshot, recoverySnapshot);
  };
  let tail = recover();
  const writeAtomic = async value => {
    const filePath = getConfigPath();
    const recovery = recoveryPath();
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await recover();
    const pending = `${filePath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(pending, JSON.stringify(value, null, 2), 'utf8');
    const handle = await fs.promises.open(pending, 'r+').catch(() => null);
    try { await handle?.sync(); } finally { await handle?.close(); }
    let backedUp = false;
    try {
      await fs.promises.rm(recovery, { force: true }).catch(() => undefined);
      if (fs.existsSync(filePath)) { await fs.promises.rename(filePath, recovery); backedUp = true; }
      await faultInjector('after-backup', { filePath, recovery, pending });
      await fs.promises.rename(pending, filePath);
      await faultInjector('after-commit', { filePath, recovery, pending });
    } catch (error) {
      await fs.promises.rm(pending, { force: true }).catch(() => undefined);
      if (!fs.existsSync(filePath) && backedUp && fs.existsSync(recovery)) await fs.promises.rename(recovery, filePath).catch(() => undefined);
      throw error;
    }
    try { await faultInjector('before-recovery-cleanup', { filePath, recovery, pending }); }
    catch { /* committed data remains authoritative */ }
    await fs.promises.rm(recovery, { force: true }).catch(() => undefined);
  };
  const mutate = mutator => {
    if (typeof mutator !== 'function') throw new TypeError('Config mutator must be a function');
    const operation = tail.catch(() => undefined).then(async () => {
      await recover();
      const current = readSavedConfig() || {};
      const next = await mutator(current);
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('Config mutation must return an object');
      if (next === current) return current;
      await writeAtomic(next);
      return next;
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const read = () => tail.catch(() => undefined).then(async () => { await recover(); return readSavedConfig() || {}; });
  const drain = ({ timeoutMs = 5000 } = {}) => {
    const pending = tail.catch(() => undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const error = new Error('Config mutation drain timed out'); error.code = 'CONFIG_BUSY'; reject(error); }, Math.max(1, Math.min(60000, Number(timeoutMs) || 5000)));
      pending.then(() => { clearTimeout(timer); resolve(); });
    });
  };
  const adoptLegacySettings = () => mutate(current => adoptLegacyComponentSettings(current, currentLegacySettingsAdoptions(), adoptionPolicy));
  return { ready: tail, recover, mutate, read, drain, adoptLegacySettings, hasSnapshot: () => configSnapshotExists(fs, getConfigPath()), mergeRendererConfig: mergeRendererConfigWithOpaqueSettings, mergeRestoredConfig: (current, restored, destination) => mergeRestoredConfig(current, restored, destination, currentLegacySettingsAdoptions(), adoptionPolicy), nextRevision: nextComponentRevision, normalizeRevision: normalizeComponentRevision };
};

const registerConfigDrainBeforeQuit = ({ app, getConfigMutationService, writeLog = () => undefined, beforeDrain = () => undefined, onQuit, onQuitFailed = () => undefined, timeoutMs = 5000 }) => {
  let state = 'idle';
  app.on('before-quit', event => {
    if (state === 'ready') return;
    event.preventDefault();
    if (state === 'draining') return;
    state = 'draining';
    const service = getConfigMutationService?.();
    void (async()=>{await beforeDrain();await (service?.drain({timeoutMs})||Promise.resolve());await onQuit?.();state='ready';app.quit();})().catch(async error=>{
      writeLog('error','Application quit coordination failed',{error:error.message||String(error),code:error.code});
      const forceQuit = await onQuitFailed(error) === true;
      if (forceQuit) { state='ready'; app.exit(0); return; }
      state='idle';
    });
  });
  return () => state;
};

module.exports = { createConfigMutationService, mergeRendererConfigWithOpaqueSettings, mergeRestoredConfig, adoptLegacyComponentSettings, nextComponentRevision, normalizeComponentRevision, readConfigFileWithRecovery, configSnapshotExists, registerConfigDrainBeforeQuit };
