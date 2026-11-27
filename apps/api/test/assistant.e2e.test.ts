import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePairingCode } from '../src/imports/assistant.controller';
import { adminSql, Client, createTestApp } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const http = () => request(app.getHttpServer());
const withKey = (key: string) => ({
  get: (path: string) => http().get(path).set('Authorization', `Bearer ${key}`),
  post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${key}`).send(body),
});

describe('pairing the Migration Assistant', () => {
  it('trades a one-time code for an import-only key', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness('Harbor Outfitters');
    await owner.put('/modules/catalog', { enabled: true }).expect(200);
    const store = (await owner.post('/locations', { name: 'Main', timezone: 'UTC' }).expect(201)).body;

    const made = (await owner.post('/migration/assistant/pairing-codes').expect(201)).body;
    expect(made.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Date(made.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    // Typed in lower case without the dash still works.
    const typed = made.code.toLowerCase().replace('-', '');
    const paired = (await http().post('/migration/assistant/pair').send({ code: typed, computer: 'FRONT-PC' }).expect(200)).body;
    expect(paired).toMatchObject({ tenantId: owner.tenantId, businessName: 'Harbor Outfitters' });
    expect(paired.apiKey).toMatch(/^ak_/);

    // The key imports, and sees locations to choose where stock goes; nothing more.
    const assistant = withKey(paired.apiKey);
    expect((await assistant.get('/locations').expect(200)).body.map((l: { id: string }) => l.id)).toContain(store.id);
    const preview = (
      await assistant
        .post('/imports', {
          kind: 'products',
          source: 'qbpos',
          fileName: 'QuickBooks POS items',
          csv: 'Item Number,Item Name,Regular Price\n1001,Mug,12.00',
          locationId: store.id,
        })
        .expect(201)
    ).body;
    await assistant.post(`/imports/${preview.batch.id}/commit`).expect(200);
    await assistant.get('/migration/reconciliation').expect(200);
    await assistant.post('/customers', { name: 'Nope' }).expect(403);
    // It can't mint more codes or keys.
    await assistant.post('/migration/assistant/pairing-codes').expect(403);

    // The owner sees it among the business's API keys, named after the PC, and can revoke it.
    const keys = (await owner.get('/api-keys').expect(200)).body;
    const listed = keys.find((k: { name: string }) => k.name === 'Migration Assistant (FRONT-PC)');
    expect(listed).toMatchObject({ permissions: ['data.manage'] });

    // Each code works once.
    const again = await http().post('/migration/assistant/pair').send({ code: made.code }).expect(401);
    expect(again.body.code).toBe('bad_pairing_code');
  });

  it('refuses expired codes and people without data.manage', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    const { code } = (await owner.post('/migration/assistant/pairing-codes').expect(201)).body;
    const sql = adminSql();
    await sql`update assistant_pairings set expires_at = now() - interval '1 second' where tenant_id = ${owner.tenantId!}`;
    await sql.end();
    await http().post('/migration/assistant/pair').send({ code }).expect(401);

    const staff = await owner.invite(await Client.signIn(app), 'manager');
    await staff.post('/migration/assistant/pairing-codes').expect(403);
    await http().post('/migration/assistant/pair').send({ code: 'short' }).expect(400);
  });

  it('reads codes the way people type them', () => {
    expect(normalizePairingCode('k7qm-2xpa')).toBe('K7QM2XPA');
    expect(normalizePairingCode(' K7QM 2XPA ')).toBe('K7QM2XPA');
    expect(normalizePairingCode('K7QM-2XP0')).toBeNull();
    expect(normalizePairingCode('K7QM2XPAX')).toBeNull();
  });
});
