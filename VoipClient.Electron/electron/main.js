const { app, BrowserWindow, ipcMain, desktopCapturer, session, systemPreferences } = require('electron');
const path = require('path');
const net = require('net');
const dgram = require('dgram');

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 960;

let mainWindow = null;
let tcpSocket = null;
let udpSocket = null;
let encoder = null;
let decoder = null;
let OpusScript = null;
let currentBitrate = 96000;
let keepaliveInterval = null;

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
    },
    backgroundColor: '#0a0e0a',
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
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
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0] });
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
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Setup ───────────────────────────────────────────────

function setupIPC() {
  // TCP Chat
  ipcMain.handle('tcp:connect', async (_event, host, port, username, password, isRegister) => {
    return connectChat(host, port, username, password, isRegister);
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
}

// ── TCP Chat ────────────────────────────────────────────────

function connectChat(host, port, username, password, isRegister) {
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
      const cmd = isRegister
        ? `REGISTER:${username}:${password}`
        : `AUTH:${username}:${password}`;
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

let _audioSendCount = 0;
let _audioRecvCount = 0;
let _videoSendCount = 0;
let _videoRecvCount = 0;

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
      const packet = Buffer.concat([Buffer.from([0x01]), Buffer.from(encoded)]);
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
