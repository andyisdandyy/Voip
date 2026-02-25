using System;
using Avalonia.Controls;
using Avalonia.Interactivity;

namespace VoipClient.Mac;

public partial class MainWindow : Window
{
    private readonly VoipEngine.VoipEngine _engine = new();
    private ClientSettings _settings = ClientSettings.Load();
    private ChatWindow? _chatWindow;

    public MainWindow()
    {
        InitializeComponent();
        ApplySettings();
    }

    private void ApplySettings()
    {
        if (!string.IsNullOrEmpty(_settings.Username))
            NameBox.Text = _settings.Username;
        if (!string.IsNullOrEmpty(_settings.ServerAddress))
            ServerBox.Text = _settings.ServerAddress;
        if (!string.IsNullOrEmpty(_settings.UdpPort))
            UdpPortBox.Text = _settings.UdpPort;
        if (!string.IsNullOrEmpty(_settings.TcpPort))
            TcpPortBox.Text = _settings.TcpPort;

        _engine.SetInputDevice(_settings.InputDeviceIndex);
        _engine.SetOutputDevice(_settings.OutputDeviceIndex);
        _engine.SetVoiceGate(_settings.VoiceGateThreshold);
        App.ApplyTheme(_settings.DarkMode);
    }

    private void SaveConnectionSettings(string username)
    {
        _settings.Username = username;
        _settings.ServerAddress = ServerBox.Text;
        _settings.UdpPort = UdpPortBox.Text;
        _settings.TcpPort = TcpPortBox.Text;
        _settings.Save();
    }

    private async void Connect_Click(object? sender, RoutedEventArgs e)
    {
        if (!int.TryParse(UdpPortBox.Text, out var udpPort) || udpPort <= 0 || udpPort > 65535)
        {
            StatusText.Text = "Invalid UDP port";
            return;
        }

        if (!int.TryParse(TcpPortBox.Text, out var tcpPort) || tcpPort <= 0 || tcpPort > 65535)
        {
            StatusText.Text = "Invalid TCP port";
            return;
        }

        var username = string.IsNullOrWhiteSpace(NameBox.Text)
            ? Environment.MachineName
            : NameBox.Text.Trim();

        SaveConnectionSettings(username);

        _engine.SetInputDevice(_settings.InputDeviceIndex);
        _engine.SetOutputDevice(_settings.OutputDeviceIndex);

        try
        {
            StatusText.Text = "Connecting...";
            await _engine.StartAsync(ServerBox.Text!, udpPort, username);

            _chatWindow?.Close();
            _chatWindow = new ChatWindow(ServerBox.Text!, tcpPort, username, _settings, _engine);
            _chatWindow.BitrateChanged += bitrate => _engine.SetBitrate(bitrate);
            _chatWindow.Closed += (s, args) =>
            {
                _engine.Stop();
                _chatWindow = null;
                StatusText.Text = "Disconnected";
                Show();
            };
            _chatWindow.Show();
            Hide();
        }
        catch
        {
            _engine.Stop();
            StatusText.Text = "Failed to connect";
        }
    }

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
        }
    }
}
