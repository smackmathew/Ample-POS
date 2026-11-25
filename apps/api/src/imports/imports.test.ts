import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv, unguard } from './csv';
import { autoMap, normalize, parseMoney, type ProductRow } from './presets';

const QB_ITEMS = [
  'Item Number,Item Name,Item Description,Attribute,Size,Department Name,Regular Price,Average Unit Cost,UPC,Alternate Lookup,Qty 1,Vendor Name',
  '1001,Rain Jacket,"Rain jacket, waterproof",Navy,L,Outerwear,"$1,129.00",54.25,012345678905,RJ-NAVY-L,8,Acme Supply',
  '1002,Rain Jacket,"Rain jacket, waterproof",Navy,M,Outerwear,129.00,54.25,012345678912,,3,Acme Supply',
  '1003,,Gift wrap,,,Services,3.00,,,,,',
  '1004,Mug,,,,Kitchen,,2.10,,,5,',
].join('\r\n');

describe('csv', () => {
  it('reads quotes, commas and line breaks inside quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","line\nbreak"\r\n\r\n"say ""hi""",2\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'line\nbreak'],
      ['say "hi"', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('writes CSV that reads back the same, keeping formulas from running in spreadsheets', () => {
    const rows = [
      ['Name', 'Note'],
      ['A, B', 'He said "hi"'],
      ['=HYPERLINK("x")', '-trouble'],
    ];
    const back = parseCsv(toCsv(rows));
    expect(back[1]).toEqual(['A, B', 'He said "hi"']);
    expect(back[2]!.map(unguard)).toEqual(['=HYPERLINK("x")', '-trouble']);
    expect(toCsv([[-5]])).toContain('-5');
  });
});

describe('QuickBooks POS item export', () => {
  const [headers, ...rows] = parseCsv(QB_ITEMS);

  it('maps the columns by name', () => {
    const m = autoMap('products', 'qbpos', headers!);
    expect(m).toMatchObject({
      sku: 'Item Number',
      name: 'Item Name',
      description: 'Item Description',
      attribute: 'Attribute',
      size: 'Size',
      category: 'Department Name',
      price: 'Regular Price',
      cost: 'Average Unit Cost',
      barcode: 'UPC',
      altBarcode: 'Alternate Lookup',
      onHand: 'Qty 1',
      variant: null,
    });
  });

  it('reads items: matrix items become variants, the description stands in for a missing name, and bad rows say why', () => {
    const out = normalize('products', headers!, rows, autoMap('products', 'qbpos', headers!));
    const [jacketL, jacketM, wrap, mug] = out;
    expect(jacketL!.data).toEqual<ProductRow>({
      sku: '1001',
      name: 'Rain Jacket',
      variant: 'Navy / L',
      category: 'Outerwear',
      priceMinor: 112900,
      costMinor: 5425,
      barcodes: ['012345678905', 'RJ-NAVY-L'],
      onHand: 8,
    });
    expect(jacketM!.data).toMatchObject({ variant: 'Navy / M', barcodes: ['012345678912'], onHand: 3 });
    expect(wrap!.data).toMatchObject({ name: 'Gift wrap', variant: 'Default', costMinor: null, onHand: null });
    expect(mug).toEqual({ line: 5, data: null, errors: ['No price'] });
  });

  it('reads customer and vendor lists', () => {
    const [h, ...r] = parseCsv('First Name,Last Name,Company,EMail,Phone 1,Notes\nAna,Lopez,,ANA@Example.com,(312) 555-0100,VIP\n,,Harbor Cafe,bad-email,,');
    const out = normalize('customers', h!, r, autoMap('customers', 'qbpos', h!));
    expect(out[0]!.data).toEqual({ name: 'Ana Lopez', email: 'ana@example.com', phone: '3125550100', note: 'VIP' });
    expect(out[1]!.data).toMatchObject({ name: 'Harbor Cafe', email: null });
    expect(out[1]!.errors[0]).toMatch(/doesn’t look right/);
    const [vh, ...vr] = parseCsv('Company,First Name,Last Name,EMail,Phone 1\nAcme Supply,Jo,Park,jo@acme.example,555-123-4567');
    expect(normalize('suppliers', vh!, vr, autoMap('suppliers', 'qbpos', vh!))[0]!.data).toEqual({
      name: 'Acme Supply',
      contactName: 'Jo Park',
      email: 'jo@acme.example',
      phone: '5551234567',
      notes: null,
    });
  });

  it('reads money', () => {
    expect(parseMoney('$1,234.5')).toBe(123450);
    expect(parseMoney(' ')).toBeNull();
    expect(parseMoney('abc')).toBeNaN();
  });
});
