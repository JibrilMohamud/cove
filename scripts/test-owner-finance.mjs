/* eslint-disable prettier/prettier -- Real owner, full migrated SQLite, injected financial write failures and response loss. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,readdirSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadPrivateFinance} from "./test-private-finance-loader.mjs";
const folder=mkdtempSync(join(tmpdir(),"cove-finance-")),stores=[];
try{
 const {CoveLegalAuthority}=await loadPrivateFinance(join(folder,"owner.mjs"));
 const migrations=readdirSync("drizzle").filter(x=>x.endsWith(".sql")).sort().map(x=>readFileSync("drizzle/"+x,"utf8"));
 function fixture(){
  const primary=new DatabaseSync(":memory:"),durable=new DatabaseSync(":memory:");stores.push(primary,durable);
  for(const migration of migrations)primary.exec(migration);
  primary.exec("PRAGMA foreign_keys=OFF");
  const actor="staff_finance_qa",intruder="staff_intruder_qa";
  for(const user of [actor,intruder])primary.prepare("INSERT INTO staff_principals(user_id,status,created_at,updated_at) VALUES(?,'active','2026-01-01','2026-01-01')").run(user);
  primary.prepare("INSERT OR IGNORE INTO staff_roles(id,name,description) VALUES('qa_finance','QA','QA')").run();
  primary.prepare("INSERT INTO staff_principal_roles(user_id,role_id,granted_at) VALUES(?,'qa_finance','2026-01-01')").run(actor);
  for(const permission of ["finance.manage","finance.contract.manage","finance.usage.ingest"])
   primary.prepare("INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES('qa_finance',?)").run(permission);
  let failAt=-1,loseResponse=false,loseRun=false,batchSize=0,royaltyFail=-1;
  const db={prepare(query){const statement=(values=[])=>({query,bind:(...v)=>statement(v),
    async first(){return primary.prepare(query).get(...values)||null;},
    async all(){return {results:primary.prepare(query).all(...values)};},
    async run(){const meta=primary.prepare(query).run(...values);if(loseRun){loseRun=false;throw Error("lost_run_response");}return {meta};},
    execute(){return {meta:primary.prepare(query).run(...values)};}
   });return statement();},async batch(statements){batchSize=statements.length;
    if(statements.some(x=>x.query.includes("INSERT INTO finance_royalty_calculations"))&&--royaltyFail===0)throw Error("royalty_processing_interrupted");
    primary.exec("BEGIN");
    try{const result=[];for(let i=0;i<statements.length;i++){if(i===failAt)throw Error("injected_finance_write_"+i);result.push(statements[i].execute());}
     primary.exec("COMMIT");if(loseResponse){loseResponse=false;throw Error("lost_batch_response");}return result;
    }catch(e){if(primary.isTransaction)primary.exec("ROLLBACK");throw e;}
   }};
  const sql={exec(text,...values){const q=durable.prepare(text),rows=q.columns().length?q.all(...values):(q.run(...values),[]);return {toArray:()=>rows};}};
  const secret="a".repeat(64),env={PRIMARY_DB:db,COVE_RIGHTS_OWNER_ENABLED:"1",COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),COVE_RIGHTS_OWNER_SECRET:secret};
  let owner;const restart=()=>{owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){return fn();}}},env);};restart();
  const command=(action,arg,n=1,user=actor)=>({action,args:[arg],actorUserId:user,operationId:"finance:"+n.toString(16).padStart(64,"0")});
  const request=(body,key=secret)=>owner.fetch(new Request("https://legal-authority.internal/finance/private-action",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify(body)}));
  const call=async body=>{const res=await request(body);assert.equal(res.status,200,await res.clone().text());return (await res.json()).result;};
  return {primary,durable,actor,intruder,env,command,request,call,restart,inject(n){failAt=n;},loseBatch(){loseResponse=true;},loseRun(){loseRun=true;},size:()=>batchSize,failSecondRoyalty(){royaltyFail=2;}};
 }
 const f=fixture(),party={type:"publisher",displayName:"QA publisher",taxCountry:"US",payoutCurrency:"USD"};
 assert.equal((await f.request(f.command("createFinanceParty",party,1,f.intruder))).status,403);
 assert.equal((await f.request(f.command("createFinanceParty",party),"b".repeat(64))).status,401);
 assert.equal((await f.request({...f.command("createFinanceParty",party),sql:"DROP TABLE finance_parties"})).status,503);
 let result=await f.call(f.command("createFinanceParty",party));const partyId=result.id;
 assert.deepEqual(await f.call(f.command("createFinanceParty",party)),result);
 assert.equal((await f.request(f.command("createFinanceParty",{...party,displayName:"conflict"}))).status,409);
 assert.equal(f.primary.prepare("SELECT COUNT(*) n FROM finance_parties").get().n,1);
 f.loseRun();assert.equal((await f.request(f.command("createFinanceParty",party,2))).status,503);f.restart();
 await f.call(f.command("createFinanceParty",party,2));assert.equal(f.primary.prepare("SELECT COUNT(*) n FROM finance_parties").get().n,2);
 const contract={name:"QA royalty",effectiveFrom:"2025-01-01T00:00:00Z",splits:[{partyId,shareBps:10000}]};
 const made=await f.call(f.command("createRoyaltyContract",contract,3));
 assert.equal(f.primary.prepare("SELECT COUNT(*) n FROM finance_royalty_contract_versions WHERE contract_id=?").get(made.id).n,1);
 const version={contractId:made.id,effectiveFrom:"2026-01-01T00:00:00Z",splits:[{partyId,shareBps:10000}],createdByUserId:f.intruder};
 f.inject(1);assert.equal((await f.request(f.command("createRoyaltyContractVersion",version,4))).status,503);
 assert.equal(f.primary.prepare("SELECT COUNT(*) n FROM finance_royalty_contract_versions WHERE contract_id=?").get(made.id).n,1,"No partial contract version can survive a split failure");
 f.inject(-1);f.loseBatch();assert.equal((await f.request(f.command("createRoyaltyContractVersion",version,4))).status,503);f.restart();
 const verified=await f.call(f.command("createRoyaltyContractVersion",version,4));
 assert.equal(f.primary.prepare("SELECT created_by_user_id FROM finance_royalty_contract_versions WHERE id=?").get(verified.versionId).created_by_user_id,f.actor);
 assert.equal(f.primary.prepare("SELECT COUNT(*) n FROM finance_royalty_contract_versions WHERE contract_id=?").get(made.id).n,2);
 assert.equal(f.primary.prepare("SELECT COUNT(*) n FROM finance_royalty_splits WHERE contract_version_id=?").get(verified.versionId).n,1);
 const pool={poolType:"subscription",periodStart:"2026-01-01T00:00:00Z",periodEnd:"2026-02-01T00:00:00Z",currency:"USD",poolMinor:1000,metric:"pages"};
 f.loseRun();assert.equal((await f.request(f.command("createUsagePool",pool,5))).status,503);f.restart();await f.call(f.command("createUsagePool",pool,5));
 assert.equal(f.primary.prepare("SELECT COUNT(*) n FROM finance_usage_pools").get().n,1);

 // Payout approval and every item posting are all-or-nothing, including both
 // balanced ledger sides. A second batch cannot reserve the same allocation.
 const payout=fixture();
 const payee=(await payout.call(payout.command("createFinanceParty",party,10))).id;
 payout.primary.prepare("INSERT INTO finance_royalty_allocations(id,calculation_id,party_id,share_bps,royalty_minor,withholding_minor,reserve_minor,payable_minor,currency,status,available_at,created_at) VALUES('alloc_qa','calc_qa',?,10000,1000,0,0,1000,'USD','accrued','2025-01-01','2025-01-01')").run(payee);
 const batchInput={currency:"USD",periodStart:"2024-01-01T00:00:00Z",periodEnd:"2026-01-01T00:00:00Z"};
 payout.inject(1);assert.equal((await payout.request(payout.command("createPayoutBatch",batchInput,11))).status,503);
 assert.equal(payout.primary.prepare("SELECT COUNT(*) n FROM payout_batches").get().n,0);
 payout.inject(-1);payout.loseBatch();assert.equal((await payout.request(payout.command("createPayoutBatch",batchInput,11))).status,503);payout.restart();
 const batch=await payout.call(payout.command("createPayoutBatch",batchInput,11));
 assert.equal(batch.netMinor,1000);assert.equal(payout.primary.prepare("SELECT COUNT(*) n FROM payout_items").get().n,1);
 const other=await payout.call(payout.command("createPayoutBatch",batchInput,12));assert.equal(other.netMinor,0,"No duplicate allocation reservation in a second payout");
 payout.inject(1);assert.equal((await payout.request(payout.command("approvePayoutBatch",batch.id,13))).status,503);
 assert.equal(payout.primary.prepare("SELECT status FROM payout_batches WHERE id=?").get(batch.id).status,"draft");
 assert.equal(payout.primary.prepare("SELECT status FROM finance_royalty_allocations WHERE id='alloc_qa'").get().status,"accrued");
 payout.inject(-1);await payout.call(payout.command("approvePayoutBatch",batch.id,13));
 const item=payout.primary.prepare("SELECT id FROM payout_items WHERE batch_id=?").get(batch.id).id;
 const settle=payout.command("settlePayoutBatch",{batchId:batch.id,settlements:[{payoutItemId:item,externalPayoutId:"qa_settlement_fixture"}]},14);
 for(let i=0;i<5;i++){
  payout.inject(i);assert.equal((await payout.request(settle)).status,503);
  assert.equal(payout.primary.prepare("SELECT status FROM payout_items WHERE id=?").get(item).status,"pending");
  assert.equal(payout.primary.prepare("SELECT COUNT(*) n FROM commerce_ledger_entries").get().n,0);
 }
 payout.inject(-1);payout.loseBatch();assert.equal((await payout.request(settle)).status,503);payout.restart();
 assert.equal((await payout.call(settle)).status,"paid");
 assert.equal(payout.primary.prepare("SELECT COUNT(*) n,SUM(amount_minor) total FROM commerce_ledger_entries").get().n,2);
 assert.equal(payout.primary.prepare("SELECT SUM(amount_minor) total FROM commerce_ledger_entries").get().total,0);
 await payout.call(settle);assert.equal(payout.primary.prepare("SELECT COUNT(*) n FROM commerce_ledger_entries").get().n,2);
 assert.equal((await payout.request(payout.command("settlePayoutBatch",{batchId:batch.id,settlements:[{payoutItemId:item,externalPayoutId:"qa_different_reference"}]},15))).status,503);

 // Recovery after the second event fails must preserve the original complete
 // allocation vector and finish only its remaining event after owner restart.
 const usage=fixture(),at="2025-01-01T00:00:00Z";
 const up=(await usage.call(usage.command("createFinanceParty",party,20))).id;
 await usage.call(usage.command("createRoyaltyContract",{...contract,salesChannel:"subscription",splits:[{partyId:up,shareBps:10000}]},21));
 usage.primary.prepare("INSERT INTO editions(id,work_id,title,created_at,updated_at) VALUES('ed_usage','work_usage','QA',?,?)").run(at,at);
 usage.primary.prepare("INSERT INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES('prd_usage','ed_usage','sku_usage','ebook','qa','qa_usage',?,?)").run(at,at);
 for(let i=0;i<2;i++)await usage.call(usage.command("recordUsageEvent",{sourceType:"subscription_read",sourceReference:"qa_usage_"+i,productId:"prd_usage",territory:"US",currency:"USD",pagesRead:10,occurredAt:"2026-01-05T00:00:00Z"},22+i));
 const allocatedPool=await usage.call(usage.command("createUsagePool",{...pool,poolMinor:1001},24));
 const allocationCommand=usage.command("allocateUsagePool",allocatedPool.id,25);
 usage.failSecondRoyalty();assert.equal((await usage.request(allocationCommand)).status,503);
 assert.equal(usage.primary.prepare("SELECT status FROM finance_usage_pools WHERE id=?").get(allocatedPool.id).status,"locked");
 assert.equal(usage.primary.prepare("SELECT SUM(gross_value_minor) n FROM finance_usage_events WHERE pool_id=?").get(allocatedPool.id).n,1001);
 assert.equal(usage.primary.prepare("SELECT COUNT(*) n FROM finance_usage_events WHERE processed_at IS NOT NULL").get().n,1);
 usage.restart();assert.equal((await usage.call(allocationCommand)).status,"allocated");
 assert.equal(usage.primary.prepare("SELECT SUM(gross_value_minor) n FROM finance_usage_events WHERE pool_id=?").get(allocatedPool.id).n,1001);
 assert.equal(usage.primary.prepare("SELECT COUNT(*) n FROM finance_royalty_calculations").get().n,2);
 assert.equal(usage.primary.prepare("SELECT SUM(amount_minor) n FROM commerce_ledger_entries").get().n,0);
 await usage.call(allocationCommand);assert.equal(usage.primary.prepare("SELECT COUNT(*) n FROM finance_royalty_calculations").get().n,2);
 f.env.COVE_RIGHTS_OWNER_ENABLED="0";assert.equal((await f.request(f.command("createFinanceParty",party,10))).status,503);
 console.log("PASS: private finance commands enforce independent staff, strict input, actor attribution, durable replay conflict, contract/split atomicity, owner restart and lost D1 responses");
}finally{for(const db of stores)db.close();rmSync(folder,{recursive:true,force:true});}
