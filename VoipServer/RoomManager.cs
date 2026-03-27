using System.Collections.Concurrent;

/// <summary>
/// Tracks which users are in which voice/text rooms.
/// All operations are thread-safe via ConcurrentDictionary.
/// </summary>
public class RoomManager
{
    private readonly RoomsConfig _config;
    private readonly ConcurrentDictionary<string, string> _userVoiceRoom = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _textRoomMembers = new(StringComparer.OrdinalIgnoreCase);
    private readonly Action<string>? _log;

    public RoomManager(RoomsConfig config, Action<string>? log = null)
    {
        _config = config;
        _log = log;
        foreach (var room in config.TextRooms)
            _textRoomMembers[room.Name] = new(StringComparer.OrdinalIgnoreCase);
    }

    public RoomsConfig Config => _config;

    /// <summary>Ensures the text room member tracking exists (called after creating a new text room).</summary>
    public void EnsureTextRoom(string roomName)
    {
        _textRoomMembers.GetOrAdd(roomName, _ => new(StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>Removes the text room member tracking and kicks all users from that room.</summary>
    public void RemoveTextRoom(string roomName)
    {
        _textRoomMembers.TryRemove(roomName, out _);
    }

    /// <summary>Kicks all users from the given voice room.</summary>
    public List<string> KickVoiceRoom(string roomName)
    {
        var kicked = new List<string>();
        foreach (var kv in _userVoiceRoom)
        {
            if (string.Equals(kv.Value, roomName, StringComparison.OrdinalIgnoreCase))
            {
                if (_userVoiceRoom.TryRemove(kv.Key, out _))
                    kicked.Add(kv.Key);
            }
        }
        return kicked;
    }

    /// <summary>Gets all users in a text room.</summary>
    public List<string> GetTextRoomUsers(string roomName)
    {
        if (_textRoomMembers.TryGetValue(roomName, out var members))
            return members.Keys.ToList();
        return new();
    }

    public bool JoinVoiceRoom(string username, string roomName, string? password)
    {
        var room = _config.VoiceRooms.FirstOrDefault(r => r.Name == roomName);
        if (room == null) return false;
        if (!string.IsNullOrEmpty(room.Password) && room.Password != password) return false;
        _userVoiceRoom[username] = roomName;
        _log?.Invoke($"[Room] {username} joined voice '{roomName}'");
        return true;
    }

    public void LeaveVoiceRoom(string username)
    {
        if (_userVoiceRoom.TryRemove(username, out var old))
            _log?.Invoke($"[Room] {username} left voice '{old}'");
    }

    public string? GetVoiceRoom(string username)
    {
        _userVoiceRoom.TryGetValue(username, out var room);
        return room;
    }

    public int GetVoiceRoomBitrate(string roomName)
    {
        var room = _config.VoiceRooms.FirstOrDefault(r => r.Name == roomName);
        return room?.Bitrate ?? 64000;
    }

    public bool JoinTextRoom(string username, string roomName, string? password)
    {
        var room = _config.TextRooms.FirstOrDefault(r => r.Name == roomName);
        if (room == null) return false;
        if (!string.IsNullOrEmpty(room.Password) && room.Password != password) return false;
        if (!_textRoomMembers.ContainsKey(roomName))
            _textRoomMembers[roomName] = new(StringComparer.OrdinalIgnoreCase);
        _textRoomMembers[roomName][username] = 0;
        _log?.Invoke($"[Room] {username} joined text '{roomName}'");
        return true;
    }

    public void LeaveTextRoom(string username, string roomName)
    {
        if (_textRoomMembers.TryGetValue(roomName, out var members))
            members.TryRemove(username, out _);
    }

    public bool IsInTextRoom(string username, string roomName)
    {
        return _textRoomMembers.TryGetValue(roomName, out var members) && members.ContainsKey(username);
    }

    public List<string> GetUserTextRooms(string username)
    {
        return _textRoomMembers
            .Where(kv => kv.Value.ContainsKey(username))
            .Select(kv => kv.Key)
            .ToList();
    }

    public void RemoveUser(string username)
    {
        _userVoiceRoom.TryRemove(username, out _);
        foreach (var members in _textRoomMembers.Values)
            members.TryRemove(username, out _);
        RemoveAllStreamWatching(username);
    }

    // ── Stream watcher tracking ─────────────────────────────
    // Tracks which users have opted-in to watch a streamer's video/screen audio.
    // Key = streamer username, Value = set of watcher usernames.
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _streamWatchers = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Register that <paramref name="watcher"/> wants to receive stream data from <paramref name="streamer"/>.</summary>
    public void WatchStream(string watcher, string streamer)
    {
        var watchers = _streamWatchers.GetOrAdd(streamer, _ => new(StringComparer.OrdinalIgnoreCase));
        watchers[watcher] = 0;
        _log?.Invoke($"[Stream] {watcher} is now watching {streamer}");
    }

    /// <summary>Register that <paramref name="watcher"/> no longer wants stream data from <paramref name="streamer"/>.</summary>
    public void UnwatchStream(string watcher, string streamer)
    {
        if (_streamWatchers.TryGetValue(streamer, out var watchers))
        {
            watchers.TryRemove(watcher, out _);
            _log?.Invoke($"[Stream] {watcher} stopped watching {streamer}");
        }
    }

    /// <summary>Returns true if <paramref name="watcher"/> is watching <paramref name="streamer"/>.</summary>
    public bool IsWatchingStream(string watcher, string streamer)
    {
        return _streamWatchers.TryGetValue(streamer, out var watchers) && watchers.ContainsKey(watcher);
    }

    /// <summary>Returns all usernames currently watching <paramref name="streamer"/>.</summary>
    public List<string> GetStreamWatchers(string streamer)
    {
        if (_streamWatchers.TryGetValue(streamer, out var watchers))
            return watchers.Keys.ToList();
        return new();
    }

    /// <summary>Removes all watcher entries when a streamer stops streaming.</summary>
    public void ClearStreamWatchers(string streamer)
    {
        _streamWatchers.TryRemove(streamer, out _);
        _log?.Invoke($"[Stream] Cleared all watchers for {streamer}");
    }

    /// <summary>Removes a user from all watching relationships (both as watcher and as streamer).</summary>
    public void RemoveAllStreamWatching(string username)
    {
        // Remove as streamer
        _streamWatchers.TryRemove(username, out _);
        // Remove as watcher from all streamers
        foreach (var kv in _streamWatchers)
            kv.Value.TryRemove(username, out _);
    }
}