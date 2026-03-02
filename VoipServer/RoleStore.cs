using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// A named role with a color, priority, and set of permission strings.
/// </summary>
public class RoleDefinition
{
    public string Name { get; set; } = "";
    public string Color { get; set; } = "#22c55e";
    public int Priority { get; set; } = 0;
    public List<string> Permissions { get; set; } = new();
}

public class RoleStoreData
{
    public List<RoleDefinition> Roles { get; set; } = new();
    public Dictionary<string, List<string>> UserRoles { get; set; } = new();
}

/// <summary>
/// Manages role definitions and user-to-role assignments.
/// Default roles: Admin (priority 100, full permissions) and Member (priority 0, no permissions).
/// </summary>
public class RoleStore
{
    public static readonly string[] ALL_PERMISSIONS =
    {
        "admin",
        "manage_roles",
        "create_rooms",
        "delete_rooms",
        "reorder_rooms",
        "kick_users",
        "delete_messages",
        "pin_messages",
        "manage_soundboard",
        "manage_emojis",
        "server_settings",
    };

    private RoleStoreData _data;
    private readonly string _path;
    private readonly object _lock = new();

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public RoleStore(string? path = null)
    {
        _path = path ?? Path.Combine(AppContext.BaseDirectory, "roles.json");
        _data = Load();
    }

    // ── Queries ──────────────────────────────────────────────

    public List<RoleDefinition> GetRoles() { lock (_lock) return _data.Roles.ToList(); }

    public RoleDefinition? GetRole(string roleName)
    {
        lock (_lock) return GetRoleUnsafe(roleName);
    }

    public List<string> GetUserRoleNames(string username)
    {
        lock (_lock)
            return _data.UserRoles.TryGetValue(username, out var roles) ? roles.ToList() : [];
    }

    public RoleDefinition? GetHighestRole(string username)
    {
        lock (_lock)
        {
            if (!_data.UserRoles.TryGetValue(username, out var roleNames) || roleNames.Count == 0)
                return null;
            return _data.Roles
                .Where(r => roleNames.Contains(r.Name, StringComparer.OrdinalIgnoreCase))
                .MaxBy(r => r.Priority);
        }
    }

    public bool HasPermission(string username, string permission)
    {
        lock (_lock)
        {
            if (!_data.UserRoles.TryGetValue(username, out var roleNames) || roleNames.Count == 0)
                return false;
            foreach (var role in _data.Roles)
            {
                if (roleNames.Contains(role.Name, StringComparer.OrdinalIgnoreCase) &&
                    (role.Permissions.Contains("admin") || role.Permissions.Contains(permission)))
                    return true;
            }
            return false;
        }
    }

    // ── Mutations ────────────────────────────────────────────

    public bool AssignRole(string username, string roleName)
    {
        lock (_lock)
        {
            if (GetRoleUnsafe(roleName) == null) return false;
            var roles = GetOrCreateUserRoles(username);
            if (roles.Contains(roleName, StringComparer.OrdinalIgnoreCase))
                return false;
            roles.Add(roleName);
            SaveUnsafe();
            return true;
        }
    }

    public bool RemoveRole(string username, string roleName)
    {
        lock (_lock)
        {
            if (!_data.UserRoles.TryGetValue(username, out var roles)) return false;
            var removed = roles.RemoveAll(r =>
                string.Equals(r, roleName, StringComparison.OrdinalIgnoreCase)) > 0;
            if (removed) SaveUnsafe();
            return removed;
        }
    }

    public bool CreateRole(string name, string color, int priority, List<string> permissions)
    {
        lock (_lock)
        {
            if (GetRoleUnsafe(name) != null) return false;
            _data.Roles.Add(new RoleDefinition
            {
                Name = name,
                Color = color,
                Priority = priority,
                Permissions = permissions,
            });
            SaveUnsafe();
            return true;
        }
    }

    public bool DeleteRole(string name)
    {
        lock (_lock)
        {
            if (string.Equals(name, "Admin", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, "Member", StringComparison.OrdinalIgnoreCase))
                return false;

            var removed = _data.Roles.RemoveAll(r =>
                string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase)) > 0;
            if (removed)
            {
                foreach (var kv in _data.UserRoles)
                    kv.Value.RemoveAll(r => string.Equals(r, name, StringComparison.OrdinalIgnoreCase));
                SaveUnsafe();
            }
            return removed;
        }
    }

    /// <summary>Ensure user has at least the Member role. Returns true if Admin was auto-assigned (first user).</summary>
    public bool EnsureDefaultRole(string username, bool isFirstUser)
    {
        lock (_lock)
        {
            var roles = GetOrCreateUserRoles(username);

            bool assignedAdmin = false;
            if (isFirstUser && !_data.UserRoles.Values.Any(r => r.Contains("Admin", StringComparer.OrdinalIgnoreCase)))
            {
                roles.Add("Admin");
                assignedAdmin = true;
            }

            if (!roles.Contains("Member", StringComparer.OrdinalIgnoreCase))
                roles.Add("Member");

            SaveUnsafe();
            return assignedAdmin;
        }
    }

    // ── Internal helpers (must be called under _lock) ────────

    private RoleDefinition? GetRoleUnsafe(string roleName) =>
        _data.Roles.FirstOrDefault(r => string.Equals(r.Name, roleName, StringComparison.OrdinalIgnoreCase));

    private List<string> GetOrCreateUserRoles(string username) =>
        _data.UserRoles.TryGetValue(username, out var roles)
            ? roles
            : _data.UserRoles[username] = [];

    // ── Persistence ──────────────────────────────────────────

    private RoleStoreData Load()
    {
        try
        {
            if (!File.Exists(_path))
            {
                var def = CreateDefault();
                try { File.WriteAllText(_path, JsonSerializer.Serialize(def, _jsonOpts)); }
                catch (Exception ex) { Console.WriteLine($"WARNING: Could not write default {_path}: {ex.Message}"); }
                return def;
            }
            var json = File.ReadAllText(_path);
            return JsonSerializer.Deserialize<RoleStoreData>(json, _jsonOpts) ?? CreateDefault();
        }
        catch
        {
            return CreateDefault();
        }
    }

    private void SaveUnsafe()
    {
        try
        {
            var json = JsonSerializer.Serialize(_data, _jsonOpts);
            File.WriteAllText(_path, json);
        }
        catch { }
    }

    private static RoleStoreData CreateDefault() => new()
    {
        Roles = new List<RoleDefinition>
        {
            new()
            {
                Name = "Admin",
                Color = "#ef4444",
                Priority = 100,
                Permissions = new List<string> { "admin" },
            },
            new()
            {
                Name = "Member",
                Color = "#22c55e",
                Priority = 0,
                Permissions = new List<string>(),
            },
        },
        UserRoles = new Dictionary<string, List<string>>(),
    };
}
