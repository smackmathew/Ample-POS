using System.Xml.Linq;
using AmpleMigration;

namespace AmpleMigration.Tests;

/// <summary>Answers qbposXML requests the way QuickBooks POS's SDK does, from canned records.</summary>
public sealed class FakeQbpos : IQbposConnection
{
    public List<string> Requests { get; } = new();
    public Dictionary<string, Func<XElement, string>> Answers { get; } = new();

    public string ProcessRequest(string requestXml)
    {
        Requests.Add(requestXml);
        var doc = XDocument.Parse(requestXml);
        var rq = doc.Descendants().First(e => e.Name.LocalName.EndsWith("Rq", StringComparison.Ordinal) && e.Name.LocalName != "QBPOSXMLMsgsRq");
        var query = rq.Name.LocalName[..^2];
        return Answers.TryGetValue(query, out var answer) ? answer(rq) : Response(query, "1", "Info", "A query request did not find a matching object", Array.Empty<XElement>());
    }

    public static string Response(string query, string code, string severity, string message, IEnumerable<XElement> records) =>
        "<?xml version=\"1.0\" ?>\n" +
        new XElement("QBPOSXML",
            new XElement("QBPOSXMLMsgsRs",
                new XElement(query + "Rs",
                    new XAttribute("requestID", "1"), new XAttribute("statusCode", code), new XAttribute("statusSeverity", severity), new XAttribute("statusMessage", message),
                    records)));

    public static string Ok(string query, IEnumerable<XElement> records) => Response(query, "0", "Info", "Status OK", records);

    public static XElement Item(string listId, string number, string name, string? attribute, string? size, string dept, string price, string cost, string? upc, string? alu, string qty) =>
        new("ItemInventoryRet",
            new XElement("ListID", listId),
            new XElement("TimeCreated", "2019-04-01T10:00:00-05:00"),
            new XElement("ALU", alu ?? ""),
            new XElement("Attribute", attribute ?? ""),
            new XElement("Cost", cost),
            new XElement("DepartmentListID", dept),
            new XElement("Desc1", name),
            new XElement("Desc2", name + " description"),
            new XElement("ItemNumber", number),
            new XElement("ItemType", "Inventory"),
            new XElement("Price1", price),
            new XElement("Price2", "0.00"),
            new XElement("QuantityOnHand", qty),
            new XElement("Size", size ?? ""),
            new XElement("UPC", upc ?? ""));
}
