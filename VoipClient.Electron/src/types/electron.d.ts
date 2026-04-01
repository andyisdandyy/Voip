export {};

interface ElectronAPI {
  connectChat: (serverId: string, host: string, port: number, username: string, password: string, isRegister: boolean, serverPassword?: string) => Promise<{ success: boolean }>;
  sendChat: (serverId: string, message: string) => void;
  disconnectChat: (serverId?: string) => void;
  requestDiag: (serverId: string) => void;
  onChatMessage: (callback: (serverId: string, line: string) => void) => () => void;
  onChatError: (callback: (serverId: string, msg: string) => void) => () => void;
  onChatDisconnected: (callback: (serverId: string) => void) => () => void;

  startVoice: (host: string, port: number, username: string, serverId: string) => Promise<{ success: boolean }>;
  sendAudio: (pcmBuffer: ArrayBuffer) => void;
  sendScreenAudio: (pcmBuffer: ArrayBuffer) => void;
  stopVoice: () => void;
  setBitrate: (bitrate: number) => void;
  onAudioReceived: (callback: (senderName: string, pcm: Uint8Array) => void) => () => void;
  onScreenAudioReceived: (callback: (senderName: string, pcm: Uint8Array) => void) => () => void;
  onVoiceConnected: (callback: () => void) => () => void;

  sendVideo: (buffer: ArrayBuffer, isKeyFrame: boolean, codec: string) => void;
  onVideoReceived: (callback: (senderName: string, encodedData: Uint8Array, isKeyFrame: boolean, codec: string) => void) => () => void;

  getScreenSources: () => Promise<Array<{ id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean }>>;
  setShareSource: (sourceId: string, withAudio: boolean) => Promise<boolean>;

  // Native WASAPI loopback (process-targeted)
  loopbackSupported: () => Promise<boolean>;
  startLoopback: (sourceId?: string | null) => Promise<{ success: boolean; sampleRate?: number; channels?: number; error?: string }>;
  stopLoopback: () => void;

  setEncryptionKey: (serverId: string, passphrase: string | null) => void;

  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  getPlatform: () => Promise<string>;
  fullscreenWindow: () => void;

  startAutoConnect: (serverId: string, host: string, ssePort: number, token: string) => void;
  stopAutoConnect: (serverId: string) => void;
  onMention: (callback: (serverId: string, room: string, sender: string, text: string) => void) => () => void;

  // Auto-Updater
  getAppVersion: () => Promise<string>;
  checkForUpdates: () => void;
  installUpdate: () => void;
  onUpdateAvailable: (callback: (version: string) => void) => () => void;
  onUpdateProgress: (callback: (percent: number) => void) => () => void;
  onUpdateDownloaded: (callback: (version: string) => void) => () => void;
  onUpdateNotAvailable: (callback: () => void) => () => void;

  // Video Pop-out
  openPopout: (username: string) => Promise<void>;
  closePopout: (username: string) => void;
  onPopoutClosed: (callback: (username: string) => void) => () => void;

  // Native Notifications
  showNotification: (title: string, body?: string) => void;

  // Direct Messages (inline)
  sendDm: (serverId: string, target: string, text: string) => void;

  // HTTP file upload (to server's file server for video transcoding)
  uploadFile: (host: string, port: number, token: string, fileName: string, mimeType: string, base64: string) => Promise<{ fileId: string; fileName: string; mimeType: string } | null>;

  // Taskbar / dock badge
  setBadge: (count: number) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
