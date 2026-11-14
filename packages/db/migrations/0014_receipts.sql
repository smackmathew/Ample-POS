-- What a business prints on its receipts: { footer, phone, website }.
alter table tenants add column receipt_settings jsonb not null default '{}';
