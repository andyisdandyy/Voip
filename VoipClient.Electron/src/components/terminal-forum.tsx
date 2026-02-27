import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Terminal, Hash, User, Circle, Mic, MicOff, Headphones,
  Volume2, VolumeX, LogIn, PhoneOff, Lock, Settings, X, Bell, Monitor,
  Trash2, UserPlus, Video, VideoOff, Share2, Minus, Square, Maximize, Minimize2,
  Plus, LogOut, Command, Wifi, WifiOff,
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────

interface VoiceRoom { name: string; hasPassword: boolean; bitrate: number }
interface TextRoom  { name: string; hasPassword: boolean }
interface UserInfo  { name: string; voiceRoom: string | null; online: boolean; roles: string[]; roleColor: string | null }
interface ChatMsg   { id: string; text: string; msgId: string; sender: string }
interface UserContextMenu { userId: string; x: number; y: number }
interface MsgContextMenu { msgId: string; sender: string; room: string; x: number; y: number }
interface UserSetting { name: string; volume: number; isMuted: boolean }
interface PinnedServer { id: string; name: string; address: string; username?: string; password?: string; serverPassword?: string; autoConnect?: boolean }
interface ServerInfo { serverName: string; voiceHost: string; udpPort: number; maxCameraWidth: number; maxCameraHeight: number; maxScreenWidth: number; maxScreenHeight: number; maxFps: number; maxScreenBitrate: number }
interface ServerContextMenu { serverId: string; x: number; y: number }
interface RoleInfo { name: string; color: string; priority: number; permissions: string[] }
interface KeyBind { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

const VIDEO_RESOLUTIONS = {
  '720p':  { label: '720p',  width: 1280, height: 720 },
  '1080p': { label: '1080p', width: 1920, height: 1080 },
  '1440p': { label: '1440p (Ultrawide)', width: 2560, height: 1440 },
  '4k':    { label: '4K',    width: 3840, height: 2160 },
} as const;
type VideoResolution = keyof typeof VIDEO_RESOLUTIONS;

const VIDEO_FPS_OPTIONS = [15, 30, 60] as const;
type VideoFps = typeof VIDEO_FPS_OPTIONS[number];

function getVideoBitrate(width: number, height: number, fps: number): number {
  const pixels = width * height;
  const base = pixels <= 921600 ? 3_000_000 : pixels <= 2073600 ? 6_000_000 : pixels <= 3686400 ? 10_000_000 : 20_000_000;
  return Math.round(base * (fps / 30));
}

type ThemeColor = 'green' | 'blue' | 'red' | 'purple';

function parseAddress(addr: string): { host: string; port: number } {
  const trimmed = addr.trim();
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx > 0) {
    const portStr = trimmed.substring(colonIdx + 1);
    const port = parseInt(portStr);
    if (!isNaN(port) && port > 0 && port <= 65535 && /^\d+$/.test(portStr)) {
      return { host: trimmed.substring(0, colonIdx), port };
    }
  }
  return { host: trimmed, port: 5001 };
}

const SERVER_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'] as const;

// ── Component ───────────────────────────────────────────────

export function TerminalForum() {
  // Connection
  const [isConnected, setIsConnected] = useState(false);
  const [nickname, setNickname]       = useState('');
  const [serverIp, setServerIp]       = useState('86.52.25.44');
  const [tcpPort, setTcpPort]         = useState('5001');
  const [status, setStatus]           = useState('Awaiting connection');
  const [connecting, setConnecting]   = useState(false);
  const [serverInfo, setServerInfo]   = useState<ServerInfo | null>(null);
  const [connectedServerId, setConnectedServerId] = useState<string | null>(null);

  // Rooms (from server)
  const [voiceRooms, setVoiceRooms]       = useState<VoiceRoom[]>([]);
  const [textRooms, setTextRooms]         = useState<TextRoom[]>([]);
  const [joinedTextRooms, setJoinedText]  = useState(new Set<string>());
  const [currentTextRoom, setCurrentText] = useState<string | null>(null);
  const [currentVoiceRoom, setCurrentVoice] = useState<string | null>(null);

  // Messages per room
  const [roomMessages, setRoomMessages] = useState<Record<string, ChatMsg[]>>({});

  // Users
  const [onlineUsers, setOnlineUsers] = useState<UserInfo[]>([]);
  const [serverRoles, setServerRoles] = useState<RoleInfo[]>([]);

  // Voice controls
  const [isMuted, setIsMuted]       = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [viewMode, setViewMode] = useState<'voice' | 'text'>('text');
  const [isCallFullscreen, setIsCallFullscreen] = useState(false);

  // Input
  const [input, setInput] = useState('');

  // Password dialog
  const [pwDialog, setPwDialog] = useState<{ room: string; type: 'voice' | 'text' } | null>(null);
  const [pwInput, setPwInput]   = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [msgContextMenu, setMsgContextMenu] = useState<MsgContextMenu | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [selectedVideoFeed, setSelectedVideoFeed] = useState<string | null>(null);
  const [activeVideos, setActiveVideos] = useState<Set<string>>(new Set());
  const [cameraUsers, setCameraUsers] = useState<Set<string>>(new Set());
  const [screenUsers, setScreenUsers] = useState<Set<string>>(new Set());
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideoInput, setSelectedVideoInput] = useState('');
  const [videoResolution, setVideoResolution] = useState<VideoResolution>('1080p');
  const [videoFps, setVideoFps] = useState<VideoFps>(30);
  const [screenShareDialog, setScreenShareDialog] = useState(false);
  const [screenShareAudio, setScreenShareAudio] = useState(false);
  const [screenShareResolution, setScreenShareResolution] = useState<VideoResolution>('1080p');
  const [screenShareFps, setScreenShareFps] = useState<VideoFps>(30);
  const [screenShareBitrate, setScreenShareBitrate] = useState(10000);
  const [serverPasswordDialog, setServerPasswordDialog] = useState<{ address: string; username: string; password: string; isRegister: boolean; serverId?: string } | null>(null);
  const [serverPasswordInput, setServerPasswordInput] = useState('');
  const [screenSources, setScreenSources] = useState<Array<{id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean}>>([]);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<'screen' | 'window'>('screen');
  const [theme, setTheme] = useState<ThemeColor>(() => {
    try { return (localStorage.getItem('meichat-theme') as ThemeColor) || 'green'; }
    catch { return 'green'; }
  });
  const [pinnedServers, setPinnedServers] = useState<PinnedServer[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('meichat-pinned-servers') || '[]');
      return raw.map((s: any) => ({
        id: s.id, name: s.name,
        address: s.address || `${s.host || '127.0.0.1'}:${s.port || s.tcpPort || '5001'}`,
        username: s.username, password: s.password, serverPassword: s.serverPassword,
      }));
    } catch { return []; }
  });
  const [loginDialog, setLoginDialog] = useState<string | null>(null);
  const [serverContextMenu, setServerContextMenu] = useState<ServerContextMenu | null>(null);
  const [addServerDialog, setAddServerDialog] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerAddress, setNewServerAddress] = useState('');
  const [platform, setPlatform] = useState<string>('win32');
  const [keybinds, setKeybinds] = useState<Record<string, KeyBind | null>>(() => {
    try { return JSON.parse(localStorage.getItem('meichat-keybinds') || '{}'); }
    catch { return {}; }
  });
  const [recordingKeybind, setRecordingKeybind] = useState<string | null>(null);
  const [serverMentions, setServerMentions] = useState<Record<string, number>>({});

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLInputElement>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const captureRef     = useRef<AudioWorkletNode | null>(null);
  const playbackRef    = useRef<AudioWorkletNode | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const isMutedRef     = useRef(false);
  const isDeafenedRef  = useRef(false);
  const nicknameRef    = useRef('');
  const selectedInputRef  = useRef('');
  const selectedOutputRef = useRef('');
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micLevelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const captureVideoElRef = useRef<HTMLVideoElement | null>(null);
  const videoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeVideosRef = useRef<Set<string>>(new Set());
  const videoTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const selectedVideoInputRef = useRef('');
  const videoResolutionRef = useRef<VideoResolution>('1080p');
  const videoFpsRef = useRef<VideoFps>(30);
  const viewModeRef = useRef<'voice' | 'text'>('text');
  const setViewModeTracked = (mode: 'voice' | 'text') => { viewModeRef.current = mode; setViewMode(mode); };
  const captureTypeRef = useRef<'none' | 'camera' | 'screen'>('none');
  const videoEncoderRef = useRef<VideoEncoder | null>(null);
  const videoCodecRef = useRef<string>('h264');
  const videoDecodersRef = useRef<Record<string, VideoDecoder>>({});
  const decoderTsRef = useRef<Record<string, number>>({});
  const gotKeyframeRef = useRef<Record<string, boolean>>({});
  const systemAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const connectedHostRef = useRef('');
  const keybindsRef = useRef<Record<string, KeyBind | null>>({});

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [audioInputs, setAudioInputs]   = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedInput, setSelectedInput]   = useState('');
  const [selectedOutput, setSelectedOutput] = useState('');
  const [micLevel, setMicLevel] = useState(0);
  const [userContextMenu, setUserContextMenu] = useState<UserContextMenu | null>(null);
  const [perUserSettings, setPerUserSettings] = useState<Record<string, UserSetting>>({});

  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { isDeafenedRef.current = isDeafened; }, [isDeafened]);
  useEffect(() => { nicknameRef.current = nickname; }, [nickname]);
  useEffect(() => { try { localStorage.setItem('meichat-theme', theme); } catch {} }, [theme]);
  useEffect(() => { window.electronAPI.getPlatform().then(p => setPlatform(p)); }, []);
  useEffect(() => { try { localStorage.setItem('meichat-pinned-servers', JSON.stringify(pinnedServers)); } catch {} }, [pinnedServers]);
  useEffect(() => { keybindsRef.current = keybinds; try { localStorage.setItem('meichat-keybinds', JSON.stringify(keybinds)); } catch {} }, [keybinds]);

  useEffect(() => {
    const handleClick = () => { setUserContextMenu(null); setMsgContextMenu(null); setServerContextMenu(null); };
    if (userContextMenu || msgContextMenu || serverContextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [userContextMenu, msgContextMenu, serverContextMenu]);

  // Keybind recording
  useEffect(() => {
    if (!recordingKeybind) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecordingKeybind(null); return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      setKeybinds(prev => ({ ...prev, [recordingKeybind]: { key: e.key, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey } }));
      setRecordingKeybind(null);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recordingKeybind]);

  // Global keybind handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      for (const [action, bind] of Object.entries(keybindsRef.current)) {
        if (!bind) continue;
        if (e.key === bind.key && e.ctrlKey === bind.ctrlKey && e.shiftKey === bind.shiftKey && e.altKey === bind.altKey) {
          e.preventDefault();
          if (action === 'toggleMute') setIsMuted(m => !m);
          else if (action === 'toggleDeafen') setIsDeafened(d => !d);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const getUserSetting = (name: string): UserSetting =>
    perUserSettings[name] || { name, volume: 100, isMuted: false };

  const updateUserSetting = (name: string, update: Partial<UserSetting>) => {
    setPerUserSettings(prev => {
      const existing = prev[name] || { name, volume: 100, isMuted: false };
      return { ...prev, [name]: { ...existing, ...update } };
    });
  };

  // ── Server message handler ────────────────────────────────

  const handleServerMessage = useCallback((line: string) => {
    if (line.startsWith('SERVER_INFO:')) {
      try {
        const d = JSON.parse(line.substring(12));
        setServerInfo({
          serverName: d.ServerName || '',
          voiceHost: d.VoiceHost || '',
          udpPort: d.UdpPort || 5000,
          maxCameraWidth: d.MaxCameraWidth || 1920,
          maxCameraHeight: d.MaxCameraHeight || 1080,
          maxScreenWidth: d.MaxScreenWidth || 1920,
          maxScreenHeight: d.MaxScreenHeight || 1080,
          maxFps: d.MaxFps || 30,
          maxScreenBitrate: d.MaxScreenBitrate ? d.MaxScreenBitrate * 1000 : 20_000_000,
        });
        // Use the same host the client connected to via TCP — the server may
        // report a private/local IP via LocalEndPoint that is unreachable.
        const voiceHost = connectedHostRef.current || d.VoiceHost || '';
        const udpPort = d.UdpPort || 5000;
        if (voiceHost && udpPort) {
          console.log(`[Voice] Connecting UDP to ${voiceHost}:${udpPort} (server said: ${d.VoiceHost})`);
          window.electronAPI.startVoice(voiceHost, udpPort, nicknameRef.current).catch(err => {
            console.error('[Voice] Auto-start failed:', err);
          });
        }
      } catch {}
    } else if (line.startsWith('ROOMS:')) {
      try {
        const d = JSON.parse(line.substring(6));
        setVoiceRooms((d.VoiceRooms || []).map((r: any) => ({
          name: r.Name, hasPassword: r.HasPassword, bitrate: r.Bitrate || 0,
        })));
        setTextRooms((d.TextRooms || []).map((r: any) => ({
          name: r.Name, hasPassword: r.HasPassword,
        })));
      } catch {}
    } else if (line.startsWith('USERS:')) {
      try {
        const d = JSON.parse(line.substring(6));
        setOnlineUsers(d.map((u: any) => ({ name: u.Name, voiceRoom: u.VoiceRoom || null, online: u.Online !== false, roles: u.Roles || [], roleColor: u.RoleColor || null })));
      } catch {}
    } else if (line.startsWith('ROLES:')) {
      try {
        const d = JSON.parse(line.substring(6));
        setServerRoles(d.map((r: any) => ({ name: r.Name, color: r.Color, priority: r.Priority, permissions: r.Permissions || [] })));
      } catch {}
    } else if (line === 'KICKED') {
      setStatus('Du blev kicket fra serveren');
      setIsConnected(false);
    } else if (line.startsWith('JOINED_TEXT:')) {
      const room = line.substring(12);
      setJoinedText(prev => new Set(prev).add(room));
      setRoomMessages(prev => ({ ...prev, [room]: prev[room] || [] }));
      setCurrentText(room);
    } else if (line.startsWith('LEFT_TEXT:')) {
      const room = line.substring(9);
      setJoinedText(prev => { const s = new Set(prev); s.delete(room); return s; });
      setCurrentText(prev => prev === room ? null : prev);
    } else if (line.startsWith('JOINED_VOICE:')) {
      const payload = line.substring(13);
      const [room, br] = payload.split(':', 2);
      setCurrentVoice(room);
      if (br) { const b = parseInt(br); if (!isNaN(b)) window.electronAPI.setBitrate(b); }
    } else if (line === 'LEFT_VOICE') {
      setCurrentVoice(null);
    } else if (line.startsWith('HISTORY:')) {
      const payload = line.substring(8);
      const idx = payload.indexOf(':');
      if (idx >= 0) {
        const room = payload.substring(0, idx);
        try {
          const msgs: any[] = JSON.parse(payload.substring(idx + 1));
          const formatted = msgs.map(m => ({
            id: crypto.randomUUID(),
            msgId: m.Id || '',
            sender: m.User || '',
            text: `[${new Date(m.Time).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}] ${m.User}: ${m.Text}`,
          }));
          setRoomMessages(prev => ({ ...prev, [room]: [...formatted, ...(prev[room] || [])] }));
        } catch {}
      }
    } else if (line.startsWith('MSG_DELETED:')) {
      const payload = line.substring(12);
      const idx = payload.indexOf(':');
      if (idx >= 0) {
        const room = payload.substring(0, idx);
        const msgId = payload.substring(idx + 1);
        setRoomMessages(prev => ({
          ...prev,
          [room]: (prev[room] || []).filter(m => m.msgId !== msgId),
        }));
      }
    } else if (line.startsWith('MSG:')) {
      const payload = line.substring(4);
      const i1 = payload.indexOf(':');
      if (i1 < 0) return;
      const room = payload.substring(0, i1);
      const rest1 = payload.substring(i1 + 1);
      const i2 = rest1.indexOf(':');
      if (i2 < 0) return;
      const msgId = rest1.substring(0, i2);
      const rest2 = rest1.substring(i2 + 1);
      const i3 = rest2.indexOf(':');
      if (i3 < 0) return;
      const sender = rest2.substring(0, i3);
      const text = rest2.substring(i3 + 1);
      const time = new Date().toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
      setRoomMessages(prev => ({
        ...prev,
        [room]: [...(prev[room] || []), { id: crypto.randomUUID(), msgId, sender, text: `[${time}] ${sender}: ${text}` }],
      }));
    } else if (line.startsWith('ERROR:')) {
      setStatus(`⚠ ${line.substring(6)}`);
    } else if (line.startsWith('CAMERA_ON:')) {
      const user = line.substring(10);
      setCameraUsers(prev => new Set(prev).add(user));
      if (viewModeRef.current !== 'voice') setViewModeTracked('voice');
    } else if (line.startsWith('CAMERA_OFF:')) {
      const user = line.substring(11);
      setCameraUsers(prev => { const s = new Set(prev); s.delete(user); return s; });
      activeVideosRef.current.delete(user);
      setActiveVideos(new Set(activeVideosRef.current));
      if (videoDecodersRef.current[user]) { try { videoDecodersRef.current[user].close(); } catch {} delete videoDecodersRef.current[user]; }
      delete decoderTsRef.current[user];
      delete gotKeyframeRef.current[user];
    } else if (line.startsWith('SCREEN_ON:')) {
      const user = line.substring(10);
      setScreenUsers(prev => new Set(prev).add(user));
      if (viewModeRef.current !== 'voice') setViewModeTracked('voice');
    } else if (line.startsWith('SCREEN_OFF:')) {
      const user = line.substring(11);
      setScreenUsers(prev => { const s = new Set(prev); s.delete(user); return s; });
      activeVideosRef.current.delete(user);
      setActiveVideos(new Set(activeVideosRef.current));
      if (videoDecodersRef.current[user]) { try { videoDecodersRef.current[user].close(); } catch {} delete videoDecodersRef.current[user]; }
      delete decoderTsRef.current[user];
      delete gotKeyframeRef.current[user];
    } else if (line.startsWith('MENTION:')) {
      // MENTION:<room>:<sender>:<text>
      const i1 = line.indexOf(':', 8);
      const i2 = i1 >= 0 ? line.indexOf(':', i1 + 1) : -1;
      if (i1 >= 0 && i2 >= 0) {
        const room = line.substring(8, i1);
        const sender = line.substring(i1 + 1, i2);
        new Notification(`@${sender} i #${room}`, { body: line.substring(i2 + 1).substring(0, 100) });
      }
    }
  }, []);

  // ── IPC subscriptions ─────────────────────────────────────

  useEffect(() => {
    const unsubs = [
      window.electronAPI.onChatMessage(handleServerMessage),
      window.electronAPI.onChatError((msg) => { setStatus(`Error: ${msg}`); setIsConnected(false); setConnectedServerId(null); }),
      window.electronAPI.onChatDisconnected(() => {
        setIsConnected(false);
        setConnectedServerId(null);
        setCurrentVoice(null);
        setStatus('Disconnected');
        stopAudio();
      }),
      window.electronAPI.onAudioReceived((data) => {
        if (!isDeafenedRef.current && playbackRef.current) {
          const copy = new Uint8Array(data).buffer;
          playbackRef.current.port.postMessage(copy, [copy]);
        }
      }),
      window.electronAPI.onVideoReceived((senderName: string, encodedData: Uint8Array, isKeyFrame: boolean, codec: string) => {
        // Wait for a keyframe before feeding delta frames to the decoder
        if (!isKeyFrame && !gotKeyframeRef.current[senderName]) return;
        if (isKeyFrame) gotKeyframeRef.current[senderName] = true;

        let decoder = videoDecodersRef.current[senderName];
        if (!decoder || decoder.state === 'closed') {
          const decoderCodec = codec === 'vp8' ? 'vp8' : 'avc1.640028';
          decoder = new VideoDecoder({
            output: (frame) => {
              const canvasEl = document.getElementById(`vc-${senderName}`) as HTMLCanvasElement | null;
              if (canvasEl) {
                canvasEl.width = frame.displayWidth;
                canvasEl.height = frame.displayHeight;
                const ctx = canvasEl.getContext('2d');
                if (ctx) ctx.drawImage(frame, 0, 0);
              }
              frame.close();
            },
            error: (e) => {
              console.error(`[VideoDecoder:${senderName}]`, e);
              gotKeyframeRef.current[senderName] = false;
            },
          });
          decoder.configure({ codec: decoderCodec });
          videoDecodersRef.current[senderName] = decoder;
        }

        if (decoder.state !== 'configured' || decoder.decodeQueueSize > 5) return;

        const ts = (decoderTsRef.current[senderName] || 0) + 33333;
        decoderTsRef.current[senderName] = ts;

        try {
          decoder.decode(new EncodedVideoChunk({
            type: isKeyFrame ? 'key' : 'delta',
            timestamp: ts,
            data: encodedData,
          }));
        } catch {
          gotKeyframeRef.current[senderName] = false;
        }

        if (!activeVideosRef.current.has(senderName)) {
          activeVideosRef.current.add(senderName);
          setActiveVideos(new Set(activeVideosRef.current));
        }
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [handleServerMessage]);

  // ── Autoconnect background mention listeners ──────────────

  useEffect(() => {
    const unsub = window.electronAPI.onMention((serverId, room, sender, text) => {
      setServerMentions(prev => ({ ...prev, [serverId]: (prev[serverId] || 0) + 1 }));
      const server = pinnedServers.find(s => s.id === serverId);
      const title = server ? server.name : 'MeiChat';
      new Notification(`${title} — @${sender} i #${room}`, { body: text.substring(0, 100) });
    });
    return unsub;
  }, [pinnedServers]);

  useEffect(() => {
    for (const server of pinnedServers) {
      // Never autoconnect to the server we're fully connected to — same username would kick us
      if (isConnected && server.id === connectedServerId) {
        window.electronAPI.stopAutoConnect(server.id);
        continue;
      }
      if (server.autoConnect && server.username && server.password) {
        const { host, port } = parseAddress(server.address);
        window.electronAPI.startAutoConnect(server.id, host, port, server.username, server.password, server.serverPassword);
      } else {
        window.electronAPI.stopAutoConnect(server.id);
      }
    }
  }, [pinnedServers, isConnected, connectedServerId]);

  // ── Audio lifecycle (tied to currentVoiceRoom) ────────────

  useEffect(() => {
    if (currentVoiceRoom) {
      startAudio().catch(err => console.error('Audio start failed:', err));
    } else {
      stopAudio();
    }
    return () => stopAudio();
  }, [currentVoiceRoom]);

  async function startAudio() {
    stopAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedInputRef.current ? { exact: selectedInputRef.current } : undefined,
          sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        },
      });
      streamRef.current = stream;
      console.log('[Audio] Mic stream:', stream.getAudioTracks()[0]?.label);

      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      audioCtxRef.current = ctx;
      console.log('[Audio] AudioContext state:', ctx.state, 'rate:', ctx.sampleRate);

      if (selectedOutputRef.current && typeof (ctx as any).setSinkId === 'function') {
        try { await (ctx as any).setSinkId(selectedOutputRef.current); } catch {}
      }

      const base = import.meta.env.DEV ? '' : '.';
      await ctx.audioWorklet.addModule(`${base}/audio-capture-processor.js`);
      await ctx.audioWorklet.addModule(`${base}/audio-playback-processor.js`);

      // Capture mic → encode → send
      const source = ctx.createMediaStreamSource(stream);

      // Analyser for mic level indicator
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const capture = new AudioWorkletNode(ctx, 'capture-processor');
      capture.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (!isMutedRef.current) window.electronAPI.sendAudio(e.data);
      };
      source.connect(capture);
      const silent = ctx.createGain();
      silent.gain.value = 0;
      capture.connect(silent);
      silent.connect(ctx.destination);
      captureRef.current = capture;

      // Start mic level monitoring
      if (micLevelIntervalRef.current) clearInterval(micLevelIntervalRef.current);
      const levelData = new Uint8Array(analyser.frequencyBinCount);
      micLevelIntervalRef.current = setInterval(() => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(levelData);
        let sum = 0;
        for (let i = 0; i < levelData.length; i++) {
          const v = (levelData[i] - 128) / 128;
          sum += v * v;
        }
        setMicLevel(Math.min(1, Math.sqrt(sum / levelData.length) * 3));
      }, 50);

      // Playback received audio
      const playback = new AudioWorkletNode(ctx, 'playback-processor');
      playback.connect(ctx.destination);
      playbackRef.current = playback;
      console.log('[Audio] Pipeline ready — capture + playback');
    } catch (err) {
      console.error('[Audio] startAudio failed:', err);
    }
  }

  function stopAudio() {
    stopVideoCapture();
    cleanupVideo();
    if (micLevelIntervalRef.current) {
      clearInterval(micLevelIntervalRef.current);
      micLevelIntervalRef.current = null;
    }
    setMicLevel(0);
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    captureRef.current = null;
    playbackRef.current = null;
  }

  async function createVideoEncoder(width: number, height: number, bitrate: number, framerate: number) {
    let codec = 'avc1.640028'; // H.264 High Profile Level 4.0
    let codecId = 'h264';
    try {
      const h264Check = await VideoEncoder.isConfigSupported({
        codec, width, height, bitrate, framerate,
      });
      if (!h264Check.supported) { codec = 'vp8'; codecId = 'vp8'; }
    } catch { codec = 'vp8'; codecId = 'vp8'; }

    const encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        window.electronAPI.sendVideo(data.buffer, chunk.type === 'key', codecId);
      },
      error: (e) => console.error('[VideoEncoder] Error:', e),
    });
    encoder.configure({
      codec, width, height, bitrate, framerate,
      latencyMode: 'realtime',
      ...(codecId === 'h264' ? { avc: { format: 'annexb' } } : {}),
    });
    console.log(`[Video] Encoder: ${codecId} ${width}x${height} @ ${bitrate / 1000}kbps`);
    return { encoder, codec: codecId };
  }

  async function startCamera() {
    if (captureTypeRef.current !== 'none') stopVideoCapture();
    try {
      const res = VIDEO_RESOLUTIONS[videoResolutionRef.current];
      const fps = videoFpsRef.current;
      const capW = serverInfo ? Math.min(res.width, serverInfo.maxCameraWidth) : res.width;
      const capH = serverInfo ? Math.min(res.height, serverInfo.maxCameraHeight) : res.height;
      const capFps = serverInfo ? Math.min(fps, serverInfo.maxFps) : fps;
      const bitrate = getVideoBitrate(capW, capH, capFps);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: selectedVideoInputRef.current ? { exact: selectedVideoInputRef.current } : undefined,
          width: capW, height: capH,
          frameRate: { ideal: capFps, max: capFps },
        }
      });
      cameraStreamRef.current = stream;

      const { encoder: enc, codec: codecId } = await createVideoEncoder(capW, capH, bitrate, capFps);
      videoEncoderRef.current = enc;
      videoCodecRef.current = codecId;

      const videoEl = document.createElement('video');
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.playsInline = true;
      await videoEl.play();
      captureVideoElRef.current = videoEl;
      const canvas = document.createElement('canvas');
      canvas.width = capW;
      canvas.height = capH;
      const ctx = canvas.getContext('2d')!;
      let frameCount = 0;
      let lastTime = -1;
      const keyInterval = capFps * 2;
      videoIntervalRef.current = setInterval(() => {
        if (videoEl.readyState >= 2 && enc.state === 'configured' && videoEl.currentTime !== lastTime) {
          lastTime = videoEl.currentTime;
          ctx.drawImage(videoEl, 0, 0, capW, capH);
          const frame = new VideoFrame(canvas, { timestamp: performance.now() * 1000 });
          enc.encode(frame, { keyFrame: frameCount % keyInterval === 0 });
          frame.close();
          frameCount++;
        }
      }, Math.round(1000 / capFps));
      captureTypeRef.current = 'camera';
      setIsCameraOn(true);
      window.electronAPI.sendChat('CMD:CAMERA_ON');
    } catch (err) {
      console.error('[Camera] Failed:', err);
    }
  }

  async function startScreenShare() {
    if (captureTypeRef.current !== 'none') stopVideoCapture();
    const sourceId = selectedSource;
    setScreenShareDialog(false);
    setSelectedSource(null);
    const res = VIDEO_RESOLUTIONS[screenShareResolution];
    const fps = screenShareFps;
    const maxW = serverInfo ? Math.min(res.width, serverInfo.maxScreenWidth) : res.width;
    const maxH = serverInfo ? Math.min(res.height, serverInfo.maxScreenHeight) : res.height;
    const capFps = serverInfo ? Math.min(fps, serverInfo.maxFps) : fps;
    try {
      if (sourceId) {
        await window.electronAPI.setShareSource(sourceId, screenShareAudio);
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: capFps, max: capFps } },
        audio: screenShareAudio,
      });
      cameraStreamRef.current = stream;
      // Mix system audio into voice pipeline if available
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && audioCtxRef.current && captureRef.current) {
        const audioStream = new MediaStream([audioTrack]);
        const systemSource = audioCtxRef.current.createMediaStreamSource(audioStream);
        systemSource.connect(captureRef.current);
        systemAudioSourceRef.current = systemSource;
      }
      const videoEl = document.createElement('video');
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.playsInline = true;
      await videoEl.play();
      captureVideoElRef.current = videoEl;
      const settings = stream.getVideoTracks()[0]?.getSettings();
      const srcW = settings?.width || 1920;
      const srcH = settings?.height || 1080;
      const scale = Math.min(1, maxW / srcW, maxH / srcH);
      const w = Math.round(srcW * scale);
      const h = Math.round(srcH * scale);
      // Ensure even dimensions (required by H.264)
      const ew = w % 2 === 0 ? w : w - 1;
      const eh = h % 2 === 0 ? h : h - 1;

      const { encoder: enc, codec: codecId } = await createVideoEncoder(ew, eh,
        Math.min(screenShareBitrate * 1000, serverInfo?.maxScreenBitrate || 20_000_000),
        capFps);
      videoEncoderRef.current = enc;
      videoCodecRef.current = codecId;

      const canvas = document.createElement('canvas');
      canvas.width = ew;
      canvas.height = eh;
      const ctx2 = canvas.getContext('2d')!;
      let frameCount = 0;
      let lastTime = -1;
      const keyInterval = capFps * 2;
      videoIntervalRef.current = setInterval(() => {
        if (videoEl.readyState >= 2 && enc.state === 'configured' && videoEl.currentTime !== lastTime) {
          lastTime = videoEl.currentTime;
          ctx2.drawImage(videoEl, 0, 0, ew, eh);
          const frame = new VideoFrame(canvas, { timestamp: performance.now() * 1000 });
          enc.encode(frame, { keyFrame: frameCount % keyInterval === 0 });
          frame.close();
          frameCount++;
        }
      }, Math.round(1000 / capFps));
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopVideoCapture());
      captureTypeRef.current = 'screen';
      setIsScreenSharing(true);
      window.electronAPI.sendChat('CMD:SCREEN_ON');
    } catch (err) {
      console.error('[ScreenShare] Failed:', err);
    }
  }

  function stopVideoCapture() {
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
    if (videoEncoderRef.current) {
      try { videoEncoderRef.current.close(); } catch {}
      videoEncoderRef.current = null;
    }
    if (captureVideoElRef.current) {
      captureVideoElRef.current.pause();
      captureVideoElRef.current.srcObject = null;
      captureVideoElRef.current = null;
    }
    cameraStreamRef.current?.getTracks().forEach(t => t.stop());
    cameraStreamRef.current = null;
    if (systemAudioSourceRef.current) {
      try { systemAudioSourceRef.current.disconnect(); } catch {}
      systemAudioSourceRef.current = null;
    }
    if (captureTypeRef.current === 'camera') window.electronAPI.sendChat('CMD:CAMERA_OFF');
    if (captureTypeRef.current === 'screen') window.electronAPI.sendChat('CMD:SCREEN_OFF');
    captureTypeRef.current = 'none';
    setIsCameraOn(false);
    setIsScreenSharing(false);
  }

  function cleanupVideo() {
    Object.values(videoDecodersRef.current).forEach(d => { try { d.close(); } catch {} });
    videoDecodersRef.current = {};
    decoderTsRef.current = {};
    gotKeyframeRef.current = {};
    Object.values(videoTimeoutsRef.current).forEach(clearTimeout);
    videoTimeoutsRef.current = {};
    activeVideosRef.current.clear();
    setActiveVideos(new Set());
    setCameraUsers(new Set());
    setScreenUsers(new Set());
  }

  const openScreenShareDialog = async () => {
    setScreenShareDialog(true);
    setSourceTab('screen');
    setSelectedSource(null);
    setScreenSources([]);
    try {
      const sources = await window.electronAPI.getScreenSources();
      setScreenSources(sources);
      const firstScreen = sources.find((s: any) => s.isScreen);
      if (firstScreen) setSelectedSource(firstScreen.id);
    } catch (err) {
      console.error('[ScreenShare] Failed to get sources:', err);
    }
  };

  async function refreshDevices() {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach(t => t.stop());
    } catch {}
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      tmp.getTracks().forEach(t => t.stop());
    } catch {}
    const all = await navigator.mediaDevices.enumerateDevices();
    setAudioInputs(all.filter(d => d.kind === 'audioinput'));
    setAudioOutputs(all.filter(d => d.kind === 'audiooutput'));
    setVideoInputs(all.filter(d => d.kind === 'videoinput'));
  }

  async function restartAudio() {
    if (currentVoiceRoom) {
      stopAudio();
      await startAudio();
    }
  }

  // ── Call duration timer

  useEffect(() => {
    if (!currentVoiceRoom) { setCallDuration(0); setViewModeTracked('text'); setIsScreenSharing(false); setSelectedVideoFeed(null); setIsCallFullscreen(false); return; }
    const iv = setInterval(() => setCallDuration(d => d + 1), 1000);
    return () => clearInterval(iv);
  }, [currentVoiceRoom]);

  // ── Auto‑scroll ───────────────────────────────────────────

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [roomMessages, currentTextRoom]);

  // ── Helpers ───────────────────────────────────────────────

  const getServerColor = (name: string) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return SERVER_COLORS[Math.abs(hash) % SERVER_COLORS.length];
  };
  const isMac = platform === 'darwin';

  const fmt = (s: number) => {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const formatKeyBind = (kb: KeyBind) => {
    const parts: string[] = [];
    if (kb.ctrlKey) parts.push('Ctrl');
    if (kb.shiftKey) parts.push('Shift');
    if (kb.altKey) parts.push('Alt');
    parts.push(kb.key.length === 1 ? kb.key.toUpperCase() : kb.key);
    return parts.join('+');
  };

  const currentMessages = currentTextRoom ? (roomMessages[currentTextRoom] || []) : [];
  const usersInRoom = onlineUsers.filter(u => u.online && u.voiceRoom === currentVoiceRoom);
  const isVideoMode = isCameraOn || isScreenSharing || cameraUsers.size > 0 || screenUsers.size > 0;
  const onlineUsersList = onlineUsers.filter(u => u.online);
  const offlineUsersList = onlineUsers.filter(u => !u.online);

  const myUser = onlineUsers.find(u => u.name === nickname);
  const ALL_PERMISSIONS = ['admin', 'manage_roles', 'manage_rooms', 'kick_users', 'delete_messages'];
  const myPermissions = new Set<string>();
  if (myUser) {
    for (const roleName of myUser.roles) {
      const role = serverRoles.find(r => r.name === roleName);
      if (role) {
        if (role.permissions.includes('admin')) { ALL_PERMISSIONS.forEach(p => myPermissions.add(p)); }
        else role.permissions.forEach(p => myPermissions.add(p));
      }
    }
  }
  const hasPermission = (perm: string) => myPermissions.has('admin') || myPermissions.has(perm);

  // ── Pinned Server Functions ───────────────────────────────

  const connectToPinnedServer = async (server: PinnedServer) => {
    if (server.username && server.password) {
      const { host, port } = parseAddress(server.address);
      // Stop background autoconnect while fully connected
      window.electronAPI.stopAutoConnect(server.id);
      setConnecting(true);
      setStatus('Connecting...');
      setNickname(server.username);
      nicknameRef.current = server.username;
      connectedHostRef.current = host;
      try {
        await window.electronAPI.connectChat(host, port, server.username, server.password, false, server.serverPassword);
        setServerIp(host);
        setTcpPort(String(port));
        setConnectedServerId(server.id);
        setIsConnected(true);
        setStatus('Connected');
      } catch (err: any) {
        if (err.message === 'SERVER_PASSWORD_REQUIRED') {
          setServerPasswordDialog({ address: server.address, username: server.username, password: server.password, isRegister: false, serverId: server.id });
          setServerPasswordInput('');
          setStatus('Server kræver password');
        } else {
          setStatus(`Failed: ${err.message}`);
        }
      }
      setConnecting(false);
    } else {
      setLoginDialog(server.id);
      setNickname('');
      setPassword('');
      setIsRegister(false);
    }
  };

  const handleLoginDialogSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginDialog || !nickname.trim() || !password.trim()) return;
    const server = pinnedServers.find(s => s.id === loginDialog);
    if (!server) return;
    setConnecting(true);
    setStatus(isRegister ? 'Registering...' : 'Logging in...');
    const { host, port } = parseAddress(server.address);
    try {
      nicknameRef.current = nickname;
      connectedHostRef.current = host;
      await window.electronAPI.connectChat(host, port, nickname, password, isRegister, server.serverPassword);
      setPinnedServers(prev => prev.map(s =>
        s.id === loginDialog ? { ...s, username: nickname, password } : s
      ));
      setServerIp(host);
      setTcpPort(String(port));
      setConnectedServerId(loginDialog);
      setIsConnected(true);
      setStatus('Connected');
      setLoginDialog(null);
    } catch (err: any) {
      if (err.message === 'SERVER_PASSWORD_REQUIRED') {
        setLoginDialog(null);
        setServerPasswordDialog({ address: server.address, username: nickname, password, isRegister, serverId: server.id });
        setServerPasswordInput('');
        setStatus('Server kræver password');
      } else {
        setStatus(`Failed: ${err.message}`);
      }
    }
    setConnecting(false);
  };

  const addPinnedServer = () => {
    if (!newServerName.trim() || !newServerAddress.trim()) return;
    setPinnedServers(prev => [...prev, {
      id: crypto.randomUUID(),
      name: newServerName.trim(),
      address: newServerAddress.trim(),
    }]);
    setAddServerDialog(false);
    setNewServerName('');
    setNewServerAddress('');
  };

  const unpinServer = (serverId: string) => {
    setPinnedServers(prev => prev.filter(s => s.id !== serverId));
    setServerContextMenu(null);
  };

  const logoutServer = (serverId: string) => {
    setPinnedServers(prev => prev.map(s =>
      s.id === serverId ? { ...s, username: undefined, password: undefined } : s
    ));
    setServerContextMenu(null);
  };

  const toggleAutoConnect = (serverId: string) => {
    setPinnedServers(prev => prev.map(s =>
      s.id === serverId ? { ...s, autoConnect: !s.autoConnect } : s
    ));
    setServerContextMenu(null);
  };

  // ── Chat submit ───────────────────────────────────────────

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !currentTextRoom) return;
    window.electronAPI.sendChat(`MSG:${currentTextRoom}:${input}`);
    setInput('');
  };

  // ── Room actions ──────────────────────────────────────────

  const joinVoice = (room: VoiceRoom) => {
    setViewModeTracked('voice');
    if (room.name === currentVoiceRoom) return;
    if (room.hasPassword) { setPwDialog({ room: room.name, type: 'voice' }); setPwInput(''); }
    else window.electronAPI.sendChat(`CMD:JOIN_VOICE:${room.name}`);
  };

  const joinText = (room: TextRoom) => {
    setViewModeTracked('text');
    if (joinedTextRooms.has(room.name)) { setCurrentText(room.name); return; }
    if (room.hasPassword) { setPwDialog({ room: room.name, type: 'text' }); setPwInput(''); }
    else window.electronAPI.sendChat(`CMD:JOIN_TEXT:${room.name}`);
  };

  const handlePwSubmit = () => {
    if (!pwDialog || !pwInput) return;
    const cmd = pwDialog.type === 'voice' ? 'JOIN_VOICE' : 'JOIN_TEXT';
    window.electronAPI.sendChat(`CMD:${cmd}:${pwDialog.room}:${pwInput}`);
    setPwDialog(null);
    setPwInput('');
  };

  const leaveVoice = () => {
    window.electronAPI.sendChat('CMD:LEAVE_VOICE');
  };

  const disconnect = () => {
    window.electronAPI.stopVoice();
    window.electronAPI.disconnectChat();
    setIsConnected(false);
    setConnectedServerId(null);
    setCurrentVoice(null);
    setCurrentText(null);
    setJoinedText(new Set());
    setRoomMessages({});
    setOnlineUsers([]);
    setVoiceRooms([]);
    setTextRooms([]);
    setStatus('Disconnected');
    setIsScreenSharing(false);
    setSelectedVideoFeed(null);
    setCameraUsers(new Set());
    setScreenUsers(new Set());
    setServerInfo(null);
    setServerRoles([]);
    stopAudio();
  };

  // ═════════════════════════════════════════════════════════
  //  CONNECT SCREEN
  // ═════════════════════════════════════════════════════════

  if (!isConnected) {
    return (
      <div className="h-screen flex flex-col bg-[#0a0e0a] text-green-500 font-mono" data-theme={theme}>
        {/* ── Draggable titlebar ── */}
        <div className="flex items-center bg-[#0d120d] border-b border-green-900/30 select-none"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
          {isMac ? (
            <>
              <div className="w-[70px]" />
              <div className="flex-1 flex items-center justify-center">
                <Terminal className="w-4 h-4 shrink-0 mr-2" />
                <span className="text-xs font-bold">MEICHAT</span>
              </div>
              <div className="w-[70px]" />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 px-4 py-2 flex-1 min-w-0">
                <Terminal className="w-4 h-4 shrink-0" />
                <span className="text-xs font-bold">MEICHAT</span>
              </div>
              <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <button onClick={() => window.electronAPI.minimizeWindow()}
                  className="px-3 py-2 text-green-600 hover:bg-green-900/30 transition-colors" title="Minimer">
                  <Minus className="w-4 h-4" />
                </button>
                <button onClick={() => window.electronAPI.maximizeWindow()}
                  className="px-3 py-2 text-green-600 hover:bg-green-900/30 transition-colors" title="Maksimer">
                  <Square className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => window.electronAPI.closeWindow()}
                  className="px-3 py-2 text-green-600 hover:bg-red-600 hover:text-white transition-colors" title="Luk">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── Connect Screen Content ── */}
        <div className="flex-1 flex items-center justify-center overflow-y-auto">
          <div className="w-full max-w-2xl px-8 py-12">
            {/* Header */}
            <div className="text-center mb-12">
              <Terminal className="w-12 h-12 mx-auto mb-4 text-green-500" />
              <h1 className="text-3xl font-bold text-green-400 mb-1">MEICHAT</h1>
              <p className="text-xs text-green-700">v1.0.0 — Secure VoIP</p>
            </div>

            {/* Pinned Servers */}
            <div className="mb-10">
              <div className="text-xs text-green-700 mb-6 text-center tracking-widest">DINE SERVERE</div>
              <div className="flex flex-wrap justify-center gap-6">
                {pinnedServers.map(server => {
                  const mentions = serverMentions[server.id] || 0;
                  return (
                  <button key={server.id}
                    onClick={() => { setServerMentions(prev => { const n = { ...prev }; delete n[server.id]; return n; }); connectToPinnedServer(server); }}
                    onContextMenu={(e) => { e.preventDefault(); setServerContextMenu({ serverId: server.id, x: e.clientX, y: e.clientY }); }}
                    disabled={connecting}
                    className="group flex flex-col items-center gap-2 transition-all disabled:opacity-50">
                    <div className="relative">
                      <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-white text-xl font-bold shadow-lg transition-all group-hover:rounded-xl group-hover:shadow-xl group-hover:scale-105"
                        style={{ backgroundColor: getServerColor(server.name) }}>
                        {server.name.charAt(0).toUpperCase()}
                      </div>
                      {mentions > 0 && (
                        <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center text-[10px] text-white font-bold shadow-lg animate-pulse">
                          {mentions > 9 ? '9+' : mentions}
                        </div>
                      )}
                      {server.autoConnect && server.username && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-600 rounded-full flex items-center justify-center border border-[#0a0e0a]" title="Autoconnect aktiv">
                          <Wifi className="w-2 h-2 text-white" />
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-green-600 group-hover:text-green-400 transition-colors max-w-[80px] truncate">{server.name}</span>
                    {server.username ? (
                      <span className="text-[10px] text-green-700 flex items-center gap-1">
                        <Circle className="w-1.5 h-1.5 fill-green-500 text-green-500" />
                        {server.username}
                      </span>
                    ) : (
                      <span className="text-[10px] text-green-800">Ikke logget ind</span>
                    )}
                  </button>
                  );
                })}
                {/* Add Server Button */}
                <button onClick={() => setAddServerDialog(true)}
                  className="group flex flex-col items-center gap-2 transition-all">
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center border-2 border-dashed border-green-900/50 text-green-700 transition-all group-hover:rounded-xl group-hover:border-green-600 group-hover:text-green-500 group-hover:scale-105">
                    <Plus className="w-7 h-7" />
                  </div>
                  <span className="text-xs text-green-700 group-hover:text-green-500 transition-colors">Tilføj</span>
                </button>
              </div>
            </div>

            {/* Status */}
            <div className="text-center text-xs text-green-700 space-y-1">
              <div>{'>'} Status: <span className="text-green-500">{status}</span></div>
              <div>{'>'} Protocol: <span className="text-green-500">UDP + TCP</span></div>
            </div>
          </div>
        </div>

        {/* ── Login Dialog ── */}
        {loginDialog && (() => {
          const server = pinnedServers.find(s => s.id === loginDialog);
          if (!server) return null;
          return (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-md">
                <div className="bg-green-900/40 p-6 border-b border-green-900/50">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold"
                      style={{ backgroundColor: getServerColor(server.name) }}>
                      {server.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-green-400">{server.name}</h2>
                      <p className="text-xs text-green-700">{server.address}</p>
                    </div>
                    <button onClick={() => setLoginDialog(null)} className="ml-auto p-2 text-green-600 hover:text-green-400">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>
                <div className="flex border-b border-green-900/50">
                  <button type="button" onClick={() => setIsRegister(false)}
                    className={`flex-1 py-3 text-sm font-bold transition-all ${!isRegister ? 'text-green-400 border-b-2 border-green-500 bg-green-900/20' : 'text-green-700 hover:text-green-500'}`}>
                    LOG IND
                  </button>
                  <button type="button" onClick={() => setIsRegister(true)}
                    className={`flex-1 py-3 text-sm font-bold transition-all ${isRegister ? 'text-green-400 border-b-2 border-green-500 bg-green-900/20' : 'text-green-700 hover:text-green-500'}`}>
                    REGISTRER
                  </button>
                </div>
                <form onSubmit={handleLoginDialogSubmit} className="p-6 space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs text-green-700 block">{'>'} BRUGERNAVN</label>
                    <input type="text" value={nickname} onChange={e => setNickname(e.target.value)}
                      placeholder="Indtast dit brugernavn..."
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                      autoFocus />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-green-700 block">{'>'} PASSWORD</label>
                    <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                      placeholder="Indtast dit password..."
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all" />
                  </div>
                  <button type="submit" disabled={!nickname.trim() || !password.trim() || connecting}
                    className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                    {isRegister ? <UserPlus className="w-5 h-5" /> : <LogIn className="w-5 h-5" />}
                    {connecting ? (isRegister ? 'REGISTERER...' : 'LOGGER IND...') : (isRegister ? 'REGISTRER' : 'LOG IND')}
                  </button>
                  <div className="pt-2 text-center">
                    <span className="text-xs text-green-700">{status}</span>
                  </div>
                </form>
              </div>
            </div>
          );
        })()}

        {/* ── Add Server Dialog ── */}
        {addServerDialog && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-md">
              <div className="bg-green-900/40 p-6 border-b border-green-900/50 flex items-center justify-between">
                <h2 className="text-lg font-bold text-green-400">TILFØJ SERVER</h2>
                <button onClick={() => setAddServerDialog(false)} className="p-2 text-green-600 hover:text-green-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-green-700 block">{'>'} SERVER NAVN</label>
                  <input type="text" value={newServerName} onChange={e => setNewServerName(e.target.value)}
                    placeholder="Min Server..."
                    className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                    autoFocus />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-green-700 block">{'>'} ADRESSE</label>
                  <input type="text" value={newServerAddress} onChange={e => setNewServerAddress(e.target.value)}
                    placeholder="86.52.25.44:5001 eller minserver.dk"
                    className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all" />
                  <span className="text-[10px] text-green-800">Port 5001 bruges som standard hvis ingen port angives</span>
                </div>
                <button onClick={addPinnedServer} disabled={!newServerName.trim() || !newServerAddress.trim()}
                  className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                  <Plus className="w-5 h-5" />
                  TILFØJ SERVER
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Server Context Menu ── */}
        {serverContextMenu && (() => {
          const server = pinnedServers.find(s => s.id === serverContextMenu.serverId);
          if (!server) return null;
          return (
            <div className="fixed bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-2 min-w-[180px] z-50"
              style={{ left: Math.min(serverContextMenu.x, window.innerWidth - 200), top: Math.min(serverContextMenu.y, window.innerHeight - 150) }}
              onClick={e => e.stopPropagation()}>
              {server.username && (
                <button onClick={() => toggleAutoConnect(server.id)}
                  className="w-full px-4 py-2.5 rounded-lg text-green-400 hover:bg-green-900/30 transition-all flex items-center gap-2 text-sm">
                  {server.autoConnect ? <WifiOff className="w-4 h-4" /> : <Wifi className="w-4 h-4" />}
                  <span>{server.autoConnect ? 'Slå autoconnect fra' : 'Slå autoconnect til'}</span>
                </button>
              )}
              {server.username && (
                <button onClick={() => logoutServer(server.id)}
                  className="w-full px-4 py-2.5 rounded-lg text-yellow-400 hover:bg-yellow-900/30 transition-all flex items-center gap-2 text-sm">
                  <LogOut className="w-4 h-4" />
                  <span>Log ud</span>
                </button>
              )}
              <button onClick={() => unpinServer(server.id)}
                className="w-full px-4 py-2.5 rounded-lg text-red-400 hover:bg-red-900/40 transition-all flex items-center gap-2 text-sm">
                <Trash2 className="w-4 h-4" />
                <span>Fjern server</span>
              </button>
            </div>
          );
        })()}

        {/* ── Server Password Dialog ── */}
        {serverPasswordDialog && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-md">
              <div className="bg-green-900/40 p-6 border-b border-green-900/50 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Lock className="w-6 h-6 text-green-500" />
                  <div>
                    <h2 className="text-lg font-bold text-green-400">SERVER PASSWORD</h2>
                    <p className="text-xs text-green-700">{serverPasswordDialog.address}</p>
                  </div>
                </div>
                <button onClick={() => { setServerPasswordDialog(null); setStatus('Awaiting connection'); }} className="p-2 text-green-600 hover:text-green-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!serverPasswordInput.trim()) return;
                const { host, port } = parseAddress(serverPasswordDialog.address);
                setConnecting(true);
                setStatus('Connecting med server password...');
                try {
                  nicknameRef.current = serverPasswordDialog.username;
                  connectedHostRef.current = host;
                  await window.electronAPI.connectChat(
                    host, port,
                    serverPasswordDialog.username, serverPasswordDialog.password,
                    serverPasswordDialog.isRegister, serverPasswordInput
                  );
                  if (serverPasswordDialog.serverId) {
                    setPinnedServers(prev => prev.map(s =>
                      s.id === serverPasswordDialog!.serverId
                        ? { ...s, username: serverPasswordDialog!.username, password: serverPasswordDialog!.password, serverPassword: serverPasswordInput }
                        : s
                    ));
                  }
                  setServerIp(host);
                  setTcpPort(String(port));
                  setNickname(serverPasswordDialog.username);
                  setConnectedServerId(serverPasswordDialog.serverId || null);
                  setIsConnected(true);
                  setStatus('Connected');
                  setServerPasswordDialog(null);
                } catch (err: any) {
                  setStatus(`Failed: ${err.message}`);
                }
                setConnecting(false);
              }} className="p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-green-700 block">{'>'} SERVER PASSWORD</label>
                  <input type="password" value={serverPasswordInput} onChange={e => setServerPasswordInput(e.target.value)}
                    placeholder="Indtast server password..."
                    className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                    autoFocus />
                </div>
                <button type="submit" disabled={!serverPasswordInput.trim() || connecting}
                  className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                  <LogIn className="w-5 h-5" />
                  {connecting ? 'FORBINDER...' : 'FORBIND'}
                </button>
                <div className="pt-2 text-center">
                  <span className="text-xs text-green-700">{status}</span>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════
  //  MAIN UI
  // ═════════════════════════════════════════════════════════

  return (
   <div className="h-screen flex flex-col bg-[#0a0e0a] text-green-500 font-mono" data-theme={theme}>

     {/* ── Draggable titlebar ─────────────────────────────── */}
     <div className="flex items-center bg-[#0d120d] border-b border-green-900/30 select-none"
       style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
       {isMac ? (
         <>
           <div className="w-[70px]" />
           <div className="flex-1 flex items-center justify-center min-w-0">
             <Terminal className="w-4 h-4 shrink-0 mr-2" />
             <span className="text-xs font-bold truncate">MEICHAT</span>
             <span className="text-xs text-green-700 truncate ml-1">— {nickname}</span>
           </div>
           <button onClick={disconnect}
             className="px-3 py-2 text-xs text-red-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"
             style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
             DISCONNECT
           </button>
         </>
       ) : (
         <>
           <div className="flex items-center gap-2 px-4 py-2 flex-1 min-w-0">
             <Terminal className="w-4 h-4 shrink-0" />
             <span className="text-xs font-bold truncate">MEICHAT</span>
             <span className="text-xs text-green-700 truncate">— {nickname}</span>
           </div>
           <button onClick={disconnect}
             className="px-3 py-2 text-xs text-red-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"
             style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
             DISCONNECT
           </button>
           <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
             <button onClick={() => window.electronAPI.minimizeWindow()}
               className="px-3 py-2 text-green-600 hover:bg-green-900/30 transition-colors" title="Minimer">
               <Minus className="w-4 h-4" />
             </button>
             <button onClick={() => window.electronAPI.maximizeWindow()}
               className="px-3 py-2 text-green-600 hover:bg-green-900/30 transition-colors" title="Maksimer">
               <Square className="w-3.5 h-3.5" />
             </button>
             <button onClick={() => window.electronAPI.closeWindow()}
               className="px-3 py-2 text-green-600 hover:bg-red-600 hover:text-white transition-colors" title="Luk">
               <X className="w-4 h-4" />
             </button>
           </div>
         </>
       )}
     </div>

     {/* ── Main content wrapper with padding ──────────────── */}
     <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">

      {/* ── Main content ───────────────────────────────────── */}
      <div className="flex-1 flex gap-4 overflow-hidden">

        {/* ── Left sidebar: rooms ─────────────────────────── */}
        <div className={`w-64 bg-[#0d120d]/60 backdrop-blur-sm rounded-lg shadow-lg shadow-green-900/10 flex flex-col ${isCallFullscreen && viewMode === 'voice' && currentVoiceRoom ? 'hidden' : ''}`}>
          <div className="flex-1 overflow-y-auto">
            {/* Text channels */}
            <div className="p-4 border-b border-green-900/30">
              <div className="text-xs text-green-700 mb-2">TEXT KANALER</div>
            </div>
            <div className="p-3">
              {textRooms.map(r => (
                <button key={r.name} onClick={() => joinText(r)}
                  className={`w-full text-left px-4 py-2.5 rounded-lg mb-2 flex items-center gap-2 transition-all ${
                    currentTextRoom === r.name
                      ? 'bg-green-900/40 text-green-400 shadow-md shadow-green-900/30'
                      : joinedTextRooms.has(r.name)
                        ? 'text-green-500 hover:bg-green-900/20'
                        : 'text-green-700 hover:bg-green-900/20'
                  }`}>
                  {r.hasPassword ? <Lock className="w-4 h-4" /> : <Hash className="w-4 h-4" />}
                  <span className="text-sm truncate">{r.name}</span>
                </button>
              ))}
            </div>

            {/* Voice channels */}
            <div className="p-4 border-b border-green-900/30">
              <div className="text-xs text-green-700 mb-2">VOICE KANALER</div>
            </div>
            <div className="p-3">
              {voiceRooms.map(r => {
                const usersInChannel = onlineUsers.filter(u => u.online && u.voiceRoom === r.name);
                return (
                  <div key={r.name} className="mb-2">
                    <button onClick={() => joinVoice(r)}
                      className={`w-full text-left px-4 py-2.5 rounded-lg flex items-center gap-2 transition-all ${
                        currentVoiceRoom === r.name
                          ? 'bg-green-900/40 text-green-400 shadow-md shadow-green-900/30'
                          : 'hover:bg-green-900/20 text-green-600'
                      }`}>
                      {r.hasPassword ? <Lock className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                      <span className="text-sm truncate">{r.name}</span>
                      {r.bitrate > 0 && <span className="ml-auto text-xs text-green-800">{r.bitrate / 1000}k</span>}
                    </button>
                    {usersInChannel.length > 0 && (
                      <div className="ml-6 mt-1 space-y-1">
                        {usersInChannel.map(u => (
                          <div key={u.name} className="flex items-center gap-2 px-2 py-1 text-xs text-green-600">
                            <User className="w-3 h-3" />
                            <span>{u.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* User controls at bottom */}
          <div className="p-4 border-t border-green-900/30 bg-[#0d120d]/40">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-green-900/40 flex items-center justify-center">
                <User className="w-4 h-4 text-green-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-green-500 truncate">{nickname}</div>
                <div className="text-xs text-green-700">online</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setIsMuted(!isMuted)}
                className={`p-2 rounded-lg transition-all ${isMuted ? 'bg-red-900/40 text-red-500 hover:bg-red-900/60' : 'bg-green-900/20 text-green-600 hover:bg-green-900/40'}`}
                title={isMuted ? 'Unmute' : 'Mute'}>
                {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
              <div className="w-1.5 h-6 bg-green-900/30 rounded-full overflow-hidden flex flex-col-reverse" title="Mic level">
                <div className={`w-full rounded-full transition-all duration-75 ${micLevel > 0.6 ? 'bg-yellow-500' : 'bg-green-500'}`}
                  style={{ height: `${micLevel * 100}%` }} />
              </div>
              <button onClick={() => setIsDeafened(!isDeafened)}
                className={`p-2 rounded-lg transition-all ${isDeafened ? 'bg-red-900/40 text-red-500 hover:bg-red-900/60' : 'bg-green-900/20 text-green-600 hover:bg-green-900/40'}`}
                title={isDeafened ? 'Undeafen' : 'Deafen'}>
                {isDeafened ? <VolumeX className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
              </button>
              <button onClick={() => { setShowSettings(true); refreshDevices(); }}
                className="p-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all ml-auto"
                title="Settings">
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* ── Center panel ────────────────────────────────── */}
        <div className="flex-1 flex flex-col bg-[#0d120d]/60 backdrop-blur-sm rounded-lg overflow-hidden shadow-lg shadow-green-900/10">
          {viewMode === 'voice' && currentVoiceRoom ? (
            /* ── Voice / Video call ─────────────────────── */
            <div className="flex-1 flex flex-col">
              {isVideoMode ? (
                /* ── Video Grid Mode ─────────────────────── */
                <div className="flex-1 flex flex-col p-4">
                  <div className={`flex-1 ${selectedVideoFeed ? '' : `grid gap-4 ${
                    usersInRoom.length === 1 ? 'grid-cols-1' :
                    usersInRoom.length === 2 ? 'grid-cols-2' :
                    usersInRoom.length <= 4 ? 'grid-cols-2 grid-rows-2' :
                    usersInRoom.length <= 6 ? 'grid-cols-3 grid-rows-2' :
                    'grid-cols-3 grid-rows-3'
                  }`} mb-4`}>
                    {usersInRoom.map(u => {
                      const isLocal = u.name === nickname;
                      const isSelected = selectedVideoFeed === u.name;
                      if (selectedVideoFeed && !isSelected) return null;
                      return (
                        <div key={u.name}
                          onClick={() => setSelectedVideoFeed(isSelected ? null : u.name)}
                          className={`relative bg-[#0a0e0a] rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                            isSelected
                              ? 'h-full border-green-500 shadow-lg shadow-green-900/50'
                              : 'border-green-900/30 hover:border-green-700/50'
                          }`}>
                          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-green-950/50 to-green-900/30">
                            {isLocal ? (
                              (isCameraOn || isScreenSharing) ? (
                                <video autoPlay muted playsInline className="absolute inset-0 w-full h-full object-contain"
                                  ref={el => { if (el && cameraStreamRef.current && el.srcObject !== cameraStreamRef.current) el.srcObject = cameraStreamRef.current; }} />
                              ) : (
                                <div className="w-24 h-24 rounded-full bg-green-900/40 flex items-center justify-center ring-4 ring-green-900/50">
                                  <User className="w-12 h-12 text-green-500" />
                                </div>
                              )
                            ) : (
                              <>
                                <div className="w-24 h-24 rounded-full bg-green-900/40 flex items-center justify-center ring-4 ring-green-900/50">
                                  <User className="w-12 h-12 text-green-500" />
                                </div>
                                <canvas id={`vc-${u.name}`}
                                  className="absolute inset-0 w-full h-full object-contain"
                                  style={{ display: (cameraUsers.has(u.name) || screenUsers.has(u.name)) ? 'block' : 'none' }} />
                              </>
                            )}
                          </div>
                          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-green-400 font-bold text-sm">{u.name}{isLocal ? ' (du)' : ''}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-center gap-3 pb-2">
                    <button onClick={() => setIsMuted(!isMuted)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isMuted ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'}`}
                      title={isMuted ? 'Unmute' : 'Mute'}>
                      {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                    </button>
                    <button onClick={() => isCameraOn ? stopVideoCapture() : startCamera()}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isCameraOn ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30' : 'bg-green-900/20 text-green-600 hover:bg-green-900/40 shadow-green-900/30'}`}
                      title={isCameraOn ? 'Sluk kamera' : 'Tænd kamera'}>
                      {isCameraOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
                    </button>
                    <button onClick={() => isScreenSharing ? stopVideoCapture() : openScreenShareDialog()}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isScreenSharing ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30' : 'bg-green-900/20 text-green-600 hover:bg-green-900/40 shadow-green-900/30'}`}
                      title={isScreenSharing ? 'Stop deling' : 'Del skærm'}>
                      <Share2 className="w-6 h-6" />
                    </button>
                    <button onClick={leaveVoice}
                      className="w-14 h-14 rounded-full bg-red-600/80 hover:bg-red-600 text-white flex items-center justify-center transition-all shadow-lg shadow-red-900/50"
                      title="Forlad voice">
                      <PhoneOff className="w-6 h-6" />
                    </button>
                    <button onClick={() => setIsDeafened(!isDeafened)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isDeafened ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'}`}
                      title={isDeafened ? 'Undeafen' : 'Deafen'}>
                      {isDeafened ? <VolumeX className="w-6 h-6" /> : <Headphones className="w-6 h-6" />}
                    </button>
                    <button onClick={() => setIsCallFullscreen(f => !f)}
                      className="w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 shadow-green-900/30"
                      title={isCallFullscreen ? 'Forlad fuldskærm' : 'Fuldskærm'}>
                      {isCallFullscreen ? <Minimize2 className="w-6 h-6" /> : <Maximize className="w-6 h-6" />}
                    </button>
                  </div>
                  <div className="text-center py-2 border-t border-green-900/30">
                    <div className="text-lg font-mono text-green-500 font-bold">{fmt(callDuration)}</div>
                    <div className="text-xs text-green-700">{currentVoiceRoom}</div>
                  </div>
                </div>
              ) : (
                /* ── Voice Only Mode ─────────────────────── */
                <div className="flex-1 flex flex-col">
                  <div className="flex-1 flex flex-col items-center justify-center p-8">
                    <div className={`grid gap-8 mb-8 ${
                      usersInRoom.length === 1 ? 'grid-cols-1' :
                      usersInRoom.length === 2 ? 'grid-cols-2' :
                      usersInRoom.length <= 4 ? 'grid-cols-2' :
                      'grid-cols-3'
                    }`}>
                      {usersInRoom.map(u => (
                        <div key={u.name} className="flex flex-col items-center">
                          <div className="w-32 h-32 rounded-full bg-green-900/40 flex items-center justify-center ring-4 ring-green-900/50 shadow-lg shadow-green-900/50 mb-3">
                            <User className="w-16 h-16 text-green-500" />
                          </div>
                          <h3 className="text-lg font-bold text-green-400 mb-1">{u.name}</h3>
                          <div className="flex items-center gap-2 text-xs text-green-700">
                            <Mic className="w-3 h-3" />
                            <span>{u.name === nickname && isMuted ? 'Muted' : 'Speaking'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="text-center mb-8">
                      <p className="text-sm text-green-700">Connected to: {currentVoiceRoom}</p>
                    </div>
                    <div className="text-center mb-12">
                      <div className="text-5xl font-mono text-green-500 font-bold">{fmt(callDuration)}</div>
                      <div className="text-xs text-green-700 mt-2">Call Duration</div>
                    </div>
                  </div>
                  <div className="flex justify-center gap-4 pb-8">
                    <button onClick={() => setIsMuted(!isMuted)}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isMuted ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'}`}
                      title={isMuted ? 'Unmute' : 'Mute'}>
                      {isMuted ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
                    </button>
                    <button onClick={() => isCameraOn ? stopVideoCapture() : startCamera()}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isCameraOn ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30' : 'bg-green-900/20 text-green-600 hover:bg-green-900/40 shadow-green-900/30'}`}
                      title={isCameraOn ? 'Sluk kamera' : 'Tænd kamera'}>
                      {isCameraOn ? <Video className="w-7 h-7" /> : <VideoOff className="w-7 h-7" />}
                    </button>
                    <button onClick={() => isScreenSharing ? stopVideoCapture() : openScreenShareDialog()}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isScreenSharing ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30' : 'bg-green-900/20 text-green-600 hover:bg-green-900/40 shadow-green-900/30'}`}
                      title={isScreenSharing ? 'Stop deling' : 'Del skærm'}>
                      <Share2 className="w-7 h-7" />
                    </button>
                    <button onClick={leaveVoice}
                      className="w-16 h-16 rounded-full bg-red-600/80 hover:bg-red-600 text-white flex items-center justify-center transition-all shadow-lg shadow-red-900/50"
                      title="Forlad voice">
                      <PhoneOff className="w-7 h-7" />
                    </button>
                    <button onClick={() => setIsDeafened(!isDeafened)}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isDeafened ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'}`}
                      title={isDeafened ? 'Undeafen' : 'Deafen'}>
                      {isDeafened ? <VolumeX className="w-7 h-7" /> : <Headphones className="w-7 h-7" />}
                    </button>
                    <button onClick={() => setIsCallFullscreen(f => !f)}
                      className="w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 shadow-green-900/30"
                      title={isCallFullscreen ? 'Forlad fuldskærm' : 'Fuldskærm'}>
                      {isCallFullscreen ? <Minimize2 className="w-7 h-7" /> : <Maximize className="w-7 h-7" />}
                    </button>
                  </div>
                  <div className="flex justify-center gap-6 text-sm pb-6 border-t border-green-900/30 pt-4">
                    <div className={`flex items-center gap-2 ${isMuted ? 'text-red-500' : 'text-green-700'}`}>
                      {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                      <span>{isMuted ? 'Muted' : 'Unmuted'}</span>
                    </div>
                    <div className={`flex items-center gap-2 ${isDeafened ? 'text-red-500' : 'text-green-700'}`}>
                      {isDeafened ? <VolumeX className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
                      <span>{isDeafened ? 'Deafened' : 'Listening'}</span>
                    </div>
                    <div className={`flex items-center gap-2 ${isCameraOn ? 'text-green-500' : 'text-green-700'}`}>
                      {isCameraOn ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
                      <span>{isCameraOn ? 'Camera On' : 'Camera Off'}</span>
                    </div>
                    <div className={`flex items-center gap-2 ${isScreenSharing ? 'text-green-500' : 'text-green-700'}`}>
                      <Share2 className="w-4 h-4" />
                      <span>{isScreenSharing ? 'Sharing' : 'Not Sharing'}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
              ) : currentTextRoom ? (
                /* ── Text chat view ─────────────────────────── */
                <>
                  {currentVoiceRoom && (
                    <div className="border-b border-green-900/30 px-4 py-2 bg-green-900/20 flex items-center gap-2 text-xs">
                      <Volume2 className="w-3.5 h-3.5 text-green-500" />
                      <span className="text-green-500">{currentVoiceRoom}</span>
                      <span className="text-green-700">{fmt(callDuration)}</span>
                      <button onClick={() => setViewModeTracked('voice')} className="ml-auto text-green-600 hover:text-green-400 transition-colors">
                        Vis voice
                      </button>
                      <button onClick={leaveVoice} className="text-red-500 hover:text-red-400 transition-colors ml-2">
                        <PhoneOff className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  <div className="border-b border-green-900/30 p-4 bg-[#0d120d]/40">
                <div className="flex items-center gap-2">
                  <Hash className="w-5 h-5" />
                  <span className="font-bold">{currentTextRoom}</span>
                  <span className="text-xs text-green-700 ml-2">{currentMessages.length} beskeder</span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-1">
                {currentMessages.map(msg => (
                  <div key={msg.id} className="group"
                    onContextMenu={(e) => {
                      if (msg.msgId && (msg.sender === nickname || hasPermission('delete_messages'))) {
                        e.preventDefault();
                        setMsgContextMenu({ msgId: msg.msgId, sender: msg.sender, room: currentTextRoom!, x: e.clientX, y: e.clientY });
                      }
                    }}>
                    <div className="flex gap-3 text-sm hover:bg-green-900/10 rounded px-2 py-1 -mx-2 transition-all">
                      <span className="text-green-400">{msg.text}</span>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
              <div className="border-t border-green-900/30 p-4 bg-[#0d120d]/40">
                <form onSubmit={handleSubmit} className="flex gap-3">
                  <span className="text-green-500">{'>'}</span>
                  <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)}
                    className="flex-1 bg-transparent outline-none text-green-500 placeholder-green-800"
                    placeholder="Skriv en besked..." autoComplete="off" />
                </form>
              </div>
            </>
          ) : (
            /* ── No room selected ───────────────────────── */
            <div className="flex-1 flex items-center justify-center text-green-700">
              <div className="text-center">
                <Terminal className="w-12 h-12 mx-auto mb-4 opacity-30" />
                <p>Vælg en kanal for at starte</p>
              </div>
            </div>
          )}
        </div>

        {/* ── Right sidebar: users ─────────────────────── */}
        <div className={`w-64 bg-[#0d120d]/60 backdrop-blur-sm rounded-lg overflow-y-auto shadow-lg shadow-green-900/10 ${isCallFullscreen && viewMode === 'voice' && currentVoiceRoom ? 'hidden' : ''}`}>
          <div className="p-4 border-b border-green-900/30">
            <div className="text-xs text-green-700">ONLINE — {onlineUsersList.length}</div>
          </div>
          <div className="p-3">
            {onlineUsersList.map(u => (
              <div key={u.name}
                className="px-4 py-2.5 flex items-center gap-3 hover:bg-green-900/20 rounded-lg transition-all mb-2"
                onContextMenu={(e) => { e.preventDefault(); setUserContextMenu({ userId: u.name, x: e.clientX, y: e.clientY }); }}>
                <Circle className="w-2 h-2 fill-current text-green-500" />
                <User className="w-4 h-4 text-green-700" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm truncate block" style={{ color: u.roleColor || '#22c55e' }}>{u.name}</span>
                  {u.roles.length > 0 && (
                    <span className="text-[10px] text-green-800 truncate block">{u.roles.join(', ')}</span>
                  )}
                  {u.voiceRoom && (
                    <span className="text-xs text-green-800">🔊 {u.voiceRoom}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {offlineUsersList.length > 0 && (
            <>
              <div className="p-4 border-b border-green-900/30 border-t border-green-900/30">
                <div className="text-xs text-green-800">OFFLINE — {offlineUsersList.length}</div>
              </div>
              <div className="p-3">
                {offlineUsersList.map(u => (
                  <div key={u.name} className="px-4 py-2.5 flex items-center gap-3 rounded-lg mb-2 opacity-40">
                    <Circle className="w-2 h-2 fill-current text-green-900" />
                    <User className="w-4 h-4 text-green-900" />
                    <span className="text-sm text-green-800 truncate">{u.name}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Footer status bar ──────────────────────────────── */}
      {!(isCallFullscreen && viewMode === 'voice' && currentVoiceRoom) && (
      <div className="bg-[#0d120d]/80 backdrop-blur-sm px-4 py-2 rounded-lg flex items-center gap-4 text-xs text-green-700 shadow-lg shadow-green-900/20">
        <span>STATUS: {isConnected ? 'CONNECTED' : 'DISCONNECTED'}</span>
        {currentTextRoom && <span>ROOM: #{currentTextRoom}</span>}
        {currentVoiceRoom && <span>🔊 {currentVoiceRoom} ({fmt(callDuration)})</span>}
        <span>USERS: {onlineUsersList.length}/{onlineUsers.length}</span>
        <span className="ml-auto">{status}</span>
      </div>
      )}
      </div>{/* end content wrapper */}

      {/* ── Settings Modal ─────────────────────────────────── */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className="bg-green-900/40 p-6 border-b border-green-900/50 flex items-center justify-between sticky top-0">
              <div className="flex items-center gap-3">
                <Settings className="w-6 h-6 text-green-500" />
                <h2 className="text-xl font-bold text-green-400">INDSTILLINGER</h2>
              </div>
              <button onClick={() => setShowSettings(false)}
                className="p-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-6">
              {/* Audio Settings */}
              <div>
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Headphones className="w-4 h-4" />
                  LYD INDSTILLINGER
                </h3>
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Mikrofon</label>
                    <select value={selectedInput}
                      onChange={e => { setSelectedInput(e.target.value); selectedInputRef.current = e.target.value; }}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option value="">Default Mikrofon</option>
                      {audioInputs.map(d => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 8)}`}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Output</label>
                    <select value={selectedOutput}
                      onChange={e => { setSelectedOutput(e.target.value); selectedOutputRef.current = e.target.value; }}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option value="">Default Output</option>
                      {audioOutputs.map(d => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || `Output ${d.deviceId.slice(0, 8)}`}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Mikrofon Aktivitet</label>
                    {currentVoiceRoom ? (
                      <>
                        <div className="w-full h-3 bg-green-900/30 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-75 ${micLevel > 0.6 ? 'bg-yellow-500' : 'bg-green-500'}`}
                            style={{ width: `${micLevel * 100}%` }} />
                        </div>
                        <span className="text-xs text-green-700 mt-1 block">
                          {micLevel > 0.05 ? '● Opfanger lyd' : '○ Ingen lyd'}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-green-800">Join en voice kanal for at teste mikrofon</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Video Settings */}
              <div className="pt-4 border-t border-green-900/30">
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Video className="w-4 h-4" />
                  VIDEO INDSTILLINGER
                </h3>
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Kamera</label>
                    <select value={selectedVideoInput}
                      onChange={e => { setSelectedVideoInput(e.target.value); selectedVideoInputRef.current = e.target.value; }}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option value="">Default Kamera</option>
                      {videoInputs.map(d => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || `Kamera ${d.deviceId.slice(0, 8)}`}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Opløsning</label>
                    <select value={videoResolution}
                      onChange={e => { const r = e.target.value as VideoResolution; setVideoResolution(r); videoResolutionRef.current = r; }}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      {Object.entries(VIDEO_RESOLUTIONS).map(([key, r]) => (
                        <option key={key} value={key}>{r.label} ({r.width}×{r.height})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-green-600 block mb-2">FPS</label>
                    <select value={videoFps}
                      onChange={e => { const f = parseInt(e.target.value) as VideoFps; setVideoFps(f); videoFpsRef.current = f; }}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      {VIDEO_FPS_OPTIONS.map(f => (
                        <option key={f} value={f}>{f} fps</option>
                      ))}
                    </select>
                  </div>
                  <div className="text-xs text-green-800 space-y-1">
                    <div>Opløsning: {VIDEO_RESOLUTIONS[videoResolution].width}×{VIDEO_RESOLUTIONS[videoResolution].height}</div>
                    <div>Billedhastighed: {videoFps} fps</div>
                    <div>Codec: H.264 (VP8 fallback)</div>
                    <div>Bitrate: {(getVideoBitrate(VIDEO_RESOLUTIONS[videoResolution].width, VIDEO_RESOLUTIONS[videoResolution].height, videoFps) / 1_000_000).toFixed(1)} Mbps</div>
                    <div>Transport: TCP (pålidelig)</div>
                  </div>
                </div>
              </div>

              {/* Notification Settings */}
              <div className="pt-4 border-t border-green-900/30">
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Bell className="w-4 h-4" />
                  NOTIFIKATIONER
                </h3>
                <div className="space-y-3 pl-6">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" defaultChecked
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                    <span className="text-sm text-green-500">Aktiver notifikationer</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" defaultChecked
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                    <span className="text-sm text-green-500">Lyd ved besked</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox"
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                    <span className="text-sm text-green-500">Kun mentions</span>
                  </label>
                </div>
              </div>

              {/* Appearance Settings */}
              <div className="pt-4 border-t border-green-900/30">
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Monitor className="w-4 h-4" />
                  UDSEENDE
                </h3>
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Tema Farve</label>
                    <select value={theme}
                      onChange={e => setTheme(e.target.value as ThemeColor)}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option value="green">Grøn (Standard)</option>
                      <option value="blue">Blå</option>
                      <option value="red">Rød</option>
                      <option value="purple">Lilla</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" defaultChecked
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                    <span className="text-sm text-green-500">Kompakt mode</span>
                  </label>
                </div>
              </div>

              {/* Keybind Settings */}
              <div className="pt-4 border-t border-green-900/30">
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Command className="w-4 h-4" />
                  GENVEJSTASTER
                </h3>
                <div className="space-y-3 pl-6">
                  {(['toggleMute', 'toggleDeafen'] as const).map(action => {
                    const labels: Record<string, string> = { toggleMute: 'Mute / Unmute', toggleDeafen: 'Deafen / Undeafen' };
                    const bind = keybinds[action];
                    const isRecording = recordingKeybind === action;
                    return (
                      <div key={action} className="flex items-center justify-between">
                        <span className="text-sm text-green-500">{labels[action]}</span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setRecordingKeybind(isRecording ? null : action)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all min-w-[120px] text-center ${
                              isRecording
                                ? 'bg-green-900/40 border-2 border-green-500 text-green-400 animate-pulse'
                                : bind
                                  ? 'bg-[#0a0e0a] border border-green-900/50 text-green-500 hover:border-green-700'
                                  : 'bg-[#0a0e0a] border border-green-900/50 text-green-800 hover:border-green-700'
                            }`}>
                            {isRecording ? 'Tryk en tast...' : bind ? formatKeyBind(bind) : 'Ikke sat'}
                          </button>
                          {bind && !isRecording && (
                            <button onClick={() => setKeybinds(prev => ({ ...prev, [action]: null }))}
                              className="p-1 text-green-800 hover:text-red-400 transition-colors">
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-[10px] text-green-800 pt-2">Klik på feltet og tryk den ønskede tast. Tryk Escape for at annullere.</p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-green-900/30 bg-[#0d120d]/40 flex justify-end gap-3">
              <button onClick={() => setShowSettings(false)}
                className="px-6 py-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all">
                Annuller
              </button>
              <button onClick={() => { if (currentVoiceRoom) restartAudio(); setShowSettings(false); }}
                className="px-6 py-2 rounded-lg bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-all font-bold">
                Gem Ændringer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── User Context Menu ────────────────────────────────── */}
      {userContextMenu && (() => {
        const menuWidth = 280;
        const menuHeight = 400;
        const x = Math.min(userContextMenu.x, window.innerWidth - menuWidth - 10);
        const y = Math.min(userContextMenu.y, window.innerHeight - menuHeight - 10);
        const setting = getUserSetting(userContextMenu.userId);
        const targetUser = onlineUsers.find(u => u.name === userContextMenu.userId);
        const targetRoles = targetUser?.roles || [];
        const isSelf = userContextMenu.userId === nickname;
        return (
          <div
            className="fixed bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-3 min-w-[240px] z-50"
            style={{ left: x, top: y }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3 pb-3 border-b border-green-900/30">
              <User className="w-4 h-4 text-green-500" />
              <span className="text-sm font-bold" style={{ color: targetUser?.roleColor || '#22c55e' }}>{userContextMenu.userId}</span>
              {targetRoles.length > 0 && (
                <span className="text-[10px] text-green-700 ml-auto">{targetRoles.join(', ')}</span>
              )}
            </div>
            {!isSelf && (
              <>
                <div className="mb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Volume2 className="w-4 h-4 text-green-500" />
                    <span className="text-xs text-green-600">Lydniveau</span>
                    <span className="ml-auto text-xs text-green-500">{setting.volume}%</span>
                  </div>
                  <input type="range" min="0" max="100" value={setting.volume}
                    onChange={(e) => updateUserSetting(userContextMenu.userId, { volume: parseInt(e.target.value) })}
                    className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer"
                    style={{ background: `linear-gradient(to right, var(--color-green-500) 0%, var(--color-green-500) ${setting.volume}%, var(--color-green-900) ${setting.volume}%, var(--color-green-900) 100%)` }} />
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); updateUserSetting(userContextMenu.userId, { isMuted: !setting.isMuted }); }}
                  className={`w-full px-4 py-2.5 rounded-lg transition-all flex items-center gap-2 mb-2 ${
                    setting.isMuted ? 'bg-red-900/40 text-red-400 hover:bg-red-900/60' : 'bg-green-900/20 text-green-500 hover:bg-green-900/40'
                  }`}>
                  {setting.isMuted ? <><MicOff className="w-4 h-4" /><span className="text-sm">Unmute Bruger</span></> : <><Mic className="w-4 h-4" /><span className="text-sm">Mute Bruger</span></>}
                </button>
              </>
            )}
            {/* Role management for admins */}
            {hasPermission('manage_roles') && !isSelf && (
              <div className="mb-2 pt-2 border-t border-green-900/30">
                <div className="text-xs text-green-700 mb-2">ROLLER</div>
                {serverRoles.map(role => {
                  const has = targetRoles.includes(role.name);
                  return (
                    <button key={role.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        const cmd = has ? 'REMOVE_ROLE' : 'ASSIGN_ROLE';
                        window.electronAPI.sendChat(`CMD:${cmd}:${userContextMenu.userId}:${role.name}`);
                      }}
                      className={`w-full px-3 py-1.5 rounded text-xs flex items-center gap-2 mb-1 transition-all ${
                        has ? 'bg-green-900/30 text-green-400' : 'text-green-700 hover:bg-green-900/20'
                      }`}>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: role.color }} />
                      <span>{role.name}</span>
                      {has && <span className="ml-auto text-green-600">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {/* Kick for admins */}
            {hasPermission('kick_users') && !isSelf && (
              <button
                onClick={(e) => { e.stopPropagation(); window.electronAPI.sendChat(`CMD:KICK_USER:${userContextMenu.userId}`); setUserContextMenu(null); }}
                className="w-full px-4 py-2 rounded-lg bg-red-900/20 text-red-400 hover:bg-red-900/40 transition-all flex items-center gap-2 mb-2">
                <PhoneOff className="w-4 h-4" />
                <span className="text-sm">Kick Bruger</span>
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setUserContextMenu(null); }}
              className="w-full px-4 py-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all flex items-center gap-2 justify-center">
              <X className="w-4 h-4" />
              <span className="text-sm">Luk</span>
            </button>
          </div>
        );
      })()}

      {/* ── Message Context Menu ─────────────────────────────── */}
      {msgContextMenu && (
        <div
          className="fixed bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-2 min-w-[160px] z-50"
          style={{ left: Math.min(msgContextMenu.x, window.innerWidth - 180), top: Math.min(msgContextMenu.y, window.innerHeight - 60) }}
          onClick={(e) => e.stopPropagation()}>
          <button onClick={() => {
              window.electronAPI.sendChat(`CMD:DELETE_MSG:${msgContextMenu.room}:${msgContextMenu.msgId}`);
              setMsgContextMenu(null);
            }}
            className="w-full px-4 py-2.5 rounded-lg text-red-400 hover:bg-red-900/40 transition-all flex items-center gap-2 text-sm">
            <Trash2 className="w-4 h-4" />
            <span>Slet besked</span>
          </button>
        </div>
      )}

      {/* ── Screen Share dialog overlay ────────────────────── */}
      {screenShareDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#0d120d] border border-green-900/50 rounded-lg w-[640px] max-h-[80vh] shadow-2xl shadow-green-900/30 flex flex-col">
            <div className="p-5 border-b border-green-900/30 flex items-center justify-between">
              <h3 className="text-green-400 font-bold flex items-center gap-2">
                <Share2 className="w-5 h-5" />
                Del Skærm
              </h3>
              <button onClick={() => setScreenShareDialog(false)} className="text-green-700 hover:text-green-400 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex border-b border-green-900/30">
              <button onClick={() => setSourceTab('screen')}
                className={`flex-1 py-3 text-sm font-bold transition-all ${sourceTab === 'screen' ? 'text-green-400 border-b-2 border-green-500 bg-green-900/20' : 'text-green-700 hover:text-green-500'}`}>
                <Monitor className="w-4 h-4 inline mr-2" />
                Skærme
              </button>
              <button onClick={() => setSourceTab('window')}
                className={`flex-1 py-3 text-sm font-bold transition-all ${sourceTab === 'window' ? 'text-green-400 border-b-2 border-green-500 bg-green-900/20' : 'text-green-700 hover:text-green-500'}`}>
                <Square className="w-4 h-4 inline mr-2" />
                Vinduer
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 min-h-[200px]">
              <div className="grid grid-cols-3 gap-3">
                {screenSources
                  .filter(s => sourceTab === 'screen' ? s.isScreen : !s.isScreen)
                  .map(source => (
                    <button key={source.id}
                      onClick={() => setSelectedSource(source.id)}
                      className={`rounded-lg overflow-hidden border-2 transition-all text-left ${
                        selectedSource === source.id
                          ? 'border-green-500 shadow-lg shadow-green-900/50'
                          : 'border-green-900/30 hover:border-green-700/50'}`}>
                      <img src={source.thumbnail} alt={source.name}
                        className="w-full aspect-video object-cover bg-black" />
                      <div className="px-2 py-1.5 bg-[#0a0e0a] flex items-center gap-1.5">
                        {source.appIcon && <img src={source.appIcon} className="w-4 h-4" alt="" />}
                        <span className="text-xs text-green-500 truncate">{source.name}</span>
                      </div>
                    </button>
                  ))}
              </div>
              {screenSources.filter(s => sourceTab === 'screen' ? s.isScreen : !s.isScreen).length === 0 && (
                <div className="text-center text-green-700 py-8 text-sm">
                  {screenSources.length === 0 ? 'Indlæser kilder...' : sourceTab === 'screen' ? 'Ingen skærme fundet' : 'Ingen vinduer fundet'}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-green-900/30 space-y-3">
              <div>
                <label className="text-xs text-green-600 block mb-2">Opløsning</label>
                <select value={screenShareResolution}
                  onChange={e => setScreenShareResolution(e.target.value as VideoResolution)}
                  className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 transition-all">
                  {Object.entries(VIDEO_RESOLUTIONS).map(([key, r]) => (
                    <option key={key} value={key}>{r.label} ({r.width}×{r.height})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-green-600 block mb-2">FPS</label>
                <select value={screenShareFps}
                  onChange={e => setScreenShareFps(parseInt(e.target.value) as VideoFps)}
                  className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 transition-all">
                  {VIDEO_FPS_OPTIONS.map(f => (
                    <option key={f} value={f}>{f} fps</option>
                  ))}
                </select>
                {serverInfo && (
                  <div className="text-xs text-green-800 mt-1">
                    Server maks: {serverInfo.maxScreenWidth}×{serverInfo.maxScreenHeight} @ {serverInfo.maxFps}fps
                  </div>
                )}
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-green-600">Bitrate</label>
                  <span className="text-xs text-green-500 font-mono">{screenShareBitrate} Kbps</span>
                </div>
                <input type="range" min="500" max={serverInfo ? Math.round(serverInfo.maxScreenBitrate / 1000) : 20000} step="500"
                  value={screenShareBitrate}
                  onChange={e => setScreenShareBitrate(parseInt(e.target.value))}
                  className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer accent-green-500" />
                <div className="flex justify-between text-[10px] text-green-800 mt-1">
                  <span>500 Kbps</span>
                  <span>{serverInfo ? Math.round(serverInfo.maxScreenBitrate / 1000) : 20000} Kbps (maks)</span>
                </div>
              </div>
              <label className="flex items-center gap-3 cursor-pointer py-1 px-3 rounded-lg hover:bg-green-900/20 transition-all">
                <input type="checkbox" checked={screenShareAudio}
                  onChange={e => setScreenShareAudio(e.target.checked)}
                  disabled={platform === 'darwin'}
                  className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 accent-green-600" />
                <div>
                  <span className="text-sm text-green-500">Del systemlyd</span>
                  <span className="block text-xs text-green-800">
                    {platform === 'darwin' ? 'Ikke understøttet på macOS' : 'Inkluder lyd fra din computer'}
                  </span>
                </div>
              </label>
            </div>
            <div className="flex justify-end gap-3 p-4 border-t border-green-900/30">
              <button onClick={() => setScreenShareDialog(false)}
                className="px-5 py-2 text-green-700 hover:text-green-500 transition-colors rounded-lg hover:bg-green-900/20">
                Annuller
              </button>
              <button onClick={() => startScreenShare()}
                disabled={!selectedSource}
                className="px-5 py-2 bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:text-green-800 text-green-400 rounded-lg transition-all font-bold flex items-center gap-2">
                <Share2 className="w-4 h-4" />
                Start Deling
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Password dialog overlay ────────────────────────── */}
      {pwDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#0d120d] border border-green-900/50 rounded-lg p-6 w-80 shadow-2xl shadow-green-900/30">
            <h3 className="text-green-400 font-bold mb-4">
              <Lock className="w-4 h-4 inline mr-2" />
              Password — {pwDialog.room}
            </h3>
            <input type="password" value={pwInput} onChange={e => setPwInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handlePwSubmit()}
              placeholder="Indtast password..."
              className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 mb-4"
              autoFocus />
            <div className="flex justify-end gap-3">
              <button onClick={() => setPwDialog(null)}
                className="px-4 py-2 text-green-700 hover:text-green-500 transition-colors">
                Cancel
              </button>
              <button onClick={handlePwSubmit}
                className="px-4 py-2 bg-green-900/40 hover:bg-green-900/60 text-green-400 rounded-lg transition-all">
                Join
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
