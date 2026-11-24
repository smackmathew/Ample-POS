'use client';

import { useOptimistic, useState, useTransition } from 'react';
import type { CompanyTool } from '@/lib/platform';
import { setCompanyTool } from '../../actions';

/** One tool for one company: on/off, free, blocked. */
export function ToolRow({ companyId, tool, price }: { companyId: string; tool: CompanyTool; price: string }) {
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  // Show the change at once; it settles to the saved state (or back, on an error).
  const [shown, show] = useOptimistic(tool, (t, c: { enabled?: boolean; comped?: boolean; blocked?: boolean }) => ({ ...t, ...c, ...(c.blocked ? { enabled: false } : {}) }));
  const change = (c: { enabled?: boolean; comped?: boolean; blocked?: boolean }) =>
    startTransition(async () => {
      setError('');
      show(c);
      const r = await setCompanyTool(companyId, tool.id, c);
      if (r?.error) setError(r.error);
    });
  return (
    <tr className="border-t border-stone-100">
      <td className="py-2">
        {tool.name}
        {!tool.available && <span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">off for everyone</span>}
        {error && <div className="text-xs text-red-700">{error}</div>}
      </td>
      <td className="text-stone-500">{price}</td>
      <td>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={shown.enabled} disabled={pending || shown.blocked} onChange={(e) => change({ enabled: e.target.checked })} />
          {shown.enabled ? 'On' : 'Off'}
        </label>
      </td>
      <td>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={shown.comped} disabled={pending} onChange={(e) => change({ comped: e.target.checked })} />
          Free
        </label>
      </td>
      <td>
        <label className="flex items-center gap-2" title="Switch it off and stop the business turning it back on">
          <input type="checkbox" checked={shown.blocked} disabled={pending} onChange={(e) => change({ blocked: e.target.checked })} />
          Blocked
        </label>
      </td>
    </tr>
  );
}
