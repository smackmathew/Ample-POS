import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import type { Location } from '@/lib/types';
import { commitImport, saveMapping } from '../../import-actions';

interface Preview {
  batch: {
    id: string;
    kind: keyof typeof WHAT;
    source: 'qbpos' | 'ample' | 'other';
    fileName: string;
    locationId: string | null;
    status: 'preview' | 'committed' | 'undone';
    headers: string[];
    mapping: Record<string, string | null>;
  };
  fields: { key: string; label: string }[];
  counts: { rows?: number; create?: number; update?: number; error?: number; warnings?: number };
  planned: { line: number; action: 'create' | 'update' | 'error'; label: string; errors: string[] }[];
}

const WHAT = {
  products: 'products',
  customers: 'customers',
  suppliers: 'suppliers',
  gift_cards: 'gift cards',
  loyalty: 'point balances',
  sales: 'sales lines',
} as const;
const ACTION = {
  create: ['New', 'bg-brand-soft text-brand'],
  update: ['Update', 'bg-sky-50 text-sky-800'],
  error: ['Skipped', 'bg-red-50 text-red-700'],
} as const;

export default async function ImportPreviewPage({ params }: { params: Promise<{ tenantId: string; batchId: string }> }) {
  const { tenantId, batchId } = await params;
  const [preview, locations] = await Promise.all([api<Preview>(`/imports/${batchId}`, { tenantId }), api<Location[]>('/locations', { tenantId })]);
  const { batch, counts, planned, fields } = preview;
  const what = WHAT[batch.kind];
  const importable = (counts.create ?? 0) + (counts.update ?? 0);

  if (batch.status !== 'preview') {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold">{batch.fileName}</h1>
        <p className="text-stone-600">This file has already been {batch.status === 'undone' ? 'imported and undone' : 'imported'}.</p>
        <Link href={`/b/${tenantId}/import`} className="btn-secondary">
          Back to Import & export
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={`/b/${tenantId}/import`} className="text-sm text-stone-500 hover:underline">
            ← Import & export
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">Check before importing</h1>
          <p className="text-stone-600">
            {batch.fileName} · {counts.rows ?? 0} rows
          </p>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        {batch.kind !== 'loyalty' && <Tile label={`New ${what}`} value={counts.create ?? 0} tone="text-brand" />}
        {batch.kind !== 'sales' && <Tile label={`${what[0]!.toUpperCase()}${what.slice(1)} to update`} value={counts.update ?? 0} tone="text-sky-800" />}
        <Tile label="Rows skipped" value={counts.error ?? 0} tone={counts.error ? 'text-red-700' : 'text-stone-900'} />
      </section>

      <ActionForm
        action={commitImport.bind(null, tenantId, batch.id)}
        className="card flex flex-wrap items-center justify-between gap-3 border-teal-200 bg-brand-soft"
      >
        <p className="text-sm text-stone-700">
          {importable
            ? batch.kind === 'sales' && !batch.locationId
              ? 'Choose the store these sales were made at under Columns, then update the preview.'
              : `${summary(batch.kind, counts.create ?? 0, counts.update ?? 0, Boolean(batch.locationId))} You can undo it afterwards.`
            : 'Nothing to import yet: check the columns below.'}
        </p>
        <button className="btn" disabled={!importable || (batch.kind === 'sales' && !batch.locationId)}>
          Import {importable} {what}
        </button>
      </ActionForm>

      <ActionForm
        action={saveMapping.bind(
          null,
          tenantId,
          batch.id,
          fields.map((f) => f.key),
        )}
        className="card grid gap-4"
      >
        <div>
          <h2 className="text-lg font-semibold">Columns</h2>
          <p className="text-sm text-stone-600">
            Each piece of information and the column of your file it comes from. Change any that are wrong, then update the preview.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map((f) => (
            <label key={f.key} className="block text-sm">
              {f.label}
              <select name={`map_${f.key}`} defaultValue={batch.mapping[f.key] ?? ''} className="input mt-1">
                <option value="">Not in this file</option>
                {batch.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {(batch.kind === 'products' || batch.kind === 'sales') && (
            <label className="block text-sm">
              {batch.kind === 'sales' ? 'Store these sales were made at' : 'Set stock at'}
              <select name="locationId" defaultValue={batch.locationId ?? ''} className="input mt-1">
                <option value="">{batch.kind === 'sales' ? 'Choose a location' : 'Don’t set stock'}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <button className="btn-secondary justify-self-start">Update preview</button>
      </ActionForm>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Rows</h2>
        <p className="text-sm text-stone-600">The first rows of the file, then every row with a problem.</p>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-5 py-3 font-medium">Line</th>
                <th className="px-5 py-3 font-medium">What happens</th>
                <th className="px-5 py-3 font-medium">Item</th>
                <th className="px-5 py-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {planned.map((p) => (
                <tr key={p.line} className="align-top">
                  <td className="px-5 py-2.5 text-stone-500">{p.line}</td>
                  <td className="px-5 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ACTION[p.action][1]}`}>{ACTION[p.action][0]}</span>
                  </td>
                  <td className="px-5 py-2.5">{p.label || <span className="text-stone-400">—</span>}</td>
                  <td className={`px-5 py-2.5 text-xs ${p.action === 'error' ? 'text-red-700' : 'text-amber-800'}`}>{p.errors.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function summary(kind: keyof typeof WHAT, create: number, update: number, stock: boolean) {
  if (kind === 'sales') return `Import adds ${create} lines of past sales to your reports and customers. Stock and your till are not changed.`;
  if (kind === 'loyalty') return `Import sets the points balance of ${update} customers to the number in the file.`;
  if (kind === 'gift_cards') return `Import adds ${create} gift cards and sets the balance of ${update} existing ones.`;
  return `Import adds ${create} and updates ${update} ${WHAT[kind]}${kind === 'products' && stock ? ', and sets their stock' : ''}.`;
}

function Tile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="card p-5">
      <p className="text-sm text-stone-500">{label}</p>
      <p className={`mt-1 text-3xl font-semibold tracking-tight ${tone}`}>{value.toLocaleString('en-US')}</p>
    </div>
  );
}
