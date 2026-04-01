using System.Collections.Concurrent;
using System.Threading.Channels;

/// <summary>
/// Manages long-lived SSE (Server-Sent Events) connections.
/// Each authenticated user may have one active connection at a time;
/// opening a second one completes (closes) the first.
/// </summary>
public class SseConnectionTracker
{
    private readonly ConcurrentDictionary<string, Channel<string>> _channels =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Registers a new SSE channel for <paramref name="username"/>.
    /// Any previous channel for that user is completed so its handler exits cleanly.
    /// </summary>
    public Channel<string> Register(string username)
    {
        var ch = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
        if (_channels.TryRemove(username, out var old))
            old.Writer.TryComplete();
        _channels[username] = ch;
        return ch;
    }

    /// <summary>Removes and completes a channel when the SSE connection closes.</summary>
    public void Unregister(string username, Channel<string> ch)
    {
        _channels.TryRemove(new KeyValuePair<string, Channel<string>>(username, ch));
        ch.Writer.TryComplete();
    }

    /// <summary>
    /// Pushes a named SSE event to a connected user.
    /// Returns true if the user has a live connection and the event was queued.
    /// </summary>
    public bool TryPush(string username, string eventType, string jsonData)
    {
        if (!_channels.TryGetValue(username, out var ch)) return false;
        return ch.Writer.TryWrite($"event: {eventType}\ndata: {jsonData}\n\n");
    }

    /// <summary>Returns true if the user currently has a live SSE connection.</summary>
    public bool IsConnected(string username) => _channels.ContainsKey(username);

    /// <summary>Number of users with live SSE connections.</summary>
    public int ConnectionCount => _channels.Count;
}
