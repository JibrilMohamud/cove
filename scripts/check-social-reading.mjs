import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d+.*\.sql$/.test(x)).sort();
assert.ok(migrations.includes('0038_social_reading_ecosystem.sql'),'social ecosystem migration missing');
assert.ok(migrations.includes('0039_social_reading_hardening.sql'),'social hardening migration missing');
assert.ok(migrations.length>=40,'expected full commercial migration chain');

const db=new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for(const file of migrations) db.exec(read(`drizzle/${file}`));
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[],'migration chain must preserve FK integrity');
const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
for(const t of ['social_profiles','social_follows','social_follow_requests','social_blocks','social_mutes','profile_top_books','reading_progress_events','reading_journeys','reading_journey_points','social_annotation_shares','reading_groups','reading_group_members','reading_group_books','reading_group_invites','social_lists','social_list_items','social_list_likes','social_list_saves','social_posts','social_post_reactions','social_events','reading_group_polls','reading_group_poll_options','reading_group_poll_votes','social_reader_preferences','social_integrity_signals','author_social_posts','social_audit_events','author_social_fanout_jobs']) assert.ok(tables.has(t),`missing ${t}`);

const notificationSql=String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_events'").get()?.sql||'');
for(const event of ['social_follow','social_reply','social_club_invite','author_social_post']) assert.ok(notificationSql.includes(event),`notification contract missing ${event}`);
const groupCols=new Set(db.prepare('PRAGMA table_info(reading_groups)').all().map(x=>x.name));
for(const c of ['version','deleted_at','discussion_spoiler_policy','owner_user_id']) assert.ok(groupCols.has(c),`reading_groups missing ${c}`);
const listCols=new Set(db.prepare('PRAGMA table_info(social_lists)').all().map(x=>x.name));
for(const c of ['version','deleted_at','comments_enabled','visibility']) assert.ok(listCols.has(c),`social_lists missing ${c}`);
const journeyCols=new Set(db.prepare('PRAGMA table_info(reading_journeys)').all().map(x=>x.name));
for(const c of ['share_token','share_revoked_at','version','read_seconds','listen_seconds','highlights_count','notes_count','bookmarks_count']) assert.ok(journeyCols.has(c),`reading_journeys missing ${c}`);

const social=read('src/features/fore/social.server.ts');
for(const token of ['ensureReadingJourney','readerSnapshot','processAuthorSocialFanoutJobs','social_integrity_signals','follow_policy','share_revoked_at','currentProductProgress','duplicate_post_velocity','reaction_velocity','reading_group_poll_votes','social_audit_events']) assert.ok(social.includes(token),`social server missing ${token}`);
assert.ok(social.includes('discussion_spoiler_policy'), 'club discussions must honor the group spoiler policy');
assert.ok(social.includes('x.progress=await currentProductProgress'), 'group progress gating must be derived on the server');
assert.ok(social.includes('x.visibility=parent.visibility'), 'replies must inherit parent audience');
assert.ok(social.includes('x.progress=parent.progress==null?x.progress:Number(parent.progress)'), 'replies must inherit parent spoiler anchor');
assert.ok(social.includes('const progress=a.progress==null?await currentProductProgress'), 'shared highlight progress must use stored/server state');
assert.ok(social.includes('blockedReaders:blocked.results'), 'blocked-reader management must remain reversible');

const ui=read('src/features/fore/Community.tsx');
for(const token of ['function PollView','Reading Journey','The Three','Create a reading group','Blocked readers','List discussion','Club room','Report group','Profile report sent to moderation','Save vote']) assert.ok(ui.includes(token),`community UI missing ${token}`);
assert.doesNotMatch(ui,/contextType="group"[^\n]*progress=\{1\}/,'club room must not unlock all progress-gated discussion');
const reader=read('src/features/fore/Reader.tsx');
for(const token of ['Social Reading','Friends / mutuals','People I follow','Reading group','Public readers','Density','At most three indicators']) assert.ok(reader.includes(token),`reader social UI missing ${token}`);
assert.ok(reader.includes('socialReader.data?.preferences?.enabled'),'social layer must be explicitly enabled');
const author=read('src/features/fore/AuthorProfile.tsx');
for(const token of ['FROM THE AUTHOR','Publish update','author-social']) assert.ok(author.includes(token),`author social surface missing ${token}`);
const api=read('src/features/fore/api.server.ts');
assert.ok(api.includes('Multi-factor authentication is required for author publishing actions.'),'author publishing must require strong auth');
assert.ok(api.includes('processAuthorSocialFanoutJobs'),'author fanout worker must be wired');
const commercialAudio=read('src/features/fore/commercial-audio.server.ts');
assert.ok(commercialAudio.includes('source:"biosync"'),'Biosync handoffs must contribute to Reading Journey progress evidence');
const account=read('src/features/fore/account-management.server.ts');
for(const token of ['social_blocks','social_annotation_shares','social_profiles']) assert.ok(account.includes(token),`account lifecycle missing ${token}`);
const docs=read('docs/SOCIAL_READING_ECOSYSTEM.md');
for(const token of ['off by default','Progress anchors','Reading Journeys','The Three','Private groups are invite-only','social_integrity_signals']) assert.ok(docs.includes(token),`social runbook missing ${token}`);

console.log(`Social reading ecosystem checks passed across ${migrations.length} migrations with FK integrity, privacy/spoiler enforcement, journeys, community, clubs, polls, author fanout, and moderation controls.`);
