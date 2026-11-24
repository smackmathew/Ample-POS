import type { Metadata } from 'next';
import Link from 'next/link';
import { Check, PlanCards } from '@/components/plan-cards';
import { getPricing, price } from '@/lib/site';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Pricing · Ample POS' };

export default async function PricingPage() {
  const pricing = await getPricing();
  const included = pricing.tools.filter((t) => t.included && !t.withOnlineStore);
  const addOns = pricing.tools.filter((t) => !t.included && !t.withOnlineStore);
  const faqs: [string, string][] = [
    [
      'How does the free trial work?',
      `You get ${pricing.trialDays} days with everything on and no card needed. Subscribe any time during the trial; you aren’t charged for the plan until the trial ends.`,
    ],
    ['What counts as a location?', 'Each store you sell from. Your plan covers the first one; every extra active location adds the plan’s extra location price.'],
    [
      'What if I need more registers?',
      `Registers are counted per location. Starter allows 1 open register per store; switch to Growth for up to ${pricing.plans[1]?.registersPerLocation ?? 5} or Pro for up to ${pricing.plans[2]?.registersPerLocation ?? 10}.`,
    ],
    ['Can I change plans or cancel?', 'Yes. Change plans from the Billing page whenever you like; the next bill is adjusted for the days used. Cancel any time and keep access until the end of the paid month.'],
    ['How are card payments charged?', 'Connect your own payment account or use ours. Card processing fees come from the card processor, not from your Ample POS plan.'],
  ];
  return (
    <main>
      <section className="mx-auto max-w-6xl px-4 pt-16 pb-12 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Pricing</h1>
        <p className="mx-auto mt-3 max-w-2xl text-lg text-stone-600">
          One plan for your registers, one price per extra store, and add-ons only if you want them. Start with a free {pricing.trialDays}-day trial.
        </p>
      </section>
      <section className="mx-auto max-w-6xl px-4">
        <PlanCards pricing={pricing} />
        <p className="mt-6 text-center text-sm text-stone-500">Prices in US dollars per month, before sales tax.</p>
      </section>

      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-16 md:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold">Included in every plan</h2>
          <ul className="mt-5 space-y-3 text-sm">
            {included.map((t) => (
              <Check key={t.id}>
                <span className="font-medium">{t.name}</span> <span className="text-stone-500">
                  — {t.description}
                  {t.id === 'purchasing' && ' Works with the Inventory add-on.'}
                </span>
              </Check>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="text-2xl font-semibold">Add-ons</h2>
          <p className="mt-1 text-sm text-stone-500">Per location, per month. Turn them on or off whenever you like.</p>
          <table className="mt-4 w-full text-sm">
            <tbody className="divide-y divide-stone-100">
              {addOns.map((t) => (
                <tr key={t.id}>
                  <td className="py-3 pr-4">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-stone-500">{t.description}</div>
                  </td>
                  <td className="py-3 text-right whitespace-nowrap font-medium">{price(t.monthlyPriceMinor)}/mo</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="online-store" className="bg-teal-50">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-2xl font-semibold">Add an online store</h2>
          <p className="mt-2 max-w-2xl text-stone-700">
            We set up your store and keep its products, prices and stock in sync with your registers. Pay once for setup, then a monthly sync fee based on your plan.
          </p>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {pricing.websiteAddons.map((a) => (
              <div key={a.id} className="rounded-2xl border border-teal-100 bg-white p-6">
                <h3 className="text-lg font-semibold">{a.name}</h3>
                <p className="mt-1 text-sm text-stone-600">{a.description}</p>
                <p className="mt-4">
                  <span className="text-3xl font-semibold">{price(a.setupMinor)}</span> <span className="text-stone-500">one-time setup</span>
                </p>
              </div>
            ))}
          </div>
          <table className="mt-8 w-full max-w-md text-sm">
            <caption className="mb-2 text-left font-medium">Monthly sync fee</caption>
            <tbody className="divide-y divide-teal-100">
              {pricing.plans.map((p) => (
                <tr key={p.id}>
                  <td className="py-2">On {p.name}</td>
                  <td className="py-2 text-right font-medium">{price(p.websiteMaintenanceMinor)}/mo</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-16">
        <h2 className="text-2xl font-semibold">Questions</h2>
        <dl className="mt-6 divide-y divide-stone-200">
          {faqs.map(([q, a]) => (
            <div key={q} className="py-5">
              <dt className="font-medium">{q}</dt>
              <dd className="mt-1 text-sm text-stone-600">{a}</dd>
            </div>
          ))}
        </dl>
        <Link href="/start" className="btn mt-8 px-5 py-3 text-base">
          Start free trial
        </Link>
      </section>
    </main>
  );
}
