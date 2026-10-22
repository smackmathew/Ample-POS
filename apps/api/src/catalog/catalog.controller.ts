import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { schema } from '@pos/db';
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant } from '../core/request-context';
import { ZodPipe } from '../core/zod';

const money = z.number().int().min(0).max(1_000_000_000_00);
const barcode = z.string().trim().regex(/^[!-~]{1,64}$/, 'printable characters only, max 64');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const variantInput = z.object({
  name: z.string().trim().min(1).max(100).default('Default'),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  priceMinor: money,
  costMinor: money.nullable().optional(),
  trackInventory: z.boolean().default(true),
  barcodes: z.array(barcode).max(20).default([]),
});

const createProductBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: optionalText(5000),
  category: optionalText(100),
  variants: z.array(variantInput).min(1).max(100),
});

const updateProductBody = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  description: optionalText(5000),
  category: optionalText(100),
  status: z.enum(['active', 'archived']).optional(),
});

const updateVariantBody = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(100).optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  priceMinor: money.optional(),
  costMinor: money.nullable().optional(),
  trackInventory: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
  /** Replaces the variant's barcodes when present. */
  barcodes: z.array(barcode).max(20).optional(),
});

const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type VariantInput = z.infer<typeof variantInput>;

function assertUniqueBarcodes(variants: { barcodes?: string[] }[]): void {
  const all = variants.flatMap((v) => v.barcodes ?? []);
  const dupes = all.filter((b, i) => all.indexOf(b) !== i);
  if (dupes.length) throw new ConflictException(`Barcode listed more than once: ${[...new Set(dupes)].join(', ')}`);
}

@Controller('catalog')
@RequireModule('catalog')
export class CatalogController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  @RequirePermission('catalog.read')
  @Get('products')
  async list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const p = schema.products;
    const filters: (SQL | undefined)[] = [q.status === 'all' ? undefined : eq(p.status, q.status)];
    if (q.search) {
      const term = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
      // Match product name, category, or any variant's SKU or barcode.
      filters.push(
        or(
          ilike(p.name, term),
          ilike(p.category, term),
          sql`exists (select 1 from product_variants v where v.product_id = ${p.id} and v.sku ilike ${term})`,
          sql`exists (select 1 from product_variants v join variant_barcodes b on b.variant_id = v.id
                      where v.product_id = ${p.id} and b.barcode = ${q.search})`,
        ),
      );
    }
    const rows = await this.db.tx
      .select()
      .from(p)
      .where(and(...filters))
      .orderBy(asc(sql`lower(${p.name})`), asc(p.id))
      .limit(q.limit)
      .offset(q.offset);
    return { products: await this.withVariants(rows), nextOffset: rows.length === q.limit ? q.offset + q.limit : null };
  }

  @RequirePermission('catalog.read')
  @Get('products/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.findProduct(id);
  }

  /** Scanner lookup: exact barcode, or SKU (case-insensitive). Active items only. */
  @RequirePermission('catalog.read')
  @Get('lookup')
  async lookup(@Query('code') rawCode?: string) {
    const code = rawCode?.trim();
    if (!code) throw new NotFoundException('No code given');
    const v = schema.productVariants;
    const [match] = await this.db.tx
      .select({ variantId: v.id })
      .from(v)
      .innerJoin(schema.products, eq(schema.products.id, v.productId))
      .where(
        and(
          eq(v.status, 'active'),
          eq(schema.products.status, 'active'),
          or(
            sql`lower(${v.sku}) = lower(${code})`,
            sql`exists (select 1 from variant_barcodes b where b.variant_id = ${v.id} and b.barcode = ${code})`,
          ),
        ),
      )
      .limit(1);
    if (!match) throw new NotFoundException(`No active product matches "${code}"`);
    return this.findVariant(match.variantId);
  }

  @RequirePermission('catalog.manage')
  @Post('products')
  async create(@Body(new ZodPipe(createProductBody)) body: z.infer<typeof createProductBody>) {
    assertUniqueBarcodes(body.variants);
    const { tenantId } = currentTenant();
    const [product] = await this.db.tx
      .insert(schema.products)
      .values({ tenantId, name: body.name, description: body.description ?? null, category: body.category ?? null })
      .returning();
    for (const [position, variant] of body.variants.entries()) {
      await this.insertVariant(product!.id, variant, position);
    }
    await this.events.record('product.created', { type: 'product', id: product!.id }, { name: body.name });
    return this.findProduct(product!.id);
  }

  @RequirePermission('catalog.manage')
  @Patch('products/:id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateProductBody)) body: z.infer<typeof updateProductBody>) {
    const { version, ...fields } = body;
    const p = schema.products;
    const [updated] = await this.db.tx
      .update(p)
      .set({ ...fields, version: sql`${p.version} + 1`, updatedAt: new Date() })
      .where(and(eq(p.id, id), eq(p.version, version)))
      .returning({ id: p.id });
    if (!updated) await this.versionConflict(() => this.findProduct(id));
    await this.events.record('product.updated', { type: 'product', id }, fields);
    return this.findProduct(id);
  }

  @RequirePermission('catalog.manage')
  @Post('products/:id/variants')
  async addVariant(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(variantInput)) body: VariantInput) {
    assertUniqueBarcodes([body]);
    const product = await this.findProduct(id);
    const variantId = await this.insertVariant(id, body, product.variants.length);
    await this.events.record('variant.created', { type: 'variant', id: variantId }, { productId: id, name: body.name });
    return this.findVariant(variantId);
  }

  @RequirePermission('catalog.manage')
  @Patch('variants/:id')
  async updateVariant(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateVariantBody)) body: z.infer<typeof updateVariantBody>) {
    const { version, barcodes, ...fields } = body;
    const v = schema.productVariants;
    const [updated] = await this.db.tx
      .update(v)
      .set({ ...fields, version: sql`${v.version} + 1`, updatedAt: new Date() })
      .where(and(eq(v.id, id), eq(v.version, version)))
      .returning({ id: v.id });
    if (!updated) await this.versionConflict(() => this.findVariant(id));
    if (barcodes) {
      assertUniqueBarcodes([{ barcodes }]);
      await this.db.tx.delete(schema.variantBarcodes).where(eq(schema.variantBarcodes.variantId, id));
      await this.insertBarcodes(id, barcodes);
    }
    await this.events.record('variant.updated', { type: 'variant', id }, { ...fields, ...(barcodes ? { barcodes } : {}) });
    return this.findVariant(id);
  }

  private async insertVariant(productId: string, input: VariantInput, position: number): Promise<string> {
    const [variant] = await this.db.tx
      .insert(schema.productVariants)
      .values({
        tenantId: currentTenant().tenantId,
        productId,
        name: input.name,
        sku: input.sku ?? null,
        priceMinor: input.priceMinor,
        costMinor: input.costMinor ?? null,
        trackInventory: input.trackInventory,
        position,
      })
      .returning({ id: schema.productVariants.id });
    await this.insertBarcodes(variant!.id, input.barcodes);
    return variant!.id;
  }

  private async insertBarcodes(variantId: string, barcodes: string[]): Promise<void> {
    if (!barcodes.length) return;
    const { tenantId } = currentTenant();
    await this.db.tx.insert(schema.variantBarcodes).values(barcodes.map((barcode) => ({ tenantId, variantId, barcode })));
  }

  /** Throws 404 if the row is gone, otherwise 409 with the current version so the client can merge. */
  private async versionConflict(load: () => Promise<{ version: number }>): Promise<never> {
    const current = await load();
    throw new ConflictException({
      code: 'version_conflict',
      message: 'This item was changed by someone else. Reload and try again.',
      current,
    });
  }

  private async findProduct(id: string) {
    const [product] = await this.db.tx.select().from(schema.products).where(eq(schema.products.id, id));
    if (!product) throw new NotFoundException('Product not found');
    return (await this.withVariants([product]))[0]!;
  }

  private async findVariant(id: string) {
    const [row] = await this.db.tx
      .select({ variant: schema.productVariants, product: schema.products })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.productVariants.id, id));
    if (!row) throw new NotFoundException('Variant not found');
    const barcodes = await this.barcodesFor([id]);
    return {
      ...row.variant,
      barcodes: barcodes.get(id) ?? [],
      product: { id: row.product.id, name: row.product.name, status: row.product.status },
    };
  }

  private async withVariants<P extends { id: string }>(products: P[]) {
    if (!products.length) return [];
    const variants = await this.db.tx
      .select()
      .from(schema.productVariants)
      .where(inArray(schema.productVariants.productId, products.map((p) => p.id)))
      .orderBy(asc(schema.productVariants.position), asc(schema.productVariants.createdAt));
    const barcodes = await this.barcodesFor(variants.map((v) => v.id));
    return products.map((p) => ({
      ...p,
      variants: variants.filter((v) => v.productId === p.id).map((v) => ({ ...v, barcodes: barcodes.get(v.id) ?? [] })),
    }));
  }

  private async barcodesFor(variantIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!variantIds.length) return map;
    const rows = await this.db.tx
      .select()
      .from(schema.variantBarcodes)
      .where(inArray(schema.variantBarcodes.variantId, variantIds))
      .orderBy(asc(schema.variantBarcodes.createdAt), asc(schema.variantBarcodes.barcode));
    for (const r of rows) map.set(r.variantId, [...(map.get(r.variantId) ?? []), r.barcode]);
    return map;
  }
}
