using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;

/// <summary>
/// Represents a single invite code with metadata.
/// </summary>
public record InviteEntry(string Token, string CreatedBy, string CreatedAt);

/// <summary>
/// Stores one-time invite codes for invite-only servers. Persisted to invites.json.
/// Each token can be used exactly once.
/// </summary>
public class InviteStore
{
    private static readonly JsonSerializerOptions _jsonOpts = new() { WriteIndented = true };
    private readonly string _filePath;
    private readonly ConcurrentDictionary<string, InviteEntry> _invites = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _saveLock = new();

    public InviteStore(string? filePath = null)
    {
        _filePath = filePath ?? Path.Combine(AppContext.BaseDirectory, "invites.json");
        Load();
    }

    /// <summary>Creates a new invite token and returns it.</summary>
    public string CreateInvite(string createdBy)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLower();
        var entry = new InviteEntry(token, createdBy, DateTime.UtcNow.ToString("O"));
        _invites[token] = entry;
        Save();
        return token;
    }

    /// <summary>Validates and consumes an invite token. Returns true if valid.</summary>
    public bool UseInvite(string token)
    {
        var found = _invites.TryRemove(token, out _);
        if (found) Save();
        return found;
    }

    public bool DeleteInvite(string token)
    {
        var removed = _invites.TryRemove(token, out _);
        if (removed) Save();
        return removed;
    }

    public List<InviteEntry> GetAllInvites() => _invites.Values.ToList();

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var json = File.ReadAllText(_filePath);
            var list = JsonSerializer.Deserialize<List<InviteEntry>>(json);
            if (list != null)
                foreach (var e in list)
                    _invites[e.Token] = e;
        }
        catch { }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var list = _invites.Values.ToList();
                File.WriteAllText(_filePath, JsonSerializer.Serialize(list, _jsonOpts));
            }
            catch { }
        }
    }
}
