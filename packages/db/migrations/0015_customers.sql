-- Customers: optional people attached to sales, for purchase history and
-- sending receipts without retyping an email.
--
-- Deleting a customer (for example on a privacy request) removes their
-- details; their sales stay, unlinked, so the books still add up.

create table customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  -- Lowercased; unique per business.
  email text,
  -- Digits only (plus a leading + if given); unique per business.
  phone text,
  note text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index customers_email on customers (tenant_id, email) where email is not null;
create unique index customers_phone on customers (tenant_id, phone) where phone is not null;
create index customers_name on customers (tenant_id, lower(name));

alter table sales add column customer_id uuid;
alter table sales add constraint sales_customer_fk
  foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete set null (customer_id);
create index sales_customer on sales (tenant_id, customer_id) where customer_id is not null;

alter table customers enable row level security;
create policy tenant_isolation on customers
  using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());

grant select, insert, update, delete on customers to pos_app;
