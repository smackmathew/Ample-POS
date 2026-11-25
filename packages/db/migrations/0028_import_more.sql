-- More to import from another POS: gift card balances, loyalty points, and
-- sales history.

alter table import_batches drop constraint import_batches_kind_check;
alter table import_batches add constraint import_batches_kind_check
  check (kind in ('products', 'customers', 'suppliers', 'gift_cards', 'loyalty', 'sales'));

alter table import_batch_items drop constraint import_batch_items_entity_type_check;
alter table import_batch_items add constraint import_batch_items_entity_type_check
  check (entity_type in ('product', 'variant', 'barcode', 'customer', 'supplier', 'gift_card', 'loyalty'));

-- Sales from before Ample POS, one row per line, for reports and customer
-- history. Kept apart from real sales so they never touch stock, payments or
-- register counts.
create table sales_history (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  batch_id uuid not null references import_batches (id) on delete cascade,
  location_id uuid not null,
  sold_on date not null,
  receipt text,
  customer_id uuid,
  variant_id uuid references product_variants (id) on delete set null,
  sku text,
  description text not null,
  quantity integer not null,
  -- What the line came to, and its tax if the file had it.
  total_minor bigint not null,
  tax_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete set null (customer_id)
);
create index sales_history_day on sales_history (tenant_id, sold_on);
create index sales_history_customer on sales_history (customer_id) where customer_id is not null;
create index sales_history_batch on sales_history (batch_id);

alter table sales_history enable row level security;
create policy tenant_isolation on sales_history using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
-- Undoing an import removes its history.
grant select, insert, delete on sales_history to pos_app;
