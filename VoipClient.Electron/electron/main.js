const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
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
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    transparent: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0a0e0a',
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

app.whenReady().then(() => {
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

  ipcMain.on('udp:send-video', (_event, jpegArrayBuffer) => {
    sendVideoFrame(jpegArrayBuffer);
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
        } else if (typeByte === 0x02) {
          // Video — chunked: [frameId:2][chunkIdx:1][totalChunks:1][data...]
          if (payload.length < 4) return;
          const frameId = payload.readUInt16BE(0);
          const chunkIdx = payload[2];
          const totalChunks = payload[3];
          const chunkData = payload.slice(4);
          if (totalChunks === 0 || chunkIdx >= totalChunks) return;

          const frameKey = `${senderName}:${frameId}`;
          if (!_videoFrameBuffer[frameKey]) {
            _videoFrameBuffer[frameKey] = {
              chunks: new Array(totalChunks),
              received: new Set(),
              total: totalChunks,
              ts: Date.now(),
            };
          }
          const frame = _videoFrameBuffer[frameKey];
          frame.chunks[chunkIdx] = chunkData;
          frame.received.add(chunkIdx);

          if (frame.received.size === frame.total) {
            const fullJpeg = Buffer.concat(frame.chunks);
            mainWindow?.webContents.send('udp:video', senderName, fullJpeg);
            delete _videoFrameBuffer[frameKey];
            if (++_videoRecvCount % 50 === 1) console.log(`[Video] Recv #${_videoRecvCount} from '${senderName}' (${fullJpeg.length}B, ${frame.total} chunks)`);

            // Cleanup stale incomplete frames for this sender
            const now = Date.now();
            for (const key of Object.keys(_videoFrameBuffer)) {
              if (key.startsWith(senderName + ':') && now - _videoFrameBuffer[key].ts > 2000) {
                delete _videoFrameBuffer[key];
              }
            }
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
let _videoFrameId = 0;

// Video chunk reassembly: key = 'sender:frameId' -> { chunks[], received Set, total, ts }
const _videoFrameBuffer = {};
const VIDEO_CHUNK_SIZE = 60000; // keep each UDP packet under ~60KB to avoid fragmentation

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

function sendVideoFrame(jpegArrayBuffer) {
  if (!udpSocket) return;
  try {
    const jpeg = Buffer.from(jpegArrayBuffer);
    const totalChunks = Math.ceil(jpeg.length / VIDEO_CHUNK_SIZE);
    if (totalChunks > 255) { console.warn('[Video] Frame too large, skipping'); return; }
    const frameId = (_videoFrameId++) & 0xFFFF;

    for (let i = 0; i < totalChunks; i++) {
      const offset = i * VIDEO_CHUNK_SIZE;
      const chunk = jpeg.slice(offset, offset + VIDEO_CHUNK_SIZE);
      // Packet: [type:0x02][frameId:2 BE][chunkIdx:1][totalChunks:1][data...]
      const header = Buffer.alloc(5);
      header[0] = 0x02;
      header.writeUInt16BE(frameId, 1);
      header[3] = i;
      header[4] = totalChunks;
      const packet = Buffer.concat([header, chunk]);
      udpSocket.send(packet, 0, packet.length, udpSocket._voipPort, udpSocket._voipHost);
    }
    if (++_videoSendCount % 50 === 1) console.log(`[Video] Sent frame #${_videoSendCount} (${jpeg.length}B, ${totalChunks} chunk${totalChunks > 1 ? 's' : ''})`);
  } catch (err) {
    console.error('[Video] Send error:', err.message);
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
