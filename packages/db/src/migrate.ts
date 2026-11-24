import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
export const APP_ROLE = 'pos_app';
/** The super admin dashboard's role: reads every business, changes only platform controls. */
export const PLATFORM_ROLE = 'pos_platform';

/**
 * Creates the restricted application role if needed and applies pending
 * migrations in filename order, each in its own transaction.
 * Must run with a connection that can create roles and own tables.
 */
export async function setupDatabase(adminUrl: string, appPassword: string): Promise<string[]> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await ensureAppRole(sql, appPassword);
    await ensureRole(sql, PLATFORM_ROLE, appPassword);
    return await runMigrations(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function ensureAppRole(sql: postgres.Sql, password: string): Promise<void> {
  await ensureRole(sql, APP_ROLE, password);
}

/** A login role that never bypasses row-level security; what it may see is set by policies and grants. */
async function ensureRole(sql: postgres.Sql, role: string, password: string): Promise<void> {
  const [existing] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = ${role}`;
  // Role names and passwords cannot be bound parameters in DDL.
  const literal = `'${password.replace(/'/g, "''")}'`;
  if (!existing) {
    await sql.unsafe(`create role ${role} login nosuperuser nobypassrls password ${literal}`);
    return;
  }
  // Tenant isolation depends on RLS applying to this role. (Managed hosts' admin
  // users may not re-state these attributes, so check instead of altering them.)
  if (existing.rolsuper || existing.rolbypassrls) {
    throw new Error(`The ${role} role must not be a superuser or bypass row-level security`);
  }
  await sql.unsafe(`alter role ${role} login password ${literal}`);
}

async function runMigrations(sql: postgres.Sql): Promise<string[]> {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
  const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    ran.push(file);
  }
  return ran;
}
