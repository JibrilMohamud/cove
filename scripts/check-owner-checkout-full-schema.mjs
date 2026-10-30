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
    return {db,durable,env,draft,call,create,prepare,count,loseAck(){loseAck=true;}};
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
  console.log("PASS: real private DO checkout order + risk + gift/card/credit + promo + quote; replay and failures against all migrations, production denied");
}finally{
  for(const db of databases)db.close();
  rmSync(root,{recursive:true,force:true});
}
