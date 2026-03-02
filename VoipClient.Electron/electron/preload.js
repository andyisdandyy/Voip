const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── TCP Chat ──────────────────────────────────────────────
  connectChat: (host, port, username, password, isRegister, serverPassword) =>
    ipcRenderer.invoke('tcp:connect', host, port, username, password, isRegister, serverPassword),

  sendChat: (message) =>
    ipcRenderer.send('tcp:send', message),

  disconnectChat: () =>
    ipcRenderer.send('tcp:disconnect'),

  requestDiag: () =>
    ipcRenderer.send('tcp:diag'),

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
    const handler = (_event, senderName, pcm) => callback(senderName, pcm);
    ipcRenderer.on('udp:audio', handler);
    return () => ipcRenderer.removeListener('udp:audio', handler);
  },

  onVoiceConnected: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('udp:connected', handler);
    return () => ipcRenderer.removeListener('udp:connected', handler);
  },

  sendVideo: (buffer, isKeyFrame, codec) =>
    ipcRenderer.send('tcp:send-video', buffer, isKeyFrame, codec),

  onVideoReceived: (callback) => {
    const handler = (_event, senderName, encodedData, isKeyFrame, codec) => callback(senderName, encodedData, isKeyFrame, codec);
    ipcRenderer.on('udp:video', handler);
    return () => ipcRenderer.removeListener('udp:video', handler);
  },

  // ── Screen Source Picker ──────────────────────────────────
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  setShareSource: (sourceId, withAudio) => ipcRenderer.invoke('set-share-source', sourceId, withAudio),

  // ── E2EE ───────────────────────────────────────────────────
  setEncryptionKey: (passphrase) =>
    ipcRenderer.send('e2ee:set-key', passphrase),

  // ── Window Controls ───────────────────────────────────────
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  fullscreenWindow: () => ipcRenderer.send('window:fullscreen'),

  // ── Autoconnect (background mention listener) ─────────────
  startAutoConnect: (serverId, host, port, username, password, serverPassword) =>
    ipcRenderer.send('autoconnect:start', serverId, host, port, username, password, serverPassword),
  stopAutoConnect: (serverId) =>
    ipcRenderer.send('autoconnect:stop', serverId),
  onMention: (callback) => {
    const handler = (_event, serverId, room, sender, text) => callback(serverId, room, sender, text);
    ipcRenderer.on('autoconnect:mention', handler);
    return () => ipcRenderer.removeListener('autoconnect:mention', handler);
  },

  // ── Auto-Updater ──────────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.send('updater:check'),
  installUpdate: () => ipcRenderer.send('updater:install'),
  onUpdateAvailable: (callback) => {
    const handler = (_event, version) => callback(version);
    ipcRenderer.on('updater:available', handler);
    return () => ipcRenderer.removeListener('updater:available', handler);
  },
  onUpdateProgress: (callback) => {
    const handler = (_event, percent) => callback(percent);
    ipcRenderer.on('updater:progress', handler);
    return () => ipcRenderer.removeListener('updater:progress', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event, version) => callback(version);
    ipcRenderer.on('updater:downloaded', handler);
    return () => ipcRenderer.removeListener('updater:downloaded', handler);
  },

  // ── Video Pop-out ──────────────────────────────────────────
  openPopout: (username) => ipcRenderer.invoke('popout:open', username),
  closePopout: (username) => ipcRenderer.send('popout:close', username),
  onPopoutClosed: (callback) => {
    const handler = (_event, username) => callback(username);
    ipcRenderer.on('popout:closed', handler);
    return () => ipcRenderer.removeListener('popout:closed', handler);
  },
});
