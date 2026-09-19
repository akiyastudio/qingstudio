const { AsyncLocalStorage } = require('node:async_hooks');

// Only explicitly registered application renderers receive application IPC.
// Component, toast and external web contents are never implicitly trusted.
const renderers = new Map();
const requestContext = new AsyncLocalStorage();
const registerApplicationRenderer = host => {
  renderers.set(host.webContents.id, host);
  host.webContents.once('destroyed', () => renderers.delete(host.webContents.id));
  return () => renderers.delete(host.webContents.id);
};
const applicationHostFor = sender => sender && renderers.get(sender.id);
const currentApplicationHost = () => requestContext.getStore() || null;
const applicationWindowFor = (sender, BrowserWindow) => applicationHostFor(sender)?.nativeWindow || BrowserWindow.fromWebContents(sender);
const withApplicationHost = (host, operation) => requestContext.run(host, operation);
const sendToApplicationRenderers = (fallbackWindow, channel, ...args) => {
  const targets = renderers.size ? [...renderers.values()].map(host => host.webContents) : [fallbackWindow?.webContents];
  for (const contents of new Set(targets)) if (contents && !contents.isDestroyed?.()) {
    try { contents.send(channel, ...args); } catch { /* A crashed recipient must not fail a committed shared operation. */ }
  }
};
const sendToRequestingRenderer = (fallbackWindow, channel, ...args) => {
  const contents = currentApplicationHost()?.webContents || fallbackWindow?.webContents;
  if (contents && !contents.isDestroyed?.()) contents.send(channel, ...args);
};
const createApplicationDialog = nativeDialog => new Proxy(nativeDialog, {
  get(target, property) {
    const value = target[property];
    if (typeof value !== 'function') return value;
    return (...args) => {
      const owner = currentApplicationHost()?.nativeWindow;
      if (owner && !owner.isDestroyed() && args[0]?.webContents) args[0] = owner;
      return value.apply(target, args);
    };
  },
});

module.exports = { applicationHostFor, applicationWindowFor, currentApplicationHost, withApplicationHost, registerApplicationRenderer, sendToApplicationRenderers, sendToRequestingRenderer, createApplicationDialog };
