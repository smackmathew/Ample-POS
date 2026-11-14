-- Two-step sign-in (authenticator app codes) for built-in accounts.
--
-- Like the other account tables, none of these is readable by the application
-- role; it works through the functions below. Signing in to an account with
-- two-step on goes: password -> short-lived challenge -> code -> session.

create table two_factor (
  user_id uuid primary key references users (id) on delete cascade,
  -- Base32 TOTP secret. Set while enrolling; confirmed_at marks it in use.
  secret text not null,
  confirmed_at timestamptz,
  -- The last 30-second step accepted, so a code can't be used twice.
  last_step bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  code_hash text not null,
  used_at timestamptz
);
create index recovery_codes_user on recovery_codes (user_id) where used_at is null;

-- Proof that the password step passed; spent by the code step.
create table login_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  secret_hash text not null,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

revoke all on two_factor, recovery_codes, login_challenges from pos_app;

-- Reading -----------------------------------------------------------------------

-- enabled: confirmed and in use. pending_secret: an enrolment waiting for its first code.
create function app_two_factor(p_user uuid)
  returns table (enabled boolean, secret text, last_step bigint, recovery_left integer)
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select t.confirmed_at is not null, t.secret, t.last_step,
           (select count(*)::integer from recovery_codes r where r.user_id = p_user and r.used_at is null)
      from two_factor t where t.user_id = p_user
  $$;

-- Enrolling ---------------------------------------------------------------------

-- Starts (or restarts) enrolment with a new secret. Refused once two-step is on.
create function app_two_factor_begin(p_user uuid, p_secret text)
  returns boolean
  language sql security definer
  set search_path = public, pg_temp
  as $$
    insert into two_factor (user_id, secret) values (p_user, p_secret)
    on conflict (user_id) do update set secret = excluded.secret, last_step = 0, updated_at = now()
      where two_factor.confirmed_at is null
    returning true
  $$;

-- Turns two-step on after a first good code, with fresh recovery codes.
create function app_two_factor_confirm(p_user uuid, p_step bigint, p_recovery_hashes text[])
  returns boolean
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  begin
    update two_factor set confirmed_at = now(), last_step = p_step, updated_at = now()
     where user_id = p_user and confirmed_at is null;
    if not found then
      return false;
    end if;
    perform app_two_factor_set_recovery(p_user, p_recovery_hashes);
    return true;
  end
  $$;

-- Using -------------------------------------------------------------------------

-- Accepts a matched step only if it is newer than the last one used.
create function app_two_factor_use_step(p_user uuid, p_step bigint)
  returns boolean
  language sql security definer
  set search_path = public, pg_temp
  as $$
    update two_factor set last_step = p_step, updated_at = now()
     where user_id = p_user and confirmed_at is not null and last_step < p_step
    returning true
  $$;

create function app_two_factor_use_recovery(p_user uuid, p_code_hash text)
  returns boolean
  language sql security definer
  set search_path = public, pg_temp
  as $$
    update recovery_codes set used_at = now()
     where id = (select id from recovery_codes where user_id = p_user and code_hash = p_code_hash and used_at is null limit 1)
    returning true
  $$;

create function app_two_factor_set_recovery(p_user uuid, p_recovery_hashes text[])
  returns void
  language sql security definer
  set search_path = public, pg_temp
  as $$
    with cleared as (
      delete from recovery_codes where user_id = p_user
    )
    insert into recovery_codes (user_id, code_hash) select p_user, unnest(p_recovery_hashes)
  $$;

create function app_two_factor_disable(p_user uuid)
  returns void
  language sql security definer
  set search_path = public, pg_temp
  as $$
    with codes as (
      delete from recovery_codes where user_id = p_user
    )
    delete from two_factor where user_id = p_user
  $$;

-- Login challenges --------------------------------------------------------------

create function app_create_login_challenge(p_user uuid, p_secret_hash text)
  returns uuid
  language sql security definer
  set search_path = public, pg_temp
  as $$
    insert into login_challenges (user_id, secret_hash, expires_at)
    values (p_user, p_secret_hash, now() + interval '10 minutes')
    returning id
  $$;

-- The account a live challenge belongs to, counting the attempt; null once it
-- is expired, used, or has had 5 attempts.
create function app_login_challenge_user(p_id uuid, p_secret_hash text)
  returns uuid
  language sql security definer
  set search_path = public, pg_temp
  as $$
    update login_challenges set attempts = attempts + 1
     where id = p_id and secret_hash = p_secret_hash and used_at is null and expires_at > now() and attempts < 5
    returning user_id
  $$;

create function app_finish_login_challenge(p_id uuid)
  returns void
  language sql security definer
  set search_path = public, pg_temp
  as $$ update login_challenges set used_at = now() where id = p_id $$;

revoke execute on function
  app_two_factor(uuid), app_two_factor_begin(uuid, text), app_two_factor_confirm(uuid, bigint, text[]),
  app_two_factor_use_step(uuid, bigint), app_two_factor_use_recovery(uuid, text), app_two_factor_set_recovery(uuid, text[]),
  app_two_factor_disable(uuid), app_create_login_challenge(uuid, text), app_login_challenge_user(uuid, text),
  app_finish_login_challenge(uuid)
  from public;
grant execute on function
  app_two_factor(uuid), app_two_factor_begin(uuid, text), app_two_factor_confirm(uuid, bigint, text[]),
  app_two_factor_use_step(uuid, bigint), app_two_factor_use_recovery(uuid, text), app_two_factor_set_recovery(uuid, text[]),
  app_two_factor_disable(uuid), app_create_login_challenge(uuid, text), app_login_challenge_user(uuid, text),
  app_finish_login_challenge(uuid)
  to pos_app;
