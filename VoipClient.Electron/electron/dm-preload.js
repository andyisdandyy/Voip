const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dmAPI', {
  getInfo: () => ipcRenderer.invoke('dm:get-info'),
  sendMessage: (text) => ipcRenderer.send('dm:send-message', text),
  onMessage: (callback) => {
    const handler = (_event, sender, text) => callback(sender, text);
    ipcRenderer.on('dm:message', handler);
    return () => ipcRenderer.removeListener('dm:message', handler);
  },
  minimize: () => ipcRenderer.send('dm:minimize'),
  maximize: () => ipcRenderer.send('dm:maximize'),
  close: () => ipcRenderer.send('dm:close-self'),
});
