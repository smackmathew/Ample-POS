import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import type { CurrentTenant, LoyaltyProgram } from '@/lib/types';
import { saveProgram } from '../loyalty-actions';

export default async function LoyaltyPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [current, program] = await Promise.all([api<CurrentTenant>('/tenant', { tenantId }), api<LoyaltyProgram>('/loyalty/program', { tenantId })]);
  const money = (n: number) => formatMoney(n, current.tenant.currency);
  // What a customer gets back for each dollar, as a percentage.
  const backPercent = (program.pointsPerDollar * program.rewardValueMinor) / program.rewardPoints;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Loyalty rewards</h1>
        <p className="mt-1 text-stone-600">
          Customers on a sale earn points on what they spend before tax. At the register, their points take money off a sale.
        </p>
      </div>

      <section className="card space-y-1 bg-teal-50">
        <p className="font-medium">
          {program.pointsPerDollar} point{program.pointsPerDollar === 1 ? '' : 's'} per $1 · {program.rewardPoints} points = {money(program.rewardValueMinor)} off
        </p>
        <p className="text-sm text-stone-600">Customers get about {backPercent.toFixed(backPercent < 1 ? 2 : 1)}% back on what they spend.</p>
      </section>

      <ActionForm action={saveProgram.bind(null, tenantId)} className="card grid gap-4 sm:grid-cols-3">
        <label className="text-sm">
          Points per $1 spent
          <input name="pointsPerDollar" inputMode="numeric" defaultValue={program.pointsPerDollar} required className="input mt-1" />
        </label>
        <label className="text-sm">
          Points for a reward
          <input name="rewardPoints" inputMode="numeric" defaultValue={program.rewardPoints} required className="input mt-1" />
        </label>
        <label className="text-sm">
          Reward is worth
          <input name="rewardValue" inputMode="decimal" defaultValue={(program.rewardValueMinor / 100).toFixed(2)} required className="input mt-1" />
        </label>
        <div className="sm:col-span-3">
          <button className="btn">Save</button>
        </div>
      </ActionForm>

      <section className="space-y-1 text-sm text-stone-600">
        <h2 className="font-medium text-stone-900">How points work</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Points count whole dollars after discounts and before tax, and arrive when the sale is paid.</li>
          <li>Refunds take back the points for what was refunded. A reward that was used stays used.</li>
          <li>A reward is taken off before payment, as a discount, so tax is charged on what’s left.</li>
          <li>Managers can add or take away points on a customer’s page, with a reason.</li>
          <li>Changing the rates doesn’t change points already earned.</li>
        </ul>
      </section>
    </div>
  );
}
