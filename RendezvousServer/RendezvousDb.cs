using Microsoft.Data.Sqlite;

/// <summary>
/// Manages the SQLite database (WAL mode). Creates the schema on first run.
/// Call MigrateFromJson once on startup to import legacy JSON data.
/// </summary>
public class RendezvousDb
{
    private readonly string _connectionString;

    public RendezvousDb(string dbPath)
    {
        _connectionString = $"Data Source={dbPath}";
        InitSchema();
    }

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
                username      TEXT PRIMARY KEY COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                public_key    TEXT NOT NULL,
                registered_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user  TEXT NOT NULL COLLATE NOCASE,
                to_user    TEXT NOT NULL COLLATE NOCASE,
                ciphertext TEXT NOT NULL,
                nonce      TEXT NOT NULL,
                sent_at    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_to      ON messages(to_user);
            CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at);
            CREATE TABLE IF NOT EXISTS friends (
                user1 TEXT NOT NULL COLLATE NOCASE,
                user2 TEXT NOT NULL COLLATE NOCASE,
                PRIMARY KEY(user1, user2)
            );
            """;
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// Imports users, messages, and friends from legacy JSON files if the
    /// corresponding SQLite tables are still empty. Safe to call on every startup.
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
            var opts = new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var dict = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, JsonUser>>(File.ReadAllText(path), opts);
            if (dict is null || dict.Count == 0) return;
            using var tx = conn.BeginTransaction();
            foreach (var (u, e) in dict)
            {
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "INSERT OR IGNORE INTO users (username, password_hash, public_key, registered_at) VALUES ($u,$ph,$pk,$ra)";
                cmd.Parameters.AddWithValue("$u",  u);
                cmd.Parameters.AddWithValue("$ph", e.PasswordHash ?? "");
                cmd.Parameters.AddWithValue("$pk", e.PublicKey ?? "");
                cmd.Parameters.AddWithValue("$ra", e.RegisteredAt?.ToString("O") ?? DateTime.UtcNow.ToString("O"));
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            log?.Invoke($"[DB] Migrated {dict.Count} users from {Path.GetFileName(path)}");
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
            var opts = new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var list = System.Text.Json.JsonSerializer.Deserialize<List<JsonMessage>>(File.ReadAllText(path), opts);
            if (list is null || list.Count == 0) return;
            using var tx = conn.BeginTransaction();
            foreach (var m in list)
            {
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "INSERT INTO messages (from_user, to_user, ciphertext, nonce, sent_at) VALUES ($f,$t,$c,$n,$s)";
                cmd.Parameters.AddWithValue("$f", m.From ?? "");
                cmd.Parameters.AddWithValue("$t", m.To ?? "");
                cmd.Parameters.AddWithValue("$c", m.Ciphertext ?? "");
                cmd.Parameters.AddWithValue("$n", m.Nonce ?? "");
                cmd.Parameters.AddWithValue("$s", m.SentAt.ToString("O"));
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            log?.Invoke($"[DB] Migrated {list.Count} messages from {Path.GetFileName(path)}");
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
            var opts = new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var list = System.Text.Json.JsonSerializer.Deserialize<List<JsonFriend>>(File.ReadAllText(path), opts);
            if (list is null || list.Count == 0) return;
            using var tx = conn.BeginTransaction();
            foreach (var f in list)
            {
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "INSERT OR IGNORE INTO friends (user1, user2) VALUES ($u1,$u2)";
                cmd.Parameters.AddWithValue("$u1", f.User1 ?? "");
                cmd.Parameters.AddWithValue("$u2", f.User2 ?? "");
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            log?.Invoke($"[DB] Migrated {list.Count} friendships from {Path.GetFileName(path)}");
        }
        catch (Exception ex) { log?.Invoke($"[DB] Friends migration error: {ex.Message}"); }
    }

    private record JsonUser(string? PasswordHash, string? PublicKey, DateTime? RegisteredAt);
    private record JsonMessage(string? Id, string? From, string? To, string? Ciphertext, string? Nonce, DateTime SentAt);
    private record JsonFriend(string? User1, string? User2);
}
