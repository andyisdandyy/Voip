using System.Collections.Concurrent;

namespace VoipEngine;

internal class JitterBuffer
{
    private readonly ConcurrentQueue<short[]> _queue = new();
    private const int MinBuffer = 3;   // build up 60ms before starting playback
    private const int MaxBuffer = 10;  // 200ms max — drop oldest if exceeded
    private bool _started;
    private short[]? _lastFrame;

    public void Add(short[] pcm)
    {
        _queue.Enqueue(pcm);

        // Drop oldest frames if we're too far behind
        while (_queue.Count > MaxBuffer)
            _queue.TryDequeue(out _);
    }

    public short[]? GetNextFrame()
    {
        // Wait until we've buffered enough frames to absorb jitter
        if (!_started)
        {
            if (_queue.Count < MinBuffer)
                return null;
            _started = true;
        }

        if (_queue.TryDequeue(out var frame))
        {
            _lastFrame = frame;
            return frame;
        }

        // Underrun: fade out last frame to avoid a hard pop
        if (_lastFrame != null)
        {
            var fade = new short[_lastFrame.Length];
            for (int i = 0; i < fade.Length; i++)
                fade[i] = (short)(_lastFrame[i] * 0.3);
            _lastFrame = null;
            return fade;
        }

        return null;
    }

    public void Reset()
    {
        while (_queue.TryDequeue(out _)) { }
        _started = false;
        _lastFrame = null;
    }
}