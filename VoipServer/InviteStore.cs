using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Represents a single invite code with metadata.
/// </summary>
public class InviteEntry
{
    public string Token { get; set; } = "";
    public string CreatedBy { get; set; } = "";
    public string CreatedAt { get; set; } = DateTime.UtcNow.ToString("O");
    public int? MaxUses { get; set; } = 1;
    public int Uses { get; set; } = 0;
    public string? ExpiresAt { get; set; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtraData { get; set; }
}

/// <summary>
/// Stores invite codes for invite-only servers. Persisted to invites.json.
/// Supports one-time, limited-use, and expiring invites.
/// </summary>
public class InviteStore
{
    private static readonly JsonSerializerOptions _jsonOpts = new() { WriteIndented = true, PropertyNameCaseInsensitive = true };
    private readonly string _filePath;
    private readonly ConcurrentDictionary<string, InviteEntry> _invites = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _saveLock = new();

    public InviteStore(string? filePath = null)
    {
        _filePath = filePath ?? Path.Combine(AppContext.BaseDirectory, "invites.json");
        Load();
    }

    public InviteEntry CreateInvite(string createdBy, int? maxUses = 1, string? expiresAtIso = null)
    {
        int? normalizedMaxUses = maxUses.HasValue ? Math.Max(1, maxUses.Value) : null;
        var expiresAt = ParseIsoUtcOrNull(expiresAtIso);

        InviteEntry entry;
        do
        {
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();
            entry = new InviteEntry
            {
                Token = token,
                CreatedBy = createdBy,
                CreatedAt = DateTime.UtcNow.ToString("O"),
                MaxUses = normalizedMaxUses,
                Uses = 0,
                ExpiresAt = expiresAt?.ToString("O"),
            };
        }
        while (!_invites.TryAdd(entry.Token, entry));

        Save();
        return entry;
    }

    public bool DeleteInvite(string token)
    {
        var removed = _invites.TryRemove(token, out _);
        if (removed) Save();
        return removed;
    }

    public List<InviteEntry> GetAllInvites() => _invites.Values
        .OrderByDescending(i => i.CreatedAt, StringComparer.Ordinal)
        .ToList();

    /// <summary>
    /// Runs the supplied action only if invite is valid, then increments use count and
    /// removes invite only when exhausted.
    /// </summary>
    public (bool success, string error) UseInviteIf(string token, Func<(bool success, string error)> action)
    {
        lock (_saveLock)
        {
            if (!_invites.TryGetValue(token, out var entry))
                return (false, "Invalid or expired invite code");

            if (IsExpired(entry))
            {
                _invites.TryRemove(token, out _);
                SaveUnsafe();
                return (false, "Invite code has expired");
            }

            if (entry.MaxUses.HasValue && entry.Uses >= entry.MaxUses.Value)
            {
                _invites.TryRemove(token, out _);
                SaveUnsafe();
                return (false, "Invite code has no uses left");
            }

            var result = action();
            if (!result.success)
                return result;

            if (!_invites.TryGetValue(token, out entry))
                return (false, "Invalid or expired invite code");

            entry.Uses++;
            if (entry.MaxUses.HasValue && entry.Uses >= entry.MaxUses.Value)
                _invites.TryRemove(token, out _);
            else
                _invites[token] = entry;

            SaveUnsafe();
            return (true, string.Empty);
        }
    }

    private static DateTime? ParseIsoUtcOrNull(string? iso)
    {
        if (string.IsNullOrWhiteSpace(iso)) return null;
        if (!DateTimeOffset.TryParse(iso, out var dto)) return null;
        return dto.UtcDateTime;
    }

    private static bool IsExpired(InviteEntry entry)
    {
        var expires = ParseIsoUtcOrNull(entry.ExpiresAt);
        return expires.HasValue && DateTime.UtcNow >= expires.Value;
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var json = File.ReadAllText(_filePath);
            var list = JsonSerializer.Deserialize<List<InviteEntry>>(json, _jsonOpts);
            if (list == null) return;

            foreach (var e in list)
            {
                if (string.IsNullOrWhiteSpace(e.Token)) continue;
                e.MaxUses ??= 1;
                e.Uses = Math.Max(0, e.Uses);
                _invites[e.Token] = e;
            }
        }
        catch { }
    }

    private void Save() { lock (_saveLock) SaveUnsafe(); }

    private void SaveUnsafe()
    {
        try
        {
            var list = _invites.Values.OrderByDescending(i => i.CreatedAt, StringComparer.Ordinal).ToList();
            File.WriteAllText(_filePath, JsonSerializer.Serialize(list, _jsonOpts));
        }
        catch { }
    }
}
