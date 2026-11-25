import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { IMPORT_KINDS, IMPORT_SOURCES, schema } from '@pos/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequirePermission } from '../core/decorators';
import { ZodPipe } from '../core/zod';
import { toCsv } from './csv';
import { ImportsService } from './imports.service';

const startBody = z.object({
  kind: z.enum(IMPORT_KINDS),
  source: z.enum(IMPORT_SOURCES),
  fileName: z.string().trim().min(1).max(200),
  // About 10 MB of text.
  csv: z.string().min(1).max(10_000_000),
  locationId: z.string().uuid().nullable().optional(),
});
const remapBody = z.object({ mapping: z.record(z.string(), z.string().nullable()), locationId: z.string().uuid().nullable().optional() });
const exportQuery = z.object({ locationId: z.string().uuid().optional() });

/** Bringing data in from another system, and taking it out, for one business. */
@Controller()
@RequirePermission('data.manage')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly db: Db,
  ) {}

  /** Reads the file and shows what importing it would do. Nothing is saved to the catalog yet. */
  @Post('imports')
  start(@Body(new ZodPipe(startBody)) body: z.infer<typeof startBody>) {
    return this.imports.start(body);
  }

  @Get('imports')
  list() {
    return this.imports.list();
  }

  @Get('imports/:id')
  preview(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.preview(id);
  }

  @Put('imports/:id/mapping')
  remap(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(remapBody)) body: z.infer<typeof remapBody>) {
    return this.imports.remap(id, body.mapping, body.locationId);
  }

  @Post('imports/:id/commit')
  @HttpCode(200)
  commit(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.commit(id);
  }

  @Post('imports/:id/undo')
  @HttpCode(200)
  undo(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.undo(id);
  }

  /**
   * Everything in the catalog, with on-hand at a location if given. The same
   * columns the Ample POS import reads, so the file can be edited and imported back.
   */
  @Get('exports/products.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async products(@Query(new ZodPipe(exportQuery)) q: z.infer<typeof exportQuery>, @Res({ passthrough: true }) res: Response) {
    await this.imports.requireTool('catalog');
    const v = schema.productVariants;
    const p = schema.products;
    const rows = await this.db.tx
      .select({
        sku: v.sku,
        product: p.name,
        variant: v.name,
        category: p.category,
        price: v.priceMinor,
        cost: v.costMinor,
        barcodes: sql<string>`coalesce((select string_agg(b.barcode, ' ' order by b.barcode) from variant_barcodes b where b.variant_id = ${v.id}), '')`,
        onHand: q.locationId
          ? sql<number | null>`(select s.on_hand from stock_levels s where s.variant_id = ${v.id} and s.location_id = ${q.locationId})`
          : sql<null>`null`,
      })
      .from(v)
      .innerJoin(p, eq(p.id, v.productId))
      .where(and(eq(v.status, 'active'), eq(p.status, 'active')))
      .orderBy(asc(p.name), asc(v.position));
    const money = (n: number | null) => (n == null ? '' : (n / 100).toFixed(2));
    filename(res, 'products');
    return toCsv([
      ['SKU', 'Product', 'Variant', 'Category', 'Price', 'Cost', 'Barcodes', 'On hand'],
      ...rows.map((r) => [r.sku, r.product, r.variant, r.category, money(r.price), money(r.cost), r.barcodes, q.locationId ? (r.onHand ?? 0) : '']),
    ]);
  }

  @Get('exports/customers.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async customers(@Res({ passthrough: true }) res: Response) {
    await this.imports.requireTool('customers');
    const c = schema.customers;
    const rows = await this.db.tx.select({ name: c.name, email: c.email, phone: c.phone, note: c.note }).from(c).orderBy(asc(c.name));
    filename(res, 'customers');
    return toCsv([['Name', 'Email', 'Phone', 'Note'], ...rows.map((r) => [r.name, r.email, r.phone, r.note])]);
  }

  @Get('exports/suppliers.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async suppliers(@Res({ passthrough: true }) res: Response) {
    await this.imports.requireTool('purchasing');
    const s = schema.suppliers;
    const rows = await this.db.tx
      .select({ name: s.name, contact: s.contactName, email: s.email, phone: s.phone, notes: s.notes })
      .from(s)
      .where(isNull(s.archivedAt))
      .orderBy(asc(s.name));
    filename(res, 'suppliers');
    return toCsv([['Name', 'Contact', 'Email', 'Phone', 'Notes'], ...rows.map((r) => [r.name, r.contact, r.email, r.phone, r.notes])]);
  }
}

function filename(res: Response, what: string) {
  res.setHeader('Content-Disposition', `attachment; filename="ample-pos-${what}-${new Date().toISOString().slice(0, 10)}.csv"`);
}
