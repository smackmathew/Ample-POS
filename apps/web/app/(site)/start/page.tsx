import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { authConfig } from '@/lib/api';
import { getPricing, isPlanId, isWebsiteAddonId, price, signedIn } from '@/lib/site';
import { startBusiness } from '../../start-actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Start your free trial · Ample POS',
};

const choice =
  'flex cursor-pointer items-start gap-3 rounded-xl border border-stone-200 bg-white p-4 has-[:checked]:border-brand has-[:checked]:bg-teal-50/60 has-[:checked]:ring-1 has-[:checked]:ring-brand';

export default async function StartPage({ searchParams }: { searchParams: Promise<{ plan?: string; website?: string }> }) {
  const [params, pricing, config, inside] = await Promise.all([searchParams, getPricing(), authConfig(), signedIn()]);
  const plan = isPlanId(params.plan) ? params.plan : 'starter';
  const website = isWebsiteAddonId(params.website) ? params.website : 'none';
  const here = `/start?plan=${plan}${website !== 'none' ? `&website=${website}` : ''}`;
  const needsAccount = !inside;
  const canSignUp = config.mode === 'password';

  return (
    <main className="mx-auto max-w-3xl px-4 py-14">
      <h1 className="text-3xl font-semibold tracking-tight">Start your free trial</h1>
      <p className="mt-2 text-stone-600">
        {pricing.trialDays} days free with everything on. No card needed unless you subscribe now.
        {needsAccount && (
          <>
            {' '}
            Already have an account?{' '}
            <Link href={`/login?next=${encodeURIComponent(here)}`} className="text-brand hover:underline">
              Sign in
            </Link>{' '}
            and come back here.
          </>
        )}
      </p>

      {needsAccount && !canSignUp ? (
        <p className="card mt-8">
          <Link href={`/login?next=${encodeURIComponent(here)}`} className="btn">
            Sign in to continue
          </Link>
        </p>
      ) : (
        <ActionForm action={startBusiness} className="mt-8">
          <div className="space-y-10">
            <fieldset>
              <legend className="text-lg font-semibold">1. Choose a plan</legend>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {pricing.plans.map((p) => (
                  <label key={p.id} className={choice}>
                    <input type="radio" name="plan" value={p.id} defaultChecked={p.id === plan} className="mt-1 accent-brand" />
                    <span className="text-sm">
                      <span className="block font-semibold">{p.name}</span>
                      <span className="block text-lg font-semibold">{price(p.baseMinor)}/mo</span>
                      <span className="block text-stone-600">
                        {p.registersPerLocation === 1 ? '1 register' : `Up to ${p.registersPerLocation} registers`} per location
                      </span>
                      <span className="block text-stone-500">+{price(p.extraLocationMinor)}/mo per extra location</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-lg font-semibold">2. Sell online too?</legend>
              <p className="mt-1 text-sm text-stone-500">Optional. Any setup fee is charged when you subscribe.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className={choice}>
                  <input type="radio" name="website" value="none" defaultChecked={website === 'none'} className="mt-1 accent-brand" />
                  <span className="text-sm">
                    <span className="block font-semibold">Not now</span>
                    <span className="block text-stone-600">You can add one later from Billing.</span>
                  </span>
                </label>
                {pricing.websiteAddons.map((a) => (
                  <label key={a.id} className={choice}>
                    <input type="radio" name="website" value={a.id} defaultChecked={website === a.id} className="mt-1 accent-brand" />
                    <span className="text-sm">
                      <span className="block font-semibold">{a.name}</span>
                      <span className="block">{price(Math.min(...pricing.plans.map((p) => p.websiteMaintenanceMinor)))}/mo</span>
                      <span className="block text-stone-500">{a.setupMinor > 0 ? `+ ${price(a.setupMinor)} one-time setup` : 'No setup fee'}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="grid gap-3 sm:max-w-md">
              <legend className="text-lg font-semibold">3. Your business</legend>
              <label className="block text-sm">
                Business name
                <input name="business" required maxLength={120} autoComplete="organization" className="input mt-1" placeholder="Corner Cafe" />
              </label>
            </fieldset>

            {needsAccount && (
              <fieldset className="grid gap-3 sm:max-w-md">
                <legend className="text-lg font-semibold">4. Your account</legend>
                <label className="block text-sm">
                  Your name
                  <input name="name" autoComplete="name" required className="input mt-1" />
                </label>
                <label className="block text-sm">
                  Email
                  <input name="email" type="email" autoComplete="email" required className="input mt-1" />
                </label>
                <label className="block text-sm">
                  Password
                  <input name="password" type="password" autoComplete="new-password" minLength={10} required className="input mt-1" />
                  <span className="mt-1 block text-xs text-stone-500">At least 10 characters.</span>
                </label>
                <label className="block text-sm">
                  Repeat password
                  <input name="confirm" type="password" autoComplete="new-password" required className="input mt-1" />
                </label>
              </fieldset>
            )}

            <div className="rounded-xl bg-stone-50 p-5">
              <div className="flex flex-wrap gap-3">
                <button name="mode" value="trial" className="btn px-5 py-3 text-base">
                  Start {pricing.trialDays}-day free trial
                </button>
                <button name="mode" value="subscribe" className="btn-secondary px-5 py-3 text-base">
                  Subscribe now
                </button>
              </div>
              <p className="mt-3 text-sm text-stone-600">
                <strong>Free trial:</strong> start selling today and add a card from Billing before the trial ends. <strong>Subscribe now:</strong> enter your
                card at checkout; the plan is still free until the trial ends, and a website setup fee is charged right away.
              </p>
            </div>
          </div>
        </ActionForm>
      )}
    </main>
  );
}
