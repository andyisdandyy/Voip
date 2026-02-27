using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

public class ServerConfig
{
    // ── Server identity ─────────────────────────────────────
    public string ServerName { get; set; } = "MeiChat Server";
    public string? ServerPassword { get; set; }

    // ── Network ─────────────────────────────────────────────
    public string VoiceHost { get; set; } = "0.0.0.0";
    public int UdpPort { get; set; } = 5000;
    public int TcpPort { get; set; } = 5001;

    // ── Quality limits (global for all rooms) ────────────────
    public int MaxCameraWidth { get; set; } = 1920;
    public int MaxCameraHeight { get; set; } = 1080;
    public int MaxScreenWidth { get; set; } = 1920;
    public int MaxScreenHeight { get; set; } = 1080;
    public int MaxFps { get; set; } = 30;
    public int DefaultBitrate { get; set; } = 96000;

    // ── Load / Save ─────────────────────────────────────────

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static ServerConfig Load(string? path = null)
    {
        path ??= Path.Combine(AppContext.BaseDirectory, "server-config.json");
        try
        {
            if (!File.Exists(path))
            {
                var def = CreateDefault();
                // Write default config so the server owner can edit it
                try { File.WriteAllText(path, JsonSerializer.Serialize(def, _jsonOpts)); } catch { }
                return def;
            }
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<ServerConfig>(json, _jsonOpts) ?? CreateDefault();
        }
        catch
        {
            return CreateDefault();
        }
    }

    private static ServerConfig CreateDefault() => new();
}
