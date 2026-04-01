using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// Rendezvous server with persistent WebSocket connections and HTTP REST fallback.
///
/// HTTP Endpoints (backward compatible):
///   GET  /                       — server info (name, type, version)
///   GET  /myip                   — returns the caller's public IP
///   POST /register               — register a new user {username, password, publicKey}
///   POST /auth                   — authenticate and receive a bearer token {username, password}
///   PUT  /presence               — mark self online (auth) {address}; acts as heartbeat
///   DELETE /presence             — mark self offline (auth)
///   GET  /presence/{username}    — check online status + address + publicKey (auth)
///   GET  /pubkey/{username}      — get a user's public key (no auth required)
///   PUT  /pubkey                 — update caller's ECDH public key (auth) {publicKey}
///   POST /messages/{recipient}   — store encrypted message for offline user (auth) {ciphertext, nonce}
///   GET  /messages               — fetch inbox (auth)
///   DELETE /messages/{id}        — acknowledge and delete a delivered message (auth)
///   GET  /friends                — list confirmed friends (auth)
///   POST /friends/{target}       — record a confirmed friendship (auth)
///   DELETE /friends/{target}     — remove a friendship (auth)
///
/// WebSocket Endpoint (v2 — persistent bidirectional):
///   GET  /ws?token=              — upgrade to WebSocket (auth via query param)
///
/// WebSocket Protocol (JSON text frames):
///   Client → Server:
///     AUTH        {type:"AUTH", token, deviceId}
///     SEND_DM     {type:"SEND_DM", to, ciphertext, nonce}
///     ACK         {type:"ACK", id}
///     FETCH_MISSED {type:"FETCH_MISSED"}
///     HEARTBEAT   {type:"HEARTBEAT"}
///
///   Server → Client:
///     DM           {type:"DM", id, from, ciphertext, nonce, sentAt}
///     DM_ACK       {type:"DM_ACK", id, sentAt}
///     MISSED_MESSAGES {type:"MISSED_MESSAGES", messages:[...]}
///     PRESENCE_UPDATE {type:"PRESENCE_UPDATE", username, online}
///     HEARTBEAT_ACK   {type:"HEARTBEAT_ACK"}
///     ERROR        {type:"ERROR", message}
///
/// The server never holds decryption keys. All message payloads are opaque ciphertext blobs.
/// </summary>
public class RendezvousHttpServer
{
    private readonly HttpListener _listener;
    private readonly RendezvousConfig _config;
    private readonly UserRegistry _users;
    private readonly PresenceTracker _presence;
    private readonly OfflineMailbox _mailbox;
    private readonly FriendStore _friends;
    private readonly WsConnectionTracker _ws = new();
    private readonly RateLimiter _rateLimiter;
    private readonly Action<string>? _log;
    private readonly byte[] _hmacKey;

    private static readonly JsonSerializerOptions _jsonIn = new() { PropertyNameCaseInsensitive = true };
    private static readonly JsonSerializerOptions _jsonOut = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly ConcurrentDictionary<string, (string username, DateTime issuedAt)> _tokens = new();
    private static readonly TimeSpan TokenLifetime = TimeSpan.FromDays(7);

    // ── Request body DTOs ────────────────────────────────────────────────────
    private record RegisterRequest(string? Username, string? Password, string? PublicKey);
    private record AuthRequest(string? Username, string? Password);
    private record PresenceRequest(string? Address);
    private record MessageRequest(string? Ciphertext, string? Nonce);

    // ── WebSocket protocol DTOs ──────────────────────────────────────────────
    private record WsIncoming(string? Type, string? Token, string? DeviceId, string? To,
        string? Ciphertext, string? Nonce, long? Id);

    public RendezvousHttpServer(
        RendezvousConfig config,
        UserRegistry users,
        PresenceTracker presence,
        OfflineMailbox mailbox,
        FriendStore friends,
        Action<string>? log = null)
    {
        _config = config;
        _users = users;
        _presence = presence;
        _mailbox = mailbox;
        _friends = friends;
        _log = log;

        _hmacKey = new byte[32];
        RandomNumberGenerator.Fill(_hmacKey);

        _rateLimiter = new RateLimiter(config.RateLimitMessages, TimeSpan.FromSeconds(config.RateLimitWindowSeconds));

        _listener = new HttpListener();
        var host = config.BindLocalhost ? "127.0.0.1" : "+";
        _listener.Prefixes.Add($"http://{host}:{config.Port}/");
    }

    public async Task StartAsync(CancellationToken ct = default)
    {
        _listener.Start();
        _log?.Invoke($"[Rendezvous] Listening on port {_config.Port}");

        // Periodic mailbox TTL cleanup (every 6 hours)
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromHours(6), ct).ConfigureAwait(false);
                var removed = _mailbox.CleanupExpired();
                if (removed > 0)
                    _log?.Invoke($"[Rendezvous] Mailbox cleanup: purged {removed} expired messages");
            }
        }, ct);

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var context = await _listener.GetContextAsync().ConfigureAwait(false);
                _ = HandleRequestAsync(context);
            }
        }
        catch (HttpListenerException) when (ct.IsCancellationRequested) { }
        catch (ObjectDisposedException) { }
        finally
        {
            try { _listener.Stop(); } catch { }
        }
    }

    // ── Request dispatch ─────────────────────────────────────────────────────
    private async Task HandleRequestAsync(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var res = ctx.Response;

        res.Headers.Add("Access-Control-Allow-Origin", "*");
        res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.Headers.Add("Access-Control-Allow-Headers", "Authorization, Content-Type");

        if (req.HttpMethod == "OPTIONS")
        {
            res.StatusCode = 204;
            res.Close();
            return;
        }

        var path = req.Url?.AbsolutePath?.TrimEnd('/') ?? "";
        var method = req.HttpMethod;

        try
        {
            // WebSocket upgrade
            if (method == "GET" && path == "/ws" && ctx.Request.IsWebSocketRequest)
            {
                await HandleWebSocketUpgradeAsync(ctx).ConfigureAwait(false);
                return;
            }

            if (method == "GET" && path == "")
            {
                await WriteJsonAsync(res, 200, new { name = _config.ServerName, type = "rendezvous", version = 2 }).ConfigureAwait(false);
            }
            else if (method == "GET" && path == "/myip")
            {
                await WriteJsonAsync(res, 200, new { ip = req.RemoteEndPoint?.Address?.ToString() }).ConfigureAwait(false);
            }
            else if (method == "POST" && path == "/register")
            {
                await HandleRegisterAsync(req, res).ConfigureAwait(false);
            }
            else if (method == "POST" && path == "/auth")
            {
                await HandleAuthAsync(req, res).ConfigureAwait(false);
            }
            else if (method == "PUT" && path == "/presence")
            {
                await HandlePresencePutAsync(req, res).ConfigureAwait(false);
            }
            else if (method == "DELETE" && path == "/presence")
            {
                await HandlePresenceDeleteAsync(req, res).ConfigureAwait(false);
            }
            else if (method == "GET" && path.StartsWith("/presence/"))
            {
                await HandlePresenceGetAsync(path["/presence/".Length..], req, res).ConfigureAwait(false);
            }
            else if (method == "GET" && path.StartsWith("/pubkey/"))
            {
                await HandlePubkeyGetAsync(path["/pubkey/".Length..], res).ConfigureAwait(false);
            }
            else if (method == "PUT" && path == "/pubkey")
            {
                await HandlePubkeyPutAsync(req, res).ConfigureAwait(false);
            }
            else if (method == "POST" && path.StartsWith("/messages/"))
            {
                await HandleMessageSendAsync(path["/messages/".Length..], req, res).ConfigureAwait(false);
            }
            else if (method == "GET" && path == "/messages")
            {
                await HandleMessageInboxAsync(req, res).ConfigureAwait(false);
            }
            else if (method == "DELETE" && path.StartsWith("/messages/"))
            {
                await HandleMessageDeleteAsync(path["/messages/".Length..], req, res).ConfigureAwait(false);
            }
            else if (method == "GET" && path == "/friends")
            {
                await HandleFriendsGetAsync(req, res).ConfigureAwait(false);
            }
            else if (method == "POST" && path.StartsWith("/friends/"))
            {
                await HandleFriendAddAsync(path["/friends/".Length..], req, res).ConfigureAwait(false);
            }
            else if (method == "DELETE" && path.StartsWith("/friends/"))
            {
                await HandleFriendRemoveAsync(path["/friends/".Length..], req, res).ConfigureAwait(false);
            }
            else if (method == "GET" && path == "/events")
            {
                // Legacy SSE endpoint — redirect clients to use /ws
                await WriteJsonAsync(res, 410, new { error = "SSE endpoint removed. Use WebSocket at /ws" }).ConfigureAwait(false);
            }
            else
            {
                await WriteJsonAsync(res, 404, new { error = "Not found" }).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"[Rendezvous] Request error {method} {path}: {ex.Message}");
            try { await WriteJsonAsync(res, 500, new { error = "Internal server error" }).ConfigureAwait(false); } catch { }
        }
    }

    // ── WebSocket handler ────────────────────────────────────────────────────
    private async Task HandleWebSocketUpgradeAsync(HttpListenerContext ctx)
    {
        var token = ctx.Request.QueryString["token"];
        if (string.IsNullOrEmpty(token))
        {
            ctx.Response.StatusCode = 401;
            ctx.Response.Close();
            return;
        }

        var username = ValidateToken(token);
        if (username is null)
        {
            ctx.Response.StatusCode = 401;
            ctx.Response.Close();
            return;
        }

        WebSocketContext wsCtx;
        try
        {
            wsCtx = await ctx.AcceptWebSocketAsync(subProtocol: null).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"[WS] Accept failed for {username}: {ex.Message}");
            ctx.Response.StatusCode = 500;
            ctx.Response.Close();
            return;
        }

        var ws = wsCtx.WebSocket;
        var deviceId = ctx.Request.QueryString["deviceId"] ?? Guid.NewGuid().ToString("N")[..8];
        var session = _ws.Register(username, deviceId, ws);
        _log?.Invoke($"[WS] {username}/{deviceId} connected (sessions: {_ws.SessionCount})");

        // Broadcast presence online
        await BroadcastPresenceAsync(username, true).ConfigureAwait(false);

        // Deliver missed messages immediately
        await DeliverMissedAsync(session).ConfigureAwait(false);

        // Heartbeat task: send periodic pings to keep connection alive
        var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(session.Cts.Token);
        _ = Task.Run(async () =>
        {
            var interval = TimeSpan.FromSeconds(_config.HeartbeatIntervalSeconds);
            while (!heartbeatCts.Token.IsCancellationRequested)
            {
                await Task.Delay(interval, heartbeatCts.Token).ConfigureAwait(false);
                try
                {
                    if (ws.State == WebSocketState.Open)
                        await ws.SendAsync(
                            Encoding.UTF8.GetBytes("""{"type":"HEARTBEAT_ACK"}"""),
                            WebSocketMessageType.Text, true, heartbeatCts.Token).ConfigureAwait(false);
                }
                catch { break; }
            }
        }, heartbeatCts.Token);

        // Read loop
        var buffer = new byte[8192];
        try
        {
            while (ws.State == WebSocketState.Open && !session.Cts.Token.IsCancellationRequested)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), session.Cts.Token).ConfigureAwait(false);

                if (result.MessageType == WebSocketMessageType.Close)
                    break;

                if (result.MessageType != WebSocketMessageType.Text)
                    continue;

                // Handle fragmented messages
                var msgBytes = new ArraySegment<byte>(buffer, 0, result.Count);
                if (!result.EndOfMessage)
                {
                    using var ms = new MemoryStream();
                    ms.Write(msgBytes);
                    while (!result.EndOfMessage)
                    {
                        result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), session.Cts.Token).ConfigureAwait(false);
                        ms.Write(buffer, 0, result.Count);
                    }
                    msgBytes = new ArraySegment<byte>(ms.ToArray());
                }

                var text = Encoding.UTF8.GetString(msgBytes);
                await HandleWsMessageAsync(session, text).ConfigureAwait(false);
            }
        }
        catch (WebSocketException) { }
        catch (OperationCanceledException) { }
        catch (Exception ex) { _log?.Invoke($"[WS] {username}/{deviceId} error: {ex.Message}"); }
        finally
        {
            heartbeatCts.Cancel();
            _ws.Unregister(session);
            _log?.Invoke($"[WS] {username}/{deviceId} disconnected (sessions: {_ws.SessionCount})");

            // Broadcast presence offline only if no remaining sessions
            if (!_ws.IsConnected(username))
                await BroadcastPresenceAsync(username, false).ConfigureAwait(false);

            if (ws.State == WebSocketState.Open || ws.State == WebSocketState.CloseReceived)
            {
                try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).ConfigureAwait(false); }
                catch { }
            }
        }
    }

    private async Task HandleWsMessageAsync(WsConnectionTracker.WsSession session, string text)
    {
        WsIncoming? msg;
        try { msg = JsonSerializer.Deserialize<WsIncoming>(text, _jsonIn); }
        catch { await WsSendErrorAsync(session, "Invalid JSON"); return; }

        if (msg?.Type is null) { await WsSendErrorAsync(session, "Missing type"); return; }

        switch (msg.Type.ToUpperInvariant())
        {
            case "SEND_DM":
                await HandleWsSendDmAsync(session, msg).ConfigureAwait(false);
                break;

            case "ACK":
                await HandleWsAckAsync(session, msg).ConfigureAwait(false);
                break;

            case "FETCH_MISSED":
                await DeliverMissedAsync(session).ConfigureAwait(false);
                break;

            case "HEARTBEAT":
                _presence.RefreshHeartbeat(session.Username);
                await _ws.SendToSessionAsync(session, """{"type":"HEARTBEAT_ACK"}""").ConfigureAwait(false);
                break;

            default:
                await WsSendErrorAsync(session, $"Unknown type: {msg.Type}").ConfigureAwait(false);
                break;
        }
    }

    private async Task HandleWsSendDmAsync(WsConnectionTracker.WsSession session, WsIncoming msg)
    {
        if (string.IsNullOrWhiteSpace(msg.To))
        {
            await WsSendErrorAsync(session, "Missing 'to' field");
            return;
        }

        if (!_users.Exists(msg.To))
        {
            await WsSendErrorAsync(session, "Recipient not found");
            return;
        }

        if (string.IsNullOrWhiteSpace(msg.Ciphertext) || string.IsNullOrWhiteSpace(msg.Nonce))
        {
            await WsSendErrorAsync(session, "ciphertext and nonce are required");
            return;
        }

        // Per-user rate limiting
        if (!_rateLimiter.TryAcquire(session.Username))
        {
            await WsSendErrorAsync(session, "Rate limited — too many messages");
            return;
        }

        // Durable write BEFORE acknowledging to the sender
        var id = _mailbox.Store(session.Username, msg.To, msg.Ciphertext, msg.Nonce);
        var sentAt = DateTime.UtcNow.ToString("O");

        // ACK back to sender
        var ack = JsonSerializer.Serialize(new { type = "DM_ACK", id, sentAt }, _jsonOut);
        await _ws.SendToSessionAsync(session, ack).ConfigureAwait(false);

        // Push to all recipient sessions
        var dm = JsonSerializer.Serialize(new
        {
            type = "DM",
            id,
            from = session.Username,
            ciphertext = msg.Ciphertext,
            nonce = msg.Nonce,
            sentAt,
        }, _jsonOut);
        var delivered = await _ws.SendToUserAsync(msg.To, dm).ConfigureAwait(false);

        _log?.Invoke($"[WS] DM {session.Username} → {msg.To} (id={id}, pushed to {delivered} sessions)");
    }

    private async Task HandleWsAckAsync(WsConnectionTracker.WsSession session, WsIncoming msg)
    {
        if (msg.Id is null)
        {
            await WsSendErrorAsync(session, "Missing 'id' field");
            return;
        }

        // Delete from mailbox (idempotent — second ACK returns false silently)
        _mailbox.Delete(msg.Id.Value, session.Username);
    }

    private async Task DeliverMissedAsync(WsConnectionTracker.WsSession session)
    {
        var messages = _mailbox.GetInbox(session.Username)
            .Select(m => new
            {
                id = m.Id,
                from = m.From,
                ciphertext = m.Ciphertext,
                nonce = m.Nonce,
                sentAt = m.SentAt.ToString("O"),
            })
            .ToArray();

        if (messages.Length == 0) return;

        var json = JsonSerializer.Serialize(new { type = "MISSED_MESSAGES", messages }, _jsonOut);
        await _ws.SendToSessionAsync(session, json).ConfigureAwait(false);
        _log?.Invoke($"[WS] Delivered {messages.Length} missed messages to {session.Username}/{session.DeviceId}");
    }

    private async Task BroadcastPresenceAsync(string username, bool online)
    {
        var json = JsonSerializer.Serialize(new { type = "PRESENCE_UPDATE", username, online }, _jsonOut);
        // Broadcast to all connected users (they can filter by friends client-side)
        foreach (var user in _ws.GetOnlineUsers())
        {
            if (!string.Equals(user, username, StringComparison.OrdinalIgnoreCase))
                await _ws.SendToUserAsync(user, json).ConfigureAwait(false);
        }
    }

    private async Task WsSendErrorAsync(WsConnectionTracker.WsSession session, string message)
    {
        var json = JsonSerializer.Serialize(new { type = "ERROR", message }, _jsonOut);
        await _ws.SendToSessionAsync(session, json).ConfigureAwait(false);
    }

    // ── HTTP Handlers ────────────────────────────────────────────────────────
    private async Task HandleRegisterAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var body = await ReadJsonAsync<RegisterRequest>(req).ConfigureAwait(false);
        if (body is null) { await WriteJsonAsync(res, 400, new { error = "Invalid request body" }); return; }

        var (success, error) = _users.Register(body.Username ?? "", body.Password ?? "", body.PublicKey ?? "");
        if (!success) { await WriteJsonAsync(res, 400, new { error }); return; }

        _log?.Invoke($"[Rendezvous] Registered user: {body.Username}");
        await WriteJsonAsync(res, 200, new { success = true }).ConfigureAwait(false);
    }

    private async Task HandleAuthAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var body = await ReadJsonAsync<AuthRequest>(req).ConfigureAwait(false);
        if (body is null) { await WriteJsonAsync(res, 400, new { error = "Invalid request body" }); return; }

        var (success, error) = _users.Authenticate(body.Username ?? "", body.Password ?? "");
        if (!success) { await WriteJsonAsync(res, 401, new { error }); return; }

        var token = IssueToken(body.Username!);
        await WriteJsonAsync(res, 200, new { token }).ConfigureAwait(false);
    }

    private async Task HandlePresencePutAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        var body = await ReadJsonAsync<PresenceRequest>(req).ConfigureAwait(false);
        if (body?.Address is null) { await WriteJsonAsync(res, 400, new { error = "address is required" }); return; }

        _presence.SetOnline(username, body.Address);
        await WriteJsonAsync(res, 200, new { success = true }).ConfigureAwait(false);
    }

    private async Task HandlePresenceDeleteAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        _presence.SetOffline(username);
        await WriteJsonAsync(res, 200, new { success = true }).ConfigureAwait(false);
    }

    private async Task HandlePresenceGetAsync(string target, HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        if (!_users.Exists(target)) { await WriteJsonAsync(res, 404, new { error = "User not found" }); return; }

        var (online, address) = _presence.GetPresence(target);
        // Also consider WebSocket presence
        if (!online && _ws.IsConnected(target))
            online = true;
        var publicKey = _users.GetPublicKey(target);
        await WriteJsonAsync(res, 200, new { online, address, publicKey }).ConfigureAwait(false);
    }

    private async Task HandlePubkeyGetAsync(string target, HttpListenerResponse res)
    {
        var publicKey = _users.GetPublicKey(target);
        if (publicKey is null) { await WriteJsonAsync(res, 404, new { error = "User not found" }); return; }

        await WriteJsonAsync(res, 200, new { publicKey }).ConfigureAwait(false);
    }

    private async Task HandlePubkeyPutAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        var body = await ReadJsonAsync<RegisterRequest>(req).ConfigureAwait(false);
        if (body?.PublicKey is null) { await WriteJsonAsync(res, 400, new { error = "publicKey is required" }); return; }

        _users.UpdatePublicKey(username, body.PublicKey);
        _log?.Invoke($"[Rendezvous] Public key updated: {username}");
        await WriteJsonAsync(res, 200, new { success = true }).ConfigureAwait(false);
    }

    private async Task HandleMessageSendAsync(string recipient, HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        if (!_users.Exists(recipient)) { await WriteJsonAsync(res, 404, new { error = "Recipient not found" }); return; }

        var body = await ReadJsonAsync<MessageRequest>(req).ConfigureAwait(false);
        if (body?.Ciphertext is null || body.Nonce is null)
        {
            await WriteJsonAsync(res, 400, new { error = "ciphertext and nonce are required" });
            return;
        }

        // Per-user rate limiting
        if (!_rateLimiter.TryAcquire(username))
        {
            await WriteJsonAsync(res, 429, new { error = "Rate limited — too many messages" });
            return;
        }

        // Durable write BEFORE acknowledging
        var id = _mailbox.Store(username, recipient, body.Ciphertext, body.Nonce);
        var sentAt = DateTime.UtcNow.ToString("O");

        // Try to push to the recipient's live WebSocket sessions
        var dm = JsonSerializer.Serialize(new
        {
            type = "DM",
            id,
            from = username,
            ciphertext = body.Ciphertext,
            nonce = body.Nonce,
            sentAt,
        }, _jsonOut);
        var delivered = await _ws.SendToUserAsync(recipient, dm).ConfigureAwait(false);

        _log?.Invoke($"[Rendezvous] Message {(delivered > 0 ? $"pushed to {delivered} sessions" : "stored")}: {username} → {recipient} (id={id})");
        await WriteJsonAsync(res, 200, new { id, delivered = delivered > 0 }).ConfigureAwait(false);
    }

    private async Task HandleMessageInboxAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        var messages = _mailbox.GetInbox(username)
            .Select(m => new
            {
                m.Id,
                m.From,
                m.Ciphertext,
                m.Nonce,
                SentAt = m.SentAt.ToString("O"),
            })
            .ToArray();

        await WriteJsonAsync(res, 200, messages).ConfigureAwait(false);
    }

    private async Task HandleMessageDeleteAsync(string idStr, HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        if (!long.TryParse(idStr, out var id))
        {
            await WriteJsonAsync(res, 400, new { error = "Invalid message ID" });
            return;
        }

        if (!_mailbox.Delete(id, username))
        {
            await WriteJsonAsync(res, 404, new { error = "Message not found" });
            return;
        }

        await WriteJsonAsync(res, 200, new { success = true }).ConfigureAwait(false);
    }

    private async Task HandleFriendsGetAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        var friends = _friends.GetFriends(username);
        await WriteJsonAsync(res, 200, friends).ConfigureAwait(false);
    }

    private async Task HandleFriendAddAsync(string target, HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        if (!_users.Exists(target)) { await WriteJsonAsync(res, 404, new { error = "User not found" }); return; }
        if (string.Equals(username, target, StringComparison.OrdinalIgnoreCase))
        {
            await WriteJsonAsync(res, 400, new { error = "Cannot friend yourself" }); return;
        }

        _friends.Add(username, target);
        _log?.Invoke($"[Rendezvous] Friendship recorded: {username} <-> {target}");
        await WriteJsonAsync(res, 200, new { success = true }).ConfigureAwait(false);
    }

    private async Task HandleFriendRemoveAsync(string target, HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

        _friends.Remove(username, target);
        _log?.Invoke($"[Rendezvous] Friendship removed: {username} <-> {target}");
        await WriteJsonAsync(res, 200, new { success = true }).ConfigureAwait(false);
    }

    // ── Token auth ───────────────────────────────────────────────────────────
    private string IssueToken(string username)
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var payload = $"{username}:{timestamp}";
        var sig = ComputeHmac(payload);
        var token = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{payload}:{sig}"));
        _tokens[token] = (username, DateTime.UtcNow);
        return token;
    }

    private string? ValidateToken(string token)
    {
        if (!_tokens.TryGetValue(token, out var entry)) return null;
        if (DateTime.UtcNow - entry.issuedAt > TokenLifetime)
        {
            _tokens.TryRemove(token, out _);
            return null;
        }
        return entry.username;
    }

    private string? AuthenticateRequest(HttpListenerRequest req)
    {
        var auth = req.Headers["Authorization"];
        if (auth is null || !auth.StartsWith("Bearer ")) return null;
        return ValidateToken(auth[7..]);
    }

    private string ComputeHmac(string data)
    {
        var bytes = Encoding.UTF8.GetBytes(data);
        return Convert.ToBase64String(HMACSHA256.HashData(_hmacKey, bytes));
    }

    // ── JSON helpers ─────────────────────────────────────────────────────────
    private static async Task<T?> ReadJsonAsync<T>(HttpListenerRequest req)
    {
        try
        {
            using var reader = new StreamReader(req.InputStream, Encoding.UTF8);
            var body = await reader.ReadToEndAsync().ConfigureAwait(false);
            return JsonSerializer.Deserialize<T>(body, _jsonIn);
        }
        catch { return default; }
    }

    private static async Task WriteJsonAsync(HttpListenerResponse res, int statusCode, object data)
    {
        var json = JsonSerializer.Serialize(data, _jsonOut);
        var bytes = Encoding.UTF8.GetBytes(json);
        res.StatusCode = statusCode;
        res.ContentType = "application/json";
        res.ContentLength64 = bytes.Length;
        await res.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
        res.Close();
    }
}
