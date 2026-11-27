using AmpleMigration;
using Xunit;

namespace AmpleMigration.Tests;

public class ImportFilesTests
{
    private static QbposData Data()
    {
        var d = new QbposData();
        d.Departments.Add(new Department("D1", "Outerwear", "OUT"));
        d.Items.Add(new Item("I3", "1004", "Mug, \"large\"", null, null, null, null, 12.5m, 2.1m, null, null, 5));
        d.Items.Add(new Item("I2", "1002", "Rain Jacket", "Rain jacket", "Navy", "M", "D1", 129m, 54.25m, "012345678912", null, 3));
        d.Items.Add(new Item("I1", "1001", "Rain Jacket", "Rain jacket", "Navy", "L", "D1", 129m, 54.25m, "012345678905", "RJ-NAVY-L", 8));
        d.Customers.Add(new Customer("C1", "Ana", "Lopez", null, "ana@example.com", "(312) 555-0199", "VIP"));
        d.Vendors.Add(new Vendor("V1", "Acme Supply", "Jo", "Park", "jo@acme.example", "555-123-4567"));
        d.Vendors.Add(new Vendor("V2", null, null, null, null, null));
        d.SalesReceipts.Add(new SalesReceipt("T1", "2001", new DateOnly(2024, 3, 14), "C1", false, false, 20.88m,
            new[] { new SalesReceiptLine("1001", "Rain Jacket", 2, 129m, 258m), new SalesReceiptLine(null, "Gift wrap", 1, 3m, 3m) }));
        d.SalesReceipts.Add(new SalesReceipt("T2", "2002", new DateOnly(2024, 3, 15), null, true, false, 0.96m, new[] { new SalesReceiptLine("1004", "Mug", 1, 12m, 12m) }));
        d.SalesReceipts.Add(new SalesReceipt("T3", "2003", new DateOnly(2024, 4, 2), null, false, true, 0, new[] { new SalesReceiptLine("1004", "Mug", 1, 12m, 12m) }));
        d.SalesReceipts.Add(new SalesReceipt("T4", "2004", new DateOnly(2024, 4, 20), null, false, false, null, new[] { new SalesReceiptLine("1004", "Mug", 3, 12m, null) }));
        return d;
    }

    [Fact]
    public void Items_use_the_columns_of_a_QuickBooks_POS_item_list()
    {
        var file = Assert.Single(ImportFiles.Items(Data()));
        Assert.Equal("products", file.Kind);
        Assert.Equal(3, file.Rows);
        Assert.Equal(
            "Item Number,Item Name,Item Description,Attribute,Size,Department Name,Regular Price,Average Unit Cost,UPC,Alternate Lookup,Qty 1\r\n" +
            "1004,\"Mug, \"\"large\"\"\",,,,,12.50,2.10,,,5\r\n" +
            "1001,Rain Jacket,Rain jacket,Navy,L,Outerwear,129.00,54.25,012345678905,RJ-NAVY-L,8\r\n" +
            "1002,Rain Jacket,Rain jacket,Navy,M,Outerwear,129.00,54.25,012345678912,,3\r\n",
            file.Csv);
    }

    [Fact]
    public void Long_lists_are_split_without_separating_sizes_of_one_item()
    {
        var files = ImportFiles.Items(Data(), maxRows: 2).ToList();
        Assert.Equal(2, files.Count);
        Assert.Equal(new[] { 1, 2 }, files.Select(f => f.Rows));
        Assert.Equal("QuickBooks POS items (part 2 of 2)", files[1].Name);
        Assert.Contains("Navy,L", files[1].Csv);
        Assert.Contains("Navy,M", files[1].Csv);
        Assert.StartsWith("Item Number,", files[1].Csv);
    }

    [Fact]
    public void Customers_and_vendors()
    {
        Assert.Equal("First Name,Last Name,Company,EMail,Phone 1,Notes\r\nAna,Lopez,,ana@example.com,(312) 555-0199,VIP\r\n", Assert.Single(ImportFiles.Customers(Data())).Csv);
        var vendors = Assert.Single(ImportFiles.Vendors(Data()));
        Assert.Equal(1, vendors.Rows);
        Assert.Contains("Acme Supply,Jo,Park,jo@acme.example,555-123-4567", vendors.Csv);
    }

    [Fact]
    public void Sales_share_tax_across_lines_make_returns_negative_and_leave_out_voids()
    {
        var csv = Assert.Single(ImportFiles.Sales(Data())).Csv.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("Receipt #,Date,Item Number,Item Name,Qty,Ext Price,Tax,Customer,EMail", csv[0]);
        // $20.88 tax over $258 + $3: 20.64 and the 0.24 left over.
        Assert.Equal("2001,2024-03-14,1001,Rain Jacket,2,258.00,20.64,Ana Lopez,ana@example.com", csv[1]);
        Assert.Equal("2001,2024-03-14,,Gift wrap,1,3.00,0.24,Ana Lopez,ana@example.com", csv[2]);
        Assert.Equal("2002,2024-03-15,1004,Mug,-1,-12.00,-0.96,,", csv[3]);
        // No extended price: price times quantity. The voided receipt 2003 isn't there.
        Assert.Equal("2004,2024-04-20,1004,Mug,3,36.00,0.00,,", csv[4]);
        Assert.Equal(5, csv.Length);
    }

    [Fact]
    public void Tax_shares_always_add_up()
    {
        var shares = ImportFiles.ShareTax(1.00m, new[] { 3.33m, 3.33m, 3.34m });
        Assert.Equal(1.00m, shares.Sum());
        Assert.Equal(new[] { 0.33m, 0.33m, 0.34m }, shares);
        Assert.Equal(new[] { 0m, 0m }, ImportFiles.ShareTax(0, new[] { 1m, 2m }));
    }

    [Fact]
    public void Site_addresses()
    {
        Assert.Equal("https://ample-pos.onrender.com", AmpleClient.NormalizeSite("ample-pos.onrender.com/"));
        Assert.Equal("https://shop.example", AmpleClient.NormalizeSite(" https://shop.example/api "));
        Assert.Equal("http://localhost:3000", AmpleClient.NormalizeSite("http://localhost:3000"));
    }
}
