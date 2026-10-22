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
| 2 | Product catalog and inventory ledger with count sessions | **Done** |
| 3 | Mobile counting app (Expo, offline SQLite queue, barcode scanning) | **Done** |
| 4 | POS checkout, refunds, registers, Stripe Terminal payment adapter | Next |
| 5 | Shopify sync (mappings, field ownership, webhooks, reconciliation) | |
| 6 | Time clock, tasks, scheduling, reporting | |
| 7 | Subscription billing tied to enabled modules | |

Modules can already be turned on per business; their screens arrive in the phase listed.

## Layout

```
apps/api         NestJS API (one transaction per request, RLS-scoped)
apps/web         Next.js admin hub
apps/mobile      Expo app for handhelds: pairing, offline scan-to-count
packages/db      SQL migrations, Drizzle schema, migrator
packages/modules Module registry, permissions catalog, built-in roles
packages/sync    API client and offline sync engine shared by devices
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

## How inventory works

- **Products and variants.** Every product has at least one variant (the sellable
  item). Variants carry the SKU, price and cost in integer cents, and any number
  of barcodes. SKUs and barcodes are unique within a business.
- **Edits are versioned.** Product and variant updates send the version they
  started from; a stale version gets `409 version_conflict` with the current
  data instead of silently overwriting someone else's change.
- **Stock is a ledger.** Receipts, adjustments, transfers and count corrections
  are append-only `stock_movements`. A database trigger keeps `stock_levels` in
  step, and the app role cannot update balances or edit movements directly.
- **Retries are safe.** Stock operations accept an `idempotencyKey`; resending
  the same request returns the original result without moving stock again.
- **Counts compare against the moment of counting.** Staff record count entries
  (several people can count the same item; offline devices can resend entries
  safely). On approval, each item's count is compared with the ledger balance
  as of when it was counted, so a sale that happens during the count is not
  booked as shrinkage. Counting (`inventory.count`) and approving
  (`inventory.count.approve`) are separate permissions.

![Count review](docs/screenshots/count-review.png)

Quantities are whole units for now; weighed and measured items come later.

## Mobile counting app

`apps/mobile` is an Expo (SDK 54) app for phones and rugged handhelds.

1. **Sign in** with your account (dev sign-in for now).
2. **Pair** the device: in the admin hub go to Devices → Register device
   (type *Handheld*) and scan the QR code it shows. The code carries the API
   address, the business and the device credential; the credential is kept in
   the phone's secure keychain. Revoking the device in the hub stops it at once.
3. **Count**: start or open a count for the device's location, then scan with
   the camera or a hardware scanner (which types the code and presses enter).

Counting works offline. The app downloads the catalog to look up barcodes
locally, and every scan is stored in SQLite with its own ID before it is sent.
The sync engine (`packages/sync`) retries when the network returns; the
server ignores entries it already has, so a lost response never double-counts.
Entries undone before syncing are never sent. If the count was closed on the
web in the meantime, its entries are shown as refused rather than lost.

Run it with `pnpm --filter @pos/mobile start` and open it in Expo Go or a
development build. Set `PUBLIC_API_URL` for the web app (and the app's server
field) to an address the phone can reach, such as your machine's LAN IP.

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
