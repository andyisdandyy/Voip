const { app, BrowserWindow, ipcMain, desktopCapturer, session, systemPreferences } = require('electron');
const path = require('path');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const nodeCrypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');

// ── Bundled FFmpeg/FFprobe binaries ─────────────────────────
// ffmpeg-static / ffprobe-static provide platform-specific binaries.
// In production the asar path must be fixed to the unpacked copy.
function asarFix(p) { return p ? p.replace('app.asar', 'app.asar.unpacked') : p; }
let _ffmpegPath, _ffprobePath;
try { _ffmpegPath = asarFix(require('ffmpeg-static')); } catch { _ffmpegPath = null; }
try { _ffprobePath = asarFix(require('ffprobe-static').path); } catch { _ffprobePath = null; }

// ── Native WASAPI loopback (Windows 10 2004+) ───────────────
// Window share → INCLUDE mode: captures only the shared app's audio.
// Screen share → EXCLUDE mode: captures all system audio except Electron.
let audioLoopback;
try {
  audioLoopback = require('../native/audio-loopback');
} catch {
  audioLoopback = { startCapture: () => {}, stopCapture: () => {}, isSupported: () => false, getWindowPid: () => 0, drainQueue: () => [] };
}

// ══════════════════════════════════════════════════════════════
//  Echo Electron Main Process
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
  app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
}

// Windows: disable WGC (Windows Graphics Capture) to avoid
// "ProcessFrame failed" errors (E_FAIL 0x80004005) that cause frame
// drops during screen sharing. Falls back to DXGI Desktop Duplication
// which is more stable across GPU drivers.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'WGCCapturerWin,AllowWgcScreenCapturer,AllowWgcWindowCapturer,AllowWgcDesktopCapturer');
  app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
  app.setAppUserModelId('Echo');
}

// Linux: enable Wayland support via Ozone platform auto-detection.
// Also enable PipeWire screen capture (used by Wayland compositors).
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,PipeWireV4L2,PlatformHEVCDecoderSupport');
}

let mainWindow = null;
// ── Per-server TCP connections (multi-server) ──────────────
// Each entry: { socket, username, pingInterval, e2eeKey }
const tcpConnections = new Map(); // serverId → connection state
let activeVoiceServerId = null;   // Which serverId owns the active voice session
let udpSocket = null;
let voiceCodec = null;   // OpusScript mono — encode+decode voice
let screenCodec = null;  // OpusScript stereo — encode+decode screen audio
let OpusScript = null;
let currentBitrate = 96000;
let keepaliveInterval = null;
let selectedShareSource = null;
let shareWithAudio = false;
let shareIsWindow = false;
const popoutWindows = new Map(); // username → BrowserWindow

// ── E2EE (End-to-End Encryption) ────────────────────────────
// Uses AES-256-GCM with a PBKDF2-derived key. When enabled, audio
// and video payloads are encrypted before sending and decrypted on
// receipt. Peers without the key receive raw (unencrypted) data.
// In multi-server mode each connection has its own independent key.

function setE2eeKeyForServer(serverId, passphrase) {
  const conn = tcpConnections.get(serverId);
  if (!conn) return;
  if (!passphrase) { conn.e2eeKey = null; return; }
  conn.e2eeKey = nodeCrypto.pbkdf2Sync(passphrase, 'voip-e2ee-v1', 100000, 32, 'sha256');
  console.log(`[E2EE:${serverId}] Key derived`);
}

function getVoiceE2eeKey() {
  if (!activeVoiceServerId) return null;
  return tcpConnections.get(activeVoiceServerId)?.e2eeKey || null;
}

function e2eeEncrypt(data, key) {
  if (!key) return data;
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = cipher.update(data);
  cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function e2eeDecrypt(data, key) {
  if (!key) return data;
  if (data.length < 28) return data;
  const iv = data.slice(0, 12);
  const tag = data.slice(12, 28);
  const ct = data.slice(28);
  try {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = decipher.update(ct);
    decipher.final();
    return dec;
  } catch {
    return data;
  }
}

function e2eeEncryptText(text, key) {
  if (!key) return text;
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, enc]);
  return 'ENC:' + combined.toString('base64');
}

function e2eeDecryptText(data, key) {
  if (!data.startsWith('ENC:')) return data;
  if (!key) return data;
  try {
    const raw = Buffer.from(data.substring(4), 'base64');
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const ct = raw.slice(28);
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return data;
  }
}

// ── Client-side HEVC → H.264 transcoding ────────────────────
// Mirrors server-side VideoTranscoder logic using bundled FFmpeg binaries.
const _videoMimes = new Set([
  'video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm',
  'video/x-m4v', 'video/3gpp', 'video/3gpp2',
]);

function _execAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function transcodeHevcToH264(fileName, mimeType, base64Data) {
  // Skip if binaries not available
  if (!_ffmpegPath) return null;

  // Skip non-video files
  if (!mimeType.startsWith('video/') || !_videoMimes.has(mimeType.toLowerCase())) return null;

  let tempDir = null;
  try {
    tempDir = path.join(os.tmpdir(), 'echo-transcode-' + nodeCrypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(tempDir, { recursive: true });

    const ext = path.extname(fileName) || '.mp4';
    const inputPath = path.join(tempDir, 'input' + ext);
    const outputPath = path.join(tempDir, 'output.mp4');

    fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));

    // Probe codec with ffprobe (if available)
    if (_ffprobePath) {
      try {
        const { stdout } = await _execAsync(_ffprobePath, [
          '-v', 'quiet', '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', inputPath,
        ]);
        const codec = stdout.trim().toLowerCase();
        if (codec !== 'hevc' && codec !== 'h265') {
          console.log('[Transcode] Video is not HEVC — skipping');
          return null;
        }
      } catch {
        // ffprobe failed — assume HEVC and try anyway
      }
    }

    console.log(`[Transcode] HEVC detected in '${fileName}', transcoding to H.264...`);

    await _execAsync(_ffmpegPath, [
      '-i', inputPath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-movflags', '+faststart', '-y', outputPath,
    ]);

    if (!fs.existsSync(outputPath)) {
      console.log('[Transcode] FFmpeg produced no output file');
      return null;
    }

    const outputBuf = fs.readFileSync(outputPath);
    const newFileName = path.basename(fileName, ext) + '.mp4';
    console.log(`[Transcode] Done: ${Math.round(base64Data.length * 3 / 4 / 1024)}KB → ${Math.round(outputBuf.length / 1024)}KB`);
    return { fileName: newFileName, mimeType: 'video/mp4', base64: outputBuf.toString('base64') };
  } catch (err) {
    console.log(`[Transcode] Skipped (ffmpeg not available): ${err.message}`);
    return null;
  } finally {
    if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

const autoConnectSockets = new Map(); // serverId → { socket, reconnectTimer }
let _audioSendCount = 0;
let _audioRecvCount = 0;
let _screenAudioSendCount = 0;
let _screenAudioRecvCount = 0;
let _videoSendCount = 0;
let _videoRecvCount = 0;
let loopbackActive = false; // True when native WASAPI loopback capture is running
// Ring buffer for accumulating WASAPI samples into 960-frame Opus blocks
let loopbackRingBuf = null;  // Int16Array, stereo interleaved
let loopbackRingPos = 0;
// ── Packet type prefix for multiplexing audio over UDP ──────
const AUDIO_TYPE_BYTE = Buffer.from([0x01]);
const SCREEN_AUDIO_TYPE_BYTE = Buffer.from([0x02]);

// ── Window

function createWindow() {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 500,
    icon: path.join(__dirname, '..', 'build-resources', 'icon.png'),
    ...(isMac
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false, roundedCorners: true }),
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
        // Chromium loopback fallback — used when native WASAPI loopback is
        // unavailable or disabled.  When native loopback is active, shareWithAudio
        // is set to false by the renderer so this path is skipped.
        opts.audio = 'loopback';
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
  ipcMain.handle('tcp:connect', async (_event, serverId, host, port, username, password, isRegister, serverPassword) => {
    return connectChat(serverId, host, port, username, password, isRegister, serverPassword);
  });

  ipcMain.on('tcp:send', (_event, serverId, message) => {
    const conn = tcpConnections.get(serverId);
    if (conn?.socket && !conn.socket.destroyed) {
      conn.socket.write(message + '\n');
    }
  });

  ipcMain.on('tcp:disconnect', (_event, serverId) => {
    if (serverId) disconnectChatForServer(serverId);
    else fullDisconnect();
  });

  // Diagnostics
  ipcMain.on('tcp:diag', (_event, serverId) => {
    const conn = tcpConnections.get(serverId);
    if (conn?.socket && !conn.socket.destroyed) {
      conn.socket.write('CMD:DIAG\n');
    }
  });

  // E2EE key
  ipcMain.on('e2ee:set-key', (_event, serverId, passphrase) => setE2eeKeyForServer(serverId, passphrase));

  // UDP Voice
  ipcMain.handle('udp:start', async (_event, host, port, username, serverId) => {
    activeVoiceServerId = serverId || null;
    return startVoice(host, port, username);
  });

  ipcMain.on('udp:send-audio', (_event, pcmArrayBuffer) => {
    sendAudio(pcmArrayBuffer);
  });

  ipcMain.on('udp:send-screen-audio', (_event, pcmArrayBuffer) => {
    sendScreenAudio(pcmArrayBuffer);
  });

  // Video over TCP (reliable delivery)
  ipcMain.on('tcp:send-video', (_event, encodedBuffer, isKeyFrame, codec) => {
    const conn = activeVoiceServerId ? tcpConnections.get(activeVoiceServerId) : null;
    if (!conn?.socket || conn.socket.destroyed) return;
    const flags = (isKeyFrame ? 0x01 : 0x00) | (codec === 'vp8' ? 0x02 : 0x00);
    const flagsHex = flags.toString(16).padStart(2, '0');
    const raw = Buffer.from(encodedBuffer);
    const payload = e2eeEncrypt(raw, conn.e2eeKey);
    const base64 = payload.toString('base64');
    conn.socket.write(`VIDEO:${flagsHex}:${base64}\n`);
    if (++_videoSendCount % 50 === 1) console.log(`[Video/TCP] Sent frame #${_videoSendCount} (${raw.length}B, ${isKeyFrame ? 'KEY' : 'delta'})`);
  });

  ipcMain.on('udp:stop', () => { stopVoice(); activeVoiceServerId = null; });

  ipcMain.on('udp:set-bitrate', (_event, br) => {
    currentBitrate = br;
    if (voiceCodec) {
      try { voiceCodec.setBitrate(br); } catch (e) { console.error('[Opus] setBitrate failed:', e); }
    }
    if (screenCodec) {
      try { screenCodec.setBitrate(br); } catch (e) { console.error('[Opus] screen setBitrate failed:', e); }
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

  // ── Native WASAPI loopback (process-excluded) ─────────────
  ipcMain.handle('loopback:supported', () => {
    try { return audioLoopback.isSupported(); } catch { return false; }
  });

  ipcMain.handle('loopback:start', (_event, sourceId) => {
    if (loopbackActive) return { success: true };
    try {
      // Determine target PID from the source ID:
      //   "window:12345:0" → INCLUDE mode (capture only that app's audio)
      //   "screen:..." or null → EXCLUDE mode (capture all except Electron)
      let targetPid = 0;
      if (sourceId && !sourceId.startsWith('screen:')) {
        // Extract HWND from desktopCapturer source ID "window:<hwnd>:<index>"
        const parts = sourceId.split(':');
        if (parts.length >= 2) {
          const hwnd = parseInt(parts[1], 10);
          if (hwnd > 0) {
            targetPid = audioLoopback.getWindowPid(hwnd);
            if (targetPid > 0) {
              console.log(`[Loopback] Window source ${sourceId} → PID ${targetPid} (INCLUDE mode)`);
            } else {
              console.warn(`[Loopback] Could not resolve PID for HWND ${hwnd}, falling back to EXCLUDE mode`);
              targetPid = 0;
            }
          }
        }
      }

      // Allocate ring buffer for 960 stereo frames (20 ms at 48 kHz)
      loopbackRingBuf = new Int16Array(FRAME_SIZE * 2);
      loopbackRingPos = 0;

      // The native addon signals "data ready" via the TSFN callback.
      // We drain the lock-free queue and process each audio packet.
      function processPacket(pcmData, info) {
        if (!loopbackActive) return;
        const channels = info.channels;
        const frames = info.frames;

        const aligned = new ArrayBuffer(pcmData.byteLength);
        new Uint8Array(aligned).set(pcmData);

        const isFloat = (info.bitsPerSample === 32);
        const src = isFloat ? new Float32Array(aligned) : new Int16Array(aligned);

        for (let i = 0; i < frames; i++) {
          let l, r;
          if (isFloat) {
            const base = i * channels;
            l = Math.max(-32768, Math.min(32767, Math.round(src[base] * 32767)));
            r = channels >= 2
              ? Math.max(-32768, Math.min(32767, Math.round(src[base + 1] * 32767)))
              : l;
          } else {
            const base = i * channels;
            l = src[base];
            r = channels >= 2 ? src[base + 1] : l;
          }

          loopbackRingBuf[loopbackRingPos * 2] = l;
          loopbackRingBuf[loopbackRingPos * 2 + 1] = r;
          loopbackRingPos++;

          if (loopbackRingPos >= FRAME_SIZE) {
            sendScreenAudio(Buffer.from(loopbackRingBuf.buffer));
            loopbackRingBuf = new Int16Array(FRAME_SIZE * 2);
            loopbackRingPos = 0;
          }
        }
      }

      const fmt = audioLoopback.startCapture(() => {
        // TSFN "data ready" signal — drain the native queue
        const packets = audioLoopback.drainQueue();
        if (!packets) return;
        for (const pkt of packets) {
          processPacket(pkt.data, pkt.info);
        }
      }, targetPid);
      loopbackActive = true;
      const mode = targetPid > 0 ? 'INCLUDE' : 'EXCLUDE';
      console.log(`[Loopback] Started (${mode}) — ${fmt.sampleRate}Hz, ${fmt.channels}ch, ${fmt.bitsPerSample}bit`);
      return { success: true, sampleRate: fmt.sampleRate, channels: fmt.channels };
    } catch (err) {
      console.error('[Loopback] Start failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.on('loopback:stop', () => {
    stopLoopback();
  });

  // ── Autoconnect (background SSE mention listener) ──────────
  ipcMain.on('autoconnect:start', (_event, serverId, host, ssePort, token) => {
    stopAutoConnect(serverId);
    startAutoConnect(serverId, host, ssePort, token);
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

  // ── Direct Messages (inline in renderer) ────────────────────
  ipcMain.on('dm:send-inline', (_event, serverId, targetUsername, text) => {
    const conn = tcpConnections.get(serverId);
    if (conn?.socket && !conn.socket.destroyed) {
      const encrypted = e2eeEncryptText(text, conn.e2eeKey);
      conn.socket.write(`DM:${targetUsername}:${encrypted}\n`);
    }
  });

  // ── Client-side video transcoding (HEVC → H.264) ───────────
  ipcMain.handle('file:transcode', async (_event, fileName, mimeType, base64Data) => {
    return transcodeHevcToH264(fileName, mimeType, base64Data);
  });
}

// DM window creation removed — DMs are now rendered inline in the main renderer.

// ── TCP Chat ────────────────────────────────────────────────

// ── TCP Chat Connection (Multi-Server) ──────────────────────
// Each server gets its own TCP connection keyed by serverId.
// Connects over TCP with automatic TLS negotiation.
// Handshake phases: (1) server password, (2) user authentication.
// After auth, relays chat messages and video frames between
// the server and the renderer process, tagged with serverId.

function connectChat(serverId, host, port, username, password, isRegister, serverPassword) {
  return new Promise((resolve, reject) => {
    // If this server already has a connection, close it first
    disconnectChatForServer(serverId);

    let sock = null;
    let buffer = '';
    let utf8Decoder = new StringDecoder('utf8');
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
      if (sock) sock.destroy();
      settle(() => reject(new Error('Connection timeout')));
    }, 10000);

    const onConnected = (isTls) => {
      tlsActive = isTls;
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 30000);
      console.log(`[TCP:${serverId}] Connected to ${host}:${port}${isTls ? ' (TLS)' : ''}, waiting for server handshake`);
    };

    const setupEvents = () => {
      sock.on('data', (data) => {
      buffer += utf8Decoder.write(data);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
        if (!line) continue;

        // ── Phase 1: Server password handshake ──
        if (!serverPwDone) {
          if (line === 'SERVER_PASSWORD_REQUIRED') {
            if (!serverPassword) {
              settle(() => reject(new Error('SERVER_PASSWORD_REQUIRED')));
              try { sock.destroy(); } catch {}
              return;
            }
            sock.write(`SERVER_PASSWORD:${serverPassword}\n`);
            console.log(`[TCP:${serverId}] Server password required — sent password`);
            continue;
          }
          if (line === 'SERVER_PASSWORD_OK' || line === 'READY') {
            serverPwDone = true;
            const prefix = isRegister ? 'REGISTER' : 'AUTH';
            sock.write(`${prefix}:${username}:${password}\n`);
            console.log(`[TCP:${serverId}] ${line === 'READY' ? 'No server password needed' : 'Server password accepted'}, sent ${prefix}`);
            continue;
          }
          if (line.startsWith('SERVER_PASSWORD_FAIL:')) {
            settle(() => reject(new Error('SERVER_PASSWORD_FAIL')));
            try { sock.destroy(); } catch {}
            return;
          }
          continue;
        }

        // ── Phase 2: User authentication ──
        if (!settled) {
          if (line === 'AUTH_OK' || line === 'REGISTER_OK') {
            const conn = { socket: sock, username, pingInterval: null, e2eeKey: null };
            conn.pingInterval = setInterval(() => {
              if (conn.socket && !conn.socket.destroyed) conn.socket.write('CMD:PING\n');
            }, 60000);
            tcpConnections.set(serverId, conn);
            settle(() => resolve({ success: true }));
          } else if (line.startsWith('AUTH_FAIL:') || line.startsWith('REGISTER_FAIL:')) {
            settle(() => reject(new Error(line.substring(line.indexOf(':') + 1))));
            try { sock.destroy(); } catch {}
            return;
          }
          continue;
        }

        // ── Post-auth: normal message handling ──
        const conn = tcpConnections.get(serverId);

        // Intercept video frames from server — decode base64 and send binary to renderer
        if (line.startsWith('VIDEO:')) {
          const i1 = line.indexOf(':', 6);
          const i2 = i1 >= 0 ? line.indexOf(':', i1 + 1) : -1;
          if (i1 >= 0 && i2 >= 0) {
            const senderName = line.substring(6, i1);
            const flags = parseInt(line.substring(i1 + 1, i2), 16);
            const isKeyFrame = (flags & 0x01) !== 0;
            const codec = (flags & 0x02) ? 'vp8' : 'h264';
            const raw = Buffer.from(line.substring(i2 + 1), 'base64');
            const encodedData = e2eeDecrypt(raw, conn?.e2eeKey);
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
        // Route incoming DMs to the renderer (inline DM tabs)
        if (line.startsWith('DM:')) {
          const i1 = line.indexOf(':', 3);
          if (i1 >= 0) {
            const fromUser = line.substring(3, i1);
            const rawText = line.substring(i1 + 1);
            const text = e2eeDecryptText(rawText, conn?.e2eeKey);
            mainWindow?.webContents.send('tcp:message', serverId, `DM:${fromUser}:${text}`);
          }
          continue;
        }
        if (line.startsWith('DM_SENT:')) {
          // DM_SENT:<target>:<text> — decrypt the text before forwarding
          const i1 = line.indexOf(':', 8);
          if (i1 >= 0) {
            const target = line.substring(8, i1);
            const rawText = line.substring(i1 + 1);
            const text = e2eeDecryptText(rawText, conn?.e2eeKey);
            mainWindow?.webContents.send('tcp:message', serverId, `DM_SENT:${target}:${text}`);
          } else {
            mainWindow?.webContents.send('tcp:message', serverId, line);
          }
          continue;
        }
        mainWindow?.webContents.send('tcp:message', serverId, line);
      }
    });

    sock.on('error', (err) => {
      console.error(`[TCP:${serverId}] Error:`, err.message);
      if (!settled) {
        settle(() => reject(err));
        mainWindow?.webContents.send('tcp:error', serverId, err.message);
      }
    });

    sock.on('close', () => {
      console.log(`[TCP:${serverId}] Disconnected`);
      if (tlsActive && !serverPwDone && !settled) {
        console.log(`[TCP:${serverId}] TLS session closed before server handshake, retrying as plain TCP`);
        _tlsCapable.set(`${host}:${port}`, false);
        tlsActive = false;
        buffer = '';
        utf8Decoder = new StringDecoder('utf8');
        sock = new net.Socket();
        setupEvents();
        sock.connect(port, host, () => onConnected(false));
        return;
      }
      if (!settled) {
        settle(() => reject(new Error('Connection closed before authentication')));
      }
      // Clean up from Map
      const c = tcpConnections.get(serverId);
      if (c) {
        if (c.pingInterval) clearInterval(c.pingInterval);
        tcpConnections.delete(serverId);
      }
      if (activeVoiceServerId === serverId) activeVoiceServerId = null;
      mainWindow?.webContents.send('tcp:disconnected', serverId);
    });
    }; // end setupEvents

    const key = `${host}:${port}`;
    const knownPlain = _tlsCapable.get(key) === false;

    if (knownPlain) {
      sock = new net.Socket();
      setupEvents();
      sock.connect(port, host, () => onConnected(false));
    } else {
      sock = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        _tlsCapable.set(key, true);
        onConnected(true);
      });
      setupEvents();
      const origError = sock.listeners('error').slice(-1)[0];
      sock.removeListener('error', origError);
      sock.once('error', (err) => {
        const isTlsError = !settled && (
          err.code === 'ECONNRESET' ||
          err.code === 'EPROTO' ||
          (err.code && err.code.startsWith('ERR_SSL_')) ||
          (err.message && (err.message.includes('ssl') || err.message.includes('SSL') || err.message.includes('wrong version') || err.message.includes('alert') || err.message.includes('routines')))
        );
        if (isTlsError) {
          console.log(`[TCP:${serverId}] TLS handshake failed (${err.code || err.message}), falling back to plain TCP`);
          _tlsCapable.set(key, false);
          try { sock.removeAllListeners(); sock.destroy(); } catch {}
          buffer = '';
          utf8Decoder = new StringDecoder('utf8');
          sock = new net.Socket();
          setupEvents();
          sock.connect(port, host, () => onConnected(false));
        } else {
          origError(err);
        }
      });
    }
  });
}

function disconnectChatForServer(serverId) {
  const conn = tcpConnections.get(serverId);
  if (!conn) return;
  if (conn.pingInterval) { clearInterval(conn.pingInterval); conn.pingInterval = null; }
  if (conn.socket) { try { conn.socket.destroy(); } catch {} }
  tcpConnections.delete(serverId);
  if (activeVoiceServerId === serverId) activeVoiceServerId = null;
}

function disconnectAllChat() {
  for (const [id] of tcpConnections) disconnectChatForServer(id);
}

function closeAllPopouts() {
  for (const [, win] of popoutWindows) {
    if (!win.isDestroyed()) win.close();
  }
  popoutWindows.clear();
}

function stopLoopback() {
  if (loopbackActive) {
    try { audioLoopback.stopCapture(); } catch {}
    loopbackActive = false;
    loopbackRingBuf = null;
    loopbackRingPos = 0;
    console.log('[Loopback] Stopped');
  }
}

function fullDisconnect() {
  disconnectAllChat();
  stopVoice();
  stopLoopback();
  closeAllPopouts();
}

// ── Autoconnect (background SSE mention listener) ───────────
// Subscribes to the server's SSE notification endpoint for real-time
// @mention events. Uses a token issued during the main TCP auth flow
// instead of re-sending credentials. Auto-reconnects every 15 seconds.

function startAutoConnect(serverId, host, ssePort, token) {
  if (!token || !ssePort) return;

  const http = require('http');
  const url = `http://${host}:${ssePort}/events?token=${encodeURIComponent(token)}`;
  let reconnectTimer = null;
  let req = null;
  let destroyed = false;

  const entry = { req: null, reconnectTimer: null, destroy: () => { destroyed = true; } };
  autoConnectSockets.set(serverId, entry);

  const reconnect = () => {
    if (destroyed || autoConnectSockets.get(serverId) !== entry) return;
    entry.reconnectTimer = setTimeout(() => {
      if (!destroyed && autoConnectSockets.get(serverId) === entry) {
        startAutoConnect(serverId, host, ssePort, token);
      }
    }, 15000);
  };

  try {
    req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        console.error(`[AutoConnect:${serverId}] SSE HTTP ${res.statusCode}`);
        res.resume();
        reconnect();
        return;
      }
      console.log(`[AutoConnect:${serverId}] SSE connected to ${host}:${ssePort}`);

      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.substring(7).trim();
          } else if (line.startsWith('data: ')) {
            currentData = line.substring(6);
          } else if (line === '' && currentEvent && currentData) {
            // End of SSE message
            if (currentEvent === 'mention') {
              try {
                const d = JSON.parse(currentData);
                console.log(`[AutoConnect:${serverId}] Mention from ${d.sender} in ${d.room}`);
                mainWindow?.webContents.send('autoconnect:mention', serverId, d.room, d.sender, d.text);
              } catch {}
            }
            currentEvent = '';
            currentData = '';
          }
        }
      });

      res.on('end', () => {
        console.log(`[AutoConnect:${serverId}] SSE stream ended`);
        reconnect();
      });

      res.on('error', (err) => {
        console.error(`[AutoConnect:${serverId}] SSE stream error: ${err.message}`);
        reconnect();
      });
    });

    entry.req = req;

    req.on('error', (err) => {
      console.error(`[AutoConnect:${serverId}] SSE request error: ${err.message}`);
      reconnect();
    });

    req.on('timeout', () => {
      console.log(`[AutoConnect:${serverId}] SSE request timeout`);
      req.destroy();
      reconnect();
    });
  } catch (err) {
    console.error(`[AutoConnect:${serverId}] SSE connect failed: ${err.message}`);
    reconnect();
  }
}

function stopAutoConnect(serverId) {
  const entry = autoConnectSockets.get(serverId);
  if (entry) {
    entry.destroy();
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    try { if (entry.req) entry.req.destroy(); } catch {}
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

      // Initialize Opus codecs — each instance has both encoder and decoder.
      // Use only 2 instances to stay within the shared WASM memory budget.
      try {
        OpusScript = require('opusscript');
        // Voice: mono (1 channel) — encode outgoing mic, decode incoming voice
        voiceCodec = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
        voiceCodec.setBitrate(currentBitrate);
        try { voiceCodec.encoderCTL(4010, 10); } catch {}
        try { voiceCodec.encoderCTL(4012, 1); } catch {}
        try { voiceCodec.encoderCTL(4014, 5); } catch {}
        // Screen audio: stereo (2 channels) — encode outgoing screen audio, decode incoming
        screenCodec = new OpusScript(SAMPLE_RATE, 2, OpusScript.Application.VOIP);
        screenCodec.setBitrate(currentBitrate);
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
          // Voice — mono decode, expand to stereo for playback
          try {
            const decrypted = e2eeDecrypt(payload, getVoiceE2eeKey());
            const mono = voiceCodec.decode(decrypted);
            // Copy to aligned ArrayBuffer for safe Int16Array view
            const aligned = new ArrayBuffer(mono.length);
            new Uint8Array(aligned).set(mono);
            const monoView = new Int16Array(aligned);
            const stereo = new Int16Array(monoView.length * 2);
            for (let i = 0; i < monoView.length; i++) {
              stereo[i * 2] = monoView[i];
              stereo[i * 2 + 1] = monoView[i];
            }
            mainWindow?.webContents.send('udp:audio', senderName, Buffer.from(stereo.buffer));
            if (++_audioRecvCount % 250 === 1 || _audioRecvCount === 1) console.log(`[Audio] Recv #${_audioRecvCount} from '${senderName}' (${payload.length}B wire → ${stereo.buffer.byteLength}B stereo)`);
          } catch (err) {
            console.error('[UDP] Voice decode error:', err.message);
          }
        } else if (typeByte === 0x02) {
          // Screen audio — stereo decode
          try {
            const decrypted = e2eeDecrypt(payload, getVoiceE2eeKey());
            const pcm = screenCodec.decode(decrypted);
            mainWindow?.webContents.send('udp:screen-audio', senderName, Buffer.from(pcm));
            if (++_screenAudioRecvCount % 250 === 1 || _screenAudioRecvCount === 1) console.log(`[ScreenAudio] Recv #${_screenAudioRecvCount} from '${senderName}' (${payload.length}B wire → ${pcm.length}B stereo)`);
          } catch (err) {
            console.error('[UDP] Screen audio decode error:', err.message);
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
  if (!udpSocket || !voiceCodec) return;

  try {
    const pcm = Buffer.from(pcmArrayBuffer);
    if (pcm.length !== FRAME_SIZE * 2) {
      if (_audioSendCount === 0) console.warn(`[Audio] Unexpected mono PCM size: ${pcm.length} (expected ${FRAME_SIZE * 2})`);
      return;
    }
    const encoded = voiceCodec.encode(pcm, FRAME_SIZE);
    if (encoded && encoded.length > 0) {
      const payload = e2eeEncrypt(Buffer.from(encoded), getVoiceE2eeKey());
      const packet = Buffer.concat([AUDIO_TYPE_BYTE, payload]);
      udpSocket.send(packet, 0, packet.length, udpSocket._voipPort, udpSocket._voipHost);
      if (++_audioSendCount % 250 === 1) console.log(`[Audio] Sent packet #${_audioSendCount} (${encoded.length}B opus, ${payload.length}B wire)`);
    }
  } catch (err) {
    console.error('[Audio] Encode/send error:', err.message);
  }
}

function sendScreenAudio(pcmArrayBuffer) {
  if (!udpSocket || !screenCodec) return;

  try {
    const pcm = Buffer.from(pcmArrayBuffer);
    if (pcm.length !== FRAME_SIZE * 4) {
      if (_screenAudioSendCount === 0) console.warn(`[ScreenAudio] Unexpected stereo PCM size: ${pcm.length} (expected ${FRAME_SIZE * 4})`);
      return;
    }
    const encoded = screenCodec.encode(pcm, FRAME_SIZE);
    if (encoded && encoded.length > 0) {
      const payload = e2eeEncrypt(Buffer.from(encoded), getVoiceE2eeKey());
      const packet = Buffer.concat([SCREEN_AUDIO_TYPE_BYTE, payload]);
      udpSocket.send(packet, 0, packet.length, udpSocket._voipPort, udpSocket._voipHost);
      if (++_screenAudioSendCount % 250 === 1) console.log(`[ScreenAudio] Sent packet #${_screenAudioSendCount} (${encoded.length}B opus, ${payload.length}B wire)`);
    }
  } catch (err) {
    console.error('[ScreenAudio] Encode/send error:', err.message);
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
  if (voiceCodec) { try { voiceCodec.delete(); } catch {} voiceCodec = null; }
  if (screenCodec) { try { screenCodec.delete(); } catch {} screenCodec = null; }
}
