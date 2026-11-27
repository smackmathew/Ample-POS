using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace AmpleMigration;

/// <summary>
/// What QuickBooks POS actually sent, for fixing field mappings when a version
/// differs from the documentation. Keeps the request, the status and the first
/// few records of each kind, with names, emails, phones and addresses masked.
/// It stays on this computer unless the store chooses to send it.
/// </summary>
public sealed partial class Diagnostics
{
    private const int RecordsPerQuery = 3;
    private readonly List<string> entries = new();
    private readonly HashSet<string> recorded = new();

    public void Note(string text)
    {
        lock (entries) entries.Add($"NOTE {DateTime.UtcNow:O}: {text}");
    }

    public void Record(string query, string request, string? response, string? error)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"=== {query} at {DateTime.UtcNow:O}");
        sb.AppendLine("--- request");
        sb.AppendLine(request);
        if (error is not null) sb.AppendLine($"--- error: {error}");
        if (response is not null)
        {
            sb.AppendLine("--- response (first records, personal details masked)");
            sb.AppendLine(Sample(response));
        }
        lock (entries)
        {
            // One full sample per query is enough; later months of sales just add their status.
            if (recorded.Add(query) || error is not null) entries.Add(sb.ToString());
        }
    }

    public string Report(string header)
    {
        lock (entries) return header + Environment.NewLine + string.Join(Environment.NewLine, entries);
    }

    private static readonly string[] Personal =
    {
        "FirstName", "LastName", "CompanyName", "FullName", "EMail", "Phone", "Phone2", "Phone3", "Phone4", "Notes",
        "Addr1", "Addr2", "Addr3", "Street", "Street2", "City", "PostalCode", "Salutation", "Name",
    };

    public static string Sample(string response)
    {
        try
        {
            var doc = XDocument.Parse(response);
            foreach (var rs in doc.Descendants().Where(e => e.Name.LocalName.EndsWith("Rs", StringComparison.Ordinal)).ToList())
            {
                var records = rs.Elements().ToList();
                rs.Add(new XComment($" {records.Count} records in all "));
                foreach (var extra in records.Skip(RecordsPerQuery)) extra.Remove();
            }
            foreach (var e in doc.Descendants().Where(e => !e.HasElements && Personal.Contains(e.Name.LocalName)).ToList())
            {
                e.Value = Mask(e.Value);
            }
            return doc.ToString();
        }
        catch
        {
            return "(not XML) " + Masked().Replace(response.Length > 2000 ? response[..2000] : response, "***");
        }
    }

    private static string Mask(string value) => value.Length == 0 ? value : $"{value[0]}*** ({value.Length} characters)";

    [GeneratedRegex(@"[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s().-]{7,}\d")]
    private static partial Regex Masked();
}
