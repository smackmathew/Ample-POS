import { inflateRawSync } from 'node:zlib';

/**
 * Reads the first worksheet of an Excel workbook (.xlsx) into rows of text,
 * the same shape parseCsv returns. Just enough of the format for exports from
 * QuickBooks POS and spreadsheets: shared and inline strings, numbers, booleans
 * and dates (cells with a date format become YYYY-MM-DD). No formulas are run;
 * the cached value Excel saved is used.
 */
export class XlsxError extends Error {}

const MAX_UNZIPPED = 200 * 1024 * 1024;

export function isXlsx(bytes: Buffer): boolean {
  // A zip file ("PK\x03\x04") holding xl/workbook.xml.
  return bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50 && bytes.includes('xl/workbook.xml');
}

export function readXlsx(bytes: Buffer): string[][] {
  const files = unzip(bytes);
  const text = (name: string) => {
    const f = files.get(name);
    return f ? f.toString('utf8') : null;
  };

  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new XlsxError('This isn’t an Excel workbook (.xlsx)');
  const firstSheet = /<(?:\w+:)?sheet\b[^>]*?\br:id="([^"]+)"/.exec(workbook)?.[1] ?? /<(?:\w+:)?sheet\b[^>]*?\bid="([^"]+)"/.exec(workbook)?.[1];
  const rels = text('xl/_rels/workbook.xml.rels') ?? '';
  let target: string | undefined;
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    if (attr(m[1]!, 'Id') === firstSheet) target = attr(m[1]!, 'Target');
  }
  const sheetPath = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : 'xl/worksheets/sheet1.xml';
  const sheet = text(sheetPath);
  if (!sheet) throw new XlsxError('The workbook has no worksheet');

  const shared = sharedStrings(text('xl/sharedStrings.xml'));
  const dateStyles = dateStyleIndexes(text('xl/styles.xml'));

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const cells: string[] = [];
    let nextCol = 0;
    for (const c of (rowMatch[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = c[1]!;
      const body = c[2] ?? '';
      const ref = attr(attrs, 'r');
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      cells[col] = cellValue(attr(attrs, 't'), Number(attr(attrs, 's') ?? -1), body, shared, dateStyles);
    }
    rows.push(Array.from(cells, (v) => v ?? ''));
  }
  // Drop empty cells at the end of rows, and empty rows, as parseCsv does.
  const trimmed = rows.map((r) => {
    let end = r.length;
    while (end > 0 && r[end - 1] === '') end--;
    return r.slice(0, end);
  });
  return trimmed.filter((r) => r.length > 0);
}

function cellValue(type: string | undefined, style: number, body: string, shared: string[], dateStyles: Set<number>): string {
  const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
  switch (type) {
    case 's':
      return shared[Number(v)] ?? '';
    case 'inlineStr':
      return textOf(body);
    case 'str':
      return decode(v ?? '');
    case 'b':
      return v === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return '';
    default: {
      if (v === undefined || v === '') return '';
      const n = Number(v);
      if (dateStyles.has(style) && Number.isFinite(n)) return excelDate(n);
      // Excel stores 0.1 + 0.2 as 0.30000000000000004; show what the cell shows.
      return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : decode(v);
    }
  }
}

/** Excel serial date (1900 system) to YYYY-MM-DD. */
function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]!));
}

/** The text of a string item: plain <t>, or rich text runs <r><t>…</t></r>, skipping phonetic hints. */
function textOf(xml: string): string {
  const withoutPhonetic = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  return [...withoutPhonetic.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decode(m[1]!)).join('');
}

/** Which cell styles (cellXfs indexes) show a date. */
function dateStyleIndexes(xml: string | null): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?>/g)) custom.set(Number(attr(m[1]!, 'numFmtId')), decode(attr(m[1]!, 'formatCode') ?? ''));
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<(?:\w+:)?xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/(?:\w+:)?xf>)/g)) {
    const id = Number(attr(m[1]!, 'numFmtId') ?? 0);
    const builtInDate = (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
    // A custom format is a date if it has day/month/year parts outside quotes and brackets.
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (builtInDate || /[dy]|m{3,}/i.test(code) || (/m/i.test(code) && /[dy]/i.test(code))) out.add(i);
    i++;
  }
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
}

function decode(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
      if (e[0] === '#') return String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()]!;
    });
}

/** The files in a zip, from its central directory. Only "stored" and "deflate", as Excel writes. */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('This isn’t an Excel workbook (.xlsx), or the file is damaged');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('The Excel file is damaged');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    // Only the parts we read; skip images and the rest.
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    total += size;
    if (total > MAX_UNZIPPED) throw new XlsxError('The Excel file is too large once opened; split it into smaller files');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError('The Excel file is damaged');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: Math.max(size, 1) + 1024 }));
    else throw new XlsxError('This Excel file uses compression we can’t read; save it again from Excel');
  }
  return out;
}
