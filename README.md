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
| 8 | Customers: profiles, purchase history, receipts to the customer | **Done** |
| 9 | Loyalty rewards: points on spending, rewards at the register | **Done** |
| 10 | Gift cards: sell, reload, pay with, refund | **Done** |
| 11 | Purchase orders: suppliers, ordering, receiving into stock | **Done** |

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

## Purchase orders

The **Purchase orders** tool (included with Inventory) covers buying stock from
suppliers.

- **Suppliers** have a name, contact person, email, phone and notes. They can
  be archived when no longer used.
- **Ordering:** start an order for a supplier and a location, then add
  stocked items with a quantity and cost each. Costs start from each item's
  current cost. *Add everything with N or fewer in stock* adds the
  location's low items that aren't already on an open order.
- **Placing:** email the order to the supplier from the app (when email is
  set up), or mark it placed after sending it another way. Only drafts can be
  edited.
- **Receiving:** enter what arrived. Stock goes in at the order's location
  through the inventory ledger (`receive` movements that point at the
  order), and item costs update to what the order paid (optional). Deliveries
  can come in parts; extra units are fine. A retried *Receive* never adds
  stock twice.
- **Finishing:** an order is received once everything has arrived. *Close*
  ends a short order, and an order nothing arrived for can be canceled.
- **Permissions:** `purchasing.manage` (suppliers and orders; managers) and
  `purchasing.receive` (receive deliveries; managers and staff).
- **On the phone:** deliveries can also be received by scanning, in the
  mobile app (see *Mobile counting app*).

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

## Receipts

One layout (`packages/receipts`) is used for every receipt, so printed and
emailed receipts always match. It shows:
- the business name, the store's name and address (from Locations), and the
  phone, website and footer message from Point of sale → Receipts;
- the receipt number, the time in the store's time zone, and the cashier's
  first name;
- the lines after discounts, which add up to the subtotal, then tax and total;
- cash given and change, card amounts, and refunds.

- **Printing** works without printer integrations:
  - *Web hub:* a sale's page has *Print receipt*, which opens a printable page
    sized for 80 mm receipt paper. Any printer the computer can use works.
  - *Register app:* *Print receipt* goes through the phone's print service
    (AirPrint, Android printing), which most Epson and Star receipt printers
    support.
- **Email** (needs `RESEND_API_KEY`): from the sale page or the register's paid
  screen. A typed address isn't stored; the audit log only notes that a
  receipt was sent, with a masked address. A receipt can be sent 5 times an hour.
  When the sale has a customer with an email, the receipt goes there by default.

## Customers

The **Customers** tool (free, needs Point of sale) keeps a list of the people
who buy from the business.

- **At checkout**, the web register and the register app have *Add customer*:
  search by name, email or phone, or add someone new. A customer can also be
  put on, changed or taken off a sale later from its page.
- **Each customer** has a name and, optionally, an email, phone and note.
  Emails are stored lowercased and phones as digits, and no two customers in a
  business share an email or phone. Adding a duplicate picks the customer
  already on file instead.
- **A customer's page** shows their purchases, visits, total spent after
  refunds, and last visit.
- **Permissions:** `customers.use` (look up and add; managers and staff) and
  `customers.manage` (edit and delete; managers).
- **Deleting** a customer removes their details for good. Their sales stay, without a
  customer. Customers belong to one business, like everything else (row-level
  security).

## Loyalty rewards

The **Loyalty rewards** tool (included in every plan, needs Customers) gives customers points
for what they spend and lets them use the points for money off.

- **Earning:** when a sale with a customer is paid, they earn points on whole
  dollars spent after discounts and before tax (default 1 point per $1).
  Refunds take back the points for what was refunded. Changing the customer
  on a paid sale moves its points. Sales made while the tool was off don't
  earn.
- **Using points:** on the payment step (web register or register app), before
  any payment, *Use reward* takes money off (default 100 points = $5). The
  reward is a discount spread over the sale's lines, so tax is charged on
  what's left. It can be taken back off until a payment is made. A voided
  sale gives the points back. A reward can't be worth more than the items.
- **Records:** points are kept in an append-only ledger
  (`loyalty_entries`), so a balance can always be traced. Customer pages show
  the balance and history. Managers (`loyalty.manage`) set the rates on the
  Loyalty page and can add or take away points with a reason.
- **Receipts** show the reward as its own row, plus points earned and the
  new balance.

## Gift cards

The **Gift cards** tool ($4.99/month per location, needs Point of sale) sells gift cards at the
register and takes them as payment.

- **Selling** (web register, *Sell a gift card*): add an amount to the sale,
  with no tax and no discount. Leave the code blank to make up a 16-character
  code; the receipt shows it. Or scan or type a printed card's code. A code
  that's already in use reloads that card. The money goes on the card when
  the sale is paid.
- **Paying** (web register and register app): enter or scan the code. The
  card pays what's due, or as much as it holds; the rest can go on another
  card, cash or a bank card. *Undo* puts the money back while the sale is
  open, and canceling the sale returns it too.
- **Refunds** follow the money. Refunding a sale paid by gift card puts the
  money back on the card. Refunding a gift card purchase takes it off the
  card, so only money still on it can be refunded.
- **Balances** live in an append-only ledger (`gift_card_entries`). The
  register can check a card's balance by code (limited to 30 lookups per 10
  minutes per person). Managers (`giftcards.manage`) see full codes and
  history, give out cards without a sale, adjust balances with a reason, and
  void lost or stolen cards.
- Gift card purchases don't earn loyalty points (spending the card does), and
  aren't counted as product sales in reports. Register summaries and the sales
  report show gift card payments separately.

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

## Public website

The web app's front door (`apps/web/app/(site)`): a home page, Features,
Pricing, and **Start free trial** (`/start`). Prices come from
`GET /public/pricing`, which needs no sign-in and includes any changes the
super admin made, so the website always matches what companies are billed.

- **Signup** picks a plan (`/start?plan=growth` from a pricing card), an
  optional online store, the business name and, for new visitors, an account.
  It creates the business on that plan with the included tools on.
- **Free trial** opens the new business. **Subscribe now** goes straight to
  checkout; the plan is still free until the trial ends, and an online store's
  setup fee is charged then.
- **Email confirmation.** When new accounts must confirm their email, the
  choices wait in a cookie and `/start/confirm` finishes setup once the link
  is opened (the confirmation page links back to it).
- **Dashboards.** Signed-in visitors see *Your dashboard* in the header, which
  lists their businesses. Super admins also get the super admin dashboard
  from their account page and the businesses list.

## Billing

- **Free trial, then a plan.** Every business gets 14 days free, then pays
  for one of three plans (in `packages/modules/src/plans.ts`):

  | Plan    | First location | Each extra location | Open registers per location |
  | ------- | -------------- | ------------------- | --------------------------- |
  | Starter | $39/mo         | $19/mo              | 1                           |
  | Growth  | $59/mo         | $29/mo              | 5                           |
  | Pro     | $79/mo         | $39/mo              | 10                          |

  Every plan includes the point of sale, product catalog, reports, customers,
  loyalty and purchase orders. Inventory, time clock, scheduling, tasks and
  gift cards are paid add-ons at $4.99/mo each, charged per active location
  (the super admin can change any of these prices). Opening a register
  past the plan's limit returns `409 register_limit`.
- **Website options.** Each is $9.99/mo for syncing (the plan's sync fee,
  the same on every plan): *Website sync* for a site the business already has
  (no setup fee), *Online store* (a simple store we set up, $399 once) or
  *Website + online store* (multi-page, $599 once). Any option unlocks website
  sync; without one, turning that tool on returns `409 website_addon_required`.
  A setup fee goes on the Checkout session, or on the next invoice if the
  business already subscribes. Setup fees already paid are remembered
  (`website_setup_paid_minor`), so switching only ever charges the difference.
  The pricing page's "custom website" line links to `CONTACT_EMAIL` when set.
- **Prices are editable.** The super admin changes plan prices, register
  limits and setup fees under Plans & prices, and moves any company between
  plans (a website option added there carries no setup fee). Subscriptions on
  a changed plan update in the background.
- **Stripe does the money.** Subscribing opens Stripe Checkout; invoices, cards
  and cancellation are in Stripe's customer portal. Ample POS creates its
  Stripe products and prices on first use (found by lookup key; a new price
  gets a new key, so existing prices are never edited). Every subscription
  carries the plan as its base item.
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

## Printers

Devices → **Printers** keeps each location's receipt printers and tag (label)
printers, connected by **USB** (plugged into the register), a **network share**
(`\\PC\Printer` or `smb://pc/printer`) or an **IP address** (raw printing,
port 9100 by default). Each has a printer language (ESC/POS or Star for
receipts; ZPL, EPL or TSPL for tags; or the system print dialog) and a paper
or tag size. A receipt printer belongs to one register (at most one each);
tag printers belong to the location and are shared by every device there.
Devices learn theirs from `GET /device` (`printers`).

**Barcode scanners** (Symbol/Zebra and others; USB, Bluetooth or serial) can be
attached to any device at their location: registers, handhelds or kiosks,
more than one each (`/scanners`, `scanners` in `GET /device`). Revoking a
device frees its receipt printer and scanners.

**Printing from the tablet app.** The register app prints a receipt as soon as
a sale is paid, on the register's receipt printer, and opens the cash drawer
plugged into it for cash sales. *Print receipt* prints it again. **Print tags**
(register menu, or the handheld home screen) scans or searches products,
takes a number of copies, and prints on one of the location's tag printers.

- **IP printers** get raw commands straight over the network (port 9100):
  ESC/POS or Star for receipts, ZPL, TSPL or EPL for tags (`react-native-tcp-socket`).
- **USB, network share and "System print dialog" printers** go through the
  tablet's print service (Android printing, AirPrint), so the printer needs
  setting up on the tablet once.
- Without a receipt printer, *Print receipt* opens the print dialog as before.

The commands are built in `packages/receipts/src/printing.ts` (receipts at the
paper width, plain ASCII; tags with name, price and a Code 128 barcode that
narrows on small tags; long names shortened). The tablet keeps its last printer
list, so printing works offline. The TCP module is native: build a new version of
the app to get it. Sending print jobs from the register app is the next step;
this stores the setup the app will use.

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

**Receiving deliveries** (with Purchase orders on, for people who may
receive): *Receive a delivery* on the counts screen, or in the register's
*More* menu, lists the orders placed for the device's location. On an order,
each scan adds one of that item (an item that isn't on the order is called
out). Use − / + or type a number to adjust, or tap *Everything arrived*.
*Receive* puts the stock in, and item costs update unless turned off.
Receiving needs a connection. If it drops, the counts stay on screen and
the retry reuses the delivery's ID, so nothing is counted twice.

Run it with `pnpm --filter @pos/mobile start` and open it in Expo Go or a
development build. Set `PUBLIC_API_URL` for the web app (and the app's server
field) to an address the phone can reach, such as your machine's LAN IP.

## Accounts and sign-in

`AUTH_MODE=password` (the default) uses Ample POS's own accounts.

- **Accounts.** Anyone can create an account with an email and password (at
  least 10 characters). Owners then invite people to a business; an invitee
  creates an account and enters the invitation code. Accounts carried over
  from demo mode keep their businesses when the same email signs up.
- **Passwords** are hashed with scrypt (parameters stored per hash). The
  application role cannot read the credentials, session or reset tables; it
  only calls narrow database functions.
- **Sessions** are opaque tokens (`<id>.<secret>`, only a hash of the secret is
  stored) that last 30 days. Every request checks them, so *Sign out*,
  *Sign out on every device* and password changes take effect at once. The hub
  keeps the token in an httpOnly cookie; the app keeps it in the device keychain.
- **Guessing is throttled**: 10 wrong passwords lock an account for 15
  minutes, and failures are also limited per email and per network address
  (`TRUST_PROXY` says which proxies' `X-Forwarded-For` to believe).
- **Email verification** (on whenever email can be sent). New accounts get a
  confirmation link (valid 24 hours, *Send it again* on the businesses page).
  Until they confirm, they can't create a business or accept an invitation
  locked to their email; open invitation codes still work. Resetting a password
  through an emailed link also confirms the email, so someone who signed up
  with your address can be locked out by you resetting it. Without email
  nothing is held back, since there would be no way to confirm.
- **Changing email** (Your account page) needs the current password. With
  email available, a link goes to the new address and the change happens when
  it is opened; the old address is then told. Links already sent to the old
  address stop working. Without email the change is immediate.
- **Two-step sign-in** (Your account page, per account; recommended for
  owners): an authenticator app (RFC 6238 codes, 30-second steps, one step of
  clock drift) plus 10 one-time recovery codes, stored only as hashes. Signing
  in then takes the password, then a code; the two are linked by a challenge
  that expires after 10 minutes or 5 wrong codes. A code can't be reused.
  Password resets (emailed or from the Team page) still ask for the code, so an
  inbox alone doesn't open the account. Turning it off or making new recovery
  codes needs the password and a code. Someone who loses both their phone and
  their recovery codes can't be let back in from inside Ample POS yet.
- **Forgotten passwords.** With `RESEND_API_KEY` set, *Forgot password?* emails
  a link that works once for an hour. Without email, an owner (or anyone with
  *members.manage*) can create a one-time reset link on the Team page, valid 24
  hours, but only for members who belong to no other business, so one business
  can never take over an account used elsewhere. Resetting signs out every device.

## Card payments (merchant setup)

Each business chooses how it takes cards on **Point of sale → Card payments**
(owners only, `pos.payments.manage`). Cash and gift cards work without either.

- **Ample POS payments (built-in):**
  - A Stripe **Express** account under the platform's Stripe account (Stripe
    Connect). *Set up with Stripe* creates the account and sends the owner to
    Stripe's hosted form (business details, bank account, ID check).
  - When they come back, or when Stripe sends `account.updated` to the Connect
    webhook, the status is re-read from Stripe. Card payments start once
    Stripe enables charges.
  - Payments are direct charges on the business's account (`Stripe-Account`
    header), so money goes straight to them and they pay Stripe's fees.
    **Ample POS takes no fee.**
  - *Payouts and balance* opens their Express dashboard.
- **Their own Stripe account:**
  - The owner pastes a secret or restricted key. It's checked with Stripe,
    stored encrypted with `SECRETS_KEY`, and never shown again.
  - Optionally they add a webhook in their own Stripe at
    `/api/webhooks/stripe/merchant/<business id>` with its signing secret.
- **Who gets the money:** a business that hasn't set up takes no cards with
  `PAYMENTS_PROVIDER=stripe`, so nothing lands in the platform account. The
  older `STRIPE_ACCOUNT` setting still sends everyone to one account. In
  development (`simulated`), businesses without a setup keep the simulator.
- **Refunds:** every card payment records the Stripe account that took it, so
  refunds and checks go back through that account even after the business
  switches setups. Each account also gets its own Stripe Terminal record of
  each store, for card readers.
- **Super admin:** the dashboard shows each company's setup (mode, account,
  whether Stripe lets it charge and pay out, what Stripe still needs, but never
  keys). It flags onboarding that's stuck or accounts Stripe disabled, and can
  switch a company's card payments off with a reason.

Platform settings: `STRIPE_SECRET_KEY` (with Connect enabled on that
account), `STRIPE_WEBHOOK_SECRET`, and `STRIPE_CONNECT_WEBHOOK_SECRET` for a
Connect webhook at `/api/webhooks/stripe-connect` listening to
`account.updated` and `payment_intent.*`.

## Super admin dashboard

`/platform` is for Ample POS staff: everyone whose email is in
`PLATFORM_ADMIN_EMAILS` (comma-separated). With built-in accounts, that
account's email must be confirmed and two-step sign-in turned on, because
the dashboard can switch off any business. Admins get a *Super admin* button
on the *Your businesses* page.

- **Overview:** card setups (built-in, onboarding, own Stripe), monthly recurring revenue, companies by billing standing,
  sales processed across all companies per day (with signups), how customers
  paid, the busiest companies and open issues, over 7, 30 or 90 days.
- **Companies:** search by name, link or member email, and filter by trial,
  subscribed, payment failing, trial ended or suspended. Each company shows
  its MRR, last 30 days of sales, tools, stores, people, last activity and
  issues.
- **A company's page:**
  - its issues, sales and billing, people, stores and devices;
  - every transaction (how it was paid, refunds) and its recent activity;
  - **tools:** turn any tool on or off for this company, make it **free**
    here (on, not billed), or **block** it (off, and the company can't turn it
    back on);
  - **suspend** it with a reason: everyone is locked out (web, registers and
    handhelds) and sees the reason until it's restored. Nothing is deleted.
  - Changes show in the company's own audit log as made by "Ample POS support",
    and billing follows them.
- **Issues**, found from the data and cleared once fixed:
  - subscription payments failing, and trials ended without a subscription;
  - card payments failing (3+ a day) or stuck pending for over 30 minutes;
  - refunds the processor refused;
  - background jobs failing repeatedly;
  - Shopify connections in error, and unresolved store sync problems;
  - registers left open for over a day.
- **Activity:** every company's audit log in one feed, or one company's.
- **Tools & prices:**
  - Switch a tool off for everyone. It disappears for every company and stops
    being billed until switched back on.
  - Change a tool's monthly price, or clear it to go back to the built-in
    price. Subscriptions move to the new price at their next update.
- **Admin log:** every change made from the dashboard, and by whom.

The dashboard reads through its own database role, `pos_platform`. It's
created next to `pos_app` with the same password, and row-level security
applies to it too. Policies let it read every business. It can change only
tool settings, suspensions, the tool catalog and its own log, and can't read
passwords, sessions or two-step secrets.

## Import & export

Business → **Import & export** (needs `data.manage`, owners by default) brings
a business's data in from another system, starting with **QuickBooks POS**.

- **Files:** CSV (or tab-separated) exports of the item list (products and stock), the customer list, or the vendor list.
  Up to 20,000 rows and 10 MB per file. Excel files are saved as CSV first.
- **Presets** match column names: QuickBooks POS (Item Number, Item Name,
  Attribute, Size, Department Name, Regular Price, Average Unit Cost, UPC,
  Alternate Lookup, Qty 1, First/Last Name, EMail, Phone 1, Company...), our
  own export columns, or a best guess for other systems. Any column can be
  re-mapped on the preview.
- **Preview first:** every row is marked new, update or skipped (with the reason),
  and nothing is saved until *Import*. Items match existing ones by SKU / item
  number, then barcode; customers by email, then phone; suppliers by name.
  Items with an attribute or size become variants of one product.
- **Stock:** quantities are set (not added) at the chosen location, as one stock
  adjustment.
- **Undo:** each import records what it created and the values it changed
  (`import_batch_items`), so it can be undone. New products are archived and
  their barcodes freed, changed values restored, the stock adjustment reversed,
  and new customers removed unless they've bought something since.
- **Export** (`GET /exports/{products,customers,suppliers}.csv`) writes the
  same columns the import reads, so a file can be edited and imported back.
  Cells that look like spreadsheet formulas are written as text.

## API for other apps

A business can connect its own systems (a hub, an ERP, a supplier feed) under
**API & webhooks** in the dashboard. The public guide is at `/developers`.

- **API keys** (`ak_<id>_<secret>`) belong to one business and are sent as
  `Authorization: Bearer`. No `X-Tenant-Id` is needed. A key acts for the
  person who created it with the permissions chosen for it, and never more
  than that person has now; read-only keys can't change anything. Only a hash
  is stored. Keys can't manage keys or reach routes outside the business, and
  stop working if the creator leaves. Requests are audited with the key.
- **Every existing endpoint works with a key.** For pushing data in, there are
  two bulk endpoints: `POST /integrations/products/upsert` (by SKU, up to
  500 rows) and `POST /integrations/inventory/levels` (set on-hand counts,
  recorded as one adjustment). Each row succeeds or fails on its own.
- **Change feed.** `GET /events?after=<id>` lists public events (products,
  variants, `inventory.changed` with the new on-hand count, sales, customers,
  purchase orders, locations) oldest first. Keys only see the types their
  permissions allow.
- **Webhooks.** The same events are POSTed to each registered URL with an
  `Ample-Signature: t=…,v1=<HMAC-SHA256 of "t.body">` header, from the
  worker. Failures retry with backoff for about a day, then show as failed with
  a retry button. Events and deliveries are written in the same transaction as
  the change. Webhook URLs on private networks are refused (set
  `WEBHOOK_ALLOW_PRIVATE=true` only for local development). Signing secrets are
  sealed with `SECRETS_KEY` when it's set.

## Deploying to Render

`render.yaml` is a Render Blueprint: one Docker web service and one Postgres
database. In Render choose **New → Blueprint**, connect this GitHub repository
and apply. The first deploy builds the image, creates the restricted database
role, runs the migrations and starts the app at `https://<service>.onrender.com`.

- One container runs both parts (`deploy/start.mjs`): the admin hub on the
  public port and the API on an internal one. The hub forwards `/api/*` to the
  API, so phones pair with and webhooks go to `https://<service>.onrender.com/api`.
- Migrations run on every start and are skipped when already applied.
- Secrets (`APP_DB_PASSWORD`, `SECRETS_KEY`) are generated by Render. Stripe and Shopify keys are added later in the service's Environment
  settings; webhook addresses are under `/api/webhooks/...`.
- Set `PLATFORM_ADMIN_EMAILS` to your own email to use the super admin
  dashboard (see *Super admin dashboard*).
- Sign-in uses built-in accounts (see *Accounts and sign-in*). Add
  `RESEND_API_KEY` and `EMAIL_FROM` to let people reset forgotten passwords by
  email. With a Resend key set, new accounts must confirm their email before
  creating a business, so `EMAIL_FROM` must be on a domain verified in Resend;
  until then Resend only delivers to your own Resend account's address. The
  super admin's **Email** page shows the setup, sends a test email (showing
  Resend's own error), and can confirm someone's address by hand.
- The free plans sleep after 15 idle minutes (the first visit then takes a
  minute, and background jobs pause) and the free database expires after 30
  days. Use paid plans for anything beyond trying it out.

Build and run the same image locally with
`docker build -t ample-pos . && docker run -p 3000:3000 -e ADMIN_DATABASE_URL=... -e APP_DB_PASSWORD=... ample-pos`.

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

Create an account on the sign-in page. `AUTH_MODE=dev` instead lets anyone
sign in as any email (handy for quick local experiments only), and
`AUTH_MODE=jwks` accepts tokens from an external identity provider (Clerk,
Auth0 or similar) via `AUTH_JWKS_URL` and `AUTH_ISSUER`. To try confirmation
and reset emails locally, set `EMAIL_DEV_LOG=true`: emails are printed to the
API's log instead of sent (refused in production).

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
