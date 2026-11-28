using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AmpleMigration.App;

/// <summary>
/// Remembered between runs, for this Windows user: the Ample POS address and
/// business, and the API key encrypted with Windows (DPAPI) so only this user
/// on this computer can read it.
/// </summary>
public sealed class Settings
{
    public string Site { get; set; } = "https://ample-pos.onrender.com";
    public string? TenantId { get; set; }
    public string? BusinessName { get; set; }
    public string? ProtectedKey { get; set; }
    public string Computer { get; set; } = Environment.MachineName;
    public string CompanyData { get; set; } = "";
    public string Version { get; set; } = "19";

    private static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Ample POS", "Migration Assistant");
    private static string FilePath => Path.Combine(Folder, "settings.json");

    public static Settings Load()
    {
        try
        {
            return File.Exists(FilePath) ? JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new Settings() : new Settings();
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return new Settings();
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(Folder);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }

    public string? ApiKey
    {
        get
        {
            if (ProtectedKey is null) return null;
            try
            {
                return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(ProtectedKey), null, DataProtectionScope.CurrentUser));
            }
            catch (CryptographicException)
            {
                return null;
            }
        }
        set => ProtectedKey = value is null ? null : Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser));
    }
}
