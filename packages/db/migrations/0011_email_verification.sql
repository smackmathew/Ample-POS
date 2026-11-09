-- Email verification for built-in accounts.
--
-- An account proves it owns its email by opening a link sent there, or by
-- resetting its password through an emailed link. While the API can send
-- email, an unverified account cannot create a business or accept an
-- invitation that was locked to an email address.

alter table credentials add column email_verified_at timestamptz;

create table email_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  -- The address the link was sent to; it only verifies that address.
  email text not null,
  secret_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

revoke all on email_verifications from pos_app;

-- Starts a verification for an account that has a password and isn't verified.
-- Returns the link id and address, or nothing when there is nothing to verify.
create function app_create_email_verification(p_user uuid, p_secret_hash text)
  returns table (verification_id uuid, email text)
  language sql security definer
  set search_path = public, pg_temp
  as $$
    insert into email_verifications (user_id, email, secret_hash, expires_at)
    select user_id, email, p_secret_hash, now() + interval '24 hours'
      from credentials where user_id = p_user and email_verified_at is null
    returning id, email
  $$;

-- Spends a verification link. Returns the verified address, or null.
create function app_verify_email(p_id uuid, p_secret_hash text)
  returns text
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
    v_email text;
  begin
    update email_verifications set used_at = now()
     where id = p_id and secret_hash = p_secret_hash and used_at is null and expires_at > now()
    returning user_id, email into v_user, v_email;
    if v_user is null then
      return null;
    end if;
    update credentials set email_verified_at = coalesce(email_verified_at, now())
     where user_id = v_user and email = v_email;
    return v_email;
  end
  $$;

-- has_password: a built-in account. email_verified: true for accounts that
-- don't use built-in passwords (their identity provider vouches for the email).
create function app_account_status(p_user uuid)
  returns table (has_password boolean, email_verified boolean)
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select c.user_id is not null, c.user_id is null or c.email_verified_at is not null
      from (select p_user as id) u
      left join credentials c on c.user_id = u.id
  $$;

-- An emailed reset link proves the account owns its email, so it also verifies it.
-- (Links a manager makes on the Team page don't.)
create or replace function app_use_password_reset(p_reset uuid, p_secret_hash text, p_password_hash text)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_user uuid;
    v_by uuid;
  begin
    update password_resets set used_at = now()
     where id = p_reset and secret_hash = p_secret_hash and used_at is null and expires_at > now()
    returning user_id, created_by into v_user, v_by;
    if v_user is null then
      return null;
    end if;
    perform app_set_password(v_user, p_password_hash, null);
    if v_by is null then
      update credentials set email_verified_at = coalesce(email_verified_at, now()) where user_id = v_user;
    end if;
    -- Other outstanding links for this account stop working too.
    update password_resets set used_at = now() where user_id = v_user and used_at is null;
    return v_user;
  end
  $$;

-- Invitations locked to an email: the lock only means something once the
-- address is verified, so p_require_verified (set by the API while it can send
-- email) refuses unverified built-in accounts.
drop function app_accept_invitation(text);
create function app_accept_invitation(p_code_hash text, p_require_verified boolean)
  returns uuid
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    v_user uuid := app_current_user();
    v_email text;
    v_inv invitations%rowtype;
  begin
    if v_user is null then
      raise exception 'app.user_id is not set' using errcode = '28000';
    end if;

    select * into v_inv from invitations where code_hash = p_code_hash for update;
    if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at < now() then
      raise exception 'invitation is invalid or expired' using errcode = 'P0002';
    end if;

    if v_inv.email is not null then
      select email into v_email from users where id = v_user;
      if v_email is null or lower(v_email) <> lower(v_inv.email) then
        raise exception 'invitation was issued to a different email address' using errcode = '42501';
      end if;
      if p_require_verified and exists (select 1 from credentials where user_id = v_user and email_verified_at is null) then
        raise exception 'confirm your email address before accepting this invitation' using errcode = '42501';
      end if;
    end if;

    if exists (select 1 from memberships where tenant_id = v_inv.tenant_id and user_id = v_user) then
      raise exception 'already a member of this business' using errcode = '23505';
    end if;

    insert into memberships (tenant_id, user_id, role_id) values (v_inv.tenant_id, v_user, v_inv.role_id);
    update invitations set accepted_at = now(), accepted_by = v_user where id = v_inv.id;
    insert into audit_log (tenant_id, actor_user_id, action, target_type, target_id, data)
    values (v_inv.tenant_id, v_user, 'invitation.accepted', 'invitation', v_inv.id::text, '{}');
    return v_inv.tenant_id;
  end
  $$;

revoke execute on function
  app_create_email_verification(uuid, text), app_verify_email(uuid, text), app_account_status(uuid),
  app_accept_invitation(text, boolean)
  from public;
grant execute on function
  app_create_email_verification(uuid, text), app_verify_email(uuid, text), app_account_status(uuid),
  app_accept_invitation(text, boolean)
  to pos_app;
