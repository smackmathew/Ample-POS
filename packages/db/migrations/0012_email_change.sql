-- Changing a built-in account's email.
--
-- With email available, the change waits until a link sent to the NEW address
-- is opened (proving it), then the old address is told. Without email it
-- happens at once, unconfirmed. The API asks for the current password first.

create table email_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  new_email text not null,
  secret_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

revoke all on email_changes from pos_app;

-- Starts a confirmed change; an earlier pending change for the account stops working.
-- Raises 23505 when another account already uses the address.
create function app_request_email_change(p_user uuid, p_new_email text, p_secret_hash text)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_id uuid;
  begin
    if exists (select 1 from credentials where email = p_new_email) then
      raise exception 'email already in use' using errcode = '23505';
    end if;
    update email_changes set used_at = now() where user_id = p_user and used_at is null;
    insert into email_changes (user_id, new_email, secret_hash, expires_at)
    values (p_user, p_new_email, p_secret_hash, now() + interval '24 hours')
    returning id into v_id;
    return v_id;
  end
  $$;

-- Applies a change: the account's sign-in email and profile email both move.
-- p_verified says whether the new address has been proven.
create function app_apply_email_change(p_user uuid, p_new_email text, p_verified boolean)
  returns text
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_old text;
  begin
    select email into v_old from credentials where user_id = p_user for update;
    if v_old is null then
      raise exception 'not a password account' using errcode = '22023';
    end if;
    update credentials
       set email = p_new_email,
           email_verified_at = case when p_verified then now() else null end
     where user_id = p_user;
    update users set email = p_new_email where id = p_user;
    -- Links sent to the old address must not verify or reset the account any more.
    update email_verifications set used_at = now() where user_id = p_user and used_at is null;
    update password_resets set used_at = now() where user_id = p_user and used_at is null and created_by is null;
    return v_old;
  end
  $$;

-- Spends a confirmation link. Returns the account and both addresses, or nothing.
-- Raises 23505 if another account took the address in the meantime.
create function app_confirm_email_change(p_id uuid, p_secret_hash text)
  returns table (user_id uuid, old_email text, new_email text)
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
    v_new text;
  begin
    update email_changes set used_at = now()
     where id = p_id and secret_hash = p_secret_hash and used_at is null and expires_at > now()
    returning email_changes.user_id, email_changes.new_email into v_user, v_new;
    if v_user is null then
      return;
    end if;
    return query select v_user, app_apply_email_change(v_user, v_new, true), v_new;
  end
  $$;

revoke execute on function
  app_request_email_change(uuid, text, text), app_apply_email_change(uuid, text, boolean), app_confirm_email_change(uuid, text)
  from public;
grant execute on function
  app_request_email_change(uuid, text, text), app_apply_email_change(uuid, text, boolean), app_confirm_email_change(uuid, text)
  to pos_app;
