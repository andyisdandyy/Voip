/// <summary>
/// Persists confirmed mutual friendships in SQLite.
/// A friendship is stored as a normalised pair (alphabetically lower name first)
/// so each relationship has exactly one record regardless of which side added it.
/// </summary>
public class FriendStore
{
    private readonly RendezvousDb _db;

    public FriendStore(RendezvousDb db)
    {
        _db = db;
    }

    /// <summary>Records a confirmed friendship between two users (idempotent).</summary>
    public void Add(string a, string b)
    {
        var (u1, u2) = Normalise(a, b);
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT OR IGNORE INTO friends (user1, user2) VALUES ($u1, $u2)";
        cmd.Parameters.AddWithValue("$u1", u1);
        cmd.Parameters.AddWithValue("$u2", u2);
        cmd.ExecuteNonQuery();
    }

    /// <summary>Removes the friendship between two users. Returns false if it did not exist.</summary>
    public bool Remove(string a, string b)
    {
        var (u1, u2) = Normalise(a, b);
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM friends WHERE user1 = $u1 AND user2 = $u2";
        cmd.Parameters.AddWithValue("$u1", u1);
        cmd.Parameters.AddWithValue("$u2", u2);
        return cmd.ExecuteNonQuery() > 0;
    }

    /// <summary>Returns all confirmed friends of <paramref name="username"/>.</summary>
    public List<string> GetFriends(string username)
    {
        var key = username.ToLowerInvariant();
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT user2 FROM friends WHERE user1 = $u
            UNION
            SELECT user1 FROM friends WHERE user2 = $u
            """;
        cmd.Parameters.AddWithValue("$u", key);

        var list = new List<string>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            list.Add(reader.GetString(0));
        return list;
    }

    /// <summary>Returns true if the two users are friends.</summary>
    public bool AreFriends(string a, string b)
    {
        var (u1, u2) = Normalise(a, b);
        using var conn = _db.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM friends WHERE user1 = $u1 AND user2 = $u2";
        cmd.Parameters.AddWithValue("$u1", u1);
        cmd.Parameters.AddWithValue("$u2", u2);
        return cmd.ExecuteScalar() is not null;
    }

    private static (string, string) Normalise(string a, string b)
    {
        var la = a.ToLowerInvariant();
        var lb = b.ToLowerInvariant();
        return string.Compare(la, lb, StringComparison.Ordinal) <= 0 ? (la, lb) : (lb, la);
    }
}
