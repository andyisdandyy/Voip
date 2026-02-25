using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace VoipEngine;

public unsafe class MacAudioDriver : IAudioDriver
{
    // ── Audio format constants ──────────────────────────────────
    const int SampleRate = 48000;
    const int Channels = 1;
    const int FramesPerBuffer = 960;  // 20 ms @ 48 kHz (Opus-native)
    const int BytesPerSample = 2;

    // ── Native library paths ────────────────────────────────────
    const string AudioToolboxLib = "/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox";
    const string CoreAudioLib = "/System/Library/Frameworks/CoreAudio.framework/CoreAudio";
    const string CoreFoundationLib = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

    // ── CoreAudio HAL property selectors (FourCharCode → uint) ──
    const uint kAudioObjectSystemObject = 1;
    const uint kAudioHardwarePropertyDevices = 0x64657623;           // 'dev#'
    const uint kAudioObjectPropertyName = 0x6C6E616D;                // 'lnam'
    const uint kAudioDevicePropertyDeviceUID = 0x75696420;           // 'uid '
    const uint kAudioDevicePropertyStreamConfiguration = 0x73747263; // 'strc'
    const uint kAudioObjectPropertyScopeGlobal = 0x676C6F62;        // 'glob'
    const uint kAudioObjectPropertyScopeInput = 0x696E7074;         // 'inpt'
    const uint kAudioObjectPropertyScopeOutput = 0x6F757470;        // 'outp'
    const uint kAudioObjectPropertyElementMain = 0;
    const uint kAudioQueuePropertyCurrentDevice = 0x61716364;        // 'aqcd'
    const uint kCFStringEncodingUTF8 = 0x08000100;

    // ── State ───────────────────────────────────────────────────
    private IntPtr _inputQueue;
    private IntPtr _outputQueue;
    private Action<short[]>? _captureCallback;
    private AudioQueueInputCallback? _inputProc;
    private AudioQueueOutputCallback? _outputProc;

    // Pre-allocated output buffer pool
    private const int OutputBufferCount = 4;
    private readonly IntPtr[] _outputBuffers = new IntPtr[OutputBufferCount];
    private readonly ConcurrentQueue<IntPtr> _freeOutputBuffers = new();

    // Device selection
    private int _inputDeviceIndex = -1;
    private int _outputDeviceIndex = -1;
    private List<string>? _inputDeviceUIDs;
    private List<string>? _outputDeviceUIDs;

    // ── Device enumeration (CoreAudio HAL) ──────────────────────

    public void SetInputDevice(int deviceIndex) => _inputDeviceIndex = deviceIndex;
    public void SetOutputDevice(int deviceIndex) => _outputDeviceIndex = deviceIndex;

    public List<string> GetInputDevices()
    {
        var names = new List<string> { "Default Input" };
        var uids = new List<string> { "" };

        try
        {
            var deviceIds = GetAllAudioDevices();
            foreach (var id in deviceIds)
            {
                if (HasStreams(id, kAudioObjectPropertyScopeInput))
                {
                    var name = GetDeviceName(id) ?? $"Input {id}";
                    var uid = GetDeviceUID(id);
                    if (uid != null)
                    {
                        names.Add(name);
                        uids.Add(uid);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[CoreAudio] Input device enumeration failed: {ex.Message}");
        }

        _inputDeviceUIDs = uids;
        return names;
    }

    public List<string> GetOutputDevices()
    {
        var names = new List<string> { "Default Output" };
        var uids = new List<string> { "" };

        try
        {
            var deviceIds = GetAllAudioDevices();
            foreach (var id in deviceIds)
            {
                if (HasStreams(id, kAudioObjectPropertyScopeOutput))
                {
                    var name = GetDeviceName(id) ?? $"Output {id}";
                    var uid = GetDeviceUID(id);
                    if (uid != null)
                    {
                        names.Add(name);
                        uids.Add(uid);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[CoreAudio] Output device enumeration failed: {ex.Message}");
        }

        _outputDeviceUIDs = uids;
        return names;
    }

    // ── Audio lifecycle ─────────────────────────────────────────

    public void Start(Action<short[]> onFrameCaptured)
    {
        _captureCallback = onFrameCaptured;
        var format = CreateFormat();

        _inputProc = OnInput;
        Check(AudioQueueNewInput(ref format, _inputProc, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out _inputQueue));

        _outputProc = OnOutput;
        Check(AudioQueueNewOutput(ref format, _outputProc, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out _outputQueue));

        // Apply user-selected devices before starting queues
        SetSelectedDevice(_inputQueue, _inputDeviceIndex, _inputDeviceUIDs);
        SetSelectedDevice(_outputQueue, _outputDeviceIndex, _outputDeviceUIDs);

        AllocateInputBuffers();
        AllocateOutputBuffers();

        Check(AudioQueueStart(_inputQueue, IntPtr.Zero));
        Check(AudioQueueStart(_outputQueue, IntPtr.Zero));

        Console.WriteLine("[CoreAudio] Audio initialized");
    }

    public void Play(short[] pcm)
    {
        if (_outputQueue == IntPtr.Zero)
            return;

        int byteSize = pcm.Length * BytesPerSample;

        IntPtr bufferRef;
        if (_freeOutputBuffers.TryDequeue(out var pooled))
            bufferRef = pooled;
        else
            Check(AudioQueueAllocateBuffer(_outputQueue, (uint)byteSize, out bufferRef));

        var buffer = Marshal.PtrToStructure<AudioQueueBuffer>(bufferRef);
        Marshal.Copy(pcm, 0, buffer.AudioData, pcm.Length);
        buffer.AudioDataByteSize = (uint)byteSize;
        Marshal.StructureToPtr(buffer, bufferRef, false);

        Check(AudioQueueEnqueueBuffer(_outputQueue, bufferRef, 0, IntPtr.Zero));
    }

    public void Stop()
    {
        if (_inputQueue != IntPtr.Zero)
        {
            AudioQueueDispose(_inputQueue, true);
            _inputQueue = IntPtr.Zero;
        }

        if (_outputQueue != IntPtr.Zero)
        {
            AudioQueueDispose(_outputQueue, true);
            _outputQueue = IntPtr.Zero;
        }

        while (_freeOutputBuffers.TryDequeue(out _)) { }
        Array.Clear(_outputBuffers);
    }

    // ── Private helpers ─────────────────────────────────────────

    private void AllocateInputBuffers()
    {
        int bufferSize = FramesPerBuffer * BytesPerSample;
        for (int i = 0; i < 3; i++)
        {
            Check(AudioQueueAllocateBuffer(_inputQueue, (uint)bufferSize, out var buf));
            Check(AudioQueueEnqueueBuffer(_inputQueue, buf, 0, IntPtr.Zero));
        }
    }

    private void AllocateOutputBuffers()
    {
        int bufferSize = FramesPerBuffer * BytesPerSample;
        for (int i = 0; i < OutputBufferCount; i++)
        {
            Check(AudioQueueAllocateBuffer(_outputQueue, (uint)bufferSize, out var buf));
            _outputBuffers[i] = buf;
            _freeOutputBuffers.Enqueue(buf);
        }
    }

    private void OnInput(IntPtr userData, IntPtr queue, IntPtr bufferRef,
        IntPtr startTime, uint numPackets, IntPtr desc)
    {
        var buffer = Marshal.PtrToStructure<AudioQueueBuffer>(bufferRef);
        int sampleCount = (int)buffer.AudioDataByteSize / BytesPerSample;
        short[] managed = new short[sampleCount];
        Marshal.Copy(buffer.AudioData, managed, 0, sampleCount);
        _captureCallback?.Invoke(managed);
        AudioQueueEnqueueBuffer(queue, bufferRef, 0, IntPtr.Zero);
    }

    private void OnOutput(IntPtr userData, IntPtr queue, IntPtr bufferRef)
    {
        _freeOutputBuffers.Enqueue(bufferRef);
    }

    private void SetSelectedDevice(IntPtr queue, int deviceIndex, List<string>? deviceUIDs)
    {
        if (deviceIndex <= 0 || deviceUIDs == null || deviceIndex >= deviceUIDs.Count)
            return;

        var uid = deviceUIDs[deviceIndex];
        if (string.IsNullOrEmpty(uid))
            return;

        var cfStr = CFStringCreateWithCString(IntPtr.Zero, uid, kCFStringEncodingUTF8);
        if (cfStr == IntPtr.Zero) return;

        try
        {
            int err = AudioQueueSetProperty(queue, kAudioQueuePropertyCurrentDevice, ref cfStr, (uint)IntPtr.Size);
            if (err != 0)
                Console.WriteLine($"[CoreAudio] Failed to set device '{uid}' (error {err})");
        }
        finally
        {
            CFRelease(cfStr);
        }
    }

    // ── CoreAudio HAL device helpers ────────────────────────────

    private static uint[] GetAllAudioDevices()
    {
        var addr = new AudioObjectPropertyAddress
        {
            mSelector = kAudioHardwarePropertyDevices,
            mScope = kAudioObjectPropertyScopeGlobal,
            mElement = kAudioObjectPropertyElementMain
        };

        if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, ref addr, 0, IntPtr.Zero, out uint dataSize) != 0)
            return Array.Empty<uint>();

        int count = (int)(dataSize / sizeof(uint));
        if (count == 0) return Array.Empty<uint>();

        var ids = new uint[count];
        var handle = GCHandle.Alloc(ids, GCHandleType.Pinned);
        try
        {
            if (AudioObjectGetPropertyData(kAudioObjectSystemObject, ref addr, 0, IntPtr.Zero, ref dataSize, handle.AddrOfPinnedObject()) != 0)
                return Array.Empty<uint>();
            return ids;
        }
        finally
        {
            handle.Free();
        }
    }

    private static bool HasStreams(uint deviceId, uint scope)
    {
        var addr = new AudioObjectPropertyAddress
        {
            mSelector = kAudioDevicePropertyStreamConfiguration,
            mScope = scope,
            mElement = kAudioObjectPropertyElementMain
        };

        if (AudioObjectGetPropertyDataSize(deviceId, ref addr, 0, IntPtr.Zero, out uint dataSize) != 0)
            return false;

        if (dataSize < 4) return false;

        var buffer = Marshal.AllocHGlobal((int)dataSize);
        try
        {
            if (AudioObjectGetPropertyData(deviceId, ref addr, 0, IntPtr.Zero, ref dataSize, buffer) != 0)
                return false;
            // First field of AudioBufferList is mNumberBuffers (UInt32)
            uint numBuffers = (uint)Marshal.ReadInt32(buffer);
            return numBuffers > 0;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string? GetDeviceName(uint deviceId)
    {
        var addr = new AudioObjectPropertyAddress
        {
            mSelector = kAudioObjectPropertyName,
            mScope = kAudioObjectPropertyScopeGlobal,
            mElement = kAudioObjectPropertyElementMain
        };

        uint dataSize = (uint)IntPtr.Size;
        var buffer = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            if (AudioObjectGetPropertyData(deviceId, ref addr, 0, IntPtr.Zero, ref dataSize, buffer) != 0)
                return null;
            var cfName = Marshal.ReadIntPtr(buffer);
            if (cfName == IntPtr.Zero) return null;
            var name = CFStringToManaged(cfName);
            CFRelease(cfName);
            return name;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string? GetDeviceUID(uint deviceId)
    {
        var addr = new AudioObjectPropertyAddress
        {
            mSelector = kAudioDevicePropertyDeviceUID,
            mScope = kAudioObjectPropertyScopeGlobal,
            mElement = kAudioObjectPropertyElementMain
        };

        uint dataSize = (uint)IntPtr.Size;
        var buffer = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            if (AudioObjectGetPropertyData(deviceId, ref addr, 0, IntPtr.Zero, ref dataSize, buffer) != 0)
                return null;
            var cfStr = Marshal.ReadIntPtr(buffer);
            if (cfStr == IntPtr.Zero) return null;
            var uid = CFStringToManaged(cfStr);
            CFRelease(cfStr);
            return uid;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string? CFStringToManaged(IntPtr cfString)
    {
        if (cfString == IntPtr.Zero) return null;
        int length = CFStringGetLength(cfString);
        if (length == 0) return "";
        int bufSize = length * 4 + 1;
        var buffer = Marshal.AllocHGlobal(bufSize);
        try
        {
            if (CFStringGetCString(cfString, buffer, bufSize, kCFStringEncodingUTF8))
                return Marshal.PtrToStringUTF8(buffer);
            return null;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static AudioStreamBasicDescription CreateFormat()
    {
        const uint kAudioFormatLinearPCM = 1819304813; // 'lpcm'
        const uint kLinearPCMFormatFlagIsSignedInteger = 1 << 0;
        const uint kLinearPCMFormatFlagIsPacked = 1 << 3;

        return new AudioStreamBasicDescription
        {
            SampleRate = SampleRate,
            FormatID = kAudioFormatLinearPCM,
            FormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            FramesPerPacket = 1,
            ChannelsPerFrame = Channels,
            BitsPerChannel = 16,
            BytesPerFrame = Channels * BytesPerSample,
            BytesPerPacket = Channels * BytesPerSample,
            Reserved = 0
        };
    }

    private static void Check(int status)
    {
        if (status != 0)
            throw new Exception($"CoreAudio error: {status}");
    }

    // ── P/Invoke: AudioToolbox ──────────────────────────────────

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void AudioQueueInputCallback(
        IntPtr userData, IntPtr queue, IntPtr buffer,
        IntPtr startTime, uint numPackets, IntPtr desc);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void AudioQueueOutputCallback(
        IntPtr userData, IntPtr queue, IntPtr buffer);

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioStreamBasicDescription
    {
        public double SampleRate;
        public uint FormatID, FormatFlags;
        public uint BytesPerPacket, FramesPerPacket, BytesPerFrame;
        public uint ChannelsPerFrame, BitsPerChannel, Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioQueueBuffer
    {
        public uint AudioDataBytesCapacity;
        public IntPtr AudioData;
        public uint AudioDataByteSize;
        public IntPtr UserData;
        public uint PacketDescriptionCapacity;
        public IntPtr PacketDescriptions;
        public uint PacketDescriptionCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioObjectPropertyAddress
    {
        public uint mSelector;
        public uint mScope;
        public uint mElement;
    }

    [DllImport(AudioToolboxLib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int AudioQueueNewInput(ref AudioStreamBasicDescription format,
        AudioQueueInputCallback callback, IntPtr userData, IntPtr runLoop,
        IntPtr runLoopMode, uint flags, out IntPtr queue);

    [DllImport(AudioToolboxLib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int AudioQueueNewOutput(ref AudioStreamBasicDescription format,
        AudioQueueOutputCallback callback, IntPtr userData, IntPtr runLoop,
        IntPtr runLoopMode, uint flags, out IntPtr queue);

    [DllImport(AudioToolboxLib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int AudioQueueAllocateBuffer(IntPtr queue, uint size, out IntPtr buffer);

    [DllImport(AudioToolboxLib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int AudioQueueEnqueueBuffer(IntPtr queue, IntPtr buffer, uint numPacketDescs, IntPtr desc);

    [DllImport(AudioToolboxLib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int AudioQueueStart(IntPtr queue, IntPtr startTime);

    [DllImport(AudioToolboxLib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int AudioQueueDispose(IntPtr queue, bool immediate);

    [DllImport(AudioToolboxLib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int AudioQueueSetProperty(IntPtr queue, uint propertyId, ref IntPtr data, uint dataSize);

    // ── P/Invoke: CoreAudio HAL ─────────────────────────────────

    [DllImport(CoreAudioLib)]
    private static extern int AudioObjectGetPropertyDataSize(
        uint objectId, ref AudioObjectPropertyAddress address,
        uint qualifierDataSize, IntPtr qualifierData, out uint dataSize);

    [DllImport(CoreAudioLib)]
    private static extern int AudioObjectGetPropertyData(
        uint objectId, ref AudioObjectPropertyAddress address,
        uint qualifierDataSize, IntPtr qualifierData,
        ref uint dataSize, IntPtr data);

    // ── P/Invoke: CoreFoundation ────────────────────────────────

    [DllImport(CoreFoundationLib)]
    private static extern IntPtr CFStringCreateWithCString(
        IntPtr allocator, [MarshalAs(UnmanagedType.LPUTF8Str)] string str, uint encoding);

    [DllImport(CoreFoundationLib)]
    private static extern int CFStringGetLength(IntPtr str);

    [DllImport(CoreFoundationLib)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool CFStringGetCString(IntPtr str, IntPtr buffer, int bufferSize, uint encoding);

    [DllImport(CoreFoundationLib)]
    private static extern void CFRelease(IntPtr cf);
}
