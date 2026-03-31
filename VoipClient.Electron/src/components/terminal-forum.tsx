import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import {
  Terminal, Hash, User, Circle, Mic, MicOff, Headphones,
  Volume2, VolumeX, LogIn, PhoneOff, Lock, Settings, X, Bell, BellOff, Monitor,
  Trash2, UserPlus, Video, VideoOff, Share2, Minus, Square, Maximize, Minimize2,
  Plus, LogOut, Command, Wifi, WifiOff, Home, Paperclip, Download, FileText, Send, Smile, Moon, Image as ImageIcon,
  Music, Upload, Play, Trash, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, Shield, Sliders, Users, Check,
  PanelRightClose, PanelRightOpen, ExternalLink, Pin, Pencil, SmilePlus, RefreshCw,
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────

interface VoiceRoom { name: string; allowedRoles: string[]; bitrate: number }
interface TextRoom  { name: string; allowedRoles: string[] }
interface UserInfo  { name: string; voiceRoom: string | null; online: boolean; status: 'online' | 'away' | 'offline'; roles: string[]; roleColor: string | null; avatar: string | null; muted: boolean; deafened: boolean }
interface ChatMsg   { id: string; msgId: string; sender: string; body: string; timestamp: number; edited?: boolean }
interface UserContextMenu { userId: string; x: number; y: number }
interface MsgContextMenu { msgId: string; sender: string; room: string; x: number; y: number }
interface UserSetting { name: string; volume: number; isMuted: boolean; soundboardMuted: boolean; screenMuted: boolean; screenVolume: number }
interface PinnedServer { id: string; name: string; address: string; username?: string; password?: string; serverPassword?: string; autoConnect?: boolean; autoConnectTcp?: boolean; logo?: string; authToken?: string; ssePort?: number; trusted?: boolean }
interface ServerInfo { serverName: string; serverLogo?: string; voiceHost: string; udpPort: number; maxCameraWidth: number; maxCameraHeight: number; maxScreenWidth: number; maxScreenHeight: number; maxFps: number; maxScreenBitrate: number; maxFileSizeKB: number; maxSoundSizeKB: number; defaultBitrate: number; giphyApiKey?: string; ssePort?: number; fileServerPort?: number }
interface ServerContextMenu { serverId: string; x: number; y: number }
interface RoleInfo { name: string; color: string; priority: number; permissions: string[] }
interface KeyBind { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
interface DmTab { username: string; serverId: string }
interface DmMessage { id: string; sender: string; body: string; timestamp: number }
interface Friend { username: string; serverId: string }

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

type ThemeColor = 'mono' | 'light' | 'custom';

interface CustomThemeColors { accent: string; bg: string; surface: string; sidebar: string; border: string; text: string; textSecondary: string }
const DEFAULT_CUSTOM_THEME: CustomThemeColors = { accent: '#3b82f6', bg: '#1a1a1a', surface: '#242424', sidebar: '#1e1e1e', border: '#333333', text: '#e0e0e0', textSecondary: '#888888' };

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function generateScale(hex: string): Record<string, string> {
  const [h, s] = hexToHsl(hex);
  const lightnesses = { '50': 96, '100': 90, '200': 80, '300': 70, '400': 58, '500': 48, '600': 40, '700': 32, '800': 25, '900': 18, '950': 10 };
  const result: Record<string, string> = {};
  for (const [key, l] of Object.entries(lightnesses)) result[key] = hslToHex(h, s, l);
  return result;
}

function hexToRgb(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`;
}

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

// Standard emoji shortcode map
const EMOJI_SHORTCODES: Record<string, string> = {
  grinning: '😀', joy: '😂', sweat_smile: '😅', blush: '😊', sunglasses: '😎', heart_eyes: '😍',
  partying: '🥳', sob: '😭', rage: '😤', thinking: '🤔', exploding_head: '🤯', pleading: '🥺',
  sleeping: '😴', clown: '🤡', thumbsup: '👍', thumbsdown: '👎', clap: '👏', raised_hands: '🙌',
  handshake: '🤝', peace: '✌️', call_me: '🤙', muscle: '💪', heart: '❤️', fire: '🔥',
  star: '⭐', hundred: '💯', tada: '🎉', notes: '🎶', skull: '💀', eyes: '👀',
  salute: '🫡', melting: '🫠', imp: '😈', poop: '💩', robot: '🤖', alien: '👾',
  goat: '🐐', fox: '🦊', cat: '🐱', dog: '🐶', coffee: '☕', pizza: '🍕',
  beer: '🍺', gaming: '🎮', computer: '💻', tools: '🛠️', zap: '⚡', check: '✅',
  x: '❌', warning: '⚠️', speech: '💬', pin: '📌', rocket: '🚀', earth: '🌍',
  moon: '🌙', sun: '☀️', rainbow: '🌈', gem: '💎', laugh: '😂', laughing: '😂',
  smile: '😊', wink: '😉', cool: '😎', cry: '😭', angry: '😤', think: '🤔',
  love: '❤️', ok: '👍', no: '👎', wave: '👋', pray: '🙏', shrug: '🤷',
  facepalm: '🤦', roll_eyes: '🙄', nerd: '🤓', money: '🤑', sick: '🤢',
  devil: '😈', angel: '😇', poo: '💩', ghost: '👻', party: '🥳',
  '+1': '👍', '-1': '👎', 'thumbs_up': '👍', 'thumbs_down': '👎',
};

// ── Blob URL media player ─────────────────────────────────
// Converts base64 data to a Blob URL for reliable <video>/<audio> playback.
// Data URLs fail for large media and Chromium doesn't recognise video/quicktime.
const BlobMedia = memo(function BlobMedia({ type, base64, mimeType, className }: { type: 'video' | 'audio'; base64: string; mimeType: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      // Normalise MIME: Chromium only accepts video/mp4, not video/quicktime
      let normalized = mimeType;
      if (normalized === 'video/quicktime' || normalized === 'video/x-m4v') normalized = 'video/mp4';
      const blob = new Blob([bytes], { type: normalized });
      const url = URL.createObjectURL(blob);
      setSrc(url);
      return () => URL.revokeObjectURL(url);
    } catch {
      setSrc(`data:${mimeType};base64,${base64}`);
    }
  }, [base64, mimeType]);
  if (!src) return null;
  if (type === 'video') return <video src={src} controls preload="metadata" className={className} />;
  return <audio src={src} controls preload="metadata" className={className} />;
});

// ── EditInput — inline message edit field ───────────────────

function EditInput({ body, onSave, onCancel }: { body: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(body);
  return (
    <div className="mt-0.5">
      <textarea
        autoFocus
        rows={Math.max(1, Math.ceil(value.length / 80))}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (value.trim() && value.trim() !== body) onSave(value); else onCancel(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        className="w-full bg-[#0a0e0a] border border-green-700/60 rounded-lg px-3 py-2 text-sm text-green-400 outline-none focus:border-green-600 resize-none"
      />
      <div className="flex gap-2 mt-1 text-[10px] text-green-800">
        <span>Enter to save</span>
        <span>·</span>
        <span>Esc to cancel</span>
        <span>·</span>
        <span>Shift+Enter for newline</span>
      </div>
    </div>
  );
}

// ── Component ───────────────────────────────────────────────

export function TerminalForum() {
  // Connection
  const [isConnected, setIsConnected] = useState(false);
  const [nickname, setNickname]       = useState('');
  const [serverIp, setServerIp]       = useState('');
  const [tcpPort, setTcpPort]         = useState('5001');
  const [status, setStatus]           = useState('Awaiting connection');
  const [connecting, setConnecting]   = useState(false);
  const [serverInfo, setServerInfo]   = useState<ServerInfo | null>(null);
  const [connectedServerId, setConnectedServerId] = useState<string | null>(null);
  const [voiceServerId, setVoiceServerId] = useState<string | null>(null);
  const [connectingToServerId, setConnectingToServerId] = useState<string | null>(null);
  const [showHome, setShowHome] = useState(false);
  // ── Browser-style back/forward navigation history ─────────
  type NavEntry =
    | { type: 'home' }
    | { type: 'server'; serverId: string; view: 'voice' | 'text'; textRoom?: string | null }
    | { type: 'dm'; username: string };
  const navHistoryRef = useRef<NavEntry[]>([{ type: 'home' }]);
  const navIndexRef = useRef(0);
  const isNavRestoreRef = useRef(false);  // true while applying a back/forward entry
  const [canNavBack, setCanNavBack] = useState(false);
  const [canNavForward, setCanNavForward] = useState(false);
  const updateNavButtons = () => {
    setCanNavBack(navIndexRef.current > 0);
    setCanNavForward(navIndexRef.current < navHistoryRef.current.length - 1);
  };
  // Multi-server: set of server IDs with active TCP connections
  const [connectedServerIds, setConnectedServerIds] = useState<Set<string>>(new Set());

  // Rooms (from server)
  const [voiceRooms, setVoiceRooms]       = useState<VoiceRoom[]>([]);
  const [textRooms, setTextRooms]         = useState<TextRoom[]>([]);
  const [joinedTextRooms, setJoinedText]  = useState(new Set<string>());
  const [currentTextRoom, setCurrentText] = useState<string | null>(null);
  const [currentVoiceRoom, setCurrentVoice] = useState<string | null>(null);

  // Messages per room
  const [roomMessages, setRoomMessages] = useState<Record<string, ChatMsg[]>>({});
  const [pinnedMessages, setPinnedMessages] = useState<Record<string, ChatMsg[]>>({});
  const [showPins, setShowPins] = useState(false);
  const [roomHasMore, setRoomHasMore] = useState<Record<string, boolean>>({});
  const [roomLoadingMore, setRoomLoadingMore] = useState<Record<string, boolean>>({});
  const [unreadRooms, setUnreadRooms] = useState<Set<string>>(new Set());
  const [mentionedRooms, setMentionedRooms] = useState<Record<string, number>>({});
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Users
  const [onlineUsers, setOnlineUsers] = useState<UserInfo[]>([]);
  const [serverRoles, setServerRoles] = useState<RoleInfo[]>([]);

  // Voice controls
  const [isMuted, setIsMuted]       = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [viewMode, setViewMode] = useState<'voice' | 'text'>('text');
  const [isCallFullscreen, setIsCallFullscreen] = useState(false);
  const [hideUiOverlay, setHideUiOverlay] = useState(false);
  const [mouseActive, setMouseActive] = useState(true);
  const mouseIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notificationSounds, setNotificationSounds] = useState(() => {
    try { return localStorage.getItem('voip-notification-sounds') !== 'false'; }
    catch { return true; }
  });
  const [notificationVolume, setNotificationVolume] = useState(() => {
    try { return parseInt(localStorage.getItem('voip-notification-volume') || '50'); }
    catch { return 50; }
  });

  type NotifLevel = 'all' | 'mentions' | 'none';
  type NotifPrefs = Record<string, { _server?: NotifLevel; [ch: string]: NotifLevel | 'default' | undefined }>;
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>(() => {
    try { return JSON.parse(localStorage.getItem('voip-notif-prefs') || '{}'); } catch { return {}; }
  });
  const notifPrefsRef = useRef<NotifPrefs>({});
  useEffect(() => { notifPrefsRef.current = notifPrefs; try { localStorage.setItem('voip-notif-prefs', JSON.stringify(notifPrefs)); } catch {} }, [notifPrefs]);

  // Input
  const [input, setInput] = useState('');
  const [isAway, setIsAway] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  // Typing indicators — per-room list of usernames currently typing
  const [typingUsers, setTypingUsers] = useState<Record<string, string[]>>({});
  const typingTimeoutsRef = useRef<Record<string, Record<string, ReturnType<typeof setTimeout>>>>({});
  const typingLastSentRef = useRef<Record<string, number>>({}); // room → last-sent timestamp

  // Reactions — msgId → (emoji → username[])
  const [reactions, setReactions] = useState<Record<string, Record<string, string[]>>>({});
  // Which message has the reaction picker open (msgId or null)
  const [reactionPickerMsgId, setReactionPickerMsgId] = useState<string | null>(null);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [gifQuery, setGifQuery] = useState('');
  const [gifResults, setGifResults] = useState<Array<{ id: string; preview: string; url: string }>>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const gifPickerRef = useRef<HTMLDivElement>(null);
  const gifDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [msgContextMenu, setMsgContextMenu] = useState<MsgContextMenu | null>(null);
  const [editingMsg, setEditingMsg] = useState<{ msgId: string; room: string; body: string } | null>(null);
  const [pendingFile, setPendingFile] = useState<{ name: string; mimeType: string; base64: string; dataUrl: string } | null>(null);
  const [fileUploadStatus, setFileUploadStatus] = useState<string | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [selectedVideoFeed, setSelectedVideoFeed] = useState<string | null>(null);
  const [activeVideos, setActiveVideos] = useState<Set<string>>(new Set());
  const [poppedOut, setPoppedOut] = useState<Set<string>>(new Set());
  const [cameraUsers, setCameraUsers] = useState<Set<string>>(new Set());
  const [screenUsers, setScreenUsers] = useState<Set<string>>(new Set());
  const [watchingStreams, setWatchingStreams] = useState<Set<string>>(new Set());
  const watchingStreamsRef = useRef<Set<string>>(new Set());
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideoInput, setSelectedVideoInput] = useState('');
  const [videoResolution, setVideoResolution] = useState<VideoResolution>('1080p');
  const [videoFps, setVideoFps] = useState<VideoFps>(30);
  const [screenShareDialog, setScreenShareDialog] = useState(false);
  const [screenShareAudio, setScreenShareAudio] = useState(false);
  const [screenShareResolution, setScreenShareResolution] = useState<VideoResolution>('1080p');
  const [screenShareFps, setScreenShareFps] = useState<VideoFps>(30);
  const [screenShareBitrate, setScreenShareBitrate] = useState(10000);
  const [screenShareVbr, setScreenShareVbr] = useState(false);
  const [serverPasswordDialog, setServerPasswordDialog] = useState<{ address: string; username: string; password: string; isRegister: boolean; serverId?: string } | null>(null);
  const [serverPasswordInput, setServerPasswordInput] = useState('');
  const [screenSources, setScreenSources] = useState<Array<{id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean}>>([]);
  const [screenSourcesLoaded, setScreenSourcesLoaded] = useState(false);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<'screen' | 'window'>('screen');
  const [avatarEditor, setAvatarEditor] = useState<{ img: HTMLImageElement; zoom: number; offsetX: number; offsetY: number } | null>(null);
  const [logoEditor, setLogoEditor] = useState<{ img: HTMLImageElement; zoom: number; offsetX: number; offsetY: number } | null>(null);
  const [emojiEditor, setEmojiEditor] = useState<{ img: HTMLImageElement; zoom: number; offsetX: number; offsetY: number; name: string } | null>(null);
  const [theme, setTheme] = useState<ThemeColor>(() => {
    try { return (localStorage.getItem('voip-theme') as ThemeColor) || 'mono'; }
    catch { return 'mono'; }
  });
  const [customTheme, setCustomTheme] = useState<CustomThemeColors>(() => {
    try { return { ...DEFAULT_CUSTOM_THEME, ...JSON.parse(localStorage.getItem('voip-custom-theme') || '{}') }; }
    catch { return DEFAULT_CUSTOM_THEME; }
  });
  const [pinnedServers, setPinnedServers] = useState<PinnedServer[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('voip-pinned-servers') || '[]');
      return raw.map((s: any) => ({
        id: s.id, name: s.name,
        address: s.address || `${s.host || '127.0.0.1'}:${s.port || s.tcpPort || '5001'}`,
        username: s.username, password: s.password, serverPassword: s.serverPassword,
        autoConnect: s.autoConnect, autoConnectTcp: s.autoConnectTcp, logo: s.logo, authToken: s.authToken, ssePort: s.ssePort,
        trusted: s.trusted ?? false,
      }));
    } catch { return []; }
  });
  const [loginDialog, setLoginDialog] = useState<string | null>(null);
  const [serverContextMenu, setServerContextMenu] = useState<ServerContextMenu | null>(null);
  const [friendContextMenu, setFriendContextMenu] = useState<{ username: string; serverId: string; x: number; y: number } | null>(null);
  const [addServerDialog, setAddServerDialog] = useState(false);
  const [untrustedConfirm, setUntrustedConfirm] = useState<PinnedServer | null>(null);
  const [newServerName, setNewServerName] = useState('');
  const [newServerAddress, setNewServerAddress] = useState('');
  const [newServerTrusted, setNewServerTrusted] = useState(false);
  const [platform, setPlatform] = useState<string>('win32');
  const [keybinds, setKeybinds] = useState<Record<string, KeyBind | null>>(() => {
    try { return JSON.parse(localStorage.getItem('voip-keybinds') || '{}'); }
    catch { return {}; }
  });
  const [recordingKeybind, setRecordingKeybind] = useState<string | null>(null);
  const [serverMentions, setServerMentions] = useState<Record<string, number>>({});
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [openTabs, setOpenTabs] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('voip-open-tabs') || '[]'); }
    catch { return []; }
  });
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);

  // Direct Messages (inline tabs)
  const [openDmTabs, setOpenDmTabs] = useState<DmTab[]>([]);
  const [activeDmTab, setActiveDmTab] = useState<string | null>(null); // username or null
  const [dmMessages, setDmMessages] = useState<Record<string, DmMessage[]>>({});
  const [dmKeyFingerprints, setDmKeyFingerprints] = useState<Record<string, string>>({});
  const [unlockedGifUrls, setUnlockedGifUrls] = useState<Set<string>>(new Set());
  const [dmInput, setDmInput] = useState('');
  const [pendingDmFile, setPendingDmFile] = useState<{ name: string; mimeType: string; base64: string; dataUrl: string } | null>(null);
  const [dmError, setDmError] = useState<string | null>(null);
  const [dmUnreadCounts, setDmUnreadCounts] = useState<Record<string, number>>({});
  const [friends, setFriends] = useState<Friend[]>(() => {
    try { return JSON.parse(localStorage.getItem('voip-friends') || '[]'); }
    catch { return []; }
  });
  const dmMessagesEndRef = useRef<HTMLDivElement>(null);
  const dmInputRef = useRef<HTMLInputElement>(null);
  const dmFileInputRef = useRef<HTMLInputElement>(null);
  const activeDmTabRef = useRef<string | null>(null);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLInputElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const captureRef     = useRef<AudioWorkletNode | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const isMutedRef     = useRef(false);
  const isDeafenedRef  = useRef(false);
  const nicknameRef    = useRef('');
  const selectedInputRef  = useRef('');
  const selectedOutputRef = useRef('');
  const echoCancellationRef = useRef(localStorage.getItem('voip-echo-cancellation') !== 'false');
  const noiseSuppressionRef = useRef(localStorage.getItem('voip-noise-suppression') !== 'false');
  const autoGainControlRef = useRef(localStorage.getItem('voip-auto-gain') !== 'false');
  const inputSensitivityRef = useRef(parseInt(localStorage.getItem('voip-input-sensitivity') || '0'));
  const gateAttackRef = useRef(parseInt(localStorage.getItem('voip-gate-attack') || '20'));
  const gateHoldRef = useRef(parseInt(localStorage.getItem('voip-gate-hold') || '100'));
  const gateReleaseRef = useRef(parseInt(localStorage.getItem('voip-gate-release') || '300'));
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
  const forceKeyframeRef = useRef(false);
  const systemAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const screenCaptureRef = useRef<AudioWorkletNode | null>(null);
  const nativeLoopbackRef = useRef(false);
  const connectedHostRef = useRef('');
  const connectedServerIdRef = useRef<string | null>(null);
  const currentVoiceRoomRef = useRef<string | null>(null);
  const currentTextRoomRef = useRef<string | null>(null);
  const keybindsRef = useRef<Record<string, KeyBind | null>>({});
  const userPlaybackRef = useRef<Record<string, { playback: AudioWorkletNode; gain: GainNode }>>({});
  const userScreenPlaybackRef = useRef<Record<string, { playback: AudioWorkletNode; gain: GainNode }>>({});
  const perUserSettingsRef = useRef<Record<string, UserSetting>>({});
  const notificationSoundsRef = useRef(true);
  const notificationVolumeRef = useRef(50);

  // ── Notification preference helpers (use refs so IPC callbacks stay fresh) ──
  const resolveNotifLevel = (sid: string, channel?: string): NotifLevel => {
    const prefs = notifPrefsRef.current[sid];
    const serverLevel: NotifLevel = (prefs?._server as NotifLevel) ?? 'all';
    if (!channel) return serverLevel;
    const chPref = prefs?.[channel];
    if (!chPref || chPref === 'default') return serverLevel;
    return chPref as NotifLevel;
  };
  const setServerNotifLevel = (sid: string, level: NotifLevel) => {
    setNotifPrefs(prev => ({ ...prev, [sid]: { ...(prev[sid] ?? {}), _server: level } }));
  };
  const setChannelNotifLevel = (sid: string, channel: string, level: NotifLevel | 'default') => {
    setNotifPrefs(prev => ({ ...prev, [sid]: { ...(prev[sid] ?? {}), [channel]: level } }));
  };
  const prevVoiceUsersRef = useRef<Set<string>>(new Set());
  const uiSoundCtxRef = useRef<AudioContext | null>(null);
  const voiceServerIdRef = useRef<string | null>(null);
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set());
  const speakingTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // ── ECDH DM encryption state ─────────────────────────────
  const ecdhPrivateKeyRef = useRef<CryptoKey | null>(null);
  const ecdhPublicKeyB64Ref = useRef<string>('');
  const dmSharedKeysRef = useRef<Map<string, CryptoKey>>(new Map());
  const pendingDmKeyCallbacksRef = useRef<Map<string, Array<(key: CryptoKey | null) => void>>>(new Map());

  // ── Multi-server state cache ──────────────────────────────
  // Stores per-server state snapshots for background servers.
  // The currently active (viewed) server's state is in the
  // individual useState hooks above. When switching tabs, we
  // save the current state into this ref and restore the new
  // server's cached state.
  interface ServerStateSnapshot {
    nickname: string; serverIp: string; tcpPort: string;
    serverInfo: ServerInfo | null; voiceRooms: VoiceRoom[]; textRooms: TextRoom[];
    joinedTextRooms: Set<string>; currentTextRoom: string | null; currentVoiceRoom: string | null;
    roomMessages: Record<string, ChatMsg[]>; pinnedMessages: Record<string, ChatMsg[]>;
    roomHasMore: Record<string, boolean>; unreadRooms: Set<string>; mentionedRooms: Record<string, number>;
    onlineUsers: UserInfo[]; serverRoles: RoleInfo[];
    cameraUsers: Set<string>; screenUsers: Set<string>;
    soundboardSounds: string[]; customEmojis: Record<string, string>; e2eeActive: boolean;
  }
  const serverStatesRef = useRef<Record<string, ServerStateSnapshot>>({});

  function takeServerSnapshot(): ServerStateSnapshot {
    return {
      nickname, serverIp, tcpPort, serverInfo, voiceRooms, textRooms,
      joinedTextRooms: joinedTextRooms, currentTextRoom: currentTextRoom, currentVoiceRoom: currentVoiceRoom,
      roomMessages, pinnedMessages, roomHasMore, unreadRooms, mentionedRooms, onlineUsers, serverRoles,
      cameraUsers, screenUsers, soundboardSounds, customEmojis, e2eeActive: e2eeActive,
    };
  }

  function restoreServerSnapshot(snap: ServerStateSnapshot) {
    setNickname(snap.nickname); setServerIp(snap.serverIp); setTcpPort(snap.tcpPort);
    setServerInfo(snap.serverInfo); setVoiceRooms(snap.voiceRooms); setTextRooms(snap.textRooms);
    setJoinedText(snap.joinedTextRooms); setCurrentText(snap.currentTextRoom);
    setCurrentVoice(snap.currentVoiceRoom);
    setRoomMessages(snap.roomMessages); setPinnedMessages(snap.pinnedMessages);
    setRoomHasMore(snap.roomHasMore); setUnreadRooms(snap.unreadRooms); setMentionedRooms(snap.mentionedRooms);
    setOnlineUsers(snap.onlineUsers); setServerRoles(snap.serverRoles);
    setCameraUsers(snap.cameraUsers); setScreenUsers(snap.screenUsers);
    setSoundboardSounds(snap.soundboardSounds); setCustomEmojis(snap.customEmojis);
    setE2eeActive(snap.e2eeActive);
  }

  function resetServerState() {
    setServerInfo(null); setVoiceRooms([]); setTextRooms([]);
    setJoinedText(new Set()); setCurrentText(null); setCurrentVoice(null);
    setRoomMessages({}); setPinnedMessages({}); setShowPins(false);
    setRoomHasMore({}); setRoomLoadingMore({}); setUnreadRooms(new Set()); setMentionedRooms({});
    setOnlineUsers([]); setServerRoles([]);
    setCameraUsers(new Set()); setScreenUsers(new Set());
    setSoundboardSounds([]); setCustomEmojis({});
    setE2eeActive(false); setE2eePrompt(false); e2eeKeyRef.current = null;
    setSelectedVideoFeed(null);
    setActiveDmTab(null); setOpenDmTabs([]); setDmMessages({}); setDmKeyFingerprints({});
    // Clear ECDH DM state
    ecdhPrivateKeyRef.current = null;
    ecdhPublicKeyB64Ref.current = '';
    dmSharedKeysRef.current.clear();
    pendingDmKeyCallbacksRef.current.forEach(cbs => cbs.forEach(cb => cb(null)));
    pendingDmKeyCallbacksRef.current.clear();
  }

  // ── ECDH DM encryption helpers ───────────────────────────

  async function generateAndPublishEcdhKey() {
    try {
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
      ecdhPrivateKeyRef.current = pair.privateKey;
      const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
      const bytes = new Uint8Array(spki);
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK)
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)) as unknown as number[]);
      const b64 = btoa(binary);
      ecdhPublicKeyB64Ref.current = b64;
      sendToServer(`CMD:SET_DM_KEY:${b64}`);
      console.log('[ECDH] DM key pair generated and published');
    } catch (err) {
      console.error('[ECDH] Key generation failed:', err);
    }
  }

  async function deriveDmSharedKey(theirPubKeyB64: string): Promise<CryptoKey | null> {
    try {
      const raw = Uint8Array.from(atob(theirPubKeyB64), c => c.charCodeAt(0));
      const theirKey = await crypto.subtle.importKey('spki', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      if (!ecdhPrivateKeyRef.current) return null;
      return crypto.subtle.deriveKey(
        { name: 'ECDH', public: theirKey },
        ecdhPrivateKeyRef.current,
        { name: 'AES-GCM', length: 256 },
        false, ['encrypt', 'decrypt']
      );
    } catch { return null; }
  }

  async function getDmSharedKey(username: string): Promise<CryptoKey | null> {
    const cached = dmSharedKeysRef.current.get(username);
    if (cached) return cached;
    sendToServer(`CMD:GET_DM_KEY:${username}`);
    return new Promise<CryptoKey | null>((resolve) => {
      let done = false;
      const cb = (key: CryptoKey | null) => { if (done) return; done = true; resolve(key); };
      const existing = pendingDmKeyCallbacksRef.current.get(username) || [];
      existing.push(cb);
      pendingDmKeyCallbacksRef.current.set(username, existing);
      setTimeout(() => cb(null), 5000);
    });
  }

  async function dmEncrypt(text: string, key: CryptoKey): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    const combined = new Uint8Array(12 + ct.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ct), 12);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < combined.length; i += CHUNK)
      binary += String.fromCharCode.apply(null, combined.subarray(i, Math.min(i + CHUNK, combined.length)) as unknown as number[]);
    return 'DMENC:' + btoa(binary);
  }

  async function dmDecrypt(text: string, key: CryptoKey): Promise<string> {
    if (!text.startsWith('DMENC:')) return text;
    try {
      const raw = Uint8Array.from(atob(text.substring(6)), c => c.charCodeAt(0));
      const iv = raw.slice(0, 12);
      const ct = raw.slice(12);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return new TextDecoder().decode(pt);
    } catch { return text; }
  }

  // ── Browser-style back / forward helpers ───────────────────
  const navEntriesEqual = (a: NavEntry, b: NavEntry): boolean => {
    if (a.type !== b.type) return false;
    if (a.type === 'server' && b.type === 'server') return a.serverId === b.serverId && a.view === b.view && (a.textRoom ?? null) === (b.textRoom ?? null);
    if (a.type === 'dm' && b.type === 'dm') return a.username === b.username;
    return true;
  };

  const pushNav = (entry: NavEntry) => {
    if (isNavRestoreRef.current) return;
    const cur = navHistoryRef.current[navIndexRef.current];
    if (cur && navEntriesEqual(cur, entry)) return;
    navHistoryRef.current = navHistoryRef.current.slice(0, navIndexRef.current + 1);
    navHistoryRef.current.push(entry);
    navIndexRef.current = navHistoryRef.current.length - 1;
    updateNavButtons();
  };

  // Build a server nav entry from the current in-server view state
  const serverNavEntry = (serverId: string): NavEntry => ({
    type: 'server', serverId, view: viewModeRef.current, textRoom: currentTextRoomRef.current,
  });

  const applyNavEntry = (entry: NavEntry) => {
    isNavRestoreRef.current = true;
    if (entry.type === 'home') {
      const currentSid = connectedServerIdRef.current;
      if (currentSid) serverStatesRef.current[currentSid] = takeServerSnapshot();
      setActiveDmTab(null);
      setShowHome(true);
    } else if (entry.type === 'server') {
      setActiveDmTab(null);
      setShowHome(false);
      const currentSid = connectedServerIdRef.current;
      if (currentSid === entry.serverId) {
        // Same server — just switch the sub-view
        setViewModeTracked(entry.view);
        if (entry.view === 'text') setCurrentText(entry.textRoom ?? null);
      } else {
        // Different server — do snapshot swap directly (bypass connectToPinnedServer to avoid stale-state issues)
        const cached = serverStatesRef.current[entry.serverId];
        if (cached) {
          // Save current server's state
          if (currentSid) serverStatesRef.current[currentSid] = takeServerSnapshot();
          // Restore target
          restoreServerSnapshot(cached);
          connectedServerIdRef.current = entry.serverId;
          setConnectedServerId(entry.serverId);
          setIsConnected(true);
          addToOpenTabs(entry.serverId);
          // Override sub-view from nav entry
          setViewModeTracked(entry.view);
          if (entry.view === 'text') setCurrentText(entry.textRoom ?? null);
          // Restore E2EE key
          if (cached.e2eeActive) {
            try {
              const stored = JSON.parse(localStorage.getItem('voip-e2ee-keys') || '{}');
              const passphrase = stored[entry.serverId];
              if (passphrase) activateE2ee(passphrase);
              else { e2eeKeyRef.current = null; setE2eeActive(false); }
            } catch { e2eeKeyRef.current = null; setE2eeActive(false); }
          } else {
            e2eeKeyRef.current = null;
          }
        } else {
          // No cached state — try connectToPinnedServer as fallback
          const server = pinnedServers.find(s => s.id === entry.serverId);
          if (server) connectToPinnedServer(server);
        }
      }
    } else if (entry.type === 'dm') {
      setActiveDmTab(entry.username);
      setShowHome(false);
    }
    isNavRestoreRef.current = false;
    updateNavButtons();
  };

  const navBack = () => {
    if (navIndexRef.current <= 0) return;
    navIndexRef.current--;
    applyNavEntry(navHistoryRef.current[navIndexRef.current]);
  };

  const navForward = () => {
    if (navIndexRef.current >= navHistoryRef.current.length - 1) return;
    navIndexRef.current++;
    applyNavEntry(navHistoryRef.current[navIndexRef.current]);
  };

  // Keep stable refs so the mount-once mouse/keyboard listener always calls the latest closure
  const navBackRef = useRef(navBack);
  const navForwardRef = useRef(navForward);
  navBackRef.current = navBack;
  navForwardRef.current = navForward;

  // Helper: send a message to the currently viewed server
  const sendToServer = useCallback((message: string) => {
    const sid = connectedServerIdRef.current;
    if (sid) window.electronAPI.sendChat(sid, message);
  }, []);

  // Helper: send a message to the server that owns the voice session
  const sendToVoice = useCallback((message: string) => {
    const sid = voiceServerIdRef.current;
    if (sid) window.electronAPI.sendChat(sid, message);
  }, []);

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [serverSettingsTab, setServerSettingsTab] = useState<'general' | 'roles' | 'soundboard' | 'emojis'>('general');
  const [audioInputs, setAudioInputs]   = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedInput, setSelectedInput]   = useState('');
  const [selectedOutput, setSelectedOutput] = useState('');
  const [echoCancellation, setEchoCancellation] = useState(() => { try { return localStorage.getItem('voip-echo-cancellation') !== 'false'; } catch { return true; } });
  const [noiseSuppression, setNoiseSuppression] = useState(() => { try { return localStorage.getItem('voip-noise-suppression') !== 'false'; } catch { return true; } });
  const [autoGainControl, setAutoGainControl] = useState(() => { try { return localStorage.getItem('voip-auto-gain') !== 'false'; } catch { return true; } });
  const [micLevel, setMicLevel] = useState(0);
  const [inputSensitivity, setInputSensitivity] = useState(() => { try { return parseInt(localStorage.getItem('voip-input-sensitivity') || '0'); } catch { return 0; } });
  const [gateAttack, setGateAttack] = useState(() => { try { return parseInt(localStorage.getItem('voip-gate-attack') || '20'); } catch { return 20; } });
  const [gateHold, setGateHold] = useState(() => { try { return parseInt(localStorage.getItem('voip-gate-hold') || '100'); } catch { return 100; } });
  const [gateRelease, setGateRelease] = useState(() => { try { return parseInt(localStorage.getItem('voip-gate-release') || '300'); } catch { return 300; } });
  const [pushToTalkMode, setPushToTalkMode] = useState(() => { try { return localStorage.getItem('voip-ptt-mode') === 'true'; } catch { return false; } });
  const pushToTalkModeRef = useRef(false);
  const [pttHeld, setPttHeld] = useState(false);
  const pttHeldRef = useRef(false);
  const [gateActive, setGateActive] = useState(false);
  const gateActiveRef = useRef(false);
  const [userContextMenu, setUserContextMenu] = useState<UserContextMenu | null>(null);
  const [roomContextMenu, setRoomContextMenu] = useState<{ type: 'text' | 'voice'; name: string; idx: number; x: number; y: number } | null>(null);
  const [dragRoomIdx, setDragRoomIdx] = useState<{ type: 'text' | 'voice'; idx: number } | null>(null);
  const [dragOverRoomIdx, setDragOverRoomIdx] = useState<{ type: 'text' | 'voice'; idx: number } | null>(null);
  const [perUserSettings, setPerUserSettings] = useState<Record<string, UserSetting>>({});
  const [uiScale, setUiScale] = useState(() => {
    try { return parseInt(localStorage.getItem('voip-ui-scale') || '100'); }
    catch { return 100; }
  });
  const [fontFamily, setFontFamily] = useState(() => {
    try { return localStorage.getItem('voip-font-family') || ''; }
    catch { return ''; }
  });
  const [e2eeActive, setE2eeActive] = useState(false);
  const [e2eePrompt, setE2eePrompt] = useState(false);
  const [e2eeInput, setE2eeInput] = useState('');
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const e2eeKeyRef = useRef<CryptoKey | null>(null);

  // Soundboard
  const [soundboardSounds, setSoundboardSounds] = useState<string[]>([]);
  const [soundboardMuted, setSoundboardMuted] = useState(false);
  const [showSoundboard, setShowSoundboard] = useState(false);
  const [soundboardVolume, setSoundboardVolume] = useState(() => {
    try { return parseInt(localStorage.getItem('voip-soundboard-volume') || '50'); }
    catch { return 50; }
  });
  const [soundboardUploadName, setSoundboardUploadName] = useState('');
  const soundboardMutedRef = useRef(false);
  const soundboardVolumeRef = useRef(50);
  const soundboardFileRef = useRef<HTMLInputElement>(null);
  const soundboardSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const soundboardGainRef = useRef<GainNode | null>(null);
  const [playingSound, setPlayingSound] = useState<string | null>(null);

  // Custom emojis (name → base64 image data from server)
  const [customEmojis, setCustomEmojis] = useState<Record<string, string>>({});
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null);
  const [emojiAutoIndex, setEmojiAutoIndex] = useState(0);

  // Room management
  const [createRoomDialog, setCreateRoomDialog] = useState<{ type: 'voice' | 'text'; editing?: string } | null>(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomRoles, setNewRoomRoles] = useState<string[]>([]);
  const [newRoomBitrate, setNewRoomBitrate] = useState('96000');

  // Role editing
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [editRoleName, setEditRoleName] = useState('');
  const [editRoleColor, setEditRoleColor] = useState('#22c55e');
  const [editRolePerms, setEditRolePerms] = useState<string[]>([]);

  // Wipe server confirmation
  const [wipeServerDialog, setWipeServerDialog] = useState(false);
  const [wipeConfirmName, setWipeConfirmName] = useState('');
  const [wipeConfirmCheck, setWipeConfirmCheck] = useState(false);

  // User list toggle
  const [showUserList, setShowUserList] = useState(() => {
    try { return localStorage.getItem('voip-show-user-list') !== 'false'; }
    catch { return true; }
  });

  // Resizable sidebars
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('voip-left-sidebar-width') || '256'); }
    catch { return 256; }
  });
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('voip-right-sidebar-width') || '256'); }
    catch { return 256; }
  });
  const resizingRef = useRef<'left' | 'right' | null>(null);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(0);

  // Sidebar resize handlers
  const startResize = useCallback((side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = side;
    resizeStartXRef.current = e.clientX;
    resizeStartWidthRef.current = side === 'left' ? leftSidebarWidth : rightSidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [leftSidebarWidth, rightSidebarWidth]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = e.clientX - resizeStartXRef.current;
      const newWidth = Math.max(180, Math.min(450, resizeStartWidthRef.current + (resizingRef.current === 'left' ? delta : -delta)));
      if (resizingRef.current === 'left') setLeftSidebarWidth(newWidth);
      else setRightSidebarWidth(newWidth);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const delta = e.clientX - resizeStartXRef.current;
      const finalWidth = Math.max(180, Math.min(450, resizeStartWidthRef.current + (resizingRef.current === 'left' ? delta : -delta)));
      localStorage.setItem(
        resizingRef.current === 'left' ? 'voip-left-sidebar-width' : 'voip-right-sidebar-width',
        String(finalWidth),
      );
      resizingRef.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (resizingRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        resizingRef.current = null;
      }
    };
  }, []);

  async function deriveE2eeKey(passphrase: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const km = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('voip-e2ee-v1'), iterations: 100000, hash: 'SHA-256' },
      km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function e2eeEncryptText(text: string): Promise<string> {
    const key = e2eeKeyRef.current;
    if (!key) return text;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    const combined = new Uint8Array(12 + ct.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ct), 12);
    // Build binary string in chunks to avoid call-stack overflow from spread operator
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < combined.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, combined.subarray(i, Math.min(i + CHUNK, combined.length)) as unknown as number[]);
    }
    return 'ENC:' + btoa(binary);
  }

  async function e2eeDecryptText(data: string): Promise<string> {
    if (!data.startsWith('ENC:')) return data;
    const key = e2eeKeyRef.current;
    if (!key) return data;
    try {
      const raw = Uint8Array.from(atob(data.substring(4)), c => c.charCodeAt(0));
      const iv = raw.slice(0, 12);
      const ct = raw.slice(12);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return new TextDecoder().decode(pt);
    } catch {
      return data;
    }
  }

  async function activateE2ee(passphrase: string) {
    const key = await deriveE2eeKey(passphrase);
    e2eeKeyRef.current = key;
    window.electronAPI.setEncryptionKey(connectedServerIdRef.current || '', passphrase);
    setE2eeActive(true);
    // Save per-server so we don't prompt again
    if (connectedServerIdRef.current) {
      try {
        const stored = JSON.parse(localStorage.getItem('voip-e2ee-keys') || '{}');
        stored[connectedServerIdRef.current] = passphrase;
        localStorage.setItem('voip-e2ee-keys', JSON.stringify(stored));
      } catch {}
    }
    // Re-decrypt any messages that arrived before the key was ready
    reDecryptMessages();
  }

  function reDecryptMessages() {
    setRoomMessages(prev => {
      const entries = Object.entries(prev);
      const hasEnc = entries.some(([, msgs]) => msgs.some(m => m.body.startsWith('ENC:')));
      if (!hasEnc) return prev;
      (async () => {
        const decrypted = new Map<string, string>();
        for (const [, msgs] of entries) {
          for (const m of msgs) {
            if (m.body.startsWith('ENC:')) {
              const body = await e2eeDecryptText(m.body);
              if (body !== m.body) decrypted.set(m.id, body);
            }
          }
        }
        if (decrypted.size > 0) {
          setRoomMessages(cur => {
            const result: Record<string, ChatMsg[]> = {};
            for (const [room, msgs] of Object.entries(cur)) {
              result[room] = msgs.map(m => {
                const d = decrypted.get(m.id);
                return d !== undefined ? { ...m, body: d } : m;
              });
            }
            return result;
          });
        }
      })();
      return prev;
    });

    // Also re-decrypt pinned messages
    setPinnedMessages(prev => {
      const entries = Object.entries(prev);
      const hasEnc = entries.some(([, msgs]) => msgs.some(m => m.body.startsWith('ENC:')));
      if (!hasEnc) return prev;
      (async () => {
        const decrypted = new Map<string, string>();
        for (const [, msgs] of entries) {
          for (const m of msgs) {
            if (m.body.startsWith('ENC:')) {
              const body = await e2eeDecryptText(m.body);
              if (body !== m.body) decrypted.set(m.id, body);
            }
          }
        }
        if (decrypted.size > 0) {
          setPinnedMessages(cur => {
            const result: Record<string, ChatMsg[]> = {};
            for (const [room, msgs] of Object.entries(cur)) {
              result[room] = msgs.map(m => {
                const d = decrypted.get(m.id);
                return d !== undefined ? { ...m, body: d } : m;
              });
            }
            return result;
          });
        }
      })();
      return prev;
    });
  }

  useEffect(() => { notificationSoundsRef.current = notificationSounds; try { localStorage.setItem('voip-notification-sounds', String(notificationSounds)); } catch {} }, [notificationSounds]);
  useEffect(() => { notificationVolumeRef.current = notificationVolume; try { localStorage.setItem('voip-notification-volume', String(notificationVolume)); } catch {} }, [notificationVolume]);

  function playUiSound(type: 'message' | 'joinSelf' | 'leaveSelf' | 'userJoin' | 'userLeave' | 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'cameraOn' | 'screenOn') {
    if (!notificationSoundsRef.current) return;
    const vol = notificationVolumeRef.current / 100;
    if (vol <= 0) return;
    try {
      if (!uiSoundCtxRef.current || uiSoundCtxRef.current.state === 'closed') {
        uiSoundCtxRef.current = new AudioContext();
      }
      const ctx = uiSoundCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);

      if (type === 'message') {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(880, t);
        o.frequency.setValueAtTime(1175, t + 0.06);
        o.connect(gain);
        gain.gain.setValueAtTime(vol * 0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.start(t); o.stop(t + 0.18);
      } else if (type === 'joinSelf') {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(523, t);
        o.frequency.exponentialRampToValueAtTime(784, t + 0.12);
        o.frequency.exponentialRampToValueAtTime(1047, t + 0.25);
        o.connect(gain);
        gain.gain.setValueAtTime(vol * 0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.start(t); o.stop(t + 0.35);
      } else if (type === 'userJoin') {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(660, t);
        o.frequency.exponentialRampToValueAtTime(880, t + 0.08);
        o.connect(gain);
        gain.gain.setValueAtTime(vol * 0.18, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        o.start(t); o.stop(t + 0.15);
      } else if (type === 'userLeave') {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(880, t);
        o.frequency.exponentialRampToValueAtTime(660, t + 0.08);
        o.connect(gain);
        gain.gain.setValueAtTime(vol * 0.18, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        o.start(t); o.stop(t + 0.15);
      } else if (type === 'mute') {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(480, t);
        o.frequency.exponentialRampToValueAtTime(300, t + 0.07);
        o.connect(gain);
        gain.gain.setValueAtTime(vol * 0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.start(t); o.stop(t + 0.1);
      } else if (type === 'unmute') {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(400, t);
        o.frequency.exponentialRampToValueAtTime(600, t + 0.07);
        o.connect(gain);
        gain.gain.setValueAtTime(vol * 0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.start(t); o.stop(t + 0.1);
      } else if (type === 'deafen') {
        const g2 = ctx.createGain();
        g2.connect(ctx.destination);
        const o1 = ctx.createOscillator();
        o1.type = 'triangle';
        o1.frequency.setValueAtTime(350, t);
        o1.frequency.exponentialRampToValueAtTime(220, t + 0.06);
        o1.connect(gain);
        gain.gain.setValueAtTime(vol * 0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        o1.start(t); o1.stop(t + 0.08);
        const o2 = ctx.createOscillator();
        o2.type = 'triangle';
        o2.frequency.setValueAtTime(300, t + 0.1);
        o2.frequency.exponentialRampToValueAtTime(180, t + 0.16);
        o2.connect(g2);
        g2.gain.setValueAtTime(vol * 0.18, t + 0.1);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o2.start(t + 0.1); o2.stop(t + 0.18);
      } else if (type === 'undeafen') {
        const g2 = ctx.createGain();
        g2.connect(ctx.destination);
        const o1 = ctx.createOscillator();
        o1.type = 'triangle';
        o1.frequency.setValueAtTime(350, t);
        o1.frequency.exponentialRampToValueAtTime(500, t + 0.06);
        o1.connect(gain);
        gain.gain.setValueAtTime(vol * 0.18, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        o1.start(t); o1.stop(t + 0.08);
        const o2 = ctx.createOscillator();
        o2.type = 'triangle';
        o2.frequency.setValueAtTime(450, t + 0.1);
        o2.frequency.exponentialRampToValueAtTime(650, t + 0.16);
        o2.connect(g2);
        g2.gain.setValueAtTime(vol * 0.2, t + 0.1);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o2.start(t + 0.1); o2.stop(t + 0.18);
      } else if (type === 'leaveSelf') {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(1047, t);
        o.frequency.exponentialRampToValueAtTime(784, t + 0.12);
        o.frequency.exponentialRampToValueAtTime(523, t + 0.25);
        o.connect(gain);
        gain.gain.setValueAtTime(vol * 0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.start(t); o.stop(t + 0.35);
      } else if (type === 'cameraOn') {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(784, t);
        o.frequency.setValueAtTime(988, t + 0.07);
        o.connect(gain);
        gain.gain.setValueAtTime(vol * 0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        o.start(t); o.stop(t + 0.15);
      } else if (type === 'screenOn') {
        const g2 = ctx.createGain();
        g2.connect(ctx.destination);
        const o1 = ctx.createOscillator();
        o1.type = 'sine';
        o1.frequency.setValueAtTime(659, t);
        o1.connect(gain);
        gain.gain.setValueAtTime(vol * 0.14, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        o1.start(t); o1.stop(t + 0.08);
        const o2 = ctx.createOscillator();
        o2.type = 'sine';
        o2.frequency.setValueAtTime(880, t + 0.09);
        o2.connect(g2);
        g2.gain.setValueAtTime(vol * 0.14, t + 0.09);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
        o2.start(t + 0.09); o2.stop(t + 0.17);
      }
    } catch {}
  }

  // Play sound on mute/deafen toggle
  useEffect(() => { isMutedRef.current = isMuted; if (isConnected) { playUiSound(isMuted ? 'mute' : 'unmute'); sendToVoice(`CMD:SET_MUTED:${isMuted}`); } }, [isMuted]);
  useEffect(() => { isDeafenedRef.current = isDeafened; if (isConnected) { playUiSound(isDeafened ? 'deafen' : 'undeafen'); sendToVoice(`CMD:SET_DEAFENED:${isDeafened}`); } }, [isDeafened]);
  useEffect(() => { soundboardMutedRef.current = soundboardMuted; }, [soundboardMuted]);
  useEffect(() => { soundboardVolumeRef.current = soundboardVolume; if (soundboardGainRef.current) soundboardGainRef.current.gain.value = soundboardVolume / 100; try { localStorage.setItem('voip-soundboard-volume', String(soundboardVolume)); } catch {} }, [soundboardVolume]);
  useEffect(() => { echoCancellationRef.current = echoCancellation; try { localStorage.setItem('voip-echo-cancellation', String(echoCancellation)); } catch {} }, [echoCancellation]);
  useEffect(() => { noiseSuppressionRef.current = noiseSuppression; try { localStorage.setItem('voip-noise-suppression', String(noiseSuppression)); } catch {} }, [noiseSuppression]);
  useEffect(() => { autoGainControlRef.current = autoGainControl; try { localStorage.setItem('voip-auto-gain', String(autoGainControl)); } catch {} }, [autoGainControl]);
  useEffect(() => { inputSensitivityRef.current = inputSensitivity; if (captureRef.current) captureRef.current.port.postMessage({ sensitivity: inputSensitivity / 100 }); try { localStorage.setItem('voip-input-sensitivity', String(inputSensitivity)); } catch {} }, [inputSensitivity]);
  useEffect(() => { gateAttackRef.current = gateAttack; if (captureRef.current) captureRef.current.port.postMessage({ attackMs: gateAttack }); try { localStorage.setItem('voip-gate-attack', String(gateAttack)); } catch {} }, [gateAttack]);
  useEffect(() => { gateHoldRef.current = gateHold; if (captureRef.current) captureRef.current.port.postMessage({ holdMs: gateHold }); try { localStorage.setItem('voip-gate-hold', String(gateHold)); } catch {} }, [gateHold]);
  useEffect(() => { gateReleaseRef.current = gateRelease; if (captureRef.current) captureRef.current.port.postMessage({ releaseMs: gateRelease }); try { localStorage.setItem('voip-gate-release', String(gateRelease)); } catch {} }, [gateRelease]);
  useEffect(() => {
    pushToTalkModeRef.current = pushToTalkMode;
    try { localStorage.setItem('voip-ptt-mode', String(pushToTalkMode)); } catch {}
    if (captureRef.current) captureRef.current.port.postMessage({ pttMode: pushToTalkMode });
    if (!pushToTalkMode && pttHeldRef.current) {
      pttHeldRef.current = false; setPttHeld(false);
      captureRef.current?.port.postMessage({ pttHeld: false });
    }
  }, [pushToTalkMode]);
  useEffect(() => { nicknameRef.current = nickname; }, [nickname]);
  useEffect(() => { connectedServerIdRef.current = connectedServerId; }, [connectedServerId]);
  useEffect(() => { currentVoiceRoomRef.current = currentVoiceRoom; }, [currentVoiceRoom]);
  useEffect(() => { currentTextRoomRef.current = currentTextRoom; }, [currentTextRoom]);
  useEffect(() => {
    if (viewMode === 'text' && currentTextRoom && !activeDmTab) {
      setUnreadRooms(prev => {
        if (!prev.has(currentTextRoom)) return prev;
        const s = new Set(prev);
        s.delete(currentTextRoom);
        return s;
      });
      setMentionedRooms(prev => {
        if (!prev[currentTextRoom]) return prev;
        const n = { ...prev };
        delete n[currentTextRoom];
        return n;
      });
    }
  }, [viewMode, currentTextRoom, activeDmTab]);
  useEffect(() => { voiceServerIdRef.current = voiceServerId; }, [voiceServerId]);
  useEffect(() => { activeDmTabRef.current = activeDmTab; }, [activeDmTab]);
  useEffect(() => { try { localStorage.setItem('voip-theme', theme); } catch {} }, [theme]);
  const customThemeSaveRef = useRef(0);
  const colorPickerRafRef = useRef(0);
  const lastAccentScaleRef = useRef<{ accent: string; scale: Record<string, string> } | null>(null);
  const applyCustomThemeCssVars = useCallback((t: CustomThemeColors) => {
    const el = document.documentElement;
    const cached = lastAccentScaleRef.current;
    let scale: Record<string, string>;
    if (cached && cached.accent === t.accent) {
      scale = cached.scale;
    } else {
      scale = generateScale(t.accent);
      lastAccentScaleRef.current = { accent: t.accent, scale };
    }
    for (const [k, v] of Object.entries(scale)) el.style.setProperty(`--custom-green-${k}`, v);
    el.style.setProperty('--custom-bg', t.bg);
    el.style.setProperty('--custom-surface', t.surface);
    el.style.setProperty('--custom-sidebar', t.sidebar);
    el.style.setProperty('--custom-border', t.border);
    el.style.setProperty('--custom-text', t.text);
    el.style.setProperty('--custom-text-secondary', t.textSecondary);
    el.style.setProperty('--custom-accent-rgb', hexToRgb(t.accent));
    el.style.setProperty('--custom-border-rgb', hexToRgb(t.border));
  }, []);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'custom') {
      applyCustomThemeCssVars(customTheme);
    } else {
      ['bg', 'surface', 'sidebar', 'border', 'text', 'text-secondary', 'accent-rgb', 'border-rgb'].forEach(k => el.style.removeProperty(`--custom-${k}`));
      ['50','100','200','300','400','500','600','700','800','900','950'].forEach(k => el.style.removeProperty(`--custom-green-${k}`));
    }
    clearTimeout(customThemeSaveRef.current);
    customThemeSaveRef.current = window.setTimeout(() => {
      try { localStorage.setItem('voip-custom-theme', JSON.stringify(customTheme)); } catch {}
    }, 300);
  }, [theme, customTheme, applyCustomThemeCssVars]);
  useEffect(() => {
    try { localStorage.setItem('voip-ui-scale', String(uiScale)); } catch {}
    document.documentElement.style.fontSize = `${uiScale}%`;
  }, [uiScale]);
  useEffect(() => {
    try { localStorage.setItem('voip-font-family', fontFamily); } catch {}
    document.body.style.fontFamily = fontFamily || '';
  }, [fontFamily]);
  useEffect(() => { window.electronAPI.getPlatform().then(p => setPlatform(p)); }, []);
  useEffect(() => { window.electronAPI.getAppVersion().then(v => setAppVersion(v)); }, []);

  // Auto-updater listener
  useEffect(() => {
    const unsubAvailable = window.electronAPI.onUpdateAvailable((version) => {
      setUpdateAvailable(version);
      setUpdateDismissed(false);
    });
    const unsubProgress = window.electronAPI.onUpdateProgress((percent) => {
      setUpdateProgress(percent);
    });
    const unsub = window.electronAPI.onUpdateDownloaded((version) => {
      setUpdateAvailable(null);
      setUpdateProgress(null);
      setUpdateReady(version);
      setUpdateDismissed(false);
    });
    return () => { unsubAvailable(); unsubProgress(); unsub(); };
  }, []);
  useEffect(() => { try { localStorage.setItem('voip-pinned-servers', JSON.stringify(pinnedServers)); } catch {} }, [pinnedServers]);
  useEffect(() => { try { localStorage.setItem('voip-open-tabs', JSON.stringify(openTabs)); } catch {} }, [openTabs]);
  useEffect(() => { try { localStorage.setItem('voip-friends', JSON.stringify(friends)); } catch {} }, [friends]);
  useEffect(() => { keybindsRef.current = keybinds; try { localStorage.setItem('voip-keybinds', JSON.stringify(keybinds)); } catch {} }, [keybinds]);
  useEffect(() => {
    perUserSettingsRef.current = perUserSettings;
    // Apply gain changes to active voice playback nodes
    for (const [name, pipeline] of Object.entries(userPlaybackRef.current)) {
      const s = perUserSettings[name] || { volume: 100, isMuted: false };
      pipeline.gain.gain.value = s.isMuted ? 0 : s.volume / 100;
    }
    // Apply gain changes to active screen audio playback nodes
    for (const [name, pipeline] of Object.entries(userScreenPlaybackRef.current)) {
      const s = perUserSettings[name] || { screenVolume: 100 };
      pipeline.gain.gain.value = (s as UserSetting).screenVolume != null ? (s as UserSetting).screenVolume / 100 : 1;
    }
  }, [perUserSettings]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      setUserContextMenu(null); setMsgContextMenu(null); setServerContextMenu(null); setFriendContextMenu(null); setRoomContextMenu(null);
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) setShowEmojiPicker(false);
      if (gifPickerRef.current && !gifPickerRef.current.contains(e.target as Node)) { setShowGifPicker(false); setGifQuery(''); setGifResults([]); }
    };
    if (userContextMenu || msgContextMenu || serverContextMenu || friendContextMenu || roomContextMenu || showEmojiPicker || reactionPickerMsgId) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [userContextMenu, msgContextMenu, serverContextMenu, friendContextMenu, roomContextMenu, showEmojiPicker, reactionPickerMsgId]);

  // Close reaction picker on outside click
  useEffect(() => {
    if (!reactionPickerMsgId) return;
    const handler = () => setReactionPickerMsgId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [reactionPickerMsgId]);

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

  // Close modals on Escape
  useEffect(() => {
    if (!showSettings && !hideUiOverlay) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (hideUiOverlay) { setHideUiOverlay(false); setMouseActive(true); if (mouseIdleTimerRef.current) clearTimeout(mouseIdleTimerRef.current); return; }
        if (showSettings) { setShowSettings(false); setRecordingKeybind(null); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showSettings, hideUiOverlay]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      for (const [action, bind] of Object.entries(keybindsRef.current)) {
        if (!bind) continue;
        if (e.key === bind.key && e.ctrlKey === bind.ctrlKey && e.shiftKey === bind.shiftKey && e.altKey === bind.altKey) {
          e.preventDefault();
          if (action === 'toggleMute') setIsMuted(m => !m);
          else if (action === 'toggleDeafen') setIsDeafened(d => !d);
          else if (action === 'pushToTalk' && pushToTalkModeRef.current && !e.repeat) {
            if (!pttHeldRef.current) {
              pttHeldRef.current = true;
              setPttHeld(true);
              captureRef.current?.port.postMessage({ pttHeld: true });
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Cancel inline message editing on Escape (global fallback)
  useEffect(() => {
    if (!editingMsg) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditingMsg(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editingMsg]);

  // PTT key-up handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!pushToTalkModeRef.current || !pttHeldRef.current) return;
      const bind = keybindsRef.current.pushToTalk;
      if (bind && e.key === bind.key) {
        pttHeldRef.current = false;
        setPttHeld(false);
        captureRef.current?.port.postMessage({ pttHeld: false });
      }
    };
    window.addEventListener('keyup', handler);
    return () => window.removeEventListener('keyup', handler);
  }, []);

  // Browser-style back/forward via mouse buttons 3/4 and Alt+Arrow keys
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) { e.preventDefault(); navBackRef.current(); }
      else if (e.button === 4) { e.preventDefault(); navForwardRef.current(); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navBackRef.current(); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navForwardRef.current(); }
    };
    window.addEventListener('mouseup', onMouse);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mouseup', onMouse); window.removeEventListener('keydown', onKey); };
  }, []);

  const getUserSetting = (name: string): UserSetting =>
    perUserSettings[name] || { name, volume: 100, isMuted: false, soundboardMuted: false, screenMuted: false, screenVolume: 100 };

  const updateUserSetting = (name: string, update: Partial<UserSetting>) => {
    setPerUserSettings(prev => {
      const existing = prev[name] || { name, volume: 100, isMuted: false, soundboardMuted: false, screenMuted: false, screenVolume: 100 };
      return { ...prev, [name]: { ...existing, ...update } };
    });
  };

  // ── Server message handler ────────────────────────────────

  const handleServerMessage = useCallback((serverId: string, line: string) => {
    // If the message is from a background server, cache it
    if (serverId !== connectedServerIdRef.current) {
      const snap = serverStatesRef.current[serverId];
      if (snap) {
        // Apply minimal state updates to the cached snapshot
        if (line.startsWith('ROOMS:')) {
          try {
            const d = JSON.parse(line.substring(6));
            snap.voiceRooms = (d.VoiceRooms || []).map((r: any) => ({ name: r.Name, hasPassword: r.HasPassword, bitrate: r.Bitrate || 0 }));
            snap.textRooms = (d.TextRooms || []).map((r: any) => ({ name: r.Name, hasPassword: r.HasPassword }));
          } catch {}
        } else if (line.startsWith('USERS:')) {
          try {
            const d = JSON.parse(line.substring(6));
            snap.onlineUsers = d.map((u: any) => ({ name: u.Name, voiceRoom: u.VoiceRoom || null, online: u.Online !== false, status: (u.Status || (u.Online !== false ? 'online' : 'offline')) as 'online' | 'away' | 'offline', roles: u.Roles || [], roleColor: u.RoleColor || null, avatar: u.Avatar || null, muted: !!u.Muted, deafened: !!u.Deafened }));
          } catch {}
        } else if (line.startsWith('MSG:')) {
          const payload = line.substring(4);
          const i1 = payload.indexOf(':');
          if (i1 >= 0) {
            const room = payload.substring(0, i1);
            const rest1 = payload.substring(i1 + 1);
            const i2 = rest1.indexOf(':');
            if (i2 >= 0) {
              const msgId = rest1.substring(0, i2);
              const rest2 = rest1.substring(i2 + 1);
              const i3 = rest2.indexOf(':');
              if (i3 >= 0) {
                const sender = rest2.substring(0, i3);
                const text = rest2.substring(i3 + 1);
                snap.roomMessages = { ...snap.roomMessages, [room]: [...(snap.roomMessages[room] || []), { id: crypto.randomUUID(), msgId, sender, body: text, timestamp: Date.now() }] };
              }
            }
          }
        } else if (line.startsWith('JOINED_VOICE:')) {
          const payload = line.substring(13);
          const [room] = payload.split(':', 2);
          snap.currentVoiceRoom = room;
        } else if (line === 'LEFT_VOICE') {
          snap.currentVoiceRoom = null;
        }
      }
      return;
    }

    // Active server — process normally
    if (line.startsWith('SERVER_INFO:')) {
      try {
        const d = JSON.parse(line.substring(12));
        setServerInfo({
          serverName: d.ServerName || '',
          serverLogo: d.ServerLogo || undefined,
          voiceHost: d.VoiceHost || '',
          udpPort: d.UdpPort || 5000,
          maxCameraWidth: d.MaxCameraWidth || 1920,
          maxCameraHeight: d.MaxCameraHeight || 1080,
          maxScreenWidth: d.MaxScreenWidth || 1920,
          maxScreenHeight: d.MaxScreenHeight || 1080,
          maxFps: d.MaxFps || 30,
          maxScreenBitrate: d.MaxScreenBitrate ? d.MaxScreenBitrate * 1000 : 20_000_000,
          maxFileSizeKB: d.MaxFileSizeKB || 2048,
          maxSoundSizeKB: d.MaxSoundSizeKB || 512,
          defaultBitrate: d.DefaultBitrate || 96000,
          giphyApiKey: d.GiphyApiKey || undefined,
          ssePort: d.SsePort || undefined,
          fileServerPort: d.FileServerPort || undefined,
        });

        // Update the pinned server's name, logo, and SSE port from the server's identity
        const sid = connectedServerIdRef.current;
        if (sid && d.ServerName) {
          setPinnedServers(prev => prev.map(s =>
            s.id === sid ? { ...s, name: d.ServerName, logo: d.ServerLogo || undefined, ssePort: d.SsePort || undefined } : s
          ));
        }

        // Generate and publish our ECDH public key for DM encryption
        generateAndPublishEcdhKey();

        // Auto-setup E2EE
        if (d.EncryptionKey) {
          // Mode 1: Server-managed key — auto-activate
          activateE2ee(d.EncryptionKey);
          console.log('[E2EE] Server-managed key active');
        } else if (d.Encrypted) {
          // Mode 2: True E2EE — server doesn't know the key
          // Check if we have a saved passphrase for this server
          const serverId = connectedServerIdRef.current;
          let saved: string | null = null;
          if (serverId) {
            try {
              const stored = JSON.parse(localStorage.getItem('voip-e2ee-keys') || '{}');
              saved = stored[serverId] || null;
            } catch {}
          }
          if (saved) {
            activateE2ee(saved);
            console.log('[E2EE] Using saved client-side key');
          } else {
            setE2eePrompt(true);
          }
        }

        // Use the same host the client connected to via TCP — the server may
        // report a private/local IP via LocalEndPoint that is unreachable.
        const voiceHost = connectedHostRef.current || d.VoiceHost || '';
        const udpPort = d.UdpPort || 5000;
        // Only auto-start UDP if no voice session is active on ANY server
        if (voiceHost && udpPort && !currentVoiceRoomRef.current && !voiceServerIdRef.current) {
          console.log(`[Voice] Connecting UDP to ${voiceHost}:${udpPort} (server said: ${d.VoiceHost})`);
          window.electronAPI.startVoice(voiceHost, udpPort, nicknameRef.current, connectedServerIdRef.current || '').catch(err => {
            console.error('[Voice] Auto-start failed:', err);
          });
        }
      } catch {}
    } else if (line.startsWith('ROOMS:')) {
      try {
        const d = JSON.parse(line.substring(6));
        const newVoiceRooms: VoiceRoom[] = (d.VoiceRooms || []).map((r: any) => ({
          name: r.Name, allowedRoles: r.AllowedRoles || [], bitrate: r.Bitrate || 0,
        }));
        const newTextRooms: TextRoom[] = (d.TextRooms || []).map((r: any) => ({
          name: r.Name, allowedRoles: r.AllowedRoles || [],
        }));
        setVoiceRooms(newVoiceRooms);
        setTextRooms(newTextRooms);
        // Defensive cleanup: if current rooms were deleted, reset state
        const textNames = new Set(newTextRooms.map(r => r.name));
        const voiceNames = new Set(newVoiceRooms.map(r => r.name));
        if (currentTextRoomRef.current && !textNames.has(currentTextRoomRef.current)) {
          const removed = currentTextRoomRef.current;
          setCurrentText(null);
          setJoinedText(prev => { const s = new Set(prev); s.delete(removed); return s; });
          setRoomMessages(prev => { const n = { ...prev }; delete n[removed]; return n; });
          setPinnedMessages(prev => { const n = { ...prev }; delete n[removed]; return n; });
          setRoomHasMore(prev => { const n = { ...prev }; delete n[removed]; return n; });
        }
        // Clean up joinedTextRooms for any other deleted rooms
        setJoinedText(prev => {
          let changed = false;
          const s = new Set(prev);
          for (const r of s) {
            if (!textNames.has(r)) { s.delete(r); changed = true; }
          }
          return changed ? s : prev;
        });
        if (currentVoiceRoomRef.current && !voiceNames.has(currentVoiceRoomRef.current)) {
          setCurrentVoice(null);
        }
      } catch {}
    } else if (line.startsWith('USERS:')) {
      try {
        const d = JSON.parse(line.substring(6));
        setOnlineUsers(d.map((u: any) => ({ name: u.Name, voiceRoom: u.VoiceRoom || null, online: u.Online !== false, status: (u.Status || (u.Online !== false ? 'online' : 'offline')) as 'online' | 'away' | 'offline', roles: u.Roles || [], roleColor: u.RoleColor || null, avatar: u.Avatar || null, muted: !!u.Muted, deafened: !!u.Deafened })));
        // Sync camera/screen state from authoritative USERS list
        const cams = new Set<string>();
        const scrs = new Set<string>();
        for (const u of d) {
          if (u.Camera) cams.add(u.Name);
          if (u.Screen) scrs.add(u.Name);
        }
        setCameraUsers(cams);
        setScreenUsers(scrs);
      } catch {}
    } else if (line.startsWith('ROLES:')) {
      try {
        const d = JSON.parse(line.substring(6));
        setServerRoles(d.map((r: any) => ({ name: r.Name, color: r.Color, priority: r.Priority, permissions: r.Permissions || [] })));
      } catch {}
    } else if (line.startsWith('AUTH_TOKEN:')) {
      const token = line.substring(11);
      const sid = connectedServerIdRef.current;
      if (sid && token) {
        setPinnedServers(prev => prev.map(s =>
          s.id === sid ? { ...s, authToken: token } : s
        ));
      }
    } else if (line === 'KICKED') {
      setStatus('You were kicked from the server');
      setIsConnected(false);
    } else if (line.startsWith('AVATAR:')) {
      const i1 = line.indexOf(':', 7);
      if (i1 >= 0) {
        const user = line.substring(7, i1);
        const avatar = line.substring(i1 + 1) || null;
        setOnlineUsers(prev => prev.map(u => u.name === user ? { ...u, avatar } : u));
      }
    } else if (line.startsWith('JOINED_TEXT:')) {
      const room = line.substring(12);
      setJoinedText(prev => new Set(prev).add(room));
      setRoomMessages(prev => ({ ...prev, [room]: [] }));
      setCurrentText(room);
    } else if (line.startsWith('LEFT_TEXT:')) {
      const room = line.substring(10);
      setJoinedText(prev => { const s = new Set(prev); s.delete(room); return s; });
      setCurrentText(prev => prev === room ? null : prev);
      setRoomMessages(prev => { const n = { ...prev }; delete n[room]; return n; });
      setPinnedMessages(prev => { const n = { ...prev }; delete n[room]; return n; });
      setRoomHasMore(prev => { const n = { ...prev }; delete n[room]; return n; });
    } else if (line.startsWith('JOINED_VOICE:')) {
      const payload = line.substring(13);
      const [room, br] = payload.split(':', 2);
      setCurrentVoice(room);
      setVoiceServerId(serverId);
      if (br) { const b = parseInt(br); if (!isNaN(b)) window.electronAPI.setBitrate(b); }
      playUiSound('joinSelf');
    } else if (line === 'LEFT_VOICE') {
      playUiSound('leaveSelf');
      setCurrentVoice(null);
      if (voiceServerIdRef.current === serverId) setVoiceServerId(null);
    } else if (line.startsWith('HISTORY:')) {
      // Format: HISTORY:<room>:<hasMore>:<json>
      const payload = line.substring(8);
      const i1 = payload.indexOf(':');
      if (i1 >= 0) {
        const room = payload.substring(0, i1);
        const rest = payload.substring(i1 + 1);
        const i2 = rest.indexOf(':');
        if (i2 >= 0) {
          const hasMore = rest.substring(0, i2).toLowerCase() === 'true';
          try {
            const msgs: any[] = JSON.parse(rest.substring(i2 + 1));
            const scrollEl = chatScrollRef.current;
            const prevScrollHeight = scrollEl?.scrollHeight || 0;
            const prevScrollTop = scrollEl?.scrollTop || 0;
            Promise.all(msgs.map(async m => ({
              id: crypto.randomUUID(),
              msgId: m.Id || '',
              sender: m.User || '',
              body: await e2eeDecryptText(m.Text || ''),
              timestamp: new Date(m.Time).getTime(),
              edited: !!m.Edited,
            }))).then(formatted => {
              setRoomMessages(prev => {
                const existing = prev[room] || [];
                if (existing.length === 0) return { ...prev, [room]: formatted };
                // Older messages — prepend and preserve scroll position
                requestAnimationFrame(() => {
                  if (scrollEl) {
                    const newScrollHeight = scrollEl.scrollHeight;
                    scrollEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
                  }
                });
                return { ...prev, [room]: [...formatted, ...existing] };
              });
              setRoomHasMore(prev => ({ ...prev, [room]: hasMore }));
              setRoomLoadingMore(prev => ({ ...prev, [room]: false }));
            });
          } catch {}
        }
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
    } else if (line.startsWith('MSG_EDITED:')) {
      // MSG_EDITED:<room>:<msgId>:<newText>
      const payload = line.substring(11);
      const i1 = payload.indexOf(':');
      const i2 = i1 >= 0 ? payload.indexOf(':', i1 + 1) : -1;
      if (i1 >= 0 && i2 >= 0) {
        const room = payload.substring(0, i1);
        const msgId = payload.substring(i1 + 1, i2);
        const newText = payload.substring(i2 + 1);
        e2eeDecryptText(newText).then(body => {
          setRoomMessages(prev => ({
            ...prev,
            [room]: (prev[room] || []).map(m => m.msgId === msgId ? { ...m, body, edited: true } : m),
          }));
        });
      }
    } else if (line.startsWith('MSG:')) {
      // Clear typing indicator for the sender when their message arrives
      const senderEnd = line.indexOf(':', line.indexOf(':', 4) + 1) + 1;
      const senderColon = line.indexOf(':', senderEnd);
      if (senderColon > 0) {
        const senderName = line.substring(senderEnd, senderColon);
        if (senderName) {
          setTypingUsers(prev => {
            const updated: Record<string, string[]> = {};
            for (const [r, users] of Object.entries(prev)) updated[r] = users.filter(u => u !== senderName);
            return updated;
          });
        }
      }
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
      const now = Date.now();
      if (sender !== nicknameRef.current) {
        const level = resolveNotifLevel(connectedServerIdRef.current ?? '', room);
        if (level === 'all') playUiSound('message');
        if (level !== 'none') {
          if (viewModeRef.current !== 'text' || currentTextRoomRef.current !== room) {
            setUnreadRooms(prev => new Set(prev).add(room));
          }
        }
      }
      e2eeDecryptText(text).then(body => {
        setRoomMessages(prev => ({
          ...prev,
          [room]: [...(prev[room] || []), { id: crypto.randomUUID(), msgId, sender, body, timestamp: now }],
        }));
      });
    } else if (line.startsWith('TYPING:')) {
      // TYPING:<room>:<username>
      const payload = line.substring(7);
      const idx = payload.indexOf(':');
      if (idx >= 0) {
        const room = payload.substring(0, idx);
        const user = payload.substring(idx + 1);
        if (!user || user === nicknameRef.current) return;
        setTypingUsers(prev => ({ ...prev, [room]: [...new Set([...(prev[room] || []), user])] }));
        if (!typingTimeoutsRef.current[room]) typingTimeoutsRef.current[room] = {};
        if (typingTimeoutsRef.current[room][user]) clearTimeout(typingTimeoutsRef.current[room][user]);
        typingTimeoutsRef.current[room][user] = setTimeout(() => {
          setTypingUsers(prev => ({ ...prev, [room]: (prev[room] || []).filter(u => u !== user) }));
        }, 3000);
      }
    } else if (line.startsWith('REACTIONS:')) {
      // REACTIONS:<room>:<json> — bulk reaction state sent on room join
      const payload = line.substring(10);
      const idx = payload.indexOf(':');
      if (idx >= 0) {
        try {
          const data: Record<string, Record<string, string[]>> = JSON.parse(payload.substring(idx + 1));
          setReactions(prev => ({ ...prev, ...data }));
        } catch {}
      }
    } else if (line.startsWith('MSG_REACT:')) {
      // MSG_REACT:<room>:<msgId>:<json>  — updated reaction state for one message
      const payload = line.substring(10);
      const i1 = payload.indexOf(':');
      const i2 = i1 >= 0 ? payload.indexOf(':', i1 + 1) : -1;
      if (i1 >= 0 && i2 >= 0) {
        const msgId = payload.substring(i1 + 1, i2);
        try {
          const data: Record<string, string[]> = JSON.parse(payload.substring(i2 + 1));
          setReactions(prev => ({ ...prev, [msgId]: data }));
        } catch {}
      }
    } else if (line.startsWith('PINS:')) {
      // PINS:<room>:<json array of pinned messages>
      const payload = line.substring(5);
      const idx = payload.indexOf(':');
      if (idx >= 0) {
        const room = payload.substring(0, idx);
        try {
          const msgs: any[] = JSON.parse(payload.substring(idx + 1));
          Promise.all(msgs.map(async m => ({
            id: crypto.randomUUID(),
            msgId: m.Id || '',
            sender: m.User || '',
            body: await e2eeDecryptText(m.Text || ''),
            timestamp: new Date(m.Time).getTime(),
          }))).then(formatted => {
            setPinnedMessages(prev => ({ ...prev, [room]: formatted }));
          });
        } catch {}
      }
    } else if (line.startsWith('MSG_PINNED:')) {
      // MSG_PINNED:<room>:<msgId>
      const payload = line.substring(11);
      const idx = payload.indexOf(':');
      if (idx >= 0) {
        const room = payload.substring(0, idx);
        const msgId = payload.substring(idx + 1);
        // Find the message in room history and add it to pinned
        setRoomMessages(prev => {
          const msgs = prev[room] || [];
          const msg = msgs.find(m => m.msgId === msgId);
          if (msg) {
            setPinnedMessages(p => ({
              ...p,
              [room]: [...(p[room] || []), msg],
            }));
          }
          return prev;
        });
      }
    } else if (line.startsWith('MSG_UNPINNED:')) {
      // MSG_UNPINNED:<room>:<msgId>
      const payload = line.substring(13);
      const idx = payload.indexOf(':');
      if (idx >= 0) {
        const room = payload.substring(0, idx);
        const msgId = payload.substring(idx + 1);
        setPinnedMessages(prev => ({
          ...prev,
          [room]: (prev[room] || []).filter(m => m.msgId !== msgId),
        }));
      }
    } else if (line.startsWith('ERROR:')) {
      setStatus(`⚠ ${line.substring(6)}`);
    } else if (line.startsWith('CAMERA_ON:')) {
      const user = line.substring(10);
      setCameraUsers(prev => new Set(prev).add(user));
      playUiSound('cameraOn');
    } else if (line.startsWith('CAMERA_OFF:')) {
      const user = line.substring(11);
      setCameraUsers(prev => { const s = new Set(prev); s.delete(user); return s; });
      activeVideosRef.current.delete(user);
      setActiveVideos(new Set(activeVideosRef.current));
      if (videoDecodersRef.current[user]) { try { videoDecodersRef.current[user].close(); } catch {} delete videoDecodersRef.current[user]; }
      delete decoderTsRef.current[user];
      delete gotKeyframeRef.current[user];
      if (watchingStreamsRef.current.has(user)) {
        watchingStreamsRef.current.delete(user);
        sendToVoice(`CMD:UNWATCH_STREAM:${user}`);
      }
      setWatchingStreams(new Set(watchingStreamsRef.current));
      window.electronAPI.closePopout(user);
      setPoppedOut(prev => { const s = new Set(prev); s.delete(user); return s; });
    } else if (line.startsWith('SCREEN_ON:')) {
      const user = line.substring(10);
      setScreenUsers(prev => new Set(prev).add(user));
      playUiSound('screenOn');
    } else if (line.startsWith('SCREEN_OFF:')) {
      const user = line.substring(11);
      setScreenUsers(prev => { const s = new Set(prev); s.delete(user); return s; });
      activeVideosRef.current.delete(user);
      setActiveVideos(new Set(activeVideosRef.current));
      if (videoDecodersRef.current[user]) { try { videoDecodersRef.current[user].close(); } catch {} delete videoDecodersRef.current[user]; }
      delete decoderTsRef.current[user];
      delete gotKeyframeRef.current[user];
      if (watchingStreamsRef.current.has(user)) {
        watchingStreamsRef.current.delete(user);
        sendToVoice(`CMD:UNWATCH_STREAM:${user}`);
      }
      setWatchingStreams(new Set(watchingStreamsRef.current));
      // Clean up screen audio playback pipeline for this user
      const screenPipeline = userScreenPlaybackRef.current[user];
      if (screenPipeline) { try { screenPipeline.playback.disconnect(); screenPipeline.gain.disconnect(); } catch {} delete userScreenPlaybackRef.current[user]; }
      window.electronAPI.closePopout(user);
      setPoppedOut(prev => { const s = new Set(prev); s.delete(user); return s; });
    } else if (line.startsWith('MENTION:')) {
      // MENTION:<room>:<sender>:<text>
      const i1 = line.indexOf(':', 8);
      const i2 = i1 >= 0 ? line.indexOf(':', i1 + 1) : -1;
      if (i1 >= 0 && i2 >= 0) {
        const room = line.substring(8, i1);
        const sender = line.substring(i1 + 1, i2);
        const rawBody = line.substring(i2 + 1);
        const notifBody = rawBody && !rawBody.startsWith('ENC:') ? rawBody.substring(0, 100) : undefined;
        const level = resolveNotifLevel(connectedServerIdRef.current ?? '', room);
        if (level !== 'none') {
          playUiSound('message');
          window.electronAPI.showNotification(`@${sender} i #${room}`, notifBody);
          if (currentTextRoomRef.current !== room || viewModeRef.current !== 'text') {
            setMentionedRooms(prev => ({ ...prev, [room]: (prev[room] || 0) + 1 }));
          }
        }
      }
    } else if (line.startsWith('DM_KEY:')) {
      // DM_KEY:<username>:<spki-base64|empty> — response to our GET_DM_KEY request
      const i1 = line.indexOf(':', 7);
      if (i1 >= 0) {
        const username = line.substring(7, i1);
        const pubKeyB64 = line.substring(i1 + 1);
        const callbacks = pendingDmKeyCallbacksRef.current.get(username) || [];
        pendingDmKeyCallbacksRef.current.delete(username);
        if (pubKeyB64) {
          deriveDmSharedKey(pubKeyB64).then(key => {
            if (key) dmSharedKeysRef.current.set(username, key);
            callbacks.forEach(cb => cb(key));
          });
          const raw = Uint8Array.from(atob(pubKeyB64), c => c.charCodeAt(0));
          crypto.subtle.digest('SHA-256', raw).then(hash => {
            const fp = Array.from(new Uint8Array(hash).slice(0, 8))
              .map(b => b.toString(16).padStart(2, '0')).join(':');
            setDmKeyFingerprints(prev => ({ ...prev, [username]: fp }));
          });
        } else {
          callbacks.forEach(cb => cb(null));
        }
      }
    } else if (line.startsWith('DM:')) {
      // DM:<fromUser>:<text> — incoming direct message (ECDH-encrypted by sender)
      const i1 = line.indexOf(':', 3);
      if (i1 >= 0) {
        const fromUser = line.substring(3, i1);
        const rawText = line.substring(i1 + 1);
        const handleDecrypted = (body: string) => {
          const msg: DmMessage = { id: crypto.randomUUID(), sender: fromUser, body, timestamp: Date.now() };
          setDmMessages(prev => ({ ...prev, [fromUser]: [...(prev[fromUser] || []), msg] }));
          setOpenDmTabs(prev => {
            if (prev.some(t => t.username === fromUser)) return prev;
            return [...prev, { username: fromUser, serverId }];
          });
          if (activeDmTabRef.current !== fromUser) {
            setDmUnreadCounts(prev => ({ ...prev, [fromUser]: (prev[fromUser] || 0) + 1 }));
          }
          const dmLevel = resolveNotifLevel(connectedServerIdRef.current ?? '');
          if (notificationSoundsRef.current && dmLevel !== 'none') playUiSound('message');
          if (dmLevel !== 'none') window.electronAPI.showNotification(`DM from ${fromUser}`, body.substring(0, 100));
        };
        if (rawText.startsWith('DMENC:')) {
          const cachedKey = dmSharedKeysRef.current.get(fromUser);
          if (cachedKey) {
            dmDecrypt(rawText, cachedKey).then(handleDecrypted);
          } else {
            getDmSharedKey(fromUser).then(key => {
              (key ? dmDecrypt(rawText, key) : Promise.resolve(rawText)).then(handleDecrypted);
            });
          }
        } else {
          handleDecrypted(rawText);
        }
      }
    } else if (line.startsWith('DM_SENT:')) {
      // DM_SENT:<target>:<text> — our own sent DM echoed back (ECDH-encrypted)
      const i1 = line.indexOf(':', 8);
      if (i1 >= 0) {
        const target = line.substring(8, i1);
        const rawText = line.substring(i1 + 1);
        const handleDecrypted = (body: string) => {
          const msg: DmMessage = { id: crypto.randomUUID(), sender: nicknameRef.current, body, timestamp: Date.now() };
          setDmMessages(prev => ({ ...prev, [target]: [...(prev[target] || []), msg] }));
        };
        if (rawText.startsWith('DMENC:')) {
          const cachedKey = dmSharedKeysRef.current.get(target);
          (cachedKey ? dmDecrypt(rawText, cachedKey) : Promise.resolve(rawText)).then(handleDecrypted);
        } else {
          handleDecrypted(rawText);
        }
      }
    } else if (line === 'REQUEST_KEYFRAME') {
      forceKeyframeRef.current = true;
    } else if (line.startsWith('FILE_PROGRESS:')) {
      // FILE_PROGRESS:<room>:<stage>  (received | transcoding | broadcasting | done)
      const payload = line.substring(14);
      const ci = payload.indexOf(':');
      if (ci >= 0) {
        const stage = payload.substring(ci + 1);
        if (stage === 'done') setFileUploadStatus(null);
        else if (stage === 'received') setFileUploadStatus('Processing…');
        else if (stage === 'transcoding') setFileUploadStatus('Transcoding video…');
        else if (stage === 'broadcasting') setFileUploadStatus('Broadcasting…');
      }
    } else if (line.startsWith('SOUNDBOARD:')) {
      try {
        const names: string[] = JSON.parse(line.substring(11));
        setSoundboardSounds(names);
      } catch {}
    } else if (line.startsWith('EMOJIS:')) {
      try {
        const data: Record<string, string> = JSON.parse(line.substring(7));
        setCustomEmojis(data);
      } catch {}
    } else if (line.startsWith('SOUNDBOARD_PLAY:')) {
      // SOUNDBOARD_PLAY:<sender>:<name>:<base64data>
      if (soundboardMutedRef.current) return;
      const i1 = line.indexOf(':', 16);
      const i2 = i1 >= 0 ? line.indexOf(':', i1 + 1) : -1;
      if (i1 >= 0 && i2 >= 0) {
        const sender = line.substring(16, i1);
        const soundName = line.substring(i1 + 1, i2);
        const userSetting = perUserSettingsRef.current[sender];
        if (userSetting?.soundboardMuted) return;
        const base64Data = line.substring(i2 + 1);
        try {
          // Stop any currently playing soundboard sound
          if (soundboardSourceRef.current) {
            try { soundboardSourceRef.current.stop(); } catch {}
            soundboardSourceRef.current = null;
            soundboardGainRef.current = null;
          }
          const binary = atob(base64Data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          let audioCtx = audioCtxRef.current;
          if (!audioCtx || audioCtx.state === 'closed') {
            audioCtx = new AudioContext({ sampleRate: 48000 });
          }
          if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
          }
          audioCtx.decodeAudioData(bytes.buffer).then((buffer) => {
            const source = audioCtx.createBufferSource();
            source.buffer = buffer;
            const gain = audioCtx.createGain();
            gain.gain.value = soundboardVolumeRef.current / 100;
            source.connect(gain);
            gain.connect(audioCtx.destination);
            soundboardSourceRef.current = source;
            soundboardGainRef.current = gain;
            setPlayingSound(soundName);
            source.onended = () => {
              if (soundboardSourceRef.current === source) {
                soundboardSourceRef.current = null;
                soundboardGainRef.current = null;
                setPlayingSound(null);
              }
            };
            source.start();
          }).catch((err) => {
            console.error('[Soundboard] decodeAudioData failed:', err);
          });
        } catch (err) {
          console.error('[Soundboard] Play failed:', err);
        }
      }
    }
  }, []);

  // ── IPC subscriptions ─────────────────────────────────────

  useEffect(() => {
    const unsubs = [
      window.electronAPI.onChatMessage(handleServerMessage),
      window.electronAPI.onChatError((serverId, msg) => {
        if (serverId === connectedServerIdRef.current) {
          setStatus(`Error: ${msg}`);
          setIsConnected(false);
          setConnectedServerId(null);
        }
        setConnectedServerIds(prev => { const s = new Set(prev); s.delete(serverId); return s; });
      }),
      window.electronAPI.onChatDisconnected((serverId) => {
        setConnectedServerIds(prev => { const s = new Set(prev); s.delete(serverId); return s; });
        delete serverStatesRef.current[serverId];
        // If the voice server disconnected (even in background), clean up audio
        if (voiceServerIdRef.current === serverId) {
          setVoiceServerId(null);
          stopAudio();
        }
        if (serverId !== connectedServerIdRef.current) return;
        connectedServerIdRef.current = null;
        window.electronAPI.setEncryptionKey(serverId, null);
        resetServerState();
        setIsConnected(false);
        setConnectedServerId(null);
        setStatus('Disconnected');
        setShowHome(true);
      }),
      window.electronAPI.onAudioReceived((senderName, data) => {
        if (isDeafenedRef.current || !audioCtxRef.current) return;
        // Get or create per-user voice playback pipeline
        let pipeline = userPlaybackRef.current[senderName];
        if (!pipeline && audioCtxRef.current.state === 'running') {
          try {
            const ctx = audioCtxRef.current;
            const playback = new AudioWorkletNode(ctx, 'playback-processor', {
              outputChannelCount: [2],
            });
            const gain = ctx.createGain();
            const s = perUserSettingsRef.current[senderName] || { volume: 100, isMuted: false };
            gain.gain.value = s.isMuted ? 0 : s.volume / 100;
            playback.connect(gain);
            gain.connect(ctx.destination);
            pipeline = { playback, gain };
            userPlaybackRef.current[senderName] = pipeline;
          } catch { return; }
        }
        if (pipeline) {
          const copy = new Uint8Array(data).buffer;
          pipeline.playback.port.postMessage(copy, [copy]);
        }
        // Track speaking state — only show the green ring when the received
        // audio has significant energy (avoids permanent ring from silence frames)
        const pcm = new Int16Array(new Uint8Array(data).buffer);
        let sumSq = 0;
        for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];
        const rms = Math.sqrt(sumSq / pcm.length) / 32768;
        if (rms > 0.01) {
          setSpeakingUsers(prev => { if (prev.has(senderName)) return prev; const s = new Set(prev); s.add(senderName); return s; });
          if (speakingTimeoutsRef.current[senderName]) clearTimeout(speakingTimeoutsRef.current[senderName]);
          speakingTimeoutsRef.current[senderName] = setTimeout(() => {
            setSpeakingUsers(prev => { if (!prev.has(senderName)) return prev; const s = new Set(prev); s.delete(senderName); return s; });
          }, 300);
        }
      }),
      window.electronAPI.onScreenAudioReceived((senderName, data) => {
        if (isDeafenedRef.current || !audioCtxRef.current) return;
        // Only play screen audio from streams the user has opted-in to watch
        if (!watchingStreamsRef.current.has(senderName)) return;
        // Get or create per-user screen audio playback pipeline (independent volume)
        let pipeline = userScreenPlaybackRef.current[senderName];
        if (!pipeline && audioCtxRef.current.state === 'running') {
          try {
            const ctx = audioCtxRef.current;
            const playback = new AudioWorkletNode(ctx, 'playback-processor', {
              outputChannelCount: [2],
            });
            const gain = ctx.createGain();
            const s = perUserSettingsRef.current[senderName] || { screenVolume: 100 };
            gain.gain.value = (s as UserSetting).screenVolume != null ? (s as UserSetting).screenVolume / 100 : 1;
            playback.connect(gain);
            gain.connect(ctx.destination);
            pipeline = { playback, gain };
            userScreenPlaybackRef.current[senderName] = pipeline;
          } catch { return; }
        }
        if (pipeline) {
          const copy = new Uint8Array(data).buffer;
          pipeline.playback.port.postMessage(copy, [copy]);
        }
      }),
      window.electronAPI.onVideoReceived((senderName: string, encodedData: Uint8Array, isKeyFrame: boolean, codec: string) => {
        // Only decode video from streams the user has opted-in to watch
        if (!watchingStreamsRef.current.has(senderName)) return;
        const us = perUserSettingsRef.current[senderName];
        if (us?.screenMuted) return;

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
      window.electronAPI.onPopoutClosed((username: string) => {
        setPoppedOut(prev => { const s = new Set(prev); s.delete(username); return s; });
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [handleServerMessage]);

  // ── Autoconnect background mention listeners (SSE) ────────

  useEffect(() => {
    const unsub = window.electronAPI.onMention((serverId, room, sender, text) => {
      setServerMentions(prev => ({ ...prev, [serverId]: (prev[serverId] || 0) + 1 }));
      const server = pinnedServers.find(s => s.id === serverId);
      const title = server ? server.name : 'Echo';
      playUiSound('message');
      window.electronAPI.showNotification(`${title} — @${sender} i #${room}`, text.substring(0, 100));
    });
    return unsub;
  }, [pinnedServers]);

  useEffect(() => {
    for (const server of pinnedServers) {
      // Never autoconnect to servers with an active TCP connection — same username would kick us
      if (connectedServerIds.has(server.id) || server.id === connectingToServerId) {
        window.electronAPI.stopAutoConnect(server.id);
        continue;
      }
      if (server.autoConnect && server.authToken && server.ssePort) {
        const { host } = parseAddress(server.address);
        window.electronAPI.startAutoConnect(server.id, host, server.ssePort, server.authToken);
      } else {
        window.electronAPI.stopAutoConnect(server.id);
      }
    }
  }, [pinnedServers, connectedServerIds, connectingToServerId]);

  // ── Autoconnect TCP (connect on startup) ──────────────────

  const _tcpAutoConnectDone = useRef(false);

  useEffect(() => {
    if (_tcpAutoConnectDone.current) return;
    _tcpAutoConnectDone.current = true;

    const targets = pinnedServers.filter(s => s.autoConnectTcp && s.username && s.password);
    if (targets.length === 0) return;

    (async () => {
      for (const server of targets) {
        if (connectedServerIds.has(server.id)) continue;
        const { host, port } = parseAddress(server.address);
        setConnecting(true);
        setConnectingToServerId(server.id);
        nicknameRef.current = server.username!;
        connectedHostRef.current = host;
        connectedServerIdRef.current = server.id;
        try {
          await window.electronAPI.connectChat(server.id, host, port, server.username!, server.password!, false, server.serverPassword);
          setNickname(server.username!);
          setServerIp(host);
          setTcpPort(String(port));
          setConnectedServerId(server.id);
          setIsConnected(true);
          setStatus('Connected');
          setShowHome(false);
          addToOpenTabs(server.id);
          setConnectedServerIds(prev => new Set(prev).add(server.id));
        } catch (err: any) {
          connectedServerIdRef.current = null;
          console.warn(`[AutoConnectTCP] Failed to connect to ${server.name}:`, err?.message);
        }
        setConnectingToServerId(null);
        setConnecting(false);
      }
    })();
  }, []); // runs once on mount — pinnedServers is synchronously loaded from localStorage
  // When switching server tabs, currentVoiceRoom changes to the target
  // server's value (often null). If the user is still in voice on another
  // server (voiceServerIdRef is set), we must NOT tear down the audio
  // pipeline — otherwise mic capture and playback stop even though the
  // UDP session is still alive.

  useEffect(() => {
    if (currentVoiceRoom) {
      // Only start if audio isn't already running (avoids teardown+restart on tab switch back)
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        startAudio().catch(err => console.error('Audio start failed:', err));
      }
    } else if (!voiceServerIdRef.current) {
      // No active voice session on any server — safe to stop
      stopAudio();
    }
    return () => {
      // Cleanup: only tear down if there's no voice session active elsewhere
      if (!voiceServerIdRef.current) {
        stopAudio();
      }
    };
  }, [currentVoiceRoom]);

  async function startAudio() {
    stopAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedInputRef.current ? { exact: selectedInputRef.current } : undefined,
          sampleRate: 48000, channelCount: 1,
          echoCancellation: echoCancellationRef.current,
          noiseSuppression: noiseSuppressionRef.current,
          autoGainControl: autoGainControlRef.current,
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
      await ctx.audioWorklet.addModule(`${base}/audio-screen-capture-processor.js`);
      await ctx.audioWorklet.addModule(`${base}/audio-playback-processor.js`);

      // Capture mic → encode → send (mono)
      const source = ctx.createMediaStreamSource(stream);

      // Analyser for mic level indicator
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const capture = new AudioWorkletNode(ctx, 'capture-processor', {
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      capture.port.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          if (!isMutedRef.current) window.electronAPI.sendAudio(e.data);
        } else if (e.data?.type === 'status') {
          const suppressing = (e.data.gateGain as number) < 0.99;
          if (suppressing !== gateActiveRef.current) {
            gateActiveRef.current = suppressing;
            setGateActive(suppressing);
          }
        }
      };
      source.connect(capture);
      capture.port.postMessage({ sensitivity: inputSensitivityRef.current / 100, attackMs: gateAttackRef.current, holdMs: gateHoldRef.current, releaseMs: gateReleaseRef.current, pttMode: pushToTalkModeRef.current, pttHeld: pttHeldRef.current });
      const silent = ctx.createGain();
      silent.gain.value = 0;
      capture.connect(silent);
      silent.connect(ctx.destination);
      captureRef.current = capture;

      // Start mic level monitoring
      if (micLevelIntervalRef.current) clearInterval(micLevelIntervalRef.current);
      const levelData = new Uint8Array(analyser.frequencyBinCount);
      let prevLevel = 0;
      micLevelIntervalRef.current = setInterval(() => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(levelData);
        let sum = 0;
        for (let i = 0; i < levelData.length; i++) {
          const v = (levelData[i] - 128) / 128;
          sum += v * v;
        }
        const newLevel = Math.min(1, Math.sqrt(sum / levelData.length) * 3);
        if (Math.abs(newLevel - prevLevel) > 0.02) {
          prevLevel = newLevel;
          setMicLevel(newLevel);
        }
      }, 100);

      // Playback: per-user pipelines are created dynamically in onAudioReceived
      console.log('[Audio] Pipeline ready — capture + per-user playback');
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
    screenCaptureRef.current = null;
    // Clean up per-user voice playback pipelines
    for (const p of Object.values(userPlaybackRef.current)) {
      try { p.playback.disconnect(); p.gain.disconnect(); } catch {}
    }
    userPlaybackRef.current = {};
    // Clean up per-user screen audio playback pipelines
    for (const p of Object.values(userScreenPlaybackRef.current)) {
      try { p.playback.disconnect(); p.gain.disconnect(); } catch {}
    }
    userScreenPlaybackRef.current = {};
    // Clear speaking state
    for (const t of Object.values(speakingTimeoutsRef.current)) clearTimeout(t);
    speakingTimeoutsRef.current = {};
    setSpeakingUsers(new Set());
  }

  async function createVideoEncoder(width: number, height: number, bitrate: number, framerate: number, bitrateMode: 'constant' | 'variable' = 'constant') {
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
      bitrateMode,
      latencyMode: 'realtime',
      ...(codecId === 'h264' ? { avc: { format: 'annexb' } } : {}),
    });
    console.log(`[Video] Encoder: ${codecId} ${width}x${height} @ ${bitrate / 1000}kbps (${bitrateMode})`);
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

      const { encoder: enc, codec: codecId } = await createVideoEncoder(capW, capH, bitrate, capFps, 'variable');
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
          const forceKey = forceKeyframeRef.current;
          if (forceKey) forceKeyframeRef.current = false;
          enc.encode(frame, { keyFrame: frameCount % keyInterval === 0 || forceKey });
          frame.close();
          frameCount++;
        }
      }, Math.round(1000 / capFps));
      captureTypeRef.current = 'camera';
      setIsCameraOn(true);
      sendToVoice('CMD:CAMERA_ON');
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
      // Check if native process-targeted loopback is available (Windows 10 2004+).
      // If so, use it instead of Chromium's built-in loopback — it captures only the
      // target app's audio (window shares) or all audio except Electron (screen shares).
      let useNativeLoopback = false;
      if (screenShareAudio && sourceId) {
        try {
          const supported = await window.electronAPI.loopbackSupported();
          if (supported) {
            const loopResult = await window.electronAPI.startLoopback(sourceId);
            if (loopResult.success) {
              useNativeLoopback = true;
              nativeLoopbackRef.current = true;
            } else {
              console.warn('[ScreenShare] Native loopback failed, using Chromium fallback:', loopResult.error);
            }
          }
        } catch {}
      }

      if (sourceId) {
        // When using native loopback, don't request Chromium loopback audio —
        // the native addon handles audio capture directly in the main process.
        await window.electronAPI.setShareSource(sourceId, useNativeLoopback ? false : screenShareAudio);
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: capFps, max: capFps } },
        audio: useNativeLoopback ? false : screenShareAudio,
      });
      cameraStreamRef.current = stream;

      // Chromium loopback path — used when native loopback is unavailable or failed
      if (!useNativeLoopback) {
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack && audioCtxRef.current) {
          const audioStream = new MediaStream([audioTrack]);
          const systemSource = audioCtxRef.current.createMediaStreamSource(audioStream);
          const screenCapture = new AudioWorkletNode(audioCtxRef.current, 'screen-capture-processor', {
            channelCount: 2,
            channelCountMode: 'explicit',
          });
          screenCapture.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
            window.electronAPI.sendScreenAudio(e.data);
          };
          systemSource.connect(screenCapture);
          const silent = audioCtxRef.current.createGain();
          silent.gain.value = 0;
          screenCapture.connect(silent);
          silent.connect(audioCtxRef.current.destination);
          systemAudioSourceRef.current = systemSource;
          screenCaptureRef.current = screenCapture;
        }
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
        capFps, screenShareVbr ? 'variable' : 'constant');
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
          const forceKey = forceKeyframeRef.current;
          if (forceKey) forceKeyframeRef.current = false;
          enc.encode(frame, { keyFrame: frameCount % keyInterval === 0 || forceKey });
          frame.close();
          frameCount++;
        }
      }, Math.round(1000 / capFps));
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopVideoCapture());
      captureTypeRef.current = 'screen';
      setIsScreenSharing(true);
      sendToVoice('CMD:SCREEN_ON');
    } catch (err) {
      // Clean up native loopback if it was started but getDisplayMedia failed
      // (e.g. user cancelled the picker dialog)
      if (nativeLoopbackRef.current) {
        window.electronAPI.stopLoopback();
        nativeLoopbackRef.current = false;
      }
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
    if (screenCaptureRef.current) {
      try { screenCaptureRef.current.disconnect(); } catch {}
      screenCaptureRef.current = null;
    }
    if (nativeLoopbackRef.current) {
      window.electronAPI.stopLoopback();
      nativeLoopbackRef.current = false;
    }
    if (captureTypeRef.current === 'camera') sendToVoice('CMD:CAMERA_OFF');
    if (captureTypeRef.current === 'screen') sendToVoice('CMD:SCREEN_OFF');
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
    setPoppedOut(new Set());
    watchingStreamsRef.current = new Set();
    setWatchingStreams(new Set());
  }

  const openScreenShareDialog = async () => {
    setScreenShareDialog(true);
    setSourceTab('screen');
    setSelectedSource(null);
    setScreenSources([]);
    setScreenSourcesLoaded(false);
    try {
      const sources = await window.electronAPI.getScreenSources();
      setScreenSources(sources);
      setScreenSourcesLoaded(true);
      const firstScreen = sources.find((s: any) => s.isScreen);
      if (firstScreen) setSelectedSource(firstScreen.id);
    } catch (err) {
      console.error('[ScreenShare] Failed to get sources:', err);
      setScreenSourcesLoaded(true);
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

  const myAvatar = useMemo(() => onlineUsers.find(u => u.name === nickname)?.avatar || null, [onlineUsers, nickname]);

  function openAvatarPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const img = new window.Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); setAvatarEditor({ img, zoom: 1, offsetX: 0, offsetY: 0 }); };
      img.src = url;
    };
    input.click();
  }

  function exportAvatar(editor: NonNullable<typeof avatarEditor>): string {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const { img, zoom, offsetX, offsetY } = editor;
    const minDim = Math.min(img.width, img.height);
    const srcSize = minDim / zoom;
    const sx = (img.width - srcSize) / 2 - (offsetX / size) * srcSize;
    const sy = (img.height - srcSize) / 2 - (offsetY / size) * srcSize;
    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  }

  function saveAvatar() {
    if (!avatarEditor) return;
    const base64 = exportAvatar(avatarEditor);
    sendToServer(`CMD:SET_AVATAR:${base64}`);
    setAvatarEditor(null);
  }

  function removeAvatar() {
    sendToServer('CMD:REMOVE_AVATAR');
  }

  function openLogoPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const img = new window.Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); setLogoEditor({ img, zoom: 1, offsetX: 0, offsetY: 0 }); };
      img.src = url;
    };
    input.click();
  }

  function openEmojiPicker() {
    const nameInput = document.getElementById('srv-emoji-name') as HTMLInputElement;
    const name = nameInput?.value?.trim();
    if (!name) { nameInput?.focus(); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const img = new window.Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); setEmojiEditor({ img, zoom: 1, offsetX: 0, offsetY: 0, name }); };
      img.src = url;
    };
    input.click();
  }

  function exportEmoji(editor: NonNullable<typeof emojiEditor>): string {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const { img, zoom, offsetX, offsetY } = editor;
    const minDim = Math.min(img.width, img.height);
    const srcSize = minDim / zoom;
    const sx = (img.width - srcSize) / 2 - (offsetX / 192) * srcSize;
    const sy = (img.height - srcSize) / 2 - (offsetY / 192) * srcSize;
    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
    return canvas.toDataURL('image/png').split(',')[1];
  }

  function saveEmoji() {
    if (!emojiEditor) return;
    const base64 = exportEmoji(emojiEditor);
    sendToServer(`CMD:UPLOAD_EMOJI:${emojiEditor.name}:${base64}`);
    const nameInput = document.getElementById('srv-emoji-name') as HTMLInputElement;
    if (nameInput) nameInput.value = '';
    setEmojiEditor(null);
  }

  function exportLogo(editor: NonNullable<typeof logoEditor>): string {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const { img, zoom, offsetX, offsetY } = editor;
    const minDim = Math.min(img.width, img.height);
    const srcSize = minDim / zoom;
    const sx = (img.width - srcSize) / 2 - (offsetX / size) * srcSize;
    const sy = (img.height - srcSize) / 2 - (offsetY / size) * srcSize;
    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
    return canvas.toDataURL('image/png', 0.9);
  }

  function saveLogo() {
    if (!logoEditor) return;
    const dataUri = exportLogo(logoEditor);
    sendToServer(`CMD:UPDATE_SERVER_CONFIG:${JSON.stringify({ ServerLogo: dataUri })}`);
    setLogoEditor(null);
  }

  function stageFile(file: File) {
    if (!currentTextRoom) return;
    const maxBytes = (serverInfo?.maxFileSizeKB || 2048) * 1024;
    if (file.size > maxBytes) {
      setStatus(`File too large (max ${serverInfo?.maxFileSizeKB || 2048} KB)`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      const mimeType = file.type || 'application/octet-stream';
      setPendingFile({ name: file.name, mimeType, base64, dataUrl });
    };
    reader.readAsDataURL(file);
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) stageFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) stageFile(file);
        return;
      }
    }
  }

  async function searchGifs(query: string) {
    const key = serverInfo?.giphyApiKey;
    if (!key) return;
    setGifLoading(true);
    try {
      const endpoint = query.trim()
        ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(query)}&limit=20&rating=g`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=20&rating=g`;
      const res = await fetch(endpoint);
      const data = await res.json();
      setGifResults((data.data || []).map((r: any) => ({
        id: r.id,
        preview: r.images?.fixed_height_small?.url || r.images?.fixed_height?.url || '',
        url: r.images?.original?.url || r.images?.fixed_height?.url || '',
      })));
    } catch { setGifResults([]); }
    setGifLoading(false);
  }

  function sendGif(url: string) {
    if (!currentTextRoom) return;
    const text = `__GIF__:${url}`;
    sendToServer(`MSG:${currentTextRoom}:${text}`);
    setShowGifPicker(false);
    setGifQuery('');
    setGifResults([]);
  }

  function renderMessageBody(body: string) {
    const isServerTrusted = pinnedServers.find(s => s.id === connectedServerIdRef.current)?.trusted ?? false;
    if (body.startsWith('__GIF__:')) {
      const url = body.substring('__GIF__:'.length);
      if (!isServerTrusted && !unlockedGifUrls.has(url)) {
        return (
          <div className="mt-1">
            <button
              onClick={() => setUnlockedGifUrls(prev => new Set(prev).add(url))}
              className="flex items-center gap-2 bg-yellow-900/20 border border-yellow-800/30 rounded-lg px-3 py-2 text-[10px] text-yellow-700 hover:bg-yellow-900/30 transition-all">
              <Shield className="w-3 h-3 flex-shrink-0" />
              <span>GIF blocked — untrusted server. Click to load (reveals your IP to the image host).</span>
            </button>
          </div>
        );
      }
      return (
        <div className="mt-1">
          <img src={url} alt="GIF"
            className="max-w-sm max-h-80 rounded-lg border border-green-900/30 cursor-pointer hover:border-green-700/50 transition-all"
            onClick={() => setLightboxSrc(url)} />
          <div className="text-[10px] text-green-800 mt-0.5">GIF</div>
        </div>
      );
    }
    if (body.startsWith('__FILE_REF__:')) {
      // Server-hosted file reference: __FILE_REF__:<fileId>:<fileName>:<mimeType>
      const rest = body.substring('__FILE_REF__:'.length);
      const parts = rest.split(':');
      if (parts.length >= 3) {
        const fileId = parts[0];
        const fileName = parts[1];
        const mimeType = parts.slice(2).join(':');
        const currentServer = pinnedServers.find(s => s.id === connectedServerIdRef.current);
        const serverHost = currentServer?.address?.split(':')[0] || '';
        const filePort = serverInfo?.fileServerPort;
        const fileUrl = filePort ? `http://${serverHost}:${filePort}/file/${fileId}` : '';
        if (mimeType.startsWith('video/') && fileUrl) {
          return (
            <div className="mt-1">
              <video src={fileUrl} controls preload="metadata"
                className="max-w-sm max-h-80 rounded-lg border border-green-900/30" />
              <div className="text-xs text-green-700 mt-1 flex items-center gap-1">
                <Play className="w-3 h-3" />
                {fileName}
              </div>
            </div>
          );
        }
        if (mimeType.startsWith('image/') && fileUrl) {
          return (
            <div className="mt-1">
              <img src={fileUrl} alt={fileName}
                className="max-w-sm max-h-80 rounded-lg border border-green-900/30 cursor-pointer hover:border-green-700/50 transition-all"
                onClick={() => setLightboxSrc(fileUrl)} />
              <div className="text-xs text-green-700 mt-1 flex items-center gap-1">
                <FileText className="w-3 h-3" />
                {fileName}
              </div>
            </div>
          );
        }
        if (mimeType.startsWith('audio/') && fileUrl) {
          return (
            <div className="mt-1">
              <audio src={fileUrl} controls preload="metadata" className="max-w-sm rounded-lg" />
              <div className="text-xs text-green-700 mt-1 flex items-center gap-1">
                <Music className="w-3 h-3" />
                {fileName}
              </div>
            </div>
          );
        }
        return (
          <div className="mt-1 inline-flex items-center gap-3 bg-[#0a0e0a] border border-green-900/30 rounded-lg px-4 py-3 hover:border-green-700/50 transition-all">
            <FileText className="w-8 h-8 text-green-600" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-green-400 truncate">{fileName}</div>
              <div className="text-xs text-green-700">{mimeType}</div>
            </div>
            {fileUrl && (
              <a href={fileUrl} download={fileName}
                className="p-2 rounded-lg bg-green-900/20 text-green-500 hover:bg-green-900/40 transition-all"
                title={isServerTrusted ? undefined : 'Untrusted server — verify this file before opening'}>
                <Download className="w-4 h-4" />
              </a>
            )}
          </div>
        );
      }
    }
    if (body.startsWith('__FILE__:')) {
      const rest = body.substring('__FILE__:'.length);
      const i1 = rest.indexOf(':');
      if (i1 < 0) return <>{body}</>;
      const fileName = rest.substring(0, i1);
      const rest2 = rest.substring(i1 + 1);
      const i2 = rest2.indexOf(':');
      if (i2 < 0) return <>{body}</>;
      const mimeType = rest2.substring(0, i2);
      const base64Data = rest2.substring(i2 + 1);
      const dataUrl = `data:${mimeType};base64,${base64Data}`;
      if (mimeType.startsWith('image/')) {
        return (
          <div className="mt-1">
            <img src={dataUrl} alt={fileName}
              className="max-w-sm max-h-80 rounded-lg border border-green-900/30 cursor-pointer hover:border-green-700/50 transition-all"
              onClick={() => setLightboxSrc(dataUrl)} />
            <div className="text-xs text-green-700 mt-1 flex items-center gap-1">
              <FileText className="w-3 h-3" />
              {fileName}
            </div>
          </div>
        );
      }
      if (mimeType.startsWith('video/')) {
        return (
          <div className="mt-1">
            <BlobMedia type="video" base64={base64Data} mimeType={mimeType}
              className="max-w-sm max-h-80 rounded-lg border border-green-900/30" />
            <div className="text-xs text-green-700 mt-1 flex items-center gap-1">
              <Play className="w-3 h-3" />
              {fileName}
            </div>
          </div>
        );
      }
      if (mimeType.startsWith('audio/')) {
        return (
          <div className="mt-1">
            <BlobMedia type="audio" base64={base64Data} mimeType={mimeType}
              className="max-w-sm rounded-lg" />
            <div className="text-xs text-green-700 mt-1 flex items-center gap-1">
              <Music className="w-3 h-3" />
              {fileName}
            </div>
          </div>
        );
      }
      return (
        <div className="mt-1 inline-flex items-center gap-3 bg-[#0a0e0a] border border-green-900/30 rounded-lg px-4 py-3 hover:border-green-700/50 transition-all">
          <FileText className="w-8 h-8 text-green-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-green-400 truncate">{fileName}</div>
            <div className="text-xs text-green-700">{mimeType}</div>
          </div>
          <a href={dataUrl} download={fileName}
            className="p-2 rounded-lg bg-green-900/20 text-green-500 hover:bg-green-900/40 transition-all">
            <Download className="w-4 h-4" />
          </a>
        </div>
      );
    }
    // Replace :shortcode: with emojis
    return renderEmojiText(body);
  }

  function renderEmojiText(text: string): React.ReactNode {
    const parts: React.ReactNode[] = [];
    const regex = /:([a-zA-Z0-9_+-]+):/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push(text.substring(lastIndex, match.index));
      const code = match[1].toLowerCase();
      const customData = customEmojis[code];
      if (customData) {
        parts.push(<img key={match.index} src={`data:image/png;base64,${customData}`} alt={`:${code}:`} title={`:${code}:`} className="inline-block w-6 h-6 align-middle object-contain" />);
      } else if (EMOJI_SHORTCODES[code]) {
        parts.push(<span key={match.index} title={`:${code}:`}>{EMOJI_SHORTCODES[code]}</span>);
      } else {
        parts.push(match[0]);
      }
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) parts.push(text.substring(lastIndex));
    return parts.length === 1 && typeof parts[0] === 'string' ? <>{parts[0]}</> : <>{parts}</>;
  }

  function UserAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
    const user = onlineUsers.find(u => u.name === name);
    const avatar = user?.avatar;
    const px = size === 'sm' ? 'w-6 h-6' : size === 'md' ? 'w-8 h-8' : 'w-12 h-12';
    const dotPx = size === 'sm' ? 'w-2 h-2' : size === 'md' ? 'w-3 h-3' : 'w-3.5 h-3.5';
    const dotPos = 'bottom-0 right-0';
    const textSz = size === 'sm' ? 'text-[10px]' : size === 'md' ? 'text-xs' : 'text-lg';
    const dotColor = user?.status === 'away' ? '#eab308' : user?.status === 'online' ? '#22c55e' : '#ef4444';
    const dot = <span className={`absolute ${dotPos} ${dotPx} rounded-full ring-2 ring-[#0a0e0a]`} style={{ backgroundColor: dotColor }} />;
    if (avatar) {
      return (
        <div className={`${px} relative flex-shrink-0 overflow-visible`}>
          <img src={`data:image/jpeg;base64,${avatar}`} className={`${px} rounded-full object-cover`} />
          {dot}
        </div>
      );
    }
    const color = user?.roleColor || '#22c55e';
    return (
      <div className={`${px} relative flex-shrink-0 overflow-visible`}>
        <div className={`${px} rounded-full flex items-center justify-center ${textSz} font-bold text-white`}
          style={{ backgroundColor: color + '40', color }}>
          {name.charAt(0).toUpperCase()}
        </div>
        {dot}
      </div>
    );
  }

  async function restartAudio() {
    if (currentVoiceRoom) {
      stopAudio();
      await startAudio();
    }
  }

  // ── Call duration timer

  useEffect(() => {
    if (!currentVoiceRoom) { setCallDuration(0); setViewModeTracked('text'); setIsScreenSharing(false); setSelectedVideoFeed(null); setIsCallFullscreen(false); setHideUiOverlay(false); setMouseActive(true); return; }
    const iv = setInterval(() => setCallDuration(d => d + 1), 1000);
    return () => clearInterval(iv);
  }, [currentVoiceRoom]);

  // ── Taskbar / dock badge ──────────────────────────────────

  useEffect(() => {
    const mentionTotal = Object.values(mentionedRooms).reduce((s, n) => s + n, 0);
    const dmTotal = Object.values(dmUnreadCounts).reduce((s, n) => s + n, 0);
    window.electronAPI.setBadge(mentionTotal + dmTotal);
  }, [mentionedRooms, dmUnreadCounts]);

  // ── Auto‑scroll ───────────────────────────────────────────

  const loadingOlderRef = useRef(false);
  const prevTextRoomRef = useRef<string | null>(null);

  useEffect(() => {
    // Don't auto-scroll to bottom when we just prepended older messages
    if (loadingOlderRef.current) {
      loadingOlderRef.current = false;
      return;
    }
    // Instant scroll when switching rooms or on initial load; smooth for new messages
    const roomChanged = currentTextRoom !== prevTextRoomRef.current;
    prevTextRoomRef.current = currentTextRoom;
    messagesEndRef.current?.scrollIntoView({ behavior: roomChanged ? 'instant' : 'smooth' });
  }, [roomMessages, currentTextRoom]);

  const prevDmTabRef = useRef<string | null>(null);

  useEffect(() => {
    const tabChanged = activeDmTab !== prevDmTabRef.current;
    prevDmTabRef.current = activeDmTab;
    dmMessagesEndRef.current?.scrollIntoView({ behavior: tabChanged ? 'instant' : 'smooth' });
  }, [dmMessages, activeDmTab]);

  // ── Load older messages on scroll-to-top ──────────────────

  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el || !currentTextRoom) return;
    if (el.scrollTop > 80) return;
    if (!roomHasMore[currentTextRoom]) return;
    if (roomLoadingMore[currentTextRoom]) return;
    const msgs = roomMessages[currentTextRoom] || [];
    if (msgs.length === 0) return;
    const oldestMsgId = msgs[0].msgId;
    if (!oldestMsgId) return;
    loadingOlderRef.current = true;
    setRoomLoadingMore(prev => ({ ...prev, [currentTextRoom]: true }));
    sendToServer(`CMD:FETCH_HISTORY:${currentTextRoom}:${oldestMsgId}:50`);
  }, [currentTextRoom, roomHasMore, roomLoadingMore, roomMessages, sendToServer]);

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

  const currentMessages = useMemo(() => currentTextRoom ? (roomMessages[currentTextRoom] || []) : [], [currentTextRoom, roomMessages]);
  const usersInRoom = useMemo(() => onlineUsers.filter(u => u.online && u.voiceRoom === currentVoiceRoom), [onlineUsers, currentVoiceRoom]);

  // Track voice room membership changes for join/leave sounds
  useEffect(() => {
    if (!currentVoiceRoom) { prevVoiceUsersRef.current = new Set(); return; }
    const currentUsers = new Set(usersInRoom.map(u => u.name));
    const prev = prevVoiceUsersRef.current;
    if (prev.size > 0) {
      for (const n of currentUsers) {
        if (!prev.has(n) && n !== nickname) { playUiSound('userJoin'); break; }
      }
      for (const n of prev) {
        if (!currentUsers.has(n) && n !== nickname) { playUiSound('userLeave'); break; }
      }
    }
    prevVoiceUsersRef.current = currentUsers;
  }, [usersInRoom, currentVoiceRoom]);
  const isVideoMode = isCameraOn || isScreenSharing || cameraUsers.size > 0 || screenUsers.size > 0;
  const onlineUsersList = useMemo(() => onlineUsers.filter(u => u.online && u.status !== 'away'), [onlineUsers]);
  const awayUsersList = useMemo(() => onlineUsers.filter(u => u.online && u.status === 'away'), [onlineUsers]);
  const offlineUsersList = useMemo(() => onlineUsers.filter(u => !u.online), [onlineUsers]);

  const myPermissions = useMemo(() => {
    const ALL_PERMS = ['admin', 'manage_roles', 'create_rooms', 'delete_rooms', 'reorder_rooms', 'kick_users', 'delete_messages', 'pin_messages', 'manage_soundboard', 'manage_emojis', 'server_settings'];
    const perms = new Set<string>();
    const myUser = onlineUsers.find(u => u.name === nickname);
    if (myUser) {
      for (const roleName of myUser.roles) {
        const role = serverRoles.find(r => r.name === roleName);
        if (role) {
          if (role.permissions.includes('admin')) { ALL_PERMS.forEach(p => perms.add(p)); }
          else role.permissions.forEach(p => perms.add(p));
        }
      }
    }
    return perms;
  }, [onlineUsers, nickname, serverRoles]);
  const hasPermission = useCallback((perm: string) => myPermissions.has('admin') || myPermissions.has(perm), [myPermissions]);

  // ── Pinned Server Functions ───────────────────────────────

  const addToOpenTabs = (serverId: string) => {
    setOpenTabs(prev => prev.includes(serverId) ? prev : [...prev, serverId]);
  };

  const isFriend = (username: string, serverId: string) =>
    friends.some(f => f.username === username && f.serverId === serverId);

  const addFriend = (username: string, serverId: string) => {
    if (username === nickname) return;
    setFriends(prev => prev.some(f => f.username === username && f.serverId === serverId) ? prev : [...prev, { username, serverId }]);
  };

  const removeFriend = (username: string, serverId: string) => {
    setFriends(prev => prev.filter(f => !(f.username === username && f.serverId === serverId)));
  };

  const getFriendOnlineStatus = (friend: Friend): { status: 'online' | 'away' | 'offline'; online: boolean } => {
    if (connectedServerId === friend.serverId) {
      const u = onlineUsers.find(u => u.name === friend.username);
      if (u) return { status: u.status, online: u.online };
    }
    const snap = serverStatesRef.current[friend.serverId];
    if (snap) {
      const u = snap.onlineUsers.find(u => u.name === friend.username);
      if (u) return { status: u.status, online: u.online };
    }
    return { status: 'offline', online: false };
  };

  const openInlineDm = (username: string, serverId: string) => {
    if (username === nickname) return;
    setOpenDmTabs(prev => {
      if (prev.some(t => t.username === username && t.serverId === serverId)) return prev;
      return [...prev, { username, serverId }];
    });
    pushNav({ type: 'dm', username });
    setActiveDmTab(username);
    setDmInput('');
    setShowHome(false);
    setDmUnreadCounts(prev => { const n = { ...prev }; delete n[username]; return n; });
  };

  const connectToPinnedServer = async (server: PinnedServer) => {
    // If clicking the currently connected server, go back to chat
    if (isConnected && connectedServerId === server.id) {
      setShowHome(false);
      return;
    }
    // If this server is already connected in the background, switch to it
    if (connectedServerIds.has(server.id) && server.id !== connectedServerId) {
      // Save current server's state
      if (connectedServerId) {
        serverStatesRef.current[connectedServerId] = takeServerSnapshot();
      }
      // Restore target server's state
      const cached = serverStatesRef.current[server.id];
      if (cached) restoreServerSnapshot(cached);
      else resetServerState();
      connectedServerIdRef.current = server.id;
      setConnectedServerId(server.id);
      setIsConnected(true);
      setShowHome(false);
      setStatus('Connected');
      addToOpenTabs(server.id);
      // Restore E2EE key for this server and re-decrypt cached messages
      if (cached?.e2eeActive) {
        try {
          const stored = JSON.parse(localStorage.getItem('voip-e2ee-keys') || '{}');
          const passphrase = stored[server.id];
          if (passphrase) activateE2ee(passphrase);
          else { e2eeKeyRef.current = null; setE2eeActive(false); }
        } catch { e2eeKeyRef.current = null; setE2eeActive(false); }
      } else {
        e2eeKeyRef.current = null;
      }
      return;
    }
    // Connect to a new server (keep other connections alive)
    if (isConnected && connectedServerId) {
      // Save current server's state before switching view
      serverStatesRef.current[connectedServerId] = takeServerSnapshot();
      resetServerState();
    }
    if (server.username && server.password) {
      const { host, port } = parseAddress(server.address);
      window.electronAPI.stopAutoConnect(server.id);
      setConnecting(true);
      setConnectingToServerId(server.id);
      setStatus('Connecting...');
      setNickname(server.username);
      nicknameRef.current = server.username;
      connectedHostRef.current = host;
      // Set ref BEFORE await so incoming messages are recognized as active server
      const prevServerId = connectedServerIdRef.current;
      connectedServerIdRef.current = server.id;
      try {
        await window.electronAPI.connectChat(server.id, host, port, server.username, server.password, false, server.serverPassword);
        setServerIp(host);
        setTcpPort(String(port));
        setConnectedServerId(server.id);
        setIsConnected(true);
        setStatus('Connected');
        setShowHome(false);
        addToOpenTabs(server.id);
        setConnectedServerIds(prev => new Set(prev).add(server.id));
      } catch (err: any) {
        connectedServerIdRef.current = prevServerId;
        const msg = err?.message || '';
        if (msg.includes('SERVER_PASSWORD_REQUIRED') || msg.includes('SERVER_PASSWORD_FAIL')) {
          setServerPasswordDialog({ address: server.address, username: server.username, password: server.password, isRegister: false, serverId: server.id });
          setServerPasswordInput('');
          setStatus(msg.includes('FAIL') ? 'Forkert server-adgangskode' : 'Server kræver adgangskode');
        } else {
          setStatus(`Failed: ${msg}`);
        }
      }
      setConnectingToServerId(null);
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
    // Set ref BEFORE await so incoming messages are recognized as active server
    const prevServerId = connectedServerIdRef.current;
    connectedServerIdRef.current = loginDialog;
    try {
      nicknameRef.current = nickname;
      connectedHostRef.current = host;
      await window.electronAPI.connectChat(loginDialog, host, port, nickname, password, isRegister, server.serverPassword);
      setPinnedServers(prev => prev.map(s =>
        s.id === loginDialog ? { ...s, username: nickname, password } : s
      ));
      setServerIp(host);
      setTcpPort(String(port));
      setConnectedServerId(loginDialog);
      setIsConnected(true);
      setStatus('Connected');
      pushNav({ type: 'server', serverId: loginDialog, view: 'text', textRoom: null });
      setShowHome(false);
      setLoginDialog(null);
      addToOpenTabs(loginDialog);
      setConnectedServerIds(prev => new Set(prev).add(loginDialog));
    } catch (err: any) {
      connectedServerIdRef.current = prevServerId;
      const msg = err?.message || '';
      if (msg.includes('SERVER_PASSWORD_REQUIRED') || msg.includes('SERVER_PASSWORD_FAIL')) {
       setLoginDialog(null);
       setServerPasswordDialog({ address: server.address, username: nickname, password, isRegister, serverId: server.id });
       setServerPasswordInput('');
       setStatus(msg.includes('FAIL') ? 'Forkert server-adgangskode' : 'Server kræver adgangskode');
      } else {
        setStatus(`Failed: ${msg}`);
      }
    }
    setConnectingToServerId(null);
    setConnecting(false);
  };

  const addPinnedServer = () => {
    if (!newServerAddress.trim()) return;
    setPinnedServers(prev => [...prev, {
      id: crypto.randomUUID(),
      name: newServerName.trim() || newServerAddress.trim(),
      address: newServerAddress.trim(),
      trusted: newServerTrusted,
    }]);
    setAddServerDialog(false);
    setNewServerName('');
    setNewServerAddress('');
    setNewServerTrusted(false);
  };

  const unpinServer = (serverId: string) => {
    setPinnedServers(prev => prev.filter(s => s.id !== serverId));
    setOpenTabs(prev => prev.filter(id => id !== serverId));
    setServerContextMenu(null);
  };

  const logoutServer = (serverId: string) => {
    setPinnedServers(prev => prev.map(s =>
      s.id === serverId ? { ...s, username: undefined, password: undefined } : s
    ));
    setServerContextMenu(null);
  };

  const toggleServerTrust = (serverId: string) => {
    setPinnedServers(prev => prev.map(s =>
      s.id === serverId ? { ...s, trusted: !s.trusted } : s
    ));
    setServerContextMenu(null);
  };

  const toggleAutoConnect = (serverId: string) => {
    setPinnedServers(prev => prev.map(s =>
      s.id === serverId ? { ...s, autoConnect: !s.autoConnect } : s
    ));
    setServerContextMenu(null);
  };

  const toggleAutoConnectTcp = (serverId: string) => {
    setPinnedServers(prev => prev.map(s =>
      s.id === serverId ? { ...s, autoConnectTcp: !s.autoConnectTcp } : s
    ));
    setServerContextMenu(null);
  };

  // ── Chat submit ───────────────────────────────────────────

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTextRoom) return;
    if (!input.trim() && !pendingFile) return;
    try {
      if (pendingFile) {
        let { name: fName, mimeType: fMime, base64: fData } = pendingFile;
        setFileUploadStatus('Sending…');

        // ── Video file upload strategy ──
        // 1. If the server has a file server enabled → upload via HTTP (server transcodes, works with E2EE)
        // 2. Else send inline as base64
        const fileServerPort = serverInfo?.fileServerPort;
        const currentServer = pinnedServers.find(s => s.id === connectedServerIdRef.current);
        const serverHost = currentServer?.address?.split(':')[0];
        const authToken = currentServer?.authToken;

        if (fMime.startsWith('video/') && fileServerPort && serverHost && authToken) {
          // Upload to server's file server — server handles transcoding
          try {
            setFileUploadStatus('Uploading…');
            const timeout = new Promise<null>(r => setTimeout(r, 60000, null));
            const result = await Promise.race([
              window.electronAPI.uploadFile(serverHost, fileServerPort, authToken, fName, fMime, fData),
              timeout,
            ]);
            if (result?.fileId) {
              // Send a file reference message (the file lives on the server's HTTP endpoint)
              const refBody = `__FILE_REF__:${result.fileId}:${result.fileName}:${result.mimeType}`;
              if (e2eeKeyRef.current) {
                const encrypted = await e2eeEncryptText(refBody);
                sendToServer(`MSG:${currentTextRoom}:${encrypted}`);
              } else {
                sendToServer(`MSG:${currentTextRoom}:${refBody}`);
              }
              setPendingFile(null);
              setFileUploadStatus(null);
              if (input.trim()) {
                const body = await e2eeEncryptText(input);
                sendToServer(`MSG:${currentTextRoom}:${body}`);
                setInput('');
              }
              return;
            }
            // Upload failed — fall through to inline path
          } catch { setFileUploadStatus(null); }
        }

        if (e2eeKeyRef.current) {
          const fileBody = `__FILE__:${fName}:${fMime}:${fData}`;
          const encrypted = await e2eeEncryptText(fileBody);
          sendToServer(`MSG:${currentTextRoom}:${encrypted}`);
          setFileUploadStatus(null);
        } else {
          sendToServer(`FILE:${currentTextRoom}:${fName}:${fMime}:${fData}`);
          // Status will be cleared by FILE_PROGRESS:done from server
        }
        setPendingFile(null);
      }
      if (input.trim()) {
        const mentions = e2eeKeyRef.current ? [...new Set((input.match(/@(\w+)/g) || []).map(m => m.substring(1)))] : [];
        const body = await e2eeEncryptText(input);
        sendToServer(`MSG:${currentTextRoom}:${body}`);
        if (mentions.length > 0) {
          sendToServer(`CMD:NOTIFY_MENTIONS:${currentTextRoom}:${mentions.join(',')}`);
        }
        setInput('');
      }
    } catch (err: any) {
      console.error('[Chat] Send failed:', err);
      setStatus(`⚠ Send failed: ${err?.message || 'unknown error'}`);
      setFileUploadStatus(null);
    }
  };

  // ── Room actions ──────────────────────────────────────────

  // Leave voice on another server and switch UDP to the current one
  const ensureVoiceOnCurrentServer = async () => {
    const oldVoiceSid = voiceServerIdRef.current;
    const targetSid = connectedServerIdRef.current;
    if (oldVoiceSid && oldVoiceSid !== targetSid) {
      // Stop camera/screen capture if active
      stopVideoCapture();
      cleanupVideo();
      // Leave voice on the old server
      window.electronAPI.sendChat(oldVoiceSid, 'CMD:LEAVE_VOICE');
      window.electronAPI.stopVoice();
      setVoiceServerId(null);
      // Update old server's cached snapshot to reflect leaving voice
      const oldSnap = serverStatesRef.current[oldVoiceSid];
      if (oldSnap) oldSnap.currentVoiceRoom = null;
      // Start UDP voice for the new server
      if (serverInfo) {
        const voiceHost = connectedHostRef.current || serverInfo.voiceHost;
        try {
          await window.electronAPI.startVoice(voiceHost, serverInfo.udpPort, nicknameRef.current, targetSid || '');
        } catch (err) {
          console.error('[Voice] Failed to start UDP for new server:', err);
        }
      }
    }
  };

  const joinVoice = async (room: VoiceRoom) => {
    if (connectedServerId) pushNav({ type: 'server', serverId: connectedServerId, view: 'voice' });
    setViewModeTracked('voice');
    if (room.name === currentVoiceRoom && voiceServerIdRef.current === connectedServerIdRef.current) return;
    await ensureVoiceOnCurrentServer();
    sendToServer(`CMD:JOIN_VOICE:${room.name}`);
  };

  const joinText = (room: TextRoom) => {
    if (connectedServerId) pushNav({ type: 'server', serverId: connectedServerId, view: 'text', textRoom: room.name });
    setViewModeTracked('text');
    if (joinedTextRooms.has(room.name)) { setCurrentText(room.name); return; }
    sendToServer(`CMD:JOIN_TEXT:${room.name}`);
  };

  const leaveVoice = () => {
    setHideUiOverlay(false);
    setMouseActive(true);
    if (mouseIdleTimerRef.current) clearTimeout(mouseIdleTimerRef.current);
    setIsCallFullscreen(false);
    sendToVoice('CMD:LEAVE_VOICE');
  };

  const disconnect = () => {
    const sid = connectedServerId;
    if (voiceServerId === sid) {
      window.electronAPI.stopVoice();
      setVoiceServerId(null);
    }
    if (sid) {
      window.electronAPI.disconnectChat(sid);
      setConnectedServerIds(prev => { const s = new Set(prev); s.delete(sid); return s; });
      delete serverStatesRef.current[sid];
    }
    setIsConnected(false);
    setConnectedServerId(null);
    setShowHome(false);
    setCurrentVoice(null);
    setCurrentText(null);
    setJoinedText(new Set());
    setRoomMessages({});
    setPinnedMessages({});
    setShowPins(false);
    setOnlineUsers([]);
    setVoiceRooms([]);
    setTextRooms([]);
    setStatus('Disconnected');
    setIsScreenSharing(false);
    setSelectedVideoFeed(null);
    setCameraUsers(new Set());
    setScreenUsers(new Set());
    watchingStreamsRef.current = new Set();
    setWatchingStreams(new Set());
    setServerInfo(null);
    setServerRoles([]);
    setPendingFile(null);
    setIsAway(false);
    setSoundboardSounds([]);
    setShowSoundboard(false);
    setCustomEmojis({});
    stopAudio();
    // Clean nav history: remove entries for the disconnected server
    if (sid) {
      const filtered = navHistoryRef.current.filter(e => !(e.type === 'server' && e.serverId === sid));
      if (filtered.length === 0) filtered.push({ type: 'home' });
      navHistoryRef.current = filtered;
      navIndexRef.current = Math.min(navIndexRef.current, filtered.length - 1);
      updateNavButtons();
    }
  };

  // ═════════════════════════════════════════════════════════
  //  CONNECT SCREEN
  // ═════════════════════════════════════════════════════════

  if ((!isConnected || showHome) && !showSettings) {
    return (
      <div className="h-screen flex flex-col bg-[#0a0e0a] text-green-500 font-mono" data-theme={theme}>
        {/* ── Draggable titlebar ── */}
        <div className="flex items-center bg-[#0d120d] border-b border-green-900/30 select-none"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
          {isMac ? (
            <>
              <div className="w-[70px]" />
              <div className="flex-1 flex items-center justify-center">
                <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <button onClick={navBack} disabled={!canNavBack}
                    className="px-1.5 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 disabled:text-green-900 disabled:cursor-default transition-colors"
                    title="Back">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button onClick={navForward} disabled={!canNavForward}
                    className="px-1.5 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 disabled:text-green-900 disabled:cursor-default transition-colors"
                    title="Forward">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
                <Terminal className="w-4 h-4 shrink-0 mr-2 ml-2" />
                <span className="text-xs font-bold">ECHO</span>
              </div>
              <div className="w-auto flex items-center justify-end pr-2 gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <button onClick={() => { setCheckingUpdates(true); window.electronAPI.checkForUpdates(); setTimeout(() => setCheckingUpdates(false), 3000); }}
                  className="p-2 rounded-lg text-green-700 hover:text-green-400 hover:bg-green-900/20 transition-colors"
                  title={checkingUpdates ? 'Checking...' : 'Check for updates'}>
                  <RefreshCw className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`} />
                </button>
                <button onClick={() => { setShowSettings(true); refreshDevices(); }}
                  className="p-2 rounded-lg text-green-700 hover:text-green-400 hover:bg-green-900/20 transition-colors"
                  title="Settings">
                  <Settings className="w-4 h-4" />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 px-4 py-2 flex-1 min-w-0">
                <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <button onClick={navBack} disabled={!canNavBack}
                    className="px-1.5 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 disabled:text-green-900 disabled:cursor-default transition-colors"
                    title="Back">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button onClick={navForward} disabled={!canNavForward}
                    className="px-1.5 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 disabled:text-green-900 disabled:cursor-default transition-colors"
                    title="Forward">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
                <Terminal className="w-4 h-4 shrink-0" />
                <span className="text-xs font-bold">ECHO</span>
              </div>
              <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <button onClick={() => { setCheckingUpdates(true); window.electronAPI.checkForUpdates(); setTimeout(() => setCheckingUpdates(false), 3000); }}
                  className="px-3 py-2 text-green-700 hover:text-green-400 hover:bg-green-900/20 transition-colors"
                  title={checkingUpdates ? 'Checking...' : 'Check for updates'}>
                  <RefreshCw className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`} />
                </button>
                <button onClick={() => { setShowSettings(true); refreshDevices(); }}
                  className="px-3 py-2 text-green-700 hover:text-green-400 hover:bg-green-900/20 transition-colors"
                  title="Settings">
                  <Settings className="w-4 h-4" />
                </button>
                <button onClick={() => window.electronAPI.minimizeWindow()}
                  className="px-3 py-2 text-green-600 hover:bg-green-900/30 transition-colors" title="Minimize">
                  <Minus className="w-4 h-4" />
                </button>
                <button onClick={() => window.electronAPI.maximizeWindow()}
                  className="px-3 py-2 text-green-600 hover:bg-green-900/30 transition-colors" title="Maximize">
                  <Square className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => window.electronAPI.closeWindow()}
                  className="px-3 py-2 text-green-600 hover:bg-red-600 hover:text-white transition-colors" title="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── Server Tab Bar ──────────────────────────────────── */}
        {openTabs.length > 0 && (
        <div className="flex items-center bg-[#0d120d]/80 border-b border-green-900/30 px-2 gap-0.5 overflow-x-auto shrink-0 scrollbar-none">
          {openTabs.map(tabId => {
            const server = pinnedServers.find(s => s.id === tabId);
            if (!server) return null;
            const isActiveTab = isConnected && connectedServerId === server.id;
            const activeMentionTotal = isActiveTab ? Object.values(mentionedRooms).reduce((s, n) => s + n, 0) : 0;
            const mentions = isActiveTab ? activeMentionTotal : (serverMentions[server.id] || 0);
            return (
              <div key={server.id}
                draggable
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragTabId(server.id); }}
                onDragOver={(e) => { e.preventDefault(); setDragOverTabId(server.id); }}
                onDragLeave={() => { if (dragOverTabId === server.id) setDragOverTabId(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragTabId && dragTabId !== server.id) {
                    setOpenTabs(prev => {
                      const next = prev.filter(id => id !== dragTabId);
                      const idx = next.indexOf(server.id);
                      next.splice(idx, 0, dragTabId!);
                      return next;
                    });
                  }
                  setDragTabId(null);
                  setDragOverTabId(null);
                }}
                onDragEnd={() => { setDragTabId(null); setDragOverTabId(null); }}
                onClick={() => {
                  pushNav({ type: 'server', serverId: server.id, view: 'text', textRoom: null });
                  setServerMentions(prev => { const n = { ...prev }; delete n[server.id]; return n; });
                  connectToPinnedServer(server);
                }}
                onContextMenu={(e) => { e.preventDefault(); setServerContextMenu({ serverId: server.id, x: e.clientX, y: e.clientY }); }}
                className={`group flex items-center gap-1.5 pl-3 pr-1 py-1.5 text-xs transition-all shrink-0 max-w-[200px] border-b-2 select-none ${
                  dragOverTabId === server.id && dragTabId !== server.id
                    ? 'bg-green-900/30 border-green-400'
                    : isActiveTab
                      ? 'bg-[#0a0e0a] text-green-400 border-green-500'
                      : 'text-green-700 hover:text-green-500 hover:bg-green-900/20 border-transparent'
                } ${dragTabId === server.id ? 'opacity-50' : ''} ${connecting ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}>
                <div className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold overflow-hidden shrink-0"
                  style={{ backgroundColor: server.logo ? 'transparent' : getServerColor(server.name) + '60' }}>
                  {server.logo ? (
                    <img src={server.logo} alt="" className="w-full h-full object-cover rounded" draggable={false} />
                  ) : (
                    <span className="text-white">{server.name.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <span className="truncate">{isActiveTab && serverInfo ? serverInfo.serverName : server.name}</span>
                {mentions > 0 && (
                  <span className="w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-[9px] text-white font-bold shrink-0 animate-pulse">
                    {mentions > 9 ? '9+' : mentions}
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isActiveTab) disconnect();
                    setOpenTabs(prev => prev.filter(id => id !== server.id));
                  }}
                  className="p-0.5 rounded text-green-800 hover:text-red-400 hover:bg-red-900/30 opacity-0 group-hover:opacity-100 transition-all shrink-0 ml-auto"
                  title="Close tab">
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
        )}

        {/* ── Connect Screen Content ── */}
        <div className="flex-1 flex items-center justify-center overflow-y-auto">
          <div className="w-full max-w-2xl px-8 py-12">
            {/* Header */}
            <div className="text-center mb-12">
              <Terminal className="w-12 h-12 mx-auto mb-4 text-green-500" />
              <h1 className="text-3xl font-bold text-green-400 mb-1">ECHO</h1>
              <p className="text-xs text-green-700">{appVersion ? `v${appVersion}` : ''} — Secure VoIP</p>
            </div>

            {/* Pinned Servers */}
            <div className="mb-10">
              <div className="text-xs text-green-700 mb-6 text-center tracking-widest">YOUR SERVERS</div>
              <div className="flex flex-wrap justify-center gap-6">
                {pinnedServers.map(server => {
                  const activeMentionTotal = (isConnected && connectedServerId === server.id) ? Object.values(mentionedRooms).reduce((s, n) => s + n, 0) : 0;
                  const mentions = (serverMentions[server.id] || 0) + activeMentionTotal;
                  return (
                  <button key={server.id}
                    onClick={() => {
                      pushNav({ type: 'server', serverId: server.id, view: 'text', textRoom: null });
                      setServerMentions(prev => { const n = { ...prev }; delete n[server.id]; return n; });
                      if (!server.trusted && !connectedServerIds.has(server.id)) {
                        setUntrustedConfirm(server);
                      } else {
                        connectToPinnedServer(server);
                      }
                    }}
                    onContextMenu={(e) => { e.preventDefault(); setServerContextMenu({ serverId: server.id, x: e.clientX, y: e.clientY }); }}
                    disabled={connecting}
                    className="group flex flex-col items-center gap-2 transition-all disabled:opacity-50">
                    <div className="relative">
                      <div className={`w-16 h-16 rounded-2xl flex items-center justify-center text-white text-xl font-bold shadow-lg transition-all group-hover:rounded-xl group-hover:shadow-xl group-hover:scale-105 overflow-hidden ${isConnected && connectedServerId === server.id ? 'ring-2 ring-green-500 ring-offset-2 ring-offset-[#0a0e0a]' : ''}`}
                        style={{ backgroundColor: server.logo ? 'transparent' : getServerColor(server.name) }}>
                        {server.logo ? (
                          <img src={server.logo} alt={server.name} className="w-full h-full object-cover" />
                        ) : (
                          server.name.charAt(0).toUpperCase()
                        )}
                      </div>
                      {mentions > 0 && (
                        <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center text-[10px] text-white font-bold shadow-lg animate-pulse">
                          {mentions > 9 ? '9+' : mentions}
                        </div>
                      )}
                      {server.autoConnectTcp && server.username && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-600 rounded-full flex items-center justify-center border border-[#0a0e0a]" title="Auto-connect on startup">
                          <Wifi className="w-2 h-2 text-white" />
                        </div>
                      )}
                      {!server.autoConnectTcp && server.autoConnect && server.authToken && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-blue-600 rounded-full flex items-center justify-center border border-[#0a0e0a]" title="Background mentions active">
                          <Bell className="w-2 h-2 text-white" />
                        </div>
                      )}
                      {!server.trusted && (
                        <div className="absolute -top-1 -left-1 w-4 h-4 bg-red-600 rounded-full flex items-center justify-center border border-[#0a0e0a]" title="Untrusted server — GIFs blocked, file downloads may be unsafe">
                          <Shield className="w-2.5 h-2.5 text-white" />
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-green-600 group-hover:text-green-400 transition-colors max-w-[80px] truncate">{server.name}</span>
                    {isConnected && connectedServerId === server.id ? (
                      <span className="text-[10px] text-green-500 font-bold flex items-center gap-1">
                        <Circle className="w-1.5 h-1.5 fill-green-500 text-green-500" />
                        Connected
                      </span>
                    ) : server.username ? (
                      <span className="text-[10px] text-green-700 flex items-center gap-1">
                        <Circle className="w-1.5 h-1.5 fill-green-500 text-green-500" />
                        {server.username}
                      </span>
                    ) : (
                      <span className="text-[10px] text-green-800">Not logged in</span>
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
                  <span className="text-xs text-green-700 group-hover:text-green-500 transition-colors">Add</span>
                </button>
              </div>
            </div>

            {/* Friends */}
            {friends.length > 0 && (() => {
              const statusOrder = { online: 0, away: 1, offline: 2 };
              const sorted = [...friends].sort((a, b) => {
                const sa = getFriendOnlineStatus(a);
                const sb = getFriendOnlineStatus(b);
                return (statusOrder[sa.online ? sa.status : 'offline'] ?? 2) - (statusOrder[sb.online ? sb.status : 'offline'] ?? 2);
              });
              return (
                <div className="mb-10">
                  <div className="text-xs text-green-700 mb-4 text-center tracking-widest">FRIENDS</div>
                  <div className="space-y-2 max-w-md mx-auto">
                    {sorted.map(friend => {
                      const server = pinnedServers.find(s => s.id === friend.serverId);
                      const isServerConnected = connectedServerIds.has(friend.serverId);
                      const { status: friendStatus, online } = getFriendOnlineStatus(friend);
                      const dotColor = friendStatus === 'away' ? '#eab308' : online ? '#22c55e' : '#6b7280';
                      return (
                        <div key={`${friend.username}-${friend.serverId}`}
                          onClick={() => { if (isServerConnected) openInlineDm(friend.username, friend.serverId); }}
                          onContextMenu={(e) => { e.preventDefault(); setFriendContextMenu({ username: friend.username, serverId: friend.serverId, x: e.clientX, y: e.clientY }); }}
                          className={`flex items-center gap-3 bg-[#0d120d]/60 border border-green-900/20 rounded-lg px-4 py-3 hover:border-green-900/40 transition-all select-none ${isServerConnected ? 'cursor-pointer' : 'cursor-default'}`}>
                          <div className="relative shrink-0">
                            <div className="w-10 h-10 rounded-full bg-green-900/40 flex items-center justify-center text-sm font-bold text-green-400">
                              {friend.username.charAt(0).toUpperCase()}
                            </div>
                            <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full ring-2 ring-[#0a0e0a]"
                              style={{ backgroundColor: dotColor }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-green-400 font-bold truncate">{friend.username}</div>
                            <div className="text-xs flex items-center gap-1">
                              <span className="text-green-700 truncate">{server?.name || 'Unknown server'}</span>
                              <span className="text-green-900 shrink-0">·</span>
                              <span className={`shrink-0 ${online ? (friendStatus === 'away' ? 'text-yellow-600' : 'text-green-600') : 'text-green-900'}`}>
                                {online ? (friendStatus === 'away' ? 'Away' : 'Online') : 'Offline'}
                              </span>
                            </div>
                          </div>
                          {(() => {
                            const unread = dmUnreadCounts[friend.username] || 0;
                            if (unread > 0) {
                              return (
                                <span className="w-5 h-5 bg-red-500 rounded-full flex items-center justify-center text-[10px] text-white font-bold shrink-0 animate-pulse">
                                  {unread > 9 ? '9+' : unread}
                                </span>
                              );
                            }
                            if (isServerConnected) return <Send className="w-3.5 h-3.5 text-green-800 shrink-0" />;
                            return null;
                          })()}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Status */}
            <div className="text-center text-xs text-green-700 space-y-1">
              <div>{'>'} Status: <span className="text-green-500">{status}</span></div>
              <div>{'>'} Protocol: <span className="text-green-500">UDP + TCP</span></div>
            </div>
          </div>
        </div>

        {/* ── Voice indicator when browsing servers ── */}
        {showHome && isConnected && currentVoiceRoom && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg px-5 py-3 flex items-center gap-4 z-40 shadow-2xl shadow-green-900/30">
            <Volume2 className="w-4 h-4 text-green-500 animate-pulse" />
            <span className="text-sm text-green-400 font-bold">{currentVoiceRoom}</span>
            <span className="text-xs text-green-700 font-mono">{fmt(callDuration)}</span>
            <button onClick={() => { if (connectedServerId) pushNav(serverNavEntry(connectedServerId)); setShowHome(false); }}
              className="px-3 py-1.5 bg-green-900/40 hover:bg-green-900/60 text-green-400 rounded-lg text-xs transition-all font-bold">
              Tilbage
            </button>
          </div>
        )}

        {/* ── Login Dialog ── */}
        {loginDialog && (() => {
          const server = pinnedServers.find(s => s.id === loginDialog);
          if (!server) return null;
          return (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-md">
                <div className="bg-green-900/40 p-6 border-b border-green-900/50">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold overflow-hidden"
                      style={{ backgroundColor: server.logo ? 'transparent' : getServerColor(server.name) }}>
                      {server.logo ? (
                        <img src={server.logo} alt={server.name} className="w-full h-full object-cover" />
                      ) : (
                        server.name.charAt(0).toUpperCase()
                      )}
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
                    <label className="text-xs text-green-700 block">{'>'} USERNAME</label>
                    <input type="text" value={nickname} onChange={e => setNickname(e.target.value)}
                      placeholder="Enter your username..."
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                      autoFocus />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-green-700 block">{'>'} PASSWORD</label>
                    <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                      placeholder="Enter your password..."
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all" />
                  </div>
                  <button type="submit" disabled={!nickname.trim() || !password.trim() || connecting}
                    className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                    {isRegister ? <UserPlus className="w-5 h-5" /> : <LogIn className="w-5 h-5" />}
                    {connecting ? (isRegister ? 'REGISTERING...' : 'LOGGING IN...') : (isRegister ? 'REGISTER' : 'LOG IN')}
                  </button>
                  {isRegister && (
                    <div className="flex items-start gap-2 bg-yellow-900/20 border border-yellow-800/30 rounded-lg px-3 py-2.5 text-[10px] text-yellow-700 leading-relaxed">
                      <Shield className="w-3 h-3 mt-0.5 flex-shrink-0 text-yellow-700" />
                      <span>The server operator can see your password. Use a unique password not shared with other services.</span>
                    </div>
                  )}
                  <div className="pt-2 text-center">
                    <span className="text-xs text-green-700">{status}</span>
                  </div>
                </form>
              </div>
            </div>
          );
        })()}

        {/* ── Untrusted Server Confirmation ── */}
        {untrustedConfirm && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-[#0d120d]/95 border border-red-900/50 rounded-lg shadow-2xl shadow-red-900/30 w-full max-w-sm">
              <div className="bg-red-900/30 p-5 border-b border-red-900/40 flex items-center gap-3">
                <Shield className="w-5 h-5 text-red-400 shrink-0" />
                <h2 className="text-base font-bold text-red-400">Untrusted Server</h2>
              </div>
              <div className="p-5 flex flex-col gap-4">
                <p className="text-sm text-red-300/80 leading-relaxed">
                  <span className="font-semibold text-red-300">{untrustedConfirm.name}</span> is marked as untrusted. The server operator can see your username, password, and all non-DM messages.
                </p>
                <p className="text-xs text-red-500/70">Make sure you trust this server before joining. Use a unique password.</p>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => { const s = untrustedConfirm; setUntrustedConfirm(null); connectToPinnedServer(s); }}
                    className="flex-1 px-4 py-2 rounded-lg bg-red-900/40 hover:bg-red-900/60 text-red-300 text-sm font-semibold transition-all">
                    Join anyway
                  </button>
                  <button
                    onClick={() => setUntrustedConfirm(null)}
                    className="flex-1 px-4 py-2 rounded-lg bg-green-900/20 hover:bg-green-900/40 text-green-400 text-sm font-semibold transition-all">
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Add Server Dialog ── */}
        {addServerDialog && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-md">
              <div className="bg-green-900/40 p-6 border-b border-green-900/50 flex items-center justify-between">
                <h2 className="text-lg font-bold text-green-400">ADD SERVER</h2>
                <button onClick={() => setAddServerDialog(false)} className="p-2 text-green-600 hover:text-green-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-green-700 block">{'>'} ADDRESS</label>
                  <input type="text" value={newServerAddress} onChange={e => setNewServerAddress(e.target.value)}
                    placeholder="hostname:port"
                    className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                    autoFocus />
                  <span className="text-[10px] text-green-800">Port 5001 is used by default if no port is specified</span>
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-green-700 block">{'>'} CUSTOM NAME <span className="text-green-800">(optional — auto-fetched from server)</span></label>
                  <input type="text" value={newServerName} onChange={e => setNewServerName(e.target.value)}
                    placeholder="Leave empty to use server name"
                    className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all" />
                </div>
                <label className="flex items-center gap-3 cursor-pointer select-none group">
                  <div className={`w-5 h-5 rounded flex items-center justify-center border-2 transition-all flex-shrink-0 ${
                    newServerTrusted
                      ? 'bg-green-600 border-green-600'
                      : 'bg-transparent border-green-800 group-hover:border-green-600'
                  }`}>
                    {newServerTrusted && <Check className="w-3 h-3 text-white" />}
                  </div>
                  <input type="checkbox" className="sr-only" checked={newServerTrusted} onChange={e => setNewServerTrusted(e.target.checked)} />
                  <span className="text-sm text-green-500">I trust this server</span>
                </label>
                <button onClick={addPinnedServer} disabled={!newServerAddress.trim()}
                  className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                  <Plus className="w-5 h-5" />
                  ADD SERVER
                </button>
                {!newServerTrusted && (
                  <div className="flex items-start gap-2 bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2.5 text-[10px] text-red-700 leading-relaxed">
                    <Shield className="w-3 h-3 mt-0.5 flex-shrink-0 text-red-700" />
                    <span>Untrusted — GIFs will be blocked and file downloads will show a warning. The server operator can still see your username, password, and all non-DM messages. Use a unique password.</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Friend Context Menu ── */}
        {friendContextMenu && (
          <div className="fixed bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-2 min-w-[160px] z-50"
            style={{ left: Math.min(friendContextMenu.x, window.innerWidth - 180), top: Math.min(friendContextMenu.y, window.innerHeight - 100) }}
            onClick={e => e.stopPropagation()}>
            {connectedServerIds.has(friendContextMenu.serverId) && (
              <button onClick={() => { openInlineDm(friendContextMenu.username, friendContextMenu.serverId); setFriendContextMenu(null); }}
                className="w-full px-4 py-2.5 rounded-lg text-green-400 hover:bg-green-900/30 transition-all flex items-center gap-2 text-sm">
                <Send className="w-4 h-4" />
                <span>Send DM</span>
              </button>
            )}
            <button onClick={() => { removeFriend(friendContextMenu.username, friendContextMenu.serverId); setFriendContextMenu(null); }}
              className="w-full px-4 py-2.5 rounded-lg text-red-400 hover:bg-red-900/40 transition-all flex items-center gap-2 text-sm">
              <X className="w-4 h-4" />
              <span>Remove friend</span>
            </button>
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
                <button onClick={() => toggleAutoConnectTcp(server.id)}
                  className="w-full px-4 py-2.5 rounded-lg text-green-400 hover:bg-green-900/30 transition-all flex items-center gap-2 text-sm">
                  {server.autoConnectTcp ? <WifiOff className="w-4 h-4" /> : <Wifi className="w-4 h-4" />}
                  <span>{server.autoConnectTcp ? 'Disable auto-connect' : 'Enable auto-connect'}</span>
                </button>
              )}
              {server.username && server.authToken && server.ssePort && (
                <button onClick={() => toggleAutoConnect(server.id)}
                  className="w-full px-4 py-2.5 rounded-lg text-blue-400 hover:bg-blue-900/30 transition-all flex items-center gap-2 text-sm">
                  {server.autoConnect ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
                  <span>{server.autoConnect ? 'Disable background mentions' : 'Enable background mentions'}</span>
                </button>
              )}
              {server.username && (
                <button onClick={() => logoutServer(server.id)}
                  className="w-full px-4 py-2.5 rounded-lg text-yellow-400 hover:bg-yellow-900/30 transition-all flex items-center gap-2 text-sm">
                  <LogOut className="w-4 h-4" />
                  <span>Log out</span>
                </button>
              )}
              <button onClick={() => toggleServerTrust(server.id)}
                className={`w-full px-4 py-2.5 rounded-lg transition-all flex items-center gap-2 text-sm ${server.trusted ? 'text-yellow-400 hover:bg-yellow-900/30' : 'text-green-400 hover:bg-green-900/30'}`}>
                <Shield className="w-4 h-4" />
                <span>{server.trusted ? 'Mark as untrusted' : 'Mark as trusted'}</span>
              </button>
              <button onClick={() => unpinServer(server.id)}
                className="w-full px-4 py-2.5 rounded-lg text-red-400 hover:bg-red-900/40 transition-all flex items-center gap-2 text-sm">
                <Trash2 className="w-4 h-4" />
                <span>Remove server</span>
              </button>
              <div className="border-t border-green-900/30 mt-1 pt-1 px-1 pb-1 group/srvnotif">
                {(() => {
                  const levels = ['all', 'mentions', 'none'] as const;
                  const icons: Record<string, React.ReactNode> = {
                    all: <Bell className="w-3.5 h-3.5 text-green-400" />,
                    mentions: <Bell className="w-3.5 h-3.5 text-yellow-500" />,
                    none: <BellOff className="w-3.5 h-3.5 text-red-500" />,
                  };
                  const labels = { all: 'All', mentions: 'Mentions only', none: 'Muted' };
                  const current = resolveNotifLevel(server.id);
                  return (
                    <>
                      <div className="w-full px-4 py-2.5 rounded-lg text-green-700 hover:bg-green-900/20 hover:text-green-500 transition-all flex items-center gap-2 text-sm cursor-default select-none">
                        {icons[current]}
                        <span className="flex-1">Notifications: <span className="text-green-500">{labels[current]}</span></span>
                        <ChevronRight className="w-3 h-3 opacity-40" />
                      </div>
                      <div className="hidden group-hover/srvnotif:flex flex-col gap-0.5 pl-2 pb-1">
                        {levels.map(level => {
                          const active = current === level;
                          return (
                            <button key={level}
                              onClick={() => { setServerNotifLevel(server.id, level); setServerContextMenu(null); }}
                              className={`w-full px-4 py-1.5 rounded-lg flex items-center gap-2 text-sm transition-all ${
                                active ? 'bg-green-900/40 text-green-300 font-semibold' : 'text-green-700 hover:bg-green-900/20 hover:text-green-500'
                              }`}>
                              {icons[level]}
                              <span>{labels[level]}</span>
                              {active && <Check className="w-3 h-3 ml-auto" />}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
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
                const spServerId = serverPasswordDialog.serverId || crypto.randomUUID();
                setConnecting(true);
                setStatus('Connecting with server password...');
                // Set ref BEFORE await so incoming messages are recognized as active server
                const prevServerId = connectedServerIdRef.current;
                connectedServerIdRef.current = spServerId;
                try {
                  nicknameRef.current = serverPasswordDialog.username;
                  connectedHostRef.current = host;
                  await window.electronAPI.connectChat(
                    spServerId,
                    host, port,
                    serverPasswordDialog.username, serverPasswordDialog.password,
                    serverPasswordDialog.isRegister, serverPasswordInput
                  );
                  if (serverPasswordDialog.serverId) {
                    setConnectedServerIds(prev => new Set(prev).add(serverPasswordDialog!.serverId!));
                    setPinnedServers(prev => prev.map(s =>
                      s.id === serverPasswordDialog!.serverId
                        ? { ...s, username: serverPasswordDialog!.username, password: serverPasswordDialog!.password, serverPassword: serverPasswordInput }
                        : s
                    ));
                  }
                  setServerIp(host);
                  setTcpPort(String(port));
                  setNickname(serverPasswordDialog.username);
                  setConnectedServerId(spServerId);
                  setIsConnected(true);
                  setStatus('Connected');
                  setShowHome(false);
                  setServerPasswordDialog(null);
                  if (serverPasswordDialog.serverId) addToOpenTabs(serverPasswordDialog.serverId);
                } catch (err: any) {
                  connectedServerIdRef.current = prevServerId;
                  const msg = err?.message || '';
                  if (msg.includes('SERVER_PASSWORD_FAIL')) {
                    setStatus('Forkert server-adgangskode — prøv igen');
                    setServerPasswordInput('');
                  } else {
                    setStatus(`Failed: ${msg}`);
                  }
                }
                setConnecting(false);
              }} className="p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-green-700 block">{'>'} SERVER PASSWORD</label>
                  <input type="password" value={serverPasswordInput} onChange={e => setServerPasswordInput(e.target.value)}
                    placeholder="Enter server password..."
                    className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                    autoFocus />
                </div>
                <button type="submit" disabled={!serverPasswordInput.trim() || connecting}
                  className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                  <LogIn className="w-5 h-5" />
                  {connecting ? 'CONNECTING...' : 'CONNECT'}
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
     <div className={`flex items-center bg-[#0d120d] border-b border-green-900/30 select-none ${hideUiOverlay && isCallFullscreen && viewMode === 'voice' && currentVoiceRoom ? 'hidden' : ''}`}
       style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
       {isMac ? (
         <>
           <div className="w-[70px]" />
           <div className="flex-1 flex items-center justify-center min-w-0">
             <Terminal className="w-4 h-4 shrink-0 mr-2" />
             <span className="text-xs font-bold truncate">ECHO</span>
                 <span className="text-xs text-green-700 truncate ml-1">— {nickname}</span>
                  </div>
                  <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                    <button onClick={navBack} disabled={!canNavBack}
                      className="px-1.5 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 disabled:text-green-900 disabled:cursor-default transition-colors"
                      title="Back">
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button onClick={navForward} disabled={!canNavForward}
                      className="px-1.5 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 disabled:text-green-900 disabled:cursor-default transition-colors"
                      title="Forward">
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                  <button onClick={() => { pushNav({ type: 'home' }); setShowHome(true); }}
                    className="px-3 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 transition-colors"
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    title="Servere">
                    <Home className="w-4 h-4" />
                  </button>
                  <button onClick={() => { setCheckingUpdates(true); window.electronAPI.checkForUpdates(); setTimeout(() => setCheckingUpdates(false), 3000); }}
                    className="px-3 py-2 text-green-700 hover:text-green-400 hover:bg-green-900/20 transition-colors"
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    title={checkingUpdates ? 'Checking...' : 'Check for updates'}>
                    <RefreshCw className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`} />
                  </button>
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
             <span className="text-xs font-bold truncate">ECHO</span>
              <span className="text-xs text-green-700 truncate">— {nickname}</span>
             </div>
             <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
               <button onClick={navBack} disabled={!canNavBack}
                 className="px-1.5 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 disabled:text-green-900 disabled:cursor-default transition-colors"
                 title="Back">
                 <ChevronLeft className="w-4 h-4" />
               </button>
               <button onClick={navForward} disabled={!canNavForward}
                 className="px-1.5 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 disabled:text-green-900 disabled:cursor-default transition-colors"
                 title="Forward">
                 <ChevronRight className="w-4 h-4" />
               </button>
             </div>
             <button onClick={() => { pushNav({ type: 'home' }); setShowHome(true); }}
               className="px-3 py-2 text-green-600 hover:text-green-400 hover:bg-green-900/20 transition-colors"
               style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
               title="Servere">
               <Home className="w-4 h-4" />
             </button>
             <button onClick={disconnect}
               className="px-3 py-2 text-xs text-red-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"
               style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
               DISCONNECT
             </button>
             <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
             <button onClick={() => { setCheckingUpdates(true); window.electronAPI.checkForUpdates(); setTimeout(() => setCheckingUpdates(false), 3000); }}
               className="px-3 py-2 text-green-700 hover:text-green-400 hover:bg-green-900/20 transition-colors"
               title={checkingUpdates ? 'Checking...' : 'Check for updates'}>
               <RefreshCw className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`} />
             </button>
             <button onClick={() => window.electronAPI.minimizeWindow()}
               className="px-3 py-2 text-green-600 hover:bg-green-900/30 transition-colors" title="Minimize">
               <Minus className="w-4 h-4" />
             </button>
             <button onClick={() => window.electronAPI.maximizeWindow()}
               className="px-3 py-2 text-green-600 hover:bg-green-900/30 transition-colors" title="Maximize">
               <Square className="w-3.5 h-3.5" />
             </button>
             <button onClick={() => window.electronAPI.closeWindow()}
               className="px-3 py-2 text-green-600 hover:bg-red-600 hover:text-white transition-colors" title="Close">
               <X className="w-4 h-4" />
             </button>
           </div>
         </>
       )}
     </div>

     {/* ── Server + DM Tab Bar ──────────────────────────────── */}
     {(openTabs.length > 0 || openDmTabs.length > 0) && (
     <div className={`flex items-center bg-[#0d120d]/80 border-b border-green-900/30 px-2 gap-0.5 overflow-x-auto shrink-0 scrollbar-none ${hideUiOverlay && isCallFullscreen && viewMode === 'voice' && currentVoiceRoom ? 'hidden' : ''}`}>
       {openTabs.map(tabId => {
         const server = pinnedServers.find(s => s.id === tabId);
         if (!server) return null;
         const isActiveTab = connectedServerId === server.id && !activeDmTab;
         const activeMentionTotal = isActiveTab ? Object.values(mentionedRooms).reduce((s, n) => s + n, 0) : 0;
         const mentions = isActiveTab ? activeMentionTotal : (serverMentions[server.id] || 0);
         return (
           <div key={server.id}
             draggable
             onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragTabId(server.id); }}
             onDragOver={(e) => { e.preventDefault(); setDragOverTabId(server.id); }}
             onDragLeave={() => { if (dragOverTabId === server.id) setDragOverTabId(null); }}
             onDrop={(e) => {
               e.preventDefault();
               if (dragTabId && dragTabId !== server.id) {
                 setOpenTabs(prev => {
                   const next = prev.filter(id => id !== dragTabId);
                   const idx = next.indexOf(server.id);
                   next.splice(idx, 0, dragTabId!);
                   return next;
                 });
               }
               setDragTabId(null);
               setDragOverTabId(null);
             }}
             onDragEnd={() => { setDragTabId(null); setDragOverTabId(null); }}
             onClick={() => {
               setActiveDmTab(null);
               if (isActiveTab) return;
               pushNav({ type: 'server', serverId: server.id, view: 'text', textRoom: null });
               setServerMentions(prev => { const n = { ...prev }; delete n[server.id]; return n; });
               connectToPinnedServer(server);
             }}
             onContextMenu={(e) => { e.preventDefault(); setServerContextMenu({ serverId: server.id, x: e.clientX, y: e.clientY }); }}
             className={`group flex items-center gap-1.5 pl-3 pr-1 py-1.5 text-xs transition-all shrink-0 max-w-[200px] border-b-2 select-none ${
               dragOverTabId === server.id && dragTabId !== server.id
                 ? 'bg-green-900/30 border-green-400'
                 : isActiveTab
                   ? 'bg-[#0a0e0a] text-green-400 border-green-500'
                   : 'text-green-700 hover:text-green-500 hover:bg-green-900/20 border-transparent'
             } ${dragTabId === server.id ? 'opacity-50' : ''} ${connecting ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}>
             <div className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold overflow-hidden shrink-0"
               style={{ backgroundColor: server.logo ? 'transparent' : getServerColor(server.name) + '60' }}>
               {server.logo ? (
                 <img src={server.logo} alt="" className="w-full h-full object-cover rounded" draggable={false} />
               ) : (
                 <span className="text-white">{server.name.charAt(0).toUpperCase()}</span>
               )}
             </div>
             <span className="truncate">{isActiveTab && serverInfo ? serverInfo.serverName : server.name}</span>
             {mentions > 0 && (
               <span className="w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-[9px] text-white font-bold shrink-0 animate-pulse">
                 {mentions > 9 ? '9+' : mentions}
               </span>
             )}
             <button
               onClick={(e) => {
                 e.stopPropagation();
                 if (isActiveTab) disconnect();
                 setOpenTabs(prev => prev.filter(id => id !== server.id));
               }}
               className="p-0.5 rounded text-green-800 hover:text-red-400 hover:bg-red-900/30 opacity-0 group-hover:opacity-100 transition-all shrink-0 ml-auto"
               title="Close tab">
               <X className="w-3 h-3" />
             </button>
           </div>
         );
       })}
       {/* ── DM tabs ──────────────────────────────────────── */}
       {openDmTabs.map(dm => {
         const isActiveDm = activeDmTab === dm.username;
         const dmUnread = dmUnreadCounts[dm.username] || 0;
         return (
           <div key={`dm-${dm.username}`}
             onClick={() => { pushNav({ type: 'dm', username: dm.username }); setActiveDmTab(dm.username); setDmInput(''); setShowHome(false); setDmUnreadCounts(prev => { const n = { ...prev }; delete n[dm.username]; return n; }); }}
             className={`group flex items-center gap-1.5 pl-3 pr-1 py-1.5 text-xs transition-all shrink-0 max-w-[200px] border-b-2 select-none cursor-pointer ${
               isActiveDm
                 ? 'bg-[#0a0e0a] text-green-400 border-green-500'
                 : dmUnread > 0
                   ? 'bg-red-900/10 text-white font-bold border-transparent hover:bg-red-900/20'
                   : 'text-green-700 hover:text-green-500 hover:bg-green-900/20 border-transparent'
             }`}>
             <Send className="w-3.5 h-3.5 shrink-0" />
             <span className="truncate">{dm.username}</span>
             {dmUnread > 0 && (
               <span className="w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-[9px] text-white font-bold shrink-0 animate-pulse">
                 {dmUnread > 9 ? '9+' : dmUnread}
               </span>
             )}
             <button
               onClick={(e) => {
                 e.stopPropagation();
                 setOpenDmTabs(prev => prev.filter(t => t.username !== dm.username));
                 if (isActiveDm) setActiveDmTab(null);
               }}
               className="p-0.5 rounded text-green-800 hover:text-red-400 hover:bg-red-900/30 opacity-0 group-hover:opacity-100 transition-all shrink-0 ml-auto"
               title="Close DM">
               <X className="w-3 h-3" />
             </button>
           </div>
         );
       })}
     </div>
     )}

     {/* ── Main content wrapper with padding ──────────────── */}
     <div className={`flex-1 flex flex-col overflow-hidden ${hideUiOverlay && isCallFullscreen && viewMode === 'voice' && currentVoiceRoom ? '' : 'p-1.5 gap-1.5'}`}>

      {/* ── Inline DM Chat ─────────────────────────────────── */}
      {activeDmTab && openDmTabs.some(t => t.username === activeDmTab) ? (() => {
        const dmTab = openDmTabs.find(t => t.username === activeDmTab);
        if (!dmTab) return null;
        const msgs = dmMessages[activeDmTab] || [];
        return (
          <div className="flex-1 flex flex-col overflow-hidden bg-[#0d120d]/60 backdrop-blur-sm rounded-lg shadow-lg shadow-green-900/10">
            {/* DM header */}
            <div className="px-4 py-3 border-b border-green-900/30 flex items-center gap-3 shrink-0">
              <Send className="w-4 h-4 text-green-600" />
              <span className="text-sm text-green-400 font-bold">DM — {activeDmTab}</span>
              <div className="ml-auto flex flex-col items-end gap-0.5">
                <span className="flex items-center gap-1 text-[10px] text-green-700" title="End-to-end encrypted with ECDH P-256 + AES-256-GCM">
                  <Lock className="w-3 h-3 text-green-600" />
                  E2EE
                </span>
                {dmKeyFingerprints[activeDmTab] ? (
                  <span className="text-[9px] text-green-800 font-mono tracking-tight" title="Key fingerprint — verify with your contact out-of-band to confirm no server MITM">
                    {dmKeyFingerprints[activeDmTab]}
                  </span>
                ) : (
                  <span className="text-[9px] text-yellow-800" title="Peer key not yet received — fingerprint unavailable">
                    key pending
                  </span>
                )}
              </div>
            </div>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {msgs.length === 0 && (
                <div className="flex-1 flex items-center justify-center h-full text-green-800 text-sm">
                  No messages yet — say hi!
                </div>
              )}
              {msgs.map(msg => {
                const isMe = msg.sender === nickname;
                return (
                  <div key={msg.id} className={`flex items-end gap-2 ${isMe ? 'flex-row-reverse' : ''}`}>
                    <UserAvatar name={msg.sender} size="sm" />
                    <div className={`max-w-[70%] px-3 py-2 rounded-xl ${isMe ? 'bg-green-900/40 text-green-400 rounded-br-sm' : 'bg-slate-700/20 border border-slate-600/15 text-slate-300 rounded-bl-sm'}`}>
                      <div className={`text-[10px] mb-0.5 font-semibold ${isMe ? 'text-green-500/70 text-right' : 'text-blue-400/70'}`}>{msg.sender} · {new Date(msg.timestamp).toLocaleTimeString()}</div>
                      <div className="text-sm break-words whitespace-pre-wrap">{renderMessageBody(msg.body)}</div>
                    </div>
                  </div>
                );
              })}
              <div ref={dmMessagesEndRef} />
            </div>
            {/* Input */}
            <div className="border-t border-green-900/30 shrink-0">
              {pendingDmFile && (
                <div className="px-4 pt-3 pb-1">
                  <div className="inline-flex items-center gap-3 bg-[#0a0e0a] border border-green-900/40 rounded-lg px-3 py-2 max-w-sm">
                    {pendingDmFile.mimeType.startsWith('image/') ? (
                      <img src={pendingDmFile.dataUrl} alt={pendingDmFile.name} className="w-16 h-16 rounded object-cover border border-green-900/30" />
                    ) : pendingDmFile.mimeType.startsWith('video/') ? (
                      <Video className="w-8 h-8 text-green-600 flex-shrink-0" />
                    ) : pendingDmFile.mimeType.startsWith('audio/') ? (
                      <Music className="w-8 h-8 text-green-600 flex-shrink-0" />
                    ) : (
                      <FileText className="w-8 h-8 text-green-600 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-green-400 truncate">{pendingDmFile.name}</div>
                      <div className="text-[10px] text-green-700">{pendingDmFile.mimeType}</div>
                    </div>
                    <button type="button" onClick={() => setPendingDmFile(null)}
                      className="p-1 rounded text-green-700 hover:text-red-400 hover:bg-red-900/20 transition-all flex-shrink-0">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
              {dmError && (
                <div className="px-4 pt-2">
                  <div className="flex items-center gap-2 bg-red-900/30 border border-red-800/40 rounded-lg px-3 py-2 text-xs text-red-400">
                    <X className="w-3 h-3 flex-shrink-0 cursor-pointer hover:text-red-300" onClick={() => setDmError(null)} />
                    {dmError}
                  </div>
                </div>
              )}
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!dmInput.trim() && !pendingDmFile) return;
                if (pendingDmFile) {
                  let { name: fName, mimeType: fMime, base64: fData } = pendingDmFile;

                  // Use file server for video uploads in DMs when available
                  const fileServerPort = serverInfo?.fileServerPort;
                  const currentServer = pinnedServers.find(s => s.id === dmTab.serverId);
                  const serverHost = currentServer?.address?.split(':')[0];
                  const authToken = currentServer?.authToken;

                  if (fMime.startsWith('video/') && fileServerPort && serverHost && authToken) {
                    try {
                      const timeout = new Promise<null>(r => setTimeout(r, 60000, null));
                      const result = await Promise.race([
                        window.electronAPI.uploadFile(serverHost, fileServerPort, authToken, fName, fMime, fData),
                        timeout,
                      ]);
                      if (result?.fileId) {
                        const refBody = `__FILE_REF__:${result.fileId}:${result.fileName}:${result.mimeType}`;
                        const dmKey = await getDmSharedKey(dmTab.username);
                        const encRefBody = dmKey ? await dmEncrypt(refBody, dmKey) : refBody;
                        window.electronAPI.sendDm(dmTab.serverId, dmTab.username, encRefBody);
                        setPendingDmFile(null);
                        if (dmInput.trim()) {
                          const encText = dmKey ? await dmEncrypt(dmInput, dmKey) : dmInput;
                          window.electronAPI.sendDm(dmTab.serverId, dmTab.username, encText);
                          setDmInput('');
                        }
                        dmInputRef.current?.focus();
                        return;
                      }
                    } catch {}
                  }

                  // Inline file — send unencrypted so server can transcode if needed
                  const fileBody = `__FILE__:${fName}:${fMime}:${fData}`;
                  window.electronAPI.sendDm(dmTab.serverId, dmTab.username, fileBody);
                  setPendingDmFile(null);
                }
                if (dmInput.trim()) {
                  const dmKey = await getDmSharedKey(dmTab.username);
                  const body = dmKey ? await dmEncrypt(dmInput, dmKey) : dmInput;
                  window.electronAPI.sendDm(dmTab.serverId, dmTab.username, body);
                  setDmInput('');
                }
                dmInputRef.current?.focus();
              }} className="px-4 py-3 flex gap-2">
                <input
                  ref={dmInputRef}
                  type="text"
                  value={dmInput}
                  onChange={e => setDmInput(e.target.value)}
                  placeholder={pendingDmFile ? 'Add a message (optional)...' : `Message ${activeDmTab}...`}
                  className="flex-1 bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2.5 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-1 focus:ring-green-900/50 transition-all text-sm"
                  autoFocus
                />
                <input ref={dmFileInputRef} type="file" className="hidden" onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const maxBytes = (serverInfo?.maxFileSizeKB || 2048) * 1024;
                  if (file.size > maxBytes) {
                    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
                    const maxMB = ((serverInfo?.maxFileSizeKB || 2048) / 1024).toFixed(0);
                    setDmError(`File too large (${sizeMB} MB) — server limit is ${maxMB} MB`);
                    setTimeout(() => setDmError(null), 5000);
                    if (dmFileInputRef.current) dmFileInputRef.current.value = '';
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = reader.result as string;
                    const base64 = dataUrl.split(',')[1];
                    const mimeType = file.type || 'application/octet-stream';
                    setPendingDmFile({ name: file.name, mimeType, base64, dataUrl });
                  };
                  reader.readAsDataURL(file);
                  if (dmFileInputRef.current) dmFileInputRef.current.value = '';
                }} />
                <button type="button" onClick={() => dmFileInputRef.current?.click()}
                  className={`px-2.5 py-2.5 rounded-lg transition-all ${pendingDmFile ? 'text-green-400 bg-green-900/30' : 'text-green-700 hover:text-green-400 hover:bg-green-900/20'}`}
                  title={`Upload file (max ${serverInfo?.maxFileSizeKB || 2048} KB)`}>
                  <Paperclip className="w-4 h-4" />
                </button>
                <button type="submit" disabled={!dmInput.trim() && !pendingDmFile}
                  className="px-4 py-2.5 bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:text-green-800 text-green-400 rounded-lg transition-all text-sm font-bold">
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          </div>
        );
      })() : (
      <>
      {/* ── Main content ───────────────────────────────────── */}
      <div className="flex-1 flex gap-0 overflow-hidden">

        {/* ── Left sidebar: rooms ─────────────────────────── */}
        <div className={`bg-[#0d120d]/60 backdrop-blur-sm rounded-lg shadow-lg shadow-green-900/10 flex flex-col shrink-0 ${isCallFullscreen && viewMode === 'voice' && currentVoiceRoom ? 'hidden' : ''}`}
          style={{ width: leftSidebarWidth }}>
          <div className="flex-1 overflow-y-auto">
            {/* Text channels */}
            <div className="p-4 border-b border-green-900/30">
              <div className="flex items-center justify-between">
                <div className="text-xs text-green-700">TEXT CHANNELS</div>
                {hasPermission('create_rooms') && (
                  <button onClick={() => { setCreateRoomDialog({ type: 'text' }); setNewRoomName(''); setNewRoomRoles([]); }}
                    className="p-1 text-green-700 hover:text-green-400 transition-colors" title="Create text channel">
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="p-3">
              {textRooms.map((r, idx) => {
                const isDraggingText = dragRoomIdx?.type === 'text' && dragRoomIdx.idx === idx;
                const isDragOverText = dragOverRoomIdx?.type === 'text' && dragOverRoomIdx.idx === idx && !isDraggingText;
                return (
                  <div
                    key={r.name}
                    className={`mb-2 rounded-lg transition-all ${isDraggingText ? 'opacity-50' : ''} ${isDragOverText ? 'ring-1 ring-green-500/50' : ''}`}
                    draggable={hasPermission('reorder_rooms')}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragRoomIdx({ type: 'text', idx }); }}
                    onDragOver={(e) => { e.preventDefault(); setDragOverRoomIdx({ type: 'text', idx }); }}
                    onDragLeave={() => { if (dragOverRoomIdx?.type === 'text' && dragOverRoomIdx.idx === idx) setDragOverRoomIdx(null); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragRoomIdx?.type === 'text' && dragRoomIdx.idx !== idx) {
                        const names = textRooms.map(x => x.name);
                        const [removed] = names.splice(dragRoomIdx.idx, 1);
                        names.splice(idx, 0, removed);
                        sendToServer(`CMD:REORDER_TEXT_ROOMS:${names.join(',')}`);
                      }
                      setDragRoomIdx(null); setDragOverRoomIdx(null);
                    }}
                    onDragEnd={() => { setDragRoomIdx(null); setDragOverRoomIdx(null); }}>
                    <button
                      onClick={() => joinText(r)}
                      onContextMenu={(e) => { e.preventDefault(); setRoomContextMenu({ type: 'text', name: r.name, idx, x: e.clientX, y: e.clientY }); }}
                      className={`w-full text-left px-4 py-2.5 rounded-lg flex items-center gap-2 transition-all ${
                        currentTextRoom === r.name && viewMode === 'text' && !activeDmTab
                          ? 'bg-green-900/40 text-green-400 shadow-md shadow-green-900/30'
                          : mentionedRooms[r.name]
                            ? 'bg-red-900/20 text-white font-bold hover:bg-red-900/30'
                            : unreadRooms.has(r.name)
                              ? 'text-green-400 font-bold hover:bg-green-900/20'
                              : 'text-green-700 hover:bg-green-900/20'
                      }`}>
                      {r.allowedRoles.length > 0 ? <Lock className="w-4 h-4" /> : <Hash className="w-4 h-4" />}
                      <span className="text-sm truncate flex-1">{r.name}</span>
                      {connectedServerId && (() => {
                        const chPref = notifPrefs[connectedServerId]?.[r.name];
                        if (chPref === 'none') return <span title="Muted"><BellOff className="w-3 h-3 text-green-800/60 shrink-0" /></span>;
                        if (chPref === 'mentions') return <span title="Mentions only"><Bell className="w-3 h-3 text-green-800/60 shrink-0" /></span>;
                        return null;
                      })()}
                      {mentionedRooms[r.name] ? (
                        <span className="w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-[9px] text-white font-bold shrink-0">
                          {mentionedRooms[r.name] > 9 ? '9+' : mentionedRooms[r.name]}
                        </span>
                      ) : unreadRooms.has(r.name) ? (
                        <span className="w-2 h-2 bg-green-500 rounded-full shrink-0" />
                      ) : null}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Voice channels */}
            <div className="p-4 border-b border-green-900/30">
              <div className="flex items-center justify-between">
                <div className="text-xs text-green-700">VOICE CHANNELS</div>
                {hasPermission('create_rooms') && (
                  <button onClick={() => { setCreateRoomDialog({ type: 'voice' }); setNewRoomName(''); setNewRoomRoles([]); setNewRoomBitrate('96000'); }}
                    className="p-1 text-green-700 hover:text-green-400 transition-colors" title="Create voice channel">
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="p-3">
              {voiceRooms.map((r, idx) => {
                const usersInChannel = onlineUsers.filter(u => u.online && u.voiceRoom === r.name);
                const isDraggingVoice = dragRoomIdx?.type === 'voice' && dragRoomIdx.idx === idx;
                const isDragOverVoice = dragOverRoomIdx?.type === 'voice' && dragOverRoomIdx.idx === idx && !isDraggingVoice;
                return (
                  <div
                    key={r.name}
                    className={`mb-2 rounded-lg transition-all ${isDraggingVoice ? 'opacity-50' : ''} ${isDragOverVoice ? 'ring-1 ring-green-500/50' : ''}`}
                    draggable={hasPermission('reorder_rooms')}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragRoomIdx({ type: 'voice', idx }); }}
                    onDragOver={(e) => { e.preventDefault(); setDragOverRoomIdx({ type: 'voice', idx }); }}
                    onDragLeave={() => { if (dragOverRoomIdx?.type === 'voice' && dragOverRoomIdx.idx === idx) setDragOverRoomIdx(null); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragRoomIdx?.type === 'voice' && dragRoomIdx.idx !== idx) {
                        const names = voiceRooms.map(x => x.name);
                        const [removed] = names.splice(dragRoomIdx.idx, 1);
                        names.splice(idx, 0, removed);
                        sendToServer(`CMD:REORDER_VOICE_ROOMS:${names.join(',')}`);
                      }
                      setDragRoomIdx(null); setDragOverRoomIdx(null);
                    }}
                    onDragEnd={() => { setDragRoomIdx(null); setDragOverRoomIdx(null); }}>
                    <button
                      onClick={() => joinVoice(r)}
                      onContextMenu={(e) => { e.preventDefault(); setRoomContextMenu({ type: 'voice', name: r.name, idx, x: e.clientX, y: e.clientY }); }}
                      className={`w-full text-left px-4 py-2.5 rounded-lg flex items-center gap-2 transition-all ${
                        currentVoiceRoom === r.name
                          ? 'bg-green-900/40 text-green-400 shadow-md shadow-green-900/30'
                          : 'hover:bg-green-900/20 text-green-600'
                      }`}>
                      {r.allowedRoles.length > 0 ? <Lock className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                      <span className="text-sm truncate">{r.name}</span>
                    </button>
                    {usersInChannel.length > 0 && (
                      <div className="ml-6 mt-1 space-y-1">
                        {usersInChannel.map(u => (
                          <div key={u.name}
                            onContextMenu={(e) => { e.preventDefault(); setUserContextMenu({ userId: u.name, x: e.clientX, y: e.clientY }); }}
                            className="flex items-center gap-2 px-2 py-1 text-xs text-green-600 cursor-pointer rounded hover:bg-green-900/20 transition-all">
                            <UserAvatar name={u.name} size="sm" />
                            <span className="truncate" style={{ color: u.roleColor || undefined }}>{u.name}</span>
                            {u.muted && <MicOff className="w-3 h-3 text-red-500 shrink-0" />}
                            {u.deafened && <VolumeX className="w-3 h-3 text-red-500 shrink-0" />}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Soundboard popup */}
          {showSoundboard && currentVoiceRoom && soundboardSounds.length > 0 && (
            <div className="border-t border-green-900/30 bg-[#0d120d]/60 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] text-green-700 uppercase tracking-wider">Soundboard</span>
                <div className="flex items-center gap-1 ml-auto">
                  <button onClick={() => setSoundboardMuted(m => !m)}
                    className={`p-1 rounded transition-all ${soundboardMuted ? 'text-red-500' : 'text-green-700 hover:text-green-400'}`}
                    title={soundboardMuted ? 'Unmute all sounds' : 'Mute all sounds'}>
                    {soundboardMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                  </button>
                  <button onClick={() => setShowSoundboard(false)} className="p-1 text-green-800 hover:text-green-400 transition-colors">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <Volume2 className="w-3 h-3 text-green-700 shrink-0" />
                <input type="range" min="0" max="100" value={soundboardVolume}
                  onChange={e => {
                    const val = parseInt(e.target.value);
                    setSoundboardVolume(val);
                    if (soundboardGainRef.current) soundboardGainRef.current.gain.value = val / 100;
                  }}
                  className="flex-1 h-1.5 bg-green-900/30 rounded-lg appearance-none cursor-pointer accent-green-500" />
                <span className="text-[10px] text-green-700 w-7 text-right shrink-0">{soundboardVolume}%</span>
              </div>
              {soundboardMuted && (
                <div className="text-[10px] text-red-500/70 mb-2">All sounds muted</div>
              )}
              <div className="grid grid-cols-2 gap-1 max-h-32 overflow-y-auto">
                {soundboardSounds.map(name => (
                  <button key={name} onClick={() => {
                      if (playingSound === name) {
                        if (soundboardSourceRef.current) { try { soundboardSourceRef.current.stop(); } catch {} soundboardSourceRef.current = null; soundboardGainRef.current = null; }
                        setPlayingSound(null);
                      } else {
                        sendToVoice(`CMD:PLAY_SOUND:${name}`);
                      }
                    }}
                    className={`text-left px-2.5 py-1.5 rounded text-xs transition-all truncate flex items-center gap-1.5 ${
                      playingSound === name ? 'bg-green-900/40 text-green-400' : 'text-green-600 hover:bg-green-900/30 hover:text-green-400'
                    }`}>
                    {playingSound === name ? <Square className="w-3 h-3 shrink-0" /> : <Play className="w-3 h-3 shrink-0" />}
                    <span className="truncate">{name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* User controls at bottom */}
          <div className="p-4 border-t border-green-900/30 bg-[#0d120d]/40">
            <div className="flex items-center gap-3 mb-3">
              <div className="relative group/avatar shrink-0">
                <UserAvatar name={nickname} size="md" />
                <button onClick={openAvatarPicker}
                  className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover/avatar:opacity-100 transition-opacity"
                  title="Change profile picture">
                  <ImageIcon className="w-3 h-3 text-white" />
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-green-500 truncate">{nickname}</div>
                <div className={`text-xs ${isAway ? 'text-yellow-500' : 'text-green-700'}`}>{isAway ? 'away' : 'online'}</div>
              </div>
            </div>
            <div className="flex items-center flex-wrap gap-1">
              {pushToTalkMode && currentVoiceRoom && (
                <div className={`px-2 py-1 rounded text-[10px] font-bold transition-all select-none ${pttHeld ? 'bg-green-900/60 text-green-300' : 'bg-red-900/30 text-red-400'}`}
                  title="Push-to-Talk active">
                  PTT
                </div>
              )}
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
              {currentVoiceRoom && (
                <>
                  <button onClick={leaveVoice}
                    className="p-2 rounded-lg bg-red-900/30 text-red-500 hover:bg-red-900/50 transition-all"
                    title="Leave voice">
                    <PhoneOff className="w-4 h-4" />
                  </button>
                  {soundboardSounds.length > 0 && (
                    <button onClick={() => setShowSoundboard(s => !s)}
                      className={`p-2 rounded-lg transition-all ${showSoundboard ? 'bg-green-900/40 text-green-400' : 'bg-green-900/20 text-green-600 hover:bg-green-900/40'}`}
                      title="Soundboard">
                      <Music className="w-4 h-4" />
                    </button>
                  )}
                </>
              )}
              <button onClick={() => {
                  const next = !isAway;
                  setIsAway(next);
                  sendToServer(`CMD:SET_STATUS:${next ? 'away' : 'online'}`);
                }}
                className={`p-2 rounded-lg transition-all ${isAway ? 'bg-yellow-900/40 text-yellow-500 hover:bg-yellow-900/60' : 'bg-green-900/20 text-green-600 hover:bg-green-900/40'}`}
                title={isAway ? 'Set Online' : 'Set Away'}>
                <Moon className="w-4 h-4" />
              </button>
              <button onClick={() => { setShowSettings(true); refreshDevices(); }}
                className="p-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all"
                title="Settings">
                <Settings className="w-4 h-4" />
              </button>
              {(hasPermission('server_settings') || hasPermission('manage_roles') || hasPermission('manage_soundboard') || hasPermission('manage_emojis')) && (
                <button onClick={() => setShowServerSettings(true)}
                  className="p-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all"
                  title="Server Settings">
                  <Shield className="w-4 h-4" />
                </button>
              )}
              <button onClick={() => { const next = !showUserList; setShowUserList(next); localStorage.setItem('voip-show-user-list', String(next)); }}
                className={`p-2 rounded-lg transition-all ${showUserList ? 'bg-green-900/20 text-green-600 hover:bg-green-900/40' : 'bg-green-900/40 text-green-400 hover:bg-green-900/60'}`}
                title={showUserList ? 'Hide user list' : 'Show user list'}>
                {showUserList ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* ── Left resize handle ──────────────────────────── */}
        {!(isCallFullscreen && viewMode === 'voice' && currentVoiceRoom) && (
          <div
            className="w-[3px] shrink-0 cursor-col-resize group flex items-center justify-center hover:bg-green-500/20 transition-colors"
            onMouseDown={(e) => startResize('left', e)}>
            <div className="w-px h-6 bg-green-900/30 group-hover:bg-green-500/60 rounded-full transition-colors" />
          </div>
        )}

        {/* ── Center panel ────────────────────────────────── */}
        <div className={`flex-1 flex flex-col overflow-hidden ${hideUiOverlay && isCallFullscreen && viewMode === 'voice' && currentVoiceRoom ? 'bg-black' : 'bg-[#0d120d]/60 backdrop-blur-sm rounded-lg shadow-lg shadow-green-900/10'}`}>
          {viewMode === 'voice' && currentVoiceRoom ? (
            /* ── Voice / Video call ─────────────────────── */
            <div className={`flex-1 flex flex-col relative group/call ${hideUiOverlay && isCallFullscreen && !mouseActive ? 'cursor-none' : ''}`}
              onMouseMove={() => {
                if (hideUiOverlay && isCallFullscreen) {
                  setMouseActive(true);
                  if (mouseIdleTimerRef.current) clearTimeout(mouseIdleTimerRef.current);
                  mouseIdleTimerRef.current = setTimeout(() => setMouseActive(false), 3000);
                }
              }}
              onMouseLeave={() => {
                if (hideUiOverlay && isCallFullscreen) {
                  if (mouseIdleTimerRef.current) clearTimeout(mouseIdleTimerRef.current);
                  setMouseActive(false);
                }
              }}>
              {isVideoMode ? (
                /* ── Video Grid Mode ─────────────────────── */
                <div className={`flex-1 flex flex-col ${hideUiOverlay && isCallFullscreen ? 'p-0' : 'p-4'}`}>
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
                      const isSpeaking = isLocal
                        ? (pushToTalkMode ? pttHeld : (micLevel > 0.05 && !isMuted))
                        : speakingUsers.has(u.name);
                      const isGateSuppressing = isLocal && !pushToTalkMode && gateActive && inputSensitivity > 0 && micLevel > 0.05;
                      return (
                        <div key={u.name}
                          onClick={() => setSelectedVideoFeed(isSelected ? null : u.name)}
                          onContextMenu={(e) => { if (!isLocal) { e.preventDefault(); e.stopPropagation(); setUserContextMenu({ userId: u.name, x: e.clientX, y: e.clientY }); } }}
                          className={`relative bg-[#0a0e0a] rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                            isSelected
                              ? 'h-full border-green-500 shadow-lg shadow-green-900/50'
                              : isSpeaking
                                ? 'shadow-lg'
                                : isGateSuppressing
                                  ? 'border-yellow-600/60'
                                  : 'border-green-900/30 hover:border-green-700/50'
                          }`}
                          style={!isSelected ? (isSpeaking ? { borderColor: '#4ade80', '--tw-shadow-color': 'rgba(34, 197, 94, 0.5)' } as React.CSSProperties : isGateSuppressing ? { borderColor: '#ca8a04' } : undefined) : undefined}>
                          {isGateSuppressing && (
                            <div className="absolute top-1 left-1 z-20 px-1.5 py-0.5 rounded text-[9px] font-bold bg-yellow-900/80 text-yellow-400 pointer-events-none">GATED</div>
                          )}
                          {isLocal && pushToTalkMode && (
                            <div className={`absolute top-1 right-1 z-20 px-1.5 py-0.5 rounded text-[9px] font-bold pointer-events-none ${pttHeld ? 'bg-green-900/80 text-green-300' : 'bg-red-900/80 text-red-400'}`}>PTT</div>
                          )}
                          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-green-950/50 to-green-900/30">
                            {isLocal ? (
                              (isCameraOn || isScreenSharing) ? (
                                <video autoPlay muted playsInline className="absolute inset-0 w-full h-full object-contain"
                                  ref={el => { if (el && cameraStreamRef.current && el.srcObject !== cameraStreamRef.current) el.srcObject = cameraStreamRef.current; }} />
                              ) : (
                                <UserAvatar name={u.name} size="lg" />
                              )
                            ) : (
                              <>
                                <UserAvatar name={u.name} size="lg" />
                                {(cameraUsers.has(u.name) || screenUsers.has(u.name)) && !watchingStreams.has(u.name) ? (
                                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 z-10">
                                    <div className="text-green-500 text-xs mb-2 flex items-center gap-1">
                                      {screenUsers.has(u.name) ? <><Share2 className="w-3.5 h-3.5" /> Sharing screen</> : <><Video className="w-3.5 h-3.5" /> Camera on</>}
                                    </div>
                                    <button onClick={(e) => {
                                        e.stopPropagation();
                                        watchingStreamsRef.current.add(u.name);
                                        setWatchingStreams(new Set(watchingStreamsRef.current));
                                        sendToVoice(`CMD:WATCH_STREAM:${u.name}`);
                                      }}
                                      className="px-4 py-2 rounded-lg bg-green-600/30 text-green-400 hover:bg-green-600/50 transition-all text-sm font-bold flex items-center gap-2">
                                      <Play className="w-4 h-4" />
                                      Join stream
                                    </button>
                                  </div>
                                ) : (getUserSetting(u.name).screenMuted && (cameraUsers.has(u.name) || screenUsers.has(u.name))) ? (
                                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 z-10">
                                    <EyeOff className="w-6 h-6 text-red-400 mb-1" />
                                    <span className="text-xs text-red-400">Stream muted</span>
                                  </div>
                                ) : null}
                                <canvas id={`vc-${u.name}`}
                                  className="absolute inset-0 w-full h-full object-contain"
                                  style={{ display: watchingStreams.has(u.name) && !getUserSetting(u.name).screenMuted && (cameraUsers.has(u.name) || screenUsers.has(u.name)) ? 'block' : 'none' }} />
                              </>
                            )}
                          </div>
                          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-green-400 font-bold text-sm">{u.name}{isLocal ? ' (du)' : ''}</span>
                              <div className="flex items-center gap-2">
                                {!isLocal && watchingStreams.has(u.name) && (cameraUsers.has(u.name) || screenUsers.has(u.name)) && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (poppedOut.has(u.name)) {
                                        window.electronAPI.closePopout(u.name);
                                        setPoppedOut(prev => { const s = new Set(prev); s.delete(u.name); return s; });
                                      } else {
                                        window.electronAPI.openPopout(u.name);
                                        setPoppedOut(prev => new Set(prev).add(u.name));
                                      }
                                    }}
                                    className={`p-1 rounded transition-all ${poppedOut.has(u.name) ? 'text-green-400 bg-green-900/40' : 'text-green-600 hover:text-green-400 hover:bg-green-900/30'}`}
                                    title={poppedOut.has(u.name) ? 'Close pop-out' : 'Pop out'}>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {!isLocal && (() => {
                                  const s = getUserSetting(u.name);
                                  return s.isMuted ? <VolumeX className="w-4 h-4 text-red-400" /> :
                                    s.volume !== 100 ? <span className="text-xs text-green-600">{s.volume}%</span> : null;
                                })()}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className={`flex justify-center gap-3 pb-2 ${hideUiOverlay && isCallFullscreen ? `absolute bottom-0 left-0 right-0 bg-black/70 backdrop-blur-sm py-4 transition-opacity duration-300 z-10 ${mouseActive ? 'opacity-100' : 'opacity-0 pointer-events-none'}` : ''}`}>
                    <button onClick={() => setIsMuted(!isMuted)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isMuted ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20'}`}
                      title={isMuted ? 'Unmute' : 'Mute'}>
                      {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                    </button>
                    <button onClick={() => isCameraOn ? stopVideoCapture() : startCamera()}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isCameraOn ? 'bg-green-600/30 text-green-400 hover:bg-green-600/50 shadow-green-900/30' : 'bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20'}`}
                      title={isCameraOn ? 'Turn off camera' : 'Turn on camera'}>
                      {isCameraOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
                    </button>
                    <button onClick={() => isScreenSharing ? stopVideoCapture() : openScreenShareDialog()}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isScreenSharing ? 'bg-green-600/30 text-green-400 hover:bg-green-600/50 shadow-green-900/30' : 'bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20'}`}
                      title={isScreenSharing ? 'Stop sharing' : 'Share screen'}>
                      <Share2 className="w-6 h-6" />
                    </button>
                    <button onClick={leaveVoice}
                      className="w-14 h-14 rounded-full bg-red-600/80 hover:bg-red-600 text-white flex items-center justify-center transition-all shadow-lg shadow-red-900/50"
                      title="Leave voice">
                      <PhoneOff className="w-6 h-6" />
                    </button>
                    <button onClick={() => setIsDeafened(!isDeafened)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isDeafened ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20'}`}
                      title={isDeafened ? 'Undeafen' : 'Deafen'}>
                      {isDeafened ? <VolumeX className="w-6 h-6" /> : <Headphones className="w-6 h-6" />}
                    </button>
                    <button onClick={() => { setIsCallFullscreen(f => { if (f) { setHideUiOverlay(false); setMouseActive(true); if (mouseIdleTimerRef.current) clearTimeout(mouseIdleTimerRef.current); } return !f; }); }}
                      className="w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20"
                      title={isCallFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                      {isCallFullscreen ? <Minimize2 className="w-6 h-6" /> : <Maximize className="w-6 h-6" />}
                    </button>
                    {isCallFullscreen && (
                      <button onClick={() => {
                          setHideUiOverlay(h => {
                            if (!h) {
                              // Turning ON — start idle timer
                              setMouseActive(true);
                              if (mouseIdleTimerRef.current) clearTimeout(mouseIdleTimerRef.current);
                              mouseIdleTimerRef.current = setTimeout(() => setMouseActive(false), 3000);
                            } else {
                              // Turning OFF — clear timer, show everything
                              setMouseActive(true);
                              if (mouseIdleTimerRef.current) clearTimeout(mouseIdleTimerRef.current);
                            }
                            return !h;
                          });
                        }}
                        className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                          hideUiOverlay ? 'bg-green-600/30 text-green-400 hover:bg-green-600/50 shadow-green-900/30' : 'bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20'}`}
                        title={hideUiOverlay ? 'Show UI' : 'Hide UI'}>
                        {hideUiOverlay ? <Eye className="w-6 h-6" /> : <EyeOff className="w-6 h-6" />}
                      </button>
                    )}
                  </div>
                  <div className={`text-center py-2 border-t border-green-900/30 ${hideUiOverlay && isCallFullscreen ? 'hidden' : ''}`}>
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
                      {usersInRoom.map(u => {
                        const isSelf = u.name === nickname;
                        const userMuted = isSelf ? isMuted : u.muted;
                        const userDeafened = isSelf ? isDeafened : u.deafened;
                        const isSpeaking = isSelf
                          ? (pushToTalkMode ? pttHeld : (micLevel > 0.05 && !isMuted))
                          : speakingUsers.has(u.name);
                        const isGateSuppressing = isSelf && !pushToTalkMode && gateActive && inputSensitivity > 0 && micLevel > 0.05;
                        return (
                        <div key={u.name} className="flex flex-col items-center">
                          <div className={`w-32 h-32 rounded-full ring-2 shadow-lg mb-3 relative overflow-visible transition-all duration-200 ${
                            isSpeaking ? '' : isGateSuppressing ? 'ring-yellow-600/50 shadow-yellow-900/30' : 'ring-green-900/50 shadow-green-900/50'
                          }`}
                            style={isSpeaking ? { '--tw-ring-color': '#4ade80', '--tw-shadow-color': 'rgba(34, 197, 94, 0.5)' } as React.CSSProperties : undefined}>
                            {u.avatar ? (
                              <img src={`data:image/jpeg;base64,${u.avatar}`} className="w-32 h-32 rounded-full object-cover" />
                            ) : (
                              <div className="w-32 h-32 rounded-full bg-green-900/40 flex items-center justify-center">
                                <span className="text-4xl font-bold" style={{ color: u.roleColor || '#22c55e' }}>{u.name.charAt(0).toUpperCase()}</span>
                              </div>
                            )}
                            {isSelf && pushToTalkMode && (
                              <div className={`absolute -top-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[10px] font-bold ${pttHeld ? 'bg-green-900/90 text-green-300' : 'bg-red-900/80 text-red-400'}`}>PTT</div>
                            )}
                            {isSelf && isGateSuppressing && (
                              <div className="absolute -top-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[10px] font-bold bg-yellow-900/90 text-yellow-400">GATED</div>
                            )}
                            {(userMuted || userDeafened) && (
                              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex gap-1">
                                {userMuted && (
                                  <span className="bg-red-600 rounded-full p-1 ring-2 ring-[#0a0e0a]">
                                    <MicOff className="w-3.5 h-3.5 text-white" />
                                  </span>
                                )}
                                {userDeafened && (
                                  <span className="bg-red-600 rounded-full p-1 ring-2 ring-[#0a0e0a]">
                                    <VolumeX className="w-3.5 h-3.5 text-white" />
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <h3 className="text-lg font-bold text-green-400 mb-1">{u.name}</h3>
                          <div className="flex items-center gap-2 text-xs text-green-700">
                            {userMuted ? <MicOff className="w-3 h-3 text-red-500" /> : userDeafened ? <VolumeX className="w-3 h-3 text-red-500" /> : <Mic className="w-3 h-3" />}
                            <span className={userMuted ? 'text-red-500' : userDeafened ? 'text-red-500' : ''}>{userMuted ? 'Muted' : userDeafened ? 'Deafened' : 'Listening'}</span>
                          </div>
                          {!isSelf && (cameraUsers.has(u.name) || screenUsers.has(u.name)) && !watchingStreams.has(u.name) && (
                            <button onClick={() => {
                                watchingStreamsRef.current.add(u.name);
                                setWatchingStreams(new Set(watchingStreamsRef.current));
                                sendToVoice(`CMD:WATCH_STREAM:${u.name}`);
                                if (connectedServerId) pushNav({ type: 'server', serverId: connectedServerId, view: 'voice' });
                                setViewModeTracked('voice');
                              }}
                              className="mt-2 px-3 py-1.5 rounded-lg bg-green-600/20 text-green-400 hover:bg-green-600/30 transition-all text-xs font-bold flex items-center gap-1.5">
                              <Play className="w-3 h-3" />
                              {screenUsers.has(u.name) ? 'Join stream' : 'Watch camera'}
                            </button>
                          )}
                        </div>
                        );
                      })}
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
                        isMuted ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20'}`}
                      title={isMuted ? 'Unmute' : 'Mute'}>
                      {isMuted ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
                    </button>
                    <button onClick={() => isCameraOn ? stopVideoCapture() : startCamera()}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isCameraOn ? 'bg-green-600/30 text-green-400 hover:bg-green-600/50 shadow-green-900/30' : 'bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20'}`}
                      title={isCameraOn ? 'Turn off camera' : 'Turn on camera'}>
                      {isCameraOn ? <Video className="w-7 h-7" /> : <VideoOff className="w-7 h-7" />}
                    </button>
                    <button onClick={() => isScreenSharing ? stopVideoCapture() : openScreenShareDialog()}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isScreenSharing ? 'bg-green-600/30 text-green-400 hover:bg-green-600/50 shadow-green-900/30' : 'bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20'}`}
                      title={isScreenSharing ? 'Stop sharing' : 'Share screen'}>
                      <Share2 className="w-7 h-7" />
                    </button>
                    <button onClick={leaveVoice}
                      className="w-16 h-16 rounded-full bg-red-600/80 hover:bg-red-600 text-white flex items-center justify-center transition-all shadow-lg shadow-red-900/50"
                      title="Leave voice">
                      <PhoneOff className="w-7 h-7" />
                    </button>
                    <button onClick={() => setIsDeafened(!isDeafened)}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isDeafened ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50' : 'bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20'}`}
                      title={isDeafened ? 'Undeafen' : 'Deafen'}>
                      {isDeafened ? <VolumeX className="w-7 h-7" /> : <Headphones className="w-7 h-7" />}
                    </button>
                    <button onClick={() => { setIsCallFullscreen(f => { if (f) { setHideUiOverlay(false); setMouseActive(true); if (mouseIdleTimerRef.current) clearTimeout(mouseIdleTimerRef.current); } return !f; }); }}
                      className="w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg bg-white/10 text-white/80 hover:bg-white/20 shadow-black/20"
                      title={isCallFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
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
                <div className="flex-1 flex flex-col min-h-0"
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={e => { e.preventDefault(); e.stopPropagation(); const file = e.dataTransfer.files?.[0]; if (file) stageFile(file); }}>
                  {currentVoiceRoom && (
                    <div className="border-b border-green-900/30 px-4 py-2 bg-green-900/20 flex items-center gap-2 text-xs">
                      <Volume2 className="w-3.5 h-3.5 text-green-500" />
                      <span className="text-green-500">{currentVoiceRoom}</span>
                      <span className="text-green-700">{fmt(callDuration)}</span>
                      {(cameraUsers.size > 0 || screenUsers.size > 0) && (() => {
                        const unwatched = [...cameraUsers, ...screenUsers].filter(u => !watchingStreams.has(u) && u !== nickname);
                        if (unwatched.length === 0) return null;
                        return (
                          <button onClick={() => {
                              unwatched.forEach(u => { watchingStreamsRef.current.add(u); sendToVoice(`CMD:WATCH_STREAM:${u}`); });
                              setWatchingStreams(new Set(watchingStreamsRef.current));
                              if (connectedServerId) pushNav({ type: 'server', serverId: connectedServerId, view: 'voice' });
                              setViewModeTracked('voice');
                            }}
                            className="ml-2 px-2.5 py-1 rounded-md bg-green-600/20 text-green-400 hover:bg-green-600/30 transition-all flex items-center gap-1.5 font-bold animate-pulse">
                            {screenUsers.size > 0 ? <><Share2 className="w-3 h-3" /> Join screenshare</> : <><Video className="w-3 h-3" /> Join camera</>}
                          </button>
                        );
                      })()}
                      <button onClick={() => { if (connectedServerId) pushNav({ type: 'server', serverId: connectedServerId, view: 'voice' }); setViewModeTracked('voice'); }} className="ml-auto text-green-600 hover:text-green-400 transition-colors">
                        Show voice
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
                  <span className="text-xs text-green-700 ml-2">{currentMessages.length} messages</span>
                  <button onClick={() => setShowPins(p => !p)}
                    className={`ml-auto p-2 rounded-lg transition-all flex items-center gap-1.5 ${
                      showPins ? 'bg-green-900/40 text-green-400' : 'text-green-700 hover:text-green-400 hover:bg-green-900/20'
                    }`}
                    title="Pinned messages">
                    <Pin className="w-4 h-4" />
                    {(pinnedMessages[currentTextRoom!] || []).length > 0 && (
                      <span className="text-[10px]">{(pinnedMessages[currentTextRoom!] || []).length}</span>
                    )}
                  </button>
                </div>
              </div>
              {showPins && (
                <div className="border-b border-green-900/30 bg-[#0d120d]/60 max-h-64 overflow-y-auto">
                  <div className="p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Pin className="w-3.5 h-3.5 text-green-500" />
                      <span className="text-xs font-bold text-green-500">PINNED MESSAGES</span>
                      <span className="text-[10px] text-green-700">{(pinnedMessages[currentTextRoom!] || []).length}</span>
                    </div>
                    {(pinnedMessages[currentTextRoom!] || []).length === 0 ? (
                      <div className="text-center py-4 text-green-800 text-xs">No pinned messages</div>
                    ) : (
                      <div className="space-y-2">
                        {(pinnedMessages[currentTextRoom!] || []).map(msg => {
                          const msgDate = new Date(msg.timestamp);
                          const timeStr = msgDate.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
                          const dateStr = msgDate.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' });
                          const senderUser = onlineUsers.find(u => u.name === msg.sender);
                          return (
                            <div key={msg.msgId} className="bg-[#0a0e0a] border border-green-900/40 rounded-lg px-3 py-2 group/pin">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-bold" style={{ color: senderUser?.roleColor || '#22c55e' }}>{msg.sender}</span>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-green-800">{dateStr} {timeStr}</span>
                                  {hasPermission('pin_messages') && (
                                    <button onClick={() => sendToServer(`CMD:UNPIN_MSG:${currentTextRoom}:${msg.msgId}`)}
                                      className="opacity-0 group-hover/pin:opacity-100 p-0.5 text-green-800 hover:text-red-400 transition-all" title="Unpin">
                                      <X className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              </div>
                              <div className="text-sm text-green-500 break-words">{renderMessageBody(msg.body)}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div ref={chatScrollRef} onScroll={handleChatScroll} className="flex-1 overflow-y-auto p-6 space-y-0">
                {currentTextRoom && roomLoadingMore[currentTextRoom] && (
                  <div className="text-center text-xs text-green-700 py-2">Loading older messages…</div>
                )}
                {currentMessages.map((msg, idx) => {
                  const prev = idx > 0 ? currentMessages[idx - 1] : null;
                  const sameSender = prev && prev.sender === msg.sender && msg.sender !== '';
                  const withinMinute = sameSender && (msg.timestamp - prev.timestamp) < 60_000;
                  const showHeader = !withinMinute;
                  const msgDate = new Date(msg.timestamp);
                  const today = new Date();
                  const isToday = msgDate.toDateString() === today.toDateString();
                  const timeStr = msgDate.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
                  const dateStr = isToday ? '' : msgDate.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' }) + ' ';
                  const senderUser = onlineUsers.find(u => u.name === msg.sender);
                  const senderColor = senderUser?.roleColor || undefined;
                  const isMention = nickname && !msg.body.startsWith('__FILE__:') && msg.body.toLowerCase().includes(`@${nickname.toLowerCase()}`);
                  const mentionBg = isMention ? 'bg-yellow-500/10 border-l-2 border-yellow-500/50' : '';
                  const canEdit = msg.msgId && (msg.sender === nickname || hasPermission('delete_messages')) && !msg.body.startsWith('__FILE__:') && !msg.body.startsWith('__GIF__:') && !msg.body.startsWith('__FILE_REF__:');
                  const isEditing = editingMsg?.msgId === msg.msgId;
                  const msgReactions = msg.msgId ? (reactions[msg.msgId] || {}) : {};
                  const hasReactions = Object.keys(msgReactions).length > 0;
                  const reactionBar = msg.msgId ? (
                    <div className="pl-8 flex flex-wrap items-center gap-1 mt-1">
                      {Object.entries(msgReactions).map(([emoji, users]) => (
                        <button key={emoji} type="button"
                          onClick={() => sendToServer(`CMD:REACT:${currentTextRoom}:${msg.msgId}:${emoji}`)}
                          title={users.join(', ')}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-all ${
                            users.includes(nickname)
                              ? 'bg-green-900/40 border-green-700/50 text-green-300'
                              : 'bg-transparent border-green-900/30 text-green-700 hover:border-green-700/40 hover:text-green-500'
                          }`}>
                          <span>{emoji}</span><span>{users.length}</span>
                        </button>
                      ))}
                      <button type="button"
                        onClick={() => setReactionPickerMsgId(prev => prev === msg.msgId ? null : msg.msgId)}
                        className="opacity-0 group-hover:opacity-100 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs border border-green-900/30 text-green-800 hover:border-green-700/40 hover:text-green-600 transition-all">
                        <SmilePlus className="w-3 h-3" />
                      </button>
                      {reactionPickerMsgId === msg.msgId && (
                        <div className="absolute z-50 mt-1 bg-[#0d120d] border border-green-900/50 rounded-lg shadow-xl shadow-black/40 p-2 flex flex-wrap gap-1 w-56">
                          {['👍','👎','❤️','😂','😮','😢','😡','🔥','✅','🎉','💯','👀','💀','🤔','🙏','💪','⭐','🥳'].map(e => (
                            <button key={e} type="button"
                              onClick={() => { sendToServer(`CMD:REACT:${currentTextRoom}:${msg.msgId}:${e}`); setReactionPickerMsgId(null); }}
                              className="w-8 h-8 flex items-center justify-center text-lg hover:bg-green-900/30 rounded transition-all">
                              {e}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null;
                  return (
                  <div key={msg.id} className={`group relative ${mentionBg}`}
                    onContextMenu={(e) => {
                      if (msg.msgId) {
                        e.preventDefault();
                        setReactionPickerMsgId(null);
                        setMsgContextMenu({ msgId: msg.msgId, sender: msg.sender, room: currentTextRoom!, x: e.clientX, y: e.clientY });
                      }
                    }}>
                    {showHeader ? (
                      <div className={`hover:bg-green-900/10 rounded px-2 py-1 -mx-2 transition-all ${idx > 0 ? 'mt-3' : ''}`}>
                        <div className="flex items-center gap-2">
                          <UserAvatar name={msg.sender} size="sm" />
                          <span className="text-sm font-bold" style={senderColor ? { color: senderColor } : undefined}>{msg.sender}</span>
                          <span className="text-[10px] text-green-700">{dateStr}{timeStr}</span>
                        </div>
                        {isEditing ? (
                          <EditInput body={editingMsg!.body} onSave={async (newBody) => {
                            const enc = await e2eeEncryptText(newBody.trim());
                            sendToServer(`CMD:EDIT_MSG:${editingMsg!.room}:${editingMsg!.msgId}:${enc}`);
                            setEditingMsg(null);
                          }} onCancel={() => setEditingMsg(null)} />
                        ) : (
                          <div className="text-sm text-green-400 mt-0.5 pl-8 flex items-start gap-1">
                            <span className="flex-1">{renderMessageBody(msg.body)}{msg.edited && <span className="text-[10px] text-green-700/60 italic ml-1">(edited)</span>}</span>
                            {canEdit && <button onClick={() => setEditingMsg({ msgId: msg.msgId, room: currentTextRoom!, body: msg.body })}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-green-800 hover:text-green-500 transition-all shrink-0 mt-0.5">
                              <Pencil className="w-3 h-3" />
                            </button>}
                          </div>
                        )}
                        {(hasReactions || reactionPickerMsgId === msg.msgId) && reactionBar}
                      </div>
                    ) : (
                      <div className="relative hover:bg-green-900/10 rounded px-2 py-0.5 -mx-2 transition-all group/cont">
                        <span className="absolute left-2 text-green-800 opacity-0 group-hover/cont:opacity-100 text-[10px] leading-5 select-none transition-opacity">{timeStr}</span>
                        {isEditing ? (
                          <div className="pl-8">
                            <EditInput body={editingMsg!.body} onSave={async (newBody) => {
                              const enc = await e2eeEncryptText(newBody.trim());
                              sendToServer(`CMD:EDIT_MSG:${editingMsg!.room}:${editingMsg!.msgId}:${enc}`);
                              setEditingMsg(null);
                            }} onCancel={() => setEditingMsg(null)} />
                          </div>
                        ) : (
                          <div className="text-sm text-green-400 pl-8 flex items-start gap-1">
                            <span className="flex-1">{renderMessageBody(msg.body)}{msg.edited && <span className="text-[10px] text-green-700/60 italic ml-1">(edited)</span>}</span>
                            {canEdit && <button onClick={() => setEditingMsg({ msgId: msg.msgId, room: currentTextRoom!, body: msg.body })}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-green-800 hover:text-green-500 transition-all shrink-0 mt-0.5">
                              <Pencil className="w-3 h-3" />
                            </button>}
                          </div>
                        )}
                        {(hasReactions || reactionPickerMsgId === msg.msgId) && reactionBar}
                      </div>
                    )}
                  </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
              <div className="border-t border-green-900/30 bg-[#0d120d]/40">
                {pendingFile && (
                  <div className="px-4 pt-3 pb-1">
                    <div className="inline-flex items-center gap-3 bg-[#0a0e0a] border border-green-900/40 rounded-lg px-3 py-2 max-w-sm">
                      {pendingFile.mimeType.startsWith('image/') ? (
                        <img src={pendingFile.dataUrl} alt={pendingFile.name} className="w-16 h-16 rounded object-cover border border-green-900/30" />
                      ) : (
                        <FileText className="w-8 h-8 text-green-600 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-green-400 truncate">{pendingFile.name}</div>
                        <div className="text-[10px] text-green-700">{pendingFile.mimeType}</div>
                      </div>
                      <button type="button" onClick={() => setPendingFile(null)}
                        className="p-1 rounded text-green-700 hover:text-red-400 hover:bg-red-900/20 transition-all flex-shrink-0"
                        disabled={!!fileUploadStatus}>
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
                {fileUploadStatus && (
                  <div className="px-4 pt-2 pb-1">
                    <div className="flex items-center gap-2">
                      <Upload className="w-3.5 h-3.5 text-green-500 animate-pulse flex-shrink-0" />
                      <span className="text-xs text-green-500">{fileUploadStatus}</span>
                    </div>
                    <div className="mt-1 h-1 bg-green-900/30 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 rounded-full animate-[progress-indeterminate_1.5s_ease-in-out_infinite]" style={{ width: '40%' }} />
                    </div>
                  </div>
                )}
                {currentTextRoom && (typingUsers[currentTextRoom] || []).length > 0 && (
                  <div className="px-4 py-1 flex items-center gap-1.5">
                    <span className="flex gap-0.5">
                      {[0,1,2].map(i => (
                        <span key={i} className="w-1 h-1 bg-green-700 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                      ))}
                    </span>
                    <span className="text-[11px] text-green-700 italic">
                      {(typingUsers[currentTextRoom] || []).slice(0, 3).join(', ')}
                      {(typingUsers[currentTextRoom] || []).length > 3 ? ' and others' : ''}
                      {' '}{(typingUsers[currentTextRoom] || []).length === 1 ? 'is' : 'are'} typing…
                    </span>
                  </div>
                )}
                <form onSubmit={handleSubmit} className="flex gap-3 items-center p-4 pt-3 relative">
                  {emojiQuery !== null && (() => {
                    const allEntries: { key: string; emoji?: string; customData?: string }[] = [
                      ...Object.keys(customEmojis).filter(k => k.toLowerCase().includes(emojiQuery.toLowerCase())).map(k => ({ key: k, customData: customEmojis[k] })),
                      ...Object.keys(EMOJI_SHORTCODES).filter(k => k.includes(emojiQuery.toLowerCase())).map(k => ({ key: k, emoji: EMOJI_SHORTCODES[k] })),
                    ].slice(0, 8);
                    if (allEntries.length === 0) return null;
                    return (
                      <div className="absolute bottom-full left-4 mb-1 w-64 bg-[#0d120d] border border-green-900/40 rounded-lg shadow-xl shadow-black/40 overflow-hidden z-50">
                        {allEntries.map((entry, i) => (
                          <button key={entry.key} type="button"
                            className={`w-full px-3 py-2 flex items-center gap-2 text-sm text-left transition-all ${i === emojiAutoIndex ? 'bg-green-900/30 text-green-400' : 'text-green-600 hover:bg-green-900/20'}`}
                            onMouseEnter={() => setEmojiAutoIndex(i)}
                            onClick={() => {
                              const cursor = inputRef.current?.selectionStart || input.length;
                              const before = input.substring(0, cursor);
                              const after = input.substring(cursor);
                              const replacement = entry.customData ? `:${entry.key}: ` : `${entry.emoji} `;
                              const newBefore = before.replace(/:[a-zA-Z0-9_+-]*$/, replacement);
                              setInput(newBefore + after);
                              setEmojiQuery(null);
                              inputRef.current?.focus();
                            }}>
                            {entry.customData
                              ? <img src={`data:image/png;base64,${entry.customData}`} className="w-5 h-5 object-contain" alt={entry.key} />
                              : <span className="text-lg w-5 text-center">{entry.emoji}</span>}
                            <span className="text-green-600">:{entry.key}:</span>
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                  {mentionQuery !== null && (() => {
                    const filtered = onlineUsers.filter(u => u.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8);
                    if (filtered.length === 0) return null;
                    return (
                      <div className="absolute bottom-full left-4 mb-1 w-56 bg-[#0d120d] border border-green-900/40 rounded-lg shadow-xl shadow-black/40 overflow-hidden z-50">
                        {filtered.map((u, i) => (
                          <button key={u.name} type="button"
                            className={`w-full px-3 py-2 flex items-center gap-2 text-sm text-left transition-all ${i === mentionIndex ? 'bg-green-900/30 text-green-400' : 'text-green-600 hover:bg-green-900/20'}`}
                            onMouseEnter={() => setMentionIndex(i)}
                            onClick={() => {
                              const cursor = inputRef.current?.selectionStart || input.length;
                              const before = input.substring(0, cursor);
                              const after = input.substring(cursor);
                              const newBefore = before.replace(/@\w*$/, `@${u.name} `);
                              setInput(newBefore + after);
                              setMentionQuery(null);
                              inputRef.current?.focus();
                            }}>
                            <UserAvatar name={u.name} size="sm" />
                            <span style={{ color: u.roleColor || undefined }}>{u.name}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                  <span className="text-green-500">{'>'}</span>
                  <input ref={inputRef} type="text" value={input}
                    onChange={e => {
                      const v = e.target.value;
                      setInput(v);
                      const cursor = e.target.selectionStart || v.length;
                      const before = v.substring(0, cursor);
                      const atMatch = before.match(/@(\w*)$/);
                      if (atMatch) { setMentionQuery(atMatch[1]); setMentionIndex(0); }
                      else setMentionQuery(null);
                      const colonMatch = before.match(/:([a-zA-Z0-9_+-]{1,})$/);
                      if (colonMatch && !before.match(/:([a-zA-Z0-9_+-]+):$/)) { setEmojiQuery(colonMatch[1]); setEmojiAutoIndex(0); }
                      else setEmojiQuery(null);
                      // Typing indicator — throttle to one event per 2 s per room
                      if (v.trim() && currentTextRoom && isConnected) {
                        const now = Date.now();
                        if (now - (typingLastSentRef.current[currentTextRoom] || 0) > 2000) {
                          typingLastSentRef.current[currentTextRoom] = now;
                          sendToServer(`CMD:TYPING:${currentTextRoom}`);
                        }
                      }
                    }}
                    onKeyDown={e => {
                      if (emojiQuery !== null) {
                        const allEntries: { key: string; isCustom: boolean }[] = [
                          ...Object.keys(customEmojis).filter(k => k.toLowerCase().includes(emojiQuery.toLowerCase())).map(k => ({ key: k, isCustom: true })),
                          ...Object.keys(EMOJI_SHORTCODES).filter(k => k.includes(emojiQuery.toLowerCase())).map(k => ({ key: k, isCustom: false })),
                        ].slice(0, 8);
                        if (allEntries.length > 0) {
                          if (e.key === 'ArrowDown') { e.preventDefault(); setEmojiAutoIndex(i => Math.min(i + 1, allEntries.length - 1)); }
                          else if (e.key === 'ArrowUp') { e.preventDefault(); setEmojiAutoIndex(i => Math.max(i - 1, 0)); }
                          else if ((e.key === 'Tab' || e.key === 'Enter') && allEntries.length > 0) {
                            e.preventDefault();
                            const sel = allEntries[emojiAutoIndex];
                            const cursor = inputRef.current?.selectionStart || input.length;
                            const before = input.substring(0, cursor);
                            const after = input.substring(cursor);
                            const replacement = sel.isCustom ? `:${sel.key}: ` : `${EMOJI_SHORTCODES[sel.key]} `;
                            const newBefore = before.replace(/:[a-zA-Z0-9_+-]*$/, replacement);
                            setInput(newBefore + after);
                            setEmojiQuery(null);
                          } else if (e.key === 'Escape') { setEmojiQuery(null); }
                          else if (allEntries.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
                        }
                      }
                      if (mentionQuery !== null) {
                        const filtered = onlineUsers.filter(u => u.name.toLowerCase().includes(mentionQuery.toLowerCase()));
                        if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, filtered.length - 1)); }
                        else if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); }
                        else if ((e.key === 'Tab' || e.key === 'Enter') && filtered.length > 0) {
                          e.preventDefault();
                          const selected = filtered[mentionIndex];
                          const cursor = inputRef.current?.selectionStart || input.length;
                          const before = input.substring(0, cursor);
                          const after = input.substring(cursor);
                          const newBefore = before.replace(/@\w*$/, `@${selected.name} `);
                          setInput(newBefore + after);
                          setMentionQuery(null);
                        } else if (e.key === 'Escape') { setMentionQuery(null); }
                      }
                    }}
                    onPaste={handlePaste}
                    className="flex-1 bg-transparent outline-none text-green-500 placeholder-green-800"
                    placeholder={pendingFile ? 'Add a message (optional)...' : 'Type a message...'} autoComplete="off" />
                  <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
                  <button type="button" onClick={() => fileInputRef.current?.click()}
                    className={`p-2 rounded-lg transition-all ${pendingFile ? 'text-green-400 bg-green-900/30' : 'text-green-700 hover:text-green-400 hover:bg-green-900/20'}`}
                    title={`Upload file (max ${serverInfo?.maxFileSizeKB || 2048} KB)`}>
                    <Paperclip className="w-4 h-4" />
                  </button>
                  <div className="relative" ref={emojiPickerRef}>
                    <button type="button" onClick={() => setShowEmojiPicker(v => !v)}
                      className={`p-2 rounded-lg transition-all ${showEmojiPicker ? 'text-green-400 bg-green-900/30' : 'text-green-700 hover:text-green-400 hover:bg-green-900/20'}`}
                      title="Emojis">
                      <Smile className="w-4 h-4" />
                    </button>
                    {showEmojiPicker && (
                      <div className="absolute bottom-full right-0 mb-2 w-80 max-h-80 overflow-y-auto bg-[#0d120d] border border-green-900/40 rounded-lg shadow-xl shadow-black/40 p-2 z-50">
                        {Object.keys(customEmojis).length > 0 && (
                          <>
                            <div className="text-[10px] text-green-700 px-1 py-1 font-bold uppercase">Custom</div>
                            <div className="grid grid-cols-8 gap-1 mb-2">
                              {Object.entries(customEmojis).map(([name, data]) => (
                                <button key={name} type="button"
                                  className="w-8 h-8 flex items-center justify-center hover:bg-green-900/30 rounded transition-all"
                                  title={`:${name}:`}
                                  onClick={() => { setInput(prev => prev + `:${name}:`); setShowEmojiPicker(false); inputRef.current?.focus(); }}>
                                  <img src={`data:image/png;base64,${data}`} className="w-6 h-6 object-contain" alt={name} />
                                </button>
                              ))}
                            </div>
                            <div className="border-t border-green-900/30 mb-1" />
                          </>
                        )}
                        <div className="text-[10px] text-green-700 px-1 py-1 font-bold uppercase">Standard</div>
                        <div className="grid grid-cols-8 gap-1">
                          {['😀','😂','😅','😊','😎','😍','🥳','😭','😤','🤔','🤯','🥺','😴','🤡','👍','👎','👏','🙌','🤝','✌️','🤙','💪','❤️','🔥','⭐','💯','🎉','🎶','💀','👀','🫡','🫠','😈','💩','🤖','👾','🐐','🦊','🐱','🐶','☕','🍕','🍺','🎮','💻','🛠️','⚡','✅','❌','⚠️','💬','📌','🚀','🌍','🌙','☀️','🌈','💎'].map(emoji => (
                            <button key={emoji} type="button"
                              className="w-8 h-8 flex items-center justify-center text-lg hover:bg-green-900/30 rounded transition-all"
                              onClick={() => { setInput(prev => prev + emoji); setShowEmojiPicker(false); inputRef.current?.focus(); }}>
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  {serverInfo?.giphyApiKey && (
                    <div className="relative" ref={gifPickerRef}>
                      <button type="button" onClick={() => { setShowGifPicker(v => !v); if (!showGifPicker) searchGifs(''); }}
                        className={`p-2 rounded-lg transition-all ${showGifPicker ? 'text-green-400 bg-green-900/30' : 'text-green-700 hover:text-green-400 hover:bg-green-900/20'}`}
                        title="GIFs">
                        <ImageIcon className="w-4 h-4" />
                      </button>
                      {showGifPicker && (
                        <div className="absolute bottom-full right-0 mb-2 w-80 bg-[#0d120d] border border-green-900/40 rounded-lg shadow-xl shadow-black/40 z-50 flex flex-col max-h-96">
                          <div className="p-2 border-b border-green-900/30">
                            <input type="text" value={gifQuery}
                              onChange={e => {
                                setGifQuery(e.target.value);
                                if (gifDebounceRef.current) clearTimeout(gifDebounceRef.current);
                                gifDebounceRef.current = setTimeout(() => searchGifs(e.target.value), 400);
                              }}
                              className="w-full bg-[#0a0e0a] border border-green-900/30 rounded px-3 py-1.5 text-sm text-green-500 placeholder-green-800 outline-none focus:border-green-700/50"
                              placeholder="Search GIFs..." autoFocus />
                          </div>
                          <div className="flex-1 overflow-y-auto p-2 min-h-0">
                            {gifLoading ? (
                              <div className="text-center text-green-700 text-xs py-8">Searching...</div>
                            ) : gifResults.length === 0 ? (
                              <div className="text-center text-green-800 text-xs py-8">No GIFs found</div>
                            ) : (
                              <div className="grid grid-cols-2 gap-1.5">
                                {gifResults.map(g => (
                                  <button key={g.id} type="button"
                                    className="rounded-lg overflow-hidden border border-green-900/20 hover:border-green-700/50 transition-all"
                                    onClick={() => sendGif(g.url)}>
                                    <img src={g.preview} alt="GIF" className="w-full h-24 object-cover" loading="lazy" />
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="px-2 py-1 border-t border-green-900/30 text-[9px] text-green-800 text-right">Powered by GIPHY</div>
                        </div>
                      )}
                    </div>
                  )}
                  <button type="submit"
                    className={`p-2 rounded-lg transition-all ${(input.trim() || pendingFile) && !fileUploadStatus ? 'text-green-400 hover:bg-green-900/30' : 'text-green-800 cursor-default'}`}
                    disabled={(!input.trim() && !pendingFile) || !!fileUploadStatus}
                    title="Send message">
                    <Send className="w-4 h-4" />
                  </button>
                </form>
              </div>
            </div>
          ) : (
            /* ── No room selected ───────────────────────── */
            <div className="flex-1 flex items-center justify-center text-green-700">
              <div className="text-center">
                <Terminal className="w-12 h-12 mx-auto mb-4 opacity-30" />
                <p>Select a channel to get started</p>
              </div>
            </div>
          )}
        </div>

        {/* ── Right resize handle ─────────────────────────── */}
        {showUserList && !(isCallFullscreen && viewMode === 'voice' && currentVoiceRoom) && (
          <div
            className="w-[3px] shrink-0 cursor-col-resize group flex items-center justify-center hover:bg-green-500/20 transition-colors"
            onMouseDown={(e) => startResize('right', e)}>
            <div className="w-px h-6 bg-green-900/30 group-hover:bg-green-500/60 rounded-full transition-colors" />
          </div>
        )}

        {/* ── Right sidebar: users ─────────────────────── */}
        {showUserList && (
        <div className={`bg-[#0d120d]/60 backdrop-blur-sm rounded-lg overflow-y-auto shadow-lg shadow-green-900/10 shrink-0 ${isCallFullscreen && viewMode === 'voice' && currentVoiceRoom ? 'hidden' : ''}`}
          style={{ width: rightSidebarWidth }}>
          <div className="p-4 border-b border-green-900/30">
            <div className="text-xs text-green-700">ONLINE — {onlineUsersList.length}</div>
          </div>
          <div className="p-3">
            {onlineUsersList.map(u => (
              <div key={u.name}
                className="px-4 py-2.5 flex items-center gap-3 hover:bg-green-900/20 rounded-lg transition-all mb-2 cursor-pointer"
                onContextMenu={(e) => { e.preventDefault(); setUserContextMenu({ userId: u.name, x: e.clientX, y: e.clientY }); }}
                onDoubleClick={() => { if (u.name !== nickname) openInlineDm(u.name, connectedServerId || ''); }}>
                <UserAvatar name={u.name} size="md" />
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
          {awayUsersList.length > 0 && (
            <>
              <div className="p-4 border-b border-green-900/30 border-t border-green-900/30">
                <div className="text-xs text-yellow-700">AWAY — {awayUsersList.length}</div>
              </div>
              <div className="p-3">
                {awayUsersList.map(u => (
                  <div key={u.name}
                    className="px-4 py-2.5 flex items-center gap-3 hover:bg-green-900/20 rounded-lg transition-all mb-2 opacity-70 cursor-pointer"
                    onContextMenu={(e) => { e.preventDefault(); setUserContextMenu({ userId: u.name, x: e.clientX, y: e.clientY }); }}
                    onDoubleClick={() => { if (u.name !== nickname) openInlineDm(u.name, connectedServerId || ''); }}>
                    <UserAvatar name={u.name} size="md" />
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
            </>
          )}
          {offlineUsersList.length > 0 && (
            <>
              <div className="p-4 border-b border-green-900/30 border-t border-green-900/30">
                <div className="text-xs text-red-700">OFFLINE — {offlineUsersList.length}</div>
              </div>
              <div className="p-3">
                {offlineUsersList.map(u => (
                  <div key={u.name} className="px-4 py-2.5 flex items-center gap-3 rounded-lg mb-2 opacity-40">
                    <UserAvatar name={u.name} size="md" />
                    <span className="text-sm text-green-800 truncate">{u.name}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        )}
      </div>

      </>
      )}
      </div>{/* end content wrapper */}

      {/* ── Settings Modal ─────────────────────────────────── */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onMouseDown={() => { setShowSettings(false); setRecordingKeybind(null); }}>
          <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            onMouseDown={e => e.stopPropagation()}>
            {/* Header */}
            <div className="bg-green-900/40 p-6 border-b border-green-900/50 flex items-center justify-between sticky top-0">
              <div className="flex items-center gap-3">
                <Settings className="w-6 h-6 text-green-500" />
                <div>
                  <h2 className="text-xl font-bold text-green-400">SETTINGS</h2>
                  <p className="text-[10px] text-green-700">Global — applies to all servers</p>
                </div>
              </div>
              <button onClick={() => { setShowSettings(false); setRecordingKeybind(null); }}
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
                  AUDIO SETTINGS
                </h3>
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Microphone</label>
                    <select value={selectedInput}
                      onChange={e => { setSelectedInput(e.target.value); selectedInputRef.current = e.target.value; }}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option value="">Default Microphone</option>
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
                    <label className="text-xs text-green-600 block mb-2">Microphone Activity</label>
                    {currentVoiceRoom ? (
                      <>
                        <div className="w-full h-3 bg-green-900/30 rounded-full overflow-hidden relative">
                          <div className={`h-full rounded-full transition-all duration-75 ${micLevel > 0.6 ? 'bg-yellow-500' : 'bg-green-500'}`}
                            style={{ width: `${micLevel * 100}%` }} />
                          {inputSensitivity > 0 && (
                            <div className="absolute top-0 h-full w-0.5 bg-red-500/70" style={{ left: `${inputSensitivity}%` }} />
                          )}
                        </div>
                        <span className="text-xs text-green-700 mt-1 block">
                          {micLevel > 0.05
                            ? (inputSensitivity > 0 && micLevel < inputSensitivity / 100
                              ? '○ Below threshold — gated'
                              : '● Capturing audio')
                            : '○ No audio'}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-green-800">Join a voice channel to test microphone</span>
                    )}
                  </div>
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Input Sensitivity</label>
                    <div className="flex items-center gap-3">
                      <input type="range" min={0} max={100} value={inputSensitivity}
                        onChange={e => setInputSensitivity(parseInt(e.target.value))}
                        className="flex-1 accent-green-500 h-1.5" />
                      <span className="text-xs text-green-600 w-8 text-right">{inputSensitivity}%</span>
                    </div>
                    <span className="text-[10px] text-green-800 mt-1 block">
                      {inputSensitivity === 0 ? 'No gate — all audio passes through' : 'Audio below this level will be silenced'}
                    </span>
                  </div>
                  {inputSensitivity > 0 && (
                    <div className="space-y-2 pl-2 border-l-2 border-green-900/30">
                      <div>
                        <label className="text-xs text-green-600 block mb-1">Attack Time</label>
                        <div className="flex items-center gap-3">
                          <input type="range" min={5} max={200} step={5} value={gateAttack}
                            onChange={e => setGateAttack(parseInt(e.target.value))}
                            className="flex-1 accent-green-500 h-1.5" />
                          <span className="text-xs text-green-600 w-12 text-right">{gateAttack} ms</span>
                        </div>
                        <span className="text-[10px] text-green-800 block">How fast the gate opens when you speak</span>
                      </div>
                      <div>
                        <label className="text-xs text-green-600 block mb-1">Hold Time</label>
                        <div className="flex items-center gap-3">
                          <input type="range" min={0} max={500} step={10} value={gateHold}
                            onChange={e => setGateHold(parseInt(e.target.value))}
                            className="flex-1 accent-green-500 h-1.5" />
                          <span className="text-xs text-green-600 w-12 text-right">{gateHold} ms</span>
                        </div>
                        <span className="text-[10px] text-green-800 block">How long the gate stays open after you stop</span>
                      </div>
                      <div>
                        <label className="text-xs text-green-600 block mb-1">Release Time</label>
                        <div className="flex items-center gap-3">
                          <input type="range" min={20} max={1000} step={10} value={gateRelease}
                            onChange={e => setGateRelease(parseInt(e.target.value))}
                            className="flex-1 accent-green-500 h-1.5" />
                          <span className="text-xs text-green-600 w-12 text-right">{gateRelease} ms</span>
                        </div>
                        <span className="text-[10px] text-green-800 block">How fast the gate fades to silence</span>
                      </div>
                    </div>
                  )}
                  <div className="pt-3 border-t border-green-900/20">
                    <label className="text-xs text-green-600 block mb-2">Audio Processing</label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input type="checkbox" checked={echoCancellation}
                          onChange={e => setEchoCancellation(e.target.checked)}
                          className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                        <div>
                          <span className="text-sm text-green-500">Echo Cancellation</span>
                          <span className="text-[10px] text-green-800 block">Prevents speakers from feeding back into the mic</span>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input type="checkbox" checked={noiseSuppression}
                          onChange={e => setNoiseSuppression(e.target.checked)}
                          className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                        <div>
                          <span className="text-sm text-green-500">Noise Suppression</span>
                          <span className="text-[10px] text-green-800 block">Reduces background noise (fans, typing, etc.)</span>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input type="checkbox" checked={autoGainControl}
                          onChange={e => setAutoGainControl(e.target.checked)}
                          className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                        <div>
                          <span className="text-sm text-green-500">Auto Gain Control</span>
                          <span className="text-[10px] text-green-800 block">Automatically adjusts microphone volume</span>
                        </div>
                      </label>
                    </div>
                    <span className="text-[10px] text-green-800 mt-2 block">Changes apply on next voice join or via Apply below</span>
                  </div>
                </div>
              </div>

              {/* Video Settings */}
              <div className="pt-4 border-t border-green-900/30">
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Video className="w-4 h-4" />
                  VIDEO SETTINGS
                </h3>
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Camera</label>
                    <select value={selectedVideoInput}
                      onChange={e => { setSelectedVideoInput(e.target.value); selectedVideoInputRef.current = e.target.value; }}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option value="">Default Camera</option>
                      {videoInputs.map(d => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 8)}`}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Resolution</label>
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
                    <div>Resolution: {VIDEO_RESOLUTIONS[videoResolution].width}×{VIDEO_RESOLUTIONS[videoResolution].height}</div>
                    <div>Framerate: {videoFps} fps</div>
                    <div>Codec: H.264 (VP8 fallback)</div>
                    <div>Bitrate: {(getVideoBitrate(VIDEO_RESOLUTIONS[videoResolution].width, VIDEO_RESOLUTIONS[videoResolution].height, videoFps) / 1_000_000).toFixed(1)} Mbps</div>
                    <div>Transport: TCP (reliable)</div>
                  </div>
                </div>
              </div>

              {/* Notification Sounds */}
              <div className="pt-4 border-t border-green-900/30">
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Bell className="w-4 h-4" />
                  NOTIFICATION SOUNDS
                </h3>
                <div className="space-y-3 pl-6">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={notificationSounds}
                      onChange={e => setNotificationSounds(e.target.checked)}
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                    <span className="text-sm text-green-500">Enable UI sounds</span>
                  </label>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs text-green-600">Volume</label>
                      <span className="text-xs text-green-500 font-mono">{notificationVolume}%</span>
                    </div>
                    <input type="range" min="0" max="100" step="5" value={notificationVolume}
                      onChange={e => setNotificationVolume(parseInt(e.target.value))}
                      disabled={!notificationSounds}
                      className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer accent-green-500 disabled:opacity-40" />
                  </div>
                  <div className="text-xs text-green-800 space-y-0.5">
                    <div>• Message received</div>
                    <div>• Join / leave voice</div>
                    <div>• User joins / leaves your room</div>
                    <div>• Mute / unmute / deafen</div>
                    <div>• Camera / screen share started</div>
                  </div>
                </div>
              </div>

              {/* Appearance Settings */}
              <div className="pt-4 border-t border-green-900/30">
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Monitor className="w-4 h-4" />
                  APPEARANCE
                </h3>
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Theme Color</label>
                    <select value={theme}
                      onChange={e => setTheme(e.target.value as ThemeColor)}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option value="mono">Mono (Default)</option>
                      <option value="light">Light</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>
                  {theme === 'custom' && (
                    <div className="space-y-2 pl-2 border-l-2 border-green-900/30">
                      {([
                        ['accent', 'Accent', 'Buttons, links, active states'],
                        ['bg', 'Background', 'Main content area'],
                        ['surface', 'Surface', 'Headers, input bar, modals'],
                        ['sidebar', 'Sidebar', 'Channel list, user list panels'],
                        ['border', 'Borders', 'Dividers and outlines'],
                        ['text', 'Primary Text', 'Messages, usernames, labels'],
                        ['textSecondary', 'Secondary Text', 'Timestamps, hints, muted labels'],
                      ] as [keyof CustomThemeColors, string, string][]).map(([key, label, hint]) => (
                        <div key={key} className="flex items-center gap-3">
                          <input type="color" value={customTheme[key]}
                            onInput={e => {
                              const val = (e.target as HTMLInputElement).value;
                              const hexSpan = (e.target as HTMLElement).parentElement?.querySelector('.hex-label');
                              if (hexSpan) hexSpan.textContent = val;
                              cancelAnimationFrame(colorPickerRafRef.current);
                              colorPickerRafRef.current = requestAnimationFrame(() => {
                                const el = document.documentElement;
                                if (key === 'accent') {
                                  const scale = generateScale(val);
                                  lastAccentScaleRef.current = { accent: val, scale };
                                  for (const [k, v] of Object.entries(scale)) el.style.setProperty(`--custom-green-${k}`, v);
                                  el.style.setProperty('--custom-accent-rgb', hexToRgb(val));
                                } else if (key === 'border') {
                                  el.style.setProperty('--custom-border', val);
                                  el.style.setProperty('--custom-border-rgb', hexToRgb(val));
                                } else {
                                  const varMap: Record<string, string> = { bg: '--custom-bg', surface: '--custom-surface', sidebar: '--custom-sidebar', text: '--custom-text', textSecondary: '--custom-text-secondary' };
                                  if (varMap[key]) el.style.setProperty(varMap[key], val);
                                }
                              });
                            }}
                            onChange={e => setCustomTheme(prev => ({ ...prev, [key]: e.target.value }))}
                            className="w-8 h-8 rounded cursor-pointer border border-green-900/50 bg-transparent [&::-webkit-color-swatch-wrapper]:p-0.5 [&::-webkit-color-swatch]:rounded" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <span className="text-xs text-green-600">{label}</span>
                              <span className="hex-label text-[10px] text-green-800 font-mono">{customTheme[key]}</span>
                            </div>
                            <div className="text-[10px] text-green-800/60">{hint}</div>
                          </div>
                        </div>
                      ))}
                      <button onClick={() => setCustomTheme(DEFAULT_CUSTOM_THEME)}
                        className="text-[10px] text-green-700 hover:text-green-500 transition-colors">
                        Reset to defaults
                      </button>
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Font</label>
                    <select value={fontFamily}
                      onChange={e => setFontFamily(e.target.value)}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option value="">Default (Monospace)</option>
                      <option value="ui-monospace, 'Cascadia Code', 'Fira Code', Menlo, monospace">Cascadia Code</option>
                      <option value="'JetBrains Mono', ui-monospace, monospace">JetBrains Mono</option>
                      <option value="'Fira Code', ui-monospace, monospace">Fira Code</option>
                      <option value="Consolas, ui-monospace, monospace">Consolas</option>
                      <option value="'Courier New', Courier, monospace">Courier New</option>
                      <option value="Inter, system-ui, -apple-system, sans-serif">Inter (Sans-serif)</option>
                      <option value="system-ui, -apple-system, 'Segoe UI', sans-serif">System UI (Sans-serif)</option>
                      <option value="'Segoe UI', Tahoma, Geneva, sans-serif">Segoe UI</option>
                      <option value="Arial, Helvetica, sans-serif">Arial</option>
                      <option value="Verdana, Geneva, sans-serif">Verdana</option>
                      <option value="Georgia, 'Times New Roman', serif">Georgia (Serif)</option>
                    </select>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs text-green-600">UI Scale</label>
                      <span className="text-xs text-green-500 font-mono">{uiScale}%</span>
                    </div>
                    <input type="range" min="50" max="150" step="5" value={uiScale}
                      onChange={e => setUiScale(parseInt(e.target.value))}
                      className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer accent-green-500" />
                    <div className="relative text-[10px] text-green-800 mt-1 h-4">
                      <span className="absolute left-0">50%</span>
                      <span className="absolute" style={{ left: '50%', transform: 'translateX(-50%)' }}>100%</span>
                      <span className="absolute right-0">150%</span>
                    </div>
                  </div>
                    </div>
                  </div>

              {/* Keybind Settings */}
              <div className="pt-4 border-t border-green-900/30">
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Command className="w-4 h-4" />
                  KEYBINDS
                </h3>
                <div className="space-y-3 pl-6">
                  {/* Push-to-Talk mode toggle */}
                  <div className="pb-3 border-b border-green-900/20">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input type="checkbox" checked={pushToTalkMode} onChange={e => setPushToTalkMode(e.target.checked)}
                        className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50" />
                      <div>
                        <span className="text-sm text-green-500">Push to Talk</span>
                        <span className="text-[10px] text-green-800 block">Hold key to transmit. VAD gate is disabled in this mode.</span>
                      </div>
                    </label>
                  </div>
                  {(['toggleMute', 'toggleDeafen', 'pushToTalk'] as const).map(action => {
                    const labels: Record<string, string> = { toggleMute: 'Mute / Unmute', toggleDeafen: 'Deafen / Undeafen', pushToTalk: 'Push to Talk' };
                    const bind = keybinds[action];
                    const isRecording = recordingKeybind === action;
                    const disabled = action === 'pushToTalk' && !pushToTalkMode;
                    return (
                      <div key={action} className={`flex items-center justify-between ${disabled ? 'opacity-40' : ''}`}>
                        <span className="text-sm text-green-500">{labels[action]}</span>
                        <div className="flex items-center gap-2">
                          <button
                            disabled={disabled}
                            onClick={() => !disabled && setRecordingKeybind(isRecording ? null : action)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all min-w-[120px] text-center ${
                              isRecording
                                ? 'bg-green-900/40 border-2 border-green-500 text-green-400 animate-pulse'
                                : bind
                                  ? 'bg-[#0a0e0a] border border-green-900/50 text-green-500 hover:border-green-700'
                                  : 'bg-[#0a0e0a] border border-green-900/50 text-green-800 hover:border-green-700'
                            }`}>
                            {isRecording ? 'Press a key...' : bind ? formatKeyBind(bind) : 'Not set'}
                          </button>
                          {bind && !isRecording && !disabled && (
                            <button onClick={() => setKeybinds(prev => ({ ...prev, [action]: null }))}
                              className="p-1 text-green-800 hover:text-red-400 transition-colors">
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-[10px] text-green-800 pt-2">Click the field and press the desired key. Press Escape to cancel.</p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-green-900/30 bg-[#0d120d]/40 flex items-center gap-3">
              <button onClick={() => { window.electronAPI.checkForUpdates(); }}
                className="px-4 py-2 rounded-lg bg-green-900/20 text-green-700 hover:bg-green-900/40 hover:text-green-400 transition-all text-xs flex items-center gap-1.5">
                <Download className="w-3.5 h-3.5" />
                Check for Updates
              </button>
              <div className="flex-1" />
              <button onClick={() => { setShowSettings(false); setRecordingKeybind(null); }}
                className="px-6 py-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all">
                Cancel
              </button>
              <button onClick={() => { if (currentVoiceRoom) restartAudio(); setShowSettings(false); setRecordingKeybind(null); }}
                className="px-6 py-2 rounded-lg bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-all font-bold">
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Server Settings Modal (admin only) ─────────────────── */}
      {showServerSettings && serverInfo && (() => {
        const ALL_PERMS = ['admin', 'manage_roles', 'create_rooms', 'delete_rooms', 'reorder_rooms', 'kick_users', 'delete_messages', 'pin_messages', 'manage_soundboard', 'manage_emojis', 'server_settings'];
        const PERM_LABELS: Record<string, string> = {
          admin: 'Administrator — full access to everything',
          manage_roles: 'Manage Roles — create, delete, assign roles',
          create_rooms: 'Create Rooms — create voice/text channels',
          delete_rooms: 'Delete Rooms — delete voice/text channels',
          reorder_rooms: 'Reorder Rooms — reorder channels',
          kick_users: 'Kick Users — remove users from the server',
          delete_messages: 'Delete Messages — delete any user\'s messages',
          pin_messages: 'Pin Messages — pin/unpin messages in text channels',
          manage_soundboard: 'Manage Soundboard — upload/delete sounds',
          manage_emojis: 'Manage Emojis — upload/delete custom emojis',
          server_settings: 'Server Settings — update server configuration',
        };
        const NumberField = ({ label, value, field, unit, min, max }: { label: string; value: number; field: string; unit?: string; min?: number; max?: number }) => (
          <div>
            <label className="text-xs text-green-600 block mb-1">{label}</label>
            <div className="flex items-center gap-2">
              <input type="number" defaultValue={value} min={min} max={max}
                id={`srv-${field}`}
                className="flex-1 bg-[#0a0e0a] border border-green-900/50 rounded-lg px-3 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all text-sm" />
              {unit && <span className="text-xs text-green-800 shrink-0">{unit}</span>}
            </div>
          </div>
        );
        const saveServerConfig = () => {
          const getNum = (field: string, fallback: number) => {
            const el = document.getElementById(`srv-${field}`) as HTMLInputElement;
            const v = parseInt(el?.value);
            return isNaN(v) ? fallback : v;
          };
          const getStr = (field: string, fallback: string) => {
            const el = document.getElementById(`srv-${field}`) as HTMLInputElement;
            return el?.value?.trim() || fallback;
          };
          const config: Record<string, any> = {
            ServerName: getStr('ServerName', serverInfo.serverName),
            MaxCameraWidth: getNum('MaxCameraWidth', serverInfo.maxCameraWidth),
            MaxCameraHeight: getNum('MaxCameraHeight', serverInfo.maxCameraHeight),
            MaxScreenWidth: getNum('MaxScreenWidth', serverInfo.maxScreenWidth),
            MaxScreenHeight: getNum('MaxScreenHeight', serverInfo.maxScreenHeight),
            MaxFps: getNum('MaxFps', serverInfo.maxFps),
            MaxScreenBitrate: getNum('MaxScreenBitrate', Math.round(serverInfo.maxScreenBitrate / 1000)),
            DefaultBitrate: getNum('DefaultBitrate', serverInfo.defaultBitrate),
            MaxFileSizeKB: getNum('MaxFileSizeKB', serverInfo.maxFileSizeKB),
            MaxSoundSizeKB: getNum('MaxSoundSizeKB', serverInfo.maxSoundSizeKB),
          };
          sendToServer(`CMD:UPDATE_SERVER_CONFIG:${JSON.stringify(config)}`);
          setShowServerSettings(false);
        };
        const allTabs: { id: typeof serverSettingsTab; label: string; icon: React.ReactNode; perm?: string }[] = [
          { id: 'general', label: 'General', icon: <Sliders className="w-4 h-4" />, perm: 'server_settings' },
          { id: 'roles', label: 'Roles', icon: <Users className="w-4 h-4" />, perm: 'manage_roles' },
          { id: 'soundboard', label: 'Soundboard', icon: <Music className="w-4 h-4" />, perm: 'manage_soundboard' },
          { id: 'emojis', label: 'Emojis', icon: <Smile className="w-4 h-4" />, perm: 'manage_emojis' },
        ];
        const tabs = allTabs.filter(t => !t.perm || hasPermission(t.perm));
        return (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onMouseDown={() => setShowServerSettings(false)}>
            <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-3xl max-h-[90vh] flex flex-col"
              onMouseDown={e => e.stopPropagation()}>
              {/* Header */}
              <div className="bg-green-900/40 p-6 border-b border-green-900/50 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <Shield className="w-6 h-6 text-green-500" />
                  <h2 className="text-xl font-bold text-green-400">SERVER SETTINGS</h2>
                </div>
                <button onClick={() => setShowServerSettings(false)}
                  className="p-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Tabs */}
              <div className="flex border-b border-green-900/50 shrink-0">
                {tabs.map(t => (
                  <button key={t.id} onClick={() => setServerSettingsTab(t.id)}
                    className={`flex items-center gap-2 px-6 py-3 text-sm transition-all border-b-2 ${
                      serverSettingsTab === t.id
                        ? 'border-green-500 text-green-400 bg-green-900/20'
                        : 'border-transparent text-green-700 hover:text-green-500 hover:bg-green-900/10'
                    }`}>
                    {t.icon}
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div className="flex-1 overflow-y-auto p-6">
                {serverSettingsTab === 'general' && (
                  <div className="space-y-6">
                    {/* General */}
                    <div>
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <Terminal className="w-4 h-4" />
                        GENERAL
                      </h3>
                      <div className="space-y-3 pl-6">
                        <div>
                          <label className="text-xs text-green-600 block mb-1">Server Name</label>
                          <input type="text" defaultValue={serverInfo.serverName} id="srv-ServerName"
                            className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-3 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all text-sm" />
                        </div>
                        <div>
                          <label className="text-xs text-green-600 block mb-1">Server Logo</label>
                          <div className="flex items-center gap-4">
                            <div className="w-14 h-14 rounded-xl flex items-center justify-center overflow-hidden border border-green-900/50 shrink-0"
                              style={{ backgroundColor: serverInfo.serverLogo ? 'transparent' : getServerColor(serverInfo.serverName) }}>
                              {serverInfo.serverLogo ? (
                                <img src={serverInfo.serverLogo} alt="Logo" className="w-full h-full object-cover" />
                              ) : (
                                <span className="text-white font-bold text-lg">{serverInfo.serverName.charAt(0).toUpperCase()}</span>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <button onClick={openLogoPicker}
                                className="px-3 py-1.5 bg-green-900/40 hover:bg-green-900/60 text-green-400 rounded-lg text-xs cursor-pointer transition-all font-bold text-center">
                                Upload Logo
                              </button>
                              {serverInfo.serverLogo && (
                                <button onClick={() => sendToServer(`CMD:UPDATE_SERVER_CONFIG:${JSON.stringify({ ServerLogo: '' })}`)}
                                  className="px-3 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-400 rounded-lg text-xs transition-all font-bold">
                                  Remove
                                </button>
                              )}
                            </div>
                          </div>
                          <span className="text-[10px] text-green-800 mt-1 block">Max 64 KB. Shown in the server list.</span>
                        </div>
                      </div>
                    </div>

                    {/* Camera Limits */}
                    <div className="pt-4 border-t border-green-900/30">
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <Video className="w-4 h-4" />
                        CAMERA LIMITS
                      </h3>
                      <div className="grid grid-cols-2 gap-3 pl-6">
                        <NumberField label="Max Width" value={serverInfo.maxCameraWidth} field="MaxCameraWidth" unit="px" min={320} max={3840} />
                        <NumberField label="Max Height" value={serverInfo.maxCameraHeight} field="MaxCameraHeight" unit="px" min={240} max={2160} />
                      </div>
                    </div>

                    {/* Screen Share Limits */}
                    <div className="pt-4 border-t border-green-900/30">
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <Monitor className="w-4 h-4" />
                        SCREEN SHARE LIMITS
                      </h3>
                      <div className="grid grid-cols-2 gap-3 pl-6">
                        <NumberField label="Max Width" value={serverInfo.maxScreenWidth} field="MaxScreenWidth" unit="px" min={320} max={3840} />
                        <NumberField label="Max Height" value={serverInfo.maxScreenHeight} field="MaxScreenHeight" unit="px" min={240} max={2160} />
                        <NumberField label="Max Bitrate" value={Math.round(serverInfo.maxScreenBitrate / 1000)} field="MaxScreenBitrate" unit="kbps" min={500} max={50000} />
                      </div>
                    </div>

                    {/* Video & Audio */}
                    <div className="pt-4 border-t border-green-900/30">
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <Sliders className="w-4 h-4" />
                        VIDEO & AUDIO
                      </h3>
                      <div className="grid grid-cols-2 gap-3 pl-6">
                        <NumberField label="Max FPS" value={serverInfo.maxFps} field="MaxFps" unit="fps" min={1} max={120} />
                        <NumberField label="Default Voice Bitrate" value={serverInfo.defaultBitrate} field="DefaultBitrate" unit="bps" min={8000} max={512000} />
                      </div>
                    </div>

                    {/* File Limits */}
                    <div className="pt-4 border-t border-green-900/30">
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <FileText className="w-4 h-4" />
                        FILE LIMITS
                      </h3>
                      <div className="grid grid-cols-2 gap-3 pl-6">
                        <NumberField label="Max File Size" value={serverInfo.maxFileSizeKB} field="MaxFileSizeKB" unit="KB" min={64} max={102400} />
                        <NumberField label="Max Sound Size" value={serverInfo.maxSoundSizeKB} field="MaxSoundSizeKB" unit="KB" min={64} max={10240} />
                      </div>
                    </div>

                    <p className="text-[10px] text-green-800 pt-2">Changes are applied immediately and persisted to <code className="text-green-700">server-config.json</code>.</p>

                    <div className="flex justify-end pt-2">
                      <button onClick={saveServerConfig}
                        className="px-6 py-2 rounded-lg bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-all font-bold">
                        Save & Apply
                      </button>
                    </div>

                    {/* Danger Zone */}
                    {hasPermission('admin') && (
                      <div className="pt-6 mt-6 border-t-2 border-red-900/40">
                        <h3 className="text-sm text-red-500 mb-4 flex items-center gap-2">
                          <Trash2 className="w-4 h-4" />
                          DANGER ZONE
                        </h3>
                        <div className="bg-red-900/10 border border-red-900/30 rounded-lg p-4">
                          <p className="text-xs text-red-400 mb-1 font-bold">Wipe Server</p>
                          <p className="text-[10px] text-red-500/70 mb-3">Permanently deletes ALL chat history, avatars, soundboard sounds, custom emojis, and custom roles. Rooms are reset to defaults. All users are kicked. This action cannot be undone.</p>
                          <button onClick={() => { setWipeServerDialog(true); setWipeConfirmName(''); setWipeConfirmCheck(false); }}
                            className="px-4 py-2 rounded-lg bg-red-900/30 border border-red-800/50 text-red-400 hover:bg-red-900/50 hover:border-red-700/50 transition-all text-xs font-bold">
                            Wipe Server…
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {serverSettingsTab === 'roles' && (
                  <div className="space-y-6">
                    {/* Role Hierarchy */}
                    <div>
                      <h3 className="text-sm text-green-700 mb-1 flex items-center gap-2">
                        <Shield className="w-4 h-4" />
                        ROLE HIERARCHY
                      </h3>
                      <p className="text-[10px] text-green-800 mb-4">Top = highest. Use arrows to reorder custom roles.</p>
                      <div className="space-y-2">
                        {serverRoles.map((role, idx) => {
                          const isAdmin = role.name === 'Admin';
                          const isMember = role.name === 'Member';
                          const isProtected = isAdmin || isMember;
                          const isCustom = !isProtected;
                          const canMoveUp = isCustom && idx > 1;
                          const canMoveDown = isCustom && idx < serverRoles.length - 2;
                          const isEditing = editingRole === role.name;

                          const reorder = (fromIdx: number, toIdx: number) => {
                            const next = [...serverRoles];
                            [next[fromIdx], next[toIdx]] = [next[toIdx], next[fromIdx]];
                            sendToServer(`CMD:REORDER_ROLES:${next.map(r => r.name).join(',')}`);
                          };

                          if (isEditing) {
                            return (
                              <div key={role.name} className="bg-[#0a0e0a] border border-green-700/50 rounded-lg p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs text-green-600 font-bold uppercase">Editing — {role.name}</span>
                                  <button onClick={() => setEditingRole(null)} className="p-1 text-green-700 hover:text-green-400 transition-colors">
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                {!isProtected && (
                                  <div>
                                    <label className="text-xs text-green-600 block mb-1">Name</label>
                                    <input type="text" value={editRoleName} onChange={e => setEditRoleName(e.target.value)}
                                      className="w-full bg-[#0d120d] border border-green-900/50 rounded-lg px-3 py-2 text-green-500 outline-none focus:border-green-700 text-sm" />
                                  </div>
                                )}
                                <div>
                                  <label className="text-xs text-green-600 block mb-1">Color</label>
                                  <div className="flex items-center gap-2">
                                    <input type="color" value={editRoleColor} onChange={e => setEditRoleColor(e.target.value)}
                                      className="w-10 h-10 rounded-lg border border-green-900/50 bg-transparent cursor-pointer" />
                                    <input type="text" value={editRoleColor}
                                      onChange={e => { if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) setEditRoleColor(e.target.value); }}
                                      className="flex-1 bg-[#0d120d] border border-green-900/50 rounded-lg px-3 py-2 text-green-500 outline-none focus:border-green-700 text-sm font-mono" />
                                  </div>
                                </div>
                                {!isAdmin && (
                                  <div>
                                    <label className="text-xs text-green-600 block mb-2">Permissions</label>
                                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                                      {ALL_PERMS.map(p => (
                                        <label key={p} className="flex items-start gap-3 cursor-pointer group/perm">
                                          <input type="checkbox" checked={editRolePerms.includes(p)}
                                            onChange={e => setEditRolePerms(prev => e.target.checked ? [...prev, p] : prev.filter(x => x !== p))}
                                            className="w-4 h-4 mt-0.5 shrink-0" />
                                          <div>
                                            <span className="text-sm text-green-500 group-hover/perm:text-green-400 transition-colors">{p}</span>
                                            <span className="text-[10px] text-green-800 block">{PERM_LABELS[p]}</span>
                                          </div>
                                        </label>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                <div className="flex gap-2 pt-1">
                                  <button onClick={() => {
                                      sendToServer(`CMD:EDIT_ROLE:${role.name}:${editRoleName || role.name}:${editRoleColor}:${editRolePerms.join(',')}`);
                                      setEditingRole(null);
                                    }}
                                    className="flex-1 py-2 rounded-lg bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-all font-bold text-sm flex items-center justify-center gap-2">
                                    <Check className="w-4 h-4" /> Save
                                  </button>
                                  <button onClick={() => setEditingRole(null)}
                                    className="px-4 py-2 rounded-lg text-green-700 hover:text-green-500 transition-colors text-sm">
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            );
                          }

                          return (
                            <div key={role.name} className="bg-[#0a0e0a] border border-green-900/40 rounded-lg px-4 py-3 flex items-center gap-3">
                              {/* Reorder arrows */}
                              <div className="flex flex-col gap-0.5 shrink-0">
                                <button disabled={!canMoveUp} onClick={() => reorder(idx, idx - 1)}
                                  className="p-0.5 text-green-800 hover:text-green-500 disabled:opacity-20 disabled:cursor-default transition-colors">
                                  <ChevronUp className="w-3 h-3" />
                                </button>
                                <button disabled={!canMoveDown} onClick={() => reorder(idx, idx + 1)}
                                  className="p-0.5 text-green-800 hover:text-green-500 disabled:opacity-20 disabled:cursor-default transition-colors">
                                  <ChevronDown className="w-3 h-3" />
                                </button>
                              </div>
                              {/* Color dot + name */}
                              <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: role.color }} />
                              <span className="text-sm font-bold flex-1" style={{ color: role.color }}>{role.name}</span>
                              {/* Permissions preview */}
                              <div className="hidden sm:flex flex-wrap gap-1 max-w-[240px]">
                                {role.permissions.length > 0 ? role.permissions.map(p => (
                                  <span key={p} className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-900/30 text-green-600">{p}</span>
                                )) : (
                                  <span className="text-[10px] text-green-800">No permissions</span>
                                )}
                              </div>
                              {/* Actions */}
                              <div className="flex items-center gap-1 ml-auto shrink-0">
                                <button onClick={() => { setEditingRole(role.name); setEditRoleName(role.name); setEditRoleColor(role.color); setEditRolePerms([...role.permissions]); }}
                                  className="p-1.5 rounded text-green-700 hover:text-green-400 hover:bg-green-900/20 transition-all" title="Edit role">
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                {!isProtected && (
                                  <button onClick={() => { if (confirm(`Delete role "${role.name}"? Users with this role will lose it.`)) sendToServer(`CMD:DELETE_ROLE:${role.name}`); }}
                                    className="p-1.5 rounded text-green-800 hover:text-red-400 hover:bg-red-900/20 transition-all" title="Delete role">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Create New Role */}
                    <div className="pt-4 border-t border-green-900/30">
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <Plus className="w-4 h-4" />
                        CREATE ROLE
                      </h3>
                      <div className="bg-[#0a0e0a] border border-green-900/40 rounded-lg p-4 space-y-4">
                        <div>
                          <label className="text-xs text-green-600 block mb-1">Name</label>
                          <input type="text" id="new-role-name" placeholder="e.g. Moderator"
                            className="w-full bg-[#0d120d] border border-green-900/50 rounded-lg px-3 py-2 text-green-500 outline-none focus:border-green-700 text-sm" />
                        </div>
                        <div>
                          <label className="text-xs text-green-600 block mb-1">Color</label>
                          <div className="flex items-center gap-2">
                            <input type="color" id="new-role-color" defaultValue="#22c55e"
                              className="w-10 h-10 rounded-lg border border-green-900/50 bg-transparent cursor-pointer" />
                            <input type="text" id="new-role-color-hex" defaultValue="#22c55e"
                              onChange={e => { const el = document.getElementById('new-role-color') as HTMLInputElement; if (el && /^#[0-9a-fA-F]{6}$/.test(e.target.value)) el.value = e.target.value; }}
                              className="flex-1 bg-[#0d120d] border border-green-900/50 rounded-lg px-3 py-2 text-green-500 outline-none focus:border-green-700 text-sm font-mono" />
                          </div>
                        </div>
                        <div>
                          <label className="text-xs text-green-600 block mb-2">Permissions</label>
                          <div className="space-y-2">
                            {ALL_PERMS.map(p => (
                              <label key={p} className="flex items-start gap-3 cursor-pointer group/perm">
                                <input type="checkbox" id={`new-role-perm-${p}`}
                                  className="w-4 h-4 mt-0.5 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50 shrink-0" />
                                <div>
                                  <span className="text-sm text-green-500 group-hover/perm:text-green-400 transition-colors">{p}</span>
                                  <span className="text-[10px] text-green-800 block">{PERM_LABELS[p]}</span>
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>
                        <button onClick={() => {
                            const name = (document.getElementById('new-role-name') as HTMLInputElement)?.value?.trim();
                            const color = (document.getElementById('new-role-color') as HTMLInputElement)?.value || '#22c55e';
                            const perms = ALL_PERMS.filter(p => (document.getElementById(`new-role-perm-${p}`) as HTMLInputElement)?.checked);
                            if (!name) return;
                            sendToServer(`CMD:CREATE_ROLE:${name}:${color}:0:${perms.join(',')}`);
                            (document.getElementById('new-role-name') as HTMLInputElement).value = '';
                            ALL_PERMS.forEach(p => { const el = document.getElementById(`new-role-perm-${p}`) as HTMLInputElement; if (el) el.checked = false; });
                          }}
                          className="w-full py-2 rounded-lg bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-all font-bold text-sm">
                          Create Role
                        </button>
                      </div>
                    </div>

                    {/* Assign Roles to Users */}
                    <div className="pt-4 border-t border-green-900/30">
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <UserPlus className="w-4 h-4" />
                        ASSIGN ROLES
                      </h3>
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {onlineUsers.filter(u => u.online).map(u => (
                          <div key={u.name} className="bg-[#0a0e0a] border border-green-900/40 rounded-lg px-4 py-3 flex items-center gap-3">
                            <UserAvatar name={u.name} size="sm" />
                            <span className="text-sm text-green-500 font-bold min-w-[80px]" style={{ color: u.roleColor || undefined }}>{u.name}</span>
                            <div className="flex flex-wrap gap-1 flex-1">
                              {serverRoles.map(role => {
                                const has = u.roles.some(r => r.toLowerCase() === role.name.toLowerCase());
                                const isProtected = role.name === 'Member';
                                return (
                                  <button key={role.name}
                                    disabled={isProtected}
                                    onClick={() => {
                                      if (has) sendToServer(`CMD:REMOVE_ROLE:${u.name}:${role.name}`);
                                      else sendToServer(`CMD:ASSIGN_ROLE:${u.name}:${role.name}`);
                                    }}
                                    className={`text-[10px] px-2 py-0.5 rounded-full transition-all ${
                                      isProtected
                                        ? 'bg-green-900/20 text-green-800 cursor-default'
                                        : has
                                          ? 'text-white hover:opacity-80'
                                          : 'bg-green-900/20 text-green-700 hover:bg-green-900/40 hover:text-green-500'
                                    }`}
                                    style={has && !isProtected ? { backgroundColor: role.color + '40', color: role.color } : undefined}
                                    title={has ? `Remove ${role.name}` : `Assign ${role.name}`}>
                                    {has ? <span>✓ {role.name}</span> : role.name}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {serverSettingsTab === 'soundboard' && (
                  <div className="space-y-6">
                    {/* Existing Sounds */}
                    <div>
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <Music className="w-4 h-4" />
                        SOUNDS ({soundboardSounds.length})
                      </h3>
                      {soundboardSounds.length > 0 ? (
                        <div className="space-y-2">
                          {soundboardSounds.map(name => (
                            <div key={name} className="bg-[#0a0e0a] border border-green-900/40 rounded-lg px-4 py-3 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <Music className="w-4 h-4 text-green-600" />
                                <span className="text-sm text-green-500">{name}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <button onClick={() => sendToVoice(`CMD:PLAY_SOUND:${name}`)}
                                  className="p-1.5 rounded text-green-700 hover:text-green-400 hover:bg-green-900/30 transition-all" title="Preview">
                                  <Play className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => { if (confirm(`Delete sound "${name}"?`)) sendToServer(`CMD:DELETE_SOUND:${name}`); }}
                                  className="p-1.5 rounded text-green-800 hover:text-red-400 hover:bg-red-900/20 transition-all" title="Delete">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-center py-8 text-green-800 text-sm">No sounds uploaded yet</div>
                      )}
                    </div>

                    {/* Upload Sound */}
                    <div className="pt-4 border-t border-green-900/30">
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <Upload className="w-4 h-4" />
                        UPLOAD SOUND
                      </h3>
                      <div className="bg-[#0a0e0a] border border-green-900/40 rounded-lg p-4 space-y-3">
                        <div>
                          <label className="text-xs text-green-600 block mb-1">Sound Name</label>
                          <input type="text" id="srv-sound-name" placeholder="e.g. airhorn"
                            className="w-full bg-[#0d120d] border border-green-900/50 rounded-lg px-3 py-2 text-green-500 outline-none focus:border-green-700 text-sm" />
                        </div>
                        <div>
                          <label className="text-xs text-green-600 block mb-1">Audio File</label>
                          <input type="file" id="srv-sound-file" accept="audio/*"
                            className="w-full text-sm text-green-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-green-900/30 file:text-green-400 file:font-bold file:cursor-pointer hover:file:bg-green-900/50 transition-all" />
                          <span className="text-[10px] text-green-800 mt-1 block">Max {serverInfo.maxSoundSizeKB} KB</span>
                        </div>
                        <button onClick={() => {
                            const name = (document.getElementById('srv-sound-name') as HTMLInputElement)?.value?.trim();
                            const fileInput = document.getElementById('srv-sound-file') as HTMLInputElement;
                            const file = fileInput?.files?.[0];
                            if (!name || !file) return;
                            const reader = new FileReader();
                            reader.onload = () => {
                              const b64 = (reader.result as string).split(',')[1];
                              if (!b64) return;
                              sendToServer(`CMD:UPLOAD_SOUND:${name}:${b64}`);
                              (document.getElementById('srv-sound-name') as HTMLInputElement).value = '';
                              fileInput.value = '';
                            };
                            reader.readAsDataURL(file);
                          }}
                          className="w-full py-2 rounded-lg bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-all font-bold text-sm">
                          Upload Sound
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {serverSettingsTab === 'emojis' && (
                  <div className="space-y-6">
                    {/* Existing Custom Emojis */}
                    <div>
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <Smile className="w-4 h-4" />
                        CUSTOM EMOJIS ({Object.keys(customEmojis).length})
                      </h3>
                      {Object.keys(customEmojis).length > 0 ? (
                        <div className="space-y-2">
                          {Object.entries(customEmojis).map(([name, data]) => (
                            <div key={name} className="bg-[#0a0e0a] border border-green-900/40 rounded-lg px-4 py-3 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <img src={`data:image/png;base64,${data}`} className="w-8 h-8 object-contain" alt={name} />
                                <span className="text-sm text-green-500">:{name}:</span>
                              </div>
                              <button onClick={() => { if (confirm(`Delete emoji ":${name}:"?`)) sendToServer(`CMD:DELETE_EMOJI:${name}`); }}
                                className="p-1.5 rounded text-green-800 hover:text-red-400 hover:bg-red-900/20 transition-all" title="Delete">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-center py-8 text-green-800 text-sm">No custom emojis yet</div>
                      )}
                    </div>

                    {/* Upload Emoji */}
                    <div className="pt-4 border-t border-green-900/30">
                      <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                        <Upload className="w-4 h-4" />
                        UPLOAD EMOJI
                      </h3>
                      <div className="bg-[#0a0e0a] border border-green-900/40 rounded-lg p-4 space-y-3">
                        <div>
                          <label className="text-xs text-green-600 block mb-1">Emoji Name</label>
                          <input type="text" id="srv-emoji-name" placeholder="e.g. pepe"
                            className="w-full bg-[#0d120d] border border-green-900/50 rounded-lg px-3 py-2 text-green-500 outline-none focus:border-green-700 text-sm" />
                          <span className="text-[10px] text-green-800 mt-1 block">Use in chat as :name:</span>
                        </div>
                        <button onClick={openEmojiPicker}
                          className="w-full py-2 rounded-lg bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-all font-bold text-sm flex items-center justify-center gap-2">
                          <Upload className="w-4 h-4" />
                          Choose Image
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Room Context Menu ── */}
      {roomContextMenu && (
        <div className="fixed bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-2 min-w-[160px] z-50"
          style={{ left: Math.min(roomContextMenu.x, window.innerWidth - 180), top: Math.min(roomContextMenu.y, window.innerHeight - 120) }}
          onClick={e => e.stopPropagation()}>
          <div className="px-3 py-1.5 mb-1 text-[10px] text-green-700 uppercase tracking-wider truncate">{roomContextMenu.name}</div>
          {hasPermission('create_rooms') && (
            <button
              onClick={() => {
                if (roomContextMenu.type === 'text') {
                  setCreateRoomDialog({ type: 'text', editing: roomContextMenu.name }); setNewRoomName(roomContextMenu.name); setNewRoomRoles(textRooms.find(t => t.name === roomContextMenu.name)?.allowedRoles ?? []);
                } else {
                  const r = voiceRooms[roomContextMenu.idx];
                  setCreateRoomDialog({ type: 'voice', editing: roomContextMenu.name }); setNewRoomName(roomContextMenu.name); setNewRoomRoles(r?.allowedRoles ?? []); setNewRoomBitrate(String(r?.bitrate ?? 96000));
                }
                setRoomContextMenu(null);
              }}
              className="w-full px-3 py-2 rounded-lg text-green-400 hover:bg-green-900/30 transition-all flex items-center gap-2 text-sm">
              <Pencil className="w-4 h-4" />
              <span>Edit channel</span>
            </button>
          )}
          {hasPermission('delete_rooms') && (
            <button
              onClick={() => {
                const cmd = roomContextMenu.type === 'text' ? `CMD:DELETE_TEXT_ROOM:${roomContextMenu.name}` : `CMD:DELETE_VOICE_ROOM:${roomContextMenu.name}`;
                if (confirm(`Delete ${roomContextMenu.type} channel "${roomContextMenu.name}"?`)) sendToServer(cmd);
                setRoomContextMenu(null);
              }}
              className="w-full px-3 py-2 rounded-lg text-red-400 hover:bg-red-900/40 transition-all flex items-center gap-2 text-sm">
              <Trash2 className="w-4 h-4" />
              <span>Delete channel</span>
            </button>
          )}
          {roomContextMenu.type === 'text' && connectedServerId && (() => {
            const levels = ['default', 'all', 'mentions', 'none'] as const;
            const icons: Record<string, React.ReactNode> = {
              default: <Bell className="w-3 h-3" />,
              all: <Bell className="w-3 h-3 text-green-400" />,
              mentions: <Bell className="w-3 h-3 text-yellow-500" />,
              none: <BellOff className="w-3 h-3 text-red-500" />,
            };
            const labels: Record<string, string> = { default: 'Default', all: 'All', mentions: 'Mentions only', none: 'Muted' };
            const current = (notifPrefs[connectedServerId]?.[roomContextMenu.name] ?? 'default') as typeof levels[number];
            return (
              <div className="border-t border-green-900/30 mt-1 pt-1 px-1 pb-1 group/notif">
                <div className="w-full px-3 py-2 rounded-lg text-green-700 hover:bg-green-900/20 hover:text-green-500 transition-all flex items-center gap-2 text-sm cursor-default select-none">
                  {icons[current]}
                  <span className="flex-1">Notifications: <span className="text-green-500">{labels[current]}</span></span>
                  <ChevronRight className="w-3 h-3 opacity-40" />
                </div>
                <div className="hidden group-hover/notif:flex flex-col gap-0.5 pl-2 pb-1">
                  {levels.map(level => {
                    const active = current === level;
                    return (
                      <button key={level}
                        onClick={() => { setChannelNotifLevel(connectedServerId, roomContextMenu.name, level); setRoomContextMenu(null); }}
                        className={`w-full px-3 py-1.5 rounded-lg flex items-center gap-2 text-sm transition-all ${
                          active ? 'bg-green-900/40 text-green-300 font-semibold' : 'text-green-700 hover:bg-green-900/20 hover:text-green-500'
                        }`}>
                        {icons[level]}
                        <span>{labels[level]}</span>
                        {active && <Check className="w-3 h-3 ml-auto" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
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
                <button
                  onClick={(e) => { e.stopPropagation(); openInlineDm(userContextMenu.userId, connectedServerId || ''); setUserContextMenu(null); }}
                  className="w-full px-4 py-2.5 rounded-lg bg-green-900/20 text-green-500 hover:bg-green-900/40 transition-all flex items-center gap-2 mb-2">
                  <Send className="w-4 h-4" />
                  <span className="text-sm">Direct Message</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const sid = connectedServerId || '';
                    if (isFriend(userContextMenu.userId, sid)) removeFriend(userContextMenu.userId, sid);
                    else addFriend(userContextMenu.userId, sid);
                  }}
                  className={`w-full px-4 py-2.5 rounded-lg transition-all flex items-center gap-2 mb-2 ${
                    isFriend(userContextMenu.userId, connectedServerId || '')
                      ? 'bg-red-900/20 text-red-400 hover:bg-red-900/40'
                      : 'bg-green-900/20 text-green-500 hover:bg-green-900/40'
                  }`}>
                  <UserPlus className="w-4 h-4" />
                  <span className="text-sm">{isFriend(userContextMenu.userId, connectedServerId || '') ? 'Remove Friend' : 'Add Friend'}</span>
                </button>
                <div className="mb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Volume2 className="w-4 h-4 text-green-500" />
                    <span className="text-xs text-green-600">Volume</span>
                    <span className="ml-auto text-xs text-green-500">{setting.volume}%</span>
                  </div>
                  <input type="range" min="0" max="200" value={setting.volume}
                    onClick={e => e.stopPropagation()}
                    onChange={(e) => updateUserSetting(userContextMenu.userId, { volume: parseInt(e.target.value) })}
                    className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer accent-green-500" />
                  <div className="flex justify-between text-[10px] text-green-800 mt-1">
                    <span>0%</span>
                    <span className={setting.volume > 100 ? 'text-yellow-600' : ''}>100%</span>
                    <span className={setting.volume > 100 ? 'text-red-600' : ''}>200%</span>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); updateUserSetting(userContextMenu.userId, { isMuted: !setting.isMuted }); }}
                  className={`w-full px-4 py-2.5 rounded-lg transition-all flex items-center gap-2 mb-2 ${
                    setting.isMuted ? 'bg-red-900/40 text-red-400 hover:bg-red-900/60' : 'bg-green-900/20 text-green-500 hover:bg-green-900/40'
                  }`}>
                  {setting.isMuted ? <><MicOff className="w-4 h-4" /><span className="text-sm">Unmute User</span></> : <><Mic className="w-4 h-4" /><span className="text-sm">Mute User</span></>}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); updateUserSetting(userContextMenu.userId, { soundboardMuted: !setting.soundboardMuted }); }}
                  className={`w-full px-4 py-2.5 rounded-lg transition-all flex items-center gap-2 mb-2 ${
                    setting.soundboardMuted ? 'bg-red-900/40 text-red-400 hover:bg-red-900/60' : 'bg-green-900/20 text-green-500 hover:bg-green-900/40'
                  }`}>
                  {setting.soundboardMuted ? <><VolumeX className="w-4 h-4" /><span className="text-sm">Unmute Soundboard</span></> : <><Music className="w-4 h-4" /><span className="text-sm">Mute Soundboard</span></>}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); updateUserSetting(userContextMenu.userId, { screenMuted: !setting.screenMuted }); }}
                  className={`w-full px-4 py-2.5 rounded-lg transition-all flex items-center gap-2 mb-2 ${
                    setting.screenMuted ? 'bg-red-900/40 text-red-400 hover:bg-red-900/60' : 'bg-green-900/20 text-green-500 hover:bg-green-900/40'
                  }`}>
                  {setting.screenMuted ? <><EyeOff className="w-4 h-4" /><span className="text-sm">Unmute Screenshare</span></> : <><Eye className="w-4 h-4" /><span className="text-sm">Mute Screenshare</span></>}
                </button>
                <div className="mb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Volume2 className="w-4 h-4 text-green-500" />
                    <span className="text-xs text-green-600">Stream Audio</span>
                    <span className="ml-auto text-xs text-green-500">{setting.screenVolume}%</span>
                  </div>
                  <input type="range" min="0" max="200" value={setting.screenVolume}
                    onClick={e => e.stopPropagation()}
                    onChange={(e) => updateUserSetting(userContextMenu.userId, { screenVolume: parseInt(e.target.value) })}
                    className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer accent-green-500" />
                  <div className="flex justify-between text-[10px] text-green-800 mt-1">
                    <span>0%</span>
                    <span className={setting.screenVolume > 100 ? 'text-yellow-600' : ''}>100%</span>
                    <span className={setting.screenVolume > 100 ? 'text-red-600' : ''}>200%</span>
                  </div>
                </div>
              </>
            )}
            {/* Role management for admins */}
            {hasPermission('manage_roles') && !isSelf && (
              <div className="mb-2 pt-2 border-t border-green-900/30">
                <div className="text-xs text-green-700 mb-2">ROLES</div>
                {serverRoles.map(role => {
                  const has = targetRoles.includes(role.name);
                  return (
                    <button key={role.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        const cmd = has ? 'REMOVE_ROLE' : 'ASSIGN_ROLE';
                        sendToServer(`CMD:${cmd}:${userContextMenu.userId}:${role.name}`);
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
                onClick={(e) => { e.stopPropagation(); sendToServer(`CMD:KICK_USER:${userContextMenu.userId}`); setUserContextMenu(null); }}
                className="w-full px-4 py-2 rounded-lg bg-red-900/20 text-red-400 hover:bg-red-900/40 transition-all flex items-center gap-2 mb-2">
                <PhoneOff className="w-4 h-4" />
                <span className="text-sm">Kick User</span>
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setUserContextMenu(null); }}
              className="w-full px-4 py-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all flex items-center gap-2 justify-center">
              <X className="w-4 h-4" />
              <span className="text-sm">Close</span>
            </button>
          </div>
        );
      })()}

      {/* ── Message Context Menu ─────────────────────────────── */}
      {msgContextMenu && (() => {
        const isPinned = (pinnedMessages[msgContextMenu.room] || []).some(m => m.msgId === msgContextMenu.msgId);
        const canDelete = msgContextMenu.sender === nickname || hasPermission('delete_messages');
        const canEdit = canDelete && !((roomMessages[msgContextMenu.room] || []).find(m => m.msgId === msgContextMenu.msgId)?.body || '').startsWith('__FILE__:');
        const canPin = hasPermission('pin_messages');
        return (
          <div
            className="fixed bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-2 min-w-[180px] z-50"
            style={{ left: Math.min(msgContextMenu.x, window.innerWidth - 200), top: Math.min(msgContextMenu.y, window.innerHeight - 140) }}
            onClick={(e) => e.stopPropagation()}>
            {canEdit && (
              <button onClick={() => {
                  const msg = (roomMessages[msgContextMenu.room] || []).find(m => m.msgId === msgContextMenu.msgId);
                  if (msg) setEditingMsg({ msgId: msg.msgId, room: msgContextMenu.room, body: msg.body });
                  setMsgContextMenu(null);
                }}
                className="w-full px-4 py-2.5 rounded-lg text-green-400 hover:bg-green-900/30 transition-all flex items-center gap-2 text-sm">
                <Pencil className="w-4 h-4" />
                <span>Edit message</span>
              </button>
            )}
            {canPin && (
              <button onClick={() => {
                  if (isPinned) sendToServer(`CMD:UNPIN_MSG:${msgContextMenu.room}:${msgContextMenu.msgId}`);
                  else sendToServer(`CMD:PIN_MSG:${msgContextMenu.room}:${msgContextMenu.msgId}`);
                  setMsgContextMenu(null);
                }}
                className="w-full px-4 py-2.5 rounded-lg text-green-500 hover:bg-green-900/30 transition-all flex items-center gap-2 text-sm">
                <Pin className="w-4 h-4" />
                <span>{isPinned ? 'Unpin message' : 'Pin message'}</span>
              </button>
            )}
            {canDelete && (
              <button onClick={() => {
                  sendToServer(`CMD:DELETE_MSG:${msgContextMenu.room}:${msgContextMenu.msgId}`);
                  setMsgContextMenu(null);
                }}
                className="w-full px-4 py-2.5 rounded-lg text-red-400 hover:bg-red-900/40 transition-all flex items-center gap-2 text-sm">
                <Trash2 className="w-4 h-4" />
                <span>Delete message</span>
              </button>
            )}
            {!canPin && !canDelete && (
              <div className="px-4 py-2.5 text-green-800 text-sm">No actions available</div>
            )}
          </div>
        );
      })()}

      {/* ── Screen Share dialog overlay ────────────────────── */}
      {screenShareDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#0d120d] border border-green-900/50 rounded-lg w-[640px] max-h-[85vh] shadow-2xl shadow-green-900/30 flex flex-col">
            <div className="p-5 border-b border-green-900/30 flex items-center justify-between shrink-0">
              <h3 className="text-green-400 font-bold flex items-center gap-2">
                <Share2 className="w-5 h-5" />
                Share Screen
              </h3>
              <button onClick={() => setScreenShareDialog(false)} className="text-green-700 hover:text-green-400 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex border-b border-green-900/30 shrink-0">
              <button onClick={() => setSourceTab('screen')}
                className={`flex-1 py-3 text-sm font-bold transition-all ${sourceTab === 'screen' ? 'text-green-400 border-b-2 border-green-500 bg-green-900/20' : 'text-green-700 hover:text-green-500'}`}>
                <Monitor className="w-4 h-4 inline mr-2" />
                Screens
              </button>
              <button onClick={() => setSourceTab('window')}
                className={`flex-1 py-3 text-sm font-bold transition-all ${sourceTab === 'window' ? 'text-green-400 border-b-2 border-green-500 bg-green-900/20' : 'text-green-700 hover:text-green-500'}`}>
                <Square className="w-4 h-4 inline mr-2" />
                Windows
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
            <div className="p-4 min-h-[200px]">
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
                  {!screenSourcesLoaded
                    ? 'Loading sources...'
                    : screenSources.length === 0
                      ? <><Monitor className="w-8 h-8 mx-auto mb-2 opacity-40" /><div>Your OS will show a source picker</div><div className="text-xs text-green-800 mt-1">Click Start Sharing below</div></>
                      : sourceTab === 'screen' ? 'No screens found' : 'No windows found'}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-green-900/30 space-y-3">
              <div>
                <label className="text-xs text-green-600 block mb-2">Resolution</label>
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
                    Server max: {serverInfo.maxScreenWidth}×{serverInfo.maxScreenHeight} @ {serverInfo.maxFps}fps
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
                  <span>{serverInfo ? Math.round(serverInfo.maxScreenBitrate / 1000) : 20000} Kbps (max)</span>
                </div>
              </div>
              <label className="flex items-center gap-3 cursor-pointer py-1 px-3 rounded-lg hover:bg-green-900/20 transition-all">
                <input type="checkbox" checked={screenShareAudio}
                  onChange={e => setScreenShareAudio(e.target.checked)}
                  disabled={platform === 'darwin'}
                  className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 accent-green-600" />
                <div>
                  <span className="text-sm text-green-500">Share audio</span>
                  <span className="block text-xs text-green-800">
                    {platform === 'darwin'
                      ? 'Not supported on macOS'
                      : platform === 'linux'
                        ? 'Include audio via PipeWire (requires PipeWire)'
                        : sourceTab === 'window'
                          ? 'Include audio from the selected window'
                          : 'Include all system audio (entire screen)'}
                  </span>
                </div>
              </label>
              <label className="flex items-center gap-3 cursor-pointer py-1 px-3 rounded-lg hover:bg-green-900/20 transition-all">
                <input type="checkbox" checked={screenShareVbr}
                  onChange={e => setScreenShareVbr(e.target.checked)}
                  className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 accent-green-600" />
                <div>
                  <span className="text-sm text-green-500">Variable bitrate</span>
                  <span className="block text-xs text-green-800">Lower bitrate on static scenes, higher on motion</span>
                </div>
              </label>
            </div>
            </div>
            <div className="flex justify-end gap-3 p-4 border-t border-green-900/30 shrink-0">
              <button onClick={() => setScreenShareDialog(false)}
                className="px-5 py-2 text-green-700 hover:text-green-500 transition-colors rounded-lg hover:bg-green-900/20">
                Cancel
              </button>
              <button onClick={() => startScreenShare()}
                disabled={!selectedSource && !(screenSourcesLoaded && screenSources.length === 0)}
                className="px-5 py-2 bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:text-green-800 text-green-400 rounded-lg transition-all font-bold flex items-center gap-2">
                <Share2 className="w-4 h-4" />
                Start Sharing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── E2EE Passphrase Prompt ────────────────────────────── */}
      {e2eePrompt && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-sm">
            <div className="bg-green-900/40 p-4 border-b border-green-900/50 flex items-center gap-3">
              <Lock className="w-5 h-5 text-green-500" />
              <div>
                <h3 className="text-sm font-bold text-green-400">END-TO-END ENCRYPTION</h3>
                <p className="text-[10px] text-green-700">This server requires E2EE — enter passphrase</p>
              </div>
            </div>
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!e2eeInput.trim()) return;
              await activateE2ee(e2eeInput.trim());
              setE2eePrompt(false);
              setE2eeInput('');
            }} className="p-4 space-y-4">
              <div>
                <label className="text-xs text-green-700 block mb-1">{'>'} E2EE PASSPHRASE</label>
                <input type="password" value={e2eeInput} onChange={e => setE2eeInput(e.target.value)}
                  placeholder="Enter the shared passphrase..."
                  className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                  autoFocus />
                <p className="text-[10px] text-green-800 mt-2">All users must use the same passphrase. The server cannot see it.</p>
              </div>
              <button type="submit" disabled={!e2eeInput.trim()}
                className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                <Lock className="w-4 h-4" />
                ACTIVATE ENCRYPTION
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── Avatar Editor Modal ───────────────────────────── */}
      {lightboxSrc && (
        <div className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="Preview"
            className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl cursor-default"
            onClick={e => e.stopPropagation()} />
        </div>
      )}

      {avatarEditor && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-sm">
            <div className="bg-green-900/40 p-4 border-b border-green-900/50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-green-400">CROP PROFILE PICTURE</h3>
              <button onClick={() => setAvatarEditor(null)} className="p-1 text-green-600 hover:text-green-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex flex-col items-center gap-4">
              <div className="relative w-48 h-48 rounded-full overflow-hidden border-2 border-green-900/50 bg-[#0a0e0a]">
                <canvas width={192} height={192}
                  ref={el => {
                    if (!el) return;
                    const ctx = el.getContext('2d');
                    if (!ctx) return;
                    const { img, zoom, offsetX, offsetY } = avatarEditor;
                    ctx.clearRect(0, 0, 192, 192);
                    const minDim = Math.min(img.width, img.height);
                    const srcSize = minDim / zoom;
                    const sx = (img.width - srcSize) / 2 - (offsetX / 192) * srcSize;
                    const sy = (img.height - srcSize) / 2 - (offsetY / 192) * srcSize;
                    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, 192, 192);
                  }}
                  onMouseDown={e => {
                    const startX = e.clientX, startY = e.clientY;
                    const { offsetX: ox, offsetY: oy } = avatarEditor;
                    const move = (ev: MouseEvent) => setAvatarEditor(prev => prev ? { ...prev, offsetX: ox + (ev.clientX - startX), offsetY: oy + (ev.clientY - startY) } : null);
                    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                    window.addEventListener('mousemove', move);
                    window.addEventListener('mouseup', up);
                  }}
                  className="w-full h-full cursor-grab active:cursor-grabbing" />
              </div>
              <div className="w-full">
                <label className="text-xs text-green-600 block mb-1">Zoom</label>
                <input type="range" min="100" max="400" value={avatarEditor.zoom * 100}
                  onChange={e => setAvatarEditor(prev => prev ? { ...prev, zoom: parseInt(e.target.value) / 100 } : null)}
                  className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer accent-green-500" />
              </div>
              <div className="flex gap-3 w-full">
                <button onClick={() => setAvatarEditor(null)}
                  className="flex-1 px-4 py-2 text-green-700 hover:text-green-500 rounded-lg hover:bg-green-900/20 transition-all text-sm">
                  Cancel
                </button>
                <button onClick={saveAvatar}
                  className="flex-1 px-4 py-2 bg-green-900/40 hover:bg-green-900/60 text-green-400 rounded-lg transition-all font-bold text-sm">
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Logo Editor Modal ────────────────────────────── */}
      {logoEditor && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-sm">
            <div className="bg-green-900/40 p-4 border-b border-green-900/50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-green-400">CROP SERVER LOGO</h3>
              <button onClick={() => setLogoEditor(null)} className="p-1 text-green-600 hover:text-green-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex flex-col items-center gap-4">
              <div className="relative w-48 h-48 rounded-2xl overflow-hidden border-2 border-green-900/50 bg-[#0a0e0a]">
                <canvas width={192} height={192}
                  ref={el => {
                    if (!el) return;
                    const ctx = el.getContext('2d');
                    if (!ctx) return;
                    const { img, zoom, offsetX, offsetY } = logoEditor;
                    ctx.clearRect(0, 0, 192, 192);
                    const minDim = Math.min(img.width, img.height);
                    const srcSize = minDim / zoom;
                    const sx = (img.width - srcSize) / 2 - (offsetX / 192) * srcSize;
                    const sy = (img.height - srcSize) / 2 - (offsetY / 192) * srcSize;
                    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, 192, 192);
                  }}
                  onMouseDown={e => {
                    const startX = e.clientX, startY = e.clientY;
                    const { offsetX: ox, offsetY: oy } = logoEditor;
                    const move = (ev: MouseEvent) => setLogoEditor(prev => prev ? { ...prev, offsetX: ox + (ev.clientX - startX), offsetY: oy + (ev.clientY - startY) } : null);
                    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                    window.addEventListener('mousemove', move);
                    window.addEventListener('mouseup', up);
                  }}
                  className="w-full h-full cursor-grab active:cursor-grabbing" />
              </div>
              <div className="w-full">
                <label className="text-xs text-green-600 block mb-1">Zoom</label>
                <input type="range" min="100" max="400" value={logoEditor.zoom * 100}
                  onChange={e => setLogoEditor(prev => prev ? { ...prev, zoom: parseInt(e.target.value) / 100 } : null)}
                  className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer accent-green-500" />
              </div>
              <div className="flex gap-3 w-full">
                <button onClick={() => setLogoEditor(null)}
                  className="flex-1 px-4 py-2 text-green-700 hover:text-green-500 rounded-lg hover:bg-green-900/20 transition-all text-sm">
                  Cancel
                </button>
                <button onClick={saveLogo}
                  className="flex-1 px-4 py-2 bg-green-900/40 hover:bg-green-900/60 text-green-400 rounded-lg transition-all font-bold text-sm">
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Emoji Editor Modal ────────────────────────────── */}
      {emojiEditor && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-sm">
            <div className="bg-green-900/40 p-4 border-b border-green-900/50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-green-400">CROP EMOJI — :{emojiEditor.name}:</h3>
              <button onClick={() => setEmojiEditor(null)} className="p-1 text-green-600 hover:text-green-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex flex-col items-center gap-4">
              <div className="relative w-48 h-48 rounded-2xl overflow-hidden border-2 border-green-900/50 bg-[#0a0e0a]">
                <canvas width={192} height={192}
                  ref={el => {
                    if (!el) return;
                    const ctx = el.getContext('2d');
                    if (!ctx) return;
                    const { img, zoom, offsetX, offsetY } = emojiEditor;
                    ctx.clearRect(0, 0, 192, 192);
                    const minDim = Math.min(img.width, img.height);
                    const srcSize = minDim / zoom;
                    const sx = (img.width - srcSize) / 2 - (offsetX / 192) * srcSize;
                    const sy = (img.height - srcSize) / 2 - (offsetY / 192) * srcSize;
                    ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, 192, 192);
                  }}
                  onMouseDown={e => {
                    const startX = e.clientX, startY = e.clientY;
                    const { offsetX: ox, offsetY: oy } = emojiEditor;
                    const move = (ev: MouseEvent) => setEmojiEditor(prev => prev ? { ...prev, offsetX: ox + (ev.clientX - startX), offsetY: oy + (ev.clientY - startY) } : null);
                    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                    window.addEventListener('mousemove', move);
                    window.addEventListener('mouseup', up);
                  }}
                  className="w-full h-full cursor-grab active:cursor-grabbing" />
              </div>
              <div className="w-full">
                <label className="text-xs text-green-600 block mb-1">Zoom</label>
                <input type="range" min="100" max="400" value={emojiEditor.zoom * 100}
                  onChange={e => setEmojiEditor(prev => prev ? { ...prev, zoom: parseInt(e.target.value) / 100 } : null)}
                  className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer accent-green-500" />
              </div>
              <div className="flex gap-3 w-full">
                <button onClick={() => setEmojiEditor(null)}
                  className="flex-1 px-4 py-2 text-green-700 hover:text-green-500 rounded-lg hover:bg-green-900/20 transition-all text-sm">
                  Cancel
                </button>
                <button onClick={saveEmoji}
                  className="flex-1 px-4 py-2 bg-green-900/40 hover:bg-green-900/60 text-green-400 rounded-lg transition-all font-bold text-sm">
                  Upload
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Create / Edit Room Dialog ─────────────────────── */}
      {createRoomDialog && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-md">
            <div className="bg-green-900/40 p-6 border-b border-green-900/50 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {createRoomDialog.type === 'voice' ? <Volume2 className="w-5 h-5 text-green-500" /> : <Hash className="w-5 h-5 text-green-500" />}
                <h2 className="text-lg font-bold text-green-400">
                  {createRoomDialog.editing
                    ? (createRoomDialog.type === 'voice' ? 'EDIT VOICE CHANNEL' : 'EDIT TEXT CHANNEL')
                    : (createRoomDialog.type === 'voice' ? 'CREATE VOICE CHANNEL' : 'CREATE TEXT CHANNEL')}
                </h2>
              </div>
              <button onClick={() => setCreateRoomDialog(null)} className="p-2 text-green-600 hover:text-green-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={e => {
              e.preventDefault();
              if (!newRoomName.trim()) return;
              if (createRoomDialog.editing) {
                if (createRoomDialog.type === 'voice') {
                  sendToServer(`CMD:EDIT_VOICE_ROOM:${createRoomDialog.editing}:${newRoomName.trim()}:${newRoomRoles.join(',')}:${newRoomBitrate}`);
                } else {
                  sendToServer(`CMD:EDIT_TEXT_ROOM:${createRoomDialog.editing}:${newRoomName.trim()}:${newRoomRoles.join(',')}`);
                }
              } else {
                if (createRoomDialog.type === 'voice') {
                  sendToServer(`CMD:CREATE_VOICE_ROOM:${newRoomName.trim()}:${newRoomRoles.join(',')}:${newRoomBitrate}`);
                } else {
                  sendToServer(`CMD:CREATE_TEXT_ROOM:${newRoomName.trim()}:${newRoomRoles.join(',')}`);
                }
              }
              setCreateRoomDialog(null);
            }} className="p-6 space-y-4">
              <div className="space-y-2">
                <label className="text-xs text-green-700 block">{'>'} CHANNEL NAME</label>
                <input type="text" value={newRoomName} onChange={e => setNewRoomName(e.target.value)}
                  placeholder="Enter channel name..."
                  className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                  autoFocus />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-green-700 block">{'>'} RESTRICTED TO ROLES <span className="text-green-800">(leave empty for public)</span></label>
                <div className="space-y-1 max-h-32 overflow-y-auto border border-green-900/30 rounded-lg p-2">
                  {serverRoles.filter(role => !role.permissions.includes('admin')).map(role => (
                    <label key={role.name} className="flex items-center gap-2 cursor-pointer px-1 py-0.5 rounded hover:bg-green-900/20">
                      <input type="checkbox" checked={newRoomRoles.includes(role.name)}
                        onChange={e => setNewRoomRoles(prev => e.target.checked ? [...prev, role.name] : prev.filter(n => n !== role.name))}
                        className="accent-green-500" />
                      <span className="text-sm" style={{ color: role.color }}>{role.name}</span>
                    </label>
                  ))}
                  {serverRoles.filter(role => !role.permissions.includes('admin')).length === 0 && (
                    <p className="text-xs text-green-800 px-1">No roles available.</p>
                  )}
                </div>
              </div>
              {createRoomDialog.type === 'voice' && (
                <div className="space-y-2">
                  <label className="text-xs text-green-700 block">{'>'} BITRATE</label>
                  <select value={newRoomBitrate} onChange={e => setNewRoomBitrate(e.target.value)}
                    className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                    <option value="32000">32 kbps</option>
                    <option value="64000">64 kbps</option>
                    <option value="96000">96 kbps (default)</option>
                    <option value="128000">128 kbps</option>
                    <option value="256000">256 kbps</option>
                    <option value="510000">510 kbps</option>
                  </select>
                </div>
              )}
              <button type="submit" disabled={!newRoomName.trim()}
                className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold">
                {createRoomDialog.editing ? <Check className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                {createRoomDialog.editing ? 'SAVE CHANGES' : 'CREATE CHANNEL'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── Wipe Server Confirmation Dialog ──────────────── */}
      {wipeServerDialog && serverInfo && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-[#0d120d]/95 border border-red-900/50 rounded-lg shadow-2xl shadow-red-900/30 w-full max-w-md">
            <div className="bg-red-900/30 p-6 border-b border-red-900/50 flex items-center gap-3">
              <Trash2 className="w-6 h-6 text-red-500" />
              <div>
                <h2 className="text-lg font-bold text-red-400">WIPE SERVER</h2>
                <p className="text-xs text-red-500/70">This action is permanent and irreversible</p>
              </div>
              <button onClick={() => setWipeServerDialog(false)} className="ml-auto p-2 text-red-600 hover:text-red-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-red-900/10 border border-red-900/30 rounded-lg p-3">
                <p className="text-xs text-red-400 font-bold mb-2">The following will be permanently deleted:</p>
                <ul className="text-[11px] text-red-500/80 space-y-1 list-disc list-inside">
                  <li>All chat messages and pins</li>
                  <li>All user avatars</li>
                  <li>All soundboard sounds</li>
                  <li>All custom emojis</li>
                  <li>All custom roles and assignments</li>
                  <li>Server name and logo (reset to defaults)</li>
                  <li>All rooms (reset to defaults)</li>
                </ul>
              </div>
              <div className="space-y-2">
                <label className="text-xs text-red-500/70 block">Type <span className="font-bold text-red-400">{serverInfo.serverName}</span> to confirm:</label>
                <input type="text" value={wipeConfirmName} onChange={e => setWipeConfirmName(e.target.value)}
                  placeholder="Enter server name exactly..."
                  className="w-full bg-[#0a0e0a] border border-red-900/50 rounded-lg px-4 py-3 text-red-500 placeholder-red-900 outline-none focus:border-red-700 focus:ring-2 focus:ring-red-900/50 transition-all"
                  autoFocus autoComplete="off" spellCheck={false} />
              </div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={wipeConfirmCheck}
                  onChange={e => setWipeConfirmCheck(e.target.checked)}
                  className="w-4 h-4 mt-0.5 rounded bg-[#0a0e0a] border-red-900/50 text-red-600 focus:ring-red-900/50 accent-red-600" />
                <span className="text-xs text-red-500/70">I understand this will permanently destroy all server data and cannot be undone</span>
              </label>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setWipeServerDialog(false)}
                  className="flex-1 px-4 py-3 text-green-700 hover:text-green-500 rounded-lg hover:bg-green-900/20 transition-all text-sm">
                  Cancel
                </button>
                <button
                  onClick={() => {
                    sendToServer(`CMD:WIPE_SERVER:${serverInfo!.serverName}`);
                    setWipeServerDialog(false);
                    setShowServerSettings(false);
                  }}
                  disabled={wipeConfirmName !== serverInfo.serverName || !wipeConfirmCheck}
                  className="flex-1 px-4 py-3 rounded-lg bg-red-700/80 hover:bg-red-600 disabled:bg-red-900/20 disabled:cursor-not-allowed text-white disabled:text-red-800 transition-all font-bold text-sm flex items-center justify-center gap-2">
                  <Trash2 className="w-4 h-4" />
                  WIPE EVERYTHING
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Update available / downloading toast ── */}
      {updateAvailable && !updateDismissed && (
        <div className="fixed bottom-4 right-4 bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-4 z-50 max-w-xs">
          <div className="flex items-start gap-3">
            <Download className="w-5 h-5 text-green-500 shrink-0 mt-0.5 animate-bounce" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-green-400 font-bold">Update available</p>
              <p className="text-xs text-green-700 mt-1">Version {updateAvailable} is downloading…</p>
              {updateProgress !== null && (
                <div className="mt-2 h-1.5 bg-green-900/40 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 transition-all duration-300 rounded-full" style={{ width: `${updateProgress}%` }} />
                </div>
              )}
            </div>
            <button onClick={() => setUpdateDismissed(true)} className="text-green-800 hover:text-green-500 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Update notification toast ── */}
      {updateReady && !updateDismissed && (
        <div className="fixed bottom-4 right-4 bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-4 z-50 max-w-xs">
          <div className="flex items-start gap-3">
            <Download className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-green-400 font-bold">Update ready</p>
              <p className="text-xs text-green-700 mt-1">Version {updateReady} has been downloaded.</p>
              <div className="flex gap-2 mt-3">
                <button onClick={() => window.electronAPI.installUpdate()}
                  className="px-3 py-1.5 bg-green-900/40 hover:bg-green-900/60 text-green-400 rounded-lg text-xs transition-all font-bold">
                  Restart now
                </button>
                <button onClick={() => setUpdateDismissed(true)}
                  className="px-3 py-1.5 text-green-700 hover:text-green-500 rounded-lg text-xs transition-all">
                  Later
                </button>
              </div>
            </div>
            <button onClick={() => setUpdateDismissed(true)} className="text-green-800 hover:text-green-500 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
