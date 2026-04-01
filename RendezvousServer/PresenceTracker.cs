using System.Collections.Concurrent;

/// <summary>
/// Tracks which users are currently online and their self-reported network address.
/// Entries expire if not refreshed within StalenessThreshold.
/// </summary>
public class PresenceTracker
{
    private static readonly TimeSpan StalenessThreshold = TimeSpan.FromMinutes(5);
    private record PresenceEntry(string Address, DateTime LastSeen);
    private readonly ConcurrentDictionary<string, PresenceEntry> _online = new(StringComparer.OrdinalIgnoreCase);

    public void SetOnline(string username, string address) =>
        _online[username] = new PresenceEntry(address, DateTime.UtcNow);

    public void SetOffline(string username) =>
        _online.TryRemove(username, out _);

    public void RefreshHeartbeat(string username)
    {
        if (_online.TryGetValue(username, out var entry))
            _online[username] = entry with { LastSeen = DateTime.UtcNow };
    }

    public (bool online, string? address) GetPresence(string username)
    {
        if (!_online.TryGetValue(username, out var entry)) return (false, null);
        if (DateTime.UtcNow - entry.LastSeen > StalenessThreshold)
        {
            _online.TryRemove(username, out _);
            return (false, null);
        }
        return (true, entry.Address);
    }

    public int OnlineCount => _online.Count(kv => DateTime.UtcNow - kv.Value.LastSeen <= StalenessThreshold);
}
