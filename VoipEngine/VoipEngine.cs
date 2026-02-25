using System;
using System.Collections.Concurrent;
using System.Text;
using Concentus;
using Concentus.Enums;
using Concentus.Structs;
using System.Net.Sockets;

namespace VoipEngine;

public class VoipEngine
{
    const int SampleRate = 48000;
    const int FrameSize = 960; // 20 ms

    private readonly IAudioDriver _audio = AudioFactory.Create();

    private readonly JitterBuffer _jitter = new();
    private readonly PeriodicTimer _playTimer = new(TimeSpan.FromMilliseconds(20));

    private readonly byte[] _encodeBuffer = new byte[4000];
    // Pooled decode buffer — reused per received packet, copied into jitter buffer
    private readonly short[] _decodeBuffer = new short[FrameSize];

    private static readonly byte[] WelcomePrefix = Encoding.ASCII.GetBytes("WELCOME:");
    private static readonly byte[] GoodbyePrefix = Encoding.ASCII.GetBytes("GOODBYE");

    private UdpClient? _udp;
    private IOpusEncoder? _encoder;
    private IOpusDecoder? _decoder;

    private int _bitrate = 64000;
    private float _voiceGateThreshold = 0f;
    private Action<short[]>? _captureCallback;

    // Per-user volume & mute
    private readonly ConcurrentDictionary<string, float> _userVolumes = new();
    private readonly ConcurrentDictionary<string, bool> _userMuted = new();

    // Stats counters
    private long _audioPacketsSent;
    private long _audioPacketsReceived;
    private long _audioBytesSent;
    private long _audioBytesReceived;
    private long _audioDecodeErrors;

    public void SetBitrate(int bitrate)
    {
        _bitrate = bitrate;
        if (_encoder != null)
            _encoder.Bitrate = bitrate;
    }

    public void SetVoiceGate(float threshold)
        => _voiceGateThreshold = Math.Clamp(threshold, 0f, 100f);

    public void SetUserVolume(string username, float volume)
        => _userVolumes[username] = Math.Clamp(volume, 0f, 3f);

    public float GetUserVolume(string username)
        => _userVolumes.GetValueOrDefault(username, 1f);

    public void MuteUser(string username, bool muted)
        => _userMuted[username] = muted;

    public bool IsUserMuted(string username)
        => _userMuted.TryGetValue(username, out var m) && m;

    public void SetInputDevice(int deviceIndex) => _audio.SetInputDevice(deviceIndex);
    public void SetOutputDevice(int deviceIndex) => _audio.SetOutputDevice(deviceIndex);
    public List<string> GetInputDevices() => _audio.GetInputDevices();
    public List<string> GetOutputDevices() => _audio.GetOutputDevices();

    public async Task StartAsync(string host, int port = 5000, string username = "User")
    {
        _jitter.Reset();

        _udp = new UdpClient();
        _udp.Connect(host, port);

        var nonce = Guid.NewGuid().ToString("N");
        var hello = Encoding.UTF8.GetBytes($"HELLO:{nonce}:{username}");
        try
        {
            await _udp.SendAsync(hello, hello.Length);
            Console.WriteLine($"[Handshake] Sent HELLO to {host}:{port}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Handshake] send error: {ex.Message}");
        }

        _udp.Client.ReceiveBufferSize = 64 * 1024;
        _udp.Client.SendBufferSize = 64 * 1024;

        _encoder = OpusCodecFactory.CreateEncoder(SampleRate, 1, OpusApplication.OPUS_APPLICATION_VOIP);
        _encoder.Bitrate = _bitrate;
        _encoder.Complexity = 5;
        _encoder.UseVBR = true;
        _encoder.UseDTX = true;
        _encoder.UseInbandFEC = true;
        _encoder.PacketLossPercent = 5;
        _encoder.SignalType = OpusSignal.OPUS_SIGNAL_VOICE;
        _decoder = OpusCodecFactory.CreateDecoder(SampleRate, 1);

        try
        {
            _captureCallback = frame =>
            {
                try
                {
                    var udp = _udp;
                    var encoder = _encoder;
                    if (udp == null || encoder == null) return;

                    if (_voiceGateThreshold > 0)
                    {
                        double sum = 0;
                        for (int i = 0; i < frame.Length; i++)
                            sum += (double)frame[i] * frame[i];
                        double rms = Math.Sqrt(sum / frame.Length);
                        double level = rms / 32767.0 * 100.0;
                        if (level < _voiceGateThreshold)
                            return;
                    }

                    int len = encoder.Encode(frame.AsSpan(0, FrameSize), FrameSize, _encodeBuffer.AsSpan(), _encodeBuffer.Length);
                    udp.Send(_encodeBuffer, len);
                    Interlocked.Increment(ref _audioPacketsSent);
                    Interlocked.Add(ref _audioBytesSent, len);
                }
                catch (ObjectDisposedException) { }
                catch (Exception ex)
                {
                    Console.WriteLine($"[Send] ERROR: {ex.Message}");
                }
            };
            _audio.Start(_captureCallback);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Audio] Start failed: {ex.Message}");
        }

        _ = Task.Run(async () =>
        {
            while (true)
            {
                UdpReceiveResult res;
                try
                {
                    var udp = _udp;
                    if (udp == null) break;
                    res = await udp.ReceiveAsync();
                }
                catch (ObjectDisposedException) { break; }
                catch { continue; }

                // Handshake responses are plain text — check first
                if (HasPrefix(res.Buffer, WelcomePrefix))
                {
                    Console.WriteLine("[Handshake] Complete");
                    continue;
                }

                if (HasPrefix(res.Buffer, GoodbyePrefix))
                    continue;

                try
                {
                    // Tagged audio from server: [nameLen:1][name:N][opus data]
                    if (res.Buffer.Length < 3) continue;
                    int nameLen = res.Buffer[0];
                    if (nameLen <= 0 || nameLen > 64 || res.Buffer.Length < 1 + nameLen + 1)
                        continue;

                    // Validate name bytes are printable ASCII/UTF-8 (not binary Opus data misinterpreted)
                    bool validName = true;
                    for (int i = 1; i < 1 + nameLen; i++)
                    {
                        byte b = res.Buffer[i];
                        if (b < 0x20 && b != 0x09) { validName = false; break; }
                    }
                    if (!validName) continue;

                    var senderName = Encoding.UTF8.GetString(res.Buffer, 1, nameLen);
                    int opusOffset = 1 + nameLen;
                    int opusLen = res.Buffer.Length - opusOffset;

                    // Skip muted users entirely
                    if (_userMuted.TryGetValue(senderName, out var muted) && muted)
                        continue;

                    var decoder = _decoder;
                    if (decoder == null) continue;

                    decoder.Decode(new ReadOnlySpan<byte>(res.Buffer, opusOffset, opusLen), _decodeBuffer.AsSpan(), FrameSize, false);

                    // Apply per-user volume in-place on pooled buffer
                    float vol = _userVolumes.GetValueOrDefault(senderName, 1f);
                    if (vol != 1f)
                    {
                        for (int i = 0; i < FrameSize; i++)
                            _decodeBuffer[i] = (short)Math.Clamp((int)(_decodeBuffer[i] * vol), short.MinValue, short.MaxValue);
                    }

                    // Copy to jitter buffer (jitter buffer owns the array)
                    var frame = new short[FrameSize];
                    Array.Copy(_decodeBuffer, frame, FrameSize);

                    Interlocked.Increment(ref _audioPacketsReceived);
                    Interlocked.Add(ref _audioBytesReceived, opusLen);
                    _jitter.Add(frame);
                }
                catch (Exception ex)
                {
                    Interlocked.Increment(ref _audioDecodeErrors);
                    Console.WriteLine($"[Recv] decode error: {ex.Message}");
                }
            }
        });

        // Playback loop: ALWAYS feed the audio driver to prevent buffer underflows
        _ = Task.Run(async () =>
        {
            var silence = new short[FrameSize];
            while (await _playTimer.WaitForNextTickAsync())
            {
                var frame = _jitter.GetNextFrame();
                _audio.Play(frame ?? silence);
            }
        });
    }

    public void Stop()
    {
        try
        {
            if (_udp != null)
            {
                try
                {
                    var goodbye = Encoding.UTF8.GetBytes("GOODBYE");
                    _udp.Send(goodbye, goodbye.Length);
                }
                catch { }
            }
        }
        catch { }

        _audio.Stop();
        _jitter.Reset();

        _encoder = null;
        _decoder = null;

        try { _udp?.Dispose(); }
        catch { }
        finally { _udp = null; }
    }

    public void RestartAudioDevices()
    {
        if (_udp == null || _captureCallback == null) return;
        try
        {
            _audio.Stop();
            _audio.Start(_captureCallback);
            Console.WriteLine("[Audio] Devices restarted");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Audio] Restart failed: {ex.Message}");
        }
    }

    public (long PacketsSent, long PacketsReceived, long BytesSent, long BytesReceived, long DecodeErrors) GetVoiceStats()
        => (Interlocked.Read(ref _audioPacketsSent),
            Interlocked.Read(ref _audioPacketsReceived),
            Interlocked.Read(ref _audioBytesSent),
            Interlocked.Read(ref _audioBytesReceived),
            Interlocked.Read(ref _audioDecodeErrors));

    private static bool HasPrefix(byte[] data, byte[] prefix)
    {
        if (data.Length < prefix.Length) return false;
        return data.AsSpan(0, prefix.Length).SequenceEqual(prefix);
    }
}