/* eslint-disable prettier/prettier -- Deny-first source-mutation staging regression fixture. */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
const directory=mkdtempSync(path.join(os.tmpdir(),"cove-legal-qa-writer-"));
try {
  const load=async(source,name)=>{
    const outfile=path.join(directory,name+".mjs");
    await build({entryPoints:[source],outfile,bundle:true,platform:"node",
      format:"esm",target:"node22",logLevel:"silent",external:["cloudflare:*"]});
    return import(pathToFileURL(outfile).href);
  };
  const core=await load("src/storefront-strangler/legal-authority-core.ts","core");
  const writer=(await load("src/storefront-strangler/legal-quarantine-qa.writer.ts","writer")).default;
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE gutenberg_source_cache(id TEXT PRIMARY KEY,rights_status TEXT,commercial_use_status TEXT,ingest_status TEXT)");
  db.prepare("INSERT INTO gutenberg_source_cache VALUES('2701','public-domain','approved','active')").run();
  const sql={exec(statement,...args){
    const stmt=db.prepare(statement);
    const results=/^\s*SELECT\b/i.test(statement)?stmt.all(...args):(stmt.run(...args),[]);
    return {toArray:()=>results};
  }};
  core.createAuthoritySchema(sql);core.createAuthorityProofSchema(sql);
  const secret="e".repeat(64),auth="f".repeat(64),operations=[];
  let failPrimary=false,failOwner=false;
  const owner={async fetch(request){
    operations.push("authority");
    if(failOwner)return new Response(null,{status:503});
    if(request.headers.get("authorization")!=="Bearer "+secret)
      return new Response(null,{status:401});
    const cmd=await request.json();
    const result=core.persistSourceWithdrawal(sql,cmd);
    return Response.json(result,{status:result.applied?200:409});
  }};
  const primary={
    prepare(stmt){
      assert.match(stmt,/^UPDATE gutenberg_source_cache SET rights_status='quarantined'/);
      return {bind(sourceId){return {async run(){
        operations.push("canonical-write");
        if(failPrimary)throw Error("primary-unavailable");
        db.prepare("UPDATE gutenberg_source_cache SET rights_status='quarantined',commercial_use_status='quarantined',ingest_status='quarantined' WHERE id=?")
          .run(sourceId);
        return {success:true};
      }};}};
    }
  };
  const env={
    PRIMARY_DB:primary,LEGAL_PRIVATE:owner,
    COVE_LEGAL_WRITER_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
    COVE_LEGAL_WRITER_EXPIRES_AT:String(Date.now()+4*60*1000),
    COVE_LEGAL_WRITER_SECRET:auth,COVE_RIGHTS_OWNER_SECRET:secret
  };
  const post=async(input,overrides={})=>writer.fetch(
    new Request("https://legal-quarantine.internal/quarantine",{method:"POST",
      headers:{"authorization":"Bearer "+auth,"content-type":"application/json"},
      body:JSON.stringify(input)}),{...env,...overrides}
  );
  const cmd={sourceId:"2701",operationId:"regional:2701:hash-1",message:"source-rights-quarantined"};
  assert.equal((await post(cmd,{COVE_LEGAL_WRITER_ENABLED:"0"})).status,503);
  assert.equal((await post(cmd,{COVE_LEGAL_WRITER_EXPIRES_AT:"0"})).status,503);
  assert.equal((await post({...cmd,sourceId:"../../test"})).status,400);
  assert.equal((await writer.fetch(new Request("https://legal-quarantine.internal/quarantine",{
    method:"POST",headers:{"authorization":"Bearer "+"0".repeat(64),
      "content-type":"application/json"},body:JSON.stringify(cmd)}),env)).status,401);
  assert.equal((await post(cmd)).status,200);
  assert.deepEqual(operations,["authority","canonical-write"],
    "The owner MUST persist denial before the first primary mutation");
  assert.deepEqual(core.readAuthority(sql,"2701","US"),{allowed:false,revision:1});
  assert.deepEqual(core.readAuthority(sql,"2701","AU"),{allowed:false,revision:1});
  assert.equal(db.prepare("SELECT rights_status FROM gutenberg_source_cache WHERE id='2701'").get().rights_status,"quarantined");
  assert.equal((await post(cmd)).status,200,"Idempotent event retry is accepted");
  assert.equal(core.readAuthority(sql,"2701","US").revision,1);
  operations.length=0;
  failOwner=true;
  assert.equal((await post({...cmd,operationId:"regional:2701:hash-2"})).status,503);
  assert.deepEqual(operations,["authority"],
    "A missing legal owner MUST prevent D1 mutation");
  failOwner=false;
  operations.length=0;
  failPrimary=true;
  assert.equal((await post({...cmd,operationId:"regional:2701:hash-3"})).status,503);
  assert.deepEqual(operations,["authority","canonical-write"]);
  assert.deepEqual(core.readAuthority(sql,"2701","US"),{allowed:false,revision:2},
    "A post-fence canonical D1 failure MUST retain newly committed denial");
  db.close();
  console.log("PASS: independently bound QA writer denies before primary D1, prevents bypasses, enforces scoped auth, preserves failed-mutation revocation");
}finally{rmSync(directory,{force:true,recursive:true});}
