# Echo — Feature Backlog

Roughly grouped by area. Items within a section are not in priority order.

---

## 🚀 Implementation Roadmap (Requested)

Scope: **Message search**, **Threaded replies**, **Announcement/read-only channels**, **Invite management UI**.

### Phase 0 — Protocol + schema alignment

- [x] Add protocol constants in client/server docs and code comments for new commands/events:
  - `CMD:SEARCH:<room>:<query>:<limit>:<cursor>`
  - `SEARCH_RESULTS:<room>:<nextCursor>:<json>`
  - `ERROR:SEARCH_INVALID` / `ERROR:SEARCH_NO_PERMISSION`
  - `CMD:CREATE_INVITE[:<maxUses>:<expiresAtIso>]`
  - `INVITES:<json>`
  - `INVITE_CREATED:<token>:<createdAtIso>:<createdBy>[:<maxUses>:<expiresAtIso>]`
  - `INVITE_DELETED:<token>`
  - `MSG_REPLY:<room>:<msgId>:<user>:<isoTime>:<replyToMsgId>:<text>`
  - `MSG_EDITED:<room>:<msgId>:<newText>` (unchanged, but must preserve `replyToMsgId`)
- [x] Confirm command ownership and permission gates:
  - Search: room access required.
  - Invite management: `server_settings` (or `admin`) required.
  - Read-only room posting: `announce` permission required.
- [x] Keep backward compatibility: old clients should still render non-thread messages and ignore unknown fields/events.

### Phase 1 — Announcement / read-only channels

#### Server
- [x] Add `ReadOnly` (bool, default `false`) to text room definition in `RoomsConfig`.
- [x] Add permission string `announce` to role permission catalog.
- [x] Enforce in message send path (`HandleMessageAsync`):
  - If room is read-only and sender lacks `announce` (or `admin`), reject with `ERROR:READ_ONLY_CHANNEL`.
- [x] Include `ReadOnly` in room list payloads so client can render badges and disable composer.

#### Client
- [x] Update room create/edit UI to toggle `ReadOnly` for text channels.
- [x] Show read-only indicator in sidebar/header (e.g., megaphone icon).
- [x] Disable composer in read-only rooms for users without permission and show helper text.
- [x] Handle `ERROR:READ_ONLY_CHANNEL` with inline toast.

#### Migration notes
- [x] `rooms.json` migration: when `ReadOnly` missing, treat as `false`.
- [x] Ensure serialization preserves unknown fields to avoid destructive rewrites.

### Phase 2 — Invite management UI

#### Server
- [x] Extend `InviteEntry` with optional metadata:
  - `MaxUses` (int?, default `1`)
  - `Uses` (int, default `0`)
  - `ExpiresAt` (ISO string?, nullable)
- [x] Extend `InviteStore` logic:
  - validate expiry and use limits in `UseInviteIf`.
  - increment `Uses` and delete only when exhausted.
- [x] Add commands:
  - `CMD:CREATE_INVITE[:<maxUses>:<expiresAtIso>]`
  - `CMD:LIST_INVITES`
  - `CMD:DELETE_INVITE:<token>`
- [x] Add response events:
  - `INVITES:<json>`
  - `INVITE_CREATED:<...>`
  - `INVITE_DELETED:<token>`

#### Client
- [x] Add **Invites** tab in Server Settings.
- [x] Add create form (quick presets: one-time, 24h, 7d, custom uses/expiry).
- [x] Add list table (token, created by, created at, uses/max, expires, actions).
- [x] Add actions: copy invite token, revoke invite, refresh list.
- [x] Add registration UI path for invite-only servers:
  - explicit invite code field and `REGISTER_WITH_INVITE:<token>:<user>:<pass>`.

#### Migration notes
- [x] `invites.json` migration: accept legacy entries with only `{Token, CreatedBy, CreatedAt}` and default to one-time behavior.
- [x] Reject malformed/expired invites with explicit error strings used by UI.

### Phase 3 — Message search

#### Server
- [x] Add `SearchMessages(room, query, limit, cursor)` in `ChatHistoryStore`.
- [x] Implement command handler:
  - `CMD:SEARCH:<room>:<query>:<limit>:<cursor>`
  - Validate room access and clamp `limit` (e.g. 1..50).
  - Return `SEARCH_RESULTS:<room>:<nextCursor>:<json>`.
- [x] Query strategy (v1):
  - case-insensitive `LIKE` over message text + sender, ordered newest-first.
  - cursor based on `rowid` for pagination.
- [ ] Query strategy (v2 optional): add FTS5 virtual table + ranking.

#### Client
- [x] Add channel-header search input/button.
- [x] Add results panel with sender, timestamp, snippet, highlight.
- [x] Clicking a result should jump to and focus the target message.
- [x] Add load-more pagination using returned cursor.
- [x] Add empty/loading/error states.

#### Migration notes
- [x] No breaking schema required for v1 (`LIKE` query path).
- [ ] If adding FTS5 later, build/rebuild index in a safe startup migration step.

### Phase 4 — Threaded replies (lightweight reply-to)

#### Server
- [x] Add nullable `reply_to_msg_id` column to `messages` table.
- [x] Extend add-message API to accept optional parent message id.
- [x] Validate parent exists in same room; if missing, store null and continue.
- [x] Extend message payloads/history JSON to include `replyToMessageId` and optional preview metadata.
- [x] Support protocol:
  - `MSG_REPLY:<room>:<replyToMsgId>:<text>` (client send)
  - broadcast as normal message event including `replyToMessageId`.

#### Client
- [x] Add message action: **Reply**.
- [x] Add composer reply context pill (show parent snippet + clear action).
- [x] Render quoted preview above reply message.
- [x] Click quoted preview to jump to parent message.
- [x] Graceful fallback when parent deleted/not loaded.

#### Migration notes
- [x] SQLite migration:
  - `ALTER TABLE messages ADD COLUMN reply_to_msg_id TEXT NULL` when absent.
- [x] Existing messages default to null reply parent.
- [x] Ensure edit/delete code paths do not drop reply metadata.

### Phase 5 — Hardening + release

- [x] Permission tests:
  - read-only send blocked without `announce`.
  - invite CRUD blocked without admin/server_settings.
  - search blocked for inaccessible rooms.
- [x] Regression tests:
  - room rename/delete interactions with reply metadata.
  - invite expiry/use-limit behavior.
  - pagination stability for search.
- [x] UX polish:
  - keyboard shortcuts for search/reply,
  - clear error copy,
  - loading and empty states.
- [x] Docs updates:
  - `GUIDE.md` user-facing instructions.
  - `ARCHITECTURE.md` protocol + storage changes.

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
