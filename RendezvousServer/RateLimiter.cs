using System.Collections.Concurrent;

/// <summary>
/// Per-user sliding window rate limiter.
/// Tracks action timestamps per user and rejects requests that exceed the configured rate.
/// Uses a simple sliding window algorithm with automatic cleanup of expired entries.
/// </summary>
public class RateLimiter
{
    private readonly int _maxActions;
    private readonly TimeSpan _window;
    private readonly ConcurrentDictionary<string, Queue<DateTime>> _buckets =
        new(StringComparer.OrdinalIgnoreCase);

    /// <param name="maxActions">Maximum number of actions allowed within the window.</param>
    /// <param name="window">Sliding window duration.</param>
    public RateLimiter(int maxActions, TimeSpan window)
    {
        _maxActions = maxActions;
        _window = window;
    }

    /// <summary>
    /// Checks whether the user is allowed to perform an action.
    /// Returns true if allowed (and records the action), false if rate-limited.
    /// </summary>
    public bool TryAcquire(string username)
    {
        var now = DateTime.UtcNow;
        var queue = _buckets.GetOrAdd(username, _ => new Queue<DateTime>());

        lock (queue)
        {
            // Purge expired entries
            while (queue.Count > 0 && now - queue.Peek() > _window)
                queue.Dequeue();

            if (queue.Count >= _maxActions)
                return false;

            queue.Enqueue(now);
            return true;
        }
    }

    /// <summary>Removes all rate-limit state (e.g. when a user disconnects).</summary>
    public void Reset(string username) =>
        _buckets.TryRemove(username, out _);
}
