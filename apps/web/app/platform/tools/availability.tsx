'use client';

import { useState, useTransition } from 'react';
import { setPlatformTool } from '../actions';

/** Switch a tool on or off for every company, with a confirmation. */
export function Availability({ moduleId, name, available, using }: { moduleId: string; name: string; available: boolean; using: number }) {
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const toggle = () => {
    if (available && !window.confirm(`Switch ${name} off for every company? ${using} compan${using === 1 ? 'y uses' : 'ies use'} it; they lose it (and stop paying for it) until you switch it back on.`)) return;
    startTransition(async () => {
      const r = await setPlatformTool(moduleId, { available: !available });
      setError(r?.error ?? '');
    });
  };
  return (
    <div>
      <button className={available ? 'btn-secondary' : 'btn'} disabled={pending} onClick={toggle}>
        {available ? 'On for everyone' : 'Off for everyone — turn on'}
      </button>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
