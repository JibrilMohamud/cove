import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd(),migration='drizzle/0028_retail_intelligence_author_review_ranking_analytics.sql',hardening='drizzle/0029_retail_intelligence_hardening.sql';
const sql=fs.readFileSync(path.join(root,migration),'utf8'),hardeningSql=fs.readFileSync(path.join(root,hardening),'utf8');
for(const table of ['author_profiles','author_profile_events','author_profile_revisions','author_follow_preferences','author_release_alert_jobs','author_alert_scan_state','review_provenance_snapshots','review_abuse_signals','review_vote_signals','retail_events','retail_event_outbox','retail_daily_product_metrics','retail_ranking_policy_versions','retail_ranking_snapshots','retail_ranking_entries'])assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`),`missing ${table}`);
assert.match(sql,/authors\.verify/);assert.match(sql,/reviews\.integrity\.manage/);assert.match(sql,/analytics\.operations\.read/);assert.match(sql,/trg_author_profile_events_append_only_update/);assert.match(sql,/trg_author_profile_revision_submitted_content_immutable/);assert.match(sql,/trg_author_profile_revision_no_delete/);assert.match(sql,/trg_review_provenance_immutable_update/);assert.match(sql,/trg_retail_ranking_policy_immutable_update/);assert.match(sql,/wishlist_removes INTEGER/);assert.match(sql,/event_origin TEXT/);assert.match(sql,/reviewed_by_user_id TEXT/);
const ri=fs.readFileSync(path.join(root,'src/features/fore/retail-intelligence.server.ts'),'utf8');
for(const name of ['saveAuthorProfile','reviewAuthorVerification','publisherAuthorProfiles','setAuthorFollow','queueAuthorReleaseAlerts','deriveReviewProvenance','evaluateReviewIntegrity','evaluateReviewHeart','recordRetailEvent','leaseRetailEventOutbox','refreshRetailDailyMetrics','refreshRetailRankings','retailChart','resolveReviewIntegritySignal','upsertRetailRiskLink','createRetailRankingPolicyVersion'])assert.match(ri,new RegExp(`export async function ${name}`),`missing ${name}`);
assert.match(ri,/JSON\.parse\(String\(policyRow\.policy_json/,'ranking engine must execute the active versioned policy');
assert.match(ri,/conversion\*num\(t\.conversion/,'trending must include Cove conversion data');assert.match(ri,/wishlist_removes/,'wishlisting must account for removals');assert.match(ri,/ratingEligible=reviewCount>=/,'top-rated must enforce policy minimum reviews');assert.match(ri,/event_origin/,'events must record authority origin');assert.match(ri,/author_profile_revisions/,'author profile edits must be staged as revisions');assert.match(ri,/publishing_publication_activations/,'new-and-noteworthy and alerts must use Cove first-live evidence');assert.match(ri,/tr\.verifiedWeight/,'top-rated provenance weights must come from the active policy');
assert.doesNotMatch(ri,/download_count/,'Cove commercial ranking must not use Gutenberg popularity');
for(const token of ['ranking_eligible','ranking_weight','quality_reason','unique_viewers','unique_buyers','unique_readers','review_integrity_policy_versions','trg_retail_events_append_only_update','trg_retail_ranking_snapshots_immutable_update'])assert.match(hardeningSql,new RegExp(token),`missing retail hardening ${token}`);
assert.match(ri,/classifyRetailEvent/,'client telemetry must be quality classified');
assert.match(ri,/actor_daily_cap/,'client behavioral events must be capped per actor');
assert.match(ri,/unique_viewers/,'ranking must use unique behavioral actors');
assert.match(ri,/activeReviewIntegrityPolicy/,'review integrity thresholds must be versioned');
assert.match(ri,/voteReciprocity/,'vote-manipulation review must include reciprocity signals');
assert.match(ri,/socialHosts/,'commercial author social links must be type validated');

const search=fs.readFileSync(path.join(root,'src/features/fore/search.server.ts'),'utf8');
for(const key of ['bestselling','trending','most_read','most_wishlisted','noteworthy','top_rated'])assert.match(search,new RegExp(key));
assert.match(search,/fore_bestseller_score/);assert.match(search,/fore_trending_score/);assert.match(search,/fore_rating_score/);
const community=fs.readFileSync(path.join(root,'src/features/fore/community.server.ts'),'utf8');assert.match(community,/deriveReviewProvenance/);assert.match(community,/evaluateReviewIntegrity/);assert.doesNotMatch(community,/trustScore: Number\(r\.trust_score/,'internal trust score must not be exposed in review payloads');assert.doesNotMatch(community,/saved: true, provenance:[^}]+trustScore/,'review-save response must not expose internal trust score');
const reviews=fs.readFileSync(path.join(root,'src/features/fore/Reviews.tsx'),'utf8');assert.match(reviews,/Verified purchase/);assert.match(reviews,/Subscription reader/);assert.match(reviews,/Promotional copy/);
const author=fs.readFileSync(path.join(root,'src/features/fore/AuthorProfile.tsx'),'utf8');assert.match(author,/Verified Author|badgeLabel/);assert.match(author,/Follow author/);assert.match(author,/Upcoming releases/);assert.doesNotMatch(author,/> Email<|\{ email: e\.target\.checked \}/,'UI must not advertise an undelivered email alert channel');
const api=fs.readFileSync(path.join(root,'src/features/fore/api.server.ts'),'utf8');for(const route of ['/authors/','/charts/','/events','/publishing/author-profiles','/admin/moderation/review-integrity','/admin/moderation/account-risk-link','/admin/publishing/ranking-policy','/publishing-worker/analytics/rankings'])assert.ok(api.includes(route),`missing route ${route}`);
const docs=fs.readFileSync(path.join(root,'docs/RETAIL_INTELLIGENCE.md'),'utf8');assert.match(docs,/never use Project Gutenberg `download_count`/i);assert.match(docs,/operational retailer telemetry/i);assert.match(docs,/review provenance/i);
const py=`import sqlite3,glob
con=sqlite3.connect(':memory:')
for f in sorted(glob.glob('drizzle/*.sql')):
 con.executescript(open(f).read())
print(con.execute("select count(*) from retail_ranking_policy_versions where status='active'").fetchone()[0])
print(con.execute("select count(*) from review_integrity_policy_versions where status='active'").fetchone()[0])
print(con.execute("select count(*) from staff_role_permissions where permission='authors.verify'").fetchone()[0])
try:
 con.execute("update retail_ranking_policy_versions set policy_hash='changed' where id='fore-ranking-v1'")
 print('mutable-policy')
except sqlite3.DatabaseError:
 print('immutable-policy')
try:
 con.execute("update review_integrity_policy_versions set policy_hash='changed' where id='fore-review-integrity-v1'")
 print('mutable-review-policy')
except sqlite3.DatabaseError:
 print('immutable-review-policy')`;
const applied=spawnSync('python',['-c',py],{cwd:root,encoding:'utf8'});assert.equal(applied.status,0,applied.stderr);assert.match(applied.stdout,/1\n1\n[1-9].*\nimmutable-policy\nimmutable-review-policy/s);
console.log('retail intelligence checks passed');
