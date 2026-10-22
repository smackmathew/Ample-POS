'use client';

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import type { ActionState } from '@/lib/api';

/**
 * A form bound to a server action that shows its success, error or one-time
 * secret. Unlike a plain `<form action>`, it keeps what the user typed when the
 * action fails and only resets after success.
 */
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
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state && !state.error) formRef.current?.reset();
  }, [state]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  };

  return (
    <form ref={formRef} onSubmit={onSubmit} className={className}>
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {state?.error && <p className="col-span-full mt-2 text-sm text-red-700">{state.error}</p>}
      {state?.ok && !state.error && <p className="col-span-full mt-2 text-sm text-teal-700">{state.ok}</p>}
      {state?.secret && (
        <div className="col-span-full mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">{secretLabel ?? 'Copy this now. It will not be shown again.'}</p>
          <code className="mt-1 block break-all">{state.secret}</code>
        </div>
      )}
    </form>
  );
}
