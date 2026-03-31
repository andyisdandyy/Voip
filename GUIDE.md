# Echo — User Guide

> A self-hosted, encrypted VoIP + chat application. This guide covers setting up the server, installing the client, and using all major features.

---

## Table of Contents

1. [Overview](#overview)
2. [Server Setup](#server-setup)
   - [Prerequisites](#server-prerequisites)
   - [Download & Run](#download--run)
   - [Configuration](#server-configuration)
   - [Running Behind a Reverse Proxy](#running-behind-a-reverse-proxy)
   - [Updating the Server](#updating-the-server)
3. [Client Installation](#client-installation)
   - [Download](#download)
   - [Building from Source](#building-from-source)
4. [Getting Started](#getting-started)
   - [Adding a Server](#adding-a-server)
   - [Registering & Logging In](#registering--logging-in)
   - [Server Trust](#server-trust)
5. [Text Chat](#text-chat)
   - [Joining Channels](#joining-channels)
   - [Sending Messages](#sending-messages)
   - [Mentions](#mentions)
   - [Emojis & Custom Emojis](#emojis--custom-emojis)
   - [File Uploads](#file-uploads)
   - [GIFs](#gifs)
   - [Pinned Messages](#pinned-messages)
   - [Message Reactions](#message-reactions)
   - [Message Editing & Deletion](#message-editing--deletion)
6. [Voice Chat](#voice-chat)
   - [Joining a Voice Channel](#joining-a-voice-channel)
   - [Mute & Deafen](#mute--deafen)
   - [Push to Talk](#push-to-talk)
   - [Input Sensitivity (Noise Gate)](#input-sensitivity-noise-gate)
7. [Video & Screen Sharing](#video--screen-sharing)
   - [Camera](#camera)
   - [Screen Sharing](#screen-sharing)
   - [Watching Streams](#watching-streams)
   - [Pop-Out Windows](#pop-out-windows)
8. [Direct Messages](#direct-messages)
9. [Friends](#friends)
10. [Multi-Server](#multi-server)
11. [Soundboard](#soundboard)
12. [End-to-End Encryption (E2EE)](#end-to-end-encryption-e2ee)
13. [Settings](#settings)
    - [Audio Settings](#audio-settings)
    - [Video Settings](#video-settings)
    - [Notification Sounds](#notification-sounds)
    - [Appearance & Themes](#appearance--themes)
    - [Keybinds](#keybinds)
14. [Server Administration](#server-administration)
    - [Roles & Permissions](#roles--permissions)
    - [Room Management](#room-management)
    - [Soundboard Management](#soundboard-management)
    - [Custom Emoji Management](#custom-emoji-management)
    - [Server Settings (Admin Panel)](#server-settings-admin-panel)
    - [Wipe Server](#wipe-server)
15. [Auto-Connect](#auto-connect)
16. [Navigation](#navigation)
17. [Keyboard Shortcuts](#keyboard-shortcuts)
18. [Troubleshooting](#troubleshooting)

---

## Overview

Echo is a self-hosted VoIP and chat platform consisting of two parts:

- **Server** — a .NET 10 console application handling TCP chat, UDP voice, SSE notifications, and optional HTTP file hosting.
- **Client** — an Electron desktop app (Windows, macOS, Linux) with React UI, supporting text chat, voice calls, video/screen sharing, and E2EE.

All data stays on your own server. No third-party accounts or cloud services required.

---

## Server Setup

### Server Prerequisites

- **.NET 10 Runtime** (or use the self-contained binary which bundles the runtime)
- **Linux, Windows, or macOS** (Linux x64 recommended for production)
- **Ports**: By default the server uses:
  - `5000` — UDP (voice)
  - `5001` — TCP (chat)
  - `5003` — HTTP SSE (background notifications)
  - `5004` — HTTP file server (optional)
- **Optional**: `ffmpeg` for server-side video transcoding (HEVC → H.264)

### Download & Run

1. **Download** the latest server binary from [GitHub Releases](https://github.com/andyisdandyy/Voip/releases). Look for `VoipServer-linux-x64.tar.gz` (or the Windows/macOS variant).

2. **Extract and run**:
   ```bash
   tar -xzf VoipServer-linux-x64.tar.gz
   cd VoipServer
   chmod +x VoipServer
   ./VoipServer
   ```

3. On first run, the server creates a default `server-config.json` and `rooms.json` in the same directory. Edit these to customise your server.

### Server Configuration

The server reads `server-config.json` from the same directory as the binary. Key options:

| Setting | Default | Description |
|---------|---------|-------------|
| `ServerName` | `"Echo Server"` | Display name shown to clients |
| `ServerPassword` | `null` | Optional password required to join the server |
| `TcpPort` | `5001` | TCP port for chat connections |
| `UdpPort` | `5000` | UDP port for voice traffic |
| `SsePort` | `0` (auto: TcpPort+2) | Port for SSE notification endpoint |
| `BindLocalhost` | `false` | Set `true` when behind a reverse proxy (binds to 127.0.0.1) |
| `Encrypted` | `false` | Enable true E2EE (clients share passphrase out-of-band) |
| `EncryptionKey` | `null` | Server-managed E2EE key (convenience mode — server knows the key) |
| `MaxFileSizeKB` | `2048` | Max file upload size in KB |
| `MaxCameraWidth` | `1920` | Max camera resolution width |
| `MaxCameraHeight` | `1080` | Max camera resolution height |
| `MaxScreenWidth` | `1920` | Max screen share resolution width |
| `MaxScreenHeight` | `1080` | Max screen share resolution height |
| `MaxFps` | `30` | Max video framerate |
| `MaxScreenBitrate` | `20000` | Max screen share bitrate in kbps |
| `DefaultBitrate` | `96000` | Default voice bitrate in bps |
| `FfmpegPath` | `null` | Path to ffmpeg binary for video transcoding |
| `FileServerEnabled` | `false` | Enable HTTP file server for video uploads |
| `FileServerPort` | `0` (auto: TcpPort+3) | File server HTTP port |
| `GiphyApiKey` | `null` | GIPHY API key for GIF search |
| `InviteOnly` | `false` | Require invite code for new registrations |

#### Room Configuration (`rooms.json`)

Defines voice and text channels. Rooms can also be created, edited, and reordered from the client UI by users with the appropriate permissions.

```json
{
  "VoiceRooms": [
    { "Name": "General", "AllowedRoles": [], "Bitrate": 96000 }
  ],
  "TextRooms": [
    { "Name": "general", "AllowedRoles": [] }
  ]
}
```

- `AllowedRoles`: empty = public, or list role names to restrict access.
- `Bitrate`: voice bitrate in bps (per-room, overrides the default).

### Running Behind a Reverse Proxy

Set `BindLocalhost: true` in config so the server only listens on `127.0.0.1`. Configure your reverse proxy (e.g. NGINX) to forward the TCP, SSE, and file server ports. Use `PublicUdpPort`, `PublicSsePort`, and `PublicFileServerPort` to advertise the public-facing ports to clients if they differ from internal ports.

The client auto-detects TLS: it tries TLS first and falls back to plain TCP if the handshake fails.

### Updating the Server

On Linux, use the included update script:

```bash
cd /path/to/VoipServer/deploy
./update.sh              # update to latest release
./update.sh v1.2.0       # update to a specific version
```

For private repos, set `GITHUB_TOKEN` first:
```bash
export GITHUB_TOKEN=ghp_xxxx
./update.sh
```

---

## Client Installation

### Download

Download the latest client from [GitHub Releases](https://github.com/andyisdandyy/Voip/releases):

- **Windows**: `Echo-Setup-x.x.x.exe` (installer) or `Echo-x.x.x-portable.exe` (portable)
- **macOS**: `Echo-x.x.x-universal.dmg` (universal binary for Intel + Apple Silicon)
- **Linux**: `Echo-x.x.x.AppImage` or `.deb`

The client auto-updates when a new release is published.

### Building from Source

```bash
cd VoipClient.Electron
npm install
npm run dev          # development mode (hot-reload)
npm run dist:win     # build Windows installer
npm run dist:mac     # build macOS DMG
npm run dist:linux   # build Linux AppImage
```

Requirements: Node.js 18+, npm, Python 3 + node-gyp (for native audio loopback addon on Windows).

---

## Getting Started

### Adding a Server

1. Launch the Echo client. You'll see the home screen.
2. Click the **+** (Add) button under "YOUR SERVERS".
3. Enter the server **address** in `hostname:port` format (e.g. `myserver.com:5001`). Port 5001 is used by default if omitted.
4. Optionally give it a custom name (otherwise the server's name is auto-fetched on connect).
5. Check **"I trust this server"** if you trust the operator (see [Server Trust](#server-trust)).
6. Click **ADD SERVER**.

### Registering & Logging In

1. Click your newly added server on the home screen.
2. A login dialog appears. Switch between **LOG IND** (login) and **REGISTRER** (register) tabs.
3. Enter a username and password, then click the button.
4. On success, you're connected. Your credentials are saved locally for future quick-connect.

> ⚠️ The server operator can see your password if the server does not use TLS. Use a unique password not shared with other services.

### Server Trust

Servers can be marked as **trusted** or **untrusted**:

- **Trusted**: GIFs load automatically, file downloads work without warnings.
- **Untrusted** (default): GIFs are blocked until you click to load them (to protect your IP), and file downloads show a warning. A red shield icon appears on untrusted server cards.

Toggle trust via right-click → "Mark as trusted/untrusted" on any server card or tab.

---

## Text Chat

### Joining Channels

Click any text channel in the left sidebar to join it. The channel name is prefixed with `#` (public) or a lock icon (role-restricted).

### Sending Messages

Type in the input bar at the bottom and press **Enter** to send. Messages appear in real-time for all users in the channel.

### Mentions

Type `@` followed by a username to mention someone. An autocomplete popup appears as you type. Press **Tab** or **Enter** to select. Mentioned users receive a notification and the message is highlighted.

### Emojis & Custom Emojis

- **Standard emojis**: Type `:shortcode:` (e.g. `:fire:`, `:heart:`) for inline replacement. An autocomplete popup appears after `:`.
- **Emoji picker**: Click the 😊 button next to the input bar.
- **Custom emojis**: Server admins can upload custom emojis. Use them with `:name:` syntax. They appear in the emoji picker under "Custom".

### File Uploads

- Click the 📎 (paperclip) button to select a file.
- Paste an image from your clipboard directly into the input.
- Drag and drop a file onto the chat area.
- A preview appears before sending. Add an optional message, then press **Enter** or click Send.
- **Max size**: Configured by the server (default 2 MB).
- Images display inline. Videos and audio files have embedded players.

### GIFs

If the server has a GIPHY API key configured:
1. Click the 🖼️ (image) button next to the input bar.
2. Search for GIFs or browse trending.
3. Click a GIF to send it.

> On untrusted servers, GIFs are blocked by default. Click the warning to load them.

### Pinned Messages

- Click the 📌 pin button in the channel header to view pinned messages.
- Admins (or users with `pin_messages` permission) can pin/unpin messages via right-click → "Pin message".

### Message Reactions

- Hover over a message and click the 😊+ reaction button to add a reaction.
- Click an existing reaction to toggle your vote.
- Reactions show who reacted on hover.

### Message Editing & Deletion

- **Edit**: Hover over your own message and click the ✏️ pencil icon, or right-click → "Edit message". Press **Enter** to save, **Escape** to cancel.
- **Delete**: Right-click → "Delete message" (own messages, or any message with `delete_messages` permission).

---

## Voice Chat

### Joining a Voice Channel

Click any voice channel in the left sidebar. The voice UI appears in the center panel, showing all users in the room with their avatars.

### Mute & Deafen

- **Mute** (microphone icon): Stops transmitting your audio. Others won't hear you.
- **Deafen** (headphones icon): Stops receiving audio from others. Automatically mutes you as well.
- Both can be toggled from the bottom-left control bar or the in-call buttons.

### Push to Talk

1. Go to **Settings → Keybinds**.
2. Enable **"Push to Talk"**.
3. Set a keybind for the PTT key.
4. Hold the key to transmit. Release to stop.

When PTT is active, the VAD noise gate is bypassed.

### Input Sensitivity (Noise Gate)

In **Settings → Audio Settings → Input Sensitivity**, adjust the threshold:
- Audio below the threshold is silenced (gated).
- A red line on the mic level indicator shows the threshold.
- Fine-tune **Attack**, **Hold**, and **Release** times for smooth transitions.
- Set to 0% to disable the gate (all audio passes through).

---

## Video & Screen Sharing

### Camera

While in a voice channel, click the **camera button** (🎥) in the call controls. Your camera feed appears in the video grid. Other users can opt-in to watch.

### Screen Sharing

1. Click the **screen share button** (↗️) in the call controls.
2. A source picker dialog opens — choose a screen or window.
3. Configure resolution, FPS, bitrate, and audio options:
   - **Share audio**: Captures system audio (Windows: per-app or all audio; Linux: via PipeWire).
   - **Variable bitrate**: Lower bitrate on static scenes, higher on motion.
4. Click **Start Sharing**.

### Watching Streams

When another user starts their camera or screen share:
- A "Join stream" button appears on their tile.
- Click it to start receiving their video feed.
- You can unwatch by right-clicking the user → "Mute Screenshare".

### Pop-Out Windows

While watching a stream, click the **↗️ pop-out** button on the video tile to open it in a separate always-on-top window.

---

## Direct Messages

- **Double-click** a user in the right sidebar, or right-click → **"Direct Message"**.
- A DM tab opens in the tab bar. DMs are E2EE-encrypted using ECDH P-256 + AES-256-GCM.
- DM messages support text, file uploads, and inline media playback.
- A key fingerprint is displayed so you can verify the connection with your contact out-of-band.
- DMs are **not stored** on the server or client — they exist only while the session is active.

---

## Friends

- Right-click a user → **"Add Friend"** to add them to your friends list.
- Friends appear on the home screen with their online status.
- Click a friend to open a DM.
- Friends list is saved locally and persists across sessions.

---

## Multi-Server

Echo supports connecting to **multiple servers simultaneously**:

- Each server connection has its own tab in the tab bar.
- Switch between servers by clicking tabs — no disconnect/reconnect needed.
- **Voice constraint**: You can only be in voice on one server at a time. Joining voice on another server automatically leaves the current one.
- Tabs can be reordered by dragging.
- Close a tab with the **×** button (disconnects that server's TCP but keeps it in your server list).

---

## Soundboard

While in a voice channel, click the 🎵 (music) button to open the soundboard panel:

- Click a sound to play it to everyone in the voice channel.
- Adjust soundboard volume with the slider.
- Mute all soundboard sounds with the speaker icon.
- Per-user: right-click a user → "Mute Soundboard" to block their sounds.

---

## End-to-End Encryption (E2EE)

Echo supports two E2EE modes:

### Server-Managed Key
The server distributes a key to all clients automatically. Simpler, but the server operator knows the key. Configured via `EncryptionKey` in `server-config.json`.

### True E2EE (Client-Side)
The server sets `Encrypted: true` in config. When connecting, clients are prompted to enter a shared passphrase. All users must use the **same passphrase**. The server never sees the key.

When E2EE is active:
- All text messages are encrypted with AES-256-GCM.
- Voice audio is encrypted per-packet.
- File uploads are encrypted within the message body.
- A 🔒 lock icon appears in the UI.

### DM Encryption
DMs always use ECDH P-256 key exchange + AES-256-GCM, independent of server-wide E2EE settings.

---

## Settings

Open settings via the ⚙️ gear icon in the bottom-left control bar.

### Audio Settings

- **Microphone**: Select your input device.
- **Output**: Select your output device.
- **Echo Cancellation**: Prevents speaker audio from feeding back into the mic.
- **Noise Suppression**: Reduces background noise (fans, typing, etc.).
- **Auto Gain Control**: Automatically adjusts mic volume.
- Changes apply on next voice join or via "Save Changes".

### Video Settings

- **Camera**: Select your video input device.
- **Resolution**: 720p, 1080p, 1440p, or 4K.
- **FPS**: 15, 30, or 60 fps.

### Notification Sounds

- Enable/disable UI sounds (message received, join/leave, mute/deafen, etc.).
- Adjust notification volume.

### Appearance & Themes

- **Mono** (default): Dark green terminal theme.
- **Light**: Light theme.
- **Custom**: Full color customization — accent, background, surface, sidebar, borders, text colors.
- **Font**: Choose from multiple mono and sans-serif fonts.
- **UI Scale**: 50% – 150%.

### Keybinds

- **Mute / Unmute**: Toggle microphone.
- **Deafen / Undeafen**: Toggle audio output.
- **Push to Talk**: Hold to transmit (must enable PTT mode first).

Click a keybind field and press the desired key combination. Press Escape to cancel.

---

## Server Administration

### Roles & Permissions

Admins can manage roles in **Server Settings → Roles**:

- **Create roles** with custom names, colors, and permissions.
- **Assign roles** to users by clicking role badges next to usernames.
- **Reorder roles** with arrow buttons (higher = more priority).
- Default roles: **Admin** (full access) and **Member** (no special permissions).

Available permissions:

| Permission | Description |
|---|---|
| `admin` | Full access to everything |
| `manage_roles` | Create, delete, assign roles |
| `create_rooms` | Create voice/text channels |
| `delete_rooms` | Delete voice/text channels |
| `reorder_rooms` | Reorder channels |
| `kick_users` | Kick users from the server |
| `delete_messages` | Delete any user's messages |
| `pin_messages` | Pin/unpin messages |
| `manage_soundboard` | Upload/delete soundboard sounds |
| `manage_emojis` | Upload/delete custom emojis |
| `server_settings` | Update server configuration |

### Room Management

Users with `create_rooms` permission can:
- Click **+** next to "TEXT CHANNELS" or "VOICE CHANNELS" to create a new room.
- Right-click a channel → "Edit channel" to rename or change role restrictions.
- Right-click → "Delete channel" (requires `delete_rooms`).
- Drag channels to reorder (requires `reorder_rooms`).

### Soundboard Management

In **Server Settings → Soundboard**, users with `manage_soundboard` can:
- Upload audio files (name + file).
- Preview and delete sounds.
- Max sound file size is configurable on the server.

### Custom Emoji Management

In **Server Settings → Emojis**, users with `manage_emojis` can:
- Upload images as custom emojis with a name (used as `:name:` in chat).
- A crop editor lets you adjust the image before uploading.
- Delete existing emojis.

### Server Settings (Admin Panel)

Users with `server_settings` permission can edit:
- Server name and logo.
- Camera/screen share resolution and bitrate limits.
- Max FPS, voice bitrate, and file size limits.

Click the 🛡️ shield icon in the bottom-left controls to open.

### Wipe Server

**Admin only**. In Server Settings → General → Danger Zone:
- Permanently deletes all chat history, avatars, soundboard sounds, custom emojis, and custom roles.
- Rooms are reset to defaults. All users are kicked.
- Requires typing the exact server name and checking a confirmation checkbox.
- **This action cannot be undone.**

---

## Auto-Connect

### Background Mentions (SSE)

Right-click a server → "Enable background mentions". The client listens for `@mentions` via SSE without a full TCP connection. You'll receive desktop notifications when mentioned.

### Auto-Connect on Startup (TCP)

Right-click a server → "Enable auto-connect". The client automatically connects to the server when the app launches. Requires saved credentials.

A small WiFi icon appears on the server card when auto-connect is enabled.

---

## Navigation

Echo has browser-style navigation:

- **Back / Forward buttons** in the titlebar (◀ ▶).
- **Mouse buttons 3 / 4** (side buttons) for back / forward.
- **Alt + Left/Right Arrow** keyboard shortcuts.
- Navigation history tracks: home screen, server views (voice/text + specific channel), and DM tabs.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift + Enter` | New line (when editing a message) |
| `Escape` | Cancel editing / close modal |
| `@` + typing | Mention autocomplete |
| `:` + typing | Emoji autocomplete |
| `Tab` | Accept autocomplete selection |
| `Alt + ←` | Navigate back |
| `Alt + →` | Navigate forward |
| Custom keybinds | Mute, Deafen, Push-to-Talk (configure in Settings) |

---

## Troubleshooting

### Can't connect to server
- Verify the server address and port are correct.
- Ensure the server is running and the ports are open in your firewall.
- If behind a reverse proxy, check that TCP, UDP, and SSE ports are all forwarded.
- The client tries TLS first, then falls back to plain TCP. Both should work automatically.

### No audio in voice chat
- Check your microphone and output device in Settings → Audio.
- Click "Save Changes" in settings to restart the audio pipeline.
- Make sure you're not muted or deafened.
- Check per-user volume: right-click a user → adjust volume slider.

### Video/screen share not working
- Ensure you're in a voice channel before starting camera or screen share.
- On macOS, grant screen recording permission in System Preferences → Privacy.
- On Linux/Wayland, PipeWire is required for screen sharing.
- Check that the server's max resolution/FPS limits aren't too restrictive.

### Files won't upload
- Check the file size against the server's `MaxFileSizeKB` limit (shown in the tooltip on the paperclip button).
- Video transcoding requires `ffmpeg` on the server (set `FfmpegPath` in config).

### E2EE issues
- All users must use the **same passphrase** for true E2EE.
- If messages appear as `ENC:...` gibberish, the passphrase doesn't match.
- The passphrase is saved per-server in localStorage and restored automatically on reconnect.

### Auto-updater
- The client checks for updates automatically. Click the 🔄 refresh icon in the titlebar to check manually.
- When an update is ready, a notification banner appears. Click to install and restart.
