const { execFile } = require('child_process');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
const childHasExited = child => !child || child.exitCode != null || child.signalCode != null;
const childStreamsClosed = child => {
  const streams = [child?.stdout, child?.stderr].filter(Boolean);
  return streams.length > 0 && streams.every(stream => stream.closed === true || stream.destroyed === true || stream.readableEnded === true);
};
const waitForChildExit = (child, deadlineAt = Infinity, { requireClose = false } = {}) => {
  let observedExit = false; let observedClose = false;
  const completed = () => (childHasExited(child) || observedExit) && (!requireClose || child.__photoFlowCloseObserved === true || observedClose || childStreamsClosed(child));
  if (completed()) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer = null;
    const finish = () => {
      if (!completed()) return;
      child.removeListener?.('exit', onExit);
      child.removeListener?.('close', onClose);
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    const onExit = () => { observedExit = true; finish(); };
    const onClose = () => { observedExit = true; observedClose = true; finish(); };
    child.once('exit', onExit);
    child.once('close', onClose);
    if (Number.isFinite(deadlineAt)) timer = setTimeout(() => {
      child.removeListener?.('exit', onExit);
      child.removeListener?.('close', onClose);
      resolve(completed());
    }, Math.max(0, deadlineAt - Date.now()));
    // Close the check/listen race: the child can settle between the initial
    // predicate and listener registration.
    if (completed()) finish();
  });
};

const terminateWindowsProcessTree = (pid, deadlineAt, execFileImpl = execFile) => new Promise((resolve, reject) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return reject(Object.assign(new Error('Invalid child PID for process-tree termination'), { code: 'PROCESS_TERMINATION_INVALID_PID' }));
  const timeout = Math.max(1, Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : 2000);
  execFileImpl('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout }, error => error ? reject(error) : resolve());
});

const terminateAndWait = async (child, deadlineAt, { rollbackSettleMs = 25, platform = process.platform, execFileImpl = execFile } = {}) => {
  if (!child) return { exited: true, forced: false };
  if (platform === 'test' && child.killed) return { exited: true, forced: true };
  const terminationDeadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + 2000;
  if (platform === 'win32' && child.__photoFlowJobManaged) {
    if (!child.__photoFlowTreeExitConfirmed) await child.terminateJob(terminationDeadline);
    if (!child.__photoFlowTreeExitConfirmed) {
      child.__photoFlowTreeTerminationUnconfirmed = true;
      const error = new Error('Windows Job termination was not confirmed by ActiveProcesses=0');
      error.code = 'PROCESS_TREE_TERMINATION_UNCONFIRMED'; error.pid = child.pid || null;
      throw error;
    }
    const helperClosed = await waitForChildExit(child, terminationDeadline, { requireClose: true });
    if (!helperClosed) {
      child.__photoFlowTreeTerminationUnconfirmed = true;
      const error = new Error('Windows Job reached ActiveProcesses=0 but its control helper did not close before the deadline');
      error.code = 'PROCESS_HELPER_CLOSE_UNCONFIRMED'; error.pid = child.pid || null;
      throw error;
    }
    child.__photoFlowTreeTerminationUnconfirmed = false;
    if (rollbackSettleMs > 0) await delay(rollbackSettleMs);
    return { exited: true, forced: true, activeProcessCount: 0 };
  }
  // Register before taskkill (or any other asynchronous termination action),
  // so exit+close cannot occur between the action and fence construction.
  const rawWindowsCloseFence = platform === 'win32'
    ? waitForChildExit(child, terminationDeadline, { requireClose: true })
    : null;
  if (platform === 'win32' && child.__photoFlowTreeTerminationUnconfirmed && childHasExited(child)) {
    await rawWindowsCloseFence;
    const error = new Error('组件服务父进程已退出，但无法确认其 Windows 子进程树已终止');
    error.code = 'PROCESS_TREE_TERMINATION_UNCONFIRMED'; error.pid = child.pid || null;
    throw error;
  }
  const closeInput = () => {
    try { child.stdin?.end?.(); } catch { /* stdin may already be closed */ }
    try { child.stdin?.destroy?.(); } catch { /* best effort */ }
  };
  // EOF makes JSON-line workers exit immediately. On Windows, keep the parent
  // alive until taskkill has inspected and terminated its entire process tree.
  if (platform !== 'win32') closeInput();
  let forced = false;
  let treeTerminationError = null;
  if (!childHasExited(child) && platform === 'win32') {
    forced = true;
    try { await terminateWindowsProcessTree(child.pid, terminationDeadline, execFileImpl); child.__photoFlowTreeTerminationUnconfirmed = false; }
    catch (error) { child.__photoFlowTreeTerminationUnconfirmed = true; treeTerminationError = error; }
  } else if (!childHasExited(child)) {
    try { child.kill(); } catch { /* exit may already be in flight */ }
  }
  if (platform === 'win32') closeInput();
  if (treeTerminationError) {
    // The PID/tree operation failed, but signalling the ChildProcess handle is
    // still useful for fencing its streams. This never upgrades the result to
    // tree-confirmed success: descendants may remain unknown.
    try { child.kill?.('SIGKILL'); } catch { /* preserve the original tree failure */ }
    const helperClosed = await rawWindowsCloseFence;
    const error = new Error(helperClosed
      ? 'Windows 组件服务进程树终止失败，且无法确认完整进程树已经清空'
      : 'Windows 组件服务进程树终止失败，且辅助进程未在截止时间前关闭');
    error.code = helperClosed ? 'PROCESS_TREE_TERMINATION_FAILED' : 'PROCESS_TERMINATION_FAILED';
    error.pid = child.pid || null; error.cause = treeTerminationError;
    throw error;
  }
  let exited = platform === 'win32'
    ? await rawWindowsCloseFence
    : childHasExited(child);
  if (!exited && platform !== 'win32') exited = await waitForChildExit(child, Date.now() + Math.min(500, Math.floor(Math.max(0, terminationDeadline - Date.now()) / 2)));
  if (!exited && platform !== 'win32') {
    forced = true;
    let forcedByChild = false;
    try { forcedByChild = child.kill('SIGKILL') !== false; } catch { /* fall through to PID kill */ }
    if (!forcedByChild && child.pid) try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exiting */ }
    exited = await waitForChildExit(child, terminationDeadline);
  }
  if (!exited) {
    const error = new Error('无法确认子进程已退出，数据库可能仍被占用');
    error.code = 'PROCESS_TERMINATION_FAILED';
    error.pid = child.pid || null;
    if (treeTerminationError) error.cause = treeTerminationError;
    throw error;
  }
  if (rollbackSettleMs > 0) await delay(rollbackSettleMs);
  return { exited: true, forced };
};

const stopProcessAndWait = (child, timeoutMs = 2000, options = {}) => terminateAndWait(child, Date.now() + Math.max(0, timeoutMs), options);

module.exports = { stopProcessAndWait, terminateAndWait, terminateWindowsProcessTree };
