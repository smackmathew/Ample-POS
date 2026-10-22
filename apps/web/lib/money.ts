/** Parses "12", "12.5" or "12.50" into minor units without floating point. Returns null if invalid. */
export function parseMoney(input: string): number | null {
  const m = /^\s*(\d{1,10})(?:\.(\d{1,2}))?\s*$/.exec(input.replace(/[$,]/g, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

/** Minor units back to an editable "12.50" string. */
export function moneyInput(minor: number | null | undefined): string {
  return minor == null ? '' : (minor / 100).toFixed(2);
}
