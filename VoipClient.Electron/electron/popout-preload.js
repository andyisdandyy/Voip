const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popoutAPI', {
  getInfo: () => ipcRenderer.invoke('popout:get-info'),
  onVideoFrame: (callback) => {
    const handler = (_event, encodedData, isKeyFrame, codec) => callback(encodedData, isKeyFrame, codec);
    ipcRenderer.on('popout:video-frame', handler);
    return () => ipcRenderer.removeListener('popout:video-frame', handler);
  },
  onClosed: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('popout:feed-ended', handler);
    return () => ipcRenderer.removeListener('popout:feed-ended', handler);
  },
});
