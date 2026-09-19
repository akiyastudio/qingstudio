// Invoke channels are registered once; event channels retain each view's exact
// sender checks. Disposing one tab must not unregister another tab's handler.
const routers = new WeakMap();
const createToastHostIpc = (ipcMain, host) => {
  const senderId = host.webContents.id;
  let routes = routers.get(ipcMain);
  if (!routes) { routes = new Map(); routers.set(ipcMain, routes); }
  return {
    handle(channel, listener) {
      let handlers = routes.get(channel);
      if (!handlers) {
        handlers = new Map(); routes.set(channel, handlers);
        ipcMain.handle(channel, (event, ...args) => {
          const handler = handlers.get(event.sender.id);
          if (!handler || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized toast host sender');
          return handler(event, ...args);
        });
      }
      handlers.set(senderId, listener);
    },
    removeHandler(channel) {
      const handlers = routes.get(channel);
      handlers?.delete(senderId);
      if (handlers?.size === 0) { ipcMain.removeHandler(channel); routes.delete(channel); }
    },
    on: (...args) => ipcMain.on(...args),
    removeListener: (...args) => ipcMain.removeListener(...args),
  };
};
module.exports = { createToastHostIpc };
