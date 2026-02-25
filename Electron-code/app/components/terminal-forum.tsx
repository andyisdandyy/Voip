import { useState, useEffect, useRef } from 'react';
import { Terminal, Hash, User, Circle, Mic, MicOff, Headphones, Settings, Volume2, VolumeX, LogIn, Phone, PhoneOff, X, Bell, Monitor, Video, VideoOff, Share2 } from 'lucide-react';

interface Message {
  id: string;
  user: string;
  text: string;
  timestamp: Date;
  room: string;
}

interface Room {
  id: string;
  name: string;
  unread: number;
  type: 'text' | 'voice';
}

interface OnlineUser {
  id: string;
  name: string;
  status: 'online' | 'away' | 'busy';
  voiceChannel?: string;
}

interface UserContextMenu {
  userId: string;
  x: number;
  y: number;
}

interface UserSettings {
  userId: string;
  volume: number;
  isMuted: boolean;
}

export function TerminalForum() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [nickname, setNickname] = useState('');
  const [serverIp, setServerIp] = useState('');
  const [currentRoom, setCurrentRoom] = useState('general');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      user: 'system',
      text: 'Velkommen til Terminal Forum. Brug /help for kommandoer.',
      timestamp: new Date(),
      room: 'general'
    },
    {
      id: '2',
      user: 'admin',
      text: 'Server startet op.',
      timestamp: new Date(),
      room: 'general'
    }
  ]);
  const [input, setInput] = useState('');
  const [rooms, setRooms] = useState<Room[]>([
    { id: 'general', name: 'general', unread: 0, type: 'text' },
    { id: 'random', name: 'random', unread: 0, type: 'text' },
    { id: 'tech', name: 'tech', unread: 0, type: 'text' },
    { id: 'gaming', name: 'gaming', unread: 0, type: 'text' },
    { id: 'voice-general', name: 'General Voice', unread: 0, type: 'voice' },
    { id: 'voice-lounge', name: 'Lounge', unread: 0, type: 'voice' },
    { id: 'voice-afk', name: 'AFK', unread: 0, type: 'voice' },
  ]);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([
    { id: '1', name: 'user@localhost', status: 'online' },
    { id: '2', name: 'admin@terminal', status: 'online' },
    { id: '3', name: 'guest_42', status: 'away' },
    { id: '4', name: 'dev@system', status: 'online' },
    { id: '5', name: 'moderator', status: 'busy' },
  ]);
  const [currentUser] = useState('user@localhost');
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [inVoiceCall, setInVoiceCall] = useState(false);
  const [voiceChannel, setVoiceChannel] = useState('');
  const [callDuration, setCallDuration] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [userContextMenu, setUserContextMenu] = useState<UserContextMenu | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings[]>([
    { userId: '1', volume: 100, isMuted: false },
    { userId: '2', volume: 100, isMuted: false },
    { userId: '3', volume: 100, isMuted: false },
    { userId: '4', volume: 100, isMuted: false },
    { userId: '5', volume: 100, isMuted: false },
  ]);
  const [showSettings, setShowSettings] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [selectedVideoFeed, setSelectedVideoFeed] = useState<string | null>(null);

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClick = () => setUserContextMenu(null);
    if (userContextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [userContextMenu]);

  // Handle login
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (nickname.trim() && serverIp.trim()) {
      setIsLoggedIn(true);
    }
  };

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Timer for voice call duration
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (inVoiceCall) {
      interval = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [inVoiceCall]);

  // Format call duration
  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) {
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Join voice channel
  const handleJoinVoice = (channelName: string) => {
    setInVoiceCall(true);
    setVoiceChannel(channelName);
    setCurrentRoom(channelName); // Show the voice channel view
    
    // Update current user to be in this voice channel
    setOnlineUsers(users => users.map(u => 
      u.id === '1' ? { ...u, voiceChannel: channelName } : u
    ));
  };

  // Leave voice channel
  const handleLeaveVoice = () => {
    setInVoiceCall(false);
    setVoiceChannel('');
    setIsMuted(false);
    setIsDeafened(false);
    
    // Remove current user from voice channel
    setOnlineUsers(users => users.map(u => 
      u.id === '1' ? { ...u, voiceChannel: undefined } : u
    ));
  };

  // Handle command input
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    // Check if it's a command
    if (input.startsWith('/')) {
      handleCommand(input);
    } else {
      // Regular message
      const newMessage: Message = {
        id: Date.now().toString(),
        user: nickname || currentUser,
        text: input,
        timestamp: new Date(),
        room: currentRoom
      };
      setMessages([...messages, newMessage]);
    }

    setInput('');
  };

  // Handle commands
  const handleCommand = (cmd: string) => {
    const parts = cmd.split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    const systemMessage = (text: string) => ({
      id: Date.now().toString(),
      user: 'system',
      text,
      timestamp: new Date(),
      room: currentRoom
    });

    switch (command) {
      case '/help':
        setMessages([...messages, 
          systemMessage('Tilgængelige kommandoer:'),
          systemMessage('/help - Vis denne hjælp'),
          systemMessage('/join <rum> - Tilslut et rum'),
          systemMessage('/create <rum> - Opret nyt rum'),
          systemMessage('/nick <navn> - Skift brugernavn'),
          systemMessage('/clear - Ryd skærmen'),
          systemMessage('/users - Vis online brugere'),
        ]);
        break;

      case '/join':
        if (args.length > 0) {
          const roomName = args[0];
          const roomExists = rooms.find(r => r.name === roomName);
          if (roomExists) {
            setCurrentRoom(roomName);
            setMessages([...messages, systemMessage(`Tilsluttet #${roomName}`)]);
          } else {
            setMessages([...messages, systemMessage(`Rum #${roomName} findes ikke. Brug /create ${roomName}`)]);
          }
        } else {
          setMessages([...messages, systemMessage('Brug: /join <rum>')]);
        }
        break;

      case '/create':
        if (args.length > 0) {
          const roomName = args[0];
          const roomExists = rooms.find(r => r.name === roomName);
          if (!roomExists) {
            setRooms([...rooms, { id: roomName, name: roomName, unread: 0, type: 'text' }]);
            setMessages([...messages, systemMessage(`Rum #${roomName} oprettet`)]);
          } else {
            setMessages([...messages, systemMessage(`Rum #${roomName} eksisterer allerede`)]);
          }
        } else {
          setMessages([...messages, systemMessage('Brug: /create <rum>')]);
        }
        break;

      case '/clear':
        setMessages([systemMessage('Terminal ryddet')]);
        break;

      case '/users':
        setMessages([...messages, 
          systemMessage(`Online brugere (${onlineUsers.length}):`),
          ...onlineUsers.map(u => systemMessage(`  - ${u.name} [${u.status}]`))
        ]);
        break;

      case '/nick':
        if (args.length > 0) {
          setMessages([...messages, systemMessage(`Brugernavn ændret til ${args[0]} (demo mode - ikke implementeret)`)]);
        } else {
          setMessages([...messages, systemMessage('Brug: /nick <navn>')]);
        }
        break;

      default:
        setMessages([...messages, systemMessage(`Ukendt kommando: ${command}. Brug /help`)]);
    }
  };

  // Format timestamp
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // Get status color
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online': return 'text-green-500';
      case 'away': return 'text-yellow-500';
      case 'busy': return 'text-red-500';
      default: return 'text-gray-500';
    }
  };

  // Filter messages by current room
  const currentMessages = messages.filter(m => m.room === currentRoom);
  
  // Separate rooms by type
  const textRooms = rooms.filter(r => r.type === 'text');
  const voiceRooms = rooms.filter(r => r.type === 'voice');

  // Get users in current voice channel
  const usersInVoiceChannel = voiceChannel ? onlineUsers.filter(u => u.voiceChannel === voiceChannel) : [];
  
  // Check if video mode is active
  const isVideoMode = isCameraOn || isScreenSharing;

  // Show login screen if not logged in
  if (!isLoggedIn) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0a0e0a] text-green-500 font-mono p-4">
        <div className="w-full max-w-md">
          {/* Login box */}
          <div className="bg-[#0d120d]/80 backdrop-blur-sm rounded-lg shadow-2xl shadow-green-900/30 overflow-hidden">
            {/* Header */}
            <div className="bg-green-900/40 p-6 border-b border-green-900/50">
              <div className="flex items-center gap-3 mb-2">
                <Terminal className="w-8 h-8" />
                <div>
                  <h1 className="text-xl font-bold">TERMINAL FORUM</h1>
                  <p className="text-xs text-green-700">v1.0.0 - Login</p>
                </div>
              </div>
            </div>

            {/* Login form */}
            <form onSubmit={handleLogin} className="p-8 space-y-6">
              <div className="space-y-2">
                <label className="text-xs text-green-700 block">{'>'} NICKNAME</label>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="Indtast dit nickname..."
                  className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs text-green-700 block">{'>'} SERVER IP</label>
                <input
                  type="text"
                  value={serverIp}
                  onChange={(e) => setServerIp(e.target.value)}
                  placeholder="192.168.1.1:8080"
                  className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-3 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                />
              </div>

              <button
                type="submit"
                disabled={!nickname.trim() || !serverIp.trim()}
                className="w-full bg-green-900/40 hover:bg-green-900/60 disabled:bg-green-900/20 disabled:cursor-not-allowed text-green-400 disabled:text-green-800 py-3 rounded-lg transition-all flex items-center justify-center gap-2 font-bold"
              >
                <LogIn className="w-5 h-5" />
                CONNECT
              </button>

              <div className="pt-4 border-t border-green-900/30">
                <div className="text-xs text-green-700 space-y-1">
                  <div>{'>'} Status: <span className="text-green-500">Awaiting connection</span></div>
                  <div>{'>'} Protocol: <span className="text-green-500">TCP/IP</span></div>
                  <div>{'>'} Encryption: <span className="text-green-500">Enabled</span></div>
                </div>
              </div>
            </form>
          </div>

          {/* Info text */}
          <div className="mt-6 text-center text-xs text-green-700">
            <p>Indtast dine credentials for at tilslutte serveren</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#0a0e0a] text-green-500 font-mono p-4 gap-4">
      {/* Header */}
      <div className="bg-[#0d120d]/80 backdrop-blur-sm p-4 rounded-lg flex items-center gap-2 shadow-lg shadow-green-900/20">
        <Terminal className="w-5 h-5" />
        <span className="text-sm">TERMINAL FORUM v1.0.0</span>
        <span className="ml-auto text-xs text-green-700">
          {new Date().toLocaleString('da-DK')}
        </span>
      </div>

      {/* Main content */}
      <div className="flex-1 flex gap-4 overflow-hidden">
        {/* Left sidebar - Rooms */}
        <div className="w-64 bg-[#0d120d]/60 backdrop-blur-sm rounded-lg shadow-lg shadow-green-900/10 flex flex-col">
          <div className="flex-1 overflow-y-auto">
            {/* Text Channels */}
            <div className="p-4 border-b border-green-900/30">
              <div className="text-xs text-green-700 mb-2">TEXT KANALER</div>
            </div>
            <div className="p-3">
              {textRooms.map((room) => (
                <button
                  key={room.id}
                  onClick={() => setCurrentRoom(room.name)}
                  className={`w-full text-left px-4 py-2.5 rounded-lg mb-2 flex items-center gap-2 transition-all ${
                    currentRoom === room.name
                      ? 'bg-green-900/40 text-green-400 shadow-md shadow-green-900/30'
                      : 'hover:bg-green-900/20 text-green-600'
                  }`}
                >
                  <Hash className="w-4 h-4" />
                  <span className="text-sm">{room.name}</span>
                  {room.unread > 0 && (
                    <span className="ml-auto bg-green-700 text-black text-xs px-2 py-0.5 rounded-full">
                      {room.unread}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Voice Channels */}
            <div className="p-4 border-b border-green-900/30">
              <div className="text-xs text-green-700 mb-2">VOICE KANALER</div>
            </div>
            <div className="p-3">
              {voiceRooms.map((room) => {
                const usersInChannel = onlineUsers.filter(u => u.voiceChannel === room.name);
                return (
                  <div key={room.id} className="mb-2">
                    <button
                      onClick={() => handleJoinVoice(room.name)}
                      className={`w-full text-left px-4 py-2.5 rounded-lg flex items-center gap-2 transition-all ${
                        currentRoom === room.name
                          ? 'bg-green-900/40 text-green-400 shadow-md shadow-green-900/30'
                          : 'hover:bg-green-900/20 text-green-600'
                      }`}
                    >
                      <Volume2 className="w-4 h-4" />
                      <span className="text-sm">{room.name}</span>
                    </button>
                    {/* Users in this voice channel */}
                    {usersInChannel.length > 0 && (
                      <div className="ml-6 mt-1 space-y-1">
                        {usersInChannel.map((user) => (
                          <div
                            key={user.id}
                            className="flex items-center gap-2 px-2 py-1 text-xs text-green-600"
                          >
                            <User className="w-3 h-3" />
                            <span>{user.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* User section at bottom */}
          <div className="p-4 border-t border-green-900/30 bg-[#0d120d]/40">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-green-900/40 flex items-center justify-center">
                <User className="w-4 h-4 text-green-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-green-500 truncate">{nickname || currentUser}</div>
                <div className="text-xs text-green-700">online</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsMuted(!isMuted)}
                className={`p-2 rounded-lg transition-all ${
                  isMuted
                    ? 'bg-red-900/40 text-red-500 hover:bg-red-900/60'
                    : 'bg-green-900/20 text-green-600 hover:bg-green-900/40'
                }`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setIsDeafened(!isDeafened)}
                className={`p-2 rounded-lg transition-all ${
                  isDeafened
                    ? 'bg-red-900/40 text-red-500 hover:bg-red-900/60'
                    : 'bg-green-900/20 text-green-600 hover:bg-green-900/40'
                }`}
                title={isDeafened ? 'Undeafen' : 'Deafen'}
              >
                {isDeafened ? <VolumeX className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setShowSettings(true)}
                className="p-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all"
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Middle - Chat */}
        <div className="flex-1 flex flex-col bg-[#0d120d]/60 backdrop-blur-sm rounded-lg overflow-hidden shadow-lg shadow-green-900/10">
          {inVoiceCall && rooms.find(r => r.name === currentRoom && r.type === 'voice') ? (
            // In Call Screen - only show when viewing a voice channel while in a call
            <div className="flex-1 flex flex-col">
              {isVideoMode ? (
                // Video Grid Mode
                <div className="flex-1 flex flex-col p-4">
                  {/* Video Grid */}
                  <div className={`flex-1 grid gap-4 mb-4 ${
                    usersInVoiceChannel.length === 1 ? 'grid-cols-1' :
                    usersInVoiceChannel.length === 2 ? 'grid-cols-2' :
                    usersInVoiceChannel.length <= 4 ? 'grid-cols-2 grid-rows-2' :
                    usersInVoiceChannel.length <= 6 ? 'grid-cols-3 grid-rows-2' :
                    'grid-cols-3 grid-rows-3'
                  }`}>
                    {usersInVoiceChannel.map((user) => {
                      const isSelected = selectedVideoFeed === user.id;
                      const isCurrentUser = user.id === '1';
                      
                      return (
                        <div
                          key={user.id}
                          onClick={() => setSelectedVideoFeed(isSelected ? null : user.id)}
                          className={`relative bg-[#0a0e0a] rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                            isSelected 
                              ? 'col-span-2 row-span-2 border-green-500 shadow-lg shadow-green-900/50' 
                              : 'border-green-900/30 hover:border-green-700/50'
                          }`}
                        >
                          {/* Video placeholder */}
                          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-green-950/50 to-green-900/30">
                            {isCurrentUser && isCameraOn ? (
                              <div className="text-center">
                                <Video className="w-16 h-16 text-green-500 mx-auto mb-2" />
                                <p className="text-green-600 text-sm">Din Kamera</p>
                              </div>
                            ) : isCurrentUser && isScreenSharing ? (
                              <div className="text-center">
                                <Monitor className="w-16 h-16 text-green-500 mx-auto mb-2" />
                                <p className="text-green-600 text-sm">Din Skærm</p>
                              </div>
                            ) : (
                              <div className="w-24 h-24 rounded-full bg-green-900/40 flex items-center justify-center ring-4 ring-green-900/50">
                                <User className="w-12 h-12 text-green-500" />
                              </div>
                            )}
                          </div>

                          {/* User name overlay */}
                          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-green-400 font-bold text-sm">{user.name}</span>
                              <div className="flex items-center gap-2">
                                {userSettings.find(s => s.userId === user.id)?.isMuted && (
                                  <MicOff className="w-4 h-4 text-red-500" />
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Controls Bar */}
                  <div className="flex justify-center gap-3 pb-2">
                    {/* Mute Button */}
                    <button
                      onClick={() => setIsMuted(!isMuted)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isMuted
                          ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50'
                          : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'
                      }`}
                      title={isMuted ? 'Unmute' : 'Mute'}
                    >
                      {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                    </button>

                    {/* Camera Button */}
                    <button
                      onClick={() => setIsCameraOn(!isCameraOn)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isCameraOn
                          ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'
                          : 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50'
                      }`}
                      title={isCameraOn ? 'Turn Off Camera' : 'Turn On Camera'}
                    >
                      {isCameraOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
                    </button>

                    {/* Screen Share Button */}
                    <button
                      onClick={() => setIsScreenSharing(!isScreenSharing)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isScreenSharing
                          ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'
                          : 'bg-green-900/20 text-green-600 hover:bg-green-900/40 shadow-green-900/30'
                      }`}
                      title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
                    >
                      <Share2 className="w-6 h-6" />
                    </button>

                    {/* End Call Button */}
                    <button
                      onClick={handleLeaveVoice}
                      className="w-14 h-14 rounded-full bg-red-600/80 hover:bg-red-600 text-white flex items-center justify-center transition-all shadow-lg shadow-red-900/50"
                      title="End Call"
                    >
                      <PhoneOff className="w-6 h-6" />
                    </button>

                    {/* Deafen Button */}
                    <button
                      onClick={() => setIsDeafened(!isDeafened)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isDeafened
                          ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50'
                          : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'
                      }`}
                      title={isDeafened ? 'Undeafen' : 'Deafen'}
                    >
                      {isDeafened ? <VolumeX className="w-6 h-6" /> : <Headphones className="w-6 h-6" />}
                    </button>
                  </div>

                  {/* Call Info */}
                  <div className="text-center py-2 border-t border-green-900/30">
                    <div className="text-lg font-mono text-green-500 font-bold">
                      {formatDuration(callDuration)}
                    </div>
                    <div className="text-xs text-green-700">{voiceChannel}</div>
                  </div>
                </div>
              ) : (
                // Voice Only Mode (original UI)
                <div className="flex-1 flex flex-col">
                  {/* Participants Grid */}
                  <div className="flex-1 flex flex-col items-center justify-center p-8">
                    {/* Show all participants */}
                    <div className={`grid gap-8 mb-8 ${
                      usersInVoiceChannel.length === 1 ? 'grid-cols-1' :
                      usersInVoiceChannel.length === 2 ? 'grid-cols-2' :
                      usersInVoiceChannel.length <= 4 ? 'grid-cols-2' :
                      'grid-cols-3'
                    }`}>
                      {usersInVoiceChannel.map((user) => (
                        <div key={user.id} className="flex flex-col items-center">
                          <div className="w-32 h-32 rounded-full bg-green-900/40 flex items-center justify-center ring-4 ring-green-900/50 shadow-lg shadow-green-900/50 mb-3">
                            <User className="w-16 h-16 text-green-500" />
                          </div>
                          <h3 className="text-lg font-bold text-green-400 mb-1">{user.name}</h3>
                          <div className="flex items-center gap-2 text-xs text-green-700">
                            {userSettings.find(s => s.userId === user.id)?.isMuted ? (
                              <>
                                <MicOff className="w-3 h-3 text-red-500" />
                                <span className="text-red-500">Muted</span>
                              </>
                            ) : (
                              <>
                                <Mic className="w-3 h-3" />
                                <span>Speaking</span>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Channel Info */}
                    <div className="text-center mb-8">
                      <p className="text-sm text-green-700">Connected to: {voiceChannel}</p>
                    </div>

                    {/* Timer */}
                    <div className="text-center mb-12">
                      <div className="text-5xl font-mono text-green-500 font-bold">
                        {formatDuration(callDuration)}
                      </div>
                      <div className="text-xs text-green-700 mt-2">Call Duration</div>
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="flex justify-center gap-4 pb-8">
                    {/* Mute Button */}
                    <button
                      onClick={() => setIsMuted(!isMuted)}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isMuted
                          ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50'
                          : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'
                      }`}
                      title={isMuted ? 'Unmute' : 'Mute'}
                    >
                      {isMuted ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
                    </button>

                    {/* Camera Button */}
                    <button
                      onClick={() => setIsCameraOn(!isCameraOn)}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isCameraOn
                          ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'
                          : 'bg-green-900/20 text-green-600 hover:bg-green-900/40 shadow-green-900/30'
                      }`}
                      title={isCameraOn ? 'Turn Off Camera' : 'Turn On Camera'}
                    >
                      {isCameraOn ? <Video className="w-7 h-7" /> : <VideoOff className="w-7 h-7" />}
                    </button>

                    {/* Screen Share Button */}
                    <button
                      onClick={() => setIsScreenSharing(!isScreenSharing)}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isScreenSharing
                          ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'
                          : 'bg-green-900/20 text-green-600 hover:bg-green-900/40 shadow-green-900/30'
                      }`}
                      title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
                    >
                      <Share2 className="w-7 h-7" />
                    </button>

                    {/* End Call Button */}
                    <button
                      onClick={handleLeaveVoice}
                      className="w-16 h-16 rounded-full bg-red-600/80 hover:bg-red-600 text-white flex items-center justify-center transition-all shadow-lg shadow-red-900/50"
                      title="End Call"
                    >
                      <PhoneOff className="w-7 h-7" />
                    </button>

                    {/* Deafen Button */}
                    <button
                      onClick={() => setIsDeafened(!isDeafened)}
                      className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg ${
                        isDeafened
                          ? 'bg-red-900/60 text-red-400 hover:bg-red-900/80 shadow-red-900/50'
                          : 'bg-green-900/40 text-green-400 hover:bg-green-900/60 shadow-green-900/30'
                      }`}
                      title={isDeafened ? 'Undeafen' : 'Deafen'}
                    >
                      {isDeafened ? <VolumeX className="w-7 h-7" /> : <Headphones className="w-7 h-7" />}
                    </button>
                  </div>

                  {/* Status indicators */}
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
          ) : (
            // Normal Chat View
            <>
              {/* Room header */}
              <div className="border-b border-green-900/30 p-4 bg-[#0d120d]/40">
                <div className="flex items-center gap-2">
                  <Hash className="w-5 h-5" />
                  <span className="font-bold">{currentRoom}</span>
                  <span className="text-xs text-green-700 ml-2">
                    {currentMessages.length} beskeder
                  </span>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-6 space-y-3">
                {currentMessages.map((message) => (
                  <div key={message.id} className="group">
                    <div className="flex gap-3 text-sm">
                      <span className="text-green-700/70 text-xs">
                        [{formatTime(message.timestamp)}]
                      </span>
                      <span className={`font-bold ${
                        message.user === 'system' ? 'text-yellow-500' :
                        message.user === 'admin' ? 'text-red-500' :
                        message.user === currentUser ? 'text-cyan-500' :
                        'text-blue-500'
                      }`}>
                        {message.user}:
                      </span>
                      <span className="text-green-400">{message.text}</span>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="border-t border-green-900/30 p-4 bg-[#0d120d]/40">
                <form onSubmit={handleSubmit} className="flex gap-3">
                  <span className="text-green-500">{'>'}</span>
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    className="flex-1 bg-transparent outline-none text-green-500 placeholder-green-800"
                    placeholder="Skriv besked eller /help for kommandoer..."
                    autoComplete="off"
                  />
                </form>
              </div>
            </>
          )}
        </div>

        {/* Right sidebar - Online users */}
        <div className="w-64 bg-[#0d120d]/60 backdrop-blur-sm rounded-lg overflow-y-auto shadow-lg shadow-green-900/10">
          <div className="p-4 border-b border-green-900/30">
            <div className="text-xs text-green-700">
              ONLINE BRUGERE ({onlineUsers.length})
            </div>
          </div>
          <div className="p-3">
            {onlineUsers.map((user) => (
              <div
                key={user.id}
                className="px-4 py-2.5 flex items-center gap-3 hover:bg-green-900/20 rounded-lg transition-all mb-2"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setUserContextMenu({ userId: user.id, x: e.clientX, y: e.clientY });
                }}
              >
                <Circle 
                  className={`w-2 h-2 fill-current ${getStatusColor(user.status)}`}
                />
                <User className="w-4 h-4 text-green-700" />
                <span className="text-sm text-green-600">{user.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer status bar */}
      <div className="bg-[#0d120d]/80 backdrop-blur-sm px-4 py-2 rounded-lg flex items-center gap-4 text-xs text-green-700 shadow-lg shadow-green-900/20">
        <span>STATUS: READY</span>
        <span>ROOM: #{currentRoom}</span>
        <span>USERS: {onlineUsers.length}</span>
        <span className="ml-auto">Press F1 for help</span>
      </div>

      {/* User Context Menu */}
      {userContextMenu && (() => {
        const menuWidth = 240;
        const menuHeight = 250; // Approximate height
        const x = Math.min(userContextMenu.x, window.innerWidth - menuWidth - 10);
        const y = Math.min(userContextMenu.y, window.innerHeight - menuHeight - 10);
        
        return (
          <div
            className="fixed bg-[#0d120d]/95 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 p-3 min-w-[240px] z-50"
            style={{ left: x, top: y }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-2 mb-3 pb-3 border-b border-green-900/30">
              <User className="w-4 h-4 text-green-500" />
              <span className="text-sm text-green-400 font-bold">
                {onlineUsers.find(u => u.id === userContextMenu.userId)?.name}
              </span>
            </div>

            {/* Volume Control */}
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-2">
                <Volume2 className="w-4 h-4 text-green-500" />
                <span className="text-xs text-green-600">Lydniveau</span>
                <span className="ml-auto text-xs text-green-500">
                  {userSettings.find(s => s.userId === userContextMenu.userId)?.volume || 100}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={userSettings.find(s => s.userId === userContextMenu.userId)?.volume || 100}
                onChange={(e) => {
                  const newSettings = userSettings.map(s => 
                    s.userId === userContextMenu.userId ? { ...s, volume: parseInt(e.target.value) } : s
                  );
                  setUserSettings(newSettings);
                }}
                className="w-full h-2 bg-green-900/30 rounded-lg appearance-none cursor-pointer slider"
                style={{
                  background: `linear-gradient(to right, #22c55e 0%, #22c55e ${userSettings.find(s => s.userId === userContextMenu.userId)?.volume || 100}%, #1a3d1a ${userSettings.find(s => s.userId === userContextMenu.userId)?.volume || 100}%, #1a3d1a 100%)`
                }}
              />
            </div>

            {/* Mute/Unmute Button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                const newSettings = userSettings.map(s => 
                  s.userId === userContextMenu.userId ? { ...s, isMuted: !s.isMuted } : s
                );
                setUserSettings(newSettings);
              }}
              className={`w-full px-4 py-2.5 rounded-lg transition-all flex items-center gap-2 mb-2 ${
                userSettings.find(s => s.userId === userContextMenu.userId)?.isMuted
                  ? 'bg-red-900/40 text-red-400 hover:bg-red-900/60'
                  : 'bg-green-900/20 text-green-500 hover:bg-green-900/40'
              }`}
            >
              {userSettings.find(s => s.userId === userContextMenu.userId)?.isMuted ? (
                <>
                  <MicOff className="w-4 h-4" />
                  <span className="text-sm">Unmute Bruger</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4" />
                  <span className="text-sm">Mute Bruger</span>
                </>
              )}
            </button>

            {/* Close Button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setUserContextMenu(null);
              }}
              className="w-full px-4 py-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all flex items-center gap-2 justify-center"
            >
              <X className="w-4 h-4" />
              <span className="text-sm">Luk</span>
            </button>
          </div>
        );
      })()}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0d120d]/95 border border-green-900/50 rounded-lg shadow-2xl shadow-green-900/30 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className="bg-green-900/40 p-6 border-b border-green-900/50 flex items-center justify-between sticky top-0">
              <div className="flex items-center gap-3">
                <Settings className="w-6 h-6 text-green-500" />
                <h2 className="text-xl font-bold text-green-400">INDSTILLINGER</h2>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="p-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Settings Content */}
            <div className="p-6 space-y-6">
              {/* User Settings */}
              <div>
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <User className="w-4 h-4" />
                  BRUGER INDSTILLINGER
                </h3>
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Nickname</label>
                    <input
                      type="text"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Server IP</label>
                    <input
                      type="text"
                      value={serverIp}
                      onChange={(e) => setServerIp(e.target.value)}
                      className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 placeholder-green-800 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all"
                    />
                  </div>
                </div>
              </div>

              {/* Audio Settings */}
              <div className="pt-4 border-t border-green-900/30">
                <h3 className="text-sm text-green-700 mb-4 flex items-center gap-2">
                  <Headphones className="w-4 h-4" />
                  LYD INDSTILLINGER
                </h3>
                <div className="space-y-3 pl-6">
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Mikrofon</label>
                    <select className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option>Default Mikrofon</option>
                      <option>USB Mikrofon</option>
                      <option>Headset Mikrofon</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-green-600 block mb-2">Output</label>
                    <select className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option>Default Output</option>
                      <option>Højtalere</option>
                      <option>Headset</option>
                    </select>
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
                    <select className="w-full bg-[#0a0e0a] border border-green-900/50 rounded-lg px-4 py-2 text-green-500 outline-none focus:border-green-700 focus:ring-2 focus:ring-green-900/50 transition-all">
                      <option>Default Kamera</option>
                      <option>Webcam (Front)</option>
                      <option>USB Kamera</option>
                      <option>Virtual Kamera</option>
                    </select>
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
                    <input
                      type="checkbox"
                      defaultChecked
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50"
                    />
                    <span className="text-sm text-green-500">Aktiver notifikationer</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      defaultChecked
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50"
                    />
                    <span className="text-sm text-green-500">Lyd ved besked</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50"
                    />
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
                    <input
                      type="checkbox"
                      defaultChecked
                      className="w-4 h-4 rounded bg-[#0a0e0a] border-green-900/50 text-green-600 focus:ring-green-900/50"
                    />
                    <span className="text-sm text-green-500">Kompakt mode</span>
                  </label>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-green-900/30 bg-[#0d120d]/40 flex justify-end gap-3">
              <button
                onClick={() => setShowSettings(false)}
                className="px-6 py-2 rounded-lg bg-green-900/20 text-green-600 hover:bg-green-900/40 transition-all"
              >
                Annuller
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="px-6 py-2 rounded-lg bg-green-900/40 text-green-400 hover:bg-green-900/60 transition-all font-bold"
              >
                Gem Ændringer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}