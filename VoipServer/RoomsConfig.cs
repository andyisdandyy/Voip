using System.Text.Json;

/// <summary>
/// A room definition with an optional password and bitrate (for voice rooms).
/// </summary>
public class RoomDefinition
{
    public string Name { get; set; } = "";
    public List<string> AllowedRoles { get; set; } = new();
    public int Bitrate { get; set; } = 96000;
}

/// <summary>
/// Configuration for voice and text rooms, loaded from rooms.json.
/// Creates a default config file if none exists.
/// Supports runtime mutations (create, delete, reorder) with auto-save.
/// </summary>
public class RoomsConfig
{
    public List<RoomDefinition> VoiceRooms { get; set; } = new();
    public List<RoomDefinition> TextRooms { get; set; } = new();

    private string? _path;
    private readonly object _saveLock = new();

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    public static RoomsConfig Load(string? path = null)
    {
        path ??= Path.Combine(AppContext.BaseDirectory, "rooms.json");
        try
        {
            RoomsConfig config;
            if (!File.Exists(path))
            {
                config = CreateDefault();
                try { File.WriteAllText(path, JsonSerializer.Serialize(config, _jsonOpts)); }
                catch (Exception ex) { Console.WriteLine($"WARNING: Could not write default {path}: {ex.Message}"); }
            }
            else
            {
                var json = File.ReadAllText(path);
                config = JsonSerializer.Deserialize<RoomsConfig>(json, _jsonOpts) ?? CreateDefault();
            }
            config._path = path;
            return config;
        }
        catch
        {
            var config = CreateDefault();
            config._path = path;
            return config;
        }
    }

    public void Save()
    {
        if (_path == null) return;
        lock (_saveLock)
        {
            try { File.WriteAllText(_path, JsonSerializer.Serialize(this, _jsonOpts)); }
            catch { }
        }
    }

    // ── Voice Room Mutations ────────────────────────────────

    public bool CreateVoiceRoom(string name, List<string> allowedRoles, int bitrate)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        if (VoiceRooms.Any(r => string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase))) return false;
        VoiceRooms.Add(new RoomDefinition { Name = name, AllowedRoles = allowedRoles, Bitrate = bitrate > 0 ? bitrate : 96000 });
        Save();
        return true;
    }

    public bool DeleteVoiceRoom(string name)
    {
        var room = VoiceRooms.FirstOrDefault(r => string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase));
        if (room == null) return false;
        VoiceRooms.Remove(room);
        Save();
        return true;
    }

    public bool ReorderVoiceRooms(List<string> orderedNames)
    {
        if (orderedNames.Count != VoiceRooms.Count) return false;
        var lookup = VoiceRooms.ToDictionary(r => r.Name, StringComparer.OrdinalIgnoreCase);
        var reordered = new List<RoomDefinition>();
        foreach (var n in orderedNames)
        {
            if (!lookup.TryGetValue(n, out var room)) return false;
            reordered.Add(room);
        }
        VoiceRooms.Clear();
        VoiceRooms.AddRange(reordered);
        Save();
        return true;
    }

    public bool EditVoiceRoom(string oldName, string newName, List<string> allowedRoles, int bitrate)
    {
        var room = VoiceRooms.FirstOrDefault(r => string.Equals(r.Name, oldName, StringComparison.OrdinalIgnoreCase));
        if (room == null) return false;
        // If renaming, ensure the new name doesn't collide with another room
        if (!string.Equals(oldName, newName, StringComparison.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(newName)) return false;
            if (VoiceRooms.Any(r => !ReferenceEquals(r, room) && string.Equals(r.Name, newName, StringComparison.OrdinalIgnoreCase))) return false;
        }
        room.Name = newName;
        room.AllowedRoles = allowedRoles;
        room.Bitrate = bitrate > 0 ? bitrate : 96000;
        Save();
        return true;
    }

    // ── Text Room Mutations ─────────────────────────────────

    public bool CreateTextRoom(string name, List<string> allowedRoles)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        if (TextRooms.Any(r => string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase))) return false;
        TextRooms.Add(new RoomDefinition { Name = name, AllowedRoles = allowedRoles });
        Save();
        return true;
    }

    public bool DeleteTextRoom(string name)
    {
        var room = TextRooms.FirstOrDefault(r => string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase));
        if (room == null) return false;
        TextRooms.Remove(room);
        Save();
        return true;
    }

    public bool EditTextRoom(string oldName, string newName, List<string> allowedRoles)
    {
        var room = TextRooms.FirstOrDefault(r => string.Equals(r.Name, oldName, StringComparison.OrdinalIgnoreCase));
        if (room == null) return false;
        if (!string.Equals(oldName, newName, StringComparison.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(newName)) return false;
            if (TextRooms.Any(r => !ReferenceEquals(r, room) && string.Equals(r.Name, newName, StringComparison.OrdinalIgnoreCase))) return false;
        }
        room.Name = newName;
        room.AllowedRoles = allowedRoles;
        Save();
        return true;
    }

    public bool ReorderTextRooms(List<string> orderedNames)
    {
        if (orderedNames.Count != TextRooms.Count) return false;
        var lookup = TextRooms.ToDictionary(r => r.Name, StringComparer.OrdinalIgnoreCase);
        var reordered = new List<RoomDefinition>();
        foreach (var n in orderedNames)
        {
            if (!lookup.TryGetValue(n, out var room)) return false;
            reordered.Add(room);
        }
        TextRooms.Clear();
        TextRooms.AddRange(reordered);
        Save();
        return true;
    }

    private static RoomsConfig CreateDefault() => new()
    {
        VoiceRooms = new() { new() { Name = "Voice 1", Bitrate = 96000 } },
        TextRooms = new() { new() { Name = "General" } }
    };

    /// <summary>Resets rooms to defaults (one voice, one text channel).</summary>
    public void ResetToDefaults()
    {
        VoiceRooms.Clear();
        VoiceRooms.Add(new RoomDefinition { Name = "Voice 1", Bitrate = 96000 });
        TextRooms.Clear();
        TextRooms.Add(new RoomDefinition { Name = "General" });
        Save();
    }
}