-- Foundation: businesses (tenants), identity, roles, locations, devices,
-- module entitlements, audit log and transactional outbox.
--
-- Tenant isolation is enforced by row-level security. The API connects as the
-- restricted role `pos_app` and sets `app.tenant_id` / `app.user_id` with
-- set_config(..., true) at the start of every request transaction.

create function app_current_tenant() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create function app_current_user() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  auth_subject text not null unique,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  key text not null,
  name text not null,
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id)
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  user_id uuid not null references users (id),
  role_id uuid not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  -- A membership can only point at a role of the same business.
  foreign key (tenant_id, role_id) references roles (tenant_id, id)
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  kind text not null default 'store' check (kind in ('store', 'warehouse', 'office')),
  timezone text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, name),
  unique (tenant_id, id)
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid not null,
  name text not null,
  kind text not null check (kind in ('register', 'handheld', 'kiosk')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  secret_hash text not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);

create table tenant_modules (
  tenant_id uuid not null references tenants (id) on delete cascade,
  module_id text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id),
  primary key (tenant_id, module_id)
);

create table audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  actor_user_id uuid references users (id),
  actor_device_id uuid references devices (id),
  action text not null,
  target_type text,
  target_id text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_tenant_created on audit_log (tenant_id, id desc);

create table outbox (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  topic text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index outbox_unpublished on outbox (available_at) where published_at is null;

-- Row-level security -------------------------------------------------------

alter table tenants enable row level security;
create policy tenant_self on tenants
  using (id = app_current_tenant());

alter table users enable row level security;
-- A user sees themselves and the members of the current business.
create policy users_visible on users for select
  using (
    id = app_current_user()
    or exists (
      select 1 from memberships m
      where m.user_id = users.id and m.tenant_id = app_current_tenant()
    )
  );

do $$
declare t text;
begin
  foreach t in array array['roles', 'memberships', 'locations', 'devices', 'tenant_modules', 'audit_log', 'outbox']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())',
      t
    );
  end loop;
end $$;

-- Cross-tenant entry points ------------------------------------------------
-- These run as the table owner so they can work before a business is selected.
-- Each one only acts on behalf of app_current_user().

create function app_upsert_user(p_subject text, p_email text, p_display_name text)
  returns uuid
  language sql security definer
  set search_path = public, pg_temp
  as $$
    insert into users (auth_subject, email, display_name)
    values (p_subject, p_email, p_display_name)
    on conflict (auth_subject) do update
      set email = coalesce(excluded.email, users.email),
          display_name = coalesce(excluded.display_name, users.display_name),
          last_seen_at = now()
    returning id
  $$;

create function app_my_tenants()
  returns table (tenant_id uuid, name text, slug text, role_key text, role_name text)
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select t.id, t.name, t.slug, r.key, r.name
    from memberships m
    join tenants t on t.id = m.tenant_id
    join roles r on r.id = m.role_id
    where m.user_id = app_current_user() and m.status = 'active'
    order by t.name
  $$;

-- p_roles: [{ "key": "owner", "name": "Owner", "permissions": ["*"] }, ...]
-- The current user becomes a member with the "owner" role.
create function app_create_tenant(p_name text, p_slug text, p_roles jsonb)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_user uuid := app_current_user();
    v_tenant uuid;
    v_owner_role uuid;
  begin
    if v_user is null then
      raise exception 'app.user_id is not set' using errcode = '28000';
    end if;

    insert into tenants (name, slug) values (p_name, p_slug) returning id into v_tenant;

    insert into roles (tenant_id, key, name, permissions, is_system)
    select v_tenant, r->>'key', r->>'name',
           array(select jsonb_array_elements_text(r->'permissions')), true
    from jsonb_array_elements(p_roles) r;

    select id into v_owner_role from roles where tenant_id = v_tenant and key = 'owner';
    if v_owner_role is null then
      raise exception 'p_roles must include an owner role' using errcode = '22023';
    end if;

    insert into memberships (tenant_id, user_id, role_id) values (v_tenant, v_user, v_owner_role);
    insert into audit_log (tenant_id, actor_user_id, action, target_type, target_id, data)
    values (v_tenant, v_user, 'tenant.created', 'tenant', v_tenant::text,
            jsonb_build_object('name', p_name, 'slug', p_slug));
    return v_tenant;
  end
  $$;

-- Grants for the application role ------------------------------------------

grant usage on schema public to pos_app;
grant select, update on tenants to pos_app;
grant select on users to pos_app;
grant select, insert, update, delete on roles, memberships, locations, devices, tenant_modules to pos_app;
-- The audit log is append-only for the application.
grant select, insert on audit_log to pos_app;
grant select, insert, update on outbox to pos_app;

revoke execute on function app_upsert_user(text, text, text), app_my_tenants(), app_create_tenant(text, text, jsonb) from public;
grant execute on function app_upsert_user(text, text, text), app_my_tenants(), app_create_tenant(text, text, jsonb) to pos_app;
