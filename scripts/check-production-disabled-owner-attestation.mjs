/* eslint-disable prettier/prettier -- Prove real bundled production-disabled DO cannot authorize any legal operations. */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const temp=mkdtempSync(join(tmpdir(),"cove-disabled-prod-owner-"));
try {
  const outfile=join(temp,"disabled-owner.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent",
    plugins:[{name:"disabled-production-host",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"test-host"}));
      b.onLoad({filter:/.*/,namespace:"test-host"},()=>({contents:
        "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }"}));
    }}]});
  const {CoveLegalAuthority,default:worker}=await import(pathToFileURL(outfile).href);
  const modulePath=join(temp,"attestation.mjs");
  await build({entryPoints:["src/storefront-strangler/production-disabled-owner-attestation.ts"],
    outfile:modulePath,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const {DISABLED_OWNER_ATTEST_ROUTE,PRODUCTION_OWNER_OBJECT,
    PRODUCTION_LEGAL_PRIMARY,attestDisabledOwnerFromBackend,
    verifyDisabledOwnerReceipt}=await import(pathToFileURL(modulePath).href);
  const primary={prepare(){throw Error("Disabled owner must not read primary D1");}};
  const sqlDB=new DatabaseSync(":memory:");
  try {
    const sql={exec(query,...args){
      const q=sqlDB.prepare(query);
      const rows=q.columns().length?q.all(...args):(q.run(...args),[]);
      return {toArray:()=>rows};
    }};
    const secret="e".repeat(64);
    const env={PRIMARY_DB:primary,COVE_RIGHTS_OWNER_ENABLED:"0",
      COVE_RIGHTS_OWNER_PRIMARY_ID:PRODUCTION_LEGAL_PRIMARY,
      COVE_RIGHTS_OWNER_SECRET:secret};
    const owner=new CoveLegalAuthority({storage:{sql,transactionSync(fn){
      sqlDB.exec("BEGIN");
      try{const output=fn();sqlDB.exec("COMMIT");return output;}
      catch(e){sqlDB.exec("ROLLBACK");throw e;}
    }}},env);
    env.LEGAL_AUTHORITY={getByName(name){
      assert.equal(name,PRODUCTION_OWNER_OBJECT);
      return owner;
    }};
    const challenge="a".repeat(32);
    const request=(path=DISABLED_OWNER_ATTEST_ROUTE,key=secret,method="POST",payload={challenge})=>
      new Request("https://legal-authority.internal"+path,{method,
        headers:{authorization:"Bearer "+key,"content-type":"application/json"},
        body:method==="POST"?JSON.stringify(payload):undefined});
    const good=await owner.fetch(request());
    assert.equal(good.status,200);
    assert.equal(good.headers.get("cache-control"),"no-store");
    const receipt=await good.json();
    assert.equal(verifyDisabledOwnerReceipt(receipt,challenge),true);
    assert.equal(receipt.ownerEnabled,false);
    assert.equal(receipt.permitsRightsWrites,false);
    assert.equal((await worker.fetch(request(),env)).status,200,
      "Service-binding Worker also gates the exact disabled production ID");
    assert.deepEqual(await attestDisabledOwnerFromBackend(env),
      {attested:true,ownerEnabled:false,authorizing:false},
      "Persistence gateway verifies a freshly generated nonce through the real DO");
    assert.equal((await owner.fetch(request(DISABLED_OWNER_ATTEST_ROUTE,"wrong"))).status,401);
    assert.equal((await worker.fetch(request(DISABLED_OWNER_ATTEST_ROUTE,"wrong"),env)).status,401);
    assert.equal((await owner.fetch(request(DISABLED_OWNER_ATTEST_ROUTE,secret,"GET"))).status,405);
    for(const payload of [{challenge:"old-nonce"}, {challenge}, {extra:true,challenge}]) {
      if(Object.keys(payload).length===1&&payload.challenge===challenge)continue;
      assert.equal((await owner.fetch(request(DISABLED_OWNER_ATTEST_ROUTE,secret,"POST",payload))).status,400);
    }
    for(const path of ["/verify","/authorize-batch","/publish-allow",
        "/commercial/entitlement/authorize","/commercial/entitlement/publish-order-verified",
        "/commercial/publish-verified","/commercial/order/deny-next",
        "/storefront/publish-commercial","/publication/activate-version"]) {
      assert.equal((await owner.fetch(request(path))).status,503,
        "Disabled production owner must reject protected operation "+path);
      assert.equal((await worker.fetch(request(path),env)).status,503,
        "Production service must never forward protected operation "+path);
    }
    for(const patch of [
      {COVE_RIGHTS_OWNER_ENABLED:"1"},
      {COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"},
      {COVE_RIGHTS_OWNER_PRIMARY_ID:"not-production"},
      {COVE_RIGHTS_OWNER_SECRET:"wrong"},
      {COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+60000)}
    ]) {
      const forged={...env,...patch};
      const other=new CoveLegalAuthority({storage:{sql},env:forged},forged);
      assert.equal((await other.fetch(request())).status,503,
        "Neither QA, enabled production, nor malformed identity may attest disabled status");
      assert.equal((await worker.fetch(request(),forged)).status,503);
    }
    const replay={...receipt,challenge:"b".repeat(32)};
    assert.equal(verifyDisabledOwnerReceipt(replay,challenge),false);
    assert.equal(verifyDisabledOwnerReceipt({...receipt,ownerEnabled:true},challenge),false);
    assert.equal(verifyDisabledOwnerReceipt({...receipt,permitsRightsWrites:true},challenge),false);
    assert.equal(verifyDisabledOwnerReceipt({...receipt,extra:"forged"},challenge),false);
    await assert.rejects(attestDisabledOwnerFromBackend({
      ...env,LEGAL_AUTHORITY:{getByName:()=>({fetch:async()=>Response.json(replay)})}
    }),/disabled_owner_receipt_mismatch/);
    await assert.rejects(attestDisabledOwnerFromBackend({
      ...env,LEGAL_AUTHORITY:{getByName:()=>({fetch:async()=>new Response(null,{status:503})})}
    }),/disabled_owner_not_acknowledged/);
    const backend=readFileSync("src/persistence-backend.worker.ts","utf8");
    const authenticated=backend.indexOf("if (!(await authorized(request, env)))");
    const dispatch=backend.indexOf("if (path === DISABLED_OWNER_ATTEST_ROUTE)");
    assert.ok(authenticated>=0&&dispatch>authenticated,
      "Disabled owner backend diagnostic must remain behind backend token authentication");
    console.log("PASS: real bundled production DO and service entrypoint attest only disabled state with authenticated fresh nonce; backend proof rejects replay/forgery; ALL protected commands deny, production primary is untouched");
  }finally{sqlDB.close();}
}finally{rmSync(temp,{recursive:true,force:true});}
