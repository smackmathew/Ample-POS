import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIL_FETCH } from '../src/core/mailer';
import { base32Decode, currentStep, hotp } from '../src/core/totp';
import { adminSql, Client, createTestApp, unique } from './helpers';

const PASSWORD = 'correct horse battery staple 9';
const outbox: { to: string[]; subject: string; text: string }[] = [];
const fakeResend = (async (_url: string, init: RequestInit) => {
  outbox.push(JSON.parse(String(init.body)));
  return new Response('{"id":"email_1"}', { status: 200 });
}) as unknown as typeof fetch;

let app: INestApplication;
let passwords: INestApplication;
const adminEmail = `${unique('staff')}@ample.example`;
const pwAdminEmail = `${unique('pwstaff')}@ample.example`;

beforeAll(async () => {
  app = await createTestApp({ env: { PLATFORM_ADMIN_EMAILS: adminEmail } });
  passwords = await createTestApp({
    env: { AUTH_MODE: 'password', PLATFORM_ADMIN_EMAILS: pwAdminEmail, RESEND_API_KEY: 're_test', WEB_URL: 'https://hub.example' },
    providers: [[MAIL_FETCH, fakeResend]],
  });
});

afterAll(async () => {
  await app.close();
  await passwords.close();
});

async function shop(name = 'Corner Cafe') {
  const owner = await Client.signIn(app);
  const tenantId = await owner.createBusiness(name);
  await owner.put('/modules/catalog', { enabled: true }).expect(200);
  await owner.post('/catalog/products', { name: 'Latte', variants: [{ priceMinor: 500, sku: unique('L'), trackInventory: false }] }).expect(201);
  return { owner, tenantId };
}

describe('support view', () => {
  it('opens a business read-only as its owner, for platform admins only, and the business sees it', async () => {
    const { owner, tenantId } = await shop();
    const admin = await Client.signIn(app, adminEmail);
    admin.tenantId = tenantId;
    // Not a member, so no access until a support view is opened.
    await admin.get('/catalog/products').expect(403);
    await admin.post(`/platform/companies/${tenantId}/support`, { reason: '' }).expect(400);
    const started = (await admin.post(`/platform/companies/${tenantId}/support`, { reason: 'Owner asked why a latte is missing' }).expect(200)).body;
    expect(new Date(started.expiresAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    const products = (await admin.get('/catalog/products').expect(200)).body;
    expect(JSON.stringify(products)).toContain('Latte');
    const tenant = (await admin.get('/tenant').expect(200)).body;
    expect(tenant.membership).toMatchObject({ role: { key: 'support' }, permissions: ['*'] });
    expect(tenant.support).toMatchObject({ reason: 'Owner asked why a latte is missing' });

    // Read-only: nothing can be changed.
    const blocked = await admin.post('/catalog/products', { name: 'Mocha', variants: [{ priceMinor: 600, sku: unique('M') }] }).expect(403);
    expect(blocked.body.code).toBe('support_read_only');
    await admin.patch('/tenant', { name: 'Hacked' }).expect(403);

    // Someone who isn't a platform admin can't open one.
    const stranger = await Client.signIn(app);
    await stranger.post(`/platform/companies/${tenantId}/support`, { reason: 'Just looking' }).expect(403);

    // The owner sees the visit in their audit log.
    const audit = (await owner.get('/audit').expect(200)).body;
    const entries = (audit.entries ?? audit) as { action: string; data: { reason?: string } }[];
    expect(entries.find((e) => e.action === 'support.view_started')?.data.reason).toBe('Owner asked why a latte is missing');

    // Ending it closes access again.
    admin.tenantId = undefined;
    expect((await admin.post(`/platform/companies/${tenantId}/support/end`).expect(200)).body).toEqual({ ended: true });
    admin.tenantId = tenantId;
    await admin.get('/catalog/products').expect(403);
    admin.tenantId = undefined;
    const detail = (await admin.get(`/platform/companies/${tenantId}`).expect(200)).body;
    expect(detail.supportSessions[0]).toMatchObject({ email: adminEmail, live: false });
  });

  it('stops working when the session runs out', async () => {
    const { tenantId } = await shop();
    const admin = await Client.signIn(app, adminEmail);
    await admin.post(`/platform/companies/${tenantId}/support`, { reason: 'Checking stock counts' }).expect(200);
    const sql = adminSql();
    await sql`update platform_support_sessions set expires_at = now() - interval '1 second' where tenant_id = ${tenantId}`;
    await sql.end();
    admin.tenantId = tenantId;
    await admin.get('/catalog/products').expect(403);
  });
});

describe('editing businesses', () => {
  it('renames a business, moves its trial and changes its owner', async () => {
    const { owner, tenantId } = await shop('Old Name');
    const admin = await Client.signIn(app, adminEmail);
    const manager = await owner.invite(await Client.signIn(app), 'manager');

    expect((await admin.put(`/platform/companies/${tenantId}/name`, { name: 'New Name' }).expect(200)).body.name).toBe('New Name');
    expect((await owner.get('/tenant').expect(200)).body.tenant.name).toBe('New Name');

    const trial = (await admin.put(`/platform/companies/${tenantId}/trial`, { trialEndsAt: '2099-01-01' }).expect(400)).body;
    expect(trial.message).toContain('at most a year');
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const moved = (await admin.put(`/platform/companies/${tenantId}/trial`, { trialEndsAt: later }).expect(200)).body;
    expect(moved.billing.trialEndsAt.slice(0, 10)).toBe(later);

    const detail = (await admin.get(`/platform/companies/${tenantId}`).expect(200)).body;
    const managerRow = detail.members.find((m: { email: string }) => m.email === manager.email);
    // Someone outside the business can't be made owner.
    const stranger = await Client.signIn(app);
    await stranger.get('/me').expect(200);
    const sql = adminSql();
    const strangerId = (await sql<{ id: string }[]>`select id from users where email = ${stranger.email}`)[0]!.id;
    await sql.end();
    await admin.post(`/platform/companies/${tenantId}/owner`, { userId: strangerId }).expect(400);
    const changed = (await admin.post(`/platform/companies/${tenantId}/owner`, { userId: managerRow.id, previousOwnersBecome: 'manager' }).expect(200)).body;
    const roles = Object.fromEntries(changed.members.map((m: { email: string; roleKey: string }) => [m.email, m.roleKey]));
    expect(roles).toMatchObject({ [manager.email]: 'owner', [owner.email]: 'manager' });
    // The old owner can no longer do owner things; the new one can.
    await owner.patch('/tenant', { name: 'Mine' }).expect(403);
    await manager.patch('/tenant', { name: 'Mine now' }).expect(200);
  });
});

describe('trials and free accounts', () => {
  it('adds days to a trial, and makes a business free so it never goes read-only or pays', async () => {
    const { owner, tenantId } = await shop('Our Test Shop');
    const admin = await Client.signIn(app, adminEmail);
    for (const m of ['time-clock']) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
    const store = (await owner.post('/locations', { name: 'Main', timezone: 'UTC' }).expect(201)).body;

    // The trial ran out: paid tools are read-only.
    const sql = adminSql();
    await sql`update tenant_billing set trial_ends_at = now() - interval '1 day' where tenant_id = ${tenantId}`;
    await sql.end();
    await owner.post('/timeclock/punches', { id: randomUUID(), kind: 'in', locationId: store.id }).expect(402);

    // Adding 7 days counts from today when the trial already ended.
    await admin.put(`/platform/companies/${tenantId}/trial`, {}).expect(400);
    const extended = (await admin.put(`/platform/companies/${tenantId}/trial`, { addDays: 7 }).expect(200)).body;
    const days = (Date.parse(extended.billing.trialEndsAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(extended.billing.standing).toBe('trial');
    // ...and from the current end when it's still running.
    const more = (await admin.put(`/platform/companies/${tenantId}/trial`, { addDays: 7 }).expect(200)).body;
    expect((Date.parse(more.billing.trialEndsAt) - Date.parse(extended.billing.trialEndsAt)) / 86_400_000).toBeCloseTo(7, 3);

    // Free: needs a reason, never lapses, nothing to pay.
    await admin.put(`/platform/companies/${tenantId}/free`, { free: true }).expect(400);
    const free = (await admin.put(`/platform/companies/${tenantId}/free`, { free: true, reason: 'Our own test business' }).expect(200)).body;
    expect(free.billing).toMatchObject({ standing: 'free', freeReason: 'Our own test business' });
    const sql2 = adminSql();
    await sql2`update tenant_billing set trial_ends_at = now() - interval '30 days' where tenant_id = ${tenantId}`;
    await sql2.end();
    await owner.post('/timeclock/punches', { id: randomUUID(), kind: 'in', locationId: store.id }).expect(201);
    expect((await owner.get('/tenant').expect(200)).body.billing.standing).toBe('free');
    expect((await owner.get('/billing').expect(200)).body).toMatchObject({ standing: 'free', free: { since: expect.any(String) } });
    expect((await owner.post('/billing/checkout').expect(409)).body.code).toBe('free_account');
    expect((await admin.get('/platform/companies?status=free').expect(200)).body.map((c: { id: string }) => c.id)).toContain(tenantId);
    const audit = (await owner.get('/audit').expect(200)).body;
    expect(JSON.stringify(audit)).toContain('billing.made_free');

    // Ending it gives a fresh 14-day trial rather than locking them out at once.
    const ended = (await admin.put(`/platform/companies/${tenantId}/free`, { free: false }).expect(200)).body;
    expect(ended.billing.standing).toBe('trial');
    expect((Date.parse(ended.billing.trialEndsAt) - Date.now()) / 86_400_000).toBeGreaterThan(13.9);
  });
});

describe('managing people', () => {
  const http = () => request(passwords.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
  });

  /** An Ample POS staff account with a confirmed email and two-step sign-in, as the dashboard requires. */
  async function staff() {
    const token = (await http().post('/auth/signup').send({ email: pwAdminEmail, password: PASSWORD, name: 'Staff' }).expect(201)).body.token as string;
    const sql = adminSql();
    await sql`update credentials set email_verified_at = now() where email = ${pwAdminEmail}`;
    await sql.end();
    const setup = (await as(token).post('/auth/2fa/setup', { password: PASSWORD }).expect(200)).body;
    await as(token)
      .post('/auth/2fa/enable', { code: hotp(base32Decode(setup.secret), currentStep()) })
      .expect(200);
    expect((await as(token).get('/platform/access').expect(200)).body.admin).toBe(true);
    return as(token);
  }

  it('finds people, sends reset links, resets two-step sign-in, confirms emails and turns accounts off', async () => {
    const admin = await staff();
    const email = `${unique('pat')}@example.com`;
    const pat = (await http().post('/auth/signup').send({ email, password: PASSWORD, name: 'Pat Smith' }).expect(201)).body.token as string;
    const found = (await admin.get(`/platform/users?search=${encodeURIComponent(email)}`).expect(200)).body;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ email, name: 'Pat Smith', businesses: [], hasPassword: true, emailVerified: false, twoFactor: false });
    const id = found[0].id;
    expect((await admin.get('/platform/users?status=unconfirmed').expect(200)).body.map((u: { id: string }) => u.id)).toContain(id);

    // Confirm the email by hand (e.g. the confirmation email never arrived), so they can create a business.
    await as(pat)
      .post('/tenants', { name: 'Pat’s Plants', slug: unique('pats') })
      .expect(403);
    expect((await admin.post(`/platform/users/${id}/confirm-email`).expect(200)).body.emailVerified).toBe(true);
    await as(pat)
      .post('/tenants', { name: 'Pat’s Plants', slug: unique('pats') })
      .expect(201);
    expect((await admin.get(`/platform/users?search=${encodeURIComponent('Pat’s Plants')}`).expect(200)).body.map((u: { id: string }) => u.id)).toEqual([id]);

    // A reset link: emailed and shown, and it works.
    const reset = (await admin.post(`/platform/users/${id}/password-reset`).expect(200)).body;
    expect(reset).toMatchObject({ emailed: true, expiresInHours: 24 });
    expect(outbox.findLast((m) => m.to[0] === email)?.text).toContain(reset.link);
    const resetToken = new URL(reset.link).searchParams.get('token');
    await http()
      .post('/auth/password/reset')
      .send({ token: resetToken, password: 'a brand new passphrase 7' })
      .expect((r) => {
        if (r.status >= 300) throw new Error(`reset failed ${r.status} ${JSON.stringify(r.body)}`);
      });

    // Turning the account off ends their sessions and stops sign-in.
    const fresh = (await http().post('/auth/login').send({ email, password: 'a brand new passphrase 7' }).expect(200)).body.token as string;
    await as(fresh).get('/me').expect(200);
    await admin.post(`/platform/users/${id}/disable`, { reason: '' }).expect(400);
    const off = (await admin.post(`/platform/users/${id}/disable`, { reason: 'Chargeback fraud' }).expect(200)).body;
    expect(off).toMatchObject({ disabledReason: 'Chargeback fraud', liveSessions: 0 });
    await as(fresh).get('/me').expect(401);
    const refused = await http().post('/auth/login').send({ email, password: 'a brand new passphrase 7' }).expect(403);
    expect(refused.body.code).toBe('account_disabled');
    expect((await admin.get('/platform/users?status=disabled').expect(200)).body.map((u: { id: string }) => u.id)).toContain(id);

    // Back on.
    await admin.post(`/platform/users/${id}/enable`).expect(200);
    await http().post('/auth/login').send({ email, password: 'a brand new passphrase 7' }).expect(200);

    // Two-step sign-in reset.
    const patToken = (await http().post('/auth/login').send({ email, password: 'a brand new passphrase 7' }).expect(200)).body.token as string;
    const setup = (await as(patToken).post('/auth/2fa/setup', { password: 'a brand new passphrase 7' }).expect(200)).body;
    await as(patToken)
      .post('/auth/2fa/enable', { code: hotp(base32Decode(setup.secret), currentStep()) })
      .expect(200);
    expect((await admin.get(`/platform/users/${id}`).expect(200)).body.twoFactor).toBe(true);
    const cleared = (await admin.post(`/platform/users/${id}/two-factor/reset`).expect(200)).body;
    expect(cleared).toMatchObject({ twoFactor: false, liveSessions: 0 });
    expect((await http().post('/auth/login').send({ email, password: 'a brand new passphrase 7' }).expect(200)).body.token).toBeTruthy();

    // History of what support did.
    const detail = (await admin.get(`/platform/users/${id}`).expect(200)).body;
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual(
      expect.arrayContaining(['user.email_confirmed', 'user.password_reset_link', 'user.disabled', 'user.enabled', 'user.two_factor_reset']),
    );
    expect(detail.memberships[0]).toMatchObject({ name: 'Pat’s Plants', roleKey: 'owner' });
  });

  it('won’t turn off staff accounts, and is only for platform admins', async () => {
    const someone = (
      await http()
        .post('/auth/signup')
        .send({ email: `${unique('x')}@example.com`, password: PASSWORD, name: 'X' })
        .expect(201)
    ).body.token as string;
    await as(someone).get('/platform/users').expect(403);
  });
});
