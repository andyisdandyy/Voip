using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;

/// <summary>
/// Manages persistent WebSocket connections for real-time message delivery.
/// Supports multiple simultaneous sessions per user (multi-device).
/// Each session is identified by a (username, deviceId) pair.
/// </summary>
public class WsConnectionTracker
{
    public record WsSession(string Username, string DeviceId, WebSocket Socket, CancellationTokenSource Cts);

    // username → list of active sessions
    private readonly ConcurrentDictionary<string, ConcurrentBag<WsSession>> _sessions =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Registers a new WebSocket session for a user.</summary>
    public WsSession Register(string username, string deviceId, WebSocket socket)
    {
        var cts = new CancellationTokenSource();
        var session = new WsSession(username, deviceId, socket, cts);
        var bag = _sessions.GetOrAdd(username, _ => new ConcurrentBag<WsSession>());
        bag.Add(session);
        return session;
    }

    /// <summary>Removes a session when the WebSocket disconnects.</summary>
    public void Unregister(WsSession session)
    {
        if (!_sessions.TryGetValue(session.Username, out var bag)) return;

        // ConcurrentBag doesn't support removal — rebuild without the dead session
        var remaining = new ConcurrentBag<WsSession>(
            bag.Where(s => !ReferenceEquals(s, session)));

        if (remaining.IsEmpty)
            _sessions.TryRemove(session.Username, out _);
        else
            _sessions[session.Username] = remaining;

        session.Cts.Cancel();
    }

    /// <summary>
    /// Sends a text message to ALL active sessions for a user.
    /// Returns the number of sessions that received the message.
    /// Dead sessions are cleaned up automatically.
    /// </summary>
    public async Task<int> SendToUserAsync(string username, string json)
    {
        if (!_sessions.TryGetValue(username, out var bag)) return 0;

        var data = Encoding.UTF8.GetBytes(json);
        var segment = new ArraySegment<byte>(data);
        var delivered = 0;
        var dead = new List<WsSession>();

        foreach (var session in bag)
        {
            if (session.Socket.State != WebSocketState.Open)
            {
                dead.Add(session);
                continue;
            }

            try
            {
                await session.Socket.SendAsync(segment, WebSocketMessageType.Text, true, session.Cts.Token)
                    .ConfigureAwait(false);
                delivered++;
            }
            catch
            {
                dead.Add(session);
            }
        }

        foreach (var d in dead) Unregister(d);
        return delivered;
    }

    /// <summary>Sends a text message to a specific session.</summary>
    public async Task<bool> SendToSessionAsync(WsSession session, string json)
    {
        if (session.Socket.State != WebSocketState.Open) return false;
        try
        {
            var data = Encoding.UTF8.GetBytes(json);
            await session.Socket.SendAsync(new ArraySegment<byte>(data),
                WebSocketMessageType.Text, true, session.Cts.Token).ConfigureAwait(false);
            return true;
        }
        catch { return false; }
    }

    /// <summary>Returns true if the user has at least one live WebSocket connection.</summary>
    public bool IsConnected(string username) =>
        _sessions.TryGetValue(username, out var bag) && bag.Any(s => s.Socket.State == WebSocketState.Open);

    /// <summary>Returns all usernames with at least one live connection.</summary>
    public IEnumerable<string> GetOnlineUsers() =>
        _sessions.Where(kv => kv.Value.Any(s => s.Socket.State == WebSocketState.Open))
                 .Select(kv => kv.Key);

    /// <summary>Total number of active WebSocket sessions across all users.</summary>
    public int SessionCount => _sessions.Values.Sum(b => b.Count(s => s.Socket.State == WebSocketState.Open));
}
