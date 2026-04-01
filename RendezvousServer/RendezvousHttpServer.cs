using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// Rendezvous server v2 -- HTTP REST + WebSocket at /ws.
///
/// HTTP Endpoints:
///   GET  /                       -- server info
///   GET  /myip                   -- caller IP
///   POST /register               -- {username, password, publicKey}
///   POST /auth                   -- {username, password} -> {token}
///   PUT  /presence               -- heartbeat {address} (auth)
///   DELETE /presence             -- go offline (auth)
///   GET  /presence/{username}    -- status + publicKey (auth)
///   GET  /pubkey/{username}      -- public key (no auth)
///   PUT  /pubkey                 -- update key (auth)
///   POST /messages/{recipient}   -- send offline DM (auth)
///   GET  /messages               -- inbox (auth)
///   DELETE /messages/{id}        -- ACK + delete (auth)
///   GET  /friends                -- list friends (auth)
///   POST /friends/{target}       -- add friend (auth)
///   DELETE /friends/{target}     -- remove friend (auth)
///
/// WebSocket Endpoint:
///   GET /ws?token=&deviceId=     -- upgrade; multi-device, one per session
///
/// WS Protocol (JSON text frames):
///   Client->Server: SEND_DM, ACK, FETCH_MISSED, HEARTBEAT
///   Server->Client: DM, DM_ACK, MISSED_MESSAGES, PRESENCE_UPDATE, HEARTBEAT_ACK, ERROR
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

    private record RegisterRequest(string? Username, string? Password, string? PublicKey);
    private record AuthRequest(string? Username, string? Password);
    private record PresenceRequest(string? Address);
    private record MessageRequest(string? Ciphertext, string? Nonce);
    private record WsIncoming(string? Type, string? To, string? Ciphertext, string? Nonce, long? Id);

    public RendezvousHttpServer(RendezvousConfig config, UserRegistry users, PresenceTracker presence,
        OfflineMailbox mailbox, FriendStore friends, Action<string>? log = null)
    {
        _config = config; _users = users; _presence = presence;
        _mailbox = mailbox; _friends = friends; _log = log;
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
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromHours(6), ct).ConfigureAwait(false);
                var removed = _mailbox.CleanupExpired();
                if (removed > 0) _log?.Invoke($"[Rendezvous] Cleanup: purged {removed} expired messages");
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
        finally { try { _listener.Stop(); } catch { } }
    }

    private async Task HandleRequestAsync(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var res = ctx.Response;
        res.Headers.Add("Access-Control-Allow-Origin", "*");
        res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.Headers.Add("Access-Control-Allow-Headers", "Authorization, Content-Type");
        if (req.HttpMethod == "OPTIONS") { res.StatusCode = 204; res.Close(); return; }

        var path = req.Url?.AbsolutePath?.TrimEnd('/') ?? "";
        var method = req.HttpMethod;
        try
        {
            if (method == "GET" && path == "/ws" && ctx.Request.IsWebSocketRequest)
                await HandleWebSocketUpgradeAsync(ctx).ConfigureAwait(false);
            else if (method == "GET" && path == "")
                await WriteJsonAsync(res, 200, new { name = _config.ServerName, type = "rendezvous", version = 2 }).ConfigureAwait(false);
            else if (method == "GET" && path == "/myip")
                await WriteJsonAsync(res, 200, new { ip = req.RemoteEndPoint?.Address?.ToString() }).ConfigureAwait(false);
            else if (method == "POST" && path == "/register")
                await HandleRegisterAsync(req, res).ConfigureAwait(false);
            else if (method == "POST" && path == "/auth")
                await HandleAuthAsync(req, res).ConfigureAwait(false);
            else if (method == "PUT" && path == "/presence")
                await HandlePresencePutAsync(req, res).ConfigureAwait(false);
            else if (method == "DELETE" && path == "/presence")
                await HandlePresenceDeleteAsync(req, res).ConfigureAwait(false);
            else if (method == "GET" && path.StartsWith("/presence/"))
                await HandlePresenceGetAsync(path["/presence/".Length..], req, res).ConfigureAwait(false);
            else if (method == "GET" && path.StartsWith("/pubkey/"))
                await HandlePubkeyGetAsync(path["/pubkey/".Length..], res).ConfigureAwait(false);
            else if (method == "PUT" && path == "/pubkey")
                await HandlePubkeyPutAsync(req, res).ConfigureAwait(false);
            else if (method == "POST" && path.StartsWith("/messages/"))
                await HandleMessageSendAsync(path["/messages/".Length..], req, res).ConfigureAwait(false);
            else if (method == "GET" && path == "/messages")
                await HandleMessageInboxAsync(req, res).ConfigureAwait(false);
            else if (method == "DELETE" && path.StartsWith("/messages/"))
                await HandleMessageDeleteAsync(path["/messages/".Length..], req, res).ConfigureAwait(false);
            else if (method == "GET" && path == "/friends")
                await HandleFriendsGetAsync(req, res).ConfigureAwait(false);
            else if (method == "POST" && path.StartsWith("/friends/"))
                await HandleFriendAddAsync(path["/friends/".Length..], req, res).ConfigureAwait(false);
            else if (method == "DELETE" && path.StartsWith("/friends/"))
                await HandleFriendRemoveAsync(path["/friends/".Length..], req, res).ConfigureAwait(false);
            else if (method == "GET" && path == "/events")
                await WriteJsonAsync(res, 410, new { error = "SSE removed. Use WebSocket at /ws" }).ConfigureAwait(false);
            else
                await WriteJsonAsync(res, 404, new { error = "Not found" }).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"[Rendezvous] Error {method} {path}: {ex.Message}");
            try { await WriteJsonAsync(res, 500, new { error = "Internal server error" }).ConfigureAwait(false); } catch { }
        }
    }
    private async Task HandleWebSocketUpgradeAsync(HttpListenerContext ctx)
    {
        var token = ctx.Request.QueryString["token"];
        var username = string.IsNullOrEmpty(token) ? null : ValidateToken(token);
        if (username is null) { ctx.Response.StatusCode = 401; ctx.Response.Close(); return; }

        WebSocketContext wsCtx;
        try { wsCtx = await ctx.AcceptWebSocketAsync(subProtocol: null).ConfigureAwait(false); }
        catch { ctx.Response.StatusCode = 500; ctx.Response.Close(); return; }

        var ws = wsCtx.WebSocket;
        var deviceId = ctx.Request.QueryString["deviceId"] ?? Guid.NewGuid().ToString("N")[..8];
        var session = _ws.Register(username, deviceId, ws);
        _log?.Invoke($"[WS] {username}/{deviceId} connected (total: {_ws.SessionCount})");

        await BroadcastPresenceAsync(username, true).ConfigureAwait(false);
        await DeliverMissedAsync(session).ConfigureAwait(false);

        var hbCts = CancellationTokenSource.CreateLinkedTokenSource(session.Cts.Token);
        _ = Task.Run(async () =>
        {
            var interval = TimeSpan.FromSeconds(_config.HeartbeatIntervalSeconds);
            while (!hbCts.Token.IsCancellationRequested)
            {
                await Task.Delay(interval, hbCts.Token).ConfigureAwait(false);
                try
                {
                    if (ws.State == WebSocketState.Open)
                        await ws.SendAsync(Encoding.UTF8.GetBytes("{\"type\":\"HEARTBEAT_ACK\"}"),
                            WebSocketMessageType.Text, true, hbCts.Token).ConfigureAwait(false);
                }
                catch { break; }
            }
        }, hbCts.Token);

        var buffer = new byte[32768];
        try
        {
            while (ws.State == WebSocketState.Open && !session.Cts.Token.IsCancellationRequested)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), session.Cts.Token).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.MessageType != WebSocketMessageType.Text) continue;

                byte[] msgBytes;
                if (result.EndOfMessage)
                {
                    msgBytes = buffer[..result.Count];
                }
                else
                {
                    using var ms = new MemoryStream();
                    ms.Write(buffer, 0, result.Count);
                    while (!result.EndOfMessage)
                    {
                        result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), session.Cts.Token).ConfigureAwait(false);
                        ms.Write(buffer, 0, result.Count);
                    }
                    msgBytes = ms.ToArray();
                }
                await HandleWsMessageAsync(session, Encoding.UTF8.GetString(msgBytes)).ConfigureAwait(false);
            }
        }
        catch (WebSocketException) { }
        catch (OperationCanceledException) { }
        finally
        {
            hbCts.Cancel();
            _ws.Unregister(session);
            _log?.Invoke($"[WS] {username}/{deviceId} disconnected (total: {_ws.SessionCount})");
            if (!_ws.IsConnected(username)) await BroadcastPresenceAsync(username, false).ConfigureAwait(false);
            if (ws.State == WebSocketState.Open || ws.State == WebSocketState.CloseReceived)
                try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).ConfigureAwait(false); } catch { }
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
            case "SEND_DM":  await HandleWsSendDmAsync(session, msg).ConfigureAwait(false); break;
            case "ACK":      await HandleWsAckAsync(session, msg).ConfigureAwait(false); break;
            case "FETCH_MISSED": await DeliverMissedAsync(session).ConfigureAwait(false); break;
            case "HEARTBEAT":
                _presence.RefreshHeartbeat(session.Username);
                await _ws.SendToSessionAsync(session, "{\"type\":\"HEARTBEAT_ACK\"}").ConfigureAwait(false);
                break;
            default: await WsSendErrorAsync(session, $"Unknown type: {msg.Type}"); break;
        }
    }

    private async Task HandleWsSendDmAsync(WsConnectionTracker.WsSession session, WsIncoming msg)
    {
        if (string.IsNullOrWhiteSpace(msg.To)) { await WsSendErrorAsync(session, "Missing 'to'"); return; }
        if (!_users.Exists(msg.To)) { await WsSendErrorAsync(session, "Recipient not found"); return; }
        if (string.IsNullOrWhiteSpace(msg.Ciphertext) || string.IsNullOrWhiteSpace(msg.Nonce))
            { await WsSendErrorAsync(session, "ciphertext and nonce are required"); return; }
        if (!_rateLimiter.TryAcquire(session.Username))
            { await WsSendErrorAsync(session, "Rate limited"); return; }

        var id = _mailbox.Store(session.Username, msg.To, msg.Ciphertext, msg.Nonce);
        var sentAt = DateTime.UtcNow.ToString("O");

        await _ws.SendToSessionAsync(session,
            JsonSerializer.Serialize(new { type = "DM_ACK", id, sentAt }, _jsonOut)).ConfigureAwait(false);

        var dm = JsonSerializer.Serialize(new { type = "DM", id, from = session.Username, ciphertext = msg.Ciphertext, nonce = msg.Nonce, sentAt }, _jsonOut);
        var delivered = await _ws.SendToUserAsync(msg.To, dm).ConfigureAwait(false);
        _log?.Invoke($"[WS] DM {session.Username}->{msg.To} id={id} pushed={delivered}");
    }

    private async Task HandleWsAckAsync(WsConnectionTracker.WsSession session, WsIncoming msg)
    {
        if (msg.Id is null) { await WsSendErrorAsync(session, "Missing 'id'"); return; }
        _mailbox.Delete(msg.Id.Value, session.Username);
    }

    private async Task DeliverMissedAsync(WsConnectionTracker.WsSession session)
    {
        var messages = _mailbox.GetInbox(session.Username)
            .Select(m => new { id = m.Id, from = m.From, ciphertext = m.Ciphertext, nonce = m.Nonce, sentAt = m.SentAt.ToString("O") })
            .ToArray();
        if (messages.Length == 0) return;
        await _ws.SendToSessionAsync(session,
            JsonSerializer.Serialize(new { type = "MISSED_MESSAGES", messages }, _jsonOut)).ConfigureAwait(false);
        _log?.Invoke($"[WS] {session.Username}/{session.DeviceId}: {messages.Length} missed messages delivered");
    }

    private async Task BroadcastPresenceAsync(string username, bool online)
    {
        var json = JsonSerializer.Serialize(new { type = "PRESENCE_UPDATE", username, online }, _jsonOut);
        foreach (var user in _ws.GetOnlineUsers())
            if (!string.Equals(user, username, StringComparison.OrdinalIgnoreCase))
                await _ws.SendToUserAsync(user, json).ConfigureAwait(false);
    }

    private async Task WsSendErrorAsync(WsConnectionTracker.WsSession session, string message) =>
        await _ws.SendToSessionAsync(session, JsonSerializer.Serialize(new { type = "ERROR", message }, _jsonOut)).ConfigureAwait(false);
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
        await WriteJsonAsync(res, 200, new { token = IssueToken(body.Username!) }).ConfigureAwait(false);
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
        if (!online && _ws.IsConnected(target)) online = true;
        await WriteJsonAsync(res, 200, new { online, address, publicKey = _users.GetPublicKey(target) }).ConfigureAwait(false);
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
            { await WriteJsonAsync(res, 400, new { error = "ciphertext and nonce are required" }); return; }
        if (!_rateLimiter.TryAcquire(username))
            { await WriteJsonAsync(res, 429, new { error = "Rate limited" }); return; }

        var id = _mailbox.Store(username, recipient, body.Ciphertext, body.Nonce);
        var sentAt = DateTime.UtcNow.ToString("O");
        var dm = JsonSerializer.Serialize(new { type = "DM", id, from = username, ciphertext = body.Ciphertext, nonce = body.Nonce, sentAt }, _jsonOut);
        var delivered = await _ws.SendToUserAsync(recipient, dm).ConfigureAwait(false);
        _log?.Invoke($"[Rendezvous] DM {username}->{recipient} id={id} pushed={delivered}");
        await WriteJsonAsync(res, 200, new { id, delivered = delivered > 0 }).ConfigureAwait(false);
    }

    private async Task HandleMessageInboxAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }
        var messages = _mailbox.GetInbox(username)
            .Select(m => new { m.Id, m.From, m.Ciphertext, m.Nonce, SentAt = m.SentAt.ToString("O") })
            .ToArray();
        await WriteJsonAsync(res, 200, messages).ConfigureAwait(false);
    }

    private async Task HandleMessageDeleteAsync(string idStr, HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }
        if (!long.TryParse(idStr, out var id)) { await WriteJsonAsync(res, 400, new { error = "Invalid message ID" }); return; }
        if (!_mailbox.Delete(id, username)) { await WriteJsonAsync(res, 404, new { error = "Message not found" }); return; }
        await WriteJsonAsync(res, 200, new { success = true }).ConfigureAwait(false);
    }

    private async Task HandleFriendsGetAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }
        await WriteJsonAsync(res, 200, _friends.GetFriends(username)).ConfigureAwait(false);
    }

    private async Task HandleFriendAddAsync(string target, HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }
        if (!_users.Exists(target)) { await WriteJsonAsync(res, 404, new { error = "User not found" }); return; }
        if (string.Equals(username, target, StringComparison.OrdinalIgnoreCase))
            { await WriteJsonAsync(res, 400, new { error = "Cannot friend yourself" }); return; }
        _friends.Add(username, target);
        _log?.Invoke($"[Rendezvous] Friendship: {username} <-> {target}");
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
        if (DateTime.UtcNow - entry.issuedAt > TokenLifetime) { _tokens.TryRemove(token, out _); return null; }
        return entry.username;
    }

    private string? AuthenticateRequest(HttpListenerRequest req)
    {
        var auth = req.Headers["Authorization"];
        if (auth is null || !auth.StartsWith("Bearer ")) return null;
        return ValidateToken(auth[7..]);
    }

    private string ComputeHmac(string data) =>
        Convert.ToBase64String(HMACSHA256.HashData(_hmacKey, Encoding.UTF8.GetBytes(data)));

    private static async Task<T?> ReadJsonAsync<T>(HttpListenerRequest req)
    {
        try
        {
            using var reader = new StreamReader(req.InputStream, Encoding.UTF8);
            return JsonSerializer.Deserialize<T>(await reader.ReadToEndAsync().ConfigureAwait(false), _jsonIn);
        }
        catch { return default; }
    }

    private static async Task WriteJsonAsync(HttpListenerResponse res, int statusCode, object data)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(data, _jsonOut));
        res.StatusCode = statusCode;
        res.ContentType = "application/json";
        res.ContentLength64 = bytes.Length;
        await res.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
        res.Close();
    }
}