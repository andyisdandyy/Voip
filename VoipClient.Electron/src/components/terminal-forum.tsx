import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Terminal, Hash, User, Circle, Mic, MicOff, Headphones,
  Volume2, VolumeX, LogIn, PhoneOff, Lock,
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────

interface VoiceRoom { name: string; hasPassword: boolean; bitrate: number }
interface TextRoom  { name: string; hasPassword: boolean }
interface UserInfo  { name: string; voiceRoom: string | null }
interface ChatMsg   { id: string; text: string }

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

  // Input
  const [input, setInput] = useState('');

  // Password dialog
  const [pwDialog, setPwDialog] = useState<{ room: string; type: 'voice' | 'text' } | null>(null);
  const [pwInput, setPwInput]   = useState('');

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLInputElement>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const captureRef     = useRef<AudioWorkletNode | null>(null);
  const playbackRef    = useRef<AudioWorkletNode | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const isMutedRef     = useRef(false);
  const isDeafenedRef  = useRef(false);

  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { isDeafenedRef.current = isDeafened; }, [isDeafened]);

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
        setOnlineUsers(d.map((u: any) => ({ name: u.Name, voiceRoom: u.VoiceRoom || null })));
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
            text: `[${new Date(m.Time).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}] ${m.User}: ${m.Text}`,
          }));
          setRoomMessages(prev => ({ ...prev, [room]: [...formatted, ...(prev[room] || [])] }));
        } catch {}
      }
    } else if (line.startsWith('MSG:')) {
      const payload = line.substring(4);
      const idx = payload.indexOf(':');
      if (idx >= 0) {
        const room = payload.substring(0, idx);
        const text = payload.substring(idx + 1);
        setRoomMessages(prev => ({
          ...prev,
          [room]: [...(prev[room] || []), { id: crypto.randomUUID(), text }],
        }));
      }
    } else if (line.startsWith('ERROR:')) {
      setStatus(`⚠ ${line.substring(6)}`);
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
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 48000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    streamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: 48000 });
    audioCtxRef.current = ctx;

    await ctx.audioWorklet.addModule('/audio-capture-processor.js');
    await ctx.audioWorklet.addModule('/audio-playback-processor.js');

    // Capture mic → encode → send
    const source = ctx.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(ctx, 'capture-processor');
    capture.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (!isMutedRef.current) window.electronAPI.sendAudio(e.data);
    };
    source.connect(capture);
    // Connect through silent gain to keep worklet alive without echo
    const silent = ctx.createGain();
    silent.gain.value = 0;
    capture.connect(silent);
    silent.connect(ctx.destination);
    captureRef.current = capture;

    // Playback received audio
    const playback = new AudioWorkletNode(ctx, 'playback-processor');
    playback.connect(ctx.destination);
    playbackRef.current = playback;
  }

  function stopAudio() {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    captureRef.current = null;
    playbackRef.current = null;
  }

  // ── Call duration timer ───────────────────────────────────

  useEffect(() => {
    if (!currentVoiceRoom) { setCallDuration(0); return; }
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

  // ── Login ─────────────────────────────────────────────────

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim() || !serverIp.trim()) return;
    setConnecting(true);
    setStatus('Connecting...');
    try {
      await window.electronAPI.connectChat(serverIp, parseInt(tcpPort), nickname);
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
    if (room.name === currentVoiceRoom) return;
    if (room.hasPassword) { setPwDialog({ room: room.name, type: 'voice' }); setPwInput(''); }
    else window.electronAPI.sendChat(`CMD:JOIN_VOICE:${room.name}`);
  };

  const joinText = (room: TextRoom) => {
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
    stopAudio();
  };

  // ═════════════════════════════════════════════════════════
  //  LOGIN SCREEN
  // ═════════════════════════════════════════════════════════

  if (!isConnected) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0a0e0a] text-green-500 font-mono">
        <div className="w-full max-w-md">
          <div className="bg-[#0d120d]/80 backdrop-blur-sm rounded-lg shadow-2xl shadow-green-900/30 overflow-hidden">
            {/* Header */}
            <div className="bg-green-900/40 p-6 border-b border-green-900/50">
              <div className="flex items-center gap-3 mb-2">
                <Terminal className="w-8 h-8" />
                <div>
                  <h1 className="text-xl font-bold">MEICHAT</h1>
                  <p className="text-xs text-green-700">v1.0.0 — Login</p>
                </div>
              </div>
            </div>

            {/* Form */}
            <form onSubmit={handleLogin} className="p-8 space-y-5">
              <div className="space-y-2">
                <label className="text-xs text-green-700 block">{'>'} NICKNAME</label>
                <input type="text" value={nickname} onChange={e => setNickname(e.target.value)}
                  placeholder="Indtast dit nickname..."
                  className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                  autoFocus />
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

              <button type="submit" disabled={!nickname.trim() || !serverIp.trim() || connecting}
                className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                <LogIn className="w-5 h-5" />
                {connecting ? 'CONNECTING...' : 'CONNECT'}
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
            <p>Indtast dine credentials for at tilslutte serveren</p>
          </div>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════
  //  MAIN UI
  // ═════════════════════════════════════════════════════════

  const isViewingVoice = currentVoiceRoom !== null;

  return (
    <div className="h-screen flex flex-col bg-[#0a0e0a] text-green-500 font-mono p-4 gap-4">

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="bg-[#0d120d]/80 backdrop-blur-sm p-4 rounded-lg flex items-center gap-2 shadow-lg shadow-green-900/20">
        <Terminal className="w-5 h-5" />
        <span className="text-sm">MEICHAT v1.0.0</span>
        <span className="text-xs text-green-700 ml-2">— {nickname}</span>
        <span className="ml-auto text-xs text-green-700">{new Date().toLocaleString('da-DK')}</span>
        <button onClick={disconnect}
          className="ml-4 text-xs text-red-500 hover:text-red-400 transition-colors">
          DISCONNECT
        </button>
      </div>

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
              {voiceRooms.map(r => (
                <button key={r.name} onClick={() => joinVoice(r)}
                  className={`w-full text-left px-4 py-2.5 rounded-lg mb-2 flex items-center gap-2 transition-all ${
                    currentVoiceRoom === r.name
                      ? 'bg-green-900/40 text-green-400 shadow-md shadow-green-900/30'
                      : 'hover:bg-green-900/20 text-green-600'
                  }`}>
                  {r.hasPassword ? <Lock className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                  <span className="text-sm truncate">{r.name}</span>
                  {r.bitrate > 0 && <span className="ml-auto text-xs text-green-800">{r.bitrate / 1000}k</span>}
                </button>
              ))}
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
              <button onClick={() => setIsDeafened(!isDeafened)}
                className={`p-2 rounded-lg transition-all ${isDeafened ? 'bg-red-900/40 text-red-500 hover:bg-red-900/60' : 'bg-green-900/20 text-green-600 hover:bg-green-900/40'}`}
                title={isDeafened ? 'Undeafen' : 'Deafen'}>
                {isDeafened ? <VolumeX className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* ── Center panel ────────────────────────────────── */}
        <div className="flex-1 flex flex-col bg-[#0d120d]/60 backdrop-blur-sm rounded-lg overflow-hidden shadow-lg shadow-green-900/10">
          {isViewingVoice ? (
            /* ── Voice call screen ──────────────────────── */
            <div className="flex-1 flex flex-col items-center justify-center p-12">
              <div className="flex justify-center mb-8">
                <div className="w-40 h-40 rounded-full bg-green-900/40 flex items-center justify-center ring-4 ring-green-900/50 shadow-lg shadow-green-900/50">
                  <User className="w-20 h-20 text-green-500" />
                </div>
              </div>
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-green-400 mb-2">{nickname}</h2>
                <p className="text-sm text-green-700">Connected to: {currentVoiceRoom}</p>
              </div>
              <div className="text-center mb-12">
                <div className="text-5xl font-mono text-green-500 font-bold">{fmt(callDuration)}</div>
                <div className="text-xs text-green-700 mt-2">Call Duration</div>
              </div>
              <div className="flex justify-center gap-4 mb-6">
                <button onClick={() => setIsMuted(!isMuted)}
                  className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${isMuted ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'}`}
                  title={isMuted ? 'Unmute' : 'Mute'}>
                  {isMuted ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
                </button>
                <button onClick={leaveVoice}
                  className="w-16 h-16 rounded-full bg-red-600/80 hover:bg-red-600 text-white flex items-center justify-center transition-all shadow-lg shadow-red-900/50"
                  title="Leave Voice">
                  <PhoneOff className="w-7 h-7" />
                </button>
                <button onClick={() => setIsDeafened(!isDeafened)}
                  className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${isDeafened ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'}`}
                  title={isDeafened ? 'Undeafen' : 'Deafen'}>
                  {isDeafened ? <VolumeX className="w-7 h-7" /> : <Headphones className="w-7 h-7" />}
                </button>
              </div>
              <div className="flex justify-center gap-6 text-sm">
                <div className={`flex items-center gap-2 ${isMuted ? 'text-red-500' : 'text-green-700'}`}>
                  {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  <span>{isMuted ? 'Muted' : 'Unmuted'}</span>
                </div>
                <div className={`flex items-center gap-2 ${isDeafened ? 'text-red-500' : 'text-green-700'}`}>
                  {isDeafened ? <VolumeX className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
                  <span>{isDeafened ? 'Deafened' : 'Listening'}</span>
                </div>
              </div>
              {/* Show text chat below voice if a text room is selected */}
              {currentTextRoom && (
                <div className="w-full mt-8 border-t border-green-900/30 pt-4">
                  <button onClick={() => setCurrentVoice(prev => prev)} className="text-xs text-green-700 mb-2">
                    💬 #{currentTextRoom}
                  </button>
                </div>
              )}
            </div>
          ) : currentTextRoom ? (
            /* ── Text chat view ─────────────────────────── */
            <>
              <div className="border-b border-green-900/30 p-4 bg-[#0d120d]/40">
                <div className="flex items-center gap-2">
                  <Hash className="w-5 h-5" />
                  <span className="font-bold">{currentTextRoom}</span>
                  <span className="text-xs text-green-700 ml-2">{currentMessages.length} beskeder</span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-3">
                {currentMessages.map(msg => (
                  <div key={msg.id} className="group">
                    <div className="flex gap-3 text-sm">
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

        {/* ── Right sidebar: online users ─────────────────── */}
        <div className="w-64 bg-[#0d120d]/60 backdrop-blur-sm rounded-lg overflow-y-auto shadow-lg shadow-green-900/10">
          <div className="p-4 border-b border-green-900/30">
            <div className="text-xs text-green-700">ONLINE BRUGERE ({onlineUsers.length})</div>
          </div>
          <div className="p-3">
            {onlineUsers.map(u => (
              <div key={u.name}
                className="px-4 py-2.5 flex items-center gap-3 hover:bg-green-900/20 rounded-lg transition-all mb-2">
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
        </div>
      </div>

      {/* ── Footer status bar ──────────────────────────────── */}
      <div className="bg-[#0d120d]/80 backdrop-blur-sm px-4 py-2 rounded-lg flex items-center gap-4 text-xs text-green-700 shadow-lg shadow-green-900/20">
        <span>STATUS: {isConnected ? 'CONNECTED' : 'DISCONNECTED'}</span>
        {currentTextRoom && <span>ROOM: #{currentTextRoom}</span>}
        {currentVoiceRoom && <span>🔊 {currentVoiceRoom} ({fmt(callDuration)})</span>}
        <span>USERS: {onlineUsers.length}</span>
        <span className="ml-auto">{status}</span>
      </div>

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
