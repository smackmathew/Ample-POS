-- Pairing the Migration Assistant (a Windows app on the store's QuickBooks POS
-- PC) with a business. Someone with data.manage makes a short code; the
-- Assistant trades it, once and within 15 minutes, for an API key that can
-- only import (data.manage), created as if by that person.

create table assistant_pairings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  created_by uuid not null references users (id),
  -- SHA-256 of the code; the code itself is shown once.
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  api_key_id uuid references api_keys (id) on delete set null,
  computer text,
  created_at timestamptz not null default now()
);
create index assistant_pairings_tenant on assistant_pairings (tenant_id, created_at desc);
alter table assistant_pairings enable row level security;
create policy tenant_isolation on assistant_pairings using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert on assistant_pairings to pos_app;

-- Spends a code: issues the API key and returns the business. Runs before any
-- business is selected (the Assistant has no session), so it is a definer
-- function; it only ever acts on the one unexpired, unused code given.
create function app_redeem_assistant_pairing(p_code_hash text, p_key_id uuid, p_hint text, p_secret_hash text, p_computer text)
  returns table (tenant_id uuid, tenant_name text)
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_id uuid;
    v_tenant uuid;
    v_user uuid;
    v_computer text := left(nullif(trim(p_computer), ''), 60);
    v_name text := 'Migration Assistant' || coalesce(' (' || left(nullif(trim(p_computer), ''), 60) || ')', '');
  begin
    select p.id, p.tenant_id, p.created_by into v_id, v_tenant, v_user
      from assistant_pairings p
     where p.code_hash = p_code_hash and p.used_at is null and p.expires_at > now()
       for update;
    if v_id is null then
      return;
    end if;
    insert into api_keys (id, tenant_id, name, hint, secret_hash, permissions, read_only, created_by)
    values (p_key_id, v_tenant, v_name, p_hint, p_secret_hash, array['data.manage'], false, v_user);
    update assistant_pairings set used_at = now(), api_key_id = p_key_id, computer = v_computer where id = v_id;
    insert into audit_log (tenant_id, actor_user_id, action, target_type, target_id, data)
    values (v_tenant, v_user, 'api_key.created', 'api_key', p_key_id::text,
            jsonb_build_object('name', v_name, 'permissions', array['data.manage'], 'via', 'migration_assistant_pairing'));
    return query select t.id, t.name from tenants t where t.id = v_tenant;
  end
  $$;
revoke execute on function app_redeem_assistant_pairing(text, uuid, text, text, text) from public;
grant execute on function app_redeem_assistant_pairing(text, uuid, text, text, text) to pos_app;
