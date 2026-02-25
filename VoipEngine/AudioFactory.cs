namespace VoipEngine;

public static class AudioFactory
{
    public static IAudioDriver Create()
    {
        if (OperatingSystem.IsWindows())
            return new WindowsAudioDriver();

        if (OperatingSystem.IsMacOS())
            return new MacAudioDriver();

        if (OperatingSystem.IsLinux())
            return new LinuxAudioDriver();

        throw new PlatformNotSupportedException(
            "Unsupported platform. Supported: Windows, macOS, Linux.");
    }
}