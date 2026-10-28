-- Subscription billing. Every business starts on a free trial; afterwards the
-- tools it has turned on are billed per active location each month.
--
-- The subscription itself lives with the billing provider (Stripe). This table
-- is our copy of it, refreshed from the provider after every change and every
-- webhook, and used to decide whether paid tools may be changed.

create table tenant_billing (
  tenant_id uuid primary key references tenants (id) on delete cascade,
  trial_ends_at timestamptz not null,
  provider text check (provider in ('simulated', 'stripe')),
  customer_id text,
  subscription_id text,
  -- The provider's status: trialing, active, past_due, canceled, unpaid, incomplete, incomplete_expired, paused.
  status text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- What the subscription currently bills: [{ "moduleId": "pos", "quantity": 2 }, ...]
  items jsonb not null default '[]',
  synced_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index tenant_billing_customer on tenant_billing (provider, customer_id) where customer_id is not null;

alter table tenant_billing enable row level security;
create policy tenant_isolation on tenant_billing
  using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());

-- The trial is set once, when the business is created; the application cannot extend it.
grant select on tenant_billing to pos_app;
grant update (provider, customer_id, subscription_id, status, current_period_end, cancel_at_period_end, items, synced_at, updated_at)
  on tenant_billing to pos_app;

create function app_start_trial() returns trigger
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  begin
    insert into tenant_billing (tenant_id, trial_ends_at) values (new.id, new.created_at + interval '14 days');
    return new;
  end
  $$;

create trigger tenants_start_trial after insert on tenants
  for each row execute function app_start_trial();

-- Businesses created before billing existed get a full trial from today.
insert into tenant_billing (tenant_id, trial_ends_at)
select id, greatest(created_at, now()) + interval '14 days' from tenants
on conflict do nothing;

-- Which business a billing customer belongs to, for provider webhooks.
create function app_billing_tenant(p_provider text, p_customer text)
  returns uuid
  language sql stable security definer
  set search_path = public, pg_temp
  as $$ select tenant_id from tenant_billing where provider = p_provider and customer_id = p_customer $$;

revoke execute on function app_billing_tenant(text, text), app_start_trial() from public;
grant execute on function app_billing_tenant(text, text) to pos_app;
