// Outlive the 30-second screenshot request, including stage creation/dispatch.
const createPlaybackCaptureService = ({ crypto, fs, path, authorizeProjectMedia, clock = Date.now, ttlMs = 35_000 }) => {
  const stages = new Map();
  const ownerMatches = (stage, owner) => stage.sessionId === String(owner.sessionId) && stage.componentId === String(owner.componentId) && stage.processId === Number(owner.processId);
  const discard = stage => { stages.delete(stage.id); void fs.promises.unlink(stage.stagePath).catch(() => undefined); };
  const sweep = () => { const now = clock(); for (const stage of stages.values()) if (stage.phase !== 'committing' && stage.expiresAt <= now) discard(stage); };
  const completePng = async filePath => {
    const handle = await fs.promises.open(filePath, 'r').catch(() => null); if (!handle) return false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 20 || stat.size > 100 * 1024 * 1024) return false;
      const head = Buffer.alloc(8), tail = Buffer.alloc(12);
      const [headRead, tailRead] = await Promise.all([handle.read(head, 0, 8, 0), handle.read(tail, 0, 12, stat.size - 12)]);
      return headRead.bytesRead === 8 && tailRead.bytesRead === 12
        && head.toString('hex') === '89504e470d0a1a0a'
        && tail.toString('hex') === '0000000049454e44ae426082';
    } finally { await handle.close(); }
  };
  const create = async ({ sessionId, componentId, processId, sourcePath }) => {
    sweep();
    const source = path.resolve(await authorizeProjectMedia(sourcePath)); const parsed = path.parse(source); const id = crypto.randomUUID();
    const stagePath = path.join(parsed.dir, `.${parsed.name}.${id}.photoflow-capture-stage.png`);
    const stage = { id, sessionId: String(sessionId), componentId: String(componentId), processId: Number(processId), stagePath, source, expiresAt: clock() + ttlMs, phase: 'created' }; stages.set(id, stage);
    return Object.freeze({ stageId: id, expiresAt: stage.expiresAt });
  };
  const resolve = (stageId, owner) => { sweep(); const stage = stages.get(String(stageId)); if (!stage || stage.phase !== 'created') throw new Error('capture stage expired or revoked'); if (!ownerMatches(stage, owner)) throw new Error('capture stage owner mismatch'); return Object.freeze({ stageId: stage.id, stagePath: stage.stagePath, expiresAt: stage.expiresAt }); };
  const validate = async (stageId, owner) => { sweep(); const stage = stages.get(String(stageId)); if (!stage || stage.phase !== 'created') throw new Error('capture stage expired or revoked'); if (!ownerMatches(stage, owner)) throw new Error('capture stage owner mismatch'); return completePng(stage.stagePath); };
  const commit = async (stageId, owner, { deadlineAt = clock(), probeMs = 40 } = {}) => {
    const stage = stages.get(String(stageId)); if (!stage || stage.phase !== 'created' || !ownerMatches(stage, owner)) throw new Error('capture stage expired, committed, or owner mismatch');
    const deadline = Math.min(stage.expiresAt, Number(deadlineAt));
    let complete = false;
    while (clock() <= deadline) {
      complete = await completePng(stage.stagePath);
      if (complete && clock() <= deadline) break;
      complete = false;
      if (clock() < deadline) await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(probeMs, Math.max(0, deadline - clock()))));
    }
    if (!complete || clock() > deadline) { stages.delete(stage.id); await fs.promises.unlink(stage.stagePath).catch(() => undefined); throw new Error('保存当前视频帧超时：capture stage is not a complete PNG'); }
    stage.phase = 'committing'; const parsed = path.parse(stage.source); const now = new Date(clock()); const pad = (n, l = 2) => String(n).padStart(l, '0'); const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(),3)}`;
    const finalPath = path.join(parsed.dir, `${parsed.name}_截图_${stamp}_${stage.id.slice(0,8)}.png`);
    try { await fs.promises.rename(stage.stagePath, finalPath); }
    catch (error) { stage.phase = 'failed'; stages.delete(stage.id); await fs.promises.unlink(stage.stagePath).catch(() => undefined); throw error; }
    stage.phase = 'committed'; stages.delete(stage.id); return Object.freeze({ path: finalPath });
  };
  const abort = async stageId => { const stage = stages.get(String(stageId)); if (!stage || stage.phase === 'committing') return false; stages.delete(stage.id); await fs.promises.unlink(stage.stagePath).catch(() => undefined); return true; };
  const abortWhere = predicate => Promise.all([...stages.values()].filter(predicate).map(stage => abort(stage.id)));
  return { create, resolve, validate, commit, abort, abortSession: id => abortWhere(stage => stage.sessionId === String(id)), abortProcess: id => abortWhere(stage => stage.processId === Number(id)), abortComponent: id => abortWhere(stage => stage.componentId === String(id)), sweep, get size() { sweep(); return stages.size; } };
};
module.exports = { createPlaybackCaptureService };
