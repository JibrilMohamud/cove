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
  const commercial=await load("src/storefront-strangler/commercial-legal-core.ts","commercial");
  const paidEnt=await load("src/storefront-strangler/commercial-entitlement-core.ts","paid-ent");
  const writer=(await load("src/storefront-strangler/legal-quarantine-qa.writer.ts","writer")).default;
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE gutenberg_source_cache(id TEXT PRIMARY KEY,rights_status TEXT,commercial_use_status TEXT,ingest_status TEXT)");
  db.prepare("INSERT INTO gutenberg_source_cache VALUES('2701','public-domain','approved','active')").run();
  db.exec("CREATE TABLE gutenberg_rights_evidence(id TEXT PRIMARY KEY,source_id TEXT,cache_id TEXT,territory_code TEXT,status TEXT)");
  db.exec("CREATE TABLE rights_grants(edition_id TEXT,source TEXT,territory_code TEXT,decision TEXT,status TEXT)");
  db.exec("ALTER TABLE rights_grants ADD COLUMN id TEXT");
  db.exec("ALTER TABLE rights_grants ADD COLUMN contract_id TEXT");
  db.exec("CREATE TABLE rights_contracts(id TEXT PRIMARY KEY,status TEXT)");
  db.exec("CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT)");
  db.exec("CREATE TABLE entitlements(id TEXT PRIMARY KEY,user_id TEXT,product_id TEXT,status TEXT,entitlement_type TEXT,order_item_id TEXT)");
  db.exec("CREATE TABLE commerce_orders(id TEXT PRIMARY KEY,user_id TEXT)");
  db.exec("CREATE TABLE commerce_order_items(id TEXT PRIMARY KEY,order_id TEXT)");
  db.exec("INSERT INTO rights_contracts VALUES('rcontract_17','active')");
  db.exec("INSERT INTO rights_contracts VALUES('rcontract_18','active')");
  db.exec("INSERT INTO products VALUES('prd_commercial_a17','ed_commercial_a17','partner')");
  db.exec("INSERT INTO products VALUES('prd_commercial_b18','ed_commercial_b18','partner')");
  db.exec("INSERT INTO products VALUES('prd_commercial_c19','ed_commercial_c19','partner')");
  db.exec("INSERT INTO rights_grants(id,edition_id,source,territory_code,decision,status,contract_id) VALUES('right_valid_17','ed_commercial_a17','operator','US','allow','active','rcontract_17')");
  db.exec("INSERT INTO rights_grants(id,edition_id,source,territory_code,decision,status,contract_id) VALUES('right_valid_18','ed_commercial_b18','operator','US','allow','active','rcontract_17')");
  db.exec("INSERT INTO rights_grants(id,edition_id,source,territory_code,decision,status,contract_id) VALUES('right_valid_19','ed_commercial_c19','operator','US','allow','active','rcontract_18')");

  for(const territory of ["US","CA"]){
    db.prepare("INSERT INTO gutenberg_rights_evidence VALUES(?,?,?,?,?)")
      .run("gre_2702_"+territory.toLowerCase(),"pg_us","2702",territory,"approved");
    db.prepare("INSERT INTO rights_grants(edition_id,source,territory_code,decision,status) VALUES(?,?,?,?,?)")
      .run("ed_gutenberg_2702","gutenberg-pg_us-public-domain",territory,"allow","active");
  }

  const sql={exec(statement,...args){
    const stmt=db.prepare(statement);
    const results=/^\s*SELECT\b/i.test(statement)?stmt.all(...args):(stmt.run(...args),[]);
    return {toArray:()=>results};
  }};
  core.createAuthoritySchema(sql);core.createAuthorityProofSchema(sql);
  commercial.createCommercialAuthoritySchema(sql);
  paidEnt.createPaidEntitlementSchema(sql);
  const secret="e".repeat(64),auth="f".repeat(64),operations=[];
  let failPrimary=false,failPrimaryBatch=false,failPrimaryWrite=false,failOwner=false;
  const owner={async fetch(request){
    operations.push("authority");
    if(failOwner)return new Response(null,{status:503});
    if(request.headers.get("authorization")!=="Bearer "+secret)
      return new Response(null,{status:401});
    const cmd=await request.json();
    if(new URL(request.url).pathname==="/commercial/order/deny-next"){
      db.exec("BEGIN");
      try{
        const result=paidEnt.denyPaidOrder(sql,cmd);
        db.exec("COMMIT");
        return Response.json(result);
      }catch{db.exec("ROLLBACK");return new Response(null,{status:409});}
    }
    if(new URL(request.url).pathname==="/commercial/entitlement/deny-batch"){
      db.exec("BEGIN");
      try{
        const result=paidEnt.denyPaidEntitlementsBatch(sql,cmd);
        db.exec("COMMIT");
        return Response.json(result);
      }catch{db.exec("ROLLBACK");return new Response(null,{status:409});}
    }
    if(new URL(request.url).pathname==="/commercial/entitlement/deny-next"){
      db.exec("BEGIN");
      try{
        const result=paidEnt.denyPaidEntitlement(sql,cmd);
        db.exec("COMMIT");
        return Response.json(result,{status:result.applied?200:409});
      }catch{db.exec("ROLLBACK");return new Response(null,{status:409});}
    }
    if(new URL(request.url).pathname==="/commercial/deny-batch"){
      db.exec("BEGIN");
      try{
        const result=commercial.denyCommercialProductsBatch(sql,cmd);
        db.exec("COMMIT");
        return Response.json(result);
      }catch{db.exec("ROLLBACK");return new Response(null,{status:409});}
    }
    if(new URL(request.url).pathname==="/deny-next-batch"){
      db.exec("BEGIN");
      try {
        const result=core.persistSourceWithdrawalsBatch(sql,cmd);
        db.exec("COMMIT");
        return Response.json(result,{status:result.applied?200:409});
      }catch(e){db.exec("ROLLBACK");return new Response(null,{status:400});}
    }
    const result=core.persistSourceWithdrawal(sql,cmd);
    return Response.json(result,{status:result.applied?200:409});
  }};
  const primary={
    prepare(stmt){
      return {bind(...params){return {
        sql:stmt,params,
        async run(){
          operations.push("canonical-write");
          if(failPrimary||failPrimaryWrite)throw Error("primary-unavailable");
          db.prepare(stmt).run(...params);
          return {success:true};
        },
        async all(){
          operations.push("canonical-scope-discovery");
          if(failPrimary)throw Error("primary-unavailable");
          return {results:db.prepare(stmt).all(...params)};
        },
        async first(){
          operations.push("canonical-evidence-check");
          if(failPrimary)throw Error("primary-unavailable");
          return db.prepare(stmt).get(...params)??null;
        }
      };}};
    },
    async batch(statements){
      operations.push("canonical-atomic-batch");
      if(failPrimary||failPrimaryBatch)throw Error("primary-unavailable");
      db.exec("BEGIN");
      try{
        const all=statements.map(entry=>db.prepare(entry.sql).run(...entry.params));
        db.exec("COMMIT");
        return all;
      }catch(e){db.exec("ROLLBACK");throw e;}
    }
  };
  const env={
    PRIMARY_DB:primary,LEGAL_PRIVATE:owner,
    COVE_LEGAL_WRITER_ENABLED:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
    COVE_LEGAL_WRITER_EXPIRES_AT:String(Date.now()+4*60*1000),
    COVE_LEGAL_WRITER_SECRET:auth,COVE_RIGHTS_OWNER_SECRET:secret
  };
  const post=async(input,overrides={},route="/quarantine")=>writer.fetch(
    new Request("https://legal-quarantine.internal"+route,{method:"POST",
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
  // A country-specific evidence withdrawal must not poison other markets.
  failPrimary=false;operations.length=0;
  assert.equal(core.applyAuthorityCommand(sql,{
    sourceId:"2702",territory:"US",revision:1,action:"allow"
  }).applied,true);
  assert.equal(core.applyAuthorityCommand(sql,{
    sourceId:"2702",territory:"CA",revision:2,action:"allow"
  }).applied,true);
  const evidenceCmd={sourceId:"2702",territory:"US",
    evidenceId:"gre_2702_us",operationId:"evidence:2702:us:withdraw:1"};
  const withdrawn=await post(evidenceCmd,{},"/evidence/revoke");
  assert.equal(withdrawn.status,200);
  assert.deepEqual(operations,["authority","canonical-evidence-check","canonical-atomic-batch"],
    "Owner denial must precede exact evidence verification and atomic D1 writes");
  assert.deepEqual(core.readAuthority(sql,"2702","US"),{allowed:false,revision:3});
  assert.deepEqual(core.readAuthority(sql,"2702","CA"),{allowed:true,revision:2},
    "Withdrawing US evidence may not revoke the separately authorized CA market");
  assert.equal(db.prepare("SELECT status FROM gutenberg_rights_evidence WHERE id='gre_2702_us'").get().status,"revoked");
  assert.equal(db.prepare("SELECT status FROM rights_grants WHERE territory_code='US' AND source='gutenberg-pg_us-public-domain'").get().status,"suspended");
  assert.equal(db.prepare("SELECT status FROM rights_grants WHERE territory_code='CA' AND source='gutenberg-pg_us-public-domain'").get().status,"active");
  assert.equal((await post(evidenceCmd,{},"/evidence/revoke")).status,200);
  assert.equal(core.readAuthority(sql,"2702","US").revision,3,
    "Retry cannot allocate a new source epoch");
  assert.equal((await post({...evidenceCmd,evidenceId:"gre_2702_ca",
    operationId:"evidence:2702:us:wrong-scope"},{},"/evidence/revoke")).status,503,
    "Wrong-country evidence may never produce a positive receipt");
  assert.equal((await post({...evidenceCmd,evidenceId:"x';DELETE"},
    {},"/evidence/revoke")).status,400);
  db.prepare("INSERT INTO gutenberg_source_cache VALUES('2705','public-domain','approved','active')").run();
  db.prepare("INSERT INTO gutenberg_source_cache VALUES('2706','public-domain','approved','active')").run();
  operations.length=0;
  const retraction={operations:[
    {sourceId:"2705",operationId:"stale:2705:1"},
    {sourceId:"2706",operationId:"stale:2706:1"}
  ]};
  assert.equal((await post(retraction,{},"/source/retract-batch")).status,200);
  assert.deepEqual(operations,["authority","canonical-atomic-batch"],
    "One owner batch must precede one canonical DB batch");
  assert.deepEqual(db.prepare(
    "SELECT id,ingest_status FROM gutenberg_source_cache WHERE id IN ('2705','2706') ORDER BY id"
  ).all().map(row=>({...row})),[{id:"2705",ingest_status:"stale"},{id:"2706",ingest_status:"stale"}]);
  for(const sourceId of ["2705","2706"])
    assert.deepEqual(core.readAuthority(sql,sourceId,"US"),{allowed:false,revision:1});
  assert.equal((await post(retraction,{},"/source/retract-batch")).status,200);
  assert.equal(core.readAuthority(sql,"2705","CA").revision,1,
    "Source batch event replay cannot allocate new rights epochs");
  assert.equal((await post({operations:[
    retraction.operations[0],retraction.operations[0]
  ]},{},"/source/retract-batch")).status,503,
    "Duplicate source in one batch cannot receive a success receipt");
  db.prepare("INSERT INTO gutenberg_source_cache VALUES('2707','public-domain','approved','active')").run();
  operations.length=0;failOwner=true;
  assert.equal((await post({operations:[
    {sourceId:"2707",operationId:"stale:2707:1"}
  ]},{},"/source/retract-batch")).status,503);
  assert.deepEqual(operations,["authority"]);
  assert.equal(db.prepare(
    "SELECT ingest_status FROM gutenberg_source_cache WHERE id='2707'"
  ).get().ingest_status,"active","Unavailable owner cannot allow D1 retraction");
  failOwner=false;
  // Physically isolated licensed-grant and contract operations must
  // discover ALL affected paid products before one atomic owner denial.
  operations.length=0;
  const grantSuspend={targetId:"right_valid_19",operationId:"grant-suspend:19:v1"};
  assert.equal((await post(grantSuspend,{},"/commercial/suspend-grant")).status,200);
  assert.deepEqual(operations,["canonical-scope-discovery","authority","canonical-atomic-batch"]);
  assert.equal(commercial.readCommercialProofs(sql,
    ["prd_commercial_c19"],"US","retail").length,0);
  assert.equal(db.prepare("SELECT status FROM rights_grants WHERE id='right_valid_19'").get().status,
    "suspended");
  assert.equal(db.prepare("SELECT status FROM rights_grants WHERE id='right_valid_17'").get().status,
    "active");
  operations.length=0;
  const contractSuspend={targetId:"rcontract_17",operationId:"contract-suspend:17:v1"};
  assert.equal((await post(contractSuspend,{},"/commercial/suspend-contract")).status,200);
  assert.deepEqual(operations,["canonical-scope-discovery","authority","canonical-atomic-batch"]);
  assert.equal(db.prepare("SELECT status FROM rights_contracts WHERE id='rcontract_17'").get().status,
    "suspended");
  assert.deepEqual(db.prepare(
    "SELECT status FROM rights_grants WHERE contract_id='rcontract_17' ORDER BY id"
  ).all().map(v=>v.status),["suspended","suspended"]);
  assert.equal(db.prepare("SELECT status FROM rights_contracts WHERE id='rcontract_18'").get().status,
    "active","Other publisher contract unaffected");
  assert.equal((await post(contractSuspend,{},"/commercial/suspend-contract")).status,200,
    "Same legal change is idempotent");
  const nowEpoch=commercial.captureCommercialEpoch(sql,{productId:"prd_commercial_a17"});
  assert.equal(nowEpoch,1);
  failOwner=true;operations.length=0;
  assert.equal((await post({targetId:"rcontract_18",operationId:"contract-suspend:18:v1"},
    {},"/commercial/suspend-contract")).status,503);
  assert.deepEqual(operations,["canonical-scope-discovery","authority"],
    "Owner outage cannot permit canonical contract update");
  assert.equal(db.prepare("SELECT status FROM rights_contracts WHERE id='rcontract_18'").get().status,
    "active");
  failOwner=false;operations.length=0;
  failPrimaryBatch=true;
  assert.equal((await post({targetId:"rcontract_18",operationId:"contract-suspend:18:v2"},
    {},"/commercial/suspend-contract")).status,503);
  assert.equal(commercial.captureCommercialEpoch(sql,{productId:"prd_commercial_c19"}),2,
    "D1 failure must leave strong denial committed");
  failPrimaryBatch=false;
  const entitlementId="dc6197f2-945c-4362-b4bc-7dd928f3c980";
  db.prepare("INSERT INTO entitlements(id,user_id,product_id,status) VALUES(?,?,?,'active')").run(
    entitlementId,"user_paid_17","prd_commercial_a17"
  );
  operations.length=0;
  const revoke={entitlementId,operationId:"refund:order17:ent17"};
  assert.equal((await post(revoke,{},"/commercial/entitlement/revoke")).status,200);
  assert.deepEqual(operations,["canonical-evidence-check","authority","canonical-write"],
    "D1 beneficiary discovery, strong paid buyer deny, THEN canonical entitlement revoke");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id=?").get(entitlementId).status,
    "revoked");
  assert.equal(paidEnt.captureEntitlementEpoch(sql,{
    entitlementId,userId:"user_paid_17",productId:"prd_commercial_a17"
  }),1);
  assert.equal((await post(revoke,{},"/commercial/entitlement/revoke")).status,200,
    "Refund event replay must not reinstate paid access");
  operations.length=0;failOwner=true;
  db.prepare("UPDATE entitlements SET status='active' WHERE id=?").run(entitlementId);
  assert.equal((await post({...revoke,operationId:"refund:order17:ent18"},
    {},"/commercial/entitlement/revoke")).status,503);
  assert.deepEqual(operations,["canonical-evidence-check","authority"]);
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id=?").get(entitlementId).status,
    "active","An unavailable strong owner cannot commit a refund revocation");
  failOwner=false;failPrimaryWrite=true;
  const loss=await post({...revoke,operationId:"refund:order17:ent19"},
    {},"/commercial/entitlement/revoke");
  assert.equal(loss.status,503);
  assert.equal(paidEnt.captureEntitlementEpoch(sql,{
    entitlementId,userId:"user_paid_17",productId:"prd_commercial_a17"
  }),2,"Failed canonical refund update leaves owner denial in place");
  failPrimaryWrite=false;
  // Full-order refunds revoke every canonical paid buyer in ONE strong owner
  // transaction, then ONE atomic canonical batch; no caller-supplied scopes.
  const refundOrderId="co_refund_21";
  const refundEnts=[
    {id:"02419dc7-6868-48e7-a1f5-c39f172bee0a",product:"prd_commercial_a17",item:"co_item_21"},
    {id:"98fd74fa-af84-4d87-a450-d84d30241a67",product:"prd_commercial_b18",item:"co_item_22"}
  ];
  db.prepare("INSERT INTO commerce_orders VALUES(?,?)").run(refundOrderId,"user_paid_17");
  for(const row of refundEnts){
    db.prepare("INSERT INTO commerce_order_items VALUES(?,?)").run(row.item,refundOrderId);
    db.prepare("INSERT INTO entitlements(id,user_id,product_id,status,entitlement_type,order_item_id) VALUES(?,?,?,'active','purchase',?)")
      .run(row.id,"user_paid_17",row.product,row.item);
  }
  operations.length=0;
  const fullRefund={orderId:refundOrderId,operationId:"refund_paid_order_21"};
  assert.equal((await post(fullRefund,{},"/commercial/entitlement/revoke-order")).status,200);
  assert.deepEqual(operations,[
    "canonical-evidence-check","authority","canonical-scope-discovery",
    "authority","canonical-atomic-batch"
  ],"One whole-order denial MUST precede per-entitlement owner and canonical batches");
  for(const row of refundEnts){
    assert.equal(db.prepare("SELECT status FROM entitlements WHERE id=?").get(row.id).status,
      "revoked");
    assert.equal(paidEnt.captureEntitlementEpoch(sql,{
      entitlementId:row.id,userId:"user_paid_17",productId:row.product
    }),1);
  }
  assert.equal((await post(fullRefund,{},"/commercial/entitlement/revoke-order")).status,200,
    "Exact full-refund event replay may not mutate buyer entitlement epochs");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cove_paid_refunded_orders WHERE order_id=?")
    .get(refundOrderId).n,1,"One durable order denial covers every original paid item");
  assert.equal(paidEnt.readPaidAccess(sql,{
    entitlementId:refundEnts[0].id,userId:"user_paid_17",
    productId:refundEnts[0].product,territory:"US",channel:"retail"
  }),null);
  assert.equal(paidEnt.captureEntitlementEpoch(sql,{
    entitlementId:refundEnts[0].id,userId:"user_paid_17",productId:refundEnts[0].product
  }),1);
  operations.length=0;failOwner=true;
  assert.equal((await post({...fullRefund,operationId:"refund_paid_order_22"},
    {},"/commercial/entitlement/revoke-order")).status,503);
  assert.deepEqual(operations,["canonical-evidence-check","authority"],
    "Owner outage must prevent even discovering/changing canonical refund entitlements");
  failOwner=false;failPrimaryBatch=true;
  assert.equal((await post({...fullRefund,operationId:"refund_paid_order_23"},
    {},"/commercial/entitlement/revoke-order")).status,503);
  assert.equal(paidEnt.captureEntitlementEpoch(sql,{
    entitlementId:refundEnts[0].id,userId:"user_paid_17",productId:refundEnts[0].product
  }),2,"Post-denial DB write failure must leave buyer explicitly denied");
  failPrimaryBatch=false;
  db.close();
  console.log("PASS: QA source quarantine, independent-country evidence withdrawal and atomic source retraction batch, fail closed, replay safe");
}finally{rmSync(directory,{force:true,recursive:true});}
