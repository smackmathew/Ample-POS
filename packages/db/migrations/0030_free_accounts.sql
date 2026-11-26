-- Businesses Ample POS has made free (staff, testing, partners): never billed,
-- and paid tools never go read-only. Set from the super admin dashboard.
alter table tenant_billing add column free_since timestamptz, add column free_reason text;
grant update (free_since, free_reason) on tenant_billing to pos_platform;
