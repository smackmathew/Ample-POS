import { receiptHtml, type Receipt } from '@pos/receipts';
import { api, ApiError } from '@/lib/api';

/**
 * The printable receipt: the same layout the app prints and the email shows,
 * with a Print button that doesn't print. Opens the print dialog by itself
 * when asked to (?print=1).
 */
export async function GET(request: Request, { params }: { params: Promise<{ tenantId: string; saleId: string }> }) {
  const { tenantId, saleId } = await params;
  let receipt: Receipt;
  try {
    receipt = await api<Receipt>(`/sales/${saleId}/receipt`, { tenantId });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    return new Response(err instanceof Error ? err.message : 'Receipt not available', { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const autoPrint = new URL(request.url).searchParams.get('print') === '1';
  const toolbar = `<div class="no-print" style="text-align:center;margin:16px 0;font:14px system-ui,sans-serif">
  <button onclick="window.print()" style="padding:8px 16px;border-radius:8px;border:1px solid #0f766e;background:#0f766e;color:#fff;cursor:pointer">Print receipt</button>
</div>
<style>@media print { .no-print { display: none !important; } }</style>
${autoPrint ? '<script>window.addEventListener("load", () => window.print());</script>' : ''}`;
  const html = receiptHtml(receipt).replace('<body>', `<body>${toolbar}`);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
