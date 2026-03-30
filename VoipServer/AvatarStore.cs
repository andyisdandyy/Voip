using System.Collections.Concurrent;
using System.Text.Json;

/// <summary>
/// Stores per-user avatar images as base64 strings (max ~32 KB each).
/// Persisted to a JSON file on every change.
/// </summary>
public class AvatarStore
{
    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        WriteIndented = true,
    };

    private readonly string _filePath;
    private readonly ConcurrentDictionary<string, string> _avatars = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _saveLock = new();

    // Max avatar size: ~32KB base64 (≈24KB image)
    public const int MaxBase64Length = 44_000;

    public AvatarStore(string? filePath = null)
    {
        _filePath = filePath ?? Path.Combine(AppContext.BaseDirectory, "avatars.json");
        Load();
    }

    public string? GetAvatar(string username)
    {
        _avatars.TryGetValue(username, out var avatar);
        return avatar;
    }

    public bool SetAvatar(string username, string base64Data)
    {
        if (string.IsNullOrEmpty(base64Data) || base64Data.Length > MaxBase64Length)
            return false;
        _avatars[username] = base64Data;
        Save();
        return true;
    }

    public void RemoveAvatar(string username)
    {
        if (_avatars.TryRemove(username, out _))
            Save();
    }

    public void WipeAll()
    {
        _avatars.Clear();
        Save();
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var json = File.ReadAllText(_filePath);
            var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
            if (data != null)
                foreach (var kv in data)
                    _avatars[kv.Key] = kv.Value;
        }
        catch { }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var snapshot = new Dictionary<string, string>(_avatars);
                var json = JsonSerializer.Serialize(snapshot, _jsonOpts);
                File.WriteAllText(_filePath, json);
            }
            catch { }
        }
    }
}
