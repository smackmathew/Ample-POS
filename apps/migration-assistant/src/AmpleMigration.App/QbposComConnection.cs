using System.Reflection;
using System.Runtime.InteropServices;

namespace AmpleMigration.App;

/// <summary>
/// QuickBooks POS's SDK request processor (COM, installed with QuickBooks POS).
/// The first connection makes QuickBooks POS ask an administrator to allow
/// the Assistant. Call from one STA thread (see StaWorker).
/// </summary>
public sealed class QbposComConnection : IQbposConnection, IDisposable
{
    public const string ProgId = "QBPOSXMLRPLib.RequestProcessor";
    public const string AppName = "Ample POS Migration Assistant";

    private readonly object processor;
    private readonly string ticket;
    private bool open = true;

    /// <summary>"Computer Name=FRONT-PC;Company Data=Harbor Outfitters;Version=19"</summary>
    public static string ConnectionString(string computer, string companyData, string version) =>
        $"Computer Name={computer.Trim()};Company Data={companyData.Trim()};Version={version.Trim()}";

    public QbposComConnection(string connectionString)
    {
        var type = Type.GetTypeFromProgID(ProgId)
            ?? throw new QbposException("The QuickBooks POS SDK isn’t on this computer. Run the Assistant on the computer where QuickBooks POS is installed.");
        processor = Activator.CreateInstance(type) ?? throw new QbposException("Couldn’t start the QuickBooks POS SDK.");
        try
        {
            Call("OpenConnection", "", AppName);
            ticket = (string)Call("BeginSession", connectionString)!;
        }
        catch (QbposException)
        {
            Release();
            throw;
        }
    }

    public string ProcessRequest(string requestXml) => (string)Call("ProcessRequest", ticket, requestXml)!;

    private object? Call(string method, params object[] args)
    {
        try
        {
            return processor.GetType().InvokeMember(method, BindingFlags.InvokeMethod, null, processor, args);
        }
        catch (TargetInvocationException e) when (e.InnerException is COMException com)
        {
            throw new QbposException(Explain(method, com));
        }
        catch (COMException com)
        {
            throw new QbposException(Explain(method, com));
        }
    }

    private static string Explain(string method, COMException e)
    {
        var hint = method switch
        {
            "BeginSession" => " Check that QuickBooks POS is open on this company, that the company name and version are right, and that you allowed the Assistant when QuickBooks POS asked.",
            "OpenConnection" => " QuickBooks POS may need repairing, or the Assistant isn’t allowed to connect.",
            _ => "",
        };
        return $"QuickBooks POS: {e.Message.Trim()} (0x{e.HResult:X8}).{hint}";
    }

    public void Dispose()
    {
        if (!open) return;
        open = false;
        try
        {
            Call("EndSession", ticket);
            Call("CloseConnection");
        }
        catch (QbposException)
        {
        }
        Release();
    }

    private void Release()
    {
        if (Marshal.IsComObject(processor)) Marshal.FinalReleaseComObject(processor);
    }
}

/// <summary>Runs work on one single-threaded-apartment thread, as COM components like QuickBooks POS's expect.</summary>
public static class StaWorker
{
    public static Task<T> Run<T>(Func<T> work)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                done.SetResult(work());
            }
            catch (Exception e)
            {
                done.SetException(e);
            }
        })
        { IsBackground = true, Name = "QuickBooks POS" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return done.Task;
    }
}
