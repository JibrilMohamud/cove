/* eslint-disable prettier/prettier -- Forensic SQL-site assertions depend on literal text and exact column lists. */
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import ts from "typescript";
import {currentWriterSites,identifyWriterSites,REVIEW_PATH} from "./reconcile-canonical-writers.mjs";

const eventColumns={
  publishing_lifecycle_events:new Set([
    "id","lifecycle_id","from_state","to_state","trigger_type",
    "actor_user_id","reason_code","metadata_json","created_at"
  ]),
  publication_version_distribution_events:new Set([
    "id","publication_version_id","from_status","to_status",
    "allow_existing_owners","reason_code","reason_detail","actor_user_id","created_at"
  ])
};
const targetFiles=new Set([
  "src/features/fore/moderation.server.ts",
  "src/features/fore/publishing-trust.server.ts",
  "src/features/fore/publishing.server.ts",
  "src/features/fore/delivery.server.ts"
]);
const approvedCount={publishing_lifecycle_events:9,publication_version_distribution_events:1};
const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
const current=currentWriterSites();
const targets=current.filter(s=>Object.hasOwn(eventColumns,s.table));
assert.equal(targets.length,10);
const db=new DatabaseSync(":memory:");
try{
  db.exec("CREATE TABLE publishing_release_lifecycles(id TEXT PRIMARY KEY,state TEXT)");
  db.exec("CREATE TABLE publication_version_distribution_controls(publication_version_id TEXT PRIMARY KEY,distribution_status TEXT)");
  db.exec("INSERT INTO publishing_release_lifecycles VALUES('lifecycle_root','takedown')");
  db.exec("INSERT INTO publication_version_distribution_controls VALUES('version_root','recalled')");
  for(const [table,cols] of Object.entries(eventColumns)){
    db.exec("CREATE TABLE "+table+"("+[...cols].map(c=>c+" TEXT").join(",")+")");
  }
  const counts={publishing_lifecycle_events:0,publication_version_distribution_events:0};
  const sources=new Map();
  for(const site of targets){
    assert.ok(targetFiles.has(site.file),"Unknown direct writer of legal event history: "+site.file);
    assert.equal(site.operation,"INSERT INTO","Audit history must be append-only");
    const reviewed=review.sites.find(s=>s.siteId===site.siteId);
    assert.ok(reviewed,"Exact SQL/source review is required for each history writer");
    assert.equal(reviewed.table,site.table);
    assert.equal(reviewed.file,site.file);
    assert.equal(reviewed.disposition,"non-authorizing-write");
    assert.equal(reviewed.productionOwnerGuarded,false);
    let parsed=sources.get(site.file);
    if(!parsed){
      const text=readFileSync(site.file,"utf8"),tree=ts.createSourceFile(site.file,text,ts.ScriptTarget.Latest,true);
      const literalNodes=[];
      function visit(node){
        if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))
          literalNodes.push(node);
        ts.forEachChild(node,visit);
      }
      visit(tree);
      parsed={text,tree,literalNodes};
      sources.set(site.file,parsed);
    }
    const lineStart=parsed.tree.getPositionOfLineAndCharacter(site.line-1,0);
    const lineEnd=parsed.text.indexOf("\n",lineStart);
    const candidates=parsed.literalNodes.filter(n=>n.getStart(parsed.tree)<=lineEnd&&n.end>lineStart&&
      n.text.includes(site.table)).sort((a,b)=>(a.end-a.pos)-(b.end-b.pos));
    assert.ok(candidates.length,"Event insert SQL literal must be discoverable: "+site.file+":"+site.line);
    const sql=candidates[0].text.trim();
    const statement=sql.match(/^INSERT INTO (publishing_lifecycle_events|publication_version_distribution_events)\s*\(([^)]+)\)\s*VALUES\s*\(([^;]+)\)$/i);
    assert.ok(statement,"History writes must be one static parameterized INSERT, not conditional or dynamic SQL: "+sql);
    assert.equal(statement[1].toLowerCase(),site.table);
    const cols=statement[2].split(",").map(x=>x.trim().toLowerCase());
    assert.equal(new Set(cols).size,cols.length);
    assert.ok(cols.every(x=>eventColumns[site.table].has(x)),"No protected authorizing columns in event history: "+sql);
    assert.equal(cols[0],"id");
    assert.ok(!/\b(?:UPDATE|DELETE|REPLACE|SELECT|RETURNING|ON CONFLICT|WITH)\b/i.test(sql),
      "Audit history must not contain any read-modify-write or cross-table mutation");
    const args=Array.from({length:(sql.match(/\?/g)||[]).length},(_,i)=>i===0?"history_"+site.table+"_"+counts[site.table]: "audit_value");
    assert.equal(db.prepare(sql).run(...args).changes,1);
    counts[site.table]++;
  }
  for(const [table,n] of Object.entries(approvedCount)){
    assert.equal(counts[table],n,"Each reviewed history source must be exercised");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM "+table).get().n,n);
  }
  assert.equal(db.prepare("SELECT state FROM publishing_release_lifecycles WHERE id='lifecycle_root'").get().state,"takedown",
    "Publishing history events cannot transition a lifecycle to live");
  assert.equal(db.prepare("SELECT distribution_status FROM publication_version_distribution_controls WHERE publication_version_id='version_root'").get().distribution_status,"recalled",
    "Distribution history events cannot reauthorize recalled delivery");
}finally{db.close();}

// Protect the classification from future implicit event-history authority
// dependencies. A new read of event rows must be separately analyzed before
// these sites remain non-authorizing; audit/fixture scripts are excluded.
function walk(dir,output=[]){
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory())walk(path,output);
    else if(entry.isFile()&&/\.(ts|tsx|js|mjs)$/.test(entry.name))output.push(path);
  }
  return output;
}
for(const path of walk("src")){
  const contents=readFileSync(path,"utf8");
  for(const name of Object.keys(eventColumns)){
    const query=new RegExp("\\b(?:FROM|JOIN)\\s+[`\\\"']?"+name+"\\b","gi");
    assert.equal([...contents.matchAll(query)].length,0,
      "Event history is no longer write-only; inspect whether reads confer authority: "+path+":"+name);
  }
}
assert.equal(review.releaseApproval,false);
console.log("PASS: ten exact append-only legal history SQL sites never mutate publishing or distribution authority; no event-history reads are used to grant access");
