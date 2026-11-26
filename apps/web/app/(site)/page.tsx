import Link from 'next/link';
import { PlanCards } from '@/components/plan-cards';
import { formatMoney } from '@/lib/money';
import { getPricing, price } from '@/lib/site';

export const dynamic = 'force-dynamic';

const HIGHLIGHTS = [
  ['Sell anywhere in the store', 'A fast register on any tablet or phone. Scan, take cash, cards or gift cards, and split payments.'],
  ['Know what you have', 'Stock counts, transfers between stores and purchase orders that update inventory the moment a delivery arrives.'],
  ['Bring customers back', 'Customer profiles, emailed receipts and loyalty points they can spend at the counter.'],
  ['Run your team', 'Time clock, schedules and checklists, with timecards ready for payroll.'],
  ['See how you’re doing', 'Sales, inventory and labor reports for every store, or all of them at once.'],
  ['Sell online too', 'Sync the website you already have, or let us build one, sharing products, prices and stock with the register.'],
] as const;

export default async function Home() {
  const pricing = await getPricing();
  const starter = pricing.plans[0]!;
  return (
    <main>
      <section className="bg-gradient-to-b from-teal-50 to-white">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <p className="text-sm font-medium text-brand">Point of sale for independent shops</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">Everything your store runs on, in one place.</h1>
            <p className="mt-5 max-w-xl text-lg text-stone-600">
              Ample POS rings up sales, tracks stock, rewards regulars and keeps your online store in step. Turn on only the tools you need.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/start" className="btn px-5 py-3 text-base">
                Start your {pricing.trialDays}-day free trial
              </Link>
              <Link href="/pricing" className="btn-secondary px-5 py-3 text-base">
                See pricing
              </Link>
            </div>
            <p className="mt-4 text-sm text-stone-500">No card needed to start. Plans from {price(starter.baseMinor)}/mo after the trial.</p>
          </div>
          <RegisterPreview />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-3xl font-semibold tracking-tight">Built for the way shops actually work</h2>
        <p className="mt-3 max-w-2xl text-stone-600">Start with the register. Add inventory, staff tools or an online store when you’re ready.</p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {HIGHLIGHTS.map(([title, body]) => (
            <div key={title} className="rounded-xl border border-stone-200 p-6">
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-stone-600">{body}</p>
            </div>
          ))}
        </div>
        <Link href="/features" className="mt-8 inline-block text-sm font-medium text-brand hover:underline">
          Every feature →
        </Link>
      </section>

      <section className="bg-stone-50">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <h2 className="text-3xl font-semibold tracking-tight">Simple pricing</h2>
          <p className="mt-3 text-stone-600">Pick a plan for how many registers you run. Every plan starts with a free {pricing.trialDays}-day trial.</p>
          <div className="mt-10">
            <PlanCards pricing={pricing} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Open your register today</h2>
        <p className="mx-auto mt-3 max-w-xl text-stone-600">Set up takes a few minutes: create your account, name your business, and start selling.</p>
        <Link href="/start" className="btn mt-8 px-5 py-3 text-base">
          Start free trial
        </Link>
      </section>
    </main>
  );
}

/** A small drawing of the register screen. */
function RegisterPreview() {
  const lines = [
    ['Oat latte', 2, 1100],
    ['Almond croissant', 1, 450],
    ['House blend, 12oz', 1, 1600],
  ] as const;
  const subtotal = lines.reduce((s, [, q, p]) => s + p, 0);
  const tax = Math.round(subtotal * 0.08);
  return (
    <div aria-hidden className="mx-auto w-full max-w-md rounded-2xl border border-stone-200 bg-white p-5 shadow-xl shadow-teal-900/10">
      <div className="flex items-center justify-between text-xs text-stone-500">
        <span>Register 1 · Main St</span>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-brand">Open</span>
      </div>
      <ul className="mt-4 divide-y divide-stone-100 text-sm">
        {lines.map(([name, qty, total]) => (
          <li key={name} className="flex justify-between py-2">
            <span>
              {name} <span className="text-stone-400">× {qty}</span>
            </span>
            <span>{formatMoney(total, 'USD')}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-1 border-t border-stone-200 pt-3 text-sm">
        <div className="flex justify-between text-stone-500">
          <span>Tax</span>
          <span>{formatMoney(tax, 'USD')}</span>
        </div>
        <div className="flex justify-between text-base font-semibold">
          <span>Total</span>
          <span>{formatMoney(subtotal + tax, 'USD')}</span>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-sm font-medium">
        <span className="rounded-lg bg-brand py-3 text-white">Card</span>
        <span className="rounded-lg border border-stone-200 py-3">Cash</span>
        <span className="rounded-lg border border-stone-200 py-3">Gift card</span>
      </div>
      <p className="mt-3 text-center text-xs text-stone-500">+ 22 loyalty points for Maya R.</p>
    </div>
  );
}
