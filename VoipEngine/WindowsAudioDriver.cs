using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using NAudio.Wave;

namespace VoipEngine
{
    public class WindowsAudioDriver : IAudioDriver
    {
        private WaveInEvent? input;
        private WaveOutEvent? output;
        private BufferedWaveProvider? buffer;

        // Circular capture buffer — avoids O(n) List<short>.RemoveRange per callback
        private short[] _ringBuffer = new short[4096];
        private int _ringHead; // write position
        private int _ringTail; // read position
        private int _ringCount;
        private readonly object _captureLock = new();
        private EventHandler<WaveInEventArgs>? _dataAvailableHandler;

        // Pooled playback byte buffer — avoids allocation per 20ms frame
        private byte[] _playbackBytes = new byte[TargetFrameSize * 2];

        private const int SampleRate = 48000;
        private const int Channels = 1;
        private const int TargetFrameSize = 960; // 20 ms at 48 kHz

        private int _inputDeviceIndex = -1;  // -1 = system default
        private int _outputDeviceIndex = -1;

        public void SetInputDevice(int deviceIndex) => _inputDeviceIndex = deviceIndex;
        public void SetOutputDevice(int deviceIndex) => _outputDeviceIndex = deviceIndex;

        public List<string> GetInputDevices()
        {
            var devices = new List<string> { "Default" };
            int count = NativeMM.waveInGetNumDevs();
            for (int i = 0; i < count; i++)
            {
                var caps = new NativeMM.WAVEINCAPSW();
                if (NativeMM.waveInGetDevCapsW((nint)i, ref caps, Marshal.SizeOf<NativeMM.WAVEINCAPSW>()) == 0)
                    devices.Add(caps.szPname);
                else
                    devices.Add($"Input Device {i}");
            }
            return devices;
        }

        public List<string> GetOutputDevices()
        {
            var devices = new List<string> { "Default" };
            int count = NativeMM.waveOutGetNumDevs();
            for (int i = 0; i < count; i++)
            {
                var caps = new NativeMM.WAVEOUTCAPSW();
                if (NativeMM.waveOutGetDevCapsW((nint)i, ref caps, Marshal.SizeOf<NativeMM.WAVEOUTCAPSW>()) == 0)
                    devices.Add(caps.szPname);
                else
                    devices.Add($"Output Device {i}");
            }
            return devices;
        }

        public void Init()
        {
            if (buffer != null && output != null)
                return;

            var format = new WaveFormat(SampleRate, 16, Channels);

            if (buffer == null)
                buffer = new BufferedWaveProvider(format)
                {
                    BufferDuration = TimeSpan.FromMilliseconds(200),
                    DiscardOnBufferOverflow = true
                };

            if (output == null)
            {
                output = new WaveOutEvent
                {
                    DeviceNumber = _outputDeviceIndex,
                    DesiredLatency = 100
                };
                output.Init(buffer);
            }
        }

        public void Start(Action<short[]> onFrameCaptured)
        {
            Init();

            if (input != null)
                return;

            input = new WaveInEvent
            {
                DeviceNumber = _inputDeviceIndex,
                WaveFormat = new WaveFormat(SampleRate, 16, Channels),
                BufferMilliseconds = 20
            };

            _dataAvailableHandler = (s, e) =>
            {
                int samples = e.BytesRecorded / 2;

                lock (_captureLock)
                {
                    // Ensure ring buffer has space
                    int required = _ringCount + samples;
                    if (required > _ringBuffer.Length)
                    {
                        int newSize = Math.Max(_ringBuffer.Length * 2, required);
                        var newBuf = new short[newSize];
                        for (int j = 0; j < _ringCount; j++)
                            newBuf[j] = _ringBuffer[(_ringTail + j) % _ringBuffer.Length];
                        _ringBuffer = newBuf;
                        _ringTail = 0;
                        _ringHead = _ringCount;
                    }

                    // Copy incoming bytes directly into ring buffer as shorts
                    for (int j = 0; j < samples; j++)
                    {
                        _ringBuffer[_ringHead] = (short)(e.Buffer[j * 2] | (e.Buffer[j * 2 + 1] << 8));
                        _ringHead = (_ringHead + 1) % _ringBuffer.Length;
                    }
                    _ringCount += samples;

                    // Emit complete frames
                    while (_ringCount >= TargetFrameSize)
                    {
                        var frame = new short[TargetFrameSize];
                        for (int j = 0; j < TargetFrameSize; j++)
                        {
                            frame[j] = _ringBuffer[_ringTail];
                            _ringTail = (_ringTail + 1) % _ringBuffer.Length;
                        }
                        _ringCount -= TargetFrameSize;

                        try
                        {
                            onFrameCaptured?.Invoke(frame);
                        }
                        catch
                        {
                        }
                    }
                }
            };
            input.DataAvailable += _dataAvailableHandler;

            input.StartRecording();

            if (output != null)
                output.Play();
        }

        public void Play(short[] pcm)
        {
            if (pcm == null || pcm.Length == 0)
                return;

            Init();

            if (buffer == null)
                return;

            int byteLen = pcm.Length * 2;
            if (_playbackBytes.Length < byteLen)
                _playbackBytes = new byte[byteLen];
            Buffer.BlockCopy(pcm, 0, _playbackBytes, 0, byteLen);
            buffer.AddSamples(_playbackBytes, 0, byteLen);

            output?.Play();
        }

        public void Stop()
        {
            if (input != null)
            {
                try { input.StopRecording(); } catch { }
                if (_dataAvailableHandler != null)
                {
                    input.DataAvailable -= _dataAvailableHandler;
                    _dataAvailableHandler = null;
                }
                input.Dispose();
                input = null;
            }

            if (output != null)
            {
                try { output.Stop(); } catch { }
                output.Dispose();
                output = null;
            }

            buffer = null;

            lock (_captureLock)
            {
                _ringHead = 0;
                _ringTail = 0;
                _ringCount = 0;
            }
        }

        // ── Win32 multimedia interop for device enumeration ─────
        private static class NativeMM
        {
            [DllImport("winmm.dll")]
            public static extern int waveInGetNumDevs();

            [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
            public static extern int waveInGetDevCapsW(nint uDeviceID, ref WAVEINCAPSW pwic, int cbwic);

            [DllImport("winmm.dll")]
            public static extern int waveOutGetNumDevs();

            [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
            public static extern int waveOutGetDevCapsW(nint uDeviceID, ref WAVEOUTCAPSW pwoc, int cbwoc);

            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
            public struct WAVEINCAPSW
            {
                public ushort wMid;
                public ushort wPid;
                public uint vDriverVersion;
                [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
                public string szPname;
                public uint dwFormats;
                public ushort wChannels;
                public ushort wReserved1;
            }

            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
            public struct WAVEOUTCAPSW
            {
                public ushort wMid;
                public ushort wPid;
                public uint vDriverVersion;
                [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
                public string szPname;
                public uint dwFormats;
                public ushort wChannels;
                public ushort wReserved1;
                public uint dwSupport;
            }
        }
    }
}