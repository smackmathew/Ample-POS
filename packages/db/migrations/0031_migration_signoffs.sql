-- The owner's sign-off on a migration: they checked the reconciliation report
-- (what the files from the old system said against what Ample POS has) and
-- accept it. The report as it stood is kept with the sign-off.
create table migration_signoffs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  signed_by uuid not null references users (id),
  signed_at timestamptz not null default now(),
  note text,
  report jsonb not null
);
create index migration_signoffs_tenant on migration_signoffs (tenant_id, signed_at desc);
alter table migration_signoffs enable row level security;
create policy tenant_isolation on migration_signoffs using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert on migration_signoffs to pos_app;
