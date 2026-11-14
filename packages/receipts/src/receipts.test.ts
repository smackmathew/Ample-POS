import { describe, expect, it } from 'vitest';
import { receiptHtml, receiptText, type Receipt } from './index';

const receipt: Receipt = {
  saleId: 's1',
  business: { name: 'Corner Cafe', phone: '(312) 555-0100', website: 'cornercafe.example', footer: 'Thanks for visiting!' },
  location: { name: 'Main St', address: { line1: '100 Main St', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'US' }, timezone: 'America/Chicago' },
  receiptNumber: 42,
  status: 'completed',
  issuedAt: '2026-11-14T02:05:00Z',
  cashier: 'Sam',
  currency: 'USD',
  lines: [
    { description: 'Latte', quantity: 2, unitPriceMinor: 450, discountMinor: 0, totalMinor: 900 },
    { description: 'Muffin <blueberry>', quantity: 1, unitPriceMinor: 325, discountMinor: 25, totalMinor: 300 },
  ],
  subtotalMinor: 1225,
  discountMinor: 25,
  taxMinor: 120,
  totalMinor: 1320,
  payments: [
    { method: 'cash', amountMinor: 500, tenderedMinor: 500, changeMinor: 0 },
    { method: 'card', amountMinor: 820, tenderedMinor: null, changeMinor: null },
  ],
  refunds: [],
};

describe('receipts', () => {
  it('lays out the same content as text, in the store’s time zone', () => {
    const text = receiptText(receipt);
    expect(text).toContain('Corner Cafe');
    expect(text).toContain('Receipt #42');
    // 02:05 UTC on the 14th is 8:05 PM on the 13th in Chicago.
    expect(text).toContain('Nov 13, 2026, 8:05 PM');
    expect(text).toContain('2 × Latte');
    expect(text).toContain('$4.50 each');
    // Lines after discounts add up to the subtotal: $9.00 + $3.00 = $12.00.
    expect(text).toMatch(/Subtotal\s+\$12\.00/);
    expect(text).toMatch(/TOTAL\s+\$13\.20/);
    expect(text).toContain('You saved $0.25');
    expect(text).toMatch(/Card\s+\$8\.20/);
    expect(text).toContain('Thanks for visiting!');
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(40);
  });

  it('escapes HTML and marks voided sales', () => {
    const html = receiptHtml({ ...receipt, status: 'voided' });
    expect(html).toContain('Muffin &lt;blueberry&gt;');
    expect(html).not.toContain('<blueberry>');
    expect(html).toContain('VOIDED');
    expect(html).toContain('@page { size: 80mm auto');
  });

  it('shows change for cash and refunds', () => {
    const text = receiptText({
      ...receipt,
      payments: [{ method: 'cash', amountMinor: 1320, tenderedMinor: 2000, changeMinor: 680 }],
      refunds: [{ createdAt: '2026-11-15T15:00:00Z', amountMinor: 300, reason: 'stale' }],
    });
    expect(text).toMatch(/Cash\s+\$20\.00/);
    expect(text).toMatch(/Change\s+\$6\.80/);
    expect(text).toContain('Refund Nov 15, 2026, 9:00 AM (stale)');
  });

  it('shows a loyalty reward as its own row and the customer’s points', () => {
    // $12.00 of items, $5.00 reward, tax on the $7.00 left.
    const text = receiptText({ ...receipt, discountMinor: 525, rewardMinor: 500, taxMinor: 70, totalMinor: 770, payments: [], loyalty: { earned: 7, balance: 32 } });
    expect(text).toMatch(/Subtotal\s+\$12\.00/);
    expect(text).toMatch(/Loyalty reward\s+−\$5\.00/);
    expect(text).toMatch(/TOTAL\s+\$7\.70/);
    expect(text).toContain('You saved $5.25');
    expect(text).toContain('You earned 7 points. Balance: 32 points');
    expect(receiptText({ ...receipt, loyalty: { earned: 0, balance: 1 } })).toContain('Balance: 1 point');
  });
});
