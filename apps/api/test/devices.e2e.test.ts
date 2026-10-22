import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, Client, createTestApp, unique } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

async function pairedHandheld() {
  const owner = await Client.signIn(app);
  await owner.createBusiness();
  await owner.put('/modules/catalog', { enabled: true }).expect(200);
  await owner.put('/modules/inventory', { enabled: true }).expect(200);
  const location = (await owner.post('/locations', { name: 'Back room', timezone: 'UTC' }).expect(201)).body;
  const reg = await owner.post('/devices', { locationId: location.id, name: 'Scanner 1', kind: 'handheld' }).expect(201);
  const staff = await owner.invite(await Client.signIn(app), 'staff');
  staff.deviceCredential = reg.body.credential;
  return { owner, staff, location, device: reg.body.device, credential: reg.body.credential as string };
}

describe('device credentials', () => {
  it('identifies a paired device and its location', async () => {
    const { staff, location, device } = await pairedHandheld();
    const me = await staff.get('/device').expect(200);
    expect(me.body).toMatchObject({ id: device.id, name: 'Scanner 1', kind: 'handheld', location: { id: location.id, name: 'Back room' } });
  });

  it('rejects wrong secrets, revoked devices and other businesses’ devices', async () => {
    const { owner, staff, device, credential } = await pairedHandheld();

    staff.deviceCredential = `${device.id}.not-the-secret`;
    await staff.get('/device').expect(401);
    staff.deviceCredential = 'garbage';
    await staff.get('/locations').expect(401);

    // A real credential from another business does not work here.
    const other = await pairedHandheld();
    staff.deviceCredential = other.credential;
    await staff.get('/device').expect(401);

    staff.deviceCredential = credential;
    await staff.get('/device').expect(200);
    await owner.post(`/devices/${device.id}/revoke`).expect(201);
    await staff.get('/device').expect(401);
    await staff.get('/locations').expect(401);

    // Without a device header the person can still use the web hub.
    staff.deviceCredential = undefined;
    await staff.get('/locations').expect(200);
    await staff.get('/device').expect(401);
  });

  it('records which device counted, and when it was last seen', async () => {
    const { owner, staff, location, device } = await pairedHandheld();
    const product = await owner
      .post('/catalog/products', { name: 'Widget', variants: [{ priceMinor: 100, barcodes: [unique('W')] }] })
      .expect(201);
    const count = (await staff.post('/inventory/counts', { locationId: location.id, name: 'Device count' }).expect(201)).body;
    await staff
      .post(`/inventory/counts/${count.id}/entries`, { entries: [{ id: randomUUID(), variantId: product.body.variants[0].id, quantity: 2 }] })
      .expect(201);

    const sql = adminSql();
    try {
      const [entry] = await sql`select device_id from count_entries where session_id = ${count.id}`;
      expect(entry!.device_id).toBe(device.id);
      const [audit] = await sql`select actor_device_id from audit_log where action = 'count.started' and target_id = ${count.id}`;
      expect(audit!.actor_device_id).toBe(device.id);
    } finally {
      await sql.end();
    }
    const devices = await owner.get('/devices').expect(200);
    expect(devices.body[0].lastSeenAt).not.toBeNull();
  });

  it('filters counts by location', async () => {
    const { owner, location } = await pairedHandheld();
    const elsewhere = (await owner.post('/locations', { name: 'Front', timezone: 'UTC' }).expect(201)).body;
    await owner.post('/inventory/counts', { locationId: location.id, name: 'Here' }).expect(201);
    await owner.post('/inventory/counts', { locationId: elsewhere.id, name: 'There' }).expect(201);
    const res = await owner.get(`/inventory/counts?locationId=${location.id}&status=open`).expect(200);
    expect(res.body.map((c: { name: string }) => c.name)).toEqual(['Here']);
  });
});

describe('catalog download for offline scanning', () => {
  it('pages through active variants with their barcodes', async () => {
    const { owner, staff } = await pairedHandheld();
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const code = unique(`C${i}`);
      codes.push(code);
      await owner.post('/catalog/products', { name: `Item ${i}`, variants: [{ priceMinor: 100 + i, barcodes: [code] }] }).expect(201);
    }
    const archived = await owner.post('/catalog/products', { name: 'Old', variants: [{ priceMinor: 1 }] }).expect(201);
    await owner.patch(`/catalog/products/${archived.body.id}`, { version: 1, status: 'archived' }).expect(200);

    const seen: { productName: string; barcodes: string[] }[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const res: { body: { variants: { productName: string; barcodes: string[] }[]; next: string | null } } = await staff
        .get(`/catalog/variants?limit=2${after ? `&after=${after}` : ''}`)
        .expect(200);
      seen.push(...res.body.variants);
      after = res.body.next;
      pages++;
    } while (after);
    expect(pages).toBe(3);
    expect(seen.map((v) => v.productName).sort()).toEqual(['Item 0', 'Item 1', 'Item 2', 'Item 3', 'Item 4']);
    expect(seen.flatMap((v) => v.barcodes).sort()).toEqual([...codes].sort());
  });
});
