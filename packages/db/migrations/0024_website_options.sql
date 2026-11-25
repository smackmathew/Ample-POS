-- Website options: "sync" (keep an existing website in sync, no setup fee)
-- joins the simple and complex online stores. The setup fee paid so far is
-- kept as an amount, so switching between options only ever charges the
-- difference, never the same fee twice.

alter table tenant_billing drop constraint tenant_billing_website_addon_check;
alter table tenant_billing add constraint tenant_billing_website_addon_check check (website_addon in ('sync', 'simple', 'complex'));

alter table platform_website_addons drop constraint platform_website_addons_addon_id_check;
alter table platform_website_addons add constraint platform_website_addons_addon_id_check check (addon_id in ('sync', 'simple', 'complex'));

alter table tenant_billing add column website_setup_paid_minor bigint not null default 0 check (website_setup_paid_minor >= 0);
-- Businesses that already paid (or were given) a store keep credit for it.
update tenant_billing
   set website_setup_paid_minor = case website_addon when 'complex' then 59900 else 39900 end
 where website_addon is not null and website_setup_charged_at is not null;

grant update (website_setup_paid_minor) on tenant_billing to pos_app, pos_platform;

-- The monthly sync fee is now the same on every plan: refresh live subscriptions.
insert into outbox (tenant_id, topic, payload)
select tenant_id, 'billing.items_changed', '{"reason":"website_sync_price"}'::jsonb
  from tenant_billing where website_addon is not null;
