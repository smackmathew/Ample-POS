/**
 * Printer commands for thermal printers: receipts in ESC/POS or Star, price
 * tags in ZPL (Zebra), TSPL (TSC, Rollo...) or EPL. Pure functions that return
 * bytes or text; the register app sends them to the printer.
 */
import { formatReceiptMoney, receiptText, type Receipt } from './index';

const ESC = 0x1b;
const GS = 0x1d;

/** Characters per line for common paper widths (font A). */
export function columnsFor(paper: string | null | undefined): number {
  return paper === '58mm' ? 32 : 48;
}

/** Thermal printers' default code page is ASCII-safe; swap typographic characters and drop the rest. */
export function toPrinterAscii(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '*')
    .replace(/×/g, 'x')
    .replace(/ /g, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\n\x20-\x7e]/g, '?');
}

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (let i = 0; i < p.length; i++) out.push(p.charCodeAt(i) & 0xff);
    else out.push(...p);
  }
  return Uint8Array.from(out);
}

export interface ReceiptPrintOptions {
  paper?: string | null;
  /** Kick the cash drawer plugged into the printer (cash sales). */
  openDrawer?: boolean;
}

/** A receipt as ESC/POS: Epson and most receipt printers. Ends with a feed and a cut. */
export function receiptEscPos(r: Receipt, options: ReceiptPrintOptions = {}): Uint8Array {
  const text = toPrinterAscii(receiptText(r, columnsFor(options.paper)));
  return bytes(
    [ESC, 0x40], // initialise
    options.openDrawer ? [ESC, 0x70, 0, 25, 250] : [],
    text,
    '\n\n\n\n',
    [GS, 0x56, 0x42, 0], // feed and partial cut
  );
}

/** A receipt for Star printers in Star Line Mode. */
export function receiptStar(r: Receipt, options: ReceiptPrintOptions = {}): Uint8Array {
  const text = toPrinterAscii(receiptText(r, columnsFor(options.paper)));
  return bytes(
    [ESC, 0x40],
    options.openDrawer ? [0x07] : [],
    text.replace(/\n/g, '\r\n'),
    '\r\n\r\n\r\n',
    [ESC, 0x64, 0x03], // feed and partial cut
  );
}

export interface Tag {
  name: string;
  variant?: string | null;
  priceMinor: number;
  currency: string;
  sku?: string | null;
  /** Printed as a Code 128 barcode; falls back to the SKU. */
  barcode?: string | null;
}

export interface TagSize {
  widthIn: number;
  heightIn: number;
}

/** "2x1in" → 2 × 1 inches; anything unreadable is a 2 × 1 inch tag. */
export function parseTagSize(paper: string | null | undefined): TagSize {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(in|mm)?\s*$/i.exec(paper ?? '');
  if (!m) return { widthIn: 2, heightIn: 1 };
  const k = m[3]?.toLowerCase() === 'mm' ? 1 / 25.4 : 1;
  return { widthIn: Number(m[1]) * k, heightIn: Number(m[2]) * k };
}

/** Thermal label printers are usually 203 dpi. */
const DPI = 203;

/** Shortens text to `max` characters, ending in "..." when cut. */
function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
}

/** How many title characters fit: `lines` lines of a font about half as wide as it is tall. */
function titleChars(L: { w: number; margin: number; title: number }, lines: number): number {
  return Math.max(8, Math.floor((L.w - L.margin * 2) / (L.title * 0.55))) * lines;
}

function tagParts(tag: Tag) {
  const title = toPrinterAscii([tag.name, tag.variant && tag.variant !== 'Default' ? tag.variant : null].filter(Boolean).join(' - '));
  const price = toPrinterAscii(formatReceiptMoney(tag.priceMinor, tag.currency));
  const code = toPrinterAscii(tag.barcode || tag.sku || '').replace(/\s/g, '');
  return { title, price, code };
}

function layout(size: TagSize) {
  const w = Math.round(size.widthIn * DPI);
  const h = Math.round(size.heightIn * DPI);
  // Font and barcode heights scale with the tag, within sensible limits.
  const title = Math.max(20, Math.min(40, Math.round(h * 0.14)));
  const price = Math.max(28, Math.min(80, Math.round(h * 0.22)));
  const bar = Math.max(30, Math.min(120, Math.round(h * 0.28)));
  return { w, h, margin: 16, title, price, bar, priceY: 12 + title * 2 + 6, barY: 12 + title * 2 + 6 + price + 8 };
}

/** Narrow bars (1 dot) when a Code 128 barcode wouldn't fit across the tag at 2 dots. */
function barWidth(code: string, w: number, margin: number): 1 | 2 {
  const modules = 11 * code.length + 35;
  return modules * 2 <= w - margin * 2 ? 2 : 1;
}

/** ZPL for Zebra printers. `copies` tags of the same item. */
export function tagZpl(tag: Tag, size: TagSize, copies = 1): string {
  const { title: full, price, code } = tagParts(tag);
  const L = layout(size);
  const title = fit(full, titleChars(L, 2));
  const safe = (s: string) => s.replace(/[\^~]/g, ' ');
  return [
    '^XA',
    `^PW${L.w}`,
    `^LL${L.h}`,
    `^FO${L.margin},12^A0N,${L.title},${L.title}^FB${L.w - L.margin * 2},2,0,L^FD${safe(title)}^FS`,
    `^FO${L.margin},${L.priceY}^A0N,${L.price},${L.price}^FD${safe(price)}^FS`,
    ...(code ? [`^FO${L.margin},${L.barY}^BY${barWidth(code, L.w, L.margin)}^BCN,${L.bar},Y,N,N^FD${safe(code)}^FS`] : []),
    `^PQ${Math.max(1, copies)}`,
    '^XZ',
    '',
  ].join('\n');
}

/** TSPL for TSC, Rollo, Munbyn and most other thermal label printers. */
export function tagTspl(tag: Tag, size: TagSize, copies = 1): string {
  const { title: full, price, code } = tagParts(tag);
  const L = layout(size);
  // Font 3 is 16 dots wide per character.
  const title = fit(full, Math.floor((L.w - L.margin * 2) / 16));
  const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
  return [
    `SIZE ${size.widthIn.toFixed(2)},${size.heightIn.toFixed(2)}`,
    'GAP 0.12,0',
    'DIRECTION 1',
    'CLS',
    `TEXT ${L.margin},12,"3",0,1,1,${q(title)}`,
    `TEXT ${L.margin},${L.priceY},"4",0,1,1,${q(price)}`,
    ...(code ? [`BARCODE ${L.margin},${L.barY},"128",${L.bar},1,0,${barWidth(code, L.w, L.margin)},${barWidth(code, L.w, L.margin)},${q(code)}`] : []),
    `PRINT ${Math.max(1, copies)}`,
    '',
  ].join('\r\n');
}

/** EPL for older Zebra printers. */
export function tagEpl(tag: Tag, size: TagSize, copies = 1): string {
  const { title: full, price, code } = tagParts(tag);
  const L = layout(size);
  // Font 3 is 12 dots wide per character.
  const title = fit(full, Math.floor((L.w - L.margin * 2) / 12));
  const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
  return [
    '',
    'N',
    `q${L.w}`,
    `Q${L.h},24`,
    `A${L.margin},12,0,3,1,1,N,${q(title)}`,
    `A${L.margin},${L.priceY},0,4,1,1,N,${q(price)}`,
    ...(code ? [`B${L.margin},${L.barY},0,1,${barWidth(code, L.w, L.margin)},${barWidth(code, L.w, L.margin) * 2},${L.bar},B,${q(code)}`] : []),
    `P${Math.max(1, copies)}`,
    '',
  ].join('\n');
}

/** Tags as a printable page, for printers reached through the system print dialog. */
export function tagHtml(tags: { tag: Tag; copies: number }[], size: TagSize): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const one = (tag: Tag) => {
    const { title, price, code } = tagParts(tag);
    return `<div class="tag"><div class="t">${esc(title)}</div><div class="p">${esc(price)}</div>${code ? `<div class="c">${esc(code)}</div>` : ''}</div>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${size.widthIn}in ${size.heightIn}in; margin: 0; }
body { margin: 0; font-family: -apple-system, Helvetica, Arial, sans-serif; }
.tag { width: ${size.widthIn}in; height: ${size.heightIn}in; padding: 0.06in 0.1in; box-sizing: border-box; page-break-after: always; overflow: hidden; }
.t { font-size: 10pt; line-height: 1.15; max-height: 2.3em; overflow: hidden; }
.p { font-size: 20pt; font-weight: 700; margin-top: 2pt; }
.c { font-family: monospace; font-size: 8pt; margin-top: 2pt; letter-spacing: 1px; }
</style></head><body>${tags.flatMap(({ tag, copies }) => Array.from({ length: Math.max(1, copies) }, () => one(tag))).join('')}</body></html>`;
}
