using System.Text.Json;

/// <summary>
/// Store-and-forward mailbox for encrypted messages sent to offline users.
/// Messages are opaque ciphertext blobs — the server cannot read them.
/// Undelivered messages are automatically purged after <see cref="_ttlDays"/> days.
/// </summary>
public class OfflineMailbox
{
    public record MailMessage(
        string Id,
        string From,
        string To,
        string Ciphertext,
        string Nonce,
        DateTime SentAt);

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    private readonly string _filePath;
    private readonly int _ttlDays;
    private readonly List<MailMessage> _messages = new();
    private readonly object _lock = new();

    public OfflineMailbox(string filePath, int ttlDays = 30)
    {
        _filePath = filePath;
        _ttlDays = ttlDays;
        Load();
    }

    /// <summary>Stores an encrypted message blob for a recipient. Returns the assigned message ID.</summary>
    public string Store(string from, string to, string ciphertext, string nonce)
    {
        var id = Guid.NewGuid().ToString("N");
        lock (_lock)
        {
            _messages.Add(new MailMessage(id, from, to, ciphertext, nonce, DateTime.UtcNow));
            Save();
        }
        return id;
    }

    /// <summary>Returns all pending messages for the given recipient.</summary>
    public List<MailMessage> GetInbox(string username)
    {
        lock (_lock)
        {
            return _messages
                .Where(m => string.Equals(m.To, username, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }
    }

    /// <summary>
    /// Deletes a message by ID after the recipient confirms delivery.
    /// Returns false if the message does not exist or does not belong to the recipient.
    /// </summary>
    public bool Delete(string id, string recipient)
    {
        lock (_lock)
        {
            var msg = _messages.FirstOrDefault(m =>
                m.Id == id &&
                string.Equals(m.To, recipient, StringComparison.OrdinalIgnoreCase));

            if (msg is null) return false;
            _messages.Remove(msg);
            Save();
            return true;
        }
    }

    /// <summary>Removes all messages older than the configured TTL. Called periodically by the server.</summary>
    public void CleanupExpired()
    {
        var cutoff = DateTime.UtcNow.AddDays(-_ttlDays);
        lock (_lock)
        {
            var removed = _messages.RemoveAll(m => m.SentAt < cutoff);
            if (removed > 0) Save();
        }
    }

    // ── Persistence ─────────────────────────────────────────────────────────
    private void Load()
    {
        if (!File.Exists(_filePath)) return;
        try
        {
            var json = File.ReadAllText(_filePath);
            var list = JsonSerializer.Deserialize<List<MailMessage>>(json, _jsonOpts);
            if (list is not null) _messages.AddRange(list);
        }
        catch { }
    }

    private void Save()
    {
        try
        {
            File.WriteAllText(_filePath, JsonSerializer.Serialize(_messages, _jsonOpts));
        }
        catch { }
    }
}
