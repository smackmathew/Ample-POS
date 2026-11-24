-- The super admin dashboard (Ample POS staff, not business owners).
--
-- It connects as pos_platform, a second login role that, like pos_app, never
-- bypasses row-level security. The policies below let it read every
-- business's rows, but it can change only platform controls: which tools a
-- business has (and whether they are free or blocked), suspending a business,
-- and the tool catalog. It has no access to passwords, sessions or two-step
-- secrets. Who may use it is decided in the API (PLATFORM_ADMIN_EMAILS).

-- Platform-wide tool settings: switch a tool off for everyone, or change its price.
create table platform_modules (
  module_id text primary key,
  available boolean not null default true,
  -- Overrides the built-in monthly price (per location); null keeps it.
  monthly_price_minor bigint check (monthly_price_minor between 0 and 10000000),
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);

-- A suspended business can't be used until it is restored.
alter table tenants add column suspended_at timestamptz;
alter table tenants add column suspended_reason text;

-- Per business: comped tools are on but not billed; blocked tools can't be turned on by the business.
alter table tenant_modules add column comped boolean not null default false;
alter table tenant_modules add column blocked boolean not null default false;

-- What platform admins did.
create table platform_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid references users (id),
  action text not null,
  tenant_id uuid references tenants (id) on delete set null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index platform_audit_created on platform_audit (created_at desc);

grant select on platform_modules to pos_app;
grant select, insert, update on platform_modules to pos_platform;
grant select, insert on platform_audit to pos_platform;

-- Read access to every business's rows.
do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  loop
    execute format('grant select on %I to pos_platform', t);
    execute format('create policy platform_read on %I for select to pos_platform using (true)', t);
  end loop;
end
$$;

-- The few writes it makes. Changes it makes to a business are also written to
-- that business's own audit log and outbox (so billing follows tool changes).
grant insert, update on tenant_modules to pos_platform;
create policy platform_insert on tenant_modules for insert to pos_platform with check (true);
create policy platform_update on tenant_modules for update to pos_platform using (true) with check (true);
grant update (suspended_at, suspended_reason) on tenants to pos_platform;
create policy platform_update on tenants for update to pos_platform using (true) with check (true);
grant insert on audit_log, outbox to pos_platform;
create policy platform_insert on audit_log for insert to pos_platform with check (true);
create policy platform_insert on outbox for insert to pos_platform with check (true);
