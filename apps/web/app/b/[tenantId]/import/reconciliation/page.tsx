import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatDateTime, homeTimeZone } from '@/lib/time';
import type { Location } from '@/lib/types';
import { signOffMigration } from '../../import-actions';

type Unit = 'count' | 'units' | 'money' | 'points';
interface Check {
  key: string;
  label: string;
  unit: Unit;
  file: number;
  ample: number;
  ok: boolean;
  note?: string;
}
interface ImportReport {
  id: string;
  kind: 'products' | 'customers' | 'suppliers' | 'gift_cards' | 'loyalty' | 'sales';
  fileName: string;
  committedAt: string | null;
  location: string | null;
  rows: number;
  skippedRows: number;
  fileKept: boolean;
  checks: Check[];
  differences: { line: number; item: string; problem: string; file: string | null; ample: string | null }[];
  differenceCount: number;
}
interface Report {
  generatedAt: string;
  imports: ImportReport[];
  summary: { imports: number; checks: number; matching: number; differences: number };
  signoff: { id: string; signedAt: string; note: string | null; by: string | null } | null;
}

const KIND = {
  products: 'Products & stock',
  customers: 'Customers',
  suppliers: 'Suppliers',
  gift_cards: 'Gift card balances',
  loyalty: 'Loyalty points',
  sales: 'Sales history',
} as const;

const fmt = (unit: Unit, n: number) =>
  unit === 'money' ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100) : n.toLocaleString('en-US');
const diff = (unit: Unit, n: number) => (n === 0 ? '—' : `${n > 0 ? '+' : '−'}${fmt(unit, Math.abs(n))}`);

export default async function ReconciliationPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [report, locations] = await Promise.all([api<Report>('/migration/reconciliation', { tenantId }), api<Location[]>('/locations', { tenantId })]);
  const zone = homeTimeZone(locations);
  const { summary } = report;
  const allMatch = summary.imports > 0 && summary.matching === summary.checks && summary.differences === 0;

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={`/b/${tenantId}/import`} className="text-sm text-stone-500 hover:underline">
            ← Import & export
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">Check the migration</h1>
          <p className="max-w-3xl text-stone-600">
            What each file from your old system said, next to what Ample POS has now. When the numbers agree (or you know why they don’t), sign it off.
          </p>
        </div>
        {summary.imports > 0 && (
          <a href={`/b/${tenantId}/import/reconciliation/download`} className="btn-secondary">
            Download CSV
          </a>
        )}
      </header>

      {summary.imports === 0 ? (
        <div className="card text-stone-600">
          Nothing has been imported yet.{' '}
          <Link href={`/b/${tenantId}/import`} className="text-brand hover:underline">
            Import a file
          </Link>{' '}
          and its numbers show up here.
        </div>
      ) : (
        <div className={`rounded-xl border px-5 py-4 ${allMatch ? 'border-teal-200 bg-brand-soft' : 'border-amber-200 bg-amber-50'}`}>
          <p className={`font-medium ${allMatch ? 'text-brand' : 'text-amber-900'}`}>
            {allMatch
              ? `Everything matches: ${summary.checks} checks across ${summary.imports} imports.`
              : `${summary.checks - summary.matching} of ${summary.checks} checks differ, with ${summary.differences.toLocaleString('en-US')} ${summary.differences === 1 ? 'line' : 'lines'} to look at.`}
          </p>
          {!allMatch && (
            <p className="mt-1 text-sm text-stone-700">
              Differences aren’t always mistakes: a sale or a price change since the import shows up here too. Each one is listed under its import.
            </p>
          )}
        </div>
      )}

      {report.imports.map((i) => (
        <section key={i.id} className="card space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">{KIND[i.kind]}</h2>
              <p className="text-sm text-stone-500">
                {i.fileName}
                {i.location && ` · ${i.location}`}
                {i.committedAt && ` · imported ${formatDateTime(i.committedAt, zone)}`}
              </p>
            </div>
            {i.skippedRows > 0 && (
              <span className="text-sm text-amber-800">
                {i.skippedRows} of {i.rows} rows were skipped when importing and aren’t counted
              </span>
            )}
          </div>

          {!i.fileKept ? (
            <p className="text-sm text-stone-600">This file was imported before the report existed, so its rows weren’t kept. Import it again to compare.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-stone-500">
                <tr>
                  <th className="pb-2 font-medium">Check</th>
                  <th className="pb-2 text-right font-medium">In the file</th>
                  <th className="pb-2 text-right font-medium">In Ample POS</th>
                  <th className="pb-2 text-right font-medium">Difference</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {i.checks.map((c) => (
                  <tr key={c.key} className="border-t border-stone-100 align-top">
                    <td className="py-2">
                      {c.label}
                      {c.note && <div className="text-xs text-stone-500">{c.note}</div>}
                    </td>
                    <td className="py-2 text-right tabular-nums">{fmt(c.unit, c.file)}</td>
                    <td className="py-2 text-right tabular-nums">{fmt(c.unit, c.ample)}</td>
                    <td className={`py-2 text-right tabular-nums ${c.ok ? 'text-stone-400' : 'font-medium text-amber-800'}`}>
                      {diff(c.unit, c.ample - c.file)}
                    </td>
                    <td className="py-2 pl-3 text-right">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.ok ? 'bg-brand-soft text-brand' : 'bg-amber-50 text-amber-800'}`}>
                        {c.ok ? 'Matches' : 'Differs'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {i.differenceCount > 0 && (
            <details className="rounded-lg border border-stone-200">
              <summary className="cursor-pointer px-4 py-2 text-sm font-medium">
                {i.differenceCount.toLocaleString('en-US')} {i.differenceCount === 1 ? 'line differs' : 'lines differ'}
                {i.differenceCount > i.differences.length && ` (first ${i.differences.length} shown; the CSV has them all)`}
              </summary>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 text-left text-stone-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Line</th>
                      <th className="px-4 py-2 font-medium">Item</th>
                      <th className="px-4 py-2 font-medium">What</th>
                      <th className="px-4 py-2 text-right font-medium">In the file</th>
                      <th className="px-4 py-2 text-right font-medium">In Ample POS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {i.differences.map((d, n) => (
                      <tr key={n} className="border-t border-stone-100">
                        <td className="px-4 py-1.5 text-stone-500">{d.line}</td>
                        <td className="px-4 py-1.5">{d.item}</td>
                        <td className="px-4 py-1.5">{d.problem}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{d.file ?? '—'}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{d.ample ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </section>
      ))}

      {summary.imports > 0 && (
        <section className="card space-y-3 border-navy/15">
          <h2 className="text-lg font-semibold">Sign off</h2>
          {report.signoff && (
            <p className="text-sm text-stone-700">
              Last signed off by <strong>{report.signoff.by ?? 'the owner'}</strong> on {formatDateTime(report.signoff.signedAt, zone)}
              {report.signoff.note && <>: “{report.signoff.note}”</>}. Imports since then aren’t covered.
            </p>
          )}
          <ActionForm action={signOffMigration.bind(null, tenantId)} className="grid gap-3">
            <label className="block text-sm">
              Note (optional): anything you checked or that explains a difference
              <textarea
                name="note"
                rows={2}
                maxLength={1000}
                className="input mt-1"
                placeholder="e.g. Jacket repriced on purpose; one damaged and written off"
              />
            </label>
            <button className="btn justify-self-start">I’ve checked this: sign off the migration</button>
          </ActionForm>
          <p className="text-xs text-stone-500">The report as it stands now is kept with your name and the date, and the sign-off appears in the audit log.</p>
        </section>
      )}
    </div>
  );
}
