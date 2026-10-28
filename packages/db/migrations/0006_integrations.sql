-- Integrations (Shopify first) and the outbox worker.
--
-- Field ownership for Shopify:
--   catalog (names, variants, SKUs, barcodes, prices)  Shopify -> POS
--   available stock at mapped locations                 POS -> Shopify
--   online orders                                       Shopify -> POS (stock movements)

create table integration_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  provider text not null check (provider in ('shopify')),
  status text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  shop_domain text not null,
  -- AES-256-GCM encrypted JSON ({ accessToken, webhookSecret }); never returned by the API.
  credentials text not null,
  -- { onlineOrdersLocationId?: uuid }
  settings jsonb not null default '{}',
  status_message text,
  last_import_at timestamptz,
  last_push_at timestamptz,
  orders_checked_at timestamptz,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index integration_connections_one_active on integration_connections (tenant_id, provider) where status <> 'disconnected';

-- Which external record corresponds to which of ours.
create table external_mappings (
  tenant_id uuid not null references tenants (id) on delete cascade,
  connection_id uuid not null,
  kind text not null check (kind in ('product', 'variant', 'location')),
  external_id text not null,
  internal_id uuid not null,
  -- Variant: { inventoryItemId }.
  data jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (connection_id, kind, external_id),
  unique (connection_id, kind, internal_id),
  foreign key (tenant_id, connection_id) references integration_connections (tenant_id, id) on delete cascade
);

-- What we last told the store each variant has at each location. Used as the
-- compare-and-swap value so we never overwrite a change made on the store side.
create table inventory_push_state (
  tenant_id uuid not null references tenants (id) on delete cascade,
  connection_id uuid not null,
  variant_id uuid not null,
  location_id uuid not null,
  last_pushed integer,
  -- Bumped after every successful push; part of the idempotency key.
  push_seq integer not null default 0,
  last_pushed_at timestamptz,
  primary key (connection_id, variant_id, location_id),
  foreign key (tenant_id, connection_id) references integration_connections (tenant_id, id) on delete cascade
);

create table sync_issues (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  connection_id uuid not null,
  kind text not null,
  message text not null,
  external_ref text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (tenant_id, connection_id) references integration_connections (tenant_id, id) on delete cascade
);
create index sync_issues_open on sync_issues (connection_id, id desc) where resolved_at is null;

-- Webhook deliveries already accepted (providers retry and may send duplicates).
create table processed_webhooks (
  tenant_id uuid not null references tenants (id) on delete cascade,
  connection_id uuid not null,
  webhook_id text not null,
  received_at timestamptz not null default now(),
  primary key (connection_id, webhook_id),
  foreign key (tenant_id, connection_id) references integration_connections (tenant_id, id) on delete cascade
);

do $$
declare t text;
begin
  foreach t in array array['integration_connections', 'external_mappings', 'inventory_push_state', 'sync_issues', 'processed_webhooks']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())',
      t
    );
  end loop;
end $$;

grant select, insert, update on integration_connections, inventory_push_state, sync_issues to pos_app;
grant select, insert, update, delete on external_mappings to pos_app;
grant select, insert on processed_webhooks to pos_app;

-- Cross-tenant entry points for webhooks and background work ----------------

-- Which business a webhook URL belongs to (the URL carries the connection id).
create function app_connection_tenant(p_connection uuid)
  returns uuid
  language sql stable security definer
  set search_path = public, pg_temp
  as $$ select tenant_id from integration_connections where id = p_connection and status <> 'disconnected' $$;

-- Active connections across all businesses, for scheduled reconciliation.
create function app_active_connections()
  returns table (id uuid, tenant_id uuid, provider text)
  language sql stable security definer
  set search_path = public, pg_temp
  as $$ select id, tenant_id, provider from integration_connections where status = 'active' $$;

-- Leases up to p_limit due outbox events. A leased event is invisible to other
-- workers until p_lease_seconds pass, so a crashed worker's events come back.
create function app_claim_outbox(p_limit integer, p_lease_seconds integer)
  returns table (id bigint, tenant_id uuid, topic text, payload jsonb, attempts integer)
  language sql security definer
  set search_path = public, pg_temp
  as $$
    update outbox o
       set available_at = now() + make_interval(secs => p_lease_seconds),
           attempts = o.attempts + 1
     where o.id in (
       select id from outbox
        where published_at is null and available_at <= now()
        order by id
        limit p_limit
        for update skip locked
     )
    returning o.id, o.tenant_id, o.topic, o.payload, o.attempts
  $$;

-- Marks an event done, or schedules a retry with exponential backoff.
create function app_finish_outbox(p_id bigint, p_error text)
  returns void
  language sql security definer
  set search_path = public, pg_temp
  as $$
    update outbox
       set published_at = case when p_error is null then now() else null end,
           last_error = p_error,
           available_at = case when p_error is null then available_at
                               else now() + make_interval(secs => least(3600, 5 * power(2, least(attempts, 12))::integer)) end
     where id = p_id
  $$;

revoke execute on function app_connection_tenant(uuid), app_active_connections(), app_claim_outbox(integer, integer), app_finish_outbox(bigint, text) from public;
grant execute on function app_connection_tenant(uuid), app_active_connections(), app_claim_outbox(integer, integer), app_finish_outbox(bigint, text) to pos_app;
