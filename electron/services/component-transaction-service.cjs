const { validateComponentCleanupReceipt } = require('../component-package-archive.cjs');

const SCHEMA_VERSION = 3;
const MAX_TRANSACTION_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_TRANSACTION_STATE_BYTES = 64 * 1024;
const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const OPERATION_ID = /^[a-f0-9-]{36}$/;
const INSTALL_TRANSITIONS = {
  prepared: ['prepared', 'published', 'done'], published: ['published', 'host-committing', 'done'],
  'host-committing': ['host-committing', 'cleanup-pending'], 'cleanup-pending': ['cleanup-pending', 'done'], done: ['done'],
};
const UNINSTALL_TRANSITIONS = {
  prepared: ['prepared', 'quarantined', 'done'], quarantined: ['quarantined', 'cleanup-pending'],
  'cleanup-pending': ['cleanup-pending', 'done'], done: ['done'],
};
const nodeIdentity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
const sameNode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const existing = (fs, target) => fs.promises.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
const escapes = (path, relative) => relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
const syncDirectory = async (fs, directory) => {
  let handle;
  try { handle = await fs.promises.open(directory, 'r'); await handle.sync(); }
  catch (error) {
    // Node on Windows cannot fsync directory handles. File contents are synced.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBADF', 'EINVAL'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
};
const readJson = async (fs, filePath, maxBytes) => {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maxBytes) throw new Error('组件事务文件类型或大小无效');
  const bytes = await fs.promises.readFile(filePath);
  if (bytes.length > maxBytes || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('组件事务文件编码或大小无效');
  return { value: JSON.parse(bytes.toString('utf8')), bytes };
};

// Replace current state without unlinking it first. Temporary-file cleanup is
// best effort and cannot turn a successfully published state into a failure.
const atomicJson = async ({ fs, path, crypto, filePath, value, maxBytes = MAX_TRANSACTION_JOURNAL_BYTES, fault = async () => undefined }) => {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > maxBytes) throw new Error('组件事务文件超过大小上限');
  let handle;
  let published = false;
  try {
    const target = await existing(fs, filePath);
    if (target && (!target.isFile() || target.isSymbolicLink())) throw new Error('组件事务状态目标不是普通文件');
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await fault('json:before-replace', { filePath, value });
    try { await fs.promises.rename(temporary, filePath); }
    catch (error) {
      // The OS may have completed the rename before an error reached its caller.
      const loaded = await readJson(fs, filePath, maxBytes).catch(() => null);
      if (!loaded || !loaded.bytes.equals(bytes)) throw error;
    }
    published = true;
    await syncDirectory(fs, directory);
    await fault('json:after-replace', { filePath, value });
    return bytes;
  } catch (error) { error.published = published; throw error; }
  finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.unlink(temporary).catch(() => undefined);
  }
};

const assertManagedPath = async ({ fs, path, root, target, allowMissing = false, label = '组件路径' }) => {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0')) throw new Error(`${label}无效`);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(target));
  if (!relative || escapes(path, relative) || relative.split(path.sep).some(part => part.includes(':'))) throw new Error(`${label}越过受管根目录`);
  const rootStat = await fs.promises.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('组件安装根目录不是普通目录');
  const canonicalRoot = await fs.promises.realpath(resolvedRoot);
  let current = resolvedRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await existing(fs, current);
    if (!stat) {
      if (allowMissing) break;
      throw Object.assign(new Error(`${label}不存在`), { code: 'ENOENT' });
    }
    if (stat.isSymbolicLink() || escapes(path, path.relative(canonicalRoot, await fs.promises.realpath(current)))) throw new Error(`${label}包含链接或真实路径越界`);
  }
  return { root: resolvedRoot, target: path.resolve(target), rootIdentity: nodeIdentity(rootStat) };
};

const createComponentTransactionService = ({ fs, path, crypto, installRoot, preparationRoot = '', captureTreeIdentity, verifyTreeIdentity, cleanupOwnedPath,
  getComponentEnabled = () => true, setComponentEnabled = () => undefined, clearComponentEnabledState = () => undefined,
  recoverInstallHostState = async () => undefined, cleanupProvider = () => [], onBlocked = () => undefined, onUnblocked = () => undefined,
  onCorrupt = () => undefined, onWarning = () => undefined, now = Date.now, fault = async () => undefined }) => {
  const root = path.resolve(installRoot);
  const preparedRoot = preparationRoot ? path.resolve(preparationRoot) : '';
  const journalRoot = path.join(root, '.transactions');
  const active = new Map();
  const recoveries = new Map();
  let globalRecovery = null;
  let rootIdentity = null;
  const directoryFor = id => path.join(journalRoot, id);
  const journalOf = record => ({ ...record.receipt, ...record.state });
  const attach = (error, record) => { error.record = record; error.transactionRecord = journalOf(record); return error; };
  const checkpoint = async (point, record) => {
    try { await fault(point, journalOf(record)); } catch (error) { throw attach(error, record); }
  };
  const warn = error => { try { onWarning(error); } catch { /* Diagnostics do not affect completed work. */ } };
  const ensureRoots = async () => {
    await fs.promises.mkdir(root, { recursive: true });
    await assertManagedPath({ fs, path, root, target: journalRoot, allowMissing: true });
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const stat = await fs.promises.lstat(root);
    if (rootIdentity && !sameNode(rootIdentity, nodeIdentity(stat))) throw new Error('组件安装根目录身份发生变化');
    rootIdentity ||= nodeIdentity(stat);
  };
  const beginActiveOperation = (id, kind) => {
    if (!COMPONENT_ID.test(id)) throw new Error('组件 ID 无效');
    if (globalRecovery || recoveries.has(id) || active.has(id)) throw Object.assign(new Error('组件事务或恢复正在进行'), { code: 'COMPONENT_LIFECYCLE_BUSY' });
    let settle;
    const operation = { kind, settled: new Promise(resolve => { settle = resolve; }), release: () => { active.delete(id); settle(); } };
    active.set(id, operation);
    return operation;
  };
  const directoryReceipt = (target, identity, treeIdentity) => ({ path: target, kind: 'directory', nodeIdentity: identity, treeIdentity });
  const cleanupNames = receipt => receipt.kind === 'install'
    ? [...receipt.preparationCleanup.map(item => item.name), 'rollback-runtime', 'rollback-staging', ...(receipt.backup ? ['committed-backup'] : [])]
    : ['uninstall-runtime', ...receipt.cleanupStepNames.map(name => `data:${name}`)];
  const validateReceipt = receipt => {
    const keys = ['schemaVersion', 'kind', 'operationId', 'componentId', 'installRoot', 'installRootIdentity', 'container', 'destination', 'source', 'quarantinePath', 'backup', 'previousInstalled', 'previousEnabled', 'desiredEnabled', 'clearUserData', 'preparationCleanup', 'cleanupStepNames'];
    if (!exact(receipt, keys) || receipt.schemaVersion !== SCHEMA_VERSION || !['install', 'uninstall'].includes(receipt.kind) || !COMPONENT_ID.test(receipt.componentId) || !OPERATION_ID.test(receipt.operationId)
      || receipt.installRoot !== root || !sameNode(receipt.installRootIdentity, rootIdentity) || !['previousInstalled', 'previousEnabled', 'desiredEnabled', 'clearUserData'].every(key => typeof receipt[key] === 'boolean')) throw new Error('组件事务收据结构或归属无效');
    const container = path.join(root, receipt.componentId);
    if (receipt.container !== container || receipt.destination !== path.join(container, 'runtime')) throw new Error('组件事务目录结构无效');
    validateComponentCleanupReceipt(receipt.source);
    if (receipt.source.kind !== 'directory') throw new Error('组件事务源不是目录');
    if (!Array.isArray(receipt.preparationCleanup) || !Array.isArray(receipt.cleanupStepNames) || new Set(receipt.cleanupStepNames).size !== receipt.cleanupStepNames.length || receipt.cleanupStepNames.some(name => !/^[a-z][a-z0-9-]{0,79}$/.test(name))) throw new Error('组件清理计划无效');
    if (receipt.kind === 'install') {
      if (receipt.clearUserData || receipt.cleanupStepNames.length || path.dirname(receipt.source.path) !== root || !path.basename(receipt.source.path).startsWith(`.${receipt.componentId}-install-`)
        || receipt.quarantinePath !== path.join(root, `.${receipt.componentId}-quarantine-${receipt.operationId}`)) throw new Error('组件安装路径或清理授权无效');
      if (Boolean(receipt.backup) !== receipt.previousInstalled) throw new Error('组件安装旧版本收据不完整');
      if (receipt.backup) {
        validateComponentCleanupReceipt(receipt.backup);
        if (receipt.backup.kind !== 'directory' || receipt.backup.path !== receipt.quarantinePath) throw new Error('组件备份路径无效');
      }
      if (preparedRoot) {
        if (receipt.preparationCleanup.length !== 2) throw new Error('组件安装准备文件收据不完整');
        const [stage, snapshot] = receipt.preparationCleanup;
        for (const item of [stage, snapshot]) { if (!exact(item, ['name', 'receipt'])) throw new Error('组件安装准备收据无效'); validateComponentCleanupReceipt(item.receipt); }
        const expectedStage = path.join(preparedRoot, `photoflow-component-package-${receipt.componentId}-${receipt.operationId}`);
        if (stage.name !== 'package-stage' || stage.receipt.kind !== 'directory' || stage.receipt.path !== expectedStage || snapshot.name !== 'package-snapshot' || snapshot.receipt.kind !== 'file' || snapshot.receipt.path !== `${expectedStage}.zip`) throw new Error('组件安装准备清理越过授权范围');
      } else if (receipt.preparationCleanup.length) throw new Error('组件安装准备清理缺少授权根目录');
    } else {
      if (receipt.backup !== null || receipt.preparationCleanup.length || receipt.desiredEnabled || receipt.source.path !== (receipt.clearUserData ? container : receipt.destination)
        || receipt.quarantinePath !== path.join(root, `.${receipt.componentId}-uninstall-${receipt.operationId}`)) throw new Error('组件卸载路径或清理授权无效');
      const expectedSteps = cleanupProvider(receipt.componentId, receipt.clearUserData).map(step => step.name);
      if (JSON.stringify(receipt.cleanupStepNames) !== JSON.stringify(expectedSteps)) throw new Error('组件卸载清理计划与用户选择不一致');
    }
    return receipt;
  };
  const validateState = (state, receipt, receiptDigest) => {
    const transitions = receipt.kind === 'install' ? INSTALL_TRANSITIONS : UNINSTALL_TRANSITIONS;
    if (!exact(state, ['schemaVersion', 'componentId', 'operationId', 'receiptDigest', 'revision', 'phase', 'outcome', 'cleanup', 'lastError', 'updatedAt'])
      || state.schemaVersion !== SCHEMA_VERSION || state.componentId !== receipt.componentId || state.operationId !== receipt.operationId || state.receiptDigest !== receiptDigest
      || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Object.hasOwn(transitions, state.phase) || !plain(state.cleanup)
      || Object.entries(state.cleanup).some(([name, status]) => !cleanupNames(receipt).includes(name) || !['executing', 'applied'].includes(status))
      || typeof state.lastError !== 'string' || state.lastError.length > 4000 || !Number.isFinite(state.updatedAt)
      || (state.phase === 'done' ? !['committed', 'rolled-back'].includes(state.outcome) : state.outcome !== null)) throw new Error('组件事务当前状态无效');
    if (receipt.kind === 'install' && ['prepared', 'published', 'host-committing'].includes(state.phase) && state.cleanup['committed-backup']) throw new Error('组件尚未提交，不能清理旧版本');
    if (receipt.kind === 'install' && ['host-committing', 'cleanup-pending'].includes(state.phase) && (state.cleanup['rollback-runtime'] || state.cleanup['rollback-staging'])) throw new Error('组件提交与回滚状态冲突');
    if (receipt.kind === 'uninstall' && state.phase === 'prepared' && Object.keys(state.cleanup).length) throw new Error('组件尚未隔离，不能清理用户数据');
    if (state.phase === 'done') {
      const required = receipt.kind === 'install'
        ? [...receipt.preparationCleanup.map(item => item.name), ...(state.outcome === 'committed' && receipt.backup ? ['committed-backup'] : [])]
        : state.outcome === 'committed' ? cleanupNames(receipt) : [];
      if (required.some(name => state.cleanup[name] !== 'applied') || Object.values(state.cleanup).some(status => status !== 'applied')) throw new Error('组件事务完成状态仍有未完成清理');
    }
    return state;
  };
  const loadRecord = async id => {
    const directory = directoryFor(id);
    await assertManagedPath({ fs, path, root, target: directory });
    const loaded = await readJson(fs, path.join(directory, 'receipt.json'), MAX_TRANSACTION_JOURNAL_BYTES);
    const receipt = validateReceipt(loaded.value);
    if (receipt.componentId !== id) throw new Error('组件事务目录与收据不匹配');
    const receiptDigest = crypto.createHash('sha256').update(loaded.bytes).digest('hex');
    const state = validateState((await readJson(fs, path.join(directory, 'state.json'), MAX_TRANSACTION_STATE_BYTES)).value, receipt, receiptDigest);
    return { receipt, receiptDigest, state };
  };
  const persist = async (record, patch = {}) => {
    const state = validateState({ ...record.state, ...patch, revision: record.state.revision + 1, updatedAt: now() }, record.receipt, record.receiptDigest);
    const transitions = record.receipt.kind === 'install' ? INSTALL_TRANSITIONS : UNINSTALL_TRANSITIONS;
    if (!transitions[record.state.phase].includes(state.phase) || Object.entries(record.state.cleanup).some(([name, status]) => !state.cleanup[name] || status === 'applied' && state.cleanup[name] !== 'applied')
      || state.phase === 'done' && state.outcome === 'rolled-back' && !['prepared', 'published', 'done'].includes(record.state.phase)) throw new Error('组件事务阶段转换无效');
    const next = { ...record, state };
    try {
      await checkpoint(`journal:before:${state.phase}`, record);
      await assertManagedPath({ fs, path, root, target: directoryFor(state.componentId) });
      await atomicJson({ fs, path, crypto, filePath: path.join(directoryFor(state.componentId), 'state.json'), value: state, maxBytes: MAX_TRANSACTION_STATE_BYTES, fault });
      await checkpoint(`journal:after:${state.phase}`, next);
      return next;
    } catch (error) { throw attach(error, error.record || (error.published ? next : record)); }
  };
  const admit = async receipt => {
    validateReceipt(receipt);
    const receiptDigest = crypto.createHash('sha256').update(`${JSON.stringify(receipt)}\n`).digest('hex');
    const state = validateState({ schemaVersion: SCHEMA_VERSION, componentId: receipt.componentId, operationId: receipt.operationId, receiptDigest, revision: 1, phase: 'prepared', outcome: null, cleanup: {}, lastError: '', updatedAt: now() }, receipt, receiptDigest);
    const record = { receipt, receiptDigest, state };
    const directory = directoryFor(receipt.componentId);
    if (await existing(fs, directory)) {
      const previous = await loadRecord(receipt.componentId);
      if (previous.state.phase === 'done') await retire(previous);
      if (await existing(fs, directory)) throw Object.assign(new Error('组件还有未回收的事务，请重试恢复'), { code: 'COMPONENT_TRANSACTION_BLOCKED' });
    }
    const bundle = path.join(journalRoot, `.admit-${receipt.componentId}-${receipt.operationId}`);
    await fs.promises.mkdir(bundle);
    await atomicJson({ fs, path, crypto, filePath: path.join(bundle, 'receipt.json'), value: receipt, fault });
    await atomicJson({ fs, path, crypto, filePath: path.join(bundle, 'state.json'), value: state, maxBytes: MAX_TRANSACTION_STATE_BYTES, fault });
    await fault('journal:before-admission', journalOf(record));
    try { await fs.promises.rename(bundle, directory); }
    catch (error) {
      const loaded = await loadRecord(receipt.componentId).catch(() => null);
      if (!loaded || loaded.receiptDigest !== receiptDigest) throw error;
    }
    try { await syncDirectory(fs, journalRoot); await checkpoint('journal:after:prepared', record); }
    catch (error) { error.admitted = true; throw attach(error, record); }
    return record;
  };
  const purgeMetadata = async directory => {
    await assertManagedPath({ fs, path, root: journalRoot, target: directory });
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !/^(?:receipt\.json|state\.json|\.(?:receipt|state)\.json\.[a-f0-9-]{36}\.tmp)$/.test(entry.name))) throw new Error('事务日志目录含有未知文件，已保留');
    for (const entry of entries) await fs.promises.unlink(path.join(directory, entry.name));
    await fs.promises.rmdir(directory);
  };
  const retire = async record => {
    if (record.state.phase !== 'done') throw new Error('组件事务尚未完成');
    const directory = directoryFor(record.receipt.componentId);
    const retired = path.join(journalRoot, `.retired-${record.receipt.componentId}-${record.receipt.operationId}`);
    const warnings = [];
    try {
      await checkpoint('journal:before-retire', record);
      await assertManagedPath({ fs, path, root, target: directory });
      if (await existing(fs, retired)) throw new Error('已完成事务目录被占用');
      await fs.promises.rename(directory, retired);
      await syncDirectory(fs, journalRoot);
      await checkpoint('journal:after-retire', record);
      await purgeMetadata(retired);
    } catch (error) {
      if (error.simulateCrash) throw attach(error, record);
      warnings.push(error.message || String(error)); warn(error);
    }
    onUnblocked(record.receipt.componentId);
    return warnings;
  };
  const verifyDirectory = async (receipt, target = receipt.path) => {
    await assertManagedPath({ fs, path, root, target });
    const stat = await existing(fs, target);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || !sameNode(nodeIdentity(stat), receipt.nodeIdentity)) throw new Error('组件目录身份发生变化');
    await verifyTreeIdentity(target, receipt.treeIdentity, { includeNode: true });
  };
  const clean = async (record, name, receipt, cleanupRoot = root) => {
    try {
      const progress = record.state.cleanup[name];
      if (progress === 'applied') {
        if (await existing(fs, receipt.path)) throw new Error('已清理的组件路径被其他文件占用');
        return record;
      }
      await cleanupOwnedPath(receipt, {
        root: cleanupRoot, allowMissing: progress === 'executing', allowPartial: progress === 'executing',
        beforeDelete: async () => {
          if (!progress) record = await persist(record, { cleanup: { ...record.state.cleanup, [name]: 'executing' } });
          await checkpoint(`cleanup:before:${name}`, record);
        },
      });
      await checkpoint(`cleanup:after:${name}`, record);
      return await persist(record, { cleanup: { ...record.state.cleanup, [name]: 'applied' } });
    } catch (error) { throw attach(error, error.record || record); }
  };
  const cleanPreparation = async record => {
    for (const item of record.receipt.preparationCleanup) record = await clean(record, item.name, item.receipt, preparedRoot);
    return record;
  };
  const block = async (record, error) => {
    onBlocked(record.receipt.componentId, error);
    try { record = await persist(record, { lastError: String(error.message || error).slice(0, 4000) }); }
    catch (writeError) {
      record = writeError.record || record;
      error = new AggregateError([error, writeError], '组件操作失败，恢复进度写入失败');
      error.outcomeUnknown = true;
    }
    error.code ||= 'COMPONENT_TRANSACTION_BLOCKED';
    error.cleanupPending = true; error.journal = journalOf(record);
    return attach(error, record);
  };
  const complete = async (record, outcome) => {
    record = await persist(record, { phase: 'done', outcome, lastError: '' });
    const cleanupWarnings = await retire(record);
    return { kind: record.receipt.kind, componentId: record.receipt.componentId, operationId: record.receipt.operationId, status: outcome, clearUserData: record.receipt.clearUserData, cleanupSteps: record.receipt.cleanupStepNames, cleanupWarnings };
  };
  const restoreInstall = async record => {
    try {
      record = await cleanPreparation(record);
      const receipt = record.receipt;
      const destination = await existing(fs, receipt.destination);
      const backup = await existing(fs, receipt.quarantinePath);
      const oldRestored = destination && receipt.backup && sameNode(nodeIdentity(destination), receipt.backup.nodeIdentity);
      if (oldRestored && backup) throw new Error('旧组件与备份同时存在，无法安全回滚');
      const published = destination && sameNode(nodeIdentity(destination), receipt.source.nodeIdentity);
      if (destination && !oldRestored && !published) throw new Error('组件目标被未知对象占用，无法回滚');
      if (!published && !await existing(fs, receipt.source.path) && !record.state.cleanup['rollback-runtime'] && !record.state.cleanup['rollback-staging']) throw new Error('组件暂存目录缺失且未记录清理');
      if (!oldRestored && (published || record.state.cleanup['rollback-runtime'])) record = await clean(record, 'rollback-runtime', { ...receipt.source, path: receipt.destination });
      if (backup) {
        if (!receipt.backup) throw new Error('未知对象占用组件备份路径');
        await verifyDirectory(receipt.backup);
        if (await existing(fs, receipt.destination)) throw new Error('旧组件恢复路径被占用');
        await checkpoint('install:before-restore', record);
        await fs.promises.rename(receipt.quarantinePath, receipt.destination);
        await checkpoint('install:after-restore', record);
      }
      const source = await existing(fs, receipt.source.path);
      if (source || record.state.cleanup['rollback-staging']) record = await clean(record, 'rollback-staging', receipt.source);
      else if (!record.state.cleanup['rollback-runtime']) throw new Error('组件暂存目录缺失且未记录清理');
      if (receipt.backup) await verifyDirectory(receipt.backup, receipt.destination);
      else if (await existing(fs, receipt.destination)) throw new Error('首次安装回滚后目标仍被占用');
      if (receipt.previousInstalled) await setComponentEnabled(receipt.componentId, receipt.previousEnabled);
      else await clearComponentEnabledState(receipt.componentId);
      return await complete(record, 'rolled-back');
    } catch (error) { throw attach(error, error.record || record); }
  };
  const finishInstall = async record => {
    try {
      record = await cleanPreparation(record);
      if (record.receipt.backup) record = await clean(record, 'committed-backup', record.receipt.backup);
      await verifyDirectory(record.receipt.source, record.receipt.destination);
      await setComponentEnabled(record.receipt.componentId, record.receipt.desiredEnabled);
      return await complete(record, 'committed');
    } catch (error) { throw attach(error, error.record || record); }
  };
  const install = async ({ operationId = crypto.randomUUID(), componentId, container, destination, stagingPath, stagingIdentity, stagingTreeIdentity, preparationCleanup = [],
    previousEnabled = getComponentEnabled(componentId), desiredEnabled = true, validatePublished, commitHostState, onAdmitted = () => undefined }) => {
    const operation = beginActiveOperation(componentId, 'install');
    let record;
    try {
      await ensureRoots();
      const source = directoryReceipt(stagingPath, stagingIdentity, stagingTreeIdentity);
      await verifyDirectory(source);
      await assertManagedPath({ fs, path, root, target: container });
      await assertManagedPath({ fs, path, root, target: destination, allowMissing: true });
      const old = await existing(fs, destination);
      const quarantinePath = path.join(root, `.${componentId}-quarantine-${operationId}`);
      if (await existing(fs, quarantinePath)) throw new Error('组件备份路径已被占用');
      const backup = old ? directoryReceipt(quarantinePath, nodeIdentity(old), await captureTreeIdentity(destination)) : null;
      record = await admit({ schemaVersion: SCHEMA_VERSION, kind: 'install', operationId, componentId, installRoot: root, installRootIdentity: rootIdentity, container, destination,
        source, quarantinePath, backup, previousInstalled: Boolean(old), previousEnabled, desiredEnabled, clearUserData: false,
        preparationCleanup: preparationCleanup.length ? [{ name: 'package-stage', receipt: preparationCleanup.find(item => item.kind === 'directory') }, { name: 'package-snapshot', receipt: preparationCleanup.find(item => item.kind === 'file') }] : [], cleanupStepNames: [] });
      onAdmitted(operationId);
      record = await cleanPreparation(record);
      if (backup) {
        await verifyDirectory(backup, destination);
        await checkpoint('install:before-backup', record);
        await fs.promises.rename(destination, quarantinePath);
        await checkpoint('install:after-backup', record);
      }
      await checkpoint('install:before-publish', record);
      await fs.promises.rename(stagingPath, destination);
      await checkpoint('install:after-publish', record);
      record = await persist(record, { phase: 'published' });
      await verifyDirectory(source, destination);
      await validatePublished(destination);
      // Persist the forward-only decision before any host-side commit.
      record = await persist(record, { phase: 'host-committing' });
      await commitHostState(destination, desiredEnabled);
      await checkpoint('install:host-committed', record);
      record = await persist(record, { phase: 'cleanup-pending' });
      return await finishInstall(record);
    } catch (error) {
      if (error.admitted) { record = error.record; onAdmitted(operationId); }
      else record = error.record || record;
      if (error.simulateCrash || !record) throw error;
      if (['prepared', 'published'].includes(record.state.phase)) {
        try { await restoreInstall(record); }
        catch (restoreError) {
          if (restoreError.simulateCrash) throw restoreError;
          throw await block(restoreError.record || record, restoreError);
        }
        throw error;
      }
      throw await block(record, error);
    } finally { operation.release(); }
  };
  const quarantineUninstall = async record => {
    try {
      const receipt = record.receipt;
      const source = await existing(fs, receipt.source.path);
      const quarantine = await existing(fs, receipt.quarantinePath);
      if (source && quarantine) throw new Error('卸载源与隔离目录同时存在');
      if (source) {
        if (record.state.phase !== 'prepared') throw new Error('卸载路径被其他对象占用');
        await verifyDirectory(receipt.source);
        await setComponentEnabled(receipt.componentId, false);
        await checkpoint('uninstall:before-quarantine', record);
        await fs.promises.rename(receipt.source.path, receipt.quarantinePath);
        await checkpoint('uninstall:after-quarantine', record);
      } else if (!quarantine && !record.state.cleanup['uninstall-runtime']) throw new Error('卸载源与隔离目录均缺失');
      if (!record.state.cleanup['uninstall-runtime']) await verifyDirectory(receipt.source, receipt.quarantinePath);
      if (record.state.phase === 'prepared') record = await persist(record, { phase: 'quarantined' });
      // Disabled durably before rename. The runtime is no longer discoverable
      // here, so the public enablement setter cannot be called after quarantine.
      return record;
    } catch (error) { throw attach(error, error.record || record); }
  };
  const finishUninstall = async record => {
    try {
      record = await quarantineUninstall(record);
      if (record.state.phase !== 'cleanup-pending') record = await persist(record, { phase: 'cleanup-pending' });
      const handlers = new Map(cleanupProvider(record.receipt.componentId, record.receipt.clearUserData).map(step => [step.name, step.run]));
      for (const name of record.receipt.cleanupStepNames) {
        const key = `data:${name}`;
        if (record.state.cleanup[key] === 'applied') continue;
        const run = handlers.get(name);
        if (typeof run !== 'function') throw new Error(`组件清理步骤不可恢复：${name}`);
        record = await persist(record, { cleanup: { ...record.state.cleanup, [key]: 'executing' } });
        await checkpoint(`uninstall:before:${name}`, record);
        await run(record.receipt.quarantinePath, journalOf(record));
        await checkpoint(`uninstall:after:${name}`, record);
        record = await persist(record, { cleanup: { ...record.state.cleanup, [key]: 'applied' } });
      }
      record = await clean(record, 'uninstall-runtime', { ...record.receipt.source, path: record.receipt.quarantinePath });
      if (await existing(fs, record.receipt.source.path) || await existing(fs, record.receipt.destination)) throw new Error('组件卸载路径被其他对象占用');
      await clearComponentEnabledState(record.receipt.componentId);
      return await complete(record, 'committed');
    } catch (error) { throw attach(error, error.record || record); }
  };
  const uninstall = async ({ componentId, container, destination, targetPath, targetIdentity, targetTreeIdentity, clearUserData, previousEnabled = getComponentEnabled(componentId) }) => {
    const operation = beginActiveOperation(componentId, 'uninstall');
    let record;
    try {
      await ensureRoots();
      const source = directoryReceipt(targetPath, targetIdentity, targetTreeIdentity);
      await verifyDirectory(source);
      const operationId = crypto.randomUUID();
      record = await admit({ schemaVersion: SCHEMA_VERSION, kind: 'uninstall', operationId, componentId, installRoot: root, installRootIdentity: rootIdentity, container, destination, source,
        quarantinePath: path.join(root, `.${componentId}-uninstall-${operationId}`), backup: null, previousInstalled: true, previousEnabled, desiredEnabled: false, clearUserData,
        preparationCleanup: [], cleanupStepNames: cleanupProvider(componentId, clearUserData).map(step => step.name) });
      return await finishUninstall(record);
    } catch (error) {
      record = error.record || record;
      if (error.simulateCrash || !record) throw error;
      if (record.state.phase === 'prepared' && await existing(fs, record.receipt.source.path) && !await existing(fs, record.receipt.quarantinePath)) {
        try {
          await verifyDirectory(record.receipt.source);
          await setComponentEnabled(componentId, previousEnabled);
          await complete(record, 'rolled-back');
        } catch (restoreError) {
          if (restoreError.simulateCrash) throw restoreError;
          throw await block(restoreError.record || record, restoreError);
        }
        throw error;
      }
      throw await block(record, error);
    } finally { operation.release(); }
  };
  const recoverOnce = async (filter = '') => {
    await ensureRoots();
    const results = [];
    for (const entry of await fs.promises.readdir(journalRoot, { withFileTypes: true })) {
      if (/^\.(?:admit|retired)-[a-z0-9][a-z0-9._-]{0,79}-[a-f0-9-]{36}$/.test(entry.name)) {
        // Only the global pass waits for every active admission to finish.
        if (filter) continue;
        try { await purgeMetadata(path.join(journalRoot, entry.name)); } catch (error) { warn(error); }
        continue;
      }
      if (filter && entry.name !== filter) continue;
      let record;
      try {
        if (!COMPONENT_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error('组件事务目录结构无效');
        record = await loadRecord(entry.name);
        if (record.state.phase === 'done') {
          await retire(record); // Never replay business settings from a terminal record.
          continue;
        }
        onBlocked(entry.name, new Error('组件事务正在恢复'));
        if (record.receipt.kind === 'install') {
          if (record.state.phase === 'host-committing') {
            await verifyDirectory(record.receipt.source, record.receipt.destination);
            await recoverInstallHostState(entry.name, record.receipt.destination, record.receipt.desiredEnabled);
            record = await persist(record, { phase: 'cleanup-pending' });
          }
          results.push(await (record.state.phase === 'cleanup-pending' ? finishInstall(record) : restoreInstall(record)));
        } else results.push(await finishUninstall(record));
      } catch (error) {
        if (record && !error.simulateCrash) error = await block(error.record || record, error);
        else if (COMPONENT_ID.test(entry.name)) onBlocked(entry.name, error);
        else onCorrupt(error);
        results.push({ componentId: entry.name, status: 'blocked', error: error.message || String(error) });
      }
    }
    return results;
  };
  const startFilteredRecovery = id => {
    if (!COMPONENT_ID.test(id)) return Promise.reject(new Error('组件 ID 无效'));
    if (active.has(id)) return Promise.reject(Object.assign(new Error('组件操作正在进行，不能并发恢复'), { code: 'COMPONENT_LIFECYCLE_BUSY' }));
    if (recoveries.has(id)) return recoveries.get(id);
    const exposed = recoverOnce(id).finally(() => { if (recoveries.get(id) === exposed) recoveries.delete(id); });
    recoveries.set(id, exposed);
    return exposed;
  };
  const recover = componentId => {
    const id = String(componentId || '');
    if (id) return globalRecovery ? globalRecovery.then(results => {
      const relevant = results.filter(result => result.componentId === id);
      return relevant.length ? relevant : startFilteredRecovery(id);
    }) : startFilteredRecovery(id);
    if (globalRecovery) return globalRecovery;
    const operation = (async () => {
      await Promise.resolve();
      await Promise.allSettled([...recoveries.values()]);
      await Promise.all([...active.values()].map(item => item.settled));
      return recoverOnce();
    })();
    const exposed = operation.finally(() => { if (globalRecovery === exposed) globalRecovery = null; });
    globalRecovery = exposed;
    return exposed;
  };
  const hasPendingJournal = async id => {
    if (!COMPONENT_ID.test(id)) throw new Error('组件 ID 无效');
    await ensureRoots();
    if (!await existing(fs, directoryFor(id))) return false;
    // A terminal record is metadata only, including when antivirus delays deletion.
    const record = await loadRecord(id);
    return record.state.phase !== 'done';
  };
  return { active, journalRoot, hasPendingJournal, install, uninstall, recover };
};

module.exports = { SCHEMA_VERSION, MAX_TRANSACTION_JOURNAL_BYTES, MAX_TRANSACTION_STATE_BYTES, atomicJson, assertManagedPath, createComponentTransactionService, nodeIdentity };
