import { unguard } from './csv';

export type ImportKind = 'products' | 'customers' | 'suppliers' | 'gift_cards' | 'loyalty' | 'sales';
export type ImportSource = 'qbpos' | 'ample' | 'other';

interface FieldDef {
  key: string;
  label: string;
  /** Column names by source; "other" files try every list. */
  qbpos: string[];
  ample: string[];
  other: string[];
}

/**
 * What each import understands, and the column names other systems use for it.
 * QuickBooks POS names come from its Item, Customer and Vendor list exports;
 * the Ample POS names are what our own exports write, so a file round-trips.
 */
export const FIELDS: Record<ImportKind, FieldDef[]> = {
  products: [
    {
      key: 'sku',
      label: 'SKU / item number',
      qbpos: ['Item Number', 'Item #', 'Item No', 'Item No.'],
      ample: ['SKU'],
      other: ['SKU', 'Item Code', 'Product Code', 'Code', 'Item Number'],
    },
    {
      key: 'name',
      label: 'Product name',
      qbpos: ['Item Name', 'Name'],
      ample: ['Product'],
      other: ['Product Name', 'Product', 'Name', 'Title', 'Item Name', 'Item'],
    },
    {
      key: 'description',
      label: 'Description (used as the name when there is none)',
      qbpos: ['Item Description', 'Description', 'Brief Description'],
      ample: [],
      other: ['Description'],
    },
    { key: 'variant', label: 'Variant', qbpos: [], ample: ['Variant'], other: ['Variant', 'Variant Name', 'Option', 'Option1 Value'] },
    { key: 'attribute', label: 'Attribute (e.g. color)', qbpos: ['Attribute', 'Attr'], ample: [], other: ['Attribute', 'Color', 'Colour'] },
    { key: 'size', label: 'Size', qbpos: ['Size'], ample: [], other: ['Size'] },
    {
      key: 'category',
      label: 'Category',
      qbpos: ['Department Name', 'Department', 'Dept Name', 'Dept'],
      ample: ['Category'],
      other: ['Category', 'Department', 'Product Type', 'Type'],
    },
    {
      key: 'price',
      label: 'Price',
      qbpos: ['Regular Price', 'Price 1', 'Price'],
      ample: ['Price'],
      other: ['Price', 'Retail Price', 'Retail', 'Selling Price', 'Unit Price', 'Regular Price'],
    },
    {
      key: 'cost',
      label: 'Cost',
      qbpos: ['Average Unit Cost', 'Avg Unit Cost', 'Order Cost', 'Cost'],
      ample: ['Cost'],
      other: ['Cost', 'Unit Cost', 'Average Cost'],
    },
    { key: 'barcode', label: 'Barcode (UPC)', qbpos: ['UPC', 'Barcode'], ample: ['Barcodes'], other: ['Barcode', 'Barcodes', 'UPC', 'EAN', 'GTIN'] },
    {
      key: 'altBarcode',
      label: 'Second barcode (alternate lookup)',
      qbpos: ['Alternate Lookup', 'ALU', 'Alt Lookup'],
      ample: [],
      other: ['Alternate Lookup', 'ALU'],
    },
    {
      key: 'onHand',
      label: 'Quantity on hand',
      qbpos: ['Qty 1', 'On Hand Qty', 'Qty On Hand', 'Quantity On Hand', 'Store Qty 1', 'Qty', 'On Hand'],
      ample: ['On hand'],
      other: ['On Hand', 'Quantity', 'Qty', 'Stock', 'Inventory', 'Quantity On Hand'],
    },
  ],
  customers: [
    { key: 'name', label: 'Full name', qbpos: ['Customer Name', 'Full Name'], ample: ['Name'], other: ['Name', 'Full Name', 'Customer Name', 'Customer'] },
    { key: 'firstName', label: 'First name', qbpos: ['First Name'], ample: [], other: ['First Name', 'Firstname', 'Given Name'] },
    { key: 'lastName', label: 'Last name', qbpos: ['Last Name'], ample: [], other: ['Last Name', 'Lastname', 'Surname', 'Family Name'] },
    { key: 'company', label: 'Company', qbpos: ['Company', 'Company Name'], ample: [], other: ['Company', 'Company Name', 'Business'] },
    { key: 'email', label: 'Email', qbpos: ['EMail', 'Email', 'E-mail', 'Email Address'], ample: ['Email'], other: ['Email', 'E-mail', 'Email Address'] },
    {
      key: 'phone',
      label: 'Phone',
      qbpos: ['Phone 1', 'Phone', 'Phone Number'],
      ample: ['Phone'],
      other: ['Phone', 'Phone Number', 'Mobile', 'Cell', 'Telephone'],
    },
    { key: 'note', label: 'Notes', qbpos: ['Notes', 'Note', 'Comments'], ample: ['Note'], other: ['Notes', 'Note', 'Comments'] },
  ],
  suppliers: [
    {
      key: 'name',
      label: 'Supplier name',
      qbpos: ['Company', 'Vendor Name', 'Company Name', 'Vendor'],
      ample: ['Name'],
      other: ['Name', 'Supplier', 'Supplier Name', 'Vendor', 'Vendor Name', 'Company'],
    },
    { key: 'contactName', label: 'Contact', qbpos: ['Contact', 'Contact Name'], ample: ['Contact'], other: ['Contact', 'Contact Name'] },
    { key: 'firstName', label: 'Contact first name', qbpos: ['First Name'], ample: [], other: ['First Name'] },
    { key: 'lastName', label: 'Contact last name', qbpos: ['Last Name'], ample: [], other: ['Last Name'] },
    { key: 'email', label: 'Email', qbpos: ['EMail', 'Email', 'E-mail'], ample: ['Email'], other: ['Email', 'E-mail'] },
    { key: 'phone', label: 'Phone', qbpos: ['Phone 1', 'Phone', 'Phone Number'], ample: ['Phone'], other: ['Phone', 'Phone Number'] },
    { key: 'notes', label: 'Notes', qbpos: ['Notes', 'Note', 'Comments'], ample: ['Notes'], other: ['Notes', 'Note', 'Comments'] },
  ],
  gift_cards: [
    {
      key: 'code',
      label: 'Card number',
      qbpos: ['Gift Card #', 'Gift Card Number', 'Card Number', 'Gift Certificate #', 'Certificate Number', 'Card #'],
      ample: ['Code'],
      other: ['Code', 'Card Number', 'Gift Card', 'Gift Card Code', 'Card #', 'Number'],
    },
    {
      key: 'balance',
      label: 'Balance',
      qbpos: ['Balance', 'Remaining Balance', 'Current Balance', 'Amount'],
      ample: ['Balance'],
      other: ['Balance', 'Remaining Balance', 'Current Balance', 'Amount', 'Value'],
    },
  ],
  loyalty: [
    { key: 'email', label: 'Customer email', qbpos: ['EMail', 'Email', 'E-mail'], ample: ['Email'], other: ['Email', 'E-mail', 'Customer Email'] },
    { key: 'phone', label: 'Customer phone', qbpos: ['Phone 1', 'Phone', 'Phone Number'], ample: ['Phone'], other: ['Phone', 'Phone Number', 'Mobile'] },
    {
      key: 'name',
      label: 'Customer name (used when there’s no email or phone)',
      qbpos: ['Customer Name', 'Full Name'],
      ample: ['Name'],
      other: ['Name', 'Customer', 'Customer Name', 'Full Name'],
    },
    { key: 'firstName', label: 'First name', qbpos: ['First Name'], ample: [], other: ['First Name'] },
    { key: 'lastName', label: 'Last name', qbpos: ['Last Name'], ample: [], other: ['Last Name'] },
    {
      key: 'points',
      label: 'Points balance',
      qbpos: ['Points', 'Loyalty Points', 'Reward Points', 'Points Balance', 'Rewards Balance'],
      ample: ['Points'],
      other: ['Points', 'Loyalty Points', 'Reward Points', 'Points Balance', 'Balance'],
    },
  ],
  sales: [
    {
      key: 'receipt',
      label: 'Receipt number',
      qbpos: ['Receipt #', 'Receipt Number', 'Receipt', 'Rcpt #'],
      ample: ['Receipt'],
      other: ['Receipt', 'Receipt #', 'Receipt Number', 'Order', 'Order #', 'Order Number', 'Transaction', 'Invoice'],
    },
    {
      key: 'date',
      label: 'Date',
      qbpos: ['Date', 'Receipt Date', 'Sale Date'],
      ample: ['Date'],
      other: ['Date', 'Sale Date', 'Order Date', 'Created At', 'Transaction Date'],
    },
    {
      key: 'sku',
      label: 'SKU / item number',
      qbpos: ['Item Number', 'Item #', 'Item No'],
      ample: ['SKU'],
      other: ['SKU', 'Item Code', 'Product Code', 'Item Number'],
    },
    {
      key: 'description',
      label: 'Item',
      qbpos: ['Item Description', 'Item Name', 'Description'],
      ample: ['Item'],
      other: ['Item', 'Product', 'Product Name', 'Description', 'Item Name', 'Name'],
    },
    { key: 'quantity', label: 'Quantity', qbpos: ['Qty', 'Quantity', 'Qty Sold'], ample: ['Quantity'], other: ['Quantity', 'Qty', 'Units'] },
    {
      key: 'total',
      label: 'Line total',
      qbpos: ['Ext Price', 'Extended Price', 'Ext. Price', 'Ext Amount', 'Amount'],
      ample: ['Total'],
      other: ['Total', 'Line Total', 'Amount', 'Net Sales', 'Ext Price', 'Extended Price', 'Sales'],
    },
    { key: 'price', label: 'Unit price (used when there’s no line total)', qbpos: ['Price', 'Unit Price'], ample: ['Price'], other: ['Price', 'Unit Price'] },
    { key: 'tax', label: 'Tax', qbpos: ['Tax', 'Tax Amount', 'Sales Tax'], ample: ['Tax'], other: ['Tax', 'Tax Amount', 'Sales Tax'] },
    { key: 'customer', label: 'Customer name', qbpos: ['Customer', 'Customer Name', 'Bill To'], ample: ['Customer'], other: ['Customer', 'Customer Name'] },
    { key: 'email', label: 'Customer email', qbpos: ['EMail', 'Email', 'Customer Email'], ample: ['Email'], other: ['Email', 'Customer Email'] },
  ],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]/g, '');

/** Matches the file's columns to our fields by name: the source's own names first, then any we know. */
export function autoMap(kind: ImportKind, source: ImportSource, headers: string[]): Record<string, string | null> {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const taken = new Set<string>();
  const mapping: Record<string, string | null> = {};
  for (const field of FIELDS[kind]) {
    const candidates = source === 'other' ? [...field.other, ...field.qbpos, ...field.ample] : [...field[source], ...field.other];
    const hit = candidates.map((c) => byNorm.get(norm(c))).find((h) => h !== undefined && !taken.has(h));
    mapping[field.key] = hit ?? null;
    if (hit) taken.add(hit);
  }
  return mapping;
}

/** "$1,234.50" → 123450; blank → null; anything else unreadable → NaN. */
export function parseMoney(value: string): number | null {
  const v = value.trim().replace(/[$£€\s,]/g, '');
  if (!v) return null;
  if (!/^\d+(\.\d+)?$/.test(v)) return Number.NaN;
  return Math.round(Number(v) * 100);
}

function parseQuantity(value: string): number | null {
  const v = value.trim().replace(/,/g, '');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : Number.NaN;
}

export interface ProductRow {
  sku: string | null;
  name: string;
  variant: string;
  category: string | null;
  priceMinor: number;
  costMinor: number | null;
  barcodes: string[];
  onHand: number | null;
}
export interface CustomerRow {
  name: string;
  email: string | null;
  phone: string | null;
  note: string | null;
}
export interface SupplierRow {
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
}
export interface GiftCardRow {
  code: string;
  balanceMinor: number;
}
export interface LoyaltyRow {
  email: string | null;
  phone: string | null;
  name: string | null;
  points: number;
}
export interface SaleHistoryRow {
  receipt: string | null;
  soldOn: string;
  sku: string | null;
  description: string;
  quantity: number;
  totalMinor: number;
  taxMinor: number;
  customerName: string | null;
  customerEmail: string | null;
}
export type NormalizedRow<T> = { line: number; data: T | null; errors: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailOf(value: string, errors: string[]): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (!EMAIL.test(v) || v.length > 254) {
    errors.push(`Email “${value.trim()}” doesn’t look right; it was left out`);
    return null;
  }
  return v;
}

function phoneOf(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const digits = `${v.startsWith('+') ? '+' : ''}${v.replace(/\D/g, '')}`;
  return digits.replace('+', '').length >= 7 ? digits.slice(0, 40) : null;
}

/** A date as YYYY-MM-DD: from 2024-03-07, 3/7/2024 or 3/7/24 (US month first), ignoring any time. */
export function parseDate(value: string): string | null {
  const v = value.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s|$|T)/.exec(v))) {
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += y < 70 ? 2000 : 1900;
  } else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export type AnyRow = ProductRow | CustomerRow | SupplierRow | GiftCardRow | LoyaltyRow | SaleHistoryRow;

/** Reads each row into what we store, with any problems. Line numbers count the header as line 1. */
export function normalize(kind: ImportKind, headers: string[], rows: string[][], mapping: Record<string, string | null>): NormalizedRow<AnyRow>[] {
  const index = new Map(headers.map((h, i) => [h, i]));
  return rows.map((cells, i) => {
    const get = (key: string) => {
      const col = mapping[key];
      const at = col == null ? undefined : index.get(col);
      return at === undefined ? '' : unguard((cells[at] ?? '').trim());
    };
    const errors: string[] = [];
    const line = i + 2;
    if (kind === 'products') {
      const name = (get('name') || get('description')).slice(0, 200);
      const variant = (get('variant') || [get('attribute'), get('size')].filter(Boolean).join(' / ') || 'Default').slice(0, 100);
      const price = parseMoney(get('price'));
      const cost = parseMoney(get('cost'));
      const onHand = parseQuantity(get('onHand'));
      const sku = get('sku').slice(0, 64) || null;
      if (!name) errors.push('No product name');
      if (price === null) errors.push('No price');
      else if (Number.isNaN(price)) errors.push(`Price “${get('price')}” isn’t a number`);
      if (cost !== null && Number.isNaN(cost)) errors.push(`Cost “${get('cost')}” isn’t a number`);
      if (onHand !== null && Number.isNaN(onHand)) errors.push(`Quantity “${get('onHand')}” isn’t a number`);
      const barcodes = [...new Set([get('barcode'), get('altBarcode')].flatMap((b) => b.split(/[;|,\s]+/)).filter((b) => /^[!-~]{1,64}$/.test(b)))];
      if (errors.length) return { line, data: null, errors };
      return {
        line,
        errors,
        data: {
          sku,
          name,
          variant,
          category: get('category').slice(0, 100) || null,
          priceMinor: price!,
          costMinor: cost,
          barcodes,
          onHand,
        } satisfies ProductRow,
      };
    }
    if (kind === 'gift_cards') {
      const code = get('code')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      const balance = parseMoney(get('balance'));
      if (!code) errors.push('No card number');
      else if (code.length < 8 || code.length > 32) errors.push(`Card number “${get('code')}” needs 8 to 32 letters and digits`);
      if (balance === null) errors.push('No balance');
      else if (Number.isNaN(balance)) errors.push(`Balance “${get('balance')}” isn’t a number`);
      else if (balance > 1_000_000) errors.push('A gift card can hold at most $10,000');
      return errors.length ? { line, data: null, errors } : { line, errors, data: { code, balanceMinor: balance! } satisfies GiftCardRow };
    }
    if (kind === 'loyalty') {
      const email = emailOf(get('email'), errors);
      const phone = phoneOf(get('phone'));
      const name = (get('name') || [get('firstName'), get('lastName')].filter(Boolean).join(' ')).trim() || null;
      const points = parseQuantity(get('points'));
      if (!email && !phone && !name) return { line, data: null, errors: ['No email, phone or name to find the customer by'] };
      if (points === null) return { line, data: null, errors: ['No points'] };
      if (Number.isNaN(points) || points < 0) return { line, data: null, errors: [`Points “${get('points')}” isn’t a whole number`] };
      return { line, errors, data: { email, phone, name, points } satisfies LoyaltyRow };
    }
    if (kind === 'sales') {
      const soldOn = parseDate(get('date'));
      const description = (get('description') || get('sku')).slice(0, 200);
      const quantity = parseQuantity(get('quantity')) ?? 1;
      const total = parseMoney(get('total').replace(/^\s*-|[()]/g, ''));
      const price = parseMoney(get('price'));
      // Returns carry negative tax: "-0.96" or "(0.96)".
      const taxText = get('tax');
      const taxAbs = parseMoney(taxText.replace(/^\s*-|[()]/g, '')) ?? 0;
      const tax = /^\s*-|\(/.test(taxText) ? -taxAbs : taxAbs;
      const negative = /^\s*-|\(/.test(get('total'));
      if (!soldOn) errors.push(get('date') ? `Date “${get('date')}” isn’t a date` : 'No date');
      if (!description) errors.push('No item');
      if (Number.isNaN(quantity)) errors.push(`Quantity “${get('quantity')}” isn’t a number`);
      if (total !== null && Number.isNaN(total)) errors.push(`Total “${get('total')}” isn’t a number`);
      if (total === null && (price === null || Number.isNaN(price))) errors.push('No line total or price');
      if (Number.isNaN(tax)) errors.push(`Tax “${get('tax')}” isn’t a number`);
      if (errors.length) return { line, data: null, errors };
      const totalMinor = total !== null ? (negative ? -total : total) : price! * quantity;
      return {
        line,
        errors,
        data: {
          receipt: get('receipt').slice(0, 60) || null,
          soldOn: soldOn!,
          sku: get('sku').slice(0, 64) || null,
          description,
          quantity,
          totalMinor,
          taxMinor: tax,
          customerName: get('customer').slice(0, 120) || null,
          customerEmail: emailOf(get('email'), []),
        } satisfies SaleHistoryRow,
      };
    }
    if (kind === 'customers') {
      const person = [get('firstName'), get('lastName')].filter(Boolean).join(' ');
      const name = (get('name') || person || get('company')).slice(0, 120);
      if (!name) return { line, data: null, errors: ['No name'] };
      return {
        line,
        errors,
        data: { name, email: emailOf(get('email'), errors), phone: phoneOf(get('phone')), note: get('note').slice(0, 1000) || null } satisfies CustomerRow,
      };
    }
    const name = get('name').slice(0, 200);
    if (!name) return { line, data: null, errors: ['No supplier name'] };
    const contact = (get('contactName') || [get('firstName'), get('lastName')].filter(Boolean).join(' ')).slice(0, 120) || null;
    return {
      line,
      errors,
      data: {
        name,
        contactName: contact,
        email: emailOf(get('email'), errors),
        phone: phoneOf(get('phone')),
        notes: get('notes').slice(0, 2000) || null,
      } satisfies SupplierRow,
    };
  });
}
