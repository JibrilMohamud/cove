/* eslint-disable prettier/prettier -- Real isolated QA owner/SQLite contract-version, retry, denial, and authorization tests. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {readdirSync,readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-owned-contract-"));
const primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");
try{
  const workerFile=join(folder,"worker.mjs"),facadeFile=join(folder,"facade.mjs");
  const plugins=[{name:"test-owner-host",setup(b){
    b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"test-host",namespace:"owner-host"}));
    b.onLoad({filter:/.*/,namespace:"owner-host"},()=>({contents:
      "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
  }}];
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],outfile:workerFile,
    bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",plugins});
  await build({entryPoints:["src/storefront-strangler/owner-contract-version.server.ts"],outfile:facadeFile,
    bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {CoveLegalAuthority}=await import(pathToFileURL(workerFile).href);
  const {saveStageOwnerContractVersion:save}=await import(pathToFileURL(facadeFile).href);
  primary.exec("PRAGMA foreign_keys=ON");
  for(const f of readdirSync("drizzle").filter(f=>/^\d+.*\.sql$/.test(f)).sort())
    primary.exec(readFileSync(join("drizzle",f),"utf8"));
  const at="2026-10-29T12:00:00.000Z",actor="staff_contract_owner_qa",other="staff_contract_forged_qa",contractId="rcontract_owner_qa";
  primary.prepare("INSERT INTO rights_contracts(id,reference_code,name,status,language_match_mode,source,notes,created_at,updated_at) VALUES(?,'OWNER-QA','Private contract','active','all','operator','',?,?)").run(contractId,at,at);
  primary.prepare("INSERT INTO staff_principals(user_id,status,created_at,updated_at) VALUES(?,'active',?,?)").run(actor,at,at);
  const seeded=primary.prepare("SELECT role_id FROM staff_role_permissions WHERE permission='finance.contract.manage' LIMIT 1").get();
  assert.ok(seeded?.role_id,"A real finance.contract.manage role must exist");
  primary.prepare("INSERT INTO staff_principal_roles(user_id,role_id,granted_at) VALUES(?,?,?)").run(actor,seeded.role_id,at);
  const db={prepare(sql){return {bind(...values){return {
    async first(){return primary.prepare(sql).get(...values)||null;},
    async all(){return {results:primary.prepare(sql).all(...values)};},
    async run(){return {meta:{changes:primary.prepare(sql).run(...values).changes}};}
  };}};},async batch(statements){
    primary.exec("BEGIN");
    try{const results=[];for(const s of statements)results.push(await s.run());primary.exec("COMMIT");return results;}
    catch(e){primary.exec("ROLLBACK");throw e;}
  }};
  const storageSql={exec(sql,...values){const stmt=durable.prepare(sql);
    const rows=stmt.columns().length?stmt.all(...values):(stmt.run(...values),[]);
    return {toArray:()=>rows};
  }};
  const secret="a".repeat(64);
  const ownerEnv={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",
    COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600_000),
    COVE_RIGHTS_OWNER_SECRET:secret};
  const owner=new CoveLegalAuthority({storage:{sql:storageSql,transactionSync(fn){
    durable.exec("BEGIN");try{const result=fn();durable.exec("COMMIT");return result;}
    catch(e){durable.exec("ROLLBACK");throw e;}
  }}},ownerEnv);
  const stage={COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",COVE_SSR_STAGING:"1",
    COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",COVE_LEGAL_WRITER_PRIMARY_ID:ownerEnv.COVE_RIGHTS_OWNER_PRIMARY_ID,
    COVE_RIGHTS_OWNER_SECRET:secret,LEGAL_AUTHORITY:{getByName(name){
      assert.equal(name,"cove-staged-legal-global-v1");return owner;
    }}};
  const input={contractId,versionNumber:1,status:"draft",effectiveFrom:at,
    retailerCommissionBps:3000,paymentSchedule:{cadence:"monthly",netDays:30},
    territories:[{territoryCode:"US",decision:"allow"}],
    formats:[{format:"ebook",decision:"allow",drmRequirement:"none",offlinePermitted:true}],
    channels:[{salesChannel:"retail",permitted:true}]};
  const auditCount=()=>primary.prepare("SELECT count(*) n FROM rights_contract_audit").get().n;
  const draft=await save(stage,db,actor,input);
  assert.equal(draft.contractId,contractId);assert.equal(draft.status,"draft");
  assert.equal(auditCount(),1);
  assert.deepEqual(await save(stage,db,actor,input),draft,"Exact retry must return journal receipt");
  assert.equal(auditCount(),1,"Exact retry must not add an audit event");
  const active={...input,versionNumber:2,status:"active",effectiveFrom:"2026-10-30T00:00:00.000Z"};
  const published=await save(stage,db,actor,active);
  assert.equal(published.status,"active");
  assert.equal(primary.prepare("SELECT status FROM rights_contract_versions WHERE id=?").get(published.id).status,"active");
  assert.equal(auditCount(),2);
  assert.ok(durable.prepare("SELECT count(*) n FROM cove_owner_contract_version_commands WHERE state='completed'").get().n===2);
  assert.equal(durable.prepare("SELECT count(*) n FROM cove_commercial_subject_denials").get().n,1,
    "Active contract migration must commit durable denial before D1 write");
  assert.deepEqual(await save(stage,db,actor,active),published);
  assert.equal(auditCount(),2);
  await assert.rejects(()=>save(stage,db,other,{...input,versionNumber:3}),/not acknowledged/);
  assert.equal(auditCount(),2,"Forged staff must never mutate a contract");
  for(const bad of [
    {...input,versionNumber:3,effectiveTo:"2026-01-01T00:00:00.000Z",status:"active"},
    {...input,versionNumber:3,territories:[{territoryCode:"USA"}]},
    {...input,versionNumber:2,status:"active"},
  ])await assert.rejects(()=>save(stage,db,actor,bad));
  assert.equal(auditCount(),2);
  for(const overrides of [
    {COVE_CANONICAL_LEGAL_WRITE_LOCK:"0"},{COVE_SSR_STAGING:"0"},
    {COVE_LEGAL_WRITER_PRIMARY_ID:"4bd657ac-8789-403e-a28c-93aba8d0a989"},
    {COVE_RIGHTS_OWNER_SECRET:"not-a-secret"},{LEGAL_AUTHORITY:null}
  ])await assert.rejects(()=>save({...stage,...overrides},db,actor,{...input,versionNumber:3}));
  ownerEnv.COVE_RIGHTS_OWNER_ENABLED="0";
  await assert.rejects(()=>save(stage,db,actor,{...input,versionNumber:3}),/not acknowledged/);
  assert.equal(auditCount(),2);
  console.log("PASS: isolated real owner contract versions independently authorize staff, deny first, replay once, reject invalid terms and fail closed");
}finally{primary.close();durable.close();rmSync(folder,{recursive:true,force:true});}
