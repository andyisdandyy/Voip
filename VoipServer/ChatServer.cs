using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

public class ChatServer
{
    private readonly TcpListener _listener;
    private readonly ConcurrentDictionary<TcpClient, (StreamWriter writer, string name)> _clients = new();
    private readonly RoomManager _rooms;
    private readonly ChatHistoryStore _history;
    private readonly UserStore _userStore;
    private readonly RoleStore _roleStore;
    private readonly Action<string>? _log;
    private readonly ServerConfig _serverConfig;
    private readonly ConcurrentDictionary<string, byte> _cameraActive = new();
    private readonly ConcurrentDictionary<string, byte> _screenActive = new();

    public ChatServer(ServerConfig serverConfig, RoomManager rooms, ChatHistoryStore history, UserStore userStore, RoleStore roleStore, Action<string>? log = null)
    {
        _serverConfig = serverConfig;
        _listener = new TcpListener(IPAddress.Any, serverConfig.TcpPort);
        _rooms = rooms;
        _history = history;
        _userStore = userStore;
        _roleStore = roleStore;
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
            using var stream = client.GetStream();
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };

            // Authentication: first line must be AUTH: or REGISTER:
            var authLine = (await reader.ReadLineAsync().ConfigureAwait(false))?.Trim();
            if (string.IsNullOrEmpty(authLine))
                return;

            if (authLine.StartsWith("REGISTER:"))
            {
                var parts = authLine.Substring(9).Split(':', 3);
                if (parts.Length < 2)
                {
                    await writer.WriteLineAsync("REGISTER_FAIL:Invalid format").ConfigureAwait(false);
                    return;
                }
                // Check server password if configured
                if (!string.IsNullOrEmpty(_serverConfig.ServerPassword))
                {
                    var serverPw = parts.Length > 2 ? parts[2] : null;
                    if (serverPw != _serverConfig.ServerPassword)
                    {
                        await writer.WriteLineAsync("REGISTER_FAIL:SERVER_PASSWORD_REQUIRED").ConfigureAwait(false);
                        return;
                    }
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
                var parts = authLine.Substring(5).Split(':', 3);
                if (parts.Length < 2)
                {
                    await writer.WriteLineAsync("AUTH_FAIL:Invalid format").ConfigureAwait(false);
                    return;
                }
                // Check server password if configured
                if (!string.IsNullOrEmpty(_serverConfig.ServerPassword))
                {
                    var serverPw = parts.Length > 2 ? parts[2] : null;
                    if (serverPw != _serverConfig.ServerPassword)
                    {
                        await writer.WriteLineAsync("AUTH_FAIL:SERVER_PASSWORD_REQUIRED").ConfigureAwait(false);
                        return;
                    }
                }
                var (ok, err) = _userStore.Authenticate(parts[0], parts[1]);
                if (!ok)
                {
                    await writer.WriteLineAsync($"AUTH_FAIL:{err}").ConfigureAwait(false);
                    return;
                }
                name = _userStore.GetDisplayName(parts[0]);
                _roleStore.EnsureDefaultRole(name, false);
                await writer.WriteLineAsync("AUTH_OK").ConfigureAwait(false);
            }
            else
            {
                await writer.WriteLineAsync("AUTH_FAIL:Authentication required").ConfigureAwait(false);
                return;
            }

            // Kick existing connection with same username
            foreach (var existingKv in _clients.ToArray())
            {
                if (existingKv.Value.name == name)
                {
                    _clients.TryRemove(existingKv.Key, out _);
                    try { existingKv.Key.Close(); } catch { }
                }
            }

            _clients[client] = (writer, name);
            _log?.Invoke($"[Chat] '{name}' authenticated and connected");

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

            string? line;
            while ((line = await reader.ReadLineAsync().ConfigureAwait(false)) != null)
            {
                if (line.StartsWith("VIDEO:"))
                    await RelayVideoAsync(name, line).ConfigureAwait(false);
                else if (line.StartsWith("CMD:"))
                    await HandleCommandAsync(writer, name, line.Substring(4)).ConfigureAwait(false);
                else if (line.StartsWith("MSG:"))
                    await HandleMessageAsync(writer, name, line.Substring(4)).ConfigureAwait(false);
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally
        {
            if (_cameraActive.TryRemove(name, out _))
                try { await BroadcastToVoiceRoomAsync(name, $"CAMERA_OFF:{name}").ConfigureAwait(false); } catch { }
            if (_screenActive.TryRemove(name, out _))
                try { await BroadcastToVoiceRoomAsync(name, $"SCREEN_OFF:{name}").ConfigureAwait(false); } catch { }
            _clients.TryRemove(client, out _);
            _rooms.RemoveUser(name);
            _log?.Invoke($"[Chat] '{name}' disconnected");

            await BroadcastUserListAsync().ConfigureAwait(false);

            try { client.Close(); } catch { }
        }
    }

    private async Task HandleCommandAsync(StreamWriter writer, string name, string cmd)
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
                foreach (var camUser in _cameraActive.Keys)
                    if (camUser != name && _rooms.GetVoiceRoom(camUser) == roomName)
                        await writer.WriteLineAsync($"CAMERA_ON:{camUser}").ConfigureAwait(false);
                foreach (var scrUser in _screenActive.Keys)
                    if (scrUser != name && _rooms.GetVoiceRoom(scrUser) == roomName)
                        await writer.WriteLineAsync($"SCREEN_ON:{scrUser}").ConfigureAwait(false);

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
        }
        else
            await writer.WriteLineAsync($"ERROR:Not in room '{roomName}'").ConfigureAwait(false);
    }

    private async Task SendHistoryAsync(StreamWriter writer, string roomName)
    {
        var history = _history.GetHistory(roomName);
        if (history.Count > 0)
        {
            var json = JsonSerializer.Serialize(history);
            await writer.WriteLineAsync($"HISTORY:{roomName}:{json}").ConfigureAwait(false);
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

        var info = new
        {
            _serverConfig.ServerName,
            HasPassword = !string.IsNullOrEmpty(_serverConfig.ServerPassword),
            VoiceHost = voiceHost,
            _serverConfig.UdpPort,
            _serverConfig.MaxCameraWidth,
            _serverConfig.MaxCameraHeight,
            _serverConfig.MaxScreenWidth,
            _serverConfig.MaxScreenHeight,
            _serverConfig.MaxFps,
        };
        var json = JsonSerializer.Serialize(info);
        await writer.WriteLineAsync($"SERVER_INFO:{json}").ConfigureAwait(false);
    }

    private async Task SendRoomListAsync(StreamWriter writer)
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
        var json = JsonSerializer.Serialize(new { VoiceRooms = voiceRooms, TextRooms = textRooms });
        await writer.WriteLineAsync($"ROOMS:{json}").ConfigureAwait(false);
    }

    private async Task SendRoleListAsync(StreamWriter writer)
    {
        var roles = _roleStore.GetRoles().Select(r => new
        {
            r.Name,
            r.Color,
            r.Priority,
            r.Permissions,
        });
        var json = JsonSerializer.Serialize(roles);
        await writer.WriteLineAsync($"ROLES:{json}").ConfigureAwait(false);
    }

    private async Task BroadcastRoleListAsync()
    {
        var roles = _roleStore.GetRoles().Select(r => new
        {
            r.Name,
            r.Color,
            r.Priority,
            r.Permissions,
        });
        var json = JsonSerializer.Serialize(roles);
        var message = $"ROLES:{json}";
        foreach (var (writer, _) in _clients.Values)
        {
            try { await writer.WriteLineAsync(message).ConfigureAwait(false); }
            catch { }
        }
    }

    private async Task BroadcastUserListAsync()
    {
        var onlineNames = new HashSet<string>(_clients.Values.Select(c => c.name), StringComparer.OrdinalIgnoreCase);
        var allNames = _userStore.GetAllUsernames();

        var users = new List<object>();
        foreach (var c in _clients.Values)
        {
            var highest = _roleStore.GetHighestRole(c.name);
            users.Add(new
            {
                Name = c.name,
                VoiceRoom = _rooms.GetVoiceRoom(c.name),
                Online = true,
                Roles = _roleStore.GetUserRoleNames(c.name),
                RoleColor = highest?.Color,
            });
        }
        foreach (var name in allNames)
        {
            if (!onlineNames.Contains(name))
            {
                var highest = _roleStore.GetHighestRole(name);
                users.Add(new
                {
                    Name = name,
                    VoiceRoom = (string?)null,
                    Online = false,
                    Roles = _roleStore.GetUserRoleNames(name),
                    RoleColor = highest?.Color,
                });
            }
        }

        var json = JsonSerializer.Serialize(users);
        var message = $"USERS:{json}";
        foreach (var (writer, _) in _clients.Values)
        {
            try { await writer.WriteLineAsync(message).ConfigureAwait(false); }
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
        _log?.Invoke(message);
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
        _log?.Invoke(message);
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