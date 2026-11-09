-- Built-in accounts: email + password sign-in with server-side sessions.
--
-- None of these tables is readable by the application role. Everything goes
-- through the SECURITY DEFINER functions below, which run before a business is
-- selected (signing in is not tied to one business).
--
-- Session tokens are "<session id>.<secret>"; only a SHA-256 of the secret is
-- stored, so a database leak does not hand out live sessions. Reset tokens
-- work the same way.

create table credentials (
  user_id uuid primary key references users (id) on delete cascade,
  -- Normalized (lowercased, trimmed) sign-in email; unique across accounts.
  email text not null unique,
  -- "scrypt$N$r$p$<salt b64>$<hash b64>"
  password_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  password_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  secret_hash text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index auth_sessions_user on auth_sessions (user_id) where revoked_at is null;

create table password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  secret_hash text not null,
  -- Who asked: the account holder by email (null), or a manager in the hub.
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Signing up -----------------------------------------------------------------

-- Creates an account, or gives a password to a demo-mode user with the same
-- email who has none yet (so businesses made in demo mode carry over).
-- Returns null when the email already has a password.
create function app_register_account(p_email text, p_password_hash text, p_name text)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
  begin
    if exists (select 1 from credentials where email = p_email) then
      return null;
    end if;
    select id into v_user from users
     where auth_subject = 'dev|' || p_email
       and not exists (select 1 from credentials c where c.user_id = users.id);
    if v_user is null then
      v_user := gen_random_uuid();
      insert into users (id, auth_subject, email, display_name) values (v_user, 'local|' || v_user, p_email, p_name);
    else
      update users set auth_subject = 'local|' || v_user, display_name = coalesce(p_name, display_name) where id = v_user;
    end if;
    insert into credentials (user_id, email, password_hash) values (v_user, p_email, p_password_hash);
    return v_user;
  exception when unique_violation then
    return null;
  end
  $$;

-- Signing in -----------------------------------------------------------------

create function app_account_for_login(p_email text)
  returns table (user_id uuid, password_hash text, locked_until timestamptz)
  language sql stable security definer
  set search_path = public, pg_temp
  as $$ select user_id, password_hash, locked_until from credentials where email = p_email $$;

-- Counts a failed attempt; 10 in a row lock the account for 15 minutes.
create function app_login_failed(p_user uuid)
  returns void
  language sql security definer
  set search_path = public, pg_temp
  as $$
    update credentials
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 10 then now() + interval '15 minutes' else locked_until end
     where user_id = p_user
  $$;

create function app_start_session(p_user uuid, p_secret_hash text, p_user_agent text, p_days integer)
  returns uuid
  language sql security definer
  set search_path = public, pg_temp
  as $$
    with reset as (
      update credentials set failed_attempts = 0, locked_until = null where user_id = p_user
    ), touched as (
      update users set last_seen_at = now() where id = p_user
    )
    insert into auth_sessions (user_id, secret_hash, user_agent, expires_at)
    values (p_user, p_secret_hash, left(p_user_agent, 300), now() + make_interval(days => p_days))
    returning id
  $$;

-- The user behind a live session, or nothing. Marks the session used at most once a minute.
create function app_session_user(p_session uuid, p_secret_hash text)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
    v_last timestamptz;
  begin
    select user_id, last_used_at into v_user, v_last from auth_sessions
     where id = p_session and secret_hash = p_secret_hash and revoked_at is null and expires_at > now();
    if v_user is not null and v_last < now() - interval '1 minute' then
      update auth_sessions set last_used_at = now() where id = p_session;
    end if;
    return v_user;
  end
  $$;

-- Ends one session, or every session of its user (keeping p_keep, if given).
create function app_end_sessions(p_session uuid, p_everywhere boolean, p_keep uuid)
  returns void
  language sql security definer
  set search_path = public, pg_temp
  as $$
    update auth_sessions s set revoked_at = now()
     where s.revoked_at is null
       and (s.id = p_session
            or (p_everywhere and s.user_id = (select user_id from auth_sessions where id = p_session)))
       and s.id is distinct from p_keep
  $$;

-- Passwords --------------------------------------------------------------------

create function app_password_hash(p_user uuid)
  returns text
  language sql stable security definer
  set search_path = public, pg_temp
  as $$ select password_hash from credentials where user_id = p_user $$;

-- Sets a new password and signs the account out everywhere except p_keep.
create function app_set_password(p_user uuid, p_password_hash text, p_keep uuid)
  returns void
  language sql security definer
  set search_path = public, pg_temp
  as $$
    with changed as (
      update credentials
         set password_hash = p_password_hash, password_changed_at = now(), failed_attempts = 0, locked_until = null
       where user_id = p_user
    )
    update auth_sessions set revoked_at = now()
     where user_id = p_user and revoked_at is null and id is distinct from p_keep
  $$;

-- A reset requested by email. Returns the user id, or null for an unknown email
-- (the caller answers the same either way).
create function app_create_password_reset(p_email text, p_secret_hash text)
  returns table (reset_id uuid, user_id uuid)
  language sql security definer
  set search_path = public, pg_temp
  as $$
    insert into password_resets (user_id, secret_hash, expires_at)
    select user_id, p_secret_hash, now() + interval '1 hour' from credentials where email = p_email
    returning id, user_id
  $$;

-- A reset link made in the hub by someone with members.manage in the current
-- business, for a member who belongs to no other business (so one business
-- cannot take over an account used elsewhere). Raises with a reason otherwise.
create function app_create_member_reset(p_member uuid, p_secret_hash text)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_tenant uuid := app_current_tenant();
    v_actor uuid := app_current_user();
    v_id uuid;
  begin
    if v_tenant is null or v_actor is null then
      raise exception 'business and user must be set' using errcode = '28000';
    end if;
    if p_member = v_actor then
      raise exception 'Use Change password for your own account' using errcode = '22023';
    end if;
    if not exists (select 1 from memberships where user_id = p_member and tenant_id = v_tenant and status = 'active') then
      raise exception 'Not a member of this business' using errcode = '22023';
    end if;
    if exists (select 1 from memberships where user_id = p_member and tenant_id <> v_tenant and status = 'active') then
      raise exception 'This person also belongs to another business, so only they can reset their password (Forgot password)' using errcode = '22023';
    end if;
    if not exists (select 1 from credentials where user_id = p_member) then
      raise exception 'This person has not set up a password yet' using errcode = '22023';
    end if;
    insert into password_resets (user_id, secret_hash, created_by, expires_at)
    values (p_member, p_secret_hash, v_actor, now() + interval '24 hours')
    returning id into v_id;
    return v_id;
  end
  $$;

-- Spends a reset token: sets the password, ends every session. Returns the user, or null.
create function app_use_password_reset(p_reset uuid, p_secret_hash text, p_password_hash text)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
  begin
    update password_resets set used_at = now()
     where id = p_reset and secret_hash = p_secret_hash and used_at is null and expires_at > now()
    returning user_id into v_user;
    if v_user is null then
      return null;
    end if;
    perform app_set_password(v_user, p_password_hash, null);
    -- Other outstanding links for this account stop working too.
    update password_resets set used_at = now() where user_id = v_user and used_at is null;
    return v_user;
  end
  $$;

revoke all on credentials, auth_sessions, password_resets from pos_app;
revoke execute on function
  app_register_account(text, text, text), app_account_for_login(text), app_login_failed(uuid),
  app_start_session(uuid, text, text, integer), app_session_user(uuid, text), app_end_sessions(uuid, boolean, uuid),
  app_password_hash(uuid), app_set_password(uuid, text, uuid), app_create_password_reset(text, text),
  app_create_member_reset(uuid, text), app_use_password_reset(uuid, text, text)
  from public;
grant execute on function
  app_register_account(text, text, text), app_account_for_login(text), app_login_failed(uuid),
  app_start_session(uuid, text, text, integer), app_session_user(uuid, text), app_end_sessions(uuid, boolean, uuid),
  app_password_hash(uuid), app_set_password(uuid, text, uuid), app_create_password_reset(text, text),
  app_create_member_reset(uuid, text), app_use_password_reset(uuid, text, text)
  to pos_app;
