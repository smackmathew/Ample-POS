using System.Xml.Linq;
using AmpleMigration;
using Xunit;

namespace AmpleMigration.Tests;

public class ReaderTests
{
    private static FakeQbpos Store()
    {
        var qb = new FakeQbpos();
        qb.Answers["DepartmentQuery"] = _ => FakeQbpos.Ok("DepartmentQuery", new[]
        {
            new XElement("DepartmentRet", new XElement("ListID", "D1"), new XElement("DepartmentCode", "OUT"), new XElement("DepartmentName", "Outerwear")),
            new XElement("DepartmentRet", new XElement("ListID", "D2"), new XElement("DepartmentCode", "KIT"), new XElement("DepartmentName", "Kitchen")),
        });
        qb.Answers["ItemInventoryQuery"] = _ => FakeQbpos.Ok("ItemInventoryQuery", new[]
        {
            FakeQbpos.Item("I1", "1001", "Rain Jacket", "Navy", "L", "D1", "129.00", "54.25", "012345678905", "RJ-NAVY-L", "8"),
            FakeQbpos.Item("I2", "1002", "Rain Jacket", "Navy", "M", "D1", "129.00", "54.25", "012345678912", null, "3"),
            FakeQbpos.Item("I3", "1004", "Mug, \"large\"", null, null, "D2", "12.50", "2.10", null, null, "5"),
        });
        qb.Answers["CustomerQuery"] = _ => FakeQbpos.Ok("CustomerQuery", new[]
        {
            new XElement("CustomerRet", new XElement("ListID", "C1"), new XElement("FirstName", "Ana"), new XElement("LastName", "Lopez"),
                new XElement("EMail", "ana@example.com"), new XElement("Phone", "(312) 555-0199"), new XElement("Notes", "VIP")),
            new XElement("CustomerRet", new XElement("ListID", "C2"), new XElement("CompanyName", "Harbor Rowing Club")),
        });
        qb.Answers["VendorQuery"] = _ => FakeQbpos.Ok("VendorQuery", new[]
        {
            new XElement("VendorRet", new XElement("ListID", "V1"), new XElement("CompanyName", "Acme Supply"), new XElement("FirstName", "Jo"),
                new XElement("LastName", "Park"), new XElement("EMail", "jo@acme.example"), new XElement("Phone", "555-123-4567")),
        });
        qb.Answers["SalesReceiptQuery"] = rq =>
        {
            var from = rq.Element("TxnDateRangeFilter")?.Element("FromTxnDate")?.Value;
            var receipts = new[]
            {
                Receipt("T1", "2001", "2024-03-14", "C1", "Sales", null, "20.88", Line("1001", "Rain Jacket", "2", "129.00", "258.00"), Line(null, "Gift wrap", "1", "3.00", "3.00")),
                Receipt("T2", "2002", "2024-03-15", null, "Return", null, "0.96", Line("1004", "Mug", "1", "12.00", "12.00")),
                Receipt("T3", "2003", "2024-04-02", null, "Sales", "Voided", "0", Line("1004", "Mug", "1", "12.00", "12.00")),
                Receipt("T4", "2004", "2024-04-20", "C2", "Sales", null, "0", Line("1004", "Mug", "3", "12.00", null)),
            };
            var month = from is null ? receipts : receipts.Where(r => r.Element("TxnDate")!.Value[..7] == from[..7]);
            return FakeQbpos.Ok("SalesReceiptQuery", month);
        };
        return qb;
    }

    private static XElement Receipt(string id, string number, string date, string? customer, string type, string? state, string tax, params XElement[] lines) =>
        new("SalesReceiptRet",
            new XElement("TxnID", id), new XElement("SalesReceiptNumber", number), new XElement("TxnDate", date),
            customer is null ? null : new XElement("CustomerListID", customer), new XElement("SalesReceiptType", type),
            state is null ? null : new XElement("TxnState", state), new XElement("TaxAmount", tax), lines);

    private static XElement Line(string? number, string name, string qty, string price, string? ext) =>
        new("SalesReceiptItemRet",
            number is null ? null : new XElement("ItemNumber", number), new XElement("Desc1", name), new XElement("Qty", qty),
            new XElement("Price", price), ext is null ? null : new XElement("ExtendedPrice", ext));

    private static readonly ReadOptions All = new(true, true, true, true, new DateOnly(2024, 3, 1), new DateOnly(2024, 4, 30));

    [Fact]
    public void Requests_are_qbposxml_3_0()
    {
        var request = QbposXml.Request("ItemInventoryQuery");
        Assert.StartsWith("<?xml version=\"1.0\"?>\n<?qbposxml version=\"3.0\"?>\n<QBPOSXML>", request);
        Assert.Contains("<QBPOSXMLMsgsRq onError=\"stopOnError\">", request);
        Assert.Contains("<ItemInventoryQueryRq requestID=\"1\" />", request);
    }

    [Fact]
    public void Reads_everything_and_sales_a_month_at_a_time()
    {
        var qb = Store();
        var data = new QbposReader(qb).Read(All);
        Assert.Equal(2, data.Departments.Count);
        Assert.Equal(3, data.Items.Count);
        Assert.Equal(new Item("I1", "1001", "Rain Jacket", "Rain Jacket description", "Navy", "L", "D1", 129.00m, 54.25m, "012345678905", "RJ-NAVY-L", 8m), data.Items[0]);
        Assert.Null(data.Items[1].Alu);
        Assert.Equal("Ana Lopez", data.Customers[0].DisplayName);
        Assert.Equal("Harbor Rowing Club", data.Customers[1].DisplayName);
        Assert.Single(data.Vendors);
        Assert.Equal(4, data.SalesReceipts.Count);
        Assert.Equal(2, qb.Requests.Count(r => r.Contains("SalesReceiptQueryRq")));
        Assert.Contains("<FromTxnDate>2024-04-01</FromTxnDate>", qb.Requests.Last());
        Assert.Contains("<ToTxnDate>2024-04-30</ToTxnDate>", qb.Requests.Last());
        var ret = data.SalesReceipts.Single(r => r.TxnId == "T2");
        Assert.True(ret.IsReturn);
        Assert.True(data.SalesReceipts.Single(r => r.TxnId == "T3").IsVoided);
    }

    [Fact]
    public void Reads_all_sales_once_when_the_date_filter_is_refused()
    {
        var qb = Store();
        var inner = qb.Answers["SalesReceiptQuery"];
        qb.Answers["SalesReceiptQuery"] = rq => rq.Element("TxnDateRangeFilter") is null
            ? inner(rq)
            : FakeQbpos.Response("SalesReceiptQuery", "3120", "Error", "Element TxnDateRangeFilter not expected", Array.Empty<XElement>());
        var diagnostics = new Diagnostics();
        var data = new QbposReader(qb, diagnostics).Read(All with { SalesFrom = new DateOnly(2024, 3, 15) });
        // The 14 March receipt is before the chosen start; the rest are kept.
        Assert.Equal(new[] { "T2", "T3", "T4" }, data.SalesReceipts.Select(r => r.TxnId));
        Assert.Contains("date filter was refused", diagnostics.Report("x"));
    }

    [Fact]
    public void Refusals_and_empty_answers()
    {
        Assert.Empty(QbposXml.Records(FakeQbpos.Response("VendorQuery", "1", "Info", "None found", Array.Empty<XElement>()), "VendorQuery", "VendorRet"));
        var e = Assert.Throws<QbposException>(() =>
            QbposXml.Records(FakeQbpos.Response("CustomerQuery", "3200", "Error", "Permission denied", Array.Empty<XElement>()), "CustomerQuery", "CustomerRet"));
        Assert.Contains("Permission denied", e.Message);
        Assert.Throws<QbposException>(() => QbposXml.Records("not xml", "CustomerQuery", "CustomerRet"));
        Assert.Throws<QbposException>(() => QbposXml.Records(FakeQbpos.Ok("VendorQuery", Array.Empty<XElement>()), "CustomerQuery", "CustomerRet"));
    }

    [Fact]
    public void Diagnostics_mask_personal_details_and_keep_a_few_records()
    {
        var many = Enumerable.Range(1, 10).Select(i => new XElement("CustomerRet", new XElement("ListID", $"C{i}"), new XElement("FirstName", "Ana"), new XElement("EMail", "ana@example.com")));
        var sample = Diagnostics.Sample(FakeQbpos.Ok("CustomerQuery", many));
        Assert.DoesNotContain("ana@example.com", sample);
        Assert.Contains("a*** (15 characters)", sample);
        Assert.Contains("10 records in all", sample);
        Assert.Equal(3, sample.Split("<CustomerRet>").Length - 1);
    }
}
