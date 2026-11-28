namespace AmpleMigration;

/// <summary>What QuickBooks POS has, read through its SDK.</summary>
public sealed record Department(string ListId, string Name, string? Code);

public sealed record Item(
    string ListId,
    string? ItemNumber,
    string? Name,
    string? Description,
    string? Attribute,
    string? Size,
    string? DepartmentListId,
    decimal? Price,
    decimal? Cost,
    string? Upc,
    string? Alu,
    decimal? QuantityOnHand);

public sealed record Customer(string ListId, string? FirstName, string? LastName, string? CompanyName, string? Email, string? Phone, string? Notes)
{
    public string DisplayName =>
        string.Join(' ', new[] { FirstName, LastName }.Where(s => !string.IsNullOrWhiteSpace(s))).Trim() is { Length: > 0 } person ? person : CompanyName ?? "";
}

public sealed record Vendor(string ListId, string? CompanyName, string? FirstName, string? LastName, string? Email, string? Phone);

public sealed record SalesReceiptLine(string? ItemNumber, string? Name, decimal Quantity, decimal? Price, decimal? ExtendedPrice);

public sealed record SalesReceipt(
    string TxnId,
    string? Number,
    DateOnly? Date,
    string? CustomerListId,
    bool IsReturn,
    bool IsVoided,
    decimal? Tax,
    IReadOnlyList<SalesReceiptLine> Lines);

/// <summary>Everything read from one QuickBooks POS company.</summary>
public sealed class QbposData
{
    public List<Department> Departments { get; } = new();
    public List<Item> Items { get; } = new();
    public List<Customer> Customers { get; } = new();
    public List<Vendor> Vendors { get; } = new();
    public List<SalesReceipt> SalesReceipts { get; } = new();
}
