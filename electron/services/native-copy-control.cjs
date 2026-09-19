const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Only state transitions touch disk. A pending pause waiter must not prevent a
// later cancellation, nor keep shutdown waiting for the user to click Resume.
const createNativeCopyControl = async (directory, options) => {
  const filePath = path.join(directory, `photoflow-copy-control-${crypto.randomUUID()}`);
  await fs.promises.writeFile(filePath, 'run', { flag: 'wx' });
  let state = 'run';
  let stopped = false;
  let checkingPause = false;
  let pauseTimer;
  let error = null;
  let writes = Promise.resolve();
  const setState = next => {
    if (stopped || state === next || state === 'cancel') return;
    state = next;
    writes = writes.then(() => fs.promises.writeFile(filePath, next)).catch(failure => { error ||= failure; });
  };
  const fail = failure => { error ||= failure; setState('cancel'); };
  const tick = () => {
    if (stopped) return;
    try {
      if (options.isCancelled?.()) { setState('cancel'); return; }
      if (checkingPause || state === 'cancel' || !options.waitIfPaused) return;
      checkingPause = true;
      pauseTimer = setTimeout(() => { if (checkingPause) setState('pause'); }, 20);
      Promise.resolve().then(() => options.waitIfPaused()).then(() => setState('run'), fail).finally(() => {
        clearTimeout(pauseTimer);
        checkingPause = false;
      });
    } catch (failure) { fail(failure); }
  };
  const timer = setInterval(tick, 50);
  timer.unref?.();
  tick();
  return {
    filePath, fail, getError: () => error,
    close: async () => { stopped = true; clearInterval(timer); clearTimeout(pauseTimer); await writes; await fs.promises.rm(filePath, { force: true }); },
  };
};

module.exports = { createNativeCopyControl };
