using System.Diagnostics;
using System.Drawing;

namespace AmpleMigration.App;

/// <summary>
/// The Assistant's one window: connect to Ample POS, connect to QuickBooks POS,
/// choose what to bring over and read it, then send it for preview and import.
/// </summary>
public sealed class MainForm : Form
{
    private static readonly Color Navy = Color.FromArgb(0x0B, 0x2E, 0x50);
    private static readonly Color Green = Color.FromArgb(0x13, 0x80, 0x3F);

    private readonly Settings settings = Settings.Load();
    private readonly Diagnostics diagnostics = new();
    private CancellationTokenSource? cancel;
    private QbposData? data;
    private ReadOptions? readOptions;
    private IReadOnlyList<UploadedFile>? uploaded;

    // Step 1: Ample POS
    private readonly TextBox site = new() { Width = 320 };
    private readonly TextBox code = new() { Width = 140, CharacterCasing = CharacterCasing.Upper, PlaceholderText = "ABCD-EFGH" };
    private readonly Button connectAmple = new() { Text = "Connect", AutoSize = true };
    private readonly Label ampleStatus = new() { AutoSize = true };

    // Step 2: QuickBooks POS
    private readonly TextBox computer = new() { Width = 200 };
    private readonly TextBox company = new() { Width = 260, PlaceholderText = "the company data name" };
    private readonly ComboBox version = new() { Width = 80, DropDownStyle = ComboBoxStyle.DropDownList };

    // Step 3: what to bring over
    private readonly CheckBox items = new() { Text = "Items, departments and stock", Checked = true, AutoSize = true };
    private readonly ComboBox location = new() { Width = 220, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly CheckBox customers = new() { Text = "Customers", Checked = true, AutoSize = true };
    private readonly CheckBox vendors = new() { Text = "Vendors (suppliers)", Checked = true, AutoSize = true };
    private readonly CheckBox sales = new() { Text = "Sales history since", Checked = true, AutoSize = true };
    private readonly DateTimePicker salesFrom = new() { Width = 130, Format = DateTimePickerFormat.Short };
    private readonly Button read = new() { Text = "Read from QuickBooks POS", AutoSize = true };

    // Step 4: send and import
    private readonly ListView results = new() { View = View.Details, FullRowSelect = true, Height = 150, Dock = DockStyle.Fill, HeaderStyle = ColumnHeaderStyle.Nonclickable };
    private readonly Button preview = new() { Text = "Send for preview", AutoSize = true, Enabled = false };
    private readonly Button import = new() { Text = "Import everything", AutoSize = true, Enabled = false };
    private readonly LinkLabel report = new() { Text = "Open the migration report in Ample POS", AutoSize = true, Visible = false };

    private readonly TextBox log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Height = 110 };
    private readonly Button saveDiagnostics = new() { Text = "Save diagnostic file…", AutoSize = true };
    private readonly Button stop = new() { Text = "Stop", AutoSize = true, Enabled = false };

    public MainForm()
    {
        Text = "Ample POS Migration Assistant";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Font = new Font("Segoe UI", 9.5f);
        MinimumSize = new Size(760, 760);
        Size = new Size(820, 860);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;

        version.Items.AddRange(new object[] { "19", "18", "12", "11" });
        site.Text = settings.Site;
        computer.Text = settings.Computer;
        company.Text = settings.CompanyData;
        version.SelectedItem = version.Items.Contains(settings.Version) ? settings.Version : "19";
        salesFrom.Value = DateTime.Today.AddYears(-2);
        results.Columns.Add("What", 260);
        results.Columns.Add("Rows", 70, HorizontalAlignment.Right);
        results.Columns.Add("New", 70, HorizontalAlignment.Right);
        results.Columns.Add("Update", 70, HorizontalAlignment.Right);
        results.Columns.Add("Skipped", 70, HorizontalAlignment.Right);
        results.Columns.Add("Status", 200);

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(16), AutoScroll = true };
        layout.Controls.Add(Header());
        layout.Controls.Add(Step("1. Connect to Ample POS",
            "In Ample POS, go to Import & export and choose “Make a pairing code”. Type the code here.",
            Row(Label("Ample POS address"), site),
            Row(Label("Pairing code"), code, connectAmple),
            ampleStatus));
        layout.Controls.Add(Step("2. Connect to QuickBooks POS",
            "Run this on the computer with QuickBooks POS, with QuickBooks POS open and signed in as an administrator. " +
            "The company data name is the one you open in QuickBooks POS. The first time, QuickBooks POS asks whether to allow the Assistant: choose yes.",
            Row(Label("Computer name"), computer),
            Row(Label("Company data"), company),
            Row(Label("QuickBooks POS version"), version)));
        layout.Controls.Add(Step("3. Choose what to bring over",
            "Nothing changes in QuickBooks POS: the Assistant only reads.",
            Row(items, Label("stock at", 60), location),
            Row(customers, vendors),
            Row(sales, salesFrom),
            Row(read)));
        var resultsPanel = new Panel { Height = 160, Dock = DockStyle.Top };
        resultsPanel.Controls.Add(results);
        layout.Controls.Add(Step("4. Check and import",
            "“Send for preview” shows what will be added or updated; nothing is saved in Ample POS yet. You can also look at each preview, or undo an import, in Ample POS under Import & export.",
            resultsPanel,
            Row(preview, import, report)));
        layout.Controls.Add(Row(stop, saveDiagnostics));
        var logPanel = new Panel { Height = 120, Dock = DockStyle.Top };
        logPanel.Controls.Add(log);
        layout.Controls.Add(logPanel);
        Controls.Add(layout);

        connectAmple.Click += async (_, _) => await Busy(ConnectAmple);
        read.Click += async (_, _) => await Busy(ReadQbpos);
        preview.Click += async (_, _) => await Busy(SendPreview);
        import.Click += async (_, _) => await Busy(ImportAll);
        stop.Click += (_, _) => cancel?.Cancel();
        report.LinkClicked += (_, _) => Open($"{AmpleClient.NormalizeSite(site.Text)}/b/{settings.TenantId}/import/reconciliation");
        saveDiagnostics.Click += (_, _) => SaveDiagnostics();
        items.CheckedChanged += (_, _) => location.Enabled = items.Checked;
        sales.CheckedChanged += (_, _) => salesFrom.Enabled = sales.Checked;
        Shown += async (_, _) => await Busy(Resume);
    }

    // --- steps -----------------------------------------------------------------

    private async Task Resume(CancellationToken token)
    {
        if (settings.ApiKey is null || settings.BusinessName is null) return;
        ampleStatus.Text = $"Connected to {settings.BusinessName}.";
        ampleStatus.ForeColor = Green;
        await LoadLocations(token);
    }

    private async Task ConnectAmple(CancellationToken token)
    {
        using var client = new AmpleClient(site.Text);
        var pairing = await client.PairAsync(code.Text, computer.Text, token);
        settings.Site = client.SiteAddress;
        settings.TenantId = pairing.TenantId;
        settings.BusinessName = pairing.BusinessName;
        settings.ApiKey = pairing.ApiKey;
        settings.Save();
        code.Text = "";
        ampleStatus.Text = $"Connected to {pairing.BusinessName}.";
        ampleStatus.ForeColor = Green;
        Log($"Connected to {pairing.BusinessName} at {client.SiteAddress}.");
        await LoadLocations(token);
    }

    private async Task LoadLocations(CancellationToken token)
    {
        using var client = Ample();
        var locations = await client.LocationsAsync(token);
        location.Items.Clear();
        foreach (var l in locations) location.Items.Add(new Choice(l.Id, l.Name));
        if (location.Items.Count > 0) location.SelectedIndex = 0;
        else Log("Add a location (store) in Ample POS first: stock and sales history are recorded there.");
    }

    private async Task ReadQbpos(CancellationToken token)
    {
        if (string.IsNullOrWhiteSpace(company.Text)) throw new QbposException("Type the company data name you open in QuickBooks POS.");
        settings.Computer = computer.Text.Trim();
        settings.CompanyData = company.Text.Trim();
        settings.Version = (string)version.SelectedItem!;
        settings.Save();
        readOptions = new ReadOptions(items.Checked, customers.Checked, vendors.Checked, sales.Checked, DateOnly.FromDateTime(salesFrom.Value), DateOnly.FromDateTime(DateTime.Today));
        var connectionString = QbposComConnection.ConnectionString(settings.Computer, settings.CompanyData, settings.Version);
        Log($"Connecting to QuickBooks POS ({connectionString})…");
        var progress = new Progress<string>(Log);
        var options = readOptions;
        data = await StaWorker.Run(() =>
        {
            using var qb = new QbposComConnection(connectionString);
            return new QbposReader(qb, diagnostics).Read(options, progress, token);
        });
        var files = Migration.Files(data, options);
        results.Items.Clear();
        foreach (var f in files) results.Items.Add(new ListViewItem(new[] { f.Name, f.Rows.ToString("N0"), "", "", "", "Read" }));
        uploaded = null;
        preview.Enabled = files.Count > 0;
        import.Enabled = false;
        Log($"Read {data.Items.Count:N0} items, {data.Customers.Count:N0} customers, {data.Vendors.Count:N0} vendors and {data.SalesReceipts.Count:N0} receipts.");
    }

    private async Task SendPreview(CancellationToken token)
    {
        if (data is null || readOptions is null) return;
        if ((readOptions.Items || readOptions.Sales) && location.SelectedItem is not Choice)
        {
            throw new AmpleException("Choose the store (location) for stock and sales history.");
        }
        using var client = Ample();
        uploaded = await new Migration(client).PreviewAsync(Migration.Files(data, readOptions), (location.SelectedItem as Choice)?.Id, new Progress<string>(Log), token);
        ShowResults();
        import.Enabled = uploaded.Any(u => u.Preview is not null);
        Log("Previews are ready. Check the numbers, then choose Import everything.");
    }

    private async Task ImportAll(CancellationToken token)
    {
        if (uploaded is null) return;
        var answer = MessageBox.Show(this, "Import everything into Ample POS now? You can undo each import afterwards in Ample POS, under Import & export.",
            Text, MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
        if (answer != DialogResult.OK) return;
        using var client = Ample();
        try
        {
            await new Migration(client).CommitAsync(uploaded, new Progress<string>(Log), token);
        }
        finally
        {
            ShowResults();
        }
        import.Enabled = false;
        var summary = await client.ReconciliationAsync(token);
        Log(summary.Checks == summary.Matching
            ? $"Done. The migration report shows all {summary.Checks} checks matching."
            : $"Done. The migration report shows {summary.Checks - summary.Matching} of {summary.Checks} checks differing; open it to see where.");
        report.Visible = true;
    }

    private void ShowResults()
    {
        if (uploaded is null) return;
        results.Items.Clear();
        foreach (var u in uploaded)
        {
            var c = u.Preview?.Counts;
            var status = u.Error ?? (u.Result is { } r ? $"Imported: {r.Created:N0} new, {r.Updated:N0} updated" : u.Preview is not null ? "Ready to import" : "");
            results.Items.Add(new ListViewItem(new[]
            {
                u.File.Name, u.File.Rows.ToString("N0"), c?.Create.ToString("N0") ?? "", c?.Update.ToString("N0") ?? "", c?.Error.ToString("N0") ?? "", status,
            }) { ForeColor = u.Error is null ? Color.Black : Color.Firebrick });
        }
    }

    // --- helpers ---------------------------------------------------------------

    private AmpleClient Ample()
    {
        var key = settings.ApiKey ?? throw new AmpleException("Connect to Ample POS first (step 1).");
        return new AmpleClient(settings.Site, key);
    }

    private async Task Busy(Func<CancellationToken, Task> work)
    {
        cancel = new CancellationTokenSource();
        UseWaitCursor = true;
        foreach (var b in new[] { connectAmple, read, preview, import }) b.Tag = b.Enabled;
        foreach (var b in new[] { connectAmple, read, preview, import }) b.Enabled = false;
        stop.Enabled = true;
        try
        {
            await work(cancel.Token);
        }
        catch (OperationCanceledException)
        {
            Log("Stopped.");
        }
        catch (Exception e) when (e is QbposException or AmpleException)
        {
            Log(e.Message);
            MessageBox.Show(this, e.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception e)
        {
            diagnostics.Note(e.ToString());
            Log($"Something went wrong: {e.Message}");
            MessageBox.Show(this, $"Something went wrong: {e.Message}\n\nSave a diagnostic file and send it to Ample POS support.", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            foreach (var b in new[] { connectAmple, read, preview, import }) b.Enabled = b.Tag is true;
            connectAmple.Enabled = read.Enabled = true;
            stop.Enabled = false;
            UseWaitCursor = false;
        }
    }

    private void SaveDiagnostics()
    {
        using var dialog = new SaveFileDialog { FileName = $"ample-migration-diagnostics-{DateTime.Now:yyyyMMdd-HHmm}.txt", Filter = "Text file|*.txt" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        var header = $"Ample POS Migration Assistant {Application.ProductVersion}\nQuickBooks POS version {settings.Version}\nWindows {Environment.OSVersion}\n" +
            "Names, emails, phone numbers and addresses are masked.\n\n--- log\n" + log.Text;
        File.WriteAllText(dialog.FileName, diagnostics.Report(header));
        Log($"Saved {dialog.FileName}");
    }

    private void Log(string line) => log.AppendText($"{DateTime.Now:HH:mm:ss}  {line}{Environment.NewLine}");

    private static void Open(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });

    private static Control Header()
    {
        var title = new Label { Text = "Move from QuickBooks POS to Ample POS", AutoSize = true, Font = new Font("Segoe UI Semibold", 15f), ForeColor = Navy };
        var sub = new Label
        {
            Text = "Reads your QuickBooks POS data on this computer and brings it into Ample POS. Nothing in QuickBooks POS is changed.",
            AutoSize = true,
            MaximumSize = new Size(720, 0),
            ForeColor = Color.DimGray,
        };
        var panel = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Margin = new Padding(0, 0, 0, 8) };
        panel.Controls.Add(title);
        panel.Controls.Add(sub);
        return panel;
    }

    private static Control Step(string title, string help, params Control[] controls)
    {
        var box = new GroupBox { Text = title, AutoSize = true, Dock = DockStyle.Top, Padding = new Padding(10), ForeColor = Navy, Margin = new Padding(0, 6, 0, 6) };
        var flow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Dock = DockStyle.Fill, WrapContents = false, ForeColor = Color.Black };
        flow.Controls.Add(new Label { Text = help, AutoSize = true, MaximumSize = new Size(700, 0), ForeColor = Color.DimGray, Margin = new Padding(3, 3, 3, 8) });
        foreach (var c in controls)
        {
            if (c is Panel p && p is not FlowLayoutPanel) p.Width = 700;
            flow.Controls.Add(c);
        }
        box.Controls.Add(flow);
        return box;
    }

    private static FlowLayoutPanel Row(params Control[] controls)
    {
        var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 2, 0, 2) };
        foreach (var c in controls)
        {
            c.Margin = new Padding(3, 4, 6, 4);
            row.Controls.Add(c);
        }
        return row;
    }

    private static Label Label(string text, int width = 170) => new() { Text = text, AutoSize = false, Width = width, Height = 26, TextAlign = ContentAlignment.MiddleLeft };

    private sealed record Choice(string Id, string Name)
    {
        public override string ToString() => Name;
    }
}
