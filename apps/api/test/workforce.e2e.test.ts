import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDate } from '../src/workforce/timecards';
import { adminSql, appDatabaseUrl, Client, createTestApp, unique } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

/** A business in Chicago with a manager and a staff member, all workforce tools on. */
async function team(modules = ['time-clock', 'scheduling', 'tasks', 'reporting']) {
  const owner = await Client.signIn(app);
  await owner.createBusiness();
  for (const m of modules) await owner.put(`/modules/${m}`, { enabled: true }).expect(200);
  const store = (await owner.post('/locations', { name: 'Store', timezone: 'America/Chicago' }).expect(201)).body;
  const manager = await owner.invite(await Client.signIn(app), 'manager');
  const staff = await owner.invite(await Client.signIn(app), 'staff');
  const me = async (c: Client) => (await c.get('/me').expect(200)).body.user.id as string;
  return { owner, manager, staff, store, ids: { owner: await me(owner), manager: await me(manager), staff: await me(staff) } };
}

const punch = (c: Client, kind: string, locationId?: string, id = randomUUID()) => c.post('/timeclock/punches', { id, kind, locationId });

/** A manager-entered punch at a Chicago local time on a given date. */
function manual(by: Client, userId: string, locationId: string, kind: string, localDateTime: string) {
  // March 2026 dates below are CST (UTC-6) until the 8th, CDT (UTC-5) after.
  const offset = localDateTime >= '2026-03-08T02:00' ? '-05:00' : '-06:00';
  return by.post('/timeclock/punches/manual', { id: randomUUID(), userId, locationId, kind, occurredAt: `${localDateTime}:00${offset}`, reason: 'Entered from paper timesheet' });
}

describe('time clock', () => {
  it('lets staff clock in and out with only sensible punches', async () => {
    const { staff, store } = await team();
    expect((await staff.get('/timeclock/me').expect(200)).body).toMatchObject({ state: 'off', allowed: ['in'] });
    await punch(staff, 'in').expect(400); // no location chosen
    await punch(staff, 'out', store.id).expect(409);

    const inId = randomUUID();
    expect((await punch(staff, 'in', store.id, inId).expect(201)).body).toMatchObject({ state: 'working', allowed: ['break_start', 'out'] });
    await punch(staff, 'in', store.id, inId).expect(201); // the same tap resent is fine
    const again = await punch(staff, 'in', store.id).expect(409);
    expect(again.body.message).toBe('You are already clocked in');
    expect((await punch(staff, 'break_start', store.id).expect(201)).body.state).toBe('on_break');
    expect((await punch(staff, 'break_end', store.id).expect(201)).body.state).toBe('working');
    const out = (await punch(staff, 'out', store.id).expect(201)).body;
    expect(out.state).toBe('off');
    expect(out.punches.map((p: { kind: string }) => p.kind)).toEqual(['out', 'break_end', 'break_start', 'in']);
  });

  it('never lets the app change what was punched, only void it', async () => {
    const { staff, store } = await team();
    await punch(staff, 'in', store.id).expect(201);
    const sql = postgres(appDatabaseUrl(), { max: 1, onnotice: () => {} });
    try {
      await expect(sql`update time_punches set occurred_at = now() - interval '1 hour'`).rejects.toThrow(/permission denied/);
      await expect(sql`delete from time_punches`).rejects.toThrow(/permission denied/);
    } finally {
      await sql.end();
    }
  });

  it('builds weekly timecards with breaks and overtime in the location’s time zone', async () => {
    const { owner, staff, store, ids } = await team();
    // Mon 2 – Fri 6 March 2026: 8:00–17:00 with a 30 minute break = 8.5h a day, 42.5h for the week.
    for (const day of ['02', '03', '04', '05', '06']) {
      await manual(owner, ids.staff, store.id, 'in', `2026-03-${day}T08:00`).expect(201);
      await manual(owner, ids.staff, store.id, 'break_start', `2026-03-${day}T12:00`).expect(201);
      await manual(owner, ids.staff, store.id, 'break_end', `2026-03-${day}T12:30`).expect(201);
      await manual(owner, ids.staff, store.id, 'out', `2026-03-${day}T17:00`).expect(201);
    }
    // Saturday night shift past midnight counts on Saturday (local), not Sunday (UTC).
    await manual(owner, ids.staff, store.id, 'in', '2026-03-07T20:00').expect(201);
    await manual(owner, ids.staff, store.id, 'out', '2026-03-07T23:30').expect(201);

    const card = (await staff.get('/timeclock/timecards?from=2026-03-02&to=2026-03-08').expect(200)).body.people[0];
    expect(card.days.map((d: { date: string; workedMinutes: number }) => [d.date, d.workedMinutes])).toEqual([
      ['2026-03-02', 510],
      ['2026-03-03', 510],
      ['2026-03-04', 510],
      ['2026-03-05', 510],
      ['2026-03-06', 510],
      ['2026-03-07', 210],
    ]);
    expect(card.weeks).toEqual([expect.objectContaining({ weekStart: '2026-03-02', workedMinutes: 2760, overtimeMinutes: 360, approval: null })]);
    expect(card.issues).toEqual([]);
  });

  it('keeps people from correcting or approving their own time', async () => {
    const { owner, manager, staff, store, ids } = await team();
    await manual(manager, ids.manager, store.id, 'in', '2026-03-02T09:00').expect(403);
    await manual(manager, ids.staff, store.id, 'in', '2026-03-02T09:00').expect(201);
    await manager.post('/timeclock/approvals', { userId: ids.manager, weekStart: '2026-03-02' }).expect(403);
    // Owners may fix their own records.
    await manual(owner, ids.owner, store.id, 'in', '2026-03-02T09:00').expect(201);
    // A reason is required for manual punches; staff can't add them at all.
    await manager.post('/timeclock/punches/manual', { id: randomUUID(), userId: ids.staff, locationId: store.id, kind: 'out', occurredAt: '2026-03-02T17:00:00-06:00' }).expect(400);
    await manual(staff, ids.staff, store.id, 'out', '2026-03-02T17:00').expect(403);
    // Staff see only their own timecard.
    await staff.get(`/timeclock/timecards?from=2026-03-02&to=2026-03-08&userId=${ids.manager}`).expect(403);
  });

  it('voids wrong punches and marks approvals out of date only for the affected week', async () => {
    const { manager, store, ids } = await team();
    const week1 = ['2026-03-02T09:00', '2026-03-02T17:00'];
    await manual(manager, ids.staff, store.id, 'in', week1[0]!).expect(201);
    await manual(manager, ids.staff, store.id, 'out', week1[1]!).expect(201);
    // Week 2 has a missing clock-out, so it can't be approved yet.
    await manual(manager, ids.staff, store.id, 'in', '2026-03-09T09:00').expect(201);
    await manual(manager, ids.staff, store.id, 'in', '2026-03-10T09:00').expect(201);
    await manual(manager, ids.staff, store.id, 'out', '2026-03-10T15:00').expect(201);

    await manager.post('/timeclock/approvals', { userId: ids.staff, weekStart: '2026-03-03' }).expect(400); // not a Monday
    await manager.post('/timeclock/approvals', { userId: ids.staff, weekStart: '2026-03-02' }).expect(201);
    const blocked = await manager.post('/timeclock/approvals', { userId: ids.staff, weekStart: '2026-03-09' }).expect(409);
    expect(blocked.body.message).toMatch(/No clock-out/);

    // Fix week 2 by voiding the stray clock-in: week 1's approval is untouched.
    const card = async () => (await manager.get(`/timeclock/timecards?from=2026-03-02&to=2026-03-15&userId=${ids.staff}`).expect(200)).body.people[0];
    const stray = (await card()).shifts.find((s: { issues: string[] }) => s.issues.length).punchIds[0];
    await manager.post(`/timeclock/punches/${stray}/void`, { reason: 'Clocked in by mistake' }).expect(201);
    let now = await card();
    expect(now.issues).toEqual([]);
    expect(now.weeks.find((w: { weekStart: string }) => w.weekStart === '2026-03-02').approval).toMatchObject({ workedMinutes: 480, outdated: false });

    // Changing week 1 after approval flags it.
    await manual(manager, ids.staff, store.id, 'in', '2026-03-03T09:00').expect(201);
    await manual(manager, ids.staff, store.id, 'out', '2026-03-03T10:00').expect(201);
    now = await card();
    expect(now.weeks.find((w: { weekStart: string }) => w.weekStart === '2026-03-02').approval.outdated).toBe(true);

    // The voided punch is still on record with who voided it and why.
    const sql = adminSql();
    try {
      const [row] = await sql`select voided_by, void_reason from time_punches where id = ${stray}`;
      expect(row).toEqual({ voided_by: ids.manager, void_reason: 'Clocked in by mistake' });
    } finally {
      await sql.end();
    }
  });
});

describe('scheduling', () => {
  it('prevents double-booking and shows staff only the published schedule', async () => {
    const { manager, staff, store, ids } = await team();
    const shift = (userId: string | null, start: string, end: string) =>
      manager.post('/schedule/shifts', { locationId: store.id, userId, startsAt: start, endsAt: end, position: 'Cashier' });

    await shift(ids.staff, '2026-03-02T09:00:00-06:00', '2026-03-02T17:00:00-06:00').expect(201);
    const clash = await shift(ids.staff, '2026-03-02T16:00:00-06:00', '2026-03-02T20:00:00-06:00').expect(409);
    expect(clash.body.message).toBe('That person is already scheduled at that time');
    await shift(ids.staff, '2026-03-02T17:00:00-06:00', '2026-03-02T21:00:00-06:00').expect(201); // back-to-back is fine
    await shift(null, '2026-03-02T10:00:00-06:00', '2026-03-02T14:00:00-06:00').expect(201); // open shifts may overlap
    await shift(null, '2026-03-02T10:00:00-06:00', '2026-03-02T14:00:00-06:00').expect(201);
    await shift(ids.staff, '2026-03-03T09:00:00-06:00', '2026-03-04T10:00:00-06:00').expect(400); // over 24h

    const range = '/schedule?from=2026-03-02T00:00:00-06:00&to=2026-03-09T00:00:00-06:00';
    expect((await staff.get(range).expect(200)).body).toEqual([]);
    expect((await manager.get(range).expect(200)).body).toHaveLength(4);
    await staff.post('/schedule/shifts', { locationId: store.id, userId: ids.staff, startsAt: '2026-03-05T09:00:00-06:00', endsAt: '2026-03-05T10:00:00-06:00' }).expect(403);

    expect((await manager.post('/schedule/publish', { from: '2026-03-02T00:00:00-06:00', to: '2026-03-09T00:00:00-06:00' }).expect(201)).body).toEqual({ published: 4 });
    const visible = (await staff.get(range).expect(200)).body;
    expect(visible.filter((s: { userId: string }) => s.userId === ids.staff)).toHaveLength(2);

    // Timecards show scheduled next to worked time.
    await manual(manager, ids.staff, store.id, 'in', '2026-03-02T09:10').expect(201);
    await manual(manager, ids.staff, store.id, 'out', '2026-03-02T17:00').expect(201);
    const day = (await staff.get('/timeclock/timecards?from=2026-03-02&to=2026-03-02').expect(200)).body.people[0].days[0];
    expect(day).toEqual({ date: '2026-03-02', workedMinutes: 470, scheduledMinutes: 720 });
  });
});

describe('tasks', () => {
  it('shows each person the checklists due today for them, and records who did what', async () => {
    const { owner, manager, staff, store, ids } = await team();
    const make = (body: object) => manager.post('/tasks/checklists', { locationId: store.id, ...body }).expect(201);
    const opening = (await make({ title: 'Opening', recurrence: 'daily', assigneeRoleKey: 'staff', items: ['Count float', 'Turn on lights'] })).body;
    await make({ title: 'Mondays: deep clean', recurrence: 'weekly', weekdays: [1], items: ['Mop'] });
    await make({ title: 'Manager only', recurrence: 'daily', assigneeRoleKey: 'manager', items: ['Bank deposit'] });
    await make({ title: 'Set up display', recurrence: 'once', dueDate: '2026-03-01', items: ['Build stand'] });
    await manager.post('/tasks/checklists', { title: 'Bad', recurrence: 'weekly', items: ['x'] }).expect(400);

    // Monday 2 March: daily + Monday list + the overdue one-off; not the manager's.
    const monday = (await staff.get(`/tasks/today?locationId=${store.id}&date=2026-03-02`).expect(200)).body;
    expect(monday.lists.map((l: { checklist: { title: string }; overdue: boolean }) => [l.checklist.title, l.overdue])).toEqual([
      ['Mondays: deep clean', false],
      ['Opening', false],
      ['Set up display', true],
    ]);
    const tuesday = (await staff.get(`/tasks/today?locationId=${store.id}&date=2026-03-03`).expect(200)).body;
    expect(tuesday.lists.map((l: { checklist: { title: string } }) => l.checklist.title)).toEqual(['Opening', 'Set up display']);

    const run = monday.lists.find((l: { checklist: { id: string } }) => l.checklist.id === opening.id);
    const [count, lights] = run.items;
    let view = (await staff.post(`/tasks/runs/${run.runId}/items/${count.id}/complete`, { note: 'All there' }).expect(201)).body;
    await staff.post(`/tasks/runs/${run.runId}/items/${count.id}/complete`, {}).expect(201); // ticking twice is harmless
    expect(view).toMatchObject({ done: 1, total: 2 });
    expect(view.items[0].completion).toMatchObject({ completedBy: ids.staff, note: 'All there' });

    // Someone else can't untick your item; a manager can, and the record stays.
    const colleague = await owner.invite(await Client.signIn(app), 'staff');
    await colleague.post(`/tasks/runs/${run.runId}/items/${count.id}/undo`).expect(403);
    view = (await manager.post(`/tasks/runs/${run.runId}/items/${count.id}/undo`).expect(201)).body;
    expect(view.done).toBe(0);
    await staff.post(`/tasks/runs/${run.runId}/items/${lights.id}/complete`, {}).expect(201);

    // The one-off list disappears once finished.
    const display = monday.lists.find((l: { checklist: { title: string } }) => l.checklist.title === 'Set up display');
    await staff.post(`/tasks/runs/${display.runId}/items/${display.items[0].id}/complete`, {}).expect(201);
    const later = (await staff.get(`/tasks/today?locationId=${store.id}&date=2026-03-04`).expect(200)).body;
    expect(later.lists.map((l: { checklist: { title: string } }) => l.checklist.title)).toEqual(['Opening']);

    const sql = adminSql();
    try {
      const rows = await sql`select completed_by, undone_by from checklist_completions where run_id = ${run.runId} and item_id = ${count.id}`;
      expect(rows).toEqual([{ completed_by: ids.staff, undone_by: ids.manager }]);
    } finally {
      await sql.end();
    }
  });

  it('edits items without losing history', async () => {
    const { manager, store } = await team();
    const list = (await manager.post('/tasks/checklists', { locationId: store.id, title: 'Close', recurrence: 'daily', items: ['Lock door', 'Alarm'] }).expect(201)).body;
    const updated = (await manager
      .patch(`/tasks/checklists/${list.id}`, { items: [{ label: 'Set alarm' , id: list.items[1].id }, { label: 'Lights off' }] })
      .expect(200)).body;
    expect(updated.items.map((i: { label: string }) => i.label)).toEqual(['Set alarm', 'Lights off']);
    await manager.patch(`/tasks/checklists/${list.id}`, { items: [{ id: randomUUID(), label: 'x' }] }).expect(400);
    await manager.patch(`/tasks/checklists/${list.id}`, { archived: true }).expect(200);
    expect((await manager.get('/tasks/checklists').expect(200)).body).toEqual([]);
  });
});

describe('reports', () => {
  it('summarises sales, refunds and payment methods by local day, with CSV export', async () => {
    const { owner, store } = await team(['catalog', 'inventory', 'pos', 'reporting', 'time-clock']);
    await owner.patch(`/locations/${store.id}`, { taxRateBps: 1000 }).expect(200);
    const mug = (await owner.post('/catalog/products', { name: 'Mug', variants: [{ priceMinor: 1000, costMinor: 400, sku: unique('M') }] }).expect(201)).body.variants[0];
    const tee = (await owner.post('/catalog/products', { name: 'Tee', variants: [{ priceMinor: 2000, sku: unique('T') }] }).expect(201)).body.variants[0];
    await owner.post('/inventory/receipts', { locationId: store.id, lines: [{ variantId: mug.id, quantity: 10 }, { variantId: tee.id, quantity: 5 }] }).expect(201);
    const register = (await owner.post('/registers/sessions', { locationId: store.id, openingFloatMinor: 0 }).expect(201)).body;
    const sell = async (variantId: string, quantity: number, method: 'cash' | 'card') => {
      const sale = (await owner.post('/sales', { id: randomUUID(), registerSessionId: register.id, lines: [{ variantId, quantity }] }).expect(201)).body;
      if (method === 'cash') await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method, tenderedMinor: sale.totalMinor }).expect(201);
      else {
        const card = (await owner.post(`/sales/${sale.id}/payments`, { id: randomUUID(), method }).expect(201)).body;
        await owner.post(`/sales/${sale.id}/payments/${card.payment.id}/simulate`, { outcome: 'approve' }).expect(201);
      }
      return sale;
    };
    const first = await sell(mug.id, 2, 'cash'); // 22.00
    await sell(tee.id, 1, 'card'); // 22.00
    await sell(mug.id, 1, 'card'); // 11.00
    await owner.post(`/sales/${first.id}/refunds`, { id: randomUUID(), lines: [{ saleLineId: first.lines[0].id, quantity: 1 }], restock: true, registerSessionId: register.id }).expect(201);

    const today = localDate(new Date(), 'America/Chicago');
    const report = (await owner.get(`/reports/sales?from=${today}&to=${today}`).expect(200)).body;
    expect(report.totals).toEqual({ salesCount: 3, grossMinor: 5500, discountMinor: 0, taxMinor: 500, refundsMinor: 1100, netMinor: 4400 });
    expect(report.tenders).toEqual({ cash: 2200, card: 3300 });
    expect(report.topProducts.map((p: { description: string; quantity: number; revenueMinor: number }) => [p.description, p.quantity, p.revenueMinor])).toEqual([
      ['Mug', 3, 3300],
      ['Tee', 1, 2200],
    ]);

    const csv = await owner.get(`/reports/sales.csv?from=${today}&to=${today}`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.trim().split('\n')).toEqual(['date,sales,gross,discounts,tax,refunds,net', `${today},3,55.00,0.00,5.00,11.00,44.00`]);

    // Stock at cost: mugs 10 − 3 + 1 = 8 × 4.00; tees have no cost recorded.
    const inventory = (await owner.get('/reports/inventory').expect(200)).body;
    expect(inventory).toEqual([expect.objectContaining({ location: 'Store', units: 12, valueMinor: 3200, uncostedUnits: 4, itemsInStock: 2 })]);
  });

  it('relates hours worked to sales', async () => {
    const { owner, manager, store, ids } = await team(['reporting', 'time-clock']);
    await manual(owner, ids.staff, store.id, 'in', '2026-03-02T09:00').expect(201);
    await manual(owner, ids.staff, store.id, 'out', '2026-03-02T13:00').expect(201);
    await manual(owner, ids.manager, store.id, 'in', '2026-03-02T09:00').expect(201);
    await manual(owner, ids.manager, store.id, 'out', '2026-03-02T11:00').expect(201);
    const labor = (await manager.get('/reports/labor?from=2026-03-02&to=2026-03-02').expect(200)).body;
    expect(labor.people.map((p: { userId: string; workedMinutes: number }) => [p.userId, p.workedMinutes])).toEqual([
      [ids.staff, 240],
      [ids.manager, 120],
    ]);
    expect(labor).toMatchObject({ workedMinutes: 360, netSalesMinor: 0, salesPerLaborHourMinor: 0 });
    const staff = await owner.invite(await Client.signIn(app), 'staff');
    await staff.get('/reports/labor?from=2026-03-02&to=2026-03-02').expect(403);
  });
});
