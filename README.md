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
| 4 | POS checkout, refunds, registers, card payments (simulated + Stripe server side) | **Done** |
| 4b | Native register app with the Stripe Terminal reader SDK | Next |
| 5 | Shopify sync (mappings, field ownership, webhooks, reconciliation) | **Done** |
| 6 | Time clock, tasks, scheduling, reporting | Next |
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

## Checkout and payments

- **Registers.** A cashier opens a register with a starting float (from the web
  hub, or on a paired register device). Closing it compares the cash counted
  with the float plus cash sales minus cash refunds and records the over/short.
- **Sales.** The server prices every sale from the catalog. Prices are entered
  before tax; each location has a sales tax rate, and tax is rounded per line.
  Line discounts need `pos.discount`. A sale completes once its payments cover
  the total: it gets the next receipt number and, if Inventory is on, stock
  goes down.
- **Payments.** Cash records what was tendered and the change. Card payments go
  through a processor behind one interface:
  - `PAYMENTS_PROVIDER=simulated` (default) keeps payments in memory; the
    register shows *Simulate approved card* / *Simulate decline*.
  - `PAYMENTS_PROVIDER=stripe` creates card-present PaymentIntents for Stripe
    Terminal and updates them from Stripe's webhook (`POST /webhooks/stripe`,
    signature checked) or when the register asks.
  A declined card stays pending so the customer can try another card; while a
  card is pending nothing else can be charged, so a sale can't be overpaid.
- **Retries are safe.** Sale, payment and refund ids come from the client and
  double as the processor's idempotency keys. Re-sending a request after a
  timeout returns the original result instead of charging or refunding twice.
- **Refunds.** Pick items and quantities; the amount includes their tax.
  Partial refunds split a line to the cent. Money goes back to the original
  payments, most recent first: cards through the processor, cash from the
  refunding cashier's open register. Optionally put items back in stock.

![Register](docs/screenshots/register.png)

## Shopify sync

Turn on **Website sync**, then connect a store from the Website sync page.

**Who owns what**

| Data | Source of truth | Direction |
|---|---|---|
| Product names, variants, SKUs, barcodes, prices | Shopify | Imported into Ample POS (matched by SKU first, so nothing is duplicated) |
| Stock at linked locations | Ample POS | Pushed to Shopify's "available" quantity |
| Online orders | Shopify | Recorded as sales at the location you choose; cancellations restock |

**How it stays correct**

- *Compare-and-swap.* Every stock push says what Shopify should currently have
  (`changeFromQuantity`). If an online sale changed it meanwhile, Shopify
  refuses, we re-read, and retry once the order has been recorded, so a push
  never erases an online sale.
- *Idempotency keys* on every inventory write (required by Shopify since
  2026-04), so a retried push is applied once.
- *No surprise zeros.* The first time an item is linked at a location where
  Ample POS has no stock record, Shopify's count is adopted as starting stock.
  Nothing is pushed while the Inventory tool is off.
- *Webhooks are only a nudge.* Signatures are checked, duplicates dropped, and
  the worker re-reads the product or order from Shopify rather than trusting
  the webhook body. A scheduled reconcile (every 15 minutes) catches anything a
  webhook missed.
- *Background worker.* Stock pushes and webhook handling run from the outbox
  with retries and exponential backoff, inside the API process by default
  (`WORKER_ENABLED`).

**Connecting**

- *Connect with Shopify* (recommended): set `SHOPIFY_CLIENT_ID` and
  `SHOPIFY_CLIENT_SECRET` from Ample POS's app in the Shopify Dev Dashboard and
  allow `<WEB_URL>/shopify/callback` as a redirect URL. Merchants approve
  access on Shopify. Tokens expire hourly and are refreshed automatically; if
  Shopify refuses a refresh (e.g. the app was uninstalled) the store is marked
  "reconnect needed".
- *Existing custom app token*: for stores that already have an app created in
  the Shopify admin (Shopify no longer allows new ones).

Credentials are encrypted with `SECRETS_KEY` (AES-256-GCM) and never returned
by the API. Written against Shopify Admin API version 2026-10.

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
