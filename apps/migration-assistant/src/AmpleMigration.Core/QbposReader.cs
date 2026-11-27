using System.Xml.Linq;

namespace AmpleMigration;

/// <summary>What to read, and from when for sales.</summary>
public sealed record ReadOptions(bool Items, bool Customers, bool Vendors, bool Sales, DateOnly SalesFrom, DateOnly SalesTo, string Version = QbposXml.DefaultVersion);

/// <summary>
/// Reads a QuickBooks POS company through the SDK. Sales are read a month at a
/// time so no single answer gets huge; if QuickBooks POS doesn't take the date
/// filter, it reads them unfiltered once and keeps the chosen dates.
/// </summary>
public sealed class QbposReader(IQbposConnection connection, Diagnostics? diagnostics = null)
{
    public QbposData Read(ReadOptions options, IProgress<string>? progress = null, CancellationToken cancel = default)
    {
        var data = new QbposData();
        if (options.Items)
        {
            progress?.Report("Reading departments…");
            data.Departments.AddRange(Query("DepartmentQuery", "DepartmentRet", options.Version).Select(QbposXml.ParseDepartment));
            cancel.ThrowIfCancellationRequested();
            progress?.Report("Reading items and stock…");
            data.Items.AddRange(Query("ItemInventoryQuery", "ItemInventoryRet", options.Version).Select(QbposXml.ParseItem));
            progress?.Report($"Read {data.Items.Count:N0} items.");
        }
        cancel.ThrowIfCancellationRequested();
        // Customers are needed to name the customer on past sales, too.
        if (options.Customers || options.Sales)
        {
            progress?.Report("Reading customers…");
            data.Customers.AddRange(Query("CustomerQuery", "CustomerRet", options.Version).Select(QbposXml.ParseCustomer));
            progress?.Report($"Read {data.Customers.Count:N0} customers.");
        }
        cancel.ThrowIfCancellationRequested();
        if (options.Vendors)
        {
            progress?.Report("Reading vendors…");
            data.Vendors.AddRange(Query("VendorQuery", "VendorRet", options.Version).Select(QbposXml.ParseVendor));
            progress?.Report($"Read {data.Vendors.Count:N0} vendors.");
        }
        if (options.Sales) ReadSales(data, options, progress, cancel);
        return data;
    }

    private void ReadSales(QbposData data, ReadOptions options, IProgress<string>? progress, CancellationToken cancel)
    {
        var seen = new HashSet<string>();
        var month = new DateOnly(options.SalesFrom.Year, options.SalesFrom.Month, 1);
        while (month <= options.SalesTo)
        {
            cancel.ThrowIfCancellationRequested();
            var from = month < options.SalesFrom ? options.SalesFrom : month;
            var to = month.AddMonths(1).AddDays(-1);
            if (to > options.SalesTo) to = options.SalesTo;
            progress?.Report($"Reading sales for {month:MMMM yyyy}…");
            IReadOnlyList<XElement> records;
            try
            {
                records = Query("SalesReceiptQuery", "SalesReceiptRet", options.Version, DateFilter(from, to));
            }
            catch (QbposException) when (seen.Count == 0)
            {
                // This version doesn't take the date filter: read every receipt once and keep the chosen dates.
                progress?.Report("Reading all sales (this version doesn’t filter by date)…");
                diagnostics?.Note("SalesReceiptQuery date filter was refused; read all receipts instead.");
                foreach (var r in Query("SalesReceiptQuery", "SalesReceiptRet", options.Version).Select(QbposXml.ParseSalesReceipt))
                {
                    if (r.Date is { } d && d >= options.SalesFrom && d <= options.SalesTo && seen.Add(r.TxnId)) data.SalesReceipts.Add(r);
                }
                progress?.Report($"Read {data.SalesReceipts.Count:N0} receipts.");
                return;
            }
            foreach (var r in records.Select(QbposXml.ParseSalesReceipt))
            {
                if (seen.Add(r.TxnId)) data.SalesReceipts.Add(r);
            }
            month = month.AddMonths(1);
        }
        progress?.Report($"Read {data.SalesReceipts.Count:N0} receipts.");
    }

    /// <summary>The date filter for SalesReceiptQueryRq.</summary>
    public static IEnumerable<XElement> DateFilter(DateOnly from, DateOnly to) =>
        new[]
        {
            new XElement("TxnDateRangeFilter",
                new XElement("FromTxnDate", from.ToString("yyyy-MM-dd")),
                new XElement("ToTxnDate", to.ToString("yyyy-MM-dd"))),
        };

    private IReadOnlyList<XElement> Query(string query, string ret, string version, IEnumerable<XElement>? filter = null)
    {
        var request = QbposXml.Request(query, version, filter);
        string response;
        try
        {
            response = connection.ProcessRequest(request);
        }
        catch (Exception e) when (e is not QbposException)
        {
            diagnostics?.Record(query, request, null, e.Message);
            throw new QbposException($"QuickBooks POS couldn’t answer {query}: {e.Message}");
        }
        try
        {
            var records = QbposXml.Records(response, query, ret);
            diagnostics?.Record(query, request, response, null);
            return records;
        }
        catch (QbposException e)
        {
            diagnostics?.Record(query, request, response, e.Message);
            throw;
        }
    }
}
