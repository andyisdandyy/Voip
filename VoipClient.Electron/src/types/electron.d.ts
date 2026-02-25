export {};

interface ElectronAPI {
  connectChat: (host: string, port: number, username: string) => Promise<{ success: boolean }>;
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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
