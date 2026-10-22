-- Inventory ledger. Stock changes are recorded as append-only movements;
-- stock_levels is a running balance maintained by a trigger, so the
-- application cannot change a balance without leaving a movement behind.

create table stock_movements (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid not null,
  variant_id uuid not null,
  quantity_delta integer not null check (quantity_delta <> 0),
  reason text not null check (reason in (
    'receive', 'sale', 'return', 'transfer_out', 'transfer_in', 'adjustment', 'count_adjustment'
  )),
  -- Groups the lines of one operation (a receipt, a transfer, a count).
  operation_id uuid not null,
  reference_type text,
  reference_id text,
  note text,
  actor_user_id uuid references users (id),
  actor_device_id uuid references devices (id),
  -- When the movement happened (may precede created_at for offline devices).
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, variant_id) references product_variants (tenant_id, id)
);
create index stock_movements_level on stock_movements (tenant_id, location_id, variant_id, id);
create index stock_movements_operation on stock_movements (operation_id);
create index stock_movements_recent on stock_movements (tenant_id, id desc);

-- Retried client requests reuse the same key and get the original operation back.
create table inventory_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  kind text not null check (kind in ('receipt', 'adjustment', 'transfer', 'count')),
  idempotency_key text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
alter table stock_movements
  add constraint stock_movements_operation_fk foreign key (operation_id) references inventory_operations (id);

create table stock_levels (
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid not null,
  variant_id uuid not null,
  on_hand integer not null default 0,
  last_movement_id bigint not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, location_id, variant_id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  foreign key (tenant_id, variant_id) references product_variants (tenant_id, id)
);

create function apply_stock_movement() returns trigger
  language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  begin
    insert into stock_levels (tenant_id, location_id, variant_id, on_hand, last_movement_id)
    values (new.tenant_id, new.location_id, new.variant_id, new.quantity_delta, new.id)
    on conflict (tenant_id, location_id, variant_id) do update
      set on_hand = stock_levels.on_hand + excluded.on_hand,
          last_movement_id = excluded.last_movement_id,
          updated_at = now();
    return new;
  end
  $$;

create trigger stock_movements_apply
  after insert on stock_movements
  for each row execute function apply_stock_movement();

-- Count sessions ------------------------------------------------------------
-- Staff record counted quantities as entries (several people or scans may
-- count the same item). On approval each counted variant is compared with the
-- ledger balance as of the moment it was counted, so sales made during the
-- count are not mistaken for shrinkage.

create table count_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  status text not null default 'open' check (status in ('open', 'submitted', 'approved', 'cancelled')),
  started_by uuid not null references users (id),
  started_at timestamptz not null default now(),
  submitted_by uuid references users (id),
  submitted_at timestamptz,
  closed_by uuid references users (id),
  closed_at timestamptz,
  operation_id uuid references inventory_operations (id),
  unique (tenant_id, id),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);
create index count_sessions_recent on count_sessions (tenant_id, started_at desc);

create table count_entries (
  -- Client-generated so an offline device can safely resend the same entry.
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  session_id uuid not null,
  variant_id uuid not null,
  quantity integer not null check (quantity > 0),
  counted_at timestamptz not null,
  counted_by uuid not null references users (id),
  device_id uuid references devices (id),
  voided_at timestamptz,
  voided_by uuid references users (id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, session_id) references count_sessions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id) references product_variants (tenant_id, id)
);
create index count_entries_session on count_entries (session_id, variant_id);

do $$
declare t text;
begin
  foreach t in array array['stock_movements', 'inventory_operations', 'stock_levels', 'count_sessions', 'count_entries']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())',
      t
    );
  end loop;
end $$;

-- Movements are append-only and balances are read-only for the application.
grant select, insert on stock_movements, inventory_operations to pos_app;
grant select on stock_levels to pos_app;
grant select, insert, update on count_sessions, count_entries to pos_app;
revoke execute on function apply_stock_movement() from public;
