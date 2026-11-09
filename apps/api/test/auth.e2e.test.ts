import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIL_FETCH } from '../src/core/mailer';
import { appDatabaseUrl, Client, createTestApp, unique } from './helpers';

const PASSWORD = 'correct horse battery';

/** Captures what would have been emailed. */
const outbox: { to: string[]; subject: string; text: string }[] = [];
const fakeResend = (async (_url: string, init: RequestInit) => {
  outbox.push(JSON.parse(String(init.body)));
  return new Response('{"id":"email_1"}', { status: 200 });
}) as unknown as typeof fetch;

let app: INestApplication;
let devApp: INestApplication;

beforeAll(async () => {
  app = await createTestApp({
    env: { AUTH_MODE: 'password', RESEND_API_KEY: 're_test', WEB_URL: 'https://hub.example' },
    providers: [[MAIL_FETCH, fakeResend]],
  });
  devApp = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await devApp.close();
});

const http = () => request(app.getHttpServer());
const signup = (email: string, password = PASSWORD, name = 'Pat Smith') => http().post('/auth/signup').send({ email, password, name });
const login = (email: string, password = PASSWORD) => http().post('/auth/login').send({ email, password });
const as = (token: string) => ({
  get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object = {}, tenantId?: string) => {
    const r = http().post(path).set('Authorization', `Bearer ${token}`);
    return (tenantId ? r.set('X-Tenant-Id', tenantId) : r).send(body);
  },
});
const newEmail = () => `${unique('person')}@Example.com`;

/** The token from the last email of a kind sent to an address. */
function linkToken(email: string, path: 'verify' | 'reset' | 'email-change'): string {
  const mail = outbox.findLast((m) => m.to[0] === email.toLowerCase() && m.text.includes(`/${path}?token=`));
  if (!mail) throw new Error(`no ${path} email for ${email}`);
  return new RegExp(`https://hub\\.example/${path}\\?token=(\\S+)`).exec(mail.text)![1]!;
}

/** Signs up and confirms the email, as someone who reads their inbox would. */
async function verifiedAccount(email = newEmail()): Promise<{ email: string; token: string }> {
  const token = (await signup(email).expect(201)).body.token as string;
  await http().post('/auth/email/verify').send({ token: linkToken(email, 'verify') }).expect(200);
  return { email, token };
}

describe('built-in accounts', () => {
  it('signs up, signs in with any letter case, and rejects duplicates and weak passwords', async () => {
    const email = newEmail();
    expect((await http().get('/auth/config').expect(200)).body).toEqual({ mode: 'password', passwordResetByEmail: true, emailVerification: true });
    expect((await signup(email, 'short')).status).toBe(400);
    expect((await signup(email, email.toLowerCase())).body.message).toBe('Don’t use your email as your password');

    const created = await signup(email).expect(201);
    expect(created.body.token).toMatch(/^[0-9a-f-]{36}\.[\w-]{43}$/);
    const me = await as(created.body.token).get('/me').expect(200);
    expect(me.body.user).toMatchObject({ email: email.toLowerCase(), displayName: 'Pat Smith' });

    const taken = await signup(email.toUpperCase()).expect(409);
    expect(taken.body.code).toBe('email_taken');

    const again = await login(email.toUpperCase()).expect(200);
    expect(again.body.token).not.toBe(created.body.token);
    expect((await login(email, 'wrong password!')).status).toBe(401);
    expect((await login(newEmail())).body.message).toBe('Email or password is incorrect');

    // The dev stand-in is gone in this mode.
    await http().post('/dev/token').send({ email }).expect(404);
  });

  it('locks an account after repeated wrong passwords', async () => {
    const email = newEmail();
    await signup(email).expect(201);
    for (let i = 0; i < 10; i++) await login(email, `wrong password ${i}`).expect(401);
    const locked = await login(email).expect(429);
    expect(locked.body.message).toMatch(/Try again in 15 minutes/);
  });

  it('signs out one device or every device', async () => {
    const email = newEmail();
    const phone = (await signup(email).expect(201)).body.token;
    const laptop = (await login(email).expect(200)).body.token;
    const tablet = (await login(email).expect(200)).body.token;

    await as(phone).post('/auth/logout').expect(200);
    expect((await as(phone).get('/me')).status).toBe(401);
    await as(laptop).get('/me').expect(200);

    await as(laptop).post('/auth/logout-all').expect(200);
    expect((await as(laptop).get('/me')).status).toBe(401);
    expect((await as(tablet).get('/me')).status).toBe(401);

    // A forged secret for a real session id is refused.
    const fresh = (await login(email).expect(200)).body.token as string;
    expect((await as(`${fresh.split('.')[0]}.${'x'.repeat(43)}`).get('/me')).status).toBe(401);
  });

  it('changes the password, keeping this device signed in and signing out the rest', async () => {
    const email = newEmail();
    const here = (await signup(email).expect(201)).body.token;
    const elsewhere = (await login(email).expect(200)).body.token;

    const wrong = await as(here).post('/auth/password', { currentPassword: 'not it at all', newPassword: 'a brand new passphrase' }).expect(400);
    expect(wrong.body.message).toBe('Your current password is incorrect');
    await as(here).post('/auth/password', { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' }).expect(200);

    await as(here).get('/me').expect(200);
    expect((await as(elsewhere).get('/me')).status).toBe(401);
    await login(email).expect(401);
    await login(email, 'a brand new passphrase').expect(200);
  });

  it('resets a forgotten password by email, once', async () => {
    const email = newEmail();
    const old = (await signup(email).expect(201)).body.token;

    await http().post('/auth/password/forgot').send({ email: email.toUpperCase() }).expect(200);
    // Unknown emails get the same answer and no email.
    const before = outbox.length;
    await http().post('/auth/password/forgot').send({ email: newEmail() }).expect(200);
    expect(outbox.length).toBe(before);

    const mail = outbox.findLast((m) => m.to[0] === email.toLowerCase())!;
    expect(mail.subject).toBe('Reset your Ample POS password');
    const token = /https:\/\/hub\.example\/reset\?token=(\S+)/.exec(mail.text)![1]!;

    const reset = await http().post('/auth/password/reset').send({ token, password: 'my new long password' }).expect(200);
    await as(reset.body.token).get('/me').expect(200);
    expect((await as(old).get('/me')).status).toBe(401);
    await login(email, 'my new long password').expect(200);

    const reused = await http().post('/auth/password/reset').send({ token, password: 'another new password' }).expect(400);
    expect(reused.body.code).toBe('reset_invalid');
  });

  it('lets a manager make a reset link only for members who belong to no other business', async () => {
    const ownerToken = (await verifiedAccount()).token;
    const owner = as(ownerToken);
    const tenantId = (await owner.post('/tenants', { name: 'Shop', slug: unique('shop') }).expect(201)).body.id;
    const roles = (await http().get('/roles').set('Authorization', `Bearer ${ownerToken}`).set('X-Tenant-Id', tenantId).expect(200)).body;
    const invite = async (roleKey: string) => {
      const email = newEmail();
      const token = (await signup(email).expect(201)).body.token;
      const code = (await owner.post('/invitations', { roleId: roles.find((r: { key: string }) => r.key === roleKey).id }, tenantId).expect(201)).body.code;
      await as(token).post('/invitations/accept', { code }).expect(201);
      return { email, token };
    };
    const staff = await invite('staff');
    const manager = await invite('manager');
    const members = (await http().get('/members').set('Authorization', `Bearer ${ownerToken}`).set('X-Tenant-Id', tenantId).expect(200)).body;
    const memberId = (email: string) => members.find((m: { user: { email: string } }) => m.user.email === email.toLowerCase()).id;

    // Managers don't manage the team by default; owners do.
    await as(manager.token).post(`/members/${memberId(staff.email)}/password-reset`, {}, tenantId).expect(403);
    const made = await owner.post(`/members/${memberId(staff.email)}/password-reset`, {}, tenantId).expect(201);
    expect(made.body.link).toMatch(/^https:\/\/hub\.example\/reset\?token=/);
    const token = new URL(made.body.link).searchParams.get('token')!;
    const viaHub = await http().post('/auth/password/reset').send({ token, password: 'staff picked this one' }).expect(200);
    await login(staff.email, 'staff picked this one').expect(200);
    // A link from the hub says nothing about who reads that inbox.
    expect((await as(viaHub.body.token).get('/me').expect(200)).body.account.emailVerified).toBe(false);

    // Nobody resets their own password this way.
    const ownerMember = members.find((m: { role: { key: string } }) => m.role.key === 'owner').id;
    await owner.post(`/members/${ownerMember}/password-reset`, {}, tenantId).expect(409);

    // Someone who also works at another business can only reset by email.
    const other = await owner.post('/tenants', { name: 'Other', slug: unique('other') }).expect(201);
    const otherRoles = (await http().get('/roles').set('Authorization', `Bearer ${ownerToken}`).set('X-Tenant-Id', other.body.id).expect(200)).body;
    const code = (await owner.post('/invitations', { roleId: otherRoles.find((r: { key: string }) => r.key === 'staff').id }, other.body.id).expect(201)).body.code;
    await as(manager.token).post('/invitations/accept', { code }).expect(201);
    const shared = await owner.post(`/members/${memberId(manager.email)}/password-reset`, {}, tenantId).expect(409);
    expect(shared.body.message).toMatch(/also belongs to another business/);
  });

  it('asks new accounts to confirm their email before creating a business', async () => {
    const email = newEmail();
    const token = (await signup(email).expect(201)).body.token;
    const mail = outbox.findLast((m) => m.to[0] === email.toLowerCase())!;
    expect(mail.subject).toBe('Confirm your email for Ample POS');
    expect((await as(token).get('/me').expect(200)).body.account).toEqual({ hasPassword: true, emailVerified: false });

    const blocked = await as(token).post('/tenants', { name: 'Shop', slug: unique('shop') }).expect(403);
    expect(blocked.body.code).toBe('email_unverified');

    // A fresh link can be requested; only the latest matters to the user, but any unused one works.
    await as(token).post('/auth/email/verify-request').expect(200);
    const verifyToken = linkToken(email, 'verify');
    const verified = await http().post('/auth/email/verify').send({ token: verifyToken }).expect(200);
    expect(verified.body.email).toBe(email.toLowerCase());
    expect((await as(token).get('/me').expect(200)).body.account.emailVerified).toBe(true);
    await as(token).post('/tenants', { name: 'Shop', slug: unique('shop') }).expect(201);

    const reused = await http().post('/auth/email/verify').send({ token: verifyToken }).expect(400);
    expect(reused.body.code).toBe('verify_invalid');
    // Nothing left to verify, so no more links go out.
    const before = outbox.length;
    expect((await as(token).post('/auth/email/verify-request').expect(200)).body.sent).toBe(false);
    expect(outbox.length).toBe(before);
  });

  it('only lets a verified account accept an invitation locked to its email', async () => {
    const owner = await verifiedAccount();
    const tenantId = (await as(owner.token).post('/tenants', { name: 'Shop', slug: unique('shop') }).expect(201)).body.id;
    const roles = (await http().get('/roles').set('Authorization', `Bearer ${owner.token}`).set('X-Tenant-Id', tenantId).expect(200)).body;
    const staffRole = roles.find((r: { key: string }) => r.key === 'staff').id;

    const email = newEmail();
    const invitee = (await signup(email).expect(201)).body.token;
    const locked = (await as(owner.token).post('/invitations', { roleId: staffRole, email }, tenantId).expect(201)).body.code;
    const refused = await as(invitee).post('/invitations/accept', { code: locked }).expect(403);
    expect(refused.body.code).toBe('email_unverified');

    // An open code (not locked to an email) works without verifying.
    const open = (await as(owner.token).post('/invitations', { roleId: staffRole }, tenantId).expect(201)).body.code;
    const other = (await signup(newEmail()).expect(201)).body.token;
    await as(other).post('/invitations/accept', { code: open }).expect(201);

    await http().post('/auth/email/verify').send({ token: linkToken(email, 'verify') }).expect(200);
    await as(invitee).post('/invitations/accept', { code: locked }).expect(201);
  });

  it('treats an emailed password reset as proof of the email, but not a hub-made link', async () => {
    // Someone signs up with an address they don't own; the real owner reclaims it by email.
    const email = newEmail();
    const squatter = (await signup(email, 'squatter password').expect(201)).body.token;
    await http().post('/auth/password/forgot').send({ email }).expect(200);
    const reset = await http().post('/auth/password/reset').send({ token: linkToken(email, 'reset'), password: 'the real owner here' }).expect(200);
    expect((await as(squatter).get('/me')).status).toBe(401);
    expect((await as(reset.body.token).get('/me').expect(200)).body.account.emailVerified).toBe(true);
  });

  it('changes the sign-in email once the new address confirms, and tells the old one', async () => {
    const { email, token } = await verifiedAccount();
    const other = await verifiedAccount();
    const next = newEmail();
    // A reset link already sent to the old address must stop working after the change.
    await http().post('/auth/password/forgot').send({ email }).expect(200);
    const oldReset = linkToken(email, 'reset');

    const wrong = await as(token).post('/auth/email/change', { newEmail: next, password: 'not my password' }).expect(400);
    expect(wrong.body.message).toBe('Your password is incorrect');
    const taken = await as(token).post('/auth/email/change', { newEmail: other.email.toUpperCase(), password: PASSWORD }).expect(409);
    expect(taken.body.code).toBe('email_taken');

    const asked = await as(token).post('/auth/email/change', { newEmail: next, password: PASSWORD }).expect(200);
    expect(asked.body).toEqual({ status: 'confirm_sent', email: next.toLowerCase() });
    // Nothing changes until the new address confirms.
    expect((await as(token).get('/me').expect(200)).body.user.email).toBe(email.toLowerCase());
    await login(email).expect(200);

    const link = linkToken(next, 'email-change');
    const confirmed = await http().post('/auth/email/change/confirm').send({ token: link }).expect(200);
    expect(confirmed.body.email).toBe(next.toLowerCase());
    const me = (await as(token).get('/me').expect(200)).body;
    expect(me.user.email).toBe(next.toLowerCase());
    expect(me.account.emailVerified).toBe(true);
    await login(next).expect(200);
    await login(email).expect(401);

    const notice = outbox.findLast((m) => m.to[0] === email.toLowerCase())!;
    expect(notice.subject).toBe('Your Ample POS email was changed');
    expect(notice.text).toContain(next.toLowerCase());
    await http().post('/auth/email/change/confirm').send({ token: link }).expect(400);
    const stale = await http().post('/auth/password/reset').send({ token: oldReset, password: 'trying the old link' }).expect(400);
    expect(stale.body.code).toBe('reset_invalid');
  });

  it('only honours the latest change request', async () => {
    const { token } = await verifiedAccount();
    const first = newEmail();
    const second = newEmail();
    await as(token).post('/auth/email/change', { newEmail: first, password: PASSWORD }).expect(200);
    const firstLink = linkToken(first, 'email-change');
    await as(token).post('/auth/email/change', { newEmail: second, password: PASSWORD }).expect(200);
    await http().post('/auth/email/change/confirm').send({ token: firstLink }).expect(400);
    await http().post('/auth/email/change/confirm').send({ token: linkToken(second, 'email-change') }).expect(200);
    expect((await as(token).get('/me').expect(200)).body.user.email).toBe(second.toLowerCase());
  });

  it('carries a demo-mode user (and their businesses) over to a password account', async () => {
    const email = `${unique('demo')}@example.com`;
    const demo = await Client.signIn(devApp, email);
    await demo.createBusiness('Demo Shop');
    const token = (await signup(email).expect(201)).body.token;
    const me = (await as(token).get('/me').expect(200)).body;
    expect(me.tenants.map((t: { name: string }) => t.name)).toEqual(['Demo Shop']);
    // Password endpoints don't exist in demo mode.
    await request(devApp.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD }).expect(404);
  });

  it('keeps credentials and sessions out of reach of the application role', async () => {
    const sql = postgres(appDatabaseUrl(), { max: 1, onnotice: () => {} });
    try {
      for (const table of ['credentials', 'auth_sessions', 'password_resets']) {
        await expect(sql.unsafe(`select * from ${table} limit 1`)).rejects.toThrow(/permission denied/);
      }
    } finally {
      await sql.end();
    }
  });
});

describe('built-in accounts without email', () => {
  let quiet: INestApplication;

  beforeAll(async () => {
    quiet = await createTestApp({ env: { AUTH_MODE: 'password' } });
  });

  afterAll(async () => {
    await quiet.close();
  });

  it('doesn’t hold anything back when there is no way to send a confirmation', async () => {
    const q = () => request(quiet.getHttpServer());
    expect((await q().get('/auth/config').expect(200)).body).toEqual({ mode: 'password', passwordResetByEmail: false, emailVerification: false });
    const token = (await q().post('/auth/signup').send({ email: newEmail(), password: PASSWORD, name: 'Pat' }).expect(201)).body.token;
    await q().post('/tenants').set('Authorization', `Bearer ${token}`).send({ name: 'Shop', slug: unique('shop') }).expect(201);
    await q().post('/auth/email/verify-request').set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('changes the email at once, since there is no way to confirm it', async () => {
    const q = () => request(quiet.getHttpServer());
    const email = newEmail();
    const next = newEmail();
    const token = (await q().post('/auth/signup').send({ email, password: PASSWORD, name: 'Pat' }).expect(201)).body.token;
    const res = await q().post('/auth/email/change').set('Authorization', `Bearer ${token}`).send({ newEmail: next, password: PASSWORD }).expect(200);
    expect(res.body).toEqual({ status: 'changed', email: next.toLowerCase() });
    await q().post('/auth/login').send({ email: next, password: PASSWORD }).expect(200);
    await q().post('/auth/login').send({ email, password: PASSWORD }).expect(401);
  });
});
