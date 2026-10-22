-- Product catalog: products, sellable variants, barcodes.
-- Every product has at least one variant; a simple product has one default variant.
-- Prices are integer minor units (cents) in the business currency.

alter table tenants add column currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$');

create table products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text,
  category text,
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index products_tenant_name on products (tenant_id, lower(name));

create table product_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  product_id uuid not null,
  name text not null default 'Default',
  sku text check (sku is null or length(trim(sku)) > 0),
  price_minor bigint not null check (price_minor >= 0),
  cost_minor bigint check (cost_minor is null or cost_minor >= 0),
  track_inventory boolean not null default true,
  status text not null default 'active' check (status in ('active', 'archived')),
  position integer not null default 0,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id) on delete cascade
);
create unique index product_variants_sku on product_variants (tenant_id, lower(sku)) where sku is not null;
create index product_variants_product on product_variants (product_id, position);

create table variant_barcodes (
  tenant_id uuid not null references tenants (id) on delete cascade,
  barcode text not null check (barcode ~ '^[!-~]{1,64}$'),
  variant_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, barcode),
  foreign key (tenant_id, variant_id) references product_variants (tenant_id, id) on delete cascade
);
create index variant_barcodes_variant on variant_barcodes (variant_id);

do $$
declare t text;
begin
  foreach t in array array['products', 'product_variants', 'variant_barcodes']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())',
      t
    );
  end loop;
end $$;

grant select, insert, update on products, product_variants to pos_app;
grant select, insert, delete on variant_barcodes to pos_app;
