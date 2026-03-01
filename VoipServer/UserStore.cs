using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// Persists user credentials to a JSON file. Passwords are hashed with PBKDF2-SHA512.
/// Legacy SHA-256 hashes are automatically migrated on successful login.
/// </summary>
public class UserStore
{
    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private readonly string _filePath;
    private readonly ConcurrentDictionary<string, string> _users = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _saveLock = new();

    public UserStore(string? filePath = null)
    {
        _filePath = filePath ?? Path.Combine(AppContext.BaseDirectory, "users.json");
        Load();
    }

    public (bool success, string error) Register(string username, string password)
    {
        if (string.IsNullOrWhiteSpace(username) || username.Length < 2 || username.Length > 32)
            return (false, "Brugernavn skal være 2-32 tegn");
        if (username.Contains(':') || username.Contains('\n') || username.Contains('\r'))
            return (false, "Brugernavn indeholder ugyldige tegn");
        // Reject control characters (protocol injection prevention)
        foreach (var ch in username)
            if (char.IsControl(ch)) return (false, "Brugernavn indeholder ugyldige tegn");
        if (string.IsNullOrWhiteSpace(password) || password.Length < 4)
            return (false, "Password skal være mindst 4 tegn");
        var hash = HashPassword(password);
        if (!_users.TryAdd(username, hash))
            return (false, "Brugernavn er allerede taget");
        Save();
        return (true, "");
    }

    public (bool success, string error) Authenticate(string username, string password)
    {
        if (!_users.TryGetValue(username, out var storedHash))
            return (false, "Forkert brugernavn eller password");
        if (!VerifyPassword(password, storedHash))
            return (false, "Forkert brugernavn eller password");
        // Migrate legacy SHA-256 hash to PBKDF2 on successful login
        if (!storedHash.StartsWith("$PBKDF2$"))
        {
            _users[username] = HashPassword(password);
            Save();
        }
        return (true, "");
    }

    public bool UserExists(string username) => _users.ContainsKey(username);

    public string GetDisplayName(string username)
    {
        // ConcurrentDictionary uses OrdinalIgnoreCase comparer, so the stored key
        // preserves the original casing. Enumerate only if needed for casing match.
        if (_users.TryGetValue(username, out _))
        {
            // Fast path: find the key with matching casing from the comparer
            foreach (var key in _users.Keys)
                if (string.Equals(key, username, StringComparison.OrdinalIgnoreCase))
                    return key;
        }
        return username;
    }

    public List<string> GetAllUsernames()
    {
        return _users.Keys.ToList();
    }

    private const int Pbkdf2Iterations = 100_000;
    private const int SaltSize = 16;
    private const int HashSize = 32;

    private static string HashPassword(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var hash = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password), salt, Pbkdf2Iterations,
            HashAlgorithmName.SHA512, HashSize);
        return $"$PBKDF2${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    private static bool VerifyPassword(string password, string storedHash)
    {
        if (storedHash.StartsWith("$PBKDF2$"))
        {
            var parts = storedHash.Split('$', StringSplitOptions.RemoveEmptyEntries);
            // parts: ["PBKDF2", "<salt>", "<hash>"]
            if (parts.Length < 3) return false;
            var salt = Convert.FromBase64String(parts[1]);
            var expected = Convert.FromBase64String(parts[2]);
            var actual = Rfc2898DeriveBytes.Pbkdf2(
                Encoding.UTF8.GetBytes(password), salt, Pbkdf2Iterations,
                HashAlgorithmName.SHA512, HashSize);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        // Legacy SHA-256 fallback (migrated on next successful login)
        var legacyHash = SHA256.HashData(Encoding.UTF8.GetBytes(password));
        var legacyStored = Convert.FromBase64String(storedHash);
        return CryptographicOperations.FixedTimeEquals(legacyHash, legacyStored);
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var json = File.ReadAllText(_filePath);
            var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json, _jsonOpts);
            if (data != null)
                foreach (var kv in data)
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
                var snapshot = new Dictionary<string, string>(_users);
                var json = JsonSerializer.Serialize(snapshot, _jsonOpts);
                File.WriteAllText(_filePath, json);
            }
            catch { }
        }
    }
}
