import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import type { ModuleSummary } from '@/lib/types';
import { toggleModule } from '../actions';

export default async function ToolsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const modules = await api<ModuleSummary[]>('/modules', { tenantId });
  const names = new Map(modules.map((m) => [m.id, m.name]));

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold">Tools</h1>
      <p className="mt-1 text-sm text-stone-600">
        Turn on the tools your business needs. You can change this any time, and you only pay for what’s on.
      </p>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2">
        {modules.map((m) => (
          <li key={m.id} className={`card flex flex-col ${m.enabled ? 'border-brand' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-medium">{m.name}</h2>
              {m.enabled && <span className="rounded bg-teal-50 px-2 py-0.5 text-xs text-brand">On</span>}
            </div>
            <p className="mt-1 flex-1 text-sm text-stone-600">{m.description}</p>
            {m.dependsOn.length > 0 && (
              <p className="mt-2 text-xs text-stone-500">Requires {m.dependsOn.map((d) => names.get(d)).join(', ')}</p>
            )}
            <p className="mt-2 text-sm font-medium">
              {m.monthlyPriceMinor ? `${formatMoney(m.monthlyPriceMinor, 'USD')} per location / month` : 'Included'}
            </p>
            <ActionForm action={toggleModule.bind(null, tenantId, m.id, !m.enabled)} className="mt-3">
              <button className={m.enabled ? 'btn-secondary' : 'btn'} disabled={!m.enabled && m.missingDependencies.length > 0}>
                {m.enabled ? 'Turn off' : 'Turn on'}
              </button>
            </ActionForm>
          </li>
        ))}
      </ul>
    </div>
  );
}
