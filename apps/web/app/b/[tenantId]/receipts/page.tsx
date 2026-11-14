import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import type { CurrentTenant } from '@/lib/types';
import { saveReceiptSettings } from '../sales-actions';

export default async function ReceiptsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const current = await api<CurrentTenant>('/tenant', { tenantId });
  const s = current.tenant.receiptSettings ?? {};
  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Receipts</h1>
        <p className="mt-1 text-sm text-stone-600">
          Every receipt shows your business name and the store’s name and address (from Locations). Add these to show more. Leave a field blank to leave it off.
        </p>
      </div>
      <ActionForm action={saveReceiptSettings.bind(null, tenantId)} className="card grid gap-3">
        <label className="block text-sm">
          Phone
          <input name="phone" defaultValue={s.phone} placeholder="(312) 555-0100" className="input mt-1" />
        </label>
        <label className="block text-sm">
          Website
          <input name="website" defaultValue={s.website} placeholder="cornercafe.com" className="input mt-1" />
        </label>
        <label className="block text-sm">
          Message at the bottom
          <textarea name="footer" defaultValue={s.footer} rows={3} maxLength={300} placeholder="Thanks for visiting! Returns within 30 days with receipt." className="input mt-1" />
        </label>
        <button className="btn justify-self-start">Save</button>
      </ActionForm>
      <p className="text-sm text-stone-600">
        Print receipts from any sale’s page, or from the register app after a sale. Receipt printers that work with your computer, AirPrint or Android printing all work; the layout fits 80 mm paper.
      </p>
    </div>
  );
}
