import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'API guide · Ample POS' };

const READ: [string, string, string][] = [
  ['GET /locations', 'Stores and their time zones', '—'],
  ['GET /catalog/products?search=&status=&limit=&offset=', 'Products with their variants', 'catalog.read'],
  ['GET /catalog/products/{id}', 'One product', 'catalog.read'],
  ['GET /catalog/variants?after=&limit=', 'Every sellable variant with barcodes, paged by `after` (fast full export)', 'catalog.read'],
  ['GET /catalog/lookup?code=', 'Find a variant by SKU or barcode', 'catalog.read'],
  ['GET /inventory/levels?locationId=&limit=&offset=', 'On-hand counts at a location', 'inventory.read'],
  ['GET /inventory/movements?locationId=&variantId=&before=', 'Stock history, newest first', 'inventory.read'],
  ['GET /sales?status=&before=&limit=', 'Sales, newest first', 'pos.sell'],
  ['GET /sales/{id}', 'One sale with lines, payments and refunds', 'pos.sell'],
  ['GET /customers?search=&limit=&offset=', 'Customers', 'customers.use'],
  ['GET /customers/{id}', 'One customer with their sales', 'customers.use'],
  ['GET /reports/sales?from=&to=&locationId=', 'Daily totals, payment methods, top products', 'reports.read'],
  ['GET /reports/inventory', 'Stock value by location', 'reports.read'],
  ['GET /purchase-orders, /suppliers', 'Purchasing', 'purchasing.receive'],
  ['GET /gift-cards', 'Gift cards and balances', 'giftcards.manage'],
];

const WRITE: [string, string, string][] = [
  ['POST /integrations/products/upsert', 'Create or update up to 500 products by SKU', 'catalog.manage'],
  ['POST /integrations/inventory/levels', 'Set on-hand counts at a location (up to 1,000 rows)', 'inventory.adjust'],
  ['POST /inventory/receipts', 'Add stock that arrived', 'inventory.adjust'],
  ['POST /inventory/adjustments', 'Add or remove stock with a reason', 'inventory.adjust'],
  ['POST /inventory/transfers', 'Move stock between locations', 'inventory.adjust'],
  ['POST /catalog/products, PATCH /catalog/products/{id}, PATCH /catalog/variants/{id}', 'Edit the catalog item by item', 'catalog.manage'],
  ['POST /customers, PATCH /customers/{id}', 'Add and edit customers', 'customers.use / customers.manage'],
];

export default async function ApiGuidePage() {
  const events = await api<{ type: string; description: string; permission: string | null }[]>('/events/catalog', { anonymous: true }).catch(() => []);
  return (
    <main className="mx-auto max-w-4xl px-4 py-14">
      <p className="text-sm font-medium text-brand">For developers</p>
      <h1 className="mt-1 text-4xl font-semibold tracking-tight">Ample POS API</h1>
      <p className="mt-3 text-lg text-stone-600">
        Connect your own systems, like a hub, an ERP or a supplier feed, to a business on Ample POS: read everything, push products and stock in, and hear about changes
        as they happen.
      </p>

      <Section title="1. Get a key">
        <p>
          The business owner opens <strong>API &amp; webhooks</strong> in their dashboard and creates a key. They choose read only or read and write, and which areas it can
          use. The full key is shown once; it looks like <Code>ak_4c1f…_Yx3…</Code>.
        </p>
        <p>
          A key belongs to one business. It acts for the person who created it and can never do more than they can. If they leave the business, or the key is revoked, it
          stops working.
        </p>
      </Section>

      <Section title="2. Make requests">
        <p>
          Send the key as a bearer token to <Code>https://&lt;your Ample POS address&gt;/api</Code>. The dashboard shows the exact address. You don’t need a business ID header:
          the key already says which business it’s for.
        </p>
        <Pre>{`curl https://ample-pos.onrender.com/api/catalog/products?limit=50 \\
  -H "Authorization: Bearer ak_..."`}</Pre>
        <ul className="list-disc space-y-1 pl-5">
          <li>Money is in cents: <Code>priceMinor: 1250</Code> is $12.50.</li>
          <li>IDs are UUIDs. Times are ISO 8601 in UTC.</li>
          <li>
            Errors are JSON with <Code>statusCode</Code> and <Code>message</Code>. <Code>401</Code> means a bad or revoked key, <Code>403</Code> a missing permission or a
            read-only key, <Code>409</Code> a conflict such as a duplicate SKU or a stale <Code>version</Code>.
          </li>
          <li>
            Many writes accept an <Code>idempotencyKey</Code>: send the same one when retrying and the change is applied only once.
          </li>
        </ul>
      </Section>

      <Section title="Read data">
        <Endpoints rows={READ} />
      </Section>

      <Section title="Push data in">
        <Endpoints rows={WRITE} />
        <p className="font-medium text-stone-900">Upsert products by SKU</p>
        <Pre>{`POST /integrations/products/upsert
{
  "products": [
    { "sku": "TEE-RED-M", "name": "Red tee", "variantName": "Medium",
      "priceMinor": 2500, "costMinor": 900, "category": "Apparel", "barcodes": ["0123456789012"] },
    { "sku": "MUG-1", "name": "Mug", "priceMinor": 1200 }
  ]
}
→ { "created": 1, "updated": 1, "errors": 0,
    "results": [{ "sku": "TEE-RED-M", "status": "updated", "productId": "…", "variantId": "…" }, …] }`}</Pre>
        <p>A SKU that exists is updated (matching ignores upper/lower case); a new one creates a product. Each row succeeds or fails on its own.</p>
        <p className="font-medium text-stone-900">Set stock levels</p>
        <Pre>{`POST /integrations/inventory/levels
{
  "locationId": "…",
  "levels": [{ "sku": "TEE-RED-M", "onHand": 12 }, { "variantId": "…", "onHand": 0 }],
  "idempotencyKey": "hub-sync-2026-11-24T10:00"
}
→ { "set": 1, "unchanged": 1, "errors": 0,
    "results": [{ "sku": "TEE-RED-M", "status": "set", "before": 9, "after": 12 }, …] }`}</Pre>
        <p>Give the count you want, not the difference. Ample POS records the difference as one stock adjustment, so history and reports stay correct.</p>
      </Section>

      <Section title="Follow changes: the feed">
        <p>
          <Code>GET /events?after=&lt;last id&gt;&amp;types=inventory.changed,sale.completed&amp;limit=100</Code> returns events oldest first, with <Code>next</Code> to pass as{' '}
          <Code>after</Code> next time and <Code>hasMore</Code>. Store the last id you handled and you’ll never miss a change, even after downtime. Keys only see event types
          their permissions allow.
        </p>
      </Section>

      <Section title="Follow changes: webhooks">
        <p>
          Add a webhook in the dashboard, or from your app with a key that has <Code>api.manage</Code>: <Code>POST /webhooks</Code> with{' '}
          <Code>{`{ "url": "https://…", "events": ["inventory.changed"] }`}</Code>. The response includes the signing secret (<Code>whsec_…</Code>), shown once.
        </p>
        <p>Each event is a POST with this body. Answer with any 2xx within 10 seconds; anything else is retried with backoff for about a day.</p>
        <Pre>{`{
  "id": "evt_1042",
  "type": "inventory.changed",
  "createdAt": "2026-11-24T10:00:00.000Z",
  "businessId": "…",
  "data": {
    "kind": "sale",
    "lines": [{ "locationId": "…", "variantId": "…", "sku": "TEE-RED-M",
                "quantityDelta": -1, "reason": "sale", "onHand": 11 }]
  }
}`}</Pre>
        <p>
          Check the <Code>Ample-Signature</Code> header (<Code>t=&lt;unix time&gt;,v1=&lt;hex&gt;</Code>): it’s an HMAC-SHA256 of <Code>&lt;t&gt;.&lt;raw body&gt;</Code> with your
          secret. Reject old timestamps, and use the event <Code>id</Code> to ignore repeats.
        </p>
        <Pre>{`import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromAmplePos(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(\`\${parts.t}.\${rawBody}\`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 ?? ''));
}`}</Pre>
      </Section>

      <Section title="Event types">
        <div className="overflow-x-auto rounded-xl border border-stone-200">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Needs</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.type} className="border-t border-stone-100">
                  <td className="px-4 py-2">
                    <Code>{e.type}</Code>
                  </td>
                  <td className="px-4 py-2 text-stone-600">{e.description}</td>
                  <td className="px-4 py-2 text-stone-500">{e.permission ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>Events carry IDs and what changed; fetch the record for full details.</p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-12 space-y-4 text-stone-700">
      <h2 className="text-2xl font-semibold tracking-tight text-stone-900">{title}</h2>
      {children}
    </section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-stone-100 px-1.5 py-0.5 text-[0.85em] text-stone-800">{children}</code>;
}

function Pre({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-xl bg-stone-900 p-4 text-sm leading-relaxed text-stone-100">{children}</pre>;
}

function Endpoints({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-stone-200">
      <table className="w-full text-sm">
        <thead className="bg-stone-50 text-left text-stone-500">
          <tr>
            <th className="px-4 py-2">Endpoint</th>
            <th className="px-4 py-2">What</th>
            <th className="px-4 py-2">Needs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([path, what, perm]) => (
            <tr key={path} className="border-t border-stone-100 align-top">
              <td className="px-4 py-2">
                <code className="text-xs break-all text-stone-800">{path}</code>
              </td>
              <td className="px-4 py-2 text-stone-600">{what}</td>
              <td className="px-4 py-2 text-xs text-stone-500">{perm}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
