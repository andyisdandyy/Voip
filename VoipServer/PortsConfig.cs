using System;
using System.IO;
using System.Text.Json;

public class PortsConfig
{
    public int UdpPort { get; set; } = 5000;
    public int TcpPort { get; set; } = 5001;

    public static PortsConfig Load(string? path = null)
    {
        path ??= Path.Combine(AppContext.BaseDirectory, "ports.json");
        try
        {
            if (!File.Exists(path))
                return new PortsConfig();
            var json = File.ReadAllText(path);
            var cfg = JsonSerializer.Deserialize<PortsConfig>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            return cfg ?? new PortsConfig();
        }
        catch
        {
            return new PortsConfig();
        }
    }
}