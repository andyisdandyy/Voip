using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// TCP chat server handling authentication, text/voice room management,
/// video relay, role/permission enforcement, and real-time user presence.
/// Each connected client is served on its own async task.
/// </summary>
public class ChatServer
{
    // ── Dependencies ────────────────────────────────────────
    private readonly TcpListener _listener;
    private readonly RoomManager _rooms;
    private readonly ChatHistoryStore _history;
    private readonly UserStore _userStore;
    private readonly RoleStore _roleStore;
    private readonly AvatarStore _avatarStore;
    private readonly SoundboardStore _soundboardStore;
    private readonly EmojiStore _emojiStore;
    private readonly ServerConfig _serverConfig;
    private readonly Action<string>? _log;

    // ── Connected clients ───────────────────────────────────
    private readonly ConcurrentDictionary<TcpClient, (StreamWriter writer, string name)> _clients = new();

    // ── Active media state per username ─────────────────────
    private readonly ConcurrentDictionary<string, byte> _cameraActive = new();
    private readonly ConcurrentDictionary<string, byte> _screenActive = new();

    // ── User voice state (muted / deafened) ──────────────────
    private readonly ConcurrentDictionary<string, byte> _userMuted = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, byte> _userDeafened = new(StringComparer.OrdinalIgnoreCase);

    // ── User presence status (online / away) ────────────────
    private readonly ConcurrentDictionary<string, string> _userStatus = new(StringComparer.OrdinalIgnoreCase);

    // ── Soundboard cooldown per user ───────────────────────
    private readonly ConcurrentDictionary<string, DateTime> _soundboardCooldown = new(StringComparer.OrdinalIgnoreCase);
    private static readonly TimeSpan SoundboardCooldownDuration = TimeSpan.FromSeconds(1);

    // ── Auth rate limiting per IP ───────────────────────────
    private readonly ConcurrentDictionary<string, (int attempts, DateTime resetAt)> _authRateLimit = new();
    private const int MaxAuthAttempts = 5;
    private static readonly TimeSpan AuthLockoutDuration = TimeSpan.FromMinutes(2);

    public ChatServer(ServerConfig serverConfig, RoomManager rooms, ChatHistoryStore history, UserStore userStore, RoleStore roleStore, AvatarStore avatarStore, SoundboardStore soundboardStore, EmojiStore emojiStore, Action<string>? log = null)
    {
        _serverConfig = serverConfig;
        var bindAddress = serverConfig.BindLocalhost ? IPAddress.Loopback : IPAddress.Any;
        _listener = new TcpListener(bindAddress, serverConfig.TcpPort);
        _rooms = rooms;
        _history = history;
        _userStore = userStore;
        _roleStore = roleStore;
        _avatarStore = avatarStore;
        _soundboardStore = soundboardStore;
        _emojiStore = emojiStore;
        _log = log;
    }

    public async Task StartAsync(CancellationToken ct = default)
    {
        _listener.Start();
        _log?.Invoke($"Chat server listening on port {((IPEndPoint)_listener.LocalEndpoint).Port}");
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
                _ = HandleClientAsync(client);
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            Stop();
        }
    }

    public void Stop()
    {
        try { _listener.Stop(); } catch { }
        foreach (var c in _clients.Keys)
            try { c.Close(); } catch { }
    }

    private async Task HandleClientAsync(TcpClient client)
    {
        string name = "User";
        try
        {
            client.NoDelay = true;
            client.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
            client.Client.SetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveTime, 30);
            client.Client.SetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveInterval, 10);
            client.Client.SetSocketOption(SocketOptionLevel.Tcp, SocketOptionName.TcpKeepAliveRetryCount, 3);
            using var stream = client.GetStream();
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };

            // ── Phase 1: Server password gate (before any user credentials) ──
            var clientIp = (client.Client.RemoteEndPoint as IPEndPoint)?.Address.ToString() ?? "unknown";

            if (!string.IsNullOrEmpty(_serverConfig.ServerPassword))
            {
                await writer.WriteLineAsync("SERVER_PASSWORD_REQUIRED").ConfigureAwait(false);

                var pwLine = (await reader.ReadLineAsync().ConfigureAwait(false))?.Trim();
                if (string.IsNullOrEmpty(pwLine) || !pwLine.StartsWith("SERVER_PASSWORD:"))
                {
                    await writer.WriteLineAsync("SERVER_PASSWORD_FAIL:Ugyldigt format").ConfigureAwait(false);
                    return;
                }

                var submittedPw = pwLine.Substring("SERVER_PASSWORD:".Length);
                if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.UTF8.GetBytes(submittedPw), Encoding.UTF8.GetBytes(_serverConfig.ServerPassword)))
                {
                    await writer.WriteLineAsync("SERVER_PASSWORD_FAIL:Forkert server-adgangskode").ConfigureAwait(false);
                    return;
                }

                await writer.WriteLineAsync("SERVER_PASSWORD_OK").ConfigureAwait(false);
                _log?.Invoke($"[Chat] Server password accepted from {clientIp}");
            }
            else
            {
                await writer.WriteLineAsync("READY").ConfigureAwait(false);
            }

            // ── Phase 2: User authentication ──
            var authLine = (await reader.ReadLineAsync().ConfigureAwait(false))?.Trim();
            if (string.IsNullOrEmpty(authLine))
                return;

            // Rate limiting per IP
            if (_authRateLimit.TryGetValue(clientIp, out var rl) && rl.attempts >= MaxAuthAttempts && DateTime.UtcNow < rl.resetAt)
            {
                await writer.WriteLineAsync("AUTH_FAIL:For mange forsøg — prøv igen senere").ConfigureAwait(false);
                return;
            }

            if (authLine.StartsWith("REGISTER:"))
            {
                var parts = authLine.Substring(9).Split(':', 2);
                if (parts.Length < 2)
                {
                    await writer.WriteLineAsync("REGISTER_FAIL:Invalid format").ConfigureAwait(false);
                    return;
                }
                var (ok, err) = _userStore.Register(parts[0], parts[1]);
                if (!ok)
                {
                    await writer.WriteLineAsync($"REGISTER_FAIL:{err}").ConfigureAwait(false);
                    return;
                }
                name = parts[0];
                var isFirst = _userStore.GetAllUsernames().Count <= 1;
                _roleStore.EnsureDefaultRole(name, isFirst);
                await writer.WriteLineAsync("REGISTER_OK").ConfigureAwait(false);
            }
            else if (authLine.StartsWith("AUTH:"))
            {
                var parts = authLine.Substring(5).Split(':', 2);
                if (parts.Length < 2)
                {
                    await writer.WriteLineAsync("AUTH_FAIL:Invalid format").ConfigureAwait(false);
                    return;
                }
                var (ok, err) = _userStore.Authenticate(parts[0], parts[1]);
                if (!ok)
                {
                    // Track failed attempt for rate limiting
                    _authRateLimit.AddOrUpdate(clientIp,
                        _ => (1, DateTime.UtcNow + AuthLockoutDuration),
                        (_, prev) => (prev.attempts + 1, DateTime.UtcNow + AuthLockoutDuration));
                    await writer.WriteLineAsync($"AUTH_FAIL:{err}").ConfigureAwait(false);
                    return;
                }
                // Clear rate limit on success
                _authRateLimit.TryRemove(clientIp, out _);
                name = _userStore.GetDisplayName(parts[0]);
                _roleStore.EnsureDefaultRole(name, false);
                await writer.WriteLineAsync("AUTH_OK").ConfigureAwait(false);
            }
            else
            {
                await writer.WriteLineAsync("AUTH_FAIL:Authentication required").ConfigureAwait(false);
                return;
            }

            // Register new connection first (so old connection's cleanup preserves voice)
            _clients[client] = (writer, name);
            _log?.Invoke($"[Chat] '{name}' authenticated and connected");

            // Kick existing connections with same username (old one's cleanup will see new client)
            foreach (var existingKv in _clients.ToArray())
            {
                if (existingKv.Key != client && existingKv.Value.name == name)
                {
                    _clients.TryRemove(existingKv.Key, out _);
                    try { existingKv.Key.Close(); } catch { }
                }
            }

            // Send server info so the client can auto-connect voice
            await SendServerInfoAsync(writer, client).ConfigureAwait(false);

            // Send room list
            await SendRoomListAsync(writer).ConfigureAwait(false);

            // Send role definitions
            await SendRoleListAsync(writer).ConfigureAwait(false);

            // Auto-join first non-password text room
            var firstRoom = _rooms.Config.TextRooms.FirstOrDefault(r => string.IsNullOrEmpty(r.Password));
            if (firstRoom != null)
            {
                _rooms.JoinTextRoom(name, firstRoom.Name, null);
                await writer.WriteLineAsync($"JOINED_TEXT:{firstRoom.Name}").ConfigureAwait(false);
                await SendHistoryAsync(writer, firstRoom.Name).ConfigureAwait(false);
            }

            // Broadcast updated users list
            await BroadcastUserListAsync().ConfigureAwait(false);

            // Send soundboard list
            await SendSoundboardListAsync(writer).ConfigureAwait(false);

            // Send custom emoji list
            await SendEmojiListAsync(writer).ConfigureAwait(false);

            string? line;
            while ((line = await reader.ReadLineAsync().ConfigureAwait(false)) != null)
            {
                // Reject oversized messages to prevent memory exhaustion (10 MB max for video frames)
                if (line.Length > 10_000_000) continue;
                if (line.StartsWith("VIDEO:"))
                    await RelayVideoAsync(name, line).ConfigureAwait(false);
                else if (line.StartsWith("CMD:"))
                    await HandleCommandAsync(writer, name, line.Substring(4), client).ConfigureAwait(false);
                else if (line.StartsWith("FILE:"))
                    await HandleFileAsync(writer, name, line.Substring(5)).ConfigureAwait(false);
                else if (line.StartsWith("MSG:"))
                    await HandleMessageAsync(writer, name, line.Substring(4)).ConfigureAwait(false);
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally
        {
            _clients.TryRemove(client, out _);

            // Only remove from rooms if no other connection exists for this user
            // (preserves voice room membership on reconnect / server switch)
            var stillConnected = _clients.Values.Any(c => c.name == name);
            if (!stillConnected)
            {
                if (_cameraActive.TryRemove(name, out _))
                    try { await BroadcastToVoiceRoomAsync(name, $"CAMERA_OFF:{name}").ConfigureAwait(false); } catch { }
                if (_screenActive.TryRemove(name, out _))
                    try { await BroadcastToVoiceRoomAsync(name, $"SCREEN_OFF:{name}").ConfigureAwait(false); } catch { }
                _rooms.RemoveUser(name);
                _userStatus.TryRemove(name, out _);
                _userMuted.TryRemove(name, out _);
                _userDeafened.TryRemove(name, out _);
            }

            _log?.Invoke($"[Chat] '{name}' disconnected{(stillConnected ? " (reconnect, preserving rooms)" : "")}");

            await BroadcastUserListAsync().ConfigureAwait(false);

            try { client.Close(); } catch { }
        }
    }

    private async Task HandleCommandAsync(StreamWriter writer, string name, string cmd, TcpClient client)
    {
        if (cmd == "LIST_ROOMS")
        {
            await SendRoomListAsync(writer).ConfigureAwait(false);
        }
        else if (cmd.StartsWith("JOIN_VOICE:"))
        {
            var args = cmd.Substring("JOIN_VOICE:".Length).Split(':', 2);
            var roomName = args[0];
            var password = args.Length > 1 ? args[1] : null;

            if (_rooms.JoinVoiceRoom(name, roomName, password))
            {
                var bitrate = _rooms.GetVoiceRoomBitrate(roomName);
                await writer.WriteLineAsync($"JOINED_VOICE:{roomName}:{bitrate}").ConfigureAwait(false);

                // Tell the joining user about active cameras/screens in this room
                var activeStreamers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var camUser in _cameraActive.Keys)
                {
                    if (camUser != name && _rooms.GetVoiceRoom(camUser) == roomName)
                    {
                        await writer.WriteLineAsync($"CAMERA_ON:{camUser}").ConfigureAwait(false);
                        activeStreamers.Add(camUser);
                    }
                }
                foreach (var scrUser in _screenActive.Keys)
                {
                    if (scrUser != name && _rooms.GetVoiceRoom(scrUser) == roomName)
                    {
                        await writer.WriteLineAsync($"SCREEN_ON:{scrUser}").ConfigureAwait(false);
                        activeStreamers.Add(scrUser);
                    }
                }

                // Ask active streamers to send a keyframe so the new joiner can decode immediately
                if (activeStreamers.Count > 0)
                {
                    foreach (var kv in _clients)
                    {
                        if (activeStreamers.Contains(kv.Value.name))
                        {
                            try { await kv.Value.writer.WriteLineAsync("REQUEST_KEYFRAME").ConfigureAwait(false); }
                            catch { }
                        }
                    }
                }

                await BroadcastUserListAsync().ConfigureAwait(false);
            }
            else
            {
                await writer.WriteLineAsync("ERROR:Wrong password or room not found").ConfigureAwait(false);
            }
        }
        else if (cmd == "LEAVE_VOICE")
        {
            if (_cameraActive.TryRemove(name, out _))
                await BroadcastToVoiceRoomAsync(name, $"CAMERA_OFF:{name}").ConfigureAwait(false);
            if (_screenActive.TryRemove(name, out _))
                await BroadcastToVoiceRoomAsync(name, $"SCREEN_OFF:{name}").ConfigureAwait(false);
            _rooms.LeaveVoiceRoom(name);
            await writer.WriteLineAsync("LEFT_VOICE").ConfigureAwait(false);
            await BroadcastUserListAsync().ConfigureAwait(false);
        }
        else if (cmd.StartsWith("JOIN_TEXT:"))
        {
            var args = cmd.Substring("JOIN_TEXT:".Length).Split(':', 2);
            var roomName = args[0];
            var password = args.Length > 1 ? args[1] : null;

            if (_rooms.JoinTextRoom(name, roomName, password))
            {
                await writer.WriteLineAsync($"JOINED_TEXT:{roomName}").ConfigureAwait(false);
                await SendHistoryAsync(writer, roomName).ConfigureAwait(false);
            }
            else
            {
                await writer.WriteLineAsync("ERROR:Wrong password or room not found").ConfigureAwait(false);
            }
        }
        else if (cmd.StartsWith("LEAVE_TEXT:"))
        {
            var roomName = cmd.Substring("LEAVE_TEXT:".Length);
            _rooms.LeaveTextRoom(name, roomName);
            await writer.WriteLineAsync($"LEFT_TEXT:{roomName}").ConfigureAwait(false);
        }
        else if (cmd == "CAMERA_ON")
        {
            _cameraActive[name] = 0;
            await BroadcastToVoiceRoomAsync(name, $"CAMERA_ON:{name}").ConfigureAwait(false);
        }
        else if (cmd == "CAMERA_OFF")
        {
            _cameraActive.TryRemove(name, out _);
            await BroadcastToVoiceRoomAsync(name, $"CAMERA_OFF:{name}").ConfigureAwait(false);
        }
        else if (cmd == "SCREEN_ON")
        {
            _screenActive[name] = 0;
            await BroadcastToVoiceRoomAsync(name, $"SCREEN_ON:{name}").ConfigureAwait(false);
        }
        else if (cmd == "SCREEN_OFF")
        {
            _screenActive.TryRemove(name, out _);
            await BroadcastToVoiceRoomAsync(name, $"SCREEN_OFF:{name}").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("DELETE_MSG:"))
        {
            var args = cmd.Substring("DELETE_MSG:".Length).Split(':', 2);
            if (args.Length >= 2)
            {
                var roomName = args[0];
                var msgId = args[1];
                // Allow delete if owner or has delete_messages permission
                if (_history.DeleteMessage(roomName, msgId, name) ||
                    (_roleStore.HasPermission(name, "delete_messages") && _history.DeleteMessageAdmin(roomName, msgId)))
                    await BroadcastToTextRoomAsync(roomName, $"MSG_DELETED:{roomName}:{msgId}").ConfigureAwait(false);
            }
        }
        else if (cmd.StartsWith("PIN_MSG:"))
        {
            // PIN_MSG:<room>:<msgId>
            var args = cmd.Substring("PIN_MSG:".Length).Split(':', 2);
            if (args.Length >= 2 && _roleStore.HasPermission(name, "manage_rooms"))
            {
                var roomName = args[0];
                var msgId = args[1];
                if (_history.PinMessage(roomName, msgId))
                    await BroadcastToTextRoomAsync(roomName, $"MSG_PINNED:{roomName}:{msgId}").ConfigureAwait(false);
            }
            else if (args.Length >= 2)
                await writer.WriteLineAsync("ERROR:Ingen tilladelse").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("UNPIN_MSG:"))
        {
            // UNPIN_MSG:<room>:<msgId>
            var args = cmd.Substring("UNPIN_MSG:".Length).Split(':', 2);
            if (args.Length >= 2 && _roleStore.HasPermission(name, "manage_rooms"))
            {
                var roomName = args[0];
                var msgId = args[1];
                if (_history.UnpinMessage(roomName, msgId))
                    await BroadcastToTextRoomAsync(roomName, $"MSG_UNPINNED:{roomName}:{msgId}").ConfigureAwait(false);
            }
            else if (args.Length >= 2)
                await writer.WriteLineAsync("ERROR:Ingen tilladelse").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("ASSIGN_ROLE:"))
        {
            // ASSIGN_ROLE:<username>:<roleName>
            var args = cmd.Substring("ASSIGN_ROLE:".Length).Split(':', 2);
            if (args.Length >= 2 && _roleStore.HasPermission(name, "manage_roles"))
            {
                if (_roleStore.AssignRole(args[0], args[1]))
                {
                    _log?.Invoke($"[Roles] {name} assigned '{args[1]}' to {args[0]}");
                    await BroadcastUserListAsync().ConfigureAwait(false);
                    await BroadcastRoleListAsync().ConfigureAwait(false);
                }
                else
                    await writer.WriteLineAsync("ERROR:Kunne ikke tildele rolle").ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Ingen tilladelse").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("REMOVE_ROLE:"))
        {
            // REMOVE_ROLE:<username>:<roleName>
            var args = cmd.Substring("REMOVE_ROLE:".Length).Split(':', 2);
            if (args.Length >= 2 && _roleStore.HasPermission(name, "manage_roles"))
            {
                if (_roleStore.RemoveRole(args[0], args[1]))
                {
                    _log?.Invoke($"[Roles] {name} removed '{args[1]}' from {args[0]}");
                    await BroadcastUserListAsync().ConfigureAwait(false);
                    await BroadcastRoleListAsync().ConfigureAwait(false);
                }
                else
                    await writer.WriteLineAsync("ERROR:Kunne ikke fjerne rolle").ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Ingen tilladelse").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("CREATE_ROLE:"))
        {
            // CREATE_ROLE:<name>:<color>:<priority>:<perm1,perm2,...>
            var args = cmd.Substring("CREATE_ROLE:".Length).Split(':', 4);
            if (args.Length >= 4 && _roleStore.HasPermission(name, "manage_roles"))
            {
                var perms = args[3].Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
                if (int.TryParse(args[2], out var prio) && _roleStore.CreateRole(args[0], args[1], prio, perms))
                {
                    _log?.Invoke($"[Roles] {name} created role '{args[0]}'");
                    await BroadcastRoleListAsync().ConfigureAwait(false);
                }
                else
                    await writer.WriteLineAsync("ERROR:Kunne ikke oprette rolle").ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Ingen tilladelse").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("DELETE_ROLE:"))
        {
            var roleName = cmd.Substring("DELETE_ROLE:".Length);
            if (_roleStore.HasPermission(name, "manage_roles"))
            {
                if (_roleStore.DeleteRole(roleName))
                {
                    _log?.Invoke($"[Roles] {name} deleted role '{roleName}'");
                    await BroadcastUserListAsync().ConfigureAwait(false);
                    await BroadcastRoleListAsync().ConfigureAwait(false);
                }
                else
                    await writer.WriteLineAsync("ERROR:Kan ikke slette denne rolle").ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Ingen tilladelse").ConfigureAwait(false);
        }
        else if (cmd == "KICK_USER" || cmd.StartsWith("KICK_USER:"))
        {
            var targetName = cmd.Contains(':') ? cmd.Substring("KICK_USER:".Length) : "";
            if (!string.IsNullOrEmpty(targetName) && _roleStore.HasPermission(name, "kick_users"))
            {
                foreach (var kv in _clients.ToArray())
                {
                    if (string.Equals(kv.Value.name, targetName, StringComparison.OrdinalIgnoreCase))
                    {
                        try { await kv.Value.writer.WriteLineAsync("KICKED").ConfigureAwait(false); } catch { }
                        _clients.TryRemove(kv.Key, out _);
                        try { kv.Key.Close(); } catch { }
                        _log?.Invoke($"[Kick] {name} kicked {targetName}");
                    }
                }
            }
            else
                await writer.WriteLineAsync("ERROR:Ingen tilladelse").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("SET_AVATAR:"))
        {
            var base64 = cmd.Substring("SET_AVATAR:".Length);
            if (_avatarStore.SetAvatar(name, base64))
            {
                _log?.Invoke($"[Avatar] {name} updated avatar ({base64.Length} chars)");
                await BroadcastAsync($"AVATAR:{name}:{base64}").ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Avatar for stor (maks ~32KB)").ConfigureAwait(false);
        }
        else if (cmd == "REMOVE_AVATAR")
        {
            _avatarStore.RemoveAvatar(name);
            _log?.Invoke($"[Avatar] {name} removed avatar");
            await BroadcastAsync($"AVATAR:{name}:").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("SET_STATUS:"))
        {
            var status = cmd.Substring("SET_STATUS:".Length).Trim().ToLowerInvariant();
            if (status is "online" or "away")
            {
                _userStatus[name] = status;
                _log?.Invoke($"[Status] {name} -> {status}");
                await BroadcastUserListAsync().ConfigureAwait(false);
            }
        }
        else if (cmd.StartsWith("SET_MUTED:"))
        {
            var val = cmd.Substring("SET_MUTED:".Length).Trim();
            if (val == "true") _userMuted[name] = 0;
            else _userMuted.TryRemove(name, out _);
            await BroadcastUserListAsync().ConfigureAwait(false);
        }
        else if (cmd.StartsWith("SET_DEAFENED:"))
        {
            var val = cmd.Substring("SET_DEAFENED:".Length).Trim();
            if (val == "true") _userDeafened[name] = 0;
            else _userDeafened.TryRemove(name, out _);
            await BroadcastUserListAsync().ConfigureAwait(false);
        }
        else if (cmd == "PING")
        {
            await writer.WriteLineAsync("PONG").ConfigureAwait(false);
        }
        else if (cmd == "DIAG")
        {
            var remoteEp = client.Client.RemoteEndPoint as IPEndPoint;
            var localEp = client.Client.LocalEndPoint as IPEndPoint;
            var isLoopback = remoteEp?.Address.Equals(IPAddress.Loopback) == true ||
                             remoteEp?.Address.Equals(IPAddress.IPv6Loopback) == true;
            var diag = new Dictionary<string, object?>
            {
                ["RemoteIP"] = remoteEp?.Address.ToString(),
                ["RemotePort"] = remoteEp?.Port,
                ["LocalIP"] = localEp?.Address.ToString(),
                ["LocalPort"] = localEp?.Port,
                ["ViaProxy"] = isLoopback && _serverConfig.BindLocalhost,
                ["BindLocalhost"] = _serverConfig.BindLocalhost,
                ["UdpPort"] = _serverConfig.UdpPort,
                ["PublicUdpPort"] = _serverConfig.PublicUdpPort,
                ["ServerTime"] = DateTime.UtcNow.ToString("O"),
            };
            var json = JsonSerializer.Serialize(diag);
            await writer.WriteLineAsync($"DIAG:{json}").ConfigureAwait(false);
            _log?.Invoke($"[Diag] {name} requested diagnostics from {remoteEp}");
        }
        else if (cmd.StartsWith("UPLOAD_SOUND:"))
        {
            // UPLOAD_SOUND:<name>:<base64data>  (requires admin)
            var payload = cmd.Substring("UPLOAD_SOUND:".Length);
            var idx = payload.IndexOf(':');
            if (idx > 0 && _roleStore.HasPermission(name, "admin"))
            {
                var soundName = payload.Substring(0, idx);
                var base64Data = payload.Substring(idx + 1);
                var estimatedBytes = base64Data.Length * 3 / 4;
                if (estimatedBytes > _serverConfig.MaxSoundSizeKB * 1024)
                {
                    await writer.WriteLineAsync($"ERROR:Sound too large (max {_serverConfig.MaxSoundSizeKB} KB)").ConfigureAwait(false);
                }
                else if (_soundboardStore.AddSound(soundName, base64Data))
                {
                    _log?.Invoke($"[Soundboard] {name} uploaded sound '{soundName}' ({estimatedBytes / 1024}KB)");
                    await BroadcastSoundboardListAsync().ConfigureAwait(false);
                }
                else
                    await writer.WriteLineAsync("ERROR:Could not upload sound").ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("DELETE_SOUND:"))
        {
            var soundName = cmd.Substring("DELETE_SOUND:".Length);
            if (_roleStore.HasPermission(name, "admin"))
            {
                if (_soundboardStore.RemoveSound(soundName))
                {
                    _log?.Invoke($"[Soundboard] {name} deleted sound '{soundName}'");
                    await BroadcastSoundboardListAsync().ConfigureAwait(false);
                }
                else
                    await writer.WriteLineAsync("ERROR:Sound not found").ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("PLAY_SOUND:"))
        {
            var soundName = cmd.Substring("PLAY_SOUND:".Length);
            var senderRoom = _rooms.GetVoiceRoom(name);
            if (senderRoom == null)
            {
                await writer.WriteLineAsync("ERROR:Not in a voice room").ConfigureAwait(false);
            }
            else if (_soundboardCooldown.TryGetValue(name, out var lastPlay) && DateTime.UtcNow - lastPlay < SoundboardCooldownDuration)
            {
                await writer.WriteLineAsync("ERROR:Soundboard cooldown — wait a moment").ConfigureAwait(false);
            }
            else
            {
                _soundboardCooldown[name] = DateTime.UtcNow;
                var base64Data = _soundboardStore.GetSound(soundName);
                if (base64Data != null)
                {
                    // Relay to all users in the same voice room (including sender)
                    var message = $"SOUNDBOARD_PLAY:{name}:{soundName}:{base64Data}";
                    foreach (var kv in _clients)
                    {
                        var (w, clientName) = kv.Value;
                        if (_rooms.GetVoiceRoom(clientName) == senderRoom)
                        {
                            try { await w.WriteLineAsync(message).ConfigureAwait(false); }
                            catch { }
                        }
                    }
                    _log?.Invoke($"[Soundboard] {name} played '{soundName}' in '{senderRoom}'");
                }
                else
                    await writer.WriteLineAsync("ERROR:Sound not found").ConfigureAwait(false);
            }
        }
        else if (cmd.StartsWith("UPLOAD_EMOJI:"))
        {
            // UPLOAD_EMOJI:<name>:<base64data>  (requires admin)
            var payload = cmd.Substring("UPLOAD_EMOJI:".Length);
            var idx = payload.IndexOf(':');
            if (idx > 0 && _roleStore.HasPermission(name, "admin"))
            {
                var emojiName = payload.Substring(0, idx);
                var base64Data = payload.Substring(idx + 1);
                var estimatedBytes = base64Data.Length * 3 / 4;
                if (estimatedBytes > 256 * 1024) // 256 KB max per emoji
                {
                    await writer.WriteLineAsync("ERROR:Emoji too large (max 256 KB)").ConfigureAwait(false);
                }
                else if (_emojiStore.AddEmoji(emojiName, base64Data))
                {
                    _log?.Invoke($"[Emoji] {name} uploaded emoji ':{emojiName}:' ({estimatedBytes / 1024}KB)");
                    await BroadcastEmojiListAsync().ConfigureAwait(false);
                }
                else
                    await writer.WriteLineAsync("ERROR:Could not upload emoji").ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("DELETE_EMOJI:"))
        {
            var emojiName = cmd.Substring("DELETE_EMOJI:".Length);
            if (_roleStore.HasPermission(name, "admin"))
            {
                if (_emojiStore.RemoveEmoji(emojiName))
                {
                    _log?.Invoke($"[Emoji] {name} deleted emoji ':{emojiName}:'");
                    await BroadcastEmojiListAsync().ConfigureAwait(false);
                }
                else
                    await writer.WriteLineAsync("ERROR:Emoji not found").ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("CREATE_VOICE_ROOM:"))
        {
            // CREATE_VOICE_ROOM:<name>:<password>:<bitrate>
            if (!_roleStore.HasPermission(name, "manage_rooms"))
            {
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
                return;
            }
            var args = cmd.Substring("CREATE_VOICE_ROOM:".Length).Split(':', 3);
            var roomName = args[0];
            var password = args.Length > 1 && !string.IsNullOrEmpty(args[1]) ? args[1] : null;
            var bitrate = args.Length > 2 && int.TryParse(args[2], out var br) ? br : 96000;
            if (_rooms.Config.CreateVoiceRoom(roomName, password, bitrate))
            {
                _log?.Invoke($"[Rooms] {name} created voice room '{roomName}'");
                await BroadcastRoomListAsync().ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Room already exists or invalid name").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("CREATE_TEXT_ROOM:"))
        {
            // CREATE_TEXT_ROOM:<name>:<password>
            if (!_roleStore.HasPermission(name, "manage_rooms"))
            {
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
                return;
            }
            var args = cmd.Substring("CREATE_TEXT_ROOM:".Length).Split(':', 2);
            var roomName = args[0];
            var password = args.Length > 1 && !string.IsNullOrEmpty(args[1]) ? args[1] : null;
            if (_rooms.Config.CreateTextRoom(roomName, password))
            {
                _rooms.EnsureTextRoom(roomName);
                _log?.Invoke($"[Rooms] {name} created text room '{roomName}'");
                await BroadcastRoomListAsync().ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Room already exists or invalid name").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("DELETE_VOICE_ROOM:"))
        {
            var roomName = cmd.Substring("DELETE_VOICE_ROOM:".Length);
            if (!_roleStore.HasPermission(name, "manage_rooms"))
            {
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
                return;
            }
            // Kick all users from that voice room first
            var kicked = _rooms.KickVoiceRoom(roomName);
            foreach (var kv in _clients)
            {
                if (kicked.Contains(kv.Value.name, StringComparer.OrdinalIgnoreCase))
                {
                    try { await kv.Value.writer.WriteLineAsync("LEFT_VOICE").ConfigureAwait(false); } catch { }
                }
            }
            if (_rooms.Config.DeleteVoiceRoom(roomName))
            {
                _log?.Invoke($"[Rooms] {name} deleted voice room '{roomName}'");
                await BroadcastRoomListAsync().ConfigureAwait(false);
                await BroadcastUserListAsync().ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Room not found").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("DELETE_TEXT_ROOM:"))
        {
            var roomName = cmd.Substring("DELETE_TEXT_ROOM:".Length);
            if (!_roleStore.HasPermission(name, "manage_rooms"))
            {
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
                return;
            }
            // Notify users in the room
            var users = _rooms.GetTextRoomUsers(roomName);
            foreach (var kv in _clients)
            {
                if (users.Contains(kv.Value.name, StringComparer.OrdinalIgnoreCase))
                {
                    try { await kv.Value.writer.WriteLineAsync($"LEFT_TEXT:{roomName}").ConfigureAwait(false); } catch { }
                }
            }
            _rooms.RemoveTextRoom(roomName);
            if (_rooms.Config.DeleteTextRoom(roomName))
            {
                _log?.Invoke($"[Rooms] {name} deleted text room '{roomName}'");
                await BroadcastRoomListAsync().ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Room not found").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("REORDER_VOICE_ROOMS:"))
        {
            if (!_roleStore.HasPermission(name, "manage_rooms"))
            {
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
                return;
            }
            var names = cmd.Substring("REORDER_VOICE_ROOMS:".Length).Split(',').ToList();
            if (_rooms.Config.ReorderVoiceRooms(names))
            {
                _log?.Invoke($"[Rooms] {name} reordered voice rooms");
                await BroadcastRoomListAsync().ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Invalid room order").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("REORDER_TEXT_ROOMS:"))
        {
            if (!_roleStore.HasPermission(name, "manage_rooms"))
            {
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
                return;
            }
            var names = cmd.Substring("REORDER_TEXT_ROOMS:".Length).Split(',').ToList();
            if (_rooms.Config.ReorderTextRooms(names))
            {
                _log?.Invoke($"[Rooms] {name} reordered text rooms");
                await BroadcastRoomListAsync().ConfigureAwait(false);
            }
            else
                await writer.WriteLineAsync("ERROR:Invalid room order").ConfigureAwait(false);
        }
        else if (cmd.StartsWith("UPDATE_SERVER_CONFIG:"))
        {
            if (!_roleStore.HasPermission(name, "admin"))
            {
                await writer.WriteLineAsync("ERROR:No permission").ConfigureAwait(false);
                return;
            }
            try
            {
                var json = cmd.Substring("UPDATE_SERVER_CONFIG:".Length);
                var updates = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json);
                if (updates == null) { await writer.WriteLineAsync("ERROR:Invalid JSON").ConfigureAwait(false); return; }

                // Only allow safe, non-sensitive fields to be updated
                var safeFields = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                {
                    "ServerName", "ServerLogo", "MaxCameraWidth", "MaxCameraHeight",
                    "MaxScreenWidth", "MaxScreenHeight", "MaxFps",
                    "MaxScreenBitrate", "DefaultBitrate", "MaxFileSizeKB", "MaxSoundSizeKB",
                };

                // Helper to safely parse an int and clamp to a range
                static int ClampInt(JsonElement el, int min, int max)
                {
                    var v = el.TryGetInt64(out var l) ? (int)Math.Clamp(l, min, max) : el.GetInt32();
                    return Math.Clamp(v, min, max);
                }

                foreach (var kv in updates)
                {
                    if (!safeFields.Contains(kv.Key)) continue;
                    switch (kv.Key.ToLowerInvariant())
                    {
                        case "servername": _serverConfig.ServerName = kv.Value.GetString() ?? _serverConfig.ServerName; break;
                        case "serverlogo":
                            var logo = kv.Value.GetString();
                            // Allow clearing (null/empty) or setting (max ~88KB base64 ≈ 64KB image)
                            if (string.IsNullOrEmpty(logo)) _serverConfig.ServerLogo = null;
                            else if (logo.Length <= 120_000) _serverConfig.ServerLogo = logo;
                            break;
                        case "maxcamerawidth": _serverConfig.MaxCameraWidth = ClampInt(kv.Value, 320, 3840); break;
                        case "maxcameraheight": _serverConfig.MaxCameraHeight = ClampInt(kv.Value, 240, 2160); break;
                        case "maxscreenwidth": _serverConfig.MaxScreenWidth = ClampInt(kv.Value, 320, 3840); break;
                        case "maxscreenheight": _serverConfig.MaxScreenHeight = ClampInt(kv.Value, 240, 2160); break;
                        case "maxfps": _serverConfig.MaxFps = ClampInt(kv.Value, 1, 120); break;
                        case "maxscreenbitrate": _serverConfig.MaxScreenBitrate = ClampInt(kv.Value, 500, 100_000); break;
                        case "defaultbitrate": _serverConfig.DefaultBitrate = ClampInt(kv.Value, 8000, 512_000); break;
                        case "maxfilesizekb": _serverConfig.MaxFileSizeKB = ClampInt(kv.Value, 64, 102_400); break;
                        case "maxsoundsizekb": _serverConfig.MaxSoundSizeKB = ClampInt(kv.Value, 64, 10_240); break;
                    }
                }

                _serverConfig.Save();
                _log?.Invoke($"[Config] {name} updated server config");

                // Broadcast updated SERVER_INFO to all clients
                foreach (var kv in _clients)
                {
                    try { await SendServerInfoAsync(kv.Value.writer, kv.Key).ConfigureAwait(false); }
                    catch { }
                }
            }
            catch
            {
                await writer.WriteLineAsync("ERROR:Failed to update config").ConfigureAwait(false);
            }
        }
    }

    private async Task HandleMessageAsync(StreamWriter writer, string name, string payload)
    {
        var colonIdx = payload.IndexOf(':');
        if (colonIdx < 0) return;

        var roomName = payload.Substring(0, colonIdx);
        var text = payload.Substring(colonIdx + 1);

        if (_rooms.IsInTextRoom(name, roomName))
        {
            var id = _history.AddMessage(roomName, name, text);
            await BroadcastToTextRoomAsync(roomName, $"MSG:{roomName}:{id}:{name}:{text}").ConfigureAwait(false);

            // Detect @mentions and notify mentioned users
            foreach (var kv in _clients)
            {
                var targetName = kv.Value.name;
                if (targetName != name && text.Contains($"@{targetName}", StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        await kv.Value.writer.WriteLineAsync($"MENTION:{roomName}:{name}:{text}").ConfigureAwait(false);
                    }
                    catch { }
                }
            }
        }
        else
            await writer.WriteLineAsync($"ERROR:Not in room '{roomName}'").ConfigureAwait(false);
    }

    private async Task HandleFileAsync(StreamWriter writer, string name, string payload)
    {
        // payload = <room>:<filename>:<mimeType>:<base64data>
        var i1 = payload.IndexOf(':');
        if (i1 < 0) return;
        var roomName = payload.Substring(0, i1);
        var rest = payload.Substring(i1 + 1);

        var i2 = rest.IndexOf(':');
        if (i2 < 0) return;
        var fileName = rest.Substring(0, i2);
        var rest2 = rest.Substring(i2 + 1);

        var i3 = rest2.IndexOf(':');
        if (i3 < 0) return;
        var mimeType = rest2.Substring(0, i3);
        var base64Data = rest2.Substring(i3 + 1);

        // Validate size (base64 is ~4/3 of original, allow overhead for E2EE)
        var estimatedBytes = base64Data.Length * 3 / 4;
        if (estimatedBytes > _serverConfig.MaxFileSizeKB * 1024)
        {
            await writer.WriteLineAsync($"ERROR:Filen er for stor (maks {_serverConfig.MaxFileSizeKB} KB)").ConfigureAwait(false);
            return;
        }

        if (!_rooms.IsInTextRoom(name, roomName))
        {
            await writer.WriteLineAsync($"ERROR:Not in room '{roomName}'").ConfigureAwait(false);
            return;
        }

        var text = $"__FILE__:{fileName}:{mimeType}:{base64Data}";
        var id = _history.AddMessage(roomName, name, text);
        await BroadcastToTextRoomAsync(roomName, $"MSG:{roomName}:{id}:{name}:{text}").ConfigureAwait(false);
        _log?.Invoke($"[Chat] File '{fileName}' ({estimatedBytes / 1024}KB) from '{name}' in '{roomName}'");
    }

    private async Task SendHistoryAsync(StreamWriter writer, string roomName)
    {
        var history = _history.GetHistory(roomName);
        if (history.Count > 0)
        {
            var json = JsonSerializer.Serialize(history);
            await writer.WriteLineAsync($"HISTORY:{roomName}:{json}").ConfigureAwait(false);
        }

        var pinned = _history.GetPinnedMessages(roomName);
        if (pinned.Count > 0)
        {
            var pinsJson = JsonSerializer.Serialize(pinned);
            await writer.WriteLineAsync($"PINS:{roomName}:{pinsJson}").ConfigureAwait(false);
        }
    }

    private async Task SendServerInfoAsync(StreamWriter writer, TcpClient client)
    {
        // Determine the voice host to advertise to the client
        var voiceHost = _serverConfig.VoiceHost;
        // If the server binds to 0.0.0.0, tell the client to use the same IP it connected to
        if (voiceHost == "0.0.0.0" || string.IsNullOrEmpty(voiceHost))
        {
            var localEp = client.Client.LocalEndPoint as IPEndPoint;
            voiceHost = localEp?.Address.ToString() ?? "127.0.0.1";
        }

        var encrypted = _serverConfig.Encrypted || !string.IsNullOrEmpty(_serverConfig.EncryptionKey);
        var encKey = string.IsNullOrEmpty(_serverConfig.EncryptionKey) ? null : _serverConfig.EncryptionKey;

        var info = new Dictionary<string, object?>
        {
            ["ServerName"] = _serverConfig.ServerName,
            ["ServerLogo"] = _serverConfig.ServerLogo,
            ["HasPassword"] = !string.IsNullOrEmpty(_serverConfig.ServerPassword),
            ["VoiceHost"] = voiceHost,
            ["UdpPort"] = _serverConfig.PublicUdpPort is > 0 ? _serverConfig.PublicUdpPort.Value : _serverConfig.UdpPort,
            ["MaxCameraWidth"] = _serverConfig.MaxCameraWidth,
            ["MaxCameraHeight"] = _serverConfig.MaxCameraHeight,
            ["MaxScreenWidth"] = _serverConfig.MaxScreenWidth,
            ["MaxScreenHeight"] = _serverConfig.MaxScreenHeight,
            ["MaxFps"] = _serverConfig.MaxFps,
            ["MaxScreenBitrate"] = _serverConfig.MaxScreenBitrate,
            ["MaxFileSizeKB"] = _serverConfig.MaxFileSizeKB,
            ["MaxSoundSizeKB"] = _serverConfig.MaxSoundSizeKB,
            ["DefaultBitrate"] = _serverConfig.DefaultBitrate,
            ["Encrypted"] = encrypted,
        };
        if (encKey != null)
            info["EncryptionKey"] = encKey;
        if (!string.IsNullOrEmpty(_serverConfig.GiphyApiKey))
            info["GiphyApiKey"] = _serverConfig.GiphyApiKey;
        var json = JsonSerializer.Serialize(info);
        await writer.WriteLineAsync($"SERVER_INFO:{json}").ConfigureAwait(false);
    }

    private string BuildRoomListJson()
    {
        var voiceRooms = _rooms.Config.VoiceRooms.Select(r => new
        {
            r.Name,
            HasPassword = !string.IsNullOrEmpty(r.Password),
            r.Bitrate,
        });
        var textRooms = _rooms.Config.TextRooms.Select(r => new
        {
            r.Name,
            HasPassword = !string.IsNullOrEmpty(r.Password)
        });
        return JsonSerializer.Serialize(new { VoiceRooms = voiceRooms, TextRooms = textRooms });
    }

    private async Task SendRoomListAsync(StreamWriter writer)
    {
        await writer.WriteLineAsync($"ROOMS:{BuildRoomListJson()}").ConfigureAwait(false);
    }

    private async Task BroadcastRoomListAsync()
    {
        var message = $"ROOMS:{BuildRoomListJson()}";
        foreach (var (writer, _) in _clients.Values)
        {
            try { await writer.WriteLineAsync(message).ConfigureAwait(false); }
            catch { }
        }
    }

    private string BuildRoleListJson()
    {
        var roles = _roleStore.GetRoles().Select(r => new
        {
            r.Name,
            r.Color,
            r.Priority,
            r.Permissions,
        });
        return JsonSerializer.Serialize(roles);
    }

    private async Task SendRoleListAsync(StreamWriter writer)
    {
        await writer.WriteLineAsync($"ROLES:{BuildRoleListJson()}").ConfigureAwait(false);
    }

    private async Task BroadcastRoleListAsync()
    {
        var message = $"ROLES:{BuildRoleListJson()}";
        foreach (var (writer, _) in _clients.Values)
        {
            try { await writer.WriteLineAsync(message).ConfigureAwait(false); }
            catch { }
        }
    }

    private async Task BroadcastUserListAsync()
    {
        var clientSnapshot = _clients.Values.ToArray();
        var onlineNames = new HashSet<string>(clientSnapshot.Length, StringComparer.OrdinalIgnoreCase);
        var users = new List<object>(clientSnapshot.Length + 16);

        foreach (var c in clientSnapshot)
        {
            if (!onlineNames.Add(c.name)) continue; // skip duplicate connections
            var highest = _roleStore.GetHighestRole(c.name);
            _userStatus.TryGetValue(c.name, out var status);
            users.Add(new
            {
                Name = c.name,
                VoiceRoom = _rooms.GetVoiceRoom(c.name),
                Online = true,
                Status = status ?? "online",
                Roles = _roleStore.GetUserRoleNames(c.name),
                RoleColor = highest?.Color,
                Avatar = _avatarStore.GetAvatar(c.name),
                Muted = _userMuted.ContainsKey(c.name),
                Deafened = _userDeafened.ContainsKey(c.name),
            });
        }

        foreach (var name in _userStore.GetAllUsernames())
        {
            if (onlineNames.Contains(name)) continue;
            var highest = _roleStore.GetHighestRole(name);
            users.Add(new
            {
                Name = name,
                VoiceRoom = (string?)null,
                Online = false,
                Status = "offline",
                Roles = _roleStore.GetUserRoleNames(name),
                RoleColor = highest?.Color,
                Avatar = _avatarStore.GetAvatar(name),
                Muted = false,
                Deafened = false,
            });
        }

        var json = JsonSerializer.Serialize(users);
        var message = $"USERS:{json}";
        foreach (var c in clientSnapshot)
        {
            try { await c.writer.WriteLineAsync(message).ConfigureAwait(false); }
            catch { }
        }
    }

    private async Task BroadcastToTextRoomAsync(string roomName, string message)
    {
        foreach (var kv in _clients)
        {
            var (writer, clientName) = kv.Value;
            if (_rooms.IsInTextRoom(clientName, roomName))
            {
                try { await writer.WriteLineAsync(message).ConfigureAwait(false); }
                catch { }
            }
        }
        // Log only metadata, never message content (privacy)
        _log?.Invoke($"[Chat] Message broadcast to room '{roomName}'");
    }

    private async Task BroadcastAsync(string message)
    {
        foreach (var (writer, _) in _clients.Values)
        {
            try { await writer.WriteLineAsync(message).ConfigureAwait(false); }
            catch { }
        }
    }

    private async Task BroadcastToVoiceRoomAsync(string senderName, string message)
    {
        var senderRoom = _rooms.GetVoiceRoom(senderName);
        if (senderRoom == null) return;
        foreach (var kv in _clients)
        {
            var (writer, clientName) = kv.Value;
            if (clientName != senderName && _rooms.GetVoiceRoom(clientName) == senderRoom)
            {
                try { await writer.WriteLineAsync(message).ConfigureAwait(false); }
                catch { }
            }
        }
    }

    private async Task SendSoundboardListAsync(StreamWriter writer)
    {
        var names = _soundboardStore.GetNames();
        var json = JsonSerializer.Serialize(names);
        await writer.WriteLineAsync($"SOUNDBOARD:{json}").ConfigureAwait(false);
    }

    private async Task BroadcastSoundboardListAsync()
    {
        var names = _soundboardStore.GetNames();
        var json = JsonSerializer.Serialize(names);
        var message = $"SOUNDBOARD:{json}";
        foreach (var (writer, _) in _clients.Values)
        {
            try { await writer.WriteLineAsync(message).ConfigureAwait(false); }
            catch { }
        }
    }

    private async Task SendEmojiListAsync(StreamWriter writer)
    {
        var all = _emojiStore.GetAll();
        if (all.Count > 0)
        {
            var json = JsonSerializer.Serialize(all);
            await writer.WriteLineAsync($"EMOJIS:{json}").ConfigureAwait(false);
        }
    }

    private async Task BroadcastEmojiListAsync()
    {
        var all = _emojiStore.GetAll();
        var json = JsonSerializer.Serialize(all);
        var message = $"EMOJIS:{json}";
        foreach (var (writer, _) in _clients.Values)
        {
            try { await writer.WriteLineAsync(message).ConfigureAwait(false); }
            catch { }
        }
    }

    private async Task RelayVideoAsync(string senderName, string rawLine)
    {
        var senderRoom = _rooms.GetVoiceRoom(senderName);
        if (senderRoom == null) return;

        // rawLine = "VIDEO:<flags>:<base64data>"
        // Relay as "VIDEO:<sender>:<flags>:<base64data>" to voice room peers
        var outLine = string.Concat("VIDEO:", senderName, ":", rawLine.AsSpan(6));

        foreach (var kv in _clients)
        {
            var (writer, clientName) = kv.Value;
            if (clientName != senderName && _rooms.GetVoiceRoom(clientName) == senderRoom)
            {
                try { await writer.WriteLineAsync(outLine).ConfigureAwait(false); }
                catch { }
            }
        }
    }
}