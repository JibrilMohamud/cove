/* eslint-disable prettier/prettier -- Exact source-bound paid-owner version history review. */
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import ts from "typescript";
import {currentWriterSites,REVIEW_PATH} from "./reconcile-canonical-writers.mjs";

const history="publishing_owner_version_events";
const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
const all=currentWriterSites().filter(x=>x.table===history);
assert.equal(all.length,3,"The whole owner-version audit inventory needs fresh review if history writers change");
// The formerly shared commerce grant_pin writer was physically retired;
// only the atomic private QA settlement grant pin remains with two non-authorizing
// policy history actions. The preorder grant-pin writer is private to the leased QA owner.
const privatePins=all.filter(x=>x.file==="src/features/fore/paid-settlement-transaction.server.ts");
assert.equal(privatePins.length,1,"Only the new atomic settlement executor adds a QA grant-pin history writer");
assert.equal(privatePins[0].functionName,"postPaidSettlementTransaction");
const safeFunctions=new Map([
  ["setPublishingUpdatePolicy","policy_pin"],
  ["optInOwnedPublicationUpdate","owner_opt_in"]
]);
const safe=all.filter(x=>x.file==="src/features/fore/publishing.server.ts");
assert.equal(safe.length,2);
const raw=readFileSync("src/features/fore/publishing.server.ts","utf8");
const source=ts.createSourceFile("src/features/fore/publishing.server.ts",raw,ts.ScriptTarget.Latest,true);
const literals=[];
function visit(n){
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))literals.push(n);
  ts.forEachChild(n,visit);
}
visit(source);
const db=new DatabaseSync(":memory:");
try{
  db.exec("CREATE TABLE entitlements(id TEXT PRIMARY KEY,status TEXT)");
  db.exec("CREATE TABLE publishing_entitlement_version_pins(entitlement_id TEXT PRIMARY KEY,publication_version_id TEXT)");
  db.exec("CREATE TABLE publishing_owner_version_events(id TEXT PRIMARY KEY,entitlement_id TEXT,lifecycle_id TEXT,from_publication_version_id TEXT,to_publication_version_id TEXT,action TEXT,actor_user_id TEXT,created_at TEXT)");
  db.exec("INSERT INTO entitlements VALUES('ent_revoked','revoked')");
  db.exec("INSERT INTO publishing_entitlement_version_pins VALUES('ent_revoked','version_recalled')");
  const counts={policy_pin:0,owner_opt_in:0};
  for(const site of all){
    const row=review.sites.find(x=>x.siteId===site.siteId);
    assert.ok(row,"Every historical SQL site must retain its source-bound review");
    assert.equal(row.productionOwnerGuarded,false);
    if(site.siteId===privatePins[0].siteId){
      assert.equal(row.disposition,"private-owner-qa-executor",
        "The new grant_pin is authorizing QA executor code, never a nonauthorizing history exemption");
      continue;
    }
    if(!safeFunctions.has(site.functionName)){
      assert.equal(row.disposition,"owner-command-required",
        "grant_pin inserts can affect preorder idempotency and must stay owner-required");
      continue;
    }
    assert.equal(row.disposition,"non-authorizing-write");
    assert.equal(site.operation,"INSERT INTO");
    const action=safeFunctions.get(site.functionName);
    const begin=source.getPositionOfLineAndCharacter(site.line-1,0),end=raw.indexOf("\n",begin);
    const nodes=literals.filter(n=>n.getStart(source)<=end&&n.end>begin&&n.text.includes(history));
    assert.equal(nodes.length,1,"Exact event SQL must be discoverable by TypeScript AST");
    const sql=nodes[0].text;
    assert.equal(sql,
      "INSERT INTO publishing_owner_version_events(id,entitlement_id,lifecycle_id,from_publication_version_id,to_publication_version_id,action,actor_user_id,created_at) VALUES(?,?,?,?,?,'"+action+"',?,?)",
      "Policy/opt-in logging cannot become a grant_pin or a cross-table mutation");
    const id="event_"+action;
    assert.equal(db.prepare(sql).run(id,"ent_revoked","life1",null,"version_new","actor","now").changes,1);
    counts[action]++;
  }
  assert.deepEqual(counts,{policy_pin:1,owner_opt_in:1});
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id='ent_revoked'").get().status,"revoked");
  assert.equal(db.prepare("SELECT publication_version_id FROM publishing_entitlement_version_pins WHERE entitlement_id='ent_revoked'").get().publication_version_id,"version_recalled",
    "Version-event history does not update canonical entitlement version pins");
  const blocking=db.prepare("SELECT 1 FROM publishing_owner_version_events WHERE entitlement_id=? AND action='grant_pin'").get("ent_revoked");
  assert.equal(blocking,undefined,
    "Neither event action can spoof preorder initial-grant idempotency");
  db.prepare("INSERT INTO publishing_owner_version_events VALUES(?,?,?,?,?,?,?,?)").run("grant_event","ent_revoked","life1",null,"version_recalled","grant_pin","actor","now");
  assert.equal(db.prepare("SELECT 1 FROM publishing_owner_version_events WHERE entitlement_id=? AND action='grant_pin'").get("ent_revoked")?.[1],1);
}finally{db.close();}

// Preorder grant_pin is an intentional read dependency. Do not waive it or
// permit new reads that derive permission from policy_pin/owner_opt_in.
function walk(dir,out=[]){
  for(const e of readdirSync(dir,{withFileTypes:true})){
    const p=join(dir,e.name);
    if(e.isDirectory())walk(p,out);
    else if(e.isFile()&&/\.(ts|tsx|js|mjs)$/.test(e.name))out.push(p);
  }
  return out;
}
let reads=0;
for(const path of walk("src")){
  const source=readFileSync(path,"utf8");
  const found=[...source.matchAll(/\b(?:FROM|JOIN)\s+publishing_owner_version_events\b/gi)];
  if(!found.length)continue;
  assert.equal(path.replaceAll("\\","/"),"src/storefront-strangler/legal-authority.worker.ts",
    "Version history became a new read dependency: "+path);
  assert.equal(found.length,1,"Preorder grant-pin read predicate changed");
  const query=source.slice(Math.max(0,found[0].index-150),found[0].index+160);
  assert.match(query,/action='grant_pin'/);
  reads+=found.length;
}
assert.equal(reads,1,"Only the private preorder owner grant_pin history predicate may be read");
assert.equal(review.releaseApproval,false);
console.log("PASS: two exact policy/opt-in history rows cannot grant versions, revive revoked entitlements or counterfeit grant_pin; the former shared preorder grant-pin writer is now private QA-only");
