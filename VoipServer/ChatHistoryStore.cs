using Microsoft.Data.Sqlite;
using System.Text.Json;

/// <summary>
/// Represents a single chat message stored in history.
/// </summary>
public class ChatMessage
{
    public string Id { get; set; } = "";
    public string User { get; set; } = "";
    public string Text { get; set; } = "";
    public DateTime Time { get; set; }
}

/// <summary>
/// Persists chat messages and pins in a SQLite database.
/// Thread-safe: uses WAL mode and connection pooling.
/// On first run, automatically imports data from legacy JSON files if they exist.
/// </summary>
public class ChatHistoryStore
{
    private readonly string _connectionString;
    private readonly string _dbPath;

    public ChatHistoryStore(string? filePath = null)
    {
        // Accept the legacy .json path for compatibility — derive the .db path from it
        var basePath = filePath ?? Path.Combine(AppContext.BaseDirectory, "chat_history.json");
        _dbPath = Path.ChangeExtension(basePath, ".db");
        _connectionString = $"Data Source={_dbPath}";
        InitializeDatabase();
        MigrateFromJson(basePath);
    }

    // ── Public API (unchanged signatures) ───────────────────

    public string AddMessage(string room, string user, string text)
    {
        var id = Guid.NewGuid().ToString("N")[..12];
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT INTO messages (id, room, user, text, time) VALUES ($id, $room, $user, $text, $time)";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$room", room);
        cmd.Parameters.AddWithValue("$user", user);
        cmd.Parameters.AddWithValue("$text", text);
        cmd.Parameters.AddWithValue("$time", DateTime.UtcNow.ToString("O"));
        cmd.ExecuteNonQuery();
        return id;
    }

    public bool DeleteMessage(string room, string id, string username)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM messages WHERE id = $id AND room = $room AND user = $user";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$room", room);
        cmd.Parameters.AddWithValue("$user", username);
        return cmd.ExecuteNonQuery() > 0;
    }

    public bool DeleteMessageAdmin(string room, string id)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM messages WHERE id = $id AND room = $room";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$room", room);
        return cmd.ExecuteNonQuery() > 0;
    }

    public List<ChatMessage> GetHistory(string room)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id, user, text, time FROM messages WHERE room = $room ORDER BY rowid ASC";
        cmd.Parameters.AddWithValue("$room", room);
        return ReadMessages(cmd);
    }

    /// <summary>
    /// Returns up to <paramref name="count"/> messages older than the message
    /// identified by <paramref name="beforeId"/>. If <paramref name="beforeId"/>
    /// is null or empty the newest messages are returned.
    /// </summary>
    public List<ChatMessage> GetHistory(string room, int count, string? beforeId)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        if (string.IsNullOrEmpty(beforeId))
        {
            cmd.CommandText = """
                SELECT id, user, text, time FROM (
                    SELECT id, user, text, time, rowid FROM messages
                    WHERE room = $room ORDER BY rowid DESC LIMIT $count
                ) sub ORDER BY rowid ASC
                """;
        }
        else
        {
            cmd.CommandText = """
                SELECT id, user, text, time FROM (
                    SELECT m.id, m.user, m.text, m.time, m.rowid FROM messages m
                    WHERE m.room = $room AND m.rowid < (SELECT rowid FROM messages WHERE id = $bid AND room = $room)
                    ORDER BY m.rowid DESC LIMIT $count
                ) sub ORDER BY rowid ASC
                """;
            cmd.Parameters.AddWithValue("$bid", beforeId);
        }
        cmd.Parameters.AddWithValue("$room", room);
        cmd.Parameters.AddWithValue("$count", count);
        return ReadMessages(cmd);
    }

    public int GetMessageCount(string room)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM messages WHERE room = $room";
        cmd.Parameters.AddWithValue("$room", room);
        return Convert.ToInt32(cmd.ExecuteScalar());
    }

    // ── Pin support ─────────────────────────────────────────

    public bool PinMessage(string room, string msgId)
    {
        try
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "INSERT INTO pins (room, msg_id) VALUES ($room, $mid)";
            cmd.Parameters.AddWithValue("$room", room);
            cmd.Parameters.AddWithValue("$mid", msgId);
            cmd.ExecuteNonQuery();
            return true;
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 19) // UNIQUE constraint
        {
            return false;
        }
    }

    public bool UnpinMessage(string room, string msgId)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM pins WHERE room = $room AND msg_id = $mid";
        cmd.Parameters.AddWithValue("$room", room);
        cmd.Parameters.AddWithValue("$mid", msgId);
        return cmd.ExecuteNonQuery() > 0;
    }

    public List<ChatMessage> GetPinnedMessages(string room)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT m.id, m.user, m.text, m.time FROM messages m
            INNER JOIN pins p ON p.msg_id = m.id AND p.room = m.room
            WHERE m.room = $room ORDER BY m.rowid ASC
            """;
        cmd.Parameters.AddWithValue("$room", room);
        return ReadMessages(cmd);
    }

    /// <summary>Renames a room key in history and pins (used when a channel is renamed).</summary>
    public void RenameRoom(string oldName, string newName)
    {
        if (string.Equals(oldName, newName, StringComparison.OrdinalIgnoreCase)) return;
        using var conn = Open();
        using var tx = conn.BeginTransaction();
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "UPDATE messages SET room = $new WHERE room = $old";
            cmd.Parameters.AddWithValue("$new", newName);
            cmd.Parameters.AddWithValue("$old", oldName);
            cmd.ExecuteNonQuery();
        }
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "UPDATE pins SET room = $new WHERE room = $old";
            cmd.Parameters.AddWithValue("$new", newName);
            cmd.Parameters.AddWithValue("$old", oldName);
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
    }

    /// <summary>Permanently deletes all history and pins for the given room.</summary>
    public void DeleteRoom(string roomName)
    {
        using var conn = Open();
        using var tx = conn.BeginTransaction();
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "DELETE FROM pins WHERE room = $room";
            cmd.Parameters.AddWithValue("$room", roomName);
            cmd.ExecuteNonQuery();
        }
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "DELETE FROM messages WHERE room = $room";
            cmd.Parameters.AddWithValue("$room", roomName);
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
    }

    // ── Private helpers ─────────────────────────────────────

    private SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        return conn;
    }

    private void InitializeDatabase()
    {
        using var conn = Open();

        // Execute each statement individually — Microsoft.Data.Sqlite may stop
        // iterating a multi-statement batch when a PRAGMA returns a result set,
        // which would silently skip later CREATE TABLE statements.
        Exec(conn, "PRAGMA journal_mode = WAL");
        Exec(conn, "PRAGMA synchronous = NORMAL");

        Exec(conn, """
            CREATE TABLE IF NOT EXISTS messages (
                id   TEXT NOT NULL,
                room TEXT NOT NULL,
                user TEXT NOT NULL,
                text TEXT NOT NULL,
                time TEXT NOT NULL
            )
            """);

        // rowid is an implicit virtual column in SQLite and cannot appear in index
        // definitions.  An index on (room) alone is sufficient — ORDER BY rowid
        // queries benefit from it because SQLite stores rows in rowid order already.
        Exec(conn, "CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room)");
        Exec(conn, "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id_room ON messages (id, room)");

        Exec(conn, """
            CREATE TABLE IF NOT EXISTS pins (
                room   TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                UNIQUE(room, msg_id)
            )
            """);

        Exec(conn, "CREATE INDEX IF NOT EXISTS idx_pins_room ON pins (room)");
    }

    private static void Exec(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// One-time migration: imports data from the legacy JSON files into SQLite,
    /// then renames them to .bak so the migration doesn't run again.
    /// </summary>
    private void MigrateFromJson(string jsonPath)
    {
        var pinsJsonPath = Path.Combine(Path.GetDirectoryName(jsonPath)!, "pinned_messages.json");
        if (!File.Exists(jsonPath) && !File.Exists(pinsJsonPath)) return;

        var jsonOpts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

        using var conn = Open();
        using var tx = conn.BeginTransaction();

        try
        {
            if (File.Exists(jsonPath))
            {
                var json = File.ReadAllText(jsonPath);
                var data = JsonSerializer.Deserialize<Dictionary<string, List<ChatMessage>>>(json, jsonOpts);
                if (data != null)
                {
                    using var cmd = conn.CreateCommand();
                    cmd.CommandText = "INSERT OR IGNORE INTO messages (id, room, user, text, time) VALUES ($id, $room, $user, $text, $time)";
                    var pId = cmd.Parameters.Add("$id", SqliteType.Text);
                    var pRoom = cmd.Parameters.Add("$room", SqliteType.Text);
                    var pUser = cmd.Parameters.Add("$user", SqliteType.Text);
                    var pText = cmd.Parameters.Add("$text", SqliteType.Text);
                    var pTime = cmd.Parameters.Add("$time", SqliteType.Text);

                    foreach (var (room, msgs) in data)
                    {
                        foreach (var msg in msgs)
                        {
                            pId.Value = msg.Id;
                            pRoom.Value = room;
                            pUser.Value = msg.User;
                            pText.Value = msg.Text;
                            pTime.Value = msg.Time.ToString("O");
                            cmd.ExecuteNonQuery();
                        }
                    }
                }
            }

            if (File.Exists(pinsJsonPath))
            {
                var pinsJson = File.ReadAllText(pinsJsonPath);
                var pinsData = JsonSerializer.Deserialize<Dictionary<string, HashSet<string>>>(pinsJson, jsonOpts);
                if (pinsData != null)
                {
                    using var cmd = conn.CreateCommand();
                    cmd.CommandText = "INSERT OR IGNORE INTO pins (room, msg_id) VALUES ($room, $mid)";
                    var pRoom = cmd.Parameters.Add("$room", SqliteType.Text);
                    var pMid = cmd.Parameters.Add("$mid", SqliteType.Text);

                    foreach (var (room, ids) in pinsData)
                    {
                        foreach (var id in ids)
                        {
                            pRoom.Value = room;
                            pMid.Value = id;
                            cmd.ExecuteNonQuery();
                        }
                    }
                }
            }

            tx.Commit();

            // Rename legacy files so migration doesn't run again
            if (File.Exists(jsonPath))
                File.Move(jsonPath, jsonPath + ".bak", overwrite: true);
            if (File.Exists(pinsJsonPath))
                File.Move(pinsJsonPath, pinsJsonPath + ".bak", overwrite: true);
        }
        catch
        {
            try { tx.Rollback(); } catch { }
        }
    }

    private static List<ChatMessage> ReadMessages(SqliteCommand cmd)
    {
        var list = new List<ChatMessage>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            list.Add(new ChatMessage
            {
                Id = reader.GetString(0),
                User = reader.GetString(1),
                Text = reader.GetString(2),
                Time = DateTime.Parse(reader.GetString(3)).ToUniversalTime(),
            });
        }
        return list;
    }
}