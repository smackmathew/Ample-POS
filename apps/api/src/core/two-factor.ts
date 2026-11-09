import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { newToken, sha256 } from './auth.service';
import { Db } from './database';
import { matchTotp, newRecoveryCodes, normalizeRecoveryCode } from './totp';

export interface TwoFactorState {
  enabled: boolean;
  secret: string | null;
  lastStep: number;
  recoveryLeft: number;
}

/** Authenticator-app codes for built-in accounts. */
@Injectable()
export class TwoFactor {
  constructor(private readonly db: Db) {}

  async state(userId: string): Promise<TwoFactorState> {
    const [row] = await this.db.pool.execute<{ enabled: boolean; secret: string; last_step: string; recovery_left: number }>(
      sql`select * from app_two_factor(${userId}::uuid)`,
    );
    return row
      ? { enabled: row.enabled, secret: row.secret, lastStep: Number(row.last_step), recoveryLeft: row.recovery_left }
      : { enabled: false, secret: null, lastStep: 0, recoveryLeft: 0 };
  }

  /**
   * Checks an authenticator code (or, when allowed, a recovery code) and spends
   * it, so the same code can't be used twice.
   */
  async check(userId: string, code: string, allowRecovery = true): Promise<boolean> {
    const state = await this.state(userId);
    if (!state.enabled || !state.secret) return false;
    const step = matchTotp(state.secret, code);
    if (step !== null) {
      const [row] = await this.db.pool.execute<{ ok: boolean | null }>(sql`select app_two_factor_use_step(${userId}::uuid, ${step}) as ok`);
      return Boolean(row?.ok);
    }
    if (!allowRecovery) return false;
    const normalized = normalizeRecoveryCode(code);
    if (normalized.length !== 12) return false;
    const [row] = await this.db.pool.execute<{ ok: boolean | null }>(
      sql`select app_two_factor_use_recovery(${userId}::uuid, ${sha256(normalized)}) as ok`,
    );
    return Boolean(row?.ok);
  }

  /** Fresh recovery codes: returns the codes to show once; only hashes are kept. */
  freshRecoveryCodes(): { codes: string[]; hashes: string[] } {
    const codes = newRecoveryCodes();
    return { codes, hashes: codes.map((c) => sha256(normalizeRecoveryCode(c))) };
  }

  /** A short-lived "password was right" token for the code step. */
  async challenge(userId: string): Promise<string> {
    const { secret, secretHash } = newToken();
    const [row] = await this.db.pool.execute<{ id: string }>(sql`select app_create_login_challenge(${userId}::uuid, ${secretHash}) as id`);
    return `${row!.id}.${secret}`;
  }
}
