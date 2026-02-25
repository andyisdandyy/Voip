using Avalonia;

namespace VoipClient.Mac;

class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        MacPermissions.EnsureMicrophoneAccess();
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .LogToTrace();
}
