# Fix: Image Loading Lag on Server Join

## Problem

When joining a server, the client freezes for ~30 seconds when a text channel contains high-resolution images (e.g., 4K). The root cause is that images are stored as inline base64 in the message database and the full base64 data is included in the HISTORY response sent over TCP when the user auto-joins the first text channel.

### Impact Chain

1. **Server auto-joins first text channel** after auth (`ChatServer.cs:320-328`)
2. **`SendHistoryAsync` sends last 50 messages** including `__FILE__:<name>:<mime>:<10-30MB_base64>` (`ChatServer.cs:1588-1609`)
3. **O(n^2) TCP buffer parsing** in `main.js:937-939` — each TCP chunk re-scans the entire growing buffer via `split('\n')`
4. **Synchronous `JSON.parse`** in `terminal-forum.tsx:1817` blocks the renderer
5. **Massive IPC serialization** of 10+ MB strings across Electron process boundary

## Solution Overview

- Add capability negotiation (`CAPS:LAZY_FILES`) so old clients still get full inline data
- Strip base64 from HISTORY for capable clients, replace with `__LAZY__` placeholder
- Add `CMD:FETCH_FILE` for on-demand file retrieval
- Fix O(n^2) TCP buffer parsing
- Client-side lazy loading + Blob URL caching for E2EE

---

## Changes

### 1. Server: Capability Negotiation

**File: `VoipServer/ChatServer.cs`**

Add a per-client capabilities dictionary:

```csharp
// After line 59 (_clients dict)
private readonly ConcurrentDictionary<TcpClient, HashSet<string>> _clientCaps = new();
private const string CapLazyFiles = "LAZY_FILES";
```

Modify auth Phase 2 (line 176) to accept CAPS lines before the auth line:

```csharp
// Replace single ReadLineAsync with a loop
var clientCaps = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
string? authLine = null;
while (true)
{
    var capOrAuth = (await reader.ReadLineAsync().ConfigureAwait(false))?.Trim();
    if (string.IsNullOrEmpty(capOrAuth)) return;
    if (capOrAuth.StartsWith("CAPS:", StringComparison.Ordinal))
    {
        foreach (var cap in capOrAuth.Substring(5).Split(','))
        {
            var c = cap.Trim();
            if (c.Length > 0) clientCaps.Add(c);
        }
        continue;
    }
    authLine = capOrAuth;
    break;
}
```

After `_clients[client] = (writer, name)` (line 298), store caps:

```csharp
_clientCaps[client] = clientCaps;
```

In the `finally` cleanup block (after line 377), also clean up caps:

```csharp
_clientCaps.TryRemove(client, out _);
```

### 2. Server: Strip base64 from HISTORY

**File: `VoipServer/ChatServer.cs`**

Add a helper method to strip inline file data:

```csharp
/// <summary>
/// For clients with LAZY_FILES capability, replaces inline base64 file data
/// in message text with a __LAZY__ placeholder to keep HISTORY payloads small.
/// </summary>
private static List<ChatMessage> StripInlineFileData(List<ChatMessage> messages)
{
    for (int i = 0; i < messages.Count; i++)
    {
        var text = messages[i].Text;
        if (text.StartsWith("__FILE__:", StringComparison.Ordinal))
        {
            // Format: __FILE__:<name>:<mime>:<base64data>
            // Replace base64data with __LAZY__
            var firstColon = text.IndexOf(':', 9);  // after "__FILE__:"
            if (firstColon >= 0)
            {
                var secondColon = text.IndexOf(':', firstColon + 1);
                if (secondColon >= 0)
                {
                    // Keep __FILE__:<name>:<mime>: and replace data with __LAZY__
                    messages[i] = new ChatMessage
                    {
                        Id = messages[i].Id,
                        User = messages[i].User,
                        Text = text.Substring(0, secondColon + 1) + "__LAZY__",
                        Time = messages[i].Time,
                        Edited = messages[i].Edited,
                        ReplyToMessageId = messages[i].ReplyToMessageId
                    };
                }
            }
        }
    }
    return messages;
}
```

Modify `SendHistoryAsync` (line 1588) to accept a `lazyFiles` parameter:

```csharp
private async Task SendHistoryAsync(StreamWriter writer, string roomName, bool lazyFiles = false)
{
    var history = _history.GetHistory(roomName, 50, null);
    if (history.Count > 0)
    {
        if (lazyFiles)
            history = StripInlineFileData(history);
        var total = _history.GetMessageCount(roomName);
        var hasMore = total > history.Count;
        var json = JsonSerializer.Serialize(history);
        await writer.WriteLineAsync($"HISTORY:{roomName}:{hasMore}:{json}").ConfigureAwait(false);
    }
    // ... reactions and pins unchanged
}
```

Update the call at line 326 (auto-join):

```csharp
var lazyFiles = clientCaps.Contains(CapLazyFiles);
// ... later ...
try { await SendHistoryAsync(writer, firstRoom.Name, lazyFiles).ConfigureAwait(false); }
```

Update the FETCH_HISTORY handler (line 601) to check client caps:

```csharp
else if (cmd.StartsWith("FETCH_HISTORY:"))
{
    var args = cmd.Substring("FETCH_HISTORY:".Length).Split(':', 3);
    if (args.Length >= 3)
    {
        var roomName = args[0];
        var beforeId = args[1];
        if (int.TryParse(args[2], out var count))
        {
            count = Math.Clamp(count, 1, 50);
            var older = _history.GetHistory(roomName, count, beforeId);
            var lazyFiles = _clientCaps.TryGetValue(client, out var caps) && caps.Contains(CapLazyFiles);
            if (lazyFiles)
                older = StripInlineFileData(older);
            var hasMore = older.Count > 0 && older.Count == count;
            var json = JsonSerializer.Serialize(older);
            await writer.WriteLineAsync($"HISTORY:{roomName}:{hasMore}:{json}").ConfigureAwait(false);
        }
    }
}
```

Note: The `HandleCommandAsync` needs access to the `TcpClient` — it already has it via the `client` parameter.

### 3. Server: Add FETCH_FILE command

**File: `VoipServer/ChatHistoryStore.cs`**

Add a `GetMessage` method to fetch a single message:

```csharp
/// <summary>
/// Returns a single message by room and ID, or null if not found.
/// </summary>
public ChatMessage? GetMessage(string room, string id)
{
    using var conn = Open();
    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT id, user, text, time, edited, reply_to_msg_id FROM messages WHERE room = $room AND id = $id LIMIT 1";
    cmd.Parameters.AddWithValue("$room", room);
    cmd.Parameters.AddWithValue("$id", id);
    var results = ReadMessages(cmd);
    return results.Count > 0 ? results[0] : null;
}
```

**File: `VoipServer/ChatServer.cs`**

Add the FETCH_FILE command handler in `HandleCommandAsync` (after the FETCH_HISTORY block around line 619):

```csharp
else if (cmd.StartsWith("FETCH_FILE:"))
{
    // FETCH_FILE:<room>:<messageId>
    var args = cmd.Substring("FETCH_FILE:".Length).Split(':', 2);
    if (args.Length >= 2)
    {
        var roomName = args[0];
        var msgId = args[1];
        if (!_rooms.IsInTextRoom(name, roomName))
        {
            await writer.WriteLineAsync("ERROR:Not in room").ConfigureAwait(false);
            return;
        }
        var msg = _history.GetMessage(roomName, msgId);
        if (msg != null && msg.Text.StartsWith("__FILE__:", StringComparison.Ordinal))
        {
            // Extract the base64 data portion: __FILE__:<name>:<mime>:<data>
            var fileText = msg.Text;
            var i1 = fileText.IndexOf(':', 9);  // after "__FILE__:"
            var i2 = i1 >= 0 ? fileText.IndexOf(':', i1 + 1) : -1;
            if (i2 >= 0)
            {
                var base64Data = fileText.Substring(i2 + 1);
                await writer.WriteLineAsync($"FILE_CONTENT:{msgId}:{base64Data}").ConfigureAwait(false);
            }
            else
            {
                await writer.WriteLineAsync($"FILE_CONTENT:{msgId}:NOT_FOUND").ConfigureAwait(false);
            }
        }
        else
        {
            await writer.WriteLineAsync($"FILE_CONTENT:{msgId}:NOT_FOUND").ConfigureAwait(false);
        }
    }
}
```

### 4. Client: Send CAPS during auth

**File: `VoipClient.Electron/electron/main.js`**

After `serverPwDone = true` (line 957), before sending the auth line, send CAPS:

```javascript
if (line === 'SERVER_PASSWORD_OK' || line === 'READY') {
    serverPwDone = true;
    // Send capabilities before auth
    sock.write('CAPS:LAZY_FILES\n');
    let authLine;
    // ... rest unchanged
```

### 5. Client: Handle __LAZY__ placeholders in renderMessageBody

**File: `VoipClient.Electron/src/components/terminal-forum.tsx`**

Add state for fetched file data (near other state declarations):

```typescript
const [fetchedFiles, setFetchedFiles] = useState<Record<string, string>>({});  // msgId → base64data
const fetchedFilesRef = useRef(fetchedFiles);
fetchedFilesRef.current = fetchedFiles;
const pendingFileFetches = useRef(new Set<string>());
```

In `renderMessageBody` (around line 3274), add handling for `__LAZY__` placeholder:

```typescript
// After: } else if (text.startsWith('__FILE__:')) {
// Detect __LAZY__ placeholder
const fileParts = text.substring(9).split(':');  // [name, mime, data_or_LAZY]
if (fileParts.length >= 3) {
    const [fName, fMime, ...rest] = fileParts;
    const fData = rest.join(':');

    if (fData === '__LAZY__') {
        // Lazy file — check if already fetched
        const cached = fetchedFilesRef.current[msgId];
        if (cached) {
            // Render the file with cached data
            const isImage = fMime.startsWith('image/');
            if (isImage) {
                return <img src={`data:${fMime};base64,${cached}`}
                    className="max-w-md max-h-80 rounded mt-1 cursor-pointer"
                    loading="lazy"
                    onClick={() => setLightboxSrc(`data:${fMime};base64,${cached}`)} />;
            }
            // ... handle video/audio/other similarly
        } else {
            // Return placeholder and trigger fetch via IntersectionObserver
            return <LazyFilePlaceholder
                msgId={msgId}
                room={currentTextRoom!}
                fileName={fName}
                mimeType={fMime}
                onVisible={() => {
                    if (!pendingFileFetches.current.has(msgId)) {
                        pendingFileFetches.current.add(msgId);
                        sendToServer(`CMD:FETCH_FILE:${currentTextRoom}:${msgId}`);
                    }
                }}
            />;
        }
    }
    // ... existing __FILE__ handling for non-lazy case
}
```

Create a `LazyFilePlaceholder` component:

```typescript
const LazyFilePlaceholder = React.memo(({ msgId, room, fileName, mimeType, onVisible }: {
    msgId: string; room: string; fileName: string; mimeType: string; onVisible: () => void;
}) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!ref.current) return;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                onVisible();
                observer.disconnect();
            }
        }, { threshold: 0.1 });
        observer.observe(ref.current);
        return () => observer.disconnect();
    }, [onVisible]);

    const isImage = mimeType.startsWith('image/');
    return (
        <div ref={ref} className="flex items-center gap-2 p-2 bg-zinc-800/50 rounded mt-1">
            <span className="text-zinc-400 text-sm">
                {isImage ? '🖼' : '📎'} {fileName}
            </span>
            <span className="text-zinc-500 text-xs">Loading...</span>
        </div>
    );
});
```

### 6. Client: Handle FILE_CONTENT responses

**File: `VoipClient.Electron/src/components/terminal-forum.tsx`**

In `handleServerMessage` (around line 1574), add a handler for `FILE_CONTENT:`:

```typescript
} else if (line.startsWith('FILE_CONTENT:')) {
    // FILE_CONTENT:<msgId>:<base64data>
    const i1 = line.indexOf(':', 13);  // after 'FILE_CONTENT:'
    if (i1 >= 0) {
        const msgId = line.substring(13, i1);
        const data = line.substring(i1 + 1);
        if (data !== 'NOT_FOUND') {
            setFetchedFiles(prev => ({ ...prev, [msgId]: data }));
            pendingFileFetches.current.delete(msgId);
        }
    }
}
```

### 7. Client: Fix O(n^2) TCP buffer parsing

**File: `VoipClient.Electron/electron/main.js` (lines 936-939)**

Replace:

```javascript
sock.on('data', (data) => {
    buffer += utf8Decoder.write(data);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
```

With:

```javascript
sock.on('data', (data) => {
    buffer += utf8Decoder.write(data);
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.substring(0, newlineIdx);
        buffer = buffer.substring(newlineIdx + 1);
        const line = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
        if (!line) continue;
```

Note: This is still O(n) per newline due to `substring`, but avoids the `split` on the entire buffer. For a further optimization, track a `searchStart` offset and batch-extract lines:

```javascript
sock.on('data', (data) => {
    buffer += utf8Decoder.write(data);
    let start = 0;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n', start)) !== -1) {
        const rawLine = buffer.substring(start, newlineIdx);
        start = newlineIdx + 1;
        const line = rawLine.replace(/^\uFEFF/, '').replace(/\r$/, '');
        if (!line) continue;
        // ... process line ...
    }
    if (start > 0) {
        buffer = buffer.substring(start);
    }
```

This avoids re-creating the buffer string on every extracted line. The `indexOf` only scans from `start`, and the buffer is trimmed once at the end.

### 8. Client: Upload ALL file types via FileServer when available

**File: `VoipClient.Electron/src/components/terminal-forum.tsx`**

At line 3793, change:

```typescript
// FROM:
if (fMime.startsWith('video/') && fileServerPort && serverHost && authToken) {
// TO:
if (fileServerPort && serverHost && authToken) {
```

Same change at line 5496 for DM file uploads.

### 9. Client: Add loading="lazy" to img tags + Blob URL caching

**File: `VoipClient.Electron/src/components/terminal-forum.tsx`**

For `__FILE_REF__` images (around line 3227), add `loading="lazy"`:

```typescript
<img src={fileUrl} ... loading="lazy" />
```

For inline `__FILE__` images (E2EE case, around line 3289), convert to Blob URL:

Add a `blobUrlCache` ref:
```typescript
const blobUrlCache = useRef(new Map<string, string>());
```

Helper to get/create blob URL:
```typescript
function getOrCreateBlobUrl(key: string, base64: string, mimeType: string): string {
    if (blobUrlCache.current.has(key)) return blobUrlCache.current.get(key)!;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    blobUrlCache.current.set(key, url);
    return url;
}
```

Use blob URLs instead of `data:` URLs for inline file images:
```typescript
// Instead of: src={`data:${fMime};base64,${fData}`}
// Use: src={getOrCreateBlobUrl(msgId, fData, fMime)}
```

---

## File Change Summary

| File | Lines Changed | Description |
|------|---------------|-------------|
| `VoipServer/ChatServer.cs` | ~59, ~176-178, ~298, ~320-327, ~377, ~601-618, ~1588-1609, new block after ~619 | Caps dict, auth loop, strip history, FETCH_FILE handler |
| `VoipServer/ChatHistoryStore.cs` | New method after ~229 | `GetMessage(room, id)` method |
| `VoipClient.Electron/electron/main.js` | ~936-939, ~957 | Buffer fix, CAPS:LAZY_FILES |
| `VoipClient.Electron/src/components/terminal-forum.tsx` | ~1574+, ~3274+, ~3793, ~5496 | FILE_CONTENT handler, lazy placeholders, upload routing |

## Testing

1. Start server, connect with new client → verify HISTORY contains `__LAZY__` placeholders
2. Scroll through messages with images → verify lazy fetch triggers and images render
3. Connect with old client (without CAPS) → verify full inline data is still sent
4. Send a large image → verify it's uploaded via FileServer when enabled, or inline when not
5. Test E2EE channels → verify encrypted inline files still work
6. Test the O(n^2) fix by monitoring CPU during large message transfer
