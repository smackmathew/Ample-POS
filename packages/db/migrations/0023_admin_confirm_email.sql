-- Lets Ample POS staff (the super admin dashboard, as pos_platform) confirm a
-- person's email by hand, e.g. when confirmation emails can't be delivered.
create function app_admin_confirm_email(p_email text)
  returns table (user_id uuid, already_confirmed boolean)
  language sql security definer
  set search_path = public, pg_temp
  as $$
    with c as (
      select user_id, email_verified_at is not null as already from credentials where email = lower(trim(p_email))
    ), upd as (
      update credentials set email_verified_at = coalesce(email_verified_at, now())
       where user_id = (select user_id from c)
    )
    select c.user_id, c.already from c
  $$;

revoke execute on function app_admin_confirm_email(text) from public;
grant execute on function app_admin_confirm_email(text) to pos_platform;
