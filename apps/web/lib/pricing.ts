// Mirrors the API's line pricing so the cart can show totals before the sale
// is created. The server recomputes everything; its numbers are final.

export function estimateLine(unitPriceMinor: number, quantity: number, discountMinor: number, taxRateBps: number) {
  const taxable = BigInt(unitPriceMinor) * BigInt(quantity) - BigInt(discountMinor);
  const tax = (taxable * BigInt(taxRateBps) * 2n + 10_000n) / 20_000n;
  return { taxMinor: Number(tax), totalMinor: Number(taxable + tax) };
}

/** "8.25" → 825 basis points; null if not a valid percentage. */
export function parsePercentToBps(input: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(input);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

export const formatPercent = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
