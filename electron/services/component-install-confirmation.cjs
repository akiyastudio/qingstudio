const { randomUUID } = require('node:crypto');

// Keep consent attached to the requesting window and this already-inspected
// package snapshot. A stale response must never approve a later installation.
const requestComponentInstallConfirmation = (sender, presentation, { signal, deadlineAt } = {}) => new Promise(resolve => {
  if (!sender || sender.isDestroyed() || signal?.aborted) { resolve(false); return; }
  const requestId = randomUUID();
  let timer;
  const finish = accepted => {
    clearTimeout(timer);
    sender.removeListener('ipc-message', onReply);
    sender.removeListener('destroyed', cancel);
    sender.removeListener('did-start-navigation', onNavigation);
    signal?.removeEventListener('abort', cancel);
    resolve(accepted);
  };
  const cancel = () => finish(false);
  const onNavigation = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancel(); };
  const onReply = (event, channel, response) => {
    if (channel !== 'components-install-confirmation-response' || event.senderFrame !== sender.mainFrame || response?.requestId !== requestId) return;
    finish(response.accepted === true);
  };
  sender.on('ipc-message', onReply);
  sender.once('destroyed', cancel);
  sender.on('did-start-navigation', onNavigation);
  signal?.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(cancel, Math.max(1, Math.min(300_000, (deadlineAt || Date.now() + 300_000) - Date.now())));
  try { sender.send('components-install-confirmation', { requestId, ...presentation }); }
  catch { cancel(); }
});

module.exports = { requestComponentInstallConfirmation };
