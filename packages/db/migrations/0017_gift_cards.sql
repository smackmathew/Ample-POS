-- Gift cards: sold as a tax-free line on a sale, spent as a payment method.
--
-- A card's balance is the sum of its entries (gift_card_entries), like the
-- loyalty ledger. Money goes on when the sale selling it completes ("load"),
-- comes off when it pays for a sale ("redeem"), and moves back for refunds
-- and voids. Codes are kept so they can be printed again; only people who
-- manage gift cards see them in full.

create table gift_cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- Uppercase letters and digits, no separators.
  code text not null check (code ~ '^[A-Z0-9]{8,32}$'),
  status text not null default 'active' check (status in ('active', 'void')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

-- Selling a gift card is a sale line with no product, no tax and no discount.
alter table sale_lines add column kind text not null default 'item' check (kind in ('item', 'gift_card'));
alter table sale_lines alter column variant_id drop not null;
alter table sale_lines add column gift_card_code text;
alter table sale_lines add constraint sale_lines_kind check (
  (kind = 'item' and variant_id is not null and gift_card_code is null)
  or (kind = 'gift_card' and variant_id is null and gift_card_code is not null and discount_minor = 0 and tax_minor = 0 and quantity = 1)
);

alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check check (method in ('cash', 'card', 'gift_card'));
alter table payments add column gift_card_id uuid;
alter table payments add constraint payments_gift_card_fk foreign key (tenant_id, gift_card_id) references gift_cards (tenant_id, id);
alter table payments add constraint payments_gift_card check ((method = 'gift_card') = (gift_card_id is not null));

create table gift_card_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  gift_card_id uuid not null,
  kind text not null check (kind in ('load', 'redeem', 'refund', 'adjust', 'void')),
  amount_minor bigint not null check (amount_minor <> 0),
  sale_id uuid,
  payment_id uuid,
  refund_id uuid,
  note text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, gift_card_id) references gift_cards (tenant_id, id),
  foreign key (tenant_id, sale_id) references sales (tenant_id, id)
);
create index gift_card_entries_card on gift_card_entries (gift_card_id, created_at);

alter table gift_cards enable row level security;
alter table gift_card_entries enable row level security;
create policy tenant_isolation on gift_cards using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
create policy tenant_isolation on gift_card_entries using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
grant select, insert on gift_cards to pos_app;
grant update (status) on gift_cards to pos_app;
-- The ledger is append-only for the app.
grant select, insert on gift_card_entries to pos_app;
