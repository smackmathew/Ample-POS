import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxWorker } from '../src/worker/outbox.worker';
import { Client, createTestApp, unique } from './helpers';

let app: INestApplication;
let passwords: INestApplication;
const adminEmail = `${unique('staff')}@ample.example`;

beforeAll(async () => {
  app = await createTestApp({ env: { PLATFORM_ADMIN_EMAILS: `someone@else.example, ${adminEmail.toUpperCase()}` } });
  passwords = await createTestApp({ env: { AUTH_MODE: 'password', PLATFORM_ADMIN_EMAILS: adminEmail } });
});

afterAll(async () => {
  await app.close();
  await passwords.close();
});

/** A business with Point of sale, a $5 latte and an open register; `sell` rings up a paid cash sale. */
async function business(name = 'Corner Cafe') {
  const owner = await Client.signIn(app);
  await owner.createBusiness(name);
  for (const m of ['catalog', 'pos']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const location = (await owner.post('/locations', { name: 'Main St', timezone: 'America/Chicago' }).expect(201)).body;
  const latte = (await owner.post('/catalog/products', { name: 'Latte', variants: [{ priceMinor: 500, sku: unique('L'), trackInventory: false }] }).expect(201)).body.variants[0];
  const register = (await owner.post('/registers/sessions', { locationId: location.id, openingFloatMinor: 0 }).expect(201)).body;
  const sell = async () => {
    const sale = (await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines: [{ variantId: latte.id, quantity: 2 }] }).expect(201)).body;
    await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'cash', tenderedMinor: sale.totalMinor }).expect(201);
    return sale;
  };
  return { owner, sell, location };
}

describe('super admin dashboard', () => {
  it('is only for platform admins', async () => {
    const admin = await Client.signIn(app, adminEmail);
    expect((await admin.get('/platform/access').expect(200)).body).toEqual({ admin: true, email: adminEmail });
    const owner = (await business()).owner;
    expect((await owner.get('/platform/access').expect(200)).body).toMatchObject({ admin: false, code: 'not_platform_admin' });
    for (const path of ['/platform/overview', '/platform/companies', '/platform/issues', '/platform/tools', '/platform/activity']) {
      await owner.get(path).expect(403);
    }
    await owner.put('/platform/tools/loyalty', { available: false }).expect(403);
  });

  it('wants a confirmed email and two-step sign-in with built-in accounts', async () => {
    const signup = await request(passwords.getHttpServer()).post('/auth/signup').send({ email: adminEmail, password: 'correct horse battery staple 9', name: 'Staff' }).expect(201);
    const res = await request(passwords.getHttpServer()).get('/platform/access').set('Authorization', `Bearer ${signup.body.token}`).expect(200);
    expect(res.body).toMatchObject({ admin: false });
    expect(['email_unverified', 'two_step_required']).toContain(res.body.code);
    await request(passwords.getHttpServer()).get('/platform/companies').set('Authorization', `Bearer ${signup.body.token}`).expect(403);
  });

  it('lists companies with their standing, sales and owner, and shows one in detail', async () => {
    const admin = await Client.signIn(app, adminEmail);
    const name = unique('Bakery');
    const { owner, sell } = await business(name);
    await sell();
    await sell();
    const list = (await admin.get(`/platform/companies?search=${encodeURIComponent(name.toLowerCase())}`).expect(200)).body;
    expect(list).toEqual([
      expect.objectContaining({ id: owner.tenantId, name, ownerEmail: owner.email, standing: 'trial', sales30: 2, gross30Minor: 2000, toolsOn: 2, locations: 1, members: 1 }),
    ]);
    expect((await admin.get(`/platform/companies?search=${encodeURIComponent(owner.email)}`).expect(200)).body).toHaveLength(1);

    const detail = (await admin.get(`/platform/companies/${owner.tenantId}`).expect(200)).body;
    expect(detail).toMatchObject({
      name,
      billing: { standing: 'trial' },
      stats: { sales30: 2, gross30Minor: 2000, tenders30: { cash: 2000 } },
      members: [{ email: owner.email, role: 'Owner' }],
    });
    expect(detail.tools.find((t: { id: string }) => t.id === 'pos')).toMatchObject({ enabled: true, comped: false, available: true, monthlyPriceMinor: 0 });

    const tx = (await admin.get(`/platform/companies/${owner.tenantId}/transactions`).expect(200)).body.transactions;
    expect(tx).toHaveLength(2);
    expect(tx[0]).toMatchObject({ status: 'completed', totalMinor: 1000, location: 'Main St', payments: [{ method: 'cash', status: 'succeeded', amountMinor: 1000 }] });
    await admin.get(`/platform/companies/${randomUUID()}`).expect(404);

    const overview = (await admin.get('/platform/overview?days=7').expect(200)).body;
    expect(overview.companies.total).toBeGreaterThanOrEqual(1);
    expect(overview.sales.grossMinor).toBeGreaterThanOrEqual(2000);
    expect(overview.daily).toHaveLength(7);
    expect(overview.daily.at(-1).grossMinor).toBeGreaterThanOrEqual(2000);
  });

  it('turns tools on and off for a company, makes them free, and blocks them', async () => {
    const admin = await Client.signIn(app, adminEmail);
    const { owner } = await business();
    const tool = (body: object, moduleId = 'customers') => admin.put(`/platform/companies/${owner.tenantId}/tools/${moduleId}`, body);
    await tool({ enabled: true }, 'loyalty').expect(409); // needs Customers first
    let detail = (await tool({ enabled: true, comped: true }).expect(200)).body;
    expect(detail.tools.find((t: { id: string }) => t.id === 'customers')).toMatchObject({ enabled: true, comped: true });
    await owner.get('/customers').expect(200);

    // Comped paid tools aren't billed; the business sees them as included.
    await tool({ enabled: true, comped: true }, 'loyalty').expect(200);
    const billing = (await owner.get('/billing').expect(200)).body;
    expect(billing.lines.map((l: { moduleId: string }) => l.moduleId)).toEqual(['plan:starter']);
    expect(billing.included).toEqual(expect.arrayContaining(['Customers', 'Loyalty rewards']));
    // A comped paid tool (Gift cards) isn't billed either.
    await tool({ enabled: true, comped: true }, 'gift-cards').expect(200);
    expect((await owner.get('/billing').expect(200)).body.lines.map((l: { moduleId: string }) => l.moduleId)).toEqual(['plan:starter']);

    // Blocked: switched off, and the business can't turn it back on.
    detail = (await tool({ blocked: true }, 'loyalty').expect(200)).body;
    expect(detail.tools.find((t: { id: string }) => t.id === 'loyalty')).toMatchObject({ enabled: false, blocked: true });
    const refused = await owner.put('/modules/loyalty', { enabled: true }).expect(409);
    expect(refused.body.code).toBe('blocked');
    expect((await owner.get('/modules').expect(200)).body.find((m: { id: string }) => m.id === 'loyalty')).toMatchObject({ enabled: false, blocked: true });
    await tool({ blocked: false }, 'loyalty').expect(200);
    await owner.put('/modules/loyalty', { enabled: true }).expect(200);

    // The business's own audit log says support made the change.
    const audit = (await owner.get('/audit').expect(200)).body.entries;
    expect(audit.find((e: { action: string; targetId: string }) => e.action === 'module.enabled' && e.targetId === 'customers').data.by).toBe('Ample POS support');
    const platformAudit = (await admin.get(`/platform/audit?tenantId=${owner.tenantId}`).expect(200)).body;
    expect(platformAudit[0]).toMatchObject({ action: 'tool.changed', actorEmail: adminEmail });
  });

  it('suspends and restores a company', async () => {
    const admin = await Client.signIn(app, adminEmail);
    const { owner } = await business();
    await admin.post(`/platform/companies/${owner.tenantId}/suspend`, { reason: '' }).expect(400);
    const suspended = (await admin.post(`/platform/companies/${owner.tenantId}/suspend`, { reason: 'Chargeback review' }).expect(200)).body;
    expect(suspended).toMatchObject({ suspendedReason: 'Chargeback review' });
    expect(suspended.suspendedAt).toBeTruthy();
    const blocked = await owner.get('/tenant').expect(403);
    expect(blocked.body).toMatchObject({ code: 'business_suspended', message: 'This business is suspended: Chargeback review. Contact Ample POS support.' });
    await owner.get('/catalog/products').expect(403);
    expect((await admin.get('/platform/companies?status=suspended').expect(200)).body.map((c: { id: string }) => c.id)).toContain(owner.tenantId);

    await admin.post(`/platform/companies/${owner.tenantId}/restore`).expect(200);
    await owner.get('/tenant').expect(200);
    const actions = (await admin.get(`/platform/activity?tenantId=${owner.tenantId}`).expect(200)).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['business.suspended', 'business.restored']));
  });

  it('switches a tool off for everyone and changes its price', async () => {
    const admin = await Client.signIn(app, adminEmail);
    const { owner } = await business();
    await owner.put('/modules/tasks', { enabled: true }).expect(200);
    try {
      let tools = (await admin.put('/platform/tools/tasks', { available: false }).expect(200)).body;
      expect(tools.find((t: { id: string }) => t.id === 'tasks')).toMatchObject({ available: false });
      const mine = (await owner.get('/modules').expect(200)).body.find((m: { id: string }) => m.id === 'tasks');
      expect(mine).toMatchObject({ available: false, enabled: false });
      await owner.get('/tasks/checklists').expect(403);
      expect((await owner.put('/modules/tasks', { enabled: true }).expect(409)).body.code).toBe('unavailable');
      expect((await owner.get('/tenant').expect(200)).body.enabledModules).not.toContain('tasks');

      await admin.put('/platform/tools/tasks', { available: true, monthlyPriceMinor: 1500 }).expect(200);
      expect((await owner.get('/modules').expect(200)).body.find((m: { id: string }) => m.id === 'tasks')).toMatchObject({ available: true, enabled: true, monthlyPriceMinor: 1500 });
      expect((await owner.get('/billing').expect(200)).body.lines).toEqual(expect.arrayContaining([expect.objectContaining({ moduleId: 'tasks', unitMinor: 1500, totalMinor: 1500 })]));
      tools = (await admin.put('/platform/tools/tasks', { monthlyPriceMinor: null }).expect(200)).body;
      expect(tools.find((t: { id: string }) => t.id === 'tasks')).toMatchObject({ monthlyPriceMinor: 499, priceOverridden: false });
      await app.get(OutboxWorker).runOnce();
    } finally {
      await admin.put('/platform/tools/tasks', { available: true, monthlyPriceMinor: null }).expect(200);
    }
  });

  it('flags problems so they can be fixed fast', async () => {
    const admin = await Client.signIn(app, adminEmail);
    const { owner, location } = await business(unique('Stuck'));
    // A card payment that has been waiting for over half an hour.
    const register = (await owner.get('/registers/sessions/current').expect(200)).body.session;
    const latte = (await owner.get('/catalog/products').expect(200)).body.products[0].variants[0];
    const sale = (await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines: [{ variantId: latte.id, quantity: 1 }] }).expect(201)).body;
    const pay = (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method: 'card' }).expect(201)).body;
    const { adminSql } = await import('./helpers');
    const sql = adminSql();
    await sql`update payments set created_at = now() - interval '2 hours' where id = ${pay.payment.id}`;
    await sql`update register_sessions set opened_at = now() - interval '2 days' where location_id = ${location.id}`;
    await sql.end();

    const issues = (await admin.get('/platform/issues').expect(200)).body.filter((i: { tenantId: string }) => i.tenantId === owner.tenantId);
    expect(issues.map((i: { severity: string; title: string }) => [i.severity, i.title])).toEqual([
      ['high', '1 card payment stuck waiting'],
      ['low', 'Register open for over a day'],
    ]);
    expect((await admin.get(`/platform/companies/${owner.tenantId}`).expect(200)).body.issues).toHaveLength(2);
  });

  it('changes plan prices for everyone, and a company’s plan and online store', async () => {
    const admin = await Client.signIn(app, adminEmail);
    const { owner } = await business();
    try {
      const catalog = (await admin.put('/platform/plans/starter', { baseMinor: 2900 }).expect(200)).body;
      expect(catalog.plans.find((p: { id: string }) => p.id === 'starter')).toMatchObject({ baseMinor: 2900, extraLocationMinor: 1900, registersPerLocation: 1 });
      expect((await owner.get('/billing').expect(200)).body.lines[0]).toMatchObject({ moduleId: 'plan:starter', unitMinor: 2900 });
      await admin.put('/platform/plans/gold', { baseMinor: 1 }).expect(404);
      expect((await admin.put('/platform/website-addons/simple', { setupMinor: 29900 }).expect(200)).body.websiteAddons[1]).toMatchObject({ id: 'simple', setupMinor: 29900 });

      // The public pricing page needs no sign-in and shows the new prices.
      const pricing = (await request(app.getHttpServer()).get('/public/pricing').expect(200)).body;
      expect(pricing.plans.map((p: { id: string; baseMinor: number }) => [p.id, p.baseMinor])).toEqual([['starter', 2900], ['growth', 5900], ['pro', 7900]]);
      expect(pricing.websiteAddons[1]).toMatchObject({ id: 'simple', setupMinor: 29900 });
      expect(pricing.tools.find((t: { id: string }) => t.id === 'loyalty')).toMatchObject({ included: true });
      expect(pricing.tools.find((t: { id: string }) => t.id === 'inventory')).toMatchObject({ included: false, monthlyPriceMinor: 499 });
      expect(pricing.plans[0]).not.toHaveProperty('companies');

      const detail = (await admin.put(`/platform/companies/${owner.tenantId}/plan`, { plan: 'pro', websiteAddon: 'simple' }).expect(200)).body;
      expect(detail.billing).toMatchObject({ plan: 'pro', websiteAddon: 'simple' });
      // An online store given by support carries no setup fee.
      expect((await owner.get('/billing').expect(200)).body).toMatchObject({ plan: { id: 'pro' }, website: { id: 'simple', setupCharged: true } });
      expect((await admin.get('/platform/companies').expect(200)).body.find((c: { id: string }) => c.id === owner.tenantId)).toMatchObject({ plan: 'pro', websiteAddon: 'simple' });
    } finally {
      await admin.put('/platform/plans/starter', { baseMinor: null }).expect(200);
      await admin.put('/platform/website-addons/simple', { setupMinor: null }).expect(200);
    }
  });
});
