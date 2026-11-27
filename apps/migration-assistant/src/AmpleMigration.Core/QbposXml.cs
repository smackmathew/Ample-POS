using System.Globalization;
using System.Xml.Linq;

namespace AmpleMigration;

/// <summary>
/// Sends one qbposXML request and returns the response text. In the app this is
/// QuickBooks POS's SDK request processor; in tests, canned responses.
/// </summary>
public interface IQbposConnection
{
    string ProcessRequest(string requestXml);
}

public sealed class QbposException(string message) : Exception(message);

/// <summary>
/// qbposXML requests and responses, as described in Intuit's QuickBooks POS SDK
/// reference. Parsing is deliberately tolerant: unknown elements are ignored and
/// missing ones are null, because fields vary a little between POS versions.
/// </summary>
public static class QbposXml
{
    /// <summary>qbposXML 3.0 is what QuickBooks POS 2013 and later (v11 to v19) accept.</summary>
    public const string DefaultVersion = "3.0";

    public static string Request(string queryName, string version = DefaultVersion, IEnumerable<XElement>? filter = null)
    {
        var rq = new XElement(queryName + "Rq", new XAttribute("requestID", "1"), filter);
        var body = new XElement("QBPOSXML", new XElement("QBPOSXMLMsgsRq", new XAttribute("onError", "stopOnError"), rq));
        return $"<?xml version=\"1.0\"?>\n<?qbposxml version=\"{version}\"?>\n{body}";
    }

    /// <summary>The records of a query response (for example every ItemInventoryRet). Status 1 means "none found".</summary>
    public static IReadOnlyList<XElement> Records(string responseXml, string queryName, string retName)
    {
        XDocument doc;
        try
        {
            doc = XDocument.Parse(responseXml);
        }
        catch (Exception e)
        {
            throw new QbposException($"QuickBooks POS sent back something that isn’t qbposXML ({e.Message}).");
        }
        var rs = doc.Descendants(queryName + "Rs").FirstOrDefault()
            ?? throw new QbposException($"QuickBooks POS didn’t answer the {queryName} request.");
        var code = (string?)rs.Attribute("statusCode") ?? "0";
        var severity = (string?)rs.Attribute("statusSeverity") ?? "Info";
        if (code == "1") return Array.Empty<XElement>();
        if (code != "0" && !severity.Equals("Info", StringComparison.OrdinalIgnoreCase) && !severity.Equals("Warn", StringComparison.OrdinalIgnoreCase))
        {
            throw new QbposException($"QuickBooks POS refused {queryName} (status {code}): {(string?)rs.Attribute("statusMessage") ?? "no message"}");
        }
        return rs.Elements(retName).ToList();
    }

    public static string? Text(XElement e, string name)
    {
        var v = e.Element(name)?.Value.Trim();
        return string.IsNullOrEmpty(v) ? null : v;
    }

    public static decimal? Number(XElement e, string name) =>
        decimal.TryParse(Text(e, name), NumberStyles.Number, CultureInfo.InvariantCulture, out var n) ? n : null;

    public static DateOnly? Date(XElement e, string name)
    {
        var v = Text(e, name);
        if (v is null) return null;
        // TxnDate is "2024-03-14"; time stamps are "2024-03-14T16:45:00-06:00".
        return DateOnly.TryParse(v.Length >= 10 ? v[..10] : v, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;
    }

    public static Department ParseDepartment(XElement e) =>
        new(Text(e, "ListID") ?? "", Text(e, "DepartmentName") ?? Text(e, "DepartmentCode") ?? "", Text(e, "DepartmentCode"));

    public static Item ParseItem(XElement e) => new(
        Text(e, "ListID") ?? "",
        Text(e, "ItemNumber"),
        Text(e, "Desc1"),
        Text(e, "Desc2"),
        Text(e, "Attribute"),
        Text(e, "Size"),
        Text(e, "DepartmentListID"),
        Number(e, "Price1"),
        Number(e, "Cost"),
        Text(e, "UPC"),
        Text(e, "ALU"),
        Number(e, "QuantityOnHand"));

    public static Customer ParseCustomer(XElement e) => new(
        Text(e, "ListID") ?? "",
        Text(e, "FirstName"),
        Text(e, "LastName"),
        Text(e, "CompanyName"),
        Text(e, "EMail"),
        Text(e, "Phone"),
        Text(e, "Notes"));

    public static Vendor ParseVendor(XElement e) => new(
        Text(e, "ListID") ?? "",
        Text(e, "CompanyName"),
        Text(e, "FirstName"),
        Text(e, "LastName"),
        Text(e, "EMail"),
        Text(e, "Phone"));

    public static SalesReceipt ParseSalesReceipt(XElement e)
    {
        var type = Text(e, "SalesReceiptType") ?? "";
        var state = $"{Text(e, "TxnState")} {Text(e, "Status")}";
        var lines = e.Elements("SalesReceiptItemRet")
            .Select(l => new SalesReceiptLine(
                Text(l, "ItemNumber"),
                Text(l, "Desc1") ?? Text(l, "Desc2") ?? Text(l, "ALU"),
                Number(l, "Qty") ?? 1,
                Number(l, "Price"),
                Number(l, "ExtendedPrice")))
            .ToList();
        return new SalesReceipt(
            Text(e, "TxnID") ?? "",
            Text(e, "SalesReceiptNumber"),
            Date(e, "TxnDate"),
            Text(e, "CustomerListID"),
            type.Contains("Return", StringComparison.OrdinalIgnoreCase),
            state.Contains("Void", StringComparison.OrdinalIgnoreCase),
            Number(e, "TaxAmount"),
            lines);
    }
}
