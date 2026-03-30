using System.Collections.Concurrent;
using System.Text.Json;

/// <summary>
/// Manages soundboard sound entries — name → base64 audio data.
/// Persisted as soundboard.json in the working directory.
/// </summary>
public class SoundboardStore
{
    private readonly ConcurrentDictionary<string, string> _sounds = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _path;
    private readonly object _saveLock = new();

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    public SoundboardStore(string? path = null)
    {
        _path = path ?? Path.Combine(AppContext.BaseDirectory, "soundboard.json");
        Load();
    }

    /// <summary>Returns only the names (no audio data) for the list.</summary>
    public List<string> GetNames() => _sounds.Keys.ToList();

    public string? GetSound(string name)
    {
        _sounds.TryGetValue(name, out var data);
        return data;
    }

    public bool AddSound(string name, string base64Data)
    {
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(base64Data))
            return false;
        _sounds[name] = base64Data;
        Save();
        return true;
    }

    public bool RemoveSound(string name)
    {
        if (!_sounds.TryRemove(name, out _))
            return false;
        Save();
        return true;
    }

    public void WipeAll()
    {
        _sounds.Clear();
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
                    _sounds[kv.Key] = kv.Value;
        }
        catch { }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var snapshot = new Dictionary<string, string>(_sounds);
                File.WriteAllText(_path, JsonSerializer.Serialize(snapshot, _jsonOpts));
            }
            catch { }
        }
    }
}
