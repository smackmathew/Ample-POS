-- Invitations: a member with members.manage creates a one-time code for a
-- role; the invitee accepts it after signing in.

create table invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  role_id uuid not null,
  email text,
  code_hash text not null unique,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references users (id),
  revoked_at timestamptz,
  foreign key (tenant_id, role_id) references roles (tenant_id, id) on delete cascade
);

alter table invitations enable row level security;
create policy tenant_isolation on invitations
  using (tenant_id = app_current_tenant())
  with check (tenant_id = app_current_tenant());

grant select, insert, update on invitations to pos_app;

-- Accept as app_current_user(). Returns the business id joined.
create function app_accept_invitation(p_code_hash text)
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

revoke execute on function app_accept_invitation(text) from public;
grant execute on function app_accept_invitation(text) to pos_app;
