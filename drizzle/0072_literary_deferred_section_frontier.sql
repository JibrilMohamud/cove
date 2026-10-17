-- The deferred literary scheduler must find the oldest un-analyzed chapter
-- without repeatedly sorting the entire section evidence table.
-- Keep source-keyed evidence even when AI analysis admission is temporarily paused.
CREATE INDEX IF NOT EXISTS literary_deferred_section_frontier
  ON literary_profile_sections(updated_at,product_id,spine_index,chunk_index,fingerprint,section_id)
  WHERE profile_json IS NULL;
