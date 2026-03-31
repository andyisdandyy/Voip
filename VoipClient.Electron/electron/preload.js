const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── TCP Chat (multi-server) ────────────────────────────────
  connectChat: (serverId, host, port, username, password, isRegister, serverPassword) =>
    ipcRenderer.invoke('tcp:connect', serverId, host, port, username, password, isRegister, serverPassword),

  sendChat: (serverId, message) =>
    ipcRenderer.send('tcp:send', serverId, message),

  disconnectChat: (serverId) =>
    ipcRenderer.send('tcp:disconnect', serverId),

  requestDiag: (serverId) =>
    ipcRenderer.send('tcp:diag', serverId),

  onChatMessage: (callback) => {
    const handler = (_event, serverId, msg) => callback(serverId, msg);
    ipcRenderer.on('tcp:message', handler);
    return () => ipcRenderer.removeListener('tcp:message', handler);
  },

  onChatError: (callback) => {
    const handler = (_event, serverId, msg) => callback(serverId, msg);
    ipcRenderer.on('tcp:error', handler);
    return () => ipcRenderer.removeListener('tcp:error', handler);
  },

  onChatDisconnected: (callback) => {
    const handler = (_event, serverId) => callback(serverId);
    ipcRenderer.on('tcp:disconnected', handler);
    return () => ipcRenderer.removeListener('tcp:disconnected', handler);
  },

  // ── UDP Voice ─────────────────────────────────────────────
  startVoice: (host, port, username, serverId) =>
    ipcRenderer.invoke('udp:start', host, port, username, serverId),

  sendAudio: (pcmBuffer) =>
    ipcRenderer.send('udp:send-audio', pcmBuffer),

  sendScreenAudio: (pcmBuffer) =>
    ipcRenderer.send('udp:send-screen-audio', pcmBuffer),

  stopVoice: () =>
    ipcRenderer.send('udp:stop'),

  setBitrate: (bitrate) =>
    ipcRenderer.send('udp:set-bitrate', bitrate),

  onAudioReceived: (callback) => {
    const handler = (_event, senderName, pcm) => callback(senderName, pcm);
    ipcRenderer.on('udp:audio', handler);
    return () => ipcRenderer.removeListener('udp:audio', handler);
  },

  onScreenAudioReceived: (callback) => {
    const handler = (_event, senderName, pcm) => callback(senderName, pcm);
    ipcRenderer.on('udp:screen-audio', handler);
    return () => ipcRenderer.removeListener('udp:screen-audio', handler);
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

  // ── Native WASAPI Loopback (process-targeted) ──────────────
  // Audio data is fed directly into the Opus encoder in the main process
  // (no renderer round-trip). The renderer only controls start/stop.
  // Pass the desktopCapturer sourceId so the addon can target a specific
  // process (INCLUDE mode for windows, EXCLUDE-self for screens).
  loopbackSupported: () => ipcRenderer.invoke('loopback:supported'),
  startLoopback: (sourceId) => ipcRenderer.invoke('loopback:start', sourceId),
  stopLoopback: () => ipcRenderer.send('loopback:stop'),

  // ── E2EE ───────────────────────────────────────────────────
  setEncryptionKey: (serverId, passphrase) =>
    ipcRenderer.send('e2ee:set-key', serverId, passphrase),

  // ── Window Controls ───────────────────────────────────────
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  fullscreenWindow: () => ipcRenderer.send('window:fullscreen'),

  // ── Autoconnect (background SSE mention listener) ──────────
  startAutoConnect: (serverId, host, ssePort, token) =>
    ipcRenderer.send('autoconnect:start', serverId, host, ssePort, token),
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

  // ── Native Notifications ─────────────────────────────────────
  showNotification: (title, body) => ipcRenderer.send('notify:show', title, body),

  // ── Direct Messages (inline in renderer) ───────────────────
  sendDm: (serverId, target, text) => ipcRenderer.send('dm:send-inline', serverId, target, text),

  // ── HTTP file upload (to server's file server) ─────────────
  uploadFile: (host, port, token, fileName, mimeType, base64) => ipcRenderer.invoke('file:upload', host, port, token, fileName, mimeType, base64),

  // ── Rendezvous Server HTTP requests ──────────────────────
  rendezvousRequest: (opts) => ipcRenderer.invoke('rendezvous:request', opts),

  // ── Taskbar / dock badge ──────────────────────────────────
  setBadge: (count) => ipcRenderer.send('badge:set', count),
});
