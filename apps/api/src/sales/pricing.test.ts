import { describe, expect, it } from 'vitest';
import { allocateRefund, priceLine, refundAmountForLine, sumPrices } from './pricing';

describe('priceLine', () => {
  it('applies discount before tax and rounds tax half up per line', () => {
    // 3 × $3.33 = $9.99, less $1.00 → $8.99 at 8.25% = 74.1675¢ → 74¢
    expect(priceLine({ unitPriceMinor: 333, quantity: 3, discountMinor: 100 }, 825)).toEqual({
      subtotalMinor: 999,
      discountMinor: 100,
      taxMinor: 74,
      totalMinor: 973,
    });
    // Exactly half a cent rounds up: $1.00 at 0.5% = 0.5¢ → 1¢
    expect(priceLine({ unitPriceMinor: 100, quantity: 1, discountMinor: 0 }, 50).taxMinor).toBe(1);
    expect(priceLine({ unitPriceMinor: 100, quantity: 1, discountMinor: 0 }, 0).totalMinor).toBe(100);
  });

  it('handles large amounts without floating point error', () => {
    const line = priceLine({ unitPriceMinor: 99_999_999_99, quantity: 1000, discountMinor: 0 }, 9999);
    expect(line.subtotalMinor).toBe(99_999_999_990_00);
    expect(line.taxMinor).toBe(99_989_999_990_00); // 9,999,999,999,000 × 0.9999 = …000.1 → rounds down
  });

  it('rejects discounts larger than the line', () => {
    expect(() => priceLine({ unitPriceMinor: 100, quantity: 1, discountMinor: 101 }, 0)).toThrow(RangeError);
  });

  it('sums lines', () => {
    const a = priceLine({ unitPriceMinor: 500, quantity: 2, discountMinor: 0 }, 1000);
    const b = priceLine({ unitPriceMinor: 250, quantity: 1, discountMinor: 50 }, 1000);
    expect(sumPrices([a, b])).toEqual({ subtotalMinor: 1250, discountMinor: 50, taxMinor: 120, totalMinor: 1320 });
  });
});

describe('refundAmountForLine', () => {
  it('splits a line across partial refunds without losing a cent', () => {
    const line = { totalMinor: 1000, quantity: 3 };
    const first = refundAmountForLine(line, { quantity: 0, amountMinor: 0 }, 1);
    const second = refundAmountForLine(line, { quantity: 1, amountMinor: first }, 1);
    const last = refundAmountForLine(line, { quantity: 2, amountMinor: first + second }, 1);
    expect([first, second, last]).toEqual([333, 333, 334]);
  });

  it('refuses to refund more units than remain', () => {
    expect(() => refundAmountForLine({ totalMinor: 100, quantity: 2 }, { quantity: 2, amountMinor: 100 }, 1)).toThrow(/Only 0 left/);
  });
});

describe('allocateRefund', () => {
  it('takes from the most recent payments first', () => {
    const payments = [
      { id: 'cash', method: 'cash' as const, refundableMinor: 500 },
      { id: 'card', method: 'card' as const, refundableMinor: 700 },
    ];
    expect(allocateRefund(900, payments)).toEqual([
      { paymentId: 'card', method: 'card', amountMinor: 700 },
      { paymentId: 'cash', method: 'cash', amountMinor: 200 },
    ]);
    expect(() => allocateRefund(1201, payments)).toThrow(/exceeds/);
  });
});
