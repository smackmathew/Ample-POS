# Ample POS Migration Assistant

A Windows app that reads a QuickBooks POS company through Intuit's QuickBooks
POS SDK and brings it into Ample POS through the same imports as a file upload
(preview, undo and the reconciliation report included). It only reads
QuickBooks POS; nothing there is changed.

- `src/AmpleMigration.Core`: qbposXML requests and parsing, turning records
  into the columns of QuickBooks POS's own list exports, splitting long lists
  (20,000 rows per import, never splitting the sizes of one item), and the
  Ample POS API client. Cross-platform and unit-tested.
- `src/AmpleMigration.App`: the Windows app (WinForms, 32-bit, because the
  SDK's request processor `QBPOSXMLRPLib.RequestProcessor` is a 32-bit COM
  component). Published as one self-contained `.exe`, so stores don't need
  .NET installed.
- `tests/AmpleMigration.Tests`: xUnit. `LiveTests` runs the whole flow against
  a running Ample POS when `AMPLE_TEST_SITE` and `AMPLE_TEST_CODE` are set.

## What it reads

| QuickBooks POS (SDK query) | Becomes in Ample POS |
|---|---|
| `DepartmentQuery`, `ItemInventoryQuery` (ItemNumber, Desc1, Desc2, Attribute, Size, DepartmentListID, Price1, Cost, UPC, ALU, QuantityOnHand) | Products with variants, categories, prices, costs, barcodes, and stock at the chosen store |
| `CustomerQuery` (FirstName, LastName, CompanyName, EMail, Phone, Notes) | Customers |
| `VendorQuery` (CompanyName, FirstName, LastName, EMail, Phone) | Suppliers |
| `SalesReceiptQuery`, a month at a time (TxnDateRangeFilter) | Sales history: one line per item; the receipt's tax shared over its lines; returns negative; voided receipts left out |

Connection: `OpenConnection("", "Ample POS Migration Assistant")`, then
`BeginSession("Computer Name=…;Company Data=…;Version=…")`, qbposXML 3.0
requests through `ProcessRequest`.

## Pairing

Import & export → *Make a pairing code* gives a code valid once for 15 minutes.
The Assistant trades it (`POST /api/migration/assistant/pair`) for an API key
that can only import (`data.manage`), named after the PC. The key is stored for
the Windows user, encrypted with DPAPI. Remove it in API & webhooks when done.

## Build

```sh
dotnet test tests/AmpleMigration.Tests
dotnet publish src/AmpleMigration.App -c Release -o publish   # works on Linux too
```

The Dockerfile builds it on every deploy and puts it in the web app's
`public/downloads`, where the Import & export page offers it.

## First test on a real store PC (QuickBooks POS 18 or 19)

The SDK formats come from Intuit's documentation; this checks them on a real
company. Use a copy of the company, or a test business in Ample POS.

1. In Ample POS (a test business is best): Locations → add a store. Import &
   export → *Download the Migration Assistant*, then *Make a pairing code*.
2. On the QuickBooks POS PC, open QuickBooks POS on the company and sign in as
   an administrator. Run the Assistant.
3. Step 1: the Ample POS address and the code → *Connect*.
4. Step 2: the computer name (filled in), the company data name exactly as
   QuickBooks POS shows it, and the version.
5. Step 3: tick everything, sales since a recent month (keeps the first test
   quick) → *Read from QuickBooks POS*. QuickBooks POS asks whether to allow
   the Assistant the first time: allow it.
6. Step 4: *Send for preview*. Compare the counts with QuickBooks POS (number
   of items, customers, vendors). Then *Import everything* and open the
   migration report.
7. Whatever happens, choose *Save diagnostic file…* and send it over. It holds
   each request, QuickBooks POS's status answers and the first three records
   of each kind, with names, emails, phones and addresses masked. If a field
   is named differently in your version, that file shows it.

Things to look at in particular: department names on products, matrix items
(attribute/size) becoming one product with variants, the on-hand quantity, and
whether sales came in month by month or the log says the date filter was refused.
