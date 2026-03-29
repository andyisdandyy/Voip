using System.Diagnostics;

/// <summary>
/// Server-side video transcoding via FFmpeg.
/// Converts HEVC/H.265 video files to H.264/MP4 so all Electron clients
/// can play them inline without requiring OS-level HEVC decoder support.
/// </summary>
public static class VideoTranscoder
{
    /// <summary>
    /// MIME types that should be checked for HEVC content and potentially transcoded.
    /// </summary>
    private static readonly HashSet<string> _videoMimes = new(StringComparer.OrdinalIgnoreCase)
    {
        "video/mp4", "video/quicktime", "video/x-matroska", "video/webm",
        "video/x-m4v", "video/3gpp", "video/3gpp2",
    };

    /// <summary>
    /// Probes a video file to check if it uses HEVC (H.265) codec.
    /// Returns true if the video should be transcoded.
    /// </summary>
    private static async Task<bool> IsHevcAsync(string ffmpegPath, string filePath)
    {
        // Use ffprobe (same directory as ffmpeg) to check the codec
        var ffprobePath = Path.Combine(Path.GetDirectoryName(ffmpegPath) ?? "", "ffprobe");
        if (OperatingSystem.IsWindows())
            ffprobePath += ".exe";

        // Fall back to bare "ffprobe" if directory-based path doesn't exist
        if (!File.Exists(ffprobePath))
            ffprobePath = "ffprobe";

        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = ffprobePath,
                Arguments = $"-v quiet -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 \"{filePath}\"",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            process.Start();
            var output = await process.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
            await process.WaitForExitAsync().ConfigureAwait(false);

            var codec = output.Trim().ToLowerInvariant();
            return codec is "hevc" or "h265";
        }
        catch
        {
            // If ffprobe fails, assume it might be HEVC and try transcoding anyway
            return true;
        }
    }

    /// <summary>
    /// Attempts to transcode a video file from HEVC to H.264/MP4.
    /// Returns the transcoded base64 data and "video/mp4" mime type,
    /// or null if transcoding is not needed, not configured, or fails.
    /// </summary>
    public static async Task<(string base64, string mimeType, string fileName)?> TryTranscodeAsync(
        string? ffmpegPath, string fileName, string mimeType, string base64Data, Action<string>? log)
    {
        // Skip if FFmpeg not configured
        if (string.IsNullOrWhiteSpace(ffmpegPath))
            return null;

        // Skip non-video files
        if (!mimeType.StartsWith("video/", StringComparison.OrdinalIgnoreCase))
            return null;

        // Skip if not a known video MIME type
        if (!_videoMimes.Contains(mimeType))
            return null;

        string? tempDir = null;
        try
        {
            // Decode base64 to temp file
            tempDir = Path.Combine(Path.GetTempPath(), "echo-transcode-" + Guid.NewGuid().ToString("N")[..8]);
            Directory.CreateDirectory(tempDir);

            var ext = Path.GetExtension(fileName);
            if (string.IsNullOrEmpty(ext)) ext = ".mp4";
            var inputPath = Path.Combine(tempDir, "input" + ext);
            var outputPath = Path.Combine(tempDir, "output.mp4");

            var inputBytes = Convert.FromBase64String(base64Data);
            await File.WriteAllBytesAsync(inputPath, inputBytes).ConfigureAwait(false);

            // Check if the file actually uses HEVC
            if (!await IsHevcAsync(ffmpegPath, inputPath).ConfigureAwait(false))
            {
                log?.Invoke("[Transcode] Video is not HEVC — skipping transcode");
                return null;
            }

            log?.Invoke($"[Transcode] HEVC detected in '{fileName}' ({inputBytes.Length / 1024}KB), transcoding to H.264...");

            // Transcode: HEVC → H.264, copy audio, fast preset, MP4 output
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = ffmpegPath,
                Arguments = $"-i \"{inputPath}\" -c:v libx264 -preset fast -crf 23 -c:a aac -movflags +faststart -y \"{outputPath}\"",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            process.Start();

            // Read stderr (FFmpeg writes progress there)
            var stderr = await process.StandardError.ReadToEndAsync().ConfigureAwait(false);
            await process.WaitForExitAsync().ConfigureAwait(false);

            if (process.ExitCode != 0)
            {
                log?.Invoke($"[Transcode] FFmpeg failed (exit {process.ExitCode}): {stderr[..Math.Min(stderr.Length, 200)]}");
                return null;
            }

            if (!File.Exists(outputPath))
            {
                log?.Invoke("[Transcode] FFmpeg produced no output file");
                return null;
            }

            var outputBytes = await File.ReadAllBytesAsync(outputPath).ConfigureAwait(false);
            var outputBase64 = Convert.ToBase64String(outputBytes);

            // Update filename extension to .mp4
            var newFileName = Path.GetFileNameWithoutExtension(fileName) + ".mp4";

            log?.Invoke($"[Transcode] Done: {inputBytes.Length / 1024}KB → {outputBytes.Length / 1024}KB ({newFileName})");

            return (outputBase64, "video/mp4", newFileName);
        }
        catch (Exception ex)
        {
            log?.Invoke($"[Transcode] Error: {ex.Message}");
            return null;
        }
        finally
        {
            // Clean up temp files
            if (tempDir != null)
            {
                try { Directory.Delete(tempDir, true); } catch { }
            }
        }
    }
}
