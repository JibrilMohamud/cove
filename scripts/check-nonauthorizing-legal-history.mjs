/* eslint-disable prettier/prettier -- Review exact immutable history SQL; never reclassify restoration inputs. */
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {currentWriterSites,REVIEW_PATH} from "./reconcile-canonical-writers.mjs";

const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
const current=currentWriterSites();
const lifecycle=current.filter(x=>x.table==="publishing_lifecycle_events");
assert.ok(lifecycle.length<=9,
  "Only physically retired owner-command SQL may reduce restoration-sensitive lifecycle history counts");
for(const site of lifecycle){
  const row=review.sites.find(x=>x.siteId===site.siteId);
  assert.equal(row?.disposition,"owner-command-required",
    "Publishing lifecycle history drives restoration and may NOT be waived");
  assert.equal(row?.productionOwnerGuarded,false);
}
// An authenticated staff restoration consumes historical from_state and can
// change the real current lifecycle; the source demonstrates history is NOT
// harmless telemetry. Keep all remaining direct lifecycle events authorizing until owner-first migration.
const moderation=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const retiredModeration=JSON.parse(readFileSync("docs/architecture/retired-moderation-owner-lineage.json","utf8"));
assert.equal(retiredModeration.retired.filter(x=>x.table==="publishing_lifecycle_events").length,1,
  "Removed lifecycle event must have immutable owner-only source lineage");
assert.match(moderation,/const privateModeration=/);
assert.doesNotMatch(readFileSync("src/features/fore/moderation.server.ts","utf8"),/INSERT INTO publishing_lifecycle_events/);
assert.match(moderation,/SELECT from_state FROM publishing_lifecycle_events WHERE lifecycle_id=\? AND to_state IN \('suppressed','takedown'\)/);
assert.match(moderation,/restoredFrom\s*=\s*prior\?\.from_state/);
assert.match(moderation,/const target\s*=\s*restoring\s*&&\s*restoredFrom/);

const table="publication_version_distribution_events";
const historical=current.filter(x=>x.table===table);
assert.equal(historical.length,0,"Distribution events must be owned privately");
const lineage=JSON.parse(readFileSync("docs/architecture/retired-negative-commercial-delivery-owner-lineage.json","utf8"));
const retired=lineage.retired.filter(x=>x.table===table&&x.disposition==="non-authorizing-write");
assert.equal(retired.length,1,"Distribution history must retain immutable owner-only lineage");
assert.ok(!review.sites.some(x=>x.siteId===retired[0].siteId));
const worker=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const sql="INSERT OR IGNORE INTO publication_version_distribution_events(id,publication_version_id,from_status,to_status,allow_existing_owners,reason_code,reason_detail,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)";
assert.ok(worker.includes(sql),"Owner must append immutable history during withdrawal");
assert.match(worker,/if\(route==="\/delivery\/private-negative"\)/);
assert.doesNotMatch(readFileSync("src/features/fore/delivery.server.ts","utf8"),/INSERT INTO publication_version_distribution_events/);

const db=new DatabaseSync(":memory:");
try{
  db.exec("CREATE TABLE publication_version_distribution_controls(publication_version_id TEXT PRIMARY KEY,distribution_status TEXT,allow_existing_owners INTEGER)");
  db.exec("CREATE TABLE publication_version_distribution_events(id TEXT PRIMARY KEY,publication_version_id TEXT,from_status TEXT,to_status TEXT,allow_existing_owners INTEGER,reason_code TEXT,reason_detail TEXT,actor_user_id TEXT,created_at TEXT)");
  db.exec("INSERT INTO publication_version_distribution_controls VALUES('version_root','recalled',0)");
  assert.equal(db.prepare(sql).run("event_1","version_root","distributable","distributable",1,"","", "actor","now").changes,1);
  const authority=db.prepare("SELECT distribution_status,allow_existing_owners FROM publication_version_distribution_controls WHERE publication_version_id='version_root'").get();
  assert.equal(authority.distribution_status,"recalled");
  assert.equal(authority.allow_existing_owners,0,
    "Forged distribution event history cannot reinstate a recalled asset");
}finally{db.close();}

// If any deployed source begins reading distribution history to compute
// permission, this classification MUST fail CI until independently reviewed.
function walk(dir,out=[]){
  for(const e of readdirSync(dir,{withFileTypes:true})){
    const p=join(dir,e.name);
    if(e.isDirectory())walk(p,out);
    else if(e.isFile()&&/\.(ts|tsx|js|mjs)$/.test(e.name))out.push(p);
  }
  return out;
}
for(const path of walk("src")){
  const contents=readFileSync(path,"utf8"),
    expression=/\b(?:FROM|JOIN)\s+publication_version_distribution_events\b/gi;
  assert.equal([...contents.matchAll(expression)].length,0,
    "Distribution event history became a read dependency: "+path);
}
assert.equal(review.releaseApproval,false);
console.log("PASS: private distribution history projection never grants access; all "+lifecycle.length+" remaining restoration-sensitive publishing lifecycle events remain owner-required");
