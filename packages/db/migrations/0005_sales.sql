-- Point of sale: register shifts, sales, payments and refunds.
-- Money is integer minor units. Prices are tax-exclusive; tax is computed per
-- line from the location's rate. Sale, payment and refund ids are generated
-- by the client so retried requests are idempotent.

alter table locations add column tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 10000);

alter table inventory_operations drop constraint inventory_operations_kind_check;
alter table inventory_operations add constraint inventory_operations_kind_check
  check (kind in ('receipt', 'adjustment', 'transfer', 'count', 'sale', 'refund'));

-- Per-business counters (receipt numbers). Incremented under a row lock.
create table tenant_counters (
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  value bigint not null default 0,
  primary key (tenant_id, name)
);

create table register_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid not null,
  -- Null when the register runs in the web hub rather than on a paired device.
  device_id uuid references devices (id),
  status text not null default 'open' check (status in ('open', 'closed')),
  opening_float_minor bigint not null check (opening_float_minor >= 0),
  opened_by uuid not null references users (id),
  opened_at timestamptz not null default now(),
  counted_cash_minor bigint check (counted_cash_minor >= 0),
  expected_cash_minor bigint,
  closed_by uuid references users (id),
  closed_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);
create unique index register_sessions_one_open_per_device on register_sessions (device_id) where status = 'open' and device_id is not null;
create unique index register_sessions_one_open_per_user_web on register_sessions (tenant_id, opened_by) where status = 'open' and device_id is null;

create table sales (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid not null,
  register_session_id uuid not null,
  device_id uuid references devices (id),
  status text not null default 'open' check (status in ('open', 'completed', 'voided')),
  currency char(3) not null,
  subtotal_minor bigint not null,
  discount_minor bigint not null,
  tax_minor bigint not null,
  total_minor bigint not null check (total_minor >= 0),
  tax_rate_bps integer not null,
  receipt_number bigint,
  note text,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  voided_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, receipt_number),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, register_session_id) references register_sessions (tenant_id, id)
);
create index sales_recent on sales (tenant_id, created_at desc);

create table sale_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  sale_id uuid not null,
  position integer not null,
  variant_id uuid not null,
  -- Snapshot so receipts don't change when the catalog does.
  description text not null,
  sku text,
  quantity integer not null check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null check (tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  track_inventory boolean not null,
  foreign key (tenant_id, sale_id) references sales (tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id) references product_variants (tenant_id, id)
);
create index sale_lines_sale on sale_lines (sale_id, position);

create table payments (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  sale_id uuid not null,
  method text not null check (method in ('cash', 'card')),
  status text not null check (status in ('pending', 'succeeded', 'failed', 'canceled')),
  amount_minor bigint not null check (amount_minor > 0),
  -- Cash only: what the customer handed over, and the change given.
  tendered_minor bigint,
  change_minor bigint,
  provider text,
  provider_ref text,
  last_error text,
  created_by uuid not null references users (id),
  device_id uuid references devices (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, sale_id) references sales (tenant_id, id)
);
create index payments_sale on payments (sale_id);
create unique index payments_provider_ref on payments (provider, provider_ref) where provider_ref is not null;

create table refunds (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  sale_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  restock boolean not null,
  reason text,
  -- The drawer cash was paid out of; null when nothing was refunded in cash.
  register_session_id uuid,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, sale_id) references sales (tenant_id, id),
  foreign key (tenant_id, register_session_id) references register_sessions (tenant_id, id)
);

create table refund_lines (
  refund_id uuid not null references refunds (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  sale_line_id uuid not null references sale_lines (id),
  quantity integer not null check (quantity > 0),
  amount_minor bigint not null check (amount_minor >= 0),
  primary key (refund_id, sale_line_id)
);

-- How a refund was paid back: one row per original payment it draws on.
create table refund_payments (
  refund_id uuid not null references refunds (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  payment_id uuid not null references payments (id),
  amount_minor bigint not null check (amount_minor > 0),
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  provider_ref text,
  primary key (refund_id, payment_id)
);

do $$
declare t text;
begin
  foreach t in array array['tenant_counters', 'register_sessions', 'sales', 'sale_lines', 'payments', 'refunds', 'refund_lines', 'refund_payments']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())',
      t
    );
  end loop;
end $$;

-- Payment webhooks arrive without a business selected. This only reveals
-- which business owns a provider payment, so the handler can switch to it.
create function app_payment_tenant(p_provider text, p_ref text)
  returns uuid
  language sql stable security definer
  set search_path = public, pg_temp
  as $$ select tenant_id from payments where provider = p_provider and provider_ref = p_ref $$;

revoke execute on function app_payment_tenant(text, text) from public;
grant execute on function app_payment_tenant(text, text) to pos_app;

grant select, insert, update on tenant_counters, register_sessions, sales, payments, refund_payments to pos_app;
grant select, insert on sale_lines, refunds, refund_lines to pos_app;
