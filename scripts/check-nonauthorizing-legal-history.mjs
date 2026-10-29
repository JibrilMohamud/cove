/* eslint-disable prettier/prettier -- Review exact immutable history SQL; never reclassify restoration inputs. */
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import ts from "typescript";
import {currentWriterSites,REVIEW_PATH} from "./reconcile-canonical-writers.mjs";

const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
const current=currentWriterSites();
const lifecycle=current.filter(x=>x.table==="publishing_lifecycle_events");
assert.equal(lifecycle.length,9);
for(const site of lifecycle){
  const row=review.sites.find(x=>x.siteId===site.siteId);
  assert.equal(row?.disposition,"owner-command-required",
    "Publishing lifecycle history drives restoration and may NOT be waived");
  assert.equal(row?.productionOwnerGuarded,false);
}
// An authenticated staff restoration consumes historical from_state and can
// change the real current lifecycle; the source demonstrates history is NOT
// harmless telemetry. Keep these nine authorizing until owner-first migration.
const moderation=readFileSync("src/features/fore/moderation.server.ts","utf8");
assert.match(moderation,/SELECT from_state FROM publishing_lifecycle_events WHERE lifecycle_id=\? AND to_state IN \('suppressed','takedown'\)/);
assert.match(moderation,/restoredFrom\s*=\s*prior\?\.from_state/);
assert.match(moderation,/const target\s*=\s*restoring\s*&&\s*restoredFrom/);

const table="publication_version_distribution_events";
const historical=current.filter(x=>x.table===table);
assert.equal(historical.length,1);
const site=historical[0],row=review.sites.find(x=>x.siteId===site.siteId);
assert.equal(row?.disposition,"non-authorizing-write");
assert.equal(row?.productionOwnerGuarded,false);
assert.equal(site.file,"src/features/fore/delivery.server.ts");
assert.equal(site.functionName,"setDistributionControl");
assert.equal(site.operation,"INSERT INTO");
const source=readFileSync(site.file,"utf8"),
  tree=ts.createSourceFile(site.file,source,ts.ScriptTarget.Latest,true),
  literalNodes=[];
function visit(node){
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))literalNodes.push(node);
  ts.forEachChild(node,visit);
}
visit(tree);
const from=tree.getPositionOfLineAndCharacter(site.line-1,0),to=source.indexOf("\n",from);
const choices=literalNodes.filter(node=>node.getStart(tree)<=to&&node.end>from&&node.text.includes(table));
assert.equal(choices.length,1);
const sql=choices[0].text;
assert.equal(sql,
  "INSERT INTO publication_version_distribution_events(id,publication_version_id,from_status,to_status,allow_existing_owners,reason_code,reason_detail,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  "The only nonauthorizing writer must append the exact reviewed history fields");

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
console.log("PASS: one distribution history projection never grants access; all nine restoration-sensitive publishing lifecycle events correctly remain owner-required");
