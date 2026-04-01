using Microsoft.Data.Sqlite;

/// <summary>
/// Manages the SQLite database for the rendezvous server.
/// Creates the schema on first run and provides a connection factory.
/// Uses WAL mode for concurrent read/write performance.
/// </summary>
public class RendezvousDb
{
    private readonly string _connectionString;

    public RendezvousDb(string dbPath)
    {
        _connectionString = $"Data Source={dbPath}";
        InitSchema();
    }

    /// <summary>Opens a new SQLite connection (caller must dispose).</summary>
    public SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        return conn;
    }

    private void InitSchema()
    {
        using var conn = Open();

        using (var pragma = conn.CreateCommand())
        {
            pragma.CommandText = "PRAGMA journal_mode=WAL;";
            pragma.ExecuteNonQuery();
        }

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS users (
                username       TEXT PRIMARY KEY COLLATE NOCASE,
                password_hash  TEXT NOT NULL,
                public_key     TEXT NOT NULL,
                registered_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user   TEXT NOT NULL COLLATE NOCASE,
                to_user     TEXT NOT NULL COLLATE NOCASE,
                ciphertext  TEXT NOT NULL,
                nonce       TEXT NOT NULL,
                sent_at     TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_to      ON messages(to_user);
            CREATE INDEX IF NOT EXISTS idx_messages_from_to  ON messages(from_user, to_user);
            CREATE INDEX IF NOT EXISTS idx_messages_sent_at  ON messages(sent_at);

            CREATE TABLE IF NOT EXISTS friends (
                user1 TEXT NOT NULL COLLATE NOCASE,
                user2 TEXT NOT NULL COLLATE NOCASE,
                PRIMARY KEY(user1, user2)
            );
            """;
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// Imports legacy JSON data from the old file-based stores.
    /// Call once at startup; safe to call repeatedly (skips if tables are populated).
    /// </summary>
    public void MigrateFromJson(string usersJson, string mailboxJson, string friendsJson, Action<string>? log = null)
    {
        MigrateUsers(usersJson, log);
        MigrateMailbox(mailboxJson, log);
        MigrateFriends(friendsJson, log);
    }

    private void MigrateUsers(string path, Action<string>? log)
    {
        if (!File.Exists(path)) return;
        using var conn = Open();
        using var check = conn.CreateCommand();
        check.CommandText = "SELECT COUNT(*) FROM users";
        if ((long)check.ExecuteScalar()! > 0) return;

        try
        {
            var json = File.ReadAllText(path);
            var dict = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, JsonUserEntry>>(json,
                new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (dict is null || dict.Count == 0) return;

            using var tx = conn.BeginTransaction();
            foreach (var (username, entry) in dict)
            {
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "INSERT OR IGNORE INTO users (username, password_hash, public_key, registered_at) VALUES ($u, $ph, $pk, $ra)";
                cmd.Parameters.AddWithValue("$u", username);
                cmd.Parameters.AddWithValue("$ph", entry.PasswordHash ?? "");
                cmd.Parameters.AddWithValue("$pk", entry.PublicKey ?? "");
                cmd.Parameters.AddWithValue("$ra", entry.RegisteredAt?.ToString("O") ?? DateTime.UtcNow.ToString("O"));
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            log?.Invoke($"[DB] Migrated {dict.Count} users from {path}");
        }
        catch (Exception ex) { log?.Invoke($"[DB] User migration error: {ex.Message}"); }
    }

    private void MigrateMailbox(string path, Action<string>? log)
    {
        if (!File.Exists(path)) return;
        using var conn = Open();
        using var check = conn.CreateCommand();
        check.CommandText = "SELECT COUNT(*) FROM messages";
        if ((long)check.ExecuteScalar()! > 0) return;

        try
        {
            var json = File.ReadAllText(path);
            var list = System.Text.Json.JsonSerializer.Deserialize<List<JsonMailMessage>>(json,
                new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (list is null || list.Count == 0) return;

            using var tx = conn.BeginTransaction();
            foreach (var msg in list)
            {
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "INSERT INTO messages (from_user, to_user, ciphertext, nonce, sent_at) VALUES ($f, $t, $c, $n, $s)";
                cmd.Parameters.AddWithValue("$f", msg.From ?? "");
                cmd.Parameters.AddWithValue("$t", msg.To ?? "");
                cmd.Parameters.AddWithValue("$c", msg.Ciphertext ?? "");
                cmd.Parameters.AddWithValue("$n", msg.Nonce ?? "");
                cmd.Parameters.AddWithValue("$s", msg.SentAt.ToString("O"));
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            log?.Invoke($"[DB] Migrated {list.Count} messages from {path}");
        }
        catch (Exception ex) { log?.Invoke($"[DB] Mailbox migration error: {ex.Message}"); }
    }

    private void MigrateFriends(string path, Action<string>? log)
    {
        if (!File.Exists(path)) return;
        using var conn = Open();
        using var check = conn.CreateCommand();
        check.CommandText = "SELECT COUNT(*) FROM friends";
        if ((long)check.ExecuteScalar()! > 0) return;

        try
        {
            var json = File.ReadAllText(path);
            var list = System.Text.Json.JsonSerializer.Deserialize<List<JsonFriendPair>>(json,
                new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (list is null || list.Count == 0) return;

            using var tx = conn.BeginTransaction();
            foreach (var pair in list)
            {
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "INSERT OR IGNORE INTO friends (user1, user2) VALUES ($u1, $u2)";
                cmd.Parameters.AddWithValue("$u1", pair.User1 ?? "");
                cmd.Parameters.AddWithValue("$u2", pair.User2 ?? "");
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            log?.Invoke($"[DB] Migrated {list.Count} friendships from {path}");
        }
        catch (Exception ex) { log?.Invoke($"[DB] Friends migration error: {ex.Message}"); }
    }

    // DTOs for JSON migration
    private record JsonUserEntry(string? PasswordHash, string? PublicKey, DateTime? RegisteredAt);
    private record JsonMailMessage(string? Id, string? From, string? To, string? Ciphertext, string? Nonce, DateTime SentAt);
    private record JsonFriendPair(string? User1, string? User2);
}
