using System;
using System.IO;
using System.Text.Json;

namespace VoipClient;

public class ClientSettings
{
    public string? Username { get; set; }
    public string? ServerAddress { get; set; }
    public string? UdpPort { get; set; }
    public string? TcpPort { get; set; }
    public bool DarkMode { get; set; }
    public int InputDeviceIndex { get; set; } = -1;
    public int OutputDeviceIndex { get; set; } = -1;
    public int VoiceGateThreshold { get; set; } = 0;

    private static readonly string SettingsDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "MeiChat");

    private static readonly string SettingsPath = Path.Combine(SettingsDir, "settings.json");

    public static ClientSettings Load()
    {
        try
        {
            if (!File.Exists(SettingsPath))
                return new ClientSettings();
            var json = File.ReadAllText(SettingsPath);
            return JsonSerializer.Deserialize<ClientSettings>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
        }
        catch
        {
            return new ClientSettings();
        }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(SettingsDir);
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(SettingsPath, json);
        }
        catch { }
    }
}