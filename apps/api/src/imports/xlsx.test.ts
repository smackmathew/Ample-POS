import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { isXlsx, readXlsx, XlsxError } from './xlsx';

const fixture = (name: string) => readFileSync(join(__dirname, '../../test/fixtures', name));

describe('reading Excel workbooks', () => {
  it('reads the first sheet of a QuickBooks POS item list: text, numbers, rich text, quotes and blank rows', () => {
    const bytes = fixture('qbpos-items.xlsx');
    expect(isXlsx(bytes)).toBe(true);
    const rows = readXlsx(bytes);
    expect(rows[0]).toEqual([
      'Item Number',
      'Item Name',
      'Item Description',
      'Attribute',
      'Size',
      'Department Name',
      'Regular Price',
      'Average Unit Cost',
      'UPC',
      'Alternate Lookup',
      'Qty 1',
    ]);
    // Leading zeros survive in text cells; numbers come through as Excel shows them; the blank row is gone.
    expect(rows[1]).toEqual(['1001', 'Rain Jacket', 'Rain jacket, "waterproof"', 'Navy', 'L', 'Outerwear', '129', '54.25', '012345678905', 'RJ-NAVY-L', '8']);
    expect(rows[2]).toEqual(['1002', 'Rain Jacket', 'Rain jacket', 'Navy', 'M', 'Outerwear', '129', '54.25', '012345678912', '', '3']);
    expect(rows[3]).toEqual(['1003', 'Gift wrap', '', '', '', 'Services', '3']);
    expect(rows[4]).toEqual(['1004', 'Mug & Saucer', '', '', '', 'Kitchen', '12.5', '2.1', '', '', '5']);
    expect(rows).toHaveLength(5);
  });

  it('turns date cells into dates, whatever the date format', () => {
    const rows = readXlsx(fixture('qbpos-sales.xlsx'));
    expect(rows[1]!.slice(0, 2)).toEqual(['2001', '2024-03-14']);
    expect(rows[2]!.slice(0, 2)).toEqual(['2002', '2024-03-15']);
    expect(rows[1]![6]).toBe('20.64');
  });

  it('refuses files that aren’t workbooks', () => {
    expect(isXlsx(Buffer.from('Item Number,Item Name\n1,A'))).toBe(false);
    expect(() => readXlsx(Buffer.from('not a zip at all, just some text that is long enough'))).toThrow(XlsxError);
    // A zip without a workbook inside.
    const name = Buffer.from('hello.txt');
    const data = deflateRawSync(Buffer.from('hi'));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(2, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(2, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + data.length, 16);
    const zip = Buffer.concat([local, name, data, central, name, end]);
    expect(() => readXlsx(zip)).toThrow('This isn’t an Excel workbook (.xlsx)');
  });
});
