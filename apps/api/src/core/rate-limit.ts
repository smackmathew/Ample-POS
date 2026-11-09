import { HttpException, Injectable } from '@nestjs/common';

/**
 * Fixed-window counters kept in memory. Fine for one API process; with several
 * the per-account lockout in the database still holds.
 */
@Injectable()
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  /** Throws 429 when `key` has already used `limit` hits in the window. Doesn't count the call. */
  check(key: string, limit: number, message = 'Too many attempts. Try again in a few minutes.'): void {
    const w = this.windows.get(key);
    if (w && w.resetAt > Date.now() && w.count >= limit) {
      const minutes = Math.ceil((w.resetAt - Date.now()) / 60_000);
      throw new HttpException({ statusCode: 429, code: 'too_many_attempts', message: message.replace('a few minutes', `${minutes} minute${minutes === 1 ? '' : 's'}`) }, 429);
    }
  }

  hit(key: string, windowMs: number): void {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now) this.windows.set(key, { count: 1, resetAt: now + windowMs });
    else w.count++;
    if (this.windows.size > 50_000) this.sweep(now);
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }
}
