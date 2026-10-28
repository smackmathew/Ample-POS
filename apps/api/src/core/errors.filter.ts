import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

interface PgError {
  code?: string;
  constraint_name?: string;
}

function pgErrorOf(err: unknown): PgError | null {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if (typeof (e as PgError).code === 'string' && /^[0-9A-Z]{5}$/.test((e as PgError).code!)) return e as PgError;
  }
  return null;
}

/** Maps Postgres unique and exclusion violations to 409 so callers get a usable error. */
@Catch()
export class DatabaseErrorFilter extends BaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('DatabaseErrorFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    if (!(exception instanceof HttpException)) {
      const pg = pgErrorOf(exception);
      if (pg?.code === '23505') {
        return super.catch(new ConflictException(`Already exists (${pg.constraint_name ?? 'unique'})`), host);
      }
      // Exclusion constraints (e.g. one person can't have overlapping shifts).
      if (pg?.code === '23P01') {
        const message = pg.constraint_name?.startsWith('shifts_') ? 'That person is already scheduled at that time' : 'This overlaps with an existing entry';
        return super.catch(new ConflictException(message), host);
      }
      this.logger.error(exception);
    }
    return super.catch(exception, host);
  }
}
