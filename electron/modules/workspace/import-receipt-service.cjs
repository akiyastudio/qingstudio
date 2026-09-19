const IMPORT_STAGING_ROOT_NAME = '_PhotoFlow_Safety_Temp';
const IMPORT_GRAPH_RECEIPT_NAME = '.photoflow-import-graph-receipt.json';
const validImportSessionId = value => /^[a-zA-Z0-9_-]{1,128}$/.test(String(value || ''));
const receiptLocks = new Map();

const createImportReceiptService = ({ crypto, fs, path, pathExists, versionService }) => {
  const hashingCrypto = typeof crypto?.createHash === 'function' ? crypto : require('crypto');
  const committedManifestIds = new Map();
  const clearCommittedSession = sessionId => {
    const prefix = `${String(sessionId || '')}\0`;
    for (const key of committedManifestIds.keys()) if (key.startsWith(prefix)) committedManifestIds.delete(key);
  };
  const importStagingRoots = (root, catalog) => {
    const normalizedRoot = path.resolve(root);
    return [...new Set([normalizedRoot, ...(catalog?.projects || []).map(project => path.resolve(normalizedRoot, project.relative_path))]
      .filter(candidate => candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${path.sep}`))
      .map(candidate => path.join(candidate, IMPORT_STAGING_ROOT_NAME)))];
  };

  const manifestIdentity = manifest => {
    if (validImportSessionId(manifest?.manifestId)) return String(manifest.manifestId);
    const stablePayload = JSON.stringify({
      schemaVersion: manifest?.schemaVersion,
      projectName: String(manifest?.projectName || ''),
      importSessionId: String(manifest?.importSessionId || ''),
      artifacts: Array.isArray(manifest?.artifacts) ? manifest.artifacts.map(item => ({
        relativePath: item?.relativePath, mediaKind: item?.mediaKind, importSlot: item?.importSlot, displayName: item?.displayName,
      })) : [],
    });
    return `m-${hashingCrypto.createHash('sha256').update(stablePayload).digest('hex')}`;
  };

  const manifestContentIdentity = manifest => {
    const stablePayload = JSON.stringify({
      schemaVersion: manifest?.schemaVersion,
      projectName: String(manifest?.projectName || ''),
      importSessionId: String(manifest?.importSessionId || ''),
      artifacts: Array.isArray(manifest?.artifacts) ? manifest.artifacts.map(item => ({
        relativePath: item?.relativePath, mediaKind: item?.mediaKind, importSlot: item?.importSlot, displayName: item?.displayName,
      })) : [],
    });
    return hashingCrypto.createHash('sha256').update(stablePayload).digest('hex');
  };

  const trustedImportManifest = manifest => ({
    schemaVersion: manifest?.schemaVersion,
    projectName: manifest?.projectName,
    importSessionId: manifest?.importSessionId,
    artifacts: Array.isArray(manifest?.artifacts) ? manifest.artifacts.map(item => ({
      relativePath: item?.relativePath,
      mediaKind: item?.mediaKind,
      importSlot: item?.importSlot,
      displayName: item?.displayName,
    })) : [],
  });

  const canonicalImportManifestKey = manifest => JSON.stringify({
    manifestId: manifestIdentity(manifest),
    contentId: manifestContentIdentity(trustedImportManifest(manifest)),
  });

  const inspectImportReceipt = async receiptPath => {
    try {
      const payload = JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
      if (payload?.receiptVersion !== 1 || !validImportSessionId(payload?.importSessionId)
        || !Array.isArray(payload?.manifests) || payload.manifests.length < 1 || payload.manifests.length > 10000
        || payload.manifests.some(manifest => manifest?.schemaVersion !== 2
          || manifest?.importSessionId !== payload.importSessionId || !String(manifest?.projectName || '').trim()
          || !Array.isArray(manifest?.artifacts) || manifest.artifacts.length > 100000)) {
        return { status: 'corrupt', receipt: null };
      }
      const manifests = payload.manifests.map(manifest => ({ ...manifest, manifestId: manifestIdentity(manifest) }));
      const manifestIds = manifests.map(manifest => manifest.manifestId);
      if (new Set(manifestIds).size !== manifestIds.length) return { status: 'corrupt', receipt: null };
      const acknowledgedManifestIds = new Set((Array.isArray(payload.acknowledgedManifestIds) ? payload.acknowledgedManifestIds : []).map(String));
      if ([...acknowledgedManifestIds].some(manifestId => !manifestIds.includes(manifestId))) return { status: 'corrupt', receipt: null };
      const legacyProjects = new Set((Array.isArray(payload.acknowledgedProjects) ? payload.acknowledgedProjects : [])
        .map(value => String(value).toLocaleLowerCase()));
      const projectCounts = manifests.reduce((counts, manifest) => {
        const name = String(manifest.projectName).toLocaleLowerCase();
        counts.set(name, (counts.get(name) || 0) + 1);
        return counts;
      }, new Map());
      const safeLegacyProjects = [...legacyProjects].filter(name => projectCounts.get(name) === 1);
      for (const manifest of manifests) if (safeLegacyProjects.includes(String(manifest.projectName).toLocaleLowerCase())) acknowledgedManifestIds.add(manifest.manifestId);
      return { status: 'ok', receipt: { ...payload, manifests, acknowledgedProjects: safeLegacyProjects, acknowledgedManifestIds: [...acknowledgedManifestIds] } };
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'absent', receipt: null };
      if (error instanceof SyntaxError) return { status: 'corrupt', receipt: null, error };
      return { status: 'io-error', receipt: null, error };
    }
  };
  const readImportReceipt = async receiptPath => {
    const inspected = await inspectImportReceipt(receiptPath);
    if (!inspected.receipt && ['absent', 'corrupt'].includes(inspected.status)) clearCommittedSession(path.basename(path.dirname(receiptPath)));
    return inspected.receipt;
  };

  const receiptLocationsForSession = async (root, catalog, sessionId) => {
    if (!validImportSessionId(sessionId)) return [];
    const results = [];
    for (const stagingRoot of importStagingRoots(root, catalog)) {
      const location = { sessionDir: path.join(stagingRoot, sessionId), receiptPath: path.join(stagingRoot, sessionId, IMPORT_GRAPH_RECEIPT_NAME) };
      if (await pathExists(location.receiptPath)) results.push(location);
    }
    return results;
  };

  const validateImportReceiptManifest = async (location, manifestIdOrProjectName, submittedManifest) => {
    const inspected = await inspectImportReceipt(location.receiptPath);
    if (!inspected.receipt) throw Object.assign(new Error(
      inspected.status === 'corrupt' ? '导入回执已损坏，已拒绝写入数据库并保留暂存文件'
        : inspected.status === 'absent' ? '导入回执不存在，已拒绝写入数据库'
          : inspected.error?.message || '导入回执不可读取，已拒绝写入数据库并保留暂存文件',
    ), { code: `IMPORT_RECEIPT_${String(inspected.status).toUpperCase()}`, recoveryRequired: inspected.status !== 'absent' });
    const receipt = inspected.receipt;
    const selector = String(manifestIdOrProjectName || '');
    const explicit = receipt.manifests.filter(manifest => manifest.manifestId === selector);
    const named = receipt.manifests.filter(manifest => String(manifest.projectName).toLocaleLowerCase() === selector.toLocaleLowerCase());
    if (!explicit.length && named.length > 1) throw Object.assign(new Error(
      '无 manifestId 的旧版导入回执存在同名歧义，已拒绝写入数据库',
    ), { code: 'IMPORT_RECEIPT_MANIFEST_AMBIGUOUS', recoveryRequired: true });
    const candidates = explicit.length ? explicit : named;
    const submittedContentId = manifestContentIdentity(trustedImportManifest(submittedManifest));
    const matching = candidates.filter(manifest => manifestContentIdentity(trustedImportManifest(manifest)) === submittedContentId);
    if (matching.length !== 1) throw Object.assign(new Error(
      candidates.length > 1 ? '导入回执 selector 存在歧义或内容不一致，已拒绝写入数据库'
        : '提交内容与导入回执 manifest 不一致，已拒绝写入数据库并保留暂存文件',
    ), { code: candidates.length > 1 ? 'IMPORT_RECEIPT_MANIFEST_AMBIGUOUS' : 'IMPORT_RECEIPT_MANIFEST_MISMATCH', recoveryRequired: true });
    return matching[0];
  };

  const acknowledgeImportReceipt = (location, manifestIdOrProjectName, committedManifest) => {
    const previous = receiptLocks.get(location.receiptPath) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const receipt = await readImportReceipt(location.receiptPath);
      if (!receipt) throw Object.assign(new Error('导入回执不可读取，已保留暂存文件以便恢复'), { code: 'IMPORT_RECEIPT_UNREADABLE', recoveryRequired: true });
      const selector = String(manifestIdOrProjectName || '');
      const selectorName = selector.toLocaleLowerCase();
      const explicitManifest = receipt.manifests.find(manifest => manifest.manifestId === selector);
      const explicitManifestId = Boolean(explicitManifest);
      const queueName = explicitManifestId ? String(explicitManifest.projectName).toLocaleLowerCase() : selectorName;
      const queueKey = `${receipt.importSessionId}\0${queueName}`;
      const queue = committedManifestIds.get(queueKey) || [];
      const expectedContentId = committedManifest ? manifestContentIdentity(committedManifest) : undefined;
      const queuedCommit = queue.find(item => (!expectedContentId || item.contentId === expectedContentId)
        && (!explicitManifestId || item.manifestId === selector));
      const candidate = explicitManifestId
        ? explicitManifest
        : receipt.manifests.find(manifest => manifest.manifestId === queuedCommit?.manifestId
          && String(manifest.projectName).toLocaleLowerCase() === selectorName);
      if (!queuedCommit || !candidate || queuedCommit.contentId !== manifestContentIdentity(candidate)
        || (expectedContentId && expectedContentId !== manifestContentIdentity(candidate))) {
        throw Object.assign(new Error('已提交内容与导入回执 manifest 不一致，已拒绝确认并保留暂存文件'), {
          code: 'IMPORT_RECEIPT_MANIFEST_MISMATCH', recoveryRequired: true,
        });
      }
      if (queue.includes(queuedCommit)) {
        queue.splice(queue.indexOf(queuedCommit), 1);
        if (!queue.length) committedManifestIds.delete(queueKey);
      }
      const selected = [candidate.manifestId];
      const acknowledgedManifestIds = [...new Set([...(receipt.acknowledgedManifestIds || []), ...selected])];
      const acknowledgedProjects = [...new Set(receipt.manifests.flatMap(manifest => {
        const sameName = receipt.manifests.filter(other => String(other.projectName).toLocaleLowerCase() === String(manifest.projectName).toLocaleLowerCase());
        return sameName.length === 1 && acknowledgedManifestIds.includes(manifest.manifestId) ? [String(manifest.projectName).toLocaleLowerCase()] : [];
      }))];
      const expected = receipt.manifests.map(manifest => manifest.manifestId);
      if (expected.every(value => acknowledgedManifestIds.includes(value))) {
        await fs.promises.rm(location.sessionDir, { recursive: true, force: true });
        return true;
      }
      const temporaryPath = `${location.receiptPath}.tmp-${crypto.randomUUID()}`;
      try {
        await fs.promises.writeFile(temporaryPath, JSON.stringify({ ...receipt, acknowledgedManifestIds, acknowledgedProjects }, null, 2), 'utf8');
        await fs.promises.rename(temporaryPath, location.receiptPath);
      } finally { await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined); }
      return false;
    });
    receiptLocks.set(location.receiptPath, operation);
    return operation.finally(() => { if (receiptLocks.get(location.receiptPath) === operation) receiptLocks.delete(location.receiptPath); });
  };

  const commitImportManifest = async (workspaceRoot, manifest, acknowledgmentCount = 1) => {
    const trustedManifest = trustedImportManifest(manifest);
    const result = await versionService.commitImportGraph(workspaceRoot, trustedManifest);
    const key = `${String(trustedManifest.importSessionId || '')}\0${String(trustedManifest.projectName || '').toLocaleLowerCase()}`;
    const queue = committedManifestIds.get(key) || [];
    const credential = { manifestId: manifestIdentity(manifest), contentId: manifestContentIdentity(trustedManifest) };
    const required = Math.max(1, Number(acknowledgmentCount) || 1);
    const pending = queue.filter(item => item.manifestId === credential.manifestId && item.contentId === credential.contentId).length;
    for (let index = pending; index < required; index += 1) {
      queue.push(credential);
    }
    committedManifestIds.set(key, queue);
    return result;
  };

  return {
    acknowledgeImportReceipt, canonicalImportManifestKey, commitImportManifest, importStagingRoots, inspectImportReceipt,
    readImportReceipt, receiptLocationsForSession, validateImportReceiptManifest,
  };
};

module.exports = { IMPORT_GRAPH_RECEIPT_NAME, IMPORT_STAGING_ROOT_NAME, createImportReceiptService, validImportSessionId };
