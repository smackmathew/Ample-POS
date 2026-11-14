'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Sale } from '@/lib/types';
import { setSaleCustomer, type CustomerPick } from '../../customer-actions';
import { CustomerPicker } from '../customer-picker';

/** The customer on a past or open sale, changeable after the fact. */
export function SaleCustomer({ tenantId, saleId, customer }: { tenantId: string; saleId: string; customer: Sale['customer'] }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const change = (c: CustomerPick | null) =>
    startTransition(async () => {
      setError('');
      const result = await setSaleCustomer(tenantId, saleId, c?.id ?? null);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  return (
    <div className="space-y-1">
      <CustomerPicker tenantId={tenantId} value={customer} onChange={change} disabled={pending} />
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
