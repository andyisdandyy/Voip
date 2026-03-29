using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// Lightweight SSE (Server-Sent Events) endpoint for push notifications.
/// Clients connect via <c>GET /events?token=&lt;token&gt;</c> and receive
/// real-time mention events without a full TCP chat session.
/// Tokens are HMAC-SHA256 signed and issued during TCP authentication.
/// </summary>
public class NotificationServer
{
    private readonly HttpListener _listener;
    private readonly Action<string>? _log;
    private readonly byte[] _hmacKey;

    /// <summary>Active SSE subscribers: username → set of response streams.</summary>
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<SseClient, byte>> _subscribers = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Issued tokens: token string → username (for validation).</summary>
    private readonly ConcurrentDictionary<string, (string username, DateTime issuedAt)> _tokens = new();

    private static readonly TimeSpan TokenLifetime = TimeSpan.FromDays(7);

    private record SseClient(StreamWriter Writer, CancellationTokenSource Cts);

    public NotificationServer(int port, bool bindLocalhost, Action<string>? log = null)
    {
        _log = log;
        _listener = new HttpListener();
        var host = bindLocalhost ? "127.0.0.1" : "+";
        _listener.Prefixes.Add($"http://{host}:{port}/");

        // Generate a random HMAC key for token signing (persists for server lifetime)
        _hmacKey = new byte[32];
        RandomNumberGenerator.Fill(_hmacKey);
    }

    /// <summary>
    /// Creates a signed session token for the given username.
    /// Called by <see cref="ChatServer"/> after successful authentication.
    /// </summary>
    public string IssueToken(string username)
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var payload = $"{username}:{timestamp}";
        var sig = ComputeHmac(payload);
        var token = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{payload}:{sig}"));

        _tokens[token] = (username, DateTime.UtcNow);
        return token;
    }

    /// <summary>
    /// Validates a token and returns the username if valid.
    /// </summary>
    private string? ValidateToken(string token)
    {
        if (_tokens.TryGetValue(token, out var entry))
        {
            if (DateTime.UtcNow - entry.issuedAt > TokenLifetime)
            {
                _tokens.TryRemove(token, out _);
                return null;
            }
            return entry.username;
        }

        // Verify HMAC signature for tokens we may not have in memory (restart scenario — fail closed)
        try
        {
            var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(token));
            var lastColon = decoded.LastIndexOf(':');
            if (lastColon < 0) return null;

            var payload = decoded[..lastColon];
            var sig = decoded[(lastColon + 1)..];

            if (ComputeHmac(payload) != sig) return null;

            var firstColon = payload.IndexOf(':');
            if (firstColon < 0) return null;

            var username = payload[..firstColon];
            var timestampStr = payload[(firstColon + 1)..];
            if (!long.TryParse(timestampStr, out var ts)) return null;

            var issued = DateTimeOffset.FromUnixTimeSeconds(ts).UtcDateTime;
            if (DateTime.UtcNow - issued > TokenLifetime) return null;

            return username;
        }
        catch
        {
            return null;
        }
    }

    private string ComputeHmac(string payload)
    {
        var payloadBytes = Encoding.UTF8.GetBytes(payload);
        var hash = HMACSHA256.HashData(_hmacKey, payloadBytes);
        return Convert.ToHexStringLower(hash);
    }

    /// <summary>
    /// Pushes a mention event to all SSE subscribers for the given username.
    /// </summary>
    public async Task PushMentionAsync(string targetUsername, string room, string sender, string text)
    {
        if (!_subscribers.TryGetValue(targetUsername, out var clients)) return;

        var data = JsonSerializer.Serialize(new { room, sender, text, timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() });
        var ssePayload = $"event: mention\ndata: {data}\n\n";

        var dead = new List<SseClient>();
        foreach (var kv in clients)
        {
            var client = kv.Key;
            try
            {
                if (client.Cts.IsCancellationRequested) { dead.Add(client); continue; }
                await client.Writer.WriteAsync(ssePayload).ConfigureAwait(false);
                await client.Writer.FlushAsync().ConfigureAwait(false);
            }
            catch
            {
                dead.Add(client);
            }
        }

        // Clean up dead connections
        foreach (var d in dead)
        {
            d.Cts.Cancel();
            clients.TryRemove(d, out _);
        }
    }

    public async Task StartAsync(CancellationToken ct = default)
    {
        _listener.Start();
        _log?.Invoke($"[SSE] Notification server listening on {_listener.Prefixes.First()}");

        // Periodic token cleanup
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMinutes(30), ct).ConfigureAwait(false);
                foreach (var kv in _tokens)
                {
                    if (DateTime.UtcNow - kv.Value.issuedAt > TokenLifetime)
                        _tokens.TryRemove(kv.Key, out _);
                }
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

    private async Task HandleRequestAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;

        // Only accept GET /events
        if (request.HttpMethod != "GET" || request.Url?.AbsolutePath != "/events")
        {
            response.StatusCode = 404;
            response.Close();
            return;
        }

        var token = request.QueryString["token"];
        if (string.IsNullOrEmpty(token))
        {
            response.StatusCode = 401;
            response.Close();
            return;
        }

        var username = ValidateToken(token);
        if (username == null)
        {
            response.StatusCode = 403;
            response.Close();
            return;
        }

        // Set SSE headers
        response.ContentType = "text/event-stream";
        response.Headers.Add("Cache-Control", "no-cache");
        response.Headers.Add("Connection", "keep-alive");
        response.Headers.Add("Access-Control-Allow-Origin", "*");
        response.StatusCode = 200;

        var cts = new CancellationTokenSource();
        var writer = new StreamWriter(response.OutputStream, new UTF8Encoding(false)) { AutoFlush = false };
        var client = new SseClient(writer, cts);

        var bag = _subscribers.GetOrAdd(username, _ => new ConcurrentDictionary<SseClient, byte>());
        bag.TryAdd(client, 0);

        _log?.Invoke($"[SSE] '{username}' subscribed for notifications");

        try
        {
            // Send initial retry interval (15 seconds)
            await writer.WriteAsync("retry: 15000\n\n").ConfigureAwait(false);
            await writer.FlushAsync().ConfigureAwait(false);

            // Keep the connection alive with periodic heartbeats
            while (!cts.IsCancellationRequested)
            {
                await Task.Delay(25_000, cts.Token).ConfigureAwait(false);
                await writer.WriteAsync(": heartbeat\n\n").ConfigureAwait(false);
                await writer.FlushAsync().ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception) { }
        finally
        {
            cts.Cancel();
            _log?.Invoke($"[SSE] '{username}' disconnected from notifications");
            try { writer.Dispose(); } catch { }
            try { response.Close(); } catch { }
        }
    }
}
