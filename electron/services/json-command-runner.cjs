const { classifyPythonJsonMessage, parsePythonJsonMessages } = require('./python-json-protocol.cjs');
const { terminateAndWait } = require('../infrastructure/process-termination.cjs');

const MAX_JSON_MESSAGE_BYTES = 32 * 1024 * 1024;

const createJsonCommandRunner = ({ spawnJob, terminationTimeoutMs = 5000, terminationOptions = {} }) => (
  (run, label, timeoutMs = 20 * 60 * 1000, onMessage, signal, requestedDeadlineAt, supervision = null) => new Promise((resolve, reject) => {
    const timeoutDeadline = timeoutMs === 0 ? Infinity : Date.now() + Math.max(0, timeoutMs);
    const deadlineAt = Number.isFinite(requestedDeadlineAt) ? Math.min(requestedDeadlineAt, timeoutDeadline) : timeoutDeadline;
    if (signal?.aborted) {
      const error = new Error(signal.reason?.message || '任务已取消');
      error.code = typeof signal.reason?.code === 'string' ? signal.reason.code : 'TASK_CANCELLED';
      error.cause = signal.reason;
      reject(error);
      return;
    }
    if (deadlineAt <= Date.now()) {
      const error = new Error(`${label} 处理超时`);
      error.code = 'PROCESS_TIMEOUT';
      reject(error);
      return;
    }
    const child = spawnJob({ ...run, supervision });
    let messageBuffer = '';
    let terminal = null;
    let stderr = '';
    let finished = false;
    let terminating = false;
    let abortListener = null;
    let timer = null;
    const settle = callback => value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (abortListener) signal?.removeEventListener?.('abort', abortListener);
      callback(value);
    };
    const succeed = settle(resolve);
    const fail = settle(reject);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const acceptLine = line => {
      if (Buffer.byteLength(line, 'utf8') > MAX_JSON_MESSAGE_BYTES) {
        const error = new Error(`${label} 返回的单条 JSON 消息超过安全上限`);
        error.code = 'PROCESS_PROTOCOL_MESSAGE_TOO_LARGE';
        terminateThenFail(error);
        return false;
      }
      for (const message of parsePythonJsonMessages(line)) {
        const classified = classifyPythonJsonMessage(message);
        if (classified.kind === 'error' || classified.kind === 'cancelled') terminal = classified;
        else if (classified.kind === 'success' && terminal?.kind !== 'error' && terminal?.kind !== 'cancelled') terminal = classified;
        try { onMessage?.(message); }
        catch (cause) {
          const error = new Error(`${label} 消息回调失败`, { cause });
          error.code = 'PROCESS_MESSAGE_CALLBACK_FAILED';
          terminateThenFail(error);
          return false;
        }
      }
      return true;
    };
    child.stdout.on('data', data => {
      const lines = (messageBuffer + data).split(/\r?\n/);
      messageBuffer = lines.pop() || '';
      if (Buffer.byteLength(messageBuffer, 'utf8') > MAX_JSON_MESSAGE_BYTES) {
        const error = new Error(`${label} 返回的单条 JSON 消息超过安全上限`);
        error.code = 'PROCESS_PROTOCOL_MESSAGE_TOO_LARGE';
        terminateThenFail(error);
        return;
      }
      for (const line of lines) {
        if (!acceptLine(line)) return;
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
    child.on('error', error => { if (!terminating) fail(error); });
    child.on('close', code => {
      if (terminating) return;
      if (messageBuffer.trim() && !acceptLine(messageBuffer)) return;
      if (terminal?.kind === 'error' || terminal?.kind === 'cancelled') {
        const error = new Error(terminal.message || (terminal.kind === 'cancelled' ? `${label} 已取消` : `${label} 返回错误`));
        if (terminal.kind === 'cancelled') error.code = 'TASK_CANCELLED';
        return fail(error);
      }
      if (code !== 0) return fail(new Error(stderr.trim() || `${label} 处理失败（代码 ${code}）`));
      if (terminal?.kind === 'success') return succeed(terminal.value);
      fail(new Error(stderr.trim() || `${label} 未返回有效结果`));
    });
    const terminateThenFail = error => {
      if (finished || terminating) return;
      terminating = true;
      clearTimeout(timer);
      if (abortListener) signal?.removeEventListener?.('abort', abortListener);
      void terminateAndWait(child, Date.now() + terminationTimeoutMs, terminationOptions).then(
        () => fail(error),
        terminationError => fail(terminationError),
      );
    };
    timer = Number.isFinite(deadlineAt) ? setTimeout(() => {
      const error = new Error(`${label} 处理超时`);
      error.code = 'PROCESS_TIMEOUT';
      terminateThenFail(error);
    }, Math.max(0, deadlineAt - Date.now())) : null;
    if (signal) {
      abortListener = () => {
        const error = new Error(signal.reason?.message || '任务已取消');
        error.code = typeof signal.reason?.code === 'string' ? signal.reason.code : 'TASK_CANCELLED';
        error.cause = signal.reason;
        terminateThenFail(error);
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
  })
);

module.exports = { createJsonCommandRunner };
