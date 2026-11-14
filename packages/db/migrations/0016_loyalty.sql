-- Loyalty rewards: customers earn points on what they spend and redeem them
-- for money off a sale.
--
-- Points live in a ledger (loyalty_entries); a customer's balance is the sum.
-- "earn" entries for a sale always add up to what the sale earns now, so
-- completing, refunding or changing the customer on a sale just writes the
-- difference. A redeemed reward is a discount spread over the sale's lines
-- (sale_lines.reward_minor), so tax is charged on the discounted amount.

create table loyalty_programs (
  tenant_id uuid primary key references tenants (id) on delete cascade,
  -- Points for each whole dollar (100 minor units) spent before tax.
  points_per_dollar integer not null default 1 check (points_per_dollar between 1 and 100),
  -- One reward costs this many points and takes this much off.
  reward_points integer not null default 100 check (reward_points between 1 and 1000000),
  reward_value_minor bigint not null default 500 check (reward_value_minor between 1 and 100000000),
  updated_at timestamptz not null default now()
);

create table loyalty_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  customer_id uuid not null,
  sale_id uuid,
  kind text not null check (kind in ('earn', 'redeem', 'adjust')),
  points integer not null check (points <> 0),
  note text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete cascade,
  foreign key (tenant_id, sale_id) references sales (tenant_id, id),
  check ((kind = 'adjust') = (sale_id is null))
);
create index loyalty_entries_customer on loyalty_entries (tenant_id, customer_id, created_at);
create index loyalty_entries_sale on loyalty_entries (sale_id) where sale_id is not null;

-- The reward taken off a sale, and the points it cost.
alter table sales add column reward_minor bigint not null default 0 check (reward_minor >= 0);
alter table sales add column reward_points integer not null default 0 check (reward_points >= 0);
-- Each line's share of the reward (already included in discount_minor).
alter table sale_lines add column reward_minor bigint not null default 0 check (reward_minor >= 0 and reward_minor <= discount_minor);

alter table loyalty_programs enable row level security;
alter table loyalty_entries enable row level security;
create policy tenant_isolation on loyalty_programs using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
create policy tenant_isolation on loyalty_entries using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert, update on loyalty_programs to pos_app;
-- Applying or removing a reward re-prices a sale's lines; nothing else on a line changes.
grant update (discount_minor, reward_minor, tax_minor, total_minor) on sale_lines to pos_app;
-- The ledger is append-only for the app.
grant select, insert on loyalty_entries to pos_app;
