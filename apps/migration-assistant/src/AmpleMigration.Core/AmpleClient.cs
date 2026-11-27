using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AmpleMigration;

public sealed class AmpleException(string message, HttpStatusCode? status = null) : Exception(message)
{
    public HttpStatusCode? Status { get; } = status;
}

public sealed record Pairing(string ApiKey, string TenantId, string BusinessName);
public sealed record Location(string Id, string Name, DateTime? ArchivedAt);
public sealed record PreviewCounts(int Rows, int Create, int Update, int Error);
public sealed record Preview(string BatchId, PreviewCounts Counts);
public sealed record CommitResult(int Created, int Updated, int Failed);
public sealed record ReconciliationSummary(int Imports, int Checks, int Matching, int Differences);

/// <summary>
/// Ample POS's API, at the site's address plus /api. The Assistant pairs with a
/// one-time code and then uses an import-only API key for the business.
/// </summary>
public sealed class AmpleClient : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    private readonly HttpClient http;

    public AmpleClient(string siteAddress, string? apiKey = null, HttpMessageHandler? handler = null)
    {
        SiteAddress = NormalizeSite(siteAddress);
        http = handler is null ? new HttpClient() : new HttpClient(handler);
        http.BaseAddress = new Uri(SiteAddress + "/api/");
        http.Timeout = TimeSpan.FromMinutes(10);
        http.DefaultRequestHeaders.UserAgent.ParseAdd("AmplePOS-MigrationAssistant/1.0");
        if (apiKey is not null) http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
    }

    public string SiteAddress { get; }

    /// <summary>"ample-pos.onrender.com" or "https://…/" become "https://ample-pos.onrender.com".</summary>
    public static string NormalizeSite(string address)
    {
        var a = address.Trim().TrimEnd('/');
        if (!a.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !a.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) a = "https://" + a;
        if (!Uri.TryCreate(a, UriKind.Absolute, out var uri)) throw new AmpleException("That doesn’t look like a web address.");
        if (uri.AbsolutePath.EndsWith("/api", StringComparison.OrdinalIgnoreCase)) a = a[..^4];
        return a;
    }

    public async Task<Pairing> PairAsync(string code, string computer, CancellationToken cancel = default)
    {
        var res = await Send(HttpMethod.Post, "migration/assistant/pair", new { code, computer }, cancel);
        return await Read<Pairing>(res, cancel);
    }

    public async Task<IReadOnlyList<Location>> LocationsAsync(CancellationToken cancel = default)
    {
        var list = await Read<List<Location>>(await Send(HttpMethod.Get, "locations", null, cancel), cancel);
        return list.Where(l => l.ArchivedAt is null).ToList();
    }

    public async Task<Preview> StartImportAsync(ImportFile file, string? locationId, CancellationToken cancel = default)
    {
        var body = new { kind = file.Kind, source = "qbpos", fileName = file.Name, csv = file.Csv, locationId };
        using var doc = JsonDocument.Parse(await (await Send(HttpMethod.Post, "imports", body, cancel)).Content.ReadAsStringAsync(cancel));
        var root = doc.RootElement;
        var counts = root.GetProperty("counts");
        int N(string name) => counts.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;
        return new Preview(root.GetProperty("batch").GetProperty("id").GetString()!, new PreviewCounts(N("rows"), N("create"), N("update"), N("error")));
    }

    public async Task<CommitResult> CommitAsync(string batchId, CancellationToken cancel = default) =>
        await Read<CommitResult>(await Send(HttpMethod.Post, $"imports/{batchId}/commit", null, cancel), cancel);

    public async Task<ReconciliationSummary> ReconciliationAsync(CancellationToken cancel = default)
    {
        using var doc = JsonDocument.Parse(await (await Send(HttpMethod.Get, "migration/reconciliation", null, cancel)).Content.ReadAsStringAsync(cancel));
        return doc.RootElement.GetProperty("summary").Deserialize<ReconciliationSummary>(Json)!;
    }

    private async Task<HttpResponseMessage> Send(HttpMethod method, string path, object? body, CancellationToken cancel)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body is not null) req.Content = JsonContent.Create(body, options: Json);
        HttpResponseMessage res;
        try
        {
            res = await http.SendAsync(req, cancel);
        }
        catch (HttpRequestException e)
        {
            throw new AmpleException($"Couldn’t reach Ample POS at {SiteAddress}: {e.Message}");
        }
        if (res.IsSuccessStatusCode) return res;
        var text = await res.Content.ReadAsStringAsync(cancel);
        string? message = null;
        try
        {
            using var doc = JsonDocument.Parse(text);
            if (doc.RootElement.TryGetProperty("message", out var m))
                message = m.ValueKind == JsonValueKind.Array ? string.Join("; ", m.EnumerateArray().Select(x => x.ToString())) : m.ToString();
        }
        catch (JsonException)
        {
        }
        throw new AmpleException(res.StatusCode switch
        {
            HttpStatusCode.Unauthorized when path.EndsWith("pair", StringComparison.Ordinal) => message ?? "That code didn’t work.",
            HttpStatusCode.Unauthorized => "Ample POS no longer accepts this Assistant (it may have been removed). Connect again with a new code.",
            _ => message ?? $"Ample POS answered {(int)res.StatusCode} {res.ReasonPhrase}",
        }, res.StatusCode);
    }

    private static async Task<T> Read<T>(HttpResponseMessage res, CancellationToken cancel) =>
        (await res.Content.ReadFromJsonAsync<T>(Json, cancel)) ?? throw new AmpleException("Ample POS sent an empty answer.");

    public void Dispose() => http.Dispose();
}
