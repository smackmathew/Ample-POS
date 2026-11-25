import { describe, expect, it } from 'vitest';
import type { Receipt } from './index';
import { columnsFor, parseTagSize, receiptEscPos, receiptStar, tagEpl, tagHtml, tagTspl, tagZpl, toPrinterAscii } from './printing';

const receipt: Receipt = {
  saleId: 's1',
  business: { name: 'Corner Café', phone: null, website: null, footer: 'Thanks — see you soon!' },
  location: { name: 'Main St', address: null, timezone: 'UTC' },
  receiptNumber: 7,
  status: 'completed',
  issuedAt: '2026-11-25T12:00:00Z',
  cashier: null,
  currency: 'USD',
  lines: [{ description: 'Latte', quantity: 2, unitPriceMinor: 450, discountMinor: 0, totalMinor: 900 }],
  subtotalMinor: 900,
  discountMinor: 0,
  taxMinor: 72,
  totalMinor: 972,
  payments: [{ method: 'cash', amountMinor: 972, tenderedMinor: 1000, changeMinor: 28 }],
  refunds: [],
};

const text = (b: Uint8Array) => String.fromCharCode(...b);

describe('receipt printers', () => {
  it('builds ESC/POS: initialise, the receipt in plain ASCII at the paper width, feed and cut', () => {
    const out = receiptEscPos(receipt, { paper: '80mm' });
    expect([...out.slice(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...out.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0]);
    const body = text(out);
    expect(body).toContain('Corner Cafe');
    expect(body).toContain('Thanks - see you soon!');
    expect(body).toContain('2 x Latte');
    expect([...out].every((b) => b < 0x80)).toBe(true);
    // 80mm paper is 48 characters wide, 58mm is 32.
    expect(Math.max(...body.split('\n').map((l) => l.length))).toBeLessThanOrEqual(48);
    expect(Math.max(...text(receiptEscPos(receipt, { paper: '58mm' })).split('\n').map((l) => l.length))).toBeLessThanOrEqual(32);
    expect(columnsFor(null)).toBe(48);
  });

  it('opens the cash drawer only when asked, and speaks Star for Star printers', () => {
    expect(text(receiptEscPos(receipt))).not.toContain('\x1bp');
    expect([...receiptEscPos(receipt, { openDrawer: true }).slice(2, 7)]).toEqual([0x1b, 0x70, 0, 25, 250]);
    const star = receiptStar(receipt, { openDrawer: true });
    expect([...star.slice(0, 3)]).toEqual([0x1b, 0x40, 0x07]);
    expect([...star.slice(-3)]).toEqual([0x1b, 0x64, 0x03]);
    expect(text(star)).toContain('\r\n');
  });

  it('keeps printable ASCII only', () => {
    expect(toPrinterAscii('Crème brûlée “special” – 2×')).toBe('Creme brulee "special" - 2x');
    expect(toPrinterAscii('☕ tea')).toBe('? tea');
  });
});

describe('tag printers', () => {
  const tag = { name: 'Rain jacket', variant: 'Navy / L', priceMinor: 12900, currency: 'USD', sku: 'JKT-NAVY-L', barcode: '0123456789012' };

  it('reads tag sizes in inches or millimetres', () => {
    expect(parseTagSize('2x1in')).toEqual({ widthIn: 2, heightIn: 1 });
    expect(parseTagSize('2.25 x 1.25')).toEqual({ widthIn: 2.25, heightIn: 1.25 });
    expect(parseTagSize('50x25mm').widthIn).toBeCloseTo(1.969, 2);
    expect(parseTagSize('weird')).toEqual({ widthIn: 2, heightIn: 1 });
  });

  it('prints name, price and a Code 128 barcode in ZPL, TSPL and EPL', () => {
    const size = parseTagSize('2x1in');
    const zpl = tagZpl(tag, size, 3);
    expect(zpl).toMatch(/^\^XA/);
    expect(zpl).toContain('^PW406');
    expect(zpl).toContain('^FDRain jacket - Navy / L^FS');
    expect(zpl).toContain('^FD$129.00^FS');
    expect(zpl).toContain('^BCN');
    expect(zpl).toContain('^FD0123456789012^FS');
    expect(zpl).toContain('^PQ3');
    expect(zpl.trim()).toMatch(/\^XZ$/);

    const tspl = tagTspl(tag, size, 2);
    expect(tspl).toContain('SIZE 2.00,1.00');
    expect(tspl).toContain('"Rain jacket - Navy / L"');
    expect(tspl).toContain('BARCODE 16,');
    expect(tspl).toContain('"128"');
    expect(tspl).toContain('PRINT 2');

    const epl = tagEpl({ ...tag, barcode: null }, size);
    expect(epl).toContain('q406');
    expect(epl).toContain('"JKT-NAVY-L"');
    expect(epl).toContain('P1');
  });

  it('shortens long names to fit the tag instead of printing over them', () => {
    const long = { ...tag, name: 'Organic cotton crew socks with reinforced heel and toe', variant: 'Charcoal / M' };
    const zpl = tagZpl(long, parseTagSize('1.25x1in'));
    const title = /\^FD(.*?)\^FS/.exec(zpl)![1]!;
    expect(title.endsWith('...')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(30);
    expect(tagTspl(long, parseTagSize('2x1in'))).toContain('"Organic cotton crew..."');
  });

  it('narrows the barcode when a long code would run off a small tag', () => {
    expect(tagZpl(tag, parseTagSize('2x1in'))).toContain('^BY2');
    expect(tagZpl({ ...tag, barcode: 'SKU-LONG-CODE-00012345' }, parseTagSize('2x1in'))).toContain('^BY1');
    expect(tagZpl(tag, parseTagSize('1.25x1in'))).toContain('^BY1');
  });

  it('leaves the barcode off when there is nothing to encode, and lays out pages for the print dialog', () => {
    expect(tagZpl({ name: 'Gift wrap', priceMinor: 300, currency: 'USD' }, parseTagSize('2x1in'))).not.toContain('^BC');
    const html = tagHtml([{ tag, copies: 2 }], parseTagSize('2x1in'));
    expect(html).toContain('size: 2in 1in');
    expect(html.match(/class="tag"/g)).toHaveLength(2);
  });
});
