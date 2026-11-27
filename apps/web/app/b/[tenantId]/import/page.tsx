import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatDateTime, homeTimeZone } from '@/lib/time';
import type { CurrentTenant, Location } from '@/lib/types';
import { startImport, undoImport } from '../import-actions';

interface BatchRow {
  id: string;
  kind: keyof typeof KIND;
  source: 'qbpos' | 'ample' | 'other';
  fileName: string;
  status: 'preview' | 'committed' | 'undone';
  stats: { created?: number; updated?: number; failed?: number; stockSet?: number; receipts?: number };
  createdAt: string;
  committedAt: string | null;
  by: string | null;
}

const KIND = {
  products: 'Products & stock',
  customers: 'Customers',
  suppliers: 'Suppliers',
  gift_cards: 'Gift card balances',
  loyalty: 'Loyalty points',
  sales: 'Sales history',
} as const;

/** What an import did, in words. */
function result(b: Pick<BatchRow, 'kind' | 'stats'>) {
  const { created = 0, updated = 0, failed = 0, stockSet = 0, receipts } = b.stats;
  const skipped = failed ? `, ${failed} rows skipped` : '';
  if (b.kind === 'sales') return `${created.toLocaleString('en-US')} lines from ${(receipts ?? 0).toLocaleString('en-US')} receipts${skipped}`;
  if (b.kind === 'loyalty') return `Points set for ${updated.toLocaleString('en-US')} customers${skipped}`;
  if (b.kind === 'gift_cards') return `${created} cards added, ${updated} balances updated${skipped}`;
  return `${created} added, ${updated} updated${stockSet ? `, stock set for ${stockSet}` : ''}${skipped}`;
}
const SOURCE = { qbpos: 'QuickBooks POS', ample: 'Ample POS export', other: 'Other system' } as const;
const STATUS = {
  preview: ['Not imported', 'bg-stone-100 text-stone-600'],
  committed: ['Imported', 'bg-brand-soft text-brand'],
  undone: ['Undone', 'bg-amber-50 text-amber-800'],
} as const;

export default async function ImportPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ done?: string }> }) {
  const { tenantId } = await params;
  const { done } = await searchParams;
  const [batches, locations, current] = await Promise.all([
    api<BatchRow[]>('/imports', { tenantId }),
    api<Location[]>('/locations', { tenantId }),
    api<CurrentTenant>('/tenant', { tenantId }),
  ]);
  const on = new Set(current.enabledModules);
  const zone = homeTimeZone(locations);
  const finished = batches.find((b) => b.id === done && b.status === 'committed');

  return (
    <div className="max-w-5xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Import & export</h1>
        <p className="mt-1 max-w-3xl text-stone-600">
          Moving from QuickBooks POS or another system? Bring your products, stock, customers, suppliers, gift card balances, loyalty points and past sales in
          from Excel or CSV files. You’ll see exactly what will change before anything is saved, and you can undo an import afterwards.
        </p>
      </header>

      {finished && (
        <div className="rounded-xl border border-teal-200 bg-brand-soft px-5 py-4 text-sm">
          <p className="font-medium text-brand">Imported {finished.fileName}</p>
          <p className="mt-1 text-stone-700">{result(finished)}.</p>
        </div>
      )}

      <section className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <ActionForm action={startImport.bind(null, tenantId)} className="card grid content-start gap-4">
          <h2 className="text-lg font-semibold">Import a file</h2>
          <label className="block text-sm">
            What’s in the file
            <select name="kind" className="input mt-1" defaultValue="products">
              <option value="products">Products & stock (item list)</option>
              <option value="customers">Customers</option>
              <option value="suppliers">Suppliers (vendors)</option>
              {on.has('gift-cards') && <option value="gift_cards">Gift card balances</option>}
              {on.has('loyalty') && <option value="loyalty">Loyalty points</option>}
              <option value="sales">Sales history (past receipts)</option>
            </select>
          </label>
          <label className="block text-sm">
            Where it came from
            <select name="source" className="input mt-1" defaultValue="qbpos">
              <option value="qbpos">QuickBooks POS</option>
              <option value="ample">Ample POS export</option>
              <option value="other">Another system or spreadsheet</option>
            </select>
          </label>
          <label className="block text-sm">
            Location (stock for products, the store for sales history)
            <select name="locationId" className="input mt-1" defaultValue={locations[0]?.id ?? ''}>
              <option value="">None: don’t set stock</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Excel or CSV file
            <input
              name="file"
              type="file"
              accept=".xlsx,.csv,.txt,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
              className="input mt-1 file:mr-3 file:rounded-md file:border-0 file:bg-brand-soft file:px-3 file:py-1 file:text-brand"
            />
          </label>
          <button className="btn justify-self-start">Upload and preview</button>
          <p className="text-xs text-stone-500">Up to 20,000 rows. Nothing is saved until you check the preview and choose Import.</p>
        </ActionForm>

        <div className="card space-y-3 text-sm text-stone-700">
          <h2 className="text-lg font-semibold text-stone-900">Exporting from QuickBooks POS</h2>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              In QuickBooks POS, open the <strong>Item List</strong> (Inventory → Item List). Show the columns you want to bring over, such as Item Number, Item
              Name, Attribute, Size, Department, Regular Price, Average Unit Cost, UPC, Alternate Lookup and On-hand quantity.
            </li>
            <li>
              Export the list to Excel (right-click the list, or use File → Utilities → Export, depending on your version) and save the workbook. Upload the{' '}
              <strong>.xlsx</strong> file as it is: no need to convert it to CSV. Only the first sheet is read.
            </li>
            <li>Do the same for the Customer List and the Vendor List if you want those too.</li>
            <li>
              For gift cards, export the <strong>Gift Card</strong> list with the card number and balance. For loyalty, export the Customer List with the points
              (rewards) balance column.
            </li>
            <li>
              For sales history, run the <strong>Sales History</strong> report by item (Reports → Sales → Sales History, detail) for the dates you want and
              export it. Keep the receipt number, date, item number, item name, quantity, extended price, tax and customer columns.
            </li>
            <li>Import products first, then customers and suppliers, then gift cards, loyalty points and sales history.</li>
          </ol>
          <p className="text-xs text-stone-500">
            Items with an attribute or size (matrix items) become one product with variants. Items are matched by item number, then barcode, so you can import
            an updated file again later. Gift cards and points are set to the balance in the file. Past sales show in reports and on customers, without changing
            stock or your till.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Past imports</h2>
          {batches.some((b) => b.status === 'committed') && (
            <Link href={`/b/${tenantId}/import/reconciliation`} className="text-sm font-medium text-brand hover:underline">
              Check the migration: file totals against Ample POS →
            </Link>
          )}
        </div>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-5 py-3 font-medium">File</th>
                <th className="px-5 py-3 font-medium">What</th>
                <th className="px-5 py-3 font-medium">Result</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {batches.map((b) => (
                <tr key={b.id} className="align-top">
                  <td className="px-5 py-3">
                    <div className="font-medium">{b.fileName}</div>
                    <div className="text-xs text-stone-500">
                      {formatDateTime(b.committedAt ?? b.createdAt, zone)}
                      {b.by ? ` · ${b.by}` : ''}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    {KIND[b.kind]}
                    <div className="text-xs text-stone-500">{SOURCE[b.source]}</div>
                  </td>
                  <td className="px-5 py-3 text-stone-600">{b.status === 'preview' ? '—' : result(b)}</td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[b.status][1]}`}>{STATUS[b.status][0]}</span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    {b.status === 'preview' && (
                      <Link href={`/b/${tenantId}/import/${b.id}`} className="text-xs text-brand hover:underline">
                        Open preview
                      </Link>
                    )}
                    {b.status === 'committed' && (
                      <ActionForm action={undoImport.bind(null, tenantId, b.id)}>
                        <button className="text-xs text-red-700 hover:underline">Undo</button>
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-6 text-stone-500">
                    No imports yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">Export</h2>
        <p className="text-sm text-stone-600">
          Download your data as CSV files that open in Excel. They use the same columns the import reads, so you can edit a file and import it back with “Ample
          POS export”.
        </p>
        <div className="flex flex-wrap gap-2">
          {on.has('catalog') && (
            <a href={`/b/${tenantId}/import/export/products`} className="btn-secondary">
              Products
            </a>
          )}
          {on.has('catalog') &&
            on.has('inventory') &&
            locations.map((l) => (
              <a key={l.id} href={`/b/${tenantId}/import/export/products?locationId=${l.id}`} className="btn-secondary">
                Products with stock at {l.name}
              </a>
            ))}
          {on.has('customers') && (
            <a href={`/b/${tenantId}/import/export/customers`} className="btn-secondary">
              Customers
            </a>
          )}
          {on.has('purchasing') && (
            <a href={`/b/${tenantId}/import/export/suppliers`} className="btn-secondary">
              Suppliers
            </a>
          )}
        </div>
      </section>
    </div>
  );
}
