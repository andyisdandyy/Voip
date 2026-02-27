export {};

interface ElectronAPI {
  connectChat: (host: string, port: number, username: string, password: string, isRegister: boolean, serverPassword?: string) => Promise<{ success: boolean }>;
  sendChat: (message: string) => void;
  disconnectChat: () => void;
  onChatMessage: (callback: (line: string) => void) => () => void;
  onChatError: (callback: (msg: string) => void) => () => void;
  onChatDisconnected: (callback: () => void) => () => void;

  startVoice: (host: string, port: number, username: string) => Promise<{ success: boolean }>;
  sendAudio: (pcmBuffer: ArrayBuffer) => void;
  stopVoice: () => void;
  setBitrate: (bitrate: number) => void;
  onAudioReceived: (callback: (pcm: Uint8Array) => void) => () => void;
  onVoiceConnected: (callback: () => void) => () => void;

  sendVideo: (buffer: ArrayBuffer, isKeyFrame: boolean, codec: string) => void;
  onVideoReceived: (callback: (senderName: string, encodedData: Uint8Array, isKeyFrame: boolean, codec: string) => void) => () => void;

  getScreenSources: () => Promise<Array<{ id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean }>>;
  setShareSource: (sourceId: string, withAudio: boolean) => Promise<boolean>;

  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  getPlatform: () => Promise<string>;
  fullscreenWindow: () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
