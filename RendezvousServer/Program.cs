using System.Threading.Channels;

var exeDir = Path.GetDirectoryName(Environment.ProcessPath) ?? Environment.CurrentDirectory;
Console.WriteLine("Echo Rendezvous Server v2 starting...");
Console.WriteLine($"Data directory: {exeDir}");

var config = RendezvousConfig.Load(Path.Combine(exeDir, "rendezvous-config.json"));

var db = new RendezvousDb(Path.Combine(exeDir, "rendezvous.db"));
db.MigrateFromJson(
    Path.Combine(exeDir, "rendezvous-users.json"),
    Path.Combine(exeDir, "rendezvous-mailbox.json"),
    Path.Combine(exeDir, "rendezvous-friends.json"),
    msg => Console.WriteLine(msg));

var userRegistry = new UserRegistry(db);
var presence = new PresenceTracker();
var mailbox = new OfflineMailbox(db, config.MessageTtlDays);
var friends = new FriendStore(db);

var logChannel = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
_ = Task.Run(async () =>
{
    try
    {
        var logDir = Path.Combine(exeDir, "logs");
        Directory.CreateDirectory(logDir);
        var path = Path.Combine(logDir, "rendezvous_debug.txt");
        using var sw = new StreamWriter(path, append: true) { AutoFlush = true };
        await foreach (var line in logChannel.Reader.ReadAllAsync())
            await sw.WriteLineAsync($"{DateTime.UtcNow:O} {line}");
    }
    catch (Exception ex) { Console.WriteLine($"Logger error: {ex}"); }
});

void Log(string message)
{
    Console.WriteLine(message);
    _ = logChannel.Writer.WriteAsync(message);
}

var purged = mailbox.CleanupExpired();
if (purged > 0) Log($"[Rendezvous] Startup cleanup: purged {purged} expired messages");

Log($"[Rendezvous] Server '{config.ServerName}' starting on port {config.Port}");
Log($"[Rendezvous] Message TTL: {config.MessageTtlDays} days | Rate limit: {config.RateLimitMessages} msgs/{config.RateLimitWindowSeconds}s");
Log($"[Rendezvous] Bind: {(config.BindLocalhost ? "127.0.0.1 (proxy mode)" : "0.0.0.0")}");

var server = new RendezvousHttpServer(config, userRegistry, presence, mailbox, friends, Log);
await server.StartAsync(CancellationToken.None);