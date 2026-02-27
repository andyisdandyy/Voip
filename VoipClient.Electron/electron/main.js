const { app, BrowserWindow, ipcMain, desktopCapturer, session, systemPreferences } = require('electron');
const path = require('path');
const net = require('net');
const dgram = require('dgram');

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 960;

// Fix blank/black screen on macOS (Intel GPU compositor issue)
if (process.platform === 'darwin') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-rasterization');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-features', 'UseSkiaRenderer,CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  app.commandLine.appendSwitch('in-process-gpu');
}

let mainWindow = null;
let tcpSocket = null;
let udpSocket = null;
let encoder = null;
let decoder = null;
let OpusScript = null;
let currentBitrate = 96000;
let keepaliveInterval = null;
let selectedShareSource = null;
let shareWithAudio = false;
const autoConnectSockets = new Map(); // serverId → { socket, reconnectTimer }
let _audioSendCount = 0;
let _audioRecvCount = 0;
let _videoSendCount = 0;
let _videoRecvCount = 0;
const AUDIO_TYPE_BYTE = Buffer.from([0x01]);

// ── Window

function createWindow() {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 500,
    ...(isMac
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false, roundedCorners: false }),
    transparent: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
    },
    backgroundColor: '#0a0e0a',
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Force a resize toggle to kick the compositor on Intel Macs
    if (process.platform === 'darwin') {
      const [w, h] = mainWindow.getSize();
      mainWindow.setSize(w + 1, h + 1);
      setTimeout(() => { if (mainWindow) mainWindow.setSize(w, h); }, 100);
    }
  });

  // Safety: show window after timeout even if ready-to-show doesn't fire
  const showTimeout = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      if (process.platform === 'darwin') {
        const [w, h] = mainWindow.getSize();
        mainWindow.setSize(w + 1, h + 1);
        setTimeout(() => { if (mainWindow) mainWindow.setSize(w, h); }, 100);
      }
    }
  }, 5000);
  mainWindow.once('ready-to-show', () => clearTimeout(showTimeout));

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[Window] Content failed to load: ${errorCode} ${errorDescription}`);
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://127.0.0.1:5173');
    if (process.platform === 'darwin') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Request media permissions on macOS
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch {}
    try { await systemPreferences.askForMediaAccess('camera'); } catch {}
  }

  createWindow();
  setupIPC();

  // Allow getDisplayMedia() in renderer by providing a screen source
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      let source;
      if (selectedShareSource) {
        source = sources.find(s => s.id === selectedShareSource) || sources[0];
      } else {
        source = sources.find(s => s.id.startsWith('screen:')) || sources[0];
      }
      const opts = { video: source };
      if (shareWithAudio && process.platform === 'win32') {
        opts.audio = 'loopback';
      }
      callback(opts);
      selectedShareSource = null;
      shareWithAudio = false;
    } catch {
      callback({});
    }
  });

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());
  ipcMain.handle('get-platform', () => process.platform);
  ipcMain.on('window:fullscreen', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  disconnectChat();
  stopVoice();
  stopAllAutoConnect();
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Setup ───────────────────────────────────────────────

function setupIPC() {
  // TCP Chat
  ipcMain.handle('tcp:connect', async (_event, host, port, username, password, isRegister, serverPassword) => {
    return connectChat(host, port, username, password, isRegister, serverPassword);
  });

  ipcMain.on('tcp:send', (_event, message) => {
    if (tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write(message + '\n');
    }
  });

  ipcMain.on('tcp:disconnect', () => disconnectChat());

  // UDP Voice
  ipcMain.handle('udp:start', async (_event, host, port, username) => {
    return startVoice(host, port, username);
  });

  ipcMain.on('udp:send-audio', (_event, pcmArrayBuffer) => {
    sendAudio(pcmArrayBuffer);
  });

  // Video over TCP (reliable delivery)
  ipcMain.on('tcp:send-video', (_event, encodedBuffer, isKeyFrame, codec) => {
    if (!tcpSocket || tcpSocket.destroyed) return;
    const flags = (isKeyFrame ? 0x01 : 0x00) | (codec === 'vp8' ? 0x02 : 0x00);
    const flagsHex = flags.toString(16).padStart(2, '0');
    const base64 = Buffer.from(encodedBuffer).toString('base64');
    tcpSocket.write(`VIDEO:${flagsHex}:${base64}\n`);
    if (++_videoSendCount % 50 === 1) console.log(`[Video/TCP] Sent frame #${_videoSendCount} (${Buffer.from(encodedBuffer).length}B, ${isKeyFrame ? 'KEY' : 'delta'})`);
  });

  ipcMain.on('udp:stop', () => stopVoice());

  ipcMain.on('udp:set-bitrate', (_event, br) => {
    currentBitrate = br;
    if (encoder) {
      try { encoder.setBitrate(br); } catch (e) { console.error('[Opus] setBitrate failed:', e); }
    }
  });

  // Screen source picker
  ipcMain.handle('get-screen-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });
      return sources.map(s => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
        isScreen: s.id.startsWith('screen:'),
      }));
    } catch (err) {
      console.error('[Sources] Failed:', err);
      return [];
    }
  });

  ipcMain.handle('set-share-source', (_event, sourceId, withAudio) => {
    selectedShareSource = sourceId || null;
    shareWithAudio = !!withAudio;
    return true;
  });

  // ── Autoconnect (background mention listener) ──────────────
  ipcMain.on('autoconnect:start', (_event, serverId, host, port, username, password, serverPassword) => {
    stopAutoConnect(serverId);
    startAutoConnect(serverId, host, port, username, password, serverPassword);
  });

  ipcMain.on('autoconnect:stop', (_event, serverId) => {
    stopAutoConnect(serverId);
  });
}

// ── TCP Chat ────────────────────────────────────────────────

function connectChat(host, port, username, password, isRegister, serverPassword) {
  return new Promise((resolve, reject) => {
    disconnectChat();

    tcpSocket = new net.Socket();
    let buffer = '';
    let authResolved = false;

    const timeout = setTimeout(() => {
      tcpSocket.destroy();
      reject(new Error('Connection timeout'));
    }, 10000);

    tcpSocket.connect(port, host, () => {
      tcpSocket.setNoDelay(true);
      tcpSocket.setKeepAlive(true, 30000);
      const prefix = isRegister ? 'REGISTER' : 'AUTH';
      const cmd = serverPassword
        ? `${prefix}:${username}:${password}:${serverPassword}`
        : `${prefix}:${username}:${password}`;
      tcpSocket.write(cmd + '\n');
      console.log(`[TCP] Connected to ${host}:${port}, sent ${isRegister ? 'REGISTER' : 'AUTH'}`);
    });

    tcpSocket.on('data', (data) => {
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
        if (!line) continue;

        if (!authResolved) {
          if (line === 'AUTH_OK' || line === 'REGISTER_OK') {
            clearTimeout(timeout);
            authResolved = true;
            resolve({ success: true });
          } else if (line.startsWith('AUTH_FAIL:') || line.startsWith('REGISTER_FAIL:')) {
            clearTimeout(timeout);
            authResolved = true;
            tcpSocket.destroy();
            tcpSocket = null;
            reject(new Error(line.substring(line.indexOf(':') + 1)));
            return;
          }
          continue;
        }
        // Intercept video frames from server — decode base64 and send binary to renderer
        if (line.startsWith('VIDEO:')) {
          // VIDEO:<sender>:<flagsHex>:<base64data>
          const i1 = line.indexOf(':', 6);
          const i2 = i1 >= 0 ? line.indexOf(':', i1 + 1) : -1;
          if (i1 >= 0 && i2 >= 0) {
            const senderName = line.substring(6, i1);
            const flags = parseInt(line.substring(i1 + 1, i2), 16);
            const isKeyFrame = (flags & 0x01) !== 0;
            const codec = (flags & 0x02) ? 'vp8' : 'h264';
            const encodedData = Buffer.from(line.substring(i2 + 1), 'base64');
            mainWindow?.webContents.send('udp:video', senderName, encodedData, isKeyFrame, codec);
            if (++_videoRecvCount % 50 === 1) console.log(`[Video/TCP] Recv #${_videoRecvCount} from '${senderName}' (${encodedData.length}B, ${isKeyFrame ? 'KEY' : 'delta'})`);
          }
          continue;
        }
        mainWindow?.webContents.send('tcp:message', line);
      }
    });

    tcpSocket.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[TCP] Error:', err.message);
      if (!authResolved) reject(err);
      mainWindow?.webContents.send('tcp:error', err.message);
    });

    tcpSocket.on('close', () => {
      clearTimeout(timeout);
      console.log('[TCP] Disconnected');
      if (!authResolved) reject(new Error('Connection closed before authentication'));
      mainWindow?.webContents.send('tcp:disconnected');
    });
  });
}

function disconnectChat() {
  if (tcpSocket) {
    tcpSocket.destroy();
    tcpSocket = null;
  }
}

// ── Autoconnect (background mention listener) ───────────────

function startAutoConnect(serverId, host, port, username, password, serverPassword) {
  const socket = new net.Socket();
  let buffer = '';
  let authed = false;
  let destroyed = false;

  const entry = { socket, reconnectTimer: null };
  autoConnectSockets.set(serverId, entry);

  const reconnect = () => {
    if (destroyed) return;
    entry.reconnectTimer = setTimeout(() => {
      if (autoConnectSockets.has(serverId)) {
        startAutoConnect(serverId, host, port, username, password, serverPassword);
      }
    }, 15000);
  };

  socket.connect(port, host, () => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    const cmd = serverPassword
      ? `AUTH:${username}:${password}:${serverPassword}`
      : `AUTH:${username}:${password}`;
    socket.write(cmd + '\n');
    console.log(`[AutoConnect:${serverId}] Connected to ${host}:${port}`);
  });

  socket.on('data', (data) => {
    buffer += data.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
      if (!line) continue;

      if (!authed) {
        if (line === 'AUTH_OK' || line === 'REGISTER_OK') {
          authed = true;
          console.log(`[AutoConnect:${serverId}] Authenticated`);
        } else if (line.startsWith('AUTH_FAIL:') || line.startsWith('REGISTER_FAIL:')) {
          console.error(`[AutoConnect:${serverId}] Auth failed: ${line}`);
          socket.destroy();
          return;
        }
        continue;
      }

      // Listen for mentions
      if (line.startsWith('MENTION:')) {
        // MENTION:<room>:<sender>:<text>
        const i1 = line.indexOf(':', 8);
        const i2 = i1 >= 0 ? line.indexOf(':', i1 + 1) : -1;
        if (i1 >= 0 && i2 >= 0) {
          const room = line.substring(8, i1);
          const sender = line.substring(i1 + 1, i2);
          const text = line.substring(i2 + 1);
          console.log(`[AutoConnect:${serverId}] Mention from ${sender} in ${room}`);
          mainWindow?.webContents.send('autoconnect:mention', serverId, room, sender, text);
        }
      }
    }
  });

  socket.on('error', (err) => {
    console.error(`[AutoConnect:${serverId}] Error: ${err.message}`);
  });

  socket.on('close', () => {
    console.log(`[AutoConnect:${serverId}] Disconnected`);
    if (!destroyed) reconnect();
  });
}

function stopAutoConnect(serverId) {
  const entry = autoConnectSockets.get(serverId);
  if (entry) {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    try { entry.socket.destroy(); } catch {}
    autoConnectSockets.delete(serverId);
    console.log(`[AutoConnect:${serverId}] Stopped`);
  }
}

function stopAllAutoConnect() {
  for (const [id] of autoConnectSockets) stopAutoConnect(id);
}

// ── UDP Voice ───────────────────────────────────────────────

function startVoice(host, port, username) {
  return new Promise((resolve, reject) => {
    try {
      stopVoice();

      // Initialize Opus codec
      try {
        OpusScript = require('opusscript');
        encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
        encoder.setBitrate(currentBitrate);
        // Max complexity for best quality
        try { encoder.encoderCTL(4010, 10); } catch {}
        // Enable in-band FEC for packet loss resilience
        try { encoder.encoderCTL(4012, 1); } catch {}
        // Expect ~5% packet loss
        try { encoder.encoderCTL(4014, 5); } catch {}
        decoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
      } catch (err) {
        console.error('[Opus] Init failed:', err.message);
        reject(new Error('Opus initialization failed — run: npm install opusscript'));
        return;
      }

      udpSocket = dgram.createSocket('udp4');

      // Send HELLO handshake
      const nonce = Math.random().toString(36).substring(2, 15);
      const hello = Buffer.from(`HELLO:${nonce}:${username}`);
      udpSocket.send(hello, 0, hello.length, port, host, (err) => {
        if (err) console.error('[UDP] HELLO send error:', err.message);
        else console.log(`[UDP] Sent HELLO to ${host}:${port}`);
      });

      udpSocket.on('message', (msg) => {
        // Check for handshake responses
        const prefix = msg.toString('utf8', 0, Math.min(msg.length, 8));
        if (prefix.startsWith('WELCOME:')) {
          console.log('[UDP] Handshake complete');
          mainWindow?.webContents.send('udp:connected');
          return;
        }
        if (prefix.startsWith('GOODBYE')) return;

        // Tagged audio: [nameLen:1][name:N][opus data]
        if (msg.length < 3) return;
        const nameLen = msg[0];
        if (nameLen <= 0 || nameLen > 64 || msg.length < 1 + nameLen + 1) return;

        // Validate name bytes are printable
        let validName = true;
        for (let i = 1; i < 1 + nameLen; i++) {
          if (msg[i] < 0x20 && msg[i] !== 0x09) { validName = false; break; }
        }
        if (!validName) return;

        const senderName = msg.toString('utf8', 1, 1 + nameLen);
        const typeByte = msg[1 + nameLen];
        const payload = msg.slice(2 + nameLen);

        if (typeByte === 0x01) {
          // Audio
          try {
            const pcm = decoder.decode(payload);
            mainWindow?.webContents.send('udp:audio', Buffer.from(pcm));
            if (++_audioRecvCount % 250 === 1) console.log(`[Audio] Recv #${_audioRecvCount} from '${senderName}' (${payload.length}B)`);
          } catch (err) {
            console.error('[UDP] Decode error:', err.message);
          }
        }
      });

      udpSocket.on('error', (err) => {
        console.error('[UDP] Socket error:', err.message);
      });

      // Store connection info for sending
      udpSocket._voipHost = host;
      udpSocket._voipPort = port;

      // Start UDP keepalive to prevent server timeout
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      keepaliveInterval = setInterval(() => {
        if (udpSocket) {
          try {
            const ping = Buffer.from('KEEPALIVE');
            udpSocket.send(ping, 0, ping.length, udpSocket._voipPort, udpSocket._voipHost);
          } catch {}
        }
      }, 10000);

      resolve({ success: true });
    } catch (err) {
      reject(err);
    }
  });
}

function sendAudio(pcmArrayBuffer) {
  if (!udpSocket || !encoder) return;

  try {
    const pcm = Buffer.from(pcmArrayBuffer);
    if (pcm.length !== FRAME_SIZE * 2) {
      if (_audioSendCount === 0) console.warn(`[Audio] Unexpected PCM size: ${pcm.length} (expected ${FRAME_SIZE * 2})`);
      return;
    }
    const encoded = encoder.encode(pcm, FRAME_SIZE);
    if (encoded && encoded.length > 0) {
      const packet = Buffer.concat([AUDIO_TYPE_BYTE, encoded]);
      udpSocket.send(packet, 0, packet.length, udpSocket._voipPort, udpSocket._voipHost);
      if (++_audioSendCount % 250 === 1) console.log(`[Audio] Sent packet #${_audioSendCount} (${encoded.length} bytes opus)`);
    }
  } catch (err) {
    console.error('[Audio] Encode/send error:', err.message);
  }
}

function stopVoice() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
  if (udpSocket) {
    try {
      const goodbye = Buffer.from('GOODBYE');
      udpSocket.send(goodbye, 0, goodbye.length, udpSocket._voipPort, udpSocket._voipHost);
    } catch {}
    try { udpSocket.close(); } catch {}
    udpSocket = null;
  }
  if (encoder) { try { encoder.delete(); } catch {} encoder = null; }
  if (decoder) { try { decoder.delete(); } catch {} decoder = null; }
}
