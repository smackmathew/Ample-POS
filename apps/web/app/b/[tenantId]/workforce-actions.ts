'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { api, attempt, type ActionState } from '@/lib/api';
import { zonedToUtc } from '@/lib/time';

const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const base = (tenantId: string) => `/b/${tenantId}`;

// Time clock ---------------------------------------------------------------------

export async function clockPunch(tenantId: string, kind: string, punchId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api('/timeclock/punches', { tenantId, method: 'POST', body: { id: punchId, kind, locationId: str(form, 'locationId') || undefined } });
    revalidatePath(`${base(tenantId)}/clock`);
  });
}

export async function addPunch(tenantId: string, timezones: Record<string, string>, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const locationId = str(form, 'locationId');
    await api('/timeclock/punches/manual', {
      tenantId,
      method: 'POST',
      body: {
        id: randomUUID(),
        userId: str(form, 'userId'),
        kind: str(form, 'kind'),
        locationId,
        // The manager types the store's local time.
        occurredAt: zonedToUtc(str(form, 'at'), timezones[locationId] ?? 'UTC').toISOString(),
        reason: str(form, 'reason'),
      },
    });
    revalidatePath(`${base(tenantId)}/timecards`);
    return { ok: 'Punch added' };
  });
}

export async function voidPunch(tenantId: string, punchId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    await api(`/timeclock/punches/${punchId}/void`, { tenantId, method: 'POST', body: { reason: str(form, 'reason') } });
    revalidatePath(`${base(tenantId)}/timecards`);
  });
}

export async function approveWeek(tenantId: string, userId: string, weekStart: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    await api('/timeclock/approvals', { tenantId, method: 'POST', body: { userId, weekStart } });
    revalidatePath(`${base(tenantId)}/timecards`);
    return { ok: 'Approved' };
  });
}

// Schedule -----------------------------------------------------------------------

export async function addShift(tenantId: string, timezones: Record<string, string>, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const locationId = str(form, 'locationId');
    const tz = timezones[locationId] ?? 'UTC';
    const date = str(form, 'date');
    const start = zonedToUtc(`${date}T${str(form, 'start')}`, tz);
    let end = zonedToUtc(`${date}T${str(form, 'end')}`, tz);
    // An end time earlier than the start means the shift runs past midnight.
    if (end <= start) end = new Date(end.getTime() + 86_400_000);
    await api('/schedule/shifts', {
      tenantId,
      method: 'POST',
      body: { locationId, userId: str(form, 'userId') || null, startsAt: start.toISOString(), endsAt: end.toISOString(), position: str(form, 'position') || null },
    });
    revalidatePath(`${base(tenantId)}/schedule`);
    return { ok: 'Shift added' };
  });
}

export async function deleteShift(tenantId: string, shiftId: string) {
  await api(`/schedule/shifts/${shiftId}`, { tenantId, method: 'DELETE' });
  revalidatePath(`${base(tenantId)}/schedule`);
}

export async function publishWeek(tenantId: string, from: string, to: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    const { published } = await api<{ published: number }>('/schedule/publish', { tenantId, method: 'POST', body: { from, to } });
    revalidatePath(`${base(tenantId)}/schedule`);
    return { ok: published ? `Published ${published} shifts` : 'Nothing new to publish' };
  });
}

// Tasks --------------------------------------------------------------------------

export async function toggleTask(tenantId: string, runId: string, itemId: string, done: boolean) {
  await api(`/tasks/runs/${runId}/items/${itemId}/${done ? 'undo' : 'complete'}`, { tenantId, method: 'POST', body: {} });
  revalidatePath(`${base(tenantId)}/tasks`);
}

export async function createChecklist(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async () => {
    const assignee = str(form, 'assignee');
    await api('/tasks/checklists', {
      tenantId,
      method: 'POST',
      body: {
        title: str(form, 'title'),
        locationId: str(form, 'locationId') || null,
        recurrence: str(form, 'recurrence'),
        weekdays: form.getAll('weekdays').map(Number),
        dueDate: str(form, 'dueDate') || null,
        assigneeRoleKey: assignee.startsWith('role:') ? assignee.slice(5) : null,
        assigneeUserId: assignee.startsWith('user:') ? assignee.slice(5) : null,
        items: str(form, 'items').split('\n').map((l) => l.trim()).filter(Boolean),
      },
    });
    revalidatePath(`${base(tenantId)}/tasks`, 'layout');
    return { ok: 'Checklist created' };
  });
}

export async function archiveChecklist(tenantId: string, id: string) {
  await api(`/tasks/checklists/${id}`, { tenantId, method: 'PATCH', body: { archived: true } });
  revalidatePath(`${base(tenantId)}/tasks`, 'layout');
}
