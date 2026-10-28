/* eslint-disable prettier/prettier -- Exercise the deployed handler logic against separate primary and owner SQLite stores. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const directory=mkdtempSync(join(tmpdir(),"cove-paid-worker-"));
const databases=[];
try {
  const outfile=join(directory,"worker.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",
    plugins:[{name:"durable-object-test-host",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"test-host"}));
      b.onLoad({filter:/.*/,namespace:"test-host"},()=>({contents:
        "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }"}));
    }}]});
  const {CoveLegalAuthority,default:worker}=await import(pathToFileURL(outfile).href);
  const coreFile=join(directory,"commercial.mjs");
  await build({entryPoints:["src/storefront-strangler/commercial-legal-core.ts"],
    outfile:coreFile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const commercial=await import(pathToFileURL(coreFile).href);
  const userId="user_cart_handler_01",orderId="order_cart_handler_01";
  const secret="b".repeat(64);
  const products=["prd_cart_handler_a","prd_cart_handler_b"];
  const entitlements=["ent_cart_handler_a","ent_cart_handler_b"];
  const request=(route,body)=>new Request("https://legal-authority.internal"+route,{
    method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},
    body:JSON.stringify(body)
  });
  const scope=(i=0)=>({entitlementId:entitlements[i],userId,productId:products[i],
    territory:"US",channel:"retail"});
  function fixture(count=2) {
    const primary=new DatabaseSync(":memory:"),owned=new DatabaseSync(":memory:");
    databases.push(primary,owned);
    primary.exec(`
      CREATE TABLE commerce_orders(id TEXT PRIMARY KEY,user_id TEXT,territory_code TEXT,status TEXT);
      CREATE TABLE commerce_order_items(id TEXT PRIMARY KEY,order_id TEXT,product_id TEXT,
        sales_channel TEXT,preorder_id TEXT,entitlement_status TEXT,rights_grant_id TEXT,rights_snapshot_json TEXT);
      CREATE TABLE entitlements(id TEXT PRIMARY KEY,user_id TEXT,product_id TEXT,
        entitlement_type TEXT,status TEXT,source TEXT,starts_at TEXT,ends_at TEXT,order_item_id TEXT);
      CREATE TABLE risk_holds(domain TEXT,subject_type TEXT,subject_id TEXT,status TEXT,hold_scope TEXT);
    `);
    primary.prepare("INSERT INTO commerce_orders VALUES(?,?,?,'paid')").run(orderId,userId,"US");
    for(let i=0;i<count;i++) {
      const product=products[i],grant="grant_"+product;
      primary.prepare("INSERT INTO commerce_order_items VALUES(?,?,?,'retail',NULL,'granted',?,?)")
        .run("item_"+product,orderId,product,grant,JSON.stringify({
          grantId:grant,editionId:"ed_"+product,contractId:"contract_handler_01",
          contractVersionId:"version_handler_01",territory:"US",salesChannel:"retail"
        }));
      primary.prepare("INSERT INTO entitlements VALUES(?,?,?,'purchase','active','commerce',NULL,NULL,?)")
        .run(entitlements[i],userId,product,"item_"+product);
    }
    const sql={exec(query,...args){
      const q=owned.prepare(query);
      const rows=q.columns().length?q.all(...args):(q.run(...args),[]);
      return {toArray:()=>rows};
    }};
    let onRead=null;
    const DB={prepare(query){
      const prepare=(args=[])=>({bind:(...params)=>prepare(params),
        async first(){const row=primary.prepare(query).get(...args)||null;
          if(onRead)await onRead(query);return row;},
        async all(){const results=primary.prepare(query).all(...args);
          if(onRead)await onRead(query);return {results};},
        async run(){throw Error("Positive verification must never mutate primary D1");}
      });return prepare();
    }};
    const env={PRIMARY_DB:DB,COVE_RIGHTS_OWNER_ENABLED:"1",
      COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
      COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+10*60_000),
      COVE_RIGHTS_OWNER_SECRET:secret};
    const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){
      owned.exec("BEGIN");
      try{const result=fn();owned.exec("COMMIT");return result;}
      catch(error){owned.exec("ROLLBACK");throw error;}
    }}},env);
    env.LEGAL_AUTHORITY={getByName(name){
      assert.equal(name,"cove-staged-legal-global-v1");return owner;
    }};
    const post=(route,body)=>worker.fetch(request(route,body),env);
    for(let i=0;i<count;i++) commercial.publishFreshCommercialProof(sql,{
      productId:products[i],editionId:"ed_"+products[i],grantId:"grant_"+products[i],
      contractId:"contract_handler_01",contractVersionId:"version_handler_01",
      territory:"US",channel:"retail",validUntil:new Date(Date.now()+10*60_000).toISOString()
    },0);
    return {primary,owned,post,env,setRead(fn){onRead=fn;},
      publish:()=>post("/commercial/entitlement/publish-order-verified",{
        orderId,userId,territory:"US",channel:"retail"}),
      async allowed(i=0){const r=await post("/commercial/entitlement/authorize",scope(i));
        assert.equal(r.status,200);return (await r.json()).allowed;}
    };
  }
  const partial=fixture();
  assert.equal((await partial.post("/commercial/entitlement/publish-verified",scope())).status,409,
    "Single-item endpoint must not bypass whole-cart certification");
  assert.equal(await partial.allowed(),false);
  assert.equal(await partial.allowed(1),false);
  partial.primary.prepare("UPDATE entitlements SET status='revoked' WHERE id=?").run(entitlements[1]);
  assert.equal((await partial.publish()).status,409);
  assert.equal(await partial.allowed(),false,"A bad later line cannot expose the first paid book");

  for(const [column,value] of [
    ["starts_at",new Date(Date.now()+60_000).toISOString()],
    ["ends_at",new Date(Date.now()-60_000).toISOString()],
    ["starts_at","not-a-date"],["ends_at","not-a-date"]
  ]) {
    for(const count of [1,2]) {
      const f=fixture(count);
      f.primary.prepare(`UPDATE entitlements SET ${column}=? WHERE id=?`).run(value,entitlements[count-1]);
      const r=count===1?await f.post("/commercial/entitlement/publish-verified",scope()):await f.publish();
      assert.equal(r.status,409,`${count}-line handler must deny ${column}=${value}`);
      assert.equal(await f.allowed(),false);
    }
  }
  const good=fixture();
  const expiry=new Date(Date.now()+60_000).toISOString();
  good.primary.prepare("UPDATE entitlements SET ends_at=? WHERE id=?").run(expiry,entitlements[1]);
  const result=await good.publish();
  assert.equal(result.status,200);
  assert.equal((await result.json()).receipts.length,2);
  assert.equal(await good.allowed(),true);assert.equal(await good.allowed(1),true);
  assert.equal(good.owned.prepare("SELECT valid_until FROM cove_paid_entitlement_authority WHERE entitlement_id=?")
    .get(entitlements[1]).valid_until,expiry,"Owner lease cannot outlive canonical entitlement");
  assert.equal((await good.publish()).status,200,"Whole-cart signed replay reconciles idempotently");
  await good.post("/commercial/order/deny-next",{orderId,operationId:"refund:handler:01"});
  assert.equal(await good.allowed(),false);assert.equal(await good.allowed(1),false);
  assert.equal((await good.publish()).status,503,"Refund tombstone defeats stale canonical paid rows");

  const single=fixture(1);
  assert.equal((await single.post("/commercial/entitlement/publish-verified",scope())).status,200);
  assert.equal(await single.allowed(),true,"Single-book compatibility still works");
  const wrongBuyer=fixture();
  assert.equal((await wrongBuyer.post("/commercial/entitlement/publish-order-verified",{
    orderId,userId:"other_buyer_handler",territory:"US",channel:"retail"})).status,409);
  assert.equal(await wrongBuyer.allowed(),false);

  const interrupted=fixture();
  interrupted.setRead(async(query)=>{
    if(!query.includes("FROM commerce_order_items oi"))return;
    interrupted.setRead(null);
    assert.equal((await interrupted.post("/commercial/order/deny-next",{
      orderId,operationId:"refund:interleaved:handler"})).status,200);
  });
  assert.equal((await interrupted.publish()).status,503,
    "Withdrawal acknowledged during primary reads must defeat positive commit");
  assert.equal(await interrupted.allowed(),false);assert.equal(await interrupted.allowed(1),false);
  const offline=fixture();offline.env.COVE_RIGHTS_OWNER_ENABLED="0";
  assert.equal((await offline.publish()).status,503,"Owner outage never authorizes from D1");
  console.log("PASS: real private Worker handlers enforce whole-cart publication, time windows, buyer scope, replay, withdrawal races and outage");
} finally {
  for(const db of databases)db.close();
  rmSync(directory,{recursive:true,force:true});
}
