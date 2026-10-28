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
| 4b | Native register app with the Stripe Terminal reader SDK | **Done** |
| 5 | Shopify sync (mappings, field ownership, webhooks, reconciliation) | **Done** |
| 6 | Time clock, tasks, scheduling, reporting | **Done** |
| 7 | Subscription billing tied to enabled modules | **Done** |

Every tool has working screens, and businesses pay only for the tools they turn on.

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

## Time clock, scheduling, tasks and reports

- **Punches are permanent.** Clocking in, out and breaks adds a row to
  `time_punches`; the database refuses updates and deletes except the void
  columns. A missed punch is added by a manager with a reason, and a wrong one
  is voided with a reason, so the timecard keeps its full history. Managers
  cannot correct or approve their own time; another manager or the owner must.
- **Timecards** pair punches into shifts per person, count days in the
  location's time zone, flag open or odd shifts, and show weekly overtime past
  40 hours. Approving a week saves the minutes; if a punch in that week changes
  later, the approval shows as out of date.
- **Scheduling.** Shifts start as drafts and staff see them only once the week
  is published. The database rejects overlapping shifts for the same person.
  With the time clock on, timecards show scheduled minutes next to worked.
- **Tasks.** Checklists run once, daily or on chosen weekdays, for a person, a
  role or everyone at a location. Each day gets its own run; ticking an item
  records who and when, and an unfinished one-off list carries over.
- **Reports.** Sales by store day (gross, discounts, tax, refunds, net), totals
  by payment method, top products and a CSV download; stock value at cost; and
  hours worked with net sales per labor hour. Each section appears when its
  tool is on.

## Billing

- **Free trial, then pay for what's on.** Every business gets 14 days free.
  After that each paid tool costs a monthly price per active location
  (Product catalog and Reporting are included). Prices live in the module
  registry (`monthlyPriceMinor`), so the Tools page, the Billing page and
  Stripe all use the same numbers.
- **Stripe does the money.** Subscribing opens Stripe Checkout; invoices, cards
  and cancellation are in Stripe's customer portal. Ample POS creates its
  Stripe products and prices on first use (found by lookup key; a new price
  gets a new key, so existing prices are never edited). Every subscription
  carries a $0 base item so it stays valid when no paid tool is on.
- **The plan follows the business.** Turning tools on or off, or adding and
  archiving locations, updates the subscription in the background (prorated),
  through the same outbox worker as Shopify sync.
- **Webhooks are a nudge.** `POST /webhooks/stripe-billing` checks the
  signature, then re-reads the customer's subscription from Stripe; the event
  body is never trusted for state.
- **Lapsed means read-only, not locked out.** If the trial ends without a
  subscription, or the subscription is canceled or unpaid, paid tools reject
  changes with `402 subscription_required` but everything stays viewable and
  included tools keep working. A failed payment (`past_due`) keeps working while
  Stripe retries, with a banner. Handhelds keep unsynced scans and send them
  once the business subscribes.
- The trial end is set by the database when a business is created; the API
  role cannot change it.

Locally, `BILLING_PROVIDER=simulated` subscribes without a card. For Stripe set
`BILLING_PROVIDER=stripe`, `BILLING_STRIPE_SECRET_KEY` and
`BILLING_STRIPE_WEBHOOK_SECRET`, and point a webhook (subscription, invoice
and checkout events) at `/webhooks/stripe-billing`. Turn on the customer
portal in the Stripe dashboard.

## Register app

The same Expo app becomes a register when it is paired as a *Register* device
(Devices → Register device → type Register); paired as a *Handheld* it counts
stock as before.

- **Selling.** Open the register with the starting cash, then scan (camera or a
  hardware scanner) or search by name to build the cart. *Charge* creates the
  sale on the server, which prices it (tax, rounding); payment can be cash,
  card, or both. Closing the register compares counted cash with expected.
- **Retries are safe.** The sale id and each payment id are made on the
  register, so a retried request after a dropped connection returns the same
  sale or payment instead of a second one. A declined card keeps its payment
  open, and *try again* resumes it. *Edit cart* voids the unpaid sale and
  starts a new one.
- **Card readers (Stripe Terminal).** Tap to Pay on the phone or tablet, or a
  Bluetooth reader such as the Stripe M2. The app asks our API for a
  connection token (`POST /terminal/connection-token`), so it never holds a
  Stripe key. Readers are registered to the store: the API creates a Stripe
  Terminal Location from the store's address the first time and updates it when
  the address changes. A store needs a street address (Locations page) before
  readers connect.
- **The reader is not the source of truth.** After the reader says approved,
  the app asks the server to re-read the PaymentIntent from Stripe, and only
  then is the sale paid (the payment webhook does the same).
- **Test mode.** With `PAYMENTS_PROVIDER=simulated` the payment screen shows
  Approve and Decline buttons instead of a reader. With Stripe test keys,
  *Use a simulated reader* connects Stripe's virtual reader.

The card reader SDK is native code, so card readers need a development or store
build (`npx expo run:ios`, `npx expo run:android`, or EAS Build); in Expo Go the
register still works with cash and the simulated processor. Android needs 8.0
(API 26) or newer.

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
