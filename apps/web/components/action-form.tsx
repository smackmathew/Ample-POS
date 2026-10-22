'use client';

import { useActionState, type ReactNode } from 'react';
import type { ActionState } from '@/lib/api';

/** A form bound to a server action that shows its success, error or one-time secret. */
export function ActionForm({
  action,
  children,
  className,
  secretLabel,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
  secretLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className={className}>
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {state?.error && <p className="col-span-full mt-2 text-sm text-red-700">{state.error}</p>}
      {state?.secret && (
        <div className="col-span-full mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">{secretLabel ?? 'Copy this now. It will not be shown again.'}</p>
          <code className="mt-1 block break-all">{state.secret}</code>
        </div>
      )}
    </form>
  );
}
