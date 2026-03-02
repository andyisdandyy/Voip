const { app, BrowserWindow, ipcMain, desktopCapturer, session, systemPreferences } = require('electron');
const path = require('path');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const nodeCrypto = require('crypto');
const { autoUpdater } = require('electron-updater');

// ══════════════════════════════════════════════════════════════
//  Voip Electron Main Process
//  Handles: TCP chat, UDP voice, E2EE encryption, TLS negotiation,
//  video relay, screen sharing, and background autoconnect sockets.
// ══════════════════════════════════════════════════════════════

// Cached per host:port — avoids repeating the TLS probe every reconnect
const _tlsCapable = new Map(); // "host:port" → true|false

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 960;

// Common macOS fixes
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// Linux: enable Wayland support via Ozone platform auto-detection.
// Also enable PipeWire screen capture (used by Wayland compositors).
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,PipeWireV4L2');
}

let mainWindow = null;
let tcpSocket = null;
let udpSocket = null;
let encoder = null;
let decoder = null;
let OpusScript = null;
let currentBitrate = 96000;
let keepaliveInterval = null;
let tcpPingInterval = null;
let backgroundPingInterval = null;
let selectedShareSource = null;
let shareWithAudio = false;
let shareIsWindow = false;
let e2eeKey = null; // Derived AES-256 key buffer (32 bytes) or null
let backgroundTcpSocket = null; // Parked TCP for voice preservation during server switch
const popoutWindows = new Map(); // username → BrowserWindow

// ── E2EE (End-to-End Encryption) ────────────────────────────
// Uses AES-256-GCM with a PBKDF2-derived key. When enabled, audio
// and video payloads are encrypted before sending and decrypted on
// receipt. Peers without the key receive raw (unencrypted) data.

function setE2eeKey(passphrase) {
  if (!passphrase) { e2eeKey = null; return; }
  e2eeKey = nodeCrypto.pbkdf2Sync(passphrase, 'voip-e2ee-v1', 100000, 32, 'sha256');
  console.log('[E2EE] Key derived');
}

function e2eeEncrypt(data) {
  if (!e2eeKey) return data;
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', e2eeKey, iv);
  const enc = cipher.update(data);
  cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function e2eeDecrypt(data) {
  if (!e2eeKey) return data;
  if (data.length < 28) return data; // too short to be encrypted
  const iv = data.slice(0, 12);
  const tag = data.slice(12, 28);
  const ct = data.slice(28);
  try {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', e2eeKey, iv);
    decipher.setAuthTag(tag);
    const dec = decipher.update(ct);
    decipher.final();
    return dec;
  } catch {
    return data; // decryption failed — return raw (unencrypted peer)
  }
}
const autoConnectSockets = new Map(); // serverId → { socket, reconnectTimer }
let _audioSendCount = 0;
let _audioRecvCount = 0;
let _videoSendCount = 0;
let _videoRecvCount = 0;
// ── Packet type prefix for multiplexing audio over UDP ──────
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
  });

  // Safety: show window after timeout even if ready-to-show doesn't fire
  const showTimeout = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
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
  setupAutoUpdater();

  // Allow getDisplayMedia() in renderer by providing a screen source
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      // On Wayland, desktopCapturer returns empty — let the PipeWire portal handle it
      if (sources.length === 0) {
        callback({ video: true });
        selectedShareSource = null;
        shareWithAudio = false;
        shareIsWindow = false;
        return;
      }
      let source;
      if (selectedShareSource) {
        source = sources.find(s => s.id === selectedShareSource) || sources[0];
      } else {
        source = sources.find(s => s.id.startsWith('screen:')) || sources[0];
      }
      const opts = { video: source };
      if (shareWithAudio && (process.platform === 'win32' || process.platform === 'linux')) {
        // Windows: loopback / loopbackWithMute for system / per-app audio
        // Linux (PipeWire): same mechanism works via PipeWire portal
        opts.audio = shareIsWindow ? 'loopbackWithMute' : 'loopback';
      }
      callback(opts);
      selectedShareSource = null;
      shareWithAudio = false;
      shareIsWindow = false;
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
  fullDisconnect();
  stopAllAutoConnect();
  if (process.platform !== 'darwin') app.quit();
});

// ── Auto-Updater ────────────────────────────────────────────
// Uses electron-updater to check GitHub Releases for new versions.
// Downloads updates in the background and notifies the renderer
// so the UI can prompt the user to restart.

function setupAutoUpdater() {
  if (!app.isPackaged) return; // skip in dev

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: ${info.version}`);
    mainWindow?.webContents.send('updater:available', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] Up to date');
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('updater:progress', Math.round(progress.percent));
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update downloaded: ${info.version}`);
    mainWindow?.webContents.send('updater:downloaded', info.version);
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
  });

  // Check immediately, then every 30 minutes
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30 * 60 * 1000);
}

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

  ipcMain.on('tcp:disconnect', () => fullDisconnect());

  // Diagnostics
  ipcMain.on('tcp:diag', () => {
    if (tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write('CMD:DIAG\n');
    }
  });

  // E2EE key
  ipcMain.on('e2ee:set-key', (_event, passphrase) => setE2eeKey(passphrase));

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
    const raw = Buffer.from(encodedBuffer);
    const payload = e2eeEncrypt(raw);
    const base64 = payload.toString('base64');
    tcpSocket.write(`VIDEO:${flagsHex}:${base64}\n`);
    if (++_videoSendCount % 50 === 1) console.log(`[Video/TCP] Sent frame #${_videoSendCount} (${raw.length}B, ${isKeyFrame ? 'KEY' : 'delta'})`);
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
    // Track whether the source is a window (not a screen) for per-app audio
    shareIsWindow = sourceId ? !sourceId.startsWith('screen:') : false;
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

  // ── Auto-Updater IPC ──────────────────────────────────────
  ipcMain.on('updater:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.on('updater:check', () => {
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
  });

  ipcMain.handle('get-app-version', () => app.getVersion());

  // ── Video Pop-out ─────────────────────────────────────────
  ipcMain.handle('popout:open', (_event, username) => {
    if (popoutWindows.has(username)) {
      const existing = popoutWindows.get(username);
      if (!existing.isDestroyed()) { existing.focus(); return; }
      popoutWindows.delete(username);
    }
    const win = new BrowserWindow({
      width: 800,
      height: 500,
      minWidth: 320,
      minHeight: 240,
      frame: false,
      backgroundColor: '#0a0e0a',
      webPreferences: {
        preload: path.join(__dirname, 'popout-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win._popoutUsername = username;
    win.loadFile(path.join(__dirname, 'popout-video.html'));
    win.on('closed', () => {
      popoutWindows.delete(username);
      mainWindow?.webContents.send('popout:closed', username);
    });
    popoutWindows.set(username, win);
    console.log(`[Popout] Opened for ${username}`);
  });

  ipcMain.on('popout:close', (_event, username) => {
    const win = popoutWindows.get(username);
    if (win && !win.isDestroyed()) win.close();
    popoutWindows.delete(username);
  });

  ipcMain.handle('popout:get-info', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return { username: win?._popoutUsername || 'Video' };
  });

  ipcMain.on('popout:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on('popout:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
  });
  ipcMain.on('popout:close-self', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });
}

// ── TCP Chat ────────────────────────────────────────────────

// ── TCP Chat Connection ─────────────────────────────────────
// Connects to the server over TCP (with automatic TLS negotiation).
// Handshake phases: (1) server password, (2) user authentication.
// After auth, relays chat messages and video frames between
// the server and the renderer process.

function connectChat(host, port, username, password, isRegister, serverPassword) {
  return new Promise((resolve, reject) => {
    // If voice is active, park the current TCP socket instead of destroying it
    // (keeps the server thinking we're still connected = voice room preserved)
    if (tcpSocket && !tcpSocket.destroyed && udpSocket) {
      tcpSocket.removeAllListeners();
      tcpSocket.on('data', () => {}); // consume data silently
      tcpSocket.on('error', () => {});
      tcpSocket.on('close', () => {
        backgroundTcpSocket = null;
        if (backgroundPingInterval) { clearInterval(backgroundPingInterval); backgroundPingInterval = null; }
      });
      if (backgroundTcpSocket) try { backgroundTcpSocket.destroy(); } catch {}
      if (backgroundPingInterval) { clearInterval(backgroundPingInterval); backgroundPingInterval = null; }
      backgroundTcpSocket = tcpSocket;
      // Keep the parked socket alive with pings so NAT/firewalls don't drop it
      backgroundPingInterval = setInterval(() => {
        if (backgroundTcpSocket && !backgroundTcpSocket.destroyed) {
          backgroundTcpSocket.write('CMD:PING\n');
        }
      }, 60000);
      tcpSocket = null;
      console.log('[TCP] Parked connection (voice active)');
    } else {
      disconnectChat();
    }

    let buffer = '';
    let serverPwDone = false; // Phase 1 complete
    let settled = false;      // Promise already resolved/rejected
    let tlsActive = false;    // True while connected via TLS (for close-fallback)

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    const timeout = setTimeout(() => {
      if (tcpSocket) tcpSocket.destroy();
      settle(() => reject(new Error('Connection timeout')));
    }, 10000);

    const onConnected = (isTls) => {
      tlsActive = isTls;
      tcpSocket.setNoDelay(true);
      tcpSocket.setKeepAlive(true, 30000);
      console.log(`[TCP] Connected to ${host}:${port}${isTls ? ' (TLS)' : ''}, waiting for server handshake`);
      // Don't send AUTH yet — wait for server's READY or SERVER_PASSWORD_REQUIRED
    };

    const setupEvents = () => {
      tcpSocket.on('data', (data) => {
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
        if (!line) continue;

        // ── Phase 1: Server password handshake ──
        if (!serverPwDone) {
          if (line === 'SERVER_PASSWORD_REQUIRED') {
            if (!serverPassword) {
              // No password provided — tell the UI to prompt
              settle(() => reject(new Error('SERVER_PASSWORD_REQUIRED')));
              try { tcpSocket.destroy(); } catch {}
              tcpSocket = null;
              return;
            }
            tcpSocket.write(`SERVER_PASSWORD:${serverPassword}\n`);
            console.log('[TCP] Server password required — sent password');
            continue;
          }
          if (line === 'SERVER_PASSWORD_OK' || line === 'READY') {
            serverPwDone = true;
            // Now send AUTH/REGISTER (without server password)
            const prefix = isRegister ? 'REGISTER' : 'AUTH';
            tcpSocket.write(`${prefix}:${username}:${password}\n`);
            console.log(`[TCP] ${line === 'READY' ? 'No server password needed' : 'Server password accepted'}, sent ${prefix}`);
            continue;
          }
          if (line.startsWith('SERVER_PASSWORD_FAIL:')) {
            settle(() => reject(new Error('SERVER_PASSWORD_FAIL')));
            try { tcpSocket.destroy(); } catch {}
            tcpSocket = null;
            return;
          }
          continue;
        }

        // ── Phase 2: User authentication ──
        if (!settled) {
          if (line === 'AUTH_OK' || line === 'REGISTER_OK') {
            // Start application-level keepalive to survive NAT/firewall idle timeouts
            if (tcpPingInterval) clearInterval(tcpPingInterval);
            tcpPingInterval = setInterval(() => {
              if (tcpSocket && !tcpSocket.destroyed) tcpSocket.write('CMD:PING\n');
            }, 60000);
            settle(() => resolve({ success: true }));
          } else if (line.startsWith('AUTH_FAIL:') || line.startsWith('REGISTER_FAIL:')) {
            settle(() => reject(new Error(line.substring(line.indexOf(':') + 1))));
            try { tcpSocket.destroy(); } catch {}
            tcpSocket = null;
            return;
          }
          continue;
        }

        // ── Post-auth: normal message handling ──
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
            const raw = Buffer.from(line.substring(i2 + 1), 'base64');
            const encodedData = e2eeDecrypt(raw);
            mainWindow?.webContents.send('udp:video', senderName, encodedData, isKeyFrame, codec);
            const popWin = popoutWindows.get(senderName);
            if (popWin && !popWin.isDestroyed()) {
              popWin.webContents.send('popout:video-frame', encodedData, isKeyFrame, codec);
            }
            if (++_videoRecvCount % 50 === 1) console.log(`[Video/TCP] Recv #${_videoRecvCount} from '${senderName}' (${encodedData.length}B, ${isKeyFrame ? 'KEY' : 'delta'})`);
          }
          continue;
        }
        // Suppress keepalive response
        if (line === 'PONG') continue;
        // Log diagnostics to console
        if (line.startsWith('DIAG:')) {
          console.log('[DIAG]', line.substring(5));
        }
        mainWindow?.webContents.send('tcp:message', line);
      }
    });

    tcpSocket.on('error', (err) => {
      console.error('[TCP] Error:', err.message);
      if (!settled) {
        settle(() => reject(err));
        mainWindow?.webContents.send('tcp:error', err.message);
      }
    });

    tcpSocket.on('close', () => {
      console.log('[TCP] Disconnected');
      // TLS connected but server closed before sending any data — the "TLS"
      // may have been accepted by a middlebox/NGINX while the actual server
      // is plain TCP.  Retry without TLS.
      if (tlsActive && !serverPwDone && !settled) {
        console.log('[TCP] TLS session closed before server handshake, retrying as plain TCP');
        _tlsCapable.set(`${host}:${port}`, false);
        tlsActive = false;
        buffer = '';
        tcpSocket = new net.Socket();
        setupEvents();
        tcpSocket.connect(port, host, () => onConnected(false));
        return;
      }
      if (!settled) {
        settle(() => reject(new Error('Connection closed before authentication')));
      }
      mainWindow?.webContents.send('tcp:disconnected');
    });
    }; // end setupEvents

    const key = `${host}:${port}`;
    const knownPlain = _tlsCapable.get(key) === false;

    if (knownPlain) {
      // Known plain-TCP server — connect directly
      tcpSocket = new net.Socket();
      setupEvents();
      tcpSocket.connect(port, host, () => onConnected(false));
    } else {
      // Try TLS first, fall back to plain TCP on handshake failure
      tcpSocket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        _tlsCapable.set(key, true);
        onConnected(true);
      });
      setupEvents();
      const origError = tcpSocket.listeners('error').slice(-1)[0];
      tcpSocket.removeListener('error', origError);
      tcpSocket.once('error', (err) => {
        // Only fall back to plain TCP on TLS-specific handshake errors.
        // Connection errors (ECONNREFUSED, ETIMEDOUT, etc.) mean the server
        // is unreachable — retrying plain TCP would just fail again.
        const isTlsError = !settled && (
          err.code === 'ECONNRESET' ||
          err.code === 'EPROTO' ||
          (err.code && err.code.startsWith('ERR_SSL_')) ||
          (err.message && (err.message.includes('ssl') || err.message.includes('SSL') || err.message.includes('wrong version') || err.message.includes('alert') || err.message.includes('routines')))
        );
        if (isTlsError) {
          console.log(`[TCP] TLS handshake failed (${err.code || err.message}), falling back to plain TCP`);
          _tlsCapable.set(key, false);
          // Remove all listeners from the old TLS socket so its 'close' event
          // doesn't race with the new connection and reject the promise.
          try { tcpSocket.removeAllListeners(); tcpSocket.destroy(); } catch {}
          tcpSocket = new net.Socket();
          setupEvents();
          tcpSocket.connect(port, host, () => onConnected(false));
        } else {
          // Real connection error — pass through to the normal error handler
          origError(err);
        }
      });
    }
  });
}

function disconnectChat() {
  if (tcpPingInterval) { clearInterval(tcpPingInterval); tcpPingInterval = null; }
  if (tcpSocket) {
    tcpSocket.destroy();
    tcpSocket = null;
  }
}

function killBackground() {
  if (backgroundPingInterval) { clearInterval(backgroundPingInterval); backgroundPingInterval = null; }
  if (backgroundTcpSocket) {
    try { backgroundTcpSocket.destroy(); } catch {}
    backgroundTcpSocket = null;
    console.log('[TCP] Background socket killed');
  }
}

function closeAllPopouts() {
  for (const [, win] of popoutWindows) {
    if (!win.isDestroyed()) win.close();
  }
  popoutWindows.clear();
}

function fullDisconnect() {
  disconnectChat();
  killBackground();
  stopVoice();
  closeAllPopouts();
}

// ── Autoconnect (background mention listener) ───────────────
// Maintains a lightweight TCP connection per pinned server to receive
// @mention notifications. Automatically reconnects every 15 seconds
// on disconnect. Stopped via stopAutoConnect() or stopAllAutoConnect().

function startAutoConnect(serverId, host, port, username, password, serverPassword) {
  let buffer = '';
  let serverPwDone = false;
  let authed = false;

  const setupSocket = (socket) => {
    const entry = { socket, reconnectTimer: null };
    autoConnectSockets.set(serverId, entry);

    const reconnect = () => {
      // Only reconnect if this entry is still the active one for this serverId
      if (autoConnectSockets.get(serverId) !== entry) return;
      entry.reconnectTimer = setTimeout(() => {
        if (autoConnectSockets.get(serverId) === entry) {
          startAutoConnect(serverId, host, port, username, password, serverPassword);
        }
      }, 15000);
    };

    socket.on('data', (data) => {
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
        if (!line) continue;

        // Phase 1: Server password
        if (!serverPwDone) {
          if (line === 'SERVER_PASSWORD_REQUIRED') {
            if (!serverPassword) {
              console.log(`[AutoConnect:${serverId}] Server requires password — skipping`);
              socket.destroy();
              return;
            }
            socket.write(`SERVER_PASSWORD:${serverPassword}\n`);
            continue;
          }
          if (line === 'SERVER_PASSWORD_OK' || line === 'READY') {
            serverPwDone = true;
            socket.write(`AUTH:${username}:${password}\n`);
            continue;
          }
          if (line.startsWith('SERVER_PASSWORD_FAIL:')) {
            console.error(`[AutoConnect:${serverId}] Server password failed: ${line}`);
            socket.destroy();
            return;
          }
          continue;
        }

        // Phase 2: Auth
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
      reconnect();
    });
  };

  const key = `${host}:${port}`;
  if (_tlsCapable.get(key) === false) {
    const socket = new net.Socket();
    setupSocket(socket);
    socket.connect(port, host, () => {
      console.log(`[AutoConnect:${serverId}] Connected to ${host}:${port}`);
      // Don't send AUTH — wait for server handshake
    });
  } else {
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      _tlsCapable.set(key, true);
      console.log(`[AutoConnect:${serverId}] Connected to ${host}:${port} (TLS)`);
      // Don't send AUTH — wait for server handshake
    });
    socket.once('error', (err) => {
      const msg = err.message || '';
      if (!authed && (
        err.code === 'ECONNRESET' ||
        err.code === 'EPROTO' ||
        (err.code && err.code.startsWith('ERR_SSL_')) ||
        msg.includes('ssl') || msg.includes('SSL') || msg.includes('wrong version') || msg.includes('routines')
      )) {
        console.log(`[AutoConnect:${serverId}] TLS failed, falling back to plain TCP`);
        _tlsCapable.set(key, false);
        try { socket.removeAllListeners(); socket.destroy(); } catch {}
        // Retry with plain TCP
        startAutoConnect(serverId, host, port, username, password, serverPassword);
        return;
      }
    });
    setupSocket(socket);
  }
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
// Connects a UDP socket to the voice server. Sends/receives Opus-
// encoded audio frames with optional E2EE. A periodic KEEPALIVE
// prevents the server from timing out the client.

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
          // Audio — decrypt if E2EE, then opus decode
          try {
            const decrypted = e2eeDecrypt(payload);
            const pcm = decoder.decode(decrypted);
            mainWindow?.webContents.send('udp:audio', senderName, Buffer.from(pcm));
            if (++_audioRecvCount % 250 === 1) console.log(`[Audio] Recv #${_audioRecvCount} from '${senderName}' (${payload.length}B wire)`);
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
      const keepaliveBuffer = Buffer.from('KEEPALIVE');
      keepaliveInterval = setInterval(() => {
        if (udpSocket) {
          try {
            udpSocket.send(keepaliveBuffer, 0, keepaliveBuffer.length, udpSocket._voipPort, udpSocket._voipHost);
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
      const payload = e2eeEncrypt(Buffer.from(encoded));
      const packet = Buffer.concat([AUDIO_TYPE_BYTE, payload]);
      udpSocket.send(packet, 0, packet.length, udpSocket._voipPort, udpSocket._voipHost);
      if (++_audioSendCount % 250 === 1) console.log(`[Audio] Sent packet #${_audioSendCount} (${encoded.length}B opus, ${payload.length}B wire)`);
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
