using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Channels;

Console.WriteLine("VoIP Server starting...");

var serverConfig = ServerConfig.Load();
var roomsConfig = RoomsConfig.Load();

// Simple async file logger
var logChannel = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
_ = Task.Run(async () =>
{
    try
    {
        Directory.CreateDirectory("logs");
        var path = Path.Combine("logs", "voipserver_debug.txt");
        using var sw = new StreamWriter(path, append: true) { AutoFlush = true };
        await foreach (var line in logChannel.Reader.ReadAllAsync())
            await sw.WriteLineAsync($"{DateTime.UtcNow:O} {line}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Logger error: {ex}");
    }
});

void Log(string message)
{
    Console.WriteLine(message);
    _ = logChannel.Writer.WriteAsync(message);
}

var roomManager = new RoomManager(roomsConfig, Log);
var chatHistory = new ChatHistoryStore();
var userStore = new UserStore();
var roleStore = new RoleStore();
var avatarStore = new AvatarStore();
var soundboardStore = new SoundboardStore();

Log("VoIP Server starting...");
Log($"Server: '{serverConfig.ServerName}'");
Log($"Loaded {roomsConfig.VoiceRooms.Count} voice rooms, {roomsConfig.TextRooms.Count} text rooms");
Log($"Loaded {roleStore.GetRoles().Count} roles");
Log($"E2EE: {(!string.IsNullOrEmpty(serverConfig.EncryptionKey) ? "Server-managed key" : serverConfig.Encrypted ? "Client-side (ægte E2EE)" : "Disabled")}");

var chatCts = new CancellationTokenSource();
_ = Task.Run(() => new ChatServer(serverConfig, roomManager, chatHistory, userStore, roleStore, avatarStore, soundboardStore, Log).StartAsync(chatCts.Token));
var bindAddr = serverConfig.BindLocalhost ? "127.0.0.1" : "0.0.0.0";
Log($"Chat server started on {bindAddr}:{serverConfig.TcpPort}{(serverConfig.BindLocalhost ? " (use NGINX for TLS)" : "")}");

var udpPort = serverConfig.UdpPort;
var udp = new UdpClient(udpPort);
udp.Client.ReceiveBufferSize = 2 * 1024 * 1024;
udp.Client.SendBufferSize = 2 * 1024 * 1024;

if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    const int SIO_UDP_CONNRESET = -1744830452;
    udp.Client.IOControl((IOControlCode)SIO_UDP_CONNRESET, new byte[] { 0 }, null);
}

var clients = new ConcurrentDictionary<IPEndPoint, (DateTime lastSeen, string username)>();
var nonceMap = new ConcurrentDictionary<string, IPEndPoint>();
TimeSpan timeout = TimeSpan.FromSeconds(30);

var broadcastChannel = Channel.CreateUnbounded<(UdpReceiveResult result, string senderUsername)>(
    new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });

// Voice-room-aware broadcaster — tags each packet with sender username
var lastDropLog = DateTime.MinValue;
// Cache encoded name bytes per username to avoid re-encoding on every packet
var nameBytesCache = new ConcurrentDictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
_ = Task.Run(async () =>
{
    await foreach (var (res, senderUsername) in broadcastChannel.Reader.ReadAllAsync())
    {
        var sender = res.RemoteEndPoint;
        var buffer = res.Buffer;

        var senderRoom = roomManager.GetVoiceRoom(senderUsername);

        if (senderRoom == null)
        {
            if (DateTime.UtcNow - lastDropLog > TimeSpan.FromSeconds(10))
            {
                Log($"[Broadcast] Audio from '{senderUsername}' dropped — not in any voice room");
                lastDropLog = DateTime.UtcNow;
            }
            continue;
        }

        // Build tagged packet: [nameLen:1][name:N][opus data]
        var nameBytes = nameBytesCache.GetOrAdd(senderUsername, static n => Encoding.UTF8.GetBytes(n));
        var tagged = new byte[1 + nameBytes.Length + buffer.Length];
        tagged[0] = (byte)nameBytes.Length;
        Buffer.BlockCopy(nameBytes, 0, tagged, 1, nameBytes.Length);
        Buffer.BlockCopy(buffer, 0, tagged, 1 + nameBytes.Length, buffer.Length);

        foreach (var kvp in clients)
        {
            var target = kvp.Key;
            if (target.Equals(sender))
                continue;

            var targetRoom = roomManager.GetVoiceRoom(kvp.Value.username);
            if (targetRoom == senderRoom)
            {
                try { await udp.SendAsync(tagged, tagged.Length, target).ConfigureAwait(false); }
                catch { }
            }
        }
    }
});

Log($"Listening for voice on UDP {udpPort}");

// Periodic cleanup of inactive clients (every 5 seconds)
_ = Task.Run(async () =>
{
    while (true)
    {
        await Task.Delay(5000);
        foreach (var kvp in clients.ToArray())
        {
            if (DateTime.UtcNow - kvp.Value.lastSeen > timeout)
            {
                clients.TryRemove(kvp.Key, out var removed);

                foreach (var n in nonceMap.ToArray())
                    if (n.Value.Equals(kvp.Key))
                        nonceMap.TryRemove(n.Key, out _);

                Log($"Removed inactive UDP client {kvp.Key} ({removed.username})");
            }
        }
    }
});

while (true)
{
    UdpReceiveResult result;

    try
    {
        result = await udp.ReceiveAsync();
    }
    catch (SocketException)
    {
        continue;
    }

    var sender = result.RemoteEndPoint;

    var handled = false;
    if (result.Buffer is { Length: > 0 })
    {
        // Fast-path: audio packets start with 0x01 — skip string parsing entirely
        if (result.Buffer[0] == 0x01)
        {
            if (clients.TryGetValue(sender, out var audioClient))
            {
                clients[sender] = (DateTime.UtcNow, audioClient.username);
                _ = broadcastChannel.Writer.WriteAsync((result, audioClient.username));
            }
            continue;
        }

        string? text = null;
        try { text = Encoding.UTF8.GetString(result.Buffer); }
        catch { }

        if (!string.IsNullOrEmpty(text))
        {
            if (text.StartsWith("HELLO:"))
            {
                var payload = text.Substring("HELLO:".Length);
                var colonIdx = payload.IndexOf(':');
                string nonce, username;
                if (colonIdx >= 0)
                {
                    nonce = payload.Substring(0, colonIdx);
                    username = payload.Substring(colonIdx + 1).Trim();
                }
                else
                {
                    nonce = payload;
                    username = "Unknown";
                }

                if (nonceMap.TryGetValue(nonce, out var oldEndpoint) && !oldEndpoint.Equals(sender))
                {
                    clients.TryRemove(oldEndpoint, out _);
                    Log($"Re-associated nonce {nonce} from {oldEndpoint} to {sender}");
                }

                nonceMap[nonce] = sender;
                clients[sender] = (DateTime.UtcNow, username);

                var welcome = Encoding.UTF8.GetBytes($"WELCOME:{nonce}");
                try { await udp.SendAsync(welcome, welcome.Length, sender); }
                catch { }

                Log($"Handshake completed with {sender} (user='{username}')");
                handled = true;
            }
            else if (text.StartsWith("GOODBYE"))
            {
                if (clients.TryRemove(sender, out var info))
                    roomManager.RemoveUser(info.username);

                foreach (var kv in nonceMap.ToArray())
                    if (kv.Value.Equals(sender))
                        nonceMap.TryRemove(kv.Key, out _);

                Log($"Client {sender} disconnected");
                handled = true;
            }
            else if (text == "KEEPALIVE")
            {
                if (clients.TryGetValue(sender, out var info))
                    clients[sender] = (DateTime.UtcNow, info.username);
                handled = true;
            }
        }
    }

    if (handled)
        continue;

    if (clients.TryGetValue(sender, out var clientInfo))
    {
        clients[sender] = (DateTime.UtcNow, clientInfo.username);
        _ = broadcastChannel.Writer.WriteAsync((result, clientInfo.username));
    }
}