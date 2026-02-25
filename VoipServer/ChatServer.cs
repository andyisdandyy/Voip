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
    private readonly Action<string>? _log;

    public ChatServer(int port, RoomManager rooms, ChatHistoryStore history, Action<string>? log = null)
    {
        _listener = new TcpListener(IPAddress.Any, port);
        _rooms = rooms;
        _history = history;
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
            using var stream = client.GetStream();
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };

            name = (await reader.ReadLineAsync().ConfigureAwait(false) ?? "User").Trim();
            _clients[client] = (writer, name);
            _log?.Invoke($"[Chat] '{name}' connected");

            // Send room list
            await SendRoomListAsync(writer).ConfigureAwait(false);

            // Auto-join first non-password text room
            var firstRoom = _rooms.Config.TextRooms.FirstOrDefault(r => string.IsNullOrEmpty(r.Password));
            if (firstRoom != null)
            {
                _rooms.JoinTextRoom(name, firstRoom.Name, null);
                await writer.WriteLineAsync($"JOINED_TEXT:{firstRoom.Name}").ConfigureAwait(false);
                await SendHistoryAsync(writer, firstRoom.Name).ConfigureAwait(false);
            }

            // Broadcast updated users list (replaces "[Server] X joined" messages)
            await BroadcastUserListAsync().ConfigureAwait(false);

            string? line;
            while ((line = await reader.ReadLineAsync().ConfigureAwait(false)) != null)
            {
                if (line.StartsWith("CMD:"))
                    await HandleCommandAsync(writer, name, line.Substring(4)).ConfigureAwait(false);
                else if (line.StartsWith("MSG:"))
                    await HandleMessageAsync(writer, name, line.Substring(4)).ConfigureAwait(false);
            }
        }
        catch (IOException) { /* client disconnected */ }
        catch (ObjectDisposedException) { }
        finally
        {
            _clients.TryRemove(client, out _);
            _rooms.RemoveUser(name);
            _log?.Invoke($"[Chat] '{name}' disconnected");

            // Broadcast updated users list (replaces "[Server] X left" messages)
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
                await BroadcastUserListAsync().ConfigureAwait(false);
            }
            else
            {
                await writer.WriteLineAsync("ERROR:Wrong password or room not found").ConfigureAwait(false);
            }
        }
        else if (cmd == "LEAVE_VOICE")
        {
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
    }

    private async Task HandleMessageAsync(StreamWriter writer, string name, string payload)
    {
        var colonIdx = payload.IndexOf(':');
        if (colonIdx < 0) return;

        var roomName = payload.Substring(0, colonIdx);
        var text = payload.Substring(colonIdx + 1);

        if (_rooms.IsInTextRoom(name, roomName))
        {
            _history.AddMessage(roomName, name, text);
            await BroadcastToTextRoomAsync(roomName, $"MSG:{roomName}:{name}: {text}").ConfigureAwait(false);
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

    private async Task SendRoomListAsync(StreamWriter writer)
    {
        var voiceRooms = _rooms.Config.VoiceRooms.Select(r => new
        {
            r.Name,
            HasPassword = !string.IsNullOrEmpty(r.Password),
            r.Bitrate
        });
        var textRooms = _rooms.Config.TextRooms.Select(r => new
        {
            r.Name,
            HasPassword = !string.IsNullOrEmpty(r.Password)
        });
        var json = JsonSerializer.Serialize(new { VoiceRooms = voiceRooms, TextRooms = textRooms });
        await writer.WriteLineAsync($"ROOMS:{json}").ConfigureAwait(false);
    }

    private async Task BroadcastUserListAsync()
    {
        var users = _clients.Values
            .Select(c => new { Name = c.name, VoiceRoom = _rooms.GetVoiceRoom(c.name) })
            .ToList();
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
}