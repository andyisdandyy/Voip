import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Terminal, Hash, User, Circle, Mic, MicOff, Headphones,
  Volume2, VolumeX, LogIn, PhoneOff, Lock, Settings, X, Bell, Monitor,
  Trash2, UserPlus, Video, VideoOff, Share2, Minus, Square,
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────

interface VoiceRoom { name: string; hasPassword: boolean; bitrate: number }
interface TextRoom  { name: string; hasPassword: boolean }
interface UserInfo  { name: string; voiceRoom: string | null; online: boolean }
interface ChatMsg   { id: string; text: string; msgId: string; sender: string }
interface UserContextMenu { userId: string; x: number; y: number }
interface MsgContextMenu { msgId: string; sender: string; room: string; x: number; y: number }
interface UserSetting { name: string; volume: number; isMuted: boolean }

const VIDEO_PRESETS = {
  low:    { label: 'Lav (480p)',         width: 854,  height: 480,  frameRate: 15, jpegQuality: 0.72, interval: 67  },
  medium: { label: 'Medium (720p)',      width: 1280, height: 720,  frameRate: 24, jpegQuality: 0.82, interval: 42  },
  high:   { label: 'Høj (1080p)',        width: 1920, height: 1080, frameRate: 30, jpegQuality: 0.88, interval: 33  },
} as const;
type VideoQuality = keyof typeof VIDEO_PRESETS;

// ── Component ───────────────────────────────────────────────

export function TerminalForum() {
  // Connection
  const [isConnected, setIsConnected] = useState(false);
  const [nickname, setNickname]       = useState('');
  const [serverIp, setServerIp]       = useState('86.52.25.44');
  const [udpPort, setUdpPort]         = useState('5000');
  const [tcpPort, setTcpPort]         = useState('5001');
  const [status, setStatus]           = useState('Awaiting connection');
  const [connecting, setConnecting]   = useState(false);

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

  // Voice controls
  const [isMuted, setIsMuted]       = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [viewMode, setViewMode] = useState<'voice' | 'text'>('text');

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
  const [videoQuality, setVideoQuality] = useState<VideoQuality>('high');

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLInputElement>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const captureRef     = useRef<AudioWorkletNode | null>(null);
  const playbackRef    = useRef<AudioWorkletNode | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const isMutedRef     = useRef(false);
  const isDeafenedRef  = useRef(false);
  const selectedInputRef  = useRef('');
  const selectedOutputRef = useRef('');
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micLevelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const captureVideoElRef = useRef<HTMLVideoElement | null>(null);
  const videoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoUrlsRef = useRef<Record<string, string>>({});
  const activeVideosRef = useRef<Set<string>>(new Set());
  const videoTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const selectedVideoInputRef = useRef('');
  const videoQualityRef = useRef<VideoQuality>('high');
  const viewModeRef = useRef<'voice' | 'text'>('text');
  const setViewModeTracked = (mode: 'voice' | 'text') => { viewModeRef.current = mode; setViewMode(mode); };
  const captureTypeRef = useRef<'none' | 'camera' | 'screen'>('none');

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

  useEffect(() => {
    const handleClick = () => { setUserContextMenu(null); setMsgContextMenu(null); };
    if (userContextMenu || msgContextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [userContextMenu, msgContextMenu]);

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
    if (line.startsWith('ROOMS:')) {
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
        setOnlineUsers(d.map((u: any) => ({ name: u.Name, voiceRoom: u.VoiceRoom || null, online: u.Online !== false })));
      } catch {}
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
      const oldUrl = videoUrlsRef.current[user];
      if (oldUrl) { URL.revokeObjectURL(oldUrl); delete videoUrlsRef.current[user]; }
    } else if (line.startsWith('SCREEN_ON:')) {
      const user = line.substring(10);
      setScreenUsers(prev => new Set(prev).add(user));
      if (viewModeRef.current !== 'voice') setViewModeTracked('voice');
    } else if (line.startsWith('SCREEN_OFF:')) {
      const user = line.substring(11);
      setScreenUsers(prev => { const s = new Set(prev); s.delete(user); return s; });
      activeVideosRef.current.delete(user);
      setActiveVideos(new Set(activeVideosRef.current));
      const oldUrl = videoUrlsRef.current[user];
      if (oldUrl) { URL.revokeObjectURL(oldUrl); delete videoUrlsRef.current[user]; }
    }
  }, []);

  // ── IPC subscriptions ─────────────────────────────────────

  useEffect(() => {
    const unsubs = [
      window.electronAPI.onChatMessage(handleServerMessage),
      window.electronAPI.onChatError((msg) => { setStatus(`Error: ${msg}`); setIsConnected(false); }),
      window.electronAPI.onChatDisconnected(() => {
        setIsConnected(false);
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
      window.electronAPI.onVideoReceived((senderName: string, jpegData: Uint8Array) => {
        const blob = new Blob([jpegData], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const old = videoUrlsRef.current[senderName];
        if (old) URL.revokeObjectURL(old);
        videoUrlsRef.current[senderName] = url;

        const img = document.getElementById(`vf-${senderName}`) as HTMLImageElement | null;
        if (img) img.src = url;

        if (!activeVideosRef.current.has(senderName)) {
          activeVideosRef.current.add(senderName);
          setActiveVideos(new Set(activeVideosRef.current));
        }
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [handleServerMessage]);

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

      await ctx.audioWorklet.addModule('/audio-capture-processor.js');
      await ctx.audioWorklet.addModule('/audio-playback-processor.js');

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

  async function startCamera() {
    if (captureTypeRef.current !== 'none') stopVideoCapture();
    try {
      const preset = VIDEO_PRESETS[videoQualityRef.current];
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: selectedVideoInputRef.current ? { exact: selectedVideoInputRef.current } : undefined,
          width: preset.width, height: preset.height,
          frameRate: { ideal: preset.frameRate, max: preset.frameRate },
        }
      });
      cameraStreamRef.current = stream;
      const videoEl = document.createElement('video');
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.playsInline = true;
      await videoEl.play();
      captureVideoElRef.current = videoEl;
      const canvas = document.createElement('canvas');
      canvas.width = preset.width;
      canvas.height = preset.height;
      const ctx = canvas.getContext('2d')!;
      videoIntervalRef.current = setInterval(() => {
        if (videoEl.readyState >= 2) {
          ctx.drawImage(videoEl, 0, 0, preset.width, preset.height);
          canvas.toBlob(blob => {
            if (blob) blob.arrayBuffer().then(buf => window.electronAPI.sendVideo(buf));
          }, 'image/jpeg', preset.jpegQuality);
        }
      }, preset.interval);
      captureTypeRef.current = 'camera';
      setIsCameraOn(true);
      window.electronAPI.sendChat('CMD:CAMERA_ON');
    } catch (err) {
      console.error('[Camera] Failed:', err);
    }
  }

  async function startScreenShare() {
    if (captureTypeRef.current !== 'none') stopVideoCapture();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      const videoEl = document.createElement('video');
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.playsInline = true;
      await videoEl.play();
      captureVideoElRef.current = videoEl;
      const settings = stream.getVideoTracks()[0]?.getSettings();
      const w = settings?.width || 1920;
      const h = settings?.height || 1080;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx2 = canvas.getContext('2d')!;
      videoIntervalRef.current = setInterval(() => {
        if (videoEl.readyState >= 2) {
          ctx2.drawImage(videoEl, 0, 0, w, h);
          canvas.toBlob(blob => {
            if (blob) blob.arrayBuffer().then(buf => window.electronAPI.sendVideo(buf));
          }, 'image/jpeg', 0.75);
        }
      }, 67);
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
    if (captureVideoElRef.current) {
      captureVideoElRef.current.pause();
      captureVideoElRef.current.srcObject = null;
      captureVideoElRef.current = null;
    }
    cameraStreamRef.current?.getTracks().forEach(t => t.stop());
    cameraStreamRef.current = null;
    if (captureTypeRef.current === 'camera') window.electronAPI.sendChat('CMD:CAMERA_OFF');
    if (captureTypeRef.current === 'screen') window.electronAPI.sendChat('CMD:SCREEN_OFF');
    captureTypeRef.current = 'none';
    setIsCameraOn(false);
    setIsScreenSharing(false);
  }

  function cleanupVideo() {
    Object.values(videoUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
    videoUrlsRef.current = {};
    Object.values(videoTimeoutsRef.current).forEach(clearTimeout);
    videoTimeoutsRef.current = {};
    activeVideosRef.current.clear();
    setActiveVideos(new Set());
    setCameraUsers(new Set());
    setScreenUsers(new Set());
  }

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
    if (!currentVoiceRoom) { setCallDuration(0); setViewModeTracked('text'); setIsScreenSharing(false); setSelectedVideoFeed(null); return; }
    const iv = setInterval(() => setCallDuration(d => d + 1), 1000);
    return () => clearInterval(iv);
  }, [currentVoiceRoom]);

  // ── Auto‑scroll ───────────────────────────────────────────

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [roomMessages, currentTextRoom]);

  // ── Helpers ───────────────────────────────────────────────

  const fmt = (s: number) => {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const fmtTime = (d: Date) => d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const currentMessages = currentTextRoom ? (roomMessages[currentTextRoom] || []) : [];
  const usersInRoom = onlineUsers.filter(u => u.online && u.voiceRoom === currentVoiceRoom);
  const gridCols = usersInRoom.length <= 1 ? 'grid-cols-1' : usersInRoom.length <= 4 ? 'grid-cols-2' : 'grid-cols-3';
  const isVideoMode = isCameraOn || isScreenSharing || cameraUsers.size > 0 || screenUsers.size > 0;
  const onlineUsersList = onlineUsers.filter(u => u.online);
  const offlineUsersList = onlineUsers.filter(u => !u.online);

  // ── Login ─────────────────────────────────────────────────

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim() || !serverIp.trim() || !password.trim()) return;
    setConnecting(true);
    setStatus(isRegister ? 'Registering...' : 'Logging in...');
    try {
      await window.electronAPI.connectChat(serverIp, parseInt(tcpPort), nickname, password, isRegister);
      await window.electronAPI.startVoice(serverIp, parseInt(udpPort), nickname);
      setIsConnected(true);
      setStatus('Connected');
    } catch (err: any) {
      setStatus(`Failed: ${err.message}`);
    }
    setConnecting(false);
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
    stopAudio();
  };

  // ═════════════════════════════════════════════════════════
  //  LOGIN SCREEN
  // ═════════════════════════════════════════════════════════

  if (!isConnected) {
    return (
      <div className="h-screen flex flex-col bg-[#0a0e0a] text-green-500 font-mono">
        {/* ── Draggable titlebar ── */}
        <div className="flex items-center bg-[#0d120d] border-b border-green-900/30 select-none"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
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
        </div>
        <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-md">
          <div className="bg-[#0d120d]/80 backdrop-blur-sm rounded-lg shadow-2xl shadow-green-900/30 overflow-hidden">
            {/* Header */}
            <div className="bg-green-900/40 p-6 border-b border-green-900/50">
              <div className="flex items-center gap-3 mb-2">
                <Terminal className="w-8 h-8" />
                <div>
                  <h1 className="text-xl font-bold">MEICHAT</h1>
                  <p className="text-xs text-green-700">v1.0.0</p>
                </div>
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

            {/* Form */}
            <form onSubmit={handleLogin} className="p-8 space-y-5">
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

              <div className="space-y-2">
                <label className="text-xs text-green-700 block">{'>'} SERVER IP</label>
                <input type="text" value={serverIp} onChange={e => setServerIp(e.target.value)}
                  placeholder="86.52.25.44"
                  className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all" />
              </div>

              <div className="flex gap-4">
                <div className="flex-1 space-y-2">
                  <label className="text-xs text-green-700 block">{'>'} UDP PORT</label>
                  <input type="text" value={udpPort} onChange={e => setUdpPort(e.target.value)}
                    className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all" />
                </div>
                <div className="flex-1 space-y-2">
                  <label className="text-xs text-green-700 block">{'>'} TCP PORT</label>
                  <input type="text" value={tcpPort} onChange={e => setTcpPort(e.target.value)}
                    className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all" />
                </div>
              </div>

              <button type="submit" disabled={!nickname.trim() || !serverIp.trim() || !password.trim() || connecting}
                className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                {isRegister ? <UserPlus className="w-5 h-5" /> : <LogIn className="w-5 h-5" />}
                {connecting ? (isRegister ? 'REGISTERER...' : 'LOGGER IND...') : (isRegister ? 'REGISTRER' : 'LOG IND')}
              </button>

              <div className="pt-4 border-t border-green-900/30">
                <div className="text-xs text-green-700 space-y-1">
                  <div>{'>'} Status: <span className="text-green-500">{status}</span></div>
                  <div>{'>'} Protocol: <span className="text-green-500">UDP + TCP</span></div>
                </div>
              </div>
            </form>
          </div>

          <div className="mt-6 text-center text-xs text-green-700">
            <p>Indtast dine credentials for at {isRegister ? 'oprette en konto' : 'logge ind'}</p>
          </div>
        </div>
        </div>{/* end login center wrapper */}
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════
  //  MAIN UI
  // ═════════════════════════════════════════════════════════

  return (
   <div className="h-screen flex flex-col bg-[#0a0e0a] text-green-500 font-mono">

     {/* ── Draggable titlebar ─────────────────────────────── */}
     <div className="flex items-center bg-[#0d120d] border-b border-green-900/30 select-none"
       style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
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
     </div>

     {/* ── Main content wrapper with padding ──────────────── */}
     <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">

      {/* ── Main content ───────────────────────────────────── */}
      <div className="flex-1 flex gap-4 overflow-hidden">

        {/* ── Left sidebar: rooms ─────────────────────────── */}
        <div className="w-64 bg-[#0d120d]/60 backdrop-blur-sm rounded-lg shadow-lg shadow-green-900/10 flex flex-col">
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
                  <div className={`flex-1 grid gap-4 mb-4 ${
                    usersInRoom.length === 1 ? 'grid-cols-1' :
                    usersInRoom.length === 2 ? 'grid-cols-2' :
                    usersInRoom.length <= 4 ? 'grid-cols-2 grid-rows-2' :
                    usersInRoom.length <= 6 ? 'grid-cols-3 grid-rows-2' :
                    'grid-cols-3 grid-rows-3'
                  }`}>
                    {usersInRoom.map(u => {
                      const isLocal = u.name === nickname;
                      const isSelected = selectedVideoFeed === u.name;
                      return (
                        <div key={u.name}
                          onClick={() => setSelectedVideoFeed(isSelected ? null : u.name)}
                          className={`relative bg-[#0a0e0a] rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                            isSelected
                              ? 'col-span-2 row-span-2 border-green-500 shadow-lg shadow-green-900/50'
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
                                <img id={`vf-${u.name}`} className="absolute inset-0 w-full h-full object-contain"
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
                        isCameraOn ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30' : 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50'}`}
                      title={isCameraOn ? 'Sluk kamera' : 'Tænd kamera'}>
                      {isCameraOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
                    </button>
                    <button onClick={() => isScreenSharing ? stopVideoCapture() : startScreenShare()}
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
                    <button onClick={() => isScreenSharing ? stopVideoCapture() : startScreenShare()}
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
                      if (msg.msgId && msg.sender === nickname) {
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
        <div className="w-64 bg-[#0d120d]/60 backdrop-blur-sm rounded-lg overflow-y-auto shadow-lg shadow-green-900/10">
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
                  <span className="text-sm text-green-600 truncate block">{u.name}</span>
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
      <div className="bg-[#0d120d]/80 backdrop-blur-sm px-4 py-2 rounded-lg flex items-center gap-4 text-xs text-green-700 shadow-lg shadow-green-900/20">
        <span>STATUS: {isConnected ? 'CONNECTED' : 'DISCONNECTED'}</span>
        {currentTextRoom && <span>ROOM: #{currentTextRoom}</span>}
        {currentVoiceRoom && <span>🔊 {currentVoiceRoom} ({fmt(callDuration)})</span>}
        <span>USERS: {onlineUsersList.length}/{onlineUsers.length}</span>
        <span className="ml-auto">{status}</span>
      </div>
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
                    <label className="text-xs text-green-600 block mb-2">Kvalitet</label>
                    <select value={videoQuality}
                      onChange={e => { const q = e.target.value as VideoQuality; setVideoQuality(q); videoQualityRef.current = q; }}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      {Object.entries(VIDEO_PRESETS).map(([key, p]) => (
                        <option key={key} value={key}>{p.label} — {p.frameRate} fps</option>
                      ))}
                    </select>
                  </div>
                  <div className="text-xs text-green-800 space-y-1">
                    <div>Opløsning: {VIDEO_PRESETS[videoQuality].width}×{VIDEO_PRESETS[videoQuality].height}</div>
                    <div>Billedhastighed: {VIDEO_PRESETS[videoQuality].frameRate} fps</div>
                    <div>JPEG kvalitet: {Math.round(VIDEO_PRESETS[videoQuality].jpegQuality * 100)}%</div>
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
                    <select className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option>Grøn (Standard)</option>
                      <option>Blå</option>
                      <option>Rød</option>
                      <option>Lilla</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" defaultChecked
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                    <span className="text-sm text-green-500">Kompakt mode</span>
                  </label>
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
        const menuWidth = 240;
        const menuHeight = 250;
        const x = Math.min(userContextMenu.x, window.innerWidth - menuWidth - 10);
        const y = Math.min(userContextMenu.y, window.innerHeight - menuHeight - 10);
        const setting = getUserSetting(userContextMenu.userId);
        return (
          <div
            className="fixed bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-3 min-w-[240px] z-50"
            style={{ left: x, top: y }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3 pb-3 border-b border-green-900/30">
              <User className="w-4 h-4 text-green-500" />
              <span className="text-sm text-green-400 font-bold">{userContextMenu.userId}</span>
            </div>
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-2">
                <Volume2 className="w-4 h-4 text-green-500" />
                <span className="text-xs text-green-600">Lydniveau</span>
                <span className="ml-auto text-xs text-green-500">{setting.volume}%</span>
              </div>
              <input type="range" min="0" max="100" value={setting.volume}
                onChange={(e) => updateUserSetting(userContextMenu.userId, { volume: parseInt(e.target.value) })}
                className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer"
                style={{ background: `linear-gradient(to right, #22c55e 0%, #22c55e ${setting.volume}%, #1a3d1a ${setting.volume}%, #1a3d1a 100%)` }} />
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); updateUserSetting(userContextMenu.userId, { isMuted: !setting.isMuted }); }}
              className={`w-full px-4 py-2.5 rounded-lg transition-all flex items-center gap-2 mb-2 ${
                setting.isMuted ? 'bg-red-900/40 text-red-400 hover:bg-red-900/60' : 'bg-green-900/20 text-green-500 hover:bg-green-900/40'
              }`}>
              {setting.isMuted ? <><MicOff className="w-4 h-4" /><span className="text-sm">Unmute Bruger</span></> : <><Mic className="w-4 h-4" /><span className="text-sm">Mute Bruger</span></>}
            </button>
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
