import { ActionForm } from '@/components/action-form';
import type { AuthConfig } from '@/lib/api';
import type { Me } from '@/lib/types';
import { resendVerification } from '@/app/session-actions';

/** Shown until a new account confirms its email, while confirmation is required. */
export function VerifyEmailBanner({ me, config }: { me: Me; config: AuthConfig }) {
  if (!config.emailVerification || me.account.emailVerified) return null;
  return (
    <ActionForm action={resendVerification} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
      <span>
        Confirm your email to create a business: we sent a link to <strong>{me.user.email}</strong>.
      </span>
      <button className="btn-secondary px-3 py-1.5 text-sm">Send it again</button>
    </ActionForm>
  );
}
