import { ActionForm } from '@/components/action-form';
import { devSignIn } from '../session-actions';

export default function LoginPage() {
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">Sign in to POS Hub</h1>
      <p className="mt-2 text-sm text-stone-600">
        Development sign-in. In production this page is replaced by your identity provider.
      </p>
      <ActionForm action={devSignIn} className="card mt-6 space-y-3">
        <label className="block text-sm">
          Email
          <input name="email" type="email" required className="input mt-1" />
        </label>
        <label className="block text-sm">
          Name
          <input name="name" className="input mt-1" />
        </label>
        <button className="btn w-full">Continue</button>
      </ActionForm>
    </main>
  );
}
