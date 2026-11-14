/**
 * One receipt layout for every place a receipt appears: printed from the web
 * hub or the register app (80mm receipt paper, or any printer), and emailed.
 * The API builds the `Receipt`; these functions only lay it out.
 */

export interface ReceiptAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface Receipt {
  saleId: string;
  business: { name: string; phone: string | null; website: string | null; footer: string | null };
  location: { name: string; address: ReceiptAddress | null; timezone: string };
  receiptNumber: number | null;
  status: 'open' | 'completed' | 'voided';
  /** When the sale was completed (or created, if it never was). */
  issuedAt: string;
  cashier: string | null;
  currency: string;
  /** `detail` is an extra line under the item, such as a gift card's code. */
  lines: { description: string; quantity: number; unitPriceMinor: number; discountMinor: number; totalMinor: number; detail?: string | null }[];
  /** Before discounts (as stored on the sale); the receipt shows it net of them. */
  subtotalMinor: number;
  /** All discounts, including any loyalty reward. */
  discountMinor: number;
  /** Money off from a loyalty reward, shown as its own row. Line discounts don't include it. */
  rewardMinor?: number;
  /** The customer's points, when the sale has a customer in a rewards program. */
  loyalty?: { earned: number; balance: number } | null;
  taxMinor: number;
  totalMinor: number;
  payments: {
    method: 'cash' | 'card' | 'gift_card';
    amountMinor: number;
    tenderedMinor: number | null;
    changeMinor: number | null;
    /** Gift card payments: the card's last 4 and what's left on it. */
    giftCard?: { last4: string; balanceMinor: number } | null;
  }[];
  refunds: { createdAt: string; amountMinor: number; reason: string | null }[];
}

export function formatReceiptMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

export function formatReceiptTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function addressLines(a: ReceiptAddress | null): string[] {
  if (!a) return [];
  return [a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(' ')].filter((l): l is string => Boolean(l));
}

/** Rows shared by the HTML and text layouts, so both always say the same thing. */
function receiptRows(r: Receipt) {
  const money = (m: number) => formatReceiptMoney(m, r.currency);
  const header = [r.business.name, r.location.name, ...addressLines(r.location.address), r.business.phone].filter((l): l is string => Boolean(l));
  const meta = [
    r.receiptNumber !== null ? `Receipt #${r.receiptNumber}` : 'Receipt (not completed)',
    formatReceiptTime(r.issuedAt, r.location.timezone),
    r.cashier ? `Served by ${r.cashier}` : null,
  ].filter((l): l is string => Boolean(l));
  const items = r.lines.map((l) => ({
    left: `${l.quantity} × ${l.description}`,
    right: money(l.totalMinor),
    note:
      [l.quantity > 1 ? `${money(l.unitPriceMinor)} each` : null, l.discountMinor > 0 ? `${money(l.discountMinor)} off` : null, l.detail ?? null].filter(Boolean).join(' · ') ||
      null,
  }));
  // Lines are shown after their discounts, so the subtotal is too: everything adds up.
  const reward = r.rewardMinor ?? 0;
  const totals = [
    { left: 'Subtotal', right: money(r.subtotalMinor - r.discountMinor + reward), strong: false },
    ...(reward > 0 ? [{ left: 'Loyalty reward', right: `−${money(reward)}`, strong: false }] : []),
    { left: 'Tax', right: money(r.taxMinor), strong: false },
    { left: 'Total', right: money(r.totalMinor), strong: true },
  ];
  const payments = r.payments.flatMap((p) =>
    p.method === 'cash'
      ? [
          { left: 'Cash', right: money(p.tenderedMinor ?? p.amountMinor) },
          ...(p.changeMinor ? [{ left: 'Change', right: money(p.changeMinor) }] : []),
        ]
      : p.method === 'gift_card'
        ? [
            { left: `Gift card ••••${p.giftCard?.last4 ?? ''}`, right: money(p.amountMinor) },
            ...(p.giftCard ? [{ left: `Left on gift card ••••${p.giftCard.last4}`, right: money(p.giftCard.balanceMinor) }] : []),
          ]
        : [{ left: 'Card', right: money(p.amountMinor) }],
  );
  const refunds = r.refunds.map((f) => ({
    left: `Refund ${formatReceiptTime(f.createdAt, r.location.timezone)}${f.reason ? ` (${f.reason})` : ''}`,
    right: `−${money(f.amountMinor)}`,
  }));
  const points = (n: number) => `${n.toLocaleString('en-US')} point${n === 1 || n === -1 ? '' : 's'}`;
  const footer = [
    r.discountMinor > 0 ? `You saved ${money(r.discountMinor)}` : null,
    r.loyalty ? `${r.loyalty.earned > 0 ? `You earned ${points(r.loyalty.earned)}. ` : ''}Balance: ${points(r.loyalty.balance)}` : null,
    r.business.footer,
    r.business.website,
  ].filter(
    (l): l is string => Boolean(l),
  );
  return { header, meta, items, totals, payments, refunds, footer };
}

/**
 * A self-contained HTML receipt. Sized for 80mm receipt paper when printed
 * (and readable on a normal page or in an email).
 */
export function receiptHtml(r: Receipt, options: { title?: string } = {}): string {
  const rows = receiptRows(r);
  const row = (left: string, right: string, cls = '') =>
    `<tr class="${cls}"><td>${escape(left)}</td><td class="r">${escape(right)}</td></tr>`;
  const voided = r.status === 'voided' ? '<p class="void">VOIDED — not a valid receipt</p>' : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title ?? `${r.business.name} receipt`)}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { margin: 0; background: #fff; color: #111; font: 13px/1.4 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .receipt { max-width: 72mm; margin: 0 auto; padding: 8px 0; }
  .c { text-align: center; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  p { margin: 0; }
  .muted { color: #555; }
  hr { border: 0; border-top: 1px dashed #999; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  td.r { text-align: right; white-space: nowrap; padding-left: 8px; }
  .note td { color: #555; font-size: 12px; padding-left: 12px; }
  .strong td { font-weight: 700; font-size: 15px; padding-top: 3px; }
  .void { text-align: center; font-weight: 700; border: 2px solid #111; padding: 4px; margin: 6px 0; }
</style></head>
<body><div class="receipt">
<div class="c"><h1>${escape(rows.header[0] ?? '')}</h1>${rows.header.slice(1).map((l) => `<p class="muted">${escape(l)}</p>`).join('')}</div>
<hr><div class="c">${rows.meta.map((l) => `<p>${escape(l)}</p>`).join('')}</div>${voided}<hr>
<table>${rows.items.map((i) => row(i.left, i.right) + (i.note ? `<tr class="note"><td colspan="2">${escape(i.note)}</td></tr>` : '')).join('')}</table>
<hr><table>${rows.totals.map((t) => row(t.left, t.right, t.strong ? 'strong' : '')).join('')}</table>
${rows.payments.length ? `<hr><table>${rows.payments.map((p) => row(p.left, p.right)).join('')}</table>` : ''}
${rows.refunds.length ? `<hr><table>${rows.refunds.map((p) => row(p.left, p.right)).join('')}</table>` : ''}
${rows.footer.length ? `<hr><div class="c">${rows.footer.map((l) => `<p>${escape(l)}</p>`).join('')}</div>` : ''}
</div></body></html>`;
}

/** The same receipt as plain text (email fallback), 40 columns wide. */
export function receiptText(r: Receipt, width = 40): string {
  const rows = receiptRows(r);
  const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((width - s.length) / 2))) + s;
  const pair = (left: string, right: string) => {
    const space = width - right.length - 1;
    return left.length <= space ? `${left.padEnd(space)} ${right}` : `${left}\n${' '.repeat(width - right.length)}${right}`;
  };
  const rule = '-'.repeat(width);
  return [
    ...rows.header.map(center),
    rule,
    ...rows.meta.map(center),
    ...(r.status === 'voided' ? [center('*** VOIDED ***')] : []),
    rule,
    ...rows.items.flatMap((i) => [pair(i.left, i.right), ...(i.note ? [`  ${i.note}`] : [])]),
    rule,
    ...rows.totals.map((t) => pair(t.strong ? t.left.toUpperCase() : t.left, t.right)),
    ...(rows.payments.length ? [rule, ...rows.payments.map((p) => pair(p.left, p.right))] : []),
    ...(rows.refunds.length ? [rule, ...rows.refunds.map((p) => pair(p.left, p.right))] : []),
    ...(rows.footer.length ? [rule, ...rows.footer.map(center)] : []),
  ].join('\n');
}
