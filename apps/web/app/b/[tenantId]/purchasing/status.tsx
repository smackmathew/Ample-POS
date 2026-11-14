import type { PurchaseOrderStatus } from '@/lib/types';

const LABEL: Record<PurchaseOrderStatus, [string, string]> = {
  draft: ['Draft', 'bg-stone-100 text-stone-700'],
  ordered: ['Ordered', 'bg-sky-50 text-sky-800'],
  partially_received: ['Partly received', 'bg-amber-50 text-amber-800'],
  received: ['Received', 'bg-teal-50 text-teal-800'],
  canceled: ['Canceled', 'bg-stone-100 text-stone-500'],
};

export function StatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const [label, cls] = LABEL[status];
  return <span className={`rounded px-2 py-0.5 text-xs ${cls}`}>{label}</span>;
}
