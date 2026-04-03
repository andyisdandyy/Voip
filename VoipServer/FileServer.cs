using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

/// <summary>
/// HTTP file server for video uploads and downloads.
/// Accepts multipart file uploads from authenticated clients, stores files on disk,
/// optionally transcodes HEVC → H.264 via FFmpeg, and serves files by ID.
/// Authentication uses the same HMAC-SHA256 tokens as <see cref="NotificationServer"/>.
/// </summary>
public class FileServer
{
    private readonly HttpListener _listener;
    private readonly Action<string>? _log;
    private readonly string _storageDir;
    private readonly ServerConfig _serverConfig;
    private readonly Func<string, string?> _validateToken;

    /// <summary>File metadata: fileId → { fileName, mimeType, diskPath, ready }.</summary>
    private readonly ConcurrentDictionary<string, FileMeta> _files = new();

    private record FileMeta(string FileName, string MimeType, string DiskPath, bool Ready);

    public FileServer(int port, bool bindLocalhost, string storageDir, ServerConfig serverConfig, Func<string, string?> validateToken, Action<string>? log = null)
    {
        _log = log;
        _storageDir = storageDir;
        _serverConfig = serverConfig;
        _validateToken = validateToken;
        _listener = new HttpListener();
        var host = bindLocalhost ? "127.0.0.1" : "+";
        _listener.Prefixes.Add($"http://{host}:{port}/");

        Directory.CreateDirectory(storageDir);
    }

    public async Task StartAsync(CancellationToken ct = default)
    {
        _listener.Start();
        _log?.Invoke($"[FileServer] Listening on {_listener.Prefixes.First()}");

        using var stopRegistration = ct.Register(() =>
        {
            try { _listener.Stop(); } catch { }
        });

        // Periodic cleanup of old files (every hour, remove files older than 24h)
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try { await Task.Delay(TimeSpan.FromHours(1), ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }

                CleanupOldFiles(TimeSpan.FromHours(24));
            }
        }, ct);

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var context = await _listener.GetContextAsync().ConfigureAwait(false);
                _ = HandleRequestAsync(context);
            }
        }
        catch (HttpListenerException) when (ct.IsCancellationRequested) { }
        catch (ObjectDisposedException) { }
        finally
        {
            try { _listener.Stop(); } catch { }
        }
    }

    private async Task HandleRequestAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;

        // CORS headers for Electron renderer
        response.Headers.Add("Access-Control-Allow-Origin", "*");
        response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.Headers.Add("Access-Control-Allow-Headers", "Authorization, Content-Type");

        if (request.HttpMethod == "OPTIONS")
        {
            response.StatusCode = 204;
            response.Close();
            return;
        }

        var path = request.Url?.AbsolutePath ?? "";

        if (request.HttpMethod == "POST" && string.Equals(path, "/upload", StringComparison.Ordinal))
        {
            await HandleUploadAsync(request, response).ConfigureAwait(false);
            return;
        }

        if (request.HttpMethod == "GET" && path.StartsWith("/file/", StringComparison.Ordinal))
        {
            await HandleDownloadAsync(path, request, response).ConfigureAwait(false);
            return;
        }

        response.StatusCode = 404;
        response.Close();
    }

    private async Task HandleUploadAsync(HttpListenerRequest request, HttpListenerResponse response)
    {
        // Validate auth token
        var token = request.QueryString["token"];
        if (string.IsNullOrEmpty(token))
        {
            var authHeader = request.Headers["Authorization"];
            if (authHeader?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) == true)
                token = authHeader["Bearer ".Length..];
        }

        if (string.IsNullOrEmpty(token))
        {
            response.StatusCode = 401;
            await WriteJsonAsync(response, new { error = "Missing token" }).ConfigureAwait(false);
            return;
        }

        var username = _validateToken(token);
        if (username == null)
        {
            response.StatusCode = 403;
            await WriteJsonAsync(response, new { error = "Invalid token" }).ConfigureAwait(false);
            return;
        }

        // Read the raw body (binary file data)
        var fileName = request.QueryString["name"] ?? "file";
        var mimeType = request.ContentType ?? "application/octet-stream";

        // Enforce size limit
        var maxBytes = (long)_serverConfig.MaxFileSizeKB * 1024;
        if (request.ContentLength64 > maxBytes)
        {
            response.StatusCode = 413;
            await WriteJsonAsync(response, new { error = $"File too large (max {_serverConfig.MaxFileSizeKB} KB)" }).ConfigureAwait(false);
            return;
        }

        // Generate a unique file ID
        var fileId = Guid.NewGuid().ToString("N")[..16];
        var ext = Path.GetExtension(fileName);
        if (string.IsNullOrEmpty(ext)) ext = ".bin";
        var diskPath = Path.Combine(_storageDir, fileId + ext);

        try
        {
            // Stream the upload directly to disk
            using (var fs = new FileStream(diskPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            {
                var buffer = new byte[81920];
                long totalRead = 0;
                int bytesRead;
                while ((bytesRead = await request.InputStream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
                {
                    totalRead += bytesRead;
                    if (totalRead > maxBytes)
                    {
                        // Abort — file exceeded limit mid-stream
                        fs.Close();
                        try { File.Delete(diskPath); } catch { }
                        response.StatusCode = 413;
                        await WriteJsonAsync(response, new { error = $"File too large (max {_serverConfig.MaxFileSizeKB} KB)" }).ConfigureAwait(false);
                        return;
                    }
                    await fs.WriteAsync(buffer.AsMemory(0, bytesRead)).ConfigureAwait(false);
                }
            }

            // Register file as ready immediately (original)
            _files[fileId] = new FileMeta(fileName, mimeType, diskPath, true);
            _log?.Invoke($"[FileServer] '{username}' uploaded '{fileName}' ({new FileInfo(diskPath).Length / 1024}KB) → {fileId}");

            // Return file ID to the client
            response.StatusCode = 200;
            await WriteJsonAsync(response, new { fileId, fileName, mimeType }).ConfigureAwait(false);

            // Async transcode if HEVC video (non-blocking — replaces file on disk when done)
            if (mimeType.StartsWith("video/", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(_serverConfig.FfmpegPath))
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await TranscodeFileOnDiskAsync(fileId, diskPath, fileName, mimeType).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        _log?.Invoke($"[FileServer] Transcode error for {fileId}: {ex.Message}");
                    }
                });
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"[FileServer] Upload error: {ex.Message}");
            try { File.Delete(diskPath); } catch { }
            response.StatusCode = 500;
            await WriteJsonAsync(response, new { error = "Upload failed" }).ConfigureAwait(false);
        }
    }

    private async Task TranscodeFileOnDiskAsync(string fileId, string originalPath, string fileName, string mimeType)
    {
        // Read the file as base64 for the existing VideoTranscoder
        var bytes = await File.ReadAllBytesAsync(originalPath).ConfigureAwait(false);
        var base64 = Convert.ToBase64String(bytes);

        var result = await VideoTranscoder.TryTranscodeAsync(
            _serverConfig.FfmpegPath, fileName, mimeType, base64, _log).ConfigureAwait(false);

        if (result == null) return; // Not HEVC or transcode not needed

        // Write the transcoded file to disk, replacing the original
        var transcodedBytes = Convert.FromBase64String(result.Value.base64);
        var newExt = Path.GetExtension(result.Value.fileName);
        var newPath = Path.Combine(_storageDir, fileId + newExt);

        await File.WriteAllBytesAsync(newPath, transcodedBytes).ConfigureAwait(false);

        // Remove old file if extension changed (treat path casing as equal on Windows)
        var pathComparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!string.Equals(newPath, originalPath, pathComparison))
            try { File.Delete(originalPath); } catch { }

        // Update metadata
        _files[fileId] = new FileMeta(result.Value.fileName, result.Value.mimeType, newPath, true);
        _log?.Invoke($"[FileServer] Transcoded {fileId}: {fileName} → {result.Value.fileName} ({transcodedBytes.Length / 1024}KB)");
    }

    private async Task HandleDownloadAsync(string path, HttpListenerRequest request, HttpListenerResponse response)
    {
        var fileId = path["/file/".Length..].Split('/')[0].Split('?')[0];

        if (!_files.TryGetValue(fileId, out var meta) || !meta.Ready || !File.Exists(meta.DiskPath))
        {
            response.StatusCode = 404;
            await WriteJsonAsync(response, new { error = "File not found" }).ConfigureAwait(false);
            return;
        }

        response.ContentType = meta.MimeType;
        response.Headers.Add("Content-Disposition", $"attachment; filename=\"{meta.FileName}\"");

        var fileInfo = new FileInfo(meta.DiskPath);
        response.ContentLength64 = fileInfo.Length;

        try
        {
            using var fs = new FileStream(meta.DiskPath, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, useAsync: true);
            await fs.CopyToAsync(response.OutputStream).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"[FileServer] Download error for {fileId}: {ex.Message}");
        }
        finally
        {
            try { response.Close(); } catch { }
        }
    }

    private void CleanupOldFiles(TimeSpan maxAge)
    {
        var cutoff = DateTime.UtcNow - maxAge;
        foreach (var kv in _files)
        {
            try
            {
                if (File.Exists(kv.Value.DiskPath))
                {
                    var created = File.GetCreationTimeUtc(kv.Value.DiskPath);
                    if (created < cutoff)
                    {
                        File.Delete(kv.Value.DiskPath);
                        _files.TryRemove(kv.Key, out _);
                        _log?.Invoke($"[FileServer] Cleaned up old file {kv.Key}");
                    }
                }
                else
                {
                    _files.TryRemove(kv.Key, out _);
                }
            }
            catch { }
        }
    }

    private static async Task WriteJsonAsync(HttpListenerResponse response, object data)
    {
        response.ContentType = "application/json";
        var json = JsonSerializer.Serialize(data);
        var bytes = Encoding.UTF8.GetBytes(json);
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
        response.Close();
    }
}
