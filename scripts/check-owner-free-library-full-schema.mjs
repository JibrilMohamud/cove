/* eslint-disable prettier/prettier -- Real owner + full D1 SQLite, isolated synthetic rights only. */
import assert from "node:assert/strict";
import {build} from "esbuild";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {localBindings} from "./local-api.mjs";

const folder=mkdtempSync(join(tmpdir(),"cove-owner-free-library-"));
const secret="b".repeat(64),ownerDb=new DatabaseSync(":memory:");
try{
  const output=join(folder,"owner.mjs");
  await build({entryPoints:["src/storefront-strangler/legal-authority.worker.ts"],
    outfile:output,bundle:true,platform:"node",format:"esm",target:"node22",
    logLevel:"silent",plugins:[{name:"cf-host",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"host"}));
      b.onLoad({filter:/.*/,namespace:"host"},()=>({
        contents:"export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}"
      }));
    }}]});
  const {CoveLegalAuthority}=await import(pathToFileURL(output).href);
  const fixture=localBindings(folder);
  const sql={exec(query,...args){
    if(!args.length&&/^(?:CREATE|ALTER|DROP|PRAGMA)\s/i.test(query.trimStart())){
      ownerDb.exec(query);return {toArray:()=>[]};
    }
    const statement=ownerDb.prepare(query),rows=statement.columns().length?
      statement.all(...args):(statement.run(...args),[]);
    return {toArray:()=>rows};
  }};
  const storage={sql,transactionSync(fn){
    ownerDb.exec("BEGIN");
    try{const outcome=fn();ownerDb.exec("COMMIT");return outcome;}
    catch(error){ownerDb.exec("ROLLBACK");throw error;}
  }};
  const owner=new CoveLegalAuthority({storage},{
    PRIMARY_DB:fixture.DB,COVE_RIGHTS_OWNER_ENABLED:"1",
    COVE_RIGHTS_OWNER_PRIMARY_ID:"7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT:String(Date.now()+600000),
    COVE_RIGHTS_OWNER_SECRET:secret,
  });
  const id="1342",productId="prd_gutenberg_"+id;
  const product=await fixture.DB.prepare(
    "SELECT p.id,p.edition_id,c.source_id,c.rights_evidence_id,c.copyright,c.rights_status,c.commercial_use_status FROM products p JOIN gutenberg_source_cache c ON c.id=p.source_external_id WHERE p.id=?"
  ).bind(productId).first();
  assert.ok(product,"Local synthetic canonical product fixture is missing");
  assert.equal(product.source_id,"pg_us");
  assert.equal(product.copyright,0);
  assert.equal(product.rights_status,"public-domain");
  assert.equal(product.commercial_use_status,"approved");
  assert.ok(product.rights_evidence_id);
  const market=await fixture.DB.prepare(
    "SELECT default_currency FROM storefront_markets WHERE country_code='US' AND market_status='active'"
  ).first();
  assert.equal(market?.default_currency,"USD");
  sql.exec("INSERT INTO cove_legal_fences(source_id,territory,revision,verdict) VALUES(?,'US',1,'allow')",id);
  sql.exec("INSERT INTO cove_authorized_offer_proofs(source_id,territory,currency,revision,product_id,edition_id,product_public_id,edition_public_id,offer_json) VALUES(?,'US','USD',1,?,?,NULL,NULL,?)",
    id,productId,product.edition_id,JSON.stringify({type:"public-domain",currency:"USD",amountMinor:0}));
  const call=(userId,territory="US",key=secret)=>
    owner.fetch(new Request("https://legal-authority.internal/catalog/private-grant-free-library",{
      method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key},
      body:JSON.stringify({userId,productId,territory}),
    }));
  const count=async(userId)=>Number((await fixture.DB.prepare(
    "SELECT COUNT(*) n FROM entitlements WHERE user_id=? AND product_id=? AND entitlement_type='public-domain' AND status='active'"
  ).bind(userId,productId).first()).n);
  let grant=await call("qa-reader-one");
  assert.equal(grant.status,200,"real owner must grant solely synthetic reviewed public-domain fixture: "+await grant.clone().text());
  const result=await grant.json();
  assert.equal(result.schema,"cove.owner-free-library-entitlement.v1");
  assert.equal(result.ownerFirst,true);
  assert.equal(result.saved,true);
  assert.equal(result.applied,true);
  assert.equal(await count("qa-reader-one"),1);
  grant=await call("qa-reader-one");
  assert.equal(grant.status,200,"exact grant retry must remain idempotent");
  assert.equal((await grant.json()).applied,false);
  assert.equal(await count("qa-reader-one"),1);
  assert.equal((await call("qa-reader-two","CA")).status,409,"wrong market cannot inherit US proof");
  assert.equal((await call("qa-reader-two","US","c".repeat(64))).status,401);
  assert.equal(await count("qa-reader-two"),0);
  // The owner commits a newer denial. The old immutable offer proof
  // remains physically present, yet MUST NOT authorize a new entitlement.
  sql.exec("UPDATE cove_legal_fences SET revision=2,verdict='deny' WHERE source_id=? AND territory='US'",id);
  assert.equal((await call("qa-reader-two")).status,409,"owner's current denial must veto stale grant");
  assert.equal(await count("qa-reader-two"),0);
  // Even a mistakenly replayed old allow cannot reinstall prior authority.
  assert.equal((await call("qa-reader-one")).status,409);
  assert.equal(await count("qa-reader-one"),1,"withdrawal cannot invent a second entitlement");
  // Separately prove the physical D1 source-evidence fence still fails
  // after a simulated rights-status invalidation, even with fresh owner allow.
  sql.exec("UPDATE cove_legal_fences SET revision=3,verdict='allow' WHERE source_id=? AND territory='US'",id);
  sql.exec("UPDATE cove_authorized_offer_proofs SET revision=3 WHERE source_id=? AND territory='US' AND currency='USD'",id);
  await fixture.DB.prepare("UPDATE gutenberg_source_cache SET commercial_use_status='pending' WHERE id=?").bind(id).run();
  assert.equal((await call("qa-reader-two")).status,409,"missing current independent source evidence cannot be replaced by owner allow");
  assert.equal(await count("qa-reader-two"),0);
  console.log("PASS: actual private owner + complete local D1 schema: verified free grant, exact replay, market denial, owner withdrawal and source-evidence revocation");
}finally{
  ownerDb.close();
  rmSync(folder,{recursive:true,force:true});
}
