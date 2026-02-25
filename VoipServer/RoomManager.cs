using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

public class RoomManager
{
    private readonly RoomsConfig _config;
    private readonly ConcurrentDictionary<string, string> _userVoiceRoom = new();
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _textRoomMembers = new();
    private readonly Action<string>? _log;

    public RoomManager(RoomsConfig config, Action<string>? log = null)
    {
        _config = config;
        _log = log;
        foreach (var room in config.TextRooms)
            _textRoomMembers[room.Name] = new();
    }

    public RoomsConfig Config => _config;

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
            _textRoomMembers[roomName] = new();
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