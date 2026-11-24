import type { Metadata } from 'next';
import Link from 'next/link';
import { getPricing, price } from '@/lib/site';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Features · Ample POS' };

const DETAILS: Record<string, string[]> = {
  pos: ['Scan barcodes with the camera or a scanner', 'Cards on a reader or Tap to Pay, cash, or both', 'Refunds, and a cash count when you close'],
  catalog: ['Products with sizes, colors and other variants', 'Barcodes and SKUs', 'Prices per variant'],
  inventory: ['Stock per store, moved by every sale', 'Counts with the phone app', 'Transfers between stores'],
  purchasing: ['Orders to your suppliers, emailed from the app', 'Receive deliveries on a phone, line by line', 'Stock updates the moment you receive'],
  customers: ['Profiles with purchase history', 'Emailed receipts', 'Attach a customer to a sale at the register'],
  loyalty: ['Points on every dollar spent', 'Redeem points for money off', 'Balances on receipts'],
  'gift-cards': ['Sell and reload at the register', 'Take as payment, alone or split', 'Balance lookups any time'],
  'time-clock': ['Clock in and out at the register', 'Breaks and timecard approval', 'Hours ready for payroll'],
  scheduling: ['Shifts for each store', 'Staff availability', 'Publish the schedule for your team'],
  tasks: ['Opening and closing checklists', 'Assign to people or roles', 'A record of who did what'],
  reporting: ['Sales by day, product and payment type', 'Inventory on hand for each store', 'Labor hours from timecards'],
  'ecommerce-sync': ['Products and prices shared with your online store', 'Stock kept in step both ways', 'Comes with the online store add-on'],
};

export default async function FeaturesPage() {
  const pricing = await getPricing();
  const included = pricing.tools.filter((t) => t.included && !t.withOnlineStore);
  const paid = pricing.tools.filter((t) => !t.included && !t.withOnlineStore);
  const store = pricing.tools.find((t) => t.withOnlineStore);
  return (
    <main className="mx-auto max-w-6xl px-4 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">Features</h1>
      <p className="mt-3 max-w-2xl text-lg text-stone-600">
        Every plan comes with the tools a shop needs from day one. Add more as you grow; each add-on is a monthly price per store, and you can switch it off any time.
      </p>

      <Group title="Included in every plan" tools={included} />
      <Group title="Add-ons" tools={paid} note={(t) => `${price(t.monthlyPriceMinor)}/mo per store`} />
      {store && (
        <section className="mt-14 rounded-2xl bg-teal-50 p-8">
          <h2 className="text-2xl font-semibold">Online store</h2>
          <p className="mt-2 max-w-2xl text-stone-700">
            We build your online store and keep it in sync with the register. One-time setup from {price(Math.min(...pricing.websiteAddons.map((a) => a.setupMinor)))}, then a
            small monthly sync fee that depends on your plan.
          </p>
          <ul className="mt-4 grid gap-1 text-sm text-stone-700 sm:grid-cols-3">
            {(DETAILS[store.id] ?? []).map((d) => (
              <li key={d}>• {d}</li>
            ))}
          </ul>
          <Link href="/pricing#online-store" className="mt-5 inline-block text-sm font-medium text-brand hover:underline">
            Online store pricing →
          </Link>
        </section>
      )}
      <div className="mt-14 flex flex-wrap gap-3">
        <Link href="/start" className="btn px-5 py-3 text-base">
          Start free trial
        </Link>
        <Link href="/pricing" className="btn-secondary px-5 py-3 text-base">
          See pricing
        </Link>
      </div>
    </main>
  );
}

function Group({ title, tools, note }: { title: string; tools: { id: string; name: string; description: string; monthlyPriceMinor: number }[]; note?: (t: { monthlyPriceMinor: number }) => string }) {
  if (tools.length === 0) return null;
  return (
    <section className="mt-14">
      <h2 className="text-2xl font-semibold">{title}</h2>
      <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((t) => (
          <div key={t.id} className="rounded-xl border border-stone-200 p-6">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-semibold">{t.name}</h3>
              {note && <span className="whitespace-nowrap text-xs text-stone-500">{note(t)}</span>}
            </div>
            <p className="mt-1 text-sm text-stone-600">{t.description}</p>
            <ul className="mt-3 space-y-1 text-sm text-stone-600">
              {(DETAILS[t.id] ?? []).map((d) => (
                <li key={d}>• {d}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
