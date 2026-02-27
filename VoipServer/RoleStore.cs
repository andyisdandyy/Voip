using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

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

public class RoleStore
{
    public static readonly string[] ALL_PERMISSIONS =
    {
        "admin",
        "manage_roles",
        "manage_rooms",
        "kick_users",
        "delete_messages",
    };

    private RoleStoreData _data;
    private readonly string _path;
    private readonly object _saveLock = new();

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

    public List<RoleDefinition> GetRoles() => _data.Roles.ToList();

    public RoleDefinition? GetRole(string roleName) =>
        _data.Roles.FirstOrDefault(r => string.Equals(r.Name, roleName, StringComparison.OrdinalIgnoreCase));

    public List<string> GetUserRoleNames(string username)
    {
        if (_data.UserRoles.TryGetValue(username, out var roles))
            return roles.ToList();
        return new List<string>();
    }

    public RoleDefinition? GetHighestRole(string username)
    {
        var roleNames = GetUserRoleNames(username);
        if (roleNames.Count == 0) return null;
        return _data.Roles
            .Where(r => roleNames.Contains(r.Name, StringComparer.OrdinalIgnoreCase))
            .OrderByDescending(r => r.Priority)
            .FirstOrDefault();
    }

    public bool HasPermission(string username, string permission)
    {
        var roleNames = GetUserRoleNames(username);
        return _data.Roles
            .Where(r => roleNames.Contains(r.Name, StringComparer.OrdinalIgnoreCase))
            .Any(r => r.Permissions.Contains("admin") || r.Permissions.Contains(permission));
    }

    // ── Mutations ────────────────────────────────────────────

    public bool AssignRole(string username, string roleName)
    {
        if (GetRole(roleName) == null) return false;
        if (!_data.UserRoles.ContainsKey(username))
            _data.UserRoles[username] = new List<string>();
        if (_data.UserRoles[username].Contains(roleName, StringComparer.OrdinalIgnoreCase))
            return false;
        _data.UserRoles[username].Add(roleName);
        Save();
        return true;
    }

    public bool RemoveRole(string username, string roleName)
    {
        if (!_data.UserRoles.ContainsKey(username)) return false;
        var removed = _data.UserRoles[username].RemoveAll(r =>
            string.Equals(r, roleName, StringComparison.OrdinalIgnoreCase)) > 0;
        if (removed) Save();
        return removed;
    }

    public bool CreateRole(string name, string color, int priority, List<string> permissions)
    {
        if (GetRole(name) != null) return false;
        _data.Roles.Add(new RoleDefinition
        {
            Name = name,
            Color = color,
            Priority = priority,
            Permissions = permissions,
        });
        Save();
        return true;
    }

    public bool DeleteRole(string name)
    {
        // Cannot delete Admin or Member
        if (string.Equals(name, "Admin", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(name, "Member", StringComparison.OrdinalIgnoreCase))
            return false;

        var removed = _data.Roles.RemoveAll(r =>
            string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase)) > 0;
        if (removed)
        {
            // Remove role from all users
            foreach (var kv in _data.UserRoles)
                kv.Value.RemoveAll(r => string.Equals(r, name, StringComparison.OrdinalIgnoreCase));
            Save();
        }
        return removed;
    }

    /// <summary>Ensure user has at least the Member role. Returns true if Admin was auto-assigned (first user).</summary>
    public bool EnsureDefaultRole(string username, bool isFirstUser)
    {
        if (!_data.UserRoles.ContainsKey(username))
            _data.UserRoles[username] = new List<string>();

        bool assignedAdmin = false;
        if (isFirstUser && !_data.UserRoles.Values.Any(roles => roles.Contains("Admin", StringComparer.OrdinalIgnoreCase)))
        {
            if (!_data.UserRoles[username].Contains("Admin", StringComparer.OrdinalIgnoreCase))
            {
                _data.UserRoles[username].Add("Admin");
                assignedAdmin = true;
            }
        }

        if (!_data.UserRoles[username].Contains("Member", StringComparer.OrdinalIgnoreCase))
            _data.UserRoles[username].Add("Member");

        Save();
        return assignedAdmin;
    }

    // ── Persistence ──────────────────────────────────────────

    private RoleStoreData Load()
    {
        try
        {
            if (!File.Exists(_path))
            {
                var def = CreateDefault();
                try { File.WriteAllText(_path, JsonSerializer.Serialize(def, _jsonOpts)); } catch { }
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

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var json = JsonSerializer.Serialize(_data, _jsonOpts);
                File.WriteAllText(_path, json);
            }
            catch { }
        }
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
