using System.Text.Json;

public static class Phase5SelfTests
{
    public static int RunAll()
    {
        try
        {
            TestReplyMetadataAcrossRoomRenameDelete();
            TestInviteExpiryAndUseLimits();
            TestSearchPaginationStability();
            Console.WriteLine("[SelfTest] All phase 5 regression tests passed.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SelfTest] FAILED: {ex.Message}");
            return 1;
        }
    }

    private static void TestReplyMetadataAcrossRoomRenameDelete()
    {
        var dir = Path.Combine(Path.GetTempPath(), "echo-selftest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var db = Path.Combine(dir, "chat_history.db");
        var store = new ChatHistoryStore(db);

        var parentId = store.AddMessage("general", "alice", "parent");
        _ = store.AddMessage("general", "bob", "reply", parentId);

        var before = store.GetHistory("general");
        Require(before.Count == 2, "reply test: expected 2 messages before rename");
        var replyBefore = before.Last();
        Require(replyBefore.ReplyToMessageId == parentId, "reply test: expected reply_to_msg_id before rename");

        store.RenameRoom("general", "town-square");
        var afterRename = store.GetHistory("town-square");
        Require(afterRename.Count == 2, "reply test: expected 2 messages after rename");
        var replyAfterRename = afterRename.Last();
        Require(replyAfterRename.ReplyToMessageId == parentId, "reply test: expected reply_to_msg_id after rename");

        store.DeleteRoom("town-square");
        var afterDelete = store.GetHistory("town-square");
        Require(afterDelete.Count == 0, "reply test: expected empty history after delete");
    }

    private static void TestInviteExpiryAndUseLimits()
    {
        var dir = Path.Combine(Path.GetTempPath(), "echo-selftest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var invitesPath = Path.Combine(dir, "invites.json");
        var store = new InviteStore(invitesPath);

        var twoUse = store.CreateInvite("admin", 2, null);
        var r1 = store.UseInviteIf(twoUse.Token, () => (true, string.Empty));
        var r2 = store.UseInviteIf(twoUse.Token, () => (true, string.Empty));
        var r3 = store.UseInviteIf(twoUse.Token, () => (true, string.Empty));
        Require(r1.success && r2.success, "invite test: expected first two uses to succeed");
        Require(!r3.success, "invite test: expected third use to fail for exhausted invite");

        var expiredIso = DateTime.UtcNow.AddMinutes(-1).ToString("O");
        var expired = store.CreateInvite("admin", 1, expiredIso);
        var ex = store.UseInviteIf(expired.Token, () => (true, string.Empty));
        Require(!ex.success, "invite test: expected expired invite to fail");

        // Legacy migration shape: {Token, CreatedBy, CreatedAt} defaults to one-time behavior.
        var legacyJson = JsonSerializer.Serialize(new[]
        {
            new { Token = "legacy1", CreatedBy = "admin", CreatedAt = DateTime.UtcNow.ToString("O") }
        });
        File.WriteAllText(invitesPath, legacyJson);
        var legacyStore = new InviteStore(invitesPath);
        var okLegacy = legacyStore.UseInviteIf("legacy1", () => (true, string.Empty));
        var failLegacy = legacyStore.UseInviteIf("legacy1", () => (true, string.Empty));
        Require(okLegacy.success && !failLegacy.success, "invite test: legacy invite should behave one-time");
    }

    private static void TestSearchPaginationStability()
    {
        var dir = Path.Combine(Path.GetTempPath(), "echo-selftest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var db = Path.Combine(dir, "chat_history.db");
        var store = new ChatHistoryStore(db);

        for (int i = 0; i < 83; i++)
            _ = store.AddMessage("search-room", "bot", $"needle {i}");

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? cursor = null;
        int loops = 0;
        while (true)
        {
            loops++;
            Require(loops < 20, "search test: pagination loop exceeded safety limit");

            var (messages, nextCursor) = store.SearchMessages("search-room", "needle", 25, cursor);
            foreach (var m in messages)
                Require(seen.Add(m.Id), "search test: duplicate message encountered across pages");

            if (string.IsNullOrWhiteSpace(nextCursor)) break;
            cursor = nextCursor;
        }

        Require(seen.Count == 83, $"search test: expected 83 unique results, got {seen.Count}");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
