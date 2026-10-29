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
  db.exec("CREATE TABLE offers(id TEXT PRIMARY KEY,product_id TEXT,currency TEXT,active INTEGER,updated_at TEXT)");
  db.prepare("INSERT INTO offers VALUES('offer_a17','prd_commercial_a17','USD',1,'2026-10-26T00:00:00Z')").run();
  db.prepare("INSERT INTO offers VALUES('offer_a17_eur','prd_commercial_a17','EUR',1,'2026-10-26T00:00:00Z')").run();
  db.exec("CREATE TABLE products(id TEXT PRIMARY KEY,edition_id TEXT,source_name TEXT)");
  db.exec("CREATE TABLE entitlements(id TEXT PRIMARY KEY,user_id TEXT,product_id TEXT,status TEXT,entitlement_type TEXT,order_item_id TEXT)");
  db.exec("CREATE TABLE audio_offline_licenses(id TEXT PRIMARY KEY,entitlement_id TEXT,status TEXT,revoked_at TEXT,revocation_reason TEXT)");
  db.exec("CREATE TABLE commercial_delivery_grants(id TEXT PRIMARY KEY,entitlement_id TEXT,user_id TEXT,product_id TEXT,status TEXT)");
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
  let failRetailOffer=false;
  const publicationCalls=[];
  const owner={async fetch(request){
    operations.push("authority");
    if(failOwner)return new Response(null,{status:503});
    if(request.headers.get("authorization")!=="Bearer "+secret)
      return new Response(null,{status:401});
    const cmd=await request.json();
    const pathname=new URL(request.url).pathname;
    if(pathname==="/commercial/publish-verified"||
       pathname==="/storefront/publish-commercial"){
      publicationCalls.push({pathname,body:cmd});
      assert.equal(cmd.channel,"retail",
        "Canonical commercial positive publisher requires explicit retail channel");
      if(pathname==="/storefront/publish-commercial"&&failRetailOffer)
        return new Response(null,{status:503});
      return Response.json({applied:true,epoch:1});
    }
    if(pathname==="/commercial/deny-next"){
      db.exec("BEGIN");
      try{
        const receipt=commercial.denyCommercialProduct(sql,cmd);
        db.exec("COMMIT");
        return Response.json(receipt,{status:200});
      }catch{db.exec("ROLLBACK");return new Response(null,{status:409});}
    }
    if(pathname==="/commercial/order/deny-next"){
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
    if(new URL(request.url).pathname==="/commercial/subject/deny-next"){
      db.exec("BEGIN");
      try{
        const receipt=commercial.denyCommercialSubject(sql,cmd);
        db.exec("COMMIT");
        return Response.json(receipt);
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
  assert.equal((await post(cmd,{
    COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"
  })).status,503,"Private legal writer must reject customer production D1");
  assert.equal((await post(cmd,{
    COVE_LEGAL_WRITER_PRIMARY_ID:"e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3"
  })).status,503,"Private legal writer must never target hosted-capacity D1");
  assert.equal((await post({...cmd,sourceId:"../../test"},{
    COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"
  })).status,400,"Full-schema QA writer accepts the correct database pin but rejects invalid commands");
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
  assert.deepEqual(operations,["authority","canonical-atomic-batch"]);
  assert.equal(commercial.readCommercialProofs(sql,
    ["prd_commercial_c19"],"US","retail").length,0);
  assert.equal(db.prepare("SELECT status FROM rights_grants WHERE id='right_valid_19'").get().status,
    "suspended");
  assert.equal(db.prepare("SELECT status FROM rights_grants WHERE id='right_valid_17'").get().status,
    "active");
  operations.length=0;
  // One publisher contract with >25 editions MUST be withdrawable in
  // one owner write without enumeration, paging, or a partially live tail.
  for(let i=0;i<30;i++){
    const suffix=String(i).padStart(2,"0");
    db.prepare("INSERT INTO products VALUES(?,?,'partner')")
      .run("prd_contract_bulk_"+suffix,"ed_contract_bulk_"+suffix);
    db.prepare("INSERT INTO rights_grants(id,edition_id,source,territory_code,decision,status,contract_id) VALUES(?,?,?,?,?,?,?)")
      .run("right_contract_bulk_"+suffix,"ed_contract_bulk_"+suffix,"operator","US","allow","active","rcontract_17");
  }
  const contractSuspend={targetId:"rcontract_17",operationId:"contract-suspend:17:v1"};
  assert.equal((await post(contractSuspend,{},"/commercial/suspend-contract")).status,200);
  assert.deepEqual(operations,["authority","canonical-atomic-batch"]);
  assert.equal(db.prepare("SELECT status FROM rights_contracts WHERE id='rcontract_17'").get().status,
    "suspended");
  assert.deepEqual(db.prepare(
    "SELECT status FROM rights_grants WHERE contract_id='rcontract_17' ORDER BY id"
  ).all().map(v=>v.status),Array(32).fill("suspended"),
    "Owner subject-wide veto must reconcile all 32 contract grants");
  assert.equal(db.prepare("SELECT status FROM rights_contracts WHERE id='rcontract_18'").get().status,
    "active","Other publisher contract unaffected");
  assert.equal((await post(contractSuspend,{},"/commercial/suspend-contract")).status,200,
    "Same legal change is idempotent");
  const nowEpoch=commercial.captureCommercialEpoch(sql,{productId:"prd_commercial_a17"});
  assert.equal(nowEpoch,0,"Global subject denial does not require per-product epoch writes");
  failOwner=true;operations.length=0;
  assert.equal((await post({targetId:"rcontract_18",operationId:"contract-suspend:18:v1"},
    {},"/commercial/suspend-contract")).status,503);
  assert.deepEqual(operations,["authority"],
    "Owner outage cannot permit canonical contract update");
  assert.equal(db.prepare("SELECT status FROM rights_contracts WHERE id='rcontract_18'").get().status,
    "active");
  failOwner=false;operations.length=0;
  failPrimary=true;
  assert.equal((await post({targetId:"rcontract_18",operationId:"contract-suspend:18:d1-outage"},
    {},"/commercial/suspend-contract")).status,503);
  assert.deepEqual(operations,["authority","canonical-atomic-batch"],
    "D1 outage must never precede or suppress the durable subject denial");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cove_commercial_subject_denials WHERE subject_kind='contract' AND subject_id='rcontract_18'").get().n,1,
    "Owner denial must persist even when canonical D1 cannot be read or mutated");
  failPrimary=false;operations.length=0;
  failPrimaryBatch=true;
  assert.equal((await post({targetId:"rcontract_18",operationId:"contract-suspend:18:v2"},
    {},"/commercial/suspend-contract")).status,503);
  assert.deepEqual(sql.exec(
    "SELECT subject_id FROM cove_commercial_subject_denials WHERE subject_kind='contract' AND subject_id=?",
    "rcontract_18").toArray().map(r=>r.subject_id),["rcontract_18"],
    "D1 failure must retain durable global subject denial");
  failPrimaryBatch=false;
  const entitlementId="dc6197f2-945c-4362-b4bc-7dd928f3c980";
  db.prepare("INSERT INTO entitlements(id,user_id,product_id,status) VALUES(?,?,?,'active')").run(
    entitlementId,"user_paid_17","prd_commercial_a17"
  );
  db.prepare("INSERT INTO audio_offline_licenses(id,entitlement_id,status) VALUES(?,?,'active')").run("offline_a",entitlementId);
  db.prepare("INSERT INTO audio_offline_licenses(id,entitlement_id,status) VALUES(?,?,'active')").run("offline_b",entitlementId);
  db.prepare("INSERT INTO audio_offline_licenses(id,entitlement_id,status) VALUES(?,?,'active')").run("offline_other","different_entitlement");
  for(const id of ["epub_1","epub_2"])
    db.prepare("INSERT INTO commercial_delivery_grants(id,entitlement_id,user_id,product_id,status) VALUES(?,?,?,?,'active')")
      .run(id,entitlementId,"user_paid_17","prd_commercial_a17");
  db.prepare("INSERT INTO commercial_delivery_grants(id,entitlement_id,user_id,product_id,status) VALUES(?,?,?,?,'active')")
    .run("epub_unrelated","unrelated","other_user","prd_commercial_a17");
  db.prepare("INSERT INTO commercial_delivery_grants(id,entitlement_id,user_id,product_id,status) VALUES(?,?,?,?,'active')")
    .run("epub_wrong_user",entitlementId,"other_user","prd_commercial_a17");
  operations.length=0;
  const revoke={entitlementId,operationId:"refund:order17:ent17"};
  assert.equal((await post(revoke,{},"/commercial/entitlement/revoke")).status,200);
  assert.deepEqual(operations,["canonical-evidence-check","authority","canonical-atomic-batch"],
    "D1 beneficiary discovery, strong paid buyer deny, THEN atomic canonical entitlement/offline revoke");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id=?").get(entitlementId).status,
    "revoked");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audio_offline_licenses WHERE entitlement_id=? AND status='revoked' AND revoked_at IS NOT NULL AND revocation_reason='entitlement_revoked'").get(entitlementId).n,2,
    "All linked offline licenses are revoked in the same canonical D1 batch");
  assert.equal(db.prepare("SELECT status FROM audio_offline_licenses WHERE id='offline_other'").get().status,"active",
    "Unrelated buyers cannot be affected by entitlement revocation");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commercial_delivery_grants WHERE entitlement_id=? AND user_id='user_paid_17' AND status='revoked'").get(entitlementId).n,2,
    "Both active EPUB delivery grants must be revoked in the same atomic batch");
  assert.equal(db.prepare("SELECT status FROM commercial_delivery_grants WHERE id='epub_unrelated'").get().status,"active");
  assert.equal(db.prepare("SELECT status FROM commercial_delivery_grants WHERE id='epub_wrong_user'").get().status,"active",
    "A corrupted grant for a different buyer must not be revoked");
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
  failOwner=false;failPrimaryBatch=true;
  const loss=await post({...revoke,operationId:"refund:order17:ent19"},
    {},"/commercial/entitlement/revoke");
  assert.equal(loss.status,503);
  assert.equal(paidEnt.captureEntitlementEpoch(sql,{
    entitlementId,userId:"user_paid_17",productId:"prd_commercial_a17"
  }),2,"Failed atomic D1 reconciliation leaves durable owner denial in place");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id=?").get(entitlementId).status,"active",
    "D1 failure must leave both canonical rows unchanged");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audio_offline_licenses WHERE entitlement_id=? AND status='active'").get(entitlementId).n,0,
    "Previously revoked offline licenses cannot be reactivated by a failed retry");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commercial_delivery_grants WHERE user_id='user_paid_17' AND status='revoked'").get().n,2,
    "An owner replay outage must leave previously revoked EPUB tokens denied");
  failPrimaryBatch=false;
  operations.length=0;
  assert.equal((await post({...revoke,operationId:"refund:order17:ent19"},
    {},"/commercial/entitlement/revoke")).status,200,
    "Exact retry reconciles the previously denied entitlement");
  assert.deepEqual(operations,["canonical-evidence-check","authority","canonical-atomic-batch"]);
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id=?").get(entitlementId).status,"revoked");
  // One owner-order veto instantly withdraws every buyer proof. A single
  // indexed D1 UPDATE reconciles any number of items without RPC fanout.
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
  // A 32-item order proves that the former 25-entitlement ceiling is gone.
  for(let i=0;i<30;i++){
    const item="co_large_item_"+i,entitlement="ent_large_refund_"+i;
    db.prepare("INSERT INTO commerce_order_items VALUES(?,?)").run(item,refundOrderId);
    db.prepare("INSERT INTO entitlements(id,user_id,product_id,status,entitlement_type,order_item_id) VALUES(?,?,?,'active','purchase',?)")
      .run(entitlement,"user_paid_17","prd_commercial_large_"+i,item);
  }
  const importItem="co_public_domain_refund",importEnt="ent_public_domain_refund";
  db.prepare("INSERT INTO commerce_order_items VALUES(?,?)").run(importItem,refundOrderId);
  db.prepare("INSERT INTO entitlements(id,user_id,product_id,status,entitlement_type,order_item_id) VALUES(?,?,?,'active','purchase',?)")
    .run(importEnt,"user_paid_17","prd_gutenberg_2701",importItem);
  operations.length=0;
  const fullRefund={orderId:refundOrderId,operationId:"refund_paid_order_21"};
  assert.equal((await post(fullRefund,{},"/commercial/entitlement/revoke-order")).status,200);
  assert.deepEqual(operations,["canonical-evidence-check","authority","canonical-write"],
    "ONE strong order veto before ONE indexed canonical UPDATE for all 33 items");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entitlements WHERE status='revoked' AND order_item_id IN (SELECT id FROM commerce_order_items WHERE order_id=?)").get(refundOrderId).n,
    33,"Even an oversized mixed paid/public-domain purchase has every entitlement revoked");
  for(const row of refundEnts){
    assert.equal(db.prepare("SELECT status FROM entitlements WHERE id=?").get(row.id).status,
      "revoked");
    assert.equal(paidEnt.captureEntitlementEpoch(sql,{
      entitlementId:row.id,userId:"user_paid_17",productId:row.product
    }),0,"One whole-order fence does not churn 33 independent buyer epochs");
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
  }),0);
  operations.length=0;failOwner=true;
  assert.equal((await post({...fullRefund,operationId:"refund_paid_order_22"},
    {},"/commercial/entitlement/revoke-order")).status,503);
  assert.deepEqual(operations,["canonical-evidence-check","authority"],
    "Owner outage must prevent even discovering/changing canonical refund entitlements");
  failOwner=false;failPrimaryWrite=true;
  db.prepare("UPDATE entitlements SET status='active' WHERE id=?").run(refundEnts[0].id);
  assert.equal((await post({...fullRefund,operationId:"refund_paid_order_23"},
    {},"/commercial/entitlement/revoke-order")).status,503);
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE id=?").get(refundEnts[0].id).status,
    "active","Simulated D1 failure must occur after the whole-order owner denial");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cove_paid_refunded_orders WHERE order_id=?").get(refundOrderId).n,
    1,"Post-denial D1 failure MUST NOT restore buyer rights at the owner");
  failPrimaryWrite=false;
  // No caller-provided price, edition, grant or contract is trusted.
  const publish={productId:"prd_commercial_a17",territory:"US",currency:"USD",
    operationId:"qa:retail:a17:publish"};
  operations.length=0;publicationCalls.length=0;
  assert.equal((await post(publish,{},"/commercial/retail/publish-verified")).status,200);
  assert.deepEqual(operations,["authority","authority"],
    "Private owner legal proof must precede its exact retail offer publication");
  assert.deepEqual(publicationCalls,[
    {pathname:"/commercial/publish-verified",body:{
      productId:publish.productId,territory:"US",currency:"USD",channel:"retail"}},
    {pathname:"/storefront/publish-commercial",body:{
      productId:publish.productId,territory:"US",currency:"USD",channel:"retail"}}
  ],"Publisher cannot inject a cached price or contract");
  failRetailOffer=true;publicationCalls.length=0;
  assert.equal((await post({...publish,operationId:"qa:retail:a17:failed"},
    {},"/commercial/retail/publish-verified")).status,503);
  assert.equal(publicationCalls.length,2,"No positive offer receipt on second-stage failure");
  failRetailOffer=false;
  assert.equal((await post({...publish,productId:"prd_gutenberg_2701"},
    {},"/commercial/retail/publish-verified")).status,400);
  assert.equal((await post({...publish,currency:"XX"},
    {},"/commercial/retail/publish-verified")).status,400);
  operations.length=0;failOwner=true;
  assert.equal((await post({...publish,operationId:"qa:retail:a17:owner-down"},
    {},"/commercial/retail/publish-verified")).status,503);
  assert.deepEqual(operations,["authority"],"Owner outage cannot permit publication");
  failOwner=false;
  // Off-sale authorization must precede ALL primary catalog offer writes.
  const withdraw={productId:"prd_commercial_a17",
    operationId:"qa:retail:a17:all-offers-off"};
  operations.length=0;
  assert.equal((await post(withdraw,{},"/commercial/retail/withdraw")).status,200);
  assert.deepEqual(operations,["authority","canonical-write"],
    "All market/currency offers must be denied in owner BEFORE D1 deactivation");
  assert.equal(db.prepare("SELECT SUM(active) n FROM offers WHERE product_id=?")
    .get(withdraw.productId).n,0,
    "US and EU active offer currencies must both be deactivated");
  assert.equal(commercial.captureCommercialEpoch(sql,{productId:withdraw.productId}),1);
  assert.equal((await post(withdraw,{},"/commercial/retail/withdraw")).status,200,
    "Exact operation retry can reconcile D1 while the same denial is current");
  assert.equal(commercial.captureCommercialEpoch(sql,{productId:withdraw.productId}),1,
    "Retry must not advance immutable withdrawal epoch");
  assert.equal((await post({...withdraw,productId:"prd_gutenberg_2701"},
    {},"/commercial/retail/withdraw")).status,400);
  db.prepare("UPDATE offers SET active=1 WHERE product_id=?").run(withdraw.productId);
  operations.length=0;failOwner=true;
  assert.equal((await post({...withdraw,operationId:"qa:retail:a17:offline"},
    {},"/commercial/retail/withdraw")).status,503);
  assert.deepEqual(operations,["authority"],"Unavailable strong owner cannot mutate an offer");
  assert.equal(db.prepare("SELECT SUM(active) n FROM offers WHERE product_id=?")
    .get(withdraw.productId).n,2);
  failOwner=false;failPrimaryWrite=true;operations.length=0;
  assert.equal((await post({...withdraw,operationId:"qa:retail:a17:canonical-down"},
    {},"/commercial/retail/withdraw")).status,503);
  assert.deepEqual(operations,["authority","canonical-write"],
    "D1 failure after owner denial must be recorded, never bypass authorization");
  const deniedEpoch=commercial.captureCommercialEpoch(sql,{productId:withdraw.productId});
  assert.equal(db.prepare("SELECT SUM(active) n FROM offers WHERE product_id=?")
    .get(withdraw.productId).n,2,
    "Canonical reconciliation failure must not pretend the offer rows were updated");
  failPrimaryWrite=false;operations.length=0;
  assert.equal((await post({...withdraw,operationId:"qa:retail:a17:canonical-down"},
    {},"/commercial/retail/withdraw")).status,200,
    "An interrupted canonical reconciliation must be retryable");
  assert.equal(commercial.captureCommercialEpoch(sql,{productId:withdraw.productId}),deniedEpoch);
  assert.equal(db.prepare("SELECT SUM(active) n FROM offers WHERE product_id=?")
    .get(withdraw.productId).n,0);
  db.close();
  console.log("PASS: paid retail deny-first all-currency withdrawal, primary outage and replay; legal writer fail-closed");
}finally{rmSync(directory,{force:true,recursive:true});}
