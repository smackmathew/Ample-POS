import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { acceptInvitation, createBusiness, signOut } from '../session-actions';

export default async function BusinessesPage() {
  const me = await api<Me>('/me');
  return (
    <main className="mx-auto mt-16 max-w-2xl space-y-8 px-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your businesses</h1>
        <form action={signOut}>
          <button className="btn-secondary">Sign out ({me.user.email})</button>
        </form>
      </header>

      {me.tenants.length > 0 ? (
        <ul className="space-y-2">
          {me.tenants.map((t) => (
            <li key={t.id}>
              <Link href={`/b/${t.id}`} className="card flex items-center justify-between hover:border-brand">
                <span className="font-medium">{t.name}</span>
                <span className="text-sm text-stone-500">{t.role.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-stone-600">You are not part of a business yet. Create one or accept an invitation.</p>
      )}

      <section className="grid gap-4 sm:grid-cols-2">
        <ActionForm action={createBusiness} className="card space-y-3">
          <h2 className="font-medium">Create a business</h2>
          <input name="name" placeholder="Business name" required className="input" />
          <input name="slug" placeholder="url-slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" className="input" />
          <button className="btn">Create</button>
        </ActionForm>
        <ActionForm action={acceptInvitation} className="card space-y-3">
          <h2 className="font-medium">Join with an invitation code</h2>
          <input name="code" placeholder="Invitation code" required className="input" />
          <button className="btn-secondary">Join</button>
        </ActionForm>
      </section>
    </main>
  );
}
