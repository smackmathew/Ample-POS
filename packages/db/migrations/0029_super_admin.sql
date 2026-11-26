-- More super admin powers: support view, managing people, editing businesses.

-- Support view ------------------------------------------------------------------
-- A platform admin opens a business read-only, as if they were its owner. Each
-- visit is a time-limited session, written to the business's audit log.
create table platform_support_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  admin_user_id uuid not null references users (id) on delete cascade,
  reason text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);
create index platform_support_sessions_live on platform_support_sessions (tenant_id, admin_user_id) where ended_at is null;

alter table platform_support_sessions enable row level security;
-- The app only sees the signed-in admin's own sessions for the selected business.
create policy support_self on platform_support_sessions for select to pos_app
  using (tenant_id = app_current_tenant() and admin_user_id = app_current_user());
grant select on platform_support_sessions to pos_app;
create policy platform_all on platform_support_sessions to pos_platform using (true) with check (true);
grant select, insert, update (ended_at) on platform_support_sessions to pos_platform;

-- Turning people off -----------------------------------------------------------------
alter table users add column disabled_at timestamptz, add column disabled_reason text;

-- Whether an account is turned off; checked when signing in and on every request.
create function app_user_disabled(p_user uuid)
  returns boolean
  language sql stable security definer
  set search_path = public, pg_temp
  as $$ select coalesce((select disabled_at is not null from users where id = p_user), false) $$;
revoke execute on function app_user_disabled(uuid) from public;
grant execute on function app_user_disabled(uuid) to pos_app, pos_platform;

-- Sessions of a turned-off account stop working at once.
create or replace function app_session_user(p_session uuid, p_secret_hash text)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
    v_last timestamptz;
  begin
    select s.user_id, s.last_used_at into v_user, v_last from auth_sessions s join users u on u.id = s.user_id
     where s.id = p_session and s.secret_hash = p_secret_hash and s.revoked_at is null and s.expires_at > now()
       and u.disabled_at is null;
    if v_user is not null and v_last < now() - interval '1 minute' then
      update auth_sessions set last_used_at = now() where id = p_session;
    end if;
    return v_user;
  end
  $$;

-- Turns an account off (with a reason) or back on (null reason). Turning off ends its sessions.
create function app_admin_set_disabled(p_user uuid, p_reason text)
  returns void
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  begin
    update users set disabled_at = case when p_reason is null then null else now() end, disabled_reason = p_reason where id = p_user;
    if p_reason is not null then
      update auth_sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
    end if;
  end
  $$;

-- How a set of accounts sign in, for the super admin's people pages.
create function app_admin_user_auth(p_users uuid[])
  returns table (user_id uuid, has_password boolean, email_verified boolean, two_factor boolean, locked_until timestamptz, live_sessions integer)
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select u.id,
           c.user_id is not null,
           c.email_verified_at is not null,
           exists (select 1 from two_factor t where t.user_id = u.id and t.confirmed_at is not null),
           c.locked_until,
           (select count(*)::int from auth_sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now())
      from unnest(p_users) as x(id) join users u on u.id = x.id
      left join credentials c on c.user_id = u.id
  $$;

-- A reset link made by Ample POS staff, valid 24 hours. Returns null if the account has no password yet.
create function app_admin_password_reset(p_user uuid, p_secret_hash text, p_actor uuid)
  returns uuid
  language sql security definer
  set search_path = public, pg_temp
  as $$
    insert into password_resets (user_id, secret_hash, created_by, expires_at)
    select user_id, p_secret_hash, p_actor, now() + interval '24 hours' from credentials where user_id = p_user
    returning id
  $$;

-- Confirms an account's email by hand. Returns false if it was already confirmed.
create function app_admin_confirm_user(p_user uuid)
  returns boolean
  language sql security definer
  set search_path = public, pg_temp
  as $$
    with c as (select email_verified_at is null as changed from credentials where user_id = p_user),
    upd as (update credentials set email_verified_at = coalesce(email_verified_at, now()) where user_id = p_user)
    select coalesce((select changed from c), false)
  $$;

-- Ends every session of an account (after resetting its password or two-step sign-in).
create function app_admin_end_sessions(p_user uuid)
  returns void
  language sql security definer
  set search_path = public, pg_temp
  as $$ update auth_sessions set revoked_at = now() where user_id = p_user and revoked_at is null $$;

revoke execute on function
  app_admin_set_disabled(uuid, text), app_admin_user_auth(uuid[]), app_admin_password_reset(uuid, text, uuid),
  app_admin_confirm_user(uuid), app_admin_end_sessions(uuid)
  from public;
grant execute on function
  app_admin_set_disabled(uuid, text), app_admin_user_auth(uuid[]), app_admin_password_reset(uuid, text, uuid),
  app_admin_confirm_user(uuid), app_admin_end_sessions(uuid), app_two_factor_disable(uuid)
  to pos_platform;

-- Editing businesses ----------------------------------------------------------------
grant update (name) on tenants to pos_platform;
grant update (trial_ends_at) on tenant_billing to pos_platform;
grant update (role_id) on memberships to pos_platform;
create policy platform_update on memberships for update to pos_platform using (true) with check (true);
