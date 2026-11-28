namespace AmpleMigration;

/// <summary>One file sent to Ample POS, and what happened to it.</summary>
public sealed class UploadedFile(ImportFile file)
{
    public ImportFile File { get; } = file;
    public Preview? Preview { get; set; }
    public CommitResult? Result { get; set; }
    public string? Error { get; set; }
}

/// <summary>
/// The migration: builds the import files from what was read, uploads them for
/// preview (nothing changes in Ample POS yet), then imports them in an order
/// where each step finds what it needs (departments travel with items; vendors
/// and customers before sales history).
/// </summary>
public sealed class Migration(AmpleClient ample)
{
    public static IReadOnlyList<ImportFile> Files(QbposData data, ReadOptions options)
    {
        var files = new List<ImportFile>();
        if (options.Items) files.AddRange(ImportFiles.Items(data));
        if (options.Vendors) files.AddRange(ImportFiles.Vendors(data));
        if (options.Customers) files.AddRange(ImportFiles.Customers(data));
        if (options.Sales) files.AddRange(ImportFiles.Sales(data));
        return files;
    }

    public async Task<IReadOnlyList<UploadedFile>> PreviewAsync(IEnumerable<ImportFile> files, string? itemsLocationId, IProgress<string>? progress = null, CancellationToken cancel = default)
    {
        var uploaded = new List<UploadedFile>();
        foreach (var file in files)
        {
            cancel.ThrowIfCancellationRequested();
            var u = new UploadedFile(file);
            uploaded.Add(u);
            progress?.Report($"Sending {file.Name} ({file.Rows:N0} rows)…");
            try
            {
                // Stock is set at the chosen store; sales history is recorded there too.
                var location = file.Kind is "products" or "sales" ? itemsLocationId : null;
                u.Preview = await ample.StartImportAsync(file, location, cancel);
            }
            catch (AmpleException e)
            {
                u.Error = e.Message;
            }
        }
        return uploaded;
    }

    public async Task CommitAsync(IEnumerable<UploadedFile> files, IProgress<string>? progress = null, CancellationToken cancel = default)
    {
        foreach (var u in files.Where(f => f.Preview is not null && f.Result is null))
        {
            cancel.ThrowIfCancellationRequested();
            progress?.Report($"Importing {u.File.Name}…");
            try
            {
                u.Result = await ample.CommitAsync(u.Preview!.BatchId, cancel);
            }
            catch (AmpleException e)
            {
                u.Error = e.Message;
                // Later steps depend on earlier ones (sales need items); stop here.
                throw new AmpleException($"{u.File.Name}: {e.Message}");
            }
        }
    }
}
