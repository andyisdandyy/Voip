using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;

/// <summary>
/// Persists user registrations (username, PBKDF2 password hash, ECDH public key) to a JSON file.
/// Public keys are used by peers to encrypt messages before sending them via the mailbox.
/// </summary>
public class UserRegistry
{
    private record UserEntry(string PasswordHash, string PublicKey, DateTime RegisteredAt);

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    private readonly string _filePath;
    private readonly ConcurrentDictionary<string, UserEntry> _users = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _saveLock = new();

    public UserRegistry(string filePath)
    {
        _filePath = filePath;
        Load();
    }

    public (bool success, string error) Register(string username, string password, string publicKey)
    {
        if (string.IsNullOrWhiteSpace(username) || username.Length < 2 || username.Length > 32)
            return (false, "Username must be 2–32 characters");
        foreach (var ch in username)
            if (!char.IsLetterOrDigit(ch) && ch != '_' && ch != '-')
                return (false, "Username may only contain letters, digits, _ and -");
        if (string.IsNullOrWhiteSpace(password) || password.Length < 4)
            return (false, "Password must be at least 4 characters");
        if (string.IsNullOrWhiteSpace(publicKey))
            return (false, "publicKey is required");

        var entry = new UserEntry(HashPassword(password), publicKey, DateTime.UtcNow);
        if (!_users.TryAdd(username, entry))
            return (false, "Username is already taken");

        Save();
        return (true, "");
    }

    public (bool success, string error) Authenticate(string username, string password)
    {
        if (!_users.TryGetValue(username, out var entry))
            return (false, "Invalid username or password");
        if (!VerifyPassword(password, entry.PasswordHash))
            return (false, "Invalid username or password");
        return (true, "");
    }

    public string? GetPublicKey(string username) =>
        _users.TryGetValue(username, out var entry) ? entry.PublicKey : null;

    public bool Exists(string username) => _users.ContainsKey(username);

    // ── PBKDF2-SHA512 ───────────────────────────────────────────────────────
    private static string HashPassword(string password)
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        const int iterations = 310_000;
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA512, 32);
        return $"$PBKDF2${iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    private static bool VerifyPassword(string password, string storedHash)
    {
        if (!storedHash.StartsWith("$PBKDF2$")) return false;
        var parts = storedHash.Split('$');
        if (parts.Length != 5) return false;
        if (!int.TryParse(parts[2], out var iterations)) return false;
        var salt = Convert.FromBase64String(parts[3]);
        var expectedHash = Convert.FromBase64String(parts[4]);
        var actualHash = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA512, 32);
        return CryptographicOperations.FixedTimeEquals(actualHash, expectedHash);
    }

    // ── Persistence ─────────────────────────────────────────────────────────
    private void Load()
    {
        if (!File.Exists(_filePath)) return;
        try
        {
            var json = File.ReadAllText(_filePath);
            var dict = JsonSerializer.Deserialize<Dictionary<string, UserEntry>>(json, _jsonOpts);
            if (dict is null) return;
            foreach (var kv in dict)
                _users[kv.Key] = kv.Value;
        }
        catch { }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var json = JsonSerializer.Serialize(new Dictionary<string, UserEntry>(_users), _jsonOpts);
                File.WriteAllText(_filePath, json);
            }
            catch { }
        }
    }
}
