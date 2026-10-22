// Money math for sales and refunds. Everything is integer minor units;
// products use BigInt so large amounts times rates cannot lose precision.

export interface LineInput {
  unitPriceMinor: number;
  quantity: number;
  discountMinor: number;
}

export interface LinePrice {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/** Rounds a non-negative a/b to the nearest integer, halves up. */
function divRoundHalfUp(a: bigint, b: bigint): bigint {
  return (a * 2n + b) / (b * 2n);
}

/** Prices are tax-exclusive; tax is charged on the discounted amount, rounded per line. */
export function priceLine(line: LineInput, taxRateBps: number): LinePrice {
  const subtotal = BigInt(line.unitPriceMinor) * BigInt(line.quantity);
  const discount = BigInt(line.discountMinor);
  if (discount < 0n || discount > subtotal) throw new RangeError('Discount must be between zero and the line amount');
  const taxable = subtotal - discount;
  const tax = divRoundHalfUp(taxable * BigInt(taxRateBps), 10_000n);
  return {
    subtotalMinor: Number(subtotal),
    discountMinor: Number(discount),
    taxMinor: Number(tax),
    totalMinor: Number(taxable + tax),
  };
}

export function sumPrices(lines: LinePrice[]): LinePrice {
  return lines.reduce(
    (acc, l) => ({
      subtotalMinor: acc.subtotalMinor + l.subtotalMinor,
      discountMinor: acc.discountMinor + l.discountMinor,
      taxMinor: acc.taxMinor + l.taxMinor,
      totalMinor: acc.totalMinor + l.totalMinor,
    }),
    { subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 },
  );
}

/**
 * Amount to refund for `quantity` units of a sale line. Partial refunds take
 * a proportional share rounded down; the refund that returns the last unit
 * takes whatever is left, so a line never refunds more or less than it cost.
 */
export function refundAmountForLine(
  line: { totalMinor: number; quantity: number },
  already: { quantity: number; amountMinor: number },
  quantity: number,
): number {
  const remaining = line.quantity - already.quantity;
  if (quantity < 1 || quantity > remaining) throw new RangeError(`Only ${remaining} left to refund on this line`);
  if (quantity === remaining) return line.totalMinor - already.amountMinor;
  return Number((BigInt(line.totalMinor) * BigInt(quantity)) / BigInt(line.quantity));
}

export interface RefundablePayment {
  id: string;
  method: 'cash' | 'card';
  /** Succeeded amount minus what earlier refunds already took from it. */
  refundableMinor: number;
}

/** Spreads a refund across the original payments, most recent first. */
export function allocateRefund(amountMinor: number, payments: RefundablePayment[]): { paymentId: string; method: 'cash' | 'card'; amountMinor: number }[] {
  let left = amountMinor;
  const out: { paymentId: string; method: 'cash' | 'card'; amountMinor: number }[] = [];
  for (const p of [...payments].reverse()) {
    if (left === 0) break;
    const take = Math.min(left, p.refundableMinor);
    if (take > 0) {
      out.push({ paymentId: p.id, method: p.method, amountMinor: take });
      left -= take;
    }
  }
  if (left > 0) throw new RangeError('Refund exceeds what was paid');
  return out;
}
