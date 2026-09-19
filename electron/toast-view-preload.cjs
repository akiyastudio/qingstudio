const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastViewAPI', {
  onSnapshot: callback => {
    if (typeof callback !== 'function') throw new TypeError('Toast view snapshot callback must be a function');
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('toast-view:snapshot', listener);
    ipcRenderer.send('toast-view:ready');
    return () => ipcRenderer.removeListener('toast-view:snapshot', listener);
  },
  sendAction: action => ipcRenderer.send('toast-view:action', action),
  reportLayout: layout => ipcRenderer.send('toast-view:layout', layout),
});
