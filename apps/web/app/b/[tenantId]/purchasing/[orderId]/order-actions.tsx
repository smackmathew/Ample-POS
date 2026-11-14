'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { finishOrder } from '../../purchasing-actions';

/** Close a short order, or cancel one nothing arrived for. */
export function OrderActions({ tenantId, orderId, action }: { tenantId: string; orderId: string; action: 'close' | 'cancel' }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-1">
      <button
        className="text-sm text-stone-600 hover:underline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await finishOrder(tenantId, orderId, action);
            if (!r.ok) setError(r.error);
            else router.refresh();
          })
        }
      >
        {action === 'close' ? 'Close the order: the rest isn’t coming' : 'Cancel the order'}
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
