-- Storefront operations hardening: conflict-safe taxonomy URLs and measurable merchandising.

ALTER TABLE merch_slots ADD COLUMN max_placements integer DEFAULT 1 NOT NULL;
ALTER TABLE merch_events ADD COLUMN page_view_id text;
CREATE INDEX idx_merch_events_page_view ON merch_events(visitor_id,page_view_id,placement_id,event_type);

CREATE TABLE storefront_redirects (
  from_path text PRIMARY KEY NOT NULL,
  to_path text NOT NULL,
  status_code integer DEFAULT 301 NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX idx_storefront_redirect_target ON storefront_redirects(to_path);

UPDATE merch_slots SET max_placements=1 WHERE max_placements IS NULL OR max_placements<1;
