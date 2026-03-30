using System.Collections.Concurrent;
using System.Text.Json;

/// <summary>
/// Manages custom emoji entries — name → base64 image data (PNG/GIF/WebP).
/// Persisted as emojis.json in the working directory.
/// </summary>
public class EmojiStore
{
    private readonly ConcurrentDictionary<string, string> _emojis = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _path;
    private readonly object _saveLock = new();

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    public EmojiStore(string? path = null)
    {
        _path = path ?? Path.Combine(AppContext.BaseDirectory, "emojis.json");
        Load();
    }

    public Dictionary<string, string> GetAll() => new(_emojis);

    public bool AddEmoji(string name, string base64Data)
    {
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(base64Data))
            return false;
        _emojis[name] = base64Data;
        Save();
        return true;
    }

    public bool RemoveEmoji(string name)
    {
        if (!_emojis.TryRemove(name, out _))
            return false;
        Save();
        return true;
    }

    public void WipeAll()
    {
        _emojis.Clear();
        Save();
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_path)) return;
            var json = File.ReadAllText(_path);
            var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json, _jsonOpts);
            if (data != null)
                foreach (var kv in data)
                    _emojis[kv.Key] = kv.Value;
        }
        catch { }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var snapshot = new Dictionary<string, string>(_emojis);
                File.WriteAllText(_path, JsonSerializer.Serialize(snapshot, _jsonOpts));
            }
            catch { }
        }
    }
}
