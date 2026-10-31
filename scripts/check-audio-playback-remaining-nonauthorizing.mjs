/* eslint-disable prettier/prettier -- Exact reviewed SQL and buyer-scope regression. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import ts from "typescript";
import {currentWriterSites,REVIEW_PATH} from "./reconcile-canonical-writers.mjs";

const exact={
  "src/features/fore/account-management.server.ts":[
    "DELETE FROM commercial_audio_playback WHERE user_id=?"
  ],
  "src/features/fore/commercial-audio.server.ts":[
    "INSERT INTO commercial_audio_playback(user_id,product_id,chapter_id,seconds,speed,version,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(user_id,product_id) DO NOTHING RETURNING version,updated_at",
    "UPDATE commercial_audio_playback SET chapter_id=?,seconds=?,speed=?,version=version+1,updated_at=? WHERE user_id=? AND product_id=? AND version=? RETURNING version,updated_at"
  ],
};
const target=currentWriterSites().filter(x=>x.table==="commercial_audio_playback"&&
  Object.hasOwn(exact,x.file));
assert.equal(target.length,2);
const accountLineage=JSON.parse(readFileSync("docs/architecture/retired-account-owner-lineage.json","utf8"));
assert.equal(accountLineage.retired.filter(x=>x.table==="commercial_audio_playback"&&x.disposition==="non-authorizing-write").length,1);
assert.ok(readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8").includes(exact["src/features/fore/account-management.server.ts"][0]));
const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
for(const site of target){
  const row=review.sites.find(x=>x.siteId===site.siteId);
  assert.equal(row?.disposition,"non-authorizing-write");
  assert.equal(row?.productionOwnerGuarded,false);
  const source=readFileSync(site.file,"utf8"),
    tree=ts.createSourceFile(site.file,source,ts.ScriptTarget.Latest,true);
  const nodes=[];
  function visit(n){
    if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))nodes.push(n);
    ts.forEachChild(n,visit);
  }
  visit(tree);
  const at=tree.getPositionOfLineAndCharacter(site.line-1,0),end=source.indexOf("\n",at);
  const choices=nodes.filter(n=>n.getStart(tree)<=end&&n.end>at&&n.text.includes("commercial_audio_playback"));
  assert.equal(choices.length,1);
  assert.ok(exact[site.file].includes(choices[0].text),
    "Only exact buyer-scoped playback SQL may be classified safe: "+site.file+":"+site.line);
  assert.ok(/WHERE user_id=\?/.test(choices[0].text)||/\(user_id,product_id,/.test(choices[0].text));
}
const audio=readFileSync("src/features/fore/commercial-audio.server.ts","utf8");
const at=audio.indexOf('if (match[2] === "playback")');
assert.ok(at>0);
const route=audio.slice(at,audio.indexOf('if (request.method === "PUT")',at));
for(const guard of ["if (!userId)","hasAudioAccess(db, userId, row.product_id, territory)",
  "assertCommercialAudioRiskAccess(db, userId, String(row.product_id))",
  "requireCommercialAudioOwner(env, userId, String(row.product_id), territory)"])
  assert.ok(route.includes(guard),"Playback position routes must retain authentication and owner-backed paid access: "+guard);

const db=new DatabaseSync(":memory:");
try{
  db.exec("CREATE TABLE entitlements(id TEXT,user_id TEXT,product_id TEXT,status TEXT)");
  db.exec("CREATE TABLE commercial_audio_playback(user_id TEXT,product_id TEXT,chapter_id TEXT,seconds REAL,speed REAL,version INTEGER,updated_at TEXT,PRIMARY KEY(user_id,product_id))");
  db.exec("INSERT INTO entitlements VALUES('ent_revoked','buyer_a','book_a','revoked')");
  const [cleanup]=exact["src/features/fore/account-management.server.ts"];
  const [insert,update]=exact["src/features/fore/commercial-audio.server.ts"];
  assert.equal(db.prepare(insert).get("buyer_a","book_a","chapter_1",15,1,"now").version,1);
  assert.equal(db.prepare(insert).get("buyer_a","book_a","chapter_2",16,1,"now"),undefined,
    "Duplicate initial position cannot advance existing playback");
  assert.equal(db.prepare(insert).get("buyer_b","book_b","chapter_b",3,1,"now").version,1);
  assert.equal(db.prepare(update).get("chapter_2",30,1.25,"later","buyer_a","book_a",1).version,2);
  assert.equal(db.prepare(update).get("chapter_bad",0,1,"later","buyer_a","book_a",1),undefined,
    "Stale optimistic versions cannot overwrite progress");
  assert.equal(db.prepare(cleanup).run("buyer_a").changes,1);
  assert.equal(db.prepare("SELECT chapter_id FROM commercial_audio_playback WHERE user_id='buyer_b'").get().chapter_id,"chapter_b",
    "Deleting one account cannot wipe unrelated playback");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id='ent_revoked'").get().status,"revoked",
    "Listening progress never restores a paid entitlement");
}finally{db.close();}
assert.equal(review.releaseApproval,false);
console.log("PASS: two exact shared playback writes remain; account progress erasure retains exact private-owner lineage; authenticated versioned playback never restores paid access");
