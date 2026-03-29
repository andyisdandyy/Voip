# Echo — Architecture & Code Overview

> A self-hosted VoIP + chat application with an Electron desktop client and a .NET 10 server.

---

## Repository Structure

```
Echo/
├── .github/
│   └── workflows/
│       ├── release-server.yml  # GitHub Actions — builds & publishes server releases on tag push
│       └── release-client.yml  # GitHub Actions — builds & publishes client releases (Win/Mac/Linux) on tag push
│
├── VoipServer/              # .NET 10 console application (server)
│   ├── Program.cs           # Entry point — starts TCP chat server + UDP voice loop
│   ├── ChatServer.cs        # TCP client handler (auth, rooms, commands, video relay)
│   ├── NotificationServer.cs # SSE (Server-Sent Events) endpoint for push mention notifications
│   ├── ServerConfig.cs      # Server configuration (server-config.json)
│   ├── RoomsConfig.cs       # Voice/text room definitions (rooms.json) — supports runtime CRUD + reorder
│   ├── RoomManager.cs       # Tracks user ↔ room membership (voice + text)
│   ├── UserStore.cs         # User credentials — PBKDF2-SHA512 hashed (users.json)
│   ├── RoleStore.cs         # Role definitions + user-role assignments (roles.json)
│   ├── AvatarStore.cs       # Per-user avatar images as base64 (avatars.json)
│   ├── ChatHistoryStore.cs  # Last 200 messages per text room (chat_history.json)
│   ├── SoundboardStore.cs   # Soundboard sound entries — name → base64 audio (soundboard.json)
│   ├── EmojiStore.cs        # Custom emoji entries — name → base64 image (emojis.json)
│   ├── VideoTranscoder.cs   # HEVC → H.264 transcoding via FFmpeg (server-side)
│   └── deploy/
│       └── update.sh        # Server-side script — downloads latest GitHub Release binary
│
├── VoipClient.Electron/     # Electron + React + Tailwind CSS (client)
│   ├── electron/
│   │   ├── main.js          # Main process — TCP/UDP networking, E2EE, TLS negotiation
│   │   ├── preload.js       # Context bridge — exposes IPC APIs to renderer
│   │   ├── popout-preload.js  # Context bridge for pop-out video windows
│   │   ├── popout-video.html  # Pop-out video window (canvas + VideoDecoder)
│   │   ├── dm-preload.js      # Context bridge for DM (direct message) windows
│   │   └── dm-chat.html       # DM chat window (message list + input)
│   ├── src/
│   │   ├── App.tsx           # Root React component
│   │   ├── main.tsx          # React entry point
│   │   ├── index.css         # Tailwind CSS imports + theme color overrides (mono, light, custom)
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
3. Creates `NotificationServer` (SSE endpoint for push mention notifications)
4. Launches the `ChatServer` on a background task (TCP), passing the notification server
5. Launches the `NotificationServer` on a background task (HTTP SSE)
6. Opens a `UdpClient` for voice traffic
7. Runs the main UDP receive loop:
   - **Audio packets** (0x01 prefix) — fast-path: skip string parsing, forward to broadcast channel
   - **HELLO** — registers a new voice client with a nonce handshake
   - **GOODBYE** — removes the client
   - **KEEPALIVE** — refreshes the client's last-seen timestamp
8. A broadcast task (Channel-based) tags packets with sender name and relays to voice room peers
   - Sender name bytes are cached per username to avoid repeated UTF-8 encoding
9. A cleanup task removes inactive UDP clients every 5 seconds

### SSE Notification Server — `NotificationServer.cs`
Lightweight HTTP endpoint using `HttpListener` that provides Server-Sent Events (SSE)
for real-time mention notifications without requiring a full TCP session.

- **Token auth**: On successful TCP `AUTH`/`REGISTER`, the `ChatServer` issues an
  HMAC-SHA256 signed token (`AUTH_TOKEN:<token>`) to the client. Tokens are valid for 7 days.
- **SSE endpoint**: `GET /events?token=<token>` — validates the token, holds the
  response open with `Content-Type: text/event-stream`, and pushes mention events.
- **Event format**: `event: mention\ndata: {"room":"General","sender":"alice","text":"@bob hey"}\n\n`
- **Heartbeat**: A `: heartbeat` comment is sent every 25 seconds to keep connections alive.
- **Subscriber tracking**: Uses `ConcurrentDictionary<SseClient, byte>` per user for
  correct dead-client removal (avoids the ConcurrentBag arbitrary-remove pitfall).
- **Retry**: The server sends `retry: 15000\n\n` on connect so clients auto-reconnect after 15s.
- **Port**: Configured via `SsePort` in `server-config.json` (defaults to `TcpPort + 2`).

### TCP Chat — `ChatServer.cs`
Each connected TCP client gets its own async task (`HandleClientAsync`):

#### Connection Lifecycle
1. **Server password gate** — if `ServerPassword` is configured, the client must send it first
2. **User authentication** — `AUTH:user:pass` or `REGISTER:user:pass`
3. **Auth token** — on success, sends `AUTH_TOKEN:<token>` (HMAC-SHA256 signed, used for SSE notifications)
4. **Post-auth setup** — sends `SERVER_INFO` (includes `SsePort`), room list, role list, auto-joins first text room
5. **Message loop** — dispatches `CMD:`, `MSG:`, `FILE:`, `DM:`, and `VIDEO:` prefixed lines

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
| `EDIT_VOICE_ROOM:<oldName>:<newName>:<password>:<bitrate>` | Edit a voice room — rename, change password/bitrate (requires `create_rooms`). Migrates user tracking and broadcasts updated room list. |
| `EDIT_TEXT_ROOM:<oldName>:<newName>:<password>` | Edit a text room — rename, change password (requires `create_rooms`). Migrates user tracking and chat history on rename. |
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

#### Direct Messages (DM)
Private 1-to-1 messages between users, relayed through the server.

- **Send**: Client sends `DM:<targetUser>:<text>` (text is E2EE-encrypted in the main process if a key is active)
- **Receive**: Server relays `DM:<fromUser>:<text>` to the recipient
- **Echo**: Server sends `DM_SENT:<targetUser>:<text>` back to the sender for delivery confirmation
- **Encryption**: When E2EE is active, DM text is encrypted with AES-256-GCM in the main process using the same PBKDF2-derived key as audio/video. The encrypted payload uses the `ENC:<base64>` format (same as room chat messages). Decryption also happens in the main process before forwarding to the renderer.
- **UI**: Double-click a user in the sidebar or click "Direct Message" in the user context menu to open an inline DM tab in the tab bar. The DM chat replaces the server content area while the tab is active. Incoming DMs auto-open a tab if one isn't already open for that user. DM messages support file uploads (paperclip button) — files are embedded as `__FILE__:<name>:<mime>:<base64>` in the DM body text. Video and audio files are rendered with inline `<video>` / `<audio>` players.
- **Video transcoding**: When `FfmpegPath` is set in `server-config.json`, the server automatically transcodes HEVC (H.265) video uploads to H.264/MP4 before relaying. Applies to both channel file uploads and DM file attachments. Uses `VideoTranscoder.TryTranscodeAsync` — probes codec with `ffprobe`, re-encodes with `libx264` (fast preset, CRF 23). Non-HEVC videos pass through unchanged.
- **Offline**: If the target user is not connected, the server responds with `ERROR:User is not online`
- DMs are **not persisted** on the server or client — they exist only in the renderer's in-memory state

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
- **Username matching**: All username comparisons in `ChatServer` use
  `StringComparison.OrdinalIgnoreCase` for consistent case-insensitive behaviour
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
  more stable screen capture. HEVC (H.265) hardware decoding enabled via
  `PlatformHEVCDecoderSupport` — requires HEVC Video Extensions from the Microsoft Store.
- **macOS** — hidden titlebar with native traffic light buttons, media permission prompts.
  HEVC hardware decoding enabled via `PlatformHEVCDecoderSupport` (uses VideoToolbox).
- **Linux** — frameless window with custom titlebar buttons; Ozone auto-detection for
  Wayland support; PipeWire capturer enabled for screen sharing on Wayland compositors.
  HEVC hardware decoding enabled via `PlatformHEVCDecoderSupport` (requires VA-API support).
  When `desktopCapturer` returns no sources (Wayland), the OS-native PipeWire portal
  handles source selection. Screen share audio is supported via PipeWire.

### Multi-Server Connections
The client can maintain **simultaneous TCP connections** to multiple servers. Each
connection is identified by `serverId` (the pinned server's UUID). The user can browse
text chat, see online users, and view voice room occupancy across all connected servers
by switching tabs—**no reconnection required**.

- **Voice constraint**: only **one** voice chat session is active at a time. Joining
  voice on Server B while in voice on Server A automatically sends `CMD:LEAVE_VOICE`
  to A, stops camera/screen capture, tears down the old UDP session, starts a new UDP
  session for B, and then sends `CMD:JOIN_VOICE` to B. The helper
  `ensureVoiceOnCurrentServer()` centralises this logic and is called by both
  `joinVoice()` and the password-protected room submit handler. The `SERVER_INFO`
  auto-start UDP is also guarded by `!voiceServerIdRef.current` so that connecting to
  a new server does not steal the UDP connection from an active voice session.
- **Per-server state**: rooms, users, messages, roles, emojis, and E2EE keys are
  independent per connection. The renderer caches background server state in a ref and
  saves/restores it when switching tabs.
- **IPC tagging**: all TCP-related IPC channels (`tcp:connect`, `tcp:send`,
  `tcp:message`, `tcp:error`, `tcp:disconnected`, `tcp:diag`, `e2ee:set-key`) include
  `serverId` as the first data argument so the main process and renderer can route
  messages to the correct connection.
- **Voice routing**: `sendToVoice(msg)` targets the server that owns the voice session
  (`voiceServerId`). `sendToServer(msg)` targets the currently viewed tab.
- **Audio pipeline persistence**: the renderer's audio lifecycle (`AudioContext`, mic
  stream, per-user playback nodes) is preserved when switching server tabs. Because
  `currentVoiceRoom` is part of the per-server snapshot and becomes `null` when viewing
  a non-voice server, the `useEffect` that manages `startAudio`/`stopAudio` checks
  `voiceServerIdRef` before tearing down — if an active voice session exists on *any*
  server the pipeline stays alive. Similarly, switching back to the voice server skips
  redundant `startAudio` calls when the `AudioContext` is already running.
- **Background voice-server disconnect**: if the server owning the voice session
  disconnects while the user is viewing another tab, the `onChatDisconnected` handler
  detects the match via `voiceServerIdRef` and calls `stopAudio()` + clears
  `voiceServerId` before the early-return guard for background servers.

### Server Tab Bar
A browser-style tab bar sits below the window titlebar on both the home/connect screen
and the main connected UI. Tabs are stored in a separate `openTabs` ordered list
(persisted in `voip-open-tabs` in localStorage), independent of `pinnedServers`. A tab
is automatically opened when a server connection succeeds. Each tab shows the server's
logo (or initial) and name. The currently viewed server's tab is highlighted with an
accent bottom border.

- **Switching**: clicking another tab saves the current server's state snapshot and
  restores the target server's cached state. The TCP connection stays alive in the
  background—no disconnect/reconnect cycle. `connectedServerIdRef` is updated
  **synchronously** (not deferred to `useEffect`) before any async IPC call so that
  incoming server messages are never mis-routed as background traffic. When restoring
  a server that had E2EE active, the client reloads the per-server passphrase from
  `localStorage` (`voip-e2ee-keys`), re-derives the `CryptoKey`, and calls
  `reDecryptMessages()` to decrypt any cached ciphertext.
- **Closing**: each tab has an **×** close button (visible on hover) that removes the
  tab from the bar; if it is the active connection the client disconnects that server's
  TCP. Closing a tab does **not** remove the server from the pinned-servers list on the
  home screen.
- **Reordering**: tabs are HTML5-draggable; dropping a tab onto another reorders the
  `openTabs` list.
- **Mention badges**: inactive tabs show an animated red pill with the unread mention
  count.
- **Context menu**: right-clicking a tab opens the same server context menu as the
  home-screen server cards (autoconnect toggle, logout, remove).

### Main Process — `electron/main.js`

#### Windows App Identity
On Windows, `app.setAppUserModelId('Echo')` is called at startup so that OS
notifications display the app name **Echo** (instead of the default Electron ID).
The `BrowserWindow` is also given an explicit `icon` pointing to
`build-resources/icon.png` so the notification toast shows the correct logo.
The window uses `roundedCorners: true` (native on Windows 11+) combined with
CSS `border-radius: 10px` on `html` and `body` for consistent rounded edges.

#### Multi-Server TCP State
Instead of a single `tcpSocket`, the main process maintains a `tcpConnections` Map
keyed by `serverId`. Each entry holds `{ socket, username, pingInterval, e2eeKey }`.
A separate `activeVoiceServerId` tracks which connection owns the UDP voice session.
Video frames (`tcp:send-video`) and audio encrypt/decrypt automatically route through
the voice server's connection and E2EE key via `getVoiceE2eeKey()`.

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

#### Autoconnect (SSE Notifications)
For each pinned server with `autoConnect` enabled and a valid `authToken`, the client
opens a lightweight HTTP SSE connection to the server's notification endpoint
(`GET /events?token=<token>` on the `SsePort`). This replaces the previous approach
of maintaining a full TCP chat session per pinned server.

- **No credentials sent** — uses the HMAC-SHA256 token issued during the main TCP auth
- **Auto-reconnect** — reconnects after 15 seconds on disconnect
- **Paused for active server** — SSE is stopped for the server the user is fully connected to
- Tokens and `SsePort` are received during the primary TCP connection and persisted per server

#### Auto-Updater
Uses `electron-updater` with GitHub Releases as the update provider. On startup
(and every 30 minutes), the app checks for a newer release tag matching `client-v*`.
Updates are downloaded in the background but **never forced** — the user sees a
dismissible toast in the bottom-right corner and can choose to restart or defer.
A manual "Check for Updates" button is also available in the settings modal footer.

**Note:** `quitAndInstall()` works with NSIS (Windows), AppImage (Linux), and
DMG/ZIP (macOS). Windows builds produce both an NSIS installer (supports seamless
auto-updates) and a portable `.exe` (updates are detected and downloaded but must
be applied manually by downloading the new `.exe`).

| IPC Channel           | Direction      | Description                          |
|-----------------------|----------------|--------------------------------------|
| `get-app-version`     | invoke → main  | Returns current `app.getVersion()`   |
| `updater:check`       | send → main    | Manually trigger an update check     |
| `updater:install`     | send → main    | Quit and install downloaded update   |
| `updater:available`   | main → renderer| New version string available         |
| `updater:progress`    | main → renderer| Download progress (0-100%)           |
| `updater:downloaded`  | main → renderer| Update downloaded and ready          |

Release workflow: `.github/workflows/release-client.yml` builds Windows (NSIS installer + portable),
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

#### Direct Messages (Inline)
Private 1-to-1 chats rendered inline in the main renderer as tabs alongside server tabs.
Double-clicking a user or clicking "Direct Message" in the context menu opens a DM tab
that takes up the full content area (replacing the server panels while active). Messages
are encrypted/decrypted in the main process using the same E2EE key as audio/video.
Incoming DMs from users without an open tab automatically create one. DM message history
is kept in-memory per username and is lost on reload.

Each message bubble includes the sender's `UserAvatar` (profile picture or initial).
Own messages are right-aligned with a green tint; other-party messages are left-aligned
with a slate/blue tint and a blue sender label for easy visual distinction.

DM messages are rendered through `renderMessageBody()`, the same function used for
channel messages, so all rich content is supported:
- **Images** — inline preview with lightbox on click
- **Video files** — inline `<video>` player with native controls
- **Audio files** — inline `<audio>` player with native controls
- **Other files** — download card with filename, mime type, and download button
- **GIFs** — inline animated image
- **Emojis** — custom server emojis and standard shortcodes

File uploads in DMs use a paperclip button in the input bar. Files are read as base64
data URLs and sent as the DM body with the `__FILE__:<name>:<mime>:<base64>` prefix.
The server relays the body as-is. File size is limited by `serverInfo.maxFileSizeKB`.

| IPC Channel           | Direction      | Description                          |
|-----------------------|----------------|--------------------------------------|
| `dm:send-inline`      | send → main    | Send a DM (main encrypts + TCP send) |

### Renderer — `terminal-forum.tsx`

The entire UI lives in a single React component (`TerminalForum`). Key sections:

| Section | Lines (approx) | Purpose |
|---------|----------------|---------|
| Types & constants | 1–95 | Interfaces, resolution presets, color themes, custom theme helpers (`hexToHsl`, `hslToHex`, `generateScale`). Custom theme has 7 user-configurable colors: `accent` (buttons/links/active), `bg` (main content area), `surface` (headers/inputs/modals), `sidebar` (channel/user list panels), `border` (dividers/outlines), `text` (primary), `textSecondary` (timestamps/hints). CSS vars are set on `<html>` and consumed by `[data-theme="custom"]` rules in `index.css`. |
| State declarations | 60–210 | ~60 `useState` hooks + ~40 `useRef` refs, per-server state cache (`serverStatesRef`) |
| Multi-server helpers | 310–370 | `takeServerSnapshot`, `restoreServerSnapshot`, `resetServerState`, `sendToServer`, `sendToVoice` |
| E2EE helpers | 208–290 | Key derivation, text encrypt/decrypt, re-decrypt |
| UI sound engine | 330–410 | `playUiSound()` — synthesized tones via Web Audio oscillators |
| Server message handler | 420–610 | Parses all `SERVER_INFO`, `ROOMS`, `MSG`, `VIDEO`, etc. |
| IPC subscriptions | 554–649 | Wires up audio/video receive callbacks |
| Audio lifecycle | 679–776 | `startAudio()` / `stopAudio()` — `cleanupVideo()` resets decoders, watching state, and pop-outs but preserves `cameraUsers`/`screenUsers` (server-authoritative state synced via `USERS` broadcasts) |
| Video capture | 778–970 | Camera and screen share encoding |
| Settings & avatar | 988–1043 | Device enumeration, avatar crop/upload (object URLs are revoked after image load to prevent memory leaks) |
| Connect screen | 1410+ | Server list, login dialogs |
| Main chat UI | 1500+ | Sidebar, message list, voice panel, settings modal, server settings modal (tabbed: General/Roles/Soundboard — admin only), send button, emoji picker, image lightbox, user presence (online/away/offline with status indicators), hide-UI overlay for fullscreen video (auto-hides controls + cursor after 3s mouse idle), resizable channel/user sidebars (drag handle, 180–450 px, persisted to localStorage), collapsible user list (toggle button, persisted to localStorage), per-user screenshare mute (right-click context menu), right-click context menu on voice channel sidebar users and call UI tiles, voice activity indicator (green ring around profile picture when speaking). Footer status bar removed; compact panel spacing (1.5 units padding/gap) with 3 px resize handles. Inline DM tabs in tab bar (bubble-style chat, full content area). Voice channel bitrate label hidden from sidebar (bitrate is still stored internally and used for Opus encoding). Lazy-loaded chat history: server sends last 50 messages on join, client loads 50 more on scroll-to-top via `CMD:FETCH_HISTORY`. Font family selector in Appearance settings (`voip-font-family` in localStorage) — applies to all text via `document.body.style.fontFamily`; defaults to the monospace stack from `index.css` when empty. |

### Preload Bridge — `preload.js`
Exposes a typed `window.electronAPI` object with methods for:
- TCP chat — **all calls include `serverId`**: `connectChat(serverId, …)`, `sendChat(serverId, msg)`, `disconnectChat(serverId)`, message/error/disconnect listeners receive `(serverId, …)`
- UDP voice — `startVoice(host, port, username, serverId)`, stop, send audio, audio received listener
- Video (send, receive)
- Screen sharing (source picker, share config)
- Native WASAPI loopback (start, stop, supported check)
- E2EE key management — `setEncryptionKey(serverId, passphrase)`
- Window controls (minimize, maximize, close, fullscreen)
- Autoconnect (start, stop, mention listener)
- Auto-updater (version, check, install, progress/status listeners)
- Video pop-out (open, close, closed listener)
- Direct messages — `sendDm(serverId, target, text)` (inline tabs, no separate windows)

### AudioWorklet Processors
- **`audio-capture-processor.js`**: Buffers Float32 mono samples into 960-frame blocks (20 ms at 48 kHz), converts to Int16 mono (960 samples per message), and posts to main thread. Supports an **input sensitivity gate**: the main thread sends `{ sensitivity: 0..1 }` via `port.postMessage`; when the RMS level of a 960-sample block (scaled ×3 to match the UI meter) falls below the threshold the gate closes with a smooth exponential release (~300 ms fade-out, 0.75× per block) to avoid hard cuts, and re-opens instantly when the level exceeds the threshold. Used for voice capture.
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
  CMD:FETCH_HISTORY:<room>:<beforeId>:<count>   (load older messages, max 50)
  MSG:<room>:<text>
  FILE:<room>:<filename>:<mimeType>:<base64>
  VIDEO:<flagsHex>:<base64>

  (GIF messages are sent as MSG with body: __GIF__:<tenorUrl>)

Server → Client:
  SERVER_PASSWORD_REQUIRED | SERVER_PASSWORD_OK | SERVER_PASSWORD_FAIL:<reason>
  READY
  AUTH_OK | AUTH_FAIL:<reason> | REGISTER_OK | REGISTER_FAIL:<reason>
  AUTH_TOKEN:<token>                              (HMAC-SHA256 signed SSE session token, sent after AUTH_OK/REGISTER_OK)
  SERVER_INFO:<json>
  (SERVER_INFO includes ServerLogo data-URI, GiphyApiKey, and SsePort when configured)
  ROOMS:<json>
  USERS:<json>                                   (includes Muted/Deafened/Camera/Screen per user)
  ROLES:<json>
  JOINED_VOICE:<room>:<bitrate> | LEFT_VOICE
  JOINED_TEXT:<room> | LEFT_TEXT:<room>
  HISTORY:<room>:<hasMore>:<json>               (hasMore=True/False for pagination)
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

### SSE (HTTP, Server-Sent Events)
```
Client → Server:
  GET /events?token=<auth_token>       (HTTP request, held open)

Server → Client:
  retry: 15000                          (reconnect interval in ms)
  : heartbeat                           (keep-alive comment, every 25s)
  event: mention                        (mention notification)
  data: {"room":"General","sender":"alice","text":"@bob hey","timestamp":1234567890}
```

---

## Configuration Files

### `server-config.json`
Created automatically with defaults on first run if missing. The server logs the path and outcome to stdout.
```jsonc
{
  "ServerName": "Echo Server",
  "ServerPassword": null,           // Optional gate password
  "ServerLogo": null,               // Base64 data-URI (max ~64 KB, cropped via editor)
  "Encrypted": false,               // True E2EE (client-side key)
  "EncryptionKey": null,            // Server-managed E2EE key
  "VoiceHost": "0.0.0.0",
  "UdpPort": 5000,
  "TcpPort": 5001,
  "PublicUdpPort": null,            // For reverse proxy setups
  "BindLocalhost": false,           // true = 127.0.0.1 (behind NGINX)
  "SsePort": 0,                     // SSE notification port (0 = TcpPort + 2)
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
npm run dist:win     # Windows NSIS installer + portable executable
npm run dist:linux   # Linux portable AppImage
npm run dist:mac     # macOS DMG (universal)
```

### CI/CD Release Workflows

| Workflow | Trigger tag | What it does |
|---|---|---|
| `release-server.yml` | `v*` | Publishes a self-contained `linux-x64` server binary |
| `release-client.yml` | `client-v*` | Publishes Windows (x64), macOS (x64 + arm64), and Linux (x64) Electron installers |

**macOS builds:** The client workflow uses two separate jobs (`build-mac-x64` and `build-mac-arm64`) that each run on their own `macos-14` VM. The `mac.target` config in `package.json` lists only the target formats (`dmg`, `zip`) without hardcoded `arch` arrays, so the architecture is controlled entirely by the CLI `--x64`/`--arm64` flags in the workflow. This ensures each job builds only its intended architecture and avoids cross-arch `hdiutil` failures when creating DMGs on Apple Silicon runners.

**GitHub Release publishing:** The electron-builder `publish` config in `package.json` sets `"releaseType": "release"` so that CI publishes assets to an existing (non-draft) GitHub Release. This avoids conflicts when multiple jobs (Windows, macOS x64, macOS arm64, Linux) publish to the same tag.

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
