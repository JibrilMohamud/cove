-- Independent social-game state: no commerce, legal-rights, entitlement, or catalog
-- mutations. Only a validated, bounded Community tournament writer may use it.
CREATE TABLE community_tournaments (
  id TEXT PRIMARY KEY,
  host_user_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 4 AND 100),
  entrants_count INTEGER NOT NULL CHECK(entrants_count IN (4,8,16)),
  rounds_total INTEGER NOT NULL CHECK(rounds_total IN (2,3,4)),
  current_round INTEGER NOT NULL DEFAULT 1 CHECK(current_round BETWEEN 1 AND 4),
  round_duration_minutes INTEGER NOT NULL CHECK(round_duration_minutes IN (60,1440,10080)),
  round_deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live' CHECK(status IN ('live','completed','cancelled')),
  champion_entry_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((status='completed' AND champion_entry_id IS NOT NULL) OR
    (status<>'completed' AND champion_entry_id IS NULL))
);
CREATE INDEX idx_community_tournaments_live
 ON community_tournaments(status,round_deadline,id);
CREATE INDEX idx_community_tournaments_host
 ON community_tournaments(host_user_id,created_at DESC);

CREATE TABLE community_tournament_entries (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES community_tournaments(id) ON DELETE CASCADE,
  seed INTEGER NOT NULL CHECK(seed BETWEEN 1 AND 16),
  product_id TEXT NOT NULL,
  public_product_id TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  source_external_id TEXT NOT NULL DEFAULT '',
  UNIQUE(tournament_id,seed),
  UNIQUE(tournament_id,product_id)
);
CREATE INDEX idx_community_tournament_entries_tournament
 ON community_tournament_entries(tournament_id,seed);

CREATE TABLE community_tournament_matches (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES community_tournaments(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK(round_number BETWEEN 1 AND 4),
  slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 8),
  entry_a_id TEXT NOT NULL REFERENCES community_tournament_entries(id),
  entry_b_id TEXT NOT NULL REFERENCES community_tournament_entries(id),
  status TEXT NOT NULL CHECK(status IN ('open','closed')),
  winner_entry_id TEXT REFERENCES community_tournament_entries(id),
  final_a INTEGER,
  final_b INTEGER,
  opened_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK(entry_a_id<>entry_b_id),
  CHECK((status='open' AND winner_entry_id IS NULL AND final_a IS NULL AND final_b IS NULL AND closed_at IS NULL)
   OR (status='closed' AND winner_entry_id IN (entry_a_id,entry_b_id)
      AND final_a>=0 AND final_b>=0 AND closed_at IS NOT NULL)),
  UNIQUE(tournament_id,round_number,slot)
);
CREATE INDEX idx_community_tournament_matches_round
 ON community_tournament_matches(tournament_id,round_number,slot);

CREATE TABLE community_tournament_votes (
  match_id TEXT NOT NULL REFERENCES community_tournament_matches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES community_tournament_entries(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(match_id,user_id)
);
CREATE INDEX idx_community_tournament_votes_match_choice
 ON community_tournament_votes(match_id,entry_id);

-- Fail closed even if a caller races a vote after the deadline or tries to
-- vote for a different match's entry. These guarantees are DB-enforced.
CREATE TRIGGER community_tournament_vote_guard_insert
BEFORE INSERT ON community_tournament_votes
BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM community_tournament_matches m
  JOIN community_tournaments t ON t.id=m.tournament_id
  WHERE m.id=NEW.match_id AND t.status='live' AND m.status='open'
    AND m.round_number=t.current_round
    AND m.closes_at=t.round_deadline
    AND julianday(m.closes_at)>julianday('now')
    AND NEW.entry_id IN (m.entry_a_id,m.entry_b_id)
 ) THEN RAISE(ABORT,'tournament_vote_closed_or_invalid') END;
END;
CREATE TRIGGER community_tournament_vote_guard_update
BEFORE UPDATE ON community_tournament_votes
BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM community_tournament_matches m
  JOIN community_tournaments t ON t.id=m.tournament_id
  WHERE m.id=NEW.match_id AND t.status='live' AND m.status='open'
    AND m.round_number=t.current_round
    AND m.closes_at=t.round_deadline
    AND julianday(m.closes_at)>julianday('now')
    AND NEW.entry_id IN (m.entry_a_id,m.entry_b_id)
 ) THEN RAISE(ABORT,'tournament_vote_closed_or_invalid') END;
END;
