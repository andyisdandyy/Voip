using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Threading;

namespace VoipClient.Mac;

public partial class ChatWindow : Window
{
    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private TcpClient? _chatClient;
    private StreamWriter? _chatWriter;
    private CancellationTokenSource? _chatCts;
    private readonly string _host;
    private readonly int _port;
    private readonly string _username;
    private readonly ClientSettings _settings;
    private readonly VoipEngine.VoipEngine _engine;

    // Room state
    private List<RoomInfo> _voiceRooms = new();
    private List<RoomInfo> _textRooms = new();
    private readonly HashSet<string> _joinedTextRooms = new();
    private string? _currentVoiceRoom;
    private string? _selectedTextRoom;
    private readonly Dictionary<string, List<string>> _roomMessages = new();

    // Observable collections for list boxes
    private readonly ObservableCollection<string> _voiceRoomItems = new();
    private readonly ObservableCollection<string> _textRoomItems = new();
    private readonly ObservableCollection<string> _chatItems = new();
    private readonly ObservableCollection<string> _userItems = new();

    public event Action<int>? BitrateChanged;

    public ChatWindow(string host, int port, string username, ClientSettings settings, VoipEngine.VoipEngine engine)
    {
        InitializeComponent();
        _host = host;
        _port = port;
        _username = username;
        _settings = settings;
        _engine = engine;
        Title = $"Chat — {_username}";

        VoiceRoomList.ItemsSource = _voiceRoomItems;
        TextRoomList.ItemsSource = _textRoomItems;
        ChatList.ItemsSource = _chatItems;
        UsersList.ItemsSource = _userItems;

        var usersContextMenu = new ContextMenu();
        usersContextMenu.Opening += UsersContextMenu_Opening;
        UsersList.ContextMenu = usersContextMenu;

        Opened += ChatWindow_Opened;
        Closing += ChatWindow_Closing;
    }

    // ── Connection ──────────────────────────────────────────────

    private async void ChatWindow_Opened(object? sender, EventArgs e)
    {
        InfoText.Text = $"Connecting to {_host}:{_port}...";
        await ConnectChatAsync(_host, _port);
    }

    private async Task ConnectChatAsync(string host, int port)
    {
        try
        {
            _chatCts?.Cancel();
            _chatCts = new CancellationTokenSource();

            _chatClient = new TcpClient();
            await _chatClient.ConnectAsync(host, port);
            var ns = _chatClient.GetStream();
            var reader = new StreamReader(ns, Encoding.UTF8);
            _chatWriter = new StreamWriter(ns, Encoding.UTF8) { AutoFlush = true };

            await _chatWriter.WriteLineAsync(_username);
            InfoText.Text = $"Connected as {_username}";

            var cts = _chatCts;
            _ = Task.Run(async () =>
            {
                try
                {
                    string? line;
                    while (!cts.IsCancellationRequested && (line = await reader.ReadLineAsync()) != null)
                    {
                        var msg = line;
                        Dispatcher.UIThread.Post(() => HandleServerMessage(msg));
                    }
                }
                catch { }

                if (!cts.IsCancellationRequested)
                    Dispatcher.UIThread.Post(Close);
            }, cts.Token);
        }
        catch (Exception ex)
        {
            InfoText.Text = "Connection failed";
            _chatItems.Add($"[Error] {ex.Message}");
            _chatClient?.Close();
            _chatClient = null;
            _chatWriter = null;
        }
    }

    // ── Server message dispatcher ───────────────────────────────

    private void HandleServerMessage(string line)
    {
        if (line.StartsWith("ROOMS:"))
        {
            try
            {
                var rooms = JsonSerializer.Deserialize<RoomListResponse>(
                    line.Substring("ROOMS:".Length), JsonOpts);
                if (rooms != null)
                    PopulateRoomLists(rooms);
            }
            catch (Exception ex)
            {
                _chatItems.Add($"[Error] ROOMS parse failed: {ex.Message}");
            }
        }
        else if (line.StartsWith("USERS:"))
        {
            try
            {
                var users = JsonSerializer.Deserialize<List<UserInfo>>(
                    line.Substring("USERS:".Length), JsonOpts);
                if (users != null) UpdateUsersList(users);
            }
            catch (Exception ex)
            {
                _chatItems.Add($"[Error] USERS parse failed: {ex.Message}");
            }
        }
        else if (line.StartsWith("JOINED_TEXT:"))
        {
            var room = line.Substring("JOINED_TEXT:".Length);
            _joinedTextRooms.Add(room);
            if (!_roomMessages.ContainsKey(room))
                _roomMessages[room] = new();
            SelectTextRoom(room);
        }
        else if (line.StartsWith("LEFT_TEXT:"))
        {
            var room = line.Substring("LEFT_TEXT:".Length);
            _joinedTextRooms.Remove(room);
            if (_selectedTextRoom == room)
            {
                _selectedTextRoom = null;
                InfoText.Text = "Select a text room";
                _chatItems.Clear();
            }
        }
        else if (line.StartsWith("JOINED_VOICE:"))
        {
            var payload = line.Substring("JOINED_VOICE:".Length);
            var parts = payload.Split(':', 2);
            _currentVoiceRoom = parts[0];
            if (parts.Length > 1 && int.TryParse(parts[1], out var bitrate))
                BitrateChanged?.Invoke(bitrate);
            LeaveVoiceBtn.IsEnabled = true;
            UpdateInfoText();
        }
        else if (line == "LEFT_VOICE")
        {
            _currentVoiceRoom = null;
            LeaveVoiceBtn.IsEnabled = false;
            UpdateInfoText();
        }
        else if (line.StartsWith("HISTORY:"))
        {
            var payload = line.Substring("HISTORY:".Length);
            var colonIdx = payload.IndexOf(':');
            if (colonIdx >= 0)
            {
                var room = payload.Substring(0, colonIdx);
                var json = payload.Substring(colonIdx + 1);
                try
                {
                    var messages = JsonSerializer.Deserialize<List<ChatHistoryMessage>>(json, JsonOpts);
                    if (messages != null)
                    {
                        if (!_roomMessages.ContainsKey(room))
                            _roomMessages[room] = new();
                        _roomMessages[room].InsertRange(0,
                            messages.Select(m => $"[{m.Time.ToLocalTime():HH:mm}] {m.User}: {m.Text}"));
                        if (room == _selectedTextRoom)
                            RefreshChatList();
                    }
                }
                catch { }
            }
        }
        else if (line.StartsWith("MSG:"))
        {
            var payload = line.Substring("MSG:".Length);
            var colonIdx = payload.IndexOf(':');
            if (colonIdx >= 0)
                AddMessageToRoom(payload.Substring(0, colonIdx), payload.Substring(colonIdx + 1));
        }
        else if (line.StartsWith("ERROR:"))
        {
            InfoText.Text = $"⚠ {line.Substring("ERROR:".Length)}";
        }
    }

    // ── Context menus ───────────────────────────────────────────

    private void VoiceRoomContextMenu_Opening(object? sender, CancelEventArgs e)
    {
        var idx = VoiceRoomList.SelectedIndex;
        if (idx < 0 || idx >= _voiceRooms.Count || _currentVoiceRoom == null)
        {
            e.Cancel = true;
            return;
        }

        var room = _voiceRooms[idx];
        if (room.Name != _currentVoiceRoom)
        {
            e.Cancel = true;
            return;
        }

        var menuItems = new List<object>();

        var voiceStats = _engine.GetVoiceStats();
        menuItems.Add(new MenuItem { Header = "── Voice Connection ──", IsEnabled = false });
        menuItems.Add(new MenuItem
        {
            Header = $"📤 Sent: {voiceStats.PacketsSent} pkts ({FormatBytes(voiceStats.BytesSent)})",
            IsEnabled = false
        });
        menuItems.Add(new MenuItem
        {
            Header = $"📥 Received: {voiceStats.PacketsReceived} pkts ({FormatBytes(voiceStats.BytesReceived)})",
            IsEnabled = false
        });
        menuItems.Add(new MenuItem
        {
            Header = $"⚠ Decode errors: {voiceStats.DecodeErrors}",
            IsEnabled = false
        });

        var menu = (ContextMenu)sender!;
        menu.ItemsSource = menuItems;
    }

    private static string FormatBytes(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:F1} KB";
        return $"{bytes / (1024.0 * 1024.0):F1} MB";
    }

    private void UsersContextMenu_Opening(object? sender, CancelEventArgs e)
    {
        if (UsersList.SelectedItem is not string item)
        {
            e.Cancel = true;
            return;
        }

        var username = item.Split("  🔊")[0].Trim();
        if (username == _username)
        {
            e.Cancel = true;
            return;
        }

        var isMuted = _engine.IsUserMuted(username);
        var currentVol = (int)(_engine.GetUserVolume(username) * 100);

        var menuItems = new List<object>();

        var muteItem = new MenuItem
        {
            Header = isMuted ? $"🔊 Unmute {username}" : $"🔇 Mute {username}"
        };
        muteItem.Click += (s, args) => _engine.MuteUser(username, !isMuted);
        menuItems.Add(muteItem);

        menuItems.Add(new Separator());

        var volLabel = new TextBlock
        {
            Text = $"🔊 {currentVol}%",
            Width = 70,
            VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center
        };
        var volSlider = new Slider
        {
            Minimum = 0,
            Maximum = 200,
            Value = currentVol,
            Width = 140,
            VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center
        };
        volSlider.ValueChanged += (s, args) =>
        {
            var pct = (int)args.NewValue;
            volLabel.Text = $"🔊 {pct}%";
            _engine.SetUserVolume(username, pct / 100f);
            if (pct > 0)
                _engine.MuteUser(username, false);
        };
        var volPanel = new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal };
        volPanel.Children.Add(volLabel);
        volPanel.Children.Add(volSlider);
        var volItem = new MenuItem { Header = volPanel };
        menuItems.Add(volItem);

        var menu = (ContextMenu)sender!;
        menu.ItemsSource = menuItems;
    }

    // ── Room list population ────────────────────────────────────

    private void PopulateRoomLists(RoomListResponse rooms)
    {
        _voiceRooms = rooms.VoiceRooms ?? new();
        _textRooms = rooms.TextRooms ?? new();

        _voiceRoomItems.Clear();
        foreach (var r in _voiceRooms)
        {
            var label = r.HasPassword ? $"🔒 {r.Name}" : r.Name;
            if (r.Bitrate > 0)
                label += $" ({r.Bitrate / 1000}k)";
            _voiceRoomItems.Add(label);
        }

        _textRoomItems.Clear();
        foreach (var r in _textRooms)
            _textRoomItems.Add(r.HasPassword ? $"🔒 {r.Name}" : r.Name);
    }

    // ── Users list ──────────────────────────────────────────────

    private void UpdateUsersList(List<UserInfo> users)
    {
        _userItems.Clear();
        foreach (var user in users)
        {
            var display = !string.IsNullOrEmpty(user.VoiceRoom)
                ? $"{user.Name}  🔊 {user.VoiceRoom}"
                : user.Name;
            _userItems.Add(display);
        }
    }

    // ── Text room view switching ────────────────────────────────

    private void SelectTextRoom(string roomName)
    {
        _selectedTextRoom = roomName;
        UpdateInfoText();
        RefreshChatList();
    }

    private void UpdateInfoText()
    {
        var text = _selectedTextRoom != null ? $"#{_selectedTextRoom}" : "Select a room";
        if (_currentVoiceRoom != null)
            text += $"  |  🔊 {_currentVoiceRoom}";
        InfoText.Text = text;
    }

    private void RefreshChatList()
    {
        _chatItems.Clear();
        if (_selectedTextRoom != null && _roomMessages.TryGetValue(_selectedTextRoom, out var msgs))
            foreach (var m in msgs)
                _chatItems.Add(m);
    }

    private void AddMessageToRoom(string room, string message)
    {
        if (!_roomMessages.ContainsKey(room))
            _roomMessages[room] = new();
        _roomMessages[room].Add(message);

        if (room == _selectedTextRoom)
            _chatItems.Add(message);
    }

    // ── Room interaction ────────────────────────────────────────

    private async void VoiceRoom_DoubleTapped(object? sender, TappedEventArgs e)
    {
        var idx = VoiceRoomList.SelectedIndex;
        if (idx < 0 || idx >= _voiceRooms.Count || _chatWriter == null) return;
        var room = _voiceRooms[idx];

        if (room.Name == _currentVoiceRoom)
            return;

        string? pw = null;
        if (room.HasPassword)
        {
            pw = await PromptPasswordAsync(room.Name);
            if (pw == null) return;
        }

        _ = SendAsync(pw != null
            ? $"CMD:JOIN_VOICE:{room.Name}:{pw}"
            : $"CMD:JOIN_VOICE:{room.Name}");
    }

    private void TextRoom_SelectionChanged(object? sender, SelectionChangedEventArgs e)
    {
        var idx = TextRoomList.SelectedIndex;
        if (idx < 0 || idx >= _textRooms.Count) return;
        var room = _textRooms[idx];

        if (_joinedTextRooms.Contains(room.Name))
            SelectTextRoom(room.Name);
    }

    private async void TextRoom_DoubleTapped(object? sender, TappedEventArgs e)
    {
        var idx = TextRoomList.SelectedIndex;
        if (idx < 0 || idx >= _textRooms.Count || _chatWriter == null) return;
        var room = _textRooms[idx];

        if (_joinedTextRooms.Contains(room.Name))
        {
            SelectTextRoom(room.Name);
            return;
        }

        string? pw = null;
        if (room.HasPassword)
        {
            pw = await PromptPasswordAsync(room.Name);
            if (pw == null) return;
        }

        _ = SendAsync(pw != null
            ? $"CMD:JOIN_TEXT:{room.Name}:{pw}"
            : $"CMD:JOIN_TEXT:{room.Name}");
    }

    // ── Password popup ──────────────────────────────────────────

    private async Task<string?> PromptPasswordAsync(string roomName)
    {
        var dialog = new Window
        {
            Title = $"Password — {roomName}",
            Width = 300,
            Height = 150,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            CanResize = false
        };

        var stack = new StackPanel { Margin = new Thickness(16) };
        var label = new TextBlock
        {
            Text = $"Enter password for '{roomName}':",
            Margin = new Thickness(0, 0, 0, 8)
        };
        var pwBox = new TextBox
        {
            PasswordChar = '●',
            Margin = new Thickness(0, 0, 0, 12)
        };
        var okBtn = new Button
        {
            Content = "Join",
            Width = 80,
            HorizontalAlignment = HorizontalAlignment.Right
        };

        string? result = null;
        okBtn.Click += (s, ev) => { result = pwBox.Text; dialog.Close(); };
        pwBox.KeyDown += (s, ev) =>
        {
            if (ev.Key == Key.Enter) { result = pwBox.Text; dialog.Close(); }
        };

        stack.Children.Add(label);
        stack.Children.Add(pwBox);
        stack.Children.Add(okBtn);
        dialog.Content = stack;

        await dialog.ShowDialog(this);
        return result;
    }

    // ── Settings ────────────────────────────────────────────────

    private async void Settings_Click(object? sender, RoutedEventArgs e)
    {
        var inputDevices = _engine.GetInputDevices();
        var outputDevices = _engine.GetOutputDevices();
        var win = new SettingsWindow(_settings, inputDevices, outputDevices);
        var result = await win.ShowDialog<bool>(this);
        if (result)
        {
            _engine.SetInputDevice(_settings.InputDeviceIndex);
            _engine.SetOutputDevice(_settings.OutputDeviceIndex);
            _engine.SetVoiceGate(_settings.VoiceGateThreshold);
            _engine.RestartAudioDevices();
        }
    }

    // ── Voice leave + chat send ─────────────────────────────────

    private void LeaveVoice_Click(object? sender, RoutedEventArgs e)
    {
        _ = SendAsync("CMD:LEAVE_VOICE");
    }

    private void ChatInput_KeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            SendChat_Click(sender, e);
            e.Handled = true;
        }
    }

    private async void SendChat_Click(object? sender, RoutedEventArgs e)
    {
        var text = ChatInput.Text?.Trim();
        if (string.IsNullOrEmpty(text) || _chatWriter == null || _selectedTextRoom == null)
            return;

        try
        {
            await _chatWriter.WriteLineAsync($"MSG:{_selectedTextRoom}:{text}");
            ChatInput.Text = "";
        }
        catch
        {
            _chatItems.Add("[Chat] send failed");
            DisconnectChat();
        }
    }

    private async Task SendAsync(string message)
    {
        if (_chatWriter == null) return;
        try { await _chatWriter.WriteLineAsync(message); }
        catch { }
    }

    // ── Cleanup ─────────────────────────────────────────────────

    private void ChatWindow_Closing(object? sender, WindowClosingEventArgs e)
    {
        DisconnectChat();
    }

    private void DisconnectChat()
    {
        try
        {
            _chatCts?.Cancel();
            _chatClient?.Close();
        }
        catch { }
        finally
        {
            _chatClient = null;
            _chatWriter = null;
        }
    }
}

// ── DTOs ────────────────────────────────────────────────

internal class RoomInfo
{
    public string Name { get; set; } = "";
    public bool HasPassword { get; set; }
    public int Bitrate { get; set; }
}

internal class RoomListResponse
{
    public List<RoomInfo> VoiceRooms { get; set; } = new();
    public List<RoomInfo> TextRooms { get; set; } = new();
}

internal class UserInfo
{
    public string Name { get; set; } = "";
    public string? VoiceRoom { get; set; }
}

internal class ChatHistoryMessage
{
    public string User { get; set; } = "";
    public string Text { get; set; } = "";
    public DateTime Time { get; set; }
}
