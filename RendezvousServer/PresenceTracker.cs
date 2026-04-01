using System.Collections.Concurrent;

/// <summary>
/// Tracks which users are currently online and their self-reported network address.
/// Entries expire automatically if not refreshed within <see cref="StalenessThreshold"/>.
/// The client is expected to call PUT /presence or send HEARTBEAT over WebSocket periodically.
/// </summary>
public class PresenceTracker
{
    private static readonly TimeSpan StalenessThreshold = TimeSpan.FromMinutes(5);

    private record PresenceEntry(string Address, DateTime LastSeen);

    private readonly ConcurrentDictionary<string, PresenceEntry> _online =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Marks a user as online with the given address and refreshes their timestamp.</summary>
    public void SetOnline(string username, string address) =>
        _online[username] = new PresenceEntry(address, DateTime.UtcNow);

    /// <summary>Explicitly marks a user as offline.</summary>
    public void SetOffline(string username) =>
        _online.TryRemove(username, out _);

    /// <summary>Refreshes the last-seen timestamp for a user without changing their address.</summary>
    public void RefreshHeartbeat(string username)
    {
        if (_online.TryGetValue(username, out var entry))
            _online[username] = entry with { LastSeen = DateTime.UtcNow };
    }

    /// <summary>
    /// Returns the presence state of a user.
    /// Returns offline if the entry is stale (no heartbeat within <see cref="StalenessThreshold"/>).
    /// </summary>
    public (bool online, string? address) GetPresence(string username)
    {
        if (!_online.TryGetValue(username, out var entry))
            return (false, null);

        if (DateTime.UtcNow - entry.LastSeen > StalenessThreshold)
        {
            _online.TryRemove(username, out _);
            return (false, null);
        }

        return (true, entry.Address);
    }

    /// <summary>Number of users currently considered online.</summary>
    public int OnlineCount => _online.Count(kv =>
        DateTime.UtcNow - kv.Value.LastSeen <= StalenessThreshold);
}
