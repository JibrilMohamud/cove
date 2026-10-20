-- Bounded candidate authorization must not scan the complete series-membership table
-- once per edition. Both the edition-side gate and prior-volume lookup are covering.
CREATE INDEX IF NOT EXISTS idx_series_memberships_edition_position
  ON series_memberships(edition_id,position,series_id);
CREATE INDEX IF NOT EXISTS idx_series_memberships_series_position
  ON series_memberships(series_id,position,edition_id);
