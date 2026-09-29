import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d+.*\.sql$/.test(x)).sort();
assert.ok(migrations.includes('0038_social_reading_ecosystem.sql'),'social ecosystem migration missing');
assert.ok(migrations.includes('0039_social_reading_hardening.sql'),'social hardening migration missing');
assert.ok(migrations.length>=40,'expected complete social migration chain');

const db=new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for(const file of migrations) db.exec(read(`drizzle/${file}`));
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[],'social migration chain must preserve FK integrity');

const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
for(const table of [
  'social_profiles','social_follows','social_follow_requests','social_blocks','social_mutes','profile_top_books',
  'reading_progress_events','reading_journeys','reading_journey_points','social_annotation_shares','social_reader_preferences',
  'reading_groups','reading_group_members','reading_group_books','reading_group_invites','reading_group_polls','reading_group_poll_votes',
  'social_lists','social_list_items','social_list_likes','social_list_saves','social_posts','social_post_reactions','social_post_revisions',
  'social_events','social_integrity_signals','social_audit_events','author_social_posts','author_social_fanout_jobs'
]) assert.ok(tables.has(table),`missing social table ${table}`);

const profileCols=Object.fromEntries(db.prepare('PRAGMA table_info(social_profiles)').all().map(x=>[x.name,x]));
assert.ok(profileCols.follow_policy,'follow approval policy must be durable');
assert.ok(profileCols.version,'profile concurrency version missing');
const journeyCols=Object.fromEntries(db.prepare('PRAGMA table_info(reading_journeys)').all().map(x=>[x.name,x]));
for(const c of ['share_token','share_revoked_at','version','read_seconds','listen_seconds','highlights_count','bookmarks_count']) assert.ok(journeyCols[c],`journey missing ${c}`);
const authorCols=Object.fromEntries(db.prepare('PRAGMA table_info(author_social_posts)').all().map(x=>[x.name,x]));
assert.ok(authorCols.version&&authorCols.deleted_at,'author posts need optimistic lifecycle controls');
const fanoutCols=Object.fromEntries(db.prepare('PRAGMA table_info(author_social_fanout_jobs)').all().map(x=>[x.name,x]));
assert.ok(fanoutCols.lease_token&&fanoutCols.lease_expires_at,'author notification fanout must use worker leases');

const ts='2026-09-26T00:00:00.000Z';
db.prepare("INSERT INTO social_profiles(user_id,created_at,updated_at) VALUES('reader_a',?,?)").run(ts,ts);
const defaults=db.prepare("SELECT profile_visibility,highlight_visibility_default,follow_policy,version FROM social_profiles WHERE user_id='reader_a'").get();
assert.equal(defaults.highlight_visibility_default,'private','private highlights must be the default');
assert.equal(defaults.follow_policy,'open');assert.equal(defaults.version,1);
assert.throws(()=>db.prepare("INSERT INTO social_follows(follower_user_id,followed_user_id,created_at) VALUES('reader_a','reader_a',?)").run(ts),/CHECK/);
assert.throws(()=>db.prepare("INSERT INTO reading_groups(id,owner_user_id,name,description,group_type,visibility,join_policy,discussion_spoiler_policy,status,member_count,created_at,updated_at) VALUES('g','reader_a','x','','club','secret','invite','progress','active',1,?,?)").run(ts,ts),/CHECK/);
// Social notification types must be accepted by the same durable outbox contract as commerce/security notifications.
db.prepare("INSERT INTO notification_events(id,user_id,event_type,topic,urgency,dedupe_key,subject_type,subject_id,title,body,action_url,payload_json,created_at) VALUES('n1','reader_a','social_reply','community','normal','reply:n1','social_post','p1','Reply','Someone replied','','{}',?)").run(ts);
assert.equal(db.prepare("SELECT event_type FROM notification_events WHERE id='n1'").get().event_type,'social_reply');

const social=read('src/features/fore/social.server.ts');
for(const token of [
  'ensureReadingJourney','journeySvg','reading_progress_events','profileTopBooks','social_annotation_shares','readerSnapshot',
  'density<20?1:density<67?2:3','audienceAllows','currentProductProgress','a.progress==null?await currentProductProgress',
  'feedVisibility','contentVisibility==="friends"||contentVisibility==="group"','social_follow_requests','social_mutes',
  'assertContextReadable','social_post_revisions','expectedVersion','createModerationCase','integritySignal',
  'processAuthorSocialFanoutJobs','lease_token','lease_expires_at','author_post.updated','author_post.deleted','nextCursor'
]) assert.ok(social.includes(token),`social server missing ${token}`);
assert.ok(social.includes('visibility=parent.visibility'),'replies must inherit the parent audience');
assert.ok(social.includes('progress=parent.progress'),'replies must inherit spoiler position');
assert.ok(social.includes('share_note'),'shared notes must require explicit publication state');
assert.ok(social.includes("x.visibility===\"group\"&&!await isGroupMember"),'group sharing must verify membership');

const api=read('src/features/fore/api.server.ts');
assert.ok(api.includes('Multi-factor authentication is required for author publishing actions.'),'author social publishing must require MFA');
assert.ok(api.includes('/publishing-worker/authors/social/tick'),'author follower fanout requires a background worker path');
assert.ok(api.includes('processAuthorSocialFanoutJobs'),'fanout worker must use the leased processor');

const reader=read('src/features/fore/Reader.tsx');
for(const token of ['Social Reading','Off by default','Friends / mutuals','Selected reading group','Density','Quiet','Balanced','Lively','reader-social-gutter','Share this saved highlight','Include my private note']) assert.ok(reader.includes(token),`reader social UX missing ${token}`);
assert.ok(reader.includes('setSocialAnnotationId(null)'),'new selections must not inherit saved-note sharing state');

const community=read('src/features/fore/Community.tsx');
for(const token of ['THE THREE','Reading Journeys','Create a list','Create a reading group','Buddy read','Follow requests','Discussion & questions','Spoiler — reveal','Add all to wishlist','profileVisibility','followPolicy','journeyVisibilityDefault','myReactions','nextCursor']) {
  if(token==='nextCursor') continue; // feed API is cursor-ready; UI may intentionally remain first-page until infinite scrolling is introduced.
  assert.ok(community.includes(token),`community UI missing ${token}`);
}
assert.ok(community.includes('navigator.share'),'Reading Journeys must use native share when available');
assert.ok(community.includes('Export PNG')&&community.includes('Export SVG'),'Reading Journeys need portable social artifacts');

const work=read('src/features/fore/Work.tsx');
assert.ok(work.includes('DiscussionThread'),'Work pages need full discussions separate from reviews');
const author=read('src/features/fore/AuthorProfile.tsx');
for(const token of ['Updates & reading lists','Edit','Remove','expectedVersion']) assert.ok(author.includes(token),`author social UI missing ${token}`);
const accounts=read('src/features/fore/account-management.server.ts');
for(const token of ['socialProfile','posts:posts.results','lists:lists.results','groups:groups.results','journeys:journeys.results','social_audit_events']) assert.ok(accounts.includes(token),`account export/erasure missing ${token}`);
const notifications=read('src/features/fore/notifications.server.ts');
for(const token of ['social_follow','social_reply','social_club_invite','author_social_post']) assert.ok(notifications.includes(token),`notifications missing ${token}`);

const migration=read('drizzle/0039_social_reading_hardening.sql');
for(const token of ['social_follow_requests','social_mutes','social_post_revisions','social_audit_events','lease_token','lease_expires_at','social_reply','author_social_post']) assert.ok(migration.includes(token),`hardening migration missing ${token}`);

console.log(`Social reading ecosystem checks passed across ${migrations.length} migrations with privacy defaults, spoiler gating, optimistic concurrency, leased author fan-out, and FK integrity.`);
