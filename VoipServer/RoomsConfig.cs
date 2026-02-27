using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

public class RoomDefinition
{
    public string Name { get; set; } = "";
    public string? Password { get; set; }
    public int Bitrate { get; set; } = 96000;
}

public class RoomsConfig
{
    public List<RoomDefinition> VoiceRooms { get; set; } = new();
    public List<RoomDefinition> TextRooms { get; set; } = new();

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
            if (!File.Exists(path))
            {
                var def = CreateDefault();
                try { File.WriteAllText(path, JsonSerializer.Serialize(def, _jsonOpts)); } catch { }
                return def;
            }
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<RoomsConfig>(json, _jsonOpts) ?? CreateDefault();
        }
        catch
        {
            return CreateDefault();
        }
    }

    private static RoomsConfig CreateDefault() => new()
    {
        VoiceRooms = new() { new() { Name = "Voice 1", Bitrate = 96000 } },
        TextRooms = new() { new() { Name = "General" } }
    };
}