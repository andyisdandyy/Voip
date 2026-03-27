# Voip — Architecture & Code Overview

> A self-hosted VoIP + chat application with an Electron desktop client and a .NET 10 server.

---

## Repository Structure

```
Voip/
├── .github/
│   └── workflows/
│       ├── release-server.yml  # GitHub Actions — builds & publishes server releases on tag push
│       └── release-client.yml  # GitHub Actions — builds & publishes client releases (Win/Mac/Linux) on tag push
│
├── VoipServer/              # .NET 10 console application (server)
│   ├── Program.cs           # Entry point — starts TCP chat server + UDP voice loop
│   ├── ChatServer.cs        # TCP client handler (auth, rooms, commands, video relay)
│   ├── ServerConfig.cs      # Server configuration (server-config.json)
│   ├── RoomsConfig.cs       # Voice/text room definitions (rooms.json) — supports runtime CRUD + reorder
│   ├── RoomManager.cs       # Tracks user ↔ room membership (voice + text)
│   ├── UserStore.cs         # User credentials — PBKDF2-SHA512 hashed (users.json)
│   ├── RoleStore.cs         # Role definitions + user-role assignments (roles.json)
│   ├── AvatarStore.cs       # Per-user avatar images as base64 (avatars.json)
│   ├── ChatHistoryStore.cs  # Last 200 messages per text room (chat_history.json)
│   ├── SoundboardStore.cs   # Soundboard sound entries — name → base64 audio (soundboard.json)
│   ├── EmojiStore.cs        # Custom emoji entries — name → base64 image (emojis.json)
│   └── deploy/
│       └── update.sh        # Server-side script — downloads latest GitHub Release binary
│
├── VoipClient.Electron/     # Electron + React + Tailwind CSS (client)
│   ├── electron/
│   │   ├── main.js          # Main process — TCP/UDP networking, E2EE, TLS negotiation
│   │   ├── preload.js       # Context bridge — exposes IPC APIs to renderer
│   │   ├── popout-preload.js  # Context bridge for pop-out video windows
│   │   └── popout-video.html  # Pop-out video window (canvas + VideoDecoder)
│   ├── src/
│   │   ├── App.tsx           # Root React component
│   │   ├── main.tsx          # React entry point
│   │   ├── index.css         # Tailwind CSS imports
│   │   ├── components/
│   │   │   └── terminal-forum.tsx  # Main UI component (connect screen, chat, voice, video)
│   │   └── types/
│   │       └── electron.d.ts      # TypeScript declarations for the electronAPI bridge
│   ├── public/
│   │   ├── audio-capture-processor.js   # AudioWorklet — mic PCM capture (48 kHz, mono)
│   │   ├── audio-screen-capture-processor.js  # AudioWorklet — screen audio PCM capture (48 kHz, stereo)
│   │   └── audio-playback-processor.js  # AudioWorklet — per-user PCM playback
│   ├── native/
│   │   └── audio-loopback/          # N-API C++ addon — WASAPI process-excluded loopback
│   │       ├── binding.gyp          # node-gyp build configuration
│   │       ├── package.json         # Addon dependencies (node-addon-api)
│   │       ├── index.js             # JS wrapper with safe stubs for non-Windows
│   │       └── src/
│   │           └── loopback.cpp     # ActivateAudioInterfaceAsync + EXCLUDE_TARGET_PROCESS_TREE
│   ├── scripts/
│   │   └── rebuild-native.js       # Rebuilds native addons against Electron headers
│   └── package.json
│
└── ARCHITECTURE.md           # This file
```

---

## Server Architecture (`VoipServer`)

### Technology
- **.NET 10** console app (top-level statements in `Program.cs`)
- No external NuGet dependencies — uses only BCL
- All data is stored as flat JSON files in the working directory

### Entry Point — `Program.cs`
1. Loads `ServerConfig` and `RoomsConfig` from JSON files
2. Starts an async file logger (Channel-based, writes to `logs/voipserver_debug.txt`)
3. Launches the `ChatServer` on a background task (TCP)
4. Opens a `UdpClient` for voice traffic
5. Runs the main UDP receive loop:
   - **Audio packets** (0x01 prefix) — fast-path: skip string parsing, forward to broadcast channel
   - **HELLO** — registers a new voice client with a nonce handshake
   - **GOODBYE** — removes the client
   - **KEEPALIVE** — refreshes the client's last-seen timestamp
6. A broadcast task (Channel-based) tags packets with sender name and relays to voice room peers
   - Sender name bytes are cached per username to avoid repeated UTF-8 encoding
7. A cleanup task removes inactive UDP clients every 5 seconds

### TCP Chat — `ChatServer.cs`
Each connected TCP client gets its own async task (`HandleClientAsync`):

#### Connection Lifecycle
1. **Server password gate** — if `ServerPassword` is configured, the client must send it first
2. **User authentication** — `AUTH:user:pass` or `REGISTER:user:pass`
3. **Post-auth setup** — sends `SERVER_INFO`, room list, role list, auto-joins first text room
4. **Message loop** — dispatches `CMD:`, `MSG:`, `FILE:`, and `VIDEO:` prefixed lines

#### Command Protocol (CMD:)
| Command | Description |
|---------|-------------|
| `JOIN_VOICE:<room>[:<password>]` | Join a voice room |
| `LEAVE_VOICE` | Leave current voice room |
| `JOIN_TEXT:<room>[:<password>]` | Join a text room |
| `LEAVE_TEXT:<room>` | Leave a text room |
| `CAMERA_ON` / `CAMERA_OFF` | Toggle camera state broadcast |
| `SCREEN_ON` / `SCREEN_OFF` | Toggle screen share state broadcast |
| `WATCH_STREAM:<username>` | Opt-in to receive video frames and screen audio from a streamer |
| `UNWATCH_STREAM:<username>` | Opt-out of receiving a streamer's video/screen audio |
| `DELETE_MSG:<room>:<id>` | Delete own message (or any with permission) |
| `SET_AVATAR:<base64>` | Upload avatar (max ~32 KB) |
| `REMOVE_AVATAR` | Remove avatar |
| `SET_STATUS:<online\|away>` | Set user presence status (online or away) |
| `SET_MUTED:<true\|false>` | Broadcast mute state to other users |
| `SET_DEAFENED:<true\|false>` | Broadcast deafen state to other users |
| `ASSIGN_ROLE:<user>:<role>` | Assign a role (requires `manage_roles`) |
| `REMOVE_ROLE:<user>:<role>` | Remove a role (requires `manage_roles`) |
| `CREATE_ROLE:<name>:<color>:<priority>:<perms>` | Create role |
| `DELETE_ROLE:<name>` | Delete role (cannot delete Admin/Member) |
| `KICK_USER:<name>` | Kick a user (requires `kick_users`) |
| `PING` | Application-level keepalive (server responds with `PONG`) |
| `DIAG` | Request server diagnostics |
| `UPLOAD_SOUND:<name>:<base64>` | Upload a soundboard sound (requires `manage_soundboard`) |
| `DELETE_SOUND:<name>` | Delete a soundboard sound (requires `manage_soundboard`) |
| `PLAY_SOUND:<name>` | Play a soundboard sound to everyone in voice room (1 s cooldown per user; client enforces one-at-a-time playback) |
| `UPLOAD_EMOJI:<name>:<base64>` | Upload a custom emoji image (requires `manage_emojis`, max 256 KB) |
| `DELETE_EMOJI:<name>` | Delete a custom emoji (requires `manage_emojis`) |
| `PIN_MSG:<room>:<msgId>` | Pin a message in a text room (requires `pin_messages`) |
| `UNPIN_MSG:<room>:<msgId>` | Unpin a message (requires `pin_messages`) |
| `CREATE_VOICE_ROOM:<name>:<password>:<bitrate>` | Create a voice room (requires `create_rooms`) |
| `CREATE_TEXT_ROOM:<name>:<password>` | Create a text room (requires `create_rooms`) |
| `DELETE_VOICE_ROOM:<name>` | Delete a voice room (requires `delete_rooms`) |
| `DELETE_TEXT_ROOM:<name>` | Delete a text room (requires `delete_rooms`) |
| `REORDER_VOICE_ROOMS:<name1>,<name2>,...` | Reorder voice rooms (requires `reorder_rooms`) |
| `REORDER_TEXT_ROOMS:<name1>,<name2>,...` | Reorder text rooms (requires `reorder_rooms`) |
| `UPDATE_SERVER_CONFIG:<json>` | Update safe server settings (requires `server_settings`) — saves to disk and re-broadcasts `SERVER_INFO`. Values are parsed via `TryGetInt64` and clamped to safe ranges to prevent overflow. |

#### Video Relay
- Video frames are sent as `VIDEO:<flags>:<base64data>` over TCP
- The server prepends the sender's name and relays only to voice room peers who have
  opted-in via `WATCH_STREAM` (tracked in `RoomManager._streamWatchers`)
- Flags byte: bit 0 = keyframe, bit 1 = VP8 (vs H.264)
- Screen audio (UDP type `0x02`) is similarly relayed only to watchers; voice audio
  (`0x01`) is still broadcast to all room members
- Watcher state is cleared automatically on `CAMERA_OFF`, `SCREEN_OFF`, `LEAVE_VOICE`,
  and disconnect

### Persistence Layer
| Store | File | Purpose |
|-------|------|---------|
| `UserStore` | `users.json` | Usernames → PBKDF2 password hashes |
| `RoleStore` | `roles.json` | Role definitions + user-role mapping |
| `AvatarStore` | `avatars.json` | Username → base64 JPEG |
| `ChatHistoryStore` | `chat_history.json` | Room → last 200 messages (debounced save) |
| `SoundboardStore` | `soundboard.json` | Sound name → base64 audio data |
| `EmojiStore` | `emojis.json` | Emoji name → base64 image data |
| `ChatHistoryStore` | `pinned_messages.json` | Room → set of pinned message IDs |
| `ServerConfig` | `server-config.json` | Network, encryption, quality config |
| `RoomsConfig` | `rooms.json` | Voice/text room definitions (CRUD + reorder) |

### Security
- **Password hashing**: PBKDF2-SHA512, 100k iterations, 16-byte salt, 32-byte hash
- **Legacy migration**: SHA-256 hashes are automatically upgraded on next login
- **Rate limiting**: 5 failed auth attempts per IP → 2-minute lockout
- **Server password**: Compared with `CryptographicOperations.FixedTimeEquals` (timing-safe)
- **E2EE modes**:
  - *Server-managed*: Server distributes a key to all clients (convenience)
  - *True E2EE*: Clients share a passphrase out-of-band; server never sees the key

### Roles & Permissions
Default roles:
- **Admin** (priority 100): has `admin` permission (grants all)
- **Member** (priority 0): no special permissions

Available permissions:
| Permission | Description |
|---|---|
| `admin` | Full access — implicitly grants every other permission |
| `manage_roles` | Create, delete, and assign roles |
| `create_rooms` | Create voice/text channels |
| `delete_rooms` | Delete voice/text channels |
| `reorder_rooms` | Reorder channels |
| `kick_users` | Kick users from the server |
| `delete_messages` | Delete any user's messages |
| `pin_messages` | Pin/unpin messages in text channels |
| `manage_soundboard` | Upload/delete soundboard sounds |
| `manage_emojis` | Upload/delete custom emojis |
| `server_settings` | Update server configuration |

---

## Client Architecture (`VoipClient.Electron`)

### Technology
- **Electron 35** with context isolation
- **React 19** + **TypeScript 5.7** + **Tailwind CSS 4.1** (Vite)
- **opusscript** for Opus audio encoding/decoding (runs in main process)
- **WebCodecs API** (`VideoEncoder`/`VideoDecoder`) for H.264/VP8 video

### Platform Support
- **Windows** — frameless window with custom titlebar buttons; WGC (Windows Graphics
  Capture) disabled via `--disable-features=WGCCapturerWin,AllowWgcScreenCapturer,AllowWgcWindowCapturer,AllowWgcDesktopCapturer`
  to avoid `ProcessFrame failed` errors — falls back to DXGI Desktop Duplication for
  more stable screen capture.
- **macOS** — hidden titlebar with native traffic light buttons, media permission prompts
- **Linux** — frameless window with custom titlebar buttons; Ozone auto-detection for
  Wayland support; PipeWire capturer enabled for screen sharing on Wayland compositors.
  When `desktopCapturer` returns no sources (Wayland), the OS-native PipeWire portal
  handles source selection. Screen share audio is supported via PipeWire.

### Main Process — `electron/main.js`

#### TCP Message Framing
Incoming TCP data is accumulated in a string buffer and split on `\n`. A Node.js
`StringDecoder('utf8')` is used instead of raw `Buffer.toString('utf8')` to correctly
handle multi-byte UTF-8 characters that may be split across TCP packet boundaries.
The decoder is reset whenever the socket is replaced (TLS fallback).

#### TLS Negotiation
The client probes TLS first on every new host:port. If the TLS handshake fails with
a protocol error (not a connection error), it falls back to plain TCP. The result is
cached in `_tlsCapable` so subsequent connections skip the probe.

Recognised TLS-failure signals: error codes `ECONNRESET`, `EPROTO`, any `ERR_SSL_*`
prefix, and error messages containing `ssl`/`SSL`/`wrong version`/`alert`/`routines`.
When falling back, all listeners are removed from the old TLS socket before destroying
it to prevent its `close` event from racing with the new plain-TCP connection.

Additionally, if a TLS handshake succeeds but the server closes the connection before
sending any protocol data (`READY`/`SERVER_PASSWORD_REQUIRED`), the client assumes TLS
was accepted by a middlebox (e.g. NGINX) while the actual VoIP server is plain TCP,
and retries the connection without TLS.

#### E2EE
- Key derived via PBKDF2 (100k iterations, SHA-256, salt `voip-e2ee-v1`)
- Audio payloads encrypted with AES-256-GCM (12-byte IV, 16-byte auth tag)
- Text messages encrypted in the renderer via Web Crypto API (same parameters)

#### Audio Pipeline
```
Voice (mono, type byte 0x01):
  Mic → getUserMedia(48kHz, mono, AEC/NS/AGC configurable)
      → AudioWorklet (capture-processor.js) — buffers 960 mono frames
        (channelCount: 1, channelCountMode: 'explicit')
      → Int16 mono PCM (960 samples) → main process
      → Opus encode (opusscript, 1 channel) → E2EE encrypt → UDP send [0x01]

Screen-share audio (stereo, type byte 0x02, when enabled):
  On Windows 10 2004+ (build 19041+), a native N-API C++ addon
  (`native/audio-loopback`) uses ActivateAudioInterfaceAsync for
  process-targeted audio capture:
    • Window share → INCLUDE mode: captures ONLY the shared app's
      audio (PID resolved from the HWND in the desktopCapturer source ID).
    • Screen share → EXCLUDE mode: captures all system audio EXCEPT
      the Electron process tree.
  The native capture runs entirely in the main process — WASAPI samples
  are converted to Int16 stereo, buffered into 960-frame blocks, and
  fed directly into the Opus encoder (no renderer round-trip).

  Falls back to Chromium's built-in loopback (`getDisplayMedia({audio:true})`)
  on older Windows, macOS, Linux, or if the native module is unavailable:
      getDisplayMedia({audio: true}) → audio track (stereo)
      → AudioWorklet (audio-screen-capture-processor.js) — buffers 960 stereo frames
        (channelCount: 2, channelCountMode: 'explicit')
      → Interleaved Int16 stereo PCM (L0,R0,L1,R1,...) → main process
      → Opus encode (opusscript, 2 channels) → E2EE encrypt → UDP send [0x02]

Voice and screen audio are sent as independent streams so each
receiving client can adjust their volumes separately.

UDP receive voice [0x01] → E2EE decrypt → Opus decode (mono) → expand to stereo
    → per-user AudioWorklet (playback-processor.js, outputChannelCount: [2])
    → per-user GainNode (volume/mute control)
    → AudioContext.destination

UDP receive screen audio [0x02] → E2EE decrypt → Opus decode (stereo) → PCM
    → watchingStreams gate (viewer must opt-in via "Join stream" button;
       server also filters — only relays to opted-in watchers)
    → per-user AudioWorklet (playback-processor.js, outputChannelCount: [2])
    → per-user GainNode (screenVolume control, independent from voice)
    → AudioContext.destination
```

#### Video Pipeline
```
Camera/Screen → getUserMedia/getDisplayMedia
    → canvas drawImage → VideoFrame
    → VideoEncoder (H.264 or VP8) → EncodedVideoChunk
      Camera: always variable bitrate (VBR)
      Screen share: constant (default) or variable bitrate (user toggle)
    → E2EE encrypt → base64 → TCP send

TCP receive → base64 decode → E2EE decrypt
    → watchingStreams gate (viewer must opt-in via "Join stream" button)
    → VideoDecoder → VideoFrame
    → canvas drawImage (rendered via canvas element per user)
```

Streams are **not auto-played**. When a user starts a camera or screen share,
other voice room members see a "Join stream" / "Watch camera" button on the
user tile. Clicking it opts-in to decode and display that user's video frames.
The text-chat bar also shows a "Join screenshare" shortcut when streams are
available but not yet watched.

#### Autoconnect
For each pinned server with `autoConnect` enabled, a lightweight background TCP
connection is maintained solely to receive `MENTION:` notifications. These sockets
auto-reconnect every 15 seconds on disconnect and are paused for the actively
connected server (to avoid same-username kick).

#### Auto-Updater
Uses `electron-updater` with GitHub Releases as the update provider. On startup
(and every 30 minutes), the app checks for a newer release tag matching `client-v*`.
Updates are downloaded in the background but **never forced** — the user sees a
dismissible toast in the bottom-right corner and can choose to restart or defer.
A manual "Check for Updates" button is also available in the settings modal footer.

**Note:** `quitAndInstall()` works with NSIS (Windows), AppImage (Linux), and
DMG/ZIP (macOS). For Windows portable builds, updates are detected and downloaded
but cannot be auto-installed — the user must manually download the new `.exe`.

| IPC Channel           | Direction      | Description                          |
|-----------------------|----------------|--------------------------------------|
| `get-app-version`     | invoke → main  | Returns current `app.getVersion()`   |
| `updater:check`       | send → main    | Manually trigger an update check     |
| `updater:install`     | send → main    | Quit and install downloaded update   |
| `updater:available`   | main → renderer| New version string available         |
| `updater:progress`    | main → renderer| Download progress (0-100%)           |
| `updater:downloaded`  | main → renderer| Update downloaded and ready          |

Release workflow: `.github/workflows/release-client.yml` builds Windows (portable),
macOS (DMG + ZIP), and Linux (AppImage) artifacts and publishes them to the
GitHub Release via `--publish always`.

#### Video Pop-out
Remote camera/screen-share feeds can be popped out into a separate frameless window.
The main process creates a new `BrowserWindow` per username, loads `popout-video.html`,
and forwards the raw encoded video frames in parallel with the main renderer. Each
pop-out window has its own `VideoDecoder` and `<canvas>`. Pop-out windows are
automatically closed when the feed source ends (`CAMERA_OFF`/`SCREEN_OFF`) or on
disconnect.

| IPC Channel           | Direction      | Description                          |
|-----------------------|----------------|--------------------------------------|
| `popout:open`         | invoke → main  | Open a pop-out window for a username |
| `popout:close`        | send → main    | Close a specific pop-out window      |
| `popout:closed`       | main → renderer| Notifies renderer a pop-out closed   |
| `popout:get-info`     | invoke (popout) | Pop-out window queries its username  |
| `popout:minimize`     | send → main    | Minimize the sending pop-out window  |
| `popout:maximize`     | send → main    | Toggle maximize on the pop-out window|
| `popout:close-self`   | send → main    | Close the sending pop-out window     |
| `popout:video-frame`  | main → popout  | Forward encoded video frame          |
| `popout:feed-ended`   | main → popout  | Notifies pop-out that feed ended     |

### Renderer — `terminal-forum.tsx`

The entire UI lives in a single React component (`TerminalForum`). Key sections:

| Section | Lines (approx) | Purpose |
|---------|----------------|---------|
| Types & constants | 1–60 | Interfaces, resolution presets, color themes |
| State declarations | 60–210 | ~60 `useState` hooks + ~40 `useRef` refs |
| E2EE helpers | 208–290 | Key derivation, text encrypt/decrypt, re-decrypt |
| UI sound engine | 330–410 | `playUiSound()` — synthesized tones via Web Audio oscillators |
| Server message handler | 420–610 | Parses all `SERVER_INFO`, `ROOMS`, `MSG`, `VIDEO`, etc. |
| IPC subscriptions | 554–649 | Wires up audio/video receive callbacks |
| Audio lifecycle | 679–776 | `startAudio()` / `stopAudio()` — `cleanupVideo()` resets decoders, watching state, and pop-outs but preserves `cameraUsers`/`screenUsers` (server-authoritative state synced via `USERS` broadcasts) |
| Video capture | 778–970 | Camera and screen share encoding |
| Settings & avatar | 988–1043 | Device enumeration, avatar crop/upload |
| Connect screen | 1410+ | Server list, login dialogs |
| Main chat UI | 1500+ | Sidebar, message list, voice panel, settings modal, server settings modal (tabbed: General/Roles/Soundboard — admin only), send button, emoji picker, image lightbox, user presence (online/away/offline with status indicators), hide-UI overlay for fullscreen video (auto-hides controls + cursor after 3s mouse idle), resizable channel/user sidebars (drag handle, 180–450 px, persisted to localStorage), collapsible user list (toggle button, persisted to localStorage), per-user screenshare mute (right-click context menu), right-click context menu on voice channel sidebar users and call UI tiles |

### Preload Bridge — `preload.js`
Exposes a typed `window.electronAPI` object with methods for:
- TCP chat (connect, send, disconnect, message/error/disconnect listeners)
- UDP voice (start, stop, send audio, audio received listener)
- Video (send, receive)
- Screen sharing (source picker, share config)
- Native WASAPI loopback (start, stop, supported check)
- E2EE key management
- Window controls (minimize, maximize, close, fullscreen)
- Autoconnect (start, stop, mention listener)
- Auto-updater (version, check, install, progress/status listeners)
- Video pop-out (open, close, closed listener)

### AudioWorklet Processors
- **`audio-capture-processor.js`**: Buffers Float32 mono samples into 960-frame blocks (20 ms at 48 kHz), converts to Int16 mono (960 samples per message), and posts to main thread. Used for voice capture.
- **`audio-screen-capture-processor.js`**: Buffers Float32 stereo samples into 960-frame stereo blocks (20 ms at 48 kHz), interleaves L/R channels into Int16 (1920 samples per message), and posts to main thread. Used for screen-share system audio.
- **`audio-playback-processor.js`**: Receives interleaved stereo Int16 PCM buffers, de-interleaves to separate L/R Float32 arrays, and plays them back through the stereo output channels. Used by both voice and screen audio playback pipelines.

### Native Audio Loopback — `native/audio-loopback/`
N-API C++ addon that captures system audio using the Windows 10 2004+
`ActivateAudioInterfaceAsync` process-loopback API — the same mechanism OBS uses.

**Two modes (selected automatically by source type):**
- **Window share** → `INCLUDE_TARGET_PROCESS_TREE` — captures **only** the shared
  app's audio (e.g. Brave). The HWND is extracted from the `desktopCapturer` source ID
  (`window:<hwnd>:<idx>`), converted to a PID via `GetWindowThreadProcessId`, and
  passed to the activation params.
- **Screen share** → `EXCLUDE_TARGET_PROCESS_TREE` — captures **all** system audio
  except the Electron process tree (voice/soundboard won't leak into the capture).

**How it works:**
1. `ActivateAudioInterfaceAsync` is called with the virtual device ID `VAD\Process_Loopback`
   and activation params targeting either the shared app's PID (include) or
   `GetCurrentProcessId()` (exclude).  The completion handler uses WRL `RuntimeClass`
   with `FtmBase` (agile / Free-Threaded Marshaler) so it can be called from any COM apartment.
2. The completion handler stores the raw `IUnknown`.  A dedicated MTA worker thread then
   performs `QueryInterface` for `IAudioClient`, calls `GetMixFormat` (falls back to
   48 kHz/float32/stereo if the OS returns `E_NOTIMPL`), `Initialize` with
   `AUDCLNT_STREAMFLAGS_LOOPBACK`, `GetService(IAudioCaptureClient)`, and `Start`.
3. The same MTA thread enters the capture loop, boosted via MMCSS
   `AvSetMmThreadCharacteristicsW("Audio")`.  It polls `GetNextPacketSize` / `GetBuffer`,
   copies each audio packet into an `AudioPacket` struct, and pushes it into a
   mutex-protected queue on the `CaptureState`.
4. After each push, a bare `Napi::ThreadSafeFunction::NonBlockingCall()` signals the JS
   thread that data is ready.
5. The JS-side callback calls `drainQueue()` which swaps out all pending packets and
   returns them as `{data: Uint8Array, info: {sampleRate, channels, frames, bitsPerSample}}[]`.
   Data is copied into V8-managed `ArrayBuffer`s (Electron disallows external buffers).
6. In the main process callback, samples are converted from WASAPI's native format (float32
   multi-channel) to interleaved Int16 stereo, accumulated in a ring buffer, and fed into
   `sendScreenAudio()` in 960-frame blocks — no renderer round-trip required.

**Platform handling:**
- On Windows 10 2004+ with the native module built, `isSupported()` returns `true`.
- On older Windows, macOS, or Linux, `isSupported()` returns `false` and the renderer
  falls back to Chromium's built-in `getDisplayMedia({audio: 'loopback'})`.
- Non-Windows builds compile a no-op stub so `require()` always succeeds.

| IPC Channel          | Direction      | Description                                    |
|----------------------|----------------|------------------------------------------------|
| `loopback:supported` | invoke → main  | Returns `true` if process loopback is available |
| `loopback:start`     | invoke → main  | Starts native capture for a source ID; window sources use INCLUDE mode (app-only), screen sources use EXCLUDE mode (all-minus-self); returns `{ success, sampleRate, channels }` |
| `loopback:stop`      | send → main    | Stops native capture and frees resources       |

---

## Wire Protocol Summary

### TCP (newline-delimited text)
```
Client → Server:
  SERVER_PASSWORD:<password>
  AUTH:<username>:<password>
  REGISTER:<username>:<password>
  CMD:<command>
  MSG:<room>:<text>
  FILE:<room>:<filename>:<mimeType>:<base64>
  VIDEO:<flagsHex>:<base64>

  (GIF messages are sent as MSG with body: __GIF__:<tenorUrl>)

Server → Client:
  SERVER_PASSWORD_REQUIRED | SERVER_PASSWORD_OK | SERVER_PASSWORD_FAIL:<reason>
  READY
  AUTH_OK | AUTH_FAIL:<reason> | REGISTER_OK | REGISTER_FAIL:<reason>
  SERVER_INFO:<json>
  (SERVER_INFO includes ServerLogo data-URI and GiphyApiKey when configured)
  ROOMS:<json>
  USERS:<json>                                   (includes Muted/Deafened/Camera/Screen per user)
  ROLES:<json>
  JOINED_VOICE:<room>:<bitrate> | LEFT_VOICE
  JOINED_TEXT:<room> | LEFT_TEXT:<room>
  HISTORY:<room>:<json>
  MSG:<room>:<msgId>:<sender>:<text>
  MSG_DELETED:<room>:<msgId>
  VIDEO:<sender>:<flagsHex>:<base64>
  CAMERA_ON:<user> | CAMERA_OFF:<user>
  SCREEN_ON:<user> | SCREEN_OFF:<user>
  REQUEST_KEYFRAME                                (tells streamer to emit a keyframe for new joiners)
  AVATAR:<user>:<base64>
  MENTION:<room>:<sender>:<text>
  SOUNDBOARD:<json>                              (list of sound names)
  SOUNDBOARD_PLAY:<sender>:<name>:<base64data>   (sound played in voice room)
  EMOJIS:<json>                                  (name → base64 image data for custom emojis)
  PINS:<room>:<json>                             (list of pinned messages sent on room join)
  MSG_PINNED:<room>:<msgId>                      (broadcast when a message is pinned)
  MSG_UNPINNED:<room>:<msgId>                    (broadcast when a message is unpinned)
  KICKED
  PONG
  ERROR:<message>
  DIAG:<json>
```

### UDP (binary)
```
Client → Server:
  HELLO:<nonce>:<username>   (text, handshake)
  GOODBYE                     (text, disconnect)
  KEEPALIVE                   (text, every 10s)
  [0x01][opus_data]           (voice frame, mono, optionally E2EE encrypted)
  [0x02][opus_data]           (screen audio frame, stereo, optionally E2EE encrypted)

Server → Client:
  WELCOME:<nonce>             (text, handshake response)
  [nameLen:1][name:N][0x01][opus_data]   (tagged voice audio from another user)
  [nameLen:1][name:N][0x02][opus_data]   (tagged screen audio from another user)
```

---

## Configuration Files

### `server-config.json`
```jsonc
{
  "ServerName": "Voip Server",
  "ServerPassword": null,           // Optional gate password
  "ServerLogo": null,               // Base64 data-URI (max ~64 KB, cropped via editor)
  "Encrypted": false,               // True E2EE (client-side key)
  "EncryptionKey": null,            // Server-managed E2EE key
  "VoiceHost": "0.0.0.0",
  "UdpPort": 5000,
  "TcpPort": 5001,
  "PublicUdpPort": null,            // For reverse proxy setups
  "BindLocalhost": false,           // true = 127.0.0.1 (behind NGINX)
  "MaxCameraWidth": 1920,
  "MaxCameraHeight": 1080,
  "MaxScreenWidth": 1920,
  "MaxScreenHeight": 1080,
  "MaxFps": 30,
  "MaxScreenBitrate": 20000,        // kbps
  "DefaultBitrate": 96000,          // Opus bitrate (bps)
  "MaxFileSizeKB": 2048,
  "MaxSoundSizeKB": 512,              // Max soundboard sound file size in KB
  "DefaultBitrate": 96000,            // Opus bitrate (bps)
  "TenorApiKey": null,              // DEPRECATED — use GiphyApiKey
  "GiphyApiKey": null               // GIPHY API key (enables GIF picker)
}
```

### `rooms.json`
```jsonc
{
  "VoiceRooms": [{ "Name": "Voice 1", "Bitrate": 96000, "Password": null }],
  "TextRooms":  [{ "Name": "General", "Password": null }]
}
```

---

## Deployment

### Releasing a New Version
Push a version tag — GitHub Actions builds a self-contained Linux binary and publishes it as a release:
```bash
git tag v1.0.0
git push origin v1.0.0
```

### Updating the Server
Copy `VoipServer/deploy/update.sh` next to the `VoipServer` binary on the Linux server, then:
```bash
./update.sh              # update to latest release
./update.sh v1.2.0       # update to specific version
```
The script downloads the binary from GitHub Releases, swaps it in place, and prints a message to restart. JSON data files are untouched.

---

## Development

### Server
```bash
cd VoipServer
dotnet run
```

### Client
```bash
cd VoipClient.Electron
npm install
npm run dev          # Vite dev server + Electron
```

### Build Client
```bash
npm run dist:win     # Windows portable executable
npm run dist:linux   # Linux portable AppImage
npm run dist:mac     # macOS DMG (universal)
```

### CI/CD Release Workflows

| Workflow | Trigger tag | What it does |
|---|---|---|
| `release-server.yml` | `v*` | Publishes a self-contained `linux-x64` server binary |
| `release-client.yml` | `client-v*` | Publishes Windows (x64), macOS (x64 + arm64), and Linux (x64) Electron installers |

**macOS DMG note:** The client workflow builds x64 and arm64 DMGs sequentially in the same job. A `Cleanup mounted DMG volumes` step (`hdiutil detach -force`) runs between the two builds to prevent the arm64 build from failing due to leftover `/Volumes/Voip` mount points from the x64 DMG creation.

---

## Maintenance Rules

> **Every time a new feature is added or an existing feature is updated, this document (`ARCHITECTURE.md`) must be updated to reflect the change.** This includes but is not limited to:
> - New or changed wire protocol messages
> - New commands (`CMD:`)
> - New or modified server-side classes/stores
> - New or modified client-side IPC channels or preload bridge methods
> - Changes to the audio/video pipeline
> - New configuration options in `server-config.json` or `rooms.json`
> - Changes to the repository structure (new files/folders)
>
> Keeping this document in sync ensures that Copilot (and any contributor) can quickly understand the project without re-reading every source file.
