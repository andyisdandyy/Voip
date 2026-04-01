/// <summary>
/// Store-and-forward mailbox for encrypted messages sent to offline users.
/// Messages are opaque ciphertext blobs — the server cannot read them.
/// Uses SQLite with monotonic AUTOINCREMENT IDs and server-issued timestamps.
/// Undelivered messages are automatically purged after the configured TTL.
/// </summary>
public class OfflineMailbox
{
    public record MailMessage(
        long Id,
        string From,
        string To,
        string Ciphertext,
        string Nonce,
        DateTime SentAt);

    private readonly RendezvousDb _db;
    private readonly int _ttlDays;

    public OfflineMailbox(RendezvousDb db, int ttlDays = 30)
    {
        _db = db;
        _ttlDays = ttlDays;
    }

    /// <summary>
    /// Stores an encrypted message blob for a recipient.
    /// The write is durable (committed to SQLite WAL) before the ID is returned.
    /// Returns the monotonic message ID.
    /// </summary>
    public long Store(string from, string to, string ciphertext, string nonce)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO messages (from_user, to_user, ciphertext, nonce, sent_at)
            VALUES ($f, $t, $c, $n, $s);
            SELECT last_insert_rowid();
            """;
        cmd.Parameters.AddWithValue("$f", from);
        cmd.Parameters.AddWithValue("$t", to);
        cmd.Parameters.AddWithValue("$c", ciphertext);
        cmd.Parameters.AddWithValue("$n", nonce);
        cmd.Parameters.AddWithValue("$s", DateTime.UtcNow.ToString("O"));
        return (long)cmd.ExecuteScalar()!;
    }

    /// <summary>Returns all pending messages for the given recipient, ordered by ID.</summary>
    public List<MailMessage> GetInbox(string username)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id, from_user, to_user, ciphertext, nonce, sent_at FROM messages WHERE to_user = $u ORDER BY id";
        cmd.Parameters.AddWithValue("$u", username);

        var list = new List<MailMessage>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            list.Add(new MailMessage(
                reader.GetInt64(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                DateTime.Parse(reader.GetString(5))));
        }
        return list;
    }

    /// <summary>
    /// Deletes a message by ID after the recipient confirms delivery (ACK).
    /// Returns false if the message does not exist or does not belong to the recipient.
    /// Idempotent: re-ACKing an already-deleted message returns false without error.
    /// </summary>
    public bool Delete(long id, string recipient)
    {
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM messages WHERE id = $id AND to_user = $u";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$u", recipient);
        return cmd.ExecuteNonQuery() > 0;
    }

    /// <summary>Removes all messages older than the configured TTL. Called periodically by the server.</summary>
    public int CleanupExpired()
    {
        var cutoff = DateTime.UtcNow.AddDays(-_ttlDays).ToString("O");
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM messages WHERE sent_at < $cutoff";
        cmd.Parameters.AddWithValue("$cutoff", cutoff);
        return cmd.ExecuteNonQuery();
    }
}
