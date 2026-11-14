-- Purchase orders: what a business orders from its suppliers, and receiving
-- what arrives into stock.
--
-- A purchase order goes draft -> ordered -> partially_received -> received,
-- or is canceled before anything arrives. Each delivery received is a
-- purchase_order_receipt; it puts stock in through the inventory ledger
-- (an inventory "receipt" operation referencing the order).

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  contact_name text,
  email text,
  phone text,
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index suppliers_name on suppliers (tenant_id, lower(name)) where archived_at is null;

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- PO-1, PO-2, ... per business.
  number bigint not null,
  supplier_id uuid not null,
  location_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'ordered', 'partially_received', 'received', 'canceled')),
  note text,
  expected_on date,
  ordered_at timestamptz,
  closed_at timestamptz,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);
create index purchase_orders_status on purchase_orders (tenant_id, status, created_at);

create table purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  purchase_order_id uuid not null,
  position integer not null,
  variant_id uuid not null,
  quantity_ordered integer not null check (quantity_ordered between 1 and 1000000),
  quantity_received integer not null default 0 check (quantity_received >= 0),
  unit_cost_minor bigint not null check (unit_cost_minor between 0 and 100000000),
  unique (tenant_id, id),
  unique (purchase_order_id, variant_id),
  foreign key (tenant_id, purchase_order_id) references purchase_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id) references product_variants (tenant_id, id)
);

create table purchase_order_receipts (
  -- Made by the client, so a retried "Receive" never adds stock twice.
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  purchase_order_id uuid not null,
  inventory_operation_id uuid not null references inventory_operations (id),
  note text,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, purchase_order_id) references purchase_orders (tenant_id, id)
);

create table purchase_order_receipt_lines (
  tenant_id uuid not null references tenants (id) on delete cascade,
  receipt_id uuid not null,
  line_id uuid not null,
  quantity integer not null check (quantity > 0),
  primary key (receipt_id, line_id),
  foreign key (tenant_id, receipt_id) references purchase_order_receipts (tenant_id, id),
  foreign key (tenant_id, line_id) references purchase_order_lines (tenant_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['suppliers', 'purchase_orders', 'purchase_order_lines', 'purchase_order_receipts', 'purchase_order_receipt_lines']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
  end loop;
end
$$;

grant select, insert, update on suppliers, purchase_orders to pos_app;
-- Draft orders replace their lines when edited.
grant select, insert, update, delete on purchase_order_lines to pos_app;
grant select, insert on purchase_order_receipts, purchase_order_receipt_lines to pos_app;
