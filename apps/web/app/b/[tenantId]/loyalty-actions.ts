'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError, attempt, type ActionState } from '@/lib/api';
import { parseMoney } from '@/lib/money';
import type { Sale } from '@/lib/types';
import type { Result } from './sales-actions';

async function call<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function redeemReward(tenantId: string, saleId: string, rewards: number): Promise<Result<Sale>> {
  return call(() => api<Sale>(`/sales/${saleId}/reward`, { tenantId, method: 'POST', body: { rewards } }));
}

export async function removeReward(tenantId: string, saleId: string): Promise<Result<Sale>> {
  return call(() => api<Sale>(`/sales/${saleId}/reward`, { tenantId, method: 'DELETE' }));
}

const whole = (v: FormDataEntryValue | null) => (/^\s*-?\d+\s*$/.test(String(v ?? '')) ? Number(String(v).trim()) : NaN);

export async function saveProgram(tenantId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const pointsPerDollar = whole(form.get('pointsPerDollar'));
  const rewardPoints = whole(form.get('rewardPoints'));
  const rewardValueMinor = parseMoney(String(form.get('rewardValue') ?? ''));
  if (!Number.isInteger(pointsPerDollar) || !Number.isInteger(rewardPoints)) return { error: 'Points must be whole numbers' };
  if (!rewardValueMinor) return { error: 'Enter what a reward is worth, like 5.00' };
  return attempt(async () => {
    await api('/loyalty/program', { tenantId, method: 'PUT', body: { pointsPerDollar, rewardPoints, rewardValueMinor } });
    revalidatePath(`/b/${tenantId}/loyalty`);
    return { ok: 'Saved. Sales from now on use these rates.' };
  });
}

export async function adjustPoints(tenantId: string, customerId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const points = whole(form.get('points'));
  if (!Number.isInteger(points) || points === 0) return { error: 'Enter points to add, or a negative number to take away' };
  return attempt(async () => {
    await api(`/loyalty/customers/${customerId}/adjust`, { tenantId, method: 'POST', body: { points, note: String(form.get('note') ?? '') } });
    revalidatePath(`/b/${tenantId}/customers/${customerId}`);
    return { ok: points > 0 ? `Added ${points} points` : `Took away ${-points} points` };
  });
}
