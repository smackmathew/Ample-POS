-- Import & export center: data brought in from another POS (QuickBooks POS,
-- spreadsheets...) as batches that are previewed, imported, and can be undone.

create table import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  kind text not null check (kind in ('products', 'customers', 'suppliers')),
  -- Which system the file came from, for column names: qbpos, ample or other.
  source text not null check (source in ('qbpos', 'ample', 'other')),
  file_name text not null,
  -- Products only: where on-hand quantities in the file are set.
  location_id uuid,
  status text not null default 'preview' check (status in ('preview', 'committed', 'undone')),
  headers text[] not null,
  -- The file's rows until it's imported (then cleared).
  rows jsonb,
  -- Our field → the file's column.
  mapping jsonb not null,
  stats jsonb not null default '{}',
  -- The stock adjustment the import made, so undo can reverse it.
  operation_id uuid,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  undone_at timestamptz,
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);
create index import_batches_tenant on import_batches (tenant_id, created_at desc);

-- What each import created or changed (with the values before), for undo.
create table import_batch_items (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  batch_id uuid not null references import_batches (id) on delete cascade,
  entity_type text not null check (entity_type in ('product', 'variant', 'barcode', 'customer', 'supplier')),
  entity_id text not null,
  action text not null check (action in ('created', 'updated')),
  before jsonb
);
create index import_batch_items_batch on import_batch_items (batch_id);

do $$
declare t text;
begin
  foreach t in array array['import_batches', 'import_batch_items']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
  end loop;
end
$$;

grant select, insert, update on import_batches to pos_app;
grant select, insert on import_batch_items to pos_app;
