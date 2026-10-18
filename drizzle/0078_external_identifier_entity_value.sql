-- Work-detail canonical/alias lookup filters external_identifiers by
-- entity_type AND value, not by scheme. The old scheme-first index forced
-- ~50,000 identifier reads on every first-load work resolution.
-- Add an exact covering lookup without modifying any identifier, redirect,
-- grants, or availability decisions. Fully additive; no SQL call-site change.
CREATE INDEX IF NOT EXISTS idx_external_identifiers_entity_value
  ON external_identifiers(entity_type,value,entity_id);
