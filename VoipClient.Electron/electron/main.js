const { app, BrowserWindow, ipcMain } = require('electron');
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
let currentBitrate = 64000;

// ── Window ──────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'MeiChat',
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
  ipcMain.handle('tcp:connect', async (_event, host, port, username) => {
    return connectChat(host, port, username);
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

  ipcMain.on('udp:stop', () => stopVoice());

  ipcMain.on('udp:set-bitrate', (_event, br) => {
    currentBitrate = br;
    if (encoder) {
      try { encoder.setBitrate(br); } catch (e) { console.error('[Opus] setBitrate failed:', e); }
    }
  });
}

// ── TCP Chat ────────────────────────────────────────────────

function connectChat(host, port, username) {
  return new Promise((resolve, reject) => {
    disconnectChat();

    tcpSocket = new net.Socket();
    let buffer = '';

    const timeout = setTimeout(() => {
      tcpSocket.destroy();
      reject(new Error('Connection timeout'));
    }, 10000);

    tcpSocket.connect(port, host, () => {
      clearTimeout(timeout);
      tcpSocket.write(username + '\n');
      console.log(`[TCP] Connected to ${host}:${port} as '${username}'`);
      resolve({ success: true });
    });

    tcpSocket.on('data', (data) => {
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
        if (line) {
          mainWindow?.webContents.send('tcp:message', line);
        }
      }
    });

    tcpSocket.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[TCP] Error:', err.message);
      mainWindow?.webContents.send('tcp:error', err.message);
      reject(err);
    });

    tcpSocket.on('close', () => {
      clearTimeout(timeout);
      console.log('[TCP] Disconnected');
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

        const opusData = msg.slice(1 + nameLen);

        try {
          const pcm = decoder.decode(opusData);
          // Send decoded PCM (Int16 LE bytes) to renderer
          mainWindow?.webContents.send('udp:audio', Buffer.from(pcm));
        } catch (err) {
          console.error('[UDP] Decode error:', err.message);
        }
      });

      udpSocket.on('error', (err) => {
        console.error('[UDP] Socket error:', err.message);
      });

      // Store connection info for sending
      udpSocket._voipHost = host;
      udpSocket._voipPort = port;

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
    const encoded = encoder.encode(pcm, FRAME_SIZE);
    if (encoded && encoded.length > 0) {
      udpSocket.send(encoded, 0, encoded.length, udpSocket._voipPort, udpSocket._voipHost);
    }
  } catch {
    // Silently drop on encode/send errors
  }
}

function stopVoice() {
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
