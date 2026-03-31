using System.Text.Json;

/// <summary>
/// Persists confirmed mutual friendships to a JSON file.
/// A friendship is stored as a normalised pair (alphabetically lower name first)
/// so each relationship has exactly one record regardless of which side added it.
/// </summary>
public class FriendStore
{
    private record FriendPair(string User1, string User2);

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    private readonly string _filePath;
    private readonly List<FriendPair> _pairs = new();
    private readonly object _lock = new();

    public FriendStore(string filePath)
    {
        _filePath = filePath;
        Load();
    }

    /// <summary>Records a confirmed friendship between two users (idempotent).</summary>
    public void Add(string a, string b)
    {
        var (u1, u2) = Normalise(a, b);
        lock (_lock)
        {
            if (_pairs.Any(p => p.User1 == u1 && p.User2 == u2)) return;
            _pairs.Add(new FriendPair(u1, u2));
            Save();
        }
    }

    /// <summary>Removes the friendship between two users. Returns false if it did not exist.</summary>
    public bool Remove(string a, string b)
    {
        var (u1, u2) = Normalise(a, b);
        lock (_lock)
        {
            var removed = _pairs.RemoveAll(p => p.User1 == u1 && p.User2 == u2) > 0;
            if (removed) Save();
            return removed;
        }
    }

    /// <summary>Returns all confirmed friends of <paramref name="username"/>.</summary>
    public List<string> GetFriends(string username)
    {
        var key = username.ToLowerInvariant();
        lock (_lock)
        {
            return _pairs
                .Where(p => p.User1 == key || p.User2 == key)
                .Select(p => p.User1 == key ? p.User2 : p.User1)
                .ToList();
        }
    }

    /// <summary>Returns true if the two users are friends.</summary>
    public bool AreFriends(string a, string b)
    {
        var (u1, u2) = Normalise(a, b);
        lock (_lock)
        {
            return _pairs.Any(p => p.User1 == u1 && p.User2 == u2);
        }
    }

    // ── Helpers ─────────────────────────────────────────────
    private static (string, string) Normalise(string a, string b)
    {
        var la = a.ToLowerInvariant();
        var lb = b.ToLowerInvariant();
        return string.Compare(la, lb, StringComparison.Ordinal) <= 0 ? (la, lb) : (lb, la);
    }

    private void Load()
    {
        if (!File.Exists(_filePath)) return;
        try
        {
            var json = File.ReadAllText(_filePath);
            var list = JsonSerializer.Deserialize<List<FriendPair>>(json, _jsonOpts);
            if (list is not null) _pairs.AddRange(list);
        }
        catch { }
    }

    private void Save()
    {
        try { File.WriteAllText(_filePath, JsonSerializer.Serialize(_pairs, _jsonOpts)); }
        catch { }
    }
}
