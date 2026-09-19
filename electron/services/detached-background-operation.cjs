const safeError = error => error?.message || String(error || 'unknown error');

const startDetachedBackgroundOperation = ({
  operationId,
  worker,
  onUnexpectedError = () => undefined,
  writeLog = () => undefined,
  autoRestart = false,
  restartDelayMs = 0,
}) => {
  let stopped = false;
  let timer = null;
  let execution = null;

  const log = (message, error) => {
    try { writeLog('error', message, { operationId, error: safeError(error) }); } catch (_) { /* logging is best effort */ }
  };
  const handleFailure = async error => {
    try { await onUnexpectedError(error); }
    catch (handlerError) { log('Detached background operation error handler failed', handlerError); }
    if (!stopped && autoRestart) {
      timer = setTimeout(() => {
        timer = null;
        startWorker();
      }, Math.max(0, Number(restartDelayMs) || 0));
      timer.unref?.();
    }
  };
  const startWorker = () => {
    execution = Promise.resolve().then(worker);
    // Both the worker and its async error handler terminate in an owned sink.
    void execution.catch(error => handleFailure(error)).catch(error => log('Detached background operation failure sink failed', error));
    return execution;
  };
  startWorker();
  const response = {
    success: true,
    started: true,
    operationId,
  };
  Object.defineProperties(response, {
    stop: { enumerable: false, value: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      return true;
    } },
    completion: { enumerable: false, get: () => execution },
  });
  return response;
};

module.exports = { startDetachedBackgroundOperation };
