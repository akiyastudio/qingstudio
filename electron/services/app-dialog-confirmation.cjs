const { randomUUID } = require('node:crypto');

// Bind each answer to its window, main frame and unique request.
const requestAppConfirmation = (sender, presentation, { signal, deadlineAt } = {}) => new Promise(resolve => {
  if (!sender || sender.isDestroyed() || signal?.aborted) { resolve(false); return; }
  const requestId = randomUUID();
  let timer;
  let finished = false;
  const finish = accepted => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (!sender.isDestroyed()) { try { sender.send('app-dialog:confirmation-closed', requestId); } catch {} }
    sender.removeListener('ipc-message', onReply);
    sender.removeListener('destroyed', cancel);
    sender.removeListener('did-start-navigation', onNavigation);
    signal?.removeEventListener('abort', cancel);
    resolve(accepted);
  };
  const cancel = () => finish(false);
  const onNavigation = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancel(); };
  const onReply = (event, channel, response) => {
    if (channel !== 'app-dialog:confirmation-response' || event.senderFrame !== sender.mainFrame || response?.requestId !== requestId) return;
    finish(response.accepted === true);
  };
  sender.on('ipc-message', onReply);
  sender.once('destroyed', cancel);
  sender.on('did-start-navigation', onNavigation);
  signal?.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(cancel, Math.max(1, Math.min(300_000, (deadlineAt || Date.now() + 300_000) - Date.now())));
  try { sender.send('app-dialog:confirmation', { requestId, ...presentation }); }
  catch { cancel(); }
});

module.exports = { requestAppConfirmation };
