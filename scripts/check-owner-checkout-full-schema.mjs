/* eslint-disable prettier/prettier -- Test the ACTUAL owner handlers against all D1 migrations, never a copied SQL assertion. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {copyFileSync,mkdtempSync,readFileSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const root=mkdtempSync(join(tmpdir(),"cove-checkout-full-")),databases=[];
try {
  const path=join(root,"owner.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile:path,bundle:true,platform:"node",target:"node22",format:"esm",logLevel:"silent",
    plugins:[{name:"host",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"mock-host"}));
      b.onLoad({filter:/.*/,namespace:"mock-host"},()=>({contents:"export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
    }}]});
  const {CoveLegalAuthority}=await import(pathToFileURL(path).href);
  const migrations=readdirSync("drizzle").filter(n=>n.endsWith(".sql")).sort();
  const templateFile=join(root,"template.sqlite"),template=new DatabaseSync(templateFile);
  for(const migration of migrations)
    template.exec(readFileSync(join("drizzle",migration),"utf8"));
  template.close();
  const secret="b".repeat(64),start=new Date().toISOString(),later=new Date(Date.now()+3600000).toISOString();
  const user="user_checkout_full_qa",quoteId="quote_checkout_full_qa";
  let counter=0;
  const insert=(db,table,row)=>{
    const names=Object.keys(row);
    db.prepare("INSERT INTO "+table+"("+names.join(",")+") VALUES("+names.map(()=>"?").join(",")+")")
      .run(...names.map(k=>row[k]));
  };
  function fixture({giftBalance=1000,creditBalance=1000,promoEnabled=true,
    policy={thresholds:{monitor:25,challenge:50,hold:70,block:90}},
    expires=later}={}){
    const file=join(root,"fixture-"+counter+++".sqlite");
    copyFileSync(templateFile,file);
    const db=new DatabaseSync(file),durable=new DatabaseSync(":memory:");
    databases.push(db,durable);
    db.exec("PRAGMA foreign_keys=ON");
    insert(db,"works",{id:"work_checkout_full_qa",title:"Test work",created_at:start,updated_at:start});
    insert(db,"editions",{id:"edition_checkout_full_qa",work_id:"work_checkout_full_qa",title:"Test edition",created_at:start,updated_at:start});
    insert(db,"products",{id:"prd_checkout_full_qa",edition_id:"edition_checkout_full_qa",sku:"sku_checkout_full_qa",
      format:"ebook",source_name:"publisher",source_external_id:"owner_checkout_full_qa",created_at:start,updated_at:start});
    insert(db,"shopping_carts",{id:"cart_checkout_full_qa",user_id:user,currency:"USD",created_at:start,updated_at:start});
    const lines=[{productId:"prd_checkout_full_qa",offerId:"offer_checkout_full_qa",title:"Test edition",
      amountMinor:1000,discountMinor:100,taxMinor:90,taxBehavior:"exclusive",
      rightsSnapshot:{salesChannel:"retail",territory:"US",grantId:"grant_checkout_full_qa"},
      publisherDiscountFundingMinor:0,foreDiscountFundingMinor:100}];
    insert(db,"commerce_checkout_quotes",{
      id:quoteId,user_id:user,cart_id:"cart_checkout_full_qa",
      cart_fingerprint:"sha256:checkout_full_schema_canonical_fingerprint",
      territory_code:"US",currency:"USD",items_json:JSON.stringify(lines),
      billing_address_json:"{}",subtotal_minor:1000,promo_discount_minor:100,
      tax_minor:90,tax_inclusive_minor:0,gift_card_minor:100,store_credit_minor:200,
      total_minor:990,stripe_due_minor:690,promo_code_hash:"promo_checkout_full_qa",
      gift_card_hash:"gift_checkout_full_qa",expires_at:expires,created_at:start
    });
    insert(db,"commerce_gift_cards",{code_hash:"gift_checkout_full_qa",last4:"1234",currency:"USD",
      original_balance_minor:1000,balance_minor:giftBalance,created_at:start,updated_at:start});
    insert(db,"commerce_store_credit_ledger",{id:"credit_checkout_full_qa",user_id:user,
      entry_type:"adjustment",amount_minor:creditBalance,currency:"USD",created_at:start});
    insert(db,"commerce_promo_codes",{code_hash:"promo_checkout_full_qa",code_label:"QA",
      kind:"amount",value:100,currency:"USD",max_redemptions:100,max_per_user:1,active:promoEnabled?1:0,
      created_at:start,updated_at:start});
    // Real migrations seed an active buyer policy. Preserve its immutable
    // version identity and override only policy_json inside this disposable DB.
    const active=db.prepare("UPDATE risk_policy_versions SET policy_json=? WHERE domain='buyer' AND status='active'")
      .run(JSON.stringify(policy));
    assert.ok(active.changes>=1,"Canonical full schema must seed a buyer policy");
    const sql={exec(query,...args){
      // Cloudflare's storage.sql.exec accepts multi-statement DDL;
      // node:sqlite prepare() accepts only one statement at a time.
      if(!args.length&&["CREATE","ALTER","DROP","PRAGMA"].some(verb=>query.trimStart().toUpperCase().startsWith(verb+" "))){
        durable.exec(query);return {toArray:()=>[]};
      }
      const st=durable.prepare(query);
      // Workers SQLite executes immediately, even when a mutation's returned
      // cursor is discarded. Do NOT defer execution until toArray() is read.
      const rows=st.columns().length?st.all(...args):(st.run(...args),[]);
      return {toArray:()=>rows};
    }};
    let loseAck=false;
    const DB={prepare(query){
      const binding=(params=[])=>({bind:(...v)=>binding(v),
        async first(){return db.prepare(query).get(...params)||null;},
        async all(){return {results:db.prepare(query).all(...params)};},
        async run(){return {success:true,meta:{changes:Number(db.prepare(query).run(...params).changes)}};}});
      return binding();
    },async batch(statements){
      db.exec("BEGIN IMMEDIATE");let committed=false;
      try{const output=[];for(const st of statements)output.push(await st.run());
        db.exec("COMMIT");committed=true;
        if(loseAck){loseAck=false;throw Error("lost_owner_batch_ack");}
        return output;
      }catch(error){if(!committed)db.exec("ROLLBACK");throw error;}
    }};
    const env={PRIMARY_DB:DB,COVE_RIGHTS_OWNER_ENABLED:"1",
      COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
      COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),
      COVE_RIGHTS_OWNER_SECRET:secret,STRIPE_SECRET_KEY:"sk_test_fixture_only",
      STRIPE_LIVEMODE:"false",STRIPE_TAX_ENABLED:"false"};
    const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){
      durable.exec("BEGIN");try{const result=fn();durable.exec("COMMIT");return result;}
      catch(e){durable.exec("ROLLBACK");throw e;}
    }}},env);
    const draft={userId:user,quoteId,idempotencyKey:"checkout:real-schema:original-01",
      cartFingerprint:"sha256:checkout_full_schema_canonical_fingerprint",
      captureMethod:"automatic_async"};
    const call=(route,body,authorization=secret)=>owner.fetch(new Request(
      "https://legal-authority.internal"+route,{method:"POST",headers:{
        "authorization":"Bearer "+authorization,"content-type":"application/json"},
        body:JSON.stringify(body)}));
    const create=()=>call("/commercial/checkout/materialize-draft",draft);
    const prepare=orderId=>call("/commercial/checkout/prepare-draft",{userId:user,orderId,quoteId});
    const count=table=>Number(db.prepare("SELECT COUNT(*) n FROM "+table).get().n);
    return {db,durable,owner,env,draft,call,create,prepare,count,loseAck(){loseAck=true;}};
  }
  const ok=fixture();
  let result=await ok.create();
  assert.equal(result.status,200,"Owner must create draft with the complete schema: "+await result.clone().text());
  const created=await result.json(),orderId=created.orderId;
  assert.equal(created.lineCount,1);assert.equal(created.stripeDueMinor,690);
  assert.equal(ok.count("commerce_order_items"),1);
  result=await ok.prepare(orderId);
  assert.equal(result.status,200,"Owner must prepare a real D1 order: "+await result.clone().text());
  const settled=await result.json();
  assert.equal(settled.ready,true);assert.equal(settled.riskAction,"allow");
  assert.equal(ok.count("commerce_balance_reservations"),2);
  assert.equal(ok.count("commerce_promo_redemptions"),1);
  assert.equal(ok.count("risk_assessments"),1);
  assert.equal(ok.count("risk_events"),1);
  assert.equal(ok.db.prepare("SELECT consumed_at FROM commerce_checkout_quotes WHERE id=?").get(quoteId).consumed_at!==null,true);
  result=await ok.prepare(orderId);
  assert.equal(result.status,200);assert.equal((await result.json()).applied,false);
  assert.equal(ok.count("commerce_balance_reservations"),2,"Replay duplicated tender");
  assert.equal(ok.count("risk_assessments"),1,"Replay duplicated risk assessment");
  result=await ok.call("/commercial/checkout/materialize-draft",
    {...ok.draft,idempotencyKey:"checkout:real-schema:second-key-02"});
  assert.equal(result.status,200,"Same canonical quote must resume rather than insert again");
  assert.equal((await result.json()).created,false);
  assert.equal(ok.count("commerce_orders"),1);
  for(const override of [
    {giftBalance:99},{creditBalance:199},{promoEnabled:false}
  ]){
    const a=fixture(override),draft=await a.create();
    assert.equal(draft.status,200,"Owner draft should exist before failed monetary reservation");
    const id=(await draft.json()).orderId;
    const unavailable=await a.prepare(id);
    assert.notEqual(unavailable.status,200,"Insufficient funds / inactive promo must deny");
    assert.equal(a.count("commerce_balance_reservations"),0,"No partial tender on rejected prep");
    assert.equal(a.count("commerce_promo_redemptions"),0,"No partial promo on rejected prep");
    assert.equal(a.db.prepare("SELECT consumed_at FROM commerce_checkout_quotes WHERE id=?").get(quoteId).consumed_at,null);
  }
  // Independent quote/order integrity: a write or configuration error after
  // order creation but before reservation must not authorize different terms.
  // Assert the REAL handler denies before fraud or monetary writes.
  for(const [column,value] of [
    ["subtotal_minor",1200],["total_minor",995],["stripe_due_minor",695],
    ["gift_card_minor",150],["tax_minor",95],["territory_code","CA"],
    ["currency","CAD"]
  ]){
    const changed=fixture(),made=await changed.create();
    assert.equal(made.status,200,"Real-schema draft setup must succeed");
    const draftId=(await made.json()).orderId;
    changed.db.prepare("UPDATE commerce_checkout_quotes SET "+column+"=? WHERE id=?")
      .run(value,quoteId);
    const rejected=await changed.prepare(draftId);
    assert.equal(rejected.status,409,
      "Owner must deny a changed "+column+" before tender/risk writes");
    assert.equal(changed.count("commerce_balance_reservations"),0);
    assert.equal(changed.count("commerce_promo_redemptions"),0);
    assert.equal(changed.count("risk_assessments"),0);
    assert.equal(changed.db.prepare("SELECT consumed_at FROM commerce_checkout_quotes WHERE id=?")
      .get(quoteId).consumed_at,null);
    assert.equal(changed.db.prepare("SELECT stripe_payment_intent_id FROM commerce_orders WHERE id=?")
      .get(draftId).stripe_payment_intent_id,null);
  }
  const lost=fixture();
  lost.loseAck();
  assert.equal((await lost.create()).status,503,"Lost initial order commit ACK is unconfirmed");
  const replayed=await lost.create();
  assert.equal(replayed.status,200,"Retry after committed but unacknowledged order must recover");
  assert.equal((await replayed.json()).created,false);
  assert.equal(lost.count("commerce_orders"),1);
  const revoked=fixture(),revDraft=await revoked.create();
  assert.equal(revDraft.status,200);
  const revokedOrderId=(await revDraft.json()).orderId;
  const deniedOrder=await revoked.call("/commercial/order/deny-next",{
    orderId:revokedOrderId,operationId:"qa:checkout:owner-deny"});
  assert.equal(deniedOrder.status,200,"Private owner must persist the negative order decision");
  const deniedReceipt=await deniedOrder.json();
  assert.equal(deniedReceipt.applied,true,"Order denial command must be applied");
  assert.equal(Number(revoked.durable.prepare("SELECT COUNT(*) n FROM cove_paid_refunded_orders WHERE order_id=?").get(revokedOrderId).n),1,
    "Owner must durably persist denied order ID");
  const ownerPermission=await revoked.call("/commercial/order/verify",{orderId:revokedOrderId});
  assert.equal((await ownerPermission.json()).allowed,false,
    "Owner must deny the same order to every consumer");
  assert.equal((await revoked.prepare(revokedOrderId)).status,409,
    "Durable revocation must veto checkout monetary preparation");
  assert.equal(revoked.count("commerce_balance_reservations"),0);
  assert.equal(revoked.db.prepare("SELECT consumed_at FROM commerce_checkout_quotes").get().consumed_at,null);
  assert.equal((await revoked.create()).status,409,
    "Previously denied order must not be resumed");
  const late=fixture({expires:"2020-01-01T00:00:00.000Z"});
  assert.notEqual((await late.create()).status,200,"Expired quote cannot create order");
  const denied=fixture();
  assert.equal((await denied.call("/commercial/checkout/materialize-draft",denied.draft,
    "c".repeat(64))).status,401);
  denied.env.COVE_RIGHTS_OWNER_PRIMARY_ID="4bd657ac-8789-403e-a28c-93aba8d0a989";
  assert.equal((await denied.create()).status,503,"Production DB must never use the isolated owner");
  // A full-schema Stripe dispute now executes ALL financial postings and
  // buyer revocation inside the private owner. Enrolled webhook D1 never does.
  const disputed=fixture(),disputeOrder=await disputed.create();
  assert.equal(disputeOrder.status,200);
  const paidOrderId=(await disputeOrder.json()).orderId;
  const chargeId="ch_owner_dispute_fullschema_123";
  const disputeId="dp_owner_dispute_fullschema_123";
  disputed.db.prepare("UPDATE commerce_orders SET status='paid',stripe_charge_id=? WHERE id=?")
    .run(chargeId,paidOrderId);
  const priorFetch=globalThis.fetch;
  let providerStatus="needs_response",providerOverride={},providerFail=false;
  globalThis.fetch=async (url,init)=>{
    assert.equal(String(url),"https://api.stripe.com/v1/disputes/"+disputeId);
    assert.equal(init.method,"GET");
    assert.equal(init.redirect,"manual");
    assert.equal(init.headers.authorization,"Bearer sk_test_fixture_only");
    if(providerFail)throw Error("stripe_owner_unavailable");
    return new Response(JSON.stringify({
      object:"dispute",id:disputeId,charge:chargeId,amount:300,
      currency:"usd",livemode:false,status:providerStatus,reason:"fraudulent",
      evidence_details:{due_by:1900000000},...providerOverride
    }),{status:200});
  };
  const disputeCommand={disputeId,eventType:"charge.dispute.created"};
  const sendDispute=()=>disputed.call("/commercial/dispute/sync-verified",disputeCommand);
  result=await sendDispute();
  assert.equal(result.status,200,"Owner must atomically post real-schema dispute: "+await result.clone().text());
  const proof=await result.json();
  assert.equal(proof.ownerDenied,true);
  assert.equal(proof.accountingReconciled,true);
  assert.equal(disputed.count("commerce_disputes"),1);
  assert.equal(disputed.count("commerce_ledger_entries"),2);
  assert.equal(disputed.db.prepare("SELECT SUM(amount_minor) net FROM commerce_ledger_entries").get().net,0);
  assert.equal(disputed.db.prepare("SELECT status FROM commerce_orders WHERE id=?")
    .get(paidOrderId).status,"disputed");
  assert.equal(disputed.durable.prepare("SELECT COUNT(*) n FROM cove_paid_refunded_orders WHERE order_id=?")
    .get(paidOrderId).n,1,"Strong owner must deny purchases before any ledger entry");
  assert.equal((await sendDispute()).status,200,"Exact dispute replay must be idempotent");
  assert.equal(disputed.count("commerce_ledger_entries"),2);
  providerStatus="lost";
  result=await disputed.call("/commercial/dispute/sync-verified",{
    disputeId,eventType:"charge.dispute.closed"
  });
  assert.equal(result.status,200,"Loss must post two more balanced entries");
  assert.equal(disputed.count("commerce_ledger_entries"),4);
  assert.equal(disputed.db.prepare("SELECT status FROM commerce_orders WHERE id=?")
    .get(paidOrderId).status,"chargeback_lost");
  assert.equal(disputed.db.prepare("SELECT SUM(amount_minor) net FROM commerce_ledger_entries").get().net,0);
  assert.equal((await sendDispute()).status,200,"Replayed disputed loss must not duplicate ledger");
  assert.equal(disputed.count("commerce_ledger_entries"),4);
  // Provider fraud is not a durable denial or SQL authorization source.
  const originalLedger=disputed.count("commerce_ledger_entries");
  for(const mutation of [
    {id:"dp_forged_other"}, {amount:400},{currency:"cad"},{livemode:true},
    {charge:"ch_forged_other"}, {object:"charge"}
  ]){
    providerOverride=mutation;
    assert.notEqual((await sendDispute()).status,200,"Wrong provider identity must fail closed");
    assert.equal(disputed.count("commerce_ledger_entries"),originalLedger);
  }
  providerOverride={};providerFail=true;
  assert.notEqual((await sendDispute()).status,200,"Provider outage may not mutate canonical dispute");
  providerFail=false;
  assert.equal(disputed.count("commerce_ledger_entries"),originalLedger);
  const attempted=fixture(),draftDispute=await attempted.create();
  assert.equal(draftDispute.status,200);
  const attemptedId=(await draftDispute.json()).orderId;
  attempted.db.prepare("UPDATE commerce_orders SET status='paid',stripe_charge_id=? WHERE id=?")
    .run(chargeId,attemptedId);
  attempted.loseAck();
  assert.notEqual((await attempted.call("/commercial/dispute/sync-verified",disputeCommand)).status,200,
    "Lost D1 acknowledgement cannot produce owner success receipt");
  assert.equal(attempted.count("commerce_ledger_entries"),4,
    "Atomic D1 was committed despite missing transport receipt");
  assert.equal((await attempted.call("/commercial/dispute/sync-verified",disputeCommand)).status,200,
    "Retry after lost acknowledgement reconciles the existing journal/ledger");
  assert.equal(attempted.count("commerce_ledger_entries"),4,
    "Lost-ACK retry must not double-post financial entries");
  globalThis.fetch=priorFetch;

  // Complete checkout cancellation and scheduled reconciliation replacement.
  // The owner checks Stripe using its own key, then atomically releases
  // all tender AND promo reservations. A lost D1 ACK is replay-repairable.
  const canceled=fixture(),createCancel=await canceled.create();
  assert.equal(createCancel.status,200);
  const cancelId=(await createCancel.json()).orderId;
  assert.equal((await canceled.prepare(cancelId)).status,200);
  assert.equal(canceled.count("commerce_balance_reservations"),2);
  const cancelCommand={orderId:cancelId,userId:user,source:"customer"};
  const cancelRoute="/commercial/checkout/cancel-unpaid";
  canceled.loseAck();
  assert.equal((await canceled.call(cancelRoute,cancelCommand)).status,503);
  assert.equal(canceled.db.prepare("SELECT status FROM commerce_orders WHERE id=?")
    .get(cancelId).status,"canceled","A lost transport ACK is not a rolled-back commit");
  assert.equal(canceled.db.prepare("SELECT COUNT(*) n FROM commerce_balance_reservations WHERE status='reserved'")
    .get().n,0);
  assert.equal((await canceled.call(cancelRoute,cancelCommand)).status,200,
    "Owner must replay canceled checkout, preserving released tender");
  assert.equal(canceled.db.prepare("SELECT COUNT(*) n FROM commerce_promo_redemptions WHERE status='reserved'")
    .get().n,0);
  const denial=fixture(),draftDenial=await denial.create();
  assert.equal(draftDenial.status,200);
  const deniedCancelId=(await draftDenial.json()).orderId;
  denial.db.prepare("UPDATE commerce_orders SET status='paid' WHERE id=?").run(deniedCancelId);
  assert.equal((await denial.call(cancelRoute,{
    orderId:deniedCancelId,userId:user,source:"customer"
  })).status,503,"Owner may never cancel a paid order or release its tender");
  const protectedCustomer=fixture(),draftProtected=await protectedCustomer.create();
  assert.equal(draftProtected.status,200);
  const protectedId=(await draftProtected.json()).orderId;
  const piId="pi_owner_cancel_fullschema_123";
  protectedCustomer.db.prepare("UPDATE commerce_orders SET stripe_payment_intent_id=? WHERE id=?")
    .run(piId,protectedId);
  const stripeFetch=globalThis.fetch;
  let stripeStatus="processing",stripeAmount=690,stripeLive=false;
  globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),"https://api.stripe.com/v1/payment_intents/"+piId);
    assert.equal(init.headers.authorization,"Bearer sk_test_fixture_only");
    assert.equal(init.redirect,"manual");
    return Response.json({object:"payment_intent",id:piId,status:stripeStatus,
      livemode:stripeLive,amount:stripeAmount,currency:"usd",
      metadata:{fore_order_id:protectedId},customer:null});
  };
  const ownerCancel={orderId:protectedId,userId:user,source:"reconciliation"};
  assert.equal((await protectedCustomer.call(cancelRoute,ownerCancel)).status,503,
    "Processing Stripe payment must not be canceled despite caller's claim");
  assert.equal(protectedCustomer.db.prepare("SELECT status FROM commerce_orders WHERE id=?")
    .get(protectedId).status,"pending_payment");
  stripeStatus="canceled";stripeAmount=691;
  assert.equal((await protectedCustomer.call(cancelRoute,ownerCancel)).status,503,
    "Stripe amount mismatch must deny before any D1 write");
  stripeAmount=690;stripeLive=true;
  assert.equal((await protectedCustomer.call(cancelRoute,ownerCancel)).status,503,
    "Stripe livemode mismatch must deny before any D1 write");
  stripeLive=false;
  assert.equal((await protectedCustomer.call(cancelRoute,ownerCancel)).status,200,
    "Owner independently verified Stripe cancellation must reconcile");
  assert.equal((await protectedCustomer.call(cancelRoute,ownerCancel)).status,200);
  globalThis.fetch=stripeFetch;
  // The reconciliation report has an immutable diagnostic replay identity,
  // cannot be used as financial authorization or arbitrary SQL.
  const journal=fixture(),recordId="recon_22222222-3333-4444-8888-aaaaaaaaaaaa";
  const report={runId:recordId,startedAt:start,finishedAt:start,
    checked:2,mismatches:1,repaired:1,
    details:[{orderId:"ord_test_123",action:"owner_stale_checkout_canceled"}]};
  assert.equal((await journal.call("/commercial/reconciliation/record",report)).status,200,
    "Owner must persist complete replacement run report");
  assert.equal(journal.count("commerce_reconciliation_runs"),1);
  assert.equal((await journal.call("/commercial/reconciliation/record",report)).status,200);
  assert.equal(journal.count("commerce_reconciliation_runs"),1);
  assert.equal((await journal.call("/commercial/reconciliation/record",
    {...report,repaired:2})).status,503,
    "Replaying same run ID with different financial diagnostics must fail");
  assert.equal(journal.count("commerce_reconciliation_runs"),1);
  assert.equal((await journal.call("/commercial/reconciliation/record",
    {...report,sql:"DELETE FROM commerce_orders"})).status,503);
  const isolated=fixture(),isolatedDraft=await isolated.create();
  assert.equal(isolatedDraft.status,200);
  isolated.env.COVE_RIGHTS_OWNER_PRIMARY_ID="4bd657ac-8789-403e-a28c-93aba8d0a989";
  assert.equal((await isolated.call(cancelRoute,{
    orderId:(await isolatedDraft.json()).orderId,userId:user,source:"customer"
  })).status,503,"Production DB is not an eligible private QA cancellation owner");
  // Exercise the ACTUAL customer API and scheduled cron entrypoints, not
  // only the private Durable Object. The enrolled callers have zero legal
  // writer fallback after the owner RPC fails.
  const commercePath=join(root,"commerce-caller.mjs");
  await build({entryPoints:["src/features/fore/commerce.server.ts"],
    outfile:commercePath,bundle:true,platform:"node",target:"node22",
    format:"esm",logLevel:"silent"});
  const {cancelCheckoutOrder,reconcileStripe}=await import(pathToFileURL(commercePath).href);
  const caller=fixture(),callerDraft=await caller.create();
  assert.equal(callerDraft.status,200);
  const callerOrder=(await callerDraft.json()).orderId;
  assert.equal((await caller.prepare(callerOrder)).status,200);
  const stageEnv={...caller.env,DB:caller.env.PRIMARY_DB,
    COVE_LEGAL_CONSUMER_STAGE_ENABLED:"1",COVE_SSR_STAGING:"1",
    COVE_CANONICAL_LEGAL_WRITE_LOCK:"1",
    COVE_LEGAL_WRITER_PRIMARY_ID:caller.env.COVE_RIGHTS_OWNER_PRIMARY_ID,
    LEGAL_AUTHORITY:{getByName(name){
      assert.equal(name,"cove-staged-legal-global-v1");return caller.owner;
    }}};
  assert.deepEqual(await cancelCheckoutOrder(stageEnv,user,callerOrder),
    {orderId:callerOrder,status:"canceled"},"Enrolled customer API must use owner-only cancellation");
  assert.equal(caller.db.prepare("SELECT status FROM commerce_orders WHERE id=?").get(callerOrder).status,
    "canceled");
  assert.equal(caller.db.prepare("SELECT COUNT(*) n FROM commerce_balance_reservations WHERE status='reserved'")
    .get().n,0);
  const cron=await reconcileStripe(stageEnv,5);
  assert.equal(cron.checked,0,"The stage cron must reconcile only attached PI orders");
  assert.equal(caller.count("commerce_reconciliation_runs"),1,
    "Scheduled run must be recorded by the private owner");
  const closed=fixture(),closedDraft=await closed.create();
  assert.equal(closedDraft.status,200);
  const closedOrder=(await closedDraft.json()).orderId;
  assert.equal((await closed.prepare(closedOrder)).status,200);
  const deniedEnv={...stageEnv,DB:closed.env.PRIMARY_DB,
    COVE_RIGHTS_OWNER_SECRET:"bad-secret",LEGAL_AUTHORITY:{getByName:()=>closed.owner}};
  await assert.rejects(()=>cancelCheckoutOrder(deniedEnv,user,closedOrder),
    /owner|certified/i,"A broken owner must not fall back to API-side D1");
  assert.equal(closed.db.prepare("SELECT status FROM commerce_orders WHERE id=?")
    .get(closedOrder).status,"pending_payment");
  assert.equal(closed.db.prepare("SELECT COUNT(*) n FROM commerce_balance_reservations WHERE status='reserved'")
    .get().n,2,"The failed owner must not release tender from the caller plane");
  // Enrolled staff operations cross the same owner-only RPC as monetary
  // checkout. Validate actual complete-schema principal/role/SSO/MFA,
  // gift/code idempotence and atomic negative credit availability.
  const admin=fixture(),actor={userId:user,authProvider:"supabase",
    authSubject:"subject_owner_admin_fullschema",aal:"aal2"};
  insert(admin.db,"staff_principals",{user_id:user,sso_provider:"supabase",
    sso_subject:actor.authSubject,status:"active",mfa_required:1,
    created_at:start,updated_at:start});
  insert(admin.db,"staff_roles",{id:"role_monetary_full_qa",name:"monetary_qa"});
  insert(admin.db,"staff_role_permissions",{role_id:"role_monetary_full_qa",permission:"commerce.manage"});
  insert(admin.db,"staff_principal_roles",{user_id:user,role_id:"role_monetary_full_qa",granted_at:start});
  const adminRoute="/commercial/admin/monetary";
  const adminCommand=(action,operationId,payload)=>({action,operationId,actor,payload});
  let operation=adminCommand("gift-card","monetary-gift-issued-once-001",
    {currency:"USD",amountMinor:2500});
  let m=await admin.call(adminRoute,operation);
  assert.equal(m.status,200,"Gift card must issue through complete-schema owner: "+await m.clone().text());
  const gift=await m.json();
  assert.match(gift.code,/^FORE-[0-9A-F]{16}$/);
  assert.equal(gift.amountMinor,2500);
  assert.equal(admin.count("commerce_gift_cards"),2);
  m=await admin.call(adminRoute,operation);
  assert.equal(m.status,200,"Idempotent gift replay must return original code");
  assert.equal((await m.json()).code,gift.code);
  assert.equal(admin.count("commerce_gift_cards"),2);
  assert.notEqual((await admin.call(adminRoute,
    {...operation,payload:{currency:"CAD",amountMinor:3000}})).status,200,
    "Reusing a gift idempotency key with new amount/currency is denied");
  assert.equal(admin.count("commerce_gift_cards"),2);
  operation=adminCommand("store-credit","monetary-store-credit-original-001",
    {userId:user,currency:"USD",amountMinor:-200,reference:"QA authorized debit"});
  m=await admin.call(adminRoute,operation);
  assert.equal(m.status,200,"Owner must reconcile negative credit: "+await m.clone().text());
  assert.equal((await m.json()).balanceMinor,800);
  assert.equal(admin.count("commerce_store_credit_ledger"),2);
  assert.equal((await admin.call(adminRoute,operation)).status,200,"Credit retry must not double debit");
  assert.equal(admin.count("commerce_store_credit_ledger"),2);
  assert.notEqual((await admin.call(adminRoute,
    {...operation,payload:{...operation.payload,amountMinor:-201}})).status,200,
    "Same credit operation must not change monetary amount");
  assert.equal(admin.count("commerce_store_credit_ledger"),2);
  assert.notEqual((await admin.call(adminRoute,adminCommand("store-credit",
    "monetary-negative-overdraft-001",
    {userId:user,currency:"USD",amountMinor:-2000,reference:"Overdraft"}))).status,200,
    "Owner must reject insufficient unreserved store credit atomically");
  assert.equal(admin.count("commerce_store_credit_ledger"),2);
  operation=adminCommand("promo","monetary-promo-activation-001",
    {code:" owner QA ",kind:"percent",value:12,active:true});
  m=await admin.call(adminRoute,operation);
  assert.equal(m.status,200,"Owner must write and independently read back promo");
  assert.equal((await m.json()).codeLabel,"OWNERQA");
  assert.equal(admin.count("commerce_promo_codes"),2);
  assert.notEqual((await admin.call(adminRoute,{...operation,
    actor:{...actor,aal:"aal1"}})).status,200,"MFA downgrade denied");
  assert.notEqual((await admin.call(adminRoute,{...operation,
    actor:{...actor,authSubject:"forged"}})).status,200,"SSO mismatch denied");
  admin.db.prepare("DELETE FROM staff_role_permissions WHERE role_id='role_monetary_full_qa' AND permission='commerce.manage'").run();
  assert.notEqual((await admin.call(adminRoute,adminCommand("gift-card",
    "monetary-role-revoked-001",{currency:"USD",amountMinor:100}))).status,200,
    "Role withdrawal must take effect in the owner before money issues");
  assert.equal(admin.count("commerce_gift_cards"),2);
  // Positive QA lease may NEVER act as production authorization.
  admin.env.COVE_RIGHTS_OWNER_PRIMARY_ID="4bd657ac-8789-403e-a28c-93aba8d0a989";
  assert.equal((await admin.call(adminRoute,adminCommand("promo",
    "monetary-prod-locked-001",{code:"BLOCKED",kind:"amount",value:1}))).status,503);
  console.log("PASS: real private DO checkout order + risk + gift/card/credit + promo + quote; replay and failures against all migrations, production denied");
}finally{
  for(const db of databases)db.close();
  rmSync(root,{recursive:true,force:true});
}
