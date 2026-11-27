using System.Globalization;
using System.Text;

namespace AmpleMigration;

/// <summary>One file to send to Ample POS's import: the kind, a name, and CSV text.</summary>
public sealed record ImportFile(string Kind, string Name, string Csv, int Rows);

/// <summary>
/// Turns what QuickBooks POS has into the same columns QuickBooks POS's own list
/// exports use, so Ample POS's existing QuickBooks POS import reads them
/// (column matching, preview, undo and the reconciliation report included).
/// Ample takes up to 20,000 rows per import, so long lists are split.
/// </summary>
public static class ImportFiles
{
    public const int MaxRows = 20_000;

    public static IEnumerable<ImportFile> Items(QbposData data, int maxRows = MaxRows)
    {
        var departments = data.Departments.GroupBy(d => d.ListId).ToDictionary(g => g.Key, g => g.First().Name);
        var header = new[] { "Item Number", "Item Name", "Item Description", "Attribute", "Size", "Department Name", "Regular Price", "Average Unit Cost", "UPC", "Alternate Lookup", "Qty 1" };
        // Sizes and colours of one item (a matrix) share its name; keep them in the same file so they become one product.
        var groups = data.Items
            .OrderBy(i => i.Name ?? i.Description ?? "", StringComparer.OrdinalIgnoreCase)
            .ThenBy(i => i.Attribute, StringComparer.OrdinalIgnoreCase)
            .ThenBy(i => i.Size, StringComparer.OrdinalIgnoreCase)
            .GroupBy(i => (i.Name ?? i.Description ?? i.ListId).ToUpperInvariant())
            .Select(g => g.Select(i => new[]
            {
                i.ItemNumber, i.Name, i.Description, i.Attribute, i.Size,
                i.DepartmentListId is { } d && departments.TryGetValue(d, out var name) ? name : null,
                Money(i.Price), Money(i.Cost), i.Upc, i.Alu, Quantity(i.QuantityOnHand),
            }).ToList());
        return Split("products", "QuickBooks POS items", header, groups, maxRows);
    }

    public static IEnumerable<ImportFile> Customers(QbposData data, int maxRows = MaxRows)
    {
        var header = new[] { "First Name", "Last Name", "Company", "EMail", "Phone 1", "Notes" };
        var rows = data.Customers.Select(c => new List<string?[]> { new[] { c.FirstName, c.LastName, c.CompanyName, c.Email, c.Phone, c.Notes } });
        return Split("customers", "QuickBooks POS customers", header, rows, maxRows);
    }

    public static IEnumerable<ImportFile> Vendors(QbposData data, int maxRows = MaxRows)
    {
        var header = new[] { "Company", "First Name", "Last Name", "EMail", "Phone 1" };
        var rows = data.Vendors
            .Where(v => !string.IsNullOrWhiteSpace(v.CompanyName) || !string.IsNullOrWhiteSpace(v.FirstName) || !string.IsNullOrWhiteSpace(v.LastName))
            .Select(v => new List<string?[]> { new[] { v.CompanyName, v.FirstName, v.LastName, v.Email, v.Phone } });
        return Split("suppliers", "QuickBooks POS vendors", header, rows, maxRows);
    }

    /// <summary>
    /// Past sales, one row per line. The receipt's tax is shared across its lines by
    /// amount (cents left over go on the last line). Returns are negative; voided receipts are left out.
    /// </summary>
    public static IEnumerable<ImportFile> Sales(QbposData data, int maxRows = MaxRows)
    {
        var customers = data.Customers.GroupBy(c => c.ListId).ToDictionary(g => g.Key, g => g.First());
        var header = new[] { "Receipt #", "Date", "Item Number", "Item Name", "Qty", "Ext Price", "Tax", "Customer", "EMail" };
        var receipts = data.SalesReceipts
            .Where(r => !r.IsVoided && r.Date is not null && r.Lines.Count > 0)
            .OrderBy(r => r.Date)
            .ThenBy(r => r.Number, StringComparer.Ordinal)
            .Select(r =>
            {
                customers.TryGetValue(r.CustomerListId ?? "", out var customer);
                var sign = r.IsReturn ? -1 : 1;
                var amounts = r.Lines.Select(l => Math.Round(l.ExtendedPrice ?? (l.Price ?? 0) * l.Quantity, 2)).ToList();
                // A return may already be negative; make sure it is.
                amounts = amounts.Select(a => sign < 0 ? -Math.Abs(a) : a).ToList();
                var taxes = ShareTax(Math.Abs(r.Tax ?? 0) * sign, amounts);
                return r.Lines.Select((l, i) => new[]
                {
                    r.Number, r.Date!.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), l.ItemNumber, l.Name ?? "Item",
                    Quantity(sign < 0 ? -Math.Abs(l.Quantity) : l.Quantity), Money(amounts[i]), Money(taxes[i]),
                    customer?.DisplayName, customer?.Email,
                }).ToList();
            });
        return Split("sales", "QuickBooks POS sales", header, receipts, maxRows);
    }

    public static decimal[] ShareTax(decimal tax, IReadOnlyList<decimal> amounts)
    {
        var shares = new decimal[amounts.Count];
        if (amounts.Count == 0 || tax == 0) return shares;
        var total = amounts.Sum();
        decimal given = 0;
        for (var i = 0; i < amounts.Count - 1; i++)
        {
            shares[i] = total == 0 ? 0 : Math.Round(tax * amounts[i] / total, 2, MidpointRounding.AwayFromZero);
            given += shares[i];
        }
        shares[^1] = tax - given;
        return shares;
    }

    /// <summary>Splits groups of rows into files of at most maxRows, never splitting a group.</summary>
    private static IEnumerable<ImportFile> Split(string kind, string name, string[] header, IEnumerable<List<string?[]>> groups, int maxRows)
    {
        var files = new List<(StringBuilder Csv, int Rows)>();
        StringBuilder? current = null;
        var rows = 0;
        foreach (var group in groups)
        {
            if (current is null || (rows > 0 && rows + group.Count > maxRows))
            {
                if (current is not null) files.Add((current, rows));
                current = new StringBuilder();
                AppendRow(current, header);
                rows = 0;
            }
            foreach (var row in group) AppendRow(current, row);
            rows += group.Count;
        }
        if (current is not null && rows > 0) files.Add((current, rows));
        return files.Select((f, i) => new ImportFile(kind, files.Count == 1 ? name : $"{name} (part {i + 1} of {files.Count})", f.Csv.ToString(), f.Rows));
    }

    private static void AppendRow(StringBuilder sb, IEnumerable<string?> cells)
    {
        sb.AppendJoin(',', cells.Select(Cell));
        sb.Append("\r\n");
    }

    private static string Cell(string? value)
    {
        var s = value ?? "";
        return s.IndexOfAny(new[] { ',', '"', '\r', '\n' }) >= 0 ? $"\"{s.Replace("\"", "\"\"")}\"" : s;
    }

    private static string? Money(decimal? value) => value?.ToString("0.00", CultureInfo.InvariantCulture);

    private static string? Quantity(decimal? value) => value?.ToString("0.####", CultureInfo.InvariantCulture);
}
