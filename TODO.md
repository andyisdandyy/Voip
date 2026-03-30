# Echo — Feature Backlog

Roughly grouped by area. Items within a section are not in priority order.

---

## 💬 Chat

- **Message search** — `ChatHistoryStore` uses SQLite; a `CMD:SEARCH:<room>:<query>` command using FTS5 or `LIKE` would be trivial. Client needs a search bar (magnifier icon in the channel header) and a result list with context snippets.
- **Slow mode** — per-channel rate limit (e.g. one message per N seconds per user), configurable per channel in the channel edit dialog. Enforced server-side; broadcast `ERROR:Slow mode active — wait N seconds` on violation.
- **Read-only / announcement channel** — a boolean `ReadOnly` flag on `TextRoomDefinition`; only users with a configurable permission (e.g. `announce`) can send messages. Shown with a megaphone icon in the sidebar.
- **Thread replies** — reply to a specific message, linking the reply in the history. At minimum, a quoted preview of the parent message above the reply is useful.

---

## 📁 Direct Messages

- **DM history persistence** — DMs are currently in-memory only; closing the DM window or switching servers loses the conversation. Since they are ECDH-encrypted end-to-end, the server cannot store them; the client could write ciphertext to a local SQLite file via Electron (`better-sqlite3`) keyed by `(serverId, peerUsername)`.
- **DM notification when window closed** — clicking the OS notification for an incoming DM should re-open the DM tab and focus the main window. Currently `showNotification` fires but does not navigate.

---

## 🔒 Security / Moderation

- **Ban system** — kick is temporary (user can reconnect immediately). A `BanStore` (or a `banned` field in `UserStore`) would block reconnection by username. Admin-only `CMD:BAN_USER:<name>` / `CMD:UNBAN_USER:<name>`. Show banned users in a Server Settings tab.
- **Message rate limiting** — per-user message flood protection server-side (e.g. max 5 messages per second). Drop excess messages and send `ERROR:Rate limit exceeded`.
- **Password change** — `CMD:CHANGE_PASSWORD:<oldPass>:<newPass>`. `UserStore` already has `HashPassword`; this just needs a new command handler.
- **Account deletion** — `CMD:DELETE_ACCOUNT:<password>`. Removes user from `UserStore`, `RoleStore`, `AvatarStore`, and optionally purges their chat history.
- **Invite links** — server-generated one-time or time-limited tokens that allow registration even when the server is otherwise invite-only. A new `InviteStore` and `CMD:CREATE_INVITE` / `REGISTER_WITH_INVITE:<token>:<user>:<pass>` protocol messages.

---

## 📊 Server Administration

- **Log rotation** — `Program.cs` appends to `logs/voipserver_debug.txt` without a size cap or date cutoff. Add a daily roll and a configurable max-files retention policy.
- **Lightweight admin stats endpoint** — a read-only HTTP route on the SSE port (e.g. `GET /stats?token=<adminToken>`) returning JSON: connected user count, room occupancy, uptime, CPU/memory. Protected by an admin-level auth token.
- **Server-side message editing** — `ChatHistoryStore.EditMessage(room, id, newText)` + `MSG_EDITED` broadcast. Required for admin moderation (fix content without losing context).

---

## 🧑‍💻 Client UX

- **System theme auto-detection** — Electron exposes `nativeTheme.shouldUseDarkColors`; use it to pre-select `mono` (dark) or `light` on first launch rather than always defaulting to `mono`.
- **Custom status message** — extend the `online` / `away` enum to also carry a short freeform string (e.g. "In a meeting"). The `SET_STATUS` command already exists; broaden its payload to `SET_STATUS:<online|away>:<text>`.
- **`@everyone` / `@here` mentions** — `@here` pings users currently in the channel; `@everyone` pings all server members. Both require a server permission gate to avoid spam.
- **Channel categories** — group text and voice channels under collapsible headers (e.g. "General", "Gaming"). Add a `Category` field to `TextRoomDefinition` / `VoiceRoomDefinition` in `RoomsConfig`; the client renders a section header and collapse toggle.
- **Keyboard-navigable channel list** — arrow keys + Enter to switch channels, Escape to focus the message input. Makes the app much faster to use without a mouse.
- **DM file sharing parity** — the DM window (`dm-chat.html`) does not yet support file uploads; add a paperclip/attach button to match the main chat.
