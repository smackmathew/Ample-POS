import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

async function shop() {
  const owner = await Client.signIn(app);
  await owner.createBusiness();
  const store = (await owner.post('/locations', { name: 'Main', timezone: 'UTC' }).expect(201)).body;
  const other = (await owner.post('/locations', { name: 'Other', timezone: 'UTC' }).expect(201)).body;
  const reg = (await owner.post('/devices', { locationId: store.id, name: 'Front register', kind: 'register' }).expect(201)).body;
  const handheld = (await owner.post('/devices', { locationId: store.id, name: 'Scanner', kind: 'handheld' }).expect(201)).body;
  return { owner, store, other, register: reg.device, credential: reg.credential as string, handheld: handheld.device };
}

describe('barcode scanners', () => {
  it('attaches scanners to any device at the location, and the device sees its own', async () => {
    const { owner, store, other, register, credential, handheld } = await shop();
    const front = (await owner.post('/scanners', { locationId: store.id, name: 'Front scanner', brand: 'Symbol', model: 'LS2208', connection: 'usb', deviceId: register.id }).expect(201)).body;
    expect(front).toMatchObject({ brand: 'Symbol', model: 'LS2208', connection: 'usb', deviceId: register.id });
    // More than one per device is fine, and handhelds can have them too.
    await owner.post('/scanners', { locationId: store.id, name: 'Presentation', connection: 'usb', deviceId: register.id }).expect(201);
    const bt = (await owner.post('/scanners', { locationId: store.id, name: 'Stockroom', brand: 'Symbol', model: 'CS4070', connection: 'bluetooth', deviceId: handheld.id }).expect(201)).body;
    await owner.post('/scanners', { locationId: other.id, name: 'Elsewhere', connection: 'usb', deviceId: register.id }).expect(400);
    await owner.post('/scanners', { locationId: store.id, name: 'Bad', connection: 'wifi' }).expect(400);

    owner.deviceCredential = credential;
    const me = (await owner.get('/device').expect(200)).body;
    owner.deviceCredential = undefined;
    expect(me.scanners.map((s: { name: string }) => s.name).sort()).toEqual(['Front scanner', 'Presentation']);

    // Move one, remove one; revoking a device frees its scanners.
    await owner.patch(`/scanners/${bt.id}`, { deviceId: null }).expect(200);
    await owner.delete(`/scanners/${front.id}`).expect(200);
    await owner.post(`/devices/${register.id}/revoke`).expect(201);
    const list = (await owner.get('/scanners').expect(200)).body;
    expect(list.map((s: { name: string; deviceId: string | null }) => [s.name, s.deviceId])).toEqual([
      ['Presentation', null],
      ['Stockroom', null],
    ]);
  });
});

describe('printers', () => {
  it('adds receipt printers per register and tag printers per location, by IP, network share or USB', async () => {
    const { owner, store, register, credential } = await shop();
    const receipt = (
      await owner
        .post('/printers', { locationId: store.id, kind: 'receipt', name: 'Front receipt', connection: 'ip', address: '192.168.1.50', language: 'escpos', paper: '80mm', registerId: register.id })
        .expect(201)
    ).body;
    expect(receipt).toMatchObject({ kind: 'receipt', connection: 'ip', address: '192.168.1.50', port: 9100, registerId: register.id });
    const tag = (
      await owner
        .post('/printers', { locationId: store.id, kind: 'tag', name: 'Price tags', connection: 'network_share', address: '\\\\FRONT-PC\\Zebra', language: 'zpl', paper: '2x1in' })
        .expect(201)
    ).body;
    // Tag printers aren't tied to a register.
    await owner.post('/printers', { locationId: store.id, kind: 'tag', name: 'X', connection: 'usb', language: 'zpl', registerId: register.id }).expect(400);
    await owner.patch(`/printers/${tag.id}`, { registerId: register.id }).expect(400);
    await owner.post('/printers', { locationId: store.id, kind: 'receipt', name: 'Back office', connection: 'usb', language: 'system' }).expect(201);

    // The register learns its receipt printer and the location's tag printers when it checks in.
    owner.deviceCredential = credential;
    const me = (await owner.get('/device').expect(200)).body;
    owner.deviceCredential = undefined;
    expect(me.printers.map((p: { kind: string; name: string }) => [p.kind, p.name]).sort()).toEqual([
      ['receipt', 'Front receipt'],
      ['tag', 'Price tags'],
    ]);

    // One receipt printer per register.
    expect((await owner.post('/printers', { locationId: store.id, kind: 'receipt', name: 'Second', connection: 'usb', language: 'escpos', registerId: register.id }).expect(409)).body.message).toMatch(
      /already has a receipt printer/,
    );
    await owner.delete(`/printers/${receipt.id}`).expect(200);
    const list = (await owner.get('/printers').expect(200)).body;
    expect(list.map((p: { name: string; registerId: string | null }) => [p.name, p.registerId])).toEqual([
      ['Back office', null],
      ['Price tags', null],
    ]);
  });

  it('checks connection details, language and register', async () => {
    const { owner, store, other, register, handheld } = await shop();
    const base = { locationId: store.id, kind: 'receipt', name: 'P', language: 'escpos' };
    await owner.post('/printers', { ...base, connection: 'ip' }).expect(400);
    await owner.post('/printers', { ...base, connection: 'ip', address: 'not an address!' }).expect(400);
    await owner.post('/printers', { ...base, connection: 'network_share', address: 'FRONT-PC/printer' }).expect(400);
    await owner.post('/printers', { ...base, connection: 'network_share', address: 'smb://front-pc/receipt' }).expect(201);
    await owner.post('/printers', { ...base, connection: 'usb', language: 'zpl' }).expect(400);
    await owner.post('/printers', { ...base, kind: 'tag', connection: 'usb', language: 'escpos' }).expect(400);
    // Only registers, at the same location.
    await owner.post('/printers', { ...base, connection: 'usb', registerId: handheld.id }).expect(400);
    await owner.post('/printers', { ...base, locationId: other.id, connection: 'usb', registerId: register.id }).expect(400);

    // Revoking a register frees its printers.
    const p = (await owner.post('/printers', { ...base, connection: 'ip', address: 'printer.local', port: 9101, registerId: register.id }).expect(201)).body;
    expect(p.port).toBe(9101);
    await owner.post(`/devices/${register.id}/revoke`).expect(201);
    expect((await owner.get('/printers').expect(200)).body.find((x: { id: string }) => x.id === p.id).registerId).toBeNull();

    // Staff can't manage printers.
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    await staff.get('/printers').expect(403);
  });
});
