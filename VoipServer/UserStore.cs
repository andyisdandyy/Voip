using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

public class UserStore
{
    private readonly string _filePath;
    private readonly ConcurrentDictionary<string, string> _users = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _saveLock = new();

    public UserStore(string? filePath = null)
    {
        _filePath = filePath ?? Path.Combine(AppContext.BaseDirectory, "users.json");
        Load();
    }

    public (bool success, string error) Register(string username, string password)
    {
        if (string.IsNullOrWhiteSpace(username) || username.Length < 2 || username.Length > 32)
            return (false, "Brugernavn skal være 2-32 tegn");
        if (username.Contains(':'))
            return (false, "Brugernavn må ikke indeholde ':'");
        if (string.IsNullOrWhiteSpace(password) || password.Length < 4)
            return (false, "Password skal være mindst 4 tegn");
        var hash = HashPassword(password);
        if (!_users.TryAdd(username, hash))
            return (false, "Brugernavn er allerede taget");
        Save();
        return (true, "");
    }

    public (bool success, string error) Authenticate(string username, string password)
    {
        if (!_users.TryGetValue(username, out var storedHash))
            return (false, "Forkert brugernavn eller password");
        if (storedHash != HashPassword(password))
            return (false, "Forkert brugernavn eller password");
        return (true, "");
    }

    public bool UserExists(string username) => _users.ContainsKey(username);

    public string GetDisplayName(string username)
    {
        foreach (var kv in _users)
            if (string.Equals(kv.Key, username, StringComparison.OrdinalIgnoreCase))
                return kv.Key;
        return username;
    }

    public List<string> GetAllUsernames()
    {
        return _users.Keys.ToList();
    }

    private static string HashPassword(string password)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(password));
        return Convert.ToBase64String(bytes);
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var json = File.ReadAllText(_filePath);
            var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
            if (data != null)
                foreach (var kv in data)
                    _users[kv.Key] = kv.Value;
        }
        catch { }
    }

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                var snapshot = new Dictionary<string, string>(_users);
                var json = JsonSerializer.Serialize(snapshot, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(_filePath, json);
            }
            catch { }
        }
    }
}
