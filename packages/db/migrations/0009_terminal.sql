-- Card readers on the register app (Stripe Terminal).
--
-- Stripe registers readers to a Terminal Location, which needs a street
-- address, so stores get an address. Each store's Terminal Location is created
-- on first use; `terminal_location` remembers it and the address it was given,
-- so an edited address is pushed to Stripe the next time a register connects.

alter table locations
  -- { line1, line2?, city, state?, postalCode, country } (country: ISO 3166-1 alpha-2)
  add column address jsonb,
  -- { provider, ref, addressHash }
  add column terminal_location jsonb;
