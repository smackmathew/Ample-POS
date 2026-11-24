-- Plans: Starter, Growth and Pro, each a monthly price for the first location,
-- a price per extra location and a number of registers per location. Every
-- plan includes the point of sale, catalog, reports, customers and loyalty;
-- other tools are add-ons. An online store is a one-time setup plus the
-- plan's monthly sync fee.

alter table tenant_billing add column plan text not null default 'starter' check (plan in ('starter', 'growth', 'pro'));
alter table tenant_billing add column website_addon text check (website_addon in ('simple', 'complex'));
-- When the add-on's one-time setup fee was charged (null: still to charge, at checkout).
alter table tenant_billing add column website_setup_charged_at timestamptz;

-- Price changes made in the super admin dashboard; null keeps the built-in value.
create table platform_plans (
  plan_id text primary key check (plan_id in ('starter', 'growth', 'pro')),
  base_minor bigint check (base_minor between 0 and 10000000),
  extra_location_minor bigint check (extra_location_minor between 0 and 10000000),
  registers_per_location integer check (registers_per_location between 1 and 1000),
  website_maintenance_minor bigint check (website_maintenance_minor between 0 and 10000000),
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);

create table platform_website_addons (
  addon_id text primary key check (addon_id in ('simple', 'complex')),
  setup_minor bigint check (setup_minor between 0 and 100000000),
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);

grant update (plan, website_addon, website_setup_charged_at) on tenant_billing to pos_app;
grant select on platform_plans, platform_website_addons to pos_app;
grant select, insert, update on platform_plans, platform_website_addons to pos_platform;
-- The super admin can move a business to another plan.
grant update (plan, website_addon, website_setup_charged_at) on tenant_billing to pos_platform;
create policy platform_update on tenant_billing for update to pos_platform using (true) with check (true);
