import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql, appDatabaseUrl, Client, createTestApp } from './helpers';
import postgres from 'postgres';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('authentication', () => {
  it('serves health publicly and rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { ok: true });
    await request(app.getHttpServer()).get('/me').expect(401);
    await request(app.getHttpServer()).get('/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
  });

  it('requires a business id on tenant-scoped routes', async () => {
    const user = await Client.signIn(app);
    await user.get('/locations').expect(400);
  });
});

describe('creating a business', () => {
  it('makes the creator the owner and lists the business on /me', async () => {
    const owner = await Client.signIn(app);
    const tenantId = await owner.createBusiness('Corner Store');

    const me = await owner.get('/me').expect(200);
    expect(me.body.user.email).toBe(owner.email);
    expect(me.body.tenants).toEqual([expect.objectContaining({ id: tenantId, name: 'Corner Store', role: { key: 'owner', name: 'Owner' } })]);

    const current = await owner.get('/tenant').expect(200);
    expect(current.body.membership.permissions).toEqual(['*']);
    expect(current.body.enabledModules).toEqual([]);

    const roles = await owner.get('/roles').expect(200);
    expect(roles.body.map((r: { key: string }) => r.key)).toEqual(['owner', 'manager', 'staff']);
  });

  it('rejects duplicate slugs with 409', async () => {
    const owner = await Client.signIn(app);
    await owner.post('/tenants', { name: 'A', slug: 'same-slug-shop' }).expect(201);
    await owner.post('/tenants', { name: 'B', slug: 'same-slug-shop' }).expect(409);
  });
});

describe('tenant isolation', () => {
  it('blocks non-members and never leaks another business’s rows', async () => {
    const alice = await Client.signIn(app);
    const bob = await Client.signIn(app);
    const aliceTenant = await alice.createBusiness('Alice Co');
    const bobTenant = await bob.createBusiness('Bob Co');
    await alice.post('/locations', { name: 'Main St', timezone: 'America/Chicago' }).expect(201);
    await bob.post('/locations', { name: 'Harbor', timezone: 'America/New_York' }).expect(201);

    // Bob pointing at Alice's business is refused outright.
    bob.tenantId = aliceTenant;
    await bob.get('/locations').expect(403);
    await bob.post('/locations', { name: 'Sneaky', timezone: 'UTC' }).expect(403);
    bob.tenantId = bobTenant;
    const bobs = await bob.get('/locations').expect(200);
    expect(bobs.body.map((l: { name: string }) => l.name)).toEqual(['Harbor']);
  });

  it('enforces isolation in the database itself for the app role', async () => {
    const owner = await Client.signIn(app);
    const tenantId = await owner.createBusiness();
    await owner.post('/locations', { name: 'Only Mine', timezone: 'UTC' }).expect(201);

    const sql = postgres(appDatabaseUrl(), { max: 1, onnotice: () => {} });
    try {
      // No business selected: RLS hides every row.
      const none = await sql`select count(*)::int as n from locations`;
      expect(none[0]!.n).toBe(0);

      const scoped = await sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return tx`select name from locations`;
      });
      expect(scoped.map((r) => r.name)).toEqual(['Only Mine']);

      // Writing a row for another business is rejected by the policy's check.
      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
          await tx`insert into locations (tenant_id, name, timezone) values (gen_random_uuid(), 'x', 'UTC')`;
        }),
      ).rejects.toThrow(/row-level security/);

      // The audit log is append-only for the app.
      await expect(sql`update audit_log set action = 'tampered'`).rejects.toThrow(/permission denied/);
    } finally {
      await sql.end();
    }
  });
});

describe('modules', () => {
  it('enforces dependencies when turning tools on and off', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();

    const blocked = await owner.put('/modules/inventory', { enabled: true }).expect(409);
    expect(blocked.body.modules).toEqual(['catalog']);

    await owner.put('/modules/catalog', { enabled: true }).expect(200);
    await owner.put('/modules/inventory', { enabled: true }).expect(200);
    const dependents = await owner.put('/modules/catalog', { enabled: false }).expect(409);
    expect(dependents.body.modules).toEqual(['inventory']);

    const list = await owner.get('/modules').expect(200);
    const enabled = list.body.filter((m: { enabled: boolean }) => m.enabled).map((m: { id: string }) => m.id);
    expect(enabled.sort()).toEqual(['catalog', 'inventory']);

    await owner.put('/modules/not-a-module', { enabled: true }).expect(404);
  });

  it('builds navigation from enabled modules and the member’s permissions', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    await owner.put('/modules/time-clock', { enabled: true }).expect(200);

    const ownerNav = await owner.get('/navigation').expect(200);
    const titles = ownerNav.body.sections.map((s: { title: string }) => s.title);
    expect(titles).toEqual(['Business', 'Time clock']);

    // Staff can punch but not manage timecards, so they see only the clock link.
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    const staffNav = await staff.get('/navigation').expect(200);
    expect(staffNav.body.sections.map((s: { title: string }) => s.title)).toEqual(['Business', 'Time clock']);
    expect(staffNav.body.sections[0].items.map((i: { label: string }) => i.label)).toEqual(['Locations']);
    expect(staffNav.body.sections[1].items.map((i: { label: string }) => i.label)).toEqual(['Clock in / out']);
  });

  it('records module changes in the audit log and outbox', async () => {
    const owner = await Client.signIn(app);
    const tenantId = await owner.createBusiness();
    await owner.put('/modules/tasks', { enabled: true }).expect(200);

    const audit = await owner.get('/audit').expect(200);
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual(['module.enabled', 'tenant.created']);

    const sql = adminSql();
    try {
      const events = await sql`select topic, payload from outbox where tenant_id = ${tenantId}`;
      expect(events).toEqual([{ topic: 'module.enabled', payload: { moduleId: 'tasks' } }]);
    } finally {
      await sql.end();
    }
  });
});

describe('permissions and roles', () => {
  it('limits staff to what their role allows', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    const staff = await owner.invite(await Client.signIn(app), 'staff');

    await staff.get('/locations').expect(200);
    await staff.post('/locations', { name: 'Nope', timezone: 'UTC' }).expect(403);
    await staff.put('/modules/catalog', { enabled: true }).expect(403);
    await staff.get('/members').expect(403);
    await staff.get('/audit').expect(403);
  });

  it('prevents members from granting access they do not hold', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    const roleRes = await owner
      .post('/roles', { name: 'Shift lead', permissions: ['members.read', 'members.manage', 'pos.sell'] })
      .expect(201);
    expect(roleRes.body.key).toBe('custom-shift-lead');

    const lead = await owner.invite(await Client.signIn(app), 'custom-shift-lead');
    const roles = (await owner.get('/roles').expect(200)).body as { id: string; key: string }[];
    const ownerRole = roles.find((r) => r.key === 'owner')!;
    const managerRole = roles.find((r) => r.key === 'manager')!;

    const members = (await lead.get('/members').expect(200)).body as { id: string; user: { email: string } }[];
    const leadMembership = members.find((m) => m.user.email === lead.email)!;
    const ownerMembership = members.find((m) => m.user.email === owner.email)!;

    // Cannot promote themselves, invite at a higher role, or act on the owner.
    await lead.patch(`/members/${leadMembership.id}`, { roleId: ownerRole.id }).expect(403);
    await lead.patch(`/members/${leadMembership.id}`, { roleId: managerRole.id }).expect(403);
    await lead.post('/invitations', { roleId: managerRole.id }).expect(403);
    await lead.patch(`/members/${ownerMembership.id}`, { status: 'suspended' }).expect(403);

    await owner.post('/roles', { name: 'Bad', permissions: ['*'] }).expect(400);
    await owner.post('/roles', { name: 'Typo', permissions: ['pos.sel'] }).expect(400);
    await owner.patch(`/roles/${ownerRole.id}`, { name: 'Boss' }).expect(403);
  });

  it('keeps at least one active owner', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    const members = (await owner.get('/members').expect(200)).body;
    await owner.patch(`/members/${members[0].id}`, { status: 'suspended' }).expect(409);
  });
});

describe('invitations', () => {
  it('can be used once and only by the intended email', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    const roles = (await owner.get('/roles').expect(200)).body as { id: string; key: string }[];
    const staffRole = roles.find((r) => r.key === 'staff')!;

    const invitee = await Client.signIn(app);
    const stranger = await Client.signIn(app);
    const inv = await owner.post('/invitations', { roleId: staffRole.id, email: invitee.email }).expect(201);

    await stranger.post('/invitations/accept', { code: inv.body.code }).expect(403);
    await invitee.post('/invitations/accept', { code: inv.body.code }).expect(201);
    await invitee.post('/invitations/accept', { code: inv.body.code }).expect(410);

    const revoked = await owner.post('/invitations', { roleId: staffRole.id }).expect(201);
    await owner.post(`/invitations/${revoked.body.invitation.id}/revoke`).expect(201);
    await stranger.post('/invitations/accept', { code: revoked.body.code }).expect(410);
  });
});

describe('devices', () => {
  it('registers a device, returns its credential once, and revokes it', async () => {
    const owner = await Client.signIn(app);
    await owner.createBusiness();
    const location = (await owner.post('/locations', { name: 'Front', timezone: 'UTC' }).expect(201)).body;

    const reg = await owner.post('/devices', { locationId: location.id, name: 'Register 1', kind: 'register' }).expect(201);
    expect(reg.body.credential).toMatch(new RegExp(`^${reg.body.device.id}\\.`));
    expect(reg.body.device.secretHash).toBeUndefined();

    const list = await owner.get('/devices').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].secretHash).toBeUndefined();

    await owner.post(`/devices/${reg.body.device.id}/revoke`).expect(201);
    await owner.post(`/devices/${reg.body.device.id}/revoke`).expect(404);
  });

  it('rejects devices for another business’s location', async () => {
    const alice = await Client.signIn(app);
    const bob = await Client.signIn(app);
    await alice.createBusiness();
    await bob.createBusiness();
    const aliceLoc = (await alice.post('/locations', { name: 'A', timezone: 'UTC' }).expect(201)).body;
    await bob.post('/devices', { locationId: aliceLoc.id, name: 'x', kind: 'handheld' }).expect(404);
  });
});
