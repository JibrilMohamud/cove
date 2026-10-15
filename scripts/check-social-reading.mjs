import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const migrations = fs
  .readdirSync(path.join(root, "drizzle"))
  .filter((x) => /^\d+.*\.sql$/.test(x))
  .sort();
assert.ok(
  migrations.includes("0038_social_reading_ecosystem.sql"),
  "social ecosystem migration missing",
);
assert.ok(
  migrations.includes("0039_social_reading_hardening.sql"),
  "social hardening migration missing",
);
assert.ok(migrations.length >= 40, "expected full commercial migration chain");

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=ON");
for (const file of migrations) db.exec(read(`drizzle/${file}`));
assert.deepEqual(
  db.prepare("PRAGMA foreign_key_check").all(),
  [],
  "migration chain must preserve FK integrity",
);
const tables = new Set(
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((x) => x.name),
);
for (const t of [
  "social_profiles",
  "social_follows",
  "social_follow_requests",
  "social_blocks",
  "social_mutes",
  "profile_top_books",
  "reading_progress_events",
  "reading_journeys",
  "reading_journey_points",
  "social_annotation_shares",
  "reading_groups",
  "reading_group_members",
  "reading_group_books",
  "reading_group_invites",
  "social_lists",
  "social_list_items",
  "social_list_likes",
  "social_list_saves",
  "social_posts",
  "social_post_reactions",
  "social_events",
  "reading_group_polls",
  "reading_group_poll_options",
  "reading_group_poll_votes",
  "social_reader_preferences",
  "social_integrity_signals",
  "author_social_posts",
  "social_audit_events",
  "author_social_fanout_jobs",
])
  assert.ok(tables.has(t), `missing ${t}`);

const notificationSql = String(
  db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_events'")
    .get()?.sql || "",
);
for (const event of ["social_follow", "social_reply", "social_club_invite", "author_social_post"])
  assert.ok(notificationSql.includes(event), `notification contract missing ${event}`);
const groupCols = new Set(
  db
    .prepare("PRAGMA table_info(reading_groups)")
    .all()
    .map((x) => x.name),
);
for (const c of ["version", "deleted_at", "discussion_spoiler_policy", "owner_user_id"])
  assert.ok(groupCols.has(c), `reading_groups missing ${c}`);
const listCols = new Set(
  db
    .prepare("PRAGMA table_info(social_lists)")
    .all()
    .map((x) => x.name),
);
for (const c of ["version", "deleted_at", "comments_enabled", "visibility"])
  assert.ok(listCols.has(c), `social_lists missing ${c}`);
const journeyCols = new Set(
  db
    .prepare("PRAGMA table_info(reading_journeys)")
    .all()
    .map((x) => x.name),
);
for (const c of [
  "share_token",
  "share_revoked_at",
  "version",
  "read_seconds",
  "listen_seconds",
  "highlights_count",
  "notes_count",
  "bookmarks_count",
])
  assert.ok(journeyCols.has(c), `reading_journeys missing ${c}`);

console.log(
  `PASS: social schema across ${migrations.length} migrations and foreign-key integrity. User journeys are enforced by test:social-journeys and the browser-device matrix.`,
);
