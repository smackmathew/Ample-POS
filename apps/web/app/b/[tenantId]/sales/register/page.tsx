import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { can, type CurrentTenant, type Location, type RegisterSummary } from '@/lib/types';
import { Register } from './register';

export default async function RegisterPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [current, { session, paymentsProvider }, locations] = await Promise.all([
    api<CurrentTenant>('/tenant', { tenantId }),
    api<{ session: RegisterSummary | null; paymentsProvider: string }>('/registers/sessions/current', { tenantId }),
    api<Location[]>('/locations', { tenantId }),
  ]);
  if (!session) redirect(`/b/${tenantId}/sales`);
  const location = locations.find((l) => l.id === session.locationId);

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Register · {session.locationName}</h1>
        <a href={`/b/${tenantId}/sales`} className="text-sm text-stone-500 hover:underline">
          Sales and closing
        </a>
      </div>
      <Register
        tenantId={tenantId}
        sessionId={session.id}
        currency={current.tenant.currency}
        taxRateBps={location?.taxRateBps ?? 0}
        canDiscount={can(current.membership.permissions, 'pos.discount')}
        simulatedReader={paymentsProvider === 'simulated'}
      />
    </div>
  );
}
