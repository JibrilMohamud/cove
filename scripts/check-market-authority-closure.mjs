/* eslint-disable prettier/prettier -- Market revocation must survive D1 failures and replay. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const folder=mkdtempSync(path.join(os.tmpdir(),"cove-market-owner-"));
try{
  const load=async(file,name)=>{
    const dest=path.join(folder,name+".mjs");
    await build({entryPoints:[file],outfile:dest,bundle:true,platform:"node",
      format:"esm",target:"node22",logLevel:"silent"});
    return import(pathToFileURL(dest).href);
  };
  const core=await load("src/storefront-strangler/market-authority-core.ts","core");
  const writer=(await load("src/storefront-strangler/legal-quarantine-qa.writer.ts","writer")).default;
  const db=new DatabaseSync(":memory:");
  const sql={exec(statement,...bindings){
    const query=db.prepare(statement);
    const rows=/^\s*SELECT\b/i.test(statement)
      ?query.all(...bindings):(query.run(...bindings),[]);
    return {toArray:()=>rows};
  }};
  core.createMarketAuthoritySchema(sql);
  db.exec(`CREATE TABLE storefront_markets(country_code TEXT PRIMARY KEY,
    market_status TEXT NOT NULL CHECK(market_status IN ('active','paused')),
    checkout_enabled INTEGER NOT NULL,updated_at TEXT)`);
  db.prepare("INSERT INTO storefront_markets(country_code,market_status,checkout_enabled) VALUES('US','active',1),('CA','active',1)").run();
  assert.equal(core.marketIsWithdrawn(sql,"US"),false);
  assert.equal(core.marketIsWithdrawn(sql,"CA"),false);
  assert.deepEqual(core.denyMarket(sql,{territory:"US",operationId:"market:unit:first"}),
    {applied:true,territory:"US",withdrawn:true});
  assert.equal(core.marketIsWithdrawn(sql,"US"),true);
  assert.equal(core.marketIsWithdrawn(sql,"CA"),false);
  assert.equal(core.denyMarket(sql,{territory:"US",operationId:"market:unit:first"}).applied,true);
  assert.equal(core.denyMarket(sql,{territory:"US",operationId:"market:unit:second"}).applied,true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cove_market_withdrawals").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cove_market_withdrawal_ops").get().n,2);
  assert.throws(()=>core.denyMarket(sql,{territory:"CA",operationId:"market:unit:first"}),
    /market_denial_operation_scope_collision/);
  for(const territory of ["us","*","USA","","U1"])
    assert.throws(()=>core.marketIsWithdrawn(sql,territory),/invalid_market_authorization_scope/);
  assert.throws(()=>core.denyMarket(sql,{territory:"us",operationId:"other"}),
    /invalid_market_denial/);
  assert.throws(()=>core.denyMarket(sql,{territory:"CA",operationId:"../bad"}),
    /invalid_market_denial/);

  const events=[];
  let failOwner=false,failD1=false;
  const secret="a".repeat(64),writerSecret="b".repeat(64);
  const env={
    COVE_LEGAL_WRITER_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_LEGAL_WRITER_EXPIRES_AT:String(Date.now()+8*60000),
    COVE_LEGAL_WRITER_SECRET:writerSecret,
    COVE_RIGHTS_OWNER_SECRET:secret,
    PRIMARY_DB:{prepare(statement){
      return {bind(...args){return {async run(){
        events.push("canonical");
        if(failD1)throw Error("canonical_db_down");
        db.prepare(statement).run(...args);
        return {success:true};
      }}}};
    }},
    LEGAL_PRIVATE:{async fetch(request){
      events.push("owner");
      if(failOwner)throw Error("owner_down");
      assert.equal(request.headers.get("authorization"),"Bearer "+secret);
      assert.equal(new URL(request.url).pathname,"/market/deny-next");
      // Simulate the Durable Object's atomic SQL transaction.
      const command=await request.json();
      db.exec("BEGIN");
      let receipt;
      try{
        receipt=core.denyMarket(sql,command);
        db.exec("COMMIT");
      }catch(error){db.exec("ROLLBACK");throw error;}
      return Response.json(receipt);
    }}
  };
  const post=async(territory,operationId,environment=env)=>{
    const request=new Request("https://stage.internal/market/withdraw",{
      method:"POST",headers:{"authorization":"Bearer "+writerSecret,
        "content-type":"application/json"},
      body:JSON.stringify({territory,operationId})
    });
    return writer.fetch(request,environment);
  };
  events.length=0;
  failOwner=true;
  assert.equal((await post("CA","qa:market:owner-down")).status,503);
  assert.deepEqual(events,["owner"]);
  assert.equal(core.marketIsWithdrawn(sql,"CA"),false);
  assert.equal(db.prepare("SELECT market_status s FROM storefront_markets WHERE country_code='CA'").get().s,"active");

  failOwner=false;failD1=true;events.length=0;
  assert.equal((await post("CA","qa:market:crash")).status,503);
  assert.deepEqual(events,["owner","canonical"],
    "Market denial must reach owner before canonical D1 mutation");
  assert.equal(core.marketIsWithdrawn(sql,"CA"),true,
    "Even with D1 down, all previous CA owner proofs must be vetoed");
  assert.equal(db.prepare("SELECT checkout_enabled c FROM storefront_markets WHERE country_code='CA'").get().c,1);

  failD1=false;events.length=0;
  assert.equal((await post("CA","qa:market:crash")).status,200,
    "Same operation must reconcile canonical market after DB recovery");
  assert.deepEqual(events,["owner","canonical"]);
  assert.equal(db.prepare("SELECT market_status s FROM storefront_markets WHERE country_code='CA'").get().s,"paused");
  assert.equal(db.prepare("SELECT checkout_enabled c FROM storefront_markets WHERE country_code='CA'").get().c,0);
  assert.equal((await post("CA","qa:market:crash")).status,200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cove_market_withdrawal_ops").get().n,3,
    "Replayed denial cannot allocate an additional revision or op receipt");
  assert.equal((await post("ca","qa:market:bad")).status,400);
  assert.equal((await post("US","qa:market:no-lock",{
    ...env,COVE_LEGAL_WRITER_ENABLED:"0"
  })).status,503,"Inactive private writer cannot mutate markets");
  db.close();
  console.log("PASS: durable market-wide owner veto; operation collisions, outage-before-D1, replay and exact private stage scope");
}finally{rmSync(folder,{recursive:true,force:true});}
