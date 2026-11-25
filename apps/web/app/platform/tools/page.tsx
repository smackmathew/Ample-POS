import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { usd, type PlanCatalog, type PlatformTool } from '@/lib/platform';
import { setAddonPrice, setPlanPrices, setPlatformPrice } from '../actions';
import { Availability } from './availability';

function PriceField({ label, name, value }: { label: string; name: string; value: number }) {
  return (
    <label className="block text-sm">
      {label}
      <input name={name} inputMode="decimal" defaultValue={(value / 100).toFixed(2)} className="input mt-1" />
    </label>
  );
}

export default async function ToolsPage() {
  const [tools, catalog] = await Promise.all([api<PlatformTool[]>('/platform/tools'), api<PlanCatalog>('/platform/plans')]);
  return (
    <div className="max-w-6xl space-y-4">
      <h1 className="text-2xl font-semibold">Plans, tools & prices</h1>

      <h2 className="pt-2 font-medium">Plans</h2>
      <p className="text-sm text-stone-600">Shown on the public pricing page and used for every company on the plan. Leave a field empty for its default.</p>
      <div className="grid gap-4 lg:grid-cols-3">
        {catalog.plans.map((p) => (
          <ActionForm key={p.id} action={setPlanPrices.bind(null, p.id)} className="card space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="font-semibold">{p.name}</h3>
              <span className="text-xs text-stone-500">{p.companies} compan{p.companies === 1 ? 'y' : 'ies'}</span>
            </div>
            <PriceField label="First location /mo" name="base" value={p.baseMinor} />
            <PriceField label="Each extra location /mo" name="extra" value={p.extraLocationMinor} />
            <PriceField label="Website sync /mo" name="maintenance" value={p.websiteMaintenanceMinor} />
            <label className="block text-sm">
              Registers per location
              <input name="registers" inputMode="numeric" defaultValue={p.registersPerLocation} className="input mt-1" />
            </label>
            <button className="btn-secondary">Save {p.name}</button>
          </ActionForm>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {catalog.websiteAddons.map((a) => (
          <ActionForm key={a.id} action={setAddonPrice.bind(null, a.id)} className="card flex flex-wrap items-end gap-2">
            <div className="w-full">
              <h3 className="font-semibold">{a.name}</h3>
              <p className="text-xs text-stone-500">One-time setup fee</p>
            </div>
            <input name="setup" inputMode="decimal" defaultValue={(a.setupMinor / 100).toFixed(2)} className="input w-32" aria-label={`Setup fee for ${a.name}`} />
            <button className="btn-secondary">Save</button>
          </ActionForm>
        ))}
      </div>

      <h2 className="pt-4 font-medium">Add-on tools</h2>
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
