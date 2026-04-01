using System.Text.Json;

/// <summary>
/// Configuration for the rendezvous server, loaded from rendezvous-config.json.
/// Creates a default config file on first run.
/// </summary>
public class RendezvousConfig
{
    /// <summary>Display name shown in the server info endpoint.</summary>
    public string ServerName { get; set; } = "Echo Rendezvous";

    /// <summary>HTTP port the server listens on.</summary>
    public int Port { get; set; } = 5010;

    /// <summary>
    /// When true, binds to 127.0.0.1 only (for use behind a reverse proxy).
    /// When false, binds to all interfaces (0.0.0.0).
    /// </summary>
    public bool BindLocalhost { get; set; } = false;

    /// <summary>Number of days before undelivered offline messages are automatically deleted.</summary>
    public int MessageTtlDays { get; set; } = 30;

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
