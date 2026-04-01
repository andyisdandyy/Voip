using System.Text.Json;

/// <summary>
/// Configuration for the rendezvous server, loaded from rendezvous-config.json.
/// Creates a default config file on first run.
/// </summary>
public class RendezvousConfig
{
    public string ServerName { get; set; } = "Echo Rendezvous";
    public int Port { get; set; } = 5010;
    public bool BindLocalhost { get; set; } = false;
    public int MessageTtlDays { get; set; } = 30;
    public int RateLimitMessages { get; set; } = 30;
    public int RateLimitWindowSeconds { get; set; } = 60;
    public int HeartbeatIntervalSeconds { get; set; } = 25;

    private static readonly JsonSerializerOptions _jsonOpts = new() { WriteIndented = true };

    public static RendezvousConfig Load(string path)
    {
        if (File.Exists(path))
        {
            try
            {
                var json = File.ReadAllText(path);
                return JsonSerializer.Deserialize<RendezvousConfig>(json, _jsonOpts) ?? new RendezvousConfig();
            }
            catch { }
        }
        var config = new RendezvousConfig();
        File.WriteAllText(path, JsonSerializer.Serialize(config, _jsonOpts));
        return config;
    }
}
