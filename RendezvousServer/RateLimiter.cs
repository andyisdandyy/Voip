using System.Collections.Concurrent;

/// <summary>
/// Per-user sliding-window rate limiter for message sends.
/// Thread-safe. Does not allocate timers — uses timestamp comparison instead.
/// </summary>
public class RateLimiter
{
    private readonly int _maxRequests;
    private readonly TimeSpan _window;
    private readonly ConcurrentDictionary<string, Queue<DateTime>> _buckets = new(StringComparer.OrdinalIgnoreCase);

    public RateLimiter(int maxRequests, TimeSpan window)
    {
        _maxRequests = maxRequests;
        _window = window;
    }

    /// <summary>
    /// Returns true and records the request if the user is within their rate limit.
    /// Returns false if the limit has been exceeded.
    /// </summary>
    public bool TryAcquire(string username)
    {
        var now = DateTime.UtcNow;
        var queue = _buckets.GetOrAdd(username, _ => new Queue<DateTime>());
        lock (queue)
        {
            // Evict timestamps outside the window
            while (queue.Count > 0 && now - queue.Peek() > _window)
                queue.Dequeue();

            if (queue.Count >= _maxRequests) return false;

            queue.Enqueue(now);
            return true;
        }
    }
}
