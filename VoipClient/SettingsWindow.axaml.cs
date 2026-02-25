using System.Collections.Generic;
using Avalonia.Controls;
using Avalonia.Interactivity;

namespace VoipClient;

public partial class SettingsWindow : Window
{
    private readonly ClientSettings _settings;

    public SettingsWindow(
        ClientSettings settings,
        List<string> inputDevices,
        List<string> outputDevices)
    {
        InitializeComponent();
        _settings = settings;

        DarkModeCheck.IsChecked = settings.DarkMode;

        InputDeviceCombo.ItemsSource = inputDevices;
        OutputDeviceCombo.ItemsSource = outputDevices;

        var inIdx = settings.InputDeviceIndex + 1;
        var outIdx = settings.OutputDeviceIndex + 1;
        InputDeviceCombo.SelectedIndex = inIdx < inputDevices.Count ? inIdx : 0;
        OutputDeviceCombo.SelectedIndex = outIdx < outputDevices.Count ? outIdx : 0;

        VoiceGateSlider.Value = settings.VoiceGateThreshold;
        UpdateVoiceGateLabel(settings.VoiceGateThreshold);
        VoiceGateSlider.ValueChanged += (s, e) => UpdateVoiceGateLabel((int)e.NewValue);
    }

    private void UpdateVoiceGateLabel(int value)
    {
        VoiceGateLabel.Text = value == 0
            ? "🎙 Voice Gate: Off"
            : $"🎙 Voice Gate: {value}%";
    }

    private void Save_Click(object? sender, RoutedEventArgs e)
    {
        _settings.DarkMode = DarkModeCheck.IsChecked == true;
        _settings.InputDeviceIndex = InputDeviceCombo.SelectedIndex - 1;
        _settings.OutputDeviceIndex = OutputDeviceCombo.SelectedIndex - 1;
        _settings.VoiceGateThreshold = (int)VoiceGateSlider.Value;
        _settings.Save();

        App.ApplyTheme(_settings.DarkMode);
        Close(true);
    }
}
