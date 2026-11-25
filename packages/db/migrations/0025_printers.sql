-- Printers for each location: receipt printers and tag (label) printers,
-- reached over USB, a network share or an IP address, and assigned to the
-- register that prints to them.

create table printers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  location_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 60),
  kind text not null check (kind in ('receipt', 'tag')),
  connection text not null check (connection in ('usb', 'network_share', 'ip')),
  -- IP: host name or address. Network share: \\computer\printer. USB: the printer's name on the register (optional).
  address text check (address is null or length(address) <= 255),
  -- IP only: raw printing port, usually 9100.
  port integer check (port is null or port between 1 and 65535),
  -- What the printer understands: ESC/POS or Star for receipts; ZPL, EPL or TSPL for tags; or the system print dialog.
  language text not null check (language in ('escpos', 'star', 'zpl', 'epl', 'tspl', 'system')),
  -- Receipt paper width (58mm, 80mm) or tag size (e.g. 2x1in).
  paper text check (paper is null or length(paper) <= 30),
  register_id uuid references devices (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, location_id) references locations (tenant_id, id),
  check (connection <> 'ip' or (address is not null and port is not null)),
  check (connection <> 'network_share' or address is not null)
);
create index printers_tenant on printers (tenant_id, location_id);
-- A register has at most one receipt printer and one tag printer.
create unique index printers_one_per_register on printers (register_id, kind) where register_id is not null and status = 'active';

alter table printers enable row level security;
create policy tenant_isolation on printers using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert, update on printers to pos_app;
