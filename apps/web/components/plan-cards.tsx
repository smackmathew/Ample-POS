import Link from 'next/link';
import { price, type PublicPricing } from '@/lib/site';

/** The three plans side by side, each linking to signup with the plan picked. */
export function PlanCards({ pricing }: { pricing: PublicPricing }) {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      {pricing.plans.map((p) => {
        const popular = p.id === 'growth';
        return (
          <div key={p.id} className={`relative flex flex-col rounded-2xl border bg-white p-6 ${popular ? 'border-brand shadow-lg shadow-teal-900/5' : 'border-stone-200'}`}>
            {popular && <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-0.5 text-xs font-medium text-white">Most popular</span>}
            <h3 className="text-lg font-semibold">{p.name}</h3>
            <p className="text-sm text-stone-500">{p.tagline}</p>
            <p className="mt-4">
              <span className="text-4xl font-semibold tracking-tight">{price(p.baseMinor)}</span>
              <span className="text-stone-500">/mo</span>
            </p>
            <p className="text-sm text-stone-500">for your first location</p>
            <ul className="mt-5 flex-1 space-y-2 text-sm">
              <Check>
                {p.registersPerLocation === 1 ? '1 register' : `Up to ${p.registersPerLocation} registers`} per location
              </Check>
              <Check>{price(p.extraLocationMinor)}/mo for each extra location</Check>
              <Check>Sales, reports, customers and loyalty included</Check>
              <Check>Website sync {price(p.websiteMaintenanceMinor)}/mo, if you want it</Check>
            </ul>
            <Link href={`/start?plan=${p.id}`} className={`mt-6 w-full ${popular ? 'btn' : 'btn-secondary'}`}>
              Start {pricing.trialDays}-day free trial
            </Link>
          </div>
        );
      })}
    </div>
  );
}

export function Check({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <svg viewBox="0 0 20 20" aria-hidden className="mt-0.5 h-4 w-4 flex-none fill-brand">
        <path d="M8.1 14.3 3.8 10l1.4-1.4 2.9 2.9 6.7-6.7 1.4 1.4z" />
      </svg>
      <span>{children}</span>
    </li>
  );
}
