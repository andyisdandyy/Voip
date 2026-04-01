using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;

/// <summary>
/// Tracks all active WebSocket sessions across all users.
/// Supports multiple simultaneous sessions per user (multi-device).
/// Thread-safe for concurrent send/receive.
/// </summary>
public class WsConnectionTracker
{
    public class WsSession
    {
        public string Username { get; }
        public string DeviceId { get; }
        public WebSocket Socket { get; }
        public CancellationTokenSource Cts { get; } = new();

        public WsSession(string username, string deviceId, WebSocket socket)
        {
            Username = username;
            DeviceId = deviceId;
            Socket = socket;
        }
    }

    private readonly ConcurrentDictionary<string, ConcurrentBag<WsSession>> _sessions = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    public WsSession Register(string username, string deviceId, WebSocket socket)
    {
        var session = new WsSession(username, deviceId, socket);
        _sessions.AddOrUpdate(username,
            _ => new ConcurrentBag<WsSession> { session },
            (_, bag) => { bag.Add(session); return bag; });
        return session;
    }

    public void Unregister(WsSession session)
    {
        session.Cts.Cancel();
        if (!_sessions.TryGetValue(session.Username, out var bag)) return;
        var remaining = bag.Where(s => s != session).ToArray();
        if (remaining.Length == 0)
            _sessions.TryRemove(session.Username, out _);
        else
        {
            var newBag = new ConcurrentBag<WsSession>(remaining);
            _sessions.TryUpdate(session.Username, newBag, bag);
        }
    }

    /// <summary>Sends a text message to a single session. Returns true on success.</summary>
    public async Task<bool> SendToSessionAsync(WsSession session, string json)
    {
        if (session.Socket.State != WebSocketState.Open) return false;
        var bytes = new ArraySegment<byte>(Encoding.UTF8.GetBytes(json));
        await _sendLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (session.Socket.State != WebSocketState.Open) return false;
            await session.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, session.Cts.Token).ConfigureAwait(false);
            return true;
        }
        catch { return false; }
        finally { _sendLock.Release(); }
    }

    /// <summary>
    /// Broadcasts a message to ALL active sessions for the given user.
    /// Returns the number of sessions the message was successfully sent to.
    /// </summary>
    public async Task<int> SendToUserAsync(string username, string json)
    {
        if (!_sessions.TryGetValue(username, out var bag)) return 0;
        var sent = 0;
        foreach (var session in bag)
            if (await SendToSessionAsync(session, json).ConfigureAwait(false))
                sent++;
        return sent;
    }

    public bool IsConnected(string username) =>
        _sessions.TryGetValue(username, out var bag) && bag.Any(s => s.Socket.State == WebSocketState.Open);

    public IEnumerable<string> GetOnlineUsers() =>
        _sessions.Where(kv => kv.Value.Any(s => s.Socket.State == WebSocketState.Open))
                 .Select(kv => kv.Key);

    public int SessionCount => _sessions.Values.Sum(b => b.Count);
}
