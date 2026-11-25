-- Tag printers belong to a location, not a register (any device there can
-- print tags); receipt printers stay tied to a register. Barcode scanners
-- (Symbol/Zebra and others) can be attached to any device.

update printers set register_id = null, updated_at = now() where kind = 'tag' and register_id is not null;
alter table printers add constraint printers_tag_not_on_register check (kind = 'receipt' or register_id is null);

create table scanners (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 60),
  -- Maker and model, e.g. Symbol (Zebra) LS2208.
  brand text check (brand is null or length(brand) <= 40),
  model text check (model is null or length(model) <= 60),
  -- USB (types like a keyboard), Bluetooth, or a serial / USB-COM port.
  connection text not null check (connection in ('usb', 'bluetooth', 'serial')),
  device_id uuid references devices (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, location_id) references locations (tenant_id, id)
);
create index scanners_tenant on scanners (tenant_id, location_id);
create index scanners_device on scanners (device_id) where device_id is not null;

alter table scanners enable row level security;
create policy tenant_isolation on scanners using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert, update on scanners to pos_app;
