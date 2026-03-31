using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// Lightweight HTTP rendezvous server for P2P friend connections.
///
/// Endpoints:
///   GET  /                       — server info (name, type)
///   GET  /myip                   — returns the caller's public IP as seen by the server
///   POST /register               — register a new user {username, password, publicKey}
///   POST /auth                   — authenticate and receive a bearer token {username, password}
///   PUT  /presence               — mark self online (auth) {address}; acts as heartbeat
///   DELETE /presence             — mark self offline (auth)
///   GET  /presence/{username}    — check online status + address + publicKey (auth)
///   GET  /pubkey/{username}      — get a user's public key (no auth required)
///   POST /messages/{recipient}   — store encrypted message for offline user (auth) {ciphertext, nonce}
///   GET  /messages               — fetch inbox (auth)
///   DELETE /messages/{id}        — acknowledge and delete a delivered message (auth)
///   GET  /friends                — list confirmed friends (auth)
///   POST /friends/{target}       — record a confirmed friendship (auth)
///   DELETE /friends/{target}     — remove a friendship (auth)
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
                _mailbox.CleanupExpired();
                _log?.Invoke("[Rendezvous] Mailbox cleanup complete");
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
            if (method == "GET" && path == "")
            {
                await WriteJsonAsync(res, 200, new { name = _config.ServerName, type = "rendezvous" }).ConfigureAwait(false);
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

    // ── Handlers ─────────────────────────────────────────────────────────────
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
        var publicKey = _users.GetPublicKey(target);
        await WriteJsonAsync(res, 200, new { online, address, publicKey }).ConfigureAwait(false);
    }

    private async Task HandlePubkeyGetAsync(string target, HttpListenerResponse res)
    {
        var publicKey = _users.GetPublicKey(target);
        if (publicKey is null) { await WriteJsonAsync(res, 404, new { error = "User not found" }); return; }

        await WriteJsonAsync(res, 200, new { publicKey }).ConfigureAwait(false);
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

        var id = _mailbox.Store(username, recipient, body.Ciphertext, body.Nonce);
        _log?.Invoke($"[Rendezvous] Message stored: {username} → {recipient} ({id})");
        await WriteJsonAsync(res, 200, new { id }).ConfigureAwait(false);
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

    private async Task HandleMessageDeleteAsync(string id, HttpListenerRequest req, HttpListenerResponse res)
    {
        var username = AuthenticateRequest(req);
        if (username is null) { await WriteJsonAsync(res, 401, new { error = "Unauthorized" }); return; }

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
