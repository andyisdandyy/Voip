using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

public class ChatMessage
{
    public string Id { get; set; } = "";
    public string User { get; set; } = "";
    public string Text { get; set; } = "";
    public DateTime Time { get; set; }
}

public class ChatHistoryStore
{
    private readonly string _filePath;
    private readonly ConcurrentDictionary<string, List<ChatMessage>> _history = new();
    private readonly object _saveLock = new();
    private const int MaxPerRoom = 200;

    public ChatHistoryStore(string? filePath = null)
    {
        _filePath = filePath ?? Path.Combine(AppContext.BaseDirectory, "chat_history.json");
        Load();
    }

    public string AddMessage(string room, string user, string text)
    {
        var id = Guid.NewGuid().ToString("N")[..12];
        var msgs = _history.GetOrAdd(room, _ => new List<ChatMessage>());
        lock (msgs)
        {
            msgs.Add(new ChatMessage { Id = id, User = user, Text = text, Time = DateTime.UtcNow });
            if (msgs.Count > MaxPerRoom)
                msgs.RemoveRange(0, msgs.Count - MaxPerRoom);
        }
        Save();
        return id;
    }

    public bool DeleteMessage(string room, string id, string username)
    {
        if (!_history.TryGetValue(room, out var msgs)) return false;
        lock (msgs)
        {
            var msg = msgs.FirstOrDefault(m => m.Id == id);
            if (msg == null || msg.User != username) return false;
            msgs.Remove(msg);
        }
        Save();
        return true;
    }

    public bool DeleteMessageAdmin(string room, string id)
    {
        if (!_history.TryGetValue(room, out var msgs)) return false;
        lock (msgs)
        {
            var msg = msgs.FirstOrDefault(m => m.Id == id);
            if (msg == null) return false;
            msgs.Remove(msg);
        }
        Save();
        return true;
    }

    public List<ChatMessage> GetHistory(string room)
    {
        if (_history.TryGetValue(room, out var msgs))
        {
            lock (msgs)
                return new List<ChatMessage>(msgs);
        }
        return new();
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var json = File.ReadAllText(_filePath);
            var data = JsonSerializer.Deserialize<Dictionary<string, List<ChatMessage>>>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (data != null)
                foreach (var kv in data)
                    _history[kv.Key] = kv.Value;
        }
        catch { }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var snapshot = new Dictionary<string, List<ChatMessage>>();
                foreach (var kv in _history)
                {
                    lock (kv.Value)
                        snapshot[kv.Key] = new List<ChatMessage>(kv.Value);
                }
                var json = JsonSerializer.Serialize(snapshot, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(_filePath, json);
            }
            catch { }
        }
    }
}