using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace VoipEngine;

public class LinuxAudioDriver : IAudioDriver
{
    const string LIBASOUND = "libasound.so.2";

    const int SND_PCM_STREAM_PLAYBACK = 0;
    const int SND_PCM_STREAM_CAPTURE = 1;
    const int SND_PCM_FORMAT_S16_LE = 2;
    const int SND_PCM_ACCESS_RW_INTERLEAVED = 3;

    const int SampleRate = 48000;
    const int Channels = 1;
    const int FrameSize = 960; // 20 ms at 48 kHz

    private IntPtr _captureHandle;
    private IntPtr _playbackHandle;
    private Thread? _captureThread;
    private volatile bool _running;
    private Action<short[]>? _captureCallback;

    private int _inputDeviceIndex = -1;  // -1 = default
    private int _outputDeviceIndex = -1;

    public void SetInputDevice(int deviceIndex) => _inputDeviceIndex = deviceIndex;
    public void SetOutputDevice(int deviceIndex) => _outputDeviceIndex = deviceIndex;

    public List<string> GetInputDevices()
    {
        var devices = new List<string> { "Default" };
        try
        {
            int card = -1;
            while (snd_card_next(ref card) == 0 && card >= 0)
            {
                int err = snd_card_get_name(card, out var namePtr);
                if (err == 0 && namePtr != IntPtr.Zero)
                {
                    var name = Marshal.PtrToStringAnsi(namePtr) ?? $"Card {card}";
                    devices.Add(name);
                    AlsaFree(namePtr);
                }
                else
                {
                    devices.Add($"Card {card}");
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ALSA] Device enumeration error: {ex.Message}");
        }
        return devices;
    }

    public List<string> GetOutputDevices() => GetInputDevices();

    public void Start(Action<short[]> onFrameCaptured)
    {
        _captureCallback = onFrameCaptured;

        string captureDevice = _inputDeviceIndex <= 0 ? "default" : $"plughw:{_inputDeviceIndex - 1},0";
        string playbackDevice = _outputDeviceIndex <= 0 ? "default" : $"plughw:{_outputDeviceIndex - 1},0";

        int err = snd_pcm_open(out _captureHandle, captureDevice, SND_PCM_STREAM_CAPTURE, 0);
        if (err < 0)
        {
            Console.WriteLine($"[ALSA] Cannot open capture '{captureDevice}': {GetAlsaError(err)}, trying 'default'");
            err = snd_pcm_open(out _captureHandle, "default", SND_PCM_STREAM_CAPTURE, 0);
            if (err < 0) throw new Exception($"Cannot open ALSA capture: {GetAlsaError(err)}");
        }

        err = snd_pcm_set_params(_captureHandle, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
            (uint)Channels, (uint)SampleRate, 1, 20000);
        if (err < 0)
        {
            snd_pcm_close(_captureHandle);
            _captureHandle = IntPtr.Zero;
            throw new Exception($"Cannot set ALSA capture params: {GetAlsaError(err)}");
        }

        err = snd_pcm_open(out _playbackHandle, playbackDevice, SND_PCM_STREAM_PLAYBACK, 0);
        if (err < 0)
        {
            Console.WriteLine($"[ALSA] Cannot open playback '{playbackDevice}': {GetAlsaError(err)}, trying 'default'");
            err = snd_pcm_open(out _playbackHandle, "default", SND_PCM_STREAM_PLAYBACK, 0);
            if (err < 0)
            {
                snd_pcm_close(_captureHandle);
                _captureHandle = IntPtr.Zero;
                throw new Exception($"Cannot open ALSA playback: {GetAlsaError(err)}");
            }
        }

        err = snd_pcm_set_params(_playbackHandle, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED,
            (uint)Channels, (uint)SampleRate, 1, 100000);
        if (err < 0)
        {
            snd_pcm_close(_captureHandle);
            _captureHandle = IntPtr.Zero;
            snd_pcm_close(_playbackHandle);
            _playbackHandle = IntPtr.Zero;
            throw new Exception($"Cannot set ALSA playback params: {GetAlsaError(err)}");
        }

        _running = true;
        _captureThread = new Thread(CaptureLoop) { IsBackground = true, Name = "ALSA-Capture" };
        _captureThread.Start();

        Console.WriteLine("[ALSA] Audio initialized");
    }

    public void Play(short[] pcm)
    {
        if (_playbackHandle == IntPtr.Zero || pcm == null || pcm.Length == 0)
            return;

        var handle = GCHandle.Alloc(pcm, GCHandleType.Pinned);
        try
        {
            nint frames = snd_pcm_writei(_playbackHandle, handle.AddrOfPinnedObject(), (nuint)pcm.Length);
            if (frames < 0)
            {
                snd_pcm_recover(_playbackHandle, (int)frames, 1);
                snd_pcm_writei(_playbackHandle, handle.AddrOfPinnedObject(), (nuint)pcm.Length);
            }
        }
        catch { }
        finally
        {
            handle.Free();
        }
    }

    public void Stop()
    {
        _running = false;
        _captureThread?.Join(2000);
        _captureThread = null;

        if (_captureHandle != IntPtr.Zero)
        {
            snd_pcm_close(_captureHandle);
            _captureHandle = IntPtr.Zero;
        }

        if (_playbackHandle != IntPtr.Zero)
        {
            snd_pcm_drain(_playbackHandle);
            snd_pcm_close(_playbackHandle);
            _playbackHandle = IntPtr.Zero;
        }
    }

    private void CaptureLoop()
    {
        var buffer = new short[FrameSize];
        var handle = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try
        {
            while (_running)
            {
                nint frames = snd_pcm_readi(_captureHandle, handle.AddrOfPinnedObject(), (nuint)FrameSize);
                if (frames < 0)
                {
                    int recovered = snd_pcm_recover(_captureHandle, (int)frames, 1);
                    if (recovered < 0)
                    {
                        Console.WriteLine($"[ALSA] Unrecoverable capture error: {GetAlsaError(recovered)}");
                        break;
                    }
                    continue;
                }

                if (frames == FrameSize)
                {
                    var copy = new short[FrameSize];
                    Array.Copy(buffer, copy, FrameSize);
                    try { _captureCallback?.Invoke(copy); }
                    catch { }
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ALSA] Capture thread error: {ex.Message}");
        }
        finally
        {
            handle.Free();
        }
    }

    private static string GetAlsaError(int err)
    {
        var ptr = snd_strerror(err);
        return Marshal.PtrToStringAnsi(ptr) ?? $"ALSA error {err}";
    }

    private static void AlsaFree(IntPtr ptr)
    {
        try { Marshal.FreeHGlobal(ptr); } catch { }
    }

    // ── ALSA P/Invoke ──────────────────────────────────────────

    [DllImport(LIBASOUND)]
    private static extern int snd_pcm_open(out IntPtr pcm, [MarshalAs(UnmanagedType.LPStr)] string name, int stream, int mode);

    [DllImport(LIBASOUND)]
    private static extern int snd_pcm_set_params(IntPtr pcm, int format, int access, uint channels, uint rate, int softResample, uint latency);

    [DllImport(LIBASOUND)]
    private static extern nint snd_pcm_readi(IntPtr pcm, IntPtr buffer, nuint size);

    [DllImport(LIBASOUND)]
    private static extern nint snd_pcm_writei(IntPtr pcm, IntPtr buffer, nuint size);

    [DllImport(LIBASOUND)]
    private static extern int snd_pcm_close(IntPtr pcm);

    [DllImport(LIBASOUND)]
    private static extern int snd_pcm_recover(IntPtr pcm, int err, int silent);

    [DllImport(LIBASOUND)]
    private static extern int snd_pcm_drain(IntPtr pcm);

    [DllImport(LIBASOUND)]
    private static extern IntPtr snd_strerror(int errnum);

    [DllImport(LIBASOUND)]
    private static extern int snd_card_next(ref int card);

    [DllImport(LIBASOUND)]
    private static extern int snd_card_get_name(int card, out IntPtr name);
}
