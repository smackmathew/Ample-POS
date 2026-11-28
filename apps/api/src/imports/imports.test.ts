import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv, unguard } from './csv';
import { autoMap, normalize, parseDate, parseMoney, type ProductRow, type SaleHistoryRow } from './presets';

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

  it('reads gift cards, loyalty points and sales history', () => {
    const [gh, ...gr] = parseCsv('Gift Card #,Balance\nabcd-1234-efgh,$25.00\nSHORT,5\nABCD12345678,');
    const gifts = normalize('gift_cards', gh!, gr, autoMap('gift_cards', 'qbpos', gh!));
    expect(gifts[0]!.data).toEqual({ code: 'ABCD1234EFGH', balanceMinor: 2500 });
    expect(gifts[1]!.data).toBeNull();
    expect(gifts[2]!.data).toBeNull();

    const [lh, ...lr] = parseCsv('First Name,Last Name,EMail,Phone 1,Points\nAna,Lopez,ANA@example.com,,120\nBen,,,,-4');
    const points = normalize('loyalty', lh!, lr, autoMap('loyalty', 'qbpos', lh!));
    expect(points[0]!.data).toMatchObject({ email: 'ana@example.com', name: 'Ana Lopez', points: 120 });
    expect(points[1]!.data).toBeNull();

    const [sh, ...sr] = parseCsv(
      'Receipt #,Date,Item Number,Item Name,Qty,Ext Price,Tax\n2001,3/14/2024,1001,Rain Jacket,2,258.00,20.64\n2002,2024-03-15,,Mug,1,(4.00),\n2003,,,Mug,1,4.00,',
    );
    const sales = normalize('sales', sh!, sr, autoMap('sales', 'qbpos', sh!));
    expect(sales[0]!.data).toMatchObject({ receipt: '2001', soldOn: '2024-03-14', sku: '1001', quantity: 2, totalMinor: 25800, taxMinor: 2064 });
    expect(sales[1]!.data).toMatchObject({ soldOn: '2024-03-15', totalMinor: -400, taxMinor: 0 });
    const [rh, ...rr] = parseCsv('Receipt #,Date,Item Name,Qty,Ext Price,Tax\n9,2024-03-16,Mug,-1,-12.00,-0.96\n10,2024-03-16,Mug,-1,(12.00),(0.96)');
    const returns = normalize('sales', rh!, rr, autoMap('sales', 'qbpos', rh!));
    expect(
      returns.map((r) => {
        const d = r.data as SaleHistoryRow;
        return [d.quantity, d.totalMinor, d.taxMinor];
      }),
    ).toEqual([
      [-1, -1200, -96],
      [-1, -1200, -96],
    ]);
    expect(sales[2]!.data).toBeNull();
  });

  it('reads dates', () => {
    expect(parseDate('2024-03-05')).toBe('2024-03-05');
    expect(parseDate('3/5/24')).toBe('2024-03-05');
    expect(parseDate('12/31/2023 4:15 PM')).toBe('2023-12-31');
    expect(parseDate('2/30/2024')).toBeNull();
    expect(parseDate('soon')).toBeNull();
  });
});
