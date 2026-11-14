import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { schema } from '@pos/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { Events } from '../core/events';
import { currentTenant, currentUserId } from '../core/request-context';
import { ZodPipe } from '../core/zod';

/** Lowercased email, or undefined for blank. */
const email = z
  .string()
  .trim()
  .max(254)
  .transform((v) => v.toLowerCase())
  .pipe(z.union([z.literal(''), z.string().email('Enter a valid email')]))
  .transform((v) => v || null);

/** Digits only, keeping a leading +; blank is no phone. */
const phone = z
  .string()
  .trim()
  .max(40)
  .transform((v) => (v ? `${v.startsWith('+') ? '+' : ''}${v.replace(/\D/g, '')}` : ''))
  .refine((v) => v === '' || v.replace('+', '').length >= 7, 'Enter a phone number with at least 7 digits')
  .transform((v) => v || null);

const customerBody = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(120),
    email: email.optional(),
    phone: phone.optional(),
    note: z.string().trim().max(1000).optional().transform((v) => v || null),
  });
const updateBody = customerBody.partial().refine((b) => Object.keys(b).length > 0, 'Change at least one field');
const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Visits, spending (after refunds) and last visit from completed sales. */
const stats = {
  visits: sql<number>`(select count(*) from sales s where s.customer_id = customers.id and s.status = 'completed')`.mapWith(Number),
  spentMinor: sql<number>`(select coalesce(sum(s.total_minor - (select coalesce(sum(r.amount_minor), 0) from refunds r where r.sale_id = s.id)), 0) from sales s where s.customer_id = customers.id and s.status = 'completed')`.mapWith(Number),
  lastVisitAt: sql<string | null>`(select max(s.completed_at) from sales s where s.customer_id = customers.id and s.status = 'completed')`,
};

/**
 * Customers of the business. Anyone who can sell may look customers up and add
 * them at checkout; editing and deleting is for managers.
 */
@Controller('customers')
@RequireModule('customers')
export class CustomersController {
  constructor(
    private readonly db: Db,
    private readonly events: Events,
  ) {}

  /** Search by name, email or phone (any order of words), most recent customers first. */
  @RequirePermission('customers.use')
  @Get()
  async list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const c = schema.customers;
    const words = (q.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const digits = (q.search ?? '').replace(/\D/g, '');
    const match = words.length
      ? sql.join(
          words.map((w) => {
            const like = `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            return sql`(lower(${c.name}) like ${like} or ${c.email} like ${like})`;
          }),
          sql` and `,
        )
      : undefined;
    const phoneMatch = digits.length >= 3 ? sql`${c.phone} like ${`%${digits}%`}` : undefined;
    const where = match && phoneMatch ? sql`(${match}) or ${phoneMatch}` : (match ?? phoneMatch);
    return this.db.tx
      .select({ id: c.id, name: c.name, email: c.email, phone: c.phone, createdAt: c.createdAt, ...stats })
      .from(c)
      .where(where)
      .orderBy(desc(c.updatedAt))
      .limit(q.limit);
  }

  @RequirePermission('customers.use')
  @Post()
  async create(@Body(new ZodPipe(customerBody)) body: z.infer<typeof customerBody>) {
    const [customer] = await this.db.tx
      .transaction(async (sp) =>
        sp
          .insert(schema.customers)
          .values({ tenantId: currentTenant().tenantId, ...body, createdBy: currentUserId() })
          .returning(),
      )
      .catch(async (err) => {
        throw await this.duplicate(err, body);
      });
    await this.events.audit('customer.created', { type: 'customer', id: customer!.id });
    return customer;
  }

  /** A customer with their recent sales. */
  @RequirePermission('customers.use')
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const c = schema.customers;
    const [customer] = await this.db.tx
      .select({ id: c.id, name: c.name, email: c.email, phone: c.phone, note: c.note, createdAt: c.createdAt, ...stats })
      .from(c)
      .where(eq(c.id, id));
    if (!customer) throw new NotFoundException('Customer not found');
    const s = schema.sales;
    const sales = await this.db.tx
      .select({
        id: s.id,
        status: s.status,
        receiptNumber: s.receiptNumber,
        totalMinor: s.totalMinor,
        currency: s.currency,
        locationId: s.locationId,
        locationName: schema.locations.name,
        createdAt: s.createdAt,
        completedAt: s.completedAt,
        refundedMinor: sql<number>`(select coalesce(sum(amount_minor), 0) from refunds r where r.sale_id = sales.id)`.mapWith(Number),
      })
      .from(s)
      .innerJoin(schema.locations, eq(schema.locations.id, s.locationId))
      .where(and(eq(s.customerId, id), sql`${s.status} <> 'open'`))
      .orderBy(desc(s.createdAt))
      .limit(100);
    return { ...customer, sales };
  }

  @RequirePermission('customers.manage')
  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    const [customer] = await this.db.tx
      .transaction(async (sp) =>
        sp
          .update(schema.customers)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(schema.customers.id, id))
          .returning(),
      )
      .catch(async (err) => {
        throw await this.duplicate(err, body);
      });
    if (!customer) throw new NotFoundException('Customer not found');
    await this.events.audit('customer.updated', { type: 'customer', id }, { fields: Object.keys(body) });
    return customer;
  }

  /** Removes the customer's details for good. Their sales stay, without a customer. */
  @RequirePermission('customers.manage')
  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const [gone] = await this.db.tx.delete(schema.customers).where(eq(schema.customers.id, id)).returning({ id: schema.customers.id });
    if (!gone) throw new NotFoundException('Customer not found');
    await this.events.audit('customer.deleted', { type: 'customer', id });
    return { deleted: true };
  }

  /** A clear 409 naming the existing customer when an email or phone is already used. */
  private async duplicate(err: unknown, body: { email?: string | null; phone?: string | null }): Promise<unknown> {
    type PgError = { code?: string; constraint_name?: string };
    let pg: PgError | undefined;
    for (let e: unknown = err; e && typeof e === 'object' && !pg; e = (e as { cause?: unknown }).cause) {
      if (typeof (e as { code?: unknown }).code === 'string') pg = e as PgError;
    }
    if (pg?.code !== '23505') return err;
    const byPhone = pg.constraint_name === 'customers_phone';
    const value = byPhone ? body.phone : body.email;
    const [existing] = value
      ? await this.db.tx
          .select({ id: schema.customers.id, name: schema.customers.name })
          .from(schema.customers)
          .where(byPhone ? eq(schema.customers.phone, value) : eq(schema.customers.email, value))
      : [];
    return new ConflictException({
      code: 'customer_exists',
      message: `${existing?.name ?? 'Another customer'} already has this ${byPhone ? 'phone number' : 'email'}`,
      customer: existing ?? null,
    });
  }
}
