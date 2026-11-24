import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIL_FETCH } from '../src/core/mailer';
import { Client, createTestApp, unique } from './helpers';

/** Resend refusing mail the way it does when the sending domain isn't verified. */
let refuse = true;
const sent: string[] = [];
const resend = (async (_url: string, init: RequestInit) => {
  if (refuse) {
    return new Response(JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'The example.com domain is not verified. Please, add and verify your domain on https://resend.com/domains' }), {
      status: 403,
    });
  }
  sent.push(JSON.parse(String(init.body)).to[0]);
  return new Response('{"id":"email_1"}', { status: 200 });
}) as unknown as typeof fetch;

const adminEmail = `${unique('staff')}@ample.example`;
let passwords: INestApplication;
let admin: INestApplication;

beforeAll(async () => {
  passwords = await createTestApp({ env: { AUTH_MODE: 'password', RESEND_API_KEY: 're_test' }, providers: [[MAIL_FETCH, resend]] });
  admin = await createTestApp({ env: { RESEND_API_KEY: 're_test', PLATFORM_ADMIN_EMAILS: adminEmail }, providers: [[MAIL_FETCH, resend]] });
});

afterAll(async () => {
  await passwords.close();
  await admin.close();
});

describe('when confirmation emails can’t be sent', () => {
  it('says why instead of "check your inbox", and the super admin can test email and confirm the person by hand', async () => {
    refuse = true;
    const email = `${unique('owner')}@example.com`;
    const http = () => request(passwords.getHttpServer());
    // Signing up still works.
    const { token } = (await http().post('/auth/signup').send({ email, password: 'correct horse battery', name: 'Pat' }).expect(201)).body;
    const as = (path: string) => http().post(path).set('Authorization', `Bearer ${token}`);

    // Asking again explains the failure rather than claiming the email is confirmed.
    const again = await as('/auth/email/verify-request').expect(503);
    expect(again.body).toMatchObject({ code: 'email_failed' });
    expect(again.body.message).toMatch(/domain is not verified/);
    expect((await as('/tenants').send({ name: 'Shop', slug: unique('shop') }).expect(403)).body.code).toBe('email_unverified');

    // The super admin sees how email is set up and Resend's own error.
    const boss = await Client.signIn(admin, adminEmail);
    expect((await boss.get('/platform/email').expect(200)).body).toEqual({ mode: 'resend', from: 'Ample POS <no-reply@example.com>', fromIsPlaceholder: true });
    expect((await boss.post('/platform/email/test', { email: adminEmail }).expect(502)).body.message).toMatch(/Resend refused it: The example.com domain is not verified/);
    refuse = false;
    await boss.post('/platform/email/test', { email: adminEmail }).expect(200);
    expect(sent).toContain(adminEmail);

    // ...and can confirm the stuck person so they can carry on.
    expect((await boss.post('/platform/email/confirm', { email: email.toUpperCase() }).expect(200)).body).toEqual({ confirmed: true, alreadyConfirmed: false });
    await boss.post('/platform/email/confirm', { email: 'nobody@example.com' }).expect(404);
    await as('/tenants').send({ name: 'Shop', slug: unique('shop') }).expect(201);

    // Not for everyone else.
    const someone = await Client.signIn(admin);
    await someone.post('/platform/email/confirm', { email }).expect(403);
  });
});
