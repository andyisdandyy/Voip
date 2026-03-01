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
    }
}