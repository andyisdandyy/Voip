using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Server configuration loaded from server-config.json.
/// Controls network binding, encryption mode, quality limits, and server identity.
/// Creates a default config file if none exists.
/// </summary>
public class ServerConfig
{
    // ── Server identity ─────────────────────────────────────
    public string ServerName { get; set; } = "Voip Server";
    public string? ServerPassword { get; set; }

    /// <summary>Server logo as a base64 data-URI (e.g. "data:image/png;base64,..."). Max ~64 KB.</summary>
    public string? ServerLogo { get; set; }

    // ── Encryption ──────────────────────────────────────────
    /// <summary>
    /// When true, all clients must provide an E2EE passphrase to communicate.
    /// The server never sees the key — users share it out-of-band (ægte E2EE).
    /// </summary>
    public bool Encrypted { get; set; } = false;

    /// <summary>
    /// Server-managed E2EE passphrase (convenience mode).
    /// When set, the server distributes this key to all clients automatically.
    /// Simpler but the server knows the key. Overrides Encrypted flag.
    /// Set to null or remove to disable.
    /// </summary>
    public string? EncryptionKey { get; set; }

    // ── Network ─────────────────────────────────────────────
    public string VoiceHost { get; set; } = "0.0.0.0";
    public int UdpPort { get; set; } = 5000;
    public int TcpPort { get; set; } = 5001;

    /// <summary>
    /// The UDP port advertised to clients. Use this when running behind a reverse proxy
    /// (e.g. NGINX) that forwards a public port to the internal <see cref="UdpPort"/>.
    /// When null or 0, the value of <see cref="UdpPort"/> is advertised instead.
    /// </summary>
    public int? PublicUdpPort { get; set; }

    /// <summary>
    /// When true, TCP listens only on 127.0.0.1 (for use behind NGINX/reverse proxy).
    /// When false, listens on 0.0.0.0 (direct exposure — only for local dev or LAN).
    /// </summary>
    public bool BindLocalhost { get; set; } = false;

    // ── Quality limits (global for all rooms) ────────────────
    public int MaxCameraWidth { get; set; } = 1920;
    public int MaxCameraHeight { get; set; } = 1080;
    public int MaxScreenWidth { get; set; } = 1920;
    public int MaxScreenHeight { get; set; } = 1080;
    public int MaxFps { get; set; } = 30;
    public int MaxScreenBitrate { get; set; } = 20000;
    public int DefaultBitrate { get; set; } = 96000;

    /// <summary>Maximum file/image upload size in KB (default 2048 = 2 MB).</summary>
    public int MaxFileSizeKB { get; set; } = 2048;

    /// <summary>Maximum soundboard sound file size in KB (default 512 = 512 KB).</summary>
    public int MaxSoundSizeKB { get; set; } = 512;

    /// <summary>
    /// GIPHY API key for GIF search. When set, clients can search and send GIFs.
    /// Get a free key from https://developers.giphy.com/
    /// </summary>
    public string? GiphyApiKey { get; set; }

    // ── Load / Save ─────────────────────────────────────────

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private static readonly JsonSerializerOptions _writeOpts = new()
    {
        WriteIndented = true,
    };

    private string? _loadedPath;

    public static ServerConfig Load(string? path = null)
    {
        path ??= Path.Combine(AppContext.BaseDirectory, "server-config.json");
        try
        {
            ServerConfig config;
            if (!File.Exists(path))
            {
                config = CreateDefault();
                try { File.WriteAllText(path, JsonSerializer.Serialize(config, _writeOpts)); }
                catch (Exception ex) { Console.WriteLine($"WARNING: Could not write default {path}: {ex.Message}"); }
            }
            else
            {
                var json = File.ReadAllText(path);
                config = JsonSerializer.Deserialize<ServerConfig>(json, _jsonOpts) ?? CreateDefault();
            }
            config._loadedPath = path;
            return config;
        }
        catch
        {
            var config = CreateDefault();
            config._loadedPath = path;
            return config;
        }
    }

    public void Save()
    {
        var path = _loadedPath ?? "server-config.json";
        try { File.WriteAllText(path, JsonSerializer.Serialize(this, _writeOpts)); }
        catch (Exception ex) { Console.WriteLine($"WARNING: Could not save {path}: {ex.Message}"); }
    }

    private static ServerConfig CreateDefault() => new();
}
