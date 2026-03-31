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
│   ├── FileServer.cs        # HTTP file upload/download server (video transcoding)
│   ├── ServerConfig.cs      # Server configuration (server-config.json)
│   ├── RoomsConfig.cs       # Voice/text room definitions (rooms.json) — supports runtime CRUD + reorder
│   ├── RoomManager.cs       # Tracks user ↔ room membership (voice + text)
│   ├── UserStore.cs         # User credentials — PBKDF2-SHA512 hashed (users.json)
│   ├── RoleStore.cs         # Role definitions + user-role assignments (roles.json)
│   ├── AvatarStore.cs       # Per-user avatar images as base64 (avatars.json)
│   ├── ChatHistoryStore.cs  # Chat messages & pins per text room (chat_history.db via SQLite)
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
- NuGet dependency: `Microsoft.Data.Sqlite` for chat history storage
- Most data is stored as flat JSON files; chat history and pins use SQLite (`chat_history.db`)
- `IncludeNativeLibrariesForSelfExtract` is enabled so native libraries (e.g. `e_sqlite3`) are embedded inside the single-file binary and auto-extracted at runtime

### Entry Point — `Program.cs`
1. Loads `ServerConfig` and `RoomsConfig` from JSON files
2. Starts an async file logger (Channel-based, writes to `logs/voipserver_debug.txt`)
3. Creates `NotificationServer` (SSE endpoint for push mention notifications)
4. Launches the `ChatServer` on a background task (TCP), passing the notification server
5. Launches the `NotificationServer` on a background task (HTTP SSE)
6. Optionally launches the `FileServer` on a background task (HTTP upload/download) when `FileServerEnabled` is true
7. Opens a `UdpClient` for voice traffic
8. Runs the main UDP receive loop:
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
- **Chunked transfer**: Response uses `SendChunked = true` so each `Flush` pushes data
  to the wire immediately (required for SSE — without it, `HttpListener` may buffer
  until `Close()`). The `X-Accel-Buffering: no` header disables NGINX proxy buffering
  so heartbeats and events reach the client in real-time when behind a reverse proxy.
- **Heartbeat**: A `: heartbeat` comment is sent every 25 seconds to keep connections alive.
- **Write safety**: Each `SseClient` holds a `SemaphoreSlim` write lock. Both the
  heartbeat loop and `PushMentionAsync` acquire it before writing, preventing
  interleaved / corrupted SSE frames.
- **Subscriber tracking**: Uses `ConcurrentDictionary<SseClient, byte>` per user for
  correct dead-client removal (avoids the ConcurrentBag arbitrary-remove pitfall).
  Clients are eagerly removed from the subscriber bag on disconnect (in the `finally`
  block) and lazily cleaned during `PushMentionAsync` if a write fails.
- **Presence integration**: `NotificationServer` exposes `GetConnectedUsernames()` and
  an `OnPresenceChanged` callback (`Func<Task>?`). `ChatServer` sets this callback to
  `BroadcastUserListAsync` so that when a user connects or disconnects via SSE, all
  TCP clients immediately receive an updated `USERS:` list showing the SSE user as
  online (with `Status: "online"`, no voice room). This makes autoconnect users visible
  to everyone on the server in real time.
- **Retry**: The server sends `retry: 15000\n\n` on connect so clients auto-reconnect after 15s.
- **Port**: Configured via `SsePort` in `server-config.json` (defaults to `TcpPort + 2`).

### HTTP File Server — `FileServer.cs`
Optional HTTP endpoint for video file uploads with server-side transcoding. Enabled via
`FileServerEnabled` in `server-config.json`. This allows video files to bypass E2EE for
transcoding — the trade-off is that the self-hosted server sees video content temporarily.

- **Upload**: `POST /upload?token=<auth_token>&name=<filename>` — raw binary body, returns
  `{ "fileId": "...", "fileName": "...", "mimeType": "..." }` as JSON.
- **Download**: `GET /file/<fileId>` — serves the file with correct MIME type and
  `Content-Disposition: attachment` header. No auth required (file IDs are unguessable UUIDs).
- **Auth**: Uses the same HMAC-SHA256 tokens as the SSE notification server (issued during TCP auth).
  Token can be passed as `?token=` query param or `Authorization: Bearer` header.
- **Size limit**: Enforced via `MaxFileSizeKB` from server config (same limit as inline uploads).
- **Transcoding**: After upload, if FFmpeg is configured (`FfmpegPath`) and the file is a video,
  the server asynchronously transcodes HEVC → H.264 via `VideoTranscoder`. The original file is
  served immediately; once transcoding completes, the transcoded version replaces it on disk.
- **Storage**: Files are stored in a `files/` directory next to the server binary. A cleanup task
  runs hourly and removes files older than 24 hours.
- **Port**: Configured via `FileServerPort` in `server-config.json` (defaults to `TcpPort + 3`).
- **CORS**: All responses include `Access-Control-Allow-Origin: *` for Electron renderer access.
- **Wire protocol**: The `SERVER_INFO` JSON includes `FileServerPort` when the file server is enabled,
  so clients know the capability is available.

### TCP Chat — `ChatServer.cs`
Each connected TCP client gets its own async task (`HandleClientAsync`):

#### Connection Lifecycle
1. **Server password gate** — if `ServerPassword` is configured, the client must send it first
2. **User authentication** — `AUTH:user:pass` or `REGISTER:user:pass`
3. **Auth token** — on success, sends `AUTH_TOKEN:<token>` (HMAC-SHA256 signed, used for SSE notifications)
4. **Post-auth setup** — sends `SERVER_INFO` (includes `SsePort`), room list, role list, auto-joins first text room. History loading (`SendHistoryAsync`) is wrapped in a try/catch so SQLite errors do not disconnect the client.
5. **Message loop** — dispatches `CMD:`, `MSG:`, `FILE:`, `DM:`, and `VIDEO:` prefixed lines
6. **Exception resilience** — the inner read loop catches non-fatal exceptions per iteration (logging and continuing), while only re-throwing `IOException` and `ObjectDisposedException` to signal a broken connection. The outer handler catches all remaining exceptions to prevent silent disconnects from e.g. `SqliteException`.

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
| `DELETE_VOICE_ROOM:<name>` | Delete a voice room (requires `delete_rooms`). Cascades: kicks all users, cleans camera/screen active state, clears stream watchers, broadcasts `CAMERA_OFF`/`SCREEN_OFF` for affected users. |
| `DELETE_TEXT_ROOM:<name>` | Delete a text room (requires `delete_rooms`). Cascades: kicks all users, permanently deletes all chat history and pinned messages for the room. |
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
- **Video transcoding**: When `FfmpegPath` is set in `server-config.json` and the file arrives via the `FILE:` protocol (E2EE off), the server transcodes HEVC (H.265) → H.264/MP4 via `VideoTranscoder.TryTranscodeAsync`. Uses `libx264`, fast preset, CRF 23, AAC audio, `+faststart`. Applies to channel uploads and DM attachments. Non-HEVC videos pass through unchanged.
- **Offline**: If the target user is not connected, the server responds with `ERROR:User is not online`
- DMs are **not persisted** on the server or client — they exist only in the renderer's in-memory state

### Persistence Layer
| Store | File | Purpose |
|-------|------|---------|
| `UserStore` | `users.json` | Usernames → PBKDF2 password hashes |
| `RoleStore` | `roles.json` | Role definitions + user-role mapping |
| `AvatarStore` | `avatars.json` | Username → base64 JPEG |
| `ChatHistoryStore` | `chat_history.db` | Room → messages + pinned message IDs (SQLite, WAL mode). Migrates from legacy `chat_history.json` / `pinned_messages.json` on first run. |
| `SoundboardStore` | `soundboard.json` | Sound name → base64 audio data |
| `EmojiStore` | `emojis.json` | Emoji name → base64 image data |
| `ServerConfig` | `server-config.json` | Network, encryption, quality config |
| `RoomsConfig` | `rooms.json` | Voice/text room definitions (CRUD + reorder) |

### Security
- **Password hashing**: PBKDF2-SHA512, 100k iterations, 16-byte salt, 32-byte hash
- **Legacy migration**: SHA-256 hashes are automatically upgraded on next login
- **Rate limiting**: 5 failed auth attempts per username → 2-minute lockout (keyed by
  username, not IP, so reverse-proxy / Docker setups don't lock out all clients sharing
  a single internal IP)
- **Server password**: Compared with `CryptographicOperations.FixedTimeEquals` (timing-safe)
- **Username matching**: All username comparisons in `ChatServer` use
  `StringComparison.OrdinalIgnoreCase` for consistent case-insensitive behaviour
- **Message size guard**: Incoming TCP lines are rejected if they exceed
  `max(10 MB, MaxFileSizeKB × 1400)` characters — the dynamic limit ensures large
  file uploads permitted by `MaxFileSizeKB` are not silently dropped while still
  preventing memory exhaustion from malicious payloads
- **E2EE modes**:
  - *Server-managed*: Server distributes a key to all clients (convenience)
  - *True E2EE*: Clients share a passphrase out-of-band; server never sees the key
- **E2EE file uploads**: When E2EE is active, channel file uploads are encrypted as
  `MSG:` messages (the entire `__FILE__:<name>:<mime>:<base64>` body is wrapped with
  `e2eeEncryptText`) so the server never sees the plaintext file data. This bypasses
  the `FILE:` protocol path (no server-side size validation). When E2EE is off, files
  use the `FILE:` protocol for server-side validation and transcoding. DM file
  attachments are always encrypted via the main-process `e2eeEncryptText` applied to
  the full DM body.
- **Server-side file server (opt-in)**: When `FileServerEnabled` is true, video file
  uploads are sent to the server's HTTP file server instead of being embedded as base64
  in TCP messages. The server sees video file content (for transcoding), but the **chat
  message referencing the file** (`__FILE_REF__:…`) is still E2EE-encrypted if a key is
  active. This is an explicit trade-off: the self-hosted server temporarily sees video
  content to enable reliable transcoding. Non-video files and text messages remain fully
  E2EE. The file server requires the same HMAC-SHA256 auth token as the SSE endpoint.
  File IDs are unguessable UUIDs. Files are auto-cleaned after 24 hours.

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

**Wipe Server** (admin only): `CMD:WIPE_SERVER:<serverName>` permanently deletes all
chat history, pins, avatars, soundboard sounds, custom emojis, and custom roles. Rooms
are reset to defaults (one voice, one text). The server name/logo are reset. All connected
clients are kicked. The command requires the exact server name as a confirmation token.
The client UI enforces additional safety: the user must type the server name and check an
"I understand" checkbox before the button becomes active.

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

### Back / Forward Navigation
Browser-style back/forward navigation lets users move through their entire view
history — including switching between home, servers, DM tabs, **and** in-server
sub-views (voice panel ↔ text channels). A navigation history stack
(`navHistoryRef`) and a position index (`navIndexRef`) track visited views. Each
entry is a discriminated union:

- `{ type: 'home' }` — home / connect screen
- `{ type: 'server', serverId, view: 'voice' | 'text', textRoom? }` — a specific
  sub-view inside a server (voice panel or a text channel)
- `{ type: 'dm', username }` — a DM tab

- **Triggers**: every user-initiated view switch pushes a new entry — clicking a
  server tab, opening a DM, pressing the Home button, connecting from the home
  screen, joining a voice room, clicking a text channel, pressing "Vis voice",
  joining a stream, etc. Duplicate consecutive entries are de-duplicated.
- **Back / Forward buttons**: `ChevronLeft` / `ChevronRight` buttons in the titlebar
  (both home and main UI, macOS and non-macOS layouts). Disabled when at the
  start/end of the history stack.
- **Mouse buttons 3 / 4**: mapped to back / forward via a `mouseup` listener.
- **Alt+ArrowLeft / Alt+ArrowRight**: keyboard shortcut (skipped when an input is focused).
- **Restore guard**: `isNavRestoreRef` prevents `pushNav` from firing while
  `applyNavEntry` is programmatically switching views, avoiding recursive history
  entries.
- **Helper**: `serverNavEntry(serverId)` builds a server entry from the current
  `viewModeRef` and `currentTextRoomRef` refs (both kept in sync via `useEffect`).
- **Snapshot on navigate away**: navigating to `home` saves the current server's
  state snapshot so it can be restored when navigating back.
- **Disconnect cleanup**: `disconnect()` removes all nav history entries for the
  disconnected server to prevent stale back/forward targets.
- **Null-safe text room restore**: `applyNavEntry` always sets `currentTextRoom`
  (including `null`) when restoring a text-view entry, rather than skipping falsy
  values.

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
cached in `_tlsCapable` so subsequent connections skip the probe. A helper
`isHostTlsCapable(host)` returns a tri-state: `true` if any port on the host is
TLS-capable, `false` if at least one port was probed as plain, or `undefined` if the
host was never probed (cold start). The SSE autoconnect and HTTP file upload use this
to infer HTTPS — on cold start (undefined) they default to HTTPS first, mirroring the
TCP probe's TLS-first strategy.

Recognised TLS-failure signals: error codes `ECONNRESET`, `EPROTO`, any `ERR_SSL_*`
prefix, and error messages containing `ssl`/`SSL`/`wrong version`/`alert`/`routines`.
When falling back, all listeners are removed from the old TLS socket before destroying
it to prevent its `close` event from racing with the new plain-TCP connection.

Additionally, if a TLS connection closes before the server sends any protocol data
(`READY`/`SERVER_PASSWORD_REQUIRED`), the client retries as plain TCP. A `pendingTls`
flag tracks whether a TLS attempt is in progress (set `true` before `tls.connect`,
cleared in `onConnected` or the error fallback). The `close` handler checks
`(tlsActive || pendingTls)` to trigger the retry — this ensures the fallback fires
even when the TLS socket is rejected before the `secureConnect` callback sets
`tlsActive = true` (e.g. a plain-TCP server that RSTs the TLS ClientHello).

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
opens an SSE connection to the server's notification endpoint
(`GET /events?token=<token>` on the `SsePort`). This replaces the previous approach
of maintaining a full TCP chat session per pinned server.

- **TLS-aware** — infers HTTPS from the `_tlsCapable` cache (populated during TCP
  connection). If the SSE port has no cached entry, `isHostTlsCapable(host)` checks
  whether any port on that host used TLS. On protocol mismatch (`socket hang up`,
  `ECONNRESET`, SSL errors) the client retries with the opposite protocol and caches
  the result, mirroring the TCP TLS probe behaviour.
- **No default timeout** — `req.setTimeout(0)` explicitly disables any agent/socket
  timeout so the long-lived SSE stream isn't killed prematurely.
- **Liveness timer** — a 90-second timer resets on every `data` event (heartbeats
  arrive every 25 s). If no data arrives for 90 s the connection is treated as dead
  and torn down for reconnect.
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

**Unread DM indicator**: When a DM arrives for a tab that is not currently active, a
`dmUnreadCounts` state entry is incremented. The DM tab gains a red animated badge
(identical in style to room mention badges) and a red-tinted background. The count is
cleared when the tab is clicked or opened via `openInlineDm`.

#### Friends List
A client-side friends list stored in `localStorage` (`voip-friends`) as an array of
`{ username, serverId }` pairs. Friends are scoped to a specific server — the
`serverId` is the pinned server UUID from when the friendship was added.

- **Adding**: right-clicking any online user opens the context menu; an "Add Friend" /
  "Remove Friend" button toggles the friendship. The button colour changes to red when
  the user is already a friend.
- **Home screen panel**: a **FRIENDS** section appears on the home/connect screen (below
  the server list) when the friends list is non-empty. Each friend card shows:
  - Coloured avatar circle with status dot (green/yellow/grey for online/away/offline)
  - Username and the server name the friendship belongs to
  - Online status label
  - A **Send DM** button (only visible when the friend's server has an active TCP
    connection in `connectedServerIds`); clicking it calls `openInlineDm` which
    navigates away from the home screen and opens the DM tab
  - A **Remove** button
- **Sorting**: friends are sorted by status — online first, then away, then offline.
- **Status resolution**: `getFriendOnlineStatus` checks the active server's `onlineUsers`
  state if the friend belongs to the active server, or reads from `serverStatesRef`
  (background server snapshot) otherwise.

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
| `notify:show`         | send → main    | Show a native OS notification (title, body). Uses Electron's `Notification` module so macOS displays the correct app icon instead of the Chromium default. Clicking the notification focuses the main window. |
| `file:upload`         | invoke → main  | Upload a file to the server's HTTP file server. Sends raw binary via `POST /upload`. Returns `{fileId, fileName, mimeType}` or `null`. Used for video uploads when `FileServerPort` is advertised in `SERVER_INFO`. |

### Renderer — `terminal-forum.tsx`

The entire UI lives in a single React component (`TerminalForum`). Key sections:

#### Performance Optimizations
- **`memo`**: `BlobMedia` is wrapped with `React.memo` to prevent re-renders when props are unchanged.
- **`useMemo`**: Expensive derived values are memoized — `currentMessages`, `usersInRoom`, `onlineUsersList`, `awayUsersList`, `offlineUsersList`, `myPermissions`, and `myAvatar`.
- **`useCallback`**: `hasPermission` is wrapped with `useCallback` keyed on the memoized `myPermissions` set.
- **Mic level throttling**: The mic-level monitoring interval runs at 100 ms (instead of 50 ms) and only triggers a React state update when the level changes by more than 2%, reducing re-renders during voice calls.
- **Sidebar resize**: The `mousemove`/`mouseup` listeners for sidebar resizing are registered once (`[]` deps) and use refs for all mutable state. This avoids a race condition where rapid state updates during dragging could tear down and re-register the `mouseup` listener, causing a missed mouseup that leaves `document.body.style.userSelect = 'none'` stuck (making inputs appear uneditable). The effect cleanup also resets body styles as a safety net.
- **Keybind recording cleanup**: All paths that close the settings modal (`setShowSettings(false)`) also call `setRecordingKeybind(null)` to prevent the capture-phase `keydown` handler from remaining active and eating keystrokes.
- **Instant scroll on room switch**: When switching text rooms or DM tabs, `scrollIntoView` uses `behavior: 'instant'` so the view starts at the bottom (most recent messages) immediately. New incoming messages in the same room/tab use `behavior: 'smooth'` for a natural animation. Tracked via `prevTextRoomRef` and `prevDmTabRef` refs.

| Section | Lines (approx) | Purpose |
|---------|----------------|---------|
| Types & constants | 1–95 | Interfaces, resolution presets, color themes, custom theme helpers (`hexToHsl`, `hslToHex`, `generateScale`). Custom theme has 7 user-configurable colors: `accent` (buttons/links/active), `bg` (main content area), `surface` (headers/inputs/modals), `sidebar` (channel/user list panels), `border` (dividers/outlines), `text` (primary), `textSecondary` (timestamps/hints). CSS vars are set on `<html>` and consumed by `[data-theme="custom"]` rules in `index.css`. |
| State declarations | 60–210 | ~60 `useState` hooks + ~40 `useRef` refs, per-server state cache (`serverStatesRef`), `unreadRooms` set for unseen-message indicators |
| Multi-server helpers | 310–370 | `takeServerSnapshot`, `restoreServerSnapshot`, `resetServerState`, `sendToServer`, `sendToVoice` |
| E2EE helpers | 208–290 | Key derivation, text encrypt/decrypt, re-decrypt |
| UI sound engine | 330–410 | `playUiSound()` — synthesized tones via Web Audio oscillators |
| Server message handler | 420–610 | Parses all `SERVER_INFO`, `ROOMS`, `MSG`, `VIDEO`, etc. |
| IPC subscriptions | 554–649 | Wires up audio/video receive callbacks |
| Audio lifecycle | 679–776 | `startAudio()` / `stopAudio()` — `cleanupVideo()` resets decoders, watching state, and pop-outs but preserves `cameraUsers`/`screenUsers` (server-authoritative state synced via `USERS` broadcasts) |
| Video capture | 778–970 | Camera and screen share encoding |
| Settings & avatar | 988–1043 | Device enumeration, avatar crop/upload (object URLs are revoked after image load to prevent memory leaks) |
| Connect screen | 1410+ | Server list, login dialogs |

**Voice activity indicators**: remote users show a green ring around their avatar when the received PCM RMS exceeds 0.01 (threshold avoids false positives from silence frames). Local user speaking detection respects the active input mode:
- **VAD mode**: green ring when `micLevel > 0.05 && !isMuted`.
- **PTT mode**: green ring when `pttHeld` is true.
- **Gate-suppressed**: amber ring + GATED badge when signal is present (`micLevel > 0.05`) but the gate is actively suppressing it (`gateActive && inputSensitivity > 0`).

**Notification preferences** (`voip-notif-prefs` in localStorage): per-server and per-channel control over sound/unread/mention behaviour. Three levels — `all` (sound + unread dot + badge), `mentions` (badge only), `none` (completely silent). Channel settings default to the server setting. Stored as `Record<serverId, { _server?: NotifLevel, [channelName]: NotifLevel | 'default' }>`. Accessible via right-click on a server tab (server-level) or right-click on a channel (channel-level). Muted channels show a faint `BellOff` icon in the sidebar.

**Global client settings** (localStorage keys): settings that apply across all servers are stored without a server-specific prefix and are accessible from the settings modal (⚙ button), which is available on both the home screen and the connected view.

| Key | Type | Description |
|-----|------|-------------|
| `voip-notification-sounds` | boolean | Enable/disable UI sounds globally |
| `voip-notification-volume` | number | UI sound volume (0–100) |
| `voip-echo-cancellation` | boolean | Microphone echo cancellation |
| `voip-noise-suppression` | boolean | Microphone noise suppression |
| `voip-auto-gain` | boolean | Microphone auto-gain control |
| `voip-input-sensitivity` | number | VAD gate threshold (0 = off) |
| `voip-gate-attack` | number | Gate attack time (ms) |
| `voip-gate-hold` | number | Gate hold time (ms) |
| `voip-gate-release` | number | Gate release time (ms) |
| `voip-ptt-mode` | boolean | Push-to-Talk mode enabled |
| `voip-keybinds` | JSON | Keybind assignments: `toggleMute`, `toggleDeafen`, `pushToTalk` |
| `voip-soundboard-volume` | number | Soundboard playback volume (0–100) |
| `voip-theme` | string | Active theme: `mono` / `light` / `custom` |
| `voip-custom-theme` | JSON | Custom theme color values |
| `voip-ui-scale` | number | UI zoom factor (50–150%) |
| `voip-font-family` | string | Font family CSS string |
| `voip-notif-prefs` | JSON | Per-server/channel notification preferences |
| `voip-pinned-servers` | JSON | Saved servers list |
| `voip-open-tabs` | JSON | Ordered server tab IDs |
| `voip-friends` | JSON | Friends list (username + serverId pairs) |
| `voip-e2ee-keys` | JSON | Per-server E2EE passphrases (local only) |
| `voip-show-user-list` | boolean | Right sidebar visible state |

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
- HTTP file upload — `uploadFile(host, port, token, fileName, mimeType, base64)` (upload to server's file server for server-side transcoding)

### AudioWorklet Processors
- **`audio-capture-processor.js`**: Buffers Float32 mono samples into 960-frame blocks (20 ms at 48 kHz), converts to Int16 mono, and posts two messages per block:
  1. The PCM frame as a **transferable `ArrayBuffer`** — consumed by the main thread to send audio to the server.
  2. A **status object** `{ type: 'status', gateGain: number, level: number }` — consumed by the renderer to drive the noise-gate visual indicator.

  Supports two mutually exclusive transmission modes:
  - **Voice-activity gate (VAD)** — configurable via `{ sensitivity, attackMs, holdMs, releaseMs }`. When the RMS level of a block exceeds the threshold the gate ramps open over `attackMs` (default 20 ms); once below, the gate stays open for `holdMs` (default 100 ms) then fades to silence over `releaseMs` (default 300 ms). When `sensitivity = 0` the gate is fully bypassed.
  - **Push-to-Talk (PTT)** — activated by `{ pttMode: true }`. The VAD gate is completely bypassed; instead, `{ pttHeld: true/false }` controls the gain directly (1 when held, 0 when released). Switching PTT off automatically clears `pttHeld`.

  The renderer keeps a `gateActive` state derived from incoming status messages (`gateGain < 0.99`). This state drives the **noise-gate visual feedback**: in VAD mode, a local user's voice tile shows an amber GATED badge + amber ring when signal is present but the gate is suppressing it. In PTT mode, a PTT badge shows green when transmitting, red when not.

- **`audio-screen-capture-processor.js`**: Buffers Float32 stereo samples into 960-frame stereo blocks (20 ms at 48 kHz), interleaves L/R channels into Int16 (1920 samples per message), and posts to main thread. Used for screen-share system audio.
- **`audio-playback-processor.js`**: Receives interleaved stereo Int16 PCM buffers, de-interleaves to separate L/R Float32 arrays, and plays them back through the stereo output channels. Implements an **adaptive jitter buffer**:
  - **Buffering phase**: on startup or after an underrun, silence is output until the queue reaches `targetDepth` frames before playback resumes, preventing choppy repeated underruns from small network jitter.
  - **EMA depth tracking**: `emaDepth` is an exponential moving average (α = 0.05) of instantaneous queue depth, updated on every `process()` call (~86 Hz).
  - **Adaptive target**: every 200 `process()` calls (~1 s), `targetDepth` increments (up to 8) when `emaDepth < 0.8` (frequent underruns → more jitter) and decrements (down to 1) when `emaDepth > targetDepth + 1.5` (stable → reduce latency).
  - **Hard cap**: if the queue exceeds `maxDepth = 12` frames (e.g. after the tab was backgrounded and frames accumulated), the oldest frames are dropped to prevent latency buildup.
  - Used by both voice and screen audio playback pipelines.

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
  CMD:NOTIFY_MENTIONS:<room>:<user1>,<user2>,...  (client-side mention hints for E2EE; server relays MENTION to listed users)
  CMD:WIPE_SERVER:<serverName>                   (admin only — permanently deletes all data, resets to defaults, kicks all clients)
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
  MENTION:<room>:<sender>:<text>                (text may be empty when triggered via NOTIFY_MENTIONS under E2EE)
  SOUNDBOARD:<json>                              (list of sound names)
  SOUNDBOARD_PLAY:<sender>:<name>:<base64data>   (sound played in voice room)
  EMOJIS:<json>                                  (name → base64 image data for custom emojis)
  PINS:<room>:<json>                             (list of pinned messages sent on room join)
  MSG_PINNED:<room>:<msgId>                      (broadcast when a message is pinned)
  MSG_UNPINNED:<room>:<msgId>                    (broadcast when a message is unpinned)
  FILE_PROGRESS:<room>:<stage>                   (upload progress: received | transcoding | broadcasting | done)
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

### HTTP File Server (when `FileServerEnabled` is true)
```
Client → Server:
  POST /upload?token=<auth_token>&name=<filename>
    Body: raw binary file data
    Content-Type: <mimeType>
    Response: { "fileId": "abc123", "fileName": "video.mp4", "mimeType": "video/mp4" }

  GET /file/<fileId>
    Response: raw binary file (Content-Type set, Content-Disposition: attachment)

Client chat message format for file references:
  MSG:<room>:__FILE_REF__:<fileId>:<fileName>:<mimeType>
  (the __FILE_REF__ body may be E2EE-encrypted — the reference itself is small text)
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
  "PublicSsePort": null,            // Public SSE port for reverse proxy setups
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
  "GiphyApiKey": null,              // GIPHY API key (enables GIF picker)
  "FfmpegPath": null,               // Path to FFmpeg binary for server-side transcoding
  "FileServerEnabled": false,       // Enable HTTP file server for video uploads
  "FileServerPort": 0,              // File server port (0 = TcpPort + 3)
  "PublicFileServerPort": null      // Public file server port for reverse proxy setups
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

## Known Fixes

### Room Deletion Bricking Text Inputs (terminal-forum.tsx)

**Problem:** Deleting a text or voice room caused all chat input fields in the client to become
unresponsive. Two bugs combined:

1. **Off-by-one in `LEFT_TEXT:` parsing** — `line.substring(9)` was used to extract the room name,
   but `'LEFT_TEXT:'` is 10 characters long. The extracted name included a leading colon (e.g.
   `:general` instead of `general`), so every cleanup operation (removing from `joinedTextRooms`,
   resetting `currentTextRoom`, clearing `roomMessages`, `pinnedMessages`, `roomHasMore`) failed
   to match and did nothing.

2. **No defensive cleanup in `ROOMS:` handler** — When the server broadcast the updated room list
   after deletion, the handler only called `setVoiceRooms` / `setTextRooms` without checking whether
   `currentTextRoom` or `currentVoiceRoom` still existed. The user was left viewing a phantom room
   that no longer existed on the server.

**Fix:**
- **Corrected substring index** — changed `line.substring(9)` to `line.substring(10)` in the
  `LEFT_TEXT:` handler so the room name is extracted correctly.
- **Defensive cleanup in `ROOMS:` handler** — after updating the room lists, the handler now checks
  whether `currentTextRoom` / `currentVoiceRoom` still exist in the new lists. If a room was removed,
  it resets `currentTextRoom` to `null`, removes the room from `joinedTextRooms`, and cleans up
  `roomMessages`, `pinnedMessages`, and `roomHasMore`. This also handles edge cases where `LEFT_TEXT:`
  arrives after `ROOMS:` or is lost entirely.

### E2EE Large-File Encryption (terminal-forum.tsx)

**Problem:** Sending files larger than ~64 KB with end-to-end encryption active silently failed.
`e2eeEncryptText` used `String.fromCharCode(...combined)` to convert the encrypted `Uint8Array` to a binary string. The spread operator passes every byte as a separate function argument, exceeding V8's ~65 536 argument limit and throwing a `RangeError`. Because `handleSubmit` is async with no error handling, the exception was swallowed—the file stayed staged and nothing was sent.

**Fix:**
- **Chunked encoding** — replaced the spread with a loop using `String.fromCharCode.apply(null, combined.subarray(i, i + 8192))` in 8 KB chunks, avoiding call-stack overflow for arbitrarily large payloads.
- **Error visibility** — wrapped the entire `handleSubmit` body in a `try/catch` that logs to console and calls `setStatus('⚠ Send failed: …')` so future errors are surfaced in the UI.

### SQLite Schema Initialisation Bug (ChatHistoryStore.cs)

**Problem:** After migrating chat history from JSON to SQLite (v1.1.12), the `pins` table
was never created and the server crashed on startup. `InitializeDatabase()` ran all DDL as a single
multi-statement `ExecuteNonQuery()` batch. The batch included `CREATE INDEX ... ON messages (room, rowid)`,
but SQLite's `rowid` is an implicit virtual column that **cannot appear in index definitions**. The
resulting `SqliteException` halted the batch before reaching `CREATE TABLE IF NOT EXISTS pins` and
`CREATE INDEX ... ON pins`. Because the error occurred inside the batched execution, it was silently
swallowed in the original code — the `messages` table was created (it preceded the failing index), so
normal chat appeared to work, but any operation touching `pins` threw
`SqliteException: no such table: pins`, including `GetPinnedMessages()` called during `SendHistoryAsync`,
which disconnected every client on room join.

**Fix:**
- **Removed `rowid` from index** — changed `CREATE INDEX ... ON messages (room, rowid)` to
  `CREATE INDEX ... ON messages (room)`. An index on `room` alone is sufficient; SQLite stores
  rows in `rowid` order implicitly, so `ORDER BY rowid` queries benefit from the covering index
  without needing `rowid` in the index definition.
- **Individual execution** — split the batch into one `Exec(conn, sql)` call per DDL/PRAGMA statement,
  so each gets its own prepare → step cycle and errors surface immediately instead of silently
  aborting mid-batch.
- **Server-side resilience** (prior fix) — `HandleClientAsync` wraps `SendHistoryAsync` and the
  inner read loop in try/catch, so a SQLite error no longer silently kills the TCP connection.

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
| `release-server.yml` | `v*` | Publishes a self-contained `linux-x64` server binary + native libraries (e.g. `e_sqlite3.so`) |
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
