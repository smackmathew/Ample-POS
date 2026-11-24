-- Public API for other apps (a business's own "hub", integrations):
-- API keys, a change feed, and webhooks.
--
-- An API key belongs to one business and acts on behalf of the person who
-- created it, with permissions narrowed to the ones chosen for the key. If
-- that person leaves the business, the key stops working.

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  -- The first characters of the key, so people can tell keys apart.
  hint text not null,
  secret_hash text not null,
  -- Permission keys from the module registry; '*' means everything the creator may do.
  permissions text[] not null,
  read_only boolean not null default false,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_tenant on api_keys (tenant_id, created_at desc);

alter table audit_log add column actor_api_key_id uuid references api_keys (id);

-- Every change an integration may want, in order. `id` is the feed cursor.
create table api_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  type text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index api_events_tenant_id on api_events (tenant_id, id);

create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  url text not null check (url ~ '^https?://'),
  description text,
  -- Event types, or '*' for all.
  events text[] not null,
  -- Signing secret: sealed with SECRETS_KEY when it is set.
  secret text not null,
  active boolean not null default true,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhook_endpoints_tenant on webhook_endpoints (tenant_id);

create table webhook_deliveries (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  endpoint_id uuid not null references webhook_endpoints (id) on delete cascade,
  event_id bigint references api_events (id) on delete cascade,
  type text not null,
  body jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  response_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index webhook_deliveries_due on webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_endpoint on webhook_deliveries (endpoint_id, id desc);

do $$
declare t text;
begin
  foreach t in array array['api_keys', 'api_events', 'webhook_endpoints', 'webhook_deliveries']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
  end loop;
end
$$;

-- Keys are never deleted (the audit log points at them), only revoked.
grant select, insert on api_keys to pos_app;
grant update (name, revoked_at, last_used_at) on api_keys to pos_app;
grant select, insert on api_events to pos_app;
grant select, insert, update, delete on webhook_endpoints to pos_app;
grant select, insert, update on webhook_deliveries to pos_app;

-- Looks up a key before the business is known (the key says which business it
-- belongs to). Returns nothing for an unknown, revoked or wrong key.
create function app_verify_api_key(p_id uuid, p_secret_hash text)
  returns table (tenant_id uuid, user_id uuid, name text, permissions text[], read_only boolean)
  language sql security definer
  set search_path = public, pg_temp
  as $$
    with k as (
      select * from api_keys
       where id = p_id and revoked_at is null and secret_hash = p_secret_hash
    ), touch as (
      -- At most one write a minute per key.
      update api_keys set last_used_at = now()
       where id = (select id from k) and (last_used_at is null or last_used_at < now() - interval '1 minute')
    )
    select k.tenant_id, k.created_by, k.name, k.permissions, k.read_only from k
  $$;

-- Webhook deliveries that are due, across every business, leased for a while
-- so two workers don't send the same one.
create function app_claim_webhook_deliveries(p_limit integer, p_lease_seconds integer)
  returns table (id bigint, tenant_id uuid, url text, secret text, type text, body jsonb, attempts integer)
  language sql security definer
  set search_path = public, pg_temp
  as $$
    update webhook_deliveries d
       set next_attempt_at = now() + make_interval(secs => p_lease_seconds),
           attempts = d.attempts + 1
      from webhook_endpoints e
     where e.id = d.endpoint_id
       and d.id in (
         select id from webhook_deliveries
          where status = 'pending' and next_attempt_at <= now()
          order by id
          limit p_limit
          for update skip locked
       )
    returning d.id, d.tenant_id, e.url, e.secret, d.type, d.body, d.attempts
  $$;

-- Records the outcome. Failures retry with backoff (1 minute up to 6 hours);
-- after p_max_attempts the delivery is marked failed.
create function app_finish_webhook_delivery(p_id bigint, p_status integer, p_error text, p_max_attempts integer)
  returns void
  language sql security definer
  set search_path = public, pg_temp
  as $$
    update webhook_deliveries
       set status = case when p_error is null then 'delivered'
                         when attempts >= p_max_attempts then 'failed'
                         else 'pending' end,
           delivered_at = case when p_error is null then now() end,
           response_status = p_status,
           last_error = p_error,
           next_attempt_at = case when p_error is null then next_attempt_at
                                  else now() + make_interval(secs => least(21600, 60 * power(3, least(attempts - 1, 8))::integer)) end
     where id = p_id
  $$;

revoke execute on function app_verify_api_key(uuid, text), app_claim_webhook_deliveries(integer, integer),
  app_finish_webhook_delivery(bigint, integer, text, integer) from public;
grant execute on function app_verify_api_key(uuid, text), app_claim_webhook_deliveries(integer, integer),
  app_finish_webhook_delivery(bigint, integer, text, integer) to pos_app;
