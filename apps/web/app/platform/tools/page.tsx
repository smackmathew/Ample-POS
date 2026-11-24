import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { usd, type PlatformTool } from '@/lib/platform';
import { setPlatformPrice } from '../actions';
import { Availability } from './availability';

export default async function ToolsPage() {
  const tools = await api<PlatformTool[]>('/platform/tools');
  return (
    <div className="max-w-6xl space-y-4">
      <h1 className="text-2xl font-semibold">Tools & prices</h1>
      <p className="text-stone-600">
        Prices are per store per month. A new price applies to each company’s subscription at its next update (prorated by Stripe). Switching a tool off for everyone hides it from every company and stops
        billing for it.
      </p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-stone-500">
            <tr>
              <th className="px-4 py-2">Tool</th>
              <th className="px-4 py-2 text-right">Companies</th>
              <th className="px-4 py-2">Monthly price</th>
              <th className="px-4 py-2">Availability</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.id} className="border-t border-stone-100 align-top">
                <td className="px-4 py-3">
                  <span className="font-medium">{t.name}</span>
                  <div className="max-w-sm text-xs text-stone-500">{t.description}</div>
                  {t.dependsOn.length > 0 && <div className="text-xs text-stone-400">Needs {t.dependsOn.join(', ')}</div>}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {t.companiesUsing}
                  {(t.companiesComped > 0 || t.companiesBlocked > 0) && (
                    <div className="text-xs text-stone-500">
                      {t.companiesComped} free · {t.companiesBlocked} blocked
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <ActionForm action={setPlatformPrice.bind(null, t.id)} className="flex flex-wrap items-center gap-2">
                    <input name="price" inputMode="decimal" defaultValue={t.priceOverridden ? (t.monthlyPriceMinor / 100).toFixed(2) : ''} placeholder={(t.builtInPriceMinor / 100).toFixed(2)} className="input w-24" aria-label={`Price for ${t.name}`} />
                    <button className="btn-secondary">Save</button>
                    <span className="text-xs text-stone-500">{t.priceOverridden ? `built-in ${usd(t.builtInPriceMinor)}` : t.monthlyPriceMinor ? 'built-in price' : 'included'}</span>
                  </ActionForm>
                </td>
                <td className="px-4 py-3">
                  <Availability moduleId={t.id} name={t.name} available={t.available} using={t.companiesUsing} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
