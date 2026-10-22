# POS Hub

A modular, multi-tenant point-of-sale platform. Each business picks the tools it
needs (catalog, inventory, checkout, time clock, scheduling, tasks, website sync,
reporting) on one shared foundation of businesses, locations, people, roles,
devices and an audit trail.

![Tools page](docs/screenshots/tools.png)

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Foundation: businesses, locations, roles and permissions, invitations, devices, module entitlements, audit log, outbox, admin hub | **Done** |
| 2 | Product catalog and inventory ledger with count sessions | Next |
| 3 | Mobile counting app (Expo, offline SQLite queue, barcode scanning) | |
| 4 | POS checkout, refunds, registers, Stripe Terminal payment adapter | |
| 5 | Shopify sync (mappings, field ownership, webhooks, reconciliation) | |
| 6 | Time clock, tasks, scheduling, reporting | |
| 7 | Subscription billing tied to enabled modules | |

Modules can already be turned on per business; their screens arrive in the phase listed.

## Layout

```
apps/api         NestJS API (one transaction per request, RLS-scoped)
apps/web         Next.js admin hub
packages/db      SQL migrations, Drizzle schema, migrator
packages/modules Module registry, permissions catalog, built-in roles
```

## How tenant isolation works

- Every business-owned table has a Postgres row-level security policy on
  `tenant_id = app_current_tenant()`.
- The API connects as the restricted `pos_app` role (no superuser, no BYPASSRLS).
- Each request runs in one transaction that sets `app.user_id` and, for
  business routes, `app.tenant_id` from the `X-Tenant-Id` header. The
  interceptor then checks membership, the route's `@RequirePermission`, and
  its `@RequireModule` entitlement before the handler runs.
- Cross-business operations (sign-in, listing your businesses, creating a
  business, accepting an invitation) go through `SECURITY DEFINER` functions
  that only act for `app.user_id`.
- The audit log is append-only for `pos_app`.
- Members can only grant, or act on holders of, permissions they hold themselves.

## Running locally

Requires Node 22+, pnpm 10 and Postgres 16 (or `docker compose up -d`).

```bash
cp .env.example .env
pnpm install
pnpm build
pnpm db:setup          # creates the pos_app role and runs migrations
pnpm --filter @pos/api start
pnpm --filter @pos/web start   # http://localhost:3000
```

Sign in with any email: `AUTH_MODE=dev` issues local tokens. For production set
`AUTH_MODE=jwks` with `AUTH_JWKS_URL` and `AUTH_ISSUER` from your identity
provider (Clerk, Auth0 or similar). The API maps the token's `sub` to a user.

## Tests

```bash
pnpm test
```

API tests run against a real Postgres. They recreate a `pos_hub_test` database
using `TEST_ADMIN_DATABASE_URL` (default
`postgres://postgres:postgres@localhost:5432/postgres`).

## Adding a module

1. Add its definition (dependencies, permissions, nav) to `packages/modules/src/registry.ts`.
2. Add tables in a new migration with the `tenant_isolation` policy and `pos_app` grants.
3. Add controllers guarded with `@RequireModule('<id>')` and `@RequirePermission(...)`.
4. Record changes with `Events.record(...)` so they reach the audit log and outbox.
