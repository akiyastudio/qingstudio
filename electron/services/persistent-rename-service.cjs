const { terminateAndWait } = require('../infrastructure/process-termination.cjs');

const createPersistentRenameService = ({ launch, timeoutMs = 120000, idleMs = 60000, protocol = 'photoflow-rename-v1', maxResponseBytes = 4 * 1024 * 1024, terminate = child => terminateAndWait(child, Date.now() + 5000) }) => {
  let session = null;
  let sequence = 0;
  let tail = Promise.resolve();
  let stopped = false;
  const start = async () => {
    if (stopped) throw new Error('文件改名服务已停止');
    if (session?.closing) { await session.closing; return start(); }
    if (session) return session.ready;
    const child = launch();
    const current = { child, buffer: '', pending: null, ready: null, closing: null, idle: null };
    session = current;
    let resolveReady; let rejectReady;
    current.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const fail = error => {
      if (current.closing) return current.closing;
      clearTimeout(current.idle); clearTimeout(current.startup);
      clearTimeout(current.pending?.timer);
      const pending = current.pending;
      current.pending = null;
      current.closing = Promise.resolve().then(() => terminate(child)).catch(terminationError => {
        error.terminationError = terminationError;
        // An unconfirmed process must never be replaced by another worker.
        stopped = true;
      }).then(() => {
        if (session === current) session = null;
        rejectReady(error);
        pending?.reject(Object.assign(error, { outcomeUnknown: true }));
      });
      return current.closing;
    };
    current.fail = fail;
    current.armIdle = () => {
      clearTimeout(current.idle);
      if (idleMs <= 0) return;
      current.idle = setTimeout(() => { if (!current.pending) void fail(new Error('文件改名服务空闲退出')); }, idleMs);
      current.idle.unref?.();
    };
    current.startup = setTimeout(() => void fail(Object.assign(new Error('文件改名服务启动超时'), { code: 'FILE_PUBLICATION_TIMEOUT' })), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdin.on('error', error => void fail(error));
    child.on('error', error => void fail(error));
    child.on('close', () => void fail(Object.assign(new Error('文件改名服务连接中断'), { code: 'FILE_PUBLICATION_DISCONNECTED' })));
    child.stdout.on('data', chunk => {
      if (current.closing) return;
      current.buffer += chunk;
      if (current.buffer.length > maxResponseBytes) { void fail(new Error('文件操作服务响应过大')); return; }
      let newline;
      while ((newline = current.buffer.indexOf('\n')) >= 0) {
        const line = current.buffer.slice(0, newline).replace(/^\uFEFF/, '').trim();
        current.buffer = current.buffer.slice(newline + 1);
        let payload;
        try { payload = JSON.parse(line); } catch { void fail(new Error('文件改名服务响应无效')); return; }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { void fail(new Error('文件改名服务响应无效')); return; }
        if (!current.handshake) {
          if (payload.protocol !== protocol || payload.ready !== true) { void fail(new Error('文件操作服务协议不兼容')); return; }
          current.handshake = true; clearTimeout(current.startup); current.armIdle(); resolveReady(current); continue;
        }
        const pending = current.pending;
        if (pending && payload.type === 'copy-progress') {
          try { pending.onProgress?.(payload); } catch (error) { void fail(error); }
          continue;
        }
        if (!pending || payload.id !== pending.id || typeof payload.result?.success !== 'boolean') { void fail(new Error('文件改名服务响应序号无效')); return; }
        current.pending = null; clearTimeout(pending.timer); current.armIdle();
        if (payload.result.success) pending.resolve(payload.result);
        else pending.reject(Object.assign(new Error(payload.result.error || '文件改名失败'), payload.result));
      }
    });
    return current.ready;
  };
  const request = (values, options = {}) => {
    const result = tail.then(async () => {
      const current = await start();
      if (current.closing || stopped) throw new Error('文件改名服务正在停止');
      clearTimeout(current.idle);
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => void current.fail(Object.assign(new Error('文件操作响应超时，操作结果未知'), { code: 'FILE_PUBLICATION_TIMEOUT' })), options.timeoutMs || timeoutMs);
        current.pending = { id, resolve, reject, timer, onProgress: options.onProgress };
        try { current.child.stdin.write(JSON.stringify({ ...values, id }) + '\n'); }
        catch (error) { void current.fail(error); }
      });
    });
    tail = result.catch(() => undefined);
    return result;
  };
  return { request, move: (source, target) => request({ source, target }), warm: start, stop: async () => { stopped = true; if (session) await session.fail(new Error('文件操作服务已停止')); } };
};

module.exports = { createPersistentRenameService };
