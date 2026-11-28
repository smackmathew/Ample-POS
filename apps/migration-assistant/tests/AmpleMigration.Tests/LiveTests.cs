using System.Xml.Linq;
using AmpleMigration;
using Xunit;
using Xunit.Abstractions;

namespace AmpleMigration.Tests;

/// <summary>
/// Against a running Ample POS: set AMPLE_TEST_SITE (e.g. http://localhost:3000)
/// and AMPLE_TEST_CODE (a fresh pairing code). Skipped otherwise.
/// </summary>
public class LiveTests(ITestOutputHelper output)
{
    [Fact]
    public async Task Pairs_previews_imports_and_reconciles()
    {
        var site = Environment.GetEnvironmentVariable("AMPLE_TEST_SITE");
        var code = Environment.GetEnvironmentVariable("AMPLE_TEST_CODE");
        if (site is null || code is null)
        {
            output.WriteLine("Skipped: set AMPLE_TEST_SITE and AMPLE_TEST_CODE to run against Ample POS.");
            return;
        }
        Pairing pairing;
        using (var anonymous = new AmpleClient(site)) pairing = await anonymous.PairAsync(code, "TEST-PC");
        output.WriteLine($"Paired with {pairing.BusinessName}");
        using var ample = new AmpleClient(site, pairing.ApiKey);
        var store = (await ample.LocationsAsync()).First();

        var qb = new FakeQbpos();
        qb.Answers["DepartmentQuery"] = _ => FakeQbpos.Ok("DepartmentQuery", new[] { new XElement("DepartmentRet", new XElement("ListID", "D1"), new XElement("DepartmentName", "Outerwear")) });
        qb.Answers["ItemInventoryQuery"] = _ => FakeQbpos.Ok("ItemInventoryQuery", new[]
        {
            FakeQbpos.Item("I1", "1001", "Rain Jacket", "Navy", "L", "D1", "129.00", "54.25", "012345678905", "RJ-NAVY-L", "8"),
            FakeQbpos.Item("I2", "1002", "Rain Jacket", "Navy", "M", "D1", "129.00", "54.25", "012345678912", null, "3"),
            FakeQbpos.Item("I3", "1004", "Mug", null, null, "D1", "12.50", "2.10", null, null, "5"),
        });
        qb.Answers["CustomerQuery"] = _ => FakeQbpos.Ok("CustomerQuery", new[]
        {
            new XElement("CustomerRet", new XElement("ListID", "C1"), new XElement("FirstName", "Ana"), new XElement("LastName", "Lopez"), new XElement("EMail", "ana@example.com")),
        });
        qb.Answers["VendorQuery"] = _ => FakeQbpos.Ok("VendorQuery", new[] { new XElement("VendorRet", new XElement("ListID", "V1"), new XElement("CompanyName", "Acme Supply")) });
        qb.Answers["SalesReceiptQuery"] = rq => rq.Element("TxnDateRangeFilter")!.Element("FromTxnDate")!.Value.StartsWith("2024-03")
            ? FakeQbpos.Ok("SalesReceiptQuery", new[]
            {
                new XElement("SalesReceiptRet", new XElement("TxnID", "T1"), new XElement("SalesReceiptNumber", "2001"), new XElement("TxnDate", "2024-03-14"),
                    new XElement("CustomerListID", "C1"), new XElement("SalesReceiptType", "Sales"), new XElement("TaxAmount", "20.64"),
                    new XElement("SalesReceiptItemRet", new XElement("ItemNumber", "1001"), new XElement("Desc1", "Rain Jacket"), new XElement("Qty", "2"), new XElement("ExtendedPrice", "258.00"))),
                new XElement("SalesReceiptRet", new XElement("TxnID", "T2"), new XElement("SalesReceiptNumber", "2002"), new XElement("TxnDate", "2024-03-15"),
                    new XElement("SalesReceiptType", "Return"), new XElement("TaxAmount", "0.96"),
                    new XElement("SalesReceiptItemRet", new XElement("ItemNumber", "1004"), new XElement("Desc1", "Mug"), new XElement("Qty", "1"), new XElement("ExtendedPrice", "12.00"))),
            })
            : FakeQbpos.Ok("SalesReceiptQuery", Array.Empty<XElement>());

        var options = new ReadOptions(true, true, true, true, new DateOnly(2024, 3, 1), new DateOnly(2024, 4, 30));
        var data = new QbposReader(qb).Read(options);
        var migration = new Migration(ample);
        var uploaded = await migration.PreviewAsync(Migration.Files(data, options), store.Id);
        foreach (var u in uploaded) output.WriteLine($"{u.File.Name}: {u.Preview?.Counts} {u.Error}");
        Assert.All(uploaded, u => Assert.Null(u.Error));
        Assert.Equal(new[] { "products", "suppliers", "customers", "sales" }, uploaded.Select(u => u.File.Kind));
        Assert.All(uploaded, u => Assert.Equal(0, u.Preview!.Counts.Error));
        Assert.Equal(3, uploaded[0].Preview!.Counts.Create);

        await migration.CommitAsync(uploaded);
        Assert.Equal(3, uploaded[0].Result!.Created);
        Assert.Equal(2, uploaded[3].Result!.Created);
        var summary = await ample.ReconciliationAsync();
        output.WriteLine($"Reconciliation: {summary}");
        Assert.Equal(summary.Checks, summary.Matching);
        Assert.Equal(0, summary.Differences);
    }
}
