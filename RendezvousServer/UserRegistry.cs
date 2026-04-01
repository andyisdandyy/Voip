using System.Security.Cryptography;

/// <summary>
/// Persists user registrations (username, PBKDF2 password hash, ECDH public key) in SQLite.
/// </summary>
public class UserRegistry
{
    private readonly RendezvousDb _db;

    public UserRegistry(RendezvousDb db) => _db = db;

    public (bool success, string error) Register(string username, string password, string publicKey)
    {
        if (string.IsNullOrWhiteSpace(username) || username.Length < 2 || username.Length > 32)
            return (false, "Username must be 2-32 characters");
        foreach (var ch in username)
            if (!char.IsLetterOrDigit(ch) && ch != '_' && ch != '-')
                return (false, "Username may only contain letters, digits, _ and -");
        if (string.IsNullOrWhiteSpace(password) || password.Length < 4)
            return (false, "Password must be at least 4 characters");
        if (string.IsNullOrWhiteSpace(publicKey))
            return (false, "publicKey is required");

        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT OR IGNORE INTO users (username, password_hash, public_key, registered_at) VALUES ($u, $ph, $pk, $ra)";
        cmd.Parameters.AddWithValue("$u", username);
        cmd.Parameters.AddWithValue("$ph", HashPassword(password));
        cmd.Parameters.AddWithValue("$pk", publicKey);
        cmd.Parameters.AddWithValue("$ra", DateTime.UtcNow.ToString("O"));
        return cmd.ExecuteNonQuery() > 0 ? (true, "") : (false, "Username is already taken");
    }

    public (bool success, string error) Authenticate(string username, string password)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT password_hash FROM users WHERE username = $u";
        cmd.Parameters.AddWithValue("$u", username);
        var hash = cmd.ExecuteScalar() as string;
        if (hash is null || !VerifyPassword(password, hash))
            return (false, "Invalid username or password");
        return (true, "");
    }

    public string? GetPublicKey(string username)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT public_key FROM users WHERE username = $u";
        cmd.Parameters.AddWithValue("$u", username);
        return cmd.ExecuteScalar() as string;
    }

    public bool UpdatePublicKey(string username, string publicKey)
    {
        if (string.IsNullOrWhiteSpace(publicKey)) return false;
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE users SET public_key = $pk WHERE username = $u";
        cmd.Parameters.AddWithValue("$pk", publicKey);
        cmd.Parameters.AddWithValue("$u", username);
        return cmd.ExecuteNonQuery() > 0;
    }

    public bool Exists(string username)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM users WHERE username = $u";
        cmd.Parameters.AddWithValue("$u", username);
        return cmd.ExecuteScalar() is not null;
    }

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
        if (parts.Length != 5 || !int.TryParse(parts[2], out var iterations)) return false;
        var salt = Convert.FromBase64String(parts[3]);
        var expected = Convert.FromBase64String(parts[4]);
        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA512, 32);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}