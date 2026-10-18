-- Source-of-truth-only negative gate for subscription and library search flags.
-- Exactly the two effective-grant channel branches in the authoritative
-- product_channel_availability view. This index stores candidate grant rows,
-- NEVER a denormalized rights grant/approval or a stale eligibility decision.
-- It is additive and includes new, updated and revoked grant candidates
-- transactionally via SQLite; the full legal view always handles positives.
--
-- Deploy this migration and verify sqlite_master BEFORE any application SQL
-- uses INDEXED BY idx_rights_secondary_channel_potential.
CREATE INDEX IF NOT EXISTS idx_rights_secondary_channel_potential
  ON rights_grants(status, sales_channel, subscription_permitted, library_permitted)
  WHERE sales_channel IN ('subscription','library')
     OR (sales_channel='retail' AND (subscription_permitted=1 OR library_permitted=1));
