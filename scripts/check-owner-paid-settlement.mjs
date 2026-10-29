/* eslint-disable prettier/prettier -- Real SQLite transactions, full schema and actual private owner handlers. */
import assert from "node:assert/strict";
import {isPaidOwnerQaSchemaTable} from "./staging/paid-owner-schema-policy.mjs";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,readdirSync,readFileSync,rmSync,copyFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
const folder=mkdtempSync(join(tmpdir(),"cove-owner-paid-")),databases=[];
try{
  async function load(entry,name,host=false){
    const outfile=join(folder,name+".mjs");
    await build({entryPoints:[entry],outfile,bundle:true,format:"esm",platform:"node",target:"node22",logLevel:"silent",
      alias:{jszip:"jszip/dist/jszip.min.js"},plugins:host?[{name:"host",setup(b){
        b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"host"}));
        b.onLoad({filter:/.*/,namespace:"host"},()=>({contents:"export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
      }}]:[]});return import(pathToFileURL(outfile).href);
  }
  const {postPaidSettlementTransaction:post}=await load("src/features/fore/paid-settlement-transaction.server.ts","transaction");
  const {CoveLegalAuthority,default:worker}=await load("src/storefront-strangler/legal-authority.worker.ts","owner",true);
  const {finalizePaidOrder}=await load("src/features/fore/commerce.server.ts","caller");
  const {makeStageLegalWriterLock}=await load("src/storefront-strangler/legal-primary-write-lock.ts","lock");
  const legal=await load("src/storefront-strangler/commercial-legal-core.ts","legal");
  const {ownerSettlementDiagnostic:diagnostic}=await load(
    "src/storefront-strangler/owner-settlement-diagnostic.ts","diagnostic");
  for(const [message,expected] of [
    ["Settlement line inventory is invalid or already partially written.","settlement_line_inventory_invalid"],
    ["Settlement reservations do not cover canonical tender.","settlement_reservation_mismatch"],
    ["No active royalty contract covers prd_private_buy_99 / US / retail.","settlement_royalty_contract_missing"],
    ["Royalty contract version private_contract_v5 has no payee splits.","settlement_royalty_splits_missing"],
    ["Royalty split must allocate exactly 100% for contract version private_contract_v5; found 75%.","settlement_royalty_splits_invalid"],
    ["isolated_settlement_effect_interruption","qa_expected_effect_interruption"],
    ["an unreviewed private provider response","unclassified_failure"]
  ]) {
    const observed=diagnostic(new Error(message));
    assert.equal(observed,expected);
    assert.equal(observed.includes("private"),false,"Owner diagnostic must never disclose provider or buyer details");
  }
  for(const [frame,code] of [
    ["calculateAndAccrueRoyalty","settlement_royalty_calculation_failed"],
    ["postPaidSettlementTransaction","settlement_atomic_transaction_failed"],
    ["reconcileOwnerPaidSettlementEffects","settlement_postcommit_effects_failed"],
    ["executeOwnerPaidSettlement","settlement_owner_execution_failed"]
  ]) {
    const failure=new Error("Untrusted buyer token / custom SQL / provider payload");
    failure.stack="Error: private failure\\n at "+frame+" (secret/path:12:34)";
    assert.equal(diagnostic(failure),code,"Private owner diagnostic must expose only a constant stage");
    assert.ok(!diagnostic(failure).includes("secret"));
  }
  const orderId="order_atomic_settlement",userId="user_atomic_settlement",secret="d".repeat(64),at="2026-01-01T00:00:00.000Z";
  const migrations=readdirSync("drizzle").filter(x=>x.endsWith(".sql")).sort().map(x=>readFileSync(join("drizzle",x),"utf8"));
  const stripePayment={provider:"stripe",paymentIntentId:"pi_atomic_settlement",chargeId:"ch_atomic_settlement",receiptUrl:null,paymentMethod:"card",processorFee:{amountMinor:2,currency:"USD",reference:"txn_atomic_settlement",netMinor:48}};
  const internalPayment={provider:"internal",paymentIntentId:null,chargeId:null,receiptUrl:null,paymentMethod:"Internal balance"};
  const templatePath=join(folder,"schema.sqlite"),template=new DatabaseSync(templatePath);
  migrations.forEach(sql=>template.exec(sql));template.close();let fixtureNumber=0;
  function fixture({stripe=50,gift=30,store=20,count=2,preorder=false}={}){
    const fixturePath=join(folder,"fixture-"+(fixtureNumber++)+".sqlite");copyFileSync(templatePath,fixturePath);
    const primary=new DatabaseSync(fixturePath),owned=new DatabaseSync(":memory:");databases.push(primary,owned);
    primary.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF");
    const insert=(table,row)=>{const keys=Object.keys(row);primary.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));};
    insert("finance_parties",{id:"party_atomic",party_type:"author",display_name:"Fixture author",created_at:at,updated_at:at});
    insert("finance_royalty_contracts",{id:"finance_contract_atomic",name:"Fixture terms",effective_from:at,created_at:at,updated_at:at});
    insert("finance_royalty_contract_versions",{id:"finance_version_atomic",contract_id:"finance_contract_atomic",version:1,effective_from:at,created_at:at});
    insert("finance_royalty_splits",{id:"split_atomic",contract_version_id:"finance_version_atomic",party_id:"party_atomic",share_bps:10000,created_at:at});
    const total=stripe+gift+store;
    insert("commerce_orders",{id:orderId,user_id:userId,invoice_number:"ATOMIC-1",status:"pending_payment",currency:"USD",territory_code:"US",subtotal_minor:total,total_minor:total,stripe_due_minor:stripe,gift_card_minor:gift,store_credit_minor:store,billing_address_json:"{}",idempotency_key:"atomic:settlement",stripe_payment_intent_id:stripe?stripePayment.paymentIntentId:null,created_at:at,updated_at:at});
    if(gift){
      insert("commerce_gift_cards",{code_hash:"gift_atomic",last4:"1234",currency:"USD",original_balance_minor:1000,balance_minor:1000,created_at:at,updated_at:at});
      insert("commerce_balance_reservations",{id:"reserve_gift_atomic",user_id:userId,order_id:orderId,source_type:"gift_card",source_key:"gift_atomic",amount_minor:gift,currency:"USD",status:"reserved",expires_at:"2099-01-01T00:00:00Z",created_at:at,updated_at:at});
    }
    if(store){
      insert("commerce_store_credit_ledger",{id:"initial_credit",user_id:userId,entry_type:"adjustment",amount_minor:1000,currency:"USD",created_at:at});
      insert("commerce_balance_reservations",{id:"reserve_credit_atomic",user_id:userId,order_id:orderId,source_type:"store_credit",source_key:userId,amount_minor:store,currency:"USD",status:"reserved",expires_at:"2099-01-01T00:00:00Z",created_at:at,updated_at:at});
    }
    for(let i=0;i<count;i++){
      const productId="prd_atomic_settlement_"+i,editionId="edition_atomic_"+i;
      insert("works",{id:"work_atomic_"+i,title:"Atomic title",created_at:at,updated_at:at});
      insert("editions",{id:editionId,work_id:"work_atomic_"+i,title:"Atomic title",release_status:preorder?"preorder":"released",release_date:preorder?"2099-01-01T00:00:00Z":null,created_at:at,updated_at:at});
      insert("products",{id:productId,edition_id:editionId,sku:productId,format:"ebook",source_name:"publisher",source_external_id:productId,created_at:at,updated_at:at});
      insert("commerce_order_items",{id:"item_atomic_settlement_"+i,order_id:orderId,product_id:productId,title_snapshot:"Atomic title",sku_snapshot:productId,unit_amount_minor:total/count,total_minor:total/count,rights_grant_id:"grant_atomic_"+i,rights_snapshot_json:JSON.stringify({grantId:"grant_atomic_"+i,editionId,contractId:"contract_atomic",contractVersionId:"contract_version_atomic",territory:"US",salesChannel:"retail"}),created_at:at});
      if(preorder){
        insert("publishing_accounts",{id:"account_atomic_"+i,account_type:"person",legal_name:"Fixture",display_name:"Fixture",country_code:"US",created_at:at,updated_at:at});
        insert("publishing_titles",{id:"title_atomic_"+i,account_id:"account_atomic_"+i,title:"Fixture",created_at:at,updated_at:at});
        insert("publishing_edition_drafts",{id:"draft_atomic_"+i,title_id:"title_atomic_"+i,created_at:at,updated_at:at});
        insert("preorder_release_plans",{id:"plan_atomic_"+i,publishing_edition_id:"draft_atomic_"+i,product_id:productId,opens_at:at,release_at:"2099-01-01T00:00:00Z",manuscript_deadline_at:"2098-01-01T00:00:00Z",status:"open",created_at:at,updated_at:at});
      }
    }
    let failAt=-1,lostAck=false,beforeBatch=null,writes=0,lastBatchSize=0,runFailure=null;
    const sql={exec(query,...args){const q=owned.prepare(query);const rows=q.columns().length?q.all(...args):(q.run(...args),[]);return {toArray:()=>rows};}};
    const DB={prepare(query){function bound(args=[]){return {bind:(...a)=>bound(a),async first(){return primary.prepare(query).get(...args)||null;},async all(){return {results:primary.prepare(query).all(...args)};},async run(){
      if(runFailure?.(query))throw Error("injected_effect_outage");
      writes++;const q=primary.prepare(query);return {success:true,meta:{changes:Number(q.run(...args).changes)}};
    },query,args};}return bound();},async batch(statements){
      lastBatchSize=statements.length;if(beforeBatch)await beforeBatch();primary.exec("BEGIN");let committed=false;try{
        const results=[];for(let i=0;i<statements.length;i++){
          if(i===failAt)throw Error("injected_batch_outage");results.push(await statements[i].run());
        }
        primary.exec("COMMIT");committed=true;if(lostAck){lostAck=false;throw Error("lost_commit_ack");}return results;
      }catch(e){if(!committed)primary.exec("ROLLBACK");throw e;}
    }};
    const env={PRIMARY_DB:DB,COVE_RIGHTS_OWNER_ENABLED:"1",COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+10*60_000),COVE_RIGHTS_OWNER_SECRET:secret,STRIPE_LIVEMODE:"false",STRIPE_TAX_ENABLED:"false",STRIPE_SECRET_KEY:"sk_test_fixture_only"};
    const ctx={storage:{sql,transactionSync(fn){owned.exec("BEGIN");try{const r=fn();owned.exec("COMMIT");return r;}catch(e){owned.exec("ROLLBACK");throw e;}}}};
    let owner=new CoveLegalAuthority(ctx,env);
    for(let i=0;i<count;i++)legal.publishFreshCommercialProof(sql,{productId:"prd_atomic_settlement_"+i,editionId:"edition_atomic_"+i,grantId:"grant_atomic_"+i,contractId:"contract_atomic",contractVersionId:"contract_version_atomic",territory:"US",channel:"retail",validUntil:new Date(Date.now()+10*60_000).toISOString()},0);
    env.LEGAL_AUTHORITY={getByName(){return owner;}};
    const request=(path,body)=>new Request("https://legal-authority.internal"+path,{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify(body)});
    const command=(body={orderId})=>worker.fetch(request("/commercial/order/settle",body),env);
    const snapshot=()=>({status:primary.prepare("SELECT status FROM commerce_orders WHERE id=?").get(orderId).status,gift:primary.prepare("SELECT balance_minor FROM commerce_gift_cards LIMIT 1").get()?.balance_minor,credit:primary.prepare("SELECT SUM(amount_minor) amount FROM commerce_store_credit_ledger").get().amount,entitlements:primary.prepare("SELECT COUNT(*) n FROM entitlements").get().n,ledger:primary.prepare("SELECT COUNT(*) n FROM commerce_ledger_entries").get().n,receipt:primary.prepare("SELECT COUNT(*) n FROM commerce_settlement_receipts").get().n,reservations:primary.prepare("SELECT status FROM commerce_balance_reservations ORDER BY id").all().map(x=>x.status),preorders:primary.prepare("SELECT COUNT(*) n FROM preorders").get().n});
    return {primary,owned,DB,sql,env,command,snapshot,insert,request,get owner(){return owner;},
      post:(payment=stripe?stripePayment:internalPayment)=>post(DB,orderId,payment),
      setFailAt(i){failAt=i;},setLostAck(){lostAck=true;},setBeforeBatch(fn){beforeBatch=fn;},setRunFailure(fn){runFailure=fn;},restart(){owner=new CoveLegalAuthority(ctx,env);},stats:()=>({writes,lastBatchSize})};
  }
  const f=fixture();const before=f.snapshot();
  const result=await f.post();assert.equal(result.applied,true);
  assert.deepEqual(f.snapshot(),{status:"paid",gift:970,credit:980,entitlements:2,ledger:10,receipt:1,reservations:["consumed","consumed"],preorders:0});
  assert.equal(f.primary.prepare("SELECT SUM(amount_minor) n FROM commerce_ledger_entries").get().n,0);
  assert.equal(f.primary.prepare("SELECT COUNT(*) n FROM entitlement_ownership_records").get().n,2);
  const after=f.snapshot(),writes=f.stats().writes;
  assert.equal((await f.post()).applied,false);assert.deepEqual(f.snapshot(),after);assert.equal(f.stats().writes,writes);
  // Exhaust every failure boundary in the real multi-tender/multi-line batch.
  const batchSize=f.stats().lastBatchSize;
  for(let i=0;i<batchSize;i++){
    const x=fixture();x.setFailAt(i);await assert.rejects(()=>x.post(),/injected_batch_outage/);
    assert.deepEqual(x.snapshot(),before,"Partial settlement escaped rollback at statement "+i);
    for(const table of ["finance_royalty_calculations","finance_royalty_allocations","finance_royalty_events"])
      assert.equal(x.primary.prepare("SELECT COUNT(*) n FROM "+table).get().n,0,"Royalty partial posting survived rollback");
  }
  const lost=fixture();lost.setLostAck();await assert.rejects(()=>lost.post(),/lost_commit_ack/);
  assert.equal((await lost.post()).applied,false);assert.deepEqual(lost.snapshot(),after);
  for(const change of [
    x=>x.primary.prepare("UPDATE commerce_orders SET status='canceled'").run(),
    x=>x.primary.prepare("UPDATE commerce_gift_cards SET balance_minor=0").run(),
    x=>x.primary.prepare("UPDATE commerce_order_items SET total_minor=1 WHERE id='item_atomic_settlement_1'").run(),
    x=>x.primary.prepare("UPDATE commerce_balance_reservations SET status='released'").run(),
    x=>x.primary.prepare("UPDATE commerce_order_items SET rights_snapshot_json='{}'").run(),
  ]){
    const x=fixture();x.setBeforeBatch(()=>change(x));await assert.rejects(()=>x.post());
    assert.equal(x.snapshot().receipt,0);assert.equal(x.snapshot().ledger,0);assert.equal(x.snapshot().entitlements,0);
  }
  const pre=fixture({stripe:0,gift:0,store:100,count:1,preorder:true});await pre.post();
  assert.equal(pre.snapshot().preorders,1);assert.equal(pre.snapshot().entitlements,0);
  assert.equal(pre.primary.prepare("SELECT COUNT(*) n FROM publishing_outbox WHERE event_type='preorder.confirmed'").get().n,1);
  await pre.post();assert.equal(pre.snapshot().preorders,1);
  // Actual DO command, canonical write lock on its caller, restart and denial.
  const own=fixture({stripe:0,gift:0,store:100});
  let response=await own.command();assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(await response.json(),{schema:"cove.owner-paid-settlement.v1",orderId,settled:true,effectsReconciled:true,accessPublished:true,applied:true});
  assert.equal(own.owned.prepare("SELECT COUNT(*) n FROM cove_paid_entitlement_authority WHERE verdict='allow'").get().n,2);
  const ownState=own.snapshot();own.restart();response=await own.command();assert.equal(response.status,200);assert.deepEqual(own.snapshot(),ownState);
  assert.equal(own.primary.prepare("SELECT COUNT(*) n FROM notification_events").get().n,1);
  for(const invalid of [{orderId,sql:"DELETE FROM entitlements"},{orderId,userId:"other_user"},{orderId,payment:{status:"succeeded"}},{orderId:"bad/../order"}])assert.notEqual((await own.command(invalid)).status,200);
  // Crash after atomic batch, before effects: independently publishing any
  // line is denied until the owner finishes its recorded obligation.
  const interrupted=fixture({stripe:0,gift:0,store:100});
  interrupted.setRunFailure(query=>query.startsWith("INSERT INTO notification_events"));
  assert.equal((await interrupted.command()).status,503);
  assert.equal(interrupted.snapshot().status,"paid");assert.equal(interrupted.snapshot().ledger,6);
  assert.equal(interrupted.owned.prepare("SELECT state FROM cove_paid_settlement_commands").get().state,"pending");
  const attempt=await interrupted.owner.fetch(interrupted.request("/commercial/entitlement/publish-order-verified",{orderId,userId,territory:"US",channel:"retail"}));
  assert.notEqual(attempt.status,200,"A separate publisher bypassed pending owner obligations");
  assert.equal(interrupted.owned.prepare("SELECT COUNT(*) n FROM cove_paid_entitlement_authority WHERE verdict='allow'").get().n,0);
  interrupted.restart();interrupted.setRunFailure(null);
  const recovery=await interrupted.owner.fetch(interrupted.request("/commercial/order/recover-settlements",{limit:10}));
  assert.equal(recovery.status,200);assert.deepEqual(await recovery.json(),{schema:"cove.owner-settlement-recovery.v1",checked:1,recovered:1,blocked:0});
  assert.equal(interrupted.snapshot().ledger,6);
  // A failed internal-only batch has no D1 receipt yet, but its owner
  // journal must remain discoverable by the scheduled recovery command.
  const preCommit=fixture({stripe:0,gift:0,store:100});preCommit.setFailAt(1);
  assert.equal((await preCommit.command()).status,503);assert.equal(preCommit.snapshot().receipt,0);
  preCommit.restart();preCommit.setFailAt(-1);
  const recoveredJournal=await preCommit.owner.fetch(preCommit.request("/commercial/order/recover-settlements",{limit:1}));
  assert.deepEqual(await recoveredJournal.json(),{schema:"cove.owner-settlement-recovery.v1",checked:1,recovered:1,blocked:0});
  const fair=fixture({stripe:0,gift:0,store:100});assert.equal((await fair.command()).status,200);
  fair.primary.prepare("UPDATE commerce_settlement_receipts SET owner_published_at=NULL").run();
  fair.owned.prepare("INSERT INTO cove_paid_settlement_commands(order_id,payment_reference,state) VALUES('a_order_blocked_01','internal:a_order_blocked_01','pending')").run();
  const recoverOne=()=>fair.owner.fetch(fair.request("/commercial/order/recover-settlements",{limit:1}));
  assert.equal((await (await recoverOne()).json()).blocked,1);
  assert.equal((await (await recoverOne()).json()).recovered,1,"A blocked journal must not starve receipt-only recovery at limit=1");
  const caller=fixture({stripe:0,gift:0,store:100});
  const callerEnv={DB:makeStageLegalWriterLock(caller.DB),COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",COVE_SSR_STAGING:"1",COVE_LEGAL_WRITER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",COVE_RIGHTS_OWNER_SECRET:secret,LEGAL_AUTHORITY:{getByName(){return caller.owner;}}};
  assert.equal((await finalizePaidOrder(callerEnv,orderId,internalPayment)).status,"paid","Original API finalizer must work with every caller-side legal mutation locked");
  assert.equal(caller.snapshot().ledger,6);
  const concurrent=fixture({stripe:0,gift:0,store:100});let raced=false;
  concurrent.setBeforeBatch(async()=>{if(raced)return;raced=true;assert.equal((await concurrent.command()).status,503,"A second command cannot enter an awaiting settlement");});
  assert.equal((await concurrent.command()).status,200);assert.equal(concurrent.snapshot().ledger,6);
  const denied=fixture({stripe:0,gift:0,store:100});
  await denied.owner.fetch(denied.request("/commercial/order/deny-next",{orderId,operationId:"refund:before:settlement"}));
  assert.equal((await denied.command()).status,503);assert.equal(denied.snapshot().receipt,0);
  // The hosted schema bootstrap previously omitted royalty_holds. Actual
  // settlement must deny without consuming tender, then recover once the
  // reviewed schema-only bootstrap restores that required table.
  const typeFault=fixture({stripe:0,gift:0,store:100});
  const originalPrepare=typeFault.DB.prepare;
  typeFault.DB.prepare=(query)=>{
    if(query==="SELECT * FROM commerce_orders WHERE id=?")
      throw new TypeError("private buyer identifier and payment information must not leak");
    return originalPrepare(query);
  };
  const typeResponse=await typeFault.command();
  assert.equal(typeResponse.status,503);
  assert.equal(typeResponse.headers.get("x-cove-owner-settlement-failure"),
    "owner_settlement_phase_canonical_order_read");
  assert.equal(typeFault.snapshot().receipt,0);
  const missingHold=fixture({stripe:0,gift:0,store:100});
  const holdsDdl=missingHold.primary.prepare("SELECT sql FROM sqlite_master WHERE name='royalty_holds'").get().sql;
  missingHold.primary.exec("DROP TABLE royalty_holds");
  const missingBefore=missingHold.snapshot();
  const missingResponse=await missingHold.command();
  assert.equal(missingResponse.status,503);
  assert.equal(missingResponse.headers.get("x-cove-owner-settlement-failure"),"missing_table:royalty_holds");
  assert.deepEqual(missingHold.snapshot(),missingBefore);
  assert.ok(isPaidOwnerQaSchemaTable("royalty_holds"));
  assert.equal(isPaidOwnerQaSchemaTable("royalty_holds_untrusted"),false);
  missingHold.primary.exec(holdsDdl);
  assert.equal((await missingHold.command()).status,200,"Schema-only QA repair must unblock the real owner transaction");
  const disabled=fixture({stripe:0,gift:0,store:100});disabled.env.COVE_RIGHTS_OWNER_ENABLED="0";
  assert.equal((await disabled.command()).status,503);assert.equal(disabled.snapshot().receipt,0);
  const nativeFetch=globalThis.fetch;
  try{
    for(const [status,code] of [[401,"owner_stripe_credential_rejected"],[403,"owner_stripe_permission_denied"],
      [404,"owner_stripe_payment_not_found"],[429,"owner_stripe_verification_rate_limited"],[400,"owner_stripe_verification_request_rejected"],[302,"owner_stripe_redirect_forbidden"]]){
      const deniedProvider=fixture();globalThis.fetch=async(_url,options)=>{assert.equal(options.redirect,"manual","Workerd must not receive unsupported redirect:error");return new Response(null,{status});};
      const deniedResponse=await deniedProvider.command();assert.equal(deniedResponse.status,503);
      assert.equal(deniedResponse.headers.get("x-cove-owner-settlement-failure"),code);
      assert.equal(deniedProvider.snapshot().receipt,0);
    }
    const provider=fixture();let requests=0;
    globalThis.fetch=async url=>{requests++;assert.ok(String(url).startsWith("https://api.stripe.com/v1/payment_intents/pi_atomic_settlement"));return Response.json({id:stripePayment.paymentIntentId,object:"payment_intent",status:"succeeded",livemode:false,amount:50,amount_received:50,currency:"usd",metadata:{fore_order_id:orderId},latest_charge:null});};
    // Provider confirmation succeeds, fee evidence unavailable: atomic money
    // remains committed and access remains denied until provider retry.
    const unavailableFee=await provider.command();
    assert.equal(unavailableFee.status,503);assert.equal(unavailableFee.headers.get("x-cove-owner-settlement-failure"),"owner_stripe_fee_not_available");assert.ok(requests>=1);assert.equal(provider.snapshot().receipt,0);
    assert.equal(provider.owned.prepare("SELECT COUNT(*) n FROM cove_paid_settlement_commands").get().n,0);
    for(const overrides of [{amount_received:49},{amount:49},{currency:"eur"},{livemode:true},{status:"processing"},{metadata:{fore_order_id:"other_order"}}]){
      const bad=fixture();globalThis.fetch=async()=>Response.json({id:stripePayment.paymentIntentId,object:"payment_intent",status:"succeeded",livemode:false,amount:50,amount_received:50,currency:"usd",metadata:{fore_order_id:orderId},...overrides});
      assert.equal((await bad.command()).status,503);assert.equal(bad.snapshot().receipt,0);
    }
    const real=fixture();
    globalThis.fetch=async()=>Response.json({id:stripePayment.paymentIntentId,object:"payment_intent",status:"succeeded",livemode:false,amount:50,amount_received:50,currency:"usd",metadata:{fore_order_id:orderId},latest_charge:{id:"ch_atomic_settlement",payment_intent:stripePayment.paymentIntentId,refunded:false,amount_refunded:0,disputed:false,balance_transaction:{id:"txn_atomic_settlement",fee:2,net:48,currency:"usd"}}});
    assert.equal((await real.command()).status,200,"Verified provider, all tender, fees, royalties and buyer proofs must succeed together");
    const complete=real.snapshot();assert.equal(complete.ledger,10);
    assert.equal(real.primary.prepare("SELECT SUM(amount_minor) n FROM commerce_ledger_entries").get().n,0);
    assert.equal((await real.command()).status,200);assert.deepEqual(real.snapshot(),complete);
  }finally{globalThis.fetch=nativeFetch;}
  console.log(`PASS: ${batchSize} atomic failure boundaries, mixed tender, multi-line accounting, transaction-current races, lost ACK/replay, preorder reservation, real owner restart, pending-proof exclusion, provider provenance and terminal denial`);
}finally{databases.forEach(x=>x.close());rmSync(folder,{recursive:true,force:true});}
