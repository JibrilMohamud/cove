PRAGMA foreign_keys=ON;

-- Social identity is deliberately separate from authentication/profile basics so privacy
-- defaults and public discoverability can evolve without exposing account records.
CREATE TABLE social_profiles (
  user_id TEXT PRIMARY KEY,
  bio TEXT NOT NULL DEFAULT '',
  profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK(profile_visibility IN ('public','followers','private')),
  replies_policy TEXT NOT NULL DEFAULT 'following' CHECK(replies_policy IN ('everyone','following','mutuals','none')),
  activity_visibility TEXT NOT NULL DEFAULT 'followers' CHECK(activity_visibility IN ('public','followers','private')),
  journey_visibility_default TEXT NOT NULL DEFAULT 'followers' CHECK(journey_visibility_default IN ('public','followers','private')),
  highlight_visibility_default TEXT NOT NULL DEFAULT 'private' CHECK(highlight_visibility_default IN ('public','followers','friends','private')),
  show_currently_reading INTEGER NOT NULL DEFAULT 1 CHECK(show_currently_reading IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE social_follows (
  follower_user_id TEXT NOT NULL,
  followed_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(follower_user_id,followed_user_id),
  CHECK(follower_user_id<>followed_user_id)
);
CREATE INDEX idx_social_follows_followed ON social_follows(followed_user_id,created_at DESC);

CREATE TABLE social_blocks (
  blocker_user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(blocker_user_id,blocked_user_id),
  CHECK(blocker_user_id<>blocked_user_id)
);
CREATE INDEX idx_social_blocks_blocked ON social_blocks(blocked_user_id);

CREATE TABLE profile_top_books (
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 3),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,position),
  UNIQUE(user_id,product_id)
);
CREATE INDEX idx_profile_top_books_product ON profile_top_books(product_id);

-- Exact progress samples are kept separately from the mutable current reading position so
-- finished-book journeys can be reproduced rather than inferred from a final percentage.
CREATE TABLE reading_progress_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('ebook','audiobook','biosync','import')),
  progress REAL NOT NULL CHECK(progress BETWEEN 0 AND 1),
  cfi TEXT NOT NULL DEFAULT '',
  chapter TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  dedupe_key TEXT
);
CREATE UNIQUE INDEX idx_reading_progress_dedupe ON reading_progress_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_reading_progress_user_product ON reading_progress_events(user_id,product_id,occurred_at);

CREATE TABLE reading_journeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  completion_event_id TEXT NOT NULL UNIQUE REFERENCES completion_events(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  title_snapshot TEXT NOT NULL,
  author_snapshot TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  elapsed_days INTEGER NOT NULL DEFAULT 1,
  session_count INTEGER NOT NULL DEFAULT 0,
  read_seconds INTEGER NOT NULL DEFAULT 0,
  listen_seconds INTEGER NOT NULL DEFAULT 0,
  biggest_day_seconds INTEGER NOT NULL DEFAULT 0,
  biggest_day_date TEXT,
  favorite_hour INTEGER CHECK(favorite_hour IS NULL OR favorite_hour BETWEEN 0 AND 23),
  highlights_count INTEGER NOT NULL DEFAULT 0,
  notes_count INTEGER NOT NULL DEFAULT 0,
  bookmarks_count INTEGER NOT NULL DEFAULT 0,
  rating_steps INTEGER,
  review_excerpt TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'followers' CHECK(visibility IN ('public','followers','private')),
  share_token TEXT UNIQUE,
  theme TEXT NOT NULL DEFAULT 'paper' CHECK(theme IN ('paper','night','forest','sunset','ink')),
  show_rating INTEGER NOT NULL DEFAULT 1 CHECK(show_rating IN (0,1)),
  show_time INTEGER NOT NULL DEFAULT 1 CHECK(show_time IN (0,1)),
  show_dates INTEGER NOT NULL DEFAULT 1 CHECK(show_dates IN (0,1)),
  show_pace INTEGER NOT NULL DEFAULT 1 CHECK(show_pace IN (0,1)),
  show_cover INTEGER NOT NULL DEFAULT 1 CHECK(show_cover IN (0,1)),
  favorite_quote TEXT NOT NULL DEFAULT '',
  short_review TEXT NOT NULL DEFAULT '',
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reading_journeys_user_finished ON reading_journeys(user_id,finished_at DESC);
CREATE INDEX idx_reading_journeys_public ON reading_journeys(visibility,finished_at DESC);

CREATE TABLE reading_journey_points (
  journey_id TEXT NOT NULL REFERENCES reading_journeys(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  progress REAL NOT NULL CHECK(progress BETWEEN 0 AND 1),
  read_seconds INTEGER NOT NULL DEFAULT 0,
  listen_seconds INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'ebook',
  PRIMARY KEY(journey_id,sequence)
);

-- Private annotation content remains in annotations. This table is only the user's explicit
-- publication decision and never changes the private-note default.
CREATE TABLE social_annotation_shares (
  annotation_id TEXT PRIMARY KEY REFERENCES annotations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','followers','friends','group')),
  audience_group_id TEXT,
  share_note INTEGER NOT NULL DEFAULT 0 CHECK(share_note IN (0,1)),
  progress REAL NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 1),
  passage_hash TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK(moderation_status IN ('visible','limited','hidden','removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((visibility='group' AND audience_group_id IS NOT NULL) OR (visibility<>'group' AND audience_group_id IS NULL))
);
CREATE INDEX idx_annotation_shares_product ON social_annotation_shares(product_id,progress,visibility,moderation_status);
CREATE INDEX idx_annotation_shares_work ON social_annotation_shares(work_id,visibility,moderation_status);

CREATE TABLE reading_groups (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  group_type TEXT NOT NULL DEFAULT 'club' CHECK(group_type IN ('buddy','private_group','club')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('public','unlisted','private')),
  join_policy TEXT NOT NULL DEFAULT 'invite' CHECK(join_policy IN ('open','request','invite')),
  discussion_spoiler_policy TEXT NOT NULL DEFAULT 'progress' CHECK(discussion_spoiler_policy IN ('progress','chapter','manual')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','suspended')),
  member_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reading_groups_visibility ON reading_groups(visibility,status,updated_at DESC);

CREATE TABLE reading_group_members (
  group_id TEXT NOT NULL REFERENCES reading_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','moderator','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','requested','invited','left','removed')),
  joined_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(group_id,user_id)
);
CREATE INDEX idx_group_members_user ON reading_group_members(user_id,status,updated_at DESC);

CREATE TABLE reading_group_books (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES reading_groups(id) ON DELETE CASCADE,
  work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  title_snapshot TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','current','completed','skipped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_group_books_group ON reading_group_books(group_id,status,position);

CREATE TABLE reading_group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES reading_groups(id) ON DELETE CASCADE,
  invited_by_user_id TEXT NOT NULL,
  invited_user_id TEXT,
  token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  accepted_at TEXT
);
CREATE UNIQUE INDEX idx_group_invite_token ON reading_group_invites(token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE social_lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','followers','private')),
  ranked INTEGER NOT NULL DEFAULT 1 CHECK(ranked IN (0,1)),
  comments_enabled INTEGER NOT NULL DEFAULT 1 CHECK(comments_enabled IN (0,1)),
  moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK(moderation_status IN ('visible','limited','hidden','removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,slug)
);
CREATE INDEX idx_social_lists_public ON social_lists(visibility,moderation_status,updated_at DESC);

CREATE TABLE social_list_items (
  list_id TEXT NOT NULL REFERENCES social_lists(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  PRIMARY KEY(list_id,product_id),
  UNIQUE(list_id,position)
);
CREATE INDEX idx_social_list_items_product ON social_list_items(product_id);

CREATE TABLE social_list_likes (
  list_id TEXT NOT NULL REFERENCES social_lists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(list_id,user_id)
);
CREATE TABLE social_list_saves (
  list_id TEXT NOT NULL REFERENCES social_lists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(list_id,user_id)
);

-- One generic post model handles work discussions/questions, margin threads, list comments,
-- club rooms and profile replies while preserving context-specific policies.
CREATE TABLE social_posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  context_type TEXT NOT NULL CHECK(context_type IN ('work','margin','group','list','profile')),
  context_id TEXT NOT NULL,
  parent_id TEXT REFERENCES social_posts(id) ON DELETE CASCADE,
  root_id TEXT,
  post_type TEXT NOT NULL DEFAULT 'discussion' CHECK(post_type IN ('discussion','question','reply','comment','prompt')),
  work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  group_id TEXT REFERENCES reading_groups(id) ON DELETE CASCADE,
  list_id TEXT REFERENCES social_lists(id) ON DELETE CASCADE,
  target_user_id TEXT,
  cfi TEXT NOT NULL DEFAULT '',
  chapter TEXT NOT NULL DEFAULT '',
  progress REAL CHECK(progress IS NULL OR (progress BETWEEN 0 AND 1)),
  passage_text TEXT NOT NULL DEFAULT '',
  passage_hash TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','followers','friends','group','private')),
  spoiler INTEGER NOT NULL DEFAULT 0 CHECK(spoiler IN (0,1)),
  moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK(moderation_status IN ('visible','limited','hidden','removed')),
  reply_count INTEGER NOT NULL DEFAULT 0,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_social_posts_context ON social_posts(context_type,context_id,parent_id,moderation_status,created_at DESC);
CREATE INDEX idx_social_posts_margin ON social_posts(product_id,progress,passage_hash,moderation_status) WHERE context_type='margin';
CREATE INDEX idx_social_posts_user ON social_posts(user_id,created_at DESC);

CREATE TABLE social_post_reactions (
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  reaction TEXT NOT NULL DEFAULT 'heart' CHECK(reaction IN ('heart','insightful','funny','agree')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(post_id,user_id,reaction)
);
CREATE INDEX idx_social_reactions_recent ON social_post_reactions(post_id,created_at DESC);

CREATE TABLE social_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('journey_finished','review_published','top_books_changed','list_created','list_updated','club_joined','club_started','followed_user','shared_highlight','discussion_started')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'followers' CHECK(visibility IN ('public','followers','private')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK(moderation_status IN ('visible','limited','hidden','removed')),
  created_at TEXT NOT NULL,
  dedupe_key TEXT
);
CREATE UNIQUE INDEX idx_social_events_dedupe ON social_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_social_events_feed ON social_events(visibility,moderation_status,created_at DESC);
CREATE INDEX idx_social_events_user ON social_events(user_id,created_at DESC);

CREATE TABLE reading_group_polls (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES reading_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  multiple_choice INTEGER NOT NULL DEFAULT 0 CHECK(multiple_choice IN (0,1)),
  closes_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE reading_group_poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES reading_group_polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE(poll_id,position)
);
CREATE TABLE reading_group_poll_votes (
  poll_id TEXT NOT NULL REFERENCES reading_group_polls(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES reading_group_poll_options(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(poll_id,option_id,user_id)
);

CREATE TABLE social_reader_preferences (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  audience_mode TEXT NOT NULL DEFAULT 'friends' CHECK(audience_mode IN ('friends','following','group','public')),
  group_id TEXT REFERENCES reading_groups(id) ON DELETE SET NULL,
  show_discussions INTEGER NOT NULL DEFAULT 1 CHECK(show_discussions IN (0,1)),
  show_highlights INTEGER NOT NULL DEFAULT 1 CHECK(show_highlights IN (0,1)),
  show_reactions INTEGER NOT NULL DEFAULT 0 CHECK(show_reactions IN (0,1)),
  density INTEGER NOT NULL DEFAULT 35 CHECK(density BETWEEN 0 AND 100),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- Social-fraud signals are intentionally separate from moderation actions. Financial/community
-- fraud can suppress ranking without silently removing user speech.
CREATE TABLE social_integrity_signals (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('post','list','profile','group','follow_cluster','reaction_cluster')),
  subject_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  disposition TEXT NOT NULL DEFAULT 'open' CHECK(disposition IN ('open','confirmed','dismissed','mitigated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_social_integrity_open ON social_integrity_signals(disposition,score DESC,created_at DESC);

-- Verified author/creator social publishing. These posts are separate from personal-reader
-- profiles and can only be created by authorized members of the verified publishing account.
CREATE TABLE author_social_posts (
  id TEXT PRIMARY KEY,
  contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL,
  post_type TEXT NOT NULL DEFAULT 'update' CHECK(post_type IN ('update','reading_list','announcement')),
  body TEXT NOT NULL,
  list_id TEXT REFERENCES social_lists(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK(moderation_status IN ('visible','limited','hidden','removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_author_social_posts_author ON author_social_posts(contributor_id,moderation_status,created_at DESC);
