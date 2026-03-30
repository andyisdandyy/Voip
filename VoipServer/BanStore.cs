using System.Collections.Concurrent;
using System.Text.Json;

/// <summary>
/// Stores permanently banned usernames. Persisted to bans.json.
/// </summary>
public class BanStore
{
    private static readonly JsonSerializerOptions _jsonOpts = new() { WriteIndented = true };
    private readonly string _filePath;
    private readonly ConcurrentDictionary<string, byte> _banned = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _saveLock = new();

    public BanStore(string? filePath = null)
    {
        _filePath = filePath ?? Path.Combine(AppContext.BaseDirectory, "bans.json");
        Load();
    }

    public bool IsBanned(string username) => _banned.ContainsKey(username);

    public void Ban(string username)
    {
        _banned[username] = 0;
        Save();
    }

    public bool Unban(string username)
    {
        var removed = _banned.TryRemove(username, out _);
        if (removed) Save();
        return removed;
    }

    public List<string> GetAllBanned() => _banned.Keys.ToList();

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var json = File.ReadAllText(_filePath);
            var list = JsonSerializer.Deserialize<List<string>>(json);
            if (list != null)
                foreach (var name in list)
                    _banned[name] = 0;
        }
        catch { }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var list = _banned.Keys.ToList();
                File.WriteAllText(_filePath, JsonSerializer.Serialize(list, _jsonOpts));
            }
            catch { }
        }
    }
}
