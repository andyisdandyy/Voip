const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── TCP Chat ──────────────────────────────────────────────
  connectChat: (host, port, username, password, isRegister) =>
    ipcRenderer.invoke('tcp:connect', host, port, username, password, isRegister),

  sendChat: (message) =>
    ipcRenderer.send('tcp:send', message),

  disconnectChat: () =>
    ipcRenderer.send('tcp:disconnect'),

  onChatMessage: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('tcp:message', handler);
    return () => ipcRenderer.removeListener('tcp:message', handler);
  },

  onChatError: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('tcp:error', handler);
    return () => ipcRenderer.removeListener('tcp:error', handler);
  },

  onChatDisconnected: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tcp:disconnected', handler);
    return () => ipcRenderer.removeListener('tcp:disconnected', handler);
  },

  // ── UDP Voice ─────────────────────────────────────────────
  startVoice: (host, port, username) =>
    ipcRenderer.invoke('udp:start', host, port, username),

  sendAudio: (pcmBuffer) =>
    ipcRenderer.send('udp:send-audio', pcmBuffer),

  stopVoice: () =>
    ipcRenderer.send('udp:stop'),

  setBitrate: (bitrate) =>
    ipcRenderer.send('udp:set-bitrate', bitrate),

  onAudioReceived: (callback) => {
    const handler = (_event, pcm) => callback(pcm);
    ipcRenderer.on('udp:audio', handler);
    return () => ipcRenderer.removeListener('udp:audio', handler);
  },

  onVoiceConnected: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('udp:connected', handler);
    return () => ipcRenderer.removeListener('udp:connected', handler);
  },

  sendVideo: (jpegBuffer) =>
    ipcRenderer.send('udp:send-video', jpegBuffer),

  onVideoReceived: (callback) => {
    const handler = (_event, senderName, jpegData) => callback(senderName, jpegData);
    ipcRenderer.on('udp:video', handler);
    return () => ipcRenderer.removeListener('udp:video', handler);
  },

  // ── Window Controls ───────────────────────────────────────
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
});
