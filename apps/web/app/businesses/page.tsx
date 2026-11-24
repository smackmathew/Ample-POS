import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { PlainHeader } from '@/components/app-shell';
import { VerifyEmailBanner } from '@/components/verify-email-banner';
import { api, authConfig } from '@/lib/api';
import type { Me } from '@/lib/types';
import { acceptInvitation, createBusiness } from '../session-actions';

export default async function BusinessesPage() {
  const [me, config, platform] = await Promise.all([api<Me>('/me'), authConfig(), api<{ admin: boolean }>('/platform/access')]);
  return (
    <>
      <PlainHeader email={me.user.email} admin={platform.admin} />
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-12">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Your businesses</h1>
            <p className="mt-1 text-stone-600">Pick one to open its dashboard.</p>
          </div>
          <div className="flex gap-2">
            {platform.admin && (
              <Link href="/platform" className="btn-secondary">
                Super admin
              </Link>
            )}
            <Link href="/start" className="btn">
              Start a new business
            </Link>
          </div>
        </header>
        <VerifyEmailBanner me={me} config={config} />

        {me.tenants.length > 0 ? (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {me.tenants.map((t) => (
              <li key={t.id}>
                <Link href={`/b/${t.id}`} className="card group flex h-full items-center gap-4 transition hover:border-brand hover:shadow-md">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-lg font-semibold text-brand uppercase">
                    {t.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{t.name}</span>
                    <span className="block text-sm text-stone-500">{t.role.name}</span>
                  </span>
                  <span className="text-stone-300 transition group-hover:translate-x-0.5 group-hover:text-brand">→</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card text-center">
            <p className="font-medium">You’re not part of a business yet</p>
            <p className="mt-1 text-sm text-stone-600">Start one with a free trial, or join your team with an invitation code below.</p>
            <Link href="/start" className="btn mt-4">
              Start free trial
            </Link>
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-2">
          <ActionForm action={createBusiness} className="card grid content-start gap-3">
            <h2 className="font-semibold">Quick add a business</h2>
            <p className="text-sm text-stone-500">Starts on the Starter plan. Use Start a new business to pick a plan.</p>
            <input name="name" placeholder="Business name" required className="input" />
            <input name="slug" placeholder="url-slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" className="input" />
            <button className="btn justify-self-start">Create</button>
          </ActionForm>
          <ActionForm action={acceptInvitation} className="card grid content-start gap-3">
            <h2 className="font-semibold">Join with an invitation code</h2>
            <p className="text-sm text-stone-500">Your manager can send you one from their Team page.</p>
            <input name="code" placeholder="Invitation code" required className="input" />
            <button className="btn-secondary justify-self-start">Join</button>
          </ActionForm>
        </section>
      </main>
    </>
  );
}
