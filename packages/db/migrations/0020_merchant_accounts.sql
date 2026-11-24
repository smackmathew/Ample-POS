-- How each business takes card payments.
--
--   platform: an Express account under Ample POS's Stripe platform (Stripe
--             Connect). Stripe hosts onboarding; charges are made directly on
--             the business's account, which pays Stripe's fees. No platform fee.
--   own:      the business's own Stripe account, connected with its secret key
--             (kept encrypted with SECRETS_KEY).
--   off:      no card payments (an earlier setup is remembered so it can be
--             turned back on without onboarding again).

create table merchant_accounts (
  tenant_id uuid primary key references tenants (id) on delete cascade,
  mode text not null default 'off' check (mode in ('off', 'platform', 'own')),
  -- The Express account made for this business (kept when switching away).
  connect_account_id text unique,
  -- The business's own Stripe account and its encrypted keys.
  own_account_id text,
  own_secret_key text,
  own_webhook_secret text,
  -- From Stripe, for whichever account is in use.
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  requirements_due jsonb not null default '[]',
  disabled_reason text,
  business_name text,
  livemode boolean,
  status_synced_at timestamptz,
  updated_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mode <> 'platform' or connect_account_id is not null),
  check (mode <> 'own' or (own_account_id is not null and own_secret_key is not null))
);

alter table merchant_accounts enable row level security;
create policy tenant_isolation on merchant_accounts using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert, update on merchant_accounts to pos_app;

-- The super admin sees the setup, never the keys, and can switch card payments off.
grant select (tenant_id, mode, connect_account_id, own_account_id, charges_enabled, payouts_enabled, details_submitted, requirements_due,
              disabled_reason, business_name, livemode, status_synced_at, created_at, updated_at) on merchant_accounts to pos_platform;
grant update (mode, updated_at) on merchant_accounts to pos_platform;
create policy platform_read on merchant_accounts for select to pos_platform using (true);
create policy platform_update on merchant_accounts for update to pos_platform using (true) with check (true);

-- Which Stripe account took each card payment, so its refunds go back the same way.
alter table payments add column provider_account text;

-- Stripe Connect webhooks name the account, not the business.
create function app_merchant_tenant(p_account text)
  returns uuid
  language sql stable security definer
  set search_path = public, pg_temp
  as $$ select tenant_id from merchant_accounts where connect_account_id = p_account $$;
revoke execute on function app_merchant_tenant(text) from public;
grant execute on function app_merchant_tenant(text) to pos_app;
