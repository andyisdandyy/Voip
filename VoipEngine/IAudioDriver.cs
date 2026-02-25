namespace VoipEngine;

public interface IAudioDriver
{
    void Start(Action<short[]> onFrameCaptured);
    void Play(short[] pcm);
    void Stop();

    List<string> GetInputDevices() => new() { "Default" };
    List<string> GetOutputDevices() => new() { "Default" };
    void SetInputDevice(int deviceIndex) { }
    void SetOutputDevice(int deviceIndex) { }
}