'use client';

import { useEffect, useState, useTransition } from 'react';
import { findCustomers, quickAddCustomer, type CustomerPick } from '../customer-actions';

/**
 * Finds a customer by name, email or phone, or adds one, for the sale at hand.
 * Shows the chosen customer with a way to take them off.
 */
export function CustomerPicker({
  tenantId,
  value,
  onChange,
  disabled,
}: {
  tenantId: string;
  value: CustomerPick | null;
  onChange: (customer: CustomerPick | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<CustomerPick[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', email: '', phone: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  // Search as the cashier types, after a short pause.
  useEffect(() => {
    const q = query.trim();
    if (!q || value) return setFound([]);
    const timer = setTimeout(
      () =>
        startTransition(async () => {
          const result = await findCustomers(tenantId, q);
          if (result.ok) setFound(result.data);
          else setError(result.error);
        }),
      250,
    );
    return () => clearTimeout(timer);
  }, [query, tenantId, value]);

  const pick = (c: CustomerPick | null, note = '') => {
    onChange(c);
    setQuery('');
    setFound([]);
    setAdding(false);
    setError('');
    setMessage(note);
  };

  const startAdding = () => {
    // Put what was typed into the field it looks like.
    const q = query.trim();
    setDraft(q.includes('@') ? { name: '', email: q, phone: '' } : /^[+\d\s().-]{7,}$/.test(q) ? { name: '', email: '', phone: q } : { name: q, email: '', phone: '' });
    setAdding(true);
  };

  const save = () =>
    startTransition(async () => {
      setError('');
      const result = await quickAddCustomer(tenantId, draft);
      if (result.ok) pick(result.data.customer, result.data.note);
      else setError(result.error);
    });

  if (value) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 rounded-md bg-stone-50 px-3 py-2 text-sm">
          <span>
            <span className="font-medium">{value.name}</span>
            {(value.email || value.phone) && <span className="block text-xs text-stone-500">{value.email ?? value.phone}</span>}
          </span>
          <button type="button" className="text-xs text-stone-500 hover:underline" disabled={disabled || pending} onClick={() => pick(null)}>
            Remove
          </button>
        </div>
        {message && <p className="text-xs text-stone-500">{message}</p>}
      </div>
    );
  }

  if (adding) {
    return (
      <div className="space-y-2">
        <input className="input" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
        <input className="input" type="email" placeholder="Email (for receipts)" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        <input className="input" type="tel" placeholder="Phone" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
        {error && <p className="text-xs text-red-700">{error}</p>}
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" disabled={disabled || pending || !draft.name.trim()} onClick={save}>
            Add customer
          </button>
          <button type="button" className="text-sm text-stone-500 hover:underline" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <input className="input" placeholder="Customer: name, email or phone" value={query} onChange={(e) => setQuery(e.target.value)} disabled={disabled} />
      {error && <p className="text-xs text-red-700">{error}</p>}
      {found.length > 0 && (
        <ul className="divide-y divide-stone-100 rounded-md border border-stone-200">
          {found.map((c) => (
            <li key={c.id}>
              <button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-stone-50" onClick={() => pick(c)}>
                {c.name} {(c.email || c.phone) && <span className="text-xs text-stone-500">· {c.email ?? c.phone}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="text-xs text-stone-500 hover:underline" disabled={disabled} onClick={startAdding}>
        + New customer{query.trim() && !found.length && !pending ? ` “${query.trim()}”` : ''}
      </button>
    </div>
  );
}
